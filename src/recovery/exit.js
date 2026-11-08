'use strict'
// Carries out what the exit planner decided. One loop for every "I am stuck / walled in / in a pit / in water" case:
//   plan -> do one step -> check where we really are -> next step, or ask the planner again.
// Priority 1: Walk / swim / step / pillar / bridge with temporary blocks or low-angle safe ender pearl.
// Priority 2 (Last resort): Open a non-sensitive block and immediately re-open + restore it before leaving.
const { Vec3 } = require('../util/vec3')
const { sleep, withTimeout, waitFor } = require('../util/async')
const { checkAbort } = require('../util/abort')
const { withHold } = require('./fall-guard')
const { planRoute, flood, makeView, digCost, key: ck } = require('./exit-planner')
const { solveThrow, playerBlockers } = require('./survival')
const { feetCellOf } = require('../world/ground')
const { isInteractive } = require('../rules/blocks')

const FACE_FOR = { '1,0': 4, '-1,0': 5, '0,1': 2, '0,-1': 3 }
const TOOL_TYPES = new Set(['dig', 'pillar', 'bridge', 'stair', 'pearl'])
const SUNKEN_TRAP = /^(hopper|chest|trapped_chest|ender_chest|cauldron|composter)$/

class ExitManager {
  constructor (ctx) {
    Object.assign(this, ctx)
    this.lastFail = 0
    this.running = false
    this.stats = { episodes: 0, escaped: 0, steps: 0, replans: 0, dug: 0, restored: 0 }
  }

  cellOf (p) {
    return feetCellOf(this.world, p)
  }

  blockAt (x, y, z) { return this.world.blockAt(new Vec3(x, y, z)) }

  planOpts (episode, extra = {}) {
    const planner = this.getPlanner()
    const sc = this.scaffold
    return {
      allowKept: extra.allowKept !== undefined ? extra.allowKept : (this.config.safety?.exitMayOpenFinishedBlocks !== false),
      taskAt: (x, y, z) => planner?.tasks?.get(`${x},${y},${z}`) || null,
      isTemp: (x, y, z) => {
        const k = `${x},${y},${z}`
        if (sc.created.has(k)) return true
        const b = this.blockAt(x, y, z)
        if (b && b.name === sc.itemName) {
          const t = planner?.tasks?.get(k)
          if (!t || t.name !== sc.itemName) return true
        }
        return false
      },
      forbidDig: (x, y, z) => {
        if (sc.created.has(`${x},${y},${z}`)) return false
        return false
      },
      maxDrop: Number(this.config.navigation?.exitMaxDrop ?? 3),
      penalty: episode.penalty,
      blocked: episode.blocked,
      pearls: episode.pearls,
      ...extra
    }
  }

  inventoryHas (name) { try { return (this.bot.inventory.items().filter(i => i.name === name).reduce((a, i) => a + i.count, 0)) } catch { return 0 } }

