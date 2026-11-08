'use strict'
// Starts N builder bots (BuilderBot1..N) that build one schematic together. They share one Coordinator, one
// orientation learner and one experience file (what one bot learns, all use). Worker 1 is the leader: you
// talk to it in chat and every command is applied to all workers.
const { Coordinator } = require('./coordinator')
const { OrientationLearner, Experience } = require('../learning/learner')
const { sleep } = require('../util/async')

async function superviseOne (config, fleet, createBuilderBot, logger) {
  let attempt = 0
  while (true) {
    if (fleet?.gate) await fleet.gate()
    let bot
    try {
      const account = config.account
      const authOpts = account ? await require('../core/accounts').authOptions(account, config, config.paths.stateDir) : null
      if (authOpts?.username) config.server.username = authOpts.username
      bot = createBuilderBot(config, fleet, authOpts)
    } catch (error) {
      logger.error(`${config.server.username}: login not possible: ${error.message}`)
      await sleep(Math.max(30_000, Number(config.server.reconnectDelayMs || 15000)))
      continue
    }
    const t0 = Date.now()
    try {
      await new Promise(resolve => {
        let spawned = false
        const done = why => { clearTimeout(timer); if (why) logger.warn(`${config.server.username}: ${why}`); try { bot.end?.() } catch {} ; resolve() }
        // a login that dies with ECONNRESET / never reaches the world must not leave this bot dead forever
        const timer = setTimeout(() => { if (!spawned) done('did not join within 180 s: reconnecting') }, 180_000)
        bot.once('login', () => { spawned = true; clearTimeout(timer) })
        bot.once('spawn', () => { spawned = true; clearTimeout(timer) })
        bot.on('error', error => {
          if (!spawned && /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|ENOTFOUND|Unsupported protocol version|minecraftVersion/i.test(String(error?.code || error?.message))) {
            if (/Unsupported protocol version|minecraftVersion/i.test(String(error?.message)) && !config.server.version && !config.server._detectedVersion) {
              config.server._detectedVersion = '1.21.4'
            }
            done(`login failed (${error.code || error.message}): reconnecting`)
          }
        })
        bot.once('end', () => { clearTimeout(timer); resolve() })
      })
    } catch (error) { logger.error(`bot supervisor: ${error.stack || error.message}`) }
    const up = Date.now() - t0
    logger.warn(`${config.server.username}: connection lasted ${Math.round(up / 1000)}s${fleet ? `, ${[...fleet.coord.workers.values()].filter(w => w.bot?.entity).length} bots were online` : ''}`)
    if (up > 60_000) attempt = 0
    if (!config.server.autoReconnect) break
    attempt += 1
    const baseDelay = Math.max(15_000, Number(config.server.reconnectDelayMs || 15_000))
    const delay = Math.min(90_000, baseDelay * Math.pow(1.6, Math.min(5, Math.max(0, attempt - 1))) + (fleet ? 4500 * fleet.index : 0))
    logger.warn(`${config.server.username}: reconnecting in ${delay}ms`)
    await sleep(delay)
  }
}

// the bots share one connection budget: each one places and sends commands slower than a lone bot would
function workerConfigFor (config, name) {
  return {
    ...config,
    server: { ...config.server, username: name },
    account: (config.accounts || []).find(a => String(a.username) === name) || null,
    building: { ...config.building, maxPlacementsPerSecond: Math.min(Number(config.building?.maxPlacementsPerSecond || 20), Number(config.fleet?.perBotPlacementsPerSecond ?? 20)) }
  }
}

// the bots ARE the accounts you added in the GUI: there are no built-in names
function workerNames (config) {
  return (config.accounts || []).map(a => String(a.username))
}

// One login at a time, `gap` ms apart (also for reconnects): servers answer faster logins from one address with
// "Connection throttled! Please wait before reconnecting."
function makeGate (gap) {
  let chain = Promise.resolve(); let last = 0
  return () => {
    const turn = chain.then(async () => { const wait = last + gap * (0.8 + Math.random() * 0.7) - Date.now(); if (wait > 0) await sleep(wait); last = Date.now() })
    chain = turn.catch(() => {})
    return turn
  }
}

