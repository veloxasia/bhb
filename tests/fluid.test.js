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

test('fluid check: a pour that would flood an unbuilt wall block waits until the wall stands', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 64, 8), 'stone') // floor under the cells of layer 1
    const blocks = { '2,1,1': ['water', { level: '0' }], '1,1,1': ['stone'], '3,1,1': ['stone'], '2,1,2': ['stone'], '2,1,0': ['stone'] }
    const planner = plan(ctx, blocks, new Vec3(5, 2, 3))
    const water = [...planner.tasks.values()].find(t => t.name === 'water')
    assert.ok(planner.fluidCells.get('2,65,1') === 'water')
    assert.equal(planner.fluidCheck(water).blocked, true)
    for (const t of planner.tasks.values()) if (t.kind === 'block') ctx.server.fillBox(t.world, t.world, 'stone')
    water._fc = null
    assert.equal(planner.fluidCheck(water).blocked, false)
  } finally { ctx.dispose() }
})

test('fluid check: a pour whose channel is open to a cell the design keeps empty is blocked', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 64, 8), 'stone')
    const blocks = { '2,1,1': ['water', { level: '0' }], '1,1,1': ['stone'], '3,1,1': ['stone'], '2,1,2': ['stone'] }
    const planner = plan(ctx, blocks, new Vec3(5, 2, 3))
    const water = [...planner.tasks.values()].find(t => t.name === 'water')
    for (const t of planner.tasks.values()) if (t.kind === 'block') ctx.server.fillBox(t.world, t.world, 'stone')
    water._fc = null
    assert.equal(planner.fluidCheck(water).blocked, true) // z=0 side is open air the design never closes
    ctx.server.fillBox(new Vec3(2, 65, 0), new Vec3(2, 65, 0), 'stone')
    planner.isTempCell = (x, y, z) => x === 2 && y === 65 && z === 0
    water._fc = null
    assert.equal(planner.fluidCheck(water).blocked, true) // a scaffold block is no wall
  } finally { ctx.dispose() }
})

test('fluid check: a solid block the design does not contain (any bot\'s scaffold) is not a wall', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 64, 8), 'stone')
    const blocks = { '2,1,1': ['water', { level: '0' }], '1,1,1': ['stone'], '3,1,1': ['stone'], '2,1,2': ['stone'] }
    const planner = plan(ctx, blocks, new Vec3(5, 2, 3))
    const water = [...planner.tasks.values()].find(t => t.name === 'water')
    for (const t of planner.tasks.values()) if (t.kind === 'block') ctx.server.fillBox(t.world, t.world, 'stone')
    ctx.server.fillBox(new Vec3(2, 65, 0), new Vec3(2, 65, 0), 'cobblestone') // placed by the other bot, not in this bot's ledger
    water._fc = null
    assert.equal(planner.fluidCheck(water).blocked, true)
  } finally { ctx.dispose() }
})
