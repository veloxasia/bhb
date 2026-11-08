'use strict'

const zlib = require('zlib')
const { Vec3 } = require('../util/vec3')

class NbtReader {
  constructor (buffer) {
    this.buffer = buffer
    this.offset = 0
  }

  ensure (n) {
    if (this.offset + n > this.buffer.length) throw new Error(`Truncated NBT at offset ${this.offset}`)
  }

  byte () { this.ensure(1); return this.buffer.readInt8(this.offset++) }
  ubyte () { this.ensure(1); return this.buffer.readUInt8(this.offset++) }
  short () { this.ensure(2); const v = this.buffer.readInt16BE(this.offset); this.offset += 2; return v }
  ushort () { this.ensure(2); const v = this.buffer.readUInt16BE(this.offset); this.offset += 2; return v }
  int () { this.ensure(4); const v = this.buffer.readInt32BE(this.offset); this.offset += 4; return v }
  uint () { this.ensure(4); const v = this.buffer.readUInt32BE(this.offset); this.offset += 4; return v }
  long () { this.ensure(8); const v = this.buffer.readBigInt64BE(this.offset); this.offset += 8; return v }
  float () { this.ensure(4); const v = this.buffer.readFloatBE(this.offset); this.offset += 4; return v }
  double () { this.ensure(8); const v = this.buffer.readDoubleBE(this.offset); this.offset += 8; return v }

  string () {
    const len = this.ushort()
    this.ensure(len)
    const value = this.buffer.toString('utf8', this.offset, this.offset + len)
    this.offset += len
    return value
  }

  byteArray () {
    const len = this.int()
    if (len < 0) throw new Error(`Negative NBT byte array length: ${len}`)
    this.ensure(len)
    const value = Buffer.from(this.buffer.subarray(this.offset, this.offset + len))
    this.offset += len
    return value
  }

  intArray () {
    const len = this.int()
    if (len < 0) throw new Error(`Negative NBT int array length: ${len}`)
    const value = new Array(len)
    for (let i = 0; i < len; i++) value[i] = this.int()
    return value
  }

  longArray () {
    const len = this.int()
    if (len < 0) throw new Error(`Negative NBT long array length: ${len}`)
    const value = new Array(len)
    for (let i = 0; i < len; i++) value[i] = this.long()
    return value
  }

  namedTag () {
    const type = this.ubyte()
    if (type === 0) return { type: 0, name: '', value: null }
    const name = this.string()
    return { type, name, value: this.payload(type) }
  }

  payload (type) {
    switch (type) {
      case 1: return this.byte()
      case 2: return this.short()
      case 3: return this.int()
      case 4: return this.long()
      case 5: return this.float()
      case 6: return this.double()
      case 7: return this.byteArray()
      case 8: return this.string()
      case 9: {
        const childType = this.ubyte()
        const length = this.int()
        if (length < 0) throw new Error(`Negative NBT list length: ${length}`)
        const list = new Array(length)
        for (let i = 0; i < length; i++) list[i] = this.payload(childType)
        return { childType, value: list }
      }
      case 10: {
        const out = {}
        while (true) {
          const child = this.namedTag()
          if (child.type === 0) break
          out[child.name] = { type: child.type, value: child.value }
        }
        return out
      }
      case 11: return this.intArray()
      case 12: return this.longArray()
      default: throw new Error(`Unsupported NBT tag type ${type} at offset ${this.offset}`)
    }
  }
}

function decodeNbt (buffer) {
  let raw = Buffer.from(buffer)
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) raw = zlib.gunzipSync(raw)
  const reader = new NbtReader(raw)
  const root = reader.namedTag()
  if (root.type !== 10) throw new Error('Litematic root tag must be a compound')
  return root.value
}

function valueOf (tag, fallback = undefined) {
  return tag && Object.prototype.hasOwnProperty.call(tag, 'value') ? tag.value : fallback
}

function compoundOf (tag) {
  return valueOf(tag, {}) || {}
}

function intOf (compound, key, fallback = 0) {
  const tag = compound?.[key]
  const value = valueOf(tag, fallback)
  return Number.isFinite(Number(value)) ? Number(value) : fallback
}

function stringOf (compound, key, fallback = '') {
  const value = valueOf(compound?.[key], fallback)
  return typeof value === 'string' ? value : fallback
}

function paletteProperties (paletteEntry) {
  const propertiesTag = paletteEntry?.Properties
  const properties = compoundOf(propertiesTag)
  const out = {}
  for (const [key, tag] of Object.entries(properties)) {
    const value = valueOf(tag)
    if (value !== undefined && value !== null) out[key] = String(value)
  }
  return out
}

function regionBounds (position, size) {
  const minX = position.x + (size.x < 0 ? size.x + 1 : 0)
  const minY = position.y + (size.y < 0 ? size.y + 1 : 0)
  const minZ = position.z + (size.z < 0 ? size.z + 1 : 0)
  const sx = Math.abs(size.x)
  const sy = Math.abs(size.y)
  const sz = Math.abs(size.z)
  return {
    min: new Vec3(minX, minY, minZ),
    size: new Vec3(sx, sy, sz),
    max: new Vec3(minX + sx - 1, minY + sy - 1, minZ + sz - 1)
  }
}

