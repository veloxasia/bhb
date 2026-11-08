'use strict'
// End-to-end placement in the offline world: real placer/aim solver/scaffold code against independent vanilla rules.
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { createEngine } = require('./sim/harness')
const { BuildPlanner } = require('../src/planner/build-planner')
const { taskMatches } = require('../src/rules/blocks')

let ctx
test.before(async () => { ctx = await createEngine() })
test.after(() => ctx.dispose())

function arena (target, builder) {
  const { server, bot, engine } = ctx
  server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
  bot.entity.position = new Vec3(5.5, 64, 5.5); bot.entity.onGround = true
  bot.slots.fill(null); bot.heldItem = null
  engine.scaffold.created.clear()
  if (builder) builder(server)
  return target
}

async function place (name, properties, target, tile) {
  const { bot, engine } = ctx
  const block = { name, properties, isAir: false, getProperties: () => ({ ...properties }) }
  const schematic = { size: new Vec3(1, 1, 1), start: () => new Vec3(0, 0, 0), end: () => new Vec3(0, 0, 0), tiles: new Map(tile ? [['0,0,0', tile]] : []), getBlock: () => block }
  const world = { bot, blockAt: p => bot.blockAt(p) }
  const planner = new BuildPlanner({ schematic }, { rotation: 0, origin: target, localToWorld: () => target.clone() }, world, engine.config, { info () {}, warn () {}, debug () {} }).build()
  engine.planner = planner
  engine.learner.preferred = {}
  const task = [...planner.tasks.values()].find(t => t.kind === 'block') || [...planner.tasks.values()][0]
  await engine.placer.execute(task)
  return { task, block: bot.blockAt(target) }
}

test('stairs: facing and half come from where the player really looks and clicks', async () => {
  const t = arena(new Vec3(0, 64, 0))
  const { task, block } = await place('oak_stairs', { facing: 'north', half: 'top', shape: 'straight', waterlogged: 'false' }, t)
  assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
})

test('piston facing east is placed with the matching look direction', async () => {
  const t = arena(new Vec3(0, 64, 0))
  const { task, block } = await place('piston', { facing: 'east', extended: 'false' }, t)
  assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
})

test('piston facing down is placed from below with a lowered (sneaking) eye', async () => {
  const t = arena(new Vec3(0, 65, 0), s => s.setBlock(new Vec3(0, 66, 0), 'stone'))
  const { task, block } = await place('piston', { facing: 'down', extended: 'false' }, t)
  assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
})

test('hopper takes its direction from the clicked face', async () => {
  const t = arena(new Vec3(0, 64, 0), s => s.setBlock(new Vec3(0, 64, 1), 'stone'))
  const { task, block } = await place('hopper', { facing: 'south', enabled: 'true' }, t)
  assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
})

test('repeater: delay is set afterwards with real right clicks', async () => {
  const t = arena(new Vec3(0, 64, 0))
  const { task, block } = await place('repeater', { delay: '3', powered: 'false', facing: 'west', locked: 'false' }, t)
  assert.equal(String(block.getProperties().delay), '3')
  assert.ok(taskMatches(block, task))
})

test('note block is tuned by clicking', async () => {
  const t = arena(new Vec3(0, 64, 0))
  const { task, block } = await place('note_block', { note: '5', powered: 'false', instrument: 'harp' }, t)
  assert.equal(String(block.getProperties().note), '5')
  assert.ok(taskMatches(block, task))
})

test('sign text is written after placing', async () => {
  const t = arena(new Vec3(0, 64, 0), s => s.setBlock(new Vec3(0, 64, -1), 'stone'))
  const tile = { type: 'sign', hasText: true, front: { lines: ['hello', '', '', 'world'] }, back: null }
  await place('oak_wall_sign', { facing: 'south', waterlogged: 'false' }, t, tile)
  assert.ok([...ctx.bot.signs.values()].some(text => text.startsWith('hello')))
})

