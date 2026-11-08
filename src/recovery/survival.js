'use strict'
const { withHold } = require('./fall-guard')
// Survival skills a real player has, using plain survival actions only (no /tp, no /setblock):
//  - auto-eat
//  - swim out of water pits / currents
//  - throw an ender pearl with a gravity-corrected raycast/ballistic aim (including out of shallow water trenches & tunnels)
// The pure parts (solveThrow, findWaterExit) take a blockAt(x,y,z) function so they are unit-testable.

const { Vec3 } = require('../util/vec3')
const { sleep, waitFor, withTimeout } = require('../util/async')
const { checkAbort } = require('../util/abort')

const WATERISH = /^(water|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/
const isWater = b => Boolean(b && (WATERISH.test(b.name) || b.properties?.waterlogged === true || b.getProperties?.().waterlogged === true))
const isSolid = b => Boolean(b && b.boundingBox === 'block' && b.name !== 'water')
const isFree = b => Boolean(b && b.boundingBox !== 'block')
const isAirOrWater = b => Boolean(b && (/^(air|cave_air|void_air)$/.test(b.name) || isWater(b)))
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const BAD_FOOD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew', 'enchanted_golden_apple', 'golden_apple', 'raw_chicken', 'chicken', 'tropical_fish', 'cod', 'salmon'])
const SUNKEN_LANDING = /^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/

// ---------- ender pearl ballistics ---------------------------------------------------------------
// Vanilla thrown pearl: start at eye height - 0.1, speed 1.5 along the look direction, every tick
// pos += vel; vel *= 0.99; vel.y -= 0.03.
function simulatePearl (blockAt, eye, yaw, pitch, speed = 1.5, maxTicks = 90, ents = null, ctx = null) {
  let px = eye.x; let py = eye.y - 0.1; let pz = eye.z
  const cp = Math.cos(pitch)
  let vx = -Math.sin(yaw) * cp * speed; let vy = Math.sin(pitch) * speed; let vz = -Math.cos(yaw) * cp * speed
  // vanilla adds the thrower's own motion (x and z always, y only while not on the ground)
  if (ctx && ctx.vel) { vx += ctx.vel.x || 0; vz += ctx.vel.z || 0; if (!ctx.onGround) vy += ctx.vel.y || 0 }
  let prev = { x: px, y: py, z: pz }
  for (let t = 0; t < maxTicks; t++) {
    const len = Math.hypot(vx, vy, vz)
    const steps = Math.max(1, Math.ceil(len / 0.25))
    for (let s = 1; s <= steps; s++) {
      const q = { x: px + vx * s / steps, y: py + vy * s / steps, z: pz + vz * s / steps }
      const bx = Math.floor(q.x); const by = Math.floor(q.y); const bz = Math.floor(q.z)
      const b = blockAt(bx, by, bz)
      if (!b) return { unloaded: true }
      if (ents && t >= 1) { for (const e of ents) if (Math.abs(q.x - e.x) < 0.45 && Math.abs(q.z - e.z) < 0.45 && q.y > e.y - 0.15 && q.y < e.y + 1.95) return null }
      if (b.boundingBox === 'block') {
        const topFace = Math.floor(prev.y) > by && prev.y >= by + 0.95
        return { hit: prev, block: { x: bx, y: by, z: bz }, vy, ticks: t, topFace }
      }
      prev = q
    }
    const wet = isWater(blockAt(Math.floor(px), Math.floor(py), Math.floor(pz)))
    const drag = wet ? 0.8 : 0.99
    px += vx; py += vy; pz += vz
    vx *= drag; vy *= drag; vz *= drag; vy -= 0.03
    if (py < -80) return null
  }
  return null
}

// other players / bots that would stop a pearl
function playerBlockers (bot) {
  const out = []
  try { for (const e of Object.values(bot.entities || {})) { if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue; if (e.position.distanceTo(bot.entity.position) > 60) continue; out.push({ x: e.position.x, y: e.position.y, z: e.position.z }) } } catch { /* none */ }
  return out
}

// What a throw with THIS camera angle would do: { err, ticks } when it comes down on the TOP face of the floor under `stand`, else null.
function evalThrow (blockAt, eye, yaw, pitch, stand, ents = null, ctx = null) {
  const highOrFar = (stand.y - (eye.y - 1.62)) >= 4.5 || Math.hypot(stand.x - eye.x, stand.z - eye.z) >= 15
  const maxPitchDeg = highOrFar ? 82 : 56
  const maxFlightTicks = highOrFar ? 90 : 48
  if (Math.abs(pitch) > maxPitchDeg * Math.PI / 180) return null
  const tx = Math.floor(stand.x); const ty = Math.floor(stand.y); const tz = Math.floor(stand.z)
  const r = simulatePearl(blockAt, eye, yaw, pitch, 1.5, maxFlightTicks + 2, ents, ctx)
  if (!r || r.unloaded || r.vy >= 0 || r.ticks > maxFlightTicks || r.block.y !== ty - 1) return null
  if (!r.topFace || r.hit.y < ty - 0.05) return null
  const err = Math.hypot(r.hit.x - (tx + 0.5), r.hit.z - (tz + 0.5))
  if (err > 1.2) return null
  const hx = Math.floor(r.hit.x); const hz = Math.floor(r.hit.z)
  const floorHit = blockAt(hx, ty - 1, hz)
  if (!floorHit || floorHit.boundingBox !== 'block' || SUNKEN_LANDING.test(floorHit.name || '')) return null
  const free = b => b && b.boundingBox !== 'block' && !/^(water|lava|fire|soul_fire)$/.test(b.name || '')
  if (!free(blockAt(hx, ty, hz)) || !free(blockAt(hx, ty + 1, hz))) return null
  return { err, ticks: r.ticks }
}

// Aim at the floor cell under `stand` (feet position, block centre). Returns { yaw, pitch, err, ticks } or null.
function solveThrow (blockAt, eye, stand, ents = null, ctx = null) {
  const tx = Math.floor(stand.x); const ty = Math.floor(stand.y); const tz = Math.floor(stand.z)
  const dx = stand.x - eye.x; const dz = stand.z - eye.z
  const yaw = Math.atan2(-dx, -dz)
  const horiz = Math.hypot(dx, dz)
  if (horiz < 2 || horiz > 36) return null
  const highOrFar = (stand.y - (eye.y - 1.62)) >= 4.5 || horiz >= 15
  const maxPitchDeg = highOrFar ? 82 : 55
  const maxFlightTicks = highOrFar ? 90 : 48
  // Never throw an ender pearl to a landing spot next to lava/fire, and check if landing is on a narrow rim next to water
  let narrowWaterRim = false
  for (let lx = -1; lx <= 1; lx++) {
    for (let lz = -1; lz <= 1; lz++) {
      for (let ly = -1; ly <= 1; ly++) {
        const lb = blockAt(tx + lx, ty + ly, tz + lz)
        if (lb && /^(lava|fire|soul_fire|magma_block)$/.test(lb.name)) return null
      }
      if (Math.abs(lx) + Math.abs(lz) === 1) {
        const adjFloor = blockAt(tx + lx, ty - 1, tz + lz)
        const adjBelow = blockAt(tx + lx, ty - 2, tz + lz)
        if ((!adjFloor || adjFloor.boundingBox !== 'block') && (isWater(adjFloor) || isWater(adjBelow))) {
          narrowWaterRim = true
        }
      }
    }
  }
  const landingFree = b => b && b.boundingBox !== 'block' && !/^(water|lava|fire|soul_fire)$/.test(b.name)
  const maxAllowedErr = narrowWaterRim ? 0.55 : 0.95
  const score = (pitch, y = yaw, maxErr = maxAllowedErr) => {
    if (Math.abs(pitch) > (maxPitchDeg + 1) * Math.PI / 180) return null
    const r = simulatePearl(blockAt, eye, y, pitch, 1.5, maxFlightTicks + 2, ents, ctx)
    if (!r || r.unloaded || r.vy >= 0 || r.ticks > maxFlightTicks) return null
    if (r.block.y !== ty - 1 || !r.topFace || r.hit.y < ty - 0.05) return null
    const err = Math.hypot(r.hit.x - (tx + 0.5), r.hit.z - (tz + 0.5))
    if (err > maxErr) return null
    const hx = Math.floor(r.hit.x); const hz = Math.floor(r.hit.z)
    const fHit = blockAt(hx, ty - 1, hz)
    if (!fHit || fHit.boundingBox !== 'block' || SUNKEN_LANDING.test(fHit.name || '')) return null
    if (!landingFree(blockAt(hx, ty, hz)) || !landingFree(blockAt(hx, ty + 1, hz))) return null
    return { yaw: y, pitch, err, ticks: r.ticks }
  }
  let best = null
  const robust = s => {
    let worst = s.err
    for (const [dy, dp] of [[0.5, 0], [-0.5, 0], [0, 0.4], [0, -0.4]]) {
      const t = score(s.pitch + dp * Math.PI / 180, s.yaw + dy * Math.PI / 180, narrowWaterRim ? 0.72 : 1.15)
      if (!t) {
        if (!narrowWaterRim && s.ticks <= 16 && s.err <= 0.65) { worst = Math.max(worst, 0.9); continue }
        return null
      }
      worst = Math.max(worst, t.err)
    }
    return worst
  }
  const consider = s => {
    if (!s) return
    const w = robust(s)
    if (w == null || w > (narrowWaterRim ? 0.78 : 1.35)) return
    s.err = Math.max(s.err, 0); s.worst = w
    s.rank = w + s.ticks * 0.008 + Math.max(0, Math.abs(s.pitch) * 180 / Math.PI - 40) * 0.03
    if (!best || s.rank < best.rank - 0.03 || (Math.abs(s.rank - best.rank) <= 0.03 && s.ticks < best.ticks)) best = s
  }
  let coarseCandidate = null
  for (let deg = -50; deg <= maxPitchDeg; deg += 2) {
    const s = score(deg * Math.PI / 180, yaw, narrowWaterRim ? 0.85 : 1.35)
    if (s) {
      if (!coarseCandidate || s.err < coarseCandidate.err) coarseCandidate = s
      consider(s)
    }
  }
  if (!best && coarseCandidate) {
    const cDeg = coarseCandidate.pitch * 180 / Math.PI
    for (let deg = cDeg - 2; deg <= cDeg + 2; deg += 0.25) consider(score(deg * Math.PI / 180))
  }
  if (!best) return null
  const p0 = best.pitch
  for (let d = -1; d <= 1; d += 0.2) consider(score(p0 + d * Math.PI / 180))
  return best
}

// ---------- water exit ---------------------------------------------------------------------------
function findWaterExit (blockAt, pos, limit = 900, liquid = isWater) {
  const sx = Math.floor(pos.x); const sy = Math.floor(pos.y); const sz = Math.floor(pos.z)
  const body = (x, y, z) => { const a = blockAt(x, y, z); const b = blockAt(x, y + 1, z); return a && b && a.boundingBox !== 'block' && b.boundingBox !== 'block' }
  const dry = (x, y, z) => { const a = blockAt(x, y, z); const b = blockAt(x, y + 1, z); const f = blockAt(x, y - 1, z); return a && b && f && !liquid(a) && !liquid(b) && a.boundingBox !== 'block' && b.boundingBox !== 'block' && f.boundingBox === 'block' && !liquid(f) && !SUNKEN_LANDING.test(f.name || '') }
  const key = (x, y, z) => `${x},${y},${z}`
  const prev = new Map([[key(sx, sy, sz), null]])
  const queue = [[sx, sy, sz]]
  for (let qi = 0; qi < queue.length && queue.length < limit; qi++) {
    const [x, y, z] = queue[qi]
    if (dry(x, y, z)) {
      const path = []; let k = key(x, y, z)
      while (k) { const [a, b, c] = k.split(',').map(Number); path.push({ x: a, y: b, z: c }); k = prev.get(k) }
      return path.reverse()
    }
    const inWater = liquid(blockAt(x, y, z)) || liquid(blockAt(x, y + 1, z))
    const moves = []
    for (const [dx, dz] of DIRS) { moves.push([dx, 0, dz]); moves.push([dx, 1, dz]) }
    if (inWater) { moves.push([0, 1, 0]); moves.push([0, -1, 0]) }
    moves.sort((m1, m2) => {
      const b1 = blockAt(x + m1[0], y + m1[1], z + m1[2])
      const b2 = blockAt(x + m2[0], y + m2[1], z + m2[2])
      const dry1 = b1 && !liquid(b1) ? 1 : 0
      const dry2 = b2 && !liquid(b2) ? 1 : 0
      if (dry1 !== dry2) return dry2 - dry1
      const l1 = parseInt(b1?.properties?.level ?? b1?.metadata ?? 0, 10)
      const l2 = parseInt(b2?.properties?.level ?? b2?.metadata ?? 0, 10)
      return l2 - l1
    })
    for (const [dx, dy, dz] of moves) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz
      if (Math.abs(nx - sx) > 14 || Math.abs(nz - sz) > 14 || Math.abs(ny - sy) > 8) continue
      const k = key(nx, ny, nz)
      if (prev.has(k) || !body(nx, ny, nz)) continue
      if (dy === 1 && dx !== 0 && !inWater) continue
      if (dy === 1 && (!body(x, y + 1, z) || !body(x, y + 2, z))) continue
      if (dy === 1 && dx !== 0) {
        const wUp = liquid(blockAt(x, y + 1, z)) || liquid(blockAt(nx, ny, nz))
        // In 1-block shallow water (`!wUp`), Vanilla physics cannot jump 1 full block onto a dry ledge without wall boost!
        if (!wUp) continue
      }
      prev.set(k, key(x, y, z)); queue.push([nx, ny, nz])
    }
  }
  return null
}

