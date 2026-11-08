'use strict'
// Writes a small .litematic from a function (x,y,z) -> block name | { name, props } | null. For test builds.
const path = require('path')
const fs = require('fs')
const zlib = require('zlib')
const nbt = require(path.resolve(__dirname, '..', '..', 'node_modules', 'prismarine-nbt'))

function writeLitematic (file, size, at) {
  const palette = [{ Name: 'minecraft:air' }]
  const index = new Map([['minecraft:air', 0]])
  const ids = new Int32Array(size.x * size.y * size.z)
  for (let y = 0; y < size.y; y++) for (let z = 0; z < size.z; z++) for (let x = 0; x < size.x; x++) {
    const b = at(x, y, z)
    if (!b) continue
    const name = 'minecraft:' + (typeof b === 'string' ? b : b.name)
    const props = typeof b === 'string' ? null : b.props
    const key = name + JSON.stringify(props || {})
    if (!index.has(key)) { index.set(key, palette.length); palette.push(props ? { Name: name, Properties: props } : { Name: name }) }
    ids[y * size.x * size.z + z * size.x + x] = index.get(key)
  }
  let bits = 2
  while ((1 << bits) < palette.length) bits++
  const volume = ids.length
  const longs = new Array(Math.ceil(volume * bits / 64)).fill(0n)
  for (let i = 0; i < volume; i++) {
    const start = BigInt(i) * BigInt(bits)
    const w = Number(start >> 6n); const o = start & 63n
    longs[w] |= BigInt(ids[i]) << o
    if (o + BigInt(bits) > 64n) longs[w + 1] |= BigInt(ids[i]) >> (64n - o)
  }
  const pairs = longs.map(v => { const u = BigInt.asUintN(64, v); return [Number(BigInt.asIntN(32, u >> 32n)), Number(BigInt.asIntN(32, u & 0xffffffffn))] })
  const tag = nbt.comp({
    Version: nbt.int(6), MinecraftDataVersion: nbt.int(4189),
    Metadata: nbt.comp({ Name: nbt.string('test'), Author: nbt.string('testbed'), TotalBlocks: nbt.int(0) }),
    Regions: nbt.comp({
      main: nbt.comp({
        Position: nbt.comp({ x: nbt.int(0), y: nbt.int(0), z: nbt.int(0) }),
        Size: nbt.comp({ x: nbt.int(size.x), y: nbt.int(size.y), z: nbt.int(size.z) }),
        BlockStatePalette: nbt.list(nbt.comp(palette.map(p => (p.Properties ? { Name: nbt.string(p.Name), Properties: nbt.comp(Object.fromEntries(Object.entries(p.Properties).map(([k, v]) => [k, nbt.string(String(v))]))) } : { Name: nbt.string(p.Name) })))),
        BlockStates: nbt.longArray(pairs),
        TileEntities: nbt.list(nbt.comp([])), Entities: nbt.list(nbt.comp([])), PendingBlockTicks: nbt.list(nbt.comp([])), PendingFluidTicks: nbt.list(nbt.comp([]))
      })
    })
  }, '')
  fs.writeFileSync(file, zlib.gzipSync(nbt.writeUncompressed(tag)))
}

// "bunker": grass floor, 4 walls, roof, and an elevated inner platform (stands at y=4..5 are only reachable by building up)
function bunker (file, w = 15, d = 13, h = 9) {
  writeLitematic(file, { x: w, y: h, z: d }, (x, y, z) => {
    const edge = x === 0 || z === 0 || x === w - 1 || z === d - 1
    if (y === 0) return 'grass_block'
    if (edge && y <= 6) return (y === 3 && x % 4 === 2) ? 'oak_leaves' : 'cobblestone'
    if (y === 4 && x > 1 && x < w - 2 && z > 1 && z < d - 2) return 'cobblestone' // inner platform
    if (y === 5 && x > 2 && x < w - 3 && z > 2 && z < d - 3 && (x + z) % 3 === 0) return 'cobblestone' // pillars on it
    if (y === h - 1 && x >= 0) return (x + z) % 2 ? 'cobblestone' : 'dirt' // roof
    return null
  })
}
// "farm": like a small redstone farm: grass/dirt base with a 3-deep pit, walls with gaps, an elevated deck on pillars,
// redstone / repeaters / note blocks / slabs / leaves on top, and a high tower part that only exists on scaffolding
function farm (file, w = 17, d = 14, h = 14) {
  writeLitematic(file, { x: w, y: h, z: d }, (x, y, z) => {
    const edge = x === 0 || z === 0 || x === w - 1 || z === d - 1
    const pit = x >= 6 && x <= 9 && z >= 5 && z <= 8
    if (y === 0) return pit ? null : ((x + z) % 5 === 0 ? 'dirt' : 'grass_block')
    if (y === 1 && !pit) return (x + z) % 7 === 0 ? 'oak_leaves' : null
    if (edge && y >= 1 && y <= 6) return (x === 8 && z === 0 && y <= 2) ? null : 'cobblestone' // a door gap
    if (y === 5 && x > 1 && x < w - 2 && z > 1 && z < d - 2 && !pit) return (x % 2 === 0) ? 'cobblestone' : 'smooth_stone_slab' // elevated deck
    if (y >= 1 && y <= 4 && (x === 3 || x === w - 4) && (z === 3 || z === d - 4)) return 'cobblestone' // deck pillars
    if (y === 6 && x > 2 && x < w - 3 && z > 2 && z < d - 3 && z % 2 === 1) return x % 5 === 0 ? { name: 'repeater', props: { facing: 'east', delay: '1', locked: 'false', powered: 'false' } } : 'redstone_wire'
    if (y === 6 && x === 5 && z === 4) return 'note_block'
    if (y >= 7 && y <= 11 && x === 8 && z === 6) return 'cobblestone' // tower in the middle of the deck
    if (y === 12 && x >= 7 && x <= 9 && z >= 5 && z <= 7) return 'oak_leaves'
    return null
  })
}
// "pillar": a floor and a few blocks that float high above it (each needs a reference built first)
function pillar (file) {
  writeLitematic(file, { x: 7, y: 10, z: 7 }, (x, y, z) => {
    if (y === 0) return 'grass_block'
    if (y === 8 && x >= 2 && x <= 4 && z >= 2 && z <= 4) return 'cobblestone'
    if (y === 9 && x === 3 && z === 3) return 'oak_leaves'
    return null
  })
}
// "chests": single chests facing every way, a double chest, a chest column and dirt - the "face front, place backside" case
function chests (file) {
  const C = (facing, type = 'single') => ({ name: 'chest', props: { facing, type, waterlogged: 'false' } })
  writeLitematic(file, { x: 12, y: 4, z: 8 }, (x, y, z) => {
    if (y === 0) return 'grass_block'
    if (y !== 1) return y === 2 && x === 9 && z === 2 ? C('north') : null
    if (z === 1 && x < 4) return C(['north', 'south', 'west', 'east'][x])
    if (z === 3 && x === 2) return C('west', 'left')
    if (z === 4 && x === 2) return C('west', 'right')
    if (z === 6 && x >= 1 && x <= 2) return C('south', x === 1 ? 'right' : 'left')
    if (x === 9 && z === 2) return C('north')
    if (x === 10 && z === 2) return 'dirt'
    return null
  })
}
module.exports = { writeLitematic, bunker, farm, pillar, chests }
if (require.main === module) { ({ farm, pillar, bunker, chests }[process.argv[3]] || bunker)(process.argv[2] || '/tmp/bunker.litematic'); console.log('written') }
