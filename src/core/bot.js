'use strict'

const mineflayer = require('mineflayer')
const { Logger } = require('./logger')
const { ConstructionEngine } = require('./builder')
const { RecoveryManager } = require('../recovery/recovery-manager')
const { NavigationController } = require('../navigation/controller')
const { WorldModel } = require('./world-model')
const { waitFor } = require('../util/async')

function parseCommandArgs (input) {
  const parts = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(input)) !== null) parts.push(match[1] ?? match[2] ?? match[3])
  return parts
}

// fleet = null for a single bot, or { coord, id, index, count, shared } when several bots build together.
// Only worker 0 (the leader) listens to chat; its commands are applied to every worker.
function createBuilderBot (config, fleet = null, authOpts = null) {
  const logger = new Logger(fleet ? fleet.id : 'bot')
  const isLeader = !fleet || fleet.index === 0
  const chosenVersion = config.server.version || config.server._detectedVersion || ''
  const bot = mineflayer.createBot({
    host: config.server.host,
    port: Number(config.server.port) || 25565,
    username: config.server.username,
    // empty version = let the server tell us (or use cached detected version if Aternos ping returned -1)
    ...(chosenVersion ? { version: chosenVersion } : {}),
    auth: 'offline',
    ...(authOpts || {}),
    // a fleet shares one process and one connection budget: a small view distance cuts the chunk traffic a lot
    ...(fleet ? { viewDistance: Number(config.fleet?.viewDistance ?? 4) } : {}),
    checkTimeoutInterval: 60_000,
    maxCatchupTicks: 1, // after a stall do not fire a burst of physics ticks (a burst looks like a speed/timer hack to an anti-cheat)
    hideErrors: true
  })

  // cracked servers (AuthMe and similar): answer the register / login prompt with the account's password
  const password = config.account?.mode === 'offline' ? config.account.password : null
  if (password) {
    let last = 0
    bot.on('messagestr', text => {
      const t = String(text).toLowerCase()
      if (Date.now() - last < 4000) return
      const say = c => { last = Date.now(); setTimeout(() => { try { bot.chat(c) } catch {} }, 1200 + Math.random() * 1500) }
      if (/\/register|please register|register with/.test(t)) say(`/register ${password} ${password}`)
      else if (/\/login|please log ?in|log in with/.test(t)) say(`/login ${password}`)
    })
  }

  require('../interaction/wire').installWireFixes(bot, config, logger)

  const protocolRing = []
  const ringSize = Math.max(4, Number(config.diagnostics?.protocolPacketRingSize ?? 12))
  if (bot._client?.on) {
    bot._client.on('raw', (buffer, meta) => {
      protocolRing.push({
        at: Date.now(),
        state: meta?.state || 'unknown',
        name: meta?.name || 'unknown',
        length: Buffer.isBuffer(buffer) ? buffer.length : 0,
        head: Buffer.isBuffer(buffer) ? buffer.subarray(0, 64).toString('hex') : ''
      })
      while (protocolRing.length > ringSize) protocolRing.shift()
    })
  }

  bot.once('login', () => {
    if (bot.version && !config.server.version) config.server._detectedVersion = bot.version
    if (!config.diagnostics?.quietStartup) logger.info(`login version=${bot.version}`)
  })
  bot.on('error', error => {
    const label = error?.name || 'Error'
    const field = error?.field ? ` field=${error.field}` : ''
    const code = error?.code ? ` code=${error.code}` : ''
    if (label === 'PartialReadError') {
      const last = protocolRing[protocolRing.length - 1]
      const suffix = last ? ` lastRaw=${last.state}.${last.name} len=${last.length} head=${last.head}` : ' lastRaw=none'
      logger.warn(`protocol PartialReadError${suffix}`)
      return
    }
    if (/Unsupported protocol version|minecraftVersion/i.test(String(error?.message || ''))) {
      if (!config.server.version && !config.server._detectedVersion) config.server._detectedVersion = '1.21.4'
      logger.warn(`server ping returned transient protocol version (${error.message}); using ${config.server._detectedVersion || 'auto'} on reconnect`)
      return
    }
    logger.error(`${label}${code}${field}: ${error.stack || error.message}`)
  })
  bot.on('kicked', reason => logger.warn(`kicked: ${reason}`))
  bot.on('end', reason => { logger.warn(`connection ended: ${reason}`); bot.builder?.shutdown?.(); fleet?.coord.unregister(fleet.id) })

  // ---- fleet in separate processes: commands arrive from the hub and are carried out by every worker --------
  const sayToLeader = text => fleet?.send?.({ t: 'say', text: String(text).slice(0, 230) })
  async function startWithRetry (file, origin, rotation, opts = {}) {
    const b = bot.builder
    for (let attempt = 1; attempt <= 40 && b && !b.running; attempt++) {
      try { await b.startJob(require('path').join(config.paths.schematicsDir, file), origin, rotation || 0, opts); return true } catch (error) {
        if (/already running/i.test(error.message)) return true
        if (attempt === 40) { logger.warn(`could not start the job: ${error.message}`); sayToLeader(`${bot.username}: could not start (${error.message})`); return false }
        logger.warn(`start not possible yet (attempt ${attempt}/40): ${error.message}; retrying in 3 s`)
        await new Promise(resolve => setTimeout(resolve, 3000))
      }
    }
    return true
  }
  async function execShared (m) {
    const b = bot.builder
    if (!b) { logger.warn(`command ${m.cmd} ignored: the bot is not in the world yet (it will start by itself when it is)`); return }
    logger.info(`command received: ${m.cmd}${m.file ? ` ${m.file}` : ''}${b.running ? ' (a build is already running)' : ''}`)
    try {
      if (m.cmd === 'start' || m.cmd === 'continue') {
        if (b.running) { // a new Start replaces whatever is running (e.g. a resumed build that walks somewhere else)
          logger.info('a build is running: stopping it and starting the new one')
          b.stop()
          for (let i = 0; i < 120 && b.running; i++) await new Promise(r => setTimeout(r, 100))
          if (b.running) {
            logger.warn('forcing running build state reset so new start command can proceed')
            b.running = false
            b.stopRequested = false
          }
        }
        await startWithRetry(m.file, m.origin, m.rotation, {
          continueMode: Boolean(m.continueMode || m.resume || m.cmd === 'continue'),
          startLayer: m.startLayer ?? null
        }); return
      }
      if (m.cmd === 'pause') return b.pause()
      if (m.cmd === 'resume') return b.resume()
      if (m.cmd === 'stop') return b.stop()
      if (m.cmd === 'architect') { if (b.planner) b.runArchitect(b.originVec); return }
      if (m.cmd === 'cleanup') { await b.cleanupTemporary(); return }
      if (m.cmd === 'restock') {
        await b.materials.ensureToolKit()
        for (const row of b.materials.getMissingMaterials(8).slice(0, 4)) await b.materials.ensureItem(row.item, 1)
      }
    } catch (error) { logger.warn(`command ${m.cmd}: ${error.message}`); sayToLeader(`${bot.username}: ${m.cmd} failed: ${error.message}`) }
  }
  if (fleet?.relay && isLeader) fleet.say = text => { if (config.control?.announceInChat) { try { bot.chat(String(text).slice(0, 240)) } catch {} } else logger.info(`(not sent to public chat) ${text}`) }

  bot.on('spawn', async () => {
    if (bot.builder) {
      try { await bot.recovery?.handleRespawn?.() } catch (error) { logger.warn(`respawn recovery: ${error.message}`) }
      return
    }
    if (!config.diagnostics?.quietStartup) {
      logger.info(`spawned at ${bot.entity.position}`)
      logger.info(`world=${bot.game?.dimension || 'unknown'} gamemode=${bot.game?.gameMode || 'unknown'} serverBrand=${bot.game?.serverBrand || 'unknown'}`)
      logger.info(`abilities=${JSON.stringify(bot.abilities || {})} gravity=${bot.physics?.gravity ?? 'unknown'} physicsEnabled=${bot.physicsEnabled}`)
    }
    bot.physicsEnabled = true
    if (bot.game?.gameMode && bot.game.gameMode !== 'survival' && bot.game.gameMode !== 'adventure') {
      logger.warn(`BuilderBot is in game mode ${bot.game.gameMode}; refusing to start an automated survival build.`)
    }
    if (config.diagnostics?.logProtocolVersions) {
      try {
        const mp = require('minecraft-protocol/package.json').version
        const pd = require('protodef/package.json').version
        if (!config.diagnostics?.quietStartup) logger.info(`protocol stack minecraft-protocol=${mp} protodef=${pd} node=${process.version}`)
      } catch (error) {
        logger.warn(`protocol version diagnostic failed: ${error.message}`)
      }
    }
    try {
      const timeoutMs = Math.max(1000, Number(config.navigation.chunkPreloadTimeoutMs ?? 30000))
      const minColumns = Math.max(1, Number(config.navigation.minLoadedChunkColumns ?? 9))
      if (typeof bot.waitForChunksToLoad === 'function') {
        let ready = false
        const started = Date.now()
        while (!ready && Date.now() - started < timeoutMs) {
          try {
            await bot.waitForChunksToLoad()
          } catch (error) {
            if (!config.navigation.chunkPreloadWarningOnly) throw error
          }
          const loaded = typeof bot.world?.getColumns === 'function' ? bot.world.getColumns().length : 0
          if (loaded >= minColumns) {
            ready = true
            if (!config.diagnostics?.quietStartup) logger.info(`chunk preload ready: ${loaded} columns loaded`)
            break
          }
          await waitFor(() => {
            const count = typeof bot.world?.getColumns === 'function' ? bot.world.getColumns().length : 0
            return count >= minColumns
          }, { timeoutMs: Math.min(2000, Math.max(250, timeoutMs - (Date.now() - started))), intervalMs: 100 }).catch(() => {})
        }
        const loaded = typeof bot.world?.getColumns === 'function' ? bot.world.getColumns().length : 0
        if (!ready) {
          const message = `chunk preload did not reach ${minColumns} columns within ${timeoutMs}ms (loaded=${loaded})`
          if (config.navigation.chunkPreloadWarningOnly) logger.warn(message)
          else throw new Error(message)
        }
      }
    } catch (error) {
      logger.warn(`chunk preload warning: ${error.message}`)
    }

    if (fleet) fleet.coord.register(fleet.id, fleet.index, bot)
    try { new (require('../recovery/motion-guard').MotionGuard)(bot, config, logger).attach() } catch (error) { logger.warn(`motion guard unavailable: ${error.message}`) }
    bot.builder = new ConstructionEngine(bot, config, logger, fleet
      ? { fleet: { coord: fleet.coord, id: fleet.id, index: fleet.index, count: fleet.count }, learner: fleet.shared.learner, experience: fleet.shared.experience }
      : {})
    await bot.builder.init()
    bot.recovery = new RecoveryManager(bot, bot.builder.navigation, new WorldModel(bot), config, logger, bot.builder.ground)
    bot.recovery.start()
    const defaultSchematic = config.control?.defaultSchematic || config.paths?.defaultSchematic || null
    if (!isLeader) {
      logger.info('fleet worker ready (commands are given to the leader)')
    } else if (defaultSchematic) {
      logger.info(`Ready to build ${defaultSchematic}. Start it from the GUI (or type ${config.control.chatPrefix}start in game if chat commands are on).`)
      if (config.control.announceInChat) bot.chat(`Builder ready. Stand at the build origin and type ${config.control.chatPrefix}start`)
    } else {
      logger.warn('No default schematic configured; !start is unavailable until control.defaultSchematic is set.')
    }
    if (fleet?.relay) {
      fleet.setHandler(execShared)
      fleet.hello()
    } else if (config.server.resumeOnStart) {
      const resumeDelay = fleet ? 2000 + 2500 * fleet.index : 0
      ;(async () => {
        await new Promise(resolve => setTimeout(resolve, resumeDelay))
        for (let attempt = 1; attempt <= 30; attempt++) {
          try {
            if (await bot.builder.resumeSavedJob()) logger.info('resumed the saved build')
            return
          } catch (error) {
            if (attempt === 1 || attempt % 10 === 0) logger.warn(`auto-resume: ${error.message}; retrying`)
            await new Promise(resolve => setTimeout(resolve, 3000))
          }
        }
      })()
    }
  })

  let lastHurtLogAt = 0
  bot.on('entityHurt', (entity) => {
    if (entity !== bot.entity) return
    const now = Date.now()
    bot.lastHurtAt = now
    if (bot.__motion) bot.__motion.lastExternal = now
    if (bot.builder?.fallGuard) bot.builder.fallGuard.lastHurtAt = now
    const important = Number(bot.health) < Number(config.safety?.minimumHealth || 8) || Boolean(bot.builder?.running)
    if (!important || now - lastHurtLogAt < 2000) return
    lastHurtLogAt = now
    logger.warn(`BuilderBot hurt: health=${Number(bot.health).toFixed(1)} pos=${bot.entity.position} velocity=${bot.entity.velocity}`)
  })

  bot.on('death', () => bot.recovery?.handleDeath().catch(error => logger.error(error.message)))

  bot.on('chat', async (username, message) => {
    if (!isLeader) return
    if (config.control?.chatCommands !== true) return
    if (username === bot.username) return
    if (fleet && fleet.ids.includes(username)) return
    if (!config.control.allowedUsers?.length || !config.control.allowedUsers.includes(username)) return
    if (!message.startsWith(config.control.chatPrefix)) return

    const raw = message.slice(config.control.chatPrefix.length).trim()
    const parts = parseCommandArgs(raw)
    const command = (parts.shift() || '').toLowerCase()
    const reply = text => bot.chat(String(text).slice(0, 240))
    const team = () => (fleet ? fleet.coord.builders() : [bot.builder])
    const startAll = async (file, origin, rotation, opts = {}) => {
      const list = team()
      const results = await Promise.allSettled(list.map(b => b.startJob(file, origin, rotation, opts)))
      const failed = results.map((r, i) => (r.status === 'rejected' ? `${list[i].bot.username}: ${r.reason?.message}` : null)).filter(Boolean)
      for (const f of failed.slice(0, 3)) reply(`worker could not start: ${f}`.slice(0, 200))
      return list.length - failed.length
    }
    const resolveSavedJobMeta = () => {
      if (bot.builder?.loaded?.file && bot.builder?.originVec) {
        return {
          file: require('path').basename(bot.builder.loaded.file),
          origin: { x: bot.builder.originVec.x, y: bot.builder.originVec.y, z: bot.builder.originVec.z },
          rotation: bot.builder.planner?.rotation || 0
        }
      }
      const fsSync = require('fs')
      const pathMod = require('path')
      const dirs = [...new Set([config.paths?.stateDir, pathMod.resolve(process.cwd(), 'data')].filter(Boolean))]
      for (const d of dirs) {
        for (const fn of ['fleet-job.json', 'active-job.json']) {
          try {
            const j = JSON.parse(fsSync.readFileSync(pathMod.join(d, fn), 'utf8'))
            if (j?.file && j?.origin) return { file: pathMod.basename(j.file), origin: j.origin, rotation: Number(j.rotation || 0), startLayer: j.startLayer ?? null }
          } catch {}
        }
      }
      return null
    }

    try {
      if (!bot.builder) return reply('builder not ready')
      if (fleet?.relay && ['start', 'build', 'continue', 'pause', 'resume', 'stop', 'restock', 'cleanup', 'architect'].includes(command)) {
        if (command === 'start' || command === 'build' || command === 'continue') {
          let file; let origin; let rotation; let startLayer = null
          const continueMode = command === 'continue'
          if (command === 'continue' && parts.length <= 1) {
            const savedMeta = resolveSavedJobMeta()
            if (!savedMeta) return reply('no saved build found to continue; use !continue file.litematic x y z [rotation] [startLayer]')
            file = savedMeta.file; origin = savedMeta.origin; rotation = savedMeta.rotation
            if (parts[0] != null && Number.isFinite(Number(parts[0]))) startLayer = Math.max(0, Math.floor(Number(parts[0])))
            else if (savedMeta.startLayer != null) startLayer = savedMeta.startLayer
          } else if (command === 'start') {
            file = config.control?.defaultSchematic || config.paths?.defaultSchematic
            if (!file) return reply('no default schematic configured')
            if (!(await bot.builder.ensureSafeBuildStart())) return reply('not on safe ground yet: ' + bot.builder.ground.describe().slice(0, 170))
            const pos = bot.entity.position.floored()
            origin = { x: pos.x, y: pos.y, z: pos.z }; rotation = Number(config.control?.defaultRotation || 0)
          } else {
            const [f, x, y, z, rot, sl] = parts
            if (!f || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || !Number.isFinite(Number(z))) return reply(`usage: !${command} file.schem|file.litematic x y z [rotation] [startLayer]`)
            file = f; origin = { x: Number(x), y: Number(y), z: Number(z) }; rotation = rot == null ? 0 : Number(rot)
            if (sl != null && Number.isFinite(Number(sl))) startLayer = Math.max(0, Math.floor(Number(sl)))
          }
          fleet.relay({ cmd: continueMode ? 'continue' : 'start', file, origin, rotation, startLayer, continueMode })
          return reply(`${continueMode ? 'continuing' : 'started'} ${file} at ${origin.x} ${origin.y} ${origin.z}${startLayer != null ? ` (from layer ${startLayer})` : ''} with ${fleet.count} workers`)
        }
        fleet.relay({ cmd: command })
        return reply(`${command} sent to all ${fleet.count} workers`)
      }
      if (command === 'continue') {
        let file; let origin; let rotation = 0; let startLayer = null
        if (parts.length <= 1) {
          const savedMeta = resolveSavedJobMeta()
          if (!savedMeta) return reply('no saved build found to continue; use !continue file.litematic x y z [rotation] [startLayer]')
          file = savedMeta.file; origin = savedMeta.origin; rotation = savedMeta.rotation
          if (parts[0] != null && Number.isFinite(Number(parts[0]))) startLayer = Math.max(0, Math.floor(Number(parts[0])))
          else if (savedMeta.startLayer != null) startLayer = savedMeta.startLayer
        } else {
          const [f, x, y, z, rot, sl] = parts
          if (!f || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || !Number.isFinite(Number(z))) return reply('usage: !continue [startLayer] OR !continue file.litematic x y z [rotation] [startLayer]')
          file = f; origin = { x: Number(x), y: Number(y), z: Number(z) }; rotation = rot == null ? 0 : Number(rot)
          if (sl != null && Number.isFinite(Number(sl))) startLayer = Math.max(0, Math.floor(Number(sl)))
        }
        const n = await startAll(require('path').join(config.paths.schematicsDir, file), origin, rotation, { continueMode: true, startLayer })
        return reply(`continuing ${file} at ${origin.x} ${origin.y} ${origin.z}${startLayer != null ? ` (from layer ${startLayer})` : ''} (${n} worker${n === 1 ? '' : 's'})`)
      }
      if (command === 'start') {
        const defaultSchematic = config.control?.defaultSchematic || config.paths?.defaultSchematic
        if (!defaultSchematic) return reply('no default schematic configured')
        if (bot.game?.gameMode && bot.game.gameMode !== 'survival' && bot.game.gameMode !== 'adventure') {
          return reply(`refusing to start in ${bot.game.gameMode} mode; bot must be survival/adventure`)
        }
        if (bot.abilities?.flying) {
          return reply('refusing to start: server reports BuilderBot is flying; disable flight before building')
        }
        if (!(await bot.builder.ensureSafeBuildStart())) {
          logger.warn(`start refused: ${bot.builder.ground.describe()}`)
          return reply('not on safe ground yet: ' + bot.builder.ground.describe().slice(0, 170))
        }
        const pos = bot.entity.position.floored()
        const rotation = Number(config.control?.defaultRotation || 0)
        const n = await startAll(require('path').join(config.paths.schematicsDir, defaultSchematic), pos, rotation)
        return reply(`started ${defaultSchematic} at ${pos.x} ${pos.y} ${pos.z} with ${n} worker${n === 1 ? '' : 's'}`)
      }
      if (command === 'build') {
        const [file, x, y, z, rotationRaw, slRaw] = parts
        if (!file || !Number.isFinite(Number(x)) || !Number.isFinite(Number(y)) || !Number.isFinite(Number(z))) {
          return reply('usage: !build file.schem|file.litematic x y z [rotation] [startLayer]')
        }
        const rotation = rotationRaw == null ? 0 : Number(rotationRaw)
        const startLayer = (slRaw != null && Number.isFinite(Number(slRaw))) ? Math.max(0, Math.floor(Number(slRaw))) : null
        const n = await startAll(require('path').join(config.paths.schematicsDir, file), { x: Number(x), y: Number(y), z: Number(z) }, rotation, { startLayer })
        return reply(`build started: ${file}${startLayer != null ? ` (from layer ${startLayer})` : ''} (${n} worker${n === 1 ? '' : 's'})`)
      }
      if (command === 'pause') { team().forEach(b => b.pause()); return reply('build paused') }
      if (command === 'resume') { team().forEach(b => b.resume()); return reply('build resumed') }
      if (command === 'stop') { team().forEach(b => b.stop()); return reply('build stop requested') }
      if (command === 'fleet') return reply(fleet ? `workers: ${fleet.coord.summary()}`.slice(0, 230) : 'single bot (set fleet.workers in config.json)')
      if (command === 'materials') {
        if (!bot.builder.materials) return reply('materials manager not ready')
        const rows = bot.builder.materials.getMissingMaterials(8)
        if (!rows.length) return reply('material plan satisfied in inventory / no known shortages')
        return reply(`missing: ${rows.map(r => `${r.item} ${r.missing}`).join(', ')}`)
      }
      if (command === 'restock') {
        if (!bot.builder.materials) return reply('materials manager not ready')
        for (const b of team()) {
          await b.materials.ensureToolKit()
          const rows = b.materials.getMissingMaterials(8)
          for (const row of rows.slice(0, 4)) await b.materials.ensureItem(row.item, 1)
        }
        return reply('restock pass complete; build materials are also refilled automatically on demand')
      }
      if (command === 'status') {
        const stats = bot.builder.planner?.getStats()
        if (!stats) return reply('no build loaded')
        const state = !bot.builder.running ? 'idle' : bot.builder.manualPaused ? 'paused(manual)' : bot.builder.autoPaused ? `paused(auto: ${bot.recovery?.reason || '?'})` : 'building'
        const tail = fleet ? ` | workers ${fleet.coord.summary()}` : ''
        return reply(`${state} | ${stats.percent}% | ${stats.completed}/${stats.total} | remaining ${stats.remaining} | deferred ${stats.deferred} | blocked ${stats.blocked}${tail}`.slice(0, 240))
      }
      if (command === 'ground') {
        const text = bot.builder.ground.describe()
        logger.info(`GROUND: ${text}`)
        return reply(text)
      }
      if (command === 'architect') {
        if (!bot.builder.planner) return reply('no build loaded')
        const r = bot.builder.runArchitect(bot.builder.originVec)
        for (const b of team()) if (b !== bot.builder && b.planner) b.runArchitect(b.originVec)
        if (!r) return reply('architect is off or failed (see errors.log)')
        reply(`architect: ${r.tasks} blocks, ${r.layers} layer steps, ${r.pieces} pieces, ~${r.estimatedMinutes} min, ${r.floating} need scaffold refs, ${r.soilProblems} plant/soil problems`)
        for (const w of r.warnings.slice(0, 3)) reply(`warning: ${w}`)
        return
      }
      if (command === 'analyze') {
        if (!bot.builder.planner) return reply('no build loaded')
        const r = bot.builder.analyze()
        const e = r.out.estimate
        reply(`plan: ${r.out.blocks} blocks, ${r.out.layerSteps} layer steps, ${r.out.workers} worker(s) | est. ${Math.floor(e.fleetPlannerMin / 60)}h${e.fleetPlannerMin % 60}m planner, ~${Math.round(e.fleetCalibratedMin / 60)}h realistic`)
        reply(`split: ${r.out.perWorker.map(w => `W${w.worker} ${w.blocks}`).join(' | ')}`)
        for (const risk of r.risks.slice(0, 3)) reply(`risk: ${risk}`)
        return reply('full plan saved in data/*.analysis.md')
      }
      if (command === 'plan') {
        const p = bot.builder.planner
        if (!p) return reply('no build loaded')
        const c = p.census
        return reply(`plan: tasks ${p.total} | derived ${c.derived} | look-up ${c.lookUp} | unsupported ${c.unsupported.length} | kinds ${JSON.stringify(c.byKind)}`)
      }
      if (command === 'tasks') {
        const p = bot.builder.planner
        if (!p) return reply('no build loaded')
        const bad = [...p.tasks.values()].filter(t => t.attempts > 0 && t.status !== 'completed').sort((a, b) => b.attempts - a.attempts).slice(0, 5)
        if (!bad.length) return reply('no troubled tasks')
        bad.forEach(t => logger.info(`TASK ${t.name} ${t.key} attempts=${t.attempts} status=${t.status} err=${t.lastError}`))
        return reply(bad.map(t => `${t.name}@${t.key} x${t.attempts}`).join(' | '))
      }
      if (command === 'learned' || command === 'learn') {
        const hl = bot.builder.humanLogger?.summary?.() || 'humanLogger: off'
        return reply(`learned rules: ${JSON.stringify(bot.builder.learner.preferred)} | ${hl}`.slice(0, 240))
      }
      if (command === 'watch') {
        const arg = (parts[0] || '').toLowerCase()
        const hl = bot.builder.humanLogger
        if (!hl) return reply('human logger not ready')
        const next = arg === 'off' ? false : arg === 'on' ? true : !hl.watching
        for (const b of team()) b.humanLogger?.setWatching?.(next)
        return reply(hl.summary())
      }
      if (command === 'verify') {
        const result = bot.builder.verifyAll()
        return reply(`verify ${result.correct}/${result.total} correct | wrong ${result.wrong} | unknown ${result.unknown}`)
      }
      if (command === 'cleanup') {
        let before = 0; let remaining = 0
        for (const b of team()) { const result = await b.cleanupTemporary(); before += result.before ?? 0; remaining += result.remaining ?? 0 }
        return reply(`cleanup before=${before} remaining=${remaining}`)
      }
      if (command === 'diag') {
        const stats = bot.builder.planner?.getStats()
        const materials = bot.builder.materials?.formatSummary?.(4) || 'none'
        const e = bot.entity
        const v = e?.velocity
        const lastRaw = protocolRing[protocolRing.length - 1]
        const raw = lastRaw ? `${lastRaw.state}.${lastRaw.name}/${lastRaw.length}` : 'none'
        return reply(`diag mode=${bot.game?.gameMode || 'unknown'} flying=${Boolean(bot.abilities?.flying)} mayFly=${Boolean(bot.abilities?.mayFly)} gravity=${bot.physics?.gravity ?? 'unknown'} vel=${v ? `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}` : 'none'} brand=${bot.game?.serverBrand || 'unknown'} build=${stats ? `${stats.completed}/${stats.total}` : 'none'} materials=${materials} raw=${raw}`)
      }
      if (command === 'help') return reply('!start, !build file x y z [rot], !pause, !resume, !stop, !watch [on|off], !learn, !status, !ground, !plan, !analyze, !architect, !tasks, !materials, !verify, !cleanup, !diag, !fleet')
    } catch (error) {
      logger.error(`command ${command}:`, error.stack || error.message)
      reply(`error: ${error.message}`)
    }
  })

  return bot
}

module.exports = { createBuilderBot }
