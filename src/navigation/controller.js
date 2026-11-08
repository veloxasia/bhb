'use strict'

const { Vec3, toVec3 } = require('../util/vec3')
const { sleep, waitFor } = require('../util/async')
const { supportUnder } = require('../world/ground')
const { Logger } = require('../core/logger')
const { checkAbort } = require('../util/abort')

const isDoorLike = name => /(_door|_fence_gate)$/.test(name) && !name.startsWith('iron_')

class NavigationController {
  constructor (bot, config, logger) {
    this.bot = bot
    this.config = config
    this.logger = logger
    this.pathfinderApi = null
    this.goals = null
    this.travelMovements = null
    this.accessMovements = null
    this.human = null
    this.initialized = false
    this.mode = 'travel'
    this.planner = null
    this.scaffoldItemIds = []
    this.lastPathStatus = null
    this.lastPathReason = null
    this.obstacleBreaker = null
  }

  async init () {
    const api = require('mineflayer-pathfinder')
    const { pathfinder, Movements, goals } = api
    let createHuman = api.createHuman
    try { createHuman = require('./human').createHuman } catch (e) { this.logger.warn?.(`vendored walker unavailable (${e.message}); using the package walker`) }
    this.pathfinderApi = api
    this.goals = goals
    this.bot.loadPlugin(pathfinder)

    const mcData = require('minecraft-data')(this.bot.version)
    this.travelMovements = new Movements(this.bot, mcData)
    this.configureTravelMovements(this.travelMovements)

    this.accessMovements = new Movements(this.bot, mcData)
    this.configureAccessMovements(this.accessMovements)
    this.rescueMovements = new Movements(this.bot, mcData)
    this.configureRescueMovements(this.rescueMovements)
    this.allowDoors(this.rescueMovements)
    this.allowDoors(this.travelMovements)
    this.allowDoors(this.accessMovements)

    this.bot.pathfinder.thinkTimeout = Number(this.config.navigation.thinkTimeoutMs || 6000)
    this.bot.pathfinder.tickTimeout = Number(this.config.navigation.tickTimeoutMs || 30)
    this.bot.pathfinder.searchRadius = Number(this.config.navigation.maxPathDistance || 256)
    this.bot.pathfinder.setMovements(this.travelMovements)
    this.bot.pathfinder.on?.('path_update', path => {
      this.lastPathStatus = path?.status || null
      this.lastPathReason = null
    })
    this.bot.pathfinder.on?.('path_reset', reason => { this.lastPathReason = reason || null })

    if (this.config.navigation.useHumanController !== false && typeof createHuman === 'function') {
      this.human = createHuman(this.bot, {
        seed: Number(this.config.navigation.humanSeed || 1337),
        personality: this.config.navigation.personality || {},
        movements: this.travelMovements,
        setback: { trip: 4, window: 2500, hold: 2000, quiet: 800 }, // rubber-banding must not freeze a bot for 8 s
        thinkTimeout: Number(this.config.navigation.thinkTimeoutMs || 6000)
      })
    }

    this.initialized = true
    this.logger.info('Navigation ready: active Pathfinder + human walking + GoalPlaceBlock placement search')
  }

  configureTravelMovements (m) {
    // never trample something that triggers a circuit (pressure plates, tripwires, detector rails)
    m.exclusionAreasStep.push(b => (b && typeof b.name === 'string' && /(pressure_plate|^tripwire$|^string$|detector_rail|sculk_sensor|sculk_shrieker)/.test(b.name) ? 150 : 0))
    // heavy penalty for stepping into hopper/cauldron/composter trenches or onto chest rows so bots walk on the flat deck
    m.exclusionAreasStep.push(b => (b && typeof b.name === 'string' && /^(hopper|cauldron|water_cauldron|lava_cauldron|composter|chest|trapped_chest)$/.test(b.name) ? 120 : 0))
    m.canDig = false
    m.allow1by1towers = false
    m.exclusionAreasStep.push(b => (this.holeCost && b && b.position && this.holeCost(b.position.x, b.position.z, b.position.y)) || 0)
    m.allowFreeMotion = false
    m.allowParkour = Boolean(this.config.navigation?.parkour !== false)
    m.allowSprinting = true
    m.allowEntityDetection = false
    // Allow 3-block drops on dry land (3-block drops deal 0 fall damage in Minecraft, avoiding pointless ender pearls!)
    m.maxDropDown = Number(this.config.navigation?.maxDropDown ?? 3)
    m.liquidCost = 250.0 // strictly forbid wading through water basins/trenches
    m.scafoldingBlocks = []
  }

