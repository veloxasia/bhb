'use strict'
// Pure geometry. Given a target cell and a placement spec (see rules/blocks.js), find every
// (standing cell, sneak state, reference block, clicked face, hit point on that face) tuple from which a
// real player can place the block so that Minecraft itself gives it the wanted state.
//
// Nothing here talks to the server. Everything can be unit-tested or re-checked right before clicking.

const { Vec3 } = require('../util/vec3')
const { FACE_INDEX, VEC, OPP } = require('../rules/blocks')
const { isAirLike, isBodyFree, isFullTop, isBottomSlab, isLowFloor, lowFloorHeight, supportUnder, iceStandOk, feetCellOf, BAD_BODY } = require('../world/ground')
const { isInteractive } = require('../rules/blocks')

const EYE_STAND = 1.62
const EYE_SNEAK = 1.27
const SUNKEN_NO_PLACE = /^(hopper|chest|trapped_chest|ender_chest|cauldron|composter)$/

const key = p => `${p.x},${p.y},${p.z}`
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }

function dominantDirection (d) {
  const ax = Math.abs(d.x); const ay = Math.abs(d.y); const az = Math.abs(d.z)
  if (ay >= ax && ay >= az) return d.y >= 0 ? 'up' : 'down'
  if (ax >= az) return d.x >= 0 ? 'east' : 'west'
  return d.z >= 0 ? 'south' : 'north'
}

function horizontalDirection (d) {
  if (Math.abs(d.x) > Math.abs(d.z)) return d.x >= 0 ? 'east' : 'west'
  return d.z >= 0 ? 'south' : 'north'
}

function rotation16 (d) {
  const yaw = Math.atan2(-d.x, d.z) * 180 / Math.PI
  return ((Math.floor((yaw + 180) * 16 / 360 + 0.5) % 16) + 16) % 16
}

function lookMargin (d) {
  const a = [Math.abs(d.x), Math.abs(d.y), Math.abs(d.z)].sort((x, y) => y - x)
  const s = Math.hypot(d.x, d.y, d.z) || 1
  return (a[0] - a[1]) / s
}
function horizMargin (d) {
  const ax = Math.abs(d.x); const az = Math.abs(d.z)
  return Math.abs(ax - az) / (Math.hypot(ax, az) || 1)
}
function yaw16Margin (d) {
  const yaw = Math.atan2(-d.x, d.z) * 180 / Math.PI
  const u = (yaw + 180) * 16 / 360 + 0.5
  const f = u - Math.floor(u)
  return Math.min(f, 1 - f) * (360 / 16) * Math.PI / 180
}

function specAccepts (spec, faceOpt, dir, hit, refPos, strict = true) {
  const F = VEC[faceOpt.f]
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1
  const normalDot = (dir.x * F[0] + dir.y * F[1] + dir.z * F[2]) / len
  if (normalDot >= (strict ? -0.022 : -0.012)) return false
  if ((F[0] !== 0 || F[2] !== 0) && hit && refPos) {
    const eyeX = hit.x - dir.x; const eyeY = hit.y - dir.y; const eyeZ = hit.z - dir.z
    const lateral = Math.abs((eyeX - (refPos.x + 0.5)) * F[2] + (eyeZ - (refPos.z + 0.5)) * F[0])
    const frontDist = -(dir.x * F[0] + dir.z * F[2])
    if (strict && lateral > 0.45 && frontDist < 0.24) return false
    if (eyeY > refPos.y + 1.0 && frontDist < (strict ? 0.075 : 0.02)) return false
    if (eyeY < refPos.y && frontDist < (strict ? 0.14 : 0.03)) return false
  }
  if (spec.look) {
    if (dominantDirection(dir) !== spec.look) return false
    const isHorizLook = spec.look !== 'up' && spec.look !== 'down'
    if (isHorizLook) {
      if (Math.abs(dir.y) / len > 0.55) return false
    } else {
      const minVertCos = /^observer/.test(spec.tag || "") ? (strict ? 0.74 : 0.68) : (strict ? 0.65 : 0.58)
      if (Math.abs(dir.y) / len < minVertCos) return false
    }
    const minMargin = (spec.look === 'up' || spec.look === 'down') ? (strict ? 0.16 : 0.08) : (strict ? 0.22 : 0.12)
    if (lookMargin(dir) < minMargin) return false
  }
  if (spec.horiz) {
    const want = spec.horiz === '__face__' ? faceOpt.f : spec.horiz === '__opp_face__' ? OPP[faceOpt.f] : spec.horiz
    if (horizontalDirection(dir) !== want) return false
    if (horizMargin(dir) < (strict ? 0.20 : 0.05)) return false
  }
  if (spec.yaw16 != null) {
    if (rotation16(dir) !== spec.yaw16) return false
    if (strict && yaw16Margin(dir) < 0.04) return false
  }
  const half = faceOpt.half || faceOpt.cy
  if (half) {
    const fy = hit.y - refPos.y
    if (half === 'top' && fy < 0.56) return false
    if (half === 'bottom') { if (fy > 0.44) return false }
  }
  if (faceOpt.cur) {
    const fv = faceOpt.cur.axis === 'x' ? (hit.x - refPos.x) : (hit.z - refPos.z)
    if (faceOpt.cur.gt && fv < 0.55) return false
    if (!faceOpt.cur.gt && fv > 0.45) return false
  }
  if (faceOpt.quad) {
    const fx = hit.x - refPos.x
    const fz = hit.z - refPos.z
    for (const [axis, side] of Object.entries(faceOpt.quad)) {
      const v = axis === 'x' ? fx : fz
      if (side === 'low' && v > 0.42) return false
      if (side === 'high' && v < 0.58) return false
    }
  }
  return true
}

function turnTo (botYaw, eye, hit) {
  const d = hit.minus(eye)
  const wantYaw = Math.atan2(-d.x, -d.z)
  return Math.abs(wrapPi(wantYaw - botYaw))
}

