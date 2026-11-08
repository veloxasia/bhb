'use strict'
// Watches the bot while a build runs. Pauses on danger, fixes what it can (lava, falling, death) and
// resumes by itself once the situation is physically safe again. A pause the user asked for is never undone.

const { Vec3 } = require('../util/vec3')
const { sleep } = require('../util/async')
const { isBodyFree, isFullTop, iceStandOk, supportUnder } = require('../world/ground')

const HAZARDS = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow'])
const FLOOR_HAZARDS = new Set(['magma_block', 'campfire', 'soul_campfire', 'cactus'])

class RecoveryManager {
  constructor (bot, navigation, world, config, logger, ground) {
    this.bot = bot
    this.navigation = navigation
    this.world = world
    this.config = config
    this.logger = logger
    this.ground = ground
    this.paused = false
    this.reason = null
    this.timer = null
    this.dead = false
    this.badSince = { airborne: 0 }
    this.escaping = false
    this.lastPauseAt = 0
    this.pauseCount = 0
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => this.tick().catch(error => this.logger.warn(`recovery: ${error.message}`)), 250)
  }

  stop () { if (this.timer) clearInterval(this.timer); this.timer = null }

  pause (reason) {
    const builder = this.bot.builder
    if (!builder?.running) return
    const changed = !this.paused || this.reason !== reason
    this.paused = true
    this.reason = reason
    builder.autoPaused = true
    if (changed) { this.navigation.stop(); try { this.bot.clearControlStates() } catch {} }
    const throttle = Number(this.config.safety?.recoveryLogThrottleMs || 3000)
    if (changed || Date.now() - this.lastPauseAt >= throttle * 4) {
      this.lastPauseAt = Date.now()
      if (changed) this.pauseCount++
      this.logger.warn(`BUILD PAUSED (auto-resumes when safe): ${reason}`)
      if (reason.startsWith('airborne')) this.logger.warn(`ground diagnostic: ${this.ground.describe()}`)
    }
  }

  resume () {
    const builder = this.bot.builder
    if (!this.paused) return
    this.paused = false
    this.reason = null
    this.dead = false
    this.badSince.airborne = 0
    if (builder) builder.autoPaused = false
    this.logger.info('BUILD RESUMED automatically: conditions are safe again')
  }

  isHazard (block) { return Boolean(block && HAZARDS.has(block.name)) }

  async tick () {
    const e = this.bot.entity
    const builder = this.bot.builder
    if (!e || !builder?.running || this.dead || this.escaping) return
    if (builder.manualPaused) return

    const mode = this.bot.game?.gameMode
    if ((mode === 'survival' || mode === 'adventure') && this.bot.abilities?.flying) return this.pause(`server reports flying=true in ${mode}`)

    // Always escape active lava/fire hazards FIRST before pausing in place for low health!
    if (this.hazardAround()) {
      this.pause('hazard (lava/fire/etc.) around the bot')
      await this.escapeHazard()
      return
    }

    const minHealth = Number(this.config.safety?.minimumHealth || 8)
    if (this.config.safety?.pauseOnLowHealth && Number.isFinite(this.bot.health) && this.bot.health < minHealth) {
      this.healSince = this.healSince || Date.now()
      const stalled = Date.now() - this.healSince
      if (Date.now() - (this.lastHealTry || 0) > 3500) {
        this.lastHealTry = Date.now()
        const sv = builder.survival
        try {
          const ate = await sv?.eatIfNeeded?.()
          if (!ate && Number(this.bot.health) < minHealth) {
            await sv?.healWithFood?.()
          }
        } catch { /* best effort */ }
      }
      if (stalled > Number(this.config.safety?.lowHealthResumeAfterMs ?? 2_500) && this.bot.health > 0) {
        this.logger.warn(`health stays at ${this.bot.health.toFixed(1)} (no regeneration?): continuing the build carefully`)
        this.healSince = Date.now() + 10 * 60_000
        if (this.paused) this.resume()
        return
      }
      if (stalled >= 0) return this.pause(`health ${this.bot.health.toFixed(1)} below ${minHealth}`)
    } else if (this.paused && this.reason?.startsWith('health') && this.bot.health >= minHealth) {
      this.healSince = 0
      this.resume(); return
    } else { this.healSince = 0 }

    const minY = Number(this.bot.game?.minY ?? -64)
    if (e.position.y < minY + 1 && !e.onGround && (e.velocity?.y ?? 0) < -0.25) return this.pause('void/fall risk')

    const st = this.ground.state()
    if (st === 'falling' || st === 'phantom' || st === 'airborne') {
      if (!this.badSince.airborne) this.badSince.airborne = Date.now()
      const elapsedAir = Date.now() - this.badSince.airborne
      const airTol = Number(this.config.safety?.airborneToleranceMs ?? 2500)
      if (st === 'falling' && elapsedAir >= airTol) {
        this.pause('airborne / falling')
      }
      if (elapsedAir > 400) {
        if (this.bot.getControlState?.('sneak')) {
          try { this.bot.setControlState('sneak', false) } catch {}
        }
        const fc = new Vec3(Math.floor(e.position.x), Math.floor(e.position.y + 0.01), Math.floor(e.position.z))
        const dxC = (fc.x + 0.5) - e.position.x
        const dzC = (fc.z + 0.5) - e.position.z
        if (Math.hypot(dxC, dzC) > 0.04) {
          e.position.x += dxC * 0.55
          e.position.z += dzC * 0.55
        }
        e.onGround = false
        if (e.velocity && e.velocity.y >= -0.02) e.velocity.y = -0.08
      }
      if (elapsedAir > 1200 && Date.now() - (this.lastPhantomUnstick || 0) > 1800) {
        this.lastPhantomUnstick = Date.now()
        this.navigation?.unstick?.().catch(() => {})
      }
    } else if (st === 'unloaded') {
      return this.pause('chunk under the bot is not loaded')
    } else {
      if (st === 'grounded' && this.ground.stillFor?.(400)) this.lastSafe = e.position.clone()
      this.badSince.airborne = 0
    }

    if (this.paused) {
      if (this.bot.physicsEnabled === false) this.bot.physicsEnabled = true
      if ((this.ground.isSafeToWork() && !this.hazardAround()) || (Date.now() - this.lastPauseAt > 5000 && !this.hazardAround() && (this.bot.health ?? 20) > 0)) {
        this.resume()
      }
    }
  }

  hazardAround () {
    const e = this.bot.entity
    if (!e?.position) return false
    if (e.isInLava) return true
    const f = e.position.floored()
    for (const d of [[0, 0, 0], [0, 1, 0]]) {
      if (this.isHazard(this.world.blockAt(f.offset(...d)))) return true
    }
    const below = this.world.blockAt(f.offset(0, -1, 0))
    if (below && FLOOR_HAZARDS.has(below.name)) return true
    // Only treat lava/fire at f.offset(0, -1, 0) as an active hazard if the bot is NOT supported by a solid ledge!
    // Never stop a grounded bot mid-step over a sealed/open schematic lava cell below its floor.
    if (this.isHazard(below)) {
      const sup = supportUnder(this.world, e.position)
      if (!sup.supported && !e.onGround && (e.velocity?.y ?? 0) <= 0 && e.position.y - f.y <= 0.15) return true
    }
    return false
  }

  // Walk to the closest cell that is solid, free and has no hazard beside it.
  async escapeHazard () {
    if (this.escaping) return
    this.escaping = true
    try {
      const e = this.bot.entity
      if (!e) return
      // Abort the active task first so its `nav.goTo` / `human walk fallback` cannot overwrite our hazard escape route!
      try {
        this.bot.builder?.placer?.abortActive?.('hazard escape')
        this.navigation.stop()
        this.bot.clearControlStates()
        const f0 = e.position.floored()
        if (e.isInLava || this.isHazard(this.world.blockAt(f0)) || this.isHazard(this.world.blockAt(f0.offset(0, -1, 0)))) {
          this.bot.builder?.buildMemory?.recordHazardCell?.(e.position, 'lava')
        }
      } catch {}
      const f = e.position.floored()
      if (e.isInLava || this.world.blockAt(f)?.name === 'lava') {
        this.bot.setControlState('jump', false)
        const escaped = await this.bot.builder?.survival?.escapeLava?.(2500).catch(() => false)
        if (escaped && !this.hazardAround() && this.ground.isSafeToWork()) {
          if (this.paused) this.resume()
          return
        }
      }
      if (this.bot.builder?.exit?.running) return
      const origin = e.position.floored()
      let best = null
      for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -3; dy <= 3; dy++) {
        const c = origin.offset(dx, dy, dz)
        const feet = this.world.blockAt(c); const head = this.world.blockAt(c.offset(0, 1, 0)); const ground = this.world.blockAt(c.offset(0, -1, 0))
        if (!isBodyFree(feet) || !isBodyFree(head) || !(isFullTop(ground) || iceStandOk(this.world, c))) continue
        let bad = false
        for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) if (this.isHazard(this.world.blockAt(c.offset(...d)))) { bad = true; break }
        let hazardSteps = 0
        const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.4))
        for (let s = 1; s < steps; s++) {
          const mx = Math.floor(origin.x + 0.5 + dx * s / steps)
          const mz = Math.floor(origin.z + 0.5 + dz * s / steps)
          if (mx === origin.x && mz === origin.z) continue
          const my = origin.y + Math.round(dy * s / steps)
          if (this.isHazard(this.world.blockAt(new Vec3(mx, my, mz))) || this.isHazard(this.world.blockAt(new Vec3(mx, my - 1, mz)))) hazardSteps++
        }
        const dist = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2 + hazardSteps * 12
        if (!best || dist < best.dist) best = { c, dist }
      }
      if (!best) { this.logger.warn('hazard escape: no safe cell within 8 blocks'); return }
      this.logger.warn(`hazard escape toward ${best.c}`)
      try { await this.navigation.goTo(best.c.offset(0.5, 0, 0.5), 0.6, 15_000, { human: false }) } catch (error) { this.logger.warn(`hazard escape failed: ${error.message}`) }
      this.bot.setControlState('jump', false)
      if (this.paused && !this.hazardAround() && this.ground.isSafeToWork()) this.resume()
    } finally { this.escaping = false }
  }

  async handleDeath () {
    if (!this.bot.builder?.running || this.dead) return
    this.dead = true
    this.paused = true
    this.reason = 'respawn'
    this.bot.builder.autoPaused = true
    try {
      this.bot.builder?.placer?.abortActive?.('bot died')
      this.bot.builder?.placer?._deadStands?.clear?.()
      this.bot.builder?.placer?._reach?.clear?.()
      this.bot.builder?.brain?.clearCache?.()
    } catch {}
    this.navigation.stop()
    this.logger.warn('bot died: build paused, will resume after respawn')
  }

  async handleRespawn () {
    if (!this.bot.builder?.running) return
    await sleep(1500)
    const st = await this.ground.waitSafe(10_000)
    this.dead = false
    try { const b = this.bot.builder; if (b?.originVec) await b.teleporter?.returnToWork(b.originVec, 'after respawn') } catch { /* walk instead */ }
    if (st === 'grounded' || st === 'resting') {
      this.paused = true // so resume() logs
      this.resume()
    } else {
      this.reason = 'airborne after respawn'
      this.logger.warn(`respawned but state=${st}; ${this.ground.describe()}`)
    }
  }
}

module.exports = { RecoveryManager, HAZARDS }