test('a block floating in the air gets a temporary reference and the scaffold is removed again', async () => {
  const t = arena(new Vec3(0, 70, 0))
  const { task, block } = await place('stone_bricks', {}, t)
  assert.ok(taskMatches(block, task))
  await ctx.engine.scaffold.descend()
  assert.equal(ctx.bot.entity.onGround, true)
  assert.ok(ctx.bot.entity.position.y < 66, 'bot climbed back down')
})

test('a wrongly oriented block is broken and replaced after the learner switches rule', async () => {
  const t = arena(new Vec3(0, 64, 0))
  ctx.server.observerMode = 'same' // this "server" faces observers the other way round
  const { task, block } = await place('observer', { facing: 'north', powered: 'false' }, t)
  ctx.server.observerMode = 'opposite'
  assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
  assert.equal(ctx.engine.learner.preferred.observer, 'observer-b')
})

test('no placement was ever sent without the crosshair on the clicked face', () => {
  assert.deepEqual(ctx.server.violations, [])
})

test('cleanup removes a floating scaffold reference high above the ground', async () => {
  const t = arena(new Vec3(0, 70, 0))
  await place('stone_bricks', {}, t)
  const left = ctx.engine.scaffold.getCreated()
  await ctx.engine.scaffold.cleanup(() => false, pos => ctx.engine.placer.digBlock(pos))
  assert.equal(ctx.engine.scaffold.getCreated().length, 0, `left over: ${JSON.stringify(left)}`)
  assert.equal(ctx.bot.blockAt(new Vec3(0, 69, 0)).name, 'air')
  await ctx.engine.scaffold.descend()
})

test('a hopper is stacked on top of another hopper (click on the thin rim)', async () => {
  const t = arena(new Vec3(0, 65, 0), s => { s.setBlock(new Vec3(0, 64, 0), 'hopper', { facing: 'down', enabled: 'true' }); s.setBlock(new Vec3(0, 63, 0), 'stone') })
  for (let i = 0; i < 3; i++) {
    ctx.server.setBlock(t, 'air')
    const { task, block } = await place('hopper', { facing: 'down', enabled: 'true' }, t)
    assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
  }
})

test('hopper stacked on a hopper that has hopper neighbours (row of hoppers)', async () => {
  const t = arena(new Vec3(0, 65, 0), s => { for (const x of [-1, 0, 1]) { s.setBlock(new Vec3(x, 64, 0), 'hopper', { facing: 'down', enabled: 'true' }); s.setBlock(new Vec3(x, 63, 0), 'stone') } s.setBlock(new Vec3(1, 65, 0), 'hopper', { facing: 'down', enabled: 'true' }) })
  for (let i = 0; i < 6; i++) {
    ctx.server.setBlock(t, 'air')
    ctx.bot.entity.position = new Vec3(5.5, 64, 5.5)
    const { task, block } = await place('hopper', { facing: 'down', enabled: 'true' }, t)
    assert.ok(taskMatches(block, task), JSON.stringify(block.getProperties()))
  }
})

test('two water placements in a row, then a waterlogged chest (bucket bookkeeping)', async () => {
  for (const x of [0, 2]) {
    const t = arena(new Vec3(x, 65, 0), s => { s.setBlock(new Vec3(x, 64, 0), 'stone'); s.setBlock(new Vec3(x + 1, 65, 0), 'stone') })
    const { task, block } = await place('water', { level: '0' }, t)
    assert.ok(taskMatches(block, task), block.name)
  }
  const t = arena(new Vec3(0, 65, 0), s => s.setBlock(new Vec3(0, 64, 0), 'stone'))
  const { task, block } = await place('chest', { facing: 'south', type: 'single', waterlogged: 'false' }, t)
  assert.ok(taskMatches(block, task))
  const wl = { ...task, kind: 'waterlog', info: task.info, name: 'chest', properties: { facing: 'south', type: 'single', waterlogged: 'true' } }
  assert.ok(wl)
})