function unpackPaletteIndex (longs, index, bits) {
  const start = BigInt(index) * BigInt(bits)
  const word = Number(start >> 6n)
  const bit = Number(start & 63n)
  let value = BigInt.asUintN(64, longs[word] ?? 0n) >> BigInt(bit)
  const firstBits = Math.min(bits, 64 - bit)
  if (firstBits < bits) {
    const next = BigInt.asUintN(64, longs[word + 1] ?? 0n)
    value |= next << BigInt(firstBits)
  }
  const mask = (1n << BigInt(bits)) - 1n
  return Number(value & mask)
}

function bitsForPalette (paletteLength) {
  let bits = 2
  let capacity = 1 << bits
  while (capacity < paletteLength && bits < 31) {
    bits++
    capacity *= 2
  }
  return bits
}

function key3 (x, y, z) {
  return `${x},${y},${z}`
}


// Plain text of a JSON text component (sign lines are stored as JSON strings)
function plainText (raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''
  try {
    const walk = node => {
      if (node == null) return ''
      if (typeof node === 'string') return node
      if (Array.isArray(node)) return node.map(walk).join('')
      let out = typeof node.text === 'string' ? node.text : ''
      if (Array.isArray(node.extra)) out += node.extra.map(walk).join('')
      return out
    }
    return walk(JSON.parse(trimmed))
  } catch (_) { return trimmed }
}

function signSide (tag) {
  const side = compoundOf(tag)
  const list = valueOf(side.messages, null)
  const lines = Array.isArray(list?.value) ? list.value.map(plainText) : []
  while (lines.length < 4) lines.push('')
  return { lines: lines.slice(0, 4), color: stringOf(side, 'color', 'black'), glowing: intOf(side, 'has_glowing_text', 0) === 1 }
}

// Tile entities we can reproduce by hand: sign text. Keys are schematic-local coordinates.
function parseTileEntities (region, bounds, out) {
  const list = valueOf(region.TileEntities, null)
  if (!Array.isArray(list?.value)) return
  for (const entry of list.value) {
    const id = stringOf(entry, 'id', '').replace(/^minecraft:/, '')
    const x = bounds.min.x + intOf(entry, 'x'); const y = bounds.min.y + intOf(entry, 'y'); const z = bounds.min.z + intOf(entry, 'z')
    if (id === 'sign' || id === 'hanging_sign') {
      const front = entry.front_text ? signSide(entry.front_text) : null
      const back = entry.back_text ? signSide(entry.back_text) : null
      const hasText = [front, back].some(side => side && side.lines.some(Boolean))
      out.set(key3(x, y, z), { type: 'sign', front, back, hasText, waxed: intOf(entry, 'is_waxed', 0) === 1 })
    }
  }
}

class LitematicSchematic {
  constructor ({ blocks, tiles, start, end, registry, metadata, regions }) {
    this.blocks = blocks
    this.tiles = tiles || new Map()
    this._start = start
    this._end = end
    this.size = new Vec3(end.x - start.x + 1, end.y - start.y + 1, end.z - start.z + 1)
    this.registry = registry
    this.metadata = metadata
    this.regions = regions
  }

  start () { return this._start.clone() }
  end () { return this._end.clone() }

  getBlock (pos) {
    return this.blocks.get(key3(pos.x, pos.y, pos.z)) || null
  }
}

function canonicalBlockName (name) {
  if (typeof name !== 'string') return ''
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name
}

function resolveBlock (registry, paletteEntry) {
  const rawName = stringOf(paletteEntry, 'Name', '')
  if (!rawName) throw new Error('Litematic palette entry is missing Name')
  const name = canonicalBlockName(rawName)

  // Air is a perfectly valid and extremely common Litematic palette entry.
  // It does not need a block-state lookup because all air variants are skipped
  // before entering the build task map. Keeping it here also makes the parser
  // tolerant of registries that expose `air` instead of `minecraft:air`.
  if (name === 'air' || name === 'cave_air' || name === 'void_air') {
    return {
      name,
      properties: paletteProperties(paletteEntry),
      stateId: 0,
      isAir: true,
      getProperties: () => ({})
    }
  }

  const blockType = registry?.blocksByName?.[name] || registry?.blocksByName?.[rawName] || (registry?.allowAll ? { id: 1, name } : null)
  if (!blockType) throw new Error(`Litematic contains block '${rawName}' which is not known by the configured Minecraft version`)
  const properties = paletteProperties(paletteEntry)
  let state = null
  try {
    const Block = require('prismarine-block')(registry)
    state = Block.fromProperties(blockType.id, properties, 0)
  } catch {
    state = { stateId: blockType.id || 1 }
  }
  if (!state || !Number.isInteger(state.stateId)) {
    throw new Error(`Unable to resolve block state for ${rawName} ${JSON.stringify(properties)}`)
  }
  return {
    name,
    properties,
    stateId: state.stateId,
    isAir: false,
    getProperties: () => ({ ...properties })
  }
}

