'use strict'
// Background Lookahead & Path-Precomputation Engine.
// Runs non-blocking micro-slices (via setImmediate / short timers) while the bot is actively aiming, clicking,
// towering, or waiting on server confirmation so that:
//   1. The next 3-4 upcoming tasks already have their AimSolver candidates, Brain reachability verdicts,
//      simulated reference checks (`_precomputedSimRefs`), and A* walking routes pre-computed in 0ms!
//   2. Physics (`bot.physicsEnabled === true`), anti-hover gravity (releasing sneak when a block under the bot's
//      feet is broken so the bot falls onto solid ground immediately), and anti-pause watchdogs run continuously.

const { Vec3 } = require('../util/vec3')
const { usableFaces, VEC } = require('../rules/blocks')
const { isAirLike, supportUnder, feetCellOf } = require('../world/ground')

class LookaheadEngine {
  constructor ({ bot, world, config, logger, planner, placer, aim, nav, ground, getPlanner, getPlacer, getNavigation, getGround }) {
    this.bot = bot
    this.world = world
    this.config = config
    this.logger = logger
    this.getPlanner = getPlanner || (() => planner)
    this.getPlacer = getPlacer || (() => placer)
    this.getNavigation = getNavigation || (() => nav)
    this.getGround = getGround || (() => ground)
    this.aim = aim
    this.running = false
    this.timer = null
    this.busy = false
    this.candCache = new Map() // key -> { at, botCell, cands }
    this.stats = { prewarmedTasks: 0, prewarmedRoutes: 0, prewarmedSupport: 0, cacheHits: 0, unhovered: 0 }
    this._airHoverSince = 0
  }

