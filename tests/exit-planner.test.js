'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { planRoute, flood } = require('../src/recovery/exit-planner')

// tiny world: map 'x,y,z' -> name; default air above y=0 floor? everything not listed is air
function world (cells, fill = 'air') {
  const m = new Map(Object.entries(cells))
  return (x, y, z) => {
    const n = m.get(`${x},${y},${z}`) ?? fill
    const solid = !/^(air|water|lava|ladder)$/.test(n)
    return { name: n, boundingBox: solid ? 'block' : 'empty', hardness: 1.5, metadata: 0, position: { x, y, z } }
  }
}
function box (cells, x0, y0, z0, x1, y1, z1, name) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) cells[`${x},${y},${z}`] = name }

// open ground at y<=0, a 3x3 pit (x,z in 0..2) 4 deep with walls
function pit (extra = {}) {
  const c = {}
  box(c, -8, -10, -8, 8, 0, 8, 'dirt') // ground, top at y=0, standing cells y=1
  box(c, 0, -3, 0, 2, 0, 2, 'air') // pit: floor y=-4 -> standing y=-3
  Object.assign(c, extra)
  return c
}
const goalOut = trapped => n => !n.floorPlaced && !trapped.has(`${n.x},${n.y},${n.z}`) && n.y >= 1

test('dry pit: pillar / stair out, never a pearl', () => {
  const bw = world(pit())
  const start = { x: 1, y: -3, z: 1 }
  const f = flood(bw, start)
  assert.equal(f.open, false)
  const r = planRoute(bw, start, goalOut(f.cells), {})
  assert.ok(r.steps, 'a way out exists')
  assert.ok(r.steps.some(s => s.type === 'pillar' || s.type === 'dig' || s.type === 'stair'))
  assert.ok(!r.steps.some(s => s.type === 'pearl'))
})

test('no placing, no digging: nothing found; with a pearl edge the pearl is used', () => {
  const bw = world(pit())
  const start = { x: 1, y: -3, z: 1 }
  const f = flood(bw, start)
  const r0 = planRoute(bw, start, goalOut(f.cells), { allowDig: false, allowPlace: false })
  assert.equal(r0.steps, null)
  const r1 = planRoute(bw, start, goalOut(f.cells), { allowDig: false, allowPlace: false, pearls: [{ x: 5, y: 1, z: 5, cost: 6 }] })
  assert.equal(r1.steps.length, 1)
  assert.equal(r1.steps[0].type, 'pearl')
})

test('ladder is used instead of building', () => {
  const c = pit()
  for (let y = -3; y <= 1; y++) c[`3,${y},1`] = y <= 0 ? 'dirt' : 'air'
  for (let y = -3; y <= 1; y++) c[`2,${y},1`] = 'ladder' // ladder column in pit cell x=2
  const bw = world(c)
  const start = { x: 1, y: -3, z: 1 }
  const r = planRoute(bw, start, n => n.y >= 1 && n.x >= 3, {})
  assert.ok(r.steps.some(s => s.type === 'climb'))
  assert.ok(!r.steps.some(s => s.type === 'pillar'))
})

test('water pit: swim up and out, no tools', () => {
  const c = pit()
  box(c, 0, -3, 0, 2, 0, 2, 'water') // water to the rim: surface cell y=0, rim standing cells y=1
  const bw = world(c)
  const start = { x: 1, y: -3, z: 1 }
  const f = flood(bw, start)
  const r = planRoute(bw, start, n => n.y >= 1 && (n.x > 2 || n.x < 0 || n.z > 2 || n.z < 0), { allowDig: false, allowPlace: false })
  assert.ok(r.steps, 'swims out')
  assert.ok(r.steps.every(s => ['swim', 'step', 'walk'].includes(s.type)))
})

test('enclosed kept room: digs the plain wall, not the observer wall', () => {
  const c = {}
  box(c, -6, -6, -6, 6, 6, 6, 'air')
  box(c, -6, -6, -6, 6, 0, 6, 'dirt')
  box(c, 0, 1, 0, 4, 4, 4, 'cobblestone') // block of finished cobble
  box(c, 1, 1, 1, 3, 3, 3, 'air') // hollow room
  c['0,1,2'] = 'observer'; c['0,2,2'] = 'observer' // west wall sensitive
  const tasks = new Set()
  for (const k of Object.keys(c)) if (c[k] === 'cobblestone' || c[k] === 'observer') tasks.add(k)
  const bw = world(c)
  const start = { x: 2, y: 1, z: 2 }
  const f = flood(bw, start)
  assert.equal(f.open, false)
  const r = planRoute(bw, start, goalOut(f.cells), { taskAt: (x, y, z) => (tasks.has(`${x},${y},${z}`) ? { status: 'completed' } : null) })
  assert.ok(r.steps)
  const dug = r.steps.flatMap(s => s.dig || [])
  assert.ok(dug.length >= 1)
  assert.ok(dug.every(d => d.name !== 'observer'))
  assert.ok(dug.every(d => d.kept))
})

test('lava behind a wall forbids digging it', () => {
  const c = {}
  box(c, -6, -6, -6, 6, 0, 6, 'dirt')
  box(c, 0, 1, 0, 4, 3, 4, 'stone'); box(c, 1, 1, 1, 3, 2, 3, 'air')
  box(c, 5, 1, 0, 5, 3, 4, 'lava') // east of the room is lava
  const bw = world(c)
  const start = { x: 2, y: 1, z: 2 }
  const f = flood(bw, start)
  const r = planRoute(bw, start, goalOut(f.cells), {})
  assert.ok(r.steps)
  assert.ok(!r.steps.flatMap(s => s.dig || []).some(d => d.x === 4))
})

test('flow: downstream path is chosen', () => {
  const c = {}
  box(c, -10, -3, -10, 10, 0, 10, 'dirt')
  box(c, -10, 1, -10, 10, 6, 10, 'air')
  // water channel 1 deep along x from 0..7, levels rise downstream; walls both sides
  const lv = {}
  for (let x = 0; x <= 7; x++) { c[`${x},0,0`] = 'water'; lv[`${x},0,0`] = x }
  const base = world(c)
  const bw = (x, y, z) => { const b = base(x, y, z); if (b.name === 'water') b.metadata = lv[`${x},${y},${z}`] ?? 0; return b }
  const down = planRoute(bw, { x: 3, y: 0, z: 0 }, n => n.x === 6, { allowDig: false, allowPlace: false })
  const up = planRoute(bw, { x: 3, y: 0, z: 0 }, n => n.x === 0, { allowDig: false, allowPlace: false })
  assert.ok(down.cost < up.cost)
})
