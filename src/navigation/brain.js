'use strict'
// The "brain" above the walker: it knows which standing cells can reach which (walk graph), so a bot never
// wastes minutes walking at a wall. If the stand is not reachable on foot from where the bot is, the brain
// picks the cheapest human way to get there:
//   1. a 1-block staircase step (`isAccessStep`) for a 2-block rise, or a pillar tower (1-12 blocks) next to the structure
//      up to a walkable edge cell of that region, keeping 1-block access steps intact so builders can climb freely!
//   2. ender pearl (aimed with gravity) onto an open cell of the stand's walkable region,
//   3. a taller pillar tower up to maxTowerHeight,
// then the normal walker takes over inside the region. Plain survival actions only (no /tp, no /setblock).

const { Vec3 } = require('../util/vec3')
const { checkAbort } = require('../util/abort')
const { solveThrow } = require('../recovery/survival')
const { feetCellOf } = require('../world/ground')

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const DIAGS = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
const HAZARD = /(lava|fire|cactus|magma_block|sweet_berry_bush|cobweb|powder_snow|wither_rose|campfire|pointed_dripstone)/
const NOSTAND = /(fence$|_wall$|scaffolding|^hopper$|cauldron|^composter$|^chest$|^trapped_chest$|^ender_chest$)/
const HALF = /(_slab$|_stairs$|carpet$|^snow$|_bed$|^enchanting_table$|^daylight_detector$|^repeater$|^comparator$|^cake$|^soul_sand$|^farmland$|^dirt_path$|^lectern$)/
const PASSDOOR = /(_door$|fence_gate|trapdoor)/

