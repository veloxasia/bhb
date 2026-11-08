'use strict'
// The "architect": looks at the whole schematic BEFORE the first block is placed and decides the order.
// It works layer by layer (the planner's order groups: ground first, then walls, fluids, power last). Inside a
// layer it cuts the work into separate pieces (rooms / islands), visits them nearest-first and sweeps each
// piece in 1-block-wide snake rows ordered via a support-aware wavefront so every block that leans on a
// horizontal neighbour in the same layer is placed AFTER its anchor block and no 1-block-wide trenches are left behind.

const { SchematicIntelligence } = require('./intelligence')

const SOIL = /^(dirt|grass_block|podzol|coarse_dirt|rooted_dirt|moss_block|mud|muddy_mangrove_roots|farmland|dirt_path)$/
const NEEDS_SOIL = /(sapling|propagule|_tulip|poppy|dandelion|orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|torchflower|pink_petals|wither_rose|sunflower|lilac|rose_bush|peony|short_grass|^grass$|tall_grass|fern|large_fern)$/
const CROP = /^(wheat|carrots|potatoes|beetroots)$/
const N6 = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]

function components (tasks) {
  const byXZ = new Map()
  for (const t of tasks) {
    const k = `${t.world.x},${t.world.z}`
    if (!byXZ.has(k)) byXZ.set(k, [])
    byXZ.get(k).push(t)
  }
  const seen = new Set(); const out = []
  for (const k of byXZ.keys()) {
    if (seen.has(k)) continue
    const stack = [k]; seen.add(k); const comp = []
    while (stack.length) {
      const cur = stack.pop()
      comp.push(...byXZ.get(cur))
      const [x, z] = cur.split(',').map(Number)
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        const n = `${x + dx},${z + dz}`
        if (byXZ.has(n) && !seen.has(n)) { seen.add(n); stack.push(n) }
      }
    }
    out.push(comp)
  }
  return out
}

const centroid = comp => {
  let x = 0; let z = 0
  for (const t of comp) { x += t.world.x; z += t.world.z }
  return { x: x / comp.length, z: z / comp.length }
}