// The process is single-threaded: if something blocks it for seconds, no bot answers the server's keep-alive and
// every connection drops. Measure it, write it down, and do not count the frozen time as "no progress".
function watchEventLoop (coord, logger, Logger) {
  let last = Date.now(); let cpu = process.cpuUsage(); let cpuAt = Date.now()
  const stats = setInterval(() => {
    const u = process.cpuUsage(cpu); const dt = (Date.now() - cpuAt) * 1000; cpu = process.cpuUsage(); cpuAt = Date.now()
    const online = [...coord.workers.values()].filter(w => w.bot?.entity).length
    logger.info(`HEALTH: cpu ${Math.round(((u.user + u.system) / dt) * 100)}% | rss ${Math.round(process.memoryUsage().rss / 1048576)} MB | ${online} bots online | ${coord.summary()}`.slice(0, 400))
  }, 30_000)
  stats.unref?.()
  const timer = setInterval(() => {
    const now = Date.now(); const lag = now - last - 500; last = now
    if (lag < 1500) return
    logger.warn(`EVENT LOOP BLOCKED for ${(lag / 1000).toFixed(1)}s (all bots froze; usually a long path search)`)
    Logger.incident('event-loop-blocked', { message: `event loop blocked ${lag} ms`, ms: lag })
    coord.lastProgressAt = now
    for (const b of coord.builders()) b.lastProgressAt = now
  }, 500)
  timer.unref?.()
  return timer
}

// "auto" (default): every bot in its own process on big machines, all bots in one shared process on Render /
// small containers. `fleet.mode: "inprocess"` or `"processes_isolated"` forces one of them.
async function startFleet (config, createBuilderBot, logger) {
  if (chooseFleetMode(config) === 'inprocess') return startInProcess(config, createBuilderBot, logger)
  const os = require('os')
  const path = require('path')
  const { fork } = require('child_process')
  const { Hub } = require('./hub')
  const names = workerNames(config)
  const stateDir = path.resolve(path.join(__dirname, '..', '..'), config.paths.stateDir)
  const hub = new Hub({ logger, jobFile: path.join(stateDir, 'fleet-job.json'), resume: Boolean(config.server.resumeOnStart), loginGapMs: Number(config.fleet?.joinDelayMs ?? 6000), deadAfterMs: Number(config.fleet?.deadAfterMs ?? 90_000) })
  const totalRamMb = detectContainerRamMb()
  const cpuCount = os.cpus()?.length || 1
  const fairShareMb = Math.floor(totalRamMb * 0.8 / Math.max(1, names.length + 1))
  const perWorkerHeapMb = Math.max(256, Math.min(totalRamMb >= 16384 ? 4096 : (totalRamMb >= 8192 ? 2048 : 1024), fairShareMb))
  logger.info(`Starting ${names.length} builder(s), each in its own process (${names.join(', ')}) on ${cpuCount} vCPU / ${totalRamMb} MB RAM (heap ${perWorkerHeapMb} MB/bot) -> ${config.server.host}:${config.server.port}`)
  if (hub.job) logger.info(`saved job found: ${hub.job.file} at ${hub.job.origin?.x},${hub.job.origin?.y},${hub.job.origin?.z}: the workers resume it by themselves (resume on start is on)`)
  const children = new Map()
  let shuttingDown = false
  const killAllWorkers = () => {
    shuttingDown = true
    for (const ch of children.values()) {
      try { ch.kill('SIGTERM') } catch {}
    }
    children.clear()
  }
  process.once('SIGTERM', () => { killAllWorkers(); process.exit(0) })
  process.once('SIGINT', () => { killAllWorkers(); process.exit(0) })
  process.once('exit', killAllWorkers)

  if (typeof config.onHub === 'function') config.onHub(hub)
  const spawnWorker = (index, attempt = 0) => {
    if (shuttingDown) return
    const id = names[index]
    const execArgv = process.execArgv.some(a => a.startsWith('--max-old-space-size'))
      ? process.execArgv
      : [...process.execArgv, `--max-old-space-size=${perWorkerHeapMb}`]
    const child = fork(path.join(__dirname, 'worker.js'), [], {
      execArgv,
      env: { ...process.env, MHB_WORKER_INDEX: String(index) },
      stdio: 'inherit'
    })
    children.set(id, child)
    hub.attach(id, index, child)
    const started = Date.now()
    let handled = false
    const onGone = (why) => {
      if (handled || shuttingDown) return
      handled = true
      hub.detach(id); children.delete(id)
      const up = Date.now() - started
      const delay = up > 60_000 ? 3000 : Math.min(30_000, 3000 * (attempt + 1))
      logger.warn(`${id}: process ended (${why}) after ${Math.round(up / 1000)}s; starting it again in ${Math.round(delay / 1000)}s`)
      setTimeout(() => spawnWorker(index, up > 60_000 ? 0 : attempt + 1), delay)
    }
    child.on('exit', (code, signal) => onGone(`code ${code}${signal ? ` ${signal}` : ''}`))
    child.on('error', error => onGone(error.message))
  }
  names.forEach((_, index) => spawnWorker(index))
  setInterval(() => {
    if (shuttingDown) return
    for (const id of hub.deadWorkers()) {
      logger.warn(`${id}: silent for too long, restarting its process`)
      children.get(id)?.kill()
    }
  }, 10_000).unref?.()
  await new Promise(() => {}) // the hub runs until the window is closed
}

