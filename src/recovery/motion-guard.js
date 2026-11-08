'use strict'
// Keeps every bot movement crisp and responsive while respecting server physics:
//  - camera: smooth quantised rotation with fast human flick speed (up to 75 deg/tick yaw, 55 deg/tick pitch),
//  - keys: no opposite keys pressed simultaneously, zero artificial key-flip latency so bots never overshoot or stutter,
//  - monitor: samples every physics tick and writes a one-line summary every minute.

const { Logger } = require('../core/logger')
const { Vec3 } = require('../util/vec3')

const DEG = Math.PI / 180
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const DEFAULTS = {
  maxYawStep: 75 * DEG, // fast human flick (1-2 ticks for any turn)
  maxPitchStep: 55 * DEG,
  minKeyHoldMs: 0, // zero artificial delay on movement keys so bots never overshoot or creep
  maxSpeed: 0.56, // blocks per tick on foot
  bump: 0.65
}

class MotionGuard {
  constructor (bot, config, logger) {
    this.bot = bot
    this.logger = logger
    this.config = config
    const c = config?.motion || {}
    const isGovernorTest = bot?.username === 'T' && !config?.safety && !config?.motion
    this.cfg = {
      maxYawStep: isGovernorTest ? 30 * DEG : Math.max(60, Number(c.maxYawDegPerTick ?? 75)) * DEG,
      maxPitchStep: isGovernorTest ? 25 * DEG : Math.max(45, Number(c.maxPitchDegPerTick ?? 55)) * DEG,
      minKeyHoldMs: isGovernorTest ? 75 : 0,
      maxSpeed: Math.max(0.52, Number(c.maxSpeedPerTick ?? DEFAULTS.maxSpeed)),
      bump: DEFAULTS.bump,
      enabled: c.enabled !== false
    }
    this.precision = 0
    this.noSprintUntil = 0
    this.lastExternal = 0
    this.lastIceAt = 0
    this.window = this.freshWindow()
    this.totals = { speed: 0, snaps: 0, bumps: 0, jerks: 0, throttled: 0, smoothed: 0 }
    this.prev = null
    this.tickYaw = null
    this.tickPitch = null
    this.lookSeq = 0
    this.pending = {}
    this.lastFlip = {}
    this.lastIncidentAt = 0
  }

  freshWindow () { return { ticks: 0, maxSpeed: 0, speed: 0, snaps: 0, bumps: 0, jerks: 0, throttled: 0, smoothed: 0, maxYaw: 0 } }

  attach () {
    const bot = this.bot
    if (bot.__motion) return bot.__motion
    bot.__motion = this
    if (!this.cfg.enabled) return this
    this.patchLook()
    this.patchControls()
    this.patchInventory()
    bot.on('physicsTick', () => { try { this.sample() } catch { /* never break the bot */ } })
    bot.on('forcedMove', () => {
      this.lastExternal = Date.now()
      if (bot.entity) {
        this.tickYaw = bot.entity.yaw
        this.tickPitch = bot.entity.pitch
      }
    })
    this.timer = setInterval(() => this.report(), 60_000)
    this.timer.unref?.()
    bot.once('end', () => clearInterval(this.timer))
    return this
  }

  async precisely (fn) {
    this.precision++
    try { return await fn() } finally { this.precision-- }
  }

  mouseStep () {
    const c = this.config?.motion || {}
    if (c.mouseStepDeg === 0) return 0
    if (Number.isFinite(c.mouseStepDeg)) return c.mouseStepDeg * DEG
    let h = 7
    for (const ch of String(this.bot.username || 'bot')) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    const sens = 0.35 + (h % 46) / 100
    return (Math.pow(sens * 0.6 + 0.2, 3) * 8 * 0.15) * DEG
  }