  start () {
    if (this.running) return
    this.running = true
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, 180)
    this.timer.unref?.()
  }

  stop () {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.candCache.clear()
  }

  cacheKey (target, specTag, botCellKey) {
    return `${target.x},${target.y},${target.z}|${specTag || 'free'}|${botCellKey}`
  }

  _precomputeTask (task, fromPos = null) {
    const placer = this.getPlacer?.()
    const aim = placer?.aim || this.aim
    if (!task || !aim) return null
    const pos = fromPos || this.bot?.entity?.position
    if (!pos) return null
    const bck = `${Math.floor(pos.x)},${Math.floor(pos.y + 0.01)},${Math.floor(pos.z)}`
    const specs = placer?.specsFor ? placer.specsFor(task) : (task.info?.specs || [])
    const spec = specs[0]
    if (!spec) return null
    const cands = aim.candidates(task.world, spec, { from: pos, allowScaffold: false })
    if (cands.length) {
      this.candCache.set(this.cacheKey(task.world, spec.tag, bck), { at: Date.now(), cands })
      this.stats.prewarmedTasks++
    }
    return cands
  }

  getCachedCandidates (targetOrTask, spec) {
    const target = targetOrTask?.world || targetOrTask
    if (!this.bot?.entity?.position || !target || !spec) return null
    const p = this.bot.entity.position
    const bck = `${Math.floor(p.x)},${Math.floor(p.y + 0.01)},${Math.floor(p.z)}`
    const k = this.cacheKey(target, spec.tag, bck)
    const hit = this.candCache.get(k)
    if (!hit) return null
    if (Date.now() - hit.at > 2200) {
      this.candCache.delete(k)
      return null
    }
    this.stats.cacheHits++
    return hit.cands
  }

  // Ensures the bot never hangs in mid-air if the block beneath its feet is broken or if physics was disabled
  checkPhysicsAndHover () {
    const bot = this.bot
    if (!bot?.entity?.position) return
    if (bot.physicsEnabled === false) {
      bot.physicsEnabled = true
    }
    const e = bot.entity
    const placer = this.getPlacer?.()
    if (placer?.scaffold?._sliding || placer?._inPrecision) {
      this._airHoverSince = 0
      return
    }
    const fc = feetCellOf(this.world, e.position)
    const under = this.world.blockAt(new Vec3(fc.x, fc.y - 1, fc.z))
    const here = this.world.blockAt(new Vec3(fc.x, fc.y, fc.z))
    const activeEdgeAim = Boolean(placer?.scaffold?._sliding) || ['edge slide', 'aiming', 'placing', 'click + server answer'].includes(placer?.phase || '')
    const floatingOverAir = !activeEdgeAim && !e.isInWater && !e.isInLava && isAirLike(under) && isAirLike(here) && Math.abs(e.velocity?.y ?? 0) < 0.05
    if (floatingOverAir) {
      if (!this._airHoverSince) this._airHoverSince = Date.now()
      else if (Date.now() - this._airHoverSince >= 250) {
        if (bot.getControlState?.('sneak')) {
          if (placer) placer._chestSneak = false
          bot.setControlState('sneak', false)
        }
        const dxC = (fc.x + 0.5) - e.position.x
        const dzC = (fc.z + 0.5) - e.position.z
        if (Math.hypot(dxC, dzC) > 0.04) {
          e.position.x += dxC * 0.55
          e.position.z += dzC * 0.55
        }
        e.onGround = false
        if (e.velocity && e.velocity.y >= -0.02) e.velocity.y = -0.08
        this.stats.unhovered++
      }
    } else {
      this._airHoverSince = 0
    }
  }

  async tick () {
    if (!this.running || this.busy || !this.bot?.entity?.position) return
    this.checkPhysicsAndHover()
    const planner = this.getPlanner?.()
    const placer = this.getPlacer?.()
    const nav = this.getNavigation?.()
    if (!planner || !placer || !placer.aim) return
    // Never steal CPU from physicsTick while the bot is actively walking, pathing, or towering!
    if (nav?.human?.activeWalk || nav?.human?.planning || this.bot.pathfinder?.isMoving?.() || (typeof placer.standingStill === "function" && !placer.standingStill())) return

    this.busy = true
    try {
      const pos = this.bot.entity.position.clone()
      const bck = `${Math.floor(pos.x)},${Math.floor(pos.y + 0.01)},${Math.floor(pos.z)}`
      // 1. Pre-warm the forward-flood reachability map from the bot's current cell so all subsequent reachability(stand) checks execute in O(1) (0.001ms)!
      if (placer.brain?.getForwardReach) {
        try {
          const meCell = placer.brain.cellOf ? placer.brain.cellOf(pos) : { x: Math.floor(pos.x), y: Math.floor(pos.y + 0.01), z: Math.floor(pos.z) }
          placer.brain.getForwardReach(meCell, Number(this.config?.navigation?.safeFallDistance ?? 3))
        } catch {}
      }
      const upcoming = typeof planner.peekUpcoming === 'function'
        ? planner.peekUpcoming(pos, 4)
        : []
      if (!upcoming.length) return

      for (let idx = 0; idx < upcoming.length; idx++) {
        const task = upcoming[idx]
        if (!task || task.kind !== "block" || task.status === "completed" || task.status === "blocked") continue
        const specs = placer.specsFor ? placer.specsFor(task) : (task.info?.specs || [])
        const spec = specs[0]
        if (!spec || !placer.hasRef(task, spec)) continue
        const k = this.cacheKey(task.world, spec.tag, bck)
        const existing = this.candCache.get(k)
        if (!existing || Date.now() - existing.at > 1800) {
          await new Promise(resolve => setImmediate(resolve))
          if (nav?.human?.activeWalk || this.bot.pathfinder?.isMoving?.()) break
          const cands = placer.aim.candidates(task.world, spec, { from: pos, allowScaffold: false, max: 6 })
          if (cands.length) {
            if (this.candCache.size > 160) this.candCache.clear()
            this.candCache.set(k, { at: Date.now(), cands })
            this.stats.prewarmedTasks++
            if (idx === 0 && nav?.human?.prewarmRoute && Math.hypot(cands[0].stand.x - pos.x, cands[0].stand.z - pos.z) > 1.2) {
              await nav.human.prewarmRoute(cands[0].stand, 0.4).catch(() => null)
              this.stats.prewarmedRoutes++
            }
          }
        }
      }
    } finally {
      this.busy = false
    }
  }
}

module.exports = { LookaheadEngine }
