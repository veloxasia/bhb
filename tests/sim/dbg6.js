const Vec3 = require('vec3')
const { createEngine } = require('./harness')
;(async () => {
  const ctx = await createEngine({ cfgOverrides: { safety: { airborneToleranceMs: 250 } } })
  const { bot, server, engine } = ctx
  server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 120, 8), 'air')
  engine.running = true; bot.recovery.start()
  bot.entity.position = new Vec3(0.5, 110, 0.5); bot.entity.onGround = false; bot.entity.velocity.y = 0
  for (let i = 0; i < 12; i++) { await new Promise(r => setTimeout(r, 300)); console.log(bot.entity.position.y.toFixed(1), engine.ground.state(), bot.recovery.paused, bot.recovery.badSince.airborne, engine.config.safety.airborneToleranceMs) }
  ctx.dispose(); process.exit(0)
})()
