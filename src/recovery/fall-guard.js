'use strict'
// Fall prevention & Virtual 3D Spatial Hazard Brain.
// 1. Scans the local 3D neighborhood around the bot to build a live virtual picture of open vs narrow/perforated terrain.
// 2. Distinguishes real hazards (lava, fire, deep drops > 3 blocks, enclosed 1x1/walled pits, hopper/water trenches) from safe 1-3 block steps.
// 3. Remembers real hazard cells (lava / enclosed pits) at their specific Y level until covered by a solid block.
// 4. Compensates for sprinting momentum / residual velocity by damping horizontal velocity at real hazard edges without locking sneak or steering backward.
const { Vec3 } = require('../util/vec3')

const holdOf = bot => (bot.__fallHold = bot.__fallHold || 0)
function hold (bot) { bot.__fallHold = holdOf(bot) + 1; let done = false; return () => { if (!done) { done = true; bot.__fallHold = Math.max(0, holdOf(bot) - 1) } } }
async function withHold (bot, fn) { const release = hold(bot); try { return await fn() } finally { release() } }

const TRAP_FLOOR = /^(hopper|cauldron|water_cauldron|lava_cauldron|composter|lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush)$/
const CLIMBABLE = /^(ladder|vine|scaffolding|twisting_vines|twisting_vines_plant|weeping_vines|weeping_vines_plant|cave_vines|cave_vines_plant)$/

class FallGuard {
  constructor ({ bot, world, config, logger, navigation, ground }) {
    Object.assign(this, { bot, world, config, logger, navigation, ground })
    this.lastSafe = null
    this.holes = new Map() // 'x,z' -> { y, at, kind }
    this.virtualMap = new Map() // 'x,y,z' -> { cls, at }
    this.stats = { stops: 0, falls: 0, recovered: 0 }
    this.falling = null
    this.fell = null
    this.lastStopAt = 0
    this.sneakClampTicks = 0
    this.returnCache = new Map()
    this.onTick = () => { try { this.tick() } catch { /* never throw from a physics tick */ } }
  }

  attach () { this.bot.on('physicsTick', this.onTick) }
  detach () { this.bot.removeListener('physicsTick', this.onTick) }

  floorWithin (x, y, z, maxDrop) {
    const fx = Math.floor(x); const fz = Math.floor(z); const fy = Math.floor(y + 0.01)
    const bHere = this.world.blockAt(new Vec3(fx, fy, fz))
    if (bHere && CLIMBABLE.test(bHere.name || '')) return true
    if (bHere && /_slab$/.test(bHere.name || '') && (bHere.getProperties?.()?.type || bHere.properties?.type) === 'bottom') return true
    const planner = this.bot?.builder?.planner
    for (let d = 0; d <= maxDrop; d++) {
      const b = this.world.blockAt(new Vec3(fx, fy - 1 - d, fz))
      if (!b) return true // chunk not loaded: assume fine
      if (b.name === 'hopper') {
        if (planner?.isActivePitCell ? planner.isActivePitCell(fx, fy - d, fz) : true) return false
        return true
      }
      if (TRAP_FLOOR.test(b.name || '')) return false
      if (b.boundingBox === 'block' || CLIMBABLE.test(b.name || '') || /water|bubble_column/.test(b.name) || b.properties?.waterlogged === true || b.getProperties?.().waterlogged === true) return true
    }
    return false
  }

  isHole (x, z, y = null) { return Boolean(this.holeKind(x, z, y)) }
  holeKind (x, z, y = null) {
    const fx = Math.floor(x); const fz = Math.floor(z)
    const k = `${fx},${fz}`
    const h = this.holes.get(k)
    if (!h) return null
    const botY = y != null ? Math.floor(y + 0.01) : (this.bot?.entity?.position ? Math.floor(this.bot.entity.position.y + 0.01) : h.y)
    // Clear hole memory as soon as a solid non-trap block has been placed at `h.y - 1` or `h.y` (or `botY - 1`),
    // even on diagonal/stepped roofs where air exists 2+ blocks below the roof shell!
    if (this.floorWithin(fx, h.y, fz, 0) || (Math.abs(botY - h.y) <= 1 && this.floorWithin(fx, botY, fz, 0))) {
      this.holes.delete(k)
      return null
    }
    // A hole recorded at deck height `h.y` must NEVER block walking on flat ground or another floor >1 block away!
    if (Math.abs(botY - h.y) > 1) {
      if (h.kind === 'lava') {
        const bHere = this.world.blockAt(new Vec3(fx, botY, fz))
        const bBelow = this.world.blockAt(new Vec3(fx, botY - 1, fz))
        if (bHere?.name === 'lava' || bBelow?.name === 'lava') return 'lava'
      }
      return null
    }
    const curY = botY
    if (this.floorWithin(fx, curY, fz, 1) && !this.hazardAt(fx + 0.5, curY, fz + 0.5, 1)) {
      this.holes.delete(k)
      return null
    }
    return h.kind || 'pit'
  }