async function startInProcess (config, createBuilderBot, logger) {
  const path = require('path')
  const { EventEmitter } = require('events')
  const { Hub } = require('./hub')
  const { ReplicaCoordinator } = require('./replica')
  const { Logger } = require('../core/logger')
  process.env.MHB_SHARED_PLAN = '1' // the schematic is analysed once and shared by every bot in this process
  const names = workerNames(config)
  const stateDir = path.resolve(path.join(__dirname, '..', '..'), config.paths.stateDir)
  const hub = new Hub({ logger, jobFile: path.join(stateDir, 'fleet-job.json'), resume: Boolean(config.server.resumeOnStart), loginGapMs: Number(config.fleet?.joinDelayMs ?? 6000), deadAfterMs: Number(config.fleet?.deadAfterMs ?? 90_000) })
  logger.info(`Starting ${names.length} builder(s) in ONE shared process (${names.join(', ')}) on ${detectContainerRamMb()} MB RAM -> ${config.server.host}:${config.server.port}`)
  if (hub.job) logger.info(`saved job found: ${hub.job.file} at ${hub.job.origin?.x},${hub.job.origin?.y},${hub.job.origin?.z}: the workers resume it by themselves (resume on start is on)`)
  if (typeof config.onHub === 'function') config.onHub(hub)
  const copy = m => { try { return structuredClone(m) } catch { return JSON.parse(JSON.stringify(m)) } }
  const runs = names.map((id, index) => {
    const wlogger = new Logger(id)
    const workerConfig = workerConfigFor(config, id)
    // a channel that behaves like a child process IPC pipe, but stays inside this process
    const ch = new EventEmitter()
    let toWorker = null
    ch.send = m => { const c = copy(m); setImmediate(() => { try { toWorker?.(c) } catch (error) { wlogger.warn(`hub message: ${error.message}`) } }) }
    const send = m => { const c = copy(m); setImmediate(() => ch.emit('message', c)) }
    const coord = new ReplicaCoordinator(names.length, { minGap: Number(config.fleet?.minGap ?? 6) }, send, id)
    const loginWaiters = []
    const fleet = {
      coord, id, index, count: names.length, ids: names,
      shared: { learner: new OrientationLearner(config.paths.stateDir, wlogger, id), experience: new Experience(config.paths.stateDir, wlogger, id) },
      handler: null, pending: [], say: null,
      send,
      relay: m => send({ t: 'cmd', from: id, ...m }),
      hello: () => send({ t: 'hello' }),
      jobDone: () => send({ t: 'jobdone' }),
      setHandler (fn) { this.handler = fn; const queued = this.pending.splice(0); for (const m of queued) fn(m) },
      gate: () => new Promise(resolve => {
        const timer = setTimeout(resolve, 60_000)
        loginWaiters.push(() => { clearTimeout(timer); resolve() })
        send({ t: 'login' })
      })
    }
    const dispatch = m => { if (fleet.handler) fleet.handler(m); else fleet.pending.push(m) }
    toWorker = m => {
      if (m.t === 'login-ok') { const r = loginWaiters.shift(); if (r) r(); return }
      if (m.t === 'say') { fleet.say?.(m.text); return }
      if (m.t === 'cmd') { dispatch(m); return }
      coord.apply(m)
      if (m.t === 'state' && m.job) dispatch({ t: 'cmd', cmd: 'start', file: m.job.file, origin: m.job.origin, rotation: m.job.rotation, startLayer: m.job.startLayer ?? null, continueMode: true, resume: true })
    }
    hub.attach(id, index, ch)
    setInterval(() => { coord.beat(id); coord.report() }, 500).unref?.()
    setInterval(() => { send({ t: 'ping', id }) }, 4000).unref?.()
    return superviseOne(workerConfig, fleet, createBuilderBot, wlogger).catch(error => wlogger.error(`fatal: ${error.stack || error.message}`))
  })
  let lastCpu = process.cpuUsage(); let lastAt = Date.now(); let lastTick = Date.now()
  setInterval(() => {
    const u = process.cpuUsage(lastCpu); const dt = (Date.now() - lastAt) * 1000; lastCpu = process.cpuUsage(); lastAt = Date.now()
    logger.info(`HEALTH: cpu ${Math.round(((u.user + u.system) / dt) * 100)}% | rss ${Math.round(process.memoryUsage().rss / 1048576)} MB | ${hub.snapshot().map(s => `${s.id}:${s.alive ? (s.done ? 'done' : s.target ? 'busy' : 'idle') : 'off'}`).join(' | ')}`.slice(0, 400))
  }, 30_000).unref?.()
  setInterval(() => {
    const now = Date.now(); const lag = now - lastTick - 500; lastTick = now
    if (lag >= 1500) logger.warn(`EVENT LOOP BLOCKED for ${(lag / 1000).toFixed(1)}s`)
  }, 500).unref?.()
  await Promise.all(runs)
  await new Promise(() => {})
}

