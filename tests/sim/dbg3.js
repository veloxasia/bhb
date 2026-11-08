const Vec3 = require('vec3'); const path = require('path')
const { createEngine } = require('./harness')
;(async () => {
  const ctx = await createEngine(); const { engine, bot } = ctx
  await engine.startJob(path.resolve('schematics/McDs 64 Module Cobblestone Wall Farm.litematic'), new Vec3(0, 64, 0), 0)
  await new Promise(r => setTimeout(r, Number(process.argv[2] || 25000))); engine.stop()
  await new Promise(r => setTimeout(r, 500))
  const key = process.argv[3] || '40,65,51'
  const t = engine.planner.tasks.get(key)
  console.log('task', t.name, JSON.stringify(t.info.cmp), t.status, t.attempts, t.lastError, 'ready', engine.planner.isReady(t))
  const [x, y, z] = key.split(',').map(Number)
  for (const d of [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]) { const b = bot.blockAt(new Vec3(x+d[0],y+d[1],z+d[2])); const tk = engine.planner.tasks.get(`${x+d[0]},${y+d[1]},${z+d[2]}`); console.log(d.join(','), b.name, 'task:', tk ? tk.name + ' ' + tk.status : '-') }
  const spec = t.info.specs[0]
  console.log('spec', spec.tag, spec.look, spec.horiz, spec.faces.map(f => f.f).join())
  const c = engine.aim.candidates(t.world, spec, { allowScaffold: true, allowSneakGeom: true })
  console.log('cands', c.length)
  ctx.dispose(); process.exit(0)
})()