class Survival {
  constructor ({ bot, world, config, logger, materials, look, ground, nav, interaction, scaffold }) {
    Object.assign(this, { bot, world, config, logger, materials, look, ground, nav, interaction, scaffold })
    this.eating = false
    this.lastEat = 0
    this.pearlFails = new Map()
    this.stats = { eaten: 0, pearls: 0, ramps: 0, waterEscapes: 0 }
    this.isTaskCell = () => false
  }

  blockAt (x, y, z) { return this.world.blockAt(new Vec3(x, y, z)) }

  // ---- auto eat ----
  foodItems () {
    const reg = this.bot.registry
    const items = this.bot.inventory?.items?.() || []
    return items.filter(i => i && i.count > 0 && reg?.foodsByName?.[i.name] && !BAD_FOOD.has(i.name) || (i && i.count > 0 && (i.name === 'golden_apple' || i.name === 'cooked_chicken')))
      .sort((a, b) => (reg.foodsByName[b.name]?.foodPoints || 0) - (reg.foodsByName[a.name]?.foodPoints || 0))
  }

  async healWithFood () {
    if (this.eating) return false
    let item = this.bot.inventory?.items?.()?.find(i => i.name === 'golden_apple' && i.count > 0)
    if (!item) { try { await this.materials.buy('golden_apple', 2) } catch { return false } item = this.bot.inventory?.items?.()?.find(i => i.name === 'golden_apple' && i.count > 0) }
    if (!item) return false
    this.eating = true
    try {
      this.bot.clearControlStates()
      this.materials?.closeOpenContainer?.()
      await withTimeout(this.bot.equip(item, 'hand'), 4000, 'equip')
      await withTimeout(this.bot.consume(), 5000, 'eat')
      this.logger.info(`healed with a golden apple (health ${this.bot.health})`)
      return true
    } catch (error) { this.logger.debug?.(`heal failed: ${error.message}`); return false } finally { this.eating = false }
  }