  // last resort when no walkable route exists: build one like a player (bridge over gaps, pillar up)
  configureRescueMovements (m) {
    m.canDig = this.config.navigation?.rescueDig !== false
    m.digCost = 3
    m.exclusionAreasBreak = [block => (this.mustNotBreak(block) ? 100 : 0)]

    m.allow1by1towers = true
    m.allowFreeMotion = false
    m.allowParkour = false
    m.allowSprinting = true
    m.allowEntityDetection = false
    m.maxDropDown = Number(this.config.navigation?.rescueMaxDrop ?? 3)
    m.placeCost = 2
    m.liquidCost = 2.0
    m.scafoldingBlocks = this.scaffoldItemIds.slice()
  }

  configureAccessMovements (m) {
    m.canDig = false
    m.allow1by1towers = false
    m.allowFreeMotion = false
    m.allowParkour = Boolean(this.config.navigation?.parkour !== false)
    m.allowSprinting = true
    m.allowEntityDetection = false
    m.maxDropDown = Number(this.config.navigation?.accessMaxDrop ?? 3)
  }

  // finished blocks of the schematic and containers are never dug through; terrain, temporary scaffold and blocks
  // that are in the way of a still-pending schematic cell are fair game
  mustNotBreak (block) {
    if (!block) return true
    if (/chest|barrel|shulker|furnace|hopper|dropper|dispenser|crafter|spawner|bed$|sign|banner/.test(block.name)) return true
    const t = this.planner?.tasks?.get?.(`${block.position.x},${block.position.y},${block.position.z}`)
    return Boolean(t && (t.status === 'completed' || t.name === block.name))
  }

  setToolSupplier (fn) { this.supplyTools = typeof fn === 'function' ? fn : null }

  allowDoors (m) {
    const original = m.getBlock.bind(m)
    m.getBlock = (pos, dx, dy, dz) => {
      const b = original(pos, dx, dy, dz)
      if (b && b.name) {
        if (isDoorLike(b.name)) {
          b.safe = true; b.physical = false; b.replaceable = false
        } else if (/^(repeater|comparator|daylight_detector)$|_carpet$/.test(b.name) || (/_trapdoor$/.test(b.name) && !b.name.startsWith('iron_') && (b.getProperties?.()?.half || b.properties?.half) !== 'top' && String(b.getProperties?.()?.open ?? b.properties?.open) !== 'true')) {
          const below = original(pos, dx, dy - 1, dz)
          if (below && below.physical) {
            b.safe = true; b.physical = false; b.replaceable = false
          }
        }
      }
      return b
    }
  }

  isOpen (block) {
    const o = block.getProperties?.().open
    return o === true || o === 'true'
  }

  async clickBlock (block, why) {
    const bot = this.bot
    const center = block.position.offset(0.5, 0.5, 0.5)
    this.logger.debug?.(`${why} ${block.name} at ${block.position}`)
    await sleep(50 + Math.random() * 110)
    await bot.lookAt(center, false)
    await sleep(70 + Math.random() * 110)
    await bot.activateBlock(block)
  }

