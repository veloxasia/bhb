'use strict'
// Exit planner: the "brain" for getting a bot out of (or into) anywhere. One search over everything a player can do
// with his hands, priced by effort and risk:
//   1. ender pearl (raycast/ballistic arc out of the pit/trench: cost ~ 3.0)
//   2. walk / swim / climb ladders / step up / short drop (cost ~ 1.0 - 2.0)
//   3. pillar up / bridge forward / stair up or down with temporary scaffold blocks (cost ~ 2.4 - 3.2)
//   4. dig through terrain/temporary blocks (cost ~ 1.2 - 3.0), or finished build blocks ONLY as an absolute last resort (cost ~ 450+)
// Pure: takes blockAt(x,y,z) only, so it is unit-testable.

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const AIRISH = /^(air|cave_air|void_air)$/
const BODY_HAZARD = /(^fire$|soul_fire|^lava$|cactus|magma_block|sweet_berry_bush|wither_rose|powder_snow|pointed_dripstone|campfire|^cobweb$|^end_portal$|nether_portal)/
const CLIMBABLE = /^(ladder|vine)$/
const GRAVITY = /(^sand$|^red_sand$|^gravel$|_concrete_powder$|^anvil$|^chipped_anvil$|^damaged_anvil$|^dragon_egg$)/
const NEVER_DIG = /(bedrock|obsidian|barrier|command_block|end_portal|nether_portal|spawner|reinforced_deepslate|chest|barrel|shulker_box|furnace|smoker|hopper|dropper|dispenser|crafter|beacon|enchanting_table|lectern|bell|brewing_stand|_bed$|anvil|jukebox|conduit|respawn_anchor)/
const SENSITIVE_KEPT = /(piston|observer|repeater|comparator|redstone|lever|button|pressure_plate|tripwire|rail|note_block|target|daylight|sculk|torch|lantern|sign|banner|door|trapdoor|fence_gate|ladder|water|lava|bubble|kelp|seagrass|slime|honey|lightning|carpet|flower|sapling|mushroom|vine|tnt|bubble)/
const PASSDOOR = /(_door$|fence_gate)/
const SUNKEN_BLOCK = /^(hopper|chest|trapped_chest|ender_chest|cauldron|composter|soul_sand|lectern|enchanting_table)$/

function propsOf (b) {
  try { if (b.getProperties) return b.getProperties() || {} } catch { /* fall through */ }
  return b.properties || {}
}

function makeView (blockAt, opts = {}) {
  const memo = new Map()
  const get = (x, y, z) => { const k = `${x},${y},${z}`; let b = memo.get(k); if (b === undefined) { b = blockAt(x, y, z) || null; memo.set(k, b) } return b }
  const cls = (x, y, z) => {
    const b = get(x, y, z)
    if (!b) return { k: 'unknown', b }
    const n = b.name
    if (n === 'water' || n === 'bubble_column' || n === 'seagrass' || n === 'tall_seagrass' || n === 'kelp' || n === 'kelp_plant') {
      let level = 0
      const p = propsOf(b)
      if (p.level !== undefined) level = Number(p.level)
      else if (b.metadata !== undefined) level = Number(b.metadata)
      return { k: 'water', b, level: Number.isFinite(level) ? level : 0 }
    }
    if (n === 'lava') return { k: 'lava', b }
    if (BODY_HAZARD.test(n)) return { k: 'hazard', b }
    if (AIRISH.test(n)) return { k: 'air', b }
    if (CLIMBABLE.test(n)) return { k: 'climb', b }
    if (PASSDOOR.test(n) && !n.startsWith('iron_')) return { k: 'door', b }
    if (b.boundingBox === 'block') {
      const p = propsOf(b)
      if (p.waterlogged === true || p.waterlogged === 'true') return { k: 'solid', b, wl: true }
      return { k: 'solid', b }
    }
    const p = propsOf(b)
    if (p.waterlogged === true || p.waterlogged === 'true') return { k: 'water', b, level: 0 }
    return { k: 'air', b }
  }
  const passable = (x, y, z) => { const k = cls(x, y, z).k; return k === 'air' || k === 'water' || k === 'climb' || k === 'door' }
  const wet = (x, y, z) => cls(x, y, z).k === 'water'
  const solid = (x, y, z) => cls(x, y, z).k === 'solid'
  const floorOK = (x, y, z) => { const c = cls(x, y, z); return c.k === 'solid' && !BODY_HAZARD.test(c.b.name) }
  return { get, cls, passable, wet, solid, floorOK, opts }
}