  async eatIfNeeded () {
    if (this.config.safety?.autoEat === false || this.eating) return false
    const food = Number(this.bot.food)
    if (!Number.isFinite(food)) return false
    const hurt = Number(this.bot.health) < 20
    if (!(food <= 14 || (hurt && food < 18))) return false
    if (Date.now() - this.lastEat < 4000) return false
    this.eating = true
    try {
      let item = this.foodItems()[0]
      if (!item) {
        const name = this.config.safety?.foodItem || 'cooked_beef'
        try { await this.materials.buy(name, 16) } catch (error) { this.logger.debug?.(`auto-eat: no food (${error.message})`); this.lastEat = Date.now() + 30_000; return false }
        item = this.foodItems()[0]
      }
      if (!item) { this.lastEat = Date.now() + 30_000; return false }
      this.bot.clearControlStates()
      this.materials?.closeOpenContainer?.()
      await withTimeout(this.bot.equip(item, 'hand'), 4000, 'equip food')
      await withTimeout(this.bot.consume(), 5000, 'eat')
      this.stats.eaten++
      this.lastEat = Date.now()
      this.logger.info(`auto-eat: ate ${item.name} (food ${this.bot.food})`)
      return true
    } catch (error) {
      this.logger.debug?.(`auto-eat failed: ${error.message}`)
      this.lastEat = Date.now()
      return false
    } finally { this.eating = false }
  }