  async doorAssist (force = false) {
    const bot = this.bot
    const e = bot.entity
    if (!e || (!force && Date.now() - (this._lastDoor || 0) < 700)) return
    const eye = e.position.offset(0, 1.62, 0)
    const task = block => { const t = this.planner?.tasks?.get?.(`${block.position.x},${block.position.y},${block.position.z}`); return t || null }

    for (const [k, rec] of [...(this._opened || new Map())]) {
      const block = bot.blockAt(rec.pos)
      if (!block || !isDoorLike(block.name) || !this.isOpen(block)) { this._opened.delete(k); continue }
      const center = rec.pos.offset(0.5, 0.5, 0.5)
      const inside = Math.floor(e.position.x) === rec.pos.x && Math.floor(e.position.z) === rec.pos.z
      const passed = e.position.distanceTo(rec.from) > rec.from.distanceTo(center) + 1.1
      const d = eye.distanceTo(center)
      if (!inside && passed && d < 4.2) {
        this._lastDoor = Date.now(); this._opened.delete(k)
        try { await this.clickBlock(block, 'closing') } catch (error) { this.logger.debug?.(`close failed: ${error.message}`) }
        return
      }
      if (Date.now() - rec.at > 25_000) this._opened.delete(k)
    }

    const dir = { x: -Math.sin(e.yaw), z: -Math.cos(e.yaw) }
    const seen = new Set()
    for (const d of [0, 0.5, 1.0, 1.5, 2.0]) {
      for (const dy of [0, 1]) {
        const cell = new Vec3(Math.floor(e.position.x + dir.x * d), Math.floor(e.position.y + 0.1) + dy, Math.floor(e.position.z + dir.z * d))
        const k = `${cell.x},${cell.y},${cell.z}`
        if (seen.has(k)) continue
        seen.add(k)
        const block = bot.blockAt(cell)
        if (!block) continue
        const center = cell.offset(0.5, 0.5, 0.5)
        if (eye.distanceTo(center) > 3.4) continue
        const t = task(block)
        if (isDoorLike(block.name) && !this.isOpen(block)) {
          if (t && t.status !== 'completed') continue
          this._lastDoor = Date.now()
          this._opened = this._opened || new Map()
          this._opened.set(k, { pos: cell, at: Date.now(), from: e.position.clone() })
          try { await this.clickBlock(block, 'opening') } catch (error) { this.logger.debug?.(`door open failed: ${error.message}`) }
          return
        }
        if (/_trapdoor$/.test(block.name) && !block.name.startsWith('iron_') && this.isOpen(block) && !t && dy === 0 && cell.y >= Math.floor(e.position.y + 0.1)) {
          this._lastDoor = Date.now()
          try { await this.clickBlock(block, 'closing blocking trapdoor') } catch (error) { this.logger.debug?.(`trapdoor failed: ${error.message}`) }
          return
        }
      }
    }
  }

  setBrain (b) { this.brain = b }

  setLastResort (fn) { this.lastResort = typeof fn === 'function' ? fn : null }

  setScaffoldSupplier (fn) { this.supplyScaffold = typeof fn === 'function' ? fn : null }

  // Disabled: mineflayer-pathfinder's built-in 1x1 tower/bridge mode blindly places scaffold blocks over the bot's head
  // when in water or 1x1 shafts. All structural routing and escapes are handled by Brain + ExitManager instead.
  async rescueTo () {
    return false
  }

  setObstacleBreaker (fn) { this.obstacleBreaker = typeof fn === 'function' ? fn : null }

  setConstructionContext (planner, scaffoldNames = []) {
    this.planner = planner || null
    const ids = []
    for (const name of scaffoldNames) {
      const id = this.bot.registry?.itemsByName?.[name]?.id
      if (Number.isInteger(id)) ids.push(id)
    }
    this.scaffoldItemIds = ids
    this.scaffoldNames = scaffoldNames.slice()
    if (this.rescueMovements) this.rescueMovements.scafoldingBlocks = ids

    const plannerRef = this.planner
    const blockedSchematic = (block) => {
      if (!plannerRef || !block?.position) return 0
      const task = plannerRef.tasks.get(`${block.position.x},${block.position.y},${block.position.z}`)
      return task && task.status !== 'completed' ? 100 : 0
    }
    const blockedBreak = (block) => {
      if (!block) return 0
      if (this.isProtectedBlock(block)) return 100
      return blockedSchematic(block)
    }
    const fluidCell = block => {
      const t = plannerRef?.tasks?.get(`${block.position.x},${block.position.y},${block.position.z}`)
      return Boolean(t && t.kind === 'fluid')
    }
    const blockedPlace = block => (block?.position && fluidCell(block) ? 100 : blockedSchematic(block))
    if (this.accessMovements) {
      this.accessMovements.exclusionAreasBreak = [blockedBreak]
      this.accessMovements.exclusionAreasPlace = [blockedPlace]
    }
    if (this.rescueMovements) {
      this.rescueMovements.exclusionAreasBreak = [block => (this.mustNotBreak(block) ? 100 : 0)]
      this.rescueMovements.exclusionAreasPlace = [block => {
        if (!plannerRef || !block?.position) return 0
        if (fluidCell(block)) return 100
        const t = plannerRef.tasks.get(`${block.position.x},${block.position.y},${block.position.z}`)
        return t && t.status !== 'completed' ? 2 : 0
      }]
    }
  }

