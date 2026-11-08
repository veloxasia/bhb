// VENDORED + PATCHED copy of mineflayer-pathfinder/lib/human.js (v1.4.0): collision detection, live route validation,
// corner-safe pursuit, fast re-plan around blocks that appeared after the route was made, and anti-wall-jump detection.
const { Vec3 } = require('../util/vec3')
let Movements, goals
try {
  Movements = require('mineflayer-pathfinder/lib/movements')
  goals = require('mineflayer-pathfinder/lib/goals')
} catch {
  Movements = class { constructor () { this.exclusionAreasStep = [] } }
  goals = { Goal: class {} }
}

class PathfinderGate {
  constructor (maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent
    this.active = 0
    this.queue = []
  }

  async acquire () {
    if (this.active < this.maxConcurrent) {
      this.active++
      return
    }
    return new Promise(resolve => {
      this.queue.push(resolve)
    })
  }

  release () {
    if (this.queue.length > 0) {
      const next = this.queue.shift()
      setImmediate(() => next())
    } else {
      this.active = Math.max(0, this.active - 1)
    }
  }
}

const globalPathfinderGate = new PathfinderGate(1)

const DEG = Math.PI / 180
const TICK = 0.05
const SENS = 0.15 * DEG

function rng (seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967996
  }
}

function makePersonality (r, over) {
  const u = (lo, hi) => lo + (hi - lo) * r()
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
  const p = {
    basePitch: Math.min(16, Math.max(-5, 6 + 5 * gauss())) * DEG,
    turnTime: u(0.04, 0.08),
    sprints: true,
    sprintDelay: 0,
    jumpRate: 0,
    lookAhead: u(1.8, 2.6),
    stopRadius: u(0.20, 0.34),
    reaction: 0.005,
    glanceRate: 0,
    strafe: 0,
    deadband: u(3, 7) * DEG
  }
  return { ...p, ...over }
}

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a))
const quantize = (a) => Math.round(a / SENS) * SENS
const yawTo = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z))
const horiz = (v) => Math.hypot(v.x, v.z)

