const Vec3 = require('vec3')
const { createEngine } = require('./harness')
;(async () => {
  const ctx = await createEngine(); const { engine, bot, server } = ctx
  const R = new Vec3(5, 70, 5)
  const plan = engine.scaffold.planColumn(R, new Vec3(5, 70, 6), () => false)
  console.log('plan', plan)
  try { await engine.scaffold.tower(plan.info, plan.stand) } catch (e) { console.log('ERR', e.message) }
  console.log('bot', bot.entity.position, bot.entity.onGround, engine.ground.describe())
  console.log([...engine.scaffold.created.keys()].join(' | '))
  ctx.dispose(); process.exit(0)
})()
