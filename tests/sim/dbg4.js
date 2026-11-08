const Vec3 = require('vec3')
const { createEngine } = require('./harness')
;(async () => {
  const ctx = await createEngine()
  const { server, bot, engine } = ctx
  server.fillBox(new Vec3(-8, 64, -8), new Vec3(8, 80, 8), 'air')
  bot.entity.position = new Vec3(5.5, 64, 5.5); bot.entity.onGround = true
  const info = { floor: new Vec3(1, 64, 0), height: 6 }
  await engine.scaffold.tower(info, new Vec3(1.5, 70, 0.5))
  console.log('pos', bot.entity.position, 'st', engine.ground.describe?.())
  const { FREE } = require('../../src/interaction/placer')
  const R = new Vec3(0, 69, 0)
  console.log('FREE', FREE && FREE.faces && FREE.faces.length, Object.keys(require('../../src/interaction/placer')))
  const c = engine.aim.candidates(R, FREE || {}, { fixedStand: bot.entity.position.floored(), allowScaffold: false })
  console.log(c.length, engine.aim.lastReject, bot.blockAt(new Vec3(1,69,0))?.name, bot.blockAt(new Vec3(1,70,0))?.name)
  ctx.dispose(); process.exit(0)
})()
