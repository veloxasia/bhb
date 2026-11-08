'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { bitsForPalette, unpackPaletteIndex, regionBounds } = require('../src/schematic/litematic')

test('litematic bits-per-palette uses minimum 2 bits', () => {
  assert.equal(bitsForPalette(1), 2)
  assert.equal(bitsForPalette(4), 2)
  assert.equal(bitsForPalette(5), 3)
  assert.equal(bitsForPalette(8), 3)
  assert.equal(bitsForPalette(9), 4)
})

test('litematic tight long packing crosses 64-bit boundaries', () => {
  const bits = 5
  const indexes = [0, 1, 2, 31, 17, 4, 30, 7, 19, 3, 12, 25, 1]
  let packed = 0n
  for (let i = 0; i < indexes.length; i++) packed |= BigInt(indexes[i]) << (BigInt(i) * BigInt(bits))
  const longs = []
  for (let i = 0; i < 2; i++) longs.push(BigInt.asIntN(64, (packed >> BigInt(i * 64)) & ((1n << 64n) - 1n)))
  assert.deepEqual(indexes.map((_, i) => unpackPaletteIndex(longs, i, bits)), indexes)
})

test('negative region size maps to the minimum corner', () => {
  const result = regionBounds({ x: 10, y: 20, z: 30 }, { x: -3, y: 4, z: -5 })
  assert.equal(result.min.x, 8)
  assert.equal(result.min.y, 20)
  assert.equal(result.min.z, 26)
  assert.equal(result.size.x, 3)
  assert.equal(result.size.y, 4)
  assert.equal(result.size.z, 5)
  assert.equal(result.max.x, 10)
  assert.equal(result.max.y, 23)
  assert.equal(result.max.z, 30)
})

function nbtString (value) {
  const body = Buffer.from(value, 'utf8')
  const out = Buffer.alloc(2 + body.length)
  out.writeUInt16BE(body.length, 0)
  body.copy(out, 2)
  return out
}

function tag (type, name, payload) {
  return Buffer.concat([Buffer.from([type]), nbtString(name), payload])
}

function intPayload (value) {
  const b = Buffer.alloc(4); b.writeInt32BE(value, 0); return b
}

function compoundPayload (entries) {
  return Buffer.concat([...entries, Buffer.from([0])])
}

function compoundTag (name, entries) {
  return tag(10, name, compoundPayload(entries))
}

function listTag (name, childType, payloads) {
  const header = Buffer.alloc(5)
  header.writeUInt8(childType, 0)
  header.writeInt32BE(payloads.length, 1)
  return tag(9, name, Buffer.concat([header, ...payloads]))
}

function longArrayTag (name, longs) {
  const header = Buffer.alloc(4)
  header.writeInt32BE(longs.length, 0)
  const values = longs.map(v => { const b = Buffer.alloc(8); b.writeBigInt64BE(v, 0); return b })
  return tag(12, name, Buffer.concat([header, ...values]))
}

function stringTagPayload (name, value) {
  return tag(8, name, nbtString(value))
}

function paletteEntry (name, properties = null) {
  const entries = [stringTagPayload('Name', name)]
  if (properties) {
    const props = Object.entries(properties).map(([k, v]) => stringTagPayload(k, v))
    entries.push(compoundTag('Properties', props))
  }
  return Buffer.concat([...entries, Buffer.from([0])])
}

function packIndexes (indexes, bits) {
  let packed = 0n
  for (let i = 0; i < indexes.length; i++) packed |= BigInt(indexes[i]) << (BigInt(i) * BigInt(bits))
  const longCount = Math.ceil((indexes.length * bits) / 64)
  const longs = []
  for (let i = 0; i < longCount; i++) longs.push(BigInt.asIntN(64, (packed >> BigInt(i * 64)) & ((1n << 64n) - 1n)))
  return longs
}

test('full synthetic litematic parses palette, packing and region geometry', () => {
  const registry = require('minecraft-data')('1.21.1')
  const palette = listTag('BlockStatePalette', 10, [
    paletteEntry('minecraft:air'),
    paletteEntry('minecraft:stone'),
    paletteEntry('minecraft:oak_stairs', { facing: 'north', half: 'bottom', shape: 'straight', waterlogged: 'false' })
  ])
  const indexes = [0, 1, 2, 1]
  const blockStates = longArrayTag('BlockStates', packIndexes(indexes, 2))
  const position = compoundTag('Position', [tag(3, 'x', intPayload(10)), tag(3, 'y', intPayload(20)), tag(3, 'z', intPayload(30))])
  const size = compoundTag('Size', [tag(3, 'x', intPayload(2)), tag(3, 'y', intPayload(1)), tag(3, 'z', intPayload(2))])
  const region = compoundPayload([position, size, palette, blockStates])
  const regions = compoundTag('Regions', [compoundTag('Main', [
    position, size, palette, blockStates
  ])])
  const metadata = compoundTag('Metadata', [
    stringTagPayload('Name', 'Synthetic Test')
  ])
  const root = Buffer.concat([
    Buffer.from([10]), nbtString(''),
    intTag('Version', 6),
    intTag('MinecraftDataVersion', 3953),
    metadata,
    regions,
    Buffer.from([0])
  ])

  const zlib = require('zlib')
  const { parseLitematicBuffer } = require('../src/schematic/litematic')
  const schematic = parseLitematicBuffer(zlib.gzipSync(root), registry)

  assert.equal(schematic.size.x, 2)
  assert.equal(schematic.size.y, 1)
  assert.equal(schematic.size.z, 2)
  assert.equal(schematic.getBlock({ x: 10, y: 20, z: 30 }), null)
  assert.equal(schematic.getBlock({ x: 11, y: 20, z: 30 }).name, 'stone')
  assert.equal(schematic.getBlock({ x: 10, y: 20, z: 31 }).name, 'oak_stairs')
  assert.equal(schematic.getBlock({ x: 11, y: 20, z: 31 }).name, 'stone')
})

function intTag (name, value) {
  return tag(3, name, intPayload(value))
}
