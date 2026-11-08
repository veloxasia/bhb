'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { createEngine } = require('./sim/harness')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50) } return false }

test('falling pauses the build and it resumes by itself after landing', async () => {
  const ctx = await createEngine({ cfgOverrides: { safety: { airborneToleranceMs: 250 } } })
  try {
    const { bot, server, engine } = ctx
    server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 120, 8), 'air')
    engine.running = true
    bot.recovery.start()
    bot.entity.position = new Vec3(0.5, 110, 0.5); bot.entity.onGround = false; bot.entity.velocity.y = 0
    assert.ok(await until(() => bot.recovery.paused), 'paused while falling')
    assert.equal(engine.autoPaused, true)
    assert.ok(await until(() => !bot.recovery.paused, 8000), 'resumed after landing')
    assert.equal(engine.autoPaused, false)
  } finally { ctx.dispose() }
})

test('a manual pause is never resumed automatically', async () => {
  const ctx = await createEngine()
  try {
    const { bot, engine } = ctx
    engine.running = true; engine.manualPaused = true
    bot.recovery.start()
    await sleep(900)
    assert.equal(bot.recovery.paused, false)
    assert.equal(engine.manualPaused, true)
  } finally { ctx.dispose() }
})

test('standing in lava pauses and walks out', async () => {
  const ctx = await createEngine()
  try {
    const { bot, server, engine } = ctx
    server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
    server.setBlock(new Vec3(5, 64, 5), 'lava')
    bot.entity.position = new Vec3(5.5, 64, 5.5)
    engine.running = true
    bot.recovery.start()
    assert.ok(await until(() => bot.recovery.paused, 3000), 'paused in lava')
    assert.ok(await until(() => !bot.recovery.paused, 10000), 'resumed after escaping')
    assert.notEqual(bot.blockAt(bot.entity.position.floored()).name, 'lava')
  } finally { ctx.dispose() }
})