function sweep (comp, start, stripe, supportedKeys = null) {
  const VEC_DIR = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
  if (comp.length > 1 && comp.every(t => /^(chest|trapped_chest)$/.test(t.name) && (t.properties?.type === 'left' || t.properties?.type === 'right') && t.properties?.facing)) {
    const fv = VEC_DIR[comp[0].properties.facing]
    if (fv) {
      const sortedChests = comp.slice().sort((p, q) =>
        ((p.world.x - q.world.x) * fv[0] + (p.world.z - q.world.z) * fv[1]) ||
        (p.world.x - q.world.x) ||
        (p.world.z - q.world.z) ||
        (p.world.y - q.world.y)
      )
      if (supportedKeys) {
        for (const t of sortedChests) {
          if (t.kind === 'block' && !t.info?.fragile) supportedKeys.add(`${t.world.x},${t.world.y},${t.world.z}`)
        }
      }
      return sortedChests
    }
  }
  // Always use 1-block-wide snake rows (`effStripe = 1`) so bots sweep row-by-row like a human builder
  // and never walk down the middle of a multi-row stripe leaving 1-block-wide trenches!
  const effStripe = 1
  const minZ = Math.min(...comp.map(t => t.world.z))
  const maxZ = Math.max(...comp.map(t => t.world.z))
  const minX = Math.min(...comp.map(t => t.world.x))
  const maxX = Math.max(...comp.map(t => t.world.x))
  const alongX = (maxX - minX) >= (maxZ - minZ) // run the long way
  const A = t => (alongX ? t.world.x : t.world.z)
  const B = t => (alongX ? t.world.z : t.world.x)
  const bMin = alongX ? minZ : minX
  const bMax = alongX ? maxZ : maxX
  const hasSupport = supportedKeys
    ? t => N6.some(([dx, dy, dz]) => supportedKeys.has(`${t.world.x + dx},${t.world.y + dy},${t.world.z + dz}`))
    : null
  // Start at the corner/end that already has support in `supportedKeys` (or nearest to `start` if all/none are supported)
  let anchor = start
  if (hasSupport) {
    const seeded = comp.filter(hasSupport)
    if (seeded.length > 0 && seeded.length < comp.length) {
      anchor = centroid(seeded)
    }
  }
  const farFirst = Math.abs(B({ world: { x: anchor.x, z: anchor.z } }) - bMax) <= Math.abs(B({ world: { x: anchor.x, z: anchor.z } }) - bMin)
  const stripes = new Map()
  for (const t of comp) {
    const s = Math.floor((B(t) - bMin) / effStripe)
    if (!stripes.has(s)) stripes.set(s, [])
    stripes.get(s).push(t)
  }
  const keys = [...stripes.keys()].sort((a, b) => (farFirst ? b - a : a - b))
  const aStart = A({ world: { x: anchor.x, z: anchor.z } })
  let forward = Math.abs(aStart - (alongX ? minX : minZ)) < Math.abs(aStart - (alongX ? maxX : maxZ))
  const baseOrder = []
  for (const k of keys) {
    const rawRow = stripes.get(k)
    const chestFacing = rawRow.length > 1 && rawRow.every(t => /^(chest|trapped_chest)$/.test(t.name) && (t.properties?.type === 'left' || t.properties?.type === 'right') && t.properties?.facing)
      ? rawRow[0].properties.facing
      : null
    const fv = chestFacing ? VEC_DIR[chestFacing] : null
    const row = fv
      ? rawRow.sort((p, q) => ((p.world.x - q.world.x) * fv[0] + (p.world.z - q.world.z) * fv[1]) || p.world.y - q.world.y)
      : rawRow.sort((p, q) => (forward ? A(p) - A(q) : A(q) - A(p)) || B(p) - B(q) || p.world.y - q.world.y)
    baseOrder.push(...row)
    forward = !forward
  }
  if (!supportedKeys) return baseOrder
  // Support-aware + 1-wide snake row ordering: prefer blocks that already have an adjacent reference block in supportedKeys,
  // preserving the 1-wide snake row order as the primary order so walking stays 100% contiguous!
  const remaining = new Set(baseOrder)
  const out = []
  while (remaining.size) {
    let progressed = false
    for (const t of baseOrder) {
      if (!remaining.has(t)) continue
      if (hasSupport(t)) {
        remaining.delete(t)
        out.push(t)
        if (t.kind === 'block' && !t.info?.fragile) supportedKeys.add(`${t.world.x},${t.world.y},${t.world.z}`)
        progressed = true
      }
    }
    if (!progressed) {
      for (const t of baseOrder) {
        if (!remaining.has(t)) continue
        remaining.delete(t)
        out.push(t)
        if (t.kind === 'block' && !t.info?.fragile) supportedKeys.add(`${t.world.x},${t.world.y},${t.world.z}`)
        break
      }
    }
  }
  return out
}

// returns { sequence: [task...], report }
function plan (planner, options = {}) {
  if (planner && !planner.intelligenceSummary) {
    try { new SchematicIntelligence(planner).analyze() } catch {}
  }
  const stripe = 1
  const groups = new Map()
  for (const t of planner.tasks.values()) {
    if (!groups.has(t.order)) groups.set(t.order, [])
    groups.get(t.order).push(t)
  }
  const orders = [...groups.keys()].sort((a, b) => a - b)
  let pos = options.start || { x: 0, z: 0 }
  const sequence = []
  const layers = []
  const supportedKeys = new Set()
  if (planner.world?.blockAt) {
    const seenCheck = new Set()
    for (const t of planner.tasks.values()) {
      for (const [dx, dy, dz] of N6) {
        const nx = t.world.x + dx; const ny = t.world.y + dy; const nz = t.world.z + dz
        const nk = `${nx},${ny},${nz}`
        if (seenCheck.has(nk) || planner.tasks.has(nk)) continue
        seenCheck.add(nk)
        const b = planner.world.blockAt({ x: nx, y: ny, z: nz })
        if (b && b.boundingBox === 'block') supportedKeys.add(nk)
      }
    }
  }
  for (const order of orders) {
    const tasks = groups.get(order)
    if (tasks.some(t => t.verticalClusterSeq != null)) {
      const ordered = tasks.slice().sort((a, b) => (a.verticalClusterSeq ?? 0) - (b.verticalClusterSeq ?? 0))
      for (const t of ordered) {
        if (t.kind === 'block' && !t.info?.fragile) supportedKeys.add(`${t.world.x},${t.world.y},${t.world.z}`)
      }
      if (ordered.length) {
        const last = ordered[ordered.length - 1]
        pos = { x: last.world.x, z: last.world.z }
      }
      ordered.forEach((t, i) => { t.seq = sequence.length + i })
      sequence.push(...ordered)
      layers.push({ order, tasks: tasks.length, pieces: 1 })
      continue
    }
    const comps = components(tasks)
    const todo = comps.slice()
    const ordered = []
    while (todo.length) {
      let bi = 0; let bd = Infinity
      todo.forEach((c, i) => { const m = centroid(c); const d = Math.hypot(m.x - pos.x, m.z - pos.z); if (d < bd) { bd = d; bi = i } })
      const comp = todo.splice(bi, 1)[0]
      const run = sweep(comp, pos, stripe, supportedKeys)
      ordered.push(...run)
      const last = run[run.length - 1]
      pos = { x: last.world.x, z: last.world.z }
    }
    ordered.forEach((t, i) => { t.seq = sequence.length + i })
    sequence.push(...ordered)
    layers.push({ order, tasks: tasks.length, pieces: comps.length })
  }
  return { sequence, report: analyze(planner, layers, sequence) }
}

