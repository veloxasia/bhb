const Vec3 = require('vec3'); const path = require('path')
const { createEngine } = require('./harness')
;(async () => {
  const ctx = await createEngine(); const { engine, bot } = ctx
  await engine.startJob(path.resolve('schematics/McDs 64 Module Cobblestone Wall Farm.litematic'), new Vec3(0, 64, 0), 0)
  await new Promise(r => setTimeout(r, Number(process.argv[3] || 0))); engine.stop(); await new Promise(r => setTimeout(r, 800))
  const key = process.argv[2] || '48,68,52'
  const t = engine.planner.tasks.get(key)
  console.log('task', t.status, t.attempts, t.lastError)
  for (const d of [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) console.log(d.join(), bot.blockAt(t.world.offset(...d)).name)
  const spec = t.info.specs[0]
  for (const o of [{}, { allowScaffold: true }, { onlyScaffold: true }]) { const c = engine.aim.candidates(t.world, spec, { ...o, max: 4 }); console.log(JSON.stringify(o), c.length, engine.aim.lastReject, c[0] && c[0].stand, c[0] && c[0].faceName, c[0] && c[0].sneak) }
  const rb = bot.blockAt(t.world.offset(0, -1, 0)); console.log('ref', rb.name, rb.boundingBox, JSON.stringify(rb.shapes))
  engine.running = true
  try { console.log(await engine.placer.execute(t)) } catch (e) { console.log('ERR', e.code, e.message) }
  console.log(bot.blockAt(t.world).name, engine.aim.lastReject)
  ctx.dispose(); process.exit(0)
})()