  isProtectedBlock (block) {
    const names = new Set([
      'chest', 'trapped_chest', 'barrel', 'hopper', 'furnace', 'blast_furnace', 'smoker',
      'dispenser', 'dropper', 'shulker_box', 'white_shulker_box', 'orange_shulker_box',
      'magenta_shulker_box', 'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box',
      'pink_shulker_box', 'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box',
      'purple_shulker_box', 'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box',
      'red_shulker_box', 'black_shulker_box', 'spawner', 'beacon', 'command_block',
      'chain_command_block', 'repeating_command_block', 'end_portal', 'end_portal_frame'
    ])
    return Boolean(block?.entity || names.has(block?.name))
  }

  useMode (mode) {
    this.mode = mode
    if (this.bot.pathfinder) this.bot.pathfinder.setMovements(mode === 'access' ? this.accessMovements : this.travelMovements)
  }

  stop () {
    try { this.human?.stop?.() } catch {}
    try { this.bot.pathfinder?.stop?.() } catch {}
    try { this.bot.pathfinder?.setGoal?.(null) } catch {}
    try { this.bot.clearControlStates() } catch {}
    this.mode = 'travel'
    try { this.bot.pathfinder?.setMovements?.(this.travelMovements) } catch {}
  }

  async goTo (position, radius = 0.55, timeoutMs = 60_000, options = {}) {
    if (!options._lastResort) return this._goTo_h(position, radius, timeoutMs, options)
    return require('../recovery/fall-guard').withHold(this.bot, () => this._goTo_h(position, radius, timeoutMs, options))
  }

  async _goTo_h (position, radius = 0.55, timeoutMs = 60_000, options = {}) {
    if (!this.initialized) throw new Error('Navigation controller is not initialized')
    const target = toVec3(position)
    const far = this.bot.entity ? this.bot.entity.position.distanceTo(target) : 0
    if (!options.work) timeoutMs = Math.min(Math.max(timeoutMs, 10_000 + far * 900), 60_000)
    const mode = options.mode === 'access' ? 'access' : 'travel'
    const useHuman = options.human !== false && this.human && mode === 'travel'
    const allowObstacleRecovery = options.allowObstacleBreak !== false && Boolean(this.config.materials?.autoBreakObstructions)
    let obstacleAttempted = false

    // Invoke upfront brain.prepare() whenever the target stand is elevated >= 1.5 blocks above us OR already known unreachable on foot (reachVerdict === "no");
    // if brain.prepare() proves no path/tower/pearl/exit can connect to target ("no"), fail fast instead of walking into a wall for 8s!
    if (this.brain && mode === 'travel' && options.rescue !== false && !options._lastResort && this.bot.entity && (target.y - this.bot.entity.position.y >= 1.5 || options.reachVerdict === 'no')) {
      let prep = null
      try { prep = await this.brain.prepare(target) } catch (brainError) { if (brainError.code === 'INTERRUPTED' || brainError.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(brainError.message)) throw brainError; this.logger.debug?.(`brain: ${brainError.message}`) }
      if (prep === 'no') throw new Error(`no path to (${target.x}, ${target.y}, ${target.z})`)
    }

    for (;;) {
      checkAbort()
      this.stop()
      this.useMode(mode)
      const start = this.bot.entity.position.clone()
      const deadline = Date.now() + timeoutMs

      try {
        if (useHuman) {
          try {
            await this.withUnstick(() => this.human.walkTo(target, { radius, timeout: timeoutMs, reactionScale: options.work ? 0.2 : 1 }), target, radius)
            await this.waitForStableGround(Math.min(2500, Math.max(400, deadline - Date.now())))
            this.assertNear(target, radius)
            return { method: 'human', start, end: this.bot.entity.position.clone() }
          } catch (error) {
            this.logger.debug?.(`human walk fallback: ${error.message}`)
            this.stop()
            this.useMode(mode)
            throw error
          }
        }

        const goal = new this.goals.GoalNear(target.x, target.y, target.z, Math.max(0.4, radius))
        const promise = this.bot.pathfinder.goto(goal)
        await this.withUnstick(() => this.watchNavigation(target, radius, promise, timeoutMs), target, radius)
        await this.waitForStableGround(Math.min(2500, Math.max(400, deadline - Date.now())))
        this.assertNear(target, radius)
        this.stop()
        return { method: mode === 'access' ? 'pathfinder-access' : 'pathfinder', start, end: this.bot.entity.position.clone() }
      } catch (error) {
        this.stop()
        if (error.code === 'INTERRUPTED' || error.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(error.message)) throw error
        if (options.rescue !== false && mode === 'travel' && !options._rescued) {
          options._rescued = true
          if (this.lastResort && !options._lastResort) {
            options._lastResort = true
            let moved = false
            try { moved = await this.lastResort(target, radius) } catch (lrError) { if (lrError.code === 'INTERRUPTED' || lrError.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(lrError.message)) throw lrError }
            if (moved) { continue }
            this.useMode(mode)
          }
          if (await this.rescueTo(target, radius, timeoutMs)) return { method: 'rescue', start, end: this.bot.entity.position.clone() }
          this.useMode(mode)
        }
        if (!allowObstacleRecovery || obstacleAttempted || !this.obstacleBreaker) throw error
        obstacleAttempted = true
        const changed = await this.obstacleBreaker().catch(obstacleError => {
          this.logger.debug?.(`obstacle recovery failed: ${obstacleError.message}`)
          return false
        })
        if (!changed) throw error
        this.logger.info(`Navigation obstacle cleared; replanning route to ${target}`)
      }
    }
  }

