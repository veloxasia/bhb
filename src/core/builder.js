'use strict'
const { Logger } = require('./logger')

const path = require('path')
const fs = require('fs')
const { BuildPlanner, keyOf } = require('../planner/build-planner')
const { WorldModel } = require('./world-model')
const { NavigationController } = require('../navigation/controller')
const { HumanInteractionEngine } = require('../interaction/human-interaction')
const { AimSolver } = require('../interaction/aim')
const { AimController } = require('../interaction/look')
const { Placer } = require('../interaction/placer')
const { ScaffoldManager } = require('../recovery/scaffold-manager')
const { GroundMonitor } = require('../world/ground')
const { FallGuard } = require('../recovery/fall-guard')
const { OrientationLearner, Experience, BuildMemory } = require('../learning/learner')
const { HumanBuildLogger } = require('../learning/human-logger')
const { Persistence } = require('../state/persistence')
const { MaterialManager } = require('./material-manager')
const { loadSchematic, buildTransform } = require('../schematic/loader')
const { sleep } = require('../util/async')
const { Survival } = require('../recovery/survival')
const { Brain } = require('../navigation/brain')
const { Vec3 } = require('../util/vec3')

const SUNKEN_TRAP = /^(hopper|chest|trapped_chest|ender_chest|cauldron|composter)$/

// Lets the event loop breathe between heavy start-up steps so keep-alive packets are always answered.
const yieldLoop = () => new Promise(resolve => setImmediate(resolve))

// When several bots share ONE process (fleet.mode "inprocess", the default on Render / small containers) the
// schematic is loaded and analysed once; every bot then gets a cheap copy of the finished plan.
const _planCache = new Map() // key -> Promise<{ loaded, planner, sequence, report }>
let _planChain = Promise.resolve() // only one heavy plan build at a time in this process

class ConstructionEngine {
  constructor (bot, config, logger, deps = {}) {
    this.bot = bot
    this.bot.builder = this
    this.config = config
    this.logger = logger
    this.world = new WorldModel(bot)
    this.navigation = deps.navigation || new NavigationController(bot, config, logger)
    this.materials = new MaterialManager(bot, config, logger)
    this.interaction = new HumanInteractionEngine(bot, this.world, config, logger, this.materials)
    this.persistence = new Persistence(config.paths.stateDir)
    this.ground = new GroundMonitor(bot, this.world, logger)
    this.fleet = deps.fleet || null
    this.learner = deps.learner || new OrientationLearner(config.paths.stateDir, logger)
    this.experience = deps.experience || new Experience(config.paths.stateDir, logger)
    this.look = null
    this.aim = null
    this.scaffold = null
    this.placer = null
    this.planner = null
    this.loaded = null
    this.jobId = null
    this.running = false
    this.manualPaused = false
    this.autoPaused = false
    this.stopRequested = false
    this.keepActiveJob = false
    this.actionsSinceSave = 0
    this.actionsSinceRescan = 0
    this.lastError = null
    this.lastLogAt = 0
    this.lastProgressAt = Date.now()
    this.fluidsSinceClear = 0
    this.report = null
    this.failureStats = new Map()
    this.failStreak = 0
    this.lastEscapeAt = 0
  }

  get paused () { return this.manualPaused || this.autoPaused }
  set paused (v) { this.manualPaused = Boolean(v) }

