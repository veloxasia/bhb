'use strict'
// Dedicated 5th Bot Janitor / Sweeper Engine.
// When a fleet has a designated sweeper bot (by default the 5th worker `index === count - 1` when `count >= 5`,
// or any worker with `account.role === 'sweeper'` / `config.fleet.sweeperIndex === index`), that bot runs a
// full-time intelligent real-time cleanup loop:
//   - Receives real-time temporary block placements (`temp-add` / `temp-rm`) from all builder bots over Fleet IPC,
//   - Actively scans the live world (`scanWorldForTempBlocks`) around itself and all builder bots for any temporary
//     scaffold/bridge/pillar blocks (`scaffold.itemName`) inside the build bounding box,
//   - Actively breaks temporary catwalk, support, and pillar blocks during the build (`!finalSweep`) as soon as
//     all schematic tasks within 2m of that temporary block are completed (nibbling horizontal catwalks from their
//     outer tip inward and vertical columns top-down so builders are never stranded),
//   - Walks onto adjacent catwalk blocks when needed to reach the tip of a multi-block bridge, uses Ender Pearls
//     (`survival.pearlTo`) for long/upward hops, and falls back to `placer.digBlock` so it breaks blocks with the
//     same speed and reliability as builder bots!

const { Vec3 } = require('../util/vec3')
const { sleep } = require('../util/async')
const { isAirLike, isBodyFree, isFullTop } = require('../world/ground')
const { taskMatches, FACE_INDEX } = require('../rules/blocks')

const FREE = {
  faces: ['up', 'down', 'north', 'south', 'east', 'west'].map(f => ({ f })),
  look: null,
  horiz: null,
  tag: 'free'
}

function isSweeperWorker (fleetOrIndex, countOrConfig, maybeConfig) {
  const fleet = (typeof fleetOrIndex === 'number')
    ? { index: fleetOrIndex, count: Number(countOrConfig) || 1 }
    : fleetOrIndex
  const config = (typeof fleetOrIndex === 'number') ? maybeConfig : countOrConfig
  if (!fleet) return false
  if (config?.account?.role === 'sweeper') return true
  const explicitIdx = config?.fleet?.sweeperIndex
  if (Number.isInteger(explicitIdx) && explicitIdx >= 0 && explicitIdx < fleet.count) {
    return fleet.index === explicitIdx
  }
  if (config?.fleet?.enableSweeperBot === false || config?.building?.enableSweeperBot === false) return false
  return fleet.count >= 5 && fleet.index === fleet.count - 1
}

function builderWorkerIndices (count, config) {
  const all = Array.from({ length: count }, (_, i) => i)
  if (count <= 1) return all
  const explicitIdx = config?.fleet?.sweeperIndex
  if (Number.isInteger(explicitIdx) && explicitIdx >= 0 && explicitIdx < count) {
    const filtered = all.filter(i => i !== explicitIdx)
    return filtered.length ? filtered : all
  }
  if (config?.fleet?.enableSweeperBot !== false && count >= 5) {
    return all.slice(0, count - 1)
  }
  return all
}

class SweeperEngine {
  constructor ({ builder, bot, world, config, logger, fleet, coord, planner, placer, scaffold, survival, nav, exit, look, interaction }) {
    this.builder = builder
    this.bot = bot
    this.world = world
    this.config = config
    this.logger = logger
    this.fleet = fleet || (coord ? { id: bot?.username || 'sweeper', coord } : null)
    this.planner = planner
    this.placer = placer
    this.scaffold = scaffold || { created: new Map(), getCreated () { return [...this.created.values()] }, contains (c) { return this.created.has(`${c.x},${c.y},${c.z}`) } }
    this.survival = survival
    this.nav = nav
    this.exit = exit
    this.look = look
    this.interaction = interaction
    this.unreachable = new Map()
    this.failCounts = new Map()
    this.stats = { swept: 0, pearls: 0, scans: 0 }
    this._lastWorldScanAt = 0
  }

