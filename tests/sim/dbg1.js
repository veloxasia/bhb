const Vec3 = require('vec3'); const path = require('path')
const { createEngine } = require('./harness')
;(async () => {
  const ctx = await createEngine(); const { engine, bot } = ctx
  await engine.startJob(path.resolve('schematics/McDs 64 Module Cobblestone Wall Farm.litematic'), new Vec3(0, 64, 0), 0)
  await new Promise(r => setTimeout(r, 6000)); engine.stop()
  const t = engine.planner.tasks.get('24,65,44')
  console.log('task', t.name, t.status, t.attempts, t.lastError, 'ready', engine.planner.isReady(t))
  for (const d of [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]) { const b = bot.blockAt(new Vec3(24+d[0],65+d[1],44+d[2])); console.log(d.join(','), b.name) }
  const spec = t.info.specs[0]
  const c = engine.aim.candidates(t.world, spec, { allowScaffold: true })
  console.log('cands', c.length)
  const c2 = engine.aim.candidates(t.world, spec, { stages: [{ r: 6, down: 3, up: 3, aroundTarget: true }] })
  console.log('wide', c2.length)
  console.log(bot.entity.position)
  ctx.dispose(); process.exit(0)
})()