  async withUnstick (fn, target, radius, patient = false) {
    let done = false
    const bot = this.bot
    const watchdog = (async () => {
      let lastPos = bot.entity.position.clone(); let lastMove = Date.now(); let wiggles = 0
      let anchorPos = bot.entity.position.clone(); let anchorTime = Date.now()
      let lastWake = Date.now()
      for (;;) {
        await sleep(400)
        checkAbort()
        if (done || !bot.entity) return
        const now = Date.now()
        const loopLag = Math.max(0, now - lastWake - 400)
        lastWake = now
        if (loopLag > 800) {
          lastMove += loopLag
          anchorTime += loopLag
          continue
        }
        const p = bot.entity.position
        if (p.distanceTo(target) <= radius + 0.3) return
        let working = false
        try { working = Boolean(bot.targetDigBlock) || Boolean(bot.pathfinder?.isMining?.()) || Boolean(bot.pathfinder?.isBuilding?.()) } catch {}
        try { if (this.human?.planning) working = true } catch {}
        if (working) { lastMove = Date.now(); anchorTime = Date.now(); anchorPos = p.clone(); continue }
        if (p.distanceTo(anchorPos) > 0.55) {
          anchorPos = p.clone()
          anchorTime = Date.now()
        }
        const isFar = p.distanceTo(target) > 16
        const others = this.bot?.builder?.aim?.others?.() || []
        const closeOther = others.some(o => o && Math.hypot(o.x - p.x, o.z - p.z) <= 3.0 && Math.abs(o.y - p.y) <= 2.2)
        const effectivePatient = Boolean(patient || isFar || closeOther)
        const netStalled = Date.now() - anchorTime > Number(effectivePatient ? (closeOther ? 8000 : 7000) : 3400)
        if (p.distanceTo(lastPos) > 0.12 && !netStalled) { lastPos = p.clone(); lastMove = Date.now(); wiggles = 0; continue }
        if (netStalled || Date.now() - lastMove > Number(effectivePatient ? (closeOther ? 5000 : (this.config.navigation?.rescueUnstickMs || 6000)) : (this.config.navigation?.unstickAfterMs || 2500))) {
          if (wiggles >= 2) Logger.incident('nav-stuck', { message: `stuck at ${p.floored()} going to ${target}`, around: this.describeAround() })
          if (wiggles >= 2) throw new Error(`stuck at ${p.floored()} (no movement while walking to ${target})`)
          wiggles++
          this.logger.warn?.(`walking seems stuck at ${p.floored()}: trying to free the bot (${wiggles}/2)`)
          await this.unstick()
          lastPos = bot.entity.position.clone(); lastMove = Date.now()
          anchorPos = bot.entity.position.clone(); anchorTime = Date.now()
        }
      }
    })()
    const doors = (async () => {
      while (!done && bot.entity) {
        await sleep(180)
        if (done) return
        try { await this.doorAssist() } catch { /* best effort */ }
      }
    })()
    try { return await Promise.race([Promise.resolve().then(fn), watchdog]) } finally { done = true; void doors }
  }

  describeAround () {
    const out = {}
    try {
      const p = this.bot.entity.position.floored()
      for (let dy = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const b = this.bot.blockAt(p.offset(dx, dy, dz))
        if (b && b.name !== 'air') out[`${dx},${dy},${dz}`] = `${b.name}${JSON.stringify(b.getProperties?.() || {})}`
      }
    } catch {}
    return out
  }