function analyze (planner, layers, sequence) {
  const warnings = []
  const at = (x, y, z) => planner.tasks.get(`${x},${y},${z}`)
  let floating = 0; let soil = 0; let walk = 0
  let prev = null
  for (const t of sequence) {
    if (prev) walk += Math.hypot(t.world.x - prev.world.x, t.world.z - prev.world.z) + Math.abs(t.world.y - prev.world.y)
    prev = t
    if (t.kind !== 'block') continue
    const b = at(t.world.x, t.world.y - 1, t.world.z)
    if (NEEDS_SOIL.test(t.name) || CROP.test(t.name)) {
      if (!b || !(CROP.test(t.name) ? b.name === 'farmland' : SOIL.test(b.name))) {
        const world = planner.world.blockAt({ x: t.world.x, y: t.world.y - 1, z: t.world.z })
        if (!b && world && (CROP.test(t.name) ? world.name === 'farmland' : SOIL.test(world.name))) continue
        soil++
        if (soil <= 5) warnings.push(`${t.name} at ${t.world.x},${t.world.y},${t.world.z} has no soil under it in the schematic (it will be skipped)`)
      }
    }
    const neighbours = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]]
    if (!neighbours.some(([dx, dy, dz]) => at(t.world.x + dx, t.world.y + dy, t.world.z + dz))) floating++
  }
  if (floating) warnings.push(`${floating} blocks have no neighbour block in the schematic (they will need scaffold/reference blocks)`)
  const unsupported = planner.census.unsupported.length
  if (unsupported) warnings.push(`${unsupported} blocks are not supported by this builder and will be reported`)
  const total = sequence.length
  const speed = Number(planner.config.building?.speed || 1)
  const placeSec = Math.max(1 / Math.max(0.5, Number(planner.config.building?.maxPlacementsPerSecond || 4)), 3.5 / Math.sqrt(speed))
  const minutes = Math.round((total * placeSec + walk * 0.25 / speed) / 60)
  return {
    tasks: total,
    layers: layers.length,
    pieces: layers.reduce((a, l) => a + l.pieces, 0),
    walkBlocks: Math.round(walk),
    estimatedMinutes: minutes,
    floating,
    soilProblems: soil,
    intelligence: planner.intelligenceSummary || null,
    warnings,
    materials: [...planner.getMaterialDemand().entries()].sort((a, b) => b[1] - a[1])
  }
}

// make the planner follow the sequence: per order group a list sorted by seq
function apply (planner, sequence) {
  for (const group of planner.orderGroups.values()) {
    if (!group.isVerticalWallBand && !group.isModuleClusterBase) group.seqList = []
  }
  for (const t of sequence) {
    const g = planner.orderGroups.get(t.order)
    if (g && !g.isVerticalWallBand && !g.isModuleClusterBase) g.seqList.push(t)
  }
  for (const group of planner.orderGroups.values()) {
    if (group.seqList) {
      group.seqList.sort((a, b) => a.seq - b.seq)
      group.seqPtr = 0
    }
  }
  planner.architectActive = true
}

module.exports = { plan, apply, analyze, components, sweep }
