'use strict'
// The part that actually builds: for one planner task it finds where to stand (preferring 3-4 block back-off
// stands that cover 3-6 blocks at once), walks/hops there, moves the camera with a fast quantised sweep,
// validates that the crosshair really is on the wanted face, clicks, and checks what the server made.

const { Vec3 } = require('../util/vec3')
const { sleep, waitFor, nextTick } = require('../util/async')
const { taskMatches, isInteractive, FACE_INDEX, VEC, OPP, matches, describeBlock, usableFaces } = require('../rules/blocks')
const { isAirLike, isBodyFree, isFullTop, isBottomSlab, isLowFloor, iceStandOk, feetCellOf } = require('../world/ground')
const { runStore } = require('../util/abort')

const FACES = ['up', 'down', 'north', 'south', 'east', 'west']
const FREE = Object.freeze({ faces: FACES.map(f => ({ f })), look: null, horiz: null, yaw16: null, tag: 'free' })

const REPLACEABLE = new Set(['water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'glow_lichen', 'light', 'fire', 'soul_fire', 'bubble_column', 'void_air', 'cave_air', 'air'])
const CONTAINERS = /(chest|barrel|furnace|smoker|hopper|dropper|dispenser|shulker_box|crafter|lectern|jukebox|brewing_stand|decorated_pot|spawner|beacon|command_block)$/
const SUNKEN_NO_STAND = /^(hopper|chest|trapped_chest|ender_chest|cauldron|composter)$/

class BuildError extends Error {
  constructor (code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra) }
}

const key = p => `${p.x},${p.y},${p.z}`
const rand = (a, b) => a + Math.random() * (b - a)

class Placer {
  constructor (ctx) {
    Object.assign(this, ctx)
    this.interrupt = ctx.interrupt || (() => null)
    this.isReservedCell = ctx.isReserved || (() => false)
    this.stats = { placed: 0, dug: 0, wrongState: 0, refused: 0, towers: 0 }
    this.hopStats = { hops: 0, hopMs: 0, walks: 0, walkMs: 0, walkDist: 0 }
  }

  setPhase (name) {
    const now = Date.now()
    if (this.phase) { const k = String(this.phase).replace(/^getting .* into the hand$/, 'getting item'); this.phaseTime = this.phaseTime || {}; this.phaseTime[k] = (this.phaseTime[k] || 0) + (now - (this.phaseSince || now)) }
    this.phase = name; this.phaseSince = now
  }

  phaseReport () {
    const t = this.phaseTime || {}; this.phaseTime = {}
    const total = Object.values(t).reduce((a, b) => a + b, 0) || 1
    const f = this.flowStats || { tasks: 0, walked: 0, flow: 0 }; this.flowStats = { tasks: 0, walked: 0, flow: 0 }
    const hs = this.hopStats || { hops: 0, hopMs: 0, walks: 0, walkMs: 0, walkDist: 0 }
    this.hopStats = { hops: 0, hopMs: 0, walks: 0, walkMs: 0, walkDist: 0 }
    const out = Object.entries(t).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${Math.round(100 * v / total)}%`).join(', ') + ` | moved for ${f.walked}/${f.tasks} blocks, flow ${f.flow}` + (this.look?.perf ? ` | aim: ${this.aimTries || 0} looks, human ${this.look.perf.human}ms, correct ${this.look.perf.correct}ms` : '') + ` | hops ${hs.hops} (${Math.round(hs.hopMs / Math.max(1, hs.hops))}ms), walks ${hs.walks} (${Math.round(hs.walkMs / Math.max(1, hs.walks))}ms, avg ${(hs.walkDist / Math.max(1, hs.walks)).toFixed(1)} blocks), pose lost ${hs.p0 || 0}, settle ${hs.settleMs || 0}ms, creep ${hs.p1 || 0}x ${hs.creepMs || 0}ms`
    if (this.look) { this.look.perf = null; this.aimTries = 0 }
    return out
  }

  abortActive (reason) {
    const run = this.activeRun
    if (!run) return false
    run.ctx.dead = true
    run.reject(new BuildError('TASK_TIMEOUT', `${reason} (stuck in: ${this.phase || 'unknown'}, holding ${this.bot.heldItem?.name || 'nothing'})`, { phase: this.phase }))
    return true
  }

  async executeGuarded (task) {
    const limit = Number(this.config.building?.taskTimeoutMs || 35_000)
    const ctx = { dead: false }
    let timer
    this.setPhase('starting task')
    const timeout = new Promise((resolve, reject) => {
      this.activeRun = { ctx, reject }
      timer = setTimeout(() => {
        ctx.dead = true
        const isTravel = /walk|approach/i.test(this.phase || '')
        const err = new BuildError(isTravel ? 'TRAVEL_TIMEOUT' : 'TASK_TIMEOUT', `task took longer than ${limit}ms (stuck in: ${this.phase || 'unknown'}, holding ${this.bot.heldItem?.name || 'nothing'})`, { phase: this.phase, isTravel })
        err.isTravel = isTravel
        reject(err)
      }, limit)
    })
    try {
      return await Promise.race([runStore.run(ctx, () => this.execute(task)), timeout])
    } catch (error) {
      if (error.code === 'TASK_TIMEOUT' || error.code === 'TRAVEL_TIMEOUT') {
        try { this.nav.stop(); this.bot.clearControlStates() } catch {}
        if (!this.hasActiveSweeper()) await this.scaffold.descend().catch(() => {})
      }
      throw error
    } finally { clearTimeout(timer); this.activeRun = null }
  }

  check () {
    if (runStore.getStore()?.dead) throw new BuildError('INTERRUPTED', 'task abandoned after timeout')
    const reason = this.interrupt()
    if (reason) throw new BuildError('INTERRUPTED', `interrupted: ${reason}`)
    if (!this.bot.entity || this.bot.health <= 0) throw new BuildError('INTERRUPTED', 'bot is dead')
    const fell = this.bot.builder?.fallGuard?.fell
    if (fell && fell.dy >= 2.5 && Date.now() - (fell.at || 0) < 3500) {
      throw new BuildError('NOT_GROUNDED', `fell ${fell.dy.toFixed(1)} blocks off platform during task`)
    }
  }

  async humanPause (min, max) {
    if (this.flow) return
    const speed = Number(this.config.building?.speed ?? 1) || 1
    const ms = Math.min(8, rand(min, max) / speed * Number(this.config.human?.pauseScale ?? 0.02))
    if (ms > 1) await sleep(ms)
  }

  isReplaceable (block) {
    if (!block) return false
    if (REPLACEABLE.has(block.name)) return true
    if (block.name === 'snow') return Number(block.getProperties?.().layers) === 1
    return false
  }

  setSneak (on) {
    try {
      if (!on && this.bot?.entity?.onGround && this.bot?.builder?.fallGuard) {
        const p = this.bot.entity.position
        // Only keep sneak clamped if the bot's center is overhanging an actual hazard or >2-block drop (never on a 1-2 block dirt platform!)
        if (!this.bot.builder.fallGuard.floorWithin(p.x, p.y, p.z, 0) && this.bot.builder.fallGuard.hazardAt(p.x, p.y, p.z, 2)) {
          this.bot.builder.fallGuard.sneakClampTicks = Math.max(this.bot.builder.fallGuard.sneakClampTicks || 0, 3)
          return
        }
      }
      this.bot.setControlState('sneak', Boolean(on))
    } catch {}
  }

  async withSneak (on, fn) {
    const prevChestSneak = this._chestSneak
    if (on) {
      this._chestSneak = true
      this.setSneak(true)
      await nextTick(this.bot)
    }
    try { return await fn() } finally {
      this._chestSneak = prevChestSneak
      if (!this._chestSneak) this.setSneak(false)
    }
  }

  // ---- approach: walk + (maybe) tower, return a pose that really sees the wanted face -----------
  async approach (target, spec, opts = {}) {
    this.setPhase('approach (choosing a stand)')
    if (!spec.sneak && !this._chestSneak && this.bot.getControlState?.('sneak')) {
      this.setSneak(false)
    }
    if (!opts.fixedStand && !opts.onlyScaffold) {
      const e = this.bot.entity
      if (e && (e.onGround || this.ground?.state?.() === 'grounded') && !this.bot.pathfinder?.isMoving?.() && !this.nav?.human?.activeWalk) {
        if (Math.hypot(e.velocity.x, e.velocity.z) >= 0.08 && Math.hypot(e.velocity.x, e.velocity.z) < 0.24) {
          await nextTick(this.bot)
        }
      }
    }
    if (!opts.fixedStand && !opts.onlyScaffold && this.standingStill()) {
      const e = this.bot.entity
      const onlyDownOrSide = Boolean(spec.faces && spec.faces.some(fo => fo.f === 'down') && !spec.faces.some(fo => fo.f === 'up'))
      const minAllowedY = (spec.look === 'up' || onlyDownOrSide || opts.mode === 'self') ? target.y - 5.2 : opts.bucket ? target.y - 1.3 : target.y - 2.1
      if (e.position.y >= minAllowedY) {
        if (!spec.sneak && this._chestSneak) { this._chestSneak = false; this.setSneak(false) }
        if (spec.sneak === false) this.setSneak(false)
        if (spec.sneak && !this.bot.getControlState('sneak')) { this._chestSneak = true; this.setSneak(true); await nextTick(this.bot) }
        let direct = this.aim.fromPose(target, spec, null, opts)
        if (!direct && spec.sneak) { this._chestSneak = false; this.setSneak(false); direct = null }
        if (direct && spec.noSneakRef) { const rb = this.world.blockAt(direct.ref); if (rb && isInteractive(rb.name)) direct = null }
        if (direct) {
          return { cand: { stand: e.position.clone(), cell: e.position.floored(), sneak: Boolean(spec.sneak || this.bot.getControlState?.('sneak')), edge: false, scaffold: null, direct: true }, pose: direct }
        }
      }
    }
    if (!opts.fixedStand && !opts.onlyScaffold && this.bot?.entity?.position && this.bot.entity.position.distanceTo(target) > 16) {
      const targetGround = new Vec3(target.x + 0.5, target.y, target.z + 0.5)
      const d = this.bot.entity.position.distanceTo(targetGround)
      const coarseTimeout = Math.max(12_000, Math.ceil(d * 400))
      await this.nav.goTo(targetGround, 7.0, coarseTimeout, { human: true, work: true, rescue: false }).catch(() => {})
    }
    const tried = new Set()
    let lastError = null
    for (const phase of ['stand', 'tower']) {
      if (phase === 'tower' && (opts.allowScaffold === false || this.config.building?.allowTemporaryScaffolding === false)) break
      const searchOpts = { ...opts, max: 8, exclude: tried, ...(phase === 'tower' ? { onlyScaffold: true } : {}) }
      const prewarmed = (phase === 'stand' && tried.size === 0 && !opts.fixedStand && !opts.onlyScaffold)
        ? this.lookahead?.getCachedCandidates?.(target, spec)
        : null
      const candidates = (prewarmed && prewarmed.length) ? prewarmed.map(c => ({ ...c })) : this.aim.candidates(target, spec, searchOpts)
      if (phase === 'stand' && opts.hintTask?._preferredStand) {
        const ps = opts.hintTask._preferredStand
        for (const c of candidates) {
          if (c.cell.x === ps.x && c.cell.y === ps.y && c.cell.z === ps.z) c.cost -= 35
        }
        candidates.sort((a, b) => a.cost - b.cost)
      }
      if (phase === 'stand' && opts.hint && !opts.hintTask?.hintFailed) {
        const botY = this.bot.entity?.position?.y ?? opts.hint.y
        for (const c of candidates) {
          if (c.cell.x === opts.hint.x && c.cell.y === opts.hint.y && c.cell.z === opts.hint.z && (Math.abs(c.cell.y - botY) <= 0.6 || spec.look === 'up')) {
            c.cost -= 6
          }
        }
        candidates.sort((a, b) => a.cost - b.cost)
      }
      if (candidates.length > 0) {
        let moved = false
        this._reach = this._reach || new Map()
        for (const c of candidates) {
          try {
            const walkStand = c.scaffold?.floor
              ? new Vec3(c.scaffold.floor.x + 0.5, c.scaffold.floor.y, c.scaffold.floor.z + 0.5)
              : (c.edge && c.cell ? new Vec3(c.cell.x + 0.5, c.stand.y, c.cell.z + 0.5) : c.stand)
            if (this.isDeadStand(walkStand)) {
              c._reachVerdict = 'no'
              c.cost += 55
              moved = true
            } else if (this.brain && (Math.hypot(walkStand.x - this.bot.entity.position.x, walkStand.z - this.bot.entity.position.z) > 1.2 || Math.abs(walkStand.y - this.bot.entity.position.y) > 0.6)) {
              const rv = this.reachVerdict(walkStand)
              c._reachVerdict = rv
              if (rv === 'no') { c.cost += 45; moved = true }
              else if (rv === 'yes' && Math.abs(walkStand.y - this.bot.entity.position.y) <= 2.2) { c.cost -= 10; moved = true }
            } else {
              c._reachVerdict = 'yes'
              if (this.bot.entity?.position && Math.abs(walkStand.y - this.bot.entity.position.y) <= 2.2) { c.cost -= 10; moved = true }
            }
          } catch { /* best effort */ }
        }
        if (moved) candidates.sort((a, b) => a.cost - b.cost)
      }
      const botYNow = this.bot?.entity?.position?.y ?? target.y
      const onlyDownOrSideSpec = Boolean(spec.faces && spec.faces.some(fo => fo.f === 'down') && !spec.faces.some(fo => fo.f === 'up'))
      const filteredCands = (phase === 'stand' && botYNow >= target.y - 1.2 && spec.look !== 'up' && !onlyDownOrSideSpec && candidates.some(c => c.stand.y >= botYNow - 2.2))
        ? candidates.filter(c => c.stand.y >= botYNow - 2.2)
        : candidates
      const topCands = filteredCands.slice(0, 4)
      const walkableCands = filteredCands.filter(c => c._reachVerdict !== 'no').slice(0, 4)
      const rescuePool = (phase === 'stand' && botYNow >= target.y - 1.2 && spec.look !== 'up' && !onlyDownOrSideSpec)
        ? topCands.filter(c => c.stand.y >= botYNow - 2.2)
        : topCands
      const rescueCands = phase === 'stand' && rescuePool.length && !opts.noBrainRescue
        ? (walkableCands.length ? [rescuePool.find(c => c._reachVerdict === 'no') || rescuePool[0]] : rescuePool.slice(0, 2))
        : []
      const rescueCand = rescueCands[0] || null
      const botPos = this.bot.entity.position
      const rescueDist = rescueCand ? Math.hypot(rescueCand.stand.x - botPos.x, rescueCand.stand.z - botPos.z) : Infinity
      const walkDist = walkableCands.length ? Math.hypot(walkableCands[0].stand.x - botPos.x, walkableCands[0].stand.z - botPos.z) : Infinity
      const preferRescueFirst = Boolean(rescueCand && rescueCand._reachVerdict === 'no' && rescueDist <= 5.5 && walkDist > rescueDist + 5.0)
      const towerPassList = walkableCands.length
        ? walkableCands.slice(0, 3).map(cand => ({ cand, allowRescue: false }))
        : (topCands.length && opts.allowScaffold !== false && !opts.noBrainRescue && (!topCands[0].scaffold?.floor || botYNow <= topCands[0].scaffold.floor.y + 2.5)
            ? [{ cand: topCands[0], allowRescue: true }]
            : [])
      const passList = phase === 'stand'
        ? (preferRescueFirst
            ? [...rescueCands.map(cand => ({ cand, allowRescue: true })), ...walkableCands.map(cand => ({ cand, allowRescue: false }))]
            : [
                ...walkableCands.map(cand => ({ cand, allowRescue: false })),
                ...rescueCands.map(cand => ({ cand, allowRescue: true }))
              ])
        : towerPassList

      let walkOnlyFails = 0
      for (const { cand, allowRescue } of passList) {
        this.check()
        await new Promise(resolve => setImmediate(resolve))
        if (!allowRescue) {
          if (walkOnlyFails >= 1 && passList.some(p => p.allowRescue)) continue
          tried.add(key(cand.stand))
          const walkStand = cand.edge && cand.cell ? new Vec3(cand.cell.x + 0.5, cand.stand.y, cand.cell.z + 0.5) : cand.stand
          if (this.isDeadStand(walkStand)) {
            lastError = new BuildError('NO_ACCESS', `no path to (${cand.stand.x}, ${cand.stand.y}, ${cand.stand.z})`)
            continue
          }
        }
        try {
          await this.goStand(cand, { allowRescue, target, spec, opts })
          if (spec.sneak === false) this.setSneak(false)
          else if ((cand.sneak || spec.sneak) && !this.bot.getControlState('sneak')) { this.setSneak(true); await sleep(8) }
          else if (!cand.sneak && !spec.sneak && this.bot.getControlState('sneak')) { this.setSneak(false) }
          let pose = this.aim.fromPose(target, spec, null, opts)
          const hs = (this.hopStats = this.hopStats || { hops: 0, hopMs: 0, walks: 0, walkMs: 0, walkDist: 0 }); hs.p0 = (hs.p0 || 0) + (pose ? 0 : 1)
          if (!pose) { const tb = Date.now(); await this.settleBody(); hs.settleMs = (hs.settleMs || 0) + Date.now() - tb; pose = this.aim.fromPose(target, spec, null, opts) }
          if (!pose) { const tc = Date.now(); await this.settleOnStand(cand, target, spec, opts); hs.creepMs = (hs.creepMs || 0) + Date.now() - tc; hs.p1 = (hs.p1 || 0) + 1; pose = this.aim.fromPose(target, spec, null, opts) }
          if (!pose && cand.edge) {
            await this.scaffold.slide(cand.stand, true)
            pose = this.aim.fromPose(target, spec, null, opts)
          }
          if (!pose && spec.sneak !== false) {
            const altSneak = !this.bot.getControlState('sneak')
            this.setSneak(altSneak)
            await sleep(8)
            pose = this.aim.fromPose(target, spec, null, opts)
            if (!pose) this.setSneak(!altSneak)
          }
          if (!pose) throw new BuildError('NO_ACCESS', `pose lost at ${key(cand.stand)}`)
          return { cand, pose }
        } catch (error) {
          if (error.code === 'INTERRUPTED' || error.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(error.message)) throw error
          lastError = error
          if (!allowRescue && /no path|walk timed out|stuck/i.test(error.message || '')) {
            walkOnlyFails++
          }
          if (/no path|pose lost|stuck|walk timed out/i.test(error.message || '')) {
            const walkStand = cand.scaffold?.floor
              ? new Vec3(cand.scaffold.floor.x + 0.5, cand.scaffold.floor.y, cand.scaffold.floor.z + 0.5)
              : (cand.edge && cand.cell ? new Vec3(cand.cell.x + 0.5, cand.stand.y, cand.cell.z + 0.5) : cand.stand)
            this.noteDeadStand(walkStand)
          }
          if (cand.scaffold && (!this.hasActiveSweeper() || this.shouldDescendIsolatedPillar())) {
            if (cand.scaffold.ledge) {
              await this.sweepTemporary({ maxBlocks: 1, final: true, only: new Set([key(cand.scaffold.ledge)]), ignoreReserved: true }).catch(() => {})
            }
            await this.scaffold.descend().catch(() => {})
          }
          this.logger.debug?.(`stand ${key(cand.stand)} failed: ${error.message}`)
        }
      }
    }
    throw new BuildError('NO_ACCESS', `no physical access to ${key(target)}${lastError ? ` (${lastError.message})` : ''}`)
  }

  deadStandKey (stand) {
    const p = this.bot?.entity?.position
    if (!p || !stand) return null
    return `${Math.floor(p.x)},${Math.floor(p.y + 0.01)},${Math.floor(p.z)}->${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)}`
  }

  isDeadStand (stand) {
    if (!this._deadStands) return false
    const dk = this.deadStandKey(stand)
    if (!dk) return false
    const at = this._deadStands.get(dk)
    if (!at) return false
    if (Date.now() - at > 20_000) {
      this._deadStands.delete(dk)
      return false
    }
    return true
  }

  noteDeadStand (stand) {
    this._deadStands = this._deadStands || new Map()
    if (this._deadStands.size > 400) this._deadStands.clear()
    const dk = this.deadStandKey(stand)
    if (dk) this._deadStands.set(dk, Date.now())
    if (this._reach && stand) {
      const rk = dk || `${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)}`
      this._reach.set(rk, { v: 'no', at: Date.now() })
    }
  }

  reachVerdict (stand) {
    this._reach = this._reach || new Map()
    if (this.isDeadStand(stand)) return 'no'
    const k = this.deadStandKey(stand) || `${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)}`
    const hit = this._reach.get(k)
    if (hit && Date.now() - hit.at < 8_000) return hit.v
    if (this._reach.size > 600) this._reach.clear()
    let v = 'unknown'
    try { v = this.brain.reachability(stand, 2400, false).verdict } catch { /* best effort */ }
    this._reach.set(k, { v, at: Date.now() })
    return v
  }

  async hop (stand) {
    const bot = this.bot; const e = bot.entity
    const dist0 = Math.hypot(stand.x - e.position.x, stand.z - e.position.z)
    if (dist0 > 4.2 || Math.abs(stand.y - e.position.y) > 0.55 || (!e.onGround && this.ground?.state?.() !== 'grounded')) return false
    const y0 = Math.floor(e.position.y + 0.01)
    const startCell = new Vec3(Math.floor(e.position.x), y0, Math.floor(e.position.z))
    const endCell = new Vec3(Math.floor(stand.x), y0, Math.floor(stand.z))
    const n = Math.max(1, Math.ceil(dist0 / 0.25))
    let onIce = false
    const gapCells = new Set()
    for (let i = 1; i <= n; i++) {
      const px = e.position.x + (stand.x - e.position.x) * i / n
      const pz = e.position.z + (stand.z - e.position.z) * i / n
      for (const [ox, oz] of [[0, 0], [-0.31, -0.31], [0.31, -0.31], [-0.31, 0.31], [0.31, 0.31]]) {
        const x = Math.floor(px + ox); const z = Math.floor(pz + oz)
        const feetB = this.world.blockAt(new Vec3(x, y0, z))
        const headB = this.world.blockAt(new Vec3(x, y0 + 1, z))
        const onBotSlab = isBottomSlab(feetB) || isLowFloor(feetB)
        if (!(isBodyFree(feetB) || onBotSlab || feetB?.name === 'water') || !isBodyFree(headB)) return false
        const fl = this.world.blockAt(new Vec3(x, y0 - 1, z))
        if (fl && /ice$/.test(fl.name)) onIce = true
        const floorOk = onBotSlab || isFullTop(fl) || iceStandOk(this.world, new Vec3(x, y0, z))
        if (!floorOk || this.aim?.isHazard?.(new Vec3(x, y0, z))) {
          if ((x === startCell.x && z === startCell.z) || (x === endCell.x && z === endCell.z)) return false
          if (Math.abs(stand.y - e.position.y) > 0.25 || dist0 > 2.85) return false
          if (!isBodyFree(this.world.blockAt(new Vec3(x, y0 + 2, z)))) return false
          if (fl?.name === 'lava' || this.world.blockAt(new Vec3(x, y0 - 2, z))?.name === 'lava') return false
          gapCells.add(`${x},${z}`)
          if (gapCells.size > 1) return false
        }
      }
    }
    const isGapHop = gapCells.size === 1
    if (isGapHop && (!isBodyFree(this.world.blockAt(startCell.offset(0, 2, 0))) || !isBodyFree(this.world.blockAt(endCell.offset(0, 2, 0))))) {
      return false
    }
    const ux = (stand.x - e.position.x) / Math.max(0.01, dist0)
    const uz = (stand.z - e.position.z) / Math.max(0.01, dist0)
    const nearLedge = Boolean(this.bot.builder?.fallGuard?.hazardAt?.(stand.x + ux * 0.42, y0, stand.z + uz * 0.42, 2))
    const keys = ['forward', 'back', 'left', 'right']
    const t0 = Date.now()
    const drag = onIce ? 0.72 : 0.546
    let bestDist = dist0
    let stallTicks = 0
    let jumpedGap = false
    await require('../recovery/fall-guard').withHold(bot, async () => {
    try {
      for (let i = 0; i < 65 && Date.now() - t0 < 1800; i++) {
        this.check()
        const q = bot.entity.position
        const dx = stand.x - q.x; const dz = stand.z - q.z
        const dist = Math.hypot(dx, dz)
        if (dist < bestDist - 0.03) {
          bestDist = dist
          stallTicks = 0
        } else if (++stallTicks >= 12) {
          break
        }
        const v = Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z)
        if (nearLedge && dist < 0.28 && bot.entity.onGround) bot.setControlState('sneak', true)
        if (dist < 0.24 && v < (onIce ? 0.08 : 0.14)) break
        const coast = v * drag / (1 - drag)
        const want = new Set()
        if (dist > coast + (onIce ? 0.15 : 0.08) || (isGapHop && !jumpedGap)) {
          if ((dist > 0.65 || isGapHop) && typeof bot.look === 'function') {
            const wantYaw = Math.atan2(-dx, -dz)
            bot.look(wantYaw, bot.entity.pitch, true)
          }
          const yaw = bot.entity.yaw
          const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw)
          const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw)
          if (Math.abs(fwd) > 0.10) want.add(fwd > 0 ? 'forward' : 'back')
          if (Math.abs(right) > 0.10) want.add(right > 0 ? 'right' : 'left')
        } else if (v < 0.07) break
        for (const k of keys) bot.setControlState(k, want.has(k))
        bot.setControlState('sprint', Boolean(want.has('forward') && (isGapHop || (dist > 1.15 && !nearLedge && !onIce))))
        if (isGapHop && !jumpedGap && bot.entity.onGround) {
          const nextFl = this.world.blockAt(new Vec3(Math.floor(q.x + ux * 0.45), y0 - 1, Math.floor(q.z + uz * 0.45)))
          if (!isFullTop(nextFl)) {
            bot.setControlState('jump', true)
            jumpedGap = true
          }
        } else {
          bot.setControlState('jump', false)
        }
        await nextTick(bot)
      }
      for (let i = 0; i < (onIce ? 5 : 2) && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.08; i++) await nextTick(bot)
    } finally {
      for (const k of keys) bot.setControlState(k, false)
      bot.setControlState('sprint', false)
      bot.setControlState('jump', false)
      if (nearLedge || onIce || bot.getControlState('sneak')) this.setSneak(false)
    }
    })
    const endPos = bot.entity?.position
    return Boolean(endPos && Math.hypot(stand.x - endPos.x, stand.z - endPos.z) <= 0.36 && Math.abs(stand.y - endPos.y) <= 0.55)
  }

  hasActiveSweeper () {
    return Boolean(this.planner?.fleet?.coord?.hasActiveSweeper?.())
  }

  standingStill () {
    const e = this.bot.entity
    return Boolean(e && (e.onGround || this.ground?.state?.() === 'grounded') && Math.hypot(e.velocity.x, e.velocity.z) < 0.15 && Math.abs(e.velocity.y) < 0.12 && !this.bot.pathfinder?.isMoving?.() && !this.nav?.human?.activeWalk)
  }

  reachableNow (task) {
    try {
      if (!this.standingStill()) return false
      if (task.kind === 'waterlog') {
        const tb = this.world.blockAt(task.world)
        const wlSpec = (tb && isInteractive(tb.name)) ? { ...FREE, sneak: true } : FREE
        const pose = this.aim.fromPose(task.world, wlSpec, null, { mode: 'self' })
        return Boolean(pose)
      }
      if (task.kind !== 'block') return false
      const nonHyp = task.info.specs.filter(sp => !sp.hyp)
      const checkSpecs = nonHyp.length ? nonHyp : [task.info.specs[0]]
      for (const spec of checkSpecs) {
        if (spec && this.aim.fromPose(task.world, spec, null, {})) return true
      }
      return false
    } catch { return false }
  }

  hasInPlaceReadyTask (order) {
    try {
      const grp = this.planner?.orderGroups?.get(order)
      const p = this.bot?.entity?.position
      if (!grp || !p) return false
      for (const set of grp.cells.values()) {
        for (const t of set) {
          if (t.status === 'completed' || t.status === 'blocked') continue
          if (Math.hypot(t.world.x + 0.5 - p.x, t.world.z + 0.5 - p.z) > 4.4 || Math.abs(t.world.y - p.y) > 3.5) continue
          if (this.planner.isReady(t) && this.reachableNow(t)) return true
        }
      }
      return false
    } catch { return false }
  }

  async settleOnStand (cand, target = null, spec = null, opts = null) {
    if (cand.scaffold && !this.bot.entity?.onGround) return
    const bot = this.bot
    if (bot.__motion && !this._inPrecision) { this._inPrecision = true; try { return await bot.__motion.precisely(() => this.settleOnStand(cand, target, spec, opts)) } finally { this._inPrecision = false } }
    const p = bot.entity.position
    const off = Math.hypot(p.x - cand.stand.x, p.z - cand.stand.z)
    if (off < 0.05 || off > 1.15 || Math.abs(p.y - cand.stand.y) > 0.55) return
    bot.setControlState('sneak', true)
    try {
      for (let i = 0; i < 14; i++) {
        this.check()
        if (target && spec && this.aim.fromPose(target, spec, null, opts || {})) break
        const q = bot.entity.position
        const dx = cand.stand.x - q.x; const dz = cand.stand.z - q.z
        if (Math.hypot(dx, dz) < 0.035) break
        const yaw = bot.entity.yaw
        const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw)
        const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw)
        const wantFwd = Math.abs(fwd) > 0.025 ? (fwd > 0 ? 'forward' : 'back') : null
        const wantRight = Math.abs(right) > 0.025 ? (right > 0 ? 'right' : 'left') : null
        if (!wantFwd && !wantRight) break
        bot.setControlState('forward', wantFwd === 'forward')
        bot.setControlState('back', wantFwd === 'back')
        bot.setControlState('right', wantRight === 'right')
        bot.setControlState('left', wantRight === 'left')
        await nextTick(bot)
      }
    } finally {
      for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false)
      if (!cand.sneak && !cand.edge) this.setSneak(false)
    }
  }

  async settleBody () { await this.ground.waitSafe(2500) }

  shouldDescendIsolatedPillar () {
    if (!this.scaffold?.onScaffold?.() || !this.bot?.entity) return false
    if (this.scaffold.heightUnderFeet() < 3) return false
    const f = this.bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [1, 0, -1, -2]) {
        const adj = new Vec3(f.x + dx, f.y + dy, f.z + dz)
        if (this.scaffold.contains(adj.offset(0, -1, 0))) continue
        if (this.aim?.standOk?.(adj)) return false
      }
    }
    return true
  }

  async goStand (cand, { allowRescue = true, target = null, spec = null, opts = null } = {}) {
    this.setPhase(cand.scaffold ? 'tower' : cand.edge ? 'edge slide' : 'walking to stand')
    const e = this.bot.entity.position
    if (cand.scaffold || cand.edge) this._walked = true
    if (cand.scaffold) {
      this.stats.towers++
      if (cand.scaffold.ledge) {
        if (this.scaffold.onScaffold() && (!this.hasActiveSweeper() || this.shouldDescendIsolatedPillar()) && !this.scaffold.contains(cand.stand.offset(0, -1, 0))) {
          await this.scaffold.descend().catch(() => {})
        }
        await this.placeTempBlock(cand.scaffold.ledge, { allowScaffold: false })
        await this.nav.goTo(cand.stand, 0.3, 10_000, { human: true, work: true, rescue: allowRescue })
        if (cand.edge) await this.scaffold.slide(cand.stand)
        return
      }
      await this.scaffold.tower(cand.scaffold, cand.stand)
      if (cand.edge) await this.scaffold.slide(cand.stand)
      return
    }
    // If `cand.edge` is true, ensure we FIRST walk/hop to `cand.cell` center if not already on `cand.cell`!
    // Never attempt to sneak-slide across multiple blocks or across a height difference!
    const walkGoal = cand.edge && cand.cell ? new Vec3(cand.cell.x + 0.5, cand.stand.y, cand.cell.z + 0.5) : cand.stand
    const hasSubShift = Boolean(!cand.edge && cand.cell && (Math.abs(cand.stand.x - (cand.cell.x + 0.5)) > 0.08 || Math.abs(cand.stand.z - (cand.cell.z + 0.5)) > 0.08))
    const nearTol = cand.edge ? 0.22 : (hasSubShift ? 0.14 : 0.32)
    const dx = Math.abs(e.x - walkGoal.x); const dz = Math.abs(e.z - walkGoal.z)
    const near = dx < nearTol && dz < nearTol && Math.abs(e.y - walkGoal.y) < 0.35
    if (!near) {
      this._walked = true
      const sameColBelow = Math.floor(walkGoal.x) === Math.floor(e.x) && Math.floor(walkGoal.z) === Math.floor(e.z) && walkGoal.y < e.y - 0.5
      if (this.scaffold.onScaffold() && (sameColBelow || ((!this.hasActiveSweeper() || this.shouldDescendIsolatedPillar()) && !this.scaffold.contains(walkGoal.offset(0, -1, 0)) && (walkGoal.y < e.y - 1.0 || Math.hypot(walkGoal.x - e.x, walkGoal.z - e.z) > 1.85)))) {
        await this.scaffold.descend().catch(() => {})
      }
      const far = e.distanceTo(walkGoal)
      if (far > 40) this.logger.warn(`placer: walking ${Math.round(far)} blocks to stand at ${walkGoal.x.toFixed(1)},${walkGoal.y},${walkGoal.z.toFixed(1)} (from ${e.x.toFixed(0)},${e.y.toFixed(0)},${e.z.toFixed(0)}); task ${cand.task?.world ? `${cand.task.world.x},${cand.task.world.y},${cand.task.world.z}` : '?'}`)
      const hopD = Math.hypot(walkGoal.x - e.x, walkGoal.z - e.z)
      const tHop = Date.now()
      const hs = (this.hopStats = this.hopStats || { hops: 0, hopMs: 0, walks: 0, walkMs: 0, walkDist: 0 })
      this.setPhase('walk: hop')
      if (await this.hop(walkGoal).then(ok => { if (ok) { hs.hops++; hs.hopMs += Date.now() - tHop } return ok }).catch(() => false)) { /* hopped */ } else {
        this.setPhase('walk: pathing')
        const tw = Date.now()
        try {
          await this.nav.goTo(walkGoal, 0.3, allowRescue ? 8_000 : 4_000, { human: true, work: true, rescue: allowRescue, reachVerdict: cand._reachVerdict })
        } catch (navErr) {
          const curP = this.bot.entity?.position
          const dyStep = curP ? (walkGoal.y - curP.y) : 99
          const hStep = curP ? Math.hypot(walkGoal.x - curP.x, walkGoal.z - curP.z) : 99
          if (curP && hStep <= 1.95 && dyStep >= -0.25 && dyStep <= 1.22 && typeof this.scaffold?._stepOntoTop === 'function') {
            const stepped = await this.scaffold._stepOntoTop(walkGoal, 1800).catch(() => false)
            if (!stepped) throw navErr
          } else {
            throw navErr
          }
        }
        hs.walks++; hs.walkMs += Date.now() - tw; hs.walkDist += hopD
      }
    }
    this.setPhase('walk: settle')
    let st = await this.ground.waitSafe(1500)
    if (st !== 'grounded' && st !== 'resting') { await this.nav.unstick(); st = await this.ground.waitSafe(1200) }
    if (st !== 'grounded' && st !== 'resting') throw new BuildError('NOT_GROUNDED', `bot is ${st} at stand ${key(cand.stand)}`)
    if (cand.edge) {
      const canAimHere = Boolean(target && spec && this.aim.fromPose(target, spec, null, opts || {}))
      if (!canAimHere) {
        this.setPhase('edge slide')
        await this.scaffold.slide(cand.stand, true)
      }
    }
  }

  async aimAndValidate (target, spec, pose, opts = {}, cand = null) {
    this.setPhase('aiming')
    let cur = pose
    const avoid = []; const misses = new Map()
    let lastMiss = null; let sameMiss = 0
    for (let attempt = 0; attempt < 7; attempt++) {
      this.check()
      this.aimTries = (this.aimTries || 0) + 1
      await this.look.lookAtPoint(cur.hit)
      const view = this.aim.validateView(spec, cur.faceOpt, cur.ref, cur.faceName)
      if (view) return { view, pose: cur }
      if (this.aim.lastReject === lastMiss) { if (++sameMiss >= 4) break } else { lastMiss = this.aim.lastReject; sameMiss = 0 }
      const hk = key(cur.hit)
      misses.set(hk, (misses.get(hk) || 0) + 1)
      if (misses.get(hk) >= 2) avoid.push(cur.hit)
      if (attempt === 1 && cand) { if (cand.edge) await this.scaffold.slide(cand.stand, true).catch(() => {}); else await this.settleOnStand(cand, target, spec, opts).catch(() => {}); }
      const again = this.aim.fromPose(target, spec, null, { ...opts, avoid })
      if (!again) break
      cur = again
      if (attempt === 2) await this.look.nudge((Math.random() - 0.5) * 0.01, (Math.random() - 0.5) * 0.01)
    }
    const e = this.bot.entity
    const sneak = this.bot.getControlState('sneak')
    const eye = e.position.offset(0, this.aim.eyeHeight ? this.aim.eyeHeight(sneak) : 1.62, 0)
    const d = cur.hit.minus(eye)
    const extra = {
      eye: eye.toString(), stand: e.position.toString(), yaw: +e.yaw.toFixed(3), pitch: +e.pitch.toFixed(3),
      wantYaw: +Math.atan2(-d.x, -d.z).toFixed(3), wantPitch: +Math.atan2(d.y, Math.hypot(d.x, d.z)).toFixed(3),
      aimPoint: cur.hit.toString(), distance: +d.norm().toFixed(2), sneak, speed: this.config.building?.speed
    }
    throw new BuildError('AIM', `crosshair never settled on ${pose.faceName} of ${key(pose.ref)}: ${this.aim.lastReject}`, { extra })
  }

  async clearCell (task) {
    this.setPhase('clearing the cell')
    const block = this.world.blockAt(task.world)
    if (!block || isAirLike(block) || this.isReplaceable(block)) return
    if (this._protectedDigCells?.has(key(task.world))) {
      throw new BuildError('DIG_REJECTED', `server protected cell at ${key(task.world)}`)
    }
    if (task.kind === 'block' && (CONTAINERS.test(block.name) || block.entity) && block.name !== task.name) {
      throw new BuildError('PROTECTED', `refusing to break ${block.name} at ${key(task.world)}`)
    }
    if (!this.config.building?.correctMismatchedBlocks) throw new BuildError('WRONG_BLOCK', `wrong block ${block.name} at ${key(task.world)}`)
    await this.digBlock(task.world)
  }

  async digBlock (pos, opts = {}) {
    const { pose } = await this.approach(new Vec3(pos.x, pos.y, pos.z), FREE, { mode: 'self', allowScaffold: opts.allowScaffold !== false })
    const block = this.world.blockAt(pos)
    if (!block || isAirLike(block)) return
    const aimed = await this.aimAndValidate(pos, FREE, pose, { mode: 'self' })
    try {
      await this.interaction.digAimed(this.world.blockAt(pos), FACE_INDEX[aimed.pose.faceName])
    } catch (digErr) {
      if (digErr?.code === 'DIG_REJECTED' || digErr?.code === 'DIG_PROTECTED') {
        this._protectedDigCells = this._protectedDigCells || new Set()
        this._protectedDigCells.add(key(pos))
      }
      throw digErr
    }
    this._reach?.clear(); this.brain?.clearCache?.()
    this.stats.dug++
  }

  async unsealRoofAbove (task) {
    if (!task || task.kind !== 'block') return null
    const target = task.world
    const b1 = this.world.blockAt(target.offset(0, 1, 0))
    const b2 = this.world.blockAt(target.offset(0, 2, 0))
    const roofBlocked = (b1 && b1.boundingBox === 'block' && !isAirLike(b1)) || (b2 && b2.boundingBox === 'block' && !isAirLike(b2))
    if (!roofBlocked) return null
    let walledSides = 0
    for (const [sx, sz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sb = this.world.blockAt(target.offset(sx, 0, sz))
      if (sb && sb.boundingBox === 'block' && !isAirLike(sb)) walledSides++
    }
    if (walledSides < 3) return null
    const offsets = [[0, 2, 0], [0, 1, 0], [0, 3, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]
    for (const [dx, dy, dz] of offsets) {
      const roofPos = target.offset(dx, dy, dz)
      const rb = this.world.blockAt(roofPos)
      if (!rb || rb.boundingBox !== 'block' || isAirLike(rb)) continue
      if (CONTAINERS.test(rb.name) || /bedrock|obsidian|barrier|piston|tnt|observer|repeater|comparator|note_block|trapdoor|redstone/.test(rb.name)) continue
      if (this.fluidBeside(roofPos, true)) continue
      const cands = this.aim.candidates(roofPos, FREE, { mode: 'self', allowScaffold: false })
      if (!cands.length) continue
      try {
        this.logger.info(`UNSEAL: opening 1 roof block ${rb.name}@${key(roofPos)} above sealed task ${task.name}@${key(target)}`)
        await this.digBlock(roofPos, { allowScaffold: false })
        this.planner?.reopenTask?.(key(roofPos), this.planner?.fleet?.index, { forceReset: true })
        return roofPos
      } catch {}
    }
    return null
  }

  async sweepTemporary ({ maxBlocks = 8, final = false, only = null, ignoreReserved = false, ignoreFluidBeside = false } = {}) {
    const sc = this.scaffold
    if (!sc || !sc.created.size) return 0
    let broke = 0
    const reserved = p => this.isReservedCell(p)
    for (let guard = 0; guard < maxBlocks + 4 && broke < maxBlocks; guard++) {
      const e = this.bot.entity
      if (!e || !e.onGround) break
      if (!only && this.bot.getControlState?.('sneak')) break
      if (!only && sc.onScaffold()) break
      const here = e.position
      if (!final && !only) {
        const underFeetKey = `${Math.floor(here.x)},${Math.floor(here.y - 0.05) - 1},${Math.floor(here.z)}`
        const underFeetTask = this.planner?.tasks?.get(underFeetKey)
        if (underFeetTask?.isolatedColumn || underFeetTask?.verticalAnchorCol) break
      }
      const eyeNow = here.offset(0, 1.62, 0)
      const cands = sc.getCreated().filter(p => {
        const b = this.world.blockAt(p)
        if (!b || isAirLike(b)) { sc.created.delete(key(p)); return false }
        const tTask = this.planner?.tasks?.get(key(p))
        if (tTask && (tTask.status === 'completed' || taskMatches(b, tTask))) { sc.created.delete(key(p)); return false }
        if (only && !only.has(key(p))) return false
        // Never break the block directly under the bot's own feet!
        if (Math.abs(p.x + 0.5 - here.x) < 0.85 && Math.abs(p.z + 0.5 - here.z) < 0.85 && p.y >= Math.floor(here.y - 0.1) - 1 && p.y <= Math.floor(here.y) + 1) return false
        // Never break a temporary block under another fleet worker
        if (this.planner?.fleet?.coord?.workers) {
          for (const w of this.planner.fleet.coord.workers.values()) {
            if (w.id === this.planner.fleet.id || !w.pos) continue
            if (Math.abs(p.x + 0.5 - w.pos.x) < 1.15 && Math.abs(p.z + 0.5 - w.pos.z) < 1.15 && Math.abs(p.y - w.pos.y) <= 2) return false
          }
        }
        const distHoriz = Math.hypot(p.x + 0.5 - here.x, p.z + 0.5 - here.z)
        if (distHoriz > 5 || Math.abs(p.y - here.y) > 5) return false
        if (eyeNow.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.65) return false
        if (!ignoreFluidBeside && this.fluidBeside(p, final)) return false
        if (!final && !only) {
          const isTaskCellHere = reserved(p)
          if ((p.isAccessStep || p.isCatwalk) && !isTaskCellHere) return false
          const age = p.createdAt ? (Date.now() - p.createdAt) : 99_999
          // Keep very recent blocks (< 6s) while the bot is still right next to them, unless the block is obstructing a schematic task cell
          if (!isTaskCellHere && age < 6_000 && distHoriz < 2.2) return false
        }
        return true
      }).sort((a, b) => (b.y - a.y) || (Math.hypot(a.x + 0.5 - here.x, a.z + 0.5 - here.z) - Math.hypot(b.x + 0.5 - here.x, b.z + 0.5 - here.z)))
      if (!cands.length) break
      let target = null; let pose = null
      for (const p of cands) {
        const ps = this.aim.fromPose(p, FREE, null, { mode: 'self' })
        if (ps) { target = p; pose = ps; break }
      }
      if (!target) { this.logger.debug?.(`TIDY: no aim pose to any of ${cands.length} temporary block(s) from ${key(here.floored())}`); break }
      try {
        this.setPhase('tidying: breaking the bridge from solid ground')
        const aimed = await this.aimAndValidate(target, FREE, pose, { mode: 'self' })
        await this.interaction.digAimed(this.world.blockAt(target), FACE_INDEX[aimed.pose.faceName])
        sc.created.delete(key(target))
        this._reach?.clear(); this.brain?.clearCache?.()
        this.stats.dug++
        broke++
        this.logger.info(`TIDY: broke temporary ${key(target)} from ${key(here.floored())} (${sc.created.size} left)`)
      } catch (error) {
        if (error.code === 'INTERRUPTED') throw error
        this.logger.info(`TIDY: ${key(target)} not broken: ${error.message}`)
        break
      }
    }
    return broke
  }

  fluidBeside (p, final) {
    const pk = `${p.x},${p.y},${p.z}`
    const pIsFluidCell = Boolean(this.planner?.fluidCells?.has(pk))
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const b = this.world.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })
      if (!b) continue
      if (b.name === 'lava') return true
      if (dy >= 0) {
        const props = b.getProperties?.() || b.properties || {}
        const isWet = b.name === 'water' || ((props.waterlogged === true || props.waterlogged === 'true') && !/(_leaves$|mangrove_roots)/.test(b.name || ''))
        if (isWet) {
          if (!final) return true
          const isSchematicTaskCell = Boolean(this.planner?.tasks?.has(pk))
          if (!pIsFluidCell && (isSchematicTaskCell || (dy === 1 && b.name === 'water'))) return true
          if (!isSchematicTaskCell && b.name !== 'water') continue
          // Also check if any horizontal/downward neighbor of `p` is still unsealed
          for (const [nx, ny, nz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
            const adjKey = `${p.x + nx},${p.y + ny},${p.z + nz}`
            const adjBlock = this.world.blockAt({ x: p.x + nx, y: p.y + ny, z: p.z + nz })
            const adjTask = this.planner?.tasks?.get(adjKey)
            if (adjTask && adjTask.kind === 'block' && adjTask.status !== 'completed') return true
            if ((!adjBlock || adjBlock.boundingBox !== 'block') && !this.planner?.fluidCells?.has(adjKey)) return true
          }
        }
      }
    }
    return false
  }

  async cleanupAll () {
    const sc = this.scaffold
    let rounds = 0; let stuck = 0
    const unreachableTemp = new Set()
    const deadline = Date.now() + 35_000
    while (sc && sc.created.size && rounds++ < 15 && Date.now() < deadline) {
      this.check()
      for (const p of sc.getCreated()) {
        const b = this.world.blockAt(p)
        const tTask = this.planner?.tasks?.get(key(p))
        if (!b || isAirLike(b) || (tTask && (tTask.status === 'completed' || taskMatches(b, tTask)))) sc.created.delete(key(p))
      }
      if (!sc.created.size) break
      if (sc.onScaffold() && sc.heightUnderFeet() >= 1) await sc.descend().catch(() => {})
      const n = await this.sweepTemporary({ maxBlocks: 10, final: true, ignoreReserved: true })
      if (n > 0) { stuck = 0; continue }
      const e = this.bot.entity.position
      const list = sc.getCreated()
        .filter(p => !unreachableTemp.has(key(p)))
        .sort((a, b) => Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z))
      if (!list.length) break
      let moved = false
      for (const p of list.slice(0, 4)) {
        const rawCs = this.aim.candidates(p, FREE, { mode: 'self', allowScaffold: false, max: 20, stages: [{ r: 5, down: 8, up: 3, aroundTarget: true }] })
          .filter(c => !sc.contains(c.cell) && !sc.contains({ x: c.cell.x, y: c.cell.y - 1, z: c.cell.z }) && !this.isDeadStand(c.stand))
        const reachableCs = rawCs.filter(c => !this.brain || this.reachVerdict(c.stand) !== 'no')
        const cs = reachableCs.length ? reachableCs : rawCs
        if (!cs.length) { unreachableTemp.add(key(p)); continue }
        let pDone = false
        for (const cand of cs.slice(0, 3)) {
          try {
            this.logger.info(`TIDY: walking to ${key(cand.cell)} to break ${key(p)} (${cs.length} options)`)
            this.setPhase('tidying: walking to solid ground next to the bridge')
            await require('../recovery/fall-guard').withHold(this.bot, () => this.nav.goTo(cand.stand, 0.4, 8_000, { human: true, work: true, rescue: false }))
            const swept = await this.sweepTemporary({ maxBlocks: 2, final: true, only: new Set([key(p)]), ignoreReserved: true })
            if (swept || !sc.created.has(key(p))) { moved = true; pDone = true; break }
          } catch (error) {
            this.noteDeadStand(cand.stand)
            this.logger.info(`TIDY: could not walk to ${key(p)} via ${key(cand.cell)}: ${error.message}`)
          }
        }
        if (pDone) break
        unreachableTemp.add(key(p))
      }
      if (!moved) {
        const tops = sc.getCreated()
          .filter(p => !unreachableTemp.has(`top:${key(p)}`) && !sc.contains({ x: p.x, y: p.y + 1, z: p.z }))
          .sort((a, b) => (b.y - a.y) || (Math.hypot(a.x - e.x, a.z - e.z) - Math.hypot(b.x - e.x, b.z - e.z)))
        for (const p of tops.slice(0, 3)) {
          try {
            this.logger.info(`TIDY: climbing onto the top of the temporary column at ${key(p)} to take it down from above`)
            this.setPhase('tidying: taking the column down from above')
            await require('../recovery/fall-guard').withHold(this.bot, async () => { await this.nav.goTo(new Vec3(p.x + 0.5, p.y + 1, p.z + 0.5), 0.35, 8_000, { human: true, work: true, rescue: false }); await sc.descend() })
            moved = true; break
          } catch (error) {
            unreachableTemp.add(`top:${key(p)}`)
            this.logger.info(`TIDY: could not climb onto ${key(p)}: ${error.message}`)
          }
        }
      }
      if (!moved && stuck >= 1 && this.exit) {
        for (const p of sc.getCreated().filter(c => !unreachableTemp.has(`rm:${key(c)}`) && !this.fluidBeside(c, true)).slice(0, 2)) {
          unreachableTemp.add(`rm:${key(p)}`)
          if (await this.exit.removeTemp(p).catch(() => false)) { moved = true; stuck = 0; break }
        }
      }
      if (!moved && ++stuck >= 2) {
        this.logger.warn(`TIDY: ${sc.created.size} temporary block(s) cannot be reached from solid ground: ${sc.getCreated().slice(0, 6).map(key).join(' ')}`)
        break
      }
    }
    return sc ? sc.created.size : 0
  }

  async execute (task) {
    this.flow = false
    this._walked = false
    this.check()
    const here = this.world.blockAt(task.world)
    if (taskMatches(here, task)) return 'already'
    if (task.kind === 'block' && task.info.post.length && matches(here, task.info, { ignore: this.postKeys(task) })) {
      await this.postActions(task)
      return 'placed'
    }
    if (task.kind === 'fluid') return this.executeFluid(task)
    if (task.kind === 'waterlog') return this.executeWaterlog(task)
    return this.executeBlock(task)
  }

  hasRef (task, forSpec = null) {
    const specs = task.info.specs.filter(sp => !sp.hyp)
    const checkSpecs = forSpec ? [forSpec] : (specs.length ? specs : [task.info.specs[0]])
    const V = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
    for (const spec of checkSpecs) {
      if (!spec) continue
      const ok = usableFaces(spec).some(fname => {
        const v = V[fname]
        const rx = task.world.x - v[0]; const ry = task.world.y - v[1]; const rz = task.world.z - v[2]
        const b = this.world.blockAt({ x: rx, y: ry, z: rz })
        if (!this.aim.isSolidRef(b, fname)) return false
        if (task.info?.fragile) {
          if (this.scaffold?.created?.has(`${rx},${ry},${rz}`)) return false
          const rt = this.planner?.tasks?.get(`${rx},${ry},${rz}`)
          if (rt && rt.kind === 'block' && rt.status !== 'completed') return false
        }
        return true
      })
      if (ok) return true
    }
    return false
  }

  hasSolidNeighbor (cell, ignoreCell = null) {
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const n = new Vec3(cell.x + dx, cell.y + dy, cell.z + dz)
      if (ignoreCell && n.equals(ignoreCell)) continue
      const b = this.world.blockAt(n)
      if (b && b.boundingBox === 'block' && !isAirLike(b)) return true
    }
    return false
  }

  async placeTempBlock (cell, searchOpts = { allowScaffold: false }) {
    if ((this._tempDepth || 0) >= 1) {
      throw new BuildError('NO_ACCESS', `refusing recursive temporary block placement at ${key(cell)}`)
    }
    this._tempDepth = (this._tempDepth || 0) + 1
    try {
      const item = this.scaffold.itemName
      const pseudo = { kind: 'block', name: item, item, world: cell, properties: {}, info: { ...describeBlock(item, {}), specs: [FREE] } }
      await this.materials.ensureItem(item, 1)
      const outcome = await this.placeWithSpec(pseudo, FREE, { ...searchOpts, allowScaffold: false, onlyScaffold: false })
      if (outcome !== 'ok') throw new BuildError('REFUSED', `temporary support block did not appear at ${key(cell)}`)
      const rec = cell.clone()
      rec.createdAt = Date.now()
      this.scaffold.created.set(key(cell), rec)
      this.planner?.fleet?.coord?.addTempBlock?.(rec, this.planner?.fleet?.id)
      this._reach?.clear(); this.brain?.clearCache?.()
      return rec
    } finally {
      this._tempDepth = Math.max(0, (this._tempDepth || 1) - 1)
    }
  }

  activeSpecs (task) {
    const all = this.learner?.order ? this.learner.order(task) : (task.info?.specs || [FREE])
    const filtered = all.filter(spec => {
      if (spec.partnerDir && spec.whenPartner) {
        const pv = VEC[spec.partnerDir]
        const pb = pv ? this.world.blockAt(task.world.offset(pv[0], pv[1], pv[2])) : null
        const hasPartner = Boolean(pb && pb.name === task.name && String(pb.getProperties?.()?.facing || '') === String(task.properties?.facing || ''))
        if (spec.whenPartner === 'absent' && hasPartner) return false
        if (spec.whenPartner === 'present' && !hasPartner) return false
      }
      return true
    })
    return filtered.length ? filtered : all
  }

  // Simulates placing `L` as a solid temporary block and verifies:
  // (a) the bot is not currently trapped in a sunken trench/pit,
  // (b) `standAbove = L.offset(0, 1, 0)` can be stepped onto from a currently reachable neighbor cell (AND with `L` in place, `brain.reachability(standAbove)` is not 'no'), AND
  // (c) standing at `standAbove` actually yields a valid aim candidate for `task.world` under `spec`!
  // This prevents the bot from ever placing a useless temporary ledge that cannot aim at `task.world` or cannot be stepped onto!
  canPlaceFromSimulatedLedge (L, standAbove, task, spec) {
    if (this.aim.lavaNear(standAbove)) return false
    if (this.bot?.entity?.position) {
      const fcNow = feetCellOf(this.world, this.bot.entity.position)
      const fcVec = new Vec3(fcNow.x, fcNow.y, fcNow.z)
      const underNow = this.world.blockAt(new Vec3(fcNow.x, fcNow.y - 1, fcNow.z))
      const rawNow = this.world.blockAt(this.bot.entity.position.floored())
      if (this.aim.isHazard(fcVec) || SUNKEN_NO_STAND.test(underNow?.name || '') || SUNKEN_NO_STAND.test(rawNow?.name || '')) {
        return false
      }
    }
    const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    let reachableEntry = false
    for (const [dx, dz] of H4) {
      for (const dy of [0, -1, 1]) {
        const nb = standAbove.offset(dx, dy, dz)
        if (!this.aim.standOk(nb, new Map())) continue
        if (!this.brain || this.reachVerdict(new Vec3(nb.x + 0.5, nb.y, nb.z + 0.5)) !== 'no') {
          reachableEntry = true
          break
        }
      }
      if (reachableEntry) break
    }
    if (!reachableEntry) return false
    const origWorldBlockAt = this.world.blockAt.bind(this.world)
    const origBotBlockAt = this.bot.blockAt ? this.bot.blockAt.bind(this.bot) : null
    const origIsHazard = this.aim.isHazard
    const fakeStone = {
      name: this.scaffold?.itemName || 'stone',
      boundingBox: 'block',
      _simulated: true,
      shapes: [[0, 0, 0, 1, 1, 1]],
      position: L.clone(),
      getProperties: () => ({}),
      properties: {}
    }
    this.world.blockAt = (p, ...rest) => {
      if (p && Math.floor(p.x) === L.x && Math.floor(p.y) === L.y && Math.floor(p.z) === L.z) return fakeStone
      return origWorldBlockAt(p, ...rest)
    }
    if (origBotBlockAt) {
      this.bot.blockAt = (p, ...rest) => {
        if (p && Math.floor(p.x) === L.x && Math.floor(p.y) === L.y && Math.floor(p.z) === L.z) return fakeStone
        return origBotBlockAt(p, ...rest)
      }
    }
    // With `L` placed directly under `standAbove`, `standAbove` has a solid stone floor and is not a pit hazard
    this.aim.isHazard = cell => {
      if (cell && ((cell.x === standAbove.x && cell.y === standAbove.y && cell.z === standAbove.z) || (cell.x === L.x && cell.y === L.y && cell.z === L.z))) {
        return false
      }
      return origIsHazard ? origIsHazard(cell) : false
    }
    try {
      const standVec = new Vec3(standAbove.x + 0.5, standAbove.y, standAbove.z + 0.5)
      if (this.isDeadStand(standVec)) return false
      if (this.brain && this.brain.reachability(standVec).verdict === 'no') {
        return false
      }
      const simCands = this.aim.candidates(task.world, spec, { fixedStand: standAbove, allowScaffold: false })
      return simCands.length > 0
    } finally {
      this.world.blockAt = origWorldBlockAt
      if (origBotBlockAt) this.bot.blockAt = origBotBlockAt
      this.aim.isHazard = origIsHazard
    }
  }

  canPlaceTaskWithSimulatedRefs (refs, task, specsOrSpec) {
    if (!specsOrSpec || !refs || !refs.length || !this.aim?.fromPose) return 'walkable'
    const specList = Array.isArray(specsOrSpec) ? specsOrSpec.filter(Boolean) : [specsOrSpec]
    if (!specList.length) return 'walkable'
    const origWorldBlockAt = this.world.blockAt.bind(this.world)
    const origBotBlockAt = this.bot?.blockAt ? this.bot.blockAt.bind(this.bot) : null
    const refMap = new Map()
    for (const r of refs) {
      refMap.set(key(r), {
        name: this.scaffold?.itemName || 'stone',
        boundingBox: 'block',
        _simulated: true,
        shapes: [[0, 0, 0, 1, 1, 1]],
        position: r.clone(),
        getProperties: () => ({}),
        properties: {}
      })
    }
    this.world.blockAt = (p, ...rest) => {
      if (p) {
        const fake = refMap.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
        if (fake) return fake
      }
      return origWorldBlockAt(p, ...rest)
    }
    if (origBotBlockAt) {
      this.bot.blockAt = (p, ...rest) => {
        if (p) {
          const fake = refMap.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
          if (fake) return fake
        }
        return origBotBlockAt(p, ...rest)
      }
    }
    const usesRef = c => Boolean(c?.ref && refs.some(r => r.x === c.ref.x && r.y === c.ref.y && r.z === c.ref.z))
    try {
      let anyWalkable = false
      let anyScaffold = false
      for (const spec of specList) {
        const refFaces = Array.isArray(spec.faces)
          ? spec.faces.filter(fo => {
              const Fv = VEC[fo.f]
              return Fv && refs.some(r => r.x === task.world.x - Fv[0] && r.y === task.world.y - Fv[1] && r.z === task.world.z - Fv[2])
            })
          : []
        if (!refFaces.length) continue
        const simSpec = refFaces.length === spec.faces.length ? spec : { ...spec, faces: refFaces }
        if (this.standingStill()) {
          const directPose = this.aim.fromPose(task.world, simSpec, null, {})
          if (directPose && usesRef(directPose)) return 'direct'
        }
        const simCands = this.aim.candidates(task.world, simSpec, { allowScaffold: false, max: 6, stages: [{ r: 5, down: 6, up: 3, aroundTarget: true }] })
        const isSimStandWalkable = c => {
          if (!usesRef(c)) return false
          const standsOnSimRef = Boolean(c.cell && refMap.has(key(c.cell.offset(0, -1, 0))))
          if (standsOnSimRef) {
            if (refs.length >= 2) return true
            const R0 = refs[0]
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              for (const ny of [R0.y + 1, R0.y, R0.y + 2]) {
                const N = new Vec3(R0.x + dx, ny, R0.z + dz)
                if (refMap.has(key(N.offset(0, -1, 0)))) continue
                if (this.aim.standOk(N) && (!this.brain || this.reachVerdict(new Vec3(N.x + 0.5, N.y, N.z + 0.5)) !== 'no')) {
                  return true
                }
              }
            }
            return false
          }
          return !this.isDeadStand(c.stand) && (!this.brain || this.reachVerdict(c.stand) !== 'no')
        }
        if (simCands.some(isSimStandWalkable)) {
          anyWalkable = true
        }
        if (!anyWalkable && !anyScaffold) {
          const scafCands = this.aim.candidates(task.world, simSpec, { onlyScaffold: true, max: 4, stages: [{ r: 4, down: 6, up: 2, aroundTarget: true }] })
          if (scafCands.some(c => usesRef(c) && (!this.brain || !c.scaffold?.floor || refMap.has(key(c.scaffold.floor.offset(0, -1, 0))) || this.reachVerdict(new Vec3(c.scaffold.floor.x + 0.5, c.scaffold.floor.y, c.scaffold.floor.z + 0.5)) !== 'no'))) anyScaffold = true
        }
        // For look-up blocks (`spec.look === 'up'`) when simulating the overhead reference `R = task.world.offset(0, 1, 0)`,
        // also check if a look-up ledge `L` (`finishSupport -> tryPlaceLookUpLedge`) can provide a valid stand!
        if (!anyScaffold && spec.look === 'up' && refs.some(r => r.x === task.world.x && r.y === task.world.y + 1 && r.z === task.world.z)) {
          for (const dy of [-2, -3, -4]) {
            for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
              const L = new Vec3(task.world.x + dx, task.world.y + dy, task.world.z + dz)
              if (L.equals(task.world)) continue
              const lb = this.world.blockAt(L)
              if (!lb || !(isAirLike(lb) || lb.name === 'water')) continue
              const standAbove = L.offset(0, 1, 0)
              if (!isBodyFree(this.world.blockAt(standAbove)) || !isBodyFree(this.world.blockAt(standAbove.offset(0, 1, 0)))) continue
              if (this.canPlaceFromSimulatedLedge(L, standAbove, task, spec)) {
                anyScaffold = true
                break
              }
            }
            if (anyScaffold) break
          }
        }
      }
      return anyWalkable ? 'walkable' : (anyScaffold ? 'scaffold' : false)
    } finally {
      this.world.blockAt = origWorldBlockAt
      if (origBotBlockAt) this.bot.blockAt = origBotBlockAt
    }
  }

  async provideSupport (task, forSpec = null) {
    this.setPhase('providing a reference block (support)')
    if (this.config.building?.allowTemporaryScaffolding === false) throw new BuildError('NO_ACCESS', `no reference block next to ${key(task.world)}`)
    if (task.info?.fragile && this.planner?.refPending?.(task)) {
      throw new BuildError('NO_ACCESS', `waiting for supporting schematic block for ${task.name}@${key(task.world)}`)
    }
    const nonHyp = this.activeSpecs(task).filter(sp => !sp.hyp)
    // Always include all active non-hypothesis specs as fallback after `forSpec` so if `forSpec`'s reference cell is
    // occupied (e.g. `trapdoor-flat` blocked by `redstone_wire` below), `trapdoor-side` (`R = east`) is used seamlessly!
    const checkSpecs = forSpec
      ? [forSpec, ...nonHyp.filter(sp => sp !== forSpec)]
      : (nonHyp.length ? nonHyp : [task.info.specs[0]])
    const primarySpec = checkSpecs[0]
    const V = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
    // If the bot is currently on a disconnected roof/island from `task.world` (every walkable stand within 2m of `task.world` has `reachVerdict === "no"`),
    // connect to the target region ONCE upfront (e.g. via Ender Pearl from a vantage rim) before evaluating local support blocks!
    if (this.brain && this.bot?.entity?.position && this.bot.entity.position.distanceTo(task.world) > 6.5) {
      const standCache = new Map()
      const localStands = []
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            const sc = new Vec3(task.world.x + dx, task.world.y + dy, task.world.z + dz)
            if (sc.equals(task.world)) continue
            if (this.aim.standOk(sc, standCache) && !this.aim.isHazard(sc)) {
              localStands.push(new Vec3(sc.x + 0.5, sc.y, sc.z + 0.5))
            }
          }
        }
      }
      if (localStands.length === 0) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -6; dx <= 6; dx++) {
            for (let dz = -6; dz <= 6; dz++) {
              const sc = new Vec3(task.world.x + dx, task.world.y + dy, task.world.z + dz)
              if (sc.equals(task.world)) continue
              if (this.aim.standOk(sc, standCache) && !this.aim.isHazard(sc)) {
                localStands.push(new Vec3(sc.x + 0.5, sc.y, sc.z + 0.5))
              }
            }
          }
        }
      }
      if (localStands.length > 0) {
        const bp = this.bot.entity.position
        const reachableLocal = localStands.filter(ls => this.reachVerdict(ls) !== 'no')
        if (reachableLocal.length === 0) {
          localStands.sort((a, b) => (Math.abs(a.y - (task.world.y + 1)) * 2 + Math.hypot(a.x - bp.x, a.z - bp.z)) - (Math.abs(b.y - (task.world.y + 1)) * 2 + Math.hypot(b.x - bp.x, b.z - bp.z)))
          const targetStand = localStands[0]
          const prep = await this.brain.prepare(targetStand, { force: true }).catch(() => 'no')
          this._reach?.clear()
          this.brain?.clearCache?.()
          if (prep === 'no' && this.reachVerdict(targetStand) === 'no') {
            throw new BuildError('NO_ACCESS', `no physical access to region around ${key(task.world)}`)
          }
        } else if (bp.distanceTo(task.world) > 10.0) {
          reachableLocal.sort((a, b) => (Math.abs(a.y - (task.world.y + 1)) * 3 + Math.hypot(a.x - task.world.x - 0.5, a.z - task.world.z - 0.5)) - (Math.abs(b.y - (task.world.y + 1)) * 3 + Math.hypot(b.x - task.world.x - 0.5, b.z - task.world.z - 0.5)))
          const nearAnchor = reachableLocal[0]
          if (bp.distanceTo(nearAnchor) > 4.0) {
            await this.nav.goTo(nearAnchor, 2.5, 8_000, { human: true, work: true, rescue: true }).catch(() => {})
            this._reach?.clear()
            this.brain?.clearCache?.()
          }
        }
      }
    }
    const options = []
    const seenOpt = new Set()
    for (const sp of checkSpecs) {
      if (!sp) continue
      for (const fname of usableFaces(sp)) {
        const v = V[fname]
        const cell = new Vec3(task.world.x - v[0], task.world.y - v[1], task.world.z - v[2])
        const ck = key(cell)
        if (!seenOpt.has(ck)) {
          seenOpt.add(ck)
          options.push(cell)
        }
      }
    }
    const simCache = (task._precomputedSimRefs && Date.now() - task._precomputedSimRefs.at < 2500 && task._precomputedSimRefs.map instanceof Map)
      ? new Map(task._precomputedSimRefs.map)
      : new Map()
    const evalSimR = r => {
      const k = key(r)
      if (simCache.has(k)) return simCache.get(k)
      const rb = this.world.blockAt(r)
      const v = (!rb || !(isAirLike(rb) || rb.name === 'water')) ? false : this.canPlaceTaskWithSimulatedRefs([r], task, checkSpecs)
      simCache.set(k, v)
      return v
    }
    if (primarySpec?.look === 'up') options.sort((a, b) => b.y - a.y)
    else {
      const ranks = new Map()
      for (const r of options) {
        if (!simCache.has(key(r))) await new Promise(resolve => setImmediate(resolve))
        const v = evalSimR(r)
        ranks.set(key(r), v === 'direct' ? 0 : v === 'walkable' ? 1 : v === 'scaffold' ? 2 : 3)
      }
      const hasNeighborMap = new Map(options.map(r => [key(r), this.hasSolidNeighbor(r, task.world) ? 0 : 1]))
      const isPendingMap = new Map(options.map(r => {
        const rk = key(r)
        if (r.x === task.world.x && r.y === task.world.y - 1 && r.z === task.world.z) {
          let walled4 = 0
          for (const [wx, wz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const wb = this.world.blockAt({ x: r.x + wx, y: r.y, z: r.z + wz })
            if (wb && wb.boundingBox === "block" && !isAirLike(wb)) walled4++
          }
          if (walled4 === 4) return [rk, 3]
        }
        const rt = this.planner?.tasks?.get(rk)
        if (this.planner?.fluidCells?.has?.(rk) || (rt && rt.status !== "completed" && (rt.isFluidEnclosure || /(_sign$|_wall_sign$|_hanging_sign$)/.test(rt.name || "")))) return [rk, 2]
        if (this.planner?.isPendingCell?.(r)) return [rk, 1]
        return [rk, 0]
      }))
      options.sort((a, b) => (isPendingMap.get(key(a)) - isPendingMap.get(key(b))) || (ranks.get(key(a)) - ranks.get(key(b))) || (hasNeighborMap.get(key(a)) - hasNeighborMap.get(key(b))) || (hasNeighborMap.get(key(a)) === 1 ? (Math.abs(a.y - task.world.y) - Math.abs(b.y - task.world.y)) : 0) || (a.y - b.y))
    }
    let lastReason = 'no free column'
    const H = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const tryPlaceLookUpLedge = async () => {
      for (const dy of [-2, -3, -4]) {
        for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const L = new Vec3(task.world.x + dx, task.world.y + dy, task.world.z + dz)
          if (L.equals(task.world)) continue
          const lb = this.world.blockAt(L)
          if (!lb || !(isAirLike(lb) || lb.name === 'water')) continue
          const standAbove = L.offset(0, 1, 0)
          if (!isBodyFree(this.world.blockAt(standAbove)) || !isBodyFree(this.world.blockAt(standAbove.offset(0, 1, 0)))) continue
          if (!this.hasSolidNeighbor(L, task.world)) continue
          if (!this.aim.candidates(L, FREE, { allowScaffold: false }).some(c => !this.brain || this.reachVerdict(c.stand) !== 'no')) continue
          if (!this.canPlaceFromSimulatedLedge(L, standAbove, task, primarySpec)) continue
          try {
            await this.placeTempBlock(L, { allowScaffold: false })
            task._preferredStand = standAbove
            this.logger.info(`SUPPORT: placed temporary standing ledge at ${key(L)} for look-up ${task.name}@${key(task.world)}`)
            return [L]
          } catch (err) { lastReason = err.message }
        }
      }
      return null
    }
    if (primarySpec?.look === 'up' && this.hasRef(task, primarySpec)) {
      const ledge = await tryPlaceLookUpLedge()
      if (ledge) return ledge
    }
    // If `primarySpec.look !== 'up'` and `this.hasRef(task, primarySpec)` is ALREADY true, first try placing a side standing ledge
    // so the bot can reach `task.world` on foot AND aim at `task.world` from `standAbove`. If no side standing ledge works,
    // fall through to `for (const R of options)` so an additional reference block on an open face of `task.world` can be placed!
    if (primarySpec?.look !== 'up' && this.hasRef(task, primarySpec) && (task.attempts >= 1 || task.forceSupport)) {
      const existingCands = this.aim.candidates(task.world, primarySpec, { allowScaffold: false })
      const hasWalkable = existingCands.some(c => !this.brain || this.reachVerdict(c.stand) !== 'no')
      if (!hasWalkable) {
        const wantDir = primarySpec?.look || primarySpec?.horiz
        const standDir = wantDir && OPP[wantDir] ? VEC[OPP[wantDir]] : null
        const dirsToTry = standDir
          ? [[standDir[0], standDir[2]], [standDir[0] * 2, standDir[2] * 2], ...H, [1, 1], [1, -1], [-1, 1], [-1, -1]]
          : [...H, [1, 1], [1, -1], [-1, 1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]
        for (const dy of [-1, -2, 0]) {
          for (const [dx, dz] of dirsToTry) {
            const L = new Vec3(task.world.x + dx, task.world.y + dy, task.world.z + dz)
            if (L.equals(task.world)) continue
            const lb = this.world.blockAt(L)
            if (!lb || !(isAirLike(lb) || lb.name === 'water')) continue
            if (isFullTop(this.world.blockAt(L.offset(0, -1, 0)))) continue
            const standAbove = L.offset(0, 1, 0)
            if (standAbove.equals(task.world) || standAbove.offset(0, 1, 0).equals(task.world)) continue
            if (!isBodyFree(this.world.blockAt(standAbove)) || !isBodyFree(this.world.blockAt(standAbove.offset(0, 1, 0)))) continue
            if (!this.hasSolidNeighbor(L, task.world)) continue
            const lCands = this.aim.candidates(L, FREE, { allowScaffold: false })
            if (!lCands.some(c => !this.brain || this.reachVerdict(c.stand) !== 'no')) continue
            if (!this.canPlaceFromSimulatedLedge(L, standAbove, task, primarySpec)) continue
            try {
              await this.placeTempBlock(L, { allowScaffold: false })
              task._preferredStand = standAbove
              this.logger.info(`SUPPORT: placed temporary side standing ledge at ${key(L)} for ${task.name}@${key(task.world)}`)
              return [L]
            } catch (err) { lastReason = err.message }
          }
        }
      }
    }
    const finishSupport = async (placedRefs) => {
      if (primarySpec?.look === 'up') {
        const candsAfter = this.aim.candidates(task.world, primarySpec, { allowScaffold: false })
        const hasWalkableAfter = candsAfter.some(c => (!this.brain || this.reachVerdict(c.stand) !== 'no') && c.cell.y <= task.world.y - 1)
        if (!hasWalkableAfter) {
          const ledge = await tryPlaceLookUpLedge()
          if (ledge) return [...placedRefs, ...ledge]
        }
      }
      return placedRefs
    }
    const fragileOccupied = []
    for (const R of options) {
      await new Promise(resolve => setImmediate(resolve))
      if (primarySpec?.look !== 'up' && R.y > task.world.y && this.hasRef(task, primarySpec) && task.attempts < 2) continue
      const rTask = this.planner?.tasks?.get(key(R))
      // Only skip a pending schematic cell `rTask` if `task` itself is fragile (so sweeping `R` would pop `task` off)!
      // For non-fragile blocks (slabs, leaves, walls, cobblestone), placing a temporary solid block at `R` and sweeping it right after `task` is placed is completely safe!
      if (rTask && rTask.kind === 'block' && rTask.status !== 'completed' && task.info?.fragile) {
        lastReason = `reference cell ${key(R)} is pending schematic block ${rTask.name}`
        continue
      }
      if (this.planner?.fleet?.coord?.busyFor?.(this.planner.fleet.id, { key: key(R), world: R }, false)) {
        lastReason = `reference cell ${key(R)} is busy with another worker`
        continue
      }
      const rb = this.world.blockAt(R)
      if (!rb || !(isAirLike(rb) || rb.name === 'water')) {
        lastReason = `reference cell ${key(R)} is occupied by ${rb ? rb.name : 'unloaded'}`
        if (rb && rTask && rTask.info?.fragile && !CONTAINERS.test(rb.name) && !/^(repeater|comparator)$/.test(rb.name)) fragileOccupied.push({ R, rb, rTask })
        continue
      }
      const hasReachableStandFor = (cell) => {
        const cs = this.aim.candidates(cell, FREE, { allowScaffold: false, max: 6 })
        return cs.some(c => !this.brain || this.reachVerdict(c.stand) !== 'no')
      }
      const simR = evalSimR(R)
      if (!simR && (this.hasSolidNeighbor(task.world) || this.hasSolidNeighbor(R, task.world))) {
        lastReason = `reference cell ${key(R)} gives no walkable aim candidates for ${task.name}@${key(task.world)}`
        continue
      }
      if (simR && (simR !== 'walkable' && simR !== 'direct') && primarySpec?.look !== 'up' && this.hasRef(task, primarySpec)) {
        lastReason = `reference cell ${key(R)} gives no walkable aim candidates for ${task.name}@${key(task.world)}`
        continue
      }
      if (this.hasSolidNeighbor(R, task.world) && hasReachableStandFor(R)) {
        try {
          await this.placeTempBlock(R, { allowScaffold: false })
          this.logger.info(`SUPPORT: placed temporary reference block at ${key(R)} for ${task.name}@${key(task.world)}`)
          return await finishSupport([R])
        } catch (err) { lastReason = err.message }
      }
      for (const [dx, dz] of H) {
        const H_cell = new Vec3(R.x + dx, R.y, R.z + dz)
        if (H_cell.equals(task.world)) continue
        const hb = this.world.blockAt(H_cell)
        if (!hb || !(isAirLike(hb) || hb.name === 'water')) continue
        if (!this.hasSolidNeighbor(H_cell, task.world)) continue
        if (!hasReachableStandFor(H_cell)) continue
        if (!evalSimR(R)) continue
        try {
          await this.placeTempBlock(H_cell, { allowScaffold: false })
          await this.placeTempBlock(R, { allowScaffold: false })
          this.logger.info(`SUPPORT: placed 2-step temporary overhead support ${key(H_cell)} -> ${key(R)} for ${task.name}@${key(task.world)}`)
          return await finishSupport([R, H_cell])
        } catch (err) {
          lastReason = err.message
          if (!this.hasActiveSweeper()) await this.sweepTemporary({ maxBlocks: 2, final: true, only: new Set([key(H_cell)]), ignoreReserved: true }).catch(() => {})
        }
      }
      if (R.y === task.world.y + 1) {
        for (const [dx, dz] of H) {
          const P1 = new Vec3(task.world.x + dx, task.world.y, task.world.z + dz)
          const P2 = new Vec3(task.world.x + dx, task.world.y + 1, task.world.z + dz)
          if (P1.equals(task.world) || P2.equals(task.world) || P1.equals(R) || P2.equals(R)) continue
          const b1 = this.world.blockAt(P1)
          const b2 = this.world.blockAt(P2)
          if (!b1 || !(isAirLike(b1) || b1.name === 'water')) continue
          if (!b2 || !(isAirLike(b2) || b2.name === 'water')) continue
          if (!this.hasSolidNeighbor(P1, task.world)) continue
          if (!hasReachableStandFor(P1)) continue
          try {
            await this.placeTempBlock(P1, { allowScaffold: false })
            await this.placeTempBlock(P2, { allowScaffold: false })
            await this.placeTempBlock(R, { allowScaffold: false })
            this.logger.info(`SUPPORT: placed 3-step overhead support ${key(P1)} -> ${key(P2)} -> ${key(R)} for ${task.name}@${key(task.world)}`)
            return await finishSupport([R, P2, P1])
          } catch (err) {
            lastReason = err.message
            if (!this.hasActiveSweeper()) await this.sweepTemporary({ maxBlocks: 4, final: true, only: new Set([key(P1), key(P2)]), ignoreReserved: true }).catch(() => {})
          }
        }
      }
      for (const [dx1, dz1] of H) {
        const H1 = new Vec3(R.x + dx1 * 2, R.y, R.z + dz1 * 2)
        const H2 = new Vec3(R.x + dx1, R.y, R.z + dz1)
        if (H1.equals(task.world) || H2.equals(task.world)) continue
        const b1 = this.world.blockAt(H1)
        const b2 = this.world.blockAt(H2)
        if (!b1 || !(isAirLike(b1) || b1.name === 'water')) continue
        if (!b2 || !(isAirLike(b2) || b2.name === 'water')) continue
        if (!this.hasSolidNeighbor(H1, task.world)) continue
        if (!hasReachableStandFor(H1)) continue
        try {
          await this.placeTempBlock(H1, { allowScaffold: false })
          await this.placeTempBlock(H2, { allowScaffold: false })
          await this.placeTempBlock(R, { allowScaffold: false })
          this.logger.info(`SUPPORT: placed 2-step bridge ${key(H1)} -> ${key(H2)} -> ${key(R)} for ${task.name}@${key(task.world)}`)
          return await finishSupport([R, H2, H1])
        } catch (err) {
          lastReason = err.message
          if (!this.hasActiveSweeper()) await this.sweepTemporary({ maxBlocks: 4, final: true, only: new Set([key(H1), key(H2)]), ignoreReserved: true }).catch(() => {})
        }
      }
      // 3D Multi-Block Catwalk Bridge Builder (up to 6 blocks, including L-turns / knight-move steps like L13 oak_leaves):
      // Finds the shortest chain of air/water cells B_1 -> B_2 -> ... -> R starting adjacent to an existing solid block with a reachable stand,
      // walks out along the catwalk as it places each block, and marks every catwalk block with isAccessStep = true & isCatwalk = true!
      if (R.y <= task.world.y) {
        let foundChain = null
        for (const allowPendingBridge of [false, true]) {
          if (foundChain) break
          const qBridge = [{ cell: R, path: [R] }]
          const seenBridge = new Set([key(R), key(task.world)])
          let simChecks = 0
          for (let qi = 0; qi < qBridge.length && qBridge.length < 240 && simChecks < 12; qi++) {
            const cur = qBridge[qi]
            if (cur.path.length >= 2 && this.hasSolidNeighbor(cur.cell, task.world) && hasReachableStandFor(cur.cell)) {
              simChecks++
              const candidateChain = cur.path.slice().reverse()
              if (this.canPlaceTaskWithSimulatedRefs(candidateChain, task, checkSpecs)) {
                foundChain = candidateChain
                break
              }
              continue
            }
            if (cur.path.length >= 7) continue
            for (const [bdx, bdy, bdz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]) {
              const nc = new Vec3(cur.cell.x + bdx, cur.cell.y + bdy, cur.cell.z + bdz)
              if (Math.abs(nc.y - task.world.y) > 1 || Math.abs(nc.x - R.x) + Math.abs(nc.z - R.z) > 7) continue
              const nk = key(nc)
              if (seenBridge.has(nk)) continue
              if (this.scaffold?.noScaffold?.(nc)) continue
              if (!allowPendingBridge && (this.planner?.fluidCells?.has?.(nk) || this.planner?.isPendingCell?.(nc))) continue
              if (allowPendingBridge) {
                const nTask = this.planner?.tasks?.get(nk)
                if (nTask && nTask.status !== "completed" && /(_sign$|_wall_sign$|_hanging_sign$)/.test(nTask.name || "")) continue
              }
              const nb = this.world.blockAt(nc)
              if (!nb || !(isAirLike(nb) || nb.name === "water")) continue
              seenBridge.add(nk)
              qBridge.push({ cell: nc, path: [...cur.path, nc] })
            }
          }
        }
        if (foundChain && foundChain.length >= 2) {
          const placedCatwalk = []
          let cwOk = true
          try {
            for (let ci = 0; ci < foundChain.length; ci++) {
              const stepCell = foundChain[ci]
              const nextTarget = ci + 1 < foundChain.length ? foundChain[ci + 1] : task.world
              if (!hasReachableStandFor(stepCell) && ci > 0) {
                const prevCell = foundChain[ci - 1]
                const prevTop = new Vec3(prevCell.x + 0.5, prevCell.y + 1, prevCell.z + 0.5)
                if (isBodyFree(this.world.blockAt(prevCell.offset(0, 1, 0))) && isBodyFree(this.world.blockAt(prevCell.offset(0, 2, 0)))) {
                  if (!(await this.hop(prevTop).catch(() => false))) {
                    if (typeof this.scaffold?._stepOntoTop === "function") {
                      await this.scaffold._stepOntoTop(prevTop, 1600).catch(() => false)
                    }
                  }
                }
              }
              const rec = await this.placeTempBlock(stepCell, { allowScaffold: false })
              if (rec) {
                rec.isAccessStep = true
                rec.isCatwalk = true
                this.scaffold.created.set(key(stepCell), rec)
              }
              placedCatwalk.push(stepCell)
              if (this.bot?.entity?.position && this.bot.entity.position.distanceTo(nextTarget) > 3.2 &&
                  !stepCell.offset(0, 1, 0).equals(task.world) &&
                  isBodyFree(this.world.blockAt(stepCell.offset(0, 1, 0))) &&
                  isBodyFree(this.world.blockAt(stepCell.offset(0, 2, 0)))) {
                const stepTop = new Vec3(stepCell.x + 0.5, stepCell.y + 1, stepCell.z + 0.5)
                if (!(await this.hop(stepTop).catch(() => false))) {
                  if (typeof this.scaffold?._stepOntoTop === "function") {
                    await this.scaffold._stepOntoTop(stepTop, 1600).catch(() => false)
                  }
                }
              }
            }
            this.logger.info(`SUPPORT: built ${placedCatwalk.length}-block catwalk bridge ${placedCatwalk.map(key).join(" -> ")} for ${task.name}@${key(task.world)}`)
            return await finishSupport([...placedCatwalk].reverse())
          } catch (cwErr) {
            cwOk = false
            lastReason = cwErr.message
          }
          if (cwOk) return await finishSupport([...placedCatwalk].reverse())
        }
      }
      // Vertical floor-stem support: if R is 1..5 blocks above a solid floor and all stem cells are reachable from the floor without towering, build the stem from the floor!
      if (simR === 'walkable' || simR === 'direct') {
        let floorY = null
        for (let dy = 1; dy <= 5; dy++) {
          const c = new Vec3(R.x, R.y - dy, R.z)
          if (c.equals(task.world)) break
          const cb = this.world.blockAt(c)
          if (!cb) break
          if (cb.boundingBox === 'block' && !isAirLike(cb)) { floorY = R.y - dy; break }
          if (!(isAirLike(cb) || cb.name === 'water')) break
        }
        if (floorY !== null) {
          const stemFloorStand = new Vec3(R.x + 0.5, floorY + 1, R.z + 0.5)
          if (!this.brain || this.reachVerdict(stemFloorStand) !== 'no') {
            const stemCells = []
            for (let sy = floorY + 1; sy <= R.y; sy++) stemCells.push(new Vec3(R.x, sy, R.z))
            const placedStem = []
            let stemOk = true
            try {
              if (this.bot?.entity?.position && (Math.hypot(this.bot.entity.position.x - (R.x + 0.5), this.bot.entity.position.z - (R.z + 0.5)) > 4.2 || Math.abs(this.bot.entity.position.y - (floorY + 1)) > 2.5)) {
                await this.nav.goTo(stemFloorStand, 2.8, 6_000, { human: true, work: true, rescue: false }).catch(() => {})
              }
              for (const scCell of stemCells) {
                await this.placeTempBlock(scCell, { allowScaffold: false })
                placedStem.push(scCell)
              }
              this.logger.info(`SUPPORT: placed ${placedStem.length}-block floor stem to ${key(R)} for ${task.name}@${key(task.world)}`)
              return await finishSupport([...placedStem].reverse())
            } catch (err) {
              stemOk = false
              lastReason = err.message
              if (placedStem.length && !this.hasActiveSweeper()) {
                await this.sweepTemporary({ maxBlocks: placedStem.length + 1, final: true, only: new Set(placedStem.map(key)), ignoreReserved: true }).catch(() => {})
              }
            }
            if (stemOk) return await finishSupport([...placedStem].reverse())
          }
        }
      }
      // If no horizontal catwalk or floor stem could reach a floating horizontal `R` (`R.y === task.world.y`),
      // and `R_below = task.world.offset(0, -1, 0)` is available in `options`, prefer towering for `R_below` so the bot
      // can click the top face of `R_below` directly from the tower top!
      if (R.y >= task.world.y && primarySpec?.look !== 'up' && !this.hasSolidNeighbor(R, task.world)) {
        const belowCell = task.world.offset(0, -1, 0)
        const belowKey = key(belowCell)
        const belowBlock = this.world.blockAt(belowCell)
        if (options.some(o => key(o) === belowKey) && belowBlock && isAirLike(belowBlock) && !this.planner?.isPendingCell?.(belowCell)) {
          lastReason = `deferring vertical tower on ${key(R)} in favor of underside reference ${belowKey}`
          continue
        }
      }
      const H_TOWER = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1],
        [2, 0], [-2, 0], [0, 2], [0, -2]
      ]
      const towerPlans = []
      const unreachableTowerPlans = []
      for (const [dx, dz] of H_TOWER) {
        const C = new Vec3(R.x + dx, R.y, R.z + dz)
        if (C.equals(task.world)) continue
        const plan = this.scaffold.planColumn(C, task.world, cell => this.isReservedCell(cell))
        if (!plan) { lastReason = `column at ${key(C)} blocked`; continue }
        const floorStand = new Vec3(plan.info.floor.x + 0.5, plan.info.floor.y, plan.info.floor.z + 0.5)
        const rv = this.brain ? this.reachVerdict(floorStand) : 'yes'
        const dist = this.bot.entity ? Math.hypot(floorStand.x - this.bot.entity.position.x, floorStand.z - this.bot.entity.position.z) : 0
        const nonCardinal = (Math.abs(dx) + Math.abs(dz) > 1) ? 12 : 0
        const wrongSideOfHorizR = (R.y === task.world.y && primarySpec?.look !== 'up' && ((C.x - R.x) * (task.world.x - R.x) + (C.z - R.z) * (task.world.z - R.z)) <= 0) ? 40 : 0
        const entry = { dx, dz, C, plan, floorStand, rv, score: plan.info.height * 2 + dist * 0.25 + nonCardinal + wrongSideOfHorizR }
        if (rv === 'no') {
          lastReason = `column base at ${key(plan.info.floor)} unreachable`
          unreachableTowerPlans.push(entry)
          continue
        }
        towerPlans.push(entry)
      }
      if (towerPlans.length === 0 && unreachableTowerPlans.length > 0 && this.brain) {
        unreachableTowerPlans.sort((a, b) => a.score - b.score)
        const bestUnreach = unreachableTowerPlans[0]
        const prep = await this.brain.prepare(bestUnreach.floorStand, { force: true }).catch(() => 'no')
        this._reach?.clear()
        this.brain?.clearCache?.()
        if (prep !== 'no' || this.reachVerdict(bestUnreach.floorStand) !== 'no') {
          towerPlans.push(bestUnreach)
        }
      }
      towerPlans.sort((a, b) => a.score - b.score)
      for (const { dx, dz, plan } of towerPlans.slice(0, 3)) {
        let home = null
        const placedHelpers = []
        let placedOk = false
        try {
          await this.scaffold.tower(plan.info, plan.stand)
          home = this.bot.entity.position.floored()
          const item = this.scaffold.itemName
          if (Math.abs(dx) + Math.abs(dz) > 1) {
            const bridgeCell = Math.abs(dx) > 1 || Math.abs(dz) === 0
              ? new Vec3(R.x + Math.sign(dx), R.y, R.z)
              : new Vec3(R.x, R.y, R.z + Math.sign(dz))
            if (!bridgeCell.equals(task.world) && isAirLike(this.world.blockAt(bridgeCell))) {
              const bPseudo = { kind: 'block', name: item, item, world: bridgeCell, properties: {}, info: { ...describeBlock(item, {}), specs: [FREE] } }
              await this.materials.ensureItem(item, 2)
              const bOutcome = await this.placeWithSpec(bPseudo, FREE, { allowScaffold: false, fixedStand: home })
              if (bOutcome === 'ok') {
                const bRec = bridgeCell.clone(); bRec.createdAt = Date.now()
                this.scaffold.created.set(key(bridgeCell), bRec)
                placedHelpers.push(bridgeCell)
              }
            }
          }
          const pseudo = { kind: 'block', name: item, item, world: R, properties: {}, info: { ...describeBlock(item, {}), specs: [FREE] } }
          await this.materials.ensureItem(item, 1)
          const outcome = await this.placeWithSpec(pseudo, FREE, { allowScaffold: false, fixedStand: home })
          if (outcome !== 'ok') throw new BuildError('REFUSED', 'scaffold reference did not appear')
          const rec = R.clone(); rec.createdAt = Date.now()
          this.scaffold.created.set(key(R), rec)
          placedOk = true
          await this.scaffold.slide(new Vec3(home.x + 0.5, 0, home.z + 0.5)).catch(() => {})
          this.setSneak(false)
          return await finishSupport([R, ...placedHelpers])
        } catch (err) {
          if (err.code === 'INTERRUPTED' || err.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(err.message)) throw err
          lastReason = err.message
        } finally {
          this.setSneak(false)
          if (!placedOk && (!this.hasActiveSweeper() || this.shouldDescendIsolatedPillar())) {
            if (home) await this.scaffold.slide(new Vec3(home.x + 0.5, 0, home.z + 0.5)).catch(() => {})
            await this.scaffold.descend().catch(() => {})
          }
        }
      }
    }
    // Last resort: if a reference cell `R` is occupied by a fragile schematic block (such as `redstone_wire` at -93,-50,0
    // directly under a trapdoor) and no other reference cell could be used, temporarily break the fragile block, place
    // the temporary solid reference block at `R`, and reopen the fragile block task so it is restored right after `R` is swept!
    if (!this.hasRef(task, primarySpec)) for (const { R, rb } of fragileOccupied) {
      if (!this.hasSolidNeighbor(R, task.world)) continue
      try {
        this.logger.info(`SUPPORT: temporarily unsealing fragile ${rb.name}@${key(R)} to place reference block for ${task.name}@${key(task.world)}`)
        await this.digBlock(R, { allowScaffold: false })
        this.planner?.reopenTask?.(key(R), this.planner?.fleet?.index, { forceReset: true })
        await this.placeTempBlock(R, { allowScaffold: false })
        return await finishSupport([R])
      } catch (err) { lastReason = err.message }
    }
    throw new BuildError('NO_ACCESS', `no way to give ${key(task.world)} a reference: ${lastReason}`)
  }

  tntUnsafeReason (task) {
    if (task.name !== 'tnt') return null
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const b = this.world.blockAt(task.world.offset(dx, dy, dz))
      if (!b) continue
      const p = b.getProperties?.() || {}
      if (/^(lava|fire|soul_fire|magma_block)$/.test(b.name) || b.name === 'redstone_block' || p.powered === 'true' || p.powered === true || p.lit === 'true' || p.lit === true) return `${b.name} next to it (${task.world.x + dx},${task.world.y + dy},${task.world.z + dz}) is powered / burning`
    }
    return null
  }

  canSelfPillarAnchorTask (task) {
    if (!task?.verticalAnchorCol || task.kind !== "block" || task.info?.fragile) return false
    if (!task.info?.specs || task.info.specs.length !== 1 || task.info.specs[0].tag !== "free") return false
    const tPos = task.world
    const under = this.world.blockAt(tPos.offset(0, -1, 0))
    if (!under || !isFullTop(under) || isAirLike(under) || SUNKEN_NO_STAND.test(under.name || "") || /^(water|lava)$/.test(under.name || "")) return false
    const h1 = this.world.blockAt(tPos.offset(0, 1, 0))
    const h2 = this.world.blockAt(tPos.offset(0, 2, 0))
    if (!isBodyFree(h1) || !isBodyFree(h2) || /^(water|lava)$/.test(h1?.name || "") || /^(water|lava)$/.test(h2?.name || "")) return false
    const others = this.aim?.others?.() || []
    if (others.some(o => o && Math.abs(o.x - (tPos.x + 0.5)) < 0.85 && Math.abs(o.z - (tPos.z + 0.5)) < 0.85 && o.y >= tPos.y - 0.5 && o.y <= tPos.y + 2.2)) {
      return false
    }
    const botPos = this.bot?.entity?.position
    if (!botPos) return false
    const colStand = new Vec3(tPos.x + 0.5, tPos.y, tPos.z + 0.5)
    if (Math.hypot(botPos.x - colStand.x, botPos.z - colStand.z) < 0.8 && Math.abs(botPos.y - colStand.y) < 0.55) {
      return true
    }
    if (this.brain && this.reachVerdict(colStand) === "no") {
      const dyStep = colStand.y - botPos.y
      const hStep = Math.hypot(colStand.x - botPos.x, colStand.z - botPos.z)
      if (!(hStep <= 1.95 && dyStep >= -0.25 && dyStep <= 1.22)) return false
    }
    return true
  }

  async stepDownFromVerticalColumn (task) {
    const tPos = task.world
    const baseY = Number.isFinite(task.verticalBaseY) ? task.verticalBaseY : (tPos.y - 3)
    const hint = task.verticalPartnerHint
    const bot = this.bot
    const walkDirectStep = async (goalVec, maxMs = 1500) => {
      if (!bot?.entity) return false
      return require('../recovery/fall-guard').withHold(bot, async () => {
        const t0 = Date.now()
        try {
          bot.setControlState('sneak', false)
          while (Date.now() - t0 < maxMs && bot.entity) {
            this.check()
            const p = bot.entity.position
            if (Math.hypot(p.x - goalVec.x, p.z - goalVec.z) < 0.36 && Math.abs(p.y - goalVec.y) < 0.6 && bot.entity.onGround) return true
            await bot.lookAt(new Vec3(goalVec.x, Math.max(p.y, goalVec.y) + 1.0, goalVec.z), true).catch(() => {})
            bot.setControlState('forward', Math.hypot(p.x - goalVec.x, p.z - goalVec.z) >= 0.25)
            await sleep(35)
          }
        } finally {
          bot.setControlState('forward', false)
        }
        await this.ground.waitSafe(800).catch(() => {})
        const pEnd = bot.entity?.position
        return Boolean(pEnd && Math.hypot(pEnd.x - goalVec.x, pEnd.z - goalVec.z) < 0.65 && Math.abs(pEnd.y - goalVec.y) < 0.75)
      })
    }
    // Step 1: Directly walk 1 block horizontally onto the adjacent partner L4 base block (top at baseY + 1, a 3.0m zero-damage drop!)
    if (hint && Math.abs(hint.x - tPos.x) + Math.abs(hint.z - tPos.z) === 1) {
      const stepCell = new Vec3(hint.x, baseY + 1, hint.z)
      if (this.aim.standOk(stepCell, new Map()) && !this.aim.isHazard(stepCell)) {
        const stepGoal = new Vec3(stepCell.x + 0.5, stepCell.y, stepCell.z + 0.5)
        await walkDirectStep(stepGoal, 1600).catch(() => false)
      }
    }
    // Step 2: Move onto the best wide flat non-pending deck stand at baseY beside the cluster (preferring exterior deck stands)
    const cache = new Map()
    const bx = this.planner?.box
    const cx = bx ? (bx.x0 + bx.x1) * 0.5 : tPos.x
    const cz = bx ? (bx.z0 + bx.z1) * 0.5 : tPos.z
    let bestStand = null
    let bestScore = Infinity
    for (const sy of [baseY, baseY - 1]) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          if (dx === 0 && dz === 0) continue
          const d = Math.hypot(dx, dz)
          if (d < 0.9 || d > 3.6) continue
          const S = new Vec3(tPos.x + dx, sy, tPos.z + dz)
          if (!this.aim.standOk(S, cache) || this.aim.isHazard(S)) continue
          if (this.planner?.isPendingCell?.(S) || this.planner?.isPendingCell?.(S.offset(0, 1, 0))) continue
          let dropSides = 0
          for (const [hx, hz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (!isFullTop(this.world.blockAt(S.offset(hx, -1, hz))) && !isFullTop(this.world.blockAt(S.offset(hx, -2, hz)))) dropSides++
          }
          if (dropSides >= 2) continue
          const curP = bot?.entity?.position || tPos
          const curDist = Math.hypot(S.x + 0.5 - curP.x, S.z + 0.5 - curP.z)
          const extBonus = Math.min(3.5, Math.hypot(S.x - cx, S.z - cz) * 0.35)
          const score = curDist * 1.3 + d * 0.8 + Math.abs(sy - baseY) * 2.5 + dropSides * 3 - extBonus
          if (score < bestScore) {
            bestScore = score
            bestStand = new Vec3(S.x + 0.5, sy, S.z + 0.5)
          }
        }
      }
    }
    if (bestStand && bot?.entity) {
      const cur = bot.entity.position
      if (Math.abs(cur.y - bestStand.y) > 0.6 || Math.hypot(cur.x - bestStand.x, cur.z - bestStand.z) > 1.8 || this.planner?.isPendingCell?.(cur.floored())) {
        let reached = false
        if (Math.hypot(cur.x - bestStand.x, cur.z - bestStand.z) <= 1.85 && cur.y - bestStand.y >= -0.2 && cur.y - bestStand.y <= 3.2) {
          reached = await walkDirectStep(bestStand, 1600).catch(() => false)
        }
        if (!reached && !(await this.hop(bestStand).catch(() => false))) {
          await this.nav.goTo(bestStand, 0.45, 5_000, { human: true, work: false, rescue: false }).catch(() => {})
        }
        await this.ground.waitSafe(1500).catch(() => {})
      }
    }
  }

  async executeSelfPillarStep (task) {
    const tPos = task.world
    const colStand = new Vec3(tPos.x + 0.5, tPos.y, tPos.z + 0.5)
    await this.materials.ensureItem(task.item, 1)
    const e0 = this.bot.entity.position
    if (Math.hypot(e0.x - colStand.x, e0.z - colStand.z) > 0.35 || Math.abs(e0.y - colStand.y) > 0.45) {
      this.setPhase("walking to vertical column base")
      this._walked = true
      if (!(await this.hop(colStand).catch(() => false))) {
        try {
          await this.nav.goTo(colStand, 0.28, 6_000, { human: true, work: true, rescue: false })
        } catch (navErr) {
          const curP = this.bot.entity?.position
          if (curP && Math.hypot(colStand.x - curP.x, colStand.z - curP.z) <= 1.95 && colStand.y - curP.y >= -0.25 && colStand.y - curP.y <= 1.22 && typeof this.scaffold?._stepOntoTop === "function") {
            const stepped = await this.scaffold._stepOntoTop(colStand, 1800).catch(() => false)
            if (!stepped) throw navErr
          } else {
            throw navErr
          }
        }
      }
    }
    const st = await this.ground.waitSafe(1500)
    if (st !== "grounded" && st !== "resting") throw new BuildError("NOT_GROUNDED", `bot is ${st} at column ${key(tPos)}`)
    return require("../recovery/fall-guard").withHold(this.bot, async () => {
      await this.scaffold._centerOnColumn(colStand.x, colStand.z, false)
      const under = this.world.blockAt(tPos.offset(0, -1, 0))
      if (!under || !isFullTop(under) || isAirLike(under)) {
        throw new BuildError("REF_GONE", `no solid block under vertical column cell ${key(tPos)}`)
      }
      this.setPhase(`getting ${task.item} into the hand`)
      this.materials?.closeOpenContainer?.()
      await this.materials.ensureUsableItem(task.item, "block")
      await this.scaffold.lookDown()
      const sneakForClick = isInteractive(under.name)
      let ok = null
      for (let jumpTry = 0; jumpTry < 2 && !ok; jumpTry++) {
        this.check()
        if (jumpTry > 0) {
          await this.ground.waitSafe(800).catch(() => {})
          await this.scaffold._centerOnColumn(colStand.x, colStand.z, false)
          await this.scaffold.lookDown()
        }
        if (sneakForClick) this.bot.setControlState("sneak", true)
        await sleep(12)
        const startY = this.bot.entity.position.y
        const needY = jumpTry === 0 ? Math.max(tPos.y + 1.03, startY + 0.95) : Math.max(tPos.y + 1.08, startY + 1.00)
        this.bot.setControlState("jump", true)
        let sent = false
        const deadline = Date.now() + 1400
        try {
          while (Date.now() < deadline) {
            this.check()
            await nextTick(this.bot)
            if (this.bot.entity.position.y >= needY && !sent) {
              this.bot.setControlState("jump", false)
              try {
                await this.interaction.sendPlace(this.world.blockAt(tPos.offset(0, -1, 0)), new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5))
              } catch {}
              this.materials?.closeOpenContainer?.()
              sent = true
              break
            }
          }
        } finally {
          this.bot.setControlState("jump", false)
          if (sneakForClick) this.bot.setControlState("sneak", false)
        }
        if (!sent) continue
        ok = await waitFor(() => taskMatches(this.world.blockAt(tPos), task), { timeoutMs: jumpTry === 0 ? 450 : 900, intervalMs: 15 }).catch(() => null)
      }
      if (!ok) throw new BuildError("REFUSED", `self-pillar placement of ${task.item} at ${key(tPos)} was not accepted`)
      this.materials.noteConsumed?.(task.item, 1)
      this._reach?.clear(); this.brain?.clearCache?.()
      this.stats.placed++
      this.learner.success(task, "free")
      if (this.bot.entity) {
        this.buildMemory?.recordSuccess?.(task, this.bot.entity.position.floored(), "free")
      }
      await this.ground.waitSafe(2000).catch(() => {})
      if (task.info?.waterlogged && /(_leaves$|mangrove_roots)/.test(task.name || "")) {
        const wlTask = this.planner?.tasks?.get(`${task.key}#w`)
        if (wlTask && wlTask.status !== "completed") {
          try {
            await this.executeWaterlog(wlTask)
            if (this.planner?.isCorrect?.(wlTask)) this.planner.markCompleted(wlTask)
          } catch {}
        }
      }
      await this.postActions(task)
      if (task.verticalColTop) {
        await this.stepDownFromVerticalColumn(task).catch(() => {})
      }
      return "placed"
    })
  }

  async executeBlock (task) {
    const unsafe = this.tntUnsafeReason(task)
    if (unsafe) throw new BuildError('UNSAFE', `not placing TNT at ${key(task.world)}: ${unsafe}`)
    await this.clearCell(task)
    if (task.verticalAnchorCol && this.canSelfPillarAnchorTask(task)) {
      try {
        return await this.executeSelfPillarStep(task)
      } catch (pillarErr) {
        if (pillarErr.code === "INTERRUPTED" || pillarErr.code === "TASK_TIMEOUT" || /abort|interrupt|abandoned/i.test(pillarErr.message || "")) {
          throw pillarErr
        }
        this.logger.debug?.(`VERTICAL-COLUMN: self-pillar fallback on ${task.name}@${key(task.world)}: ${pillarErr.message}`)
      }
    }
    const rawSpecs = this.activeSpecs(task)
    // Prefer specs that ALREADY have a solid reference in the world so we never waste time building temporary support
    // for `trapdoor-flat` (blocked by `redstone_wire`) when `trapdoor-side` or another face is available!
    const withRef = rawSpecs.filter(s => this.hasRef(task, s))
    const withoutRef = rawSpecs.filter(s => !this.hasRef(task, s))
    const specs = withRef.length ? [...withRef, ...withoutRef] : rawSpecs
    const rawPref = task.lockedSpecTag || (this.learner.preferredFor ? this.learner.preferredFor(task) : this.learner.preferred[task.name])
    const validPref = rawPref && specs.some(s => s.tag === rawPref) ? rawPref : null
    await this.materials.ensureItem(task.item, 1)
    let lastError = null
    let wrongSeen = false
    const retried = new Set()
    const primaryTag = validPref || specs[0].tag
    for (let si = 0; si < specs.length; si++) {
      const spec = specs[si]
      this.check()
      // Only skip rule hypotheses (`spec.hyp === true`) when `wrongSeen` is false!
      // Physical mounting alternatives (such as `trapdoor-flat` and `trapdoor-side`) must ALWAYS be tried if the first face had NO_ACCESS.
      if (!wrongSeen && spec.hyp && spec.tag !== primaryTag) continue
      let placedWrong = false
      let supportCells = null
      try {
        if (!this.hasRef(task, spec)) {
          supportCells = await this.provideSupport(task, spec)
        } else if (spec.look === 'up') {
          this._reach = this._reach || new Map()
          const candsNow = this.aim.candidates(task.world, spec, { allowScaffold: false })
          const hasWalkable = candsNow.some(c => (!this.brain || this.reachVerdict(c.stand) !== 'no') && c.cell.y <= task.world.y - 1)
          if (!hasWalkable) {
            supportCells = await this.provideSupport(task, spec).catch(() => null)
          }
        }
        let outcome
        try {
          outcome = await this.placeWithSpec(task, spec)
        } catch (firstErr) {
          if (firstErr.code === 'NO_ACCESS' && !supportCells && (!this.hasRef(task, spec) || spec.look === 'up' || task.attempts >= 1 || task.forceSupport)) {
            supportCells = await this.provideSupport(task, spec).catch(() => null)
            if (supportCells) {
              outcome = await this.placeWithSpec(task, spec)
            } else if (task.attempts >= 1 && await this.unsealRoofAbove(task)) {
              outcome = await this.placeWithSpec(task, spec)
            } else throw firstErr
          } else throw firstErr
        }
        if (outcome === 'ok' && spec.partnerDir && spec.whenPartner === 'present' && (task.properties?.type === 'left' || task.properties?.type === 'right')) {
          const gotNow = this.world.blockAt(task.world)
          const gotType = String(gotNow?.getProperties?.()?.type || '')
          const hasNextPartnerSpec = specs.slice(si + 1).some(ns => ns.whenPartner === 'present' && this.aim.candidates(task.world, ns, { allowScaffold: false }).length > 0)
          if (gotType === 'single' && hasNextPartnerSpec) {
            outcome = 'wrong'
          }
        }
        if (outcome === 'ok') {
          this.learner.success(task, spec.tag)
          // If this is a non-column waterlogged leaf block (which never spills), immediately waterlog it in-place while standing beside it!
          if ((!task.verticalColumn || task.interleavedClimb) && task.info?.waterlogged && /(_leaves$|mangrove_roots)/.test(task.name || '')) {
            const wlTask = this.planner?.tasks?.get(`${task.key}#w`)
            if (wlTask && wlTask.status !== 'completed') {
              try {
                await this.executeWaterlog(wlTask)
                if (this.planner?.isCorrect?.(wlTask)) this.planner.markCompleted(wlTask)
              } catch {}
            }
          }
          const allSupports = [...(supportCells || [])]
          if (allSupports.length) {
            this.buildMemory?.recordSupport?.(task, allSupports)
            const hasSweeper = Boolean(this.planner?.fleet?.coord?.hasActiveSweeper?.())
            for (const sc of allSupports) {
              const sk = key(sc)
              const rec = this.scaffold?.created?.get(sk)
              if (rec && !this.planner?.fluidCells?.has?.(sk) && sc.y <= task.world.y) {
                rec.isAccessStep = true
                rec.isCatwalk = true
                this.scaffold.created.set(sk, rec)
              }
            }
            // Only sweep a support block immediately if it sits inside a schematic fluid cell (or is an non-catwalk overhead cap when no Sweeper is active and no nearby look-up block needs it)!
            const supportsToSweep = allSupports.filter(sc => {
              const sk = key(sc)
              if (this.planner?.fluidCells?.has?.(sk)) return true
              if (sc.y <= task.world.y) return false
              if (hasSweeper || task.info?.fragile) return false
              if (this.planner?.isPendingCell?.(sc)) return false
              for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
                const nt = this.planner?.tasks?.get(`${task.world.x + dx},${task.world.y},${task.world.z + dz}`)
                if (nt && nt.status !== "completed" && nt.info?.specs?.[0]?.look === "up") return false
              }
              return true
            })
            if (supportsToSweep.length) {
              const onlySet = new Set(supportsToSweep.map(key))
              await this.sweepTemporary({ maxBlocks: supportsToSweep.length, final: true, only: onlySet, ignoreReserved: true }).catch(() => {})
            }
          }
          if (this.bot.entity) {
            this.buildMemory?.recordSuccess?.(task, this.bot.entity.position.floored(), spec.tag)
          }
          await this.postActions(task)
          if (task.isolatedColumnTop) {
            if (this.scaffold?.onScaffold?.()) {
              await this.scaffold.descend().catch(() => {})
            }
            if (this.bot.entity && Math.floor(this.bot.entity.position.y) >= task.world.y) {
              await this.exit?.escape?.({ why: "descending from finished isolated column", force: true, maxMs: 25_000 }).catch(() => {})
            }
          } else if (this.scaffold?.onScaffold?.() && (!this.hasActiveSweeper() || this.shouldDescendIsolatedPillar()) && !this.hasInPlaceReadyTask(task.order)) {
            await this.scaffold.descend().catch(() => {})
          }
          return 'placed'
        }
        placedWrong = outcome === 'wrong'
      } catch (error) {
        if (supportCells && supportCells.length) {
          for (const sc of supportCells) {
            const sk = key(sc)
            const rec = this.scaffold?.created?.get(sk)
            if (rec && !this.planner?.fluidCells?.has?.(sk)) {
              rec.isAccessStep = true
              rec.isCatwalk = true
              this.scaffold.created.set(sk, rec)
            }
          }
        }
        if (this.scaffold?.onScaffold?.() && (!this.planner?.fleet?.coord?.hasActiveSweeper?.() || this.shouldDescendIsolatedPillar())) {
          await this.scaffold.descend().catch(() => {})
        }
        if (error.code === 'INTERRUPTED' || error.code === 'TASK_TIMEOUT' || error.code === 'PROTECTED' || /abort|interrupt|abandoned/i.test(error.message)) throw error
        if (!(withRef.length > 0 && withoutRef.includes(spec) && lastError && /reference cell .* is (occupied|pending)/i.test(error.message || ''))) {
          lastError = error
        }
        this.logger.debug?.(`${task.name}@${key(task.world)} spec=${spec.tag}: ${error.message}`)
      } finally {
        this.setSneak(false)
      }
      if (placedWrong) {
        try {
          const got = this.world.blockAt(task.world)
          this.logger.warn(`WRONG STATE ${task.name} at ${key(task.world)} (rule ${spec.tag}, yaw ${(this.bot.entity.yaw * 180 / Math.PI).toFixed(0)}): wanted ${JSON.stringify(task.properties)}, got ${got?.name} ${JSON.stringify(got?.getProperties?.() || {})}`)
        } catch {}
        if ((spec.look || spec.horiz || spec.yaw16 != null) && !retried.has(spec.tag)) {
          retried.add(spec.tag)
          this.logger.info(`${task.name}@${key(task.world)}: wrong state once with rule ${spec.tag}; trying the same rule again before doubting it`)
          await this.clearCell(task)
          si--
          continue
        }
        wrongSeen = true
        this.learner.failure(task, spec.tag)
        this.stats.wrongState++
        await this.clearCell(task)
      }
    }
    if (lastError) throw lastError
    throw new BuildError('WRONG_STATE', `${task.name} at ${key(task.world)} never reached the wanted state`)
  }

  async clearBody (target) {
    const overlap = e => {
      const p = e?.position
      return p && Math.abs(p.x - (target.x + 0.5)) < 0.8 && Math.abs(p.z - (target.z + 0.5)) < 0.8 && p.y < target.y + 1 && p.y + 1.8 > target.y
    }
    const me = this.bot.entity
    for (let i = 0; i < 12; i++) {
      this.check()
      const others = Object.values(this.bot.entities || {}).filter(e => e !== me && e.type === 'player' && overlap(e))
      const fleetOthers = (this.aim?.others?.() || []).filter(pos => overlap({ position: pos }))
      const self = overlap(me)
      if (!self && !others.length && !fleetOthers.length) return
      if (self) {
        const fy = Math.floor(me.position.y + 0.01)
        const feet = me.position.floored()
        const baseYaw = Math.atan2(-(me.position.x - (target.x + 0.5)), -(me.position.z - (target.z + 0.5)))
        let bestBack = null
        let fallbackYaw = null
        for (let k = 0; k < 8; k++) {
          const candYaw = baseYaw + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 4)
          const ux = -Math.sin(candYaw); const uz = -Math.cos(candYaw)
          let step1Ok = true
          for (const d of [0.55, 0.95]) {
            const cx = Math.floor(me.position.x + ux * d); const cz = Math.floor(me.position.z + uz * d)
            const bodyOk = isBodyFree(this.world.blockAt(new Vec3(cx, fy, cz))) && isBodyFree(this.world.blockAt(new Vec3(cx, fy + 1, cz)))
            const floorOk = isFullTop(this.world.blockAt(new Vec3(cx, fy - 1, cz))) || iceStandOk(this.world, new Vec3(cx, fy, cz)) || isFullTop(this.world.blockAt(new Vec3(cx, fy - 2, cz)))
            if (!bodyOk || !floorOk) { step1Ok = false; break }
          }
          if (!step1Ok) continue
          if (fallbackYaw === null) fallbackYaw = candYaw
          for (const distTarget of [3.3, 2.7, 2.1]) {
            let corridorOk = true
            for (let d = 1.0; d <= distTarget; d += 0.5) {
              const cx = Math.floor(me.position.x + ux * d); const cz = Math.floor(me.position.z + uz * d)
              const bodyOk = isBodyFree(this.world.blockAt(new Vec3(cx, fy, cz))) && isBodyFree(this.world.blockAt(new Vec3(cx, fy + 1, cz)))
              const floorOk = isFullTop(this.world.blockAt(new Vec3(cx, fy - 1, cz))) || iceStandOk(this.world, new Vec3(cx, fy, cz))
              if (!bodyOk || !floorOk) { corridorOk = false; break }
            }
            if (corridorOk) {
              const destCell = new Vec3(Math.floor(me.position.x + ux * distTarget), fy, Math.floor(me.position.z + uz * distTarget))
              const isPend = this.planner?.isPendingCell?.(destCell)
              if (!isPend || !bestBack) {
                bestBack = new Vec3(destCell.x + 0.5, fy, destCell.z + 0.5)
                if (!isPend) break
              }
            }
          }
          if (bestBack && !this.planner?.isPendingCell?.(bestBack.floored())) break
        }
        if (bestBack) {
          const hopped = await this.hop(bestBack).catch(() => false)
          if (hopped && !overlap(this.bot.entity)) return
        }
        if (target.x === feet.x && target.z === feet.z && target.y === fy && isBodyFree(this.world.blockAt(feet.offset(0, 2, 0))) && fallbackYaw === null) {
          this.bot.setControlState('jump', true)
          const t0 = Date.now()
          while (Date.now() - t0 < 650 && this.bot.entity.position.y < target.y + 1.04) {
            this.check()
            await nextTick(this.bot)
          }
          this.bot.setControlState('jump', false)
          if (!overlap(this.bot.entity)) return
        }
        if (fallbackYaw === null) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const b0 = this.world.blockAt(new Vec3(feet.x + dx, fy, feet.z + dz))
            const b1 = this.world.blockAt(new Vec3(feet.x + dx, fy + 1, feet.z + dz))
            const b2 = this.world.blockAt(new Vec3(feet.x + dx, fy + 2, feet.z + dz))
            if (isFullTop(b0) && isBodyFree(b1) && isBodyFree(b2) && typeof this.scaffold?._stepOntoTop === 'function') {
              const steppedOut = await this.scaffold._stepOntoTop(new Vec3(feet.x + dx + 0.5, fy + 1, feet.z + dz + 0.5), 1600).catch(() => false)
              if (steppedOut && !overlap(this.bot.entity)) return
            }
          }
          if (isBodyFree(this.world.blockAt(feet.offset(0, 2, 0)))) {
            this.bot.setControlState('jump', true)
            await sleep(220)
            this.bot.setControlState('jump', false)
            if (!overlap(this.bot.entity)) return
          }
          throw new BuildError('NO_ACCESS', `standing inside target cell ${key(target)} with holes around`)
        }
        try {
          await this.bot.look(fallbackYaw, 0, true)
          this.bot.setControlState('sneak', true)
          this.bot.setControlState('forward', true)
          for (let step = 0; step < 18 && overlap(this.bot.entity); step++) {
            this.check()
            await nextTick(this.bot)
          }
        } finally {
          this.bot.setControlState('forward', false)
          if (!this._chestSneak) this.bot.setControlState('sneak', false)
        }
        await sleep(20)
        if (!overlap(this.bot.entity)) return
        if (overlap(this.bot.entity) && i >= 2) throw new BuildError('NO_ACCESS', `standing inside the target cell ${key(target)}`)
      } else {
        if (i === 11) throw new BuildError('NO_ACCESS', `another player/bot is standing inside target cell ${key(target)}`)
        await sleep(120)
      }
    }
  }

  async rateGate () {
    const [lo, hi] = this.config.human?.placeIntervalMs || [15, 25]
    const perSec = Number(this.config.building?.maxPlacementsPerSecond || 20)
    const floor = perSec > 0 ? 1000 / perSec : 0
    const gap = Math.max(floor, (lo + Math.random() * (hi - lo)) * (this.flow ? 0.45 : 0.75))
    const wait = (this._lastPlace || 0) + gap - Date.now()
    if (wait > 1) await sleep(wait)
    this._lastPlace = Date.now()
  }

  checkSoil (task) {
    const n = task.name
    const below = this.world.blockAt(task.world.offset(0, -1, 0))
    const bn = below ? below.name : null
    if (!bn || isAirLike(below)) return
    const dirt = /^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt|moss_block|mud|muddy_mangrove_roots|farmland|dirt_path)$/
    const sapling = /(sapling|propagule|_tulip|poppy|dandelion|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|pink_petals|wither_rose|sunflower|lilac|rose_bush|peony|short_grass|^grass$|tall_grass|fern|large_fern)$/
    const crop = /^(wheat|carrots|potatoes|beetroots|melons?_stem|pumpkin_stem|attached_.*_stem|torchflower_crop|pitcher_crop)$/
    if (crop.test(n) && bn !== 'farmland') throw new BuildError('UNSUPPORTED', `${n} needs farmland below, found ${bn}`)
    if (sapling.test(n) && !dirt.test(bn)) throw new BuildError('UNSUPPORTED', `${n} needs soil below, found ${bn}`)
  }

  async placeWithSpec (task, spec, searchOpts = { allowScaffold: true }) {
    const target = task.world
    if (task.kind === 'block') this.checkSoil(task)
    const { cand, pose } = await this.approach(target, spec, { ...searchOpts, hint: task.hint, hintTask: task })
    this.flowStats = this.flowStats || { tasks: 0, walked: 0, flow: 0 }
    this.flowStats.tasks++; if (this._walked) this.flowStats.walked++
    this.flow = !this._walked && Date.now() - (this._lastPlace || 0) < 3500
    if (this.flow) this.flowStats.flow++
    if (this.config.human) this.config.human.flowNow = this.flow
    const ref = this.world.blockAt(pose.ref)
    if (spec.sneak === false && !(ref && isInteractive(ref.name))) {
      this.setSneak(false)
    }
    const sneak = spec.sneak === false
      ? Boolean(ref && isInteractive(ref.name))
      : (Boolean(spec.sneak) || Boolean(cand?.sneak) || Boolean(ref && isInteractive(ref.name)))
    return this.withSneak(sneak, async () => {
      const refreshed = this.aim.fromPose(target, spec, null, {}) || pose
      let aimed = await this.aimAndValidate(target, spec, refreshed, {}, cand)
      this.setPhase(`getting ${task.item} into the hand`)
      await this.materials.ensureUsableItem(task.item, 'block')
      this.setPhase('placing')
      if (!this.bot.heldItem || this.bot.heldItem.name !== task.item) throw new BuildError('NO_ITEM', `could not hold ${task.item}`)
      this.check()
      const refBlock = this.world.blockAt(aimed.pose.ref)
      if (!refBlock || isAirLike(refBlock)) throw new BuildError('REF_GONE', `reference block vanished at ${key(aimed.pose.ref)}`)
      await this.clearBody(target)
      this.setPhase('rate gate')
      await this.rateGate()
      if (this.bot.entity.isInWater || !this.aim.validateView(spec, aimed.pose.faceOpt, aimed.pose.ref, aimed.pose.faceName)) {
        const freshPose = this.aim.fromPose(target, spec, null, {}) || aimed.pose
        aimed = await this.aimAndValidate(target, spec, freshPose, {}, cand)
      }
      const finalRefBlock = this.world.blockAt(aimed.pose.ref) || refBlock
      const mustSneakNow = spec.sneak === false
        ? Boolean(finalRefBlock && isInteractive(finalRefBlock.name))
        : (Boolean(spec.sneak) || Boolean(cand?.sneak) || Boolean(finalRefBlock && isInteractive(finalRefBlock.name)))
      if (mustSneakNow) {
        this._chestSneak = true
        if (!this.bot.getControlState('sneak')) {
          this.bot.setControlState('sneak', true)
          await nextTick(this.bot)
        }
      } else if (spec.sneak === false) {
        this._chestSneak = false
        this.setSneak(false)
      }
      if (spec.look || spec.horiz || spec.yaw16 != null) {
        await nextTick(this.bot)
      }
      this.setPhase('click + server answer')
      let sendError = null
      try {
        await this.interaction.sendPlace(refBlock, aimed.pose.face, aimed.view.cursor)
      } catch (error) { sendError = error }
      this.materials.noteConsumed?.(task.item, 1)

      let settled = await waitFor(() => {
        const b = this.world.blockAt(target)
        return b && (!this.isReplaceable(b) || b.name === task.name) ? b : null
      }, { timeoutMs: 450, intervalMs: 15 }).catch(() => null)
      if (!settled && !sendError && (!this.bot.heldItem || this.bot.heldItem.name === task.item)) {
        try {
          await this.interaction.sendPlace(refBlock, aimed.pose.face, aimed.view.cursor)
          settled = await waitFor(() => {
            const b = this.world.blockAt(target)
            return b && (!this.isReplaceable(b) || b.name === task.name) ? b : null
          }, { timeoutMs: 750, intervalMs: 15 }).catch(() => null)
        } catch {}
      }
      try {
        const eye = this.bot.entity.position.offset(0, this.bot.entity.height * 0.9 || 1.6, 0)
        const c = aimed.view.cursor
        const hit = new Vec3(aimed.pose.ref.x + c.x, aimed.pose.ref.y + c.y, aimed.pose.ref.z + c.z)
        const sneakNow = this.bot.getControlState('sneak') ? 1 : 0
        this.experience?.record(`${spec.tag}|${aimed.pose.faceName}|${sneakNow}`, Boolean(settled), eye.distanceTo(hit))
        this.aim?.setReachPenalty?.(this.experience?.reachPenalty?.() || 0)
      } catch { /* learning is best effort */ }
      if (cand?.edge && cand?.cell) {
        await this.scaffold.slide(new Vec3(cand.cell.x + 0.5, cand.stand.y, cand.cell.z + 0.5), false).catch(() => {})
      }
      if (!settled) {
        this.stats.refused++
        const others = this.aim?.others?.() || []
        const entityObstruction = others.some(o => o && Math.hypot(o.x - (target.x + 0.5), o.z - (target.z + 0.5)) <= 1.5 && Math.abs(o.y - target.y) <= 2.0)
        const err = new BuildError('REFUSED', sendError ? sendError.message : `server did not place ${task.item} at ${key(target)}`)
        err.entityObstruction = entityObstruction
        throw err
      }
      this._reach?.clear(); this.brain?.clearCache?.()
      this.stats.placed++
      if (matches(settled, task.info, { ignore: this.postKeys(task) })) return 'ok'
      if (settled.name === task.name && task.info.soft.length) {
        const props = settled.getProperties?.() || {}
        const hard = Object.entries(task.info.cmp).filter(([k, v]) => !task.info.soft.includes(k) && String(props[k]) !== String(v))
        if (!hard.length) {
          task.softOk = true
          this.logger.debug?.(`${task.name}@${key(target)}: accepted soft mismatch`)
          return 'ok'
        }
      }
      this.logger.debug?.(`WRONG ${task.name} @${key(target)} spec=${spec.tag}: got ${settled.name} ${JSON.stringify(settled.getProperties?.())} wanted ${JSON.stringify(task.info.cmp)}`)
      return 'wrong'
    })
  }

  postKeys (task) {
    const keys = []
    for (const a of task.info.post) {
      if (a.type === 'note') keys.push('note')
      else if (a.type === 'repeater') keys.push('delay')
      else if (a.type === 'comparator') keys.push('mode')
      else if (a.type === 'toggle') keys.push(a.prop)
    }
    return keys
  }

  // buckets ----------------------------------------------------------------------------------
  async executeFluid (task) {
    await this.materials.ensureItem(task.item, 1)
    const lava = task.name === 'lava'
    const planner = this.planner || this.builder?.planner
    if (lava) {
      await this.scoopStrayWater(task.world).catch(() => {})
      // If a stray lava source was previously mis-poured at y+1 (on top of obsidian at task.world), plug & drain y+1 first!
      const aboveCell = task.world.offset(0, 1, 0)
      const aboveBlock = this.world.blockAt(aboveCell)
      if (aboveBlock && aboveBlock.name === 'lava' && !planner?.tasks?.has(key(aboveCell))) {
        try {
          await this.placeTempBlock(aboveCell, { allowScaffold: false })
          await sleep(120)
          await this.sweepTemporary({ maxBlocks: 1, final: true, only: new Set([key(aboveCell)]), ignoreReserved: true, ignoreFluidBeside: true }).catch(() => {})
        } catch {}
      }
    }
    const existing = this.world.blockAt(task.world)
    if (existing && existing.boundingBox === 'block' && existing.name !== task.name) {
      await this.exit?.containStray?.(4).catch(() => {})
      await this.scoopStrayWater(task.world).catch(() => {})
      await this.clearCell(task)
      const afterClear = this.world.blockAt(task.world)
      if (afterClear && afterClear.boundingBox === 'block' && afterClear.name !== task.name) {
        throw new BuildError('WRONG_BLOCK', `could not clear ${afterClear.name} at ${key(task.world)} before pouring ${task.name}`)
      }
    }
    if (planner?.fluidCheck) {
      let fc = planner.fluidCheck(task)
      if (fc.tempObstructions?.length) {
        for (const obs of fc.tempObstructions) {
          const ok = key(obs)
          if (!this.scaffold.created.has(ok)) {
            const v = new Vec3(obs.x, obs.y, obs.z); v.createdAt = Date.now() - 10_000
            this.scaffold.created.set(ok, v)
          }
        }
        const obsSet = new Set(fc.tempObstructions.map(key))
        await this.sweepTemporary({ maxBlocks: fc.tempObstructions.length, final: true, only: obsSet, ignoreReserved: true, ignoreFluidBeside: true }).catch(() => {})
        for (const obs of fc.tempObstructions) {
          const ob = this.world.blockAt(obs)
          if (ob && ob.boundingBox === "block" && !isAirLike(ob)) {
            await this.digBlock(obs, { allowScaffold: false }).catch(() => {})
            this.scaffold.created.delete(key(obs))
          }
        }
        task._fc = null
        fc = planner.fluidCheck(task)
      }
      // Never force-pour fluid when `fc.blocked` is true unless `task.fluidForce` was explicitly set by user!
      const hasBlockedOrTemp = Boolean(fc.blocked || fc.tempObstructions?.length > 0)
      const forced = Boolean(hasBlockedOrTemp && task.fluidForce)
      if (hasBlockedOrTemp && !forced) {
        if (Array.isArray(fc.leaks)) {
          for (const lk of fc.leaks) {
            const lt = planner.tasks?.get(lk)
            if (lt && lt.kind === "block") {
              planner.reopenTask?.(lk, planner.fleet?.index, { forceReset: true })
            }
          }
        }
        throw new BuildError("UNSAFE", `not pouring ${task.name} at ${key(task.world)}: ${fc.why}`)
      }
      this.recorder?.pour(task, fc, { forced })
    }
    let approached
    try {
      approached = await this.approach(task.world, FREE, { allowScaffold: false, minStandDist: lava ? 1.8 : 1.5, bucket: true })
    } catch {
      try {
        approached = await this.approach(task.world, FREE, { allowScaffold: true, minStandDist: lava ? 1.8 : 1.5, bucket: true })
      } catch (accessErr) {
        if (task.attempts >= 1 && await this.unsealRoofAbove(task)) {
          approached = await this.approach(task.world, FREE, { allowScaffold: true, minStandDist: lava ? 1.8 : 1.4, bucket: true })
        } else {
          throw accessErr
        }
      }
    }
    const { pose } = approached
    try {
      // Re-verify right after approaching that `task.world` did not turn into obsidian or get occupied by a solid block!
      const cellBeforeAim = this.world.blockAt(task.world)
      if (cellBeforeAim && cellBeforeAim.boundingBox === 'block' && cellBeforeAim.name !== task.name) {
        await this.scoopStrayWater(task.world).catch(() => {})
        await this.clearCell(task)
        const stillThere = this.world.blockAt(task.world)
        if (stillThere && stillThere.boundingBox === 'block' && stillThere.name !== task.name) {
          throw new BuildError('WRONG_BLOCK', `${stillThere.name} is still occupying ${key(task.world)}; must break it before pouring ${task.name}`)
        }
      }
      const ref = this.world.blockAt(pose.ref)
      let usePose = pose
      if (ref && isInteractive(ref.name)) {
        this.setSneak(true); await sleep(10)
        usePose = this.aim.fromPose(task.world, FREE, null, { bucket: true }) || pose
      }
      let aimed = await this.aimAndValidate(task.world, FREE, usePose)
      if (aimed.pose.ref.equals(task.world)) {
        throw new BuildError('AIM', `cannot use target cell ${key(task.world)} itself as reference for pouring ${task.name}`)
      }
      const refNow = this.world.blockAt(aimed.pose.ref)
      if (refNow && /(_slab|_stairs|_trapdoor|_fence$|_wall$|ladder|chain$|(^|soul_)lantern|_leaves$|_sign|glass_pane|iron_bars|scaffolding)/.test(refNow.name)) throw new BuildError('AIM', `would pour ${task.name} onto ${refNow.name} (it would be waterlogged instead of filling ${key(task.world)})`)
      this.logger.info(`FLUID: pouring ${task.name} at ${key(task.world)} from ${key((usePose && (usePose.cell || usePose.stand)) || (pose && (pose.cell || pose.stand)) || this.bot.entity.position.floored())} onto ${ref ? ref.name : '?'} at ${key(pose.ref || { x: 0, y: 0, z: 0 })} face ${pose.faceName || '?'}`)
      await this.materials.ensureUsableItem(task.item, 'utility')
      this.check()
      const cellRightBeforeClick = this.world.blockAt(task.world)
      if (cellRightBeforeClick && cellRightBeforeClick.boundingBox === 'block' && cellRightBeforeClick.name !== task.name) {
        throw new BuildError('WRONG_BLOCK', `${cellRightBeforeClick.name} is occupying ${key(task.world)}; aborting pour so ${task.name} is not placed on top of it`)
      }
      if (this.bot.entity.isInWater || !this.aim.validateView(FREE, aimed.pose.faceOpt, aimed.pose.ref, aimed.pose.faceName)) {
        const freshPose = this.aim.fromPose(task.world, FREE, null, { bucket: true }) || aimed.pose
        aimed = await this.aimAndValidate(task.world, FREE, freshPose)
      }
      this.interaction.useHeldItem()
      let placed = await waitFor(() => taskMatches(this.world.blockAt(task.world), task), { timeoutMs: 450, intervalMs: 15 }).catch(() => null)
      if (!placed && refNow && (!this.bot.heldItem || this.bot.heldItem.name === task.item)) {
        const nowAtTarget = this.world.blockAt(task.world)
        if (!nowAtTarget || nowAtTarget.boundingBox !== 'block') {
          await this.interaction.sendUse(refNow, aimed.pose.face, aimed.view?.cursor || new Vec3(0.5, 0.5, 0.5)).catch(() => {})
          placed = await waitFor(() => taskMatches(this.world.blockAt(task.world), task), { timeoutMs: 1400, intervalMs: 25 }).catch(() => null)
        }
      }
      if (!placed) {
        await this.scoopStrayWater(task.world).catch(() => {})
        throw new BuildError('REFUSED', `${task.name} did not appear at ${key(task.world)}`)
      }
      this.buildMemory?.recordProvenFluid?.(task)
      if (this.bot.entity) this.buildMemory?.recordSuccess?.(task, this.bot.entity.position.floored(), 'fluid')
      await this.materials.noteBucketUsed?.(task.item)
      await this.retreatFrom(task.world, lava ? 5 : 3).catch(() => {})
      return 'placed'
    } finally { this.setSneak(false) }
  }

  async retreatFrom (pos, dist) {
    const e = this.bot.entity.position
    if (Math.hypot(e.x - (pos.x + 0.5), e.z - (pos.z + 0.5)) >= dist) return
    const cache = new Map()
    let best = null
    for (let a = 0; a < 16; a++) {
      const ang = a * Math.PI / 8
      for (const r of [dist, dist + 1, dist + 2]) {
        for (const dy of [0, -1, 1]) {
          const cell = new Vec3(Math.floor(pos.x + 0.5 + Math.cos(ang) * r), Math.floor(e.y) + dy, Math.floor(pos.z + 0.5 + Math.sin(ang) * r))
          if (!this.aim.standOk(cell, cache)) continue
          const d = Math.hypot(cell.x + 0.5 - e.x, cell.z + 0.5 - e.z) + Math.abs(dy)
          if (!best || d < best.d) best = { cell, d }
        }
      }
    }
    if (!best) return
    this.setPhase('stepping away from the fluid')
    await this.nav.goTo(new Vec3(best.cell.x + 0.5, best.cell.y, best.cell.z + 0.5), 0.8, 12_000, { human: true, work: true, rescue: false })
  }

  // Instantly drains any stray water source (`level === 0` not in schematic fluidCells/tasks) within 4 blocks
  // of `pos` or the bot by either scooping it with an empty bucket OR plugging the water source cell with a
  // temporary solid block (which immediately destroys the water source block in Minecraft!) and then breaking it.
  async scoopStrayWater (pos) {
    const centers = []
    if (pos) centers.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) })
    if (this.bot.entity?.position) {
      const bp = this.bot.entity.position.floored()
      if (!centers.some(c => c.x === bp.x && c.y === bp.y && c.z === bp.z)) centers.push(bp)
    }
    const seen = new Set()
    const straySources = []
    for (const ctr of centers) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          for (let dz = -3; dz <= 3; dz++) {
            const c = new Vec3(ctr.x + dx, ctr.y + dy, ctr.z + dz)
            const ck = key(c)
            if (seen.has(ck)) continue
            seen.add(ck)
            const b = this.world.blockAt(c)
            if (!b || b.name !== 'water') continue
            const isSource = Number(b.metadata) === 0 || String(b.getProperties?.()?.level ?? b.metadata ?? '') === '0'
            if (!isSource) continue
            if (this.planner && (this.planner.fluidCells.has(ck) || this.planner.tasks.has(ck))) continue
            straySources.push(c)
          }
        }
      }
    }
    for (const c of straySources) {
      const held = this.bot.heldItem && this.bot.heldItem.name
      if (held === 'bucket' && this.bot.entity && this.bot.entity.position.distanceTo(c) <= 4.3) {
        await this.bot.lookAt(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5), true).catch(() => {})
        this.interaction.useHeldItem()
        await sleep(160)
        const after = this.world.blockAt(c)
        if (!after || after.name !== 'water' || Number(after.metadata) !== 0) {
          this.logger.warn(`FLUID: scooped stray water source at ${key(c)}`)
          continue
        }
      }
      // Plug the stray water source with a temporary solid block to destroy the source block in Minecraft!
      try {
        await this.placeTempBlock(c, { allowScaffold: false })
        this.logger.warn(`FLUID: plugged & drained stray water source at ${key(c)} with temporary block`)
        await sleep(120)
        await this.sweepTemporary({ maxBlocks: 1, final: true, only: new Set([key(c)]), ignoreReserved: true, ignoreFluidBeside: true }).catch(() => {})
      } catch {
        // Fallback: ask ExitManager.containStray to plug it if within reach
        await this.exit?.containStray?.(2).catch(() => {})
      }
    }
  }

  async executeWaterlog (task) {
    const planner = this.planner || this.builder?.planner
    if (planner && !/(_leaves$|mangrove_roots)/.test(task.name) && planner.fluidCheck) {
      let fc = planner.fluidCheck(task)
      if (fc.tempObstructions?.length) {
        for (const obs of fc.tempObstructions) {
          const ok = key(obs)
          if (!this.scaffold.created.has(ok)) {
            const v = new Vec3(obs.x, obs.y, obs.z); v.createdAt = Date.now() - 10_000
            this.scaffold.created.set(ok, v)
          }
        }
        const obsSet = new Set(fc.tempObstructions.map(key))
        await this.sweepTemporary({ maxBlocks: fc.tempObstructions.length, final: true, only: obsSet, ignoreReserved: true, ignoreFluidBeside: true }).catch(() => {})
        task._fc = null
        fc = planner.fluidCheck(task)
      }
      // Never force-waterlog an unsealed block (`fc.blocked === true`) unless `task.fluidForce` is explicitly set!
      const forced = Boolean(fc.blocked && task.fluidForce)
      if (fc.blocked && !forced) {
        if (Array.isArray(fc.leaks)) {
          for (const lk of fc.leaks) {
            const lt = planner.tasks?.get(lk)
            if (lt && lt.kind === "block") {
              planner.reopenTask?.(lk, planner.fleet?.index, { forceReset: true })
            }
          }
        }
        throw new BuildError("UNSAFE", `not waterlogging ${task.name} at ${key(task.world)}: ${fc.why}`)
      }
    }
    await this.materials.ensureItem('water_bucket', 1)
    const targetBlock0 = this.world.blockAt(task.world)
    const wlSpec = (targetBlock0 && isInteractive(targetBlock0.name)) ? { ...FREE, sneak: true } : FREE
    let approached
    try {
      approached = await this.approach(task.world, wlSpec, { mode: 'self', allowScaffold: true })
    } catch (accessErr) {
      if (task.attempts >= 1 && await this.unsealRoofAbove(task)) {
        approached = await this.approach(task.world, wlSpec, { mode: 'self', allowScaffold: true })
      } else {
        throw accessErr
      }
    }
    const { pose } = approached
    try {
      const targetBlock = this.world.blockAt(task.world)
      let usePose = pose
      if (targetBlock && isInteractive(targetBlock.name)) {
        this.setSneak(true); await sleep(10)
        usePose = this.aim.fromPose(task.world, wlSpec, null, { mode: 'self' }) || pose
      }
      let aimed = await this.aimAndValidate(task.world, wlSpec, usePose, { mode: 'self' })
      await this.materials.ensureUsableItem('water_bucket', 'utility')
      this.check()
      if (this.bot.entity.isInWater || !this.aim.validateView(wlSpec, aimed.pose.faceOpt, aimed.pose.ref, aimed.pose.faceName)) {
        const freshPose = this.aim.fromPose(task.world, wlSpec, null, { mode: 'self' }) || aimed.pose
        aimed = await this.aimAndValidate(task.world, wlSpec, freshPose, { mode: 'self' })
      }
      const par = this.world.blockAt(task.world)
      if (!par || (par.name !== task.name && !/(_leaves$|_slab|_stairs|_trapdoor|_fence$|_wall$|ladder|chain$|(^|soul_)lantern|_sign|glass_pane|iron_bars|scaffolding|barrel|campfire|conduit|hopper|sea_pickle|chest|trapped_chest|ender_chest|amethyst|coral|candle|lightning_rod|pointed_dripstone|dripleaf|mangrove_roots|sculk|grate|decorated_pot|_bars$|heavy_core)/.test(par.name)) || par.getProperties?.().waterlogged === 'true' || par.getProperties?.().waterlogged === true) {
        throw new BuildError('REFUSED', `not waterlogging ${key(task.world)}: it holds ${par ? par.name : 'nothing'}`)
      }
      // Send a single targeted `sendUse` packet on `par` first and wait for the server to update `waterlogged=true`.
      // Never fire `useHeldItem()` unconditionally right after `sendUse`, as a second bucket click can pour a stray water source onto an adjacent wall!
      await this.interaction.sendUse(par, aimed.pose.face, aimed.view?.cursor || new Vec3(0.5, 0.5, 0.5)).catch(() => {})
      let ok = await waitFor(() => taskMatches(this.world.blockAt(task.world), task), { timeoutMs: 450, intervalMs: 15 }).catch(() => null)
      if (!ok && (!this.bot.heldItem || this.bot.heldItem.name === 'water_bucket') && this.aim.validateView(FREE, aimed.pose.faceOpt, aimed.pose.ref, aimed.pose.faceName)) {
        this.interaction.useHeldItem()
        ok = await waitFor(() => taskMatches(this.world.blockAt(task.world), task), { timeoutMs: 1100, intervalMs: 25 }).catch(() => null)
      }
      // Always check for and plug any stray water source placed near the bot or target cell
      await this.scoopStrayWater(task.world).catch(() => {})
      if (!ok) {
        const held = this.bot.heldItem ? this.bot.heldItem.name : 'nothing'
        const now = this.world.blockAt(task.world)
        throw new BuildError('REFUSED', `waterlogging failed at ${key(task.world)} (holding ${held}; block is ${now ? now.name : 'unloaded'} ${JSON.stringify(now?.getProperties?.() || {})})`)
      }
      this.buildMemory?.recordProvenFluid?.(task)
      await this.materials.noteBucketUsed?.('water_bucket')
      return 'placed'
    } finally { this.setSneak(false) }
  }

  async postActions (task) {
    let lastErr = null
    for (const action of task.info.post) {
      this.check()
      try {
        if (action.type === 'sign') await this.writeSign(task)
        else await this.clickActions(task, action)
      } catch (error) {
        if (error.code === 'INTERRUPTED' || error.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(error.message)) throw error
        lastErr = error
        this.logger.warn(`post action ${action.type} for ${task.name}@${key(task.world)} failed: ${error.message}`)
      }
    }
    if (lastErr && !taskMatches(this.world.blockAt(task.world), task)) {
      throw new BuildError(lastErr.code || 'NO_ACCESS', `post action for ${task.name}@${key(task.world)} failed: ${lastErr.message}`)
    }
  }

  async clickBlock (task, times, until, propKey = null) {
    this.setSneak(false)
    let pose = this.aim.fromPose(task.world, FREE, null, { mode: 'self' })
    if (!pose) {
      let approached
      try {
        approached = await this.approach(task.world, FREE, { mode: 'self', allowScaffold: true })
      } catch (err) {
        if (await this.unsealRoofAbove(task)) {
          approached = await this.approach(task.world, FREE, { mode: 'self', allowScaffold: true })
        } else {
          throw err
        }
      }
      pose = approached.pose
    }
    this.setSneak(false)
    const aimed = await this.aimAndValidate(task.world, FREE, pose, { mode: 'self' })
    for (let i = 0; i < times; i++) {
      this.check()
      this.setSneak(false)
      const b = this.world.blockAt(task.world)
      if (until && until(b)) return
      const prevVal = propKey ? String(b?.getProperties?.()?.[propKey]) : null
      await sleep(25)
      await this.interaction.sendUse(b, aimed.pose.face, aimed.view.cursor).catch(() => {})
      if (until) {
        let changed = await waitFor(() => {
          const cur = this.world.blockAt(task.world)
          if (until(cur)) return true
          if (propKey && String(cur?.getProperties?.()?.[propKey]) !== prevVal) return true
          return false
        }, { timeoutMs: 350, intervalMs: 12 }).catch(() => null)
        if (!changed && typeof this.bot.activateBlock === 'function') {
          await this.bot.activateBlock(b, aimed.pose.face, aimed.view.cursor).catch(() => {})
          changed = await waitFor(() => {
            const cur = this.world.blockAt(task.world)
            if (until(cur)) return true
            if (propKey && String(cur?.getProperties?.()?.[propKey]) !== prevVal) return true
            return false
          }, { timeoutMs: 400, intervalMs: 15 }).catch(() => null)
        }
        if (changed && until(this.world.blockAt(task.world))) return
      }
    }
    if (until) {
      await waitFor(() => until(this.world.blockAt(task.world)), { timeoutMs: 800, intervalMs: 15 }).catch(() => null)
    }
  }

  async clickActions (task, action) {
    if (action.type === 'note') {
      const targetNote = Number(action.value ?? action.clicks)
      await this.clickBlock(task, 25, b => Number(b?.getProperties?.()?.note) === targetNote, 'note')
    } else if (action.type === 'repeater') {
      const targetDelay = Number(action.value != null ? action.value : (Number(action.clicks) + 1))
      await this.clickBlock(task, 4, b => Number(b?.getProperties?.()?.delay) === targetDelay, 'delay')
    } else if (action.type === 'comparator') {
      await this.clickBlock(task, 2, b => String(b?.getProperties?.()?.mode) === 'subtract', 'mode')
    } else if (action.type === 'toggle') {
      await this.clickBlock(task, 2, b => String(b?.getProperties?.()?.[action.prop]) === String(action.want), action.prop)
    }
  }

  async writeSign (task) {
    const lines = task.tile?.lines || task.tile?.front?.lines || ['', '', '', '']
    if (lines.some(Boolean)) {
      const block = this.world.blockAt(task.world)
      if (block) {
        try { await this.bot.updateSign(block, lines.join('\n')) } catch (error) { this.logger.debug?.(`sign text at ${key(task.world)}: ${error.message}`) }
      }
    }
    const backLines = task.tile?.back?.lines || []
    if (backLines.some(Boolean)) {
      const block = this.world.blockAt(task.world)
      if (block) {
        try { await this.bot.updateSign(block, backLines.join('\n'), true) } catch (error) { this.logger.debug?.(`sign back text at ${key(task.world)}: ${error.message}`) }
      }
    }
  }
}

module.exports = { Placer, BuildError }