  async unstick () {
    const bot = this.bot
    bot.clearControlStates()
    try { await this.doorAssist(true) } catch {}
    const e = bot.entity
    if (!e) return
    const ahead = bot.blockAt(e.position.offset(-Math.sin(e.yaw) * 0.9, 0.2, -Math.cos(e.yaw) * 0.9))
    const tall = ahead && /(fence|_wall$|_gate$|door)/.test(ahead.name)
    const safeDir = (keys) => {
      const fwd = (keys.includes('forward') ? 1 : 0) - (keys.includes('back') ? 1 : 0)
      const str = (keys.includes('left') ? 1 : 0) - (keys.includes('right') ? 1 : 0)
      if (!fwd && !str) return true
      const ux = fwd * -Math.sin(e.yaw) + str * -Math.cos(e.yaw)
      const uz = fwd * -Math.cos(e.yaw) + str * Math.sin(e.yaw)
      const fy = Math.floor(e.position.y + 0.01)
      for (const d of [0.5, 0.95]) {
        const fx = Math.floor(e.position.x + ux * d); const fz = Math.floor(e.position.z + uz * d)
        let hasFloor = false
        for (let k = 1; k <= 2; k++) {
          const b = bot.blockAt(new Vec3(fx, fy - k, fz))
          if (b && /^(hopper|cauldron|composter|lava|fire|soul_fire)$/.test(b.name)) return false
          if (b && b.boundingBox === 'block') { hasFloor = true; break }
        }
        if (!hasFloor) return false
        for (const dy of [0, -1, -2]) {
          const b = bot.blockAt(new Vec3(fx, fy + dy, fz))
          if (b && /^(lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|water)$/.test(b.name)) return false
        }
      }
      return true
    }
    const moves = [['jump'], ['back'], ['left'], ['right'], ['forward', 'jump']]
      .filter(m => !(tall && m.includes('forward')) && safeDir(m))
    const order = moves.sort(() => Math.random() - 0.5)
    for (const keys of order.slice(0, 3)) {
      checkAbort()
      if (!safeDir(keys)) continue
      for (const k of keys) bot.setControlState(k, true)
      await sleep(220 + Math.random() * 140)
      for (const k of keys) bot.setControlState(k, false)
      await sleep(60)
    }
    bot.clearControlStates()
  }

  buildPlaceGoal (targetPos, face, properties = {}) {
    const options = {
      range: Number(this.config.navigation.placementReach || 4.5),
      LOS: true,
      faces: [toVec3(face)]
    }
    if (typeof properties?.facing === 'string') options.facing = properties.facing
    if (typeof properties?.half === 'string') options.half = properties.half
    return new this.goals.GoalPlaceBlock(toVec3(targetPos), this.bot.world, options)
  }

  syncCap (ms) {
    const workers = Number(this.config.fleet?.workers || 1)
    if (workers <= 1) return Math.min(ms, 800)
    return Math.min(ms, Number(this.config.fleet?.maxBlockingSearchMs || 350))
  }

  async probePlacement (targetPos, face, timeoutMs = 8000, properties = {}) {
    await new Promise(resolve => setImmediate(resolve))
    const goal = this.buildPlaceGoal(targetPos, face, properties)
    if (this.isGoalCurrentlyValid(targetPos, face, properties)) {
      return { reachable: true, status: 'success', path: { status: 'success', path: [] }, endpoint: this.bot.entity.position.floored() }
    }
    const path = this.bot.pathfinder.getPathTo(this.travelMovements, goal, this.syncCap(timeoutMs))
    return {
      reachable: Boolean(path?.status === 'success' && path.path?.length),
      status: path?.status || 'none',
      path,
      endpoint: path?.path?.length ? path.path[path.path.length - 1] : null
    }
  }

