'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { createEngine } = require('./sim/harness')
const { BuildPlanner } = require('../src/planner/build-planner')

function plan (ctx, blocks, size) {
  const { bot, engine } = ctx
  const schematic = {
    size, start: () => new Vec3(0, 0, 0), end: () => size.offset(-1, -1, -1), tiles: new Map(),
    getBlock: p => { const b = blocks[`${p.x},${p.y},${p.z}`]; return b ? { name: b[0], properties: b[1] || {}, isAir: false, getProperties: () => ({ ...(b[1] || {}) }) } : { name: 'air', properties: {}, isAir: true, getProperties: () => ({}) } }
  }
  const world = { bot, blockAt: p => bot.blockAt(p) }
  return new BuildPlanner({ schematic }, { rotation: 0, origin: new Vec3(0, 64, 0), localToWorld: p => p.offset(0, 64, 0) }, world, engine.config, { info () {}, warn () {}, debug () {} }).build()
}

test('planner: floor first, fluids last, counts and material demand', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    const blocks = {
      '0,0,0': ['stone'], '1,0,0': ['stone'], '0,1,0': ['stone_bricks'], '1,1,0': ['stone_bricks'],
      '0,2,0': ['water', { level: '0' }]
    }
    const planner = plan(ctx, blocks, new Vec3(2, 3, 1))
    assert.equal(planner.total, 5)
    const order = []
    for (let i = 0; i < 5; i++) {
      const t = planner.next(ctx.bot.entity.position) || planner.nextCandidate(ctx.bot.entity.position)
      assert.ok(t, `task ${i}`)
      order.push(t.name)
      planner.markCompleted(t)
    }
    assert.equal(order[0], 'stone')
    assert.equal(order[order.length - 1], 'water')
    const demand = planner.getMaterialDemand()
    assert.equal(demand.get('stone'), 2)
    assert.equal(demand.get('stone_bricks'), 2)
  } finally { ctx.dispose() }
})

test('planner: a piston facing down is not ready until the block above it exists', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    const blocks = { '0,0,0': ['piston', { facing: 'down', extended: 'false' }], '0,1,0': ['stone'] }
    const planner = plan(ctx, blocks, new Vec3(1, 2, 1))
    const piston = [...planner.tasks.values()].find(t => t.name === 'piston')
    assert.equal(planner.isReady(piston), false)
    ctx.server.setBlock(new Vec3(0, 65, 0), 'stone')
    piston._rf = undefined; piston.info._rf = undefined
    assert.equal(planner.isReady(piston), true)
  } finally { ctx.dispose() }
})

test('planner: stats and persistence round-trip', async () => {
  const ctx = await createEngine()
  try {
    const planner = plan(ctx, { '0,0,0': ['stone'], '1,0,0': ['stone'] }, new Vec3(2, 1, 1))
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    const t = planner.next(ctx.bot.entity.position)
    t.attempts = 3
    ctx.server.setBlock(t.world, 'stone') // completion always comes from the real world, never from a saved flag
    const state = JSON.parse(JSON.stringify(planner.serialize()))
    const again = plan(ctx, { '0,0,0': ['stone'], '1,0,0': ['stone'] }, new Vec3(2, 1, 1))
    again.restore(state)
    assert.equal(again.getStats().completed, 1)
    assert.equal(again.tasks.get(t.key).status, 'completed')
    assert.equal(planner.getStats().total, 2)
  } finally { ctx.dispose() }
})

test('planner: bedrock is not part of the job; a missing block is swapped for the next one of its chain', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    const blocks = { '0,0,0': ['bedrock'], '1,0,0': ['bedrock'], '0,1,0': ['grass_block'], '1,1,0': ['grass_block'], '0,2,0': ['stone'] }
    const planner = plan(ctx, blocks, new Vec3(2, 3, 1))
    assert.equal(planner.total, 3) // bedrock left out
    assert.equal(planner.census.ignored.bedrock, 2)
    assert.equal(planner.getMaterialDemand().get('grass_block'), 2)
    assert.equal(planner.substituteItem('grass_block', 'dirt'), 2)
    const d = planner.getMaterialDemand()
    assert.equal(d.get('grass_block'), 0); assert.equal(d.get('dirt'), 2)
    const t = [...planner.tasks.values()].find(x => x.name === 'dirt')
    const { taskMatches } = require('../src/rules/blocks')
    assert.ok(taskMatches({ name: 'grass_block', getProperties: () => ({}) }, t)) // an existing grass block is fine
    assert.ok(taskMatches({ name: 'dirt', getProperties: () => ({}) }, t))
  } finally { ctx.dispose() }
})
