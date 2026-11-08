'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { plan, apply } = require('../src/planner/architect')
const { Vec3 } = require('../src/util/vec3')

function fake (cells) {
  const tasks = new Map(); const groups = new Map()
  for (const [x, y, z] of cells) {
    const t = { key: `${x},${y},${z}`, name: 'stone', kind: 'block', status: 'pending', order: y * 4, world: new Vec3(x, y, z), attempts: 0 }
    tasks.set(t.key, t)
    if (!groups.has(t.order)) groups.set(t.order, { remaining: 0, cells: new Map() })
    groups.get(t.order).remaining++
  }
  return { tasks, orderGroups: groups, census: { unsupported: [] }, config: { building: {} }, world: { blockAt: () => null }, getMaterialDemand: () => new Map([['stone', cells.length]]) }
}

test('architect sweeps a layer in stripes, layer by layer, and covers every block once', () => {
  const cells = []
  for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) cells.push([x, y, z])
  const p = fake(cells)
  const { sequence, report } = plan(p, { start: { x: 0, z: 0 } })
  assert.strictEqual(sequence.length, 128)
  assert.strictEqual(new Set(sequence.map(t => t.key)).size, 128)
  assert.ok(sequence.slice(0, 64).every(t => t.world.y === 0)) // layer 0 before layer 1
  // short walk: average step well below 2 blocks
  assert.ok(report.walkBlocks / 128 < 2)
  apply(p, sequence)
  assert.strictEqual(p.orderGroups.get(0).seqList.length, 64)
})