  async reachPlacement (targetPos, face, timeoutMs = 8000, properties = {}) {
    const probe = await this.probePlacement(targetPos, face, timeoutMs, properties)
    if (!probe.reachable) return { ...probe, stand: null }

    const endpoint = probe.endpoint
    const stand = new Vec3(endpoint.x + 0.5, endpoint.y, endpoint.z + 0.5)

    try {
      await this.goTo(stand, 0.7, Math.max(20_000, timeoutMs * 8), { human: true })
    } catch (humanError) {
      this.logger.debug?.(`placement human route fallback: ${humanError.message}`)
      this.stop()
      this.useMode('travel')
      const goal = this.buildPlaceGoal(targetPos, face, properties)
      const promise = this.bot.pathfinder.goto(goal)
      await this.watchNavigation(stand, 0.8, promise, Math.max(20_000, timeoutMs * 8))
      this.stop()
    }

    const finalProbe = await this.probePlacement(targetPos, face, 1500, properties)
    if (!finalProbe.reachable && !this.isGoalCurrentlyValid(targetPos, face, properties)) {
      return { reachable: false, path: finalProbe.path, stand: null, status: 'endpoint-invalid-after-route' }
    }
    return { reachable: true, path: probe.path, stand: this.bot.entity.position.clone() }
  }

  isGoalCurrentlyValid (targetPos, face, properties = {}) {
    const goal = this.buildPlaceGoal(targetPos, face, properties)
    try {
      const p = this.bot.entity.position.floored()
      return Boolean(goal.isEnd({ x: p.x, y: p.y, z: p.z, remainingBlocks: 0 }))
    } catch (_) {
      return false
    }
  }

  async constructionReach (targetPos, radius = 1.2, timeoutMs = 25_000) {
    await new Promise(resolve => setImmediate(resolve))
    const pos = toVec3(targetPos)
    this.useMode('access')
    try {
      const goal = new this.goals.GoalNear(pos.x, pos.y, pos.z, radius)
      const path = this.bot.pathfinder.getPathTo(this.accessMovements, goal, this.syncCap(Number(this.config.navigation.placementThinkTimeoutMs || 8000)))
      if (!path || path.status !== 'success' || !path.path?.length) {
        throw new Error(`construction path unavailable status=${path?.status || 'none'}`)
      }
      const promise = this.bot.pathfinder.goto(goal)
      await this.watchNavigation(pos, radius, promise, timeoutMs)
      this.stop()
      return { reached: true, path }
    } finally {
      this.useMode('travel')
    }
  }

  async probeWalk (position, radius = 0.75, timeoutMs = 3000) {
    await new Promise(resolve => setImmediate(resolve))
    const target = toVec3(position)
    const goal = new this.goals.GoalNear(target.x, target.y, target.z, radius)
    const path = this.bot.pathfinder.getPathTo(this.travelMovements, goal, this.syncCap(timeoutMs))
    return { reachable: Boolean(path?.status === 'success'), status: path?.status || 'none', path }
  }

  async watchNavigation (target, radius, navigationPromise, timeoutMs) {
    const started = Date.now()
    let best = this.bot.entity.position.distanceTo(target)
    let lastImprovement = started
    let settled = false
    const watchdog = (async () => {
      while (!settled) {
        await sleep(120)
        if (!this.bot.entity) throw new Error('Bot entity disappeared during navigation')
        const distance = this.bot.entity.position.distanceTo(target)
        if (distance <= radius + 0.3) return
        if (distance + 0.08 < best) { best = distance; lastImprovement = Date.now() }
        if (Date.now() - started > timeoutMs) throw new Error(`Navigation timeout toward ${target}`)
        if (Date.now() - lastImprovement > Number(this.config.navigation.stuckTimeoutMs || 12000)) {
          throw new Error(`Navigation made no physical progress toward ${target}; status=${this.lastPathStatus || 'unknown'} reset=${this.lastPathReason || 'none'}`)
        }
        const vy = Number(this.bot.entity.velocity?.y)
        if (vy > 1.25 || vy < -5.25) throw new Error(`Unexpected vertical velocity ${vy.toFixed(3)}`)
      }
    })()
    try {
      await Promise.race([Promise.resolve(navigationPromise), watchdog])
    } finally {
      settled = true
    }
  }

  async waitForStableGround (timeoutMs) {
    const view = { blockAt: p => this.bot.blockAt(toVec3(p), false) }
    await waitFor(() => {
      const e = this.bot.entity
      if (!e) return false
      if (e.onGround) return true
      const vy = Math.abs(e.velocity?.y ?? 0)
      return vy < 0.1 && supportUnder(view, e.position).supported
    }, { timeoutMs, intervalMs: 50 }).catch(() => {})
  }

  assertNear (target, radius) {
    const d = this.bot.entity.position.distanceTo(target)
    if (d > Math.max(radius + 0.7, 1.35)) throw new Error(`Navigation ended too far from ${target}; actual=${this.bot.entity.position}`)
  }
}

module.exports = { NavigationController }