  // Raycast & ballistic landing cells for an ender pearl (only safe landings 5.5-16 blocks away, never over water/holes, capped to 18 checks so it runs in <10ms!)
  pearlCandidates (start, trapped, goalCells = null) {
    if (this.config.navigation?.pearls !== true) return []
    if (Number(this.bot.health) < 14) return []
    const view = makeView(this.blockAt.bind(this), {})
    const eye = { x: this.bot.entity.position.x, y: this.bot.entity.position.y + 1.62, z: this.bot.entity.position.z }
    const eyeCls = view.cls(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)).k
    if (eyeCls === 'lava' || eyeCls === 'water') return []
    const ents = playerBlockers(this.bot)
    const ctx = { vel: this.bot.entity.velocity, onGround: this.bot.entity.onGround }
    const cands = []
    for (let dx = -16; dx <= 16; dx++) {
      for (let dz = -16; dz <= 16; dz++) {
        const d = Math.hypot(dx, dz)
        if (d < 6.5 || d > 16) continue
        if (d > 10 && ((dx & 1) !== 0 || (dz & 1) !== 0)) continue
        const x = start.x + dx; const z = start.z + dz
        for (let y = start.y + 6; y >= start.y - 16; y--) {
          if (goalCells && goalCells.size && !goalCells.has(`${x},${y},${z}`)) continue
          const flBlock = view.cls(x, y - 1, z).b
          if (!view.floorOK(x, y - 1, z) || SUNKEN_TRAP.test(flBlock?.name || '')) continue
          if (view.cls(x, y, z).k !== 'air' || view.cls(x, y + 1, z).k !== 'air') continue
          if (trapped && trapped.has(`${x},${y},${z}`)) continue
          // Reject pearl landings over water/pits or adjacent to lava
          if (view.wet(x, y - 1, z) || view.wet(x, y - 2, z)) continue
          let badNeighbor = false
          for (let lx = -2; lx <= 2 && !badNeighbor; lx++) {
            for (let lz = -2; lz <= 2 && !badNeighbor; lz++) {
              for (let ly = -1; ly <= 1; ly++) {
                if (view.cls(x + lx, y + ly, z + lz).k === 'lava') { badNeighbor = true; break }
              }
              if (Math.abs(lx) + Math.abs(lz) === 1 && (view.wet(x + lx, y - 1, z + lz) || view.wet(x + lx, y - 2, z + lz))) {
                badNeighbor = true
                break
              }
            }
          }
          if (badNeighbor) continue
          const skyOpen = view.cls(x, y + 2, z).k === 'air' && view.cls(x, y + 3, z).k === 'air'
          cands.push({ x, y, z, d, skyOpen })
        }
      }
    }
    cands.sort((a, b) => (Number(b.skyOpen) - Number(a.skyOpen)) || (a.d - b.d))
    const out = []
    const limit = Math.min(cands.length, 18)
    const step = Math.max(1, Math.floor(cands.length / limit))
    for (let i = 0; i < cands.length && out.length < 4 && i < step * limit; i += step) {
      const c = cands[i]
      const sol = solveThrow(this.blockAt.bind(this), eye, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, ents, ctx)
      if (sol && sol.ticks <= 45 && Math.abs(sol.pitch) <= 65 * Math.PI / 180) {
        // Price pearl at 24+ so 1-4 block steps/pillars/bridges always win over pearls, while pearls still beat breaking finished build blocks (cost 450+)!
        out.push({ x: c.x, y: c.y, z: c.z, cost: 24 + sol.ticks * 0.1 + (sol.worst || sol.err) * 0.8, aim: sol })
      }
    }
    return out
  }

  async escape ({ goalCells = null, why = 'stuck', maxMs = 10_000, force = false, lava = false } = {}) {
    if (this.running) return { escaped: false, reason: 'busy' }
    if (!this.bot.entity) return { escaped: false, reason: 'no entity' }
    maxMs = Math.min(maxMs || 10_000, 10_000)
    const cur0 = this.cellOf(this.bot.entity.position)
    const curKey0 = ck(cur0.x, cur0.y, cur0.z)
    if (!lava && this.lastFailCell === curKey0 && Date.now() - this.lastFail < 4500) return { escaped: false, reason: 'cooldown' }
    if (!force && Date.now() - this.lastFail < 5000) return { escaped: false, reason: 'cooldown' }
    this.running = true
    this.stats.episodes++
    const t0 = Date.now()
    const episode = { penalty: {}, blocked: new Set(), pearls: [], placed: [], dug: [], used: new Set(), failures: 0 }
    let res
    try {
      res = await withHold(this.bot, () => this._escape(episode, { goalCells, why, maxMs, t0, lava }))
    } finally {
      this.running = false
      await this.tidy(episode, Boolean(res && res.escaped)).catch(() => {})
    }
    return res
  }

  async _escape (episode, { goalCells, why, maxMs, t0, lava }) {
    const bot = this.bot; const log = this.logger
    bot.clearControlStates()
    this.materials?.closeOpenContainer?.()
    let start = this.cellOf(bot.entity.position)
    // If any temporary scaffold block (`stone` etc.) sits directly at `start`, `start.y+1`, or `start.y+2` (pinning the bot's head in water or a shaft), dig it immediately!
    for (const dy of [1, 2, 0]) {
      const tk = ck(start.x, start.y + dy, start.z)
      const tb = this.blockAt(start.x, start.y + dy, start.z)
      if (tb && tb.boundingBox === 'block' && (this.scaffold.created.has(tk) || tb.name === this.scaffold.itemName)) {
        const taskHere = this.getPlanner()?.tasks?.get(tk)
        if (!taskHere || taskHere.name !== tb.name) {
          try {
            await this.bot.lookAt(new Vec3(start.x + 0.5, start.y + dy + 0.5, start.z + 0.5), true).catch(() => {})
            await withTimeout(this.interaction.digAimed(tb, dy > 0 ? 0 : 1), 5000, 'clear overhead scaffold')
            this.scaffold.created.delete(tk)
          } catch {}
        }
      }
    }
    start = this.cellOf(bot.entity.position)
    const view0 = makeView(this.blockAt.bind(this), {})
    if (!bot.entity.onGround && !bot.entity.isInWater && !view0.floorOK(start.x, start.y - 1, start.z)) {
      for (let dy = 1; dy <= 2; dy++) {
        if (view0.floorOK(start.x, start.y - 1 - dy, start.z) && view0.cls(start.x, start.y - dy, start.z).k === 'air') {
          start = { x: start.x, y: start.y - dy, z: start.z }
          break
        }
      }
    }
    const planner = this.getPlanner()
    const fl = flood(this.blockAt.bind(this), start, { budget: 700, maxDrop: Number(this.config.navigation?.exitMaxDrop ?? 3) })
    const startBlock = view0.cls(start.x, start.y, start.z).b
    const inPitCell = Boolean(planner?.isActivePitCell ? planner.isActivePitCell(start.x, start.y, start.z) : planner?.pitCells?.has(ck(start.x, start.y, start.z)))
    const onBottomSlab = inPitCell && Boolean(startBlock && /_slab$/.test(startBlock.name || '') && (startBlock.getProperties?.()?.type || startBlock.properties?.type) === 'bottom')
    const swimming = Boolean(bot.entity.isInWater) || view0.wet(start.x, start.y, start.z) || view0.wet(start.x, start.y + 1, start.z)
    const onSunken = SUNKEN_TRAP.test(view0.cls(start.x, start.y - 1, start.z).b?.name || '') || SUNKEN_TRAP.test(startBlock?.name || '')
    const onIsolatedColumn = Boolean(planner?.tasks?.get(ck(start.x, start.y - 1, start.z))?.isolatedColumn)
    let mode
    const lavaNear = (x, y, z, r) => {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 2; dy++) {
        const b = this.blockAt(x + dx, y + dy, z + dz)
        if (b && b.name === 'lava') {
          const lk = `${x + dx},${y + dy},${z + dz}`
          if (r > 1 && Math.abs(dx) + Math.abs(dz) > 1 && planner?.fluidCells?.get(lk) === 'lava') continue
          return true
        }
      }
      return false
    }
    if (lava) { if (!lavaNear(start.x, start.y, start.z, 4)) return { escaped: true, reason: 'no lava near' }; mode = 'lava' }
    else if (goalCells && goalCells.size && !goalCells.has(ck(start.x, start.y, start.z))) mode = 'region'
    else if (!fl.open) mode = 'trapped'
    else if (swimming || onSunken || onBottomSlab || inPitCell || onIsolatedColumn) mode = 'dryland'
    else return { escaped: true, reason: 'not trapped' }
    const trapped = fl.cells
    let maxGoalY = -Infinity; let goalSample = null
    if (goalCells && goalCells.size) {
      for (const gk of goalCells) {
        const keyStr = Array.isArray(gk) ? gk[0] : String(gk)
        const parts = keyStr.split(',')
        const gy = Number(parts[1])
        if (gy > maxGoalY) { maxGoalY = gy; goalSample = { x: Number(parts[0]), y: gy, z: Number(parts[2]) } }
      }
    }
    // Only request ender pearls if a non-pearl route cannot be found or when executing a pearl step!
    const scName = this.scaffold?.itemName || 'cobblestone'
    if (this.inventoryHas(scName) < 4) {
      await this.materials?.ensureItem?.(scName, 16).catch(() => {})
    }
    log.warn(`EXIT: ${why}: at ${start.x},${start.y},${start.z} mode=${mode} (can move in ${fl.cells.size}${fl.open ? '+' : ''} cells without tools; blocks ${this.inventoryHas(scName) + this.inventoryHas('cobblestone') + this.inventoryHas('dirt')}, pearls ${this.inventoryHas('ender_pearl')})`)
    this.incident?.('exit-start', { message: `${why} at ${start.x},${start.y},${start.z} mode=${mode}` })
    const visitedStarts = new Set()
    const isBasinOrPit = (gx, gy, gz) => {
      if (planner?.isActivePitCell ? planner.isActivePitCell(gx, gy, gz) : planner?.pitCells?.has(ck(gx, gy, gz))) return true
      if (mode === 'dryland' && planner?.fluidCells?.has(ck(gx, gy, gz))) return true
      return false
    }
    const goodGoalFloor = (v, x, y, z) => {
      if (isBasinOrPit(x, y + 1, z)) return false
      if (planner?.tasks?.get(ck(x, y, z))?.isolatedColumn) return false
      if (this.scaffold.created.has(ck(x, y, z))) return false
      if (mode === 'dryland') {
        let wetAdj = 0
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (v.wet(x + dx, y + 1, z + dz)) wetAdj++
        }
        if (wetAdj >= 2) return false
      }
      const atFeet = v.cls(x, y + 1, z).b
      if (atFeet && /_slab$/.test(atFeet.name || '') && (atFeet.getProperties?.()?.type || atFeet.properties?.type) === 'bottom') {
        return !isBasinOrPit(x, y + 1, z)
      }
      if (!v.floorOK(x, y, z)) return false
      const fb = v.cls(x, y, z).b
      if (SUNKEN_TRAP.test(fb?.name || '')) return false
      if (/_slab$/.test(fb?.name || '') && (fb.getProperties?.()?.type || fb.properties?.type) === 'bottom') return false
      return true
    }
    const isGoal = (n, v) => {
      if (n.floorPlaced) return false
      const nk = ck(n.x, n.y, n.z)
      if (visitedStarts.has(nk)) return false
      // Never stop mid-ladder (`climb`) as the final exit goal!
      if (v.cls(n.x, n.y, n.z).k === 'climb') return false
      if (mode === 'lava') return goodGoalFloor(v, n.x, n.y - 1, n.z) && !v.wet(n.x, n.y, n.z) && !lavaNear(n.x, n.y, n.z, 5)
      if (mode === 'region') return goalCells.has(nk) || (start.y > maxGoalY + 2 && !trapped.has(nk) && n.y <= maxGoalY + 2 && goodGoalFloor(v, n.x, n.y - 1, n.z) && !v.wet(n.x, n.y, n.z))
      if (mode === 'trapped') return !trapped.has(nk) && goodGoalFloor(v, n.x, n.y - 1, n.z) && !v.wet(n.x, n.y, n.z)
      return goodGoalFloor(v, n.x, n.y - 1, n.z) && !v.wet(n.x, n.y, n.z) && !v.wet(n.x, n.y + 1, n.z)
    }
    let attempts = 0; let lastRegionFail = false; let lastPearlPosKey = null
    while (Date.now() - t0 < maxMs && attempts++ < 14) {
      checkAbort()
      this.materials?.closeOpenContainer?.()
      await new Promise(r => setImmediate(r))
      const waitGroundedT0 = Date.now()
      while (Date.now() - waitGroundedT0 < 550 && bot.entity && !bot.entity.onGround && !bot.entity.isInWater && Math.abs(bot.entity.velocity?.y || 0) > 0.04) {
        await sleep(30)
      }
      start = this.cellOf(bot.entity.position)
      if (mode === 'lava') { if (!lavaNear(start.x, start.y, start.z, 4)) break } else if (mode !== 'region' && this.isOut(start, mode, trapped)) break
      if (mode === 'region' && (goalCells.has(ck(start.x, start.y, start.z)) || (start.y <= maxGoalY + 2 && this.isOut(start, 'trapped', trapped)))) break
      const curPosKey = ck(start.x, start.y, start.z)
      visitedStarts.add(curPosKey)
      if (!episode.pearlsDone || curPosKey !== lastPearlPosKey) {
        episode.pearls = this.pearlCandidates(start, trapped, mode === 'region' ? goalCells : null)
        episode.pearlsDone = true
        lastPearlPosKey = curPosKey
      }
      const heuristic = (mode === 'region' && goalSample)
        ? (n => (start.y > maxGoalY + 2 ? Math.max(0, n.y - maxGoalY) * 1.1 : Math.hypot(n.x - goalSample.x, n.z - goalSample.z) * 0.35 + Math.abs(n.y - goalSample.y) * 0.6))
        : (onIsolatedColumn || (mode === 'trapped' && fl.cells.size <= 8))
            ? (n => Math.max(0, n.y - (start.y - 6)) * 0.9)
            : null
      const dynRadius = (mode === 'region' && goalSample) ? Math.max(16, Math.min(48, Math.max(Math.abs(goalSample.x - start.x), Math.abs(goalSample.z - start.z)) + 6)) : undefined
      let plan = planRoute(this.blockAt.bind(this), start, isGoal, this.planOpts(episode, { ...(heuristic ? { heuristic } : {}), ...(dynRadius ? { radius: dynRadius } : {}), ...(mode === 'region' ? { allowKept: false } : {}) }))
      if ((!plan || !plan.steps) && mode === 'region' && start.y < maxGoalY) {
        const isStepUpGoal = (n, v) => !n.floorPlaced && n.y >= start.y + 1 && !visitedStarts.has(ck(n.x, n.y, n.z)) && v.cls(n.x, n.y, n.z).k !== 'climb' && goodGoalFloor(v, n.x, n.y - 1, n.z) && !v.wet(n.x, n.y, n.z)
        plan = planRoute(this.blockAt.bind(this), start, isStepUpGoal, this.planOpts(episode, { radius: 14, budget: 800, allowKept: false }))
        if (plan && plan.steps) episode.steppedUpFrom = start.y
      }
      if (!plan || !plan.steps) {
        log.warn(`EXIT: no way found from ${start.x},${start.y},${start.z} (${plan ? plan.expansions : 0} cells searched, ${[...episode.blocked].length} moves banned)`)
        if (mode === 'region' && !fl.open) { mode = 'trapped'; lastRegionFail = true; continue }
        if (episode.blocked.size) { episode.blocked.clear(); episode.penalty = {}; episode.pearlsDone = false; continue }
        break
      }
      log.warn(`EXIT: plan ${attempts}: ${plan.methods} -> ${plan.goal.x},${plan.goal.y},${plan.goal.z} (cost ${plan.cost.toFixed(1)}, ${plan.steps.length} steps, ${plan.ms} ms)`)
      let ok = true
      for (let i = 0; i < plan.steps.length && ok; i++) {
        checkAbort()
        const st = plan.steps[i]
        if (st.type === 'pearl' && episode.dug.length) {
          await this.restoreNearbyDug(episode).catch(() => {})
        }
        ok = await this.doStep(st, episode, `${i + 1}/${plan.steps.length}`)
        if (ok) { this.stats.steps++; episode.used.add(st.type) }
        else {
          episode.failures++
          episode.fails = episode.fails || new Map()
          const nf = (episode.fails.get(st.key) || 0) + 1; episode.fails.set(st.key, nf)
          if (nf >= 2) episode.blocked.add(st.key)
          if (TOOL_TYPES.has(st.type)) { episode.blocked.add(st.key); episode.penalty[st.type] = (episode.penalty[st.type] || 1) * 2.2 } else { episode.penalty[st.type] = (episode.penalty[st.type] || 1) * 1.3 }
          this.stats.replans++
        }
      }
    }
    const end = this.cellOf(bot.entity.position)
    const out = mode === 'lava' ? !lavaNear(end.x, end.y, end.z, 4) : mode === 'region' ? (goalCells.has(ck(end.x, end.y, end.z)) || (episode.steppedUpFrom !== undefined && end.y > episode.steppedUpFrom) || (end.y <= maxGoalY + 2 && this.isOut(end, 'trapped', trapped))) : this.isOut(end, lastRegionFail ? 'trapped' : mode, trapped)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (out) { this.lastFailCell = null; this.stats.escaped++; log.warn(`EXIT: out at ${end.x},${end.y},${end.z} after ${secs}s using ${[...episode.used].join(', ') || 'nothing'}`) } else { this.lastFail = Date.now(); this.lastFailCell = ck(end.x, end.y, end.z); log.warn(`EXIT: still stuck at ${end.x},${end.y},${end.z} after ${secs}s (${episode.failures} failed steps)`) }
    return { escaped: out, dug: episode.dug.length, placed: episode.placed.length }
  }

  async restoreNearbyDug (episode) {
    const planner = this.getPlanner()
    const placer = this.getPlacer?.()
    if (!planner || !placer || !this.bot.entity) return
    const pos = this.bot.entity.position
    for (const d of episode.dug) {
      const k = ck(d.x, d.y, d.z)
      planner.reopenTask?.(k, planner.fleet?.index, { forceReset: true })
      const task = planner.tasks?.get(k)
      if (!task || task.status === 'completed' || planner.isCorrect(task)) continue
      const dist = Math.hypot(d.x + 0.5 - pos.x, d.y + 0.5 - (pos.y + 1.62), d.z + 0.5 - pos.z)
      if (dist >= 1.1 && dist <= 4.35 && placer.reachableNow?.(task)) {
        try {
          await placer.executeGuarded(task)
          planner.rescanTask(task)
          this.logger.info(`EXIT: immediately restored broken build block ${task.name}@${k}`)
        } catch { /* remains reopened with priorityBoost in planner */ }
      }
    }
  }

  isOut (cell, mode, trapped) {
    const planner = this.getPlanner()
    if (planner?.isActivePitCell ? planner.isActivePitCell(cell.x, cell.y, cell.z) : planner?.pitCells?.has(ck(cell.x, cell.y, cell.z))) return false
    if (mode === 'dryland' && planner?.fluidCells?.has(ck(cell.x, cell.y, cell.z))) return false
    if (planner?.tasks?.get(ck(cell.x, cell.y - 1, cell.z))?.isolatedColumn) return false
    if (Boolean(this.bot.entity?.isInWater)) return false
    const v = makeView(this.blockAt.bind(this), {})
    if (v.cls(cell.x, cell.y, cell.z).k === 'climb') return false
    const flBlock = v.cls(cell.x, cell.y - 1, cell.z).b
    const hereBlock = v.cls(cell.x, cell.y, cell.z).b
    const onOpenBotSlab = Boolean(hereBlock && /_slab$/.test(hereBlock.name || '') && (hereBlock.getProperties?.()?.type || hereBlock.properties?.type) === 'bottom')
    if (onOpenBotSlab) {
      if (this.scaffold.created.has(ck(cell.x, cell.y, cell.z)) || v.wet(cell.x, cell.y, cell.z)) return false
      if (mode === 'trapped') return !trapped.has(ck(cell.x, cell.y, cell.z))
      return true
    }
    if (flBlock && /_slab$/.test(flBlock.name || '') && (flBlock.getProperties?.()?.type || flBlock.properties?.type) === 'bottom') return false
    if (!v.floorOK(cell.x, cell.y - 1, cell.z) || SUNKEN_TRAP.test(flBlock?.name || '') || v.wet(cell.x, cell.y, cell.z)) return false
    if (this.scaffold.created.has(ck(cell.x, cell.y - 1, cell.z))) return false
    if (mode === 'trapped') return !trapped.has(ck(cell.x, cell.y, cell.z))
    return true
  }

  async doStep (st, episode, label) {
    const bot = this.bot; const log = this.logger
    const from = this.cellOf(bot.entity.position)
    const t0 = Date.now()
    let ok = false; let why = ''
    try {
      switch (st.type) {
        case 'walk': case 'swim': case 'climb': case 'step': case 'drop':
          ok = await this.goCell(st.to, st); break
        case 'dig':
          ok = await this.digAll(st.dig, episode)
          if (ok && st.place) ok = await this.placeAt(st.place, episode)
          if (ok) ok = await this.goCell(st.to, st)
          break
        case 'bridge': case 'stair':
          if (st.place) st.place.isBridge = true
          ok = await this.placeAt(st.place, episode)
          if (ok) ok = await this.goCell(st.to, st)
          break
        case 'pillar':
          if (st.dig) ok = await this.digAll(st.dig, episode); else ok = true
          if (ok) ok = await this.pillar(st, episode)
          break
        case 'pearl': {
          const p = st.pearl
          const res = await this.survival.pearlTo(new Vec3(p.x + 0.5, p.y, p.z + 0.5)).catch(e => { why = e.message; return false })
          ok = Boolean(res)
          if (!ok) why = why || this.survival.lastPearlReason || 'did not land'
          break
        }
        default: why = 'unknown step'
      }
    } catch (error) {
      if (/abort|interrupt/i.test(String(error.message)) || error.code === 'INTERRUPTED') throw error
      why = error.message; ok = false
    }
    const now = this.cellOf(bot.entity.position)
    if (ok && st.type !== 'pearl' && st.type !== 'drop' && (now.x !== st.to.x || now.z !== st.to.z) && Math.hypot(now.x - st.to.x, now.z - st.to.z) > 1) { ok = false; why = `ended at ${now.x},${now.y},${now.z}` }
    log.info(`EXIT: step ${label} ${st.type} ${from.x},${from.y},${from.z} -> ${st.to.x},${st.to.y},${st.to.z}${st.dig ? ` dig ${st.dig.map(d => `${d.name}${d.kept ? '*' : ''}@${d.x},${d.y},${d.z}`).join(' ')}` : ''}: ${ok ? 'ok' : `FAILED (${why || 'did not get there'})`} ${Date.now() - t0}ms`)
    return ok
  }

  async goCell (to, st) {
    const bot = this.bot
    const from0 = this.cellOf(bot.entity.position)
    const up = to.y > from0.y
    // Live ceiling check before attempting a step up: if y+2 above current cell or target cell is solid, fail fast instead of jumping into the ceiling for 4s!
    if (up && st.type === 'step') {
      const ceilHere = this.blockAt(from0.x, from0.y + 2, from0.z)
      const ceilDest = this.blockAt(to.x, from0.y + 2, to.z)
      if ((ceilHere && ceilHere.boundingBox === 'block') || (ceilDest && ceilDest.boundingBox === 'block')) return false
    }
    const underFrom = this.blockAt(from0.x, from0.y - 1, from0.z)
    const underTo = this.blockAt(to.x, to.y - 1, to.z)
    const onHopper = underFrom?.name === 'hopper' || underTo?.name === 'hopper'
    let wall = null
    if (st.type === 'climb') {
      const lb = this.blockAt(to.x, to.y, to.z) || this.blockAt(from0.x, from0.y, from0.z)
      const f = lb && lb.name === 'ladder' ? lb.getProperties?.().facing : null
      const away = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }[f]
      if (away) wall = away
      if (bot.getControlState('sneak')) bot.setControlState('sneak', false)
    }
    // Shift 0.24m toward the ladder wall when climbing so the bot's ±0.30m AABB stays inside the 0.1875m-thick ladder hitbox!
    // When walking/stepping on a hopper, aim 0.16m off-center (at +0.34) so the bot's ±0.30m AABB rides on the 1.0-high hopper rim!
    const tx = to.x + (wall ? (0.5 + wall[0] * 0.24) : (onHopper && to.x === from0.x ? 0.34 : 0.5))
    const tz = to.z + (wall ? (0.5 + wall[1] * 0.24) : (onHopper && to.z === from0.z ? 0.34 : 0.5))
    const limit = st.type === 'drop' ? 2500 : st.type === 'climb' ? 4000 : 2200
    const t0 = Date.now()
    const yTol = (st.type === 'climb' || st.type === 'step') ? 0.38 : 0.65
    try {
      while (Date.now() - t0 < limit) {
        checkAbort()
        const p = bot.entity.position
        const c = this.cellOf(p)
        const near = Math.hypot(p.x - tx, p.z - tz) < 0.35
        if (c.x === to.x && c.z === to.z && Math.abs(p.y - to.y) < yTol && (bot.entity.onGround || st.type === 'swim' || st.type === 'climb') && (near || st.type !== 'climb')) break
        const inWater = this.ground.state() === 'swimming' || Boolean(bot.entity.isInWater) || this.blockAt(c.x, c.y, c.z)?.name === 'water'
        const aimY = to.y + (to.y >= p.y ? 1.2 : 0.4)
        const lx = wall && near ? tx + wall[0] * 0.8 : tx; const lz = wall && near ? tz + wall[1] * 0.8 : tz
        await bot.lookAt(new Vec3(lx, aimY, lz), true).catch(() => {})
        bot.setControlState('forward', !(st.type === 'climb' && near && !wall))
        bot.setControlState('sprint', inWater && !up)
        let jump = false
        if (inWater) jump = to.y >= Math.floor(p.y)
        if (up && (bot.entity.onGround || p.y < to.y - 0.1)) jump = true
        if (st.type === 'climb') jump = up
        bot.setControlState('jump', jump)
        await sleep(45)
      }
    } finally { bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('sprint', false) }
    await sleep(30)
    const p = bot.entity.position
    const fc = this.cellOf(p)
    if (st.type === 'climb' || st.type === 'step') {
      return fc.x === to.x && fc.z === to.z && fc.y === to.y && Math.abs(p.y - to.y) < 0.6
    }
    return fc.x === to.x && fc.z === to.z && Math.abs(fc.y - to.y) <= 1 && Math.abs(p.y - to.y) < 1.15
  }

  async digAll (list, episode) {
    const planner = this.getPlanner()
    for (const d of list) {
      checkAbort()
      const block = this.blockAt(d.x, d.y, d.z)
      if (!block || block.boundingBox !== 'block') continue
      const view = makeView(this.blockAt.bind(this), this.planOpts(episode))
      if (!digCost(view, d.x, d.y, d.z)) { this.logger.warn(`EXIT: not breaking ${block.name} at ${d.x},${d.y},${d.z}: unsafe now`); return false }
      const p = bot_pos(this.bot)
      const eye = p.offset(0, 1.62, 0)
      const targetCenter = new Vec3(d.x + 0.5, d.y + 0.5, d.z + 0.5)
      const dist = eye.distanceTo(targetCenter)
      if (dist > 4.6) { this.logger.warn(`EXIT: dig failed: ${block.name} at ${d.x},${d.y},${d.z} is out of reach (${dist.toFixed(1)}b)`); return false }
      // Line-of-sight check before digging so the bot never tries to break a block through a solid wall!
      if (this.bot.world?.raycast) {
        const dir = targetCenter.minus(eye).scaled(1 / Math.max(0.05, dist))
        const hit = this.bot.world.raycast(eye, dir, dist + 0.4)
        if (hit && hit.position && (hit.position.x !== d.x || hit.position.y !== d.y || hit.position.z !== d.z)) {
          const hitListed = list.some(o => o.x === hit.position.x && o.y === hit.position.y && o.z === hit.position.z)
          if (!hitListed) {
            this.logger.warn(`EXIT: dig blocked by wall ${hit.name}@${hit.position.x},${hit.position.y},${hit.position.z} before ${d.x},${d.y},${d.z}`)
            return false
          }
        }
      }
      const dx = Math.sign(d.x - Math.floor(p.x)); const dz = Math.sign(d.z - Math.floor(p.z))
      const face = d.y > Math.floor(p.y + 1.7) ? 0 : d.y < Math.floor(p.y + 0.01) ? 1 : (FACE_FOR[`${dx},${dz}`] ?? 1)
      await this.bot.lookAt(targetCenter, true).catch(() => {})
      const hasTask = Boolean(planner?.tasks?.has(ck(d.x, d.y, d.z)))
      episode.dug.push({ x: d.x, y: d.y, z: d.z, name: block.name, kept: d.kept || hasTask })
      try { await withTimeout(this.interaction.digAimed(block, face), 9000, 'exit dig') } catch (error) {
        if (hasTask) planner?.reopenTask?.(ck(d.x, d.y, d.z), planner?.fleet?.index, { forceReset: true })
        this.logger.warn(`EXIT: dig failed: ${error.message}`)
        return false
      }
      if (hasTask || d.kept) {
        planner?.reopenTask?.(ck(d.x, d.y, d.z), planner?.fleet?.index, { forceReset: true })
      }
      this.stats.dug++
    }
    return true
  }

  async placeAt (pl, episode) {
    const bot = this.bot
    this.materials?.closeOpenContainer?.()
    const item = this.scaffold.itemName
    try { await this.materials.ensureUsableItem(item, 'block') } catch (error) { this.logger.warn(`EXIT: no blocks to place (${error.message})`); return false }
    const cell = pl.cell
    const now = this.blockAt(cell.x, cell.y, cell.z)
    if (now && now.boundingBox === 'block') return true
    const ref = this.blockAt(pl.ref.x, pl.ref.y, pl.ref.z)
    if (!ref || ref.boundingBox !== 'block') return false
    let p = bot.entity.position
    // Never place a block inside the bot's own body or beyond 4.4m reach
    if (Math.abs(p.x - (cell.x + 0.5)) < 0.8 && Math.abs(p.z - (cell.z + 0.5)) < 0.8 && p.y < cell.y + 1 && p.y + 1.8 > cell.y) return false
    const face = new Vec3(pl.face[0], pl.face[1], pl.face[2])
    const cursor = new Vec3(0.5 + face.x * 0.49, 0.5 + face.y * 0.49, 0.5 + face.z * 0.49)
    const hitPt = new Vec3(pl.ref.x + cursor.x, pl.ref.y + cursor.y, pl.ref.z + cursor.z)
    const isDownStep = cell.y <= Math.floor(p.y) - 2
    const needSneak = isInteractive(ref.name) || isDownStep
    if (isDownStep && this.scaffold?.slide) {
      const fromCell = this.cellOf(p)
      const dx = Math.sign(cell.x - fromCell.x); const dz = Math.sign(cell.z - fromCell.z)
      if (dx !== 0 || dz !== 0) {
        await this.scaffold.slide(new Vec3(fromCell.x + 0.5 + dx * 0.45, fromCell.y, fromCell.z + 0.5 + dz * 0.45)).catch(() => {})
        p = bot.entity.position
      }
    }
    const eye = p.offset(0, needSneak ? 1.27 : 1.62, 0)
    const dist = eye.distanceTo(hitPt)
    if (dist > 4.45) return false
    // Raycast line-of-sight check so the bot NEVER places a block through a solid wall while in a hole!
    if (bot.world?.raycast) {
      const dir = hitPt.minus(eye).scaled(1 / Math.max(0.05, dist))
      const hit = bot.world.raycast(eye, dir, dist + 0.25)
      if (hit && hit.position) {
        const hp = hit.position
        const isRef = hp.x === pl.ref.x && hp.y === pl.ref.y && hp.z === pl.ref.z
        const isCell = hp.x === cell.x && hp.y === cell.y && hp.z === cell.z
        if (!isRef && !isCell && hit.intersect && hit.intersect.distanceTo(eye) < dist - 0.05) {
          this.logger.debug?.(`EXIT: placeAt ${cell.x},${cell.y},${cell.z} blocked by wall ${hit.name}@${hp.x},${hp.y},${hp.z}`)
          return false
        }
      }
    }
    if (needSneak) {
      bot.setControlState('sneak', true)
      await sleep(20)
    }
    try {
      for (let tries = 0; tries < 2; tries++) {
        checkAbort()
        await bot.lookAt(hitPt, true).catch(() => {})
        await sleep(35)
        try { await this.interaction.sendPlace(ref, face, cursor) } catch (error) { this.logger.debug?.(`exit place: ${error.message}`) }
        this.materials?.closeOpenContainer?.()
        const ok = await waitFor(() => { const b = this.blockAt(cell.x, cell.y, cell.z); return b && b.boundingBox === 'block' }, { timeoutMs: 900, intervalMs: 25 }).catch(() => null)
        if (ok) { const v = new Vec3(cell.x, cell.y, cell.z); v.createdAt = Date.now(); if (pl.isBridge) v.isBridge = true; this.scaffold.created.set(ck(cell.x, cell.y, cell.z), v); episode.placed.push({ x: cell.x, y: cell.y, z: cell.z, isBridge: Boolean(pl.isBridge) }); this.materials.noteConsumed?.(item, 1); return true }
      }
    } finally {
      if (needSneak) bot.setControlState('sneak', false)
    }
    return false
  }

  async containStray (maxPlace = 8) {
    if (this.running || this.containing) return 0
    this.containing = true
    const planner = this.getPlanner(); let n = 0
    const episode = { placed: [] }
    try {
      for (let round = 0; round < maxPlace; round++) {
        const e = this.bot.entity; if (!e) break
        const eye = e.position.offset(0, 1.62, 0)
        const cands = []
        for (let dx = -5; dx <= 5; dx++) for (let dy = -4; dy <= 3; dy++) for (let dz = -5; dz <= 5; dz++) {
          const x = Math.floor(e.position.x) + dx; const y = Math.floor(e.position.y) + dy; const z = Math.floor(e.position.z) + dz
          const b = this.blockAt(x, y, z)
          if (!b || (b.name !== 'lava' && b.name !== 'water')) continue
          if (planner && (planner.fluidCells.has(ck(x, y, z)) || planner.tasks.has(ck(x, y, z)))) continue
          const d = Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z)
          if (d > 4.3 || d < 1.2) continue
          const src = Number(b.metadata) === 0
          for (const f of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            const r = this.blockAt(x + f[0], y + f[1], z + f[2])
            if (r && r.boundingBox === 'block') { cands.push({ cell: { x, y, z }, ref: { x: x + f[0], y: y + f[1], z: z + f[2] }, face: [-f[0], -f[1], -f[2]], score: (src ? 0 : 10) + (b.name === 'lava' ? 0 : 5) + d }); break }
          }
        }
        if (!cands.length) break
        cands.sort((a, b) => a.score - b.score)
        const ok = await withHold(this.bot, () => this.placeAt(cands[0], episode)).catch(() => false)
        if (!ok) break
        n++
        this.logger.warn(`FLUID: covered stray fluid at ${ck(cands[0].cell.x, cands[0].cell.y, cands[0].cell.z)}`)
        await sleep(350)
      }
    } finally { this.containing = false }
    return n
  }

  async pillar (st, episode) {
    const c = st.place.cell
    const here = this.cellOf(this.bot.entity.position)
    // Live ceiling check before pillaring
    const ceil = this.blockAt(c.x, c.y + 2, c.z)
    if (ceil && ceil.boundingBox === 'block') return false
    if (here.x !== c.x || here.z !== c.z) { if (!(await this.goCell(c, { type: 'walk' }))) return false }
    const st0 = await this.ground.waitSafe(2500)
    if (st0 !== 'grounded' && st0 !== 'resting' && st0 !== 'swimming') return false
    // If `c` is in flowing water, try plugging the adjacent upstream water cell so `c` drains immediately before pillaring!
    const atC = this.blockAt(c.x, c.y, c.z)
    if (atC && atC.name === 'water') {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = this.blockAt(c.x + dx, c.y, c.z + dz)
        if (nb && nb.name === 'water') {
          for (const f of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            const refB = this.blockAt(c.x + dx + f[0], c.y + f[1], c.z + dz + f[2])
            if (refB && refB.boundingBox === 'block') {
              const plugged = await this.placeAt({ cell: { x: c.x + dx, y: c.y, z: c.z + dz }, ref: { x: c.x + dx + f[0], y: c.y + f[1], z: c.z + dz + f[2] }, face: [-f[0], -f[1], -f[2]], isBridge: true }, episode).catch(() => false)
              if (plugged) { await sleep(280); break }
            }
          }
        }
      }
    }
    const before = this.scaffold.created.size
    await this.scaffold.tower({ floor: new Vec3(c.x, c.y, c.z), height: 1 }, new Vec3(c.x + 0.5, c.y + 1, c.z + 0.5))
    if (this.scaffold.created.size > before) episode.placed.push({ x: c.x, y: c.y, z: c.z })
    return true
  }

  async removeTemp (p) {
    const k = ck(p.x, p.y, p.z)
    if (!this.scaffold.created.has(k)) return true
    if (this.running) return false
    const goal = new Set()
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 2; dy++) {
      if (dx === 0 && dz === 0 && dy >= 0) continue
      const x = p.x + dx; const y = p.y + dy; const z = p.z + dz
      if (Math.hypot(dx, dy - 1, dz) <= 3.8 && !this.scaffold.created.has(ck(x, y - 1, z))) goal.add(ck(x, y, z))
    }
    const r = await this.escape({ goalCells: goal, why: `TIDY: reach temporary ${k}`, force: true, maxMs: 25_000 })
    if (!r.escaped) return false
    const block = this.blockAt(p.x, p.y, p.z)
    if (!block || block.boundingBox !== 'block') { this.scaffold.created.delete(k); return true }
    try {
      await this.bot.lookAt(new Vec3(p.x + 0.5, p.y + 0.5, p.z + 0.5), true)
      await withTimeout(this.interaction.digAimed(block, 1), 6000, 'tidy dig')
      this.scaffold.created.delete(k)
      this.logger.info(`EXIT: removed unreachable temporary ${k}`)
      return true
    } catch { return false }
  }

  async tidy (episode, escaped) {
    const planner = this.getPlanner()
    const placer = this.getPlacer?.()
    if (planner && episode.dug.length) {
      for (const d of episode.dug) {
        const k = ck(d.x, d.y, d.z)
        const reopened = planner.reopenTask ? planner.reopenTask(k, planner.fleet?.index, { forceReset: true }) : 0
        if (reopened) {
          this.stats.restored++
          this.logger.info(`EXIT: queued broken build block at ${k} (${d.name}) for immediate priority rebuild`)
        }
      }
      if (placer && this.bot.entity) {
        await this.restoreNearbyDug(episode).catch(() => {})
      }
    }
    if (!escaped || !episode.placed.length) return
    const p = bot_pos(this.bot)
    const under = ck(Math.floor(p.x), Math.floor(p.y - 0.05), Math.floor(p.z))
    for (const c of episode.placed.reverse()) {
      const k = ck(c.x, c.y, c.z)
      if (k === under) continue
      // Keep horizontal escape bridges (`isBridge`) intact if they cover water or a pit so the bot doesn't re-open the hole right next to itself!
      if (c.isBridge) {
        const taskHere = planner?.tasks?.get(k)
        if (!taskHere) continue
      }
      const b = this.blockAt(c.x, c.y, c.z)
      if (!b || b.name !== this.scaffold.itemName) { this.scaffold.created.delete(k); continue }
      if (Math.hypot(c.x + 0.5 - p.x, c.y + 0.5 - (p.y + 1.62), c.z + 0.5 - p.z) > 4.2) continue
      try {
        await this.bot.lookAt(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5), true)
        await withTimeout(this.interaction.digAimed(b, 1), 5000, 'exit tidy')
        this.scaffold.created.delete(k)
      } catch { break }
    }
  }
}

function bot_pos (bot) { return bot.entity.position }

module.exports = { ExitManager }
