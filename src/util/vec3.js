'use strict'

let Vec3
try {
  Vec3 = require('vec3')
} catch {
  class FallbackVec3 {
    constructor (x = 0, y = 0, z = 0) {
      if (Array.isArray(x)) { this.x = Number(x[0]); this.y = Number(x[1]); this.z = Number(x[2]) } else if (x && typeof x === 'object') { this.x = Number(x.x); this.y = Number(x.y); this.z = Number(x.z) } else { this.x = Number(x); this.y = Number(y); this.z = Number(z) }
    }
    clone () { return new FallbackVec3(this.x, this.y, this.z) }
    offset (dx, dy, dz) { return new FallbackVec3(this.x + dx, this.y + dy, this.z + dz) }
    plus (o) { return new FallbackVec3(this.x + o.x, this.y + o.y, this.z + o.z) }
    minus (o) { return new FallbackVec3(this.x - o.x, this.y - o.y, this.z - o.z) }
    scaled (s) { return new FallbackVec3(this.x * s, this.y * s, this.z * s) }
    floored () { return new FallbackVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
    rounded () { return new FallbackVec3(Math.round(this.x), Math.round(this.y), Math.round(this.z)) }
    abs () { return new FallbackVec3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)) }
    norm () { return Math.hypot(this.x, this.y, this.z) }
    distanceTo (o) { return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z) }
    xzDistanceTo (o) { return Math.hypot(this.x - o.x, this.z - o.z) }
    manhattanDistanceTo (o) { return Math.abs(this.x - o.x) + Math.abs(this.y - o.y) + Math.abs(this.z - o.z) }
    equals (o) { return Boolean(o && this.x === o.x && this.y === o.y && this.z === o.z) }
    dot (o) { return this.x * o.x + this.y * o.y + this.z * o.z }
    cross (o) { return new FallbackVec3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x) }
    unit () { const n = this.norm() || 1; return this.scaled(1 / n) }
    toArray () { return [this.x, this.y, this.z] }
    toString () { return `(${this.x}, ${this.y}, ${this.z})` }
  }
  Vec3 = function (x, y, z) { return new FallbackVec3(x, y, z) }
  Vec3.Vec3 = FallbackVec3
  Object.setPrototypeOf(Vec3.prototype, FallbackVec3.prototype)
}

function toVec3 (value) {
  if (value && typeof value.clone === 'function') return value.clone()
  if (Array.isArray(value) && value.length >= 3) return new Vec3(Number(value[0]), Number(value[1]), Number(value[2]))
  if (value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z)) {
    return new Vec3(Number(value.x), Number(value.y), Number(value.z))
  }
  throw new TypeError(`Expected Vec3-like value, got ${value}`)
}

module.exports = { Vec3, toVec3 }