  recordHole (x, y, z, kind = 'pit', persist = false) {
    const fx = Math.floor(x); const fy = Math.floor(y + 0.01); const fz = Math.floor(z)
    this.holes.set(`${fx},${fz}`, { y: fy, at: Date.now(), kind })
    if (persist && kind === 'lava') {
      try {
        this.bot?.builder?.buildMemory?.recordHazardCell?.(new Vec3(fx, fy, fz), 'lava')
      } catch {}
    }
  }

  // Builds a virtual 3D spatial picture of the local neighborhood around `pos`:
  // Returns { mode: 'open' | 'narrow', safeNeighbors (0..8), minHazardDist, overhanging }
  analyzeNeighborhood (pos = this.bot?.entity?.position) {
    if (!pos) return { mode: 'open', safeNeighbors: 8, minHazardDist: 99, overhanging: false }
    const fx = Math.floor(pos.x); const fy = Math.floor(pos.y + 0.01); const fz = Math.floor(pos.z)
    let floorMask = 0
    for (let mx = -1; mx <= 1; mx++) {
      for (let mz = -1; mz <= 1; mz++) {
        const mb = this.world.blockAt(new Vec3(fx + mx, fy - 1, fz + mz))
        floorMask = (floorMask << 1) | (mb && mb.boundingBox === "block" ? 1 : 0)
      }
    }
    const cacheKey = `${fx},${fy},${fz}:${floorMask}`
    const now = Date.now()
    if (this._nhCache && this._nhCache.key === cacheKey && now - this._nhCache.at < 120 && this.holes.size === this._nhCache.holesSize) {
      return this._nhCache.res
    }
    let safeNeighbors = 0
    let minHazardDist = 99
    const planner = this.bot?.builder?.planner
    const buildMem = this.bot?.builder?.buildMemory

    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        const cx = fx + dx; const cz = fz + dz
        const dist = Math.hypot(cx + 0.5 - pos.x, cz + 0.5 - pos.z)
        const ck0 = `${cx},${fy},${cz}`
        const ck1 = `${cx},${fy - 1},${cz}`
        const inMemHole = Boolean(this.holeKind(cx, cz, fy)) ||
          Boolean(planner?.isActivePitCell ? planner.isActivePitCell(cx, fy, cz) : planner?.pitCells?.has(ck0)) ||
          Boolean(planner?.isActivePitCell ? planner.isActivePitCell(cx, fy - 1, cz) : planner?.pitCells?.has(ck1)) ||
          Boolean(buildMem?.isHazardWorldCell?.({ x: cx, y: fy, z: cz }))

        const bFeet = this.world.blockAt(new Vec3(cx, fy, cz))
        const bHead = this.world.blockAt(new Vec3(cx, fy + 1, cz))
        const bFloor = this.world.blockAt(new Vec3(cx, fy - 1, cz))
        const feetBottomSlab = Boolean(bFeet && /_slab$/.test(bFeet.name || '') && (bFeet.getProperties?.()?.type || bFeet.properties?.type) === 'bottom')
        const bodyClear = (!bFeet || bFeet.boundingBox !== 'block' || feetBottomSlab) && (!bHead || bHead.boundingBox !== 'block')
        const solidFloor = Boolean((feetBottomSlab && (!bHead || bHead.boundingBox !== 'block')) || (bFloor && bFloor.boundingBox === 'block' && !TRAP_FLOOR.test(bFloor.name || '')))

        let cellSafe = solidFloor && bodyClear && !inMemHole
        if (!cellSafe && Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && !inMemHole) {
          // Check if it is a safe 1-block or 2-block step down onto open non-trap ground, or a 1-block step up
          const bFloorDown1 = this.world.blockAt(new Vec3(cx, fy - 2, cz))
          const bFloorDown2 = this.world.blockAt(new Vec3(cx, fy - 3, cz))
          const stepDown1Safe = bodyClear && (!bFloor || bFloor.boundingBox !== 'block') && Boolean(bFloorDown1 && bFloorDown1.boundingBox === 'block' && !TRAP_FLOOR.test(bFloorDown1.name || ''))
          const stepDown2Safe = bodyClear && (!bFloor || bFloor.boundingBox !== 'block') && (!bFloorDown1 || bFloorDown1.boundingBox !== 'block') && Boolean(bFloorDown2 && bFloorDown2.boundingBox === 'block' && !TRAP_FLOOR.test(bFloorDown2.name || '')) && !planner?.pitCells?.has(`${cx},${fy - 2},${cz}`)
          const bHeadUp = this.world.blockAt(new Vec3(cx, fy + 2, cz))
          const stepUpSafe = Boolean(bFeet && bFeet.boundingBox === 'block' && !TRAP_FLOOR.test(bFeet.name || '')) && (!bHead || bHead.boundingBox !== 'block') && (!bHeadUp || bHeadUp.boundingBox !== 'block')
          if (stepDown1Safe || stepDown2Safe || stepUpSafe) cellSafe = true
        }

        if (dx !== 0 || dz !== 0) {
          if (Math.abs(dx) <= 1 && Math.abs(dz) <= 1 && cellSafe) {
            safeNeighbors++
          }
          if (!cellSafe || inMemHole) {
            const hz = inMemHole ? 'pit' : this.hazardAt(cx + 0.5, fy, cz + 0.5, 2)
            if (hz && dist < minHazardDist) minHazardDist = dist
          }
        }
        this.virtualMap.set(ck0, { cls: cellSafe ? 'safe' : 'hazard', at: Date.now() })
      }
    }
    if (this.virtualMap.size > 1500) this.virtualMap.clear()
    // Overhanging is true when the bot's center is over a cell without immediate support (or over a hazard)
    const overhanging = !this.floorWithin(pos.x, pos.y, pos.z, 0) && (!this.floorWithin(pos.x, pos.y, pos.z, 2) || Boolean(this.hazardAt(pos.x, pos.y, pos.z, 2)))
    const mode = (safeNeighbors >= 5 && minHazardDist > 1.35 && !overhanging) ? 'open' : 'narrow'
    const res = { mode, safeNeighbors, minHazardDist, overhanging }
    this._nhCache = { key: cacheKey, at: now, holesSize: this.holes.size, res }
    return res
  }

  // what is below / ahead at column (x,z) from feet level y:
  // 'lava' | 'pit' (a drop exceeding maxDrop or into a walled pocket/water trench we cannot climb out of) | 'void' | null
  hazardAt (x, y, z, maxDrop = 1) {
    const fx = Math.floor(x); const fz = Math.floor(z); const fy = Math.floor(y + 0.01)
    const planner = this.bot?.builder?.planner
    const at = (yy) => this.world.blockAt(new Vec3(fx, yy, fz))
    const scanDepth = Math.max(maxDrop + 2, 16)
    const bFloor1 = at(fy - 1)
    const bFloor2 = at(fy - 2)
    if (bFloor1 && bFloor1.boundingBox !== 'block' && (!bFloor2 || bFloor2.boundingBox !== 'block') && planner?.isPendingCell?.(new Vec3(fx, fy - 1, fz))) {
      return 'pit'
    }
    for (let d = 0; d <= scanDepth; d++) {
      if (d >= 1 && (planner?.isActivePitCell ? planner.isActivePitCell(fx, fy - d, fz) : planner?.pitCells?.has(`${fx},${fy - d},${fz}`))) return 'pit'
      const b = at(fy - d)
      if (!b) return null // unloaded: assume fine
      if (/^(lava|fire|soul_fire|magma_block|cactus|sweet_berry_bush|campfire|soul_campfire)$/.test(b.name)) return 'lava'
      // Check solid block collision BEFORE waterlogged property so solid waterlogged blocks (like oak_leaves[waterlogged=true] or slabs)
      // act as solid floors and never look through at sealed lava below!
      if (d > 0 && (b.boundingBox === 'block' || CLIMBABLE.test(b.name || ''))) {
        if (/^(cauldron|composter)$/.test(b.name || '') && d >= 1) return 'pit'
        if (b.name === 'hopper' && d >= 1 && planner?.isActivePitCell?.(fx, fy - d + 1, fz)) return 'pit'
        if (d > maxDrop + 1) return 'pit'
        if (d >= 2 && !this.canReturn(fx, fy - d + 1, fz, fy)) return 'pit'
        return null
      }
      if (d > 0 && (/^(water|bubble_column)$/.test(b.name) || b.properties?.waterlogged === true || b.getProperties?.().waterlogged === true)) {
        const under = at(fy - d - 1)
        if (under && /^(lava|fire|magma_block)$/.test(under.name)) return 'lava'
        if (d > maxDrop + 1) return 'pit'
        if (d >= 2 && !this.canReturn(fx, fy - d + 1, fz, fy)) return 'pit'
        return null
      }
      if (d === 0 && (b.boundingBox === 'block' || CLIMBABLE.test(b.name || '') || /^(water|bubble_column)$/.test(b.name))) return null
    }
    return 'void'
  }

  // raycast / column probe in direction (ux, uz) from (x, y, z)
  rayHazard (x, y, z, ux, uz, dist = 1.1, maxDrop = 1) {
    const len = Math.hypot(ux, uz)
    if (len < 1e-4) return null
    const dx = ux / len; const dz = uz / len
    const steps = [0.35, 0.65, 0.95, Math.min(1.25, dist)]
    // Check if (px, pz) is supported by an adjacent solid wall/column under the player's ±0.26m AABB while walking parallel or toward that wall
    const aabbSupported = (px, pz) => {
      for (const [ox, oz] of [[0.26, 0], [-0.26, 0], [0, 0.26], [0, -0.26]]) {
        const sx = Math.floor(px + ox); const sz = Math.floor(pz + oz)
        if (sx === Math.floor(px) && sz === Math.floor(pz)) continue
        if (this.floorWithin(sx + 0.5, y, sz + 0.5, 0) && !this.hazardAt(sx + 0.5, y, sz + 0.5, 1)) {
          const curDistToWall = Math.hypot((sx + 0.5) - x, (sz + 0.5) - z)
          const nextDistToWall = Math.hypot((sx + 0.5) - px, (sz + 0.5) - pz)
          if (nextDistToWall <= curDistToWall + 0.05 || (Math.abs(ox) > 0 ? Math.abs((sx + 0.5) - px) <= 0.72 : Math.abs((sz + 0.5) - pz) <= 0.72)) {
            return true
          }
        }
      }
      return false
    }
    for (const s of steps) {
      if (s > dist + 0.05) break
      const px = x + dx * s; const pz = z + dz * s
      const hz = this.hazardAt(px, y, pz, maxDrop)
      if (hz) {
        if (hz === 'pit' && aabbSupported(px, pz)) continue
        return { kind: hz, x: Math.floor(px), z: Math.floor(pz), dist: s }
      }
      if (maxDrop <= 1 && !this.floorWithin(px, y, pz, maxDrop)) {
        if (aabbSupported(px, pz)) continue
        return { kind: 'pit', x: Math.floor(px), z: Math.floor(pz), dist: s }
      }
    }
    return null
  }

  // after dropping into (x,y,z): can the bot walk / step back up to level `startY` or is it open ground?
  canReturn (x, y, z, startY) {
    const ck = `${x},${y},${z}>${startY}`
    const now = Date.now()
    const cached = this.returnCache.get(ck)
    if (cached && now - cached.at < 6000) return cached.ok
    if (this.returnCache.size > 400) this.returnCache.clear()
    try {
      const { flood } = require('./exit-planner')
      const fl = flood((a, b, c) => this.world.blockAt(new Vec3(a, b, c)), { x, y, z }, { budget: 400, maxDrop: 3 })
      // Open ground (>= 48 connected walkable cells) is NOT an enclosed pit trap!
      let ok = Boolean(fl.open || (fl.cells && fl.cells.size >= 48))
      if (!ok && fl.cells) {
        for (const n of fl.cells.values()) {
          if (n.y >= startY) { ok = true; break }
        }
      }
      this.returnCache.set(ck, { ok, at: now })
      return ok
    } catch { return true }
  }

  // Is cell (hx, hz) part of the bot's active planned pathfinder/human route (e.g. an intentional 1-3 block step-down or 1-block parkour hop)?
  isPlannedStep (hx, hz, fy) {
    try {
      if (this.holeKind(hx, hz, fy)) return false
      const planner = this.bot?.builder?.planner
      if (planner?.isActivePitCell ? (planner.isActivePitCell(hx, fy, hz) || planner.isActivePitCell(hx, fy - 1, hz)) : (planner?.pitCells?.has(`${hx},${fy},${hz}`) || planner?.pitCells?.has(`${hx},${fy - 1},${hz}`))) return false
      const route = this.navigation?.human?.route
      if (Array.isArray(route) && route.length) {
        for (const wp of route) {
          if (Math.abs(Math.floor(wp.x) - hx) <= 2 && Math.abs(Math.floor(wp.z) - hz) <= 2 && fy - wp.y <= 3.2 && fy - wp.y >= -1.5 && this.floorWithin(wp.x, wp.y, wp.z, 0)) {
            return true
          }
        }
      }
    } catch {}
    return false
  }

  tick () {
    const bot = this.bot; const e = bot.entity
    if (!e || !bot.builder?.running || bot.health <= 0) return
    if (holdOf(bot) > 0) {
      this.falling = null
      if (this.sneakClampTicks > 0) { this.sneakClampTicks = 0; if (!bot.builder?.placer?._chestSneak) bot.setControlState('sneak', false) }
      return
    }
    const fx0 = Math.floor(e.position.x); const fy0 = Math.floor(e.position.y + 0.01); const fz0 = Math.floor(e.position.z)
    const bFeet = this.world.blockAt(new Vec3(fx0, fy0, fz0))
    const bBelow = this.world.blockAt(new Vec3(fx0, fy0 - 1, fz0))
    if ((bFeet && CLIMBABLE.test(bFeet.name || '')) || (bBelow && CLIMBABLE.test(bBelow.name || '') && !e.onGround)) {
      this.falling = null
      if (this.sneakClampTicks > 0) { this.sneakClampTicks = 0; if (!bot.builder?.placer?._chestSneak) bot.setControlState('sneak', false) }
      return
    }
    const v = e.velocity
    const speed = Math.hypot(v.x, v.z)
    const overhangingHazard = e.onGround && !this.floorWithin(e.position.x, e.position.y, e.position.z, 0) && Boolean(this.hazardAt(e.position.x, e.position.y, e.position.z, 2))

    if (this.sneakClampTicks > 0) {
      this.sneakClampTicks--
      if (this.sneakClampTicks > 0 && overhangingHazard) {
        bot.setControlState('sneak', true)
      } else {
        this.sneakClampTicks = 0
        if (!bot.builder?.placer?._chestSneak) bot.setControlState('sneak', false)
      }
    }

    // Continuously track lastSafe on any grounded safe floor whose center is directly over solid support
    if (e.onGround && this.floorWithin(e.position.x, e.position.y, e.position.z, 0) && !this.hazardAt(e.position.x, e.position.y, e.position.z, 2)) {
      this.lastSafe = new Vec3(Math.floor(e.position.x) + 0.5, Math.floor(e.position.y + 0.01), Math.floor(e.position.z) + 0.5)
    }

    if (!e.onGround && v.y < -0.55) {
      if (!this.falling) this.falling = { pos: e.position.clone(), y: e.position.y, from: this.lastSafe, at: Date.now() }
    } else if (this.falling && e.onGround) {
      const dy = this.falling.y - e.position.y
      const landedCell = e.position.floored()
      const landedInPit = Boolean(bot.builder?.planner?.pitCells?.has(`${landedCell.x},${landedCell.y},${landedCell.z}`)) ||
        Boolean(e.isInWater) ||
        !this.canReturn(landedCell.x, landedCell.y, landedCell.z, Math.floor(this.falling.y + 0.01))
      if (dy >= 2.8 || (dy >= 1.8 && landedInPit)) {
        // Record real holes/pits so the bot never falls into that pit cell again
        this.recordHole(e.position.x, this.falling.y, e.position.z, 'pit', false)
        if (this.falling.pos) this.recordHole(this.falling.pos.x, this.falling.y, this.falling.pos.z, 'pit', false)
      }
      if (dy >= 2.8 || (dy >= 1.8 && landedInPit)) {
        this.stats.falls++
        this.fell = { dy, from: this.falling.from, at: Date.now() }
        this.logger?.warn?.(`fell ${dy.toFixed(1)} blocks at ${e.position.floored()}`)
      }
      this.falling = null
    }

    if (!e.onGround || v.y > 0.1) return
    const cs = bot.controlState || {}
    const fwd = (cs.forward ? 1 : 0) - (cs.back ? 1 : 0)
    const str = (cs.left ? 1 : 0) - (cs.right ? 1 : 0)
    const keyX = fwd * -Math.sin(e.yaw) + str * -Math.cos(e.yaw)
    const keyZ = fwd * -Math.cos(e.yaw) + str * Math.sin(e.yaw)
    const hasKey = Math.hypot(keyX, keyZ) > 0.1
    if (speed < 0.02 && !hasKey) { this.edgeStops = 0; return }

    const activeWalk = Boolean(this.navigation?.human?.activeWalk)
    // When human.js is actively walking on a planned route, human.js already manages edge-sneaking and waypoints;
    // only intervene if the immediate step is into lava or an unplanned >3-block drop!
    const maxDrop = 3
    let hit = null
    if (speed >= 0.02) {
      const lookDist = activeWalk ? 0.38 : Math.min(0.95, Math.max(0.45, speed * 3.0))
      hit = this.rayHazard(e.position.x, e.position.y, e.position.z, v.x, v.z, lookDist, maxDrop)
    }
    if (!hit && hasKey && !activeWalk && !cs.sneak) {
      hit = this.rayHazard(e.position.x, e.position.y, e.position.z, keyX, keyZ, 0.45, maxDrop)
    }
    if (!hit) { this.edgeStops = 0; return }
    // When already sneaking on solid ground (`cs.sneak && e.onGround`) and not facing lava, Vanilla Minecraft physics
    // already clamps the player to the block edge so the bot cannot fall off — never zero out movement keys during sneak-settle/slide!
    if (cs.sneak && hit.kind !== 'lava') {
      this.edgeStops = 0
      return
    }
    const fy = Math.floor(e.position.y + 0.01)
    if (hit.kind === 'pit' && this.isPlannedStep(hit.x, hit.z, fy) && (!this.hazardAt(hit.x + 0.5, fy, hit.z + 0.5, 3) || activeWalk)) {
      this.edgeStops = 0
      return
    }
    // Release movement keys, engage brief Vanilla sneak edge-clamping, and damp residual horizontal velocity so momentum cannot slide the bot into the hole!
    for (const k of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) bot.setControlState(k, false)
    bot.setControlState('sneak', true)
    this.sneakClampTicks = 2
    const isHurt = Date.now() - (this.bot.lastHurtAt || 0) < 1800
    if (!isHurt) {
      try { v.x *= 0.12; v.z *= 0.12 } catch {}
    }
    this.stats.stops++
    this.edgeStops = (this.edgeStops || 0) + 1
    if (hit.kind === 'lava' || hit.kind === 'void' || this.edgeStops >= 2) {
      this.recordHole(hit.x, e.position.y, hit.z, hit.kind, hit.kind === 'lava')
    }
    if (Date.now() - this.lastStopAt > 2500) {
      this.lastStopAt = Date.now()
      this.logger?.warn?.(`hazard guard: stopped before ${hit.kind === 'lava' ? 'lava / fire' : `a deep hole (${hit.kind})`} at ${hit.x},${Math.floor(e.position.y)},${hit.z}`)
      if (hit.kind === 'lava' || this.edgeStops >= 3) {
        try { this.navigation.stop() } catch { /* ok */ }
      }
    }
  }

  async recover () {
    const f = this.fell
    this.fell = null
    if (!f || !f.from || !this.bot.entity) return false
    if (Date.now() - f.at > 60_000) return false
    const p = this.bot.entity.position
    if (this.floorWithin(p.x, p.y, p.z, 0) && !this.hazardAt(p.x, p.y, p.z, 2) && this.canReturn(Math.floor(p.x), Math.floor(p.y + 0.01), Math.floor(p.z), Math.floor(f.from.y + 0.01))) {
      return false
    }
    this.logger?.info?.(`fall recovery: back to the last safe spot ${f.from.floored()}`)
    try {
      await this.ground.waitSafe(3000)
      await this.navigation.goTo(f.from, 1.5, 25_000, { human: true })
      this.stats.recovered++
      return true
    } catch (error) { this.logger.debug?.(`fall recovery: ${error.message}`); return false }
  }
}

module.exports = { FallGuard, hold, withHold }
