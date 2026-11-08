'use strict'
// High-end plan of a build for a fleet of workers: sizes, layers, materials, hard blocks, work split, time, risks.
// Used by `node scripts/analyze.js` (offline) and by the chat command !analyze (live).
const { Coordinator } = require('../fleet/coordinator')
const { isSweeperWorker } = require('../fleet/sweeper')

const CALIBRATION = 2.7
const BUCKET = { 'water (waterlogging)': 'water_bucket', water: 'water_bucket', lava: 'lava_bucket' }

function buildAnalysis (planner, sequence, report, { workers = 4, name = 'build', config = {}, registry = null } = {}) {
  const cfg = config
  const size = planner.schematic.size
  if (workers > 1 && !planner.fleet) planner.joinFleet(new Coordinator(workers), 'probe', 0, workers)
  const owner = t => (planner.fleet ? t.owner : 0)
  const tasks = [...planner.tasks.values()]
  const stackSize = label => {
    const item = BUCKET[label] || label
    const n = Number(registry?.itemsByName?.[item]?.stackSize)
    return Number.isFinite(n) && n > 0 ? n : 64
  }

  const byName = new Map(); const byLayer = new Map()
  for (const t of tasks) {
    const label = t.kind === 'waterlog' ? 'water (waterlogging)' : t.name
    byName.set(label, (byName.get(label) || 0) + 1)
    const row = byLayer.get(t.layer) || { total: 0, names: new Map() }
    row.total++; row.names.set(t.name, (row.names.get(t.name) || 0) + 1); byLayer.set(t.layer, row)
  }
  const mats = [...byName.entries()].sort((a, b) => b[1] - a[1])
  const count = re => tasks.filter(t => re.test(t.name)).length
  const special = {
    pistons: count(/piston/), observers: count(/^observer$/), hoppers: count(/^hopper$/), rails: count(/rail$/), redstone: count(/redstone|comparator|repeater|lever|button/),
    fluids: tasks.filter(t => t.kind === 'fluid').length, waterlogged: tasks.filter(t => t.kind === 'waterlog').length,
    lanterns: count(/^(lantern|soul_lantern)$/), trapdoorsDoors: count(/trapdoor|_door$|fence_gate/), tnt: count(/^tnt$/), signsBanners: count(/sign|banner/),
    orientationSensitive: tasks.filter(t => t.properties && (t.properties.facing || t.properties.axis || t.properties.half || t.properties.shape)).length,
    powerPhase: tasks.filter(t => t.info?.phase === 3).length
  }
  const layers = [...byLayer.entries()].sort((a, b) => a[0] - b[0]).map(([y, row]) => ({ y, blocks: row.total, top: [...row.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, c]) => `${n} ${c}`).join(', ') }))

  const speed = Number(cfg.building?.speed || 1)
  const placeSec = Math.max(1 / Math.max(0.5, Number(cfg.fleet?.perBotPlacementsPerSecond ?? cfg.building?.maxPlacementsPerSecond ?? 4)), 3.5 / Math.sqrt(speed))
  const per = Array.from({ length: workers }, () => ({ blocks: 0, walk: 0, prev: null, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity }))
  for (const t of sequence) {
    const w = per[Math.min(workers - 1, owner(t))]
    w.blocks++
    if (w.prev) w.walk += Math.hypot(t.world.x - w.prev.world.x, t.world.z - w.prev.world.z) + Math.abs(t.world.y - w.prev.world.y)
    w.prev = t
    w.minX = Math.min(w.minX, t.world.x); w.maxX = Math.max(w.maxX, t.world.x); w.minZ = Math.min(w.minZ, t.world.z); w.maxZ = Math.max(w.maxZ, t.world.z)
  }
  for (const w of per) w.minutes = Math.round((w.blocks * placeSec + w.walk * 0.25 / speed) / 60)
  const solo = report.estimatedMinutes
  const fleet = Math.round(Math.max(...per.map(w => w.minutes)) * 1.15)
  const out = {
    schematic: name, size: { x: size.x, y: size.y, z: size.z }, blocks: tasks.length, workers, layerSteps: report.layers, pieces: report.pieces,
    floating: report.floating, soil: report.soilProblems, warnings: report.warnings, special, materials: mats, layers,
    estimate: { soloPlannerMin: solo, fleetPlannerMin: fleet, soloCalibratedMin: Math.round(solo * CALIBRATION), fleetCalibratedMin: Math.round(fleet * CALIBRATION), calibration: CALIBRATION },
    perWorker: per.map((w, i) => ({
      worker: i + 1,
      blocks: w.blocks,
      walkBlocks: Math.round(w.walk),
      plannerMin: w.minutes,
      area: w.blocks === 0 || isSweeperWorker(i, workers, cfg)
        ? 'Sweeper / Janitor (all zones)'
        : `x ${w.minX}..${w.maxX}, z ${w.minZ}..${w.maxZ}`
    }))
  }

  const h = n => `${Math.floor(n / 60)} h ${n % 60} min`
  const risks = []
  if (special.tnt) risks.push(`${special.tnt} TNT: the bots pause before the power blocks; check the build, then !resume`)
  if (special.fluids + special.waterlogged > 200) risks.push(`${special.fluids + special.waterlogged} water/lava placements, one bucket each (buckets do not stack)`)
  if (special.orientationSensitive > 500) risks.push(`${special.orientationSensitive} orientation-sensitive blocks (pistons, observers, hoppers, rails): verify with !verify`)
  if (special.observers) risks.push(`${special.observers} observers are placed after all structure/fluids (so they do not fire early) and before the power blocks`)
  {
    const has = (x, y, z) => planner.tasks.has(`${x},${y},${z}`)
    let edge = 0
    for (const t of tasks) {
      if (t.kind !== 'fluid') continue
      const { x, y, z } = t.world
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
        const b = planner.world.blockAt({ x: x + dx, y: y + dy, z: z + dz })
        if (!has(x + dx, y + dy, z + dz) && b && /^(air|cave_air)$/.test(b.name) && !planner.schematic.getBlock?.(planner.transform.worldToLocal?.({ x: x + dx, y: y + dy, z: z + dz }) || { x: 1e9, y: 1e9, z: 1e9 })) { edge++; break }
      }
    }
    if (edge) risks.push(`${edge} fluid sources touch open air outside the schematic: they may spill. Check the edges after pouring`)
  }
  if (out.floating) risks.push(`${out.floating} blocks without a neighbour need scaffold blocks`)
  if (special.lanterns) risks.push(`${special.lanterns} lanterns: hanging ones get their support first`)
  const L = []
  L.push(`# Build analysis: ${name}`, '')
  L.push(`- Size ${size.x} x ${size.y} x ${size.z}, ${out.blocks.toLocaleString()} blocks, ${out.layerSteps} layer steps, ${out.pieces} pieces`, '')
  L.push('## Time', '', `| Setup | Planner estimate | Calibrated guess (x${CALIBRATION}) |`, '|---|---|---|')
  L.push(`| 1 bot | ${h(solo)} | ${h(out.estimate.soloCalibratedMin)} |`, `| ${workers} bots | ${h(fleet)} | ${h(out.estimate.fleetCalibratedMin)} |`, '')
  L.push('## Work split', '', '| Worker | Blocks | Walking | Planner min | Area |', '|---|---|---|---|---|')
  for (const w of out.perWorker) L.push(`| BuilderBot${w.worker} | ${w.blocks} | ${w.walkBlocks} | ${w.plannerMin} | ${w.area} |`)
  L.push('', '## Materials', '', '| Item | Count | Stacks | Shulker boxes |', '|---|---|---|---|')
  for (const [n, c] of mats.slice(0, 40)) { const ss = stackSize(n); const st = Math.ceil(c / ss); L.push(`| ${n} | ${c} | ${st}${ss < 64 ? ` (stack ${ss})` : ''} | ${(st / 27).toFixed(1)} |`) }
  L.push('', '## Special blocks', '')
  for (const [k, v] of Object.entries(special)) L.push(`- ${k}: ${v}`)
  L.push('', '## Risks', '')
  for (const r of risks) L.push(`- ${r}`)
  for (const w of out.warnings) L.push(`- ${w}`)
  L.push('', '## Layers', '', '| y | Blocks | Main blocks |', '|---|---|---|')
  for (const l of layers) L.push(`| ${l.y} | ${l.blocks} | ${l.top} |`)
  return { out, markdown: L.join('\n') + '\n', risks }
}

module.exports = { buildAnalysis }