function boxOf (block) {
  const sh = block && block.shapes
  if (Array.isArray(sh) && sh.length) {
    let x0 = 1; let y0 = 1; let z0 = 1; let x1 = 0; let y1 = 0; let z1 = 0
    for (const s of sh) { if (s[0] < x0) x0 = s[0]; if (s[1] < y0) y0 = s[1]; if (s[2] < z0) z0 = s[2]; if (s[3] > x1) x1 = s[3]; if (s[4] > y1) y1 = s[4]; if (s[5] > z1) z1 = s[5] }
    if (x1 > x0 && y1 > y0 && z1 > z0) return [x0, y0, z0, x1, y1, y1 > y0 ? z1 : 1]
  }
  const n = block?.name || ''
  const p = block?.getProperties?.() || block?.properties || {}
  if (/_slab$/.test(n)) {
    if (p.type === 'bottom') return [0, 0, 0, 1, 0.5, 1]
    if (p.type === 'top') return [0, 0.5, 0, 1, 1, 1]
  }
  if (/_trapdoor$/.test(n)) {
    if (p.open === 'true' || p.open === true) {
      if (p.facing === 'north') return [0, 0, 0.8125, 1, 1, 1]
      if (p.facing === 'south') return [0, 0, 0, 1, 1, 0.1875]
      if (p.facing === 'west') return [0.8125, 0, 0, 1, 1, 1]
      if (p.facing === 'east') return [0, 0, 0, 0.1875, 1, 1]
    }
    return p.half === 'top' ? [0, 0.8125, 0, 1, 1, 1] : [0, 0, 0, 1, 0.1875, 1]
  }
  if (/_door$/.test(n)) {
    const open = p.open === 'true' || p.open === true
    const hingeRight = p.hinge === 'right'
    let eff = p.facing
    if (open && eff) {
      const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
      const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }
      eff = hingeRight ? CCW[eff] : CW[eff]
    }
    if (eff === 'east') return [0, 0, 0, 0.1875, 1, 1]
    if (eff === 'west') return [0.8125, 0, 0, 1, 1, 1]
    if (eff === 'south') return [0, 0, 0, 1, 1, 0.1875]
    if (eff === 'north') return [0, 0, 0.8125, 1, 1, 1]
  }
  if (/^(chest|trapped_chest|ender_chest)$/.test(n)) return [0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375]
  if (/^(repeater|comparator|daylight_detector)$/.test(n)) return [0, 0, 0, 1, 0.125, 1]
  if (/_fence_gate$/.test(n)) {
    return (p.facing === 'east' || p.facing === 'west') ? [0.375, 0, 0, 0.625, 1.0, 1] : [0, 0, 0.375, 1, 1.0, 0.625]
  }
  if (/_wall_sign$|_wall_hanging_sign$/.test(n)) {
    const f = p.facing
    if (f === 'north') return [0, 0.28, 0.875, 1, 0.78, 1]
    if (f === 'south') return [0, 0.28, 0, 1, 0.78, 0.125]
    if (f === 'west') return [0.875, 0.28, 0, 1, 0.78, 1]
    if (f === 'east') return [0, 0.28, 0, 0.125, 0.78, 1]
  }
  if (/_sign$/.test(n)) return [0.25, 0, 0.25, 0.75, 1.0, 0.75]
  if (/button$/.test(n)) {
    const face = p.face || 'wall'
    if (face === 'floor') return [0.3125, 0, 0.3125, 0.6875, 0.125, 0.6875]
    if (face === 'ceiling') return [0.3125, 0.875, 0.3125, 0.6875, 1, 0.6875]
    const f = p.facing
    if (f === 'north') return [0.3125, 0.375, 0.875, 0.6875, 0.625, 1]
    if (f === 'south') return [0.3125, 0.375, 0, 0.6875, 0.625, 0.125]
    if (f === 'west') return [0.875, 0.375, 0.3125, 1, 0.625, 0.6875]
    if (f === 'east') return [0, 0.375, 0.3125, 0.125, 0.625, 0.6875]
  }
  if (n === 'lever') return [0.25, 0.2, 0.25, 0.75, 0.8, 0.75]
  if (/torch$/.test(n)) return [0.4, 0, 0.4, 0.6, 0.6, 0.6]
  if (/pressure_plate$/.test(n) || /carpet$/.test(n)) return [0.0625, 0, 0.0625, 0.9375, 0.0625, 0.9375]
  if (n === 'redstone_wire' || n === 'tripwire' || n === 'string' || /rail$/.test(n)) return [0, 0, 0, 1, 0.0625, 1]
  if (n === 'hopper') return [0, 0, 0, 1, 0.6875, 1]
  return [0, 0, 0, 1, 1, 1]
}

function rayHitBox (eye, dir, maxDist, pos, box) {
  const [x0, y0, z0, x1, y1, z1] = box
  const minX = pos.x + x0; const minY = pos.y + y0; const minZ = pos.z + z0
  const maxX = pos.x + x1; const maxY = pos.y + y1; const maxZ = pos.z + z1
  let tmin = 0
  let tmax = maxDist
  let hitFace = -1
  const axes = [
    [eye.x, dir.x, minX, maxX, 4, 5],
    [eye.y, dir.y, minY, maxY, 0, 1],
    [eye.z, dir.z, minZ, maxZ, 2, 3]
  ]
  for (const [orig, d, mn, mx, fMin, fMax] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (orig < mn || orig > mx) return null
    } else {
      let t1 = (mn - orig) / d
      let t2 = (mx - orig) / d
      let f = fMin
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; f = fMax }
      if (t1 > tmin) { tmin = t1; hitFace = f }
      if (t2 < tmax) tmax = t2
      if (tmin > tmax) return null
    }
  }
  if (tmin < 0 || tmin > maxDist || hitFace < 0) return null
  return {
    face: hitFace,
    dist: tmin,
    intersect: new Vec3(eye.x + dir.x * tmin, eye.y + dir.y * tmin, eye.z + dir.z * tmin)
  }
}