function makeGraph (blockAt, maxDrop = 3, isBlockedCell = null) {
  let unknown = false
  const memo = new Map()
  const passMemo = new Map()
  const walkMemo = new Map()
  const blockedMemo = new Map()
  const checkBlocked = isBlockedCell
    ? (x, y, z) => {
        const k = `${x},${y},${z}`
        let v = blockedMemo.get(k)
        if (v === undefined) { v = Boolean(isBlockedCell(x, y, z)); blockedMemo.set(k, v) }
        return v
      }
    : null
  const get = (x, y, z) => { const k = `${x},${y},${z}`; let b = memo.get(k); if (b === undefined) { b = blockAt(x, y, z); memo.set(k, b) } if (!b) unknown = true; return b }
  const passable = (x, y, z) => {
    const k = `${x},${y},${z}`
    let p = passMemo.get(k)
    if (p !== undefined) return p
    const b = get(x, y, z)
    if (!b) p = false
    else if (HAZARD.test(b.name)) p = false
    else if (b.boundingBox !== 'block') p = true
    else p = PASSDOOR.test(b.name) && b.name !== 'iron_door' && b.name !== 'iron_trapdoor'
    passMemo.set(k, p)
    return p
  }
  const isHalf = b => {
    if (!b || !HALF.test(b.name)) return false
    let props = null
    try { props = b.getProperties ? b.getProperties() : (b.properties || null) } catch { props = null }
    if (props && (props.type === 'top' || props.type === 'double' || props.half === 'top')) return false
    return true
  }
  const isWater = (x, y, z) => {
    const b = get(x, y, z)
    if (!b) return false
    if (b.name === 'water' || b.name === 'bubble_column') return true
    try {
      const p = b.getProperties ? b.getProperties() : b.properties
      return Boolean(p && (p.waterlogged === true || p.waterlogged === 'true'))
    } catch { return false }
  }
  const isClimb = (x, y, z) => {
    const b = get(x, y, z)
    return Boolean(b && /^(ladder|vine|scaffolding)$/.test(b.name || ''))
  }
  const _walkableRaw = (x, y, z) => {
    if (checkBlocked && (checkBlocked(x, y, z) || checkBlocked(x, y + 1, z))) return false
    if (isClimb(x, y, z) && (passable(x, y + 1, z) || isClimb(x, y + 1, z))) return true
    const here = get(x, y, z)
    if (here && isHalf(here)) {
      if (/^(repeater|comparator|daylight_detector)$|carpet$|^snow$/.test(here.name || '')) {
        const below = get(x, y - 1, z)
        if (!below || below.boundingBox !== 'block' || HAZARD.test(below.name) || NOSTAND.test(below.name)) return false
      }
      return passable(x, y + 1, z) && passable(x, y + 2, z)
    }
    if (!passable(x, y, z) || !passable(x, y + 1, z)) return false
    if (isWater(x, y, z)) {
      const below = get(x, y - 1, z)
      return Boolean(below && ((below.boundingBox === 'block' && !HAZARD.test(below.name) && !NOSTAND.test(below.name)) || isWater(x, y - 1, z)))
    }
    if (isClimb(x, y - 1, z)) return true
    const f = get(x, y - 1, z)
    if (!f || f.boundingBox !== 'block' || HAZARD.test(f.name) || NOSTAND.test(f.name) || PASSDOOR.test(f.name) || isHalf(f)) return false
    return true
  }
  const walkable = (x, y, z) => {
    const k = `${x},${y},${z}`
    let w = walkMemo.get(k)
    if (w === undefined) { w = _walkableRaw(x, y, z); walkMemo.set(k, w) }
    return w
  }
  const surfaceY = (x, y, z) => {
    const here = get(x, y, z)
    if (here && isHalf(here)) {
      if (/^(repeater|comparator|daylight_detector)$/.test(here.name || '')) return y + 0.125
      if (/carpet$|^snow$/.test(here.name || '')) return y + 0.0625
      return y + 0.5
    }
    if (here && /_trapdoor$/.test(here.name || '')) {
      let props = null
      try { props = here.getProperties ? here.getProperties() : (here.properties || null) } catch { props = null }
      if (props && props.half !== 'top' && props.open !== 'true' && props.open !== true) return y + 0.1875
    }
    return y
  }
  const isClearParkourGap = (gx, gy, gz) => {
    if (!passable(gx, gy, gz) || !passable(gx, gy + 1, gz) || !passable(gx, gy + 2, gz)) return false
    if (isWater(gx, gy, gz) || isWater(gx, gy + 1, gz)) return false
    const gBelow = get(gx, gy - 1, gz)
    const gBelow2 = get(gx, gy - 2, gz)
    if (HAZARD.test(gBelow?.name || '') || HAZARD.test(gBelow2?.name || '')) return false
    return true
  }
  const key = (x, y, z) => `${x},${y},${z}`
  const succ = (c) => {
    const out = []
    const curY = surfaceY(c.x, c.y, c.z)
    if ((isClimb(c.x, c.y, c.z) || isClimb(c.x, c.y + 1, c.z) || isWater(c.x, c.y, c.z) || isWater(c.y + 1 && c.x, c.y + 1, c.z)) && passable(c.x, c.y + 2, c.z) && walkable(c.x, c.y + 1, c.z)) {
      out.push({ x: c.x, y: c.y + 1, z: c.z })
    }
    if ((isClimb(c.x, c.y - 1, c.z) || isWater(c.x, c.y - 1, c.z)) && walkable(c.x, c.y - 1, c.z)) {
      out.push({ x: c.x, y: c.y - 1, z: c.z })
    }
    for (const [dx, dz] of DIRS) {
      const nx = c.x + dx; const nz = c.z + dz
      if (walkable(nx, c.y, nz) && surfaceY(nx, c.y, nz) - curY <= 1.19) { out.push({ x: nx, y: c.y, z: nz }); continue }
      const shallowWet = isWater(c.x, c.y, c.z) && !isWater(c.x, c.y + 1, c.z) && !isWater(nx, c.y + 1, nz)
      if (!shallowWet && walkable(nx, c.y + 1, nz) && passable(c.x, c.y + 2, c.z) && surfaceY(nx, c.y + 1, nz) - curY <= 1.19) out.push({ x: nx, y: c.y + 1, z: nz })
      if (passable(nx, c.y, nz) && passable(nx, c.y + 1, nz)) {
        let dropped = false
        const dropLimit = isWater(nx, c.y - 1, nz) ? 5 : maxDrop
        for (let k = 1; k <= dropLimit; k++) {
          if (walkable(nx, c.y - k, nz) && curY - surfaceY(nx, c.y - k, nz) <= dropLimit + 0.5) { out.push({ x: nx, y: c.y - k, z: nz }); dropped = true; break }
          if (!passable(nx, c.y - k, nz) && !isWater(nx, c.y - k, nz)) break
        }
        // 1-block gap parkour hop across open air (e.g. between generator columns at the same Y)
        const jx = c.x + 2 * dx; const jz = c.z + 2 * dz
        if (!dropped && !isWater(c.x, c.y, c.z) && passable(c.x, c.y + 2, c.z) && isClearParkourGap(nx, c.y, nz) &&
            walkable(jx, c.y, jz) && !isWater(jx, c.y, jz) && passable(jx, c.y + 2, jz) && Math.abs(surfaceY(jx, c.y, jz) - curY) <= 0.5) {
          out.push({ x: jx, y: c.y, z: jz })
        }
      }
    }
    for (const [dx, dz] of DIAGS) {
      const nx = c.x + dx; const nz = c.z + dz
      if (!walkable(nx, c.y, nz) || Math.abs(surfaceY(nx, c.y, nz) - curY) > 0.5) continue
      const c1 = passable(c.x + dx, c.y, c.z) && passable(c.x + dx, c.y + 1, c.z)
      const c2 = passable(c.x, c.y, c.z + dz) && passable(c.x, c.y + 1, c.z + dz)
      if (c1 && c2) out.push({ x: nx, y: c.y, z: nz })
    }
    return out
  }
  const pred = (c) => {
    const out = []
    const curY = surfaceY(c.x, c.y, c.z)
    if ((isClimb(c.x, c.y - 1, c.z) || isClimb(c.x, c.y, c.z) || isWater(c.x, c.y - 1, c.z) || isWater(c.x, c.y, c.z)) && passable(c.x, c.y + 1, c.z) && walkable(c.x, c.y - 1, c.z)) {
      out.push({ x: c.x, y: c.y - 1, z: c.z })
    }
    if ((isClimb(c.x, c.y, c.z) || isWater(c.x, c.y, c.z)) && walkable(c.x, c.y + 1, c.z)) {
      out.push({ x: c.x, y: c.y + 1, z: c.z })
    }
    for (const [dx, dz] of DIRS) {
      const px = c.x + dx; const pz = c.z + dz
      if (walkable(px, c.y, pz) && curY - surfaceY(px, c.y, pz) <= 1.19) out.push({ x: px, y: c.y, z: pz })
      const shallowWetFrom = isWater(px, c.y - 1, pz) && !isWater(px, c.y, pz) && !isWater(c.x, c.y, c.z)
      if (!shallowWetFrom && walkable(px, c.y - 1, pz) && passable(px, c.y + 1, pz) && curY - surfaceY(px, c.y - 1, pz) <= 1.19) out.push({ x: px, y: c.y - 1, z: pz })
      const dropLimit = isWater(c.x, c.y, c.z) ? 5 : maxDrop
      for (let k = 1; k <= dropLimit; k++) {
        if (!passable(c.x, c.y + k, c.z) || !passable(c.x, c.y + k + 1, c.z)) break
        if (walkable(px, c.y + k, pz) && passable(px, c.y + k + 1, pz) && surfaceY(px, c.y + k, pz) - curY <= dropLimit + 0.5) out.push({ x: px, y: c.y + k, z: pz })
      }
      // 1-block gap parkour hop from (c.x + 2*dx, c.y, c.z + 2*dz) across (px, c.y, pz) onto c
      const jx = c.x + 2 * dx; const jz = c.z + 2 * dz
      if (!walkable(px, c.y, pz) && !isWater(c.x, c.y, c.z) && passable(c.x, c.y + 2, c.z) && isClearParkourGap(px, c.y, pz) &&
          walkable(jx, c.y, jz) && !isWater(jx, c.y, jz) && passable(jx, c.y + 2, jz) && Math.abs(curY - surfaceY(jx, c.y, jz)) <= 0.5) {
        out.push({ x: jx, y: c.y, z: jz })
      }
    }
    for (const [dx, dz] of DIAGS) {
      const px = c.x + dx; const pz = c.z + dz
      if (!walkable(px, c.y, pz) || Math.abs(curY - surfaceY(px, c.y, pz)) > 0.5) continue
      const c1 = passable(c.x + dx, c.y, c.z) && passable(c.x + dx, c.y + 1, c.z)
      const c2 = passable(c.x, c.y, c.z + dz) && passable(c.x, c.y + 1, c.z + dz)
      if (c1 && c2) out.push({ x: px, y: c.y, z: pz })
    }
    return out
  }
  const flood = (start, next, budget, shouldStop) => {
    const s0 = { ...start, d: 0 }
    const seen = new Map([[key(s0.x, s0.y, s0.z), s0]])
    const queue = [s0]
    let complete = true
    for (let qi = 0; qi < queue.length; qi++) {
      if (seen.size >= budget) { complete = false; break }
      const c = queue[qi]
      if (shouldStop && shouldStop(c)) return { cells: seen, complete: false, hit: c }
      for (const n of next(c)) {
        const k = key(n.x, n.y, n.z)
        if (seen.has(k)) continue
        const nd = { ...n, d: (c.d || 0) + 1, prev: key(c.x, c.y, c.z) }
        seen.set(k, nd); queue.push(nd)
        if (shouldStop && shouldStop(nd)) return { cells: seen, complete: false, hit: nd }
      }
    }
    return { cells: seen, complete, unknown }
  }
  return { passable, walkable, surfaceY, isHalf, isWater, succ, pred, flood, key, get unknown () { return unknown } }
}

