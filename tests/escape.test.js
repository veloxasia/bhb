'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { isEnclosed, planExit } = require('../src/recovery/escape')

// fake world: floor at y=-1, solid blocks listed by "x,y,z"
function fakeBot (solids) {
  const set = new Set(solids)
  return {
    entity: { position: new Vec3(0.5, 0, 0.5) },
    blockAt: p => (p.y <= -1 || set.has(`${p.x},${p.y},${p.z}`) ? { boundingBox: 'block', name: 'stone' } : { boundingBox: 'empty', name: 'air' })
  }
}
const ring = (extra = []) => {
  const out = [...extra]
  for (const y of [0, 1]) for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push(`${x},${y},${z}`)
  out.push('0,2,0') // ceiling: no tower possible
  return out
}

test('escape: a pit with walls on 4 sides and a ceiling counts as walled in and gets a tunnel plan', () => {
  const bot = fakeBot(ring())
  assert.equal(isEnclosed(bot), true)
  const plan = planExit(bot, null)
  assert.ok(plan && plan.dig.length === 2 && plan.k === 2, JSON.stringify(plan))
})

test('escape: an open side means not enclosed', () => {
  const solids = ring().filter(s => s !== '0,0,1' && s !== '0,1,1')
  assert.equal(isEnclosed(fakeBot(solids)), false)
})

test('escape: prefers digging temporary blocks over finished schematic blocks', () => {
  const bot = fakeBot(ring())
  const planner = { tasks: new Map([['1,0,0', { status: 'completed' }], ['1,1,0', { status: 'completed' }], ['-1,0,0', { status: 'completed' }], ['-1,1,0', { status: 'completed' }], ['0,0,1', { status: 'completed' }], ['0,1,1', { status: 'completed' }]]) }
  const plan = planExit(bot, planner)
  assert.equal(plan.dx, 0); assert.equal(plan.dz, -1) // only the north wall is not part of the build
})