function hitSamples (refPos, faceName, faceOpt, box = [0, 0, 0, 1, 1, 1], fine = false, shapes = null) {
  const F = VEC[faceName]
  const [x0, y0, z0, x1, y1, z1] = box
  const base = new Vec3(refPos.x, refPos.y, refPos.z)
  let uMin = F[0] === 0 ? Math.max(x0 + 0.06, 0.06) : (F[0] > 0 ? x1 : x0)
  let uMax = F[0] === 0 ? Math.min(x1 - 0.06, 0.94) : uMin
  let vMin = F[1] === 0 ? Math.max(y0 + 0.06, 0.06) : (F[1] > 0 ? y1 : y0)
  let vMax = F[1] === 0 ? Math.min(y1 - 0.06, 0.94) : vMin
  let wMin = F[2] === 0 ? Math.max(z0 + 0.06, 0.06) : (F[2] > 0 ? z1 : z0)
  let wMax = F[2] === 0 ? Math.min(z1 - 0.06, 0.94) : wMin

  const half = faceOpt.half || faceOpt.cy
  if (half === 'top') vMin = Math.max(vMin, 0.65)
  if (half === 'bottom') vMax = Math.min(vMax, 0.35)
  if (faceOpt.cur) {
    if (faceOpt.cur.axis === 'x') {
      if (faceOpt.cur.gt) uMin = Math.max(uMin, 0.62)
      else uMax = Math.min(uMax, 0.38)
    } else if (faceOpt.cur.axis === 'z') {
      if (faceOpt.cur.gt) wMin = Math.max(wMin, 0.62)
      else wMax = Math.min(wMax, 0.38)
    }
  }
  if (faceOpt.quad) {
    if (faceOpt.quad.x === 'low') uMax = Math.min(uMax, 0.35)
    if (faceOpt.quad.x === 'high') uMin = Math.max(uMin, 0.65)
    if (faceOpt.quad.z === 'low') wMax = Math.min(wMax, 0.35)
    if (faceOpt.quad.z === 'high') wMin = Math.max(wMin, 0.65)
  }
  const hasConstraint = Boolean(half || faceOpt.quad || faceOpt.cur)
  if (hasConstraint && (uMin > uMax || vMin > vMax || wMin > wMax)) {
    return []
  }
  if (uMin > uMax) uMin = uMax = (x0 + x1) / 2
  if (vMin > vMax) vMin = vMax = (y0 + y1) / 2
  if (wMin > wMax) wMin = wMax = (z0 + z1) / 2

  const ts = fine ? [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95] : [0.5, 0.25, 0.75]
  const pick = (lo, hi) => lo === hi ? [lo] : ts.map(t => lo + (hi - lo) * t)
  const us = pick(uMin, uMax)
  const vs = pick(vMin, vMax)
  const ws = pick(wMin, wMax)
  const pts = []
  for (const u of us) for (const v of vs) for (const w of ws) pts.push(base.offset(u, v, w))

  if (Array.isArray(shapes) && shapes.length) {
    const ax = F[0] !== 0 ? 0 : F[1] !== 0 ? 1 : 2
    const oa = (ax + 1) % 3; const ob = (ax + 2) % 3
    const pos = F[ax] > 0
    const allow = (p, axis, v) => {
      if (axis === 1 && half === 'top' && v < 0.56) return false
      if (axis === 1 && half === 'bottom' && v > 0.44) return false
      if (faceOpt.cur) {
        if ((axis === 0 && faceOpt.cur.axis === 'x') || (axis === 2 && faceOpt.cur.axis === 'z')) {
          if (faceOpt.cur.gt && v < 0.55) return false
          if (!faceOpt.cur.gt && v > 0.45) return false
        }
      }
      if (faceOpt.quad) {
        const q = axis === 0 ? faceOpt.quad.x : axis === 2 ? faceOpt.quad.z : null
        if (q === 'low' && v > 0.40) return false
        if (q === 'high' && v < 0.60) return false
      }
      return true
    }
    const on = p => {
      const c = [p.x - base.x, p.y - base.y, p.z - base.z]
      if (!allow(p, oa, c[oa]) || !allow(p, ob, c[ob])) return false
      return shapes.some(s => Math.abs((pos ? s[ax + 3] : s[ax]) - c[ax]) < 1e-4 && c[oa] >= s[oa] + 0.008 && c[oa] <= s[oa + 3] - 0.008 && c[ob] >= s[ob] + 0.008 && c[ob] <= s[ob + 3] - 0.008)
    }
    const good = pts.filter(on)
    good.forEach(p => { p._m = 0.04 })
    const grid = [0.5, 0.35, 0.65, 0.2, 0.8]
    for (const s of shapes) {
      const plane = pos ? s[ax + 3] : s[ax]
      const spanA = s[oa + 3] - s[oa]; const spanB = s[ob + 3] - s[ob]
      const mA = Math.min(0.06, spanA * 0.22); const mB = Math.min(0.06, spanB * 0.22)
      const a0 = s[oa] + mA; const a1 = s[oa + 3] - mA
      const b0 = s[ob] + mB; const b1 = s[ob + 3] - mB
      if (a1 < a0 || b1 < b0) continue
      for (const ta of grid) for (const tb of grid) {
        const c = [0, 0, 0]
        c[ax] = plane
        c[oa] = a0 + (a1 - a0) * ta
        c[ob] = b0 + (b1 - b0) * tb
        const p = base.offset(c[0], c[1], c[2])
        p._m = Math.min(c[oa] - s[oa], s[oa + 3] - c[oa], c[ob] - s[ob], s[ob + 3] - c[ob])
        if (p._m < 0.012) continue
        if (!on(p)) continue
        const dup = good.find(q => q.distanceTo(p) < 0.02)
        if (dup) { dup._m = Math.max(dup._m, p._m) } else good.push(p)
      }
    }
    good.sort((p, q) => (Math.min(q._m, 0.1) - Math.min(p._m, 0.1)) || (center(p, base, F) - center(q, base, F)))
    return good
  }
  pts.sort((p, q) => center(p, base, F) - center(q, base, F))
  return pts
}
function center (p, base, F) {
  let s = 0
  for (const ax of ['x', 'y', 'z']) {
    if (F[ax === 'x' ? 0 : ax === 'y' ? 1 : 2] !== 0) continue
    s += Math.abs(p[ax] - base[ax] - 0.5)
  }
  return s
}

const WATERLOGGABLE = /(_slab|_stairs|_trapdoor|_fence$|_wall$|ladder|chain$|(^|soul_)lantern|campfire|scaffolding|_sign|glass_pane|iron_bars|^chest$|trapped_chest|ender_chest|conduit|sea_pickle|coral|candle|lightning_rod|pointed_dripstone|dripleaf|_leaves$|mangrove_roots|sculk_sensor|sculk_shrieker|copper_grate|decorated_pot|_bars$|heavy_core|bamboo_trapdoor)/

class AimSolver {
  constructor (bot, world, config, hooks = {}) {
    this.bot = bot
    this.world = world
    this.config = config
    this.isReserved = hooks.isReserved || (() => false)
    this.isPending = hooks.isPending || null
    this.batchCount = hooks.batchCount || null
    this.isTemp = hooks.isTemp || (() => false)
    this.isHazard = hooks.isHazard || (() => false)
    this.costBias = hooks.costBias || (() => 0)
    this.reachBase = Math.min(Number(config.navigation?.placementReach ?? 4.5), 4.5) - 0.15
    this.reach = this.reachBase
    this.maxTower = Number(config.building?.maxTowerHeight ?? 24)
  }

  setReachPenalty (p) { this.reach = Math.max(3.6, this.reachBase - p) }

  eyeHeight (sneak) { return sneak ? EYE_SNEAK : EYE_STAND }

  isSolidRef (block, faceName = null) {
    if (!block || isAirLike(block)) return false
    if (block.boundingBox !== 'block' && !/_door$|_trapdoor$|_fence_gate$/.test(block.name || '')) return false
    if (/^(repeater|comparator|daylight_detector)$|_carpet$/.test(block.name || '')) return false
    if (faceName && /_slab$/.test(block.name)) {
      const p = block.getProperties?.() || block.properties || {}
      if (p.type === 'bottom' && faceName === 'up') return false
      if (p.type === 'top' && faceName === 'down') return false
    }
    return true
  }