// Real memory available to us. Containers (Render, Docker, Kubernetes) report the HOST's RAM in os.totalmem();
// the cgroup limit is the number that matters (exceed it and the kernel kills every bot at once).
function detectContainerRamMb () {
  const fs = require('fs')
  const os = require('os')
  const hostMb = Math.round(os.totalmem() / 1048576)
  let limitMb = null
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim()
      if (raw && raw !== 'max') {
        const n = Number(raw)
        if (Number.isFinite(n) && n > 0 && n < 2 ** 52) { limitMb = Math.round(n / 1048576); break }
      }
    } catch {}
  }
  if (limitMb && limitMb < hostMb) return limitMb
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) return Math.min(hostMb, 2048)
  return hostMb
}

// "inprocess" when asked for, and automatically on Render / any container with less than 6 GB: 8 Node processes
// need ~1.2 GB just idling and spike far above that when a big schematic is loaded by all of them at once.
function chooseFleetMode (config) {
  const want = String(config.fleet?.mode || 'auto')
  if (want === 'inprocess') return 'inprocess'
  if (want === 'processes_isolated') return 'processes'
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) return 'inprocess'
  return detectContainerRamMb() < 6144 ? 'inprocess' : 'processes'
}

module.exports = { startFleet, superviseOne, workerNames, workerConfigFor, detectContainerRamMb, chooseFleetMode }