function createHuman (bot, opts = {}) {
  const r = rng(opts.seed ?? (Date.now() ^ (Math.random() * 2 ** 31)))
  const personality = makePersonality(r, opts.personality ?? {})
  const setback = opts.setback === false ? null : { trip: 8, window: 2000, hold: 250, quiet: 100, ...(opts.setback ?? {}) }
  if (!bot.pathfinder) bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)

  let yaw = bot.entity?.yaw ?? 0
  let pitch = bot.entity?.pitch ?? 0
  let targetYaw = null
  let targetPitch = null
  let pitchNoise = 0
  let gesture = null
  let glanceUntil = 0
  let glanceOffset = 0

  let walk = null
  let lastRotationDelta = 0
  let sprintReleaseUntil = 0
  let jumpHeld = 0
  let stuckJumpAt = 0
  let strafeUntil = 0
  let strafeDir = 'left'
  const forcedMoveAt = []
  let lastForcedMoveAt = 0
  let heldUntil = 0
  let trips = 0

  let planning = 0
  const human = { personality, route: [], walkTo, lookAt, stop, prewarmRoute, active: true, get held () { return heldUntil > 0 }, get planning () { return planning > 0 }, get activeWalk () { return walk !== null } }

  function movements () {
    if (opts.movements) return opts.movements
    const m = new Movements(bot)
    m.canDig = false
    m.allow1by1towers = false
    m.allowParkour = true
    m.allowSprinting = true
    m.allowEntityDetection = false
    m.scafoldingBlocks = []
    m.maxDropDown = 3
    return m
  }

  class GoalBlock extends goals.Goal {
    constructor (x, y, z, allowYPlus1 = false) {
      super()
      this.x = x
      this.y = y
      this.z = z
      this.allowYPlus1 = allowYPlus1
    }

    heuristic (node) {
      return Math.hypot(this.x - node.x, this.z - node.z) + Math.abs(this.y - node.y)
    }

    isEnd (node) {
      return node.x === this.x && node.z === this.z && (node.y === this.y || (this.allowYPlus1 && node.y === this.y + 1))
    }
  }

  const badCells = new Map()
  function applyBad () {
    const m = movements()
    m.liquidCost = 250
    m.allowEntityDetection = false
    m.maxDropDown = 3
    if (!m.exclusionAreasStep) return
    if (!m.__badHook) {
      m.__badHook = true
      m.exclusionAreasStep.push(b => {
        if (!b || !b.position) return 0
        const pl = bot.builder?.planner
        if (b.name === 'hopper') {
          return (pl?.isActivePitCell ? pl.isActivePitCell(b.position.x, b.position.y, b.position.z) : true) ? 250 : 18
        }
        if (/^(water|lava|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(b.name || '')) return 250
        const k0 = `${b.position.x},${b.position.y},${b.position.z}`
        const fg = bot.builder?.fallGuard
        const bm = bot.builder?.buildMemory
        const isSolidNonTrap = blk => Boolean(blk && blk.boundingBox === 'block' && !doorLike(blk) && !/^(water|lava|hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(blk.name || ''))
        const bBelow1 = bot.blockAt(new Vec3(b.position.x, b.position.y - 1, b.position.z))
        const bBelow2 = bot.blockAt(new Vec3(b.position.x, b.position.y - 2, b.position.z))
        const bBelow3 = bot.blockAt(new Vec3(b.position.x, b.position.y - 3, b.position.z))
        // A solid non-trap block, or the feet/head/jump-clearance air cells (1..3 blocks) directly above a solid non-trap floor block, is supported and NEVER an open pit!
        const supportedCell = isSolidNonTrap(b) || isSolidNonTrap(bBelow1) ||
          (b.boundingBox !== 'block' && (!bBelow1 || bBelow1.boundingBox !== 'block') && (isSolidNonTrap(bBelow2) || ((!bBelow2 || bBelow2.boundingBox !== 'block') && isSolidNonTrap(bBelow3))))
        if (!supportedCell) {
          if ((!bBelow1 || bBelow1.boundingBox !== 'block') && (!bBelow2 || bBelow2.boundingBox !== 'block') && pl?.isPendingCell?.(new Vec3(b.position.x, b.position.y - 1, b.position.z))) return 250
          if (fg?.isHole?.(b.position.x, b.position.z, b.position.y)) return 250
          if (bm && bm.isHazardWorldCell({ x: b.position.x, y: b.position.y, z: b.position.z })) return 250
          if (pl?.isActivePitCell ? pl.isActivePitCell(b.position.x, b.position.y, b.position.z) : pl?.pitCells?.has(k0)) return 250
        }
        if (pl && bot.entity?.position) {
          const botY = Math.floor(bot.entity.position.y + 0.01)
          const gGoal = human._activeGoal
          const isGoalCol = gGoal && Math.abs(b.position.x - Math.floor(gGoal.x)) <= 1 && Math.abs(b.position.z - Math.floor(gGoal.z)) <= 1
          if (!isGoalCol && b.position.y <= botY - 2 && pl.isPendingCell?.(b.position)) return 12
        }
        if (badCells.size === 0) return 0
        const exp = badCells.get(k0)
        return exp && exp > Date.now() ? 35 : 0
      })
    }
  }
  const routeCache = new Map()
  function routeCacheKey (from, goal, radius) {
    return `${Math.floor(from.x)},${Math.floor(from.y + 0.01)},${Math.floor(from.z)}->${Math.floor(goal.x)},${Math.floor(goal.y)},${Math.floor(goal.z)}:${Number(radius || 0.5).toFixed(1)}`
  }
  async function prewarmRoute (goal, radius = 0.5) {
    if (!bot.entity?.position || walk || planning > 0) return null
    const k = routeCacheKey(bot.entity.position, goal, radius)
    const hit = routeCache.get(k)
    if (hit && Date.now() - hit.at < 3500) return hit.plan
    const plan = await planRoute(goal, () => !walk, radius)
    if (plan) {
      if (routeCache.size > 80) routeCache.clear()
      routeCache.set(k, { at: Date.now(), plan })
    }
    return plan
  }
  async function planRoute (goal, live, radius = 0.5) {
    if (bot.entity?.position) {
      const k = routeCacheKey(bot.entity.position, goal, radius)
      const hit = routeCache.get(k)
      if (hit && Date.now() - hit.at < 3500 && hit.plan?.route?.length >= 2) {
        routeCache.delete(k)
        if (straightWalkable(bot.entity.position, hit.plan.route[1])) {
          return { route: [bot.entity.position.clone(), ...hit.plan.route.slice(1)], complete: hit.plan.complete }
        }
      }
    }
    planning++
    try { return await planRouteInner(goal, live, radius) } finally { planning-- }
  }
  async function planRouteInner (goal, live, radius = 0.5) {
    human._activeGoal = goal
    applyBad()
    await globalPathfinderGate.acquire()
    try {
      if (live && !live()) return null
      await new Promise(resolve => setImmediate(resolve))
      const gyFloor = Math.floor(goal.y)
      const goalBlockHere = bot.blockAt(new Vec3(Math.floor(goal.x), gyFloor, Math.floor(goal.z)))
      const allowYPlus1 = (goal.y - gyFloor) > 0.05 || isBottomSlabBlock(goalBlockHere) || isLowFloorBlock(goalBlockHere)
      const goalNode = (radius >= 1.0 && goals?.GoalNear)
        ? new goals.GoalNear(Math.floor(goal.x), gyFloor, Math.floor(goal.z), Math.max(1.0, radius))
        : new GoalBlock(Math.floor(goal.x), gyFloor, Math.floor(goal.z), allowYPlus1)
      const dist = bot.entity?.position ? horiz(goal.minus(bot.entity.position)) : 32
      const maxTimeout = dist <= 18 ? 250 : dist <= 32 ? 350 : 450
      const maxRadius = dist <= 18 ? Math.max(28, Math.ceil(dist * 2.5)) : Math.min(64, Math.max(40, Math.ceil(dist * 1.5)))
      const search = bot.pathfinder.getPathFromTo(movements(), bot.entity.position, goalNode, { timeout: maxTimeout, searchRadius: maxRadius })
      let res = null
      let iter = 0
      for (;;) {
        const step = search.next()
        if (step.value) res = step.value.result
        if (step.done || res.status !== 'partial') break
        if (live && !live()) return null
        if ((++iter % 10) === 0) await new Promise(resolve => setImmediate(resolve))
      }
      const tryBrainFallback = async () => {
        const brainPlan = bot.builder?.brain?.findRoute?.(bot.entity.position, goal, radius)
        if (!brainPlan || !brainPlan.route || brainPlan.route.length < 2) return null
        const ptsB = brainPlan.route
        const outB = [ptsB[0]]
        let ib = 0
        while (ib < ptsB.length - 1) {
          const maxLookahead = Math.min(ptsB.length - 1, ib + 12)
          let jb = maxLookahead
          while (jb > ib + 1 && !straightWalkable(ptsB[ib], ptsB[jb])) jb--
          outB.push(ptsB[jb])
          ib = jb
          if ((ib % 8) === 0) await new Promise(resolve => setImmediate(resolve))
        }
        return { route: outB, complete: brainPlan.complete }
      }
      if (res === null || (res.path.length === 0 && res.status !== 'success')) {
        return await tryBrainFallback()
      }
      const complete = res.status === 'success'
      if (!complete) {
        const bf = await tryBrainFallback()
        if (bf && bf.complete) return bf
        const lastNode = res.path[res.path.length - 1]
        const tolH = Math.max(1.5, Number(radius || 0.5) + 0.5)
        const tolY = Math.max(1.5, Number(radius || 0.5) >= 3 ? 4.5 : 1.5)
        const endDist = lastNode ? Math.hypot(lastNode.x + 0.5 - goal.x, lastNode.z + 0.5 - goal.z) : Infinity
        const madeProgress = lastNode && (dist - endDist >= 4.0)
        if (!lastNode || (!madeProgress && (endDist > tolH || Math.abs(lastNode.y - goal.y) > tolY))) {
          return bf
        }
      }
      const start = bot.entity.position.clone()
      const pts = [start]
      for (const m of res.path) {
        const p = new Vec3(Math.floor(m.x) + 0.5, m.y, Math.floor(m.z) + 0.5)
        if (Math.abs(p.y - start.y) < 0.25 && horiz(p.minus(start)) < 0.8) continue
        pts.push(p)
      }
      if (complete) pts.push(goal.clone())
      const out = [pts[0]]
      let i = 0
      while (i < pts.length - 1) {
        const maxAhead = Math.min(pts.length - 1, i + 12)
        let j = maxAhead
        while (j > i + 1 && !straightWalkable(pts[i], pts[j])) j--
        out.push(pts[j])
        i = j
      }
      return { route: out, complete }
    } finally {
      globalPathfinderGate.release()
    }
  }

  const doorLike = b => Boolean(b && /(_door|_fence_gate)$/.test(b.name) && !b.name.startsWith('iron_'))
  const isBottomSlabBlock = b => Boolean(b && /_slab$/.test(b.name || '') && (b.getProperties?.()?.type || b.properties?.type) === 'bottom')
  const isLowFloorBlock = b => Boolean(b && (/^(repeater|comparator|daylight_detector)$|_carpet$|^snow$/.test(b.name || '') || (/_trapdoor$/.test(b.name || '') && !b.name.startsWith('iron_') && (b.getProperties?.()?.half || b.properties?.half) !== 'top' && String(b.getProperties?.()?.open ?? b.properties?.open) !== 'true')))
  const trapFloor = b => {
    if (!b) return false
    if (/^(hopper|cauldron|water_cauldron|lava_cauldron|composter|chest|trapped_chest|ender_chest|lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|water)$/.test(b.name)) return true
    return false
  }
  const inPit = p => {
    const fx = Math.floor(p.x); const fy = Math.floor(p.y); const fz = Math.floor(p.z)
    const bHere = bot.blockAt(new Vec3(fx, fy, fz))
    if (bHere && bHere.boundingBox === 'block' && !doorLike(bHere) && !trapFloor(bHere)) return false
    const pl = bot.builder?.planner
    const bBelow1 = bot.blockAt(new Vec3(fx, fy - 1, fz))
    const bBelow2 = bot.blockAt(new Vec3(fx, fy - 2, fz))
    if ((!bBelow1 || bBelow1.boundingBox !== 'block') && (!bBelow2 || bBelow2.boundingBox !== 'block') && pl?.isPendingCell?.(new Vec3(fx, fy - 1, fz))) return true
    if (bot.builder?.fallGuard?.isHole?.(fx, fz, fy)) return true
    if (bot.builder?.buildMemory?.isHazardWorldCell?.({ x: fx, y: fy, z: fz })) return true
    if (pl?.isActivePitCell) return pl.isActivePitCell(fx, fy, fz)
    return Boolean(pl?.pitCells?.has(`${fx},${fy},${fz}`))
  }

  function solid (p) {
    const b = bot.blockAt(p)
    if (!b || b.boundingBox !== 'block' || doorLike(b) || trapFloor(b)) return false
    return true
  }

  function passable (p, allowBottomSlab = false) {
    if (inPit(p)) return false
    const b = bot.blockAt(p)
    if (!b) return false
    const props = b.getProperties?.() || b.properties || {}
    if (props.waterlogged === true || props.waterlogged === 'true') return false
    if (allowBottomSlab && (isBottomSlabBlock(b) || /^(repeater|comparator|daylight_detector)$|_carpet$/.test(b.name || ''))) return true
    return (b.boundingBox === 'empty' || doorLike(b)) && !/^(water|lava|fire|soul_fire|bubble_column)$/.test(b.name)
  }

  function straightWalkable (a, b) {
    if (a.y !== b.y) return false
    const d = b.minus(a)
    const len = horiz(d)
    if (len === 0) return true
    const nx = -d.z / len
    const nz = d.x / len
    const stepSize = len > 8 ? 0.6 : 0.4
    const steps = Math.ceil(len / stepSize)
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      const cx = a.x + d.x * t
      const cz = a.z + d.z * t
      for (const [ox, oz] of [[0, 0], [nx * -0.24, nz * -0.24], [nx * 0.24, nz * 0.24]]) {
        const p = new Vec3(cx + ox, a.y, cz + oz)
        const feetB = bot.blockAt(p)
        const onBotSlab = (isBottomSlabBlock(feetB) || isLowFloorBlock(feetB)) && !inPit(p)
        const floorOk = onBotSlab || solid(p.offset(0, -1, 0))
        if (!floorOk || !passable(p, true) || !passable(p.offset(0, 1, 0), false)) return false
      }
    }
    return true
  }

  function clearLine (a, b, allowGapHop = false) {
    if (Math.abs(a.y - b.y) > 0.6 && horiz(b.minus(a)) < 0.85) return false
    const d = b.minus(a)
    const len = horiz(d)
    if (len < 0.01) return Math.abs(a.y - b.y) < 0.5
    const nx = -d.z / len
    const nz = d.x / len
    const steps = Math.ceil(len / 0.2)
    const maxDropAllowed = b.y < a.y - 0.2 ? Math.min(3, Math.ceil(a.y - b.y)) : 1
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const y = Math.floor(a.y + (b.y - a.y) * t + 0.01)
      const cx = a.x + d.x * t
      const cz = a.z + d.z * t
      for (const [ox, oz] of [[0, 0], [nx * -0.3, nz * -0.3], [nx * 0.3, nz * 0.3], [-0.31, -0.31], [0.31, -0.31], [-0.31, 0.31], [0.31, 0.31]]) {
        const x = cx + ox
        const z = cz + oz
        if (!allowGapHop && inPit(new Vec3(x, y, z))) return false
        const bl0 = bot.blockAt(new Vec3(x, y, z))
        const bl1 = bot.blockAt(new Vec3(x, y + 1, z))
        const botSlab0 = isBottomSlabBlock(bl0) || isLowFloorBlock(bl0)
        if (bl0 && ((bl0.boundingBox === 'block' && !doorLike(bl0) && !botSlab0) || /^(water|lava|fire|soul_fire)$/.test(bl0.name))) return false
        if (bl1 && ((bl1.boundingBox === 'block' && !doorLike(bl1)) || /^(water|lava|fire|soul_fire)$/.test(bl1.name))) return false
        if (allowGapHop) continue
        let hasFloor = botSlab0
        for (let dy = 1; !hasFloor && dy <= maxDropAllowed; dy++) {
          const fl = bot.blockAt(new Vec3(x, y - dy, z))
          if (fl && trapFloor(fl)) return false
          if (fl && (fl.boundingBox === 'block' || /ladder|vine/.test(fl.name))) { hasFloor = true; break }
          if (inPit(new Vec3(x, y - dy, z))) return false
        }
        if (!hasFloor) return false
      }
    }
    return true
  }

  function safeCarrot (w, pos) {
    const c = carrot(w, pos)
    if (clearLine(pos, c)) return c
    const wp = w.route[Math.min(w.idx, w.route.length - 1)]
    for (let f = 0.7; f >= 0.2; f -= 0.25) {
      const t = new Vec3(pos.x + (c.x - pos.x) * f, c.y, pos.z + (c.z - pos.z) * f)
      if (clearLine(pos, t)) return t
    }
    return wp
  }

  function carrot (w, pos) {
    let remaining = personality.lookAhead
    let from = pos
    for (let k = w.idx; k < w.route.length; k++) {
      const to = w.route[k]
      const seg = to.minus(from)
      const len = horiz(seg)
      if (len >= remaining) {
        const t = remaining / len
        return new Vec3(from.x + seg.x * t, to.y, from.z + seg.z * t)
      }
      remaining -= len
      from = to
    }
    return w.route[w.route.length - 1]
  }

  function remainingDistance (w, pos) {
    let d = 0
    let from = pos
    for (let k = w.idx; k < w.route.length; k++) {
      d += horiz(w.route[k].minus(from))
      from = w.route[k]
    }
    return d
  }

  function walkDistance (w) {
    return horiz(w.route[w.route.length - 1].minus(bot.entity.position))
  }

  function stepHead (moving) {
    if (bot.__looking || (walk === null && targetYaw === null && targetPitch === null)) {
      yaw = bot.entity.yaw
      pitch = bot.entity.pitch
      gesture = null
      lastRotationDelta = 0
      return
    }
    const ty = targetYaw === null ? yaw : targetYaw + (Date.now() < glanceUntil ? glanceOffset : 0)
    const tp = targetPitch === null ? pitch : targetPitch + pitchNoise
    if (gesture === null) {
      const yawErr = wrapAngle(ty - yaw)
      const pitchErr = tp - pitch
      const tol = walk !== null && targetYaw !== null && !(walk.faceAt && walkDistance(walk) < 2.5) ? personality.deadband : 0.2 * DEG
      if (Math.abs(yawErr) < tol && Math.abs(pitchErr) < Math.max(tol, 0.2 * DEG)) {
        lastRotationDelta = 0
        return
      }
      const amp = Math.max(Math.abs(yawErr), Math.abs(pitchErr))
      const secs = (0.02 + 0.06 * Math.sqrt(amp / (90 * DEG))) * (moving ? 0.6 : 0.4) * personality.turnTime
      gesture = { ticks: 0, total: Math.max(1, Math.min(3, Math.ceil(amp / (65 * DEG)), Math.round(secs / TICK))), y0: yaw, p0: pitch, ay: yawErr, ap: pitchErr }
    }
    const g = gesture
    g.ticks++
    const t = Math.min(1, g.ticks / g.total)
    const frac = t * t * (3 - 2 * t)
    yaw = g.y0 + g.ay * frac
    pitch = Math.max(-89 * DEG, Math.min(89 * DEG, g.p0 + g.ap * frac))
    if (t >= 1) {
      gesture = null
      yaw = wrapAngle(yaw)
    }
    let qy = quantize(yaw)
    let qp = quantize(pitch)
    const dyNow = wrapAngle(qy - bot.entity.yaw)
    const dpNow = qp - bot.entity.pitch
    if (Math.abs(dyNow) > 65 * DEG) {
      qy = quantize(bot.entity.yaw + Math.sign(dyNow) * 65 * DEG)
      yaw = qy
    }
    if (Math.abs(dpNow) > 45 * DEG) {
      qp = quantize(bot.entity.pitch + Math.sign(dpNow) * 45 * DEG)
      pitch = qp
    }
    lastRotationDelta = Math.abs(wrapAngle(qy - bot.entity.yaw)) + Math.abs(qp - bot.entity.pitch)
    if (qy !== bot.entity.yaw || qp !== bot.entity.pitch) bot.look(qy, qp, true)
  }

  function tick () {
    if (!human.active || !bot.entity?.position) return
    const now = Date.now()
    const pos = bot.entity.position
    const speed = horiz(bot.entity.velocity)
    const moving = speed > 0.03

    if (heldUntil > 0 && now >= heldUntil) heldUntil = 0
    if (walk) tickWalk(walk, now, pos, speed)
    stepHead(moving)
    if (jumpHeld > 0 && --jumpHeld === 0) bot.setControlState('jump', false)
  }

  const WALL = { north: [0, 1], south: [0, -1], west: [1, 0], east: [-1, 0] }
  function ladderState (w, pos) {
    const at = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && (b.name === 'ladder' || b.name === 'vine') ? b : null }
    const fx = Math.floor(pos.x); const fy = Math.floor(pos.y + 0.01); const fz = Math.floor(pos.z)
    let b = at(fx, fy, fz) || at(fx, fy + 1, fz) || at(fx, fy - 1, fz)
    const atTopShaft = Boolean(!at(fx, fy, fz) && !at(fx, fy + 1, fz) && at(fx, fy - 1, fz))
    let cell = b ? { x: fx, y: b.position.y, z: fz } : null
    const wp = w.route[Math.min(w.idx, w.route.length - 1)]
    if (!b && wp) {
      const wx = Math.floor(wp.x); const wy = Math.floor(wp.y + 0.01); const wz = Math.floor(wp.z)
      const nb = at(wx, wy, wz) || at(wx, wy - 1, wz)
      if (nb && horiz(wp.minus(pos)) < 1.35 && Math.abs(wp.y - pos.y) < 1.6) { b = nb; cell = { x: wx, y: nb.position.y, z: wz } }
    }
    if (!b || !wp) return null
    let target = null
    for (let k = w.idx; k < Math.min(w.route.length, w.idx + 5); k++) {
      const rwp = w.route[k]
      const rx = Math.floor(rwp.x); const rz = Math.floor(rwp.z)
      const sameCol = rx === cell.x && rz === cell.z
      const adjStepOff = Math.abs(rx - cell.x) + Math.abs(rz - cell.z) === 1 && (rwp.y > pos.y + 0.25 || (atTopShaft && Math.abs(rwp.y - pos.y) <= 0.65))
      if (!sameCol && !adjStepOff) break
      if (Math.abs(rwp.y - pos.y) > 0.25 || (atTopShaft && adjStepOff)) target = rwp
    }
    if (!target) return null
    const up = Boolean(target.y > pos.y + 0.2 || (atTopShaft && (Math.floor(target.x) !== cell.x || Math.floor(target.z) !== cell.z) && target.y >= pos.y - 0.45))
    const down = Boolean(!up && target.y < pos.y - 0.25)
    if (!up && !down) return null
    let wall = null
    if (b.name === 'ladder') { const f = b.getProperties?.().facing; wall = WALL[f] || null }
    if (!wall) {
      for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) { const n = bot.blockAt(new Vec3(cell.x + dx, cell.y, cell.z + dz)); if (n && n.boundingBox === 'block') { wall = [dx, dz]; break } }
    }
    if (!wall) return null
    w.laddered = true
    return { cell, wall, up, target }
  }

  function tickWalk (w, now, pos, speed) {
    const tickDelta = w.lastTickAt ? (now - w.lastTickAt) : 50
    w.lastTickAt = now
    if (tickDelta > 200) {
      const freezeMs = tickDelta - 50
      w.lastProgressAt = (w.lastProgressAt || now) + freezeMs
      w.startedAt = (w.startedAt || now) + freezeMs
      if (w.blockedAt > 0) w.blockedAt += freezeMs
    }
    if (now - w.startedAt < personality.reaction * 1000 * w.rs) return
    while (w.idx < w.route.length - 1) {
      const wp = w.route[w.idx]
      const next = w.route[w.idx + 1]
      const passed = (horiz(wp.minus(pos)) < 0.55 && Math.abs(wp.y - pos.y) < 0.65) ||
        (Math.abs(wp.y - pos.y) < 0.38 && Math.abs(next.y - wp.y) < 0.38 && next.minus(wp).dot(pos.minus(wp)) > 0 && horiz(wp.minus(pos)) < 0.95 && clearLine(pos, next))
      if (!passed) break
      w.idx++
    }
    const last = w.route[w.route.length - 1]
    const goalDist = horiz(last.minus(pos)) + Math.abs(last.y - pos.y) * 0.75
    const remaining = remainingDistance(w, pos)
    if (goalDist < w.bestDist - 0.05) {
      w.bestDist = goalDist
      w.lastProgressAt = now
    }

    const underBlock = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y - 0.6), Math.floor(pos.z)))
    const drag = (underBlock && /ice$/.test(underBlock.name)) ? 0.68 : 0.546
    const coast = speed * drag / (1 - drag)
    const stopDist = coast + speed * 1.35
    const arrived = horiz(last.minus(pos)) <= Math.min(w.radius + 0.18, w.radius + coast * 0.6) && Math.abs(last.y - pos.y) <= 0.85 && w.idx >= w.route.length - 1
    if (arrived) {
      bot.setControlState('forward', false)
      bot.setControlState('left', false)
      bot.setControlState('right', false)
      bot.setControlState('sprint', false)
      if (speed > 0.09 && bot.entity.onGround && !w.braked) {
        w.braked = true
        bot.setControlState('back', true)
      } else {
        bot.setControlState('back', false)
      }
      if (speed < 0.065) {
        bot.setControlState('back', false)
        if (w.sneakGuard && !bot.builder?.fallGuard?.hazardAt?.(pos.x, pos.y, pos.z, 2)) {
          bot.setControlState('sneak', false)
          w.sneakGuard = false
        }
        const atGoal = horiz(w.goal.minus(pos)) <= Math.max(w.radius + 0.45, 0.65) && Math.abs(w.goal.y - pos.y) <= 1.25
        if (w.complete || atGoal) finishWalk(w)
        else failWalk(w, new Error(`no path to ${w.goal}`))
      }
      return
    }

    const lad = ladderState(w, pos)
    if (lad) {
      const wall = lad.wall
      const cx = lad.cell.x + 0.5 + wall[0] * 0.24
      const cz = lad.cell.z + 0.5 + wall[1] * 0.24
      const off = Math.hypot(pos.x - cx, pos.z - cz)
      const inside = Math.floor(pos.x) === lad.cell.x && Math.floor(pos.z) === lad.cell.z
      const errY = Math.abs(lad.target.y - pos.y)
      if (w.lastLadderTargetY !== lad.target.y) {
        w.lastLadderTargetY = lad.target.y
        w.bestLadderErr = errY
      } else if (errY < (w.bestLadderErr ?? Infinity) - 0.06) {
        w.bestLadderErr = errY
        w.lastProgressAt = now
      }
      if (bot.getControlState('sneak')) bot.setControlState('sneak', false)
      w.sneakGuard = false
      bot.setControlState('sprint', false)
      bot.setControlState('left', false); bot.setControlState('right', false)
      if (!inside || off > 0.32) {
        targetYaw = yawTo(pos, new Vec3(cx, pos.y, cz)); targetPitch = 0
        bot.setControlState('forward', Math.abs(wrapAngle(targetYaw - yaw)) < 45 * DEG)
        bot.setControlState('jump', false)
        return
      }
      if (lad.up) {
        const stepOff = lad.target && (Math.floor(lad.target.x) !== lad.cell.x || Math.floor(lad.target.z) !== lad.cell.z) && pos.y >= lad.target.y - 0.45
        const aimPt = stepOff ? new Vec3(lad.target.x, pos.y, lad.target.z) : new Vec3(lad.cell.x + 0.5 + wall[0] * 2, pos.y, lad.cell.z + 0.5 + wall[1] * 2)
        targetYaw = yawTo(pos, aimPt); targetPitch = 15 * DEG
        const facing = Math.abs(wrapAngle(targetYaw - yaw)) < 45 * DEG
        bot.setControlState('forward', facing)
        bot.setControlState('back', false)
        bot.setControlState('jump', Boolean(facing && pos.y < lad.target.y + 0.08))
      } else {
        const stepOff = lad.target && Math.abs(lad.target.y - pos.y) < 0.65
        const aimPt = stepOff ? new Vec3(lad.target.x, pos.y, lad.target.z) : new Vec3(lad.cell.x + 0.5 - wall[0] * 2, pos.y, lad.cell.z + 0.5 - wall[1] * 2)
        targetYaw = yawTo(pos, aimPt); targetPitch = 0
        bot.setControlState('forward', Boolean(stepOff && Math.abs(wrapAngle(targetYaw - yaw)) < 45 * DEG))
        bot.setControlState('back', false)
        bot.setControlState('jump', false)
      }
      if (now - w.lastProgressAt > 1500 && !w.replanning) {
        if (++w.replans > 1) { failWalk(w, new Error('stuck on ladder')); return }
        startReplan(w, 'no progress on ladder')
      }
      return
    }
    if (w.laddered) {
      if (bot.getControlState('sneak')) bot.setControlState('sneak', false)
      w.laddered = false
    }

    if (now < (w.backUntil || 0)) {
      bot.setControlState('forward', false); bot.setControlState('sprint', false); bot.setControlState('back', true)
      return
    }
    bot.setControlState('back', false)
    if (speed < 0.03 && bot.entity.onGround) {
      const other = playerAhead(pos)
      if (other) {
        w.crowdAt = w.crowdAt || now
        if (now - w.crowdAt > 500) {
          w.crowdAt = now; w.yields = (w.yields || 0) + 1
          w.lastProgressAt = now
          if (w.yields > 8) { failWalk(w, new Error('stuck: crowded')); return }
          if (String(bot.username) > String(other.username)) w.backUntil = now + 350 + 250 * r()
        }
        bot.setControlState('forward', false)
        return
      }
    } else w.crowdAt = 0

    const inWater = Boolean(bot.entity.isInWater) || bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y + 0.1), Math.floor(pos.z)))?.name === 'water'
    const target = safeCarrot(w, pos)
    const wantYaw = yawTo(pos, target)
    targetYaw = wantYaw
    if (inWater) {
      const dy = target.y - (pos.y + 1.0)
      const dh = Math.max(0.3, horiz(target.minus(pos)))
      const swimPitch = Math.atan2(dy, dh)
      targetPitch = Math.max(-60 * DEG, Math.min(60 * DEG, swimPitch))
    } else {
      targetPitch = -personality.basePitch
    }

    const err = wrapAngle(wantYaw - yaw)
    const aerr = Math.abs(err)
    const spatialNow = (!inWater && bot.builder?.fallGuard?.analyzeNeighborhood)
      ? bot.builder.fallGuard.analyzeNeighborhood(pos)
      : { mode: 'open', safeNeighbors: 8, minHazardDist: 99, overhanging: false }
    const canWalk = aerr < (spatialNow.mode === 'narrow' ? 48 : (speed > 0.08 ? 85 : 70)) * DEG
    let left = false
    let right = false
    if (canWalk && aerr > 20 * DEG && personality.strafe > 0 && r() < personality.strafe * TICK * 4) {
      strafeUntil = now + 200 + 200 * r()
      strafeDir = err > 0 ? 'left' : 'right'
    }
    if (now < strafeUntil && canWalk) {
      if (strafeDir === 'left') left = true
      else right = true
    }
    if (canWalk && w.firstStepAt === 0) {
      w.firstStepAt = now
      w.sprintAt = now + personality.sprintDelay * 1000 * w.rs
    }

    const curWp = w.route[Math.min(w.idx, w.route.length - 1)]
    const wpDist = curWp ? horiz(curWp.minus(pos)) : remaining
    const nextUp = Boolean(curWp && curWp.y > pos.y + 0.45 && wpDist < 1.35)
    const fyNow = Math.floor(pos.y + 0.01)
    const isParkourHop = Boolean(
      !inWater && curWp && Math.abs(curWp.y - pos.y) <= 0.6 && wpDist >= 1.15 && wpDist <= 3.6 &&
      solid(new Vec3(Math.floor(curWp.x), Math.floor(curWp.y + 0.01) - 1, Math.floor(curWp.z))) &&
      clearLine(pos, curWp, true) &&
      (!solid(new Vec3(Math.floor(pos.x - Math.sin(wantYaw) * 0.65), fyNow - 1, Math.floor(pos.z - Math.cos(wantYaw) * 0.65))) ||
       !solid(new Vec3(Math.floor(pos.x - Math.sin(wantYaw) * 1.05), fyNow - 1, Math.floor(pos.z - Math.cos(wantYaw) * 1.05))))
    )
    const spatial = spatialNow
    const isNarrow = spatial.mode === 'narrow'
    const checkRayDrop = (ux, uz, maxD) => {
      const fy = Math.floor(pos.y + 0.01)
      const effMax = Math.min(maxD, wpDist + 0.1, remaining + 0.15)
      for (const d of [0.45, Math.min(0.85, effMax)]) {
        if (d > effMax + 0.05) break
        const fx = Math.floor(pos.x + ux * d); const fz = Math.floor(pos.z + uz * d)
        const b0 = bot.blockAt(new Vec3(fx, fy, fz))
        if (b0 && /^(water|lava|fire|soul_fire)$/.test(b0.name)) return true
        if (b0 && isBottomSlabBlock(b0)) continue
        const b1 = bot.blockAt(new Vec3(fx, fy - 1, fz))
        if (!b1) continue
        if (trapFloor(b1)) return true
        if (b1.boundingBox === 'block') continue
        if (inPit(new Vec3(fx, fy, fz)) || inPit(new Vec3(fx, fy - 1, fz))) return true
        let hasFloor = false
        for (let k = 2; k <= 3; k++) {
          const bk = bot.blockAt(new Vec3(fx, fy - k, fz))
          if (!bk) { hasFloor = true; break }
          if (trapFloor(bk) || bk.name === 'water') return true
          if (bk.boundingBox === 'block') { hasFloor = true; break }
          if (inPit(new Vec3(fx, fy - k + 1, fz))) return true
        }
        if (!hasFloor) return true
      }
      return false
    }
    const feetBlock0 = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y + 0.01), Math.floor(pos.z)))
    const belowFeetBlock0 = bot.blockAt(new Vec3(Math.floor(pos.x), Math.floor(pos.y - 0.25), Math.floor(pos.z)))
    const onClimbable = Boolean(
      (feetBlock0 && /^(ladder|vine|scaffolding)$/.test(feetBlock0.name || '')) ||
      (belowFeetBlock0 && /^(ladder|vine|scaffolding)$/.test(belowFeetBlock0.name || ''))
    )
    const dropAhead = () => {
      if (inWater || onClimbable || nextUp || isParkourHop) return false
      const lookDist = Math.min(0.85, stopDist + 0.25)
      if (checkRayDrop(-Math.sin(wantYaw), -Math.cos(wantYaw), lookDist)) return true
      if (speed > 0.06) {
        const vx = bot.entity.velocity.x / speed; const vz = bot.entity.velocity.z / speed
        if (checkRayDrop(vx, vz, lookDist)) return true
      }
      return false
    }
    const nearEdge = dropAhead()
    const wantSprintWater = personality.sprints && canWalk && inWater && remaining > 0.8 && aerr < 55 * DEG
    const wantSprintLand = personality.sprints && canWalk && !inWater && (isParkourHop || (now >= w.sprintAt &&
      remaining > Math.max(1.1, stopDist * 1.15) && aerr < 45 * DEG && !nearEdge && (!isNarrow || spatial.minHazardDist > 1.2) && now > sprintReleaseUntil))
    let wantSprint = wantSprintWater || wantSprintLand
    let wantForward = canWalk
    let wantBack = false
    if (!isParkourHop && (nearEdge || remaining < Math.max(0.55, stopDist)) && !inWater && bot.entity.onGround && !nextUp) {
      wantSprint = false
      sprintReleaseUntil = now + 120
      if (remaining < stopDist && speed > 0.19) {
        wantForward = false
      }
    }

    // Only engage sneak during walking when overhanging a real hazard (>3 block drop or lava/pit), never during normal deck walking or a parkour hop!
    const needSneakGuard = !inWater && !onClimbable && bot.entity.onGround && !nextUp && !isParkourHop &&
      Boolean(spatial.overhanging && bot.builder?.fallGuard?.hazardAt?.(pos.x, pos.y, pos.z, 3))
    if (needSneakGuard) {
      bot.setControlState('sneak', true)
      w.sneakGuard = true
      left = false
      right = false
    } else if (w.sneakGuard) {
      bot.setControlState('sneak', false)
      w.sneakGuard = false
    }
    bot.setControlState('forward', wantForward)
    bot.setControlState('back', wantBack)
    bot.setControlState('left', left)
    bot.setControlState('right', right)
    bot.setControlState('sprint', wantSprint)

    if (inWater) {
      const wpNow = w.route[Math.min(w.idx, w.route.length - 1)]
      const wantSwimUp = Boolean(wpNow && wpNow.y >= pos.y - 0.2)
      bot.setControlState('jump', wantSwimUp)
      const dySwim = Math.abs(pos.y - (w.lastSwimY ?? pos.y))
      if (dySwim > 0.25 || speed > 0.08) {
        w.lastSwimY = pos.y
        w.lastProgressAt = now
      }
    } else if (bot.entity.onGround && jumpHeld === 0) {
      if (nextUp && lowStepAhead(pos, wantYaw, curWp)) {
        jump()
      } else if (isParkourHop && aerr < 28 * DEG && !solid(new Vec3(Math.floor(pos.x - Math.sin(wantYaw) * 0.48), fyNow - 1, Math.floor(pos.z - Math.cos(wantYaw) * 0.48)))) {
        jump()
      }
    }

    // ---- collision / stale-route handling (anti-wall-jump) ----
    if (bot.entity.onGround && !w.replanning && now - w.checkedAt > 120) {
      w.checkedAt = now
      const tgt = w.route[Math.min(w.idx, w.route.length - 1)]
      if (tgt && Math.abs(tgt.y - pos.y) < 0.6 && horiz(tgt.minus(pos)) < 4 && !clearLine(pos, tgt, isParkourHop)) {
        markBad(pos, tgt)
        startReplan(w, 'route blocked by a new block')
        return
      }
    }
    const pressing = wantForward && !arrivedNear(w, pos)
    if (pressing && speed < 0.03 && bot.entity.onGround) {
      if (w.blockedAt === 0) w.blockedAt = now
    } else if (speed >= 0.06 || !pressing) {
      w.blockedAt = 0
      w.blockedStep = 0
    }
    if (w.blockedAt > 0 && now - w.blockedAt > 180 && !w.replanning && !playerAhead(pos)) {
      w.blockedAt = now
      w.blockedStep++
      // Always check if there is a 1-block climbable step ahead BEFORE marking the cell bad!
      if (w.blockedStep <= 2 && lowStepAhead(pos, wantYaw, curWp)) { jump(); return }
      markBad(pos, curWp)
      if (w.blockedStep >= 2) { failWalk(w, new Error('stuck at wall')); return }
      startReplan(w, 'hit a block in front')
      return
    }
    if (now - w.lastProgressAt > 900 && now - stuckJumpAt > 800 && bot.entity.onGround && lowStepAhead(pos, wantYaw, curWp)) {
      stuckJumpAt = now
      jump()
    }
    if (now - w.lastProgressAt > 1400 && !w.replanning) {
      if (++w.replans > 2) { failWalk(w, new Error('stuck')); return }
      startReplan(w, 'no progress')
    }
  }

  function playerAhead (pos) {
    const me = bot.entity
    for (const e of Object.values(bot.entities || {})) {
      if (e === me || e.type !== 'player' || !e.position || !e.username) continue
      const dx = e.position.x - pos.x; const dz = e.position.z - pos.z
      if (Math.hypot(dx, dz) > 1.3 || Math.abs(e.position.y - pos.y) > 1.2) continue
      const heading = [-Math.sin(me.yaw), -Math.cos(me.yaw)]
      if (dx * heading[0] + dz * heading[1] > -0.2) return e
    }
    return null
  }

  function arrivedNear (w, pos) {
    return horiz(w.route[w.route.length - 1].minus(pos)) < w.radius + 0.4
  }

  function markBad (pos, tgt) {
    const dir = tgt ? tgt.minus(pos) : null
    const len = dir ? horiz(dir) : 0
    if (len < 0.01) return
    const ux = dir.x / len
    const uz = dir.z / len
    const exp = Date.now() + 3500
    for (const dist of [0.6, 1.0]) {
      const x = Math.floor(pos.x + ux * dist)
      const z = Math.floor(pos.z + uz * dist)
      const y = Math.floor(pos.y + 0.01)
      const b0 = bot.blockAt(new Vec3(x, y, z))
      const b1 = bot.blockAt(new Vec3(x, y + 1, z))
      // Only penalize genuine 2-block-high walls or head-height obstructions, NEVER a 1-block step!
      if ((b0 && b0.boundingBox === 'block' && b1 && b1.boundingBox === 'block') || (b1 && b1.boundingBox === 'block')) {
        badCells.set(`${x},${y},${z}`, exp)
        badCells.set(`${x},${y + 1},${z}`, exp)
      }
    }
  }

  function lowStepAhead (pos, wantYawArg = null, wp = null) {
    const y = Math.floor(pos.y + 0.01)
    if (!passable(pos.offset(0, 2, 0))) return false
    const checkCell = (x, z) => {
      const a = bot.blockAt(new Vec3(x, y, z))
      return Boolean(a && a.boundingBox === 'block' && passable(new Vec3(x, y + 1, z)) && passable(new Vec3(x, y + 2, z)))
    }
    if (wp && wp.y > pos.y + 0.45 && horiz(wp.minus(pos)) < 1.35) {
      if (checkCell(Math.floor(wp.x), Math.floor(wp.z))) return true
    }
    const yaws = wantYawArg != null ? [wantYawArg, bot.entity.yaw] : [bot.entity.yaw]
    for (const dir of yaws) {
      for (const dist of [0.65, 0.95]) {
        const x = Math.floor(pos.x - Math.sin(dir) * dist)
        const z = Math.floor(pos.z - Math.cos(dir) * dist)
        if (checkCell(x, z)) return true
      }
    }
    return false
  }

  function startReplan (w, why) {
    if (w.replanning) return
    w.replanning = true
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    human.lastReplan = { why, at: Date.now() }
    planRoute(w.goal, () => walk === w, w.radius).then(plan => {
      w.replanning = false
      if (walk !== w) return
      if (!plan) {
        failWalk(w, new Error('no path on re-plan'))
        return
      }
      w.route = plan.route
      w.complete = plan.complete
      w.idx = 0
      w.lastProgressAt = Date.now()
      w.bestDist = Infinity
      w.blockedAt = 0
      human.route = plan.route
      sprintReleaseUntil = Date.now() + 250
    }, e => {
      w.replanning = false
      if (walk === w) failWalk(w, e)
    })
  }

  function jump () {
    bot.setControlState('jump', true)
    jumpHeld = 1
  }

  function pitchTo (from, to) {
    const eye = from.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
    const d = to.minus(eye)
    return Math.atan2(d.y, horiz(d))
  }

  function releaseControls () {
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(c, false)
    if (bot.entity?.position && !bot.builder?.fallGuard?.hazardAt?.(bot.entity.position.x, bot.entity.position.y, bot.entity.position.z, 2)) {
      if (bot.getControlState?.('sneak') && !bot.builder?.placer?._chestSneak) {
        bot.setControlState('sneak', false)
      }
    }
  }

  function finishWalk (w) {
    if (walk !== w) return
    clearTimeout(w.timer)
    walk = null
    releaseControls()
    if (w.faceAt) {
      targetYaw = yawTo(bot.entity.position, w.faceAt)
      targetPitch = pitchTo(bot.entity.position, w.faceAt)
      settled(35).then(releaseHead, releaseHead).then(w.resolve, w.resolve)
    } else {
      releaseHead()
      w.resolve()
    }
  }

  function failWalk (w, e) {
    if (walk !== w) return
    clearTimeout(w.timer)
    walk = null
    releaseControls()
    releaseHead()
    w.reject(e)
  }

  function settled (ms) {
    return new Promise(resolve => {
      let quietSince = Date.now()
      const check = () => {
        if (lastRotationDelta > 0.05 * DEG) quietSince = Date.now()
        if (Date.now() - quietSince >= ms) {
          bot.off('physicsTick', check)
          resolve()
        }
      }
      bot.on('physicsTick', check)
    })
  }

  let planSeq = 0
  let inflight = null

  function requirePhysics (what) {
    if (bot.physicsEnabled === false) throw new Error(`${what} needs physics: bot.physicsEnabled is false`)
  }

  function walkTo (goal, o = {}) {
    const opts = { radius: o.radius ?? personality.stopRadius, faceAt: o.faceAt ?? null, timeout: o.timeout ?? 60000, reactionScale: o.reactionScale ?? 1 }
    if (inflight && inflight.goal.distanceTo(goal) <= 0.5 && sameOpts(inflight.opts, opts)) return inflight.promise
    const promise = startWalk(goal, opts)
    const mine = { goal: goal.clone(), opts, promise }
    inflight = mine
    const clear = () => { if (inflight === mine) inflight = null }
    promise.then(clear, clear)
    return promise
  }

  function sameOpts (a, b) {
    return a.radius === b.radius && a.timeout === b.timeout && a.reactionScale === b.reactionScale &&
      (a.faceAt === b.faceAt || (a.faceAt !== null && b.faceAt !== null && a.faceAt.equals(b.faceAt)))
  }

  async function startWalk (goal, o) {
    requirePhysics('walkTo')
    if (heldUntil > 0) throw new Error('setback')
    if (walk) failWalk(walk, new Error('superseded'))
    badCells.clear()
    const seq = ++planSeq
    const plan = await planRoute(goal, () => seq === planSeq, o.radius)
    if (seq !== planSeq) throw new Error('superseded')
    if (heldUntil > 0) throw new Error('setback')
    if (!plan) throw new Error(`no path to ${goal}`)
    const { route, complete } = plan
    return new Promise((resolve, reject) => {
      const now = Date.now()
      const w = {
        goal: goal.clone(),
        route,
        idx: 0,
        complete,
        replanning: false,
        radius: o.radius,
        startedAt: now,
        rs: o.reactionScale ?? 1,
        firstStepAt: 0,
        lastProgressAt: now + personality.reaction * 1000 * (o.reactionScale ?? 1),
        bestDist: Infinity,
        sprintAt: Infinity,
        faceAt: o.faceAt,
        replans: 0,
        checkedAt: 0,
        blockedAt: 0,
        blockedStep: 0,
        resolve,
        reject,
        timer: setTimeout(() => failWalk(w, new Error(bot.physicsEnabled === false ? 'walk timed out: physics was disabled mid-walk' : 'walk timed out')), o.timeout)
      }
      walk = w
      human.route = route
    })
  }

  async function lookAt (point, o = {}) {
    requirePhysics('lookAt')
    if (heldUntil > 0) throw new Error('setback')
    const trip = trips
    await new Promise(resolve => setTimeout(resolve, personality.reaction * 1000 * (0.5 + r()) * (o.reactionScale ?? 1)))
    if (trips !== trip || heldUntil > 0) throw new Error('setback')
    targetYaw = yawTo(bot.entity.position, point)
    targetPitch = pitchTo(bot.entity.position, point)
    await settled(o.settleMs ?? 35)
    if (trips !== trip) throw new Error('setback')
    releaseHead()
  }

  function releaseHead () {
    targetYaw = null
    targetPitch = null
  }

  function stop () {
    inflight = null
    if (walk) failWalk(walk, new Error('stopped'))
    releaseHead()
  }

  bot.on('physicsTick', tick)
  bot.on('forcedMove', () => {
    yaw = bot.entity.yaw
    pitch = bot.entity.pitch
    gesture = null
    if (setback === null) return
    const now = Date.now()
    lastForcedMoveAt = now
    forcedMoveAt.push(now)
    while (now - forcedMoveAt[0] > setback.window) forcedMoveAt.shift()
    if (forcedMoveAt.length < setback.trip) return
    heldUntil = Math.max(heldUntil, now + setback.hold)
    trips++
    if (walk) failWalk(walk, new Error('setback'))
    releaseHead()
  })
  return human
}

module.exports = { createHuman }