  // ---- standing cells ---------------------------------------------------------------------
  standOk (cell, cache) {
    const k = key(cell)
    if (cache.has(k)) return cache.get(k)
    if (this.isHazard(cell) || this.isHazard(cell.offset(0, 1, 0))) {
      cache.set(k, false)
      return false
    }
    const feet = this.world.blockAt(cell)
    const head = this.world.blockAt(cell.offset(0, 1, 0))
    const ground = this.world.blockAt(cell.offset(0, -1, 0))
    const feetProps = feet?.getProperties?.() || feet?.properties || {}
    const headProps = head?.getProperties?.() || head?.properties || {}
    const onBotSlab = isBottomSlab(feet) && feetProps.waterlogged !== true && feetProps.waterlogged !== 'true'
    const onLowFloor = !onBotSlab && isLowFloor(feet) && (isFullTop(ground) || iceStandOk(this.world, cell))
    let ok = false
    if (onBotSlab || onLowFloor) {
      const headTop = this.world.blockAt(cell.offset(0, 2, 0))
      const headTopProps = headTop?.getProperties?.() || headTop?.properties || {}
      const headDry = isBodyFree(head) && headProps.waterlogged !== true && headProps.waterlogged !== 'true'
      const headTopDry = isBodyFree(headTop) && headTopProps.waterlogged !== true && headTopProps.waterlogged !== 'true'
      ok = headDry && headTopDry
    } else {
      const shallowFlowWater = feet?.name === 'water' && Number(feetProps.level ?? feet.metadata ?? 0) > 0 && !this.isHazard(cell)
      const feetDry = (isBodyFree(feet) || shallowFlowWater) && !/^(ladder|vine)$/.test(feet?.name || '') && feetProps.waterlogged !== true && feetProps.waterlogged !== 'true'
      const headDry = isBodyFree(head) && headProps.waterlogged !== true && headProps.waterlogged !== 'true'
      ok = feetDry && headDry && !/^(ladder|vine)$/.test(ground?.name || '') && (isFullTop(ground) || iceStandOk(this.world, cell))
    }
    if (ok) ok = !this.lavaNear(cell)
    // Reject enclosed 2-block-deep pit traps (`cell` has no dry horizontal walk, 1-block step up, or 1-2 block step down exit)
    // Never reject the cell the bot is ALREADY standing on (otherwise a bot on a 1x1 pillar/island cannot bridge outward)!
    if (ok) {
      const bp = this.bot?.entity?.position
      let hasExit = Boolean(bp && Math.floor(bp.x) === cell.x && Math.floor(bp.z) === cell.z && Math.abs(bp.y - cell.y) < 0.65)
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const adj = cell.offset(dx, 0, dz)
        if (this.isHazard(adj)) continue
        const n0 = this.world.blockAt(adj)
        const n1 = this.world.blockAt(cell.offset(dx, 1, dz))
        const n2 = this.world.blockAt(cell.offset(dx, 2, dz))
        const nBelow = this.world.blockAt(cell.offset(dx, -1, dz))
        const nBelow2 = this.world.blockAt(cell.offset(dx, -2, dz))
        const nBelow3 = this.world.blockAt(cell.offset(dx, -3, dz))
        const n0FreeOrLow = isBodyFree(n0) || isLowFloor(n0)
        const canWalkSame = ((n0FreeOrLow && (isFullTop(nBelow) || iceStandOk(this.world, adj))) || isBottomSlab(n0)) && isBodyFree(n1)
        const canStepUp = !this.isHazard(cell.offset(dx, 1, dz)) && isFullTop(n0) && (isBodyFree(n1) || isLowFloor(n1)) && isBodyFree(n2)
        const canStepDown1 = !this.isHazard(cell.offset(dx, -1, dz)) && isBodyFree(n0) && isBodyFree(n1) && (((isBodyFree(nBelow) || isLowFloor(nBelow)) && isFullTop(nBelow2)) || isBottomSlab(nBelow))
        const canStepDown2 = !this.isHazard(cell.offset(dx, -2, dz)) && isBodyFree(n0) && isBodyFree(n1) && isBodyFree(nBelow) && (((isBodyFree(nBelow2) || isLowFloor(nBelow2)) && isFullTop(nBelow3)) || isBottomSlab(nBelow2))
        if (canStepUp || canStepDown1 || canStepDown2) { hasExit = true; break }
        if (canWalkSame) {
          for (const [dx2, dz2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (dx2 === -dx && dz2 === -dz) continue
            const adj2 = adj.offset(dx2, 0, dz2)
            if (this.isHazard(adj2)) continue
            const m0 = this.world.blockAt(adj2)
            const m1 = this.world.blockAt(adj.offset(dx2, 1, dz2))
            const m2 = this.world.blockAt(adj.offset(dx2, 2, dz2))
            const mBelow = this.world.blockAt(adj.offset(dx2, -1, dz2))
            const mWalk = (((isBodyFree(m0) || isLowFloor(m0)) && (isFullTop(mBelow) || iceStandOk(this.world, adj2))) || isBottomSlab(m0)) && isBodyFree(m1)
            const mStep = !this.isHazard(adj.offset(dx2, 1, dz2)) && isFullTop(m0) && (isBodyFree(m1) || isLowFloor(m1)) && isBodyFree(m2)
            if (mWalk || mStep) { hasExit = true; break }
          }
          if (hasExit) break
        }
      }
      if (!hasExit) ok = false
    }
    // Reject 1-block-wide trench slots or enclosed pockets where a pending cell is flanked by opposite or >=3 solid head-level walls!
    if (ok && this.isPending && (this.isPending(cell) || this.isPending(cell.offset(0, 1, 0)))) {
      const wE = Boolean(this.world.blockAt(cell.offset(1, 1, 0))?.boundingBox === 'block')
      const wW = Boolean(this.world.blockAt(cell.offset(-1, 1, 0))?.boundingBox === 'block')
      const wS = Boolean(this.world.blockAt(cell.offset(0, 1, 1))?.boundingBox === 'block')
      const wN = Boolean(this.world.blockAt(cell.offset(0, 1, -1))?.boundingBox === 'block')
      const walledHead = (wE ? 1 : 0) + (wW ? 1 : 0) + (wS ? 1 : 0) + (wN ? 1 : 0)
      if (walledHead >= 3 || (wE && wW) || (wS && wN)) ok = false
    }
    cache.set(k, ok)
    return ok
  }