  async init () {
    await this.navigation.init()
    this.look = new AimController(this.bot, this.navigation, this.config, this.logger)
    this.aim = new AimSolver(this.bot, this.world, this.config, {
      isReserved: cell => this.isReserved(cell),
      isPending: cell => Boolean(this.planner && this.planner.isPendingCell(cell)),
      batchCount: (s, eye, target, reach) => (this.planner ? this.planner.batchCountFrom(s, eye, target, reach) : 0),
      isTemp: cell => Boolean(this.scaffold && this.scaffold.created.has(`${cell.x},${cell.y},${cell.z}`)),
      isHazard: cell => Boolean(
        (this.planner?.isActivePitCell ? this.planner.isActivePitCell(cell.x, cell.y, cell.z) : (this.planner?.pitCells && this.planner.pitCells.has(`${cell.x},${cell.y},${cell.z}`))) ||
        (this.buildMemory && this.buildMemory.isHazardWorldCell(cell))
      ),
      costBias: (spec, face, sneak) => this.experience.bias(`${spec.tag}|${face}|${sneak ? 1 : 0}`)
    })
    this.aim.setReachPenalty(this.experience.reachPenalty())
    this.scaffold = new ScaffoldManager({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, nav: this.navigation, interaction: this.interaction, materials: this.materials, look: this.look, ground: this.ground })
    this.survival = new Survival({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, materials: this.materials, look: this.look, ground: this.ground, nav: this.navigation, interaction: this.interaction, scaffold: this.scaffold })
    this.fallGuard = new FallGuard({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, navigation: this.navigation, ground: this.ground })
    this.fallGuard.attach()
    this.navigation.holeCost = (x, z, y) => {
      const by = Number.isFinite(y) ? Math.floor(y) : Math.floor(this.bot.entity?.position?.y || 0)
      const isSolidNonTrap = blk => Boolean(blk && blk.boundingBox === 'block' && !/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest|lava|water)$/.test(blk.name || ''))
      const b0 = this.world.blockAt(new Vec3(x, by, z))
      if (isSolidNonTrap(b0)) {
        const inPitAbove = this.planner?.isActivePitCell ? this.planner.isActivePitCell(x, by + 1, z) : false
        const memAbove = this.buildMemory && this.buildMemory.isHazardWorldCell({ x, y: by + 1, z }) ? 50 : 0
        return (inPitAbove ? 250 : 0) + memAbove
      }
      const b1 = this.world.blockAt(new Vec3(x, by - 1, z))
      const b2 = this.world.blockAt(new Vec3(x, by - 2, z))
      const b3 = this.world.blockAt(new Vec3(x, by - 3, z))
      if (isSolidNonTrap(b1) || ((!b1 || b1.boundingBox !== 'block') && (isSolidNonTrap(b2) || ((!b2 || b2.boundingBox !== 'block') && isSolidNonTrap(b3))))) {
        const feetY = isSolidNonTrap(b1) ? by : isSolidNonTrap(b2) ? by - 1 : by - 2
        const inPitFeet = this.planner?.isActivePitCell ? this.planner.isActivePitCell(x, feetY, z) : false
        const memFeet = this.buildMemory && this.buildMemory.isHazardWorldCell({ x, y: feetY, z }) ? 50 : 0
        return (inPitFeet ? 250 : 0) + memFeet
      }
      if ((!b1 || b1.boundingBox !== 'block') && (!b2 || b2.boundingBox !== 'block') && this.planner?.isPendingCell?.(new Vec3(x, by - 1, z))) {
        return 250
      }
      const k = this.fallGuard.holeKind(x, z, by)
      const base = k === 'lava' ? 80 : k === 'pit' ? 45 : k ? 40 : 0
      const inPit = (this.planner?.isActivePitCell ? (this.planner.isActivePitCell(x, by, z) || this.planner.isActivePitCell(x, by - 1, z)) : (this.planner?.pitCells && (this.planner.pitCells.has(`${x},${by},${z}`) || this.planner.pitCells.has(`${x},${by - 1},${z}`)))) ? 250 : 0
      const mem = this.buildMemory && this.buildMemory.isHazardWorldCell({ x, y: by, z }) ? 50 : 0
      return base + inPit + mem
    }
    this.brain = new Brain({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, nav: this.navigation, scaffold: this.scaffold, survival: this.survival, materials: this.materials, ground: this.ground })
    this.navigation.setBrain?.(this.brain)
    const { Teleporter } = require('../navigation/teleport')
    this.teleporter = new Teleporter({ bot: this.bot, config: this.config, logger: this.logger, fleet: this.fleet, stateDir: path.resolve(__dirname, '..', '..', this.config.paths?.stateDir || 'data'), nav: this.navigation })
    this.navigation.setLastResort?.(async target => (await this.brain.prepare(target, { force: true, walkFailed: true })) === 'connected' || await this.survival.lastResort(target) || await this.teleporter.assist(target))
    this.placer = new Placer({
      bot: this.bot, world: this.world, config: this.config, logger: this.logger, nav: this.navigation, interaction: this.interaction,
      isReserved: cell => this.isReserved(cell), materials: this.materials, aim: this.aim, look: this.look, scaffold: this.scaffold, ground: this.ground, learner: this.learner, experience: this.experience,
      interrupt: () => (this.stopRequested ? 'stop requested' : this.paused ? 'paused' : null)
    })
    this.placer.brain = this.brain
    const { LookaheadEngine } = require('../navigation/lookahead')
    this.lookahead = new LookaheadEngine({
      bot: this.bot,
      world: this.world,
      config: this.config,
      logger: this.logger,
      getPlanner: () => this.planner,
      getPlacer: () => this.placer,
      getNavigation: () => this.navigation,
      getGround: () => this.ground
    })
    this.placer.lookahead = this.lookahead
    const { ExitManager } = require('../recovery/exit')
    this.exit = new ExitManager({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, interaction: this.interaction, scaffold: this.scaffold, materials: this.materials, survival: this.survival, ground: this.ground, nav: this.navigation, getPlanner: () => this.planner, getPlacer: () => this.placer, incident: (t, d) => Logger.incident(t, { ...d, worker: this.bot.username }) })
    this.survival.exit = this.exit
    {
      const { FlightRecorder } = require('../intel/recorder'); const { Engine } = require('../intel/engine')
      const stateDir = path.resolve(__dirname, '..', '..', this.config.paths?.stateDir || 'data')
      this.recorder = new FlightRecorder({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, name: this.bot.username, getPlanner: () => this.planner, getScaffold: () => this.scaffold, getPhase: () => this.placer?.phase, isActive: () => Boolean(this.running) })
      this.engine = new Engine({ bot: this.bot, world: this.world, config: this.config, logger: this.logger, recorder: this.recorder, getPlanner: () => this.planner, getPlacer: () => this.placer, exit: this.exit, navigation: this.navigation, scaffold: this.scaffold, stateDir, name: this.bot.username })
      this.recorder.onLeak = (lk, cls) => this.engine.onLeak(lk, cls)
      this.recorder.onNearLava = i => {
        if (this.bot.entity?.position) {
          const f0 = this.bot.entity.position.floored()
          if (this.bot.entity.isInLava || this.world.blockAt(f0)?.name === 'lava') {
            this.buildMemory?.recordHazardCell?.(this.bot.entity.position, 'lava')
          }
        }
        this.engine.onNearLava(i)
      }
      this.recorder.onDamage = c => {
        if (this.bot.entity?.position && c?.cause === 'lava / fire') {
          this.buildMemory?.recordHazardCell?.(this.bot.entity.position, 'lava')
        }
        this.engine.onDamage(c)
      }
      this.recorder.onLoop = cls => { this.engine.solve('loop', { why: cls.cause }).catch(() => {}) }
      this.placer.recorder = this.recorder
      const learnedDir = path.resolve(__dirname, '..', '..', 'learned')
      this.humanLogger = new HumanBuildLogger({
        bot: this.bot,
        world: this.world,
        config: this.config,
        logger: this.logger,
        stateDir,
        learnedDir,
        getPlanner: () => this.planner,
        getSchematicName: () => this.loaded?.file ? path.basename(this.loaded.file) : 'default',
        isActive: () => Boolean(this.running),
        isFleetBot: username => username === this.bot.username || Boolean(this.fleet?.ids?.includes?.(username)) || Boolean(this.fleet?.coord?.workers?.has(username)),
        wasBotAction: (pos, k) => {
          if (this.fleet?.coord?.workers) {
            for (const w of this.fleet.coord.workers.values()) {
              if (w.target && (w.target.key === k || (Math.abs(w.target.x - pos.x) <= 1 && Math.abs(w.target.y - pos.y) <= 1 && Math.abs(w.target.z - pos.z) <= 1))) return true
            }
          }
          return false
        }
      })
      this.humanLogger.attach()
      const dig = this.interaction.digAimed.bind(this.interaction)
      this.interaction.digAimed = async (block, ...rest) => {
        const pos = block?.position ? block.position.clone() : null
        try { if (pos) { this.recorder.dig(pos); this.humanLogger?.noteBotCell?.(pos) } } catch { /* ok */ }
        try {
          return await dig(block, ...rest)
        } finally {
          try {
            if (pos && this.planner) {
              const t = this.planner.tasks.get(`${pos.x},${pos.y},${pos.z}`)
              if (t && t.status === 'completed') this.planner.reopenTask(pos, this.fleet?.index, { forceReset: true })
            }
          } catch {}
        }
      }
    }
    this.placer.exit = this.exit
    this.brain.rescue = (o = {}) => this.exit.escape({ goalCells: o.goalCells || null, why: 'brain: not reachable on foot', force: true })
    this.bot.once('end', () => {
      this.running = false
      clearInterval(this.statusTimer); this.statusTimer = null
      clearInterval(this.timeTimer); this.timeTimer = null
      if (this.fluidWatch) { try { this.bot.removeListener('blockUpdate', this.fluidWatch) } catch {}; this.fluidWatch = null }
      try { this.humanLogger?.detach() } catch {}
      try { this.fallGuard?.detach() } catch {}
    })
    if (process.env.MHB_TEST_WALK) {
      const go = async () => { try { if (!this.bot.entity) return setTimeout(go, 1500); await new Promise(r => setTimeout(r, 3000)); const [x, y, z] = process.env.MHB_TEST_WALK.split(',').map(Number); const t0 = Date.now(); await this.navigation.goTo(new Vec3(x + 0.5, y, z + 0.5), 0.6, 40000, { human: true, rescue: false }); this.logger.warn(`TEST-WALK arrived at ${this.bot.entity.position.floored()} in ${Date.now() - t0} ms`) } catch (e) { this.logger.warn(`TEST-WALK failed at ${this.bot.entity.position.floored()}: ${e.message}`) } }
      setTimeout(go, 3000)
    }
    if (process.env.MHB_TEST_SEAL) {
      const go = async () => { try { if (!this.bot.entity) return setTimeout(go, 1500); await new Promise(r => setTimeout(r, 3500)); const [x, y, z] = process.env.MHB_TEST_SEAL.split(',').map(Number); this.scaffold.created.set(`${x},${y},${z}`, new Vec3(x, y, z)); const r = await this.exit.removeTemp(new Vec3(x, y, z)); this.logger.warn(`TEST-SEAL result ${r}`) } catch (e) { this.logger.warn(`TEST-SEAL error ${e.stack}`) } }
      setTimeout(go, 3000)
    }
    if (process.env.MHB_TEST_EXIT) {
      const go = async () => { try { if (!this.bot.entity) return setTimeout(go, 1500); await new Promise(r => setTimeout(r, 4000)); const r = await this.exit.escape({ why: 'test hook', force: true }); this.logger.warn(`TEST-EXIT result ${JSON.stringify(r)}`) } catch (e) { this.logger.warn(`TEST-EXIT error ${e.stack}`) } }
      setTimeout(go, 3000)
    }
  }

  isReserved (cell) {
    const task = this.planner?.tasks?.get(keyOf(cell))
    return Boolean(task)
  }

  async ensureSafeBuildStart () {
    if (!this.bot.entity) return false
    if (this.bot.abilities?.flying) return false
    if (this.ground.state() === 'swimming') await this.survival?.escapeWater(10_000).catch(() => {})
    const state = await this.ground.waitSafe(Number(this.config.safety?.safeStartWaitMs || 8000))
    if (state !== 'grounded' && state !== 'resting') {
      this.logger.warn(`start refused: ${this.ground.describe()}`)
      return false
    }
    return !this.hazardUnderfoot()
  }

  hazardUnderfoot () {
    const f = this.bot.entity.position.floored()
    return [f, f.offset(0, 1, 0), f.offset(0, -1, 0)].some(p => this.world.isDangerous(p))
  }

  async startJob (file, origin, rotation = 0, opts = {}) {
    if (this.running) throw new Error('A build is already running')
    const continueMode = Boolean(opts?.continueMode || opts?.resume)
    const rawStartLayer = opts?.startLayer
    const startLayer = (rawStartLayer !== undefined && rawStartLayer !== null && rawStartLayer !== '' && Number.isFinite(Number(rawStartLayer)))
      ? Math.max(0, Math.floor(Number(rawStartLayer)))
      : null
    this.continueMode = continueMode
    this.startLayer = startLayer
    const originVec = new Vec3(Number(origin.x), Number(origin.y), Number(origin.z))
    if (!await this.ensureSafeBuildStart()) throw new Error(`BuilderBot is not on verified footing: ${this.ground.describe()}`)

    file = require('../state/paths').resolveSchematicFile(file, this.config.paths.schematicsDir)
    await yieldLoop()
    const sharedPlan = Boolean(this.fleet) && process.env.MHB_SHARED_PLAN === '1' && this.config.planning?.architect !== false
    let usedSharedArchitect = false
    if (sharedPlan) {
      const cacheKey = `${file}|${originVec.x},${originVec.y},${originVec.z}|${rotation}`
      let entry = _planCache.get(cacheKey)
      if (!entry) {
        for (const k of [..._planCache.keys()]) _planCache.delete(k) // keep only the current job in memory
        entry = (_planChain = _planChain.catch(() => {}).then(() => this.buildPlanTemplate(file, originVec, rotation)))
        _planCache.set(cacheKey, entry)
        entry.catch(() => { if (_planCache.get(cacheKey) === entry) _planCache.delete(cacheKey) })
      }
      const tpl = await entry
      this.loaded = tpl.loaded
      await yieldLoop()
      this.planner = BuildPlanner.cloneFromTemplate(tpl.planner, this.world, this.config, this.logger)
      if (tpl.sequence) {
        this.architectSequence = tpl.sequence.map(t => this.planner.tasks.get(t.key)).filter(Boolean)
        this.architectReport = tpl.report
        usedSharedArchitect = true
      }
      await yieldLoop()
    } else {
      this.loaded = await loadSchematic(file, this.bot)
      await yieldLoop()
      const transform = buildTransform(this.loaded.schematic, originVec, rotation)
      this.planner = await new BuildPlanner(this.loaded, transform, this.world, this.config, this.logger).buildAsync()
      await yieldLoop()
    }
    if (this.loaded.skipped?.length) this.logger.warn(`Blocks unknown to this Minecraft version are left out: ${this.loaded.skipped.join(', ')}`)
    if (this.planner.total > this.config.building.maxBuildTasks) {
      throw new Error(`Schematic contains ${this.planner.total} tasks; maxBuildTasks=${this.config.building.maxBuildTasks}`)
    }
    this.planner.learner = this.learner
    this.placer.planner = this.planner
    if (this.fleet) this.aim.others = () => { const out = []; for (const w of this.fleet.coord.workers.values()) { if (w.id === this.fleet.id) continue; const p = this.fleet.coord.position(w); if (p) out.push(p) } return out }
    this.planner.isTempCell = (x, y, z) => this.scaffold.created.has(`${x},${y},${z}`) || Boolean(this.fleet?.coord?.tempBlocks?.has(`${x},${y},${z}`))
    this.scaffold.noScaffold = pos => {
      const k = `${pos.x},${pos.y},${pos.z}`
      const t = this.planner.tasks.get(k)
      if (!t || t.kind !== 'fluid') return false
      const b = this.world.blockAt(pos)
      return t.status === 'completed' || Boolean(b && (b.name === 'water' || b.name === 'lava') && (Number(b.metadata) === 0 || String(b.getProperties?.()?.level ?? '0') === '0'))
    }
    this.aim.noScaffold = this.scaffold.noScaffold
    this.scaffold.dependants = pos => this.planner.tasksNear(pos, 5).some(t => t.status !== 'completed' && Math.abs(t.world.x - pos.x) <= 5 && Math.abs(t.world.z - pos.z) <= 5 && t.world.y >= pos.y - 1 && t.world.y <= pos.y + 6)
    this.planner.probe = task => this.placer.reachableNow(task)
    const usedBlocks = new Set()
    for (const t of this.planner.tasks.values()) {
      if (t.name) usedBlocks.add(t.name)
      if (t.item) usedBlocks.add(t.item)
    }
    const overworldCandidates = [...new Set([
      ...(this.config.building.scaffoldBlockNames || []),
      'cobbled_deepslate', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'netherrack', 'cobblestone', 'dirt', 'oak_planks', 'sandstone'
    ])].filter(name => !this.bot.registry?.itemsByName || Boolean(this.bot.registry.itemsByName[name]))
    const unusedCandidates = overworldCandidates.filter(name => !usedBlocks.has(name))
    const chosenScaffolds = unusedCandidates.length ? unusedCandidates : (overworldCandidates.length ? overworldCandidates : ['cobblestone'])
    const primaryScaffold = chosenScaffolds[0]
    this.scaffold.itemName = primaryScaffold
    this.materials.scaffoldBlockName = primaryScaffold
    this.logger.info(`SCAFFOLD: selected dedicated bridging block "${primaryScaffold}" (unused in schematic: ${unusedCandidates.length > 0})`)

    if (this.fleet) this.planner.joinFleet(this.fleet.coord, this.fleet.id, this.fleet.index, this.fleet.count)
    this.originVec = originVec
    this.materials.attachPlanner(this.planner)
    this.navigation.setConstructionContext(this.planner, chosenScaffolds)
    this.navigation.onScaffoldPlaced = pos => { try { this.scaffold.created.set(`${pos.x},${pos.y},${pos.z}`, pos); this.fleet?.coord?.addTempBlock?.(pos, this.fleet?.id) } catch {} }
    this.scaffold.phaseHook = name => this.placer.setPhase(name)
    this.survival.planner = this.planner
    this.brain.isTaskCell = (x, y, z) => this.planner.tasks.has(`${x},${y},${z}`) || this.planner.fluidCells.has(`${x},${y},${z}`)
    this.survival.isTaskCell = (x, y, z) => this.planner.tasks.has(`${x},${y},${z}`) || this.planner.fluidCells.has(`${x},${y},${z}`)
    this.navigation.setToolSupplier?.(() => this.materials.ensureToolKit())
    this.navigation.setScaffoldSupplier(n => this.materials.ensureItem(this.scaffold.itemName || (this.config.building.scaffoldBlockNames || ['cobblestone'])[0], n))

    const safeName = path.basename(file).replace(/[^a-zA-Z0-9._-]+/g, '_')
    this.baseJobId = `${safeName}-${originVec.x}-${originVec.y}-${originVec.z}-${rotation}`
    this.jobId = `${this.baseJobId}${this.fleet ? `-${this.fleet.id}` : ''}`
    this.buildMemory = new BuildMemory(this.config.paths.stateDir, safeName, rotation, this.logger)
    this.placer.buildMemory = this.buildMemory
    if (usedSharedArchitect) {
      const { apply } = require('../planner/architect')
      if (!this.planner.architectActive) apply(this.planner, this.architectSequence)
      if (!this.fleet || this.fleet.index === 0) this.logger.info(`ARCHITECT: ${this.architectReport.tasks} blocks in ${this.architectReport.layers} layer steps / ${this.architectReport.pieces} pieces (plan shared by all bots in this process)`)
    } else {
      this.runArchitect(originVec)
    }
    await yieldLoop()
    if (!this.fleet || this.fleet.index === 0) { try { this.analyze() } catch {} }
    if (this.planner.total <= 4000 && (!this.fleet || this.fleet.index === 0)) { try { this.preflight = await require('../planner/preflight').run(this.planner, { registry: this.bot.registry, world: this.world, logger: this.logger }) } catch (error) { this.logger.warn(`preflight failed (the build still runs): ${error.message}`) } }
    this.buildMemory.applyToPlanner(this.planner, Vec3)
    await yieldLoop()
    const savedCandidates = []
    const sOwn = await this.persistence.load(this.jobId)
    if (sOwn) savedCandidates.push(sOwn)
    if (this.baseJobId !== this.jobId) {
      const sBase = await this.persistence.load(this.baseJobId)
      if (sBase) savedCandidates.push(sBase)
    }
    try {
      const fsSync = require('fs')
      const stateDirs = [...new Set([this.config.paths.stateDir, path.resolve(process.cwd(), 'data')].filter(Boolean))]
      for (const dir of stateDirs) {
        if (!fsSync.existsSync(dir)) continue
        for (const fn of fsSync.readdirSync(dir)) {
          if (fn.startsWith(this.baseJobId) && fn.endsWith('.json')) {
            try {
              const parsed = JSON.parse(fsSync.readFileSync(path.join(dir, fn), 'utf8'))
              if (parsed?.planner) savedCandidates.push(parsed)
            } catch {}
          }
        }
      }
    } catch {}
    if (savedCandidates.length) {
      const mergedMap = new Map()
      const mergedTemps = new Map()
      for (const cand of savedCandidates) {
        for (const entry of cand.planner || []) {
          if (!entry?.key) continue
          const prev = mergedMap.get(entry.key)
          if (!prev || entry.status === 'completed' || (prev.status !== 'completed' && (entry.attempts || 0) > (prev.attempts || 0))) {
            mergedMap.set(entry.key, entry)
          }
        }
        for (const tb of cand.tempBlocks || []) {
          if (tb && Number.isFinite(tb.x)) mergedTemps.set(`${tb.x},${tb.y},${tb.z}`, tb)
        }
      }
      if (mergedMap.size) this.planner.restore([...mergedMap.values()], { trustSaved: Boolean(continueMode || this.fleet) })
      if (mergedTemps.size) this.scaffold.setCreated([...mergedTemps.values()])
    }
    if (startLayer !== null && startLayer > 0) {
      const skipped = this.planner.fastForwardBelowLayer(startLayer)
      this.logger.info(`CONTINUE: fast-forwarded ${skipped} task(s) below layer ${startLayer} (continuing from layer ${startLayer})`)
    } else if (continueMode) {
      const autoLayer = this.planner.detectResumeLayer()
      if (autoLayer > 0) {
        const skipped = this.planner.fastForwardBelowLayer(autoLayer)
        this.logger.info(`CONTINUE: auto-detected completed bottom layers 0..${autoLayer - 1} (${skipped} task(s) fast-forwarded); continuing from layer ${autoLayer}`)
      }
    }

    this.running = true
    this.keepActiveJob = true
    this.verifyRepairRounds = 0
    this.restoreRounds = 0
    this.save().catch(() => {})
    this.manualPaused = false
    this.autoPaused = false
    this.stopRequested = false
    this.lastError = null
    this.lastProgressAt = Date.now()
    this.report = null

    const c = this.planner.census
    if (this.fleet) this.logger.info(`FLEET: worker ${this.fleet.index + 1}/${this.fleet.count} owns ${this.planner.ownCount()} of ${this.planner.total} blocks`)
    clearInterval(this.timeTimer); this.timeTimer = setInterval(() => { try { if (this.running) this.logger.info(`TIME: ${this.placer.phaseReport()} | placed ${this.placer.stats.placed}`) } catch {} }, 60_000); this.timeTimer.unref?.()
    this.startDiagnostics()
    this.lookahead?.start?.()
    const { SweeperEngine, isSweeperWorker } = require('../fleet/sweeper')
    this.isSweeper = isSweeperWorker(this.fleet, this.config)
    if (this.fleet && this.isSweeper) {
      this.fleet.coord.register(this.fleet.id, this.fleet.index, this.bot, 'sweeper')
      this.sweeper = new SweeperEngine({
        builder: this, bot: this.bot, world: this.world, config: this.config, logger: this.logger,
        fleet: this.fleet, planner: this.planner, placer: this.placer, scaffold: this.scaffold,
        survival: this.survival, nav: this.navigation, exit: this.exit
      })
    } else {
      this.sweeper = null
    }
    this.logger.info(`Build loaded: ${this.loaded.schematic.size.x}x${this.loaded.schematic.size.y}x${this.loaded.schematic.size.z}; tasks=${this.planner.total}; completed=${this.planner.getStats().completed}; derived-by-game=${c.derived}; look-up placements=${c.lookUp}; unsupported=${c.unsupported.length}`)
    try {
      const far = this.bot.entity.position.distanceTo(this.originVec)
      if (far > 48) this.logger.warn(`the build site is ${Math.round(far)} blocks away: the bot has to walk there first (check the X, Y, Z you entered)`)
    } catch {}
    if (c.unsupported.length) this.logger.warn(`unsupported blocks (will be reported, not built): ${[...new Set(c.unsupported.map(u => u.name))].join(', ')}`)
    this.loop().catch(error => {
      this.lastError = error
      this.logger.error(`Build loop crashed: ${error.stack || error.message}`)
      this.running = false
    })
  }

  async resumeSavedJob () {
    if (this.running || !this.config.server.resumeOnStart) return false
    const active = await this.persistence.loadActive()
    if (!active?.file || !active?.origin) return false
    if (!await this.ensureSafeBuildStart()) throw new Error('not on safe ground yet')
    await this.startJob(active.file, active.origin, active.rotation || 0, {
      continueMode: true,
      startLayer: active.startLayer ?? null
    })
    return true
  }

  pause (reason = 'manual pause') {
    this.manualPaused = true
    this.navigation.stop()
    if (reason) this.logger.warn(`BUILD PAUSED: ${reason}`)
  }

  resume () {
    this.manualPaused = false
    this.autoPaused = false
    if (this.bot.recovery) { this.bot.recovery.paused = false; this.bot.recovery.reason = null }
    this.logger.info('BUILD RESUME requested')
  }

  shutdown () {
    this.stopRequested = true
    clearInterval(this.idleTimer); this.idleTimer = null
    clearInterval(this.statusTimer); this.statusTimer = null
    try { this.placer.abortActive('connection closed') } catch {}
    this.keepActiveJob = true
    try { this.navigation.stop() } catch {}
    this.fleet?.coord.release(this.fleet.id)
  }

  stop () {
    this.keepActiveJob = false
    this.stopRequested = true
    this.manualPaused = false
    this.autoPaused = false
    try { this.placer?.abortActive('build stopped') } catch {}
    try { this.navigation.stop() } catch {}
  }

  async humanBetween () {
    // Continuous non-stop placement: no artificial wait between tasks!
  }

  async save () {
    if (!this.planner || !this.jobId) return
    if (this.fleet && this.fleet.index > 0) return
    const payload = {
      version: 3,
      jobId: this.jobId,
      baseJobId: this.baseJobId || this.jobId,
      schematic: this.loaded?.file,
      origin: { x: this.planner.transform.origin.x, y: this.planner.transform.origin.y, z: this.planner.transform.origin.z },
      rotation: this.planner.rotation,
      startLayer: this.startLayer ?? null,
      planner: this.planner.serialize(),
      tempBlocks: this.scaffold.getCreated().map(p => ({ x: p.x, y: p.y, z: p.z })),
      updatedAt: new Date().toISOString()
    }
    await this.persistence.save(this.jobId, payload)
    if (this.baseJobId && this.baseJobId !== this.jobId) {
      await this.persistence.save(this.baseJobId, payload).catch(() => {})
    }
    if (this.fleet?.relay) return
    if (this.keepActiveJob) {
      const activeObj = {
        file: this.loaded?.file,
        origin: { x: this.planner.transform.origin.x, y: this.planner.transform.origin.y, z: this.planner.transform.origin.z },
        rotation: this.planner.rotation,
        jobId: this.jobId,
         updatedAt: new Date().toISOString()
      }
      if (this.startLayer != null) activeObj.startLayer = this.startLayer
      await this.persistence.saveActive(activeObj)
    } else {
      await this.persistence.clearActive()
    }
  }

  verifyAll () {
    if (!this.planner) throw new Error('No build loaded')
    let correct = 0; const wrong = []; let unknown = 0
    for (const task of this.planner.tasks.values()) {
      const actual = this.world.blockAt(task.world)
      if (!actual) unknown++
      else if (this.planner.isCorrect(task)) correct++
      else wrong.push(task)
    }
    return { total: this.planner.total, correct, wrong: wrong.length, wrongTasks: wrong, unknown, complete: correct === this.planner.total }
  }

  adoptNearbyPartnerScaffolds (radius = 4, onlyStackedOrLadder = true) {
    try {
      if (!this.bot?.entity || !this.planner?.box || !this.scaffold?.itemName) return 0
      const scName = this.scaffold.itemName
      if (this.planner.materialDemand?.has(scName)) return 0
      const p = this.bot.entity.position.floored()
      const bx = this.planner.box
      let added = 0
      for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
          const x = p.x + dx; const z = p.z + dz
          if (x < bx.x0 - 2 || x > bx.x1 + 2 || z < bx.z0 - 2 || z > bx.z1 + 2) continue
          for (let dy = -2; dy <= 3; dy++) {
            const y = p.y + dy
            if (y < bx.y0 || y > bx.y1 + 2) continue
            const k = `${x},${y},${z}`
            if (this.scaffold.created.has(k) || this.planner.tasks.has(k)) continue
            const blk = this.world.blockAt(new Vec3(x, y, z))
            if (!blk || blk.name !== scName) continue
            if (onlyStackedOrLadder) {
              const stacked = this.world.blockAt(new Vec3(x, y + 1, z))?.name === scName || this.world.blockAt(new Vec3(x, y - 1, z))?.name === scName
              const adjLadder = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([lx, lz]) => this.world.blockAt(new Vec3(x + lx, y, z + lz))?.name === 'ladder')
              if (!stacked && !adjLadder) continue
            }
            const v = new Vec3(x, y, z)
            v.createdAt = Date.now() - 10_000
            this.scaffold.created.set(k, v)
            added++
          }
        }
      }
      return added
    } catch { return 0 }
  }

  async cleanupTemporary () {
    this.adoptNearbyPartnerScaffolds(14, false)
    const before = this.scaffold.getCreated().length
    const remaining = await this.placer.cleanupAll()
    await this.save()
    return { before, remaining }
  }

  writeReport (result) {
    try {
      const unsupported = this.planner.census.unsupported
      this.report = {
        finishedAt: new Date().toISOString(), job: this.jobId,
        total: result.total, correct: result.correct, wrong: result.wrong, unknown: result.unknown,
        blocked: [...this.planner.blocked].slice(0, 200),
        quarantined: [...(this.planner.quarantined || [])].slice(0, 200),
        unsupported: unsupported.slice(0, 200),
        problems: result.wrongTasks.slice(0, 300).map(t => ({ at: `${t.world.x},${t.world.y},${t.world.z}`, wanted: t.name, properties: t.properties, status: t.status, attempts: t.attempts, error: t.lastError }))
      }
      fs.mkdirSync(path.resolve(this.config.paths.stateDir), { recursive: true })
      const file = path.join(path.resolve(this.config.paths.stateDir), `${this.jobId}.report.json`)
      fs.writeFileSync(file, JSON.stringify(this.report, null, 2))
      return file
    } catch (error) { this.logger.warn(`report write failed: ${error.message}`); return null }
  }

  // Builds a pristine plan (no world state, no fleet zones) that every bot in this process copies.
  async buildPlanTemplate (file, originVec, rotation) {
    const t0 = Date.now()
    const loaded = await loadSchematic(file, this.bot)
    await yieldLoop()
    const transform = buildTransform(loaded.schematic, originVec, rotation)
    const planner = await new BuildPlanner(loaded, transform, this.world, this.config, this.logger).buildAsync({ skipWorldReconcile: true })
    await yieldLoop()
    let sequence = null; let report = null
    try {
      const { plan, apply } = require('../planner/architect')
      const res = plan(planner, { stripe: Number(this.config.planning?.stripeWidth || 1), start: { x: originVec.x, z: originVec.z } })
      apply(planner, res.sequence)
      sequence = res.sequence; report = res.report
      for (const w of report.warnings || []) this.logger.warn(`ARCHITECT: ${w}`)
    } catch (error) {
      this.logger.warn(`architect failed, using nearest-first order: ${error.message}`)
    }
    this.logger.info(`PLAN: ${planner.total} tasks analysed once in ${Date.now() - t0} ms and shared with every bot in this process`)
    return { loaded, planner, sequence, report }
  }

  runArchitect (origin) {
    if (this.config.planning?.architect === false) return null
    try {
      const { plan, apply } = require('../planner/architect')
      const { sequence, report } = plan(this.planner, { stripe: Number(this.config.planning?.stripeWidth || 1), start: origin ? { x: origin.x, z: origin.z } : undefined })
      apply(this.planner, sequence)
      this.architectReport = report
      this.architectSequence = sequence
      const intel = report.intelligence
      this.logger.info(`ARCHITECT: ${report.tasks} blocks in ${report.layers} layer steps / ${report.pieces} pieces, ~${report.walkBlocks} blocks of walking, estimated ${report.estimatedMinutes} min${intel ? ` (intel: ${intel.overhungBlocks} overhung, ${intel.sunkenTrenches} sunken, ${intel.enclosedPockets} pockets in ${intel.analysisMs}ms)` : ''}`)
      for (const w of report.warnings) this.logger.warn(`ARCHITECT: ${w}`)
      try {
        fs.mkdirSync(path.resolve(this.config.paths.stateDir), { recursive: true })
        fs.writeFileSync(path.join(path.resolve(this.config.paths.stateDir), `${this.jobId || 'job'}.plan.json`), JSON.stringify(report, null, 2))
      } catch {}
      return report
    } catch (error) {
      this.logger.warn(`architect failed, using nearest-first order: ${error.message}`)
      Logger.incident('architect-failed', { message: error.message, stack: error.stack })
      return null
    }
  }

  async maybeSetHome (task) {
    try {
      if (!this.teleporter || Date.now() - (this.lastHomeCheck || 0) < 20_000) return
      this.lastHomeCheck = Date.now()
      if (this.ground.state() !== 'grounded') return
      const p = this.bot.entity.position
      const fx = Math.floor(p.x); const fy = Math.floor(p.y) - 1; const fz = Math.floor(p.z)
      const key = `${fx},${fy},${fz}`
      if (this.scaffold.created.has(key)) return
      const t = this.planner.tasks.get(key)
      if (t && t.status !== 'completed') return
      const floor = this.bot.blockAt(p.offset(0, -1, 0))
      if (!floor || /ice|slab|stair|carpet|snow|water|lava|leaves/.test(floor.name)) return
      await this.teleporter.maintain(task.world, true)
    } catch { /* never blocks the build */ }
  }

  snapshot (task, error) {
    const out = { type: 'task-failure', worker: this.bot.username, code: error.code || 'ERR', message: error.message, stack: (error.stack || '').split('\n').slice(0, 6).join(' | ') }
    try {
      const e = this.bot.entity
      out.bot = { pos: e.position.toString(), yaw: +e.yaw.toFixed(2), pitch: +e.pitch.toFixed(2), vel: e.velocity.toString(), onGround: e.onGround, health: this.bot.health, held: this.bot.heldItem?.name || null, sneaking: this.bot.getControlState('sneak'), state: this.ground.state(), ground: this.ground.describe?.() }
      out.nav = { mode: this.navigation.mode, pathStatus: this.navigation.lastPathStatus, pathReset: this.navigation.lastPathReason }
      if (task) out.task = { name: task.name, kind: task.kind, at: `${task.world.x},${task.world.y},${task.world.z}`, attempts: task.attempts, props: task.properties }
      const p = e.position.floored(); const near = {}
      for (let dy = -1; dy <= 2; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const b = this.bot.blockAt(p.offset(dx, dy, dz))
        if (b && b.name !== 'air') near[`${dx},${dy},${dz}`] = `${b.name}${b.getProperties ? JSON.stringify(b.getProperties()) : ''}`
      }
      out.nearby = near
      out.stats = this.planner.getStats()
      out.inventory = this.bot.inventory.items().slice(0, 12).map(i => `${i.name}x${i.count}`)
    } catch (snapError) { out.snapshotError = snapError.message }
    return out
  }

  async escapeIfInTrenchOrPit () {
    if (!this.bot.entity || !this.exit || this.exit.running) return false
    if (Date.now() - (this.lastTrenchCheckAt || 0) < 500) return false
    this.lastTrenchCheckAt = Date.now()
    const p = this.bot.entity.position
    const { feetCellOf } = require('../world/ground')
    const fc = feetCellOf(this.world, p)
    const under = this.world.blockAt(new Vec3(fc.x, fc.y - 1, fc.z))
    const atFeet = this.world.blockAt(new Vec3(fc.x, fc.y, fc.z))
    const rawFloor = this.world.blockAt(p.floored())
    const onSunken = SUNKEN_TRAP.test(under?.name || '') || SUNKEN_TRAP.test(atFeet?.name || '') || SUNKEN_TRAP.test(rawFloor?.name || '')
    let walledHead = 0
    let walledBoth = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w0 = this.world.blockAt(new Vec3(fc.x + dx, fc.y, fc.z + dz))
      const w1 = this.world.blockAt(new Vec3(fc.x + dx, fc.y + 1, fc.z + dz))
      if (w1 && w1.boundingBox === 'block') {
        walledHead++
        if (w0 && w0.boundingBox === 'block') walledBoth++
      }
    }
    let walledFeet = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wf = this.world.blockAt(new Vec3(fc.x + dx, fc.y, fc.z + dz))
      if (wf && wf.boundingBox === 'block') walledFeet++
    }
    const inUnbuiltFloorHole = Boolean(walledFeet >= 2 && this.planner?.isPendingCell?.(new Vec3(fc.x, fc.y, fc.z)))
    const inPitCell = Boolean(
      (this.planner?.isActivePitCell ? this.planner.isActivePitCell(fc.x, fc.y, fc.z) : this.planner?.pitCells?.has(`${fc.x},${fc.y},${fc.z}`)) ||
      walledHead >= 4 ||
      inUnbuiltFloorHole ||
      (walledBoth >= 3 && this.planner?.pitCells?.has(`${fc.x},${fc.y},${fc.z}`))
    )
    const onBottomSlab = inPitCell && Boolean(atFeet && /_slab$/.test(atFeet.name || '') && (atFeet.getProperties?.()?.type || atFeet.properties?.type) === 'bottom')
    const rawInWater = atFeet?.name === 'water' || Boolean(this.bot.entity.isInWater)
    if (rawInWater) {
      if (!this._waterSince) this._waterSince = Date.now()
    } else {
      this._waterSince = 0
    }
    const atHead = this.world.blockAt(new Vec3(fc.x, fc.y + 1, fc.z))
    const deepWater = rawInWater && (atHead?.name === 'water' || atHead?.name === 'bubble_column' || !under || under.boundingBox !== 'block')
    const inWater = rawInWater && (deepWater || inPitCell || walledHead >= 2 || (Date.now() - (this._waterSince || Date.now()) >= 2500))
    if (!onSunken && !onBottomSlab && !inWater && !inPitCell) return false
    if (inWater && !onSunken && !onBottomSlab && this.exit?.lastWaterEscapeAt && Date.now() - this.exit.lastWaterEscapeAt < 3500) return false
    const trenchKey = `${fc.x},${fc.y},${fc.z}`
    if (this._lastTrenchKey === trenchKey && Date.now() - (this._lastTrenchAt || 0) < 4000) return false
    this._lastTrenchKey = trenchKey
    this._lastTrenchAt = Date.now()
    this.navigation.stop()
    const why = onSunken ? `standing in sunken ${under?.name || rawFloor?.name || 'container'} trench` : onBottomSlab ? 'trapped on bottom slab in shaft' : inWater ? 'in water basin/trench' : 'inside restricted pit/shaft'
    const r = await this.exit.escape({ why, force: true, maxMs: 6_000 })
    if (r?.escaped) {
      this.failStreak = 0
      this.planner?.reconcileRegion?.(this.bot.entity.position, 8)
    }
    return Boolean(r?.escaped)
  }

  async escapeIfWalledIn (why, goalPos = null) {
    if (Date.now() - this.lastEscapeAt < 4000 || !this.bot.entity) return false
    try {
      this.lastEscapeAt = Date.now()
      this.navigation.stop()
      const goalCells = goalPos && this.bot.entity.position.distanceTo(goalPos) > 10
        ? [goalPos.floored ? goalPos.floored() : new Vec3(Math.floor(goalPos.x), Math.floor(goalPos.y), Math.floor(goalPos.z))]
        : undefined
      const r = await this.exit.escape({ why: `stuck (${why})`, goalCells })
      if (r.escaped && r.reason !== 'not trapped') {
        this.failStreak = 0
        this.planner.reconcileRegion(this.bot.entity.position, 8)
      }
      if (r.reason === 'not trapped') return false
      return r.escaped
    } catch (error) { this.logger.warn(`escape failed: ${error.message}`); return false }
  }

  noteFailure (task, error) {
    try { Logger.incident('task-failure', { ...this.snapshot(task, error), extra: error.extra }) } catch {}
    try { this.buildMemory?.recordFailure?.(task, error) } catch {}
    const k = `${task.name}|${error.code || 'ERR'}`
    const row = this.failureStats.get(k) || { count: 0, sample: '' }
    row.count++
    row.sample = `(${task.world.x},${task.world.y},${task.world.z}) ${error.message}`.slice(0, 220)
    this.failureStats.set(k, row)
  }

  failureSummary (limit = 12) {
    return [...this.failureStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, limit).map(([k, v]) => `${v.count}x ${k} e.g. ${v.sample}`)
  }

  throttledWarn (message) {
    const now = Date.now()
    if (now - this.lastLogAt >= Number(this.config.building.accessStallLogIntervalMs || 15000)) {
      this.lastLogAt = now
      this.logger.warn(message)
    }
  }

  startIdleWatchdog () {
    if (this.idleTimer) return
    let last = { pos: null, at: Date.now(), phaseSince: 0 }
    let wiggled = false
    this.idleTimer = setInterval(() => {
      try {
        if (!this.running || this.paused || !this.bot.entity || !this.placer.activeRun) { last = { pos: null, at: Date.now(), phaseSince: 0 }; wiggled = false; return }
        const pos = this.bot.entity.position
        let working = false
        try { working = Boolean(this.bot.targetDigBlock) || Boolean(this.bot.pathfinder?.isMining?.()) || Boolean(this.bot.pathfinder?.isBuilding?.()) } catch {}
        const moved = (last.pos && pos.distanceTo(last.pos) > 0.3) || working
        if (!last.pos || moved || last.phaseSince !== this.placer.phaseSince) { last = { pos: pos.clone(), at: Date.now(), phaseSince: this.placer.phaseSince }; wiggled = false; return }
        const idle = Date.now() - last.at
        const baseWiggle = Number(this.config.navigation?.idleWiggleMs || 4_000)
        const isComplexPhase = /reference block|support|tower|bridg|scaffold|walking to stand|obstacle/i.test(this.placer.phase || "")
        const wiggleAfter = isComplexPhase ? Math.max(12_000, baseWiggle * 3) : Math.max(6_000, baseWiggle)
        if (idle > wiggleAfter && !wiggled) {
          wiggled = true
          Logger.incident('idle-stall', { ...this.snapshot(null, new Error(`no movement or progress for ${Math.round(idle / 1000)}s while: ${this.placer.phase}`)), phase: this.placer.phase })
          this.logger.warn(`idle for ${Math.round(idle / 1000)}s in "${this.placer.phase}": wiggling free`)
          this.bot.clearControlStates()
          this.placer.abortActive('stuck: checking whether the bot is walled in')
          Promise.resolve()
            .then(() => this.escapeIfInTrenchOrPit())
            .then(out => out || this.escapeIfWalledIn('idle watchdog'))
            .then(out => out || (this.exit ? this.exit.escape({ why: 'idle pit/pillar watchdog', force: true, maxMs: 12_000 }).then(r => r?.escaped) : false))
            .then(out => { if (!out) return this.navigation.unstick().catch(() => {}) })
            .catch(() => {})
        } else if (idle > wiggleAfter + 4_500) {
          this.logger.warn(`still stuck in "${this.placer.phase}": abandoning this task`)
          this.placer.abortActive(`no progress for ${Math.round(idle / 1000)}s`)
          this.navigation.stop()
          last = { pos: null, at: Date.now(), phaseSince: 0 }
        }
      } catch { /* watchdog must never throw */ }
    }, 2000)
  }

  async loop () {
    this.startIdleWatchdog()
    this.lookahead?.start?.()
    if (this.isSweeper && this.sweeper) {
      try {
        await this.sweeper.runLoop()
      } finally {
        this.lookahead?.stop?.()
      }
      return
    }
    const giveUpMs = Math.max(20 * 60_000, Number(this.config.building.giveUpAfterMs || 20 * 60_000))
    const fleet = this.fleet
    if (this.fleet && this.fleet.index > 0 && !this.continueMode) {
      await sleep(Math.min(6000, this.fleet.index * 800))
    }
    while (this.running && !this.stopRequested) {
      if (fleet) { fleet.coord.release(fleet.id); fleet.coord.beat(fleet.id) }
      if (this.paused) { await sleep(100); continue }
      if (this.bot._client?.ended) { this.stopRequested = true; break }
      if (!this.bot.entity) { await sleep(200); continue }

      const stats = this.planner.getStats()
      if (stats.remaining === 0 && stats.blocked > 0 && (this.rounds || 0) < (fleet ? 8 : 6)) {
        if (Date.now() - (this.lastRevive || 0) > 1_200) {
          this.lastRevive = Date.now()
          this.rounds = (this.rounds || 0) + 1
          this.scaffold?.clearChurn?.()
          const n = this.planner.revive({ includeQuarantined: true })
          this.logger.info(`retry round ${this.rounds}: ${n} blocks back in the queue`)
          this.lastProgressAt = Date.now()
          continue
        }
      }
      if (stats.remaining === 0) {
        if (fleet) { if (await this.fleetFinish()) break; continue }
        if (await this.finish()) break
        continue
      }

      await this.survival?.tick().catch(() => {})
      if (this.materials && typeof this.materials.emptySlotCount === 'function' && this.materials.emptySlotCount() < 4 && Date.now() - (this._lastRoomAt || 0) > 8_000) {
        this._lastRoomAt = Date.now()
        await this.materials.makeRoom?.(6).catch(() => {})
      }
      if (this.materials && this.scaffold?.itemName && this.config.building?.allowTemporaryScaffolding !== false && Date.now() - (this._lastScafTopUpAt || 0) > 15_000) {
        const scafHave = this.materials.countInInventory?.(this.scaffold.itemName) ?? 64
        if (scafHave < 16) {
          this._lastScafTopUpAt = Date.now()
          await this.materials.ensureItem?.(this.scaffold.itemName, 64).catch(() => {})
        }
      }
      if (this.fallGuard?.fell) await this.fallGuard.recover().catch(() => {})
      await this.escapeIfInTrenchOrPit().catch(() => {})
      if (!this.joinedChecked && this.originVec) { this.joinedChecked = true; await this.teleporter?.returnToWork(this.originVec, 'joined far from the site').catch(() => {}) }
      const pos = this.bot.entity.position
      let task = this.planner.next(pos)
      if (!task) task = this.planner.nextCandidate(pos)
      if (!task) {
        const lastProgress = fleet ? Math.max(this.lastProgressAt, fleet.coord.lastProgressAt) : this.lastProgressAt
        if (Date.now() - (this.lastAny || 0) > 120) {
          this.lastAny = Date.now()
          const any = this.planner.nextAny(pos)
          if (any) { this.logger.info(`nothing left under the normal rules; taking ${any.name} at ${any.world.x},${any.world.y},${any.world.z} anyway (${JSON.stringify(this.planner.lastAnyCounts)})`); task = any }
        }
        if (task) { /* handled below */ } else
        if (Date.now() - lastProgress > 1_200 && (this.rounds || 0) < (fleet ? 8 : 6) && Date.now() - (this.lastRevive || 0) > 1_200) {
          this.lastRevive = Date.now(); this.rounds = (this.rounds || 0) + 1
          this.scaffold?.clearChurn?.()
          const revived = this.planner.revive()
          if (revived > 0) this.logger.info(`retry round ${this.rounds}: ${revived} waiting blocks back in the queue`)
          task = this.planner.next(pos) || this.planner.nextCandidate(pos) || this.planner.nextAny(pos)
        }
        if (!task && (this.rounds || 0) >= (fleet ? 8 : 6) && Date.now() - lastProgress <= giveUpMs && Date.now() - (this.lastRevive || 0) > 3500) {
          this.lastRevive = Date.now()
          this.placer?._deadStands?.clear?.()
          this.placer?._reach?.clear?.()
          this.brain?.failed?.clear?.()
          this.scaffold?.clearChurn?.()
          const isEndgamePass = this.planner.remainingCount() <= 25
          const revived = this.planner.revive({ includeQuarantined: isEndgamePass })
          if (revived > 0) {
            this.rounds = 1
            this.logger.info(`deep recovery pass: reopened ${revived} quarantined/waiting block(s) with fresh path caches`)
            task = this.planner.next(pos) || this.planner.nextCandidate(pos) || this.planner.nextAny(pos)
          }
        }
        if (!task && Date.now() - lastProgress > giveUpMs && (this.rounds || 0) >= 6) {
          if (!this.reportedStall) { this.reportedStall = true; this.logger.warn('no progress possible on the remaining blocks after every retry round; finishing with a report') }
          if (fleet) {
            fleet.coord.setDone(fleet.id, true)
            if (fleet.coord.allDone() && await this.finish(true)) break
          } else if (await this.finish(true)) break
        }
        if (!task) {
          if (fleet && Date.now() - (this._lastStepAsideAt || 0) > 2_000) {
            const others = this.aim?.others?.() || []
            const closeOther = others.find(o => o && Math.hypot(o.x - pos.x, o.z - pos.z) <= 2.6 && Math.abs(o.y - pos.y) <= 2.5)
            if (closeOther) {
              this._lastStepAsideAt = Date.now()
              await this.placer.retreatFrom(closeOther.floored ? closeOther.floored() : new Vec3(Math.floor(closeOther.x), Math.floor(closeOther.y), Math.floor(closeOther.z)), 3).catch(() => {})
            }
          }
          this.placer.setPhase('waiting for partner bot')
          await sleep(fleet ? 60 : 100)
          continue
        }
      }
      if (fleet) fleet.coord.setDone(fleet.id, false)
      if (task.order >= 100000 && this.config.building.pauseBeforePower && !this.powerAsked) {
        this.powerAsked = true
        this.pause('structure finished, waiting before the power blocks go in (type !resume to continue)')
        if ((!fleet || fleet.index === 0) && this.config.control?.announceInChat) this.bot.chat('Structure is finished. Check it, then type !resume to place the power blocks (redstone blocks, torches, levers).')
        continue
      }

      try {
        if (!this.world.blockAt(task.world)) {
          task.status = 'deferred'
          task.deferredUntil = Date.now() + 2_000
          task.lastError = 'chunk not loaded at target'
          await this.walkToward(task)
          continue
        }
        const distToTask = this.bot.entity?.position ? this.bot.entity.position.distanceTo(task.world) : 0
        if (distToTask > 16) {
          this.placer.setPhase('approaching build site')
          await this.walkToward(task)
          continue
        }
        const pf = this.engine ? this.engine.preflight(task) : { go: true }
        if (!pf.go) { this.engine.defer(task, pf); await sleep(15); continue }
        const t0 = Date.now()
        this.recorder?.taskStart(task)
        await this.placer.executeGuarded(task)
        this.recorder?.taskEnd(task, Date.now() - t0)
        this.experience.noteTask(Date.now() - t0)
        this.logger.info(`OK ${task.name} ${keyOf(task.world)} L${task.layer} ${Date.now() - t0}ms attempt=${task.attempts + 1} [${this.planner.completed.size + 1}/${this.planner.total}]`)
        if (!this.planner.rescanTask(task)) throw new Error(`world verification failed for ${task.name} at ${keyOf(task.world)}`)
        this.lastProgressAt = Date.now()
        this.rounds = 0
        this.failStreak = 0
        this.scaffold?.clearChurn?.()
        await this.maybeSetHome(task)
        this.actionsSinceSave++
        this.actionsSinceRescan++
        if (task.kind === 'fluid' || task.kind === 'waterlog') {
          this.fluidsSinceClear++
          if (this.fluidsSinceClear >= 6) { this.fluidsSinceClear = 0; await this.materials.clearEmptyBuckets().catch(() => {}) }
        }
      } catch (error) {
        this.lastError = error
        if (error.code === 'MATERIAL_SUBSTITUTUTED' || error.code === 'MATERIAL_SUBSTITUTED') { this.logger.info(error.message); continue }
        if (error.code === 'INTERRUPTED' || /goal was changed|PathStopped/i.test(error.message)) { await sleep(30); continue }
        if (error.code === 'TRAVEL_TIMEOUT' || error.isTravel) {
          this.throttledWarn(`Travel timeout toward ${task.name} (${task.world.x},${task.world.y},${task.world.z}): deferring to step closer without quarantine`)
          task.status = 'deferred'
          task.deferredUntil = Date.now() + 1_500
          await this.walkToward(task)
          continue
        }
        this.noteFailure(task, error)
        this.recorder?.taskFail(task, error)
        if (error.code !== 'UNSAFE' && error.code !== 'AIM' && error.code !== 'REFUSED' && ++this.failStreak >= 2) {
          this.adoptNearbyPartnerScaffolds(4, true)
          await this.escapeIfWalledIn(`${error.code || 'ERR'} x${this.failStreak}`, task?.world)
        }
        if (error.code === 'PROTECTED' || error.code === 'UNSUPPORTED') this.planner.markFailure(task, error, { permanent: true })
        else this.planner.markFailure(task, error)
        this.throttledWarn(`Task retry: ${task.name} (${task.world.x},${task.world.y},${task.world.z}) attempt=${task.attempts} [${error.code || 'ERR'}] ${error.message}`)
        const failDist = this.bot.entity?.position ? task.world.distanceTo(this.bot.entity.position) : 0
        if ((error.code === 'NO_ACCESS' || error.code === 'TASK_TIMEOUT') && (task.attempts >= 2 || failDist > 18)) {
          const rad = failDist > 18 ? 10 : Number(this.config.building?.clusterDeferRadius ?? 3)
          const n = this.planner.deferNear(task, rad, Math.min(8_000, 2_500 * Math.max(1, task.attempts)), failDist > 18)
          if (n) this.throttledWarn(`unreachable pocket around ${task.world.x},${task.world.y},${task.world.z}: ${n} neighbouring blocks wait while other work goes on`)
        }
        if (error.code === 'NOT_GROUNDED') await this.ground.waitSafe(400)
        await sleep(Math.min(50, Number(this.config.building.accessRetryDelayMs || 40)))
      }

      if (this.actionsSinceSave >= Number(this.config.building.saveEveryActions || 32)) {
        await this.save().catch(error => this.logger.warn(`save failed: ${error.message}`))
        this.actionsSinceSave = 0
      }
      if (this.actionsSinceRescan >= Number(this.config.building.rescanEveryActions || 96)) {
        this.planner.reconcileRegion(this.bot.entity.position, this.config.building.localRescanRadius)
        this.actionsSinceRescan = 0
      }
      if (this.scaffold.created.size && Date.now() - (this.lastTidyAt || 0) > 2500 && !this.scaffold.onScaffold() && !this.fleet?.coord?.hasActiveSweeper?.()) {
        const bp = this.bot.entity.position
        let hasNearbyTemp = false
        for (const [k, p] of this.scaffold.created.entries()) {
          const t = this.planner.tasks.get(k)
          if (t && t.status === 'completed') continue
          if (p.isAccessStep && !t) continue
          if (bp.distanceTo(p) <= 6.5) { hasNearbyTemp = true; break }
        }
        if (hasNearbyTemp) {
          this.lastTidyAt = Date.now()
          await this.placer.sweepTemporary({ maxBlocks: 6 }).catch(() => {})
        }
      }
      this.placer.setPhase('between tasks')
      await this.humanBetween()
      this.placer.setPhase('planning next task')
    }

    this.navigation.stop()
    if (fleet) { fleet.coord.release(fleet.id); fleet.coord.setDone(fleet.id, false) }
    try { this.bot.clearControlStates() } catch {}
    clearInterval(this.idleTimer); this.idleTimer = null
    this.experience.save()
    await this.save().catch(() => {})
    this.running = false
    this.stopRequested = false
  }

  analyze () {
    if (!this.planner || !this.architectSequence) throw new Error('no build loaded')
    const { buildAnalysis } = require('../planner/analysis')
    const workers = this.fleet?.count || 1
    const res = buildAnalysis(this.planner, this.architectSequence, this.architectReport, { workers, name: this.jobId, config: this.config, registry: this.bot.registry })
    const dir = path.resolve(this.config.paths.stateDir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${this.jobId}.analysis.md`)
    fs.writeFileSync(file, res.markdown)
    return { ...res, file }
  }

  async fleetFinish () {
    const { coord, id } = this.fleet
    this.planner.syncFleet()
    if (!this.fleetCheckedAt || Date.now() - this.fleetCheckedAt > 350) {
      this.fleetCheckedAt = Date.now()
      this.planner.reconcileWorld()
      if (this.planner.getStats().remaining > 0) { coord.setDone(id, false); return false }
    }
    if (this.planner.blocked.size > 0 && !coord.allDone() && Date.now() - (this.lastRevive || 0) > 2_000 && (this.endReviveCount = (this.endReviveCount || 0) + 1) <= 2) {
      this.lastRevive = Date.now()
      this.planner.revive({ includeQuarantined: true })
      coord.setDone(id, false)
      return false
    }
    coord.setDone(id, true)
    if (!coord.allDone()) { await sleep(250); return false }
    return this.finish(false)
  }

  startDiagnostics () {
    clearInterval(this.statusTimer)
    this.watchFluids()
    this.recorder?.start()
    this.statusTimer = setInterval(() => { try { if (this.running) this.statusReport() } catch (error) { this.logger.debug?.(`status: ${error.message}`) } }, 30_000)
    this.statusTimer.unref?.()
  }

  statusReport () {
    const planner = this.planner; const bot = this.bot
    if (!planner || !bot.entity) return
    const layers = new Map()
    for (const t of planner.tasks.values()) {
      if (t.kind === 'waterlog') continue
      const l = layers.get(t.layer) || { total: 0, done: 0, pending: [], structPending: [], fluid: 0, fluidDone: 0 }
      l.total++
      if (t.status === 'completed') l.done++
      else {
        const desc = `${t.name}@${t.world.x},${t.world.y},${t.world.z}:${t.status}${t.attempts ? '/' + t.attempts : ''}${t.lastError ? '(' + String(t.lastError).slice(0, 40) + ')' : ''}`
        if (l.pending.length < 3) l.pending.push(desc)
        if (t.order < 88000 && l.structPending.length < 3) l.structPending.push(desc)
      }
      if (t.kind === 'fluid') { l.fluid++; if (t.status === 'completed') l.fluidDone++ }
      layers.set(t.layer, l)
    }
    const sortedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0])
    const rows = sortedLayers.map(([k, l]) => `L${k} ${l.done}/${l.total}${l.fluid ? ` fl${l.fluidDone}/${l.fluid}` : ''}`)
    const openStruct = sortedLayers.find(([, l]) => l.structPending.length > 0)
    const open = openStruct || sortedLayers.find(([, l]) => l.done < l.total)
    const st = planner.getStats(true)
    const p = bot.entity.position
    const others = []
    if (this.fleet) for (const w of this.fleet.coord.workers.values()) { if (w.id === this.fleet.id) continue; const q = this.fleet.coord.position(w); if (q) others.push(`${w.id}:${Math.hypot(q.x - p.x, q.z - p.z).toFixed(1)}b`) }
    const free = bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : '?'
    this.logger.info(`STATUS pos=${p.floored()} ${this.ground.state()} phase="${this.placer.phase}" done ${st.completed}/${st.total} remaining=${st.remaining} blocked=${st.blocked} | layers: ${rows.join(' ')} | first open layer: ${open ? `L${open[0]} pending ${(open[1].structPending.length ? open[1].structPending : open[1].pending).join(' ; ')}` : 'none'} | scaffold=${this.scaffold.created.size} | free slots=${free} | others: ${others.join(' ') || '-'} | health=${bot.health}`)
  }

  watchFluids () {
    if (this.fluidWatch) this.bot.removeListener('blockUpdate', this.fluidWatch)
    let n = 0; let windowAt = 0
    this.fluidWatch = (oldB, newB) => {
      try {
        if (!this.running || !this.planner || !newB?.position) return
        const k = `${newB.position.x},${newB.position.y},${newB.position.z}`
        const taskAt = this.planner.tasks.get(k)
        const turnedObsidian = newB.name === 'obsidian' && oldB && oldB.name === 'lava'
        if (taskAt && (taskAt.status === 'completed' || turnedObsidian) && !this.planner.isCorrect(taskAt)) {
          this.planner.reopenTask(k, this.fleet?.index, { forceReset: true })
        }
        const want = this.planner.fluidCells.get(k)
        const strayWater = newB.name === 'water' && !want && !this.planner.tasks.has(k)
        const strayLava = newB.name === 'lava' && !want && !this.planner.tasks.has(k)
        // If a stray water source (`level === 0`) appears near the bot, immediately plug & drain it!
        if (strayWater && (Number(newB.metadata) === 0 || String(newB.getProperties?.()?.level ?? newB.metadata ?? '') === '0') && this.placer && this.bot.entity && this.bot.entity.position.distanceTo(newB.position) <= 5) {
          clearTimeout(this._strayWaterT)
          const posClone = newB.position.clone()
          this._strayWaterT = setTimeout(() => { this.placer.scoopStrayWater(posClone).catch(() => {}) }, 120)
        }
        if (strayLava && this.exit && !this.exit.running && this.bot.entity && this.bot.entity.position.distanceTo(newB.position) < 7) {
          clearTimeout(this._lavaT)
          this._lavaT = setTimeout(() => { this.exit.escape({ why: 'lava is spreading near me', lava: true, force: true, maxMs: 40_000 }).catch(() => {}).then(() => this.exit.containStray()).catch(() => {}) }, 150)
        }
        if (!turnedObsidian && !strayWater && !strayLava) return
        if (Date.now() - windowAt > 60_000) { windowAt = Date.now(); n = 0 }
        if (++n > 12) return
        const around = []
        for (const f of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) { const b = this.world.blockAt({ x: newB.position.x + f[0], y: newB.position.y + f[1], z: newB.position.z + f[2] }); if (b && (b.name === 'water' || b.name === 'lava')) around.push(`${b.name}${Number(b.metadata) === 0 ? '(src)' : ''}@${f.join(',')}`) }
        this.logger.warn(`FLUID EVENT: ${turnedObsidian ? 'LAVA TURNED INTO OBSIDIAN' : strayWater ? 'water outside the design' : 'lava outside the design'} at ${k} (design wants ${want || 'a block/air'}); fluid neighbours: ${around.join(' ') || 'none'}; bot at ${this.bot.entity.position.floored()}; last phase "${this.placer.phase}"`)
      } catch { /* diagnostics must never throw */ }
    }
    this.bot.on('blockUpdate', this.fluidWatch)
  }

  async finish (force = false) {
    this.planner.reconcileWorld()
    if (!force && this.planner.getStats().remaining > 0) { this.lastProgressAt = Date.now(); return false }
    if (this.config.building.cleanupTemporaryBlocks) await this.cleanupTemporary().catch(error => this.logger.warn(`cleanup: ${error.message}`))
    this.planner.reconcileWorld()
    if (!force && this.planner.getStats().remaining > 0 && (this.restoreRounds = (this.restoreRounds || 0) + 1) <= 4) {
      this.logger.info(`cleanup opened ${this.planner.getStats().remaining} finished block(s): placing them again`)
      this.lastProgressAt = Date.now()
      return false
    }
    const final = this.verifyAll()
    // End-of-Build Verify-and-Repair Loop Until Zero Difference:
    // After scaffold cleanup, compare every schematic cell against the world. If any quarantined/wrong/missing blocks remain,
    // reopen them and run up to 3 full repair passes until `final.wrong === 0`!
    if (final.wrong > 0 && (this.verifyRepairRounds = (this.verifyRepairRounds || 0) + 1) <= (force ? 1 : 3)) {
      let reopened = 0
      for (const wt of final.wrongTasks) {
        reopened += this.planner.reopenTask(wt.key, this.fleet ? (reopened % this.fleet.count) : null, { forceReset: true })
      }
      if (reopened > 0) {
        if (this.fleet) this.fleet.coord.setDone(this.fleet.id, false)
        this.rounds = 0
        this.lastProgressAt = Date.now()
        this.logger.info(`VERIFY-REPAIR pass #${this.verifyRepairRounds}/3: reopened ${reopened} mismatched/missing block(s) to guarantee world == schematic`)
        return false
      }
    }
    const file = this.writeReport(final)
    this.buildMemory?.markBuildComplete?.(final)
    this.keepActiveJob = false
    await this.save().catch(() => {})
    this.fleet?.jobDone?.()
    if (final.complete) this.logger.info(`BUILD COMPLETE: ${final.correct}/${final.total} verified; temporary blocks left=${this.scaffold.getCreated().length}`)
    else this.logger.warn(`BUILD FINISHED WITH ISSUES: ${final.correct}/${final.total} correct, ${final.wrong} wrong, ${this.planner.census.unsupported.length} unsupported; report: ${file}`)
    this.recorder?.stop()
    this.running = false
    return true
  }

  async walkToward (task) {
    try {
      const p = this.bot.entity.position
      const dir = new Vec3(task.world.x - p.x, 0, task.world.z - p.z)
      const len = dir.norm()
      if (len < 2) return
      const step = Math.min(len, 24)
      const gx = Math.floor(p.x + dir.x / len * step)
      const gz = Math.floor(p.z + dir.z / len * step)
      let gy = Math.floor(p.y)
      for (let dy = 6; dy >= -16; dy--) {
        const yTest = Math.floor(p.y) + dy
        const fl = this.world.blockAt(new Vec3(gx, yTest - 1, gz))
        const b0 = this.world.blockAt(new Vec3(gx, yTest, gz))
        const b1 = this.world.blockAt(new Vec3(gx, yTest + 1, gz))
        if (fl && fl.boundingBox === 'block' && (!b0 || b0.boundingBox === 'empty') && (!b1 || b1.boundingBox === 'empty')) {
          gy = yTest
          break
        }
      }
      const goal = new Vec3(gx + 0.5, gy, gz + 0.5)
      await this.navigation.goTo(goal, 3, 30_000, { human: true, allowObstacleBreak: false })
    } catch (error) { this.logger.debug?.(`walkToward: ${error.message}`) }
  }
}

module.exports = { ConstructionEngine }