  // ---- water ----
  async escapeWater (maxMs = 5_000) { return withHold(this.bot, () => this._escapeWater_h(maxMs)) }

  async _escapeWater_h (maxMs = 5_000) {
    if (this.ground.state() !== 'swimming' && !this.bot.entity?.isInWater) return false
    this.stats.waterEscapes++
    const bot = this.bot
    const t0 = Date.now()
    let lastPos = bot.entity.position.clone()
    let lastMoveAt = t0
    this.logger.info(`water: swimming at ${bot.entity.position.floored()}, getting out`)
    try {
      while (Date.now() - t0 < Math.min(maxMs, 2200)) {
        checkAbort()
        const st = this.ground.state()
        if ((st === 'grounded' || st === 'resting') && !bot.entity.isInWater) { bot.clearControlStates(); return true }
        const p = bot.entity.position
        if (p.distanceTo(lastPos) > 0.22) {
          lastPos = p.clone()
          lastMoveAt = Date.now()
        }
        // Stuck in a water hole/current without progress for >450ms: break out immediately to scaffold/exit climb!
        if (Date.now() - lastMoveAt > 450) break
        const path = findWaterExit(this.blockAt.bind(this), p)
        if (!path) break
        const next = path[Math.min(1, path.length - 1)]
        const goal = path.length > 2 ? path[Math.min(2, path.length - 1)] : next
        await bot.lookAt(new Vec3(goal.x + 0.5, goal.y + 0.5, goal.z + 0.5), true).catch(() => {})
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        bot.setControlState('jump', goal.y >= Math.floor(p.y) || isWater(this.blockAt(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))))
        await sleep(45)
      }
    } finally { bot.setControlState('forward', false); bot.setControlState('jump', false); bot.setControlState('sprint', false) }
    const st = await this.ground.waitSafe(250)
    if ((st === 'grounded' || st === 'resting') && !bot.entity.isInWater) return true
    try {
      if (!this.exit) return false
      if (Date.now() - (this.exit.lastWaterEscapeAt || 0) < 3500) return false
      this.exit.lastWaterEscapeAt = Date.now()
      const r = await this.exit.escape({ why: 'water: trapped in water hole, climbing out', force: true, maxMs: 6_000 })
      return Boolean(r.escaped)
    } catch { return false }
  }

  async escapeLava (maxMs = 8000) { return withHold(this.bot, () => this._escapeLava_h(maxMs)) }

  async _escapeLava_h (maxMs = 8000) {
    const bot = this.bot
    const inLava = () => Boolean(bot.entity?.isInLava) || /^lava$/.test(this.blockAt(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z))?.name || '')
    const isLiq = b => Boolean(b && (b.name === 'lava' || isWater(b)))
    if (!bot.entity || !inLava()) return false
    const t0 = Date.now()
    this.logger.warn(`lava: in lava at ${bot.entity.position.floored()}, swimming out`)
    try {
      while (Date.now() - t0 < maxMs && bot.health > 0) {
        const path = findWaterExit(this.blockAt.bind(this), bot.entity.position, 900, isLiq)
        const goal = path ? path[Math.min(2, path.length - 1)] : null
        if (goal) {
          const targetPt = new Vec3(goal.x + 0.5, bot.entity.position.y + 1.2, goal.z + 0.5)
          if (typeof bot.lookAt === 'function') await bot.lookAt(targetPt, true).catch(() => {})
          else if (typeof bot.look === 'function') {
            const yaw = Math.atan2(-(targetPt.x - bot.entity.position.x), -(targetPt.z - bot.entity.position.z))
            await bot.look(yaw, 0, true).catch(() => {})
          }
        }
        bot.setControlState('forward', Boolean(goal))
        bot.setControlState('jump', true)
        await sleep(150)
        if (!inLava() && this.ground.state() !== 'falling') { if (this.ground.state() === 'grounded' || this.ground.state() === 'resting') break }
      }
    } finally { bot.setControlState('forward', false); bot.setControlState('jump', false) }
    return !inLava()
  }

  // ---- ender pearl ----
  async pearlTo (stand) { return withHold(this.bot, () => this._pearlTo_h(stand)) }

  async _pearlTo_h (stand) {
    if (this.config.navigation?.pearls !== true) return false
    const bot = this.bot
    this.lastPearlReason = null
    if (!bot.entity) return false
    this.materials?.closeOpenContainer?.()
    // Require health >= 14 before throwing an ender pearl (pearl landing costs 5 HP!)
    if (Number(bot.health) < 14) { this.lastPearlReason = 'health'; return false }
    const start0 = bot.entity.position
    const horizDist0 = Math.hypot(start0.x - stand.x, start0.z - stand.z)
    const rise0 = stand.y - start0.y
    // Never waste an ender pearl on a short flat or downward move (< 6 blocks horizontally and not climbing up) when on dry land!
    if (!bot.entity.isInWater && rise0 <= 0.5 && horizDist0 < 6.0) {
      this.lastPearlReason = 'too close'
      return false
    }
    const k = `${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)}`
    if ((this.pearlFails.get(k) || 0) >= 2 || Date.now() - (this.pearlMissAt?.get(k) || 0) < 45_000) { this.lastPearlReason = 'failed'; return false }
    const st = await this.ground.waitSafe(1500)
    if (st !== 'grounded' && st !== 'resting' && st !== 'swimming') return false
    if (bot.entity.isInLava) { this.lastPearlReason = 'in lava'; return false }
    const eyeCell = this.blockAt(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y + 1.52), Math.floor(bot.entity.position.z))
    if (isWater(eyeCell)) { this.lastPearlReason = 'in deep water'; return false }
    await waitFor(() => Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) < 0.04, { timeoutMs: 600, intervalMs: 35 }).catch(() => {})
    const ctxNow = () => ({ vel: bot.entity.velocity, onGround: bot.entity.onGround })
    const eyeNow = () => bot.entity.position.offset(0, 1.62, 0)
    const sol = solveThrow(this.blockAt.bind(this), eyeNow(), stand, playerBlockers(bot), ctxNow())
    if (!sol) { this.lastPearlReason = 'no arc'; return false }
    try { await this.materials.ensureUsableItem('ender_pearl', 'tool') } catch (error) { this.logger.debug?.(`pearl: none available (${error.message})`); this.lastPearlReason = 'no pearls'; return false }
    const start = bot.entity.position.clone()
    if (Math.hypot(start.x - stand.x, start.z - stand.z) < 2.2 && Math.abs(start.y - stand.y) < 2.2) return true
    this.logger.info(`pearl: throwing to ${k} (yaw ${(sol.yaw * 180 / Math.PI).toFixed(1)} pitch ${(sol.pitch * 180 / Math.PI).toFixed(1)} err ${sol.err.toFixed(2)} flight ${sol.ticks}t)`)
    bot.clearControlStates()
    let pearlEntity = null
    const pearlSpawned = () => new Promise(resolve => {
      const onSpawn = entity => { if (/ender_pearl|thrown_ender_pearl/.test(`${entity?.name || ''} ${entity?.displayName || ''}`)) { pearlEntity = entity; cleanup(); resolve(true) } }
      const timer = setTimeout(() => { cleanup(); resolve(false) }, 1300)
      function cleanup () { clearTimeout(timer); bot.removeListener('entitySpawn', onSpawn) }
      bot.on('entitySpawn', onSpawn)
    })
    let thrown = false
    for (let attempt = 0; attempt < 2 && !thrown; attempt++) {
      this.materials?.closeOpenContainer?.()
      try { await this.materials.ensureUsableItem('ender_pearl', 'tool') } catch { break }
      if (bot.heldItem?.name !== 'ender_pearl') continue
      const dirv = new Vec3(-Math.sin(sol.yaw) * Math.cos(sol.pitch), Math.sin(sol.pitch), -Math.cos(sol.yaw) * Math.cos(sol.pitch))
      if (this.look?.sweep) await this.look.sweep(dirv); else await bot.look(sol.yaw, sol.pitch, true)
      await bot.waitForTicks(2)
      let verified = false
      for (let v = 0; v < 3 && !verified; v++) {
        const ents = playerBlockers(bot)
        const chk = evalThrow(this.blockAt.bind(this), eyeNow(), bot.entity.yaw, bot.entity.pitch, stand, ents, ctxNow())
        if (chk) { verified = true; if (v > 0) this.logger.info(`pearl: aim corrected (${v}x), predicted landing error ${chk.err.toFixed(2)}`); break }
        const again = solveThrow(this.blockAt.bind(this), eyeNow(), stand, ents, ctxNow())
        if (!again) break
        const d2 = new Vec3(-Math.sin(again.yaw) * Math.cos(again.pitch), Math.sin(again.pitch), -Math.cos(again.yaw) * Math.cos(again.pitch))
        if (this.look?.sweep) await this.look.sweep(d2); else await bot.look(again.yaw, again.pitch, true)
        await bot.waitForTicks(2)
      }
      if (!verified) { this.lastPearlReason = 'no arc'; this.logger.info('pearl: the real camera angle would not land there; not throwing'); return false }
      const watch = pearlSpawned()
      bot.activateItem()
      thrown = await watch
    }
    if (!thrown) { this.pearlFails.set(k, (this.pearlFails.get(k) || 0) + 1); this.lastPearlReason = 'no throw'; this.logger.info('pearl: the throw did not happen (hand did not hold a pearl)'); return false }
    this.stats.pearls++
    this.bot.lastPearlLandAt = Date.now() + sol.ticks * 50
    let lastSeen = null; const flightT0 = Date.now()
    if (pearlEntity) { while (Date.now() - flightT0 < 6000 && bot.entities[pearlEntity.id]) { lastSeen = pearlEntity.position.clone(); await sleep(40) } }
    this.bot.lastPearlLandAt = Date.now()
    const near = () => Math.hypot(bot.entity.position.x - stand.x, bot.entity.position.z - stand.z) < 2.6 && Math.abs(bot.entity.position.y - stand.y) < 2.5
    await waitFor(() => near(), { timeoutMs: 1500 + sol.ticks * 60, intervalMs: 50 }).catch(() => {})
    await this.ground.waitSafe(3000)
    const end = bot.entity.position
    const ok = near()
    if (!ok) { this.lastPearlReason = 'missed'; this.pearlFails.set(k, (this.pearlFails.get(k) || 0) + 1); (this.pearlMissAt = this.pearlMissAt || new Map()).set(k, Date.now()) }
    this.logger.info(`pearl: ${ok ? 'landed' : 'did not land'} at ${end.floored()}${lastSeen ? ` (pearl was last seen at ${lastSeen.x.toFixed(1)},${lastSeen.y.toFixed(1)},${lastSeen.z.toFixed(1)} after ${((Date.now() - flightT0) / 1000).toFixed(1)}s; aimed at ${stand.x.toFixed(1)},${stand.y},${stand.z.toFixed(1)})` : ''}`)
    return ok
  }

  async lastResort (target) {
    const rise = target.y - this.bot.entity.position.y
    const far = Math.hypot(target.x - this.bot.entity.position.x, target.z - this.bot.entity.position.z)
    return (rise >= 3 || far >= 10) && far <= 24 && await this.pearlTo(target).catch(() => false)
  }

  async tick () {
    if (!this.bot.entity || this.bot.health <= 0) return
    if (this.ground.state() === 'swimming') await this.escapeWater().catch(() => {})
    await this.eatIfNeeded().catch(() => {})
  }
}

module.exports = { playerBlockers, Survival, solveThrow, simulatePearl, evalThrow, findWaterExit }