  lavaNear (cell) {
    for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 2, 0]]) {
      const b = this.world.blockAt(cell.offset(dx, dy, dz))
      if (b && (b.name === 'lava' || (BAD_BODY.has(b.name) && b.name !== 'cobweb'))) {
        return true
      }
    }
    return false
  }

  virtualStand (cell, cache, target) {
    const k = 'v' + key(cell)
    if (cache.has(k)) return cache.get(k)
    let res = null
    const feet = this.world.blockAt(cell)
    const head = this.world.blockAt(cell.offset(0, 1, 0))
    const feetProps = feet?.getProperties?.() || feet?.properties || {}
    const headProps = head?.getProperties?.() || head?.properties || {}
    const adjLadder = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => /^(ladder|vine)$/.test(this.world.blockAt(cell.offset(dx, 0, dz))?.name || '') || /^(ladder|vine)$/.test(this.world.blockAt(cell.offset(dx, -1, dz))?.name || ''))
    const dryBody = !adjLadder && isBodyFree(feet) && !/^(water|ladder|vine)$/.test(feet?.name || '') && feetProps.waterlogged !== 'true' && feetProps.waterlogged !== true &&
      isBodyFree(head) && !/^(water|ladder|vine)$/.test(head?.name || '') && headProps.waterlogged !== 'true' && headProps.waterlogged !== true
    if (dryBody && !this.isReserved(cell) && !this.isReserved(cell.offset(0, 1, 0)) && !this.lavaNear(cell)) {
      const under = cell.offset(0, -1, 0)
      const ub = this.world.blockAt(under)
      if (ub && isAirLike(ub) && !this.isReserved(under) && !this.lavaNear(under) && !(target && under.equals(target))) {
        let hasAnchor = false
        let hasWalkAdjacent = false
        const botY = this.bot?.entity?.position?.y
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nb = this.world.blockAt(under.offset(dx, 0, dz))
          if (nb && nb.boundingBox === 'block' && !isAirLike(nb) && !SUNKEN_NO_PLACE.test(nb.name || '')) {
            hasAnchor = true
            for (const dy of [0, 1, -1]) {
              const adjStand = cell.offset(dx, dy, dz)
              if (this.standOk(adjStand, cache) && (botY == null || Math.abs(botY - adjStand.y) <= 2.5)) {
                hasWalkAdjacent = true
                break
              }
            }
          }
        }
        if (hasAnchor && hasWalkAdjacent) {
          res = { floor: under, height: 1, ledge: under }
        }
      }
      if (!res && !this.isHazard(cell) && !this.isHazard(cell.offset(0, -1, 0)) && !this.noScaffold?.(cell) && !this.noScaffold?.(cell.offset(0, -1, 0))) {
        for (let h = 0; h <= this.maxTower; h++) {
          const c = cell.offset(0, -1 - h, 0)
          if (this.isHazard(c) || this.isHazard(c.offset(0, 1, 0)) || this.noScaffold?.(c) || this.noScaffold?.(c.offset(0, 1, 0))) break
          const b = this.world.blockAt(c)
          if (!b) break
          if (isFullTop(b) || iceStandOk(this.world, c.offset(0, 1, 0))) {
            const baseCell = c.offset(0, 1, 0)
            const wetBase = Boolean(this.world.blockAt(baseCell)?.name === 'water')
            res = { floor: baseCell, height: h, wetBase }
            break
          }
          if (/^(ladder|vine)$/.test(b.name || '') || (!isBodyFree(b) && !isAirLike(b) && b.name !== 'water')) break
          if (this.isReserved(c) || (target && c.equals(target))) break
        }
      }
    }
    cache.set(k, res)
    return res
  }

  rayOutlineBlocker (eye, dir, maxDist, refPos, ignorePos = null) {
    const step = 0.04
    const seen = new Set([`${refPos.x},${refPos.y},${refPos.z}`])
    if (ignorePos) seen.add(`${ignorePos.x},${ignorePos.y},${ignorePos.z}`)
    let best = null
    for (let t = 0.04; t < maxDist - 0.02; t += step) {
      const bx = Math.floor(eye.x + dir.x * t)
      const by = Math.floor(eye.y + dir.y * t)
      const bz = Math.floor(eye.z + dir.z * t)
      const ck = `${bx},${by},${bz}`
      if (seen.has(ck)) continue
      seen.add(ck)
      const b = this.world.blockAt(new Vec3(bx, by, bz))
      if (!b || isAirLike(b) || b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') continue
      const pos = new Vec3(bx, by, bz)
      if (Array.isArray(b.shapes) && b.shapes.length > 0) {
        for (const sh of b.shapes) {
          const hit = rayHitBox(eye, dir, maxDist, pos, sh)
          if (hit && hit.dist < maxDist - 0.02 && (!best || hit.dist < best.dist)) {
            best = { position: pos, name: b.name, face: hit.face, intersect: hit.intersect, dist: hit.dist }
          }
        }
      } else {
        const hit = rayHitBox(eye, dir, maxDist, pos, boxOf(b))
        if (hit && hit.dist < maxDist - 0.02 && (!best || hit.dist < best.dist)) {
          best = { position: pos, name: b.name, face: hit.face, intersect: hit.intersect, dist: hit.dist }
        }
      }
    }
    return best
  }

  los (eye, hit, refPos, faceName, ignorePos = null) {
    if (!this.losRay(eye, hit, refPos, faceName, ignorePos)) return false
    const F = VEC[faceName]
    const axes = F[0] !== 0 ? ['y', 'z'] : F[1] !== 0 ? ['x', 'z'] : ['x', 'y']
    const m = 0.07
    for (const [da, db] of [[m, 0], [-m, 0], [0, m], [0, -m]]) {
      const p = hit.clone()
      p[axes[0]] += da; p[axes[1]] += db
      const inside = ax => { const f = p[ax] - refPos[ax]; return f > 0.015 && f < 0.985 }
      if (!inside(axes[0]) || !inside(axes[1])) continue
      if (!this.losRay(eye, p, refPos, faceName, ignorePos)) return false
    }
    return true
  }

  rayHitBlock (eye, dir, maxDist, pos, block) {
    if (!block || isAirLike(block) || block.name === 'water' || block.name === 'lava' || block.name === 'bubble_column') return null
    if (Array.isArray(block.shapes) && block.shapes.length > 0) {
      let best = null
      for (const sh of block.shapes) {
        const h = rayHitBox(eye, dir, maxDist, pos, sh)
        if (h && (!best || h.dist < best.dist)) best = h
      }
      return best
    }
    return rayHitBox(eye, dir, maxDist, pos, boxOf(block))
  }

  losRay (eye, hit, refPos, faceName, ignorePos = null) {
    const d = hit.minus(eye)
    const len = d.norm()
    if (len < 0.05) return false
    const dir = d.scaled(1 / len)
    const outlineBlocker = this.rayOutlineBlocker(eye, dir, len, refPos, ignorePos)
    if (outlineBlocker) return false
    const b = this.bot.world.raycast(eye, dir, len + 0.8)
    const refBlock = this.world.blockAt(refPos)
    if (b && b.position && b.position.x === refPos.x && b.position.y === refPos.y && b.position.z === refPos.z) {
      if (b.face !== FACE_INDEX[faceName]) return false
      if (b.intersect && b.intersect.distanceTo(hit) > 0.35) return false
      return true
    }
    if (refBlock) {
      if (b && b.position && (b.position.x !== refPos.x || b.position.y !== refPos.y || b.position.z !== refPos.z)) {
        const bActual = this.world.blockAt(b.position) || b
        const bHit = this.rayHitBlock(eye, dir, len, b.position, bActual)
        if (bHit && bHit.dist < len - 0.02) return false
      }
      const rbHit = this.rayHitBlock(eye, dir, len + 0.4, refPos, refBlock)
      return Boolean(rbHit && rbHit.face === FACE_INDEX[faceName] && (!rbHit.intersect || rbHit.intersect.distanceTo(hit) <= 0.35))
    }
    return false
  }

  candidates (target, spec, opts = {}) {
    const bot = this.bot
    const origin = (opts.from || bot.entity.position).floored()
    const maxOut = opts.max ?? 8
    const stages = opts.stages || [{ r: 4, down: 3, up: 2, aroundTarget: true }, { r: 5, down: 5, up: 3, aroundTarget: true }]
    const stageResults = []
    const cache = new Map()
    if (!opts.onlyScaffold) {
      for (let si = 0; si < stages.length; si++) {
        const st = stages[si]
        const out = this.search(target, spec, origin, st, cache, opts, false).filter(c => !opts.exclude?.has(key(c.stand)))
        if (out.length) {
          stageResults.push(...out)
          const botY0 = bot.entity?.position ? Math.floor(bot.entity.position.y + 0.01) : null
          const hasLowerDeckStand = stageResults.some(c => c.cell.y <= (botY0 != null ? Math.min(target.y - 2, botY0) : target.y - 2))
          const canReachFromBelow = Boolean((botY0 != null && botY0 <= target.y - 2 && spec.faces && (spec.faces.some(fo => fo.f === "down") || !spec.look)) || opts.mode === "self" || spec.look === "up")
          if (si === 0 && !opts.stages && canReachFromBelow && !hasLowerDeckStand && stages.length > 1) {
            continue
          }
          break
        }
      }
      const botYNow = bot.entity?.position ? Math.floor(bot.entity.position.y + 0.01) : null
      const hasDeckCand = botYNow != null && botYNow >= target.y
        ? stageResults.some(c => c.cell.y >= target.y && !c.edge)
        : stageResults.length > 0
      if ((!stageResults.length || !hasDeckCand) && !opts.fixedStand && !opts.bucket) {
        const edgeOut = this.search(target, spec, origin, { r: 4, down: 3, up: 2, aroundTarget: true }, cache, { ...opts, allowEdgeShift: true }, false).filter(c => !opts.exclude?.has(key(c.stand)))
        if (edgeOut.length) stageResults.push(...edgeOut)
      }
    }
    if (!stageResults.length && opts.allowScaffold !== false && (opts.allowScaffold || opts.onlyScaffold)) {
      const out = this.search(target, spec, origin, { r: 5, down: 12, up: 4, aroundTarget: true }, cache, opts, true).filter(c => !opts.exclude?.has(key(c.stand)))
      stageResults.push(...out)
    }
    stageResults.sort((a, b) => a.cost - b.cost)
    const dedup = []
    const seenStands = new Set()
    for (const c of stageResults) {
      const sk = `${c.stand.x.toFixed(2)},${c.stand.y.toFixed(2)},${c.stand.z.toFixed(2)}|${c.faceName}`
      if (seenStands.has(sk)) continue
      seenStands.add(sk)
      dedup.push(c)
      if (dedup.length >= maxOut) break
    }
    return dedup
  }

  search (target, spec, origin, st, cache, opts, virtual) {
    const out = []
    const botFeet = this.bot.entity.position
    let order = 0
    let others = null
    try { others = this.others ? this.others() : null; if (others && !others.length) others = null } catch { others = null }
    let crowd = 0
    const batchMemo = new Map()
    const self = opts.mode === 'self'
    const onlyDownOrSide = Boolean(spec.faces && spec.faces.some(fo => fo.f === 'down') && !spec.faces.some(fo => fo.f === 'up'))
    const botAlreadyBelow = Boolean(botFeet && botFeet.y <= target.y - 2.2)
    const minStandY = (spec.look === 'up' || onlyDownOrSide || self || botAlreadyBelow) ? target.y - 5 : opts.bucket ? target.y - 1 : target.y - 2
    for (const faceOpt of spec.faces) {
      order++
      const Fv = VEC[faceOpt.f]
      const refPos = self ? new Vec3(target.x, target.y, target.z) : new Vec3(target.x - Fv[0], target.y - Fv[1], target.z - Fv[2])
      const refBlock = this.world.blockAt(refPos)
      if (self) { if (!refBlock || isAirLike(refBlock)) continue } else if (!this.isSolidRef(refBlock, faceOpt.f)) continue
      if (opts.bucket && !self && this.isTemp(refPos)) continue
      if (opts.bucket && !self && refBlock && WATERLOGGABLE.test(refBlock.name)) continue
      const refInteractive = !self && refBlock ? isInteractive(refBlock.name) : false
      const needSneak = refInteractive || Boolean(spec.sneak)
      if (spec.noSneakRef && refInteractive) continue
      const refPenalty = 0
      const samples = hitSamples(refPos, faceOpt.f, faceOpt, boxOf(refBlock), Boolean(spec.look || spec.horiz || self), refBlock && refBlock.shapes)
      if (!samples.length) continue
      const centre = st.aroundTarget ? new Vec3(refPos.x + 0.5 + Fv[0] * 0.5, refPos.y + 0.5 + Fv[1] * 0.5, refPos.z + 0.5 + Fv[2] * 0.5) : origin.offset(0.5, 0, 0.5)
      const R = st.aroundTarget ? Math.ceil(this.reach) : st.r
      const cx = Math.floor(centre.x); const cy = Math.floor(centre.y); const cz = Math.floor(centre.z)
      for (let dy = -st.down; dy <= st.up; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          for (let dz = -R; dz <= R; dz++) {
            const S = new Vec3(cx + dx, (st.aroundTarget ? cy : origin.y) + dy, cz + dz)
            if (S.y < minStandY) continue
            if (opts.fixedStand && !(S.x === opts.fixedStand.x && S.y === opts.fixedStand.y && S.z === opts.fixedStand.z)) continue
            const effMinDist = (opts.bucket && S.y >= target.y + 1 && opts.minStandDist <= 1.6) ? 0.95 : opts.minStandDist
            if (effMinDist && Math.abs(S.y - target.y) <= 3 && Math.hypot(S.x + 0.5 - (target.x + 0.5), S.z + 0.5 - (target.z + 0.5)) < effMinDist) continue
            crowd = 0
            if (others) { let near = 99; for (const o of others) { if (Math.abs(o.y - S.y) <= 2.2) near = Math.min(near, Math.hypot(o.x - (S.x + 0.5), o.z - (S.z + 0.5))) } if (near < 1.4) continue; if (near < 2.6) crowd = 6 }
            if (opts.mode !== 'self' && (S.equals(target) || S.offset(0, 1, 0).equals(target))) continue
            if (opts.mode === 'self' && (S.equals(target) || S.offset(0, 1, 0).equals(target))) continue
            let scaffold = null
            if (!virtual) { if (!this.standOk(S, cache)) continue } else {
              if (this.standOk(S, cache)) continue
              scaffold = this.virtualStand(S, cache, target)
              if (!scaffold) continue
            }
            const feetAtS = !virtual ? this.world.blockAt(S) : null
            const onSlabS = Boolean(!virtual && isBottomSlab(feetAtS))
            const onLowS = Boolean(!virtual && !onSlabS && isLowFloor(feetAtS))
            const standY = onSlabS ? S.y + 0.5 : onLowS ? S.y + lowFloorHeight(feetAtS) : S.y
            const wetPenalty = !virtual && feetAtS?.name === 'water' ? 36 : 0
            const hazardPenalty = (!scaffold?.ledge && this.isHazard(S)) ? 45 : 0
            const lookUpPenalty = spec.look === 'up' && S.y >= target.y - 1 ? 35 : 0
            let shifts = opts.fixedStand
              ? [[0, 0], [0.19, 0], [-0.19, 0], [0, 0.19], [0, -0.19], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25], [0.18, 0.18], [0.18, -0.18], [-0.18, 0.18], [-0.18, -0.18], [-0.58, 0], [0.58, 0], [0, -0.58], [0, 0.58], [-0.65, 0], [0.65, 0], [0, -0.65], [0, 0.65]]
              : [[0, 0]]
            if (!opts.fixedStand && (spec.look || spec.horiz || needSneak || opts.allowEdgeShift)) {
              shifts = [[0, 0], [0.19, 0], [-0.19, 0], [0, 0.19], [0, -0.19], [0.18, 0.18], [0.18, -0.18], [-0.18, 0.18], [-0.18, -0.18]]
              for (const [ux, uz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nb0 = this.world.blockAt(S.offset(ux, 0, uz)); const nb1 = this.world.blockAt(S.offset(ux, 1, uz))
                if (isBodyFree(nb0) && isBodyFree(nb1)) {
                  shifts.push([ux * 0.25, uz * 0.25])
                  if (opts.allowEdgeShift) shifts.push([ux * 0.58, uz * 0.58], [ux * 0.65, uz * 0.65])
                }
              }
            }
            const adjLavaDrop = !virtual && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([lx, lz]) => {
              const b0 = this.world.blockAt(S.offset(lx, 0, lz))
              const b1 = this.world.blockAt(S.offset(lx, -1, lz))
              return (!b0 || b0.boundingBox !== 'block') && (b0?.name === 'lava' || b1?.name === 'lava')
            })
            let found = false
            for (const [sx, sz] of shifts) {
              const bigShift = Math.abs(sx) > 0.26 || Math.abs(sz) > 0.26
              if (sx !== 0) { const dxS = Math.sign(sx); if (this.world.blockAt(S.offset(dxS, -1, 0))?.name === 'lava' || this.world.blockAt(S.offset(dxS, 0, 0))?.name === 'lava' || (bigShift && !needSneak && this.isHazard(S.offset(dxS, 0, 0)))) continue }
              if (sz !== 0) { const dzS = Math.sign(sz); if (this.world.blockAt(S.offset(0, -1, dzS))?.name === 'lava' || this.world.blockAt(S.offset(0, 0, dzS))?.name === 'lava' || (bigShift && !needSneak && this.isHazard(S.offset(0, 0, dzS)))) continue }
              if (!self && Math.abs(S.x + 0.5 + sx - (target.x + 0.5)) < 0.805 && Math.abs(S.z + 0.5 + sz - (target.z + 0.5)) < 0.805 && standY < target.y + 1 && standY + 1.8 > target.y) continue
              const bigEdge = Math.abs(sx) > 0.3 || Math.abs(sz) > 0.3
              const edge = bigEdge
              for (const sneak of (needSneak || adjLavaDrop || bigEdge || (edge && opts.fixedStand) ? [true] : [false, true])) {
                if (sneak && !needSneak && !adjLavaDrop && !edge && !opts.allowSneakGeom && !spec.look && !spec.horiz) continue
                const eye = new Vec3(S.x + 0.5 + sx, standY + this.eyeHeight(sneak), S.z + 0.5 + sz)
                const effReach = (!virtual && opts.hintTask?.attempts >= 1) ? Math.min(this.reach, 3.95) : this.reach
                const hit = this.pickHit(eye, samples, spec, faceOpt, refPos, null, self ? null : target, effReach)
                if (!hit) continue
                const rawWalk = Math.abs(S.x + 0.5 - botFeet.x) + Math.abs(S.z + 0.5 - botFeet.z) + Math.abs(standY - botFeet.y) * 1.5
                const walk = rawWalk <= 4.5 ? rawWalk * 0.55 : rawWalk
                const turn = turnTo(this.bot.entity.yaw, eye, hit)
                let batchBonus = 0
                if (!virtual && !opts.fixedStand) {
                  if (!self) {
                    const targetHoriz = Math.hypot(S.x + 0.5 + sx - (target.x + 0.5), S.z + 0.5 + sz - (target.z + 0.5))
                    if (targetHoriz >= 2.3 && targetHoriz <= 4.15) batchBonus -= 2.8
                    else if (targetHoriz < 1.65 && !spec.look) batchBonus += 3.5
                  }
                  // Strongly prefer staying on the bot's CURRENT Y level (e.g. flat grass at y=-60 when on grass, or upper deck at y=-56 when on deck)
                  // and penalize unnecessary 2+ block climbs or drops!
                  const dyFromBot = standY - botFeet.y
                  if (Math.abs(dyFromBot) <= 0.6) {
                    batchBonus -= 8.5
                  } else if (dyFromBot > 1.1) {
                    batchBonus += 24.0
                  } else if (dyFromBot < -1.1) {
                    batchBonus += 20.0
                  } else {
                    batchBonus += 2.0
                  }
                  const sk = key(S)
                  let cellScore = batchMemo.get(sk)
                  if (cellScore === undefined) {
                    cellScore = 0
                    // Anti-fall narrow-wall penalty: penalize climbing onto or perching on a high narrow 1-block wall/pillar
                    let dropSides = 0
                    let deepDropSides = 0
                    for (const [hx, hz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                      const nf1 = this.world.blockAt(S.offset(hx, -1, hz))
                      const nf2 = this.world.blockAt(S.offset(hx, -2, hz))
                      const nf3 = this.world.blockAt(S.offset(hx, -3, hz))
                      if (!isFullTop(nf1) && !isBottomSlab(nf1) && !isFullTop(nf2)) {
                        dropSides++
                        if (!isFullTop(nf3) && !isBottomSlab(nf3)) deepDropSides++
                      }
                    }
                    if (deepDropSides >= 2 || (dropSides >= 2 && dyFromBot > 0.6)) {
                      cellScore += (deepDropSides >= 3 || dropSides >= 3) ? 28 : 22
                    }
                    if (!self) {
                      const isFeetPend = this.isPending ? this.isPending(S) : this.isReserved(S)
                      const isHeadPend = this.isPending ? this.isPending(S.offset(0, 1, 0)) : this.isReserved(S.offset(0, 1, 0))
                      if (isFeetPend) {
                        cellScore += 6
                      } else if (isHeadPend) {
                        let headWalls = 0
                        for (const [hx, hz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                          const hb = this.world.blockAt(S.offset(hx, 1, hz))
                          if (hb && hb.boundingBox === 'block') headWalls++
                        }
                        if (headWalls >= 2) cellScore += 14
                      }
                      if (this.batchCount) {
                        const extra = this.batchCount(S, eye, target, this.reach)
                        cellScore -= Math.min(6, extra) * 1.8
                      }
                    }
                    batchMemo.set(sk, cellScore)
                  }
                  batchBonus += cellScore
                }
                const shiftPenalty = (sx !== 0 || sz !== 0) ? (bigEdge ? 3.5 : 1.25) : 0
                const cost = crowd + wetPenalty + hazardPenalty + lookUpPenalty + refPenalty + walk + batchBonus + (turn > 1.75 ? 2.5 : turn / 1.57 * 0.6) + (sneak ? 1.5 : 0) + shiftPenalty + order * 0.15 + this.costBias(spec, faceOpt.f, sneak) + (scaffold ? 8 + scaffold.height * 3 + (scaffold.wetBase ? 16 : 0) : 0)
                out.push({ stand: new Vec3(S.x + 0.5 + sx, standY, S.z + 0.5 + sz), cell: S, eye, hit, ref: refPos, face: new Vec3(Fv[0], Fv[1], Fv[2]), faceName: faceOpt.f, faceOpt, sneak, edge, scaffold, cost })
                found = true
                break
              }
              if (found) break
            }
          }
        }
      }
    }
    return out
  }

  pickHit (eye, samples, spec, faceOpt, refPos, avoid = null, ignorePos = null, maxReach = this.reach) {
    for (const p of samples) {
      if (avoid && avoid.some(a => a.distanceTo(p) < 0.012)) continue
      const d = p.minus(eye)
      const len = d.norm()
      if (len > maxReach) continue
      if (!specAccepts(spec, faceOpt, d, p, refPos)) continue
      if (!this.los(eye, p, refPos, faceNameOf(faceOpt), ignorePos)) continue
      return p
    }
    return null
  }

  fromPose (target, spec, faceOptIndex = null, opts = {}) {
    const e = this.bot.entity
    const self = opts.mode === 'self'
    if (!e?.position) return null
    const hasDownFace = Boolean(spec.faces && spec.faces.some(fo => fo.f === 'down'))
    const minAllowedY = (spec.look === 'up' || hasDownFace || self) ? target.y - 5.2 : opts.bucket ? target.y - 1.3 : target.y - 2.1
    if (e.position.y < minAllowedY) return null
    const flNow = e.position.floored()
    const fcNow = feetCellOf(this.world, e.position)
    const fcVec = new Vec3(fcNow.x, fcNow.y, fcNow.z)
    const underNow = this.world.blockAt(new Vec3(fcNow.x, fcNow.y - 1, fcNow.z))
    const feetNow = this.world.blockAt(fcVec)
    const headNow = this.world.blockAt(new Vec3(fcNow.x, fcNow.y + 1, fcNow.z))
    const rawNow = this.world.blockAt(flNow)
    if (SUNKEN_NO_PLACE.test(underNow?.name || '') || SUNKEN_NO_PLACE.test(feetNow?.name || '') || SUNKEN_NO_PLACE.test(rawNow?.name || '')) return null
    const inWaterNow = Boolean(e.isInWater) || feetNow?.name === 'water' || rawNow?.name === 'water'
    if (inWaterNow) {
      const deepWater = !headNow || headNow.name === 'water' || headNow.name === 'bubble_column' || headNow.getProperties?.()?.waterlogged === true
      const solidUnder = isFullTop(underNow) || isBottomSlab(feetNow) || isLowFloor(feetNow)
      if (deepWater || !solidUnder || this.isHazard(fcVec) || this.isHazard(flNow)) return null
    }
    const supNow = supportUnder(this.world, e.position)
    const supCell = (supNow.supported && supNow.block?.position)
      ? new Vec3(supNow.block.position.x, fcNow.y, supNow.block.position.z)
      : fcVec
    if (this.isHazard(supCell) && (this.isHazard(flNow) || this.isHazard(fcVec))) return null
    if (!self && Math.abs(e.position.x - (target.x + 0.5)) < 0.805 && Math.abs(e.position.z - (target.z + 0.5)) < 0.805 && e.position.y < target.y + 1 && e.position.y + 1.8 > target.y) {
      return null
    }
    const sneak = Boolean(this.bot.getControlState?.('sneak'))
    const eye = e.position.offset(0, this.eyeHeight(sneak), 0)
    const faces = faceOptIndex == null ? spec.faces : [spec.faces[faceOptIndex]]
    for (const faceOpt of faces) {
      const Fv = VEC[faceOpt.f]
      const selfMode = opts.mode === 'self'
      const refPos = selfMode ? new Vec3(target.x, target.y, target.z) : new Vec3(target.x - Fv[0], target.y - Fv[1], target.z - Fv[2])
      const rb = this.world.blockAt(refPos)
      if (selfMode) { if (!rb || isAirLike(rb)) continue } else if (!this.isSolidRef(rb, faceOpt.f)) continue
      if (spec.noSneakRef && !selfMode && rb && isInteractive(rb.name)) continue
      if (opts.bucket && !selfMode && this.isTemp(refPos)) continue
      if (opts.bucket && !selfMode && rb && WATERLOGGABLE.test(rb.name)) continue
      const samples = hitSamples(refPos, faceOpt.f, faceOpt, boxOf(rb), Boolean(spec.look || spec.horiz || selfMode), rb && rb.shapes)
      if (!samples.length) continue
      const hit = this.pickHit(eye, samples, spec, faceOpt, refPos, opts.avoid, self ? null : target)
      if (hit) return { turn: turnTo(e.yaw, eye, hit), eye, hit, ref: refPos, face: new Vec3(Fv[0], Fv[1], Fv[2]), faceName: faceOpt.f, faceOpt }
    }
    return null
  }

  validateView (spec, faceOpt, refPos, faceName) {
    const e = this.bot.entity
    const sneak = Boolean(this.bot.getControlState?.('sneak'))
    const eye = e.position.offset(0, this.eyeHeight(sneak), 0)
    const cp = Math.cos(e.pitch)
    const dir = new Vec3(-Math.sin(e.yaw) * cp, Math.sin(e.pitch), -Math.cos(e.yaw) * cp)
    let b = this.bot.world.raycast(eye, dir, this.reach + 0.4)
    const refBlock = this.world.blockAt(refPos)
    if (refBlock && (!b || !b.position || b.position.x !== refPos.x || b.position.y !== refPos.y || b.position.z !== refPos.z || !refBlock.shapes || !refBlock.shapes.length)) {
      const rbHit = this.rayHitBlock(eye, dir, this.reach + 0.2, refPos, refBlock)
      if (rbHit) {
        let blockedBeforeRef = false
        if (b && b.position && (b.position.x !== refPos.x || b.position.y !== refPos.y || b.position.z !== refPos.z)) {
          const bActual = this.world.blockAt(b.position) || b
          const bHit = this.rayHitBlock(eye, dir, rbHit.dist, b.position, bActual)
          if (bHit && bHit.dist < rbHit.dist - 0.02) blockedBeforeRef = true
        }
        if (!blockedBeforeRef) {
          b = { position: refPos, name: refBlock.name, face: rbHit.face, intersect: rbHit.intersect }
        }
      }
    }
    if (b && b.intersect) {
      const distToRef = b.intersect.distanceTo(eye)
      const Fv = VEC[faceName]; const targetPos = Fv ? new Vec3(refPos.x + Fv[0], refPos.y + Fv[1], refPos.z + Fv[2]) : null; const blocker = this.rayOutlineBlocker(eye, dir, distToRef, refPos, targetPos)
      if (blocker) {
        this.lastReject = `ray intercepted by ${blocker.name} at ${blocker.position} before ${refPos}`
        return null
      }
    }
    if (!b || !b.position) { this.lastReject = 'ray hit nothing'; return null }
    if (b.position.x !== refPos.x || b.position.y !== refPos.y || b.position.z !== refPos.z) { this.lastReject = `ray hit ${b.name} at ${b.position} instead of ${refPos}`; return null }
    if (b.face !== FACE_INDEX[faceName]) { this.lastReject = `ray hit face ${b.face}, wanted ${FACE_INDEX[faceName]} (${faceName})`; return null }
    const hit = b.intersect
    if (!hit) { this.lastReject = 'no intersect point'; return null }
    if (!specAccepts(spec, faceOpt, dir, hit, refPos, false)) { this.lastReject = `spec ${spec.tag} rejects view dir=(${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)}) hit=${hit.x.toFixed(2)},${hit.y.toFixed(2)},${hit.z.toFixed(2)}`; return null }
    return { hit, cursor: new Vec3(hit.x - refPos.x, hit.y - refPos.y, hit.z - refPos.z), dir }
  }
}

function faceNameOf (faceOpt) { return faceOpt.f }

module.exports = { AimSolver, dominantDirection, horizontalDirection, rotation16, specAccepts, hitSamples, boxOf, rayHitBox, EYE_STAND, EYE_SNEAK }