  targetPriority (p, botPos) {
    const k = `${p.x},${p.y},${p.z}`
    const obstructsFluid = this.planner?.fluidCells?.has?.(k) ? -200 : 0
    const t = this.planner?.tasks?.get?.(k)
    const obstructsTask = (t && t.status !== 'completed') ? -150 : 0
    let horizTemp = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (this.scaffold.created.has(`${p.x + dx},${p.y},${p.z + dz}`)) horizTemp++
    }
    const dy = botPos ? Math.abs(p.y - botPos.y) : 0
    const deckPenalty = dy > 3.5 ? 120 + dy * 10 : dy * 6
    const failPenalty = (this.failCounts.get(k) || 0) * 80
    const dist = botPos ? Math.hypot(p.x + 0.5 - botPos.x, p.z + 0.5 - botPos.z) : 0
    return obstructsFluid + obstructsTask - p.y * 4 + horizTemp * 6 + dist + deckPenalty + failPenalty
  }

  async tickOnce (finalSweep = true) {
    this.syncTempBlocks(finalSweep)
    const e = this.bot?.entity?.position || new Vec3(0, 0, 0)
    const safeTargets = this.scaffold.getCreated()
      .filter(p => this.isSafeToBreak(p, finalSweep))
      .sort((a, b) => this.targetPriority(a, e) - this.targetPriority(b, e))
    if (!safeTargets.length) return false
    const target = safeTargets[0]
    const k = `${target.x},${target.y},${target.z}`
    if (!this.placer && this.interaction?.digAimed) {
      const bNow = this.world.blockAt(target)
      if (bNow && !isAirLike(bNow)) {
        await this.look?.lookAtPoint?.(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5))
        await this.interaction.digAimed(bNow, 1)
      }
      this.scaffold.created.delete(k)
      this.fleet?.coord?.removeTempBlock?.(k, this.fleet?.id)
      this.stats.swept++
      return true
    }
    return this.breakTempBlock(target, finalSweep)
  }

  scanWorldForTempBlocks (force = false) {
    const now = Date.now()
    if (!force && now - this._lastWorldScanAt < 1500) return 0
    this._lastWorldScanAt = now
    if (!this.planner?.box || !this.world?.blockAt) return 0
    const tempNames = new Set(
      [this.scaffold?.itemName, ...(this.config?.building?.scaffoldBlockNames || []), 'cobbled_deepslate', 'stone', 'netherrack', 'dirt']
        .filter(n => n && !this.planner.materialDemand?.has(n))
    )
    if (!tempNames.size) return 0
    this.stats.scans++
    const bx = this.planner.box
    const centers = []
    if (this.bot?.entity?.position) centers.push(this.bot.entity.position.floored())
    if (this.fleet?.coord?.workers) {
      for (const w of this.fleet.coord.workers.values()) {
        const wp = this.fleet.coord.position(w)
        if (wp) centers.push(new Vec3(Math.floor(wp.x), Math.floor(wp.y), Math.floor(wp.z)))
      }
    }
    let added = 0
    const seen = new Set()
    for (const c of centers) {
      for (let dx = -14; dx <= 14; dx++) {
        for (let dz = -14; dz <= 14; dz++) {
          const x = c.x + dx; const z = c.z + dz
          if (x < bx.x0 - 2 || x > bx.x1 + 2 || z < bx.z0 - 2 || z > bx.z1 + 2) continue
          for (let dy = -5; dy <= 5; dy++) {
            const y = c.y + dy
            if (y < bx.y0 || y > bx.y1 + 2) continue
            const k = `${x},${y},${z}`
            if (seen.has(k) || this.scaffold.created.has(k)) continue
            seen.add(k)
            const b = this.world.blockAt({ x, y, z })
            if (!b || !tempNames.has(b.name)) continue
            const t = this.planner.tasks?.get(k)
            if (t && (t.status === 'completed' || taskMatches(b, t))) continue
            const v = new Vec3(x, y, z)
            v.createdAt = now - 6000
            v.isCatwalk = true
            this.scaffold.created.set(k, v)
            added++
          }
        }
      }
    }
    return added
  }

  syncTempBlocks (finalSweep = false) {
    const coord = this.fleet?.coord
    if (coord?.tempBlocks) {
      for (const [k, rec] of coord.tempBlocks.entries()) {
        const existing = this.scaffold.created.get(k)
        if (!existing) {
          const v = new Vec3(rec.x, rec.y, rec.z)
          v.createdAt = rec.createdAt || Date.now()
          if (rec.isAccessStep) v.isAccessStep = true
          if (rec.isCatwalk) v.isCatwalk = true
          if (rec.isTempLadder) v.isTempLadder = true
          this.scaffold.created.set(k, v)
        } else {
          if (rec.isAccessStep) existing.isAccessStep = true
          if (rec.isCatwalk) existing.isCatwalk = true
          if (rec.isTempLadder) existing.isTempLadder = true
        }
      }
    }
    this.scanWorldForTempBlocks(finalSweep)
    for (const [k, p] of [...this.scaffold.created.entries()]) {
      const b = this.world.blockAt(p)
      const t = this.planner?.tasks?.get(k)
      if (!b || isAirLike(b) || (t && (t.status === 'completed' || taskMatches(b, t)))) {
        this.scaffold.created.delete(k)
        coord?.removeTempBlock?.(k, this.fleet?.id)
      }
    }
  }

  isSafeToBreak (p, finalSweep = false) {
    const k = `${p.x},${p.y},${p.z}`
    const b = this.world.blockAt(p)
    if (!b || isAirLike(b)) return false
    const t = this.planner?.tasks?.get(k)
    if (t && (t.status === 'completed' || taskMatches(b, t))) return false
    if (this.placer?.fluidBeside?.(p, finalSweep)) return false

    const me = this.bot.entity?.position
    if (me && Math.abs(p.x + 0.5 - me.x) < 0.85 && Math.abs(p.z + 0.5 - me.z) < 0.85 && p.y >= Math.floor(me.y - 0.1) - 1 && p.y <= Math.floor(me.y) + 1) {
      return false
    }

    // Break multi-block temporary pillars top-down within Sweeper's reachable vertical band (so if Sweeper is on the ground at y=-60
    // next to an 8-block pillar y=-60..-53, it immediately breaks y=-56 -> -57 -> -58 -> -59 -> -60 instead of skipping the whole pillar!)
    const aboveIsReachableFromDeck = !me || (p.y + 1) <= Math.floor(me.y + 0.1) + 4
    const hasTempAbove = aboveIsReachableFromDeck && this.scaffold.created.has(`${p.x},${p.y + 1},${p.z}`) && !isAirLike(this.world.blockAt({ x: p.x, y: p.y + 1, z: p.z }))
    if (hasTempAbove) return false

    if (this.fleet?.coord?.workers) {
      for (const w of this.fleet.coord.workers.values()) {
        if (w.id === this.fleet.id) continue
        const wp = this.fleet.coord.position(w)
        if (wp) {
          const hDist = Math.hypot(p.x + 0.5 - wp.x, p.z + 0.5 - wp.z)
          if (hDist < 3.4 && p.y >= Math.floor(wp.y) - 3 && p.y <= Math.floor(wp.y) + 2) return false
          if (hDist < 2.2 && wp.y >= p.y) return false
        }
        if (w.target) {
          const tDist = Math.hypot(p.x - w.target.x, p.z - w.target.z)
          if (tDist <= 3.0 && Math.abs(p.y - w.target.y) <= 2) return false
        }
      }
    }

    if (this.bot?.entities) {
      for (const ent of Object.values(this.bot.entities)) {
        if (!ent || ent === this.bot.entity || ent.type !== 'player' || !ent.position) continue
        const ep = ent.position
        const ehDist = Math.hypot(p.x + 0.5 - ep.x, p.z + 0.5 - ep.z)
        const safeR = (p.isCatwalk || p.isAccessStep) ? 5.2 : 3.4
        if (ehDist < safeR && p.y >= Math.floor(ep.y) - 3 && p.y <= Math.floor(ep.y) + 2) return false
        if (ehDist < 2.2 && ep.y >= p.y) return false
      }
    }
    const isTaskCellHere = Boolean(t && t.status !== 'completed')
    const isFluidCellHere = Boolean(this.planner?.fluidCells?.has?.(k))

    if (!finalSweep) {
      const age = p.createdAt ? (Date.now() - p.createdAt) : 99_999
      const stats = this.planner?.getStats?.()
      const currentLayer = stats?.currentLayer
      const currentOrder = stats?.currentOrder
      const isCurrentLayerTaskHere = Boolean(isTaskCellHere && (currentLayer == null || t.layer <= currentLayer))
      const isActiveFluidObstruction = Boolean(isFluidCellHere && currentOrder >= 88000)
      const minAge = (isCurrentLayerTaskHere || isActiveFluidObstruction) ? 2000 : 3200
      if (age < minAge) return false

      // If `p` is serving as an overhead reference cap above an unfinished `look === "up"` block (such as downward pistons on L23),
      // keep `p` until the `look === "up"` blocks within 1 block below `p` are completed!
      if (!isCurrentLayerTaskHere && !isFluidCellHere && this.planner?.tasks) {
        for (let dx = -1; dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const belowTask = this.planner.tasks.get(`${p.x + dx},${p.y - 1},${p.z + dz}`)
            if (belowTask && belowTask.kind === "block" && belowTask.status !== "completed" && belowTask.status !== "blocked" && belowTask.info?.specs?.[0]?.look === "up") {
              return false
            }
          }
        }
      }

      // Preserve temporary ladders until finalSweep; preserve 1-block staircase steps (`isAccessStep && !isCatwalk`) while < 18s old unless all schematic tasks within 2m are completed!
      if (p.isTempLadder && !isTaskCellHere && !isFluidCellHere) {
        return false
      }
      if (p.isAccessStep && !p.isCatwalk && !isTaskCellHere && !isFluidCellHere && age < 18_000) {
        return false
      }

      if (!isTaskCellHere && !isFluidCellHere) {
        // Count horizontal temporary neighbors at `p.y` so horizontal catwalk bridges are always broken from their outer tip inward (`horizTemp <= 1`)!
        let horizTemp = 0
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nk = `${p.x + dx},${p.y},${p.z + dz}`
          if (this.scaffold.created.has(nk) && !isAirLike(this.world.blockAt({ x: p.x + dx, y: p.y, z: p.z + dz }))) {
            horizTemp++
          }
        }
        if (horizTemp >= 2) return false

        const isTowerCol = (this.scaffold.created.has(`${p.x},${p.y - 1},${p.z}`) || this.scaffold.created.has(`${p.x},${p.y + 1},${p.z}`)) && horizTemp === 0
        // Single support blocks and horizontal catwalks (`!isTowerCol`) are preserved while any schematic block task within 4m is still unfinished,
        // or while `p` is the root/segment of a horizontal catwalk connected to an active unfinished task!
        if (!isTowerCol && this.planner?.tasks) {
          for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
              for (let dy = -1; dy <= 2; dy++) {
                const nt = this.planner.tasks.get(`${p.x + dx},${p.y + dy},${p.z + dz}`)
                if (nt && nt.kind === 'block' && nt.status !== 'completed' && nt.status !== 'blocked') {
                  return false
                }
              }
            }
          }
        }
      }
    }

    const failAt = this.unreachable.get(k)
    if (failAt) {
      const fails = this.failCounts.get(k) || 1
      const cooldown = finalSweep ? Math.min(20_000, 3_000 * fails) : Math.min(90_000, 15_000 * fails)
      if (Date.now() - failAt < cooldown) return false
    }
    return true
  }

  async stepAsideIfCrowded () {
    const me = this.bot.entity?.position
    if (!me || !this.fleet?.coord?.workers) return
    for (const w of this.fleet.coord.workers.values()) {
      if (w.id === this.fleet.id) continue
      const wp = this.fleet.coord.position(w)
      if (wp && Math.hypot(wp.x - me.x, wp.z - me.z) < 2.8 && Math.abs(wp.y - me.y) <= 2.2) {
        await this.placer.retreatFrom(new Vec3(Math.floor(wp.x), Math.floor(wp.y), Math.floor(wp.z)), 4).catch(() => {})
        return
      }
    }
  }

  async breakTempBlock (p, finalSweep = false) {
    const k = `${p.x},${p.y},${p.z}`
    if (!this.isSafeToBreak(p, finalSweep)) return false
    const e = this.bot.entity?.position
    if (!e) return false

    const poseNow = this.placer.aim.fromPose(p, FREE, null, { mode: 'self' })
    if (poseNow && this.placer.standingStill()) {
      try {
        const aimed = await this.placer.aimAndValidate(p, FREE, poseNow, { mode: 'self' })
        const bNow = this.world.blockAt(p)
        if (bNow && !isAirLike(bNow) && this.isSafeToBreak(p, finalSweep)) {
          await this.builder.interaction.digAimed(bNow, FACE_INDEX[aimed.pose.faceName])
        }
        this.scaffold.created.delete(k)
        this.fleet?.coord?.removeTempBlock?.(k, this.fleet?.id)
        this.unreachable.delete(k)
        this.failCounts.delete(k)
        this.stats.swept++
        this.logger.info(`SWEEPER: cleared temporary block at ${k} (direct reach)`)
        return true
      } catch {}
    }

    // Allow standing on permanent blocks first (`nonTempCs`), and fall back to standing on adjacent temporary catwalk blocks (`tempCatwalkCs`)
    // when breaking the outer tip of a multi-block catwalk — never standing on `p` itself!
    const allCs = this.placer.aim.candidates(p, FREE, {
      mode: 'self',
      allowScaffold: false,
      allowEdgeShift: true,
      max: 24,
      stages: [{ r: 5, down: 5, up: 5, aroundTarget: true }]
    }).filter(c => !(c.cell.x === p.x && c.cell.z === p.z && c.cell.y >= p.y && c.cell.y <= p.y + 2) && !this.placer.isDeadStand?.(c.stand) && (finalSweep || e.y - c.stand.y <= 3.2))

    const nonTempCs = allCs.filter(c => !this.scaffold.contains(c.cell) && !this.scaffold.contains({ x: c.cell.x, y: c.cell.y - 1, z: c.cell.z }))
    const rawCs = nonTempCs.length ? [...nonTempCs, ...allCs.filter(c => !nonTempCs.includes(c))] : allCs

    if (!rawCs.length) {
      this.unreachable.set(k, Date.now())
      this.failCounts.set(k, (this.failCounts.get(k) || 0) + 1)
      return false
    }

    const yesNonTemp = nonTempCs.filter(c => !this.placer?.brain || this.placer.reachVerdict(c.stand) === 'yes')
    const yesRaw = rawCs.filter(c => !this.placer?.brain || this.placer.reachVerdict(c.stand) === 'yes')
    const reachableNonTemp = yesNonTemp.length ? yesNonTemp : nonTempCs.filter(c => !this.placer?.brain || this.placer.reachVerdict(c.stand) !== 'no')
    const reachableCs = reachableNonTemp.length
      ? reachableNonTemp
      : (yesRaw.length ? yesRaw : rawCs.filter(c => !this.placer?.brain || this.placer.reachVerdict(c.stand) !== 'no'))
    const cand = reachableCs[0] || rawCs[0]
    const dist = Math.hypot(cand.stand.x - e.x, cand.stand.z - e.z)
    const dy = cand.stand.y - e.y

    let pearled = false
    const allowPearlHere = (dist > 11 || (dy >= 2.0 && dy <= 7.0)) &&
      (finalSweep || (dy >= -1.5 && dy <= 6.0)) &&
      Date.now() - (this._lastPearlAt || 0) > 45_000 &&
      this.survival && Number(this.bot.health) >= 16 && this.config.navigation?.pearls !== false
    if (allowPearlHere) {
      this._lastPearlAt = Date.now()
      const pearlTarget = new Vec3(cand.cell.x + 0.5, cand.cell.y, cand.cell.z + 0.5)
      if (isFullTop(this.world.blockAt(cand.cell.offset(0, -1, 0))) && isBodyFree(this.world.blockAt(cand.cell)) && isBodyFree(this.world.blockAt(cand.cell.offset(0, 1, 0)))) {
        pearled = await this.survival.pearlTo(pearlTarget).catch(() => false)
        if (pearled) {
          this.stats.pearls++
          this.logger.info(`SWEEPER: ender-pearled to ${cand.cell.x},${cand.cell.y},${cand.cell.z} to clear temporary block ${k}`)
        }
      }
    }

    if (!reachableCs.length && !pearled) {
      this.unreachable.set(k, Date.now())
      this.failCounts.set(k, (this.failCounts.get(k) || 0) + 1)
      return false
    }

    // NEVER pass `rescue: Boolean(finalSweep)` on the Sweeper Bot so Sweeper never builds new temporary stone pillars just to reach a temporary block!
    try {
      if (!(await this.placer.hop?.(cand.stand).catch(() => false))) {
        await this.nav.goTo(cand.stand, 0.4, 5000, { human: true, work: true, rescue: false })
      }
      if (!this.isSafeToBreak(p, finalSweep)) {
        this.placer?.setPhase?.('sweeper: watching for temporary blocks')
        return false
      }
      if (cand.edge && !this.placer.aim.fromPose(p, FREE, null, { mode: 'self' })) {
        await this.scaffold?.slide?.(cand.stand, true).catch(() => false)
      }
      let swept = await this.placer.sweepTemporary({ maxBlocks: 3, final: true, only: new Set([k]), ignoreReserved: true })
      if (swept === 0 && this.scaffold.created.has(k) && this.isSafeToBreak(p, finalSweep)) {
        const poseAfter = this.placer.aim.fromPose(p, FREE, null, { mode: 'self' })
        if (poseAfter) {
          const aimed = await this.placer.aimAndValidate(p, FREE, poseAfter, { mode: 'self' })
          const bNow = this.world.blockAt(p)
          if (bNow && !isAirLike(bNow)) {
            await this.builder.interaction.digAimed(bNow, FACE_INDEX[aimed.pose.faceName])
            this.scaffold.created.delete(k)
            swept = 1
          }
        }
      }
      if (swept > 0 || !this.scaffold.created.has(k) || isAirLike(this.world.blockAt(p))) {
        this.scaffold.created.delete(k)
        this.fleet?.coord?.removeTempBlock?.(k, this.fleet?.id)
        this.unreachable.delete(k)
        this.failCounts.delete(k)
        this.stats.swept += Math.max(1, swept)
        this.placer?.setPhase?.('sweeper: watching for temporary blocks')
        this.logger.info(`SWEEPER: cleared temporary block at ${k}`)
        return true
      }
      this.placer.noteDeadStand?.(cand.stand)
      this.unreachable.set(k, Date.now())
      this.failCounts.set(k, (this.failCounts.get(k) || 0) + 1)
    } catch {
      this.placer.noteDeadStand?.(cand.stand)
      this.unreachable.set(k, Date.now())
      this.failCounts.set(k, (this.failCounts.get(k) || 0) + 1)
    } finally {
      this.placer?.setPhase?.('sweeper: watching for temporary blocks')
    }
    return false
  }

  async runLoop () {
    this.logger.info('SWEEPER: dedicated 5th bot janitor/sweeper active (breaking temporary bridges/pillars in real time so builders never stop)')
    while (this.builder.running && !this.builder.stopRequested) {
      this.fleet?.coord?.beat(this.fleet.id)
      if (this.builder.paused) { await sleep(100); continue }
      if (this.bot._client?.ended) { this.builder.stopRequested = true; break }
      if (!this.bot.entity) { await sleep(200); continue }

      await this.survival?.tick().catch(() => {})
      if (this.builder.fallGuard?.fell) await this.builder.fallGuard.recover().catch(() => {})
      await this.builder.escapeIfInTrenchOrPit().catch(() => {})

      this.planner.syncFleet()
      const buildersActive = this.fleet?.coord?.othersActive?.(this.fleet.id) ?? false
      const stats = this.planner.getStats()
      const finalSweep = stats.remaining === 0 && !buildersActive
      this.syncTempBlocks(finalSweep)

      const e = this.bot.entity.position
      const safeTargets = this.scaffold.getCreated()
        .filter(p => this.isSafeToBreak(p, finalSweep))
        .sort((a, b) => this.targetPriority(a, e) - this.targetPriority(b, e))

      if (safeTargets.length > 0) {
        this.fleet?.coord?.setDone(this.fleet.id, false)
        const target = safeTargets[0]
        this.fleet?.coord?.claim(this.fleet.id, { key: `sweep:${target.x},${target.y},${target.z}`, world: target })
        await this.breakTempBlock(target, finalSweep)
        this.fleet?.coord?.release(this.fleet.id)
        await sleep(25)
        continue
      }

      if (finalSweep) {
        await this.placer.cleanupAll().catch(() => {})
        this.fleet?.coord?.setDone(this.fleet.id, true)
        if (await this.builder.fleetFinish()) break
        await sleep(250)
        continue
      }

      if (Date.now() - (this._lastStepAsideAt || 0) > 3500) {
        this._lastStepAsideAt = Date.now()
        await this.stepAsideIfCrowded()
      }
      this.placer.setPhase('sweeper: watching for temporary blocks')
      await sleep(120)
    }
  }
}

module.exports = { SweeperEngine, isSweeperWorker, builderWorkerIndices }
