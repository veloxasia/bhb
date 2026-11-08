'use strict'

const fs = require('fs/promises')
const path = require('path')
const { Vec3, toVec3 } = require('../util/vec3')
const { loadLitematic } = require('./litematic')
const { parseSpongeBuffer } = require('./sponge')

async function loadSchematic (file, bot) {
  const absolute = path.resolve(file)
  const ext = path.extname(absolute).toLowerCase()
  let schematic
  let buffer
  if (ext === '.litematic') {
    schematic = await loadLitematic(absolute, bot.registry, fs)
  } else {
    buffer = await fs.readFile(absolute)
    if (ext === '.schem') schematic = await parseSpongeBuffer(buffer, bot.registry).catch(error => { throw new Error(`Cannot read ${path.basename(absolute)}: ${error.message}`) })
    if (!schematic) {
      const { Schematic } = require('prismarine-schematic')
      schematic = await Schematic.read(buffer, bot.version) // legacy .schematic (MCEdit)
    }
  }

  if (!schematic || !schematic.size || schematic.size.x < 1 || schematic.size.y < 1 || schematic.size.z < 1) {
    throw new Error(`Invalid or empty schematic: ${absolute}`)
  }

  const start = schematic.start()
  const end = schematic.end()
  const volume = schematic.size.x * schematic.size.y * schematic.size.z
  if (!Number.isSafeInteger(volume) || volume > 20_000_000) {
    throw new Error(`Schematic volume is too large for the default safety limit: ${volume}`)
  }

  return { schematic, file: absolute, start, end, volume, skipped: schematic.skipped || [] }
}

function transformXZ (x, z, rotation) {
  switch (((rotation % 360) + 360) % 360) {
    case 0: return { x, z }
    case 90: return { x: -z, z: x }
    case 180: return { x: -x, z: -z }
    case 270: return { x: z, z: -x }
    default: throw new Error('rotation must be one of 0, 90, 180, 270')
  }
}

function buildTransform (schematic, origin, rotation = 0) {
  const start = schematic.start()
  const size = schematic.size
  const transformed = []

  const corners = [
    transformXZ(0, 0, rotation),
    transformXZ(size.x - 1, 0, rotation),
    transformXZ(0, size.z - 1, rotation),
    transformXZ(size.x - 1, size.z - 1, rotation)
  ]
  const minX = Math.min(...corners.map(c => c.x))
  const minZ = Math.min(...corners.map(c => c.z))

  function localToWorld (localPos) {
    const lx = localPos.x - start.x
    const lz = localPos.z - start.z
    const r = transformXZ(lx, lz, rotation)
    return new Vec3(
      origin.x + (r.x - minX),
      origin.y + (localPos.y - start.y),
      origin.z + (r.z - minZ)
    )
  }

  function worldToLocalXZ (worldPos) {
    // Useful for diagnostics; inverse transform only.
    const x = worldPos.x - origin.x + minX
    const z = worldPos.z - origin.z + minZ
    let lx = x
    let lz = z
    switch (((rotation % 360) + 360) % 360) {
      case 0: break
      case 90: lx = z; lz = -x; break
      case 180: lx = -x; lz = -z; break
      case 270: lx = -z; lz = x; break
    }
    return new Vec3(lx + start.x, worldPos.y - origin.y + start.y, lz + start.z)
  }

  transformed.push({ origin: toVec3(origin), rotation, localToWorld, worldToLocalXZ, minX, minZ })
  return transformed[0]
}

module.exports = { loadSchematic, buildTransform }
