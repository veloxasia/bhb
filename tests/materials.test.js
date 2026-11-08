'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { describeBlock } = require('../src/rules/blocks')

const item = (name, props = {}) => describeBlock(name, props).item

test('blocks map to the item that really places them', () => {
  assert.equal(item('wall_torch', { facing: 'north' }), 'torch')
  assert.equal(item('redstone_wall_torch', { facing: 'north', lit: 'true' }), 'redstone_torch')
  assert.equal(item('oak_wall_sign', { facing: 'north' }), 'oak_sign')
  assert.equal(item('redstone_wire', { power: '0' }), 'redstone')
  assert.equal(item('wheat', { age: '0' }), 'wheat_seeds')
  assert.equal(item('stone_bricks'), 'stone_bricks')
  assert.equal(item('oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' }), 'oak_stairs')
})

test('fluids are placed by bucket', () => {
  assert.equal(describeBlock('water', { level: '0' }).kind, 'fluid')
  assert.equal(describeBlock('lava', { level: '0' }).kind, 'fluid')
})

test('a block the shop does not sell is replaced along its chain (grass -> dirt -> cobblestone)', async () => {
  const { MaterialManager } = require('../src/core/material-manager')
  const calls = []
  const bot = { registry: { itemsByName: { grass_block: {}, dirt: {}, cobblestone: {} } }, inventory: { items: () => [] }, on () {}, version: '1.21.4' }
  const config = { building: { substitutes: { grass_block: ['dirt', 'cobblestone'], dirt: ['cobblestone'] } }, shop: {} }
  const m = new MaterialManager(bot, config, { info () {}, warn () {}, debug () {} })
  m.planner = { substituteItem: (a, b) => { calls.push([a, b]); return 3 }, getMaterialDemand: () => new Map() }
  m.buy = async name => { const e = new Error('not sold'); e.code = 'NOT_FOUND'; throw e }
  await assert.rejects(m.ensureItem('grass_block', 1), { code: 'MATERIAL_SUBSTITUTED' })
  await assert.rejects(m.ensureItem('dirt', 1), { code: 'MATERIAL_SUBSTITUTED' })
  assert.deepStrictEqual(calls, [['grass_block', 'dirt'], ['dirt', 'cobblestone']])
})