class Heap {
  constructor () { this.a = [] }
  get size () { return this.a.length }
  push (cost, v) { const a = this.a; a.push([cost, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p } }
  pop () {
    const a = this.a; const top = a[0]; const last = a.pop()
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1; const r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m } }
    return top
  }
}

const key = (x, y, z) => `${x},${y},${z}`

function digCost (view, x, y, z) {
  const o = view.opts
  const c = view.cls(x, y, z)
  if (c.k === 'unknown') return null
  if (c.k !== 'solid') return { cost: 0 }
  const b = c.b; const name = b.name
  if (NEVER_DIG.test(name)) return null
  if (o.forbidDig && o.forbidDig(x, y, z, b)) return null
  let cost = 0.7 + Math.min(5, (Number.isFinite(b.hardness) ? b.hardness : 1.5) * 0.8)
  const nbs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]
  for (const [dx, dy, dz] of nbs) {
    const n = view.cls(x + dx, y + dy, z + dz)
    if (n.k === 'lava') return null
    if (n.k === 'water') cost += o.waterNeighbour ?? 9
    if (dy === 1 && n.b && GRAVITY.test(n.b.name)) return null
  }
  const task = o.taskAt ? o.taskAt(x, y, z) : null
  const temp = o.isTemp ? o.isTemp(x, y, z) : false
  const kept = Boolean(task && (task.status === 'completed' || task.name === name))
  if (temp) cost = Math.min(cost, 1.2)
  else if (!kept) cost += 4.5
  if (kept) {
    if (o.allowKept === false) return null
    if (SENSITIVE_KEPT.test(name)) return null
    // Very high default penalty (450) so ender pearls (cost ~3), walking, swimming, and pillaring ALWAYS beat breaking finished build blocks!
    cost += (o.keptPenalty ?? 450) + (o.keptWeight ? o.keptWeight(x, y, z, b) : 0)
  }
  return { cost, kept, temp, name }
}

function flowFactor (view, fx, fy, fz, tx, ty, tz) {
  const a = view.cls(fx, fy, fz); const b = view.cls(tx, ty, tz)
  if (a.k !== 'water' || b.k !== 'water') return 1
  if (ty !== fy) {
    return (ty > fy && (b.level >= 8 || a.level >= 8)) ? 2.2 : 1
  }
  if (b.level > a.level) return 0.7
  if (b.level < a.level) return 1.8
  return 1
}

