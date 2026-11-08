'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const registry = require('minecraft-data')('1.21.1')
const { parseSpongeBuffer } = require('../src/schematic/sponge')

const int = value => ({ type: 'int', value })

function make (version) {
  const palette = { type: 'compound', value: { 'minecraft:air': int(0), 'minecraft:stone': int(1), 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]': int(2), 'minecraft:totally_new_block': int(3) } }
  const data = { type: 'byteArray', value: [1, 2, 3, 0] } // (0,0,0) (1,0,0) (0,0,1) (1,0,1)
  const common = { Version: int(version), DataVersion: int(3955), Width: { type: 'short', value: 2 }, Height: { type: 'short', value: 1 }, Length: { type: 'short', value: 2 }, Offset: { type: 'intArray', value: [0, 0, 0] } }
  const root = version >= 3
    ? { type: 'compound', name: '', value: { Schematic: { type: 'compound', value: { ...common, Blocks: { type: 'compound', value: { Palette: palette, Data: data } } } } } }
    : { type: 'compound', name: '', value: { ...common, Palette: palette, BlockData: data } }
  return zlib.gzipSync(nbt.writeUncompressed(root))
}

for (const version of [2, 3]) {
  test(`sponge schematic v${version} parses palette, order and unknown blocks`, async () => {
    const s = await parseSpongeBuffer(make(version), registry)
    assert.equal(s.size.x, 2); assert.equal(s.size.z, 2)
    assert.equal(s.getBlock(new Vec3(0, 0, 0)).name, 'stone')
    const st = s.getBlock(new Vec3(1, 0, 0))
    assert.equal(st.name, 'oak_stairs'); assert.equal(st.getProperties().facing, 'north')
    assert.equal(s.getBlock(new Vec3(0, 0, 1)).isAir, true) // unknown block is left out
    assert.deepEqual(s.skipped, ['totally_new_block'])
    assert.equal(s.getBlock(new Vec3(1, 0, 1)).isAir, true)
  })
}
