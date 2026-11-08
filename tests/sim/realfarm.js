'use strict'
// Offline check on the real schematic: is the top of the farm unreachable on foot from the ground, and does the brain find a way up?
const path = require('path')
const Vec3 = require('vec3')
const { loadSchematic, buildTransform } = require('../../src/schematic/loader')
const { BuildPlanner } = require('../../src/planner/build-planner')
const { regionOf, planEntries, reachFrom, boundsOf } = require('../../src/navigation/brain')
const { solveThrow } = require('../../src/recovery/survival')
;(async () => {
  const bot = { version: '1.21.1', registry: require('minecraft-data')('1.21.1') }
  const reg = bot.registry
  const loaded = await loadSchematic(path.resolve(__dirname, '../../schematics/McDs 64 Module Cobblestone Wall Farm.litematic'), bot)
  const origin = new Vec3(26, -60, 188)
  const planner = new BuildPlanner(loaded, buildTransform(loaded.schematic, origin, 0), { blockAt: () => null }, require('../../config.json'), { info () {}, warn () {}, debug () {} }).build()
  const cells = new Map()
  for (const t of planner.tasks.values()) cells.set(`${t.world.x},${t.world.y},${t.world.z}`, t.name)
  console.log('tasks', cells.size)
  const cache = new Map()
  const blockAt = (x, y, z) => {
    if (y <= -61) return { name: 'grass_block', boundingBox: 'block' }
    const n = cells.get(`${x},${y},${z}`)
    if (!n || /^(air|cave_air)$/.test(n)) return { name: 'air', boundingBox: 'empty' }
    let b = cache.get(n); if (!b) { const d = reg.blocksByName[n]; b = { name: n, boundingBox: d ? d.boundingBox : 'block' }; cache.set(n, b) }
    return b
  }
  // pick a few high stands (door tasks etc.)
  const stands = [[81, -50, 230], [26, -46, 247], [64, -50, 228], [42, -53, 240]]
  for (const [x, y, z] of stands) {
    const r = regionOf(blockAt, { x, y, z }, 60000)
    if (!r) { console.log('stand', x, y, z, 'not a standing cell'); continue }
    { // why no ground pillar? look at the outer rim
      const free = (x, y, z) => { const b = blockAt(x, y, z); return b.boundingBox !== 'block' }
      const minX = Math.min(...[...r.cells.values()].map(c => c.x)); const maxX = Math.max(...[...r.cells.values()].map(c => c.x)); const minZ = Math.min(...[...r.cells.values()].map(c => c.z)); const maxZ = Math.max(...[...r.cells.values()].map(c => c.z))
      console.log('  region bbox', minX, maxX, minZ, maxZ)
      const rim = [...r.cells.values()].filter(c => c.x === minX || c.x === maxX || c.z === minZ || c.z === maxZ).sort((a, b) => b.y - a.y).slice(0, 3)
      for (const c of rim) { const col = []; for (let y = c.y + 2; y >= -61; y--) col.push(`${y}:${blockAt(c.x + (c.x === maxX ? 1 : c.x === minX ? -1 : 0), y, c.z + (c.z === maxZ ? 1 : c.z === minZ ? -1 : 0)).name}`); console.log('  rim', JSON.stringify(c), col.filter((_, i) => i % 3 === 0).join(' ')) }
    }
    if (x === 81) for (const z0 of [230]) { for (let yy = -42; yy >= -56; yy--) { let row = ''; for (let xx = 92; xx <= 102; xx++) { const n = blockAt(xx, yy, z0).name; row += (n === 'air' ? '.' : n[0].toUpperCase() === 'B' ? 'B' : n[0]) + (r.cells.has(`${xx},${yy},${z0}`) ? '*' : ' ') } console.log('  y' + yy, row) } }
    const bnd = boundsOf(r.cells, 36); const t0 = Date.now()
    const reach = reachFrom(blockAt, { x: 80, y: -60, z: 225 }, bnd)
    const plan = planEntries(blockAt, r.cells, { x: 80, y: -60, z: 225 }, { maxTower: 24, reach })
    const plan0 = planEntries(blockAt, r.cells, { x: 80, y: -60, z: 225 }, { maxTower: 24 }); const byBase = {}; for (const t of plan0.towers) byBase[t.base.y] = (byBase[t.base.y] || 0) + 1; console.log('  towers w/o reach by base y', JSON.stringify(byBase), 'ground cell in reach:', reach.has('80,-60,225'), 'sample reach ys', JSON.stringify([...reach.values()].slice(0, 3)))
    console.log('  reach', reach.size, 'cells in', Date.now() - t0, 'ms')
    const eye = { x: 80.5, y: -60 + 1.62, z: 225.5 }
    const pearl = plan.pearls.filter(c => Math.hypot(c.x - 80, c.z - 225) < 44 && Math.hypot(c.x - 80, c.z - 225) > 4).slice(0, 400).find(c => solveThrow(blockAt, eye, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }))
    const ys = {}; let solvable = 0; const sols = []
    for (const c of plan.pearls) { const d = Math.hypot(c.x - 80, c.z - 225); if (d > 44 || d < 4) continue; ys[c.y] = (ys[c.y] || 0) + 1 }
    for (const c of plan.pearls) { const d = Math.hypot(c.x - 80, c.z - 225); if (d > 44 || d < 4) continue; if (solveThrow(blockAt, eye, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 })) { solvable++; if (sols.length < 3) sols.push(`${c.x},${c.y},${c.z}`) } }
    console.log('  pearl cands by y', JSON.stringify(ys), 'solvable', solvable, sols.join(' | '))
    console.log(`stand ${x},${y},${z}: region ${r.cells.size} cells complete=${r.complete}; reaches ground(80,-60,225)=${r.cells.has('80,-60,225')}; towers=${plan.towers.length} best=${JSON.stringify(plan.towers[0] && { base: plan.towers[0].base, top: plan.towers[0].top, h: plan.towers[0].height })}; pearl landing=${pearl ? `${pearl.x},${pearl.y},${pearl.z}` : 'none'}`)
  }
})().catch(e => { console.error(e); process.exit(1) })
// ---- diagnostics
;(async () => {})()
