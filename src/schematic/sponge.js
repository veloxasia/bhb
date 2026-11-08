'use strict'
// Sponge schematic reader (.schem versions 1, 2 and 3: WorldEdit, FAWE, Litematica export...).
// prismarine-schematic only understands v1/v2 reliably; v3 (nested "Schematic" root) made it fall through to the
// legacy MCEdit reader and crash, so the formats are parsed here directly.
const { Vec3 } = require('../util/vec3')

const AIR = new Set(['air', 'cave_air', 'void_air'])
const parseNbt = buffer => {
  const nbt = require('prismarine-nbt')
  return new Promise((resolve, reject) => nbt.parse(buffer, (error, result) => error ? reject(error) : resolve(nbt.simplify(result))))
}

function parseBlockString (text) {
  const m = /^([^[]+)(?:\[(.*)\])?$/.exec(String(text).trim())
  const name = m[1].replace(/^minecraft:/, '')
  const properties = {}
  if (m[2]) for (const part of m[2].split(',')) { const [k, v] = part.split('='); if (k) properties[k.trim()] = String(v).trim() }
  return { name, properties }
}

function varints (bytes, count) {
  const out = new Array(count)
  let i = 0
  for (let n = 0; n < count; n++) {
    let value = 0; let shift = 0
    for (;;) {
      if (i >= bytes.length) throw new Error('Sponge schematic block data ended early (corrupt file?)')
      const b = bytes[i++] & 0xff
      value |= (b & 0x7f) << shift
      if (!(b & 0x80)) break
      shift += 7
      if (shift > 35) throw new Error('Sponge schematic: VarInt too long')
    }
    out[n] = value
  }
  return out
}

class SpongeSchematic {
  constructor ({ size, offset, indexes, palette, tiles, skipped, version }) {
    this.size = size
    this.offset = offset
    this.indexes = indexes
    this.palette = palette
    this.tiles = tiles || new Map()
    this.skipped = skipped
    this.spongeVersion = version
  }

  start () { return this.offset.clone() }
  end () { return this.offset.plus(this.size).offset(-1, -1, -1) }

  getBlock (pos) {
    const x = Math.floor(pos.x - this.offset.x); const y = Math.floor(pos.y - this.offset.y); const z = Math.floor(pos.z - this.offset.z)
    if (x < 0 || y < 0 || z < 0 || x >= this.size.x || y >= this.size.y || z >= this.size.z) return null
    return this.palette[this.indexes[(y * this.size.z + z) * this.size.x + x]] || null
  }
}

function resolve (registry, text, skipped) {
  const { name, properties } = parseBlockString(text)
  if (AIR.has(name)) return { name, properties: {}, stateId: 0, isAir: true, getProperties: () => ({}) }
  const type = registry.blocksByName[name]
  if (!type) { skipped.add(name); return { name: 'air', properties: {}, stateId: 0, isAir: true, getProperties: () => ({}) } }
  const Block = require('prismarine-block')(registry)
  const state = Block.fromProperties(type.id, properties, 0)
  if (!state || !Number.isInteger(state.stateId)) { skipped.add(`${name}[${Object.keys(properties).join(',')}]`); return { name: 'air', properties: {}, stateId: 0, isAir: true, getProperties: () => ({}) } }
  return { name, properties, stateId: state.stateId, isAir: false, getProperties: () => ({ ...properties }) }
}

async function parseSpongeBuffer (buffer, registry) {
  const root = await parseNbt(buffer)
  const body = root.Schematic || root
  const version = Number(body.Version || 1)
  const container = version >= 3 ? body.Blocks : body
  if (!container || !(container.Palette || container.palette)) return null // not a Sponge schematic
  const rawPalette = container.Palette
  const data = container.Data || container.BlockData
  if (!rawPalette || !data) return null

  const size = new Vec3(Number(body.Width), Number(body.Height), Number(body.Length))
  if (!(size.x > 0 && size.y > 0 && size.z > 0)) throw new Error('Sponge schematic has an invalid size')
  let offset = new Vec3(0, 0, 0)
  const off = body.Offset || (body.Metadata && [body.Metadata.WEOffsetX || 0, body.Metadata.WEOffsetY || 0, body.Metadata.WEOffsetZ || 0])
  if (Array.isArray(off) || (off && off.length === 3)) offset = new Vec3(Number(off[0]), Number(off[1]), Number(off[2]))

  const skipped = new Set()
  const palette = []
  for (const [text, id] of Object.entries(rawPalette)) palette[Number(id)] = resolve(registry, text, skipped)
  const count = size.x * size.y * size.z
  const indexes = varints(Uint8Array.from(data), count)
  for (const v of indexes) if (!palette[v]) throw new Error(`Sponge schematic uses palette index ${v} that is not defined`)
  return new SpongeSchematic({ size, offset, indexes, palette, skipped: [...skipped], version })
}

module.exports = { parseSpongeBuffer, parseBlockString, SpongeSchematic, varints }