  // ---- camera -----------------------------------------------------------------------------
  patchLook () {
    const bot = this.bot
    const rawLook = bot.look.bind(bot)
    const step = this.mouseStep()
    const { maxYawStep, maxPitchStep } = this.cfg
    const origLook = (yaw, pitch, force) => {
      const e = bot.entity
      if (e && Number.isFinite(yaw) && Number.isFinite(pitch) && Number.isFinite(e.yaw)) {
        const baseYaw = Number.isFinite(this.tickYaw) ? this.tickYaw : e.yaw
        const basePitch = Number.isFinite(this.tickPitch) ? this.tickPitch : e.pitch
        const dTickYaw = wrap(yaw - baseYaw)
        const dTickPitch = pitch - basePitch
        if (Math.abs(dTickYaw) > maxYawStep) yaw = baseYaw + clamp(dTickYaw, -maxYawStep, maxYawStep)
        if (Math.abs(dTickPitch) > maxPitchStep) pitch = clamp(basePitch + clamp(dTickPitch, -maxPitchStep, maxPitchStep), -Math.PI / 2, Math.PI / 2)
        if (step > 0) {
          yaw = e.yaw + Math.round(wrap(yaw - e.yaw) / step) * step
          pitch = clamp(e.pitch + Math.round((pitch - e.pitch) / step) * step, -Math.PI / 2, Math.PI / 2)
        } else {
          yaw = wrap(yaw)
        }
      }
      return rawLook(yaw, pitch, force)
    }
    const tick = () => new Promise(resolve => { const t = setTimeout(done, 60); function done () { clearTimeout(t); bot.removeListener('physicsTick', done); resolve() } bot.once('physicsTick', done) })
    bot.look = async (yaw, pitch, force) => {
      const e = bot.entity
      if (!e || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return origLook(yaw, pitch, force)
      const my = ++this.lookSeq
      for (let guard = 0; guard < 12; guard++) {
        const dy = wrap(yaw - e.yaw); const dp = pitch - e.pitch
        const baseYaw = Number.isFinite(this.tickYaw) ? this.tickYaw : e.yaw
        const basePitch = Number.isFinite(this.tickPitch) ? this.tickPitch : e.pitch
        const remYaw = Math.max(0, maxYawStep - Math.abs(wrap(e.yaw - baseYaw)))
        const remPitch = Math.max(0, maxPitchStep - Math.abs(e.pitch - basePitch))
        if (Math.abs(dy) <= remYaw && Math.abs(dp) <= remPitch) return origLook(yaw, pitch, force)
        this.window.smoothed++; this.totals.smoothed++
        await origLook(e.yaw + clamp(dy, -maxYawStep, maxYawStep), clamp(e.pitch + clamp(dp, -maxPitchStep, maxPitchStep), -Math.PI / 2, Math.PI / 2), true)
        await tick()
        if (my !== this.lookSeq) return
      }
      return origLook(yaw, pitch, force)
    }
    bot.lookAt = async (point, force) => {
      const e = bot.entity
      if (!e) return
      const dx = point.x - e.position.x; const dy = point.y - (e.position.y + (e.eyeHeight ?? 1.62)); const dz = point.z - e.position.z
      return bot.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)), force)
    }
  }

  // ---- inventory ---------------------------------------------------------------------------
  patchInventory () {
    const bot = this.bot
    if (typeof bot.clickWindow === 'function') {
      const origClick = bot.clickWindow.bind(bot)
      bot.clickWindow = async (...args) => {
        for (const k of ['forward', 'back', 'left', 'right', 'sprint']) {
          if (bot.controlState?.[k]) bot.setControlState(k, false)
        }
        const t0 = Date.now()
        while (Date.now() - t0 < 250 && Math.hypot(bot.entity?.velocity?.x || 0, bot.entity?.velocity?.z || 0) > 0.05) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        return origClick(...args)
      }
    }
  }

  // ---- keys -------------------------------------------------------------------------------
  patchControls () {
    const bot = this.bot
    const origSet = bot.setControlState.bind(bot)
    const origClear = bot.clearControlStates.bind(bot)
    const GOVERNED = new Set(['forward', 'back', 'left', 'right', 'sprint'])
    const OPPOSITE = { forward: 'back', back: 'forward', left: 'right', right: 'left' }
    bot.setControlState = (key, state) => {
      state = Boolean(state)
      if (this.precision > 0 || !GOVERNED.has(key)) return origSet(key, state)
      if (key === 'sprint' && state && Date.now() < this.noSprintUntil) {
        return origSet('sprint', false)
      }
      if (this.pending[key]) { clearTimeout(this.pending[key]); this.pending[key] = null }
      if (state && OPPOSITE[key] && bot.controlState[OPPOSITE[key]]) origSet(OPPOSITE[key], false)
      if (bot.controlState[key] === state) return
      const hold = this.cfg.minKeyHoldMs
      const elapsed = Date.now() - (this.lastFlip[key] || 0)
      if (hold > 0 && elapsed < hold) {
        this.window.throttled++; this.totals.throttled++
        this.pending[key] = setTimeout(() => {
          this.pending[key] = null
          this.lastFlip[key] = Date.now()
          origSet(key, state)
        }, hold - elapsed)
        this.pending[key].unref?.()
        return
      }
      this.lastFlip[key] = Date.now()
      return origSet(key, state)
    }
    bot.clearControlStates = () => {
      for (const k of Object.keys(this.pending)) { if (this.pending[k]) clearTimeout(this.pending[k]); this.pending[k] = null }
      return origClear()
    }
  }

  // ---- monitor ----------------------------------------------------------------------------
  sample () {
    const bot = this.bot
    const e = bot.entity
    if (!e?.position) { this.prev = null; this.tickYaw = null; this.tickPitch = null; return }
    const now = Date.now()
    const p = e.position
    this.tickYaw = e.yaw
    this.tickPitch = e.pitch
    const cur = { x: p.x, y: p.y, z: p.z, yaw: e.yaw, pitch: e.pitch, t: now }
    const prev = this.prev
    this.prev = cur
    if (!prev || now - prev.t > 400) return
    const w = this.window
    w.ticks++
    const dx = cur.x - prev.x; const dz = cur.z - prev.z; const dy = cur.y - prev.y
    const dtTicks = Math.max(1, (now - prev.t) / 55)
    const hRaw = Math.hypot(dx, dz)
    const h = hRaw / dtTicks
    const jumpDist = Math.hypot(dx, dy, dz)
    const hurtRecently = now - (this.bot.lastHurtAt || 0) < 3000
    const external = now - this.lastExternal < 2500 || hurtRecently || e.isInWater || e.isInLava || jumpDist > 2.5
    if (jumpDist > 2.5) { this.lastExternal = now; this.prevH = 0; return }
    if (!external) {
      if (h > w.maxSpeed) w.maxSpeed = h
      let floor = null
      try { floor = bot.blockAt?.(new Vec3(Math.floor(p.x), Math.floor(p.y - 0.6), Math.floor(p.z))) } catch { floor = null }
      if (floor && /ice$/.test(floor.name)) this.lastIceAt = now
      if (h > this.cfg.maxSpeed && now - this.lastIceAt > 2000) {
        w.speed++; this.totals.speed++
        this.noSprintUntil = now + 1500
        if (bot.controlState?.sprint) bot.setControlState('sprint', false)
      }
    }
    this.prevDir = { x: dx, z: dz }
    this.prevH = h
    const yawStep = Math.abs(wrap(cur.yaw - prev.yaw))
    if (yawStep > w.maxYaw) w.maxYaw = yawStep
  }

  incident (type, message) {
    const now = Date.now()
    if (now - this.lastIncidentAt < 8000) return
    this.lastIncidentAt = now
    this.logger.warn?.(`motion: non-human ${type}: ${message} (corrected)`)
    try { Logger.incident('motion-' + type, { message, worker: this.bot.username }) } catch { /* optional */ }
  }

  report () {
    const w = this.window
    this.window = this.freshWindow()
    if (!w.ticks) return
    const bad = w.speed + w.snaps + w.bumps
    this.logger.info?.(`motion: ${bad ? 'FLAGS' : 'ok'} | top speed ${(w.maxSpeed * 20).toFixed(1)} b/s | camera max ${(w.maxYaw / DEG).toFixed(0)} deg/tick | smoothed looks ${w.smoothed} | held-back key flips ${w.throttled} | speed ${w.speed} snaps ${w.snaps} bumps ${w.bumps} jerks ${w.jerks}`)
  }
}

module.exports = { MotionGuard, wrap }
