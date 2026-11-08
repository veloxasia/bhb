'use strict'
// Footing / support detection that matches how Minecraft physics really works.

const HALF_WIDTH = 0.3

const HAZARD_STAND = new Set(['magma_block', 'cactus', 'campfire', 'soul_campfire', 'honey_block', 'slime_block', 'scaffolding', 'powder_snow', 'sweet_berry_bush', 'wither_rose', 'bubble_column', 'lava', 'fire', 'soul_fire', 'hopper', 'cauldron', 'water_cauldron', 'lava_cauldron', 'powder_snow_cauldron', 'composter'])
const FLUID = new Set(['water', 'lava'])
const BAD_BODY = new Set(['lava', 'fire', 'soul_fire', 'cobweb', 'powder_snow', 'sweet_berry_bush', 'magma_block', 'cactus', 'wither_rose', 'bubble_column'])
const SUNKEN_FLOOR = /^(hopper|soul_sand|chest|trapped_chest|ender_chest|farmland|dirt_path|lectern|enchanting_table|mud|composter|cauldron|water_cauldron|lava_cauldron)$/
const CLIMBABLE = /^(ladder|vine|scaffolding|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/

function isClimbable (block) {
  return Boolean(block && CLIMBABLE.test(block.name || ''))
}

function isBottomSlab (block) {
  if (!block || !/_slab$/.test(block.name || '')) return false
  const p = block.getProperties?.() || block.properties || {}
  return p.type === 'bottom'
}

// Low-profile blocks (repeater, comparator, carpet, daylight_detector, closed bottom trapdoor) that sit on a solid block
// and have a flat walkable collision top <= 0.375m so players can stand on and walk across them.
function isLowFloor (block) {
  if (!block) return false
  const n = block.name || ''
  const p = block.getProperties?.() || block.properties || {}
  if (p.waterlogged === true || p.waterlogged === 'true') return false
  if (/^(repeater|comparator|daylight_detector)$/.test(n) || /_carpet$/.test(n)) return true
  if (/_trapdoor$/.test(n) && (p.open === 'false' || p.open === false) && p.half === 'bottom') return true
  return false
}

function lowFloorHeight (block) {
  if (!block) return 0
  const n = block.name || ''
  if (/_carpet$/.test(n)) return 0.0625
  if (/^(repeater|comparator)$/.test(n)) return 0.125
  if (/_trapdoor$/.test(n)) return 0.1875
  if (n === 'daylight_detector') return 0.375
  return 0
}

function shapesOf (block) {
  if (!block) return []
  if (Array.isArray(block.shapes) && block.shapes.length) return block.shapes
  if (/(_fence_gate|_door)$/.test(block.name || '')) {
    const p = block.getProperties?.() || block.properties || {}
    if (p.open === 'true' || p.open === true) return []
  }
  if (/_slab$/.test(block.name || '')) {
    const p = block.getProperties?.() || block.properties || {}
    if (p.type === 'bottom') return [[0, 0, 0, 1, 0.5, 1]]
    if (p.type === 'top') return [[0, 0.5, 0, 1, 1, 1]]
  }
  return block.boundingBox === 'block' ? [[0, 0, 0, 1, 1, 1]] : []
}

function isAirLike (block) {
  return !block || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'
}

// Returns the true integer cell where the bot's feet reside (above a sunken block like a hopper bowl at y+0.6875 or chest at y+0.875).
function feetCellOf (world, pos) {
  const x = Math.floor(pos.x)
  const z = Math.floor(pos.z)
  let y = Math.floor(pos.y + 0.01)
  if (world) {
    const b = world.blockAt({ x, y, z })
    if (b && SUNKEN_FLOOR.test(b.name || '') && pos.y - y >= 0.62) {
      y += 1
    }
  }
  return { x, y, z }
}

// A cell the player's body can occupy (feet or head): no collision, nothing harmful.
function isBodyFree (block) {
  if (!block) return false
  if (BAD_BODY.has(block.name)) return false
  if (FLUID.has(block.name)) return false
  if (block.boundingBox === 'empty' || isAirLike(block)) return true
  if (/(_fence_gate|_door)$/.test(block.name || '') && !block.name.startsWith('iron_')) {
    const p = block.getProperties?.() || block.properties || {}
    if (p.open === 'true' || p.open === true) return true
  }
  return false
}

// A block whose top face is a full, flat, ordinary floor (including packed_ice / blue_ice / ice platforms).
// Excludes hoppers, chests, cauldrons, composters, and bottom slabs so bots never pick sunken bowls/trenches as standing spots.
function isFullTop (block) {
  if (!block || block.boundingBox !== 'block') return false
  if (/_slab$/.test(block.name || '')) {
    const p = block.getProperties?.() || block.properties || {}
    if (p.type === 'bottom') return false
  }
  if (HAZARD_STAND.has(block.name) || SUNKEN_FLOOR.test(block.name || '') || /_(carpet|pane|fence|fence_gate|wall|door)$|^glass_pane$/.test(block.name)) return false
  if (isIce(block)) return true
  return shapesOf(block).some(s => s[4] >= 0.999 && s[0] <= 0.02 && s[2] <= 0.02 && s[3] >= 0.98 && s[5] >= 0.98)
}

// Is there a collision surface directly under the bot's footprint at (about) its feet height?
function supportUnder (world, pos, tolerance = 0.12) {
  if (world && pos) {
    const fx = Math.floor(pos.x); const fy = Math.floor(pos.y + 0.01); const fz = Math.floor(pos.z)
    const b0 = world.blockAt({ x: fx, y: fy, z: fz })
    if (isClimbable(b0)) return { supported: true, top: pos.y, block: b0 }
    const b1 = world.blockAt({ x: fx, y: fy - 1, z: fz })
    if (isClimbable(b1)) return { supported: true, top: fy, block: b1 }
  }
  let best = null
  const x0 = Math.floor(pos.x - HALF_WIDTH + 1e-6)
  const x1 = Math.floor(pos.x + HALF_WIDTH - 1e-6)
  const z0 = Math.floor(pos.z - HALF_WIDTH + 1e-6)
  const z1 = Math.floor(pos.z + HALF_WIDTH - 1e-6)
  const yTop = Math.floor(pos.y + 1e-6)
  const yLow = Math.floor(pos.y - tolerance - 1e-6)
  for (let by = yTop; by >= yLow; by--) {
    for (let bx = x0; bx <= x1; bx++) {
      for (let bz = z0; bz <= z1; bz++) {
        const block = world.blockAt({ x: bx, y: by, z: bz })
        if (!block) continue
        for (const s of shapesOf(block)) {
          if (bx + s[3] <= pos.x - HALF_WIDTH + 1e-6 || bx + s[0] >= pos.x + HALF_WIDTH - 1e-6) continue
          if (bz + s[5] <= pos.z - HALF_WIDTH + 1e-6 || bz + s[2] >= pos.z + HALF_WIDTH - 1e-6) continue
          const top = by + s[4]
          if (top <= pos.y + 0.02 && top >= pos.y - tolerance) {
            if (!best || top > best.top) best = { supported: true, top, block }
          }
        }
      }
    }
  }
  return best || { supported: false, top: null, block: null }
}

class GroundMonitor {
  constructor (bot, world, logger) {
    this.bot = bot
    this.world = world
    this.logger = logger
    this.samples = []
    this.lastDiagnosticAt = 0
    this.onTick = () => this.sample()
    bot.on?.('physicsTick', this.onTick)
  }

  dispose () { this.bot.off('physicsTick', this.onTick) }

  sample () {
    if (this.bot.physicsEnabled === false) this.bot.physicsEnabled = true
    const e = this.bot.entity
    if (!e?.position) return
    this.samples.push({ t: Date.now(), y: e.position.y, x: e.position.x, z: e.position.z, vy: e.velocity?.y ?? 0, onGround: Boolean(e.onGround) })
    if (this.samples.length > 60) this.samples.shift()
    if (!e.isInWater && !e.isInLava && this.stillFor(250)) {
      const fc = feetCellOf(this.world, e.position)
      const under = this.world.blockAt({ x: fc.x, y: fc.y - 1, z: fc.z })
      const atFeet = this.world.blockAt({ x: fc.x, y: fc.y, z: fc.z })
      const centerAir = isAirLike(under) && isAirLike(atFeet)
      const activeEdgeAim = Boolean(this.bot.builder?.scaffold?._sliding) || ['edge slide', 'aiming', 'placing', 'click + server answer'].includes(this.bot.builder?.placer?.phase || '')
      if (centerAir && !activeEdgeAim) {
        if (this.bot.getControlState?.('sneak')) {
          if (this.bot.builder?.placer) this.bot.builder.placer._chestSneak = false
          try { this.bot.setControlState('sneak', false) } catch {}
        }
        const dxC = (fc.x + 0.5) - e.position.x
        const dzC = (fc.z + 0.5) - e.position.z
        if (Math.hypot(dxC, dzC) > 0.04) {
          e.position.x += dxC * 0.55
          e.position.z += dzC * 0.55
        }
        e.onGround = false
        if (e.velocity && e.velocity.y >= -0.02) e.velocity.y = -0.08
      }
    }
  }

  chunkLoaded () {
    const e = this.bot.entity
    if (!e?.position) return false
    return Boolean(this.world.blockAt(e.position.floored()))
  }

  stillFor (ms) {
    if (!this.samples.length) return false
    const last = this.samples[this.samples.length - 1]
    let oldest = last
    for (let i = this.samples.length - 1; i >= 0; i--) {
      const s = this.samples[i]
      if (Math.abs(s.y - last.y) > 0.002 || Math.hypot(s.x - last.x, s.z - last.z) > 0.02) break
      oldest = s
    }
    return last.t - oldest.t >= ms
  }

  hoverFor (ms, dy) {
    const n = this.samples.length
    if (n < 10) return false
    const last = this.samples[n - 1]
    if (last.t - this.samples[0].t < ms) return false
    let minY = Infinity; let maxY = -Infinity; let drift = 0
    for (const s of this.samples) {
      if (last.t - s.t > ms) continue
      minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y)
      drift = Math.max(drift, Math.hypot(s.x - last.x, s.z - last.z))
    }
    return maxY - minY < dy && drift < 0.4
  }

  state () {
    if (this.bot.physicsEnabled === false) this.bot.physicsEnabled = true
    const e = this.bot.entity
    if (!e?.position) return 'unloaded'
    if (!this.chunkLoaded()) return 'unloaded'
    if (e.isInLava) return 'swimming'
    const vy = e.velocity?.y ?? 0
    const fc = feetCellOf(this.world, e.position)
    if (isClimbable(this.world.blockAt(fc)) || isClimbable(this.world.blockAt({ x: fc.x, y: fc.y - 1, z: fc.z }))) {
      return 'grounded'
    }
    const support = supportUnder(this.world, e.position, e.isInWater ? 0.65 : 0.12)
    if (e.isInWater) {
      const head = this.world.blockAt({ x: fc.x, y: fc.y + 1, z: fc.z })
      const deep = !head || head.name === 'water' || head.name === 'bubble_column' || head.getProperties?.().waterlogged === true
      const under = this.world.blockAt({ x: fc.x, y: fc.y - 1, z: fc.z })
      const feetB = this.world.blockAt(fc)
      const hasSolidFloor = support.supported || isFullTop(under) || isBottomSlab(feetB) || isLowFloor(feetB)
      // Shallow wading: Mineflayer clears e.onGround when touching flowing/1-block water and buoyancy bobs feet up ~0.5m,
      // but if the head is in air (!deep) and a solid floor is directly underneath, the bot is grounded/wading, NOT swimming!
      if (!deep && (e.onGround || (hasSolidFloor && e.position.y - fc.y <= 0.68 && Math.abs(vy) < 0.35))) return 'grounded'
      if (deep || !e.onGround) return 'swimming'
    }
    const underAir = isAirLike(this.world.blockAt({ x: fc.x, y: fc.y - 1, z: fc.z })) && isAirLike(this.world.blockAt(fc))
    const activeEdgeAim = Boolean(this.bot.builder?.scaffold?._sliding) || ['edge slide', 'aiming', 'placing', 'click + server answer'].includes(this.bot.builder?.placer?.phase || '')
    if (underAir && !activeEdgeAim && this.stillFor(250)) {
      if (this.bot.getControlState?.('sneak')) {
        if (this.bot.builder?.placer) this.bot.builder.placer._chestSneak = false
        try { this.bot.setControlState('sneak', false) } catch {}
      }
      const dxC = (fc.x + 0.5) - e.position.x
      const dzC = (fc.z + 0.5) - e.position.z
      if (Math.hypot(dxC, dzC) > 0.04) {
        e.position.x += dxC * 0.55
        e.position.z += dzC * 0.55
      }
      e.onGround = false
    }
    const supportAfter = (underAir && !activeEdgeAim && this.stillFor(250)) ? supportUnder(this.world, e.position, 0.12) : support
    if ((e.onGround && !underAir) || (supportAfter.supported && Math.abs(vy) < 0.1 && !(underAir && !activeEdgeAim && this.stillFor(250)))) return 'grounded'
    if (this.hoverFor(1500, 0.22)) return 'resting'
    if (this.stillFor(700) && Math.abs(vy + 0.0784) < 0.003) return 'resting'
    if (underAir && !support.supported) {
      if (this.bot.getControlState?.('sneak') && !this.bot.builder?.scaffold?._sliding) {
        if (this.bot.builder?.placer) this.bot.builder.placer._chestSneak = false
        try { this.bot.setControlState('sneak', false) } catch {}
      }
      if (vy < -0.1) return 'falling'
      if (vy > 0.1) return 'rising'
      return 'airborne'
    }
    if (vy < -0.1) return 'falling'
    if (vy > 0.1) return 'rising'
    return 'phantom'
  }

  isSafeToWork () {
    const s = this.state()
    return s === 'grounded' || s === 'resting'
  }

  describe () {
    const e = this.bot.entity
    if (!e?.position) return 'no entity'
    const p = e.position
    const f = p.floored()
    const names = [0, -1, 1].map(dy => {
      const b = this.world.blockAt(f.offset(0, dy, 0))
      return `${dy >= 0 ? '+' : ''}${dy}:${b ? b.name : 'UNLOADED'}`
    }).join(' ')
    const sup = supportUnder(this.world, p)
    const v = e.velocity
    return `state=${this.state()} pos=(${p.x.toFixed(3)},${p.y.toFixed(4)},${p.z.toFixed(3)}) vel=(${v.x.toFixed(3)},${v.y.toFixed(4)},${v.z.toFixed(3)}) onGround=${e.onGround} water=${Boolean(e.isInWater)} support=${sup.supported ? `${sup.block.name}@top=${sup.top}` : 'none'} cells[${names}] physics=${this.bot.physicsEnabled} gm=${this.bot.game?.gameMode}`
  }

  async waitSafe (timeoutMs = 8000) {
    const started = Date.now()
    let st = this.state()
    while (Date.now() - started < timeoutMs) {
      st = this.state()
      if (st === 'grounded' || st === 'resting') return st
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    return st
  }
}

function isIce (block) { return Boolean(block && /(^|_)ice$/.test(block.name) && block.boundingBox === 'block') }
function iceStandOk (world, cell) {
  const g = world.blockAt(cell.offset(0, -1, 0))
  return isIce(g)
}

module.exports = { isIce, iceStandOk, isClimbable, isBottomSlab, isLowFloor, lowFloorHeight, shapesOf, isAirLike, feetCellOf, isBodyFree, isFullTop, supportUnder, GroundMonitor, HAZARD_STAND, FLUID, BAD_BODY }
