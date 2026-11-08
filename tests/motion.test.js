'use strict'
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { MotionGuard } = require('../src/recovery/motion-guard')

function fakeBot () {
  const bot = new EventEmitter()
  bot.username = 'T'
  bot.entity = { position: { x: 0, y: 0, z: 0, floored () { return this } }, yaw: 0, pitch: 0, velocity: { y: 0 }, onGround: true }
  bot.controlState = { forward: false, back: false, left: false, right: false, sprint: false, jump: false, sneak: false }
  bot.setControlState = (k, v) => { bot.controlState[k] = Boolean(v) }
  bot.clearControlStates = () => { for (const k of Object.keys(bot.controlState)) bot.controlState[k] = false }
  bot.looks = []
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; bot.looks.push([yaw, pitch]) }
  bot.lookAt = async () => {}
  setInterval(() => bot.emit('physicsTick'), 5).unref()
  return bot
}
const logger = { info () {}, warn () {}, debug () {} }

test('camera: a 180 degree turn is a sweep of capped steps, never one snap', async () => {
  const bot = fakeBot(); new MotionGuard(bot, {}, logger).attach()
  await bot.look(Math.PI, 0.3, true)
  assert.ok(bot.looks.length >= 6, `steps ${bot.looks.length}`)
  let prev = 0
  for (const [yaw] of bot.looks) { assert.ok(Math.abs(Math.atan2(Math.sin(yaw - prev), Math.cos(yaw - prev))) <= 31 * Math.PI / 180 + 1e-9); prev = yaw }
  assert.ok(Math.abs(Math.abs(bot.entity.yaw) - Math.PI) < 0.02) // within one mouse step
})

test('keys: rapid toggling is held back, opposite keys never overlap, clear is immediate', async () => {
  const bot = fakeBot(); const m = new MotionGuard(bot, {}, logger).attach()
  bot.setControlState('forward', true)
  bot.setControlState('forward', false) // within the hold time: deferred
  assert.equal(bot.controlState.forward, true)
  await new Promise(r => setTimeout(r, 140))
  assert.equal(bot.controlState.forward, false)
  assert.ok(m.totals.throttled >= 1)
  bot.setControlState('forward', true); await new Promise(r => setTimeout(r, 100))
  bot.setControlState('back', true)
  assert.equal(bot.controlState.forward, false)
  bot.clearControlStates()
  assert.equal(bot.controlState.back, false)
})

test('precision scope bypasses the governor', async () => {
  const bot = fakeBot(); const m = new MotionGuard(bot, {}, logger).attach()
  await m.precisely(async () => { bot.setControlState('forward', true); bot.setControlState('forward', false) })
  assert.equal(bot.controlState.forward, false)
})

test('monitor: flags non-human speed once and drops sprint', () => {
  const bot = fakeBot(); const m = new MotionGuard(bot, {}, logger).attach()
  m.sample()
  bot.entity.position.x += 0.6 // 12 blocks/s on foot
  bot.controlState.sprint = true
  m.sample()
  assert.equal(m.totals.speed, 1)
  bot.setControlState('sprint', true)
  assert.equal(bot.controlState.sprint, false, 'sprint refused during the cool-down')
})

test('monitor: a pearl teleport or setback is not blamed on the bot', () => {
  const bot = fakeBot(); const m = new MotionGuard(bot, {}, logger).attach()
  m.sample(); bot.entity.position.x += 30; m.sample()
  assert.equal(m.totals.speed, 0)
})

test('camera: every look is a whole number of mouse steps from the previous one', async () => {
  const bot = fakeBot(); const m = new MotionGuard(bot, {}, logger).attach()
  const step = m.mouseStep()
  assert.ok(step > 0.05 * Math.PI / 180 && step < 0.7 * Math.PI / 180)
  let prev = 0
  for (const [yaw, pitch] of [[0.4, 0.1], [1.3, -0.2], [-2.0, 0.5]]) await bot.look(yaw, pitch, true)
  for (const [yaw] of bot.looks) { const n = (yaw - prev) / step; assert.ok(Math.abs(n - Math.round(n)) < 1e-6, `not a multiple: ${n}`); prev = yaw }
})

test('inventory: a click-based item change lets go of the keys and waits for standstill first', async () => {
  const bot = fakeBot(); new MotionGuard(bot, {}, logger).attach()
  bot.entity.velocity = { x: 0.2, y: 0, z: 0 }
  setTimeout(() => { bot.entity.velocity = { x: 0, y: 0, z: 0 } }, 120)
  let keysAtClick = null; let speedAtClick = null
  bot.clickWindow = async () => { keysAtClick = bot.controlState.forward; speedAtClick = bot.entity.velocity.x }
  // re-attach patch on the fake click (patch happens at attach time, so install after)
  const m2 = new MotionGuard(bot, {}, logger); m2.patchInventory()
  bot.setControlState('forward', true); bot.controlState.forward = true
  await bot.clickWindow(10, 0, 0)
  assert.strictEqual(keysAtClick, false)
  assert.strictEqual(speedAtClick, 0)
})
