'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { describeBlock, taskMatches, usableFaces } = require('../src/rules/blocks')

test('plain blocks are free-placement solids', () => {
  const info = describeBlock('cobblestone', {})
  assert.equal(info.kind, 'solid')
  assert.equal(info.item, 'cobblestone')
  assert.equal(info.specs[0].tag, 'free')
})

test('flowing water is created by the game, sources by a bucket', () => {
  assert.equal(describeBlock('water', { level: '3' }).kind, 'derived')
  const src = describeBlock('water', { level: '0' })
  assert.equal(src.kind, 'fluid')
  assert.equal(src.item, 'water_bucket')
})

test('wall signs map to the sign item and request text entry', () => {
  const info = describeBlock('oak_wall_sign', { facing: 'north', waterlogged: 'false' })
  assert.equal(info.item, 'oak_sign')
  assert.ok(info.post.some(a => a.type === 'sign'))
})

test('look-up rules can only use the underside of a block above', () => {
  const info = describeBlock('piston', { facing: 'down', extended: 'false' })
  assert.deepEqual(usableFaces(info.specs[0]), ['down'])
})

test('a face equal to the facing/look direction can never be clicked', () => {
  const info = describeBlock('piston', { facing: 'east', extended: 'false' })
  assert.ok(!usableFaces(info.specs[0]).includes('west'))
})

test('rule hypotheses are flagged so they are only tried after a wrong result', () => {
  const info = describeBlock('observer', { facing: 'north', powered: 'false' })
  assert.equal(info.specs.length, 2)
  assert.ok(!info.specs[0].hyp && info.specs[1].hyp)
})

test('derived properties never cause mismatches', () => {
  const info = describeBlock('observer', { facing: 'north', powered: 'true' })
  const block = { name: 'observer', getProperties: () => ({ facing: 'north', powered: 'false' }) }
  assert.ok(taskMatches(block, { kind: 'block', info }))
  const wrong = { name: 'observer', getProperties: () => ({ facing: 'south', powered: 'false' }) }
  assert.ok(!taskMatches(wrong, { kind: 'block', info }))
})

test('every block of the real example schematic has a placement rule', async () => {
  const fs = require('fs')
  const file = 'schematics/McDs 64 Module Cobblestone Wall Farm.litematic'
  if (!fs.existsSync(file)) return
  const { parseLitematicBuffer } = require('../src/schematic/litematic')
  const sch = parseLitematicBuffer(fs.readFileSync(file), require('prismarine-registry')('1.21.1'))
  const bad = new Set()
  for (const b of sch.blocks.values()) if (describeBlock(b.name, b.properties).kind === 'unsupported') bad.add(b.name)
  assert.deepEqual([...bad], [])
  assert.equal(sch.tiles.size, 94)
})

test('hanging lantern is clicked on the underside of a block above, standing one on top', () => {
  const { describeBlock } = require('../src/rules/blocks')
  assert.deepStrictEqual(describeBlock('lantern', { hanging: 'true', waterlogged: 'false' }).specs.map(s => s.tag), ['lantern-hang'])
  assert.deepStrictEqual(describeBlock('lantern', { hanging: 'false', waterlogged: 'false' }).specs.map(s => s.tag), ['lantern-stand'])
})
