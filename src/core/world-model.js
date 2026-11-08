'use strict'

const { toVec3 } = require('../util/vec3')

const NON_SUPPORT = new Set([
  'air', 'cave_air', 'void_air', 'torch', 'wall_torch', 'redstone_torch', 'redstone_wall_torch',
  'tripwire', 'string', 'rail', 'powered_rail', 'detector_rail', 'activator_rail',
  'redstone_wire', 'snow', 'tall_grass', 'grass', 'fern', 'large_fern', 'vine', 'kelp', 'seagrass'
])

class WorldModel {
  constructor (bot) {
    this.bot = bot
  }

  blockAt (pos) {
    return this.bot.blockAt(toVec3(pos), false)
  }

  isKnown (pos) {
    return Boolean(this.blockAt(pos))
  }

  isAirLike (block) {
    if (!block) return true
    return block.boundingBox === 'empty' || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'
  }

  isSupportable (block) {
    if (!block || this.isAirLike(block)) return false
    if (NON_SUPPORT.has(block.name)) return false
    return block.boundingBox !== 'empty'
  }

  resolveBlock (value) {
    if (!value) return null
    // Mineflayer Block instances are structurally identifiable and may come
    // from a different vec3 module instance than this builder uses. Accept
    // the block directly instead of forcing it through blockAt()/toVec3().
    if (typeof value === 'object' && typeof value.name === 'string' &&
        ('boundingBox' in value || 'position' in value || 'stateId' in value)) {
      return value
    }
    return this.blockAt(value)
  }

  isDangerous (value) {
    const b = this.resolveBlock(value)
    if (!b) return false
    return b.name === 'lava' || b.name === 'flowing_lava' || b.name === 'fire' || b.name === 'soul_fire'
  }

  isVoidRisk (pos) {
    const p = toVec3(pos)
    for (let dy = 0; dy <= 3; dy++) {
      const b = this.blockAt(p.offset(0, -dy, 0))
      if (this.isSupportable(b)) return false
      if (b && !this.isAirLike(b) && b.name !== 'water' && b.name !== 'lava') return false
    }
    return true
  }

  neighbors (pos) {
    return [
      pos.offset(1, 0, 0), pos.offset(-1, 0, 0), pos.offset(0, 1, 0),
      pos.offset(0, -1, 0), pos.offset(0, 0, 1), pos.offset(0, 0, -1)
    ]
  }
}

module.exports = { WorldModel }