function regionOf (blockAt, stand, budget = 600, maxDrop = 1, isBlockedCell = null) {
  const g = makeGraph(blockAt, maxDrop, isBlockedCell)
  let s = stand
  if (!g.walkable(s.x, s.y, s.z)) {
    for (const dy of [1, -1]) {
      if (g.walkable(stand.x, stand.y + dy, stand.z)) { s = { x: stand.x, y: stand.y + dy, z: stand.z }; break }
    }
    if (!g.walkable(s.x, s.y, s.z)) return null
  }
  const r = g.flood(s, g.pred, budget)
  return { cells: r.cells, complete: r.complete, graph: g }
}

function planEntries (blockAt, R, from, opts = {}) {
  const maxTower = opts.maxTower ?? 36
  const isTaskCell = opts.isTaskCell || (() => false)
  const g = makeGraph(blockAt)
  const dryFree = (x, y, z) => { const b = blockAt(x, y, z); return Boolean(b && (b.boundingBox !== 'block') && !/lava|water|bubble_column/.test(b.name) && !PASSDOOR.test(b.name) && !HALF.test(b.name)) }
  const isFullFloor = f => Boolean(f && f.boundingBox === 'block' && !/lava|water|bubble_column|hopper|chest|trapped_chest|ender_chest/.test(f.name) && !HAZARD.test(f.name) && !NOSTAND.test(f.name) && !PASSDOOR.test(f.name) && !g.isHalf(f))
  const skyFree = (x, y, z) => { const b = blockAt(x, y, z); return Boolean(b && (b.boundingBox !== 'block') && !/lava|water/.test(b.name)) }
  const towers = []; const pearls = []; const bridges = []
  const seenCol = new Set()
  const distTo = c => Math.hypot(c.x - from.x, c.z - from.z)
  const distToStand = c => opts.stand ? Math.hypot(c.x - opts.stand.x, c.z - opts.stand.z) : 0
  const cells = [...R.values()]
  if (cells.length > 600) {
    cells.sort((a, b) => (distTo(a) + distToStand(a)) - (distTo(b) + distToStand(b)))
    cells.length = 600
  }
  for (const r of cells) {
    if (opts.pearl !== false && pearls.length < 48) {
      let open = true
      for (let k = 2; k <= 5 && open; k++) if (!skyFree(r.x, r.y + k, r.z)) open = false
      if (open && g.isWater(r.x, r.y - 2, r.z)) open = false
      if (open) pearls.push(r)
    }
    for (const [dx, dz] of DIRS) {
      const nx = r.x + dx; const nz = r.z + dz
      if (R.has(g.key(nx, r.y, nz))) continue
      if (!dryFree(nx, r.y, nz) || !dryFree(nx, r.y + 1, nz) || !dryFree(nx, r.y + 2, nz)) continue
      const ck = `${nx},${nz},${r.y}`
      if (seenCol.has(ck)) continue
      seenCol.add(ck)
      let gy = null
      for (let y = r.y - 1; y >= r.y - maxTower - 1; y--) {
        const f = blockAt(nx, y - 1, nz)
        if (!f) break
        if (isFullFloor(f)) {
          if ((dryFree(nx, y, nz) || blockAt(nx, y, nz)?.name === 'water') && dryFree(nx, y + 1, nz) && dryFree(nx, y + 2, nz)) gy = y
          break
        }
        if (!dryFree(nx, y, nz) && blockAt(nx, y, nz)?.name !== 'water') break
      }
      if (gy === null) continue
      if (opts.reach && !opts.reach.has(g.key(nx, gy, nz))) continue
      const height = r.y - gy
      if (height < 1 || height > maxTower) continue
      let clash = false
      const maxPlacedY = height === 2 ? gy : r.y
      for (let y = gy; y <= r.y + 2; y++) {
        const bHere = blockAt(nx, y, nz)
        const okCell = (dryFree(nx, y, nz) && !/^(ladder|vine)$/.test(bHere?.name || '')) || (y === gy && bHere?.name === 'water')
        if (!okCell || (y <= maxPlacedY && isTaskCell(nx, y, nz))) { clash = true; break }
        if (y <= maxPlacedY && DIRS.some(([ldx, ldz]) => /^(ladder|vine)$/.test(blockAt(nx + ldx, y, nz + ldz)?.name || ''))) { clash = true; break }
      }
      if (clash) continue
      const base = { x: nx, y: gy, z: nz }
      const d = Math.hypot(base.x - from.x, base.z - from.z)
      const dStand = distToStand(r)
      const wetBasePenalty = blockAt(nx, gy, nz)?.name === 'water' ? 6 : 0
      const otherOccupied = Array.isArray(opts.others) && opts.others.some(o => o && Math.abs(o.x - (nx + 0.5)) < 0.85 && Math.abs(o.z - (nz + 0.5)) < 0.85 && Math.abs(o.y - gy) <= 2)
      const crowdPenalty = otherOccupied ? 30 : 0
      towers.push({ top: r, base, height, column: { x: nx, z: nz }, cost: height + d * 0.12 + dStand * 0.35 + wetBasePenalty + crowdPenalty })
    }
  }
  // Also find horizontal/stepped catwalk bridge pairs (start ∈ opts.reach -> end ∈ R) across air gaps of 2..9 blocks
  if (opts.reach && opts.reach.size > 0 && cells.length > 0) {
    const reachEdge = []
    for (const rc of opts.reach.values()) {
      if (!isFullFloor(blockAt(rc.x, rc.y - 1, rc.z))) continue
      if (DIRS.some(([dx, dz]) => !opts.reach.has(g.key(rc.x + dx, rc.y, rc.z + dz)))) {
        reachEdge.push(rc)
      }
    }
    if (reachEdge.length > 36) {
      const ref = opts.stand || cells[0]
      reachEdge.sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z))
      reachEdge.length = 36
    }
    const rEdge = cells.slice(0, 36)
    for (const rc of reachEdge) {
      for (const tc of rEdge) {
        const dy = tc.y - rc.y
        if (dy < -2 || dy > 4) continue
        const dx = tc.x - rc.x; const dz = tc.z - rc.z
        const mh = Math.abs(dx) + Math.abs(dz)
        if (mh < 2 || mh > 9) continue
        // Build L-path of floor cells from rc to tc (allowing existing solid column tops along the way)
        const steps = []
        let cx = rc.x; let cy = rc.y; let cz = rc.z
        let clear = true
        let placedCount = 0
        while (cx !== tc.x || cz !== tc.z) {
          if (Math.abs(tc.x - cx) >= Math.abs(tc.z - cz)) cx += Math.sign(tc.x - cx)
          else cz += Math.sign(tc.z - cz)
          if (cx === tc.x && cz === tc.z) break
          if (cy < tc.y && dryFree(cx, cy + 2, cz)) cy += 1
          else if (cy > tc.y && dryFree(cx, cy - 1, cz)) cy -= 1
          const floorAlreadySolid = isFullFloor(blockAt(cx, cy - 1, cz))
          if ((!dryFree(cx, cy - 1, cz) && !floorAlreadySolid) || !dryFree(cx, cy, cz) || !dryFree(cx, cy + 1, cz)) { clear = false; break }
          if (!floorAlreadySolid) placedCount++
          steps.push({ x: cx, y: cy, z: cz, alreadySolid: floorAlreadySolid })
        }
        if (clear && steps.length >= 1 && placedCount >= 1 && placedCount <= 8 && Math.abs(cy - tc.y) <= 1) {
          const walkD = Math.hypot(rc.x - from.x, rc.z - from.z)
          const standD = distToStand(tc)
          bridges.push({ start: rc, end: tc, steps, placedCount, cost: placedCount * 1.8 + (steps.length - placedCount) * 0.4 + Math.max(0, dy) * 1.5 + walkD * 0.15 + standD * 0.25 })
        }
      }
    }
    bridges.sort((a, b) => a.cost - b.cost)
  }
  pearls.sort((a, b) => distTo(a) - distTo(b))
  towers.sort((a, b) => a.cost - b.cost)
  return { pearls: sample(pearls, 24), towers: towers.slice(0, 8), bridges: bridges.slice(0, 4) }
}

