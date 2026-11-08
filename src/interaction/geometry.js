'use strict'

const { Vec3 } = require('../util/vec3')

const FACES = Object.freeze([
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0)
])

function faceKey (face) {
  return `${face.x},${face.y},${face.z}`
}

function sameVec (a, b, eps = 1e-7) {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps
}

function normalize (v) {
  const len = Math.hypot(v.x, v.y, v.z)
  if (!Number.isFinite(len) || len <= 1e-12) throw new Error('Cannot normalize zero/invalid vector')
  return new Vec3(v.x / len, v.y / len, v.z / len)
}

function directionFromYawPitch (yaw, pitch) {
  const cp = Math.cos(pitch)
  return normalize(new Vec3(-Math.sin(yaw) * cp, -Math.sin(pitch), -Math.cos(yaw) * cp))
}

function eyePosition (bot) {
  const e = bot.entity
  const eyeHeight = Number.isFinite(e.eyeHeight) ? e.eyeHeight : 1.62
  return e.position.offset(0, eyeHeight, 0)
}

function viewRay (bot) {
  return directionFromYawPitch(bot.entity.yaw, bot.entity.pitch)
}

function blockCenter (position) {
  return new Vec3(position.x + 0.5, position.y + 0.5, position.z + 0.5)
}

function makeAABB (minX, minY, minZ, maxX, maxY, maxZ) {
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

function fullBlockAABB (position) {
  return makeAABB(position.x, position.y, position.z, position.x + 1, position.y + 1, position.z + 1)
}

// Slabs/stairs often expose block.shapes as [minX,minY,minZ,maxX,maxY,maxZ] arrays.
// When no shapes are available, fall back to the full cube; strict placement still depends on a world raycast.
function selectionShapes (block) {
  const p = block.position
  if (Array.isArray(block.shapes) && block.shapes.length) {
    return block.shapes.map(shape => makeAABB(
      p.x + shape[0], p.y + shape[1], p.z + shape[2],
      p.x + shape[3], p.y + shape[4], p.z + shape[5]
    ))
  }
  return [fullBlockAABB(p)]
}

function candidateFacePoints (referenceBlock, face, properties = {}) {
  const p = referenceBlock.position
  const samples = [0.18, 0.33, 0.5, 0.67, 0.82]
  const points = []
  const shapes = selectionShapes(referenceBlock)

  for (const shape of shapes) {
    const { minX, minY, minZ, maxX, maxY, maxZ } = shape
    for (const a of samples) {
      for (const b of samples) {
        let x = (minX + maxX) / 2
        let y = (minY + maxY) / 2
        let z = (minZ + maxZ) / 2

        if (face.x > 0) {
          x = maxX
          y = minY + (maxY - minY) * a
          z = minZ + (maxZ - minZ) * b
        } else if (face.x < 0) {
          x = minX
          y = minY + (maxY - minY) * a
          z = minZ + (maxZ - minZ) * b
        } else if (face.y > 0) {
          y = maxY
          x = minX + (maxX - minX) * a
          z = minZ + (maxZ - minZ) * b
        } else if (face.y < 0) {
          y = minY
          x = minX + (maxX - minX) * a
          z = minZ + (maxZ - minZ) * b
        } else if (face.z > 0) {
          z = maxZ
          x = minX + (maxX - minX) * a
          y = minY + (maxY - minY) * b
        } else if (face.z < 0) {
          z = minZ
          x = minX + (maxX - minX) * a
          y = minY + (maxY - minY) * b
        }

        // Bias half-sensitive placements toward the correct vertical area.
        if (face.y === 0 && properties?.half === 'top' && y < p.y + 0.5) continue
        if (face.y === 0 && properties?.half === 'bottom' && y > p.y + 0.5) continue

        points.push(new Vec3(x, y, z))
      }
    }
  }

  // Deterministic de-duplication for full blocks / overlapping shapes.
  const seen = new Set()
  return points.filter(point => {
    const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function raycastWorld (bot, origin, target, range) {
  const direction = normalize(target.minus(origin))
  return bot.world.raycast(origin, direction, range)
}

function distanceTo (a, b) {
  return Math.sqrt(a.distanceToSquared(b))
}

function faceName (face) {
  if (face.y < 0) return 'down'
  if (face.y > 0) return 'up'
  if (face.z < 0) return 'north'
  if (face.z > 0) return 'south'
  if (face.x < 0) return 'west'
  if (face.x > 0) return 'east'
  return 'unknown'
}

function faceFromName (name) {
  switch (String(name).toLowerCase()) {
    case 'down': return new Vec3(0, -1, 0)
    case 'up': return new Vec3(0, 1, 0)
    case 'north': return new Vec3(0, 0, -1)
    case 'south': return new Vec3(0, 0, 1)
    case 'west': return new Vec3(-1, 0, 0)
    case 'east': return new Vec3(1, 0, 0)
    default: throw new Error(`Unknown face ${name}`)
  }
}

function localCursorFromIntersection (blockPos, intersection) {
  return new Vec3(
    intersection.x - blockPos.x,
    intersection.y - blockPos.y,
    intersection.z - blockPos.z
  )
}

module.exports = {
  FACES,
  faceKey,
  sameVec,
  normalize,
  directionFromYawPitch,
  eyePosition,
  viewRay,
  blockCenter,
  selectionShapes,
  candidateFacePoints,
  raycastWorld,
  distanceTo,
  faceName,
  faceFromName,
  localCursorFromIntersection
}