function* moves (view, n, cfg) {
  const { x, y, z } = n
  const maxDrop = cfg.maxDrop
  const feetWet = view.wet(x, y, z); const headWet = view.wet(x, y + 1, z)
  const wetHere = feetWet || headWet
  const hasFloor = view.floorOK(x, y - 1, z) || n.floorPlaced
  const here = view.cls(x, y, z)
  const climbHere = here.k === 'climb' || view.cls(x, y + 1, z).k === 'climb'
  const underBlock = view.cls(x, y - 1, z).b
  const underBottomSlab = Boolean(underBlock && /_slab$/.test(underBlock.name || '') && String(propsOf(underBlock).type) === 'bottom')
  const underSunken = !n.floorPlaced && Boolean((underBlock && SUNKEN_BLOCK.test(underBlock.name || '')) || (here.b && SUNKEN_BLOCK.test(here.b.name || '')))
  const valid = (tx, ty, tz) => {
    const f = view.cls(tx, ty, tz); const h = view.cls(tx, ty + 1, tz)
    if (!(f.k === 'air' || f.k === 'water' || f.k === 'climb' || f.k === 'door')) return false
    if (!(h.k === 'air' || h.k === 'water' || h.k === 'climb' || h.k === 'door')) return false
    if (f.k === 'water' || h.k === 'water' || f.k === 'climb' || h.k === 'climb') {
      return true
    }
    return view.floorOK(tx, ty - 1, tz)
  }
  const mediumCost = (tx, ty, tz) => {
    const f = view.cls(tx, ty, tz)
    if (f.k === 'water') return 1.7 * flowFactor(view, x, y, z, tx, ty, tz)
    if (f.k === 'climb') return 1.2
    if (f.k === 'door') return 1.4
    return 1
  }
  const diggable = list => {
    let cost = 0; const dig = []
    for (const [cx, cy, cz] of list) {
      const c = view.cls(cx, cy, cz)
      if (c.k === 'solid') {
        const d = digCost(view, cx, cy, cz)
        if (!d) return null
        cost += d.cost; dig.push({ x: cx, y: cy, z: cz, kept: Boolean(d.kept), temp: Boolean(d.temp), name: d.name })
      } else if (!(c.k === 'air' || c.k === 'water' || c.k === 'climb' || c.k === 'door')) return null
    }
    return { cost, dig }
  }
  const refFor = (px, py, pz, avoid) => {
    const c = view.cls(px, py, pz)
    if (!(c.k === 'air' || c.k === 'water')) return null
    const order = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
    for (const [dx, dy, dz] of order) {
      const rx = px + dx; const ry = py + dy; const rz = pz + dz
      if (avoid && avoid.some(a => a[0] === rx && a[1] === ry && a[2] === rz)) continue
      const isPlacedFloor = Boolean(n.floorPlaced && rx === x && ry === y - 1 && rz === z)
      if (isPlacedFloor || view.floorOK(rx, ry, rz) || (view.solid(rx, ry, rz) && !BODY_HAZARD.test(view.cls(rx, ry, rz).b.name))) return { ref: { x: rx, y: ry, z: rz }, face: [-dx, -dy, -dz] }
    }
    return null
  }
  const lavaIn = (px, py, pz) => view.cls(px, py, pz).k === 'lava'
  const fluidSourceIn = (px, py, pz) => {
    if (view.cls(px, py, pz).k !== 'water') return false
    const t = view.opts?.taskAt?.(px, py, pz)
    return Boolean(t && (t.kind === 'fluid' || t.kind === 'waterlog' || t.info?.waterlogged))
  }

  // 1) horizontal moves
  for (const [dx, dz] of DIRS) {
    const nx = x + dx; const nz = z + dz
    if (valid(nx, y, nz)) {
      yield { to: { x: nx, y, z: nz }, cost: mediumCost(nx, y, nz), type: wetHere || view.wet(nx, y, nz) ? 'swim' : (view.cls(nx, y, nz).k === 'climb' ? 'climb' : 'walk') }
    } else if (cfg.allowDig || cfg.allowPlace) {
      const f = view.cls(nx, y, nz); const h = view.cls(nx, y + 1, nz)
      const floorOk = view.floorOK(nx, y - 1, nz)
      if (cfg.allowDig && (f.k === 'solid' || h.k === 'solid')) {
        const d = diggable([[nx, y, nz], [nx, y + 1, nz]])
        if (d && floorOk) yield { to: { x: nx, y, z: nz }, cost: 1.2 + d.cost, type: 'dig', dig: d.dig }
        else if (d && cfg.allowPlace && hasFloor && !view.cls(nx, y - 1, nz).k.startsWith('lava') && view.cls(nx, y - 1, nz).k !== 'solid' && !lavaIn(nx, y - 1, nz) && !fluidSourceIn(nx, y - 1, nz)) {
          const r = { ref: { x, y: y - 1, z }, face: [dx, 0, dz] }
          yield { to: { x: nx, y, z: nz, floorPlaced: true }, cost: 1.2 + d.cost + 2.4, type: 'dig', dig: d.dig, place: { cell: { x: nx, y: y - 1, z: nz }, ...r } }
        }
      } else if (cfg.allowPlace && hasFloor && f.k !== 'solid' && h.k !== 'solid' && (f.k === 'air' || f.k === 'water') && (h.k === 'air' || h.k === 'water')) {
        const below = view.cls(nx, y - 1, nz)
        if ((below.k === 'air' || below.k === 'water' || below.k === 'lava') && !fluidSourceIn(nx, y - 1, nz)) {
          // Do not chain multi-block horizontal air bridges above a deep drop unless the bridge stays adjacent to a solid wall or spans water/lava/shallow gap
          const touchesWall = !n.floorPlaced || below.k !== 'air' || view.floorOK(nx, y - 2, nz) || view.floorOK(nx, y - 3, nz) || [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]].some(([wx, wz]) => view.solid(nx + wx, y - 1, nz + wz) || view.solid(nx + wx, y - 2, nz + wz))
          if (touchesWall && (!feetWet || view.floorOK(x, y - 1, z) || n.floorPlaced)) {
            yield { to: { x: nx, y, z: nz, floorPlaced: true }, cost: 2.4 + (below.k === 'lava' ? 7 : below.k === 'water' ? 0.4 : 0), type: 'bridge', place: { cell: { x: nx, y: y - 1, z: nz }, ref: { x, y: y - 1, z }, face: [dx, 0, dz] } }
          }
        }
      }
    }
    // step up one (works in dry air, 1-block water via horizontal wall-collision boost, and from 0.5m bottom slabs — NEVER from a sunken 0.875m chest or 0.6875m hopper where jumping onto y+1 is a >1.125m wall!)
    const headRoom = view.cls(x, y + 2, z)
    const destHeadRoom = view.cls(nx, y + 2, nz)
    const headOpen = (headRoom.k === 'air' || headRoom.k === 'water' || headRoom.k === 'climb' || headRoom.k === 'door') &&
      (!wetHere || destHeadRoom.k === 'air' || destHeadRoom.k === 'water' || destHeadRoom.k === 'climb')
    if (headOpen || (cfg.allowDig && headRoom.k === 'solid')) {
      if (!underSunken && headOpen && valid(nx, y + 1, nz) && view.floorOK(nx, y, nz)) {
        yield { to: { x: nx, y: y + 1, z: nz }, cost: 1.5 * (wetHere ? 1.4 : 1) * (view.wet(nx, y + 1, nz) ? 1.2 : 1), type: 'step' }
      } else if (cfg.allowDig || cfg.allowPlace) {
        const f = view.cls(nx, y + 1, nz); const h = view.cls(nx, y + 2, nz)
        const floorSolid = view.floorOK(nx, y, nz)
        if (cfg.allowDig && floorSolid && !underSunken && (f.k === 'solid' || h.k === 'solid' || !headOpen)) {
          const cells = [[nx, y + 1, nz], [nx, y + 2, nz]]
          if (headRoom.k === 'solid') cells.push([x, y + 2, z])
          const d = diggable(cells)
          if (d && d.dig.length) yield { to: { x: nx, y: y + 1, z: nz }, cost: 1.7 + d.cost, type: 'dig', dig: d.dig }
        }
        if (cfg.allowPlace && !underSunken && headOpen && (f.k === 'air' || f.k === 'water') && (h.k === 'air' || h.k === 'water') && !floorSolid && !lavaIn(nx, y, nz) && !fluidSourceIn(nx, y, nz)) {
          const r = refFor(nx, y, nz, [[x, y, z], [x, y + 1, z], [x, y - 1, z]])
          if (r) {
            yield { to: { x: nx, y: y + 1, z: nz, floorPlaced: true }, cost: 2.8, type: 'stair', place: { cell: { x: nx, y, z: nz }, ...r } }
          }
        }
      }
    }
    // drop down (or place a downward step block at y-2 / y-3 to descend >3-block cliffs safely!)
    if (hasFloor) {
      const topOk = (view.passable(nx, y, nz) && view.passable(nx, y + 1, nz)) && !(view.cls(nx, y, nz).k === 'water' && view.cls(nx, y - 1, nz).k === 'water')
      if (topOk && !valid(nx, y, nz)) {
        let dropped = false
        for (let k = 1; k <= maxDrop; k++) {
          const ty = y - k
          const c = view.cls(nx, ty, nz)
          if (c.k === 'lava' || c.k === 'hazard' || c.k === 'unknown') break
          if (!(c.k === 'air' || c.k === 'water' || c.k === 'climb')) break
          if (valid(nx, ty, nz) && (view.floorOK(nx, ty - 1, nz) || c.k === 'water')) {
            yield { to: { x: nx, y: ty, z: nz }, cost: 1.1 + 0.9 * k + (k >= 4 ? 3 * (k - 3) : 0) + (c.k === 'water' ? -0.3 : 0), type: 'drop', drop: k }
            dropped = true
            break
          }
        }
        if (!dropped && cfg.allowPlace && !feetWet) {
          for (const k of [1, 2]) {
            const ty = y - k
            const placeY = ty - 1
            if (view.cls(nx, ty, nz).k !== 'air' || view.cls(nx, ty + 1, nz).k !== 'air') break
            const pc = view.cls(nx, placeY, nz)
            if (pc.k !== 'air' && pc.k !== 'water') continue
            if (lavaIn(nx, placeY, nz) || fluidSourceIn(nx, placeY, nz)) continue
            const r = refFor(nx, placeY, nz, [[x, y, z], [x, y + 1, z], [x, y - 1, z], [x, placeY, z]])
            if (r) {
              yield { to: { x: nx, y: ty, z: nz, floorPlaced: true }, cost: 2.9 + k * 0.4, type: 'stair', place: { cell: { x: nx, y: placeY, z: nz }, ...r } }
              break
            }
          }
        }
      }
    }
  }
  // 2) vertical moves
  if (wetHere) {
    if (view.passable(x, y + 2, z) || view.wet(x, y + 2, z)) {
      if (valid(x, y + 1, z) && (view.wet(x, y + 1, z) || view.wet(x, y + 2, z))) yield { to: { x, y: y + 1, z }, cost: 1.2 * flowFactor(view, x, y, z, x, y + 1, z), type: 'swim' }
    }
    if (valid(x, y - 1, z) && view.wet(x, y - 1, z) !== undefined && (view.wet(x, y - 1, z) || view.wet(x, y, z))) yield { to: { x, y: y - 1, z }, cost: 1.0, type: 'swim' }
  }
  if (climbHere) {
    if (valid(x, y + 1, z) && view.passable(x, y + 2, z)) yield { to: { x, y: y + 1, z }, cost: 1.1, type: 'climb' }
    if (valid(x, y - 1, z)) yield { to: { x, y: y - 1, z }, cost: 0.9, type: 'climb' }
  }
  // 3) pillar up (in dry air, from sunken chests/hoppers, OR when standing on a bottom slab at (x,y,z) by breaking the bottom slab first so feet rest on the full block at y-1)
  const hereBottomSlab = Boolean(here.b && /_slab$/.test(here.b.name || '') && String(propsOf(here.b).type) === 'bottom')
  const shallowNonSourceWater = here.k === 'water' && !headWet && !fluidSourceIn(x, y, z)
  if (cfg.allowPlace && hasFloor && (here.k === 'air' || shallowNonSourceWater || (hereBottomSlab && cfg.allowDig)) && !underBottomSlab && !climbHere) {
    const room = view.cls(x, y + 2, z)
    const baseDig = hereBottomSlab ? [{ x, y, z, kept: true, temp: false, name: here.b.name }] : []
    const pillarCost = hereBottomSlab ? 6.5 : 2.4
    if ((room.k === 'air' || room.k === 'water') && view.passable(x, y + 1, z)) {
      yield { to: { x, y: y + 1, z, floorPlaced: true }, cost: pillarCost, type: 'pillar', ...(baseDig.length ? { dig: baseDig } : {}), place: { cell: { x, y, z }, ref: { x, y: y - 1, z }, face: [0, 1, 0] } }
    } else if (cfg.allowDig && room.k === 'solid') {
      const d = diggable([[x, y + 2, z]])
      if (d && d.dig.length) yield { to: { x, y: y + 1, z, floorPlaced: true }, cost: pillarCost + d.cost, type: 'pillar', dig: [...baseDig, ...d.dig], place: { cell: { x, y, z }, ref: { x, y: y - 1, z }, face: [0, 1, 0] } }
    }
  }
}