function boundsOf (cells, pad = 28) {
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
  for (const c of cells.values()) { if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x; if (c.z < minZ) minZ = c.z; if (c.z > maxZ) maxZ = c.z }
  return { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad }
}

function reachFrom (blockAt, start, bounds, budget = 2500, maxDrop = 3, isBlockedCell = null) {
  const g = makeGraph(blockAt, maxDrop, isBlockedCell)
  let s0 = null
  for (const dy of [0, 1, -1]) {
    if (g.walkable(start.x, start.y + dy, start.z)) { s0 = { x: start.x, y: start.y + dy, z: start.z }; break }
  }
  if (!s0) {
    for (const [dx, dz] of DIRS) {
      for (const dy of [0, 1, -1]) {
        if (g.walkable(start.x + dx, start.y + dy, start.z + dz)) { s0 = { x: start.x + dx, y: start.y + dy, z: start.z + dz }; break }
      }
      if (s0) break
    }
  }
  if (!s0) return null
  const seen = new Map([[g.key(s0.x, s0.y, s0.z), s0]])
  const q = [s0]
  for (let i = 0; i < q.length && seen.size < budget; i++) {
    const c = q[i]
    for (const n of g.succ(c)) {
      if (n.x < bounds.minX || n.x > bounds.maxX || n.z < bounds.minZ || n.z > bounds.maxZ) continue
      const k = g.key(n.x, n.y, n.z)
      if (seen.has(k)) continue
      seen.set(k, n); q.push(n)
    }
  }
  return seen
}

class Brain {
  constructor ({ bot, world, config, logger, nav, scaffold, survival }) {
    Object.assign(this, { bot, world, config, logger, nav, scaffold, survival })
    this.isTaskCell = () => false
    this.failed = new Map()
    this.stats = { checks: 0, unreachable: 0, pearls: 0, towers: 0, entered: 0 }
  }

  blockAt (x, y, z) { return this.world.blockAt(new Vec3(x, y, z)) }

  clearCache () {
    this._forwardCacheMap?.clear?.()
  }

