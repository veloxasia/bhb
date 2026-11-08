'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { describeBlock } = require('../src/rules/blocks')

test('vendored walker loads', () => {
  const { createHuman } = require('../src/navigation/human')
  assert.strictEqual(typeof createHuman, 'function')
})

test('observer is a producer, ordered before power but after structure', () => {
  const { BuildPlanner } = require('../src/planner/build-planner')
  const orderOf = BuildPlanner.prototype.orderOf
  const obs = orderOf(describeBlock('observer', { facing: 'north' }), 'block', 3)
  const stone = orderOf(describeBlock('stone', {}), 'block', 40)
  const torch = orderOf(describeBlock('redstone_torch', {}), 'block', 0)
  assert.ok(obs > stone && obs < torch)
})

test('step-exclusion hooks survive position-less placeholder blocks', () => {
  const Movements = require('mineflayer-pathfinder/lib/movements')
  const fake = { registry: require('minecraft-data')('1.21.1'), version: '1.21.1', entity: { position: { x: 0, y: 0, z: 0 } }, inventory: { items: () => [] }, world: {}, blockAt: () => null }
  const m = Object.create(Movements.prototype)
  m.exclusionAreasStep = []
  m.exclusionAreasStep.push(b => (b && typeof b.name === 'string' && /pressure_plate/.test(b.name) ? 150 : 0))
  assert.strictEqual(m.exclusionStep({ safe: false }), 0)
  assert.strictEqual(m.exclusionStep({ name: 'stone_pressure_plate' }), 150)
  void fake
})

test('state: shared dir migrates job files from an older version and resolves the schematic by name', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path')
  const { prepareState, resolveSchematicFile } = require('../src/state/paths')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhbstate-'))
  const old = path.join(tmp, 'minecraft-human-builder-v1.5.0', 'mhb'); fs.mkdirSync(path.join(old, 'data'), { recursive: true })
  fs.writeFileSync(path.join(old, 'data', 'active-job.json'), '{"file":"x"}')
  const neu = path.join(tmp, 'minecraft-human-builder-v1.6.0', 'mhb'); fs.mkdirSync(neu, { recursive: true })
  process.env.MHB_STATE_DIR = path.join(tmp, 'shared')
  const cfg = { paths: { stateDir: './data' } }
  prepareState(neu, cfg)
  assert.ok(fs.existsSync(path.join(tmp, 'shared', 'active-job.json')))
  fs.mkdirSync(path.join(tmp, 'sch')); fs.writeFileSync(path.join(tmp, 'sch', 'a.litematic'), '')
  assert.equal(resolveSchematicFile('C:\\old\\folder\\a.litematic', path.join(tmp, 'sch')), path.join(tmp, 'sch', 'a.litematic'))
  delete process.env.MHB_STATE_DIR
})

test('ground: a hovering bot with air in the model counts as resting', () => {
  const { GroundMonitor } = require('../src/world/ground')
  const bot = { on () {}, off () {}, entity: { position: { x: 1, y: -60, z: 1, floored: () => ({ x: 1, y: -60, z: 1, offset: () => ({}) }) }, velocity: { y: -0.1552 }, onGround: false } }
  const world = { blockAt: () => ({ name: 'air', boundingBox: 'empty' }) }
  const g = new GroundMonitor(bot, world, {})
  const t = Date.now()
  for (let i = 0; i < 40; i++) g.samples.push({ t: t - (40 - i) * 50, x: 1, y: -60 - (i % 3) * 0.05, z: 1, vy: 0, onGround: false })
  assert.equal(g.state(), 'resting')
})