function parseLitematicBuffer (buffer, registry) {
  if (!registry) throw new Error('A Mineflayer registry is required to resolve Litematic block states')
  const root = decodeNbt(buffer)
  const regionsTag = root.Regions
  if (!regionsTag || regionsTag.type !== 10) throw new Error('Invalid Litematic: missing Regions compound')

  const regions = compoundOf(regionsTag)
  const allBlocks = new Map()
  const allTiles = new Map()
  const regionInfo = []
  let bboxMin = null
  let bboxMax = null

  for (const [regionName, regionTag] of Object.entries(regions)) {
    const region = compoundOf(regionTag)
    const posTag = compoundOf(region.Position)
    const sizeTag = compoundOf(region.Size)
    const position = new Vec3(intOf(posTag, 'x'), intOf(posTag, 'y'), intOf(posTag, 'z'))
    const rawSize = new Vec3(intOf(sizeTag, 'x'), intOf(sizeTag, 'y'), intOf(sizeTag, 'z'))
    const bounds = regionBounds(position, rawSize)

    if (bounds.size.x < 1 || bounds.size.y < 1 || bounds.size.z < 1) {
      throw new Error(`Litematic region '${regionName}' has an empty size`)
    }

    const paletteList = region.BlockStatePalette?.value?.value
    if (!Array.isArray(paletteList) || paletteList.length === 0) {
      throw new Error(`Litematic region '${regionName}' has no BlockStatePalette`)
    }
    const palette = paletteList.map(entry => resolveBlock(registry, entry))
    const longs = valueOf(region.BlockStates, [])
    if (!Array.isArray(longs)) throw new Error(`Litematic region '${regionName}' has no BlockStates LongArray`)

    const volume = bounds.size.x * bounds.size.y * bounds.size.z
    const bits = bitsForPalette(palette.length)
    const expectedLongs = Math.ceil((volume * bits) / 64)
    if (longs.length < expectedLongs) {
      throw new Error(`Litematic region '${regionName}' BlockStates is truncated: got ${longs.length} longs, expected ${expectedLongs}`)
    }

    let nonAir = 0
    for (let y = 0; y < bounds.size.y; y++) {
      for (let z = 0; z < bounds.size.z; z++) {
        for (let x = 0; x < bounds.size.x; x++) {
          const index = y * bounds.size.x * bounds.size.z + z * bounds.size.x + x
          const paletteIndex = unpackPaletteIndex(longs, index, bits)
          if (paletteIndex < 0 || paletteIndex >= palette.length) continue
          const block = palette[paletteIndex]
          if (!block || block.isAir || block.name === 'minecraft:air' || block.name === 'minecraft:cave_air' || block.name === 'minecraft:void_air') continue

          const pos = new Vec3(bounds.min.x + x, bounds.min.y + y, bounds.min.z + z)
          allBlocks.set(key3(pos.x, pos.y, pos.z), block)
          nonAir++

        }
      }
    }

    parseTileEntities(region, bounds, allTiles)

    if (!bboxMin) {
      bboxMin = bounds.min.clone()
      bboxMax = bounds.max.clone()
    } else {
      bboxMin.x = Math.min(bboxMin.x, bounds.min.x)
      bboxMin.y = Math.min(bboxMin.y, bounds.min.y)
      bboxMin.z = Math.min(bboxMin.z, bounds.min.z)
      bboxMax.x = Math.max(bboxMax.x, bounds.max.x)
      bboxMax.y = Math.max(bboxMax.y, bounds.max.y)
      bboxMax.z = Math.max(bboxMax.z, bounds.max.z)
    }

    regionInfo.push({
      name: regionName,
      position,
      rawSize,
      bounds,
      paletteSize: palette.length,
      nonAir
    })
  }

  if (!bboxMin || !bboxMax) throw new Error('Litematic contains no regions')

  const metadataCompound = compoundOf(root.Metadata)
  const metadata = {
    name: stringOf(metadataCompound, 'Name', ''),
    author: stringOf(metadataCompound, 'Author', ''),
    description: stringOf(metadataCompound, 'Description', ''),
    minecraftDataVersion: intOf(root, 'MinecraftDataVersion', 0),
    version: intOf(root, 'Version', 0),
    subVersion: intOf(root, 'SubVersion', 0),
    regionCount: regionInfo.length,
    totalBlocks: regionInfo.reduce((sum, r) => sum + r.nonAir, 0)
  }

  return new LitematicSchematic({
    blocks: allBlocks,
    tiles: allTiles,
    start: bboxMin,
    end: bboxMax,
    registry,
    metadata,
    regions: regionInfo
  })
}

async function loadLitematic (file, registry, fs) {
  const buffer = await fs.readFile(file)
  return parseLitematicBuffer(buffer, registry)
}

module.exports = {
  NbtReader,
  decodeNbt,
  parseLitematicBuffer,
  loadLitematic,
  bitsForPalette,
  unpackPaletteIndex,
  regionBounds,
  LitematicSchematic
}
