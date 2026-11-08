'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { regionOf, planEntries, makeGraph } = require('../src/navigation/brain')
const { solveThrow } = require('../src/recovery/survival')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
// flat ground (solid up to y=-61), a solid block "farm" x 20..60, z 20..60, y -60..-52 (roof top surface at y=-51 feet)
const farm = (x, y, z) => {
  if (y <= -61) return STONE
  if (x >= 20 && x <= 60 && z >= 20 && z <= 60 && y <= -52) return STONE
  return AIR
}

test('walk graph: roof stand is NOT reachable from the ground (wall too high)', () => {
  const stand = { x: 40, y: -51, z: 40 }
  const r = regionOf(farm, stand, 20000)
  assert.ok(r && r.complete, 'region of a roof is finite')
  assert.ok(r.cells.has('40,-51,40'))
  assert.ok(!r.cells.has('10,-60,10'), 'ground is not in the roof region')
})

test('walk graph: a stair makes it reachable', () => {
  const withStair = (x, y, z) => (x === 61 && z === 40 && y <= -60 + (61 - 61) ? STONE : farm(x, y, z))
  const stairs = (x, y, z) => {
    const f = farm(x, y, z)
    if (f !== AIR) return f
    // steps going up beside the east wall: x=61..69 height rises toward the wall
    if (z === 40 && x >= 61 && x <= 69 && y <= -61 + (70 - x)) return STONE
    return AIR
  }
  void withStair
  const r = regionOf(stairs, { x: 40, y: -51, z: 40 }, 30000)
  assert.ok(r.cells.has('70,-60,40'), 'bottom of the stair can reach the roof')
})

test('brain plans pearl landings and pillar sites for a roof stand', () => {
  const r = regionOf(farm, { x: 40, y: -51, z: 40 }, 20000)
  const plan = planEntries(farm, r.cells, { x: 15, y: -60, z: 40 }, { maxTower: 24 })
  assert.ok(plan.towers.length > 0, 'pillar sites exist along the roof edge')
  const t = plan.towers[0]
  assert.equal(t.top.y, -51)
  assert.equal(t.height, 9)
  assert.equal(t.base.y, -60)
  assert.ok(plan.pearls.length > 0)
  // some roof cell must be throwable from the ground in front of the wall
  const eye = { x: 12.5, y: -60 + 1.62, z: 40.5 }
  const ok = plan.pearls.filter(c => c.x <= 40).some(c => solveThrow(farm, eye, { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }))
  assert.ok(ok, 'an ender pearl can reach the roof')
})

test('performance: region search on open ground stays bounded', () => {
  const t0 = Date.now()
  const r = regionOf((x, y) => (y <= -61 ? STONE : AIR), { x: 0, y: -60, z: 0 }, 30000)
  assert.equal(r.complete, false)
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`)
})

test('graph: hazards and fences are not standing cells', () => {
  const g = makeGraph((x, y, z) => (y <= -61 ? { name: 'oak_fence', boundingBox: 'block' } : AIR))
  assert.equal(g.walkable(0, -60, 0), false)
})