function validStart (view, s) {
  const f = view.cls(s.x, s.y, s.z); const h = view.cls(s.x, s.y + 1, s.z)
  return f.k !== 'unknown' && h.k !== 'unknown'
}

function flood (blockAt, start, opts = {}) {
  const view = makeView(blockAt, opts)
  const cfg = { maxDrop: opts.maxDrop ?? 1, allowDig: false, allowPlace: false }
  const s = { x: start.x, y: start.y, z: start.z }
  const seen = new Map([[key(s.x, s.y, s.z), s]])
  const q = [s]
  const budget = opts.budget ?? 700
  let open = false
  for (let i = 0; i < q.length; i++) {
    if (seen.size >= budget) { open = true; break }
    const n = q[i]
    for (const m of moves(view, n, cfg)) {
      const k = key(m.to.x, m.to.y, m.to.z)
      if (seen.has(k)) continue
      seen.set(k, m.to); q.push(m.to)
    }
  }
  return { cells: seen, open }
}

function planRoute (blockAt, start, isGoal, opts = {}) {
  const view = makeView(blockAt, opts)
  const cfg = { maxDrop: opts.maxDrop ?? 1, allowDig: opts.allowDig !== false, allowPlace: opts.allowPlace !== false }
  const R = opts.radius ?? 16; const UP = opts.up ?? 14; const DOWN = opts.down ?? 18
  const s = { x: start.x, y: start.y, z: start.z, floorPlaced: false }
  if (!validStart(view, s)) return null
  const sk = key(s.x, s.y, s.z)
  const dist = new Map([[sk, 0]]); const prev = new Map(); const nodes = new Map([[sk, s]])
  const heap = new Heap(); heap.push(0, sk)
  const done = new Set()
  const t0 = Date.now(); const maxMs = opts.maxMs ?? 400; let expansions = 0
  const penalty = opts.penalty || {}
  const blocked = opts.blocked || null
  const pearlsFrom = new Map()
  if (opts.pearls) {
    for (const p of opts.pearls) {
      const fk = p.from ? key(p.from.x, p.from.y, p.from.z) : sk
      if (!pearlsFrom.has(fk)) pearlsFrom.set(fk, [])
      pearlsFrom.get(fk).push(p)
    }
  }
  const consider = (fromKey, from, m) => {
    const tk = key(m.to.x, m.to.y, m.to.z)
    if (m.type !== 'pearl' && (Math.abs(m.to.x - s.x) > R || Math.abs(m.to.z - s.z) > R || m.to.y > s.y + UP || m.to.y < s.y - DOWN)) return
    const ek = `${fromKey}>${tk}|${m.type}`
    if (blocked && blocked.has(ek)) return
    const cost = dist.get(fromKey) + m.cost * (penalty[m.type] || 1)
    if (cost < (dist.has(tk) ? dist.get(tk) : Infinity)) {
      const h = typeof opts.heuristic === 'function' ? Math.max(0, Number(opts.heuristic(m.to)) || 0) : 0
      dist.set(tk, cost); prev.set(tk, { from: fromKey, move: m, ek }); nodes.set(tk, m.to); heap.push(cost + h, tk)
    }
  }
  if (pearlsFrom.has(sk)) {
    for (const p of pearlsFrom.get(sk)) consider(sk, s, { to: { x: p.x, y: p.y, z: p.z }, cost: p.cost ?? 3.5, type: 'pearl', pearl: p })
  }
  let found = null
  while (heap.size) {
    const [, k] = heap.pop()
    if (done.has(k)) continue
    const c = dist.get(k)
    if (c === undefined) continue
    done.add(k)
    const n = nodes.get(k)
    if (k !== sk && isGoal(n, view)) { found = k; break }
    if (++expansions % 400 === 0 && Date.now() - t0 > maxMs) break
    if (k !== sk && pearlsFrom.has(k)) {
      for (const p of pearlsFrom.get(k)) consider(k, n, { to: { x: p.x, y: p.y, z: p.z }, cost: p.cost ?? 3.5, type: 'pearl', pearl: p })
    }
    for (const m of moves(view, n, cfg)) consider(k, n, m)
  }
  if (!found) return { steps: null, expansions, ms: Date.now() - t0 }
  const steps = []
  for (let k = found; k !== sk;) { const p = prev.get(k); steps.push({ ...p.move, from: p.from, key: p.ek }); k = p.from }
  steps.reverse()
  const goal = nodes.get(found)
  return { steps, cost: dist.get(found), goal: { x: goal.x, y: goal.y, z: goal.z }, expansions, ms: Date.now() - t0, methods: summarize(steps) }
}

function summarize (steps) {
  const c = {}
  for (const st of steps) c[st.type] = (c[st.type] || 0) + 1
  const dug = steps.reduce((a, st) => a + (st.dig ? st.dig.length : 0), 0)
  const kept = steps.reduce((a, st) => a + (st.dig ? st.dig.filter(d => d.kept).length : 0), 0)
  return Object.entries(c).map(([t, n]) => `${t}x${n}`).join(' ') + (dug ? ` (dig ${dug}${kept ? `, ${kept} finished` : ''})` : '')
}

module.exports = { planRoute, flood, makeView, digCost, moves, summarize, key }