  isBlockedCell (x, y, z) {
    const pl = this.bot?.builder?.planner
    const bm = this.bot?.builder?.buildMemory
    if (pl?.isActivePitCell && pl.isActivePitCell(x, y, z)) return true
    if (bm?.isHazardWorldCell && bm.isHazardWorldCell({ x, y, z })) return true
    const b = this.blockAt(x, y, z)
    if (b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column')) return true
    return false
  }

  getForwardReach (me, effDrop, blockedFn, maxBudget = 3200) {
    const now = Date.now()
    this._forwardCacheMap = this._forwardCacheMap || new Map()
    const ck = `${me.x},${me.y},${me.z}:${effDrop}`
    const cached = this._forwardCacheMap.get(ck)
    if (cached && now - cached.at < 2500 && (cached.cells.size >= maxBudget || cached.complete)) {
      return cached
    }
    // Check if an existing fresh cached reach entry already contains 'me': if so, they share the same connected walkable component!
    const meKey = `${me.x},${me.y},${me.z}`
    for (const entry of this._forwardCacheMap.values()) {
      if (now - entry.at < 2500 && entry.cells.has(meKey) && (entry.cells.size >= maxBudget || entry.complete)) {
        return entry
      }
    }
    if (this._forwardCacheMap.size > 8) this._forwardCacheMap.clear()
    const g = makeGraph(this.blockAt.bind(this), effDrop, blockedFn)
    let start = null
    for (const dy of [0, 1, -1]) {
      if (g.walkable(me.x, me.y + dy, me.z)) { start = { x: me.x, y: me.y + dy, z: me.z }; break }
    }
    if (!start) {
      for (const [dx, dz] of DIRS) {
        for (const dy of [0, 1, -1]) {
          if (g.walkable(me.x + dx, me.y + dy, me.z + dz)) { start = { x: me.x + dx, y: me.y + dy, z: me.z + dz }; break }
        }
        if (start) break
      }
    }
    if (!start) {
      const empty = { key: ck, at: now, start: null, cells: new Map(), complete: true, unknown: false, graph: g, goalCache: new Map() }
      this._forwardCacheMap.set(ck, empty)
      return empty
    }
    const r = g.flood(start, g.succ, maxBudget)
    const entry = { key: ck, at: now, start, cells: r.cells, complete: r.complete, unknown: r.unknown, graph: g, goalCache: new Map() }
    this._forwardCacheMap.set(ck, entry)
    return entry
  }

  reachability (stand, budget = 2400, needRegion = true) {
    this.stats.checks++
    const bot = this.bot
    if (!bot?.entity) return { verdict: 'unknown' }
    const s = { x: Math.floor(stand.x), y: Math.floor(stand.y), z: Math.floor(stand.z) }
    const me = feetCellOf(this.world, bot.entity.position)
    if (s.x === me.x && s.z === me.z && Math.abs(s.y - me.y) <= 1) return { verdict: 'yes', steps: 0 }
    const maxDrop = Number(this.config.navigation?.exitMaxDrop ?? 3)
    const underFeetTask = this.bot?.builder?.planner?.tasks?.get(`${me.x},${me.y - 1},${me.z}`)
    const onIsolatedCol = Boolean(underFeetTask?.isolatedColumn || underFeetTask?.verticalAnchorCol)
    const blockedFn = (x, y, z) => !(x === me.x && z === me.z && (y === me.y || y === me.y + 1)) && this.isBlockedCell(x, y, z)
    // Never treat a ground stand > maxDrop (4+ blocks) below an elevated build deck as walkable on foot (prevents one-way cliff drops to y=-60)!
    if (!onIsolatedCol && me.y - s.y > maxDrop) {
      return { verdict: 'no', region: needRegion ? regionOf(this.blockAt.bind(this), s, 600, 1, blockedFn) : null }
    }
    const effDrop = (s.y <= me.y - 2 && !this.isTaskCell(s.x, s.y, s.z) && !this.isTaskCell(s.x, s.y + 1, s.z)) ? maxDrop : 1
    const horizDist = Math.hypot(s.x - me.x, s.z - me.z)
    // Dynamically bound flood budget based on physical distance to stand so we never block the event loop exploring 3200 distant cells
    const effBudget = horizDist <= 8.0
      ? Math.min(300, Math.max(80, Math.ceil(horizDist * horizDist * 4)))
      : (horizDist <= 16.0 ? 800 : budget)
    const fw = this.getForwardReach(me, effDrop, blockedFn, effBudget)
    const g = fw.graph
    if (!fw.start) {
      return { verdict: 'no', region: needRegion ? regionOf(this.blockAt.bind(this), s, 600, 1, blockedFn) : null }
    }
    let goal = null
    for (const dy of [0, 1, -1]) if (g.walkable(s.x, s.y + dy, s.z)) { goal = { x: s.x, y: s.y + dy, z: s.z }; break }
    if (!goal) return { verdict: 'no', region: null }
    const goalKey = g.key(goal.x, goal.y, goal.z)
    const hitFw = fw.cells.get(goalKey)
    if (hitFw) {
      const horizDist = Math.hypot(goal.x - fw.start.x, goal.z - fw.start.z)
      if (Math.abs(goal.y - fw.start.y) >= 2 && horizDist <= 10.0 && (hitFw.d || 0) > Math.max(18, horizDist * 3.5)) {
        return { verdict: 'no', region: needRegion ? regionOf(this.blockAt.bind(this), s, 600, 1, blockedFn) : null }
      }
      return { verdict: 'yes', steps: hitFw.d || 0 }
    }
    if (fw.complete && !fw.unknown) {
      return { verdict: 'no', region: needRegion ? regionOf(this.blockAt.bind(this), s, 600, 1, blockedFn) : null }
    }
    if (!needRegion && fw.goalCache.has(goalKey)) {
      return fw.goalCache.get(goalKey)
    }
    const hitForwardSet = c => fw.cells.has(g.key(c.x, c.y, c.z))
    const backBudget = Math.min(budget, 1500)
    const r = g.flood(goal, g.pred, backBudget, hitForwardSet)
    if (r.hit) {
      const fwHit = fw.cells.get(g.key(r.hit.x, r.hit.y, r.hit.z))
      const totalSteps = (r.hit.d || 0) + (fwHit?.d || 0)
      const horizDist = Math.hypot(goal.x - fw.start.x, goal.z - fw.start.z)
      if (Math.abs(goal.y - fw.start.y) >= 2 && horizDist <= 10.0 && totalSteps > Math.max(18, horizDist * 3.5)) {
        const resNo = { verdict: 'no', region: needRegion ? regionOf(this.blockAt.bind(this), s, 600, 1, blockedFn) : null }
        if (!needRegion) fw.goalCache.set(goalKey, resNo)
        return resNo
      }
      const resYes = { verdict: 'yes', steps: totalSteps }
      fw.goalCache.set(goalKey, resYes)
      return resYes
    }
    if (!r.complete || r.unknown) {
      const resUnk = { verdict: 'unknown' }
      fw.goalCache.set(goalKey, resUnk)
      return resUnk
    }
    const resNo = { verdict: 'no', region: { cells: r.cells, complete: true, graph: g } }
    fw.goalCache.set(goalKey, resNo)
    return resNo
  }

  async connect (stand, region) {
    if (!region || !region.cells || !region.cells.size) return false
    const bot = this.bot
    if (!bot?.entity) return false
    if (this.scaffold?.onScaffold?.()) await this.scaffold?.descend?.().catch(() => {})
    const key = `${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)}`
    if ((this.failed.get(key) || 0) >= 3) return false
    await new Promise(r => setImmediate(r))
    const from = bot.entity.position
    const me = feetCellOf(this.world, from)
    const underFeetTask = this.bot?.builder?.planner?.tasks?.get(`${me.x},${me.y - 1},${me.z}`)
    const onIsolatedCol = Boolean(underFeetTask?.isolatedColumn || underFeetTask?.verticalAnchorCol)
    // Never pearl or dig downward off an elevated deck/roof (`me.y >= stand.y + 3`) unless descending a finished isolated column!
    if (me.y >= Math.floor(stand.y) + 3 && !onIsolatedCol) {
      this.failed.set(key, (this.failed.get(key) || 0) + 1)
      return false
    }
    const b = boundsOf(region.cells, 48)
    b.minX = Math.min(b.minX, me.x - 4); b.maxX = Math.max(b.maxX, me.x + 4); b.minZ = Math.min(b.minZ, me.z - 4); b.maxZ = Math.max(b.maxZ, me.z + 4)
    const blockedFn = (x, y, z) => !(x === me.x && z === me.z && (y === me.y || y === me.y + 1)) && this.isBlockedCell(x, y, z)
    const reach = reachFrom(this.blockAt.bind(this), me, b, 5000, 3, blockedFn)
    const others = this.bot?.builder?.aim?.others?.() || []
    const plan = planEntries(this.blockAt.bind(this), region.cells, from, { reach, others, stand: { x: Math.floor(stand.x), y: Math.floor(stand.y), z: Math.floor(stand.z) }, maxTower: Number(this.config.building?.maxTowerHeight ?? 36), isTaskCell: (x, y, z) => this.isTaskCell(x, y, z), pearl: this.config.navigation?.pearls !== false })
    await new Promise(r => setImmediate(r))
    this.logger.info(`brain: ${key} is not reachable on foot from ${from.floored()} (region ${region.cells.size} cells); ${plan.pearls.length} pearl landings, ${plan.towers.length} tower sites`)

    const tryTower = async (t) => {
      checkAbort()
      const base = new Vec3(t.base.x + 0.5, t.base.y, t.base.z + 0.5)
      try { await this.nav.goTo(base, 0.35, 8_000, { human: true, rescue: false, allowObstacleBreak: false, _lastResort: true }) } catch (error) { this.logger.debug?.(`brain: tower base ${t.base.x},${t.base.y},${t.base.z} unreachable (${error.message})`); return false }
      const useSingleStep = t.height === 2 && !this.isTaskCell(t.base.x, t.base.y, t.base.z)
      const pillarHeight = useSingleStep ? 1 : t.height
      this.logger.info(`brain: building a ${pillarHeight}-block ${useSingleStep ? 'staircase step' : 'pillar'} at ${t.base.x},${t.base.y},${t.base.z} to step onto ${t.top.x},${t.top.y},${t.top.z}`)
      try {
        await this.scaffold.tower({ floor: new Vec3(t.base.x, t.base.y, t.base.z), height: pillarHeight, isAccessStep: useSingleStep }, new Vec3(t.base.x + 0.5, t.base.y + pillarHeight, t.base.z + 0.5))
        this.stats.towers++
        if (pillarHeight === 1) {
          const pk = `${t.base.x},${t.base.y},${t.base.z}`
          const rec = this.scaffold.created.get(pk)
          if (rec && !this.isTaskCell(t.base.x, t.base.y, t.base.z)) {
            rec.isAccessStep = true
            this.scaffold.created.set(pk, rec)
          }
        }
        const topSurfaceY = region.graph?.surfaceY ? region.graph.surfaceY(t.top.x, t.top.y, t.top.z) : t.top.y
        const topGoal = new Vec3(t.top.x + 0.5, topSurfaceY, t.top.z + 0.5)
        let stepped = false
        if (typeof this.scaffold._stepOntoTop === 'function') {
          stepped = await this.scaffold._stepOntoTop(topGoal, 2200).catch(() => false)
        }
        if (!stepped) {
          await this.nav.goTo(topGoal, 0.35, 5000, { human: true, rescue: false, allowObstacleBreak: false, _lastResort: true })
        }
        this.stats.entered++
        return true
      } catch (error) {
        if (error.code === 'INTERRUPTED' || error.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(error.message)) throw error
        this.logger.warn(`brain: pillar failed (${error.message})`)
        await this.scaffold?.descend?.().catch(() => {})
        return false
      }
    }

    const tryBridge = async (b) => {
      checkAbort()
      if (!this.scaffold?._placeBlockOnFloor) return false
      const startPos = new Vec3(b.start.x + 0.5, b.start.y, b.start.z + 0.5)
      try {
        await this.nav.goTo(startPos, 0.4, 7_000, { human: true, rescue: false, allowObstacleBreak: false, _lastResort: true })
      } catch { return false }
      this.logger.info(`brain: building ${b.steps.length}-block catwalk bridge from ${b.start.x},${b.start.y},${b.start.z} to ${b.end.x},${b.end.y},${b.end.z}`)
      try {
        for (const st of b.steps) {
          checkAbort()
          const floorCell = new Vec3(st.x, st.y - 1, st.z)
          const ok = await this.scaffold._placeBlockOnFloor(floorCell, true)
          if (!ok) return false
          const rec = this.scaffold.created.get(`${floorCell.x},${floorCell.y},${floorCell.z}`)
          if (rec) { rec.isAccessStep = true; rec.isCatwalk = true; this.scaffold.created.set(`${floorCell.x},${floorCell.y},${floorCell.z}`, rec) }
          const stepGoal = new Vec3(st.x + 0.5, st.y, st.z + 0.5)
          if (typeof this.scaffold._stepOntoTop === "function") {
            await this.scaffold._stepOntoTop(stepGoal, 1600).catch(() => false)
          }
        }
        const endGoal = new Vec3(b.end.x + 0.5, b.end.y, b.end.z + 0.5)
        if (typeof this.scaffold._stepOntoTop === "function") {
          await this.scaffold._stepOntoTop(endGoal, 1800).catch(() => false)
        }
        this.stats.entered++
        return true
      } catch { return false }
    }

    const deckLevelBridgeFirst = Math.abs(stand.y - me.y) <= 3 && plan.bridges && plan.bridges.length
    if (deckLevelBridgeFirst) {
      for (const b of plan.bridges.slice(0, 2)) {
        if (await tryBridge(b)) return true
      }
    }
    const primaryTowers = plan.towers.filter(t => t.height <= 18).slice(0, 3)
    for (const t of primaryTowers) {
      if (await tryTower(t)) return true
    }
    if (!deckLevelBridgeFirst && plan.bridges && plan.bridges.length) {
      for (const b of plan.bridges.slice(0, 2)) {
        if (await tryBridge(b)) return true
      }
    }

    if (this.survival && Number(bot.health) >= 14) {
      const pearlPool = onIsolatedCol ? plan.pearls : plan.pearls.filter(c => c.y >= me.y - 2)
      const near = () => this.throwable(pearlPool)
      let tries = near()
      if (!tries.length && reach && reach.size > 0 && pearlPool.length > 0) {
        const p0 = pearlPool[0]
        const launchCands = [...reach.values()]
          .filter(rc => {
            const d = Math.hypot(rc.x - p0.x, rc.z - p0.z)
            return d >= 8.0 && d <= 22.5 && rc.y >= p0.y - 3
          })
          .sort((a, b) => (Math.abs(a.y - me.y) - Math.abs(b.y - me.y)) * 3 + Math.hypot(a.x - from.x, a.z - from.z) * 0.4 + Math.abs(Math.hypot(a.x - p0.x, a.z - p0.z) - 13) - Math.abs(Math.hypot(b.x - p0.x, b.z - p0.z) - 13))
          .slice(0, 12)
        let vantageAttempts = 0
        for (const rc of launchCands) {
          if (vantageAttempts >= 2) break
          const rcPos = new Vec3(rc.x + 0.5, rc.y, rc.z + 0.5)
          const th = this.throwable(pearlPool, 2, rcPos)
          if (th.length) {
            vantageAttempts++
            this.logger.info(`brain: walking to pearl vantage point ${rc.x},${rc.y},${rc.z} to pearl across to ${th[0].x},${th[0].y},${th[0].z}`)
            try {
              await this.nav.goTo(rcPos, 0.55, 5_000, { human: true, rescue: false, allowObstacleBreak: false, _lastResort: true })
              tries = near()
              if (!tries.length) tries = th
              break
            } catch (_) {}
          }
        }
      }
      if (!tries.length && plan.towers.length) {
        const b = plan.towers[0].base
        try { await this.nav.goTo(new Vec3(b.x + 0.5, b.y, b.z + 0.5), 1.5, 6_000, { human: true, rescue: false, allowObstacleBreak: false, _lastResort: true }) } catch (_) {}
        tries = near()
      }
      for (let throwNo = 0; throwNo < 1; throwNo++) {
        checkAbort()
        await new Promise(r => setImmediate(r))
        let thrownOk = false; let gaveUp = false
        for (const c of tries) {
          const target = new Vec3(c.x + 0.5, c.y, c.z + 0.5)
          const ok = await this.survival.pearlTo(target).catch(() => false)
          if (ok) { this.stats.pearls++; this.stats.entered++; return true }
          if (['no pearls', 'health', 'in lava', 'in deep water', 'too close'].includes(this.survival.lastPearlReason)) { gaveUp = true; break }
          if (this.survival.lastPearlReason !== 'no arc' && this.survival.lastPearlReason !== 'failed') { thrownOk = true; break }
        }
        if (gaveUp || !thrownOk) break
      }
    }

    for (const t of plan.towers.filter(tw => !primaryTowers.includes(tw)).slice(0, 2)) {
      if (await tryTower(t)) return true
    }

    if (this.rescue && (onIsolatedCol || Math.floor(stand.y) >= me.y - 1)) {
      this.logger.warn(`brain: no direct pearl or pillar from ${from.floored()}; invoking exit planner`)
      try {
        const goalSet = region.cells instanceof Map ? new Set(region.cells.keys()) : region.cells
        const r = await this.rescue({ goalCells: goalSet })
        if (r && r.escaped) {
          this.failed.delete(key); this.stats.entered++
          const fc = feetCellOf(this.world, this.bot.entity.position)
          return region.cells.has(`${fc.x},${fc.y},${fc.z}`)
        }
      } catch (error) { if (error.code === 'INTERRUPTED' || error.code === 'TASK_TIMEOUT' || /abort|interrupt|abandoned/i.test(error.message)) throw error; this.logger.warn(`brain: exit failed: ${error.message}`) }
    }
    this.failed.set(key, (this.failed.get(key) || 0) + 1)
    return false
  }

  throwable (pearls, limit = 4, fromPos = null) {
    const q = fromPos || this.bot.entity.position
    const eye = { x: q.x, y: q.y + 1.62, z: q.z }
    const cand = pearls.filter(c => {
      const d = Math.hypot(c.x - q.x, c.z - q.z)
      const dy = c.y - q.y
      if (dy > -2.5 && dy <= 1.5 && d < 9.0) return false
      return dy >= -16 && d <= 24 && (d >= 7.5 || dy >= 3 || dy <= -4)
    }).slice(0, 16)
    const ents = require('../recovery/survival').playerBlockers(this.bot)
    const out = []
    for (let i = 0; i < cand.length && out.length < limit; i++) {
      const c = cand[i]
      const sol = solveThrow(this.blockAt.bind(this), eye, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, ents)
      if (sol && sol.ticks <= 45 && Math.abs(sol.pitch) <= 65 * Math.PI / 180) out.push(c)
    }
    return out
  }

  findRoute (fromPos, goalPos, radius = 0.5) {
    if (!fromPos || !goalPos) return null
    const me = feetCellOf(this.world, fromPos)
    const s = { x: Math.floor(goalPos.x), y: Math.floor(goalPos.y), z: Math.floor(goalPos.z) }
    const maxDrop = Number(this.config.navigation?.exitMaxDrop ?? 3)
    const blockedFn = (x, y, z) => !(x === me.x && z === me.z && (y === me.y || y === me.y + 1)) && this.isBlockedCell(x, y, z)
    const effDrop = (s.y <= me.y - 2 && !this.isTaskCell(s.x, s.y, s.z) && !this.isTaskCell(s.x, s.y + 1, s.z)) ? maxDrop : 1
    let fw = this.getForwardReach(me, effDrop, blockedFn)
    if (!fw.start) return null
    let g = fw.graph
    let goalCell = null
    for (const dy of [0, 1, -1]) {
      if (g.walkable(s.x, s.y + dy, s.z)) { goalCell = { x: s.x, y: s.y + dy, z: s.z }; break }
    }
    let hitNode = goalCell ? fw.cells.get(g.key(goalCell.x, goalCell.y, goalCell.z)) : null
    if (!hitNode && !fw.complete) {
      const rBig = g.flood(fw.start, g.succ, 8000, c => Boolean(goalCell && c.x === goalCell.x && c.y === goalCell.y && c.z === goalCell.z))
      fw = { ...fw, cells: rBig.cells }
      hitNode = rBig.hit || (goalCell ? fw.cells.get(g.key(goalCell.x, goalCell.y, goalCell.z)) : null)
    }
    if (!hitNode && Number(radius || 0.5) >= 1.0) {
      const tolH = Math.max(1.5, Number(radius || 0.5) + 0.5)
      const tolY = Math.max(1.5, Number(radius || 0.5) >= 3 ? 4.5 : 1.5)
      let best = null; let bestD = Infinity
      for (const c of fw.cells.values()) {
        const hd = Math.hypot(c.x + 0.5 - goalPos.x, c.z + 0.5 - goalPos.z)
        if (hd <= tolH && Math.abs(c.y - goalPos.y) <= tolY && (c.d || 0) < bestD) {
          best = c; bestD = c.d || 0
        }
      }
      hitNode = best
    }
    if (!hitNode) return null
    const cells = []
    let cur = hitNode
    let guard = 0
    while (cur && guard++ < 600) {
      cells.push(cur)
      if (!cur.prev) break
      cur = fw.cells.get(cur.prev)
    }
    cells.reverse()
    const pts = [new Vec3(fromPos.x, fromPos.y, fromPos.z)]
    for (const c of cells) {
      const sy = g.surfaceY(c.x, c.y, c.z)
      const p = new Vec3(c.x + 0.5, sy, c.z + 0.5)
      if (Math.abs(p.y - fromPos.y) < 0.25 && Math.hypot(p.x - fromPos.x, p.z - fromPos.z) < 0.65) continue
      pts.push(p)
    }
    const complete = Boolean(goalCell && hitNode.x === goalCell.x && hitNode.y === goalCell.y && hitNode.z === goalCell.z)
    if (complete) pts.push(new Vec3(goalPos.x, goalPos.y, goalPos.z))
    if (pts.length < 2) pts.push(new Vec3(goalPos.x, goalPos.y, goalPos.z))
    return { route: pts, complete }
  }

  async prepare (stand, opts = {}) {
    const v = this.reachability(stand)
    const botY = this.bot?.entity?.position?.y ?? stand.y
    if (v.verdict === 'yes' && !opts.walkFailed && !(opts.force && stand.y - botY >= 1.5)) return 'yes'
    if (v.verdict !== 'no' && !opts.force && !opts.walkFailed) return v.verdict
    const s = { x: Math.floor(stand.x), y: Math.floor(stand.y), z: Math.floor(stand.z) }
    const me = this.bot?.entity?.position ? feetCellOf(this.world, this.bot.entity.position) : null
    const blockedFn = (x, y, z) => !(me && x === me.x && z === me.z && (y === me.y || y === me.y + 1)) && this.isBlockedCell(x, y, z)
    const reg = v.region || regionOf(this.blockAt.bind(this), s, 1200, 1, blockedFn)
    if (!reg) return 'no'
    return (await this.connect(stand, reg)) ? 'connected' : 'no'
  }
}

function sample (list, n) {
  if (list.length <= n) return list
  const out = []; const step = list.length / n
  for (let i = 0; i < n; i++) out.push(list[Math.floor(i * step)])
  return out
}

module.exports = { Brain, makeGraph, regionOf, planEntries, reachFrom }
