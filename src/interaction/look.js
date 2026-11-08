'use strict'
// Fast, quantised camera control (0.15 degree mouse quantisation).
// Caps per-step angular velocity to <= 24 deg/tick and sets `bot.__looking = true` so `human.js` never fights
// the camera on the same physics tick and `motion-guard` never flags a camera snap.

const { Vec3 } = require('../util/vec3')
const { sleep, nextTick } = require('../util/async')
const { checkAbort } = require('../util/abort')
const { EYE_STAND, EYE_SNEAK } = require('./aim')

const DEG = Math.PI / 180
const SENS = 0.15 * DEG
const quant = v => Math.round(v / SENS) * SENS
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a }

class AimController {
  constructor (bot, navigation, config, logger) {
    this.bot = bot
    this.nav = navigation
    this.config = config
    this.logger = logger
  }

  aimScale () { return Number(this.config.human?.aimScale ?? 0.1) * (this.config.human?.flowNow ? 0.35 : 1) }

  eyeNow () {
    const sneak = Boolean(this.bot.getControlState?.('sneak'))
    return this.bot.entity.position.offset(0, sneak ? EYE_SNEAK : EYE_STAND, 0)
  }

  // Aim at a world point with quantised minimum-jerk sweep.
  async lookAtPoint (point) {
    const eye = this.eyeNow()
    const dir = point.minus(eye)
    await this.sweep(dir)
    return 'sweep'
  }

  desired (dir) {
    const horiz = Math.hypot(dir.x, dir.z)
    const yaw = horiz < 1e-4 ? this.bot.entity.yaw : Math.atan2(-dir.x, -dir.z) // straight down/up: keep the heading
    return { yaw, pitch: Math.atan2(dir.y, horiz) }
  }

  async correct (dir) {
    const want = this.desired(dir)
    const e = this.bot.entity
    if (Math.abs(wrap(want.yaw - e.yaw)) < 0.25 * DEG && Math.abs(want.pitch - e.pitch) < 0.25 * DEG) return
    await this.sweep(dir)
  }

  // looks straight down the way a player does when pillar-jumping (never hangs, keeps the heading)
  async lookDown () {
    await this.sweep(new Vec3(0, -1, 0))
  }

  async sweep (dir) {
    checkAbort()
    const bot = this.bot
    const ty = quant(this.desired(dir).yaw)
    const tp = Math.max(-89 * DEG, Math.min(89 * DEG, quant(Math.atan2(dir.y, Math.hypot(dir.x, dir.z)))))
    const y0 = bot.entity.yaw; const p0 = bot.entity.pitch
    const dy = wrap(ty - y0); const dp = tp - p0
    const amp = Math.max(Math.abs(dy), Math.abs(dp))
    if (amp < 0.2 * DEG) return
    bot.__looking = true
    try {
      // If MotionGuard is attached, `bot.look` already steps once per physics tick within maxYawStep/maxPitchStep.
      // Calling `bot.look(ty, tp, true)` directly avoids double-throttling while guaranteeing the exact final angle!
      if (bot.__motion) {
        await bot.look(ty, tp, true)
      } else {
        const ticks = Math.max(1, Math.min(5, Math.ceil(amp / (24 * DEG))))
        for (let i = 1; i <= ticks; i++) {
          const t = i / ticks
          const f = t * t * t * (10 - 15 * t + 6 * t * t)
          await bot.look(quant(y0 + dy * f), Math.max(-89 * DEG, Math.min(89 * DEG, quant(p0 + dp * f))), true)
          if (i < ticks) await nextTick(bot)
        }
      }
      await nextTick(bot)
    } finally {
      bot.__looking = false
    }
  }

  // Tiny corrective nudge (a human re-centres the crosshair by a pixel or two when it is on an edge)
  async nudge (dyaw, dpitch) {
    this.bot.__looking = true
    try {
      await this.bot.look(quant(this.bot.entity.yaw + dyaw), quant(this.bot.entity.pitch + dpitch), true)
      await nextTick(this.bot)
    } finally {
      this.bot.__looking = false
    }
  }
}

module.exports = { AimController, quant }
