const Vec3 = require('vec3'); const path = require('path')
const { createEngine } = require('./harness')
const { Placer } = require('../../src/interaction/placer')
const { ScaffoldManager } = require('../../src/recovery/scaffold-manager')
const { AimSolver } = require('../../src/interaction/aim')
const T = {}
function wrap (proto, name, label) { const f = proto[name]; proto[name] = async function (...a) { const t = Date.now(); try { return await f.apply(this, a) } finally { T[label] = (T[label] || [0, 0]); T[label][0] += Date.now() - t; T[label][1]++ } } }
function wrapSync (proto, name, label) { const f = proto[name]; proto[name] = function (...a) { const t = Date.now(); try { return f.apply(this, a) } finally { T[label] = (T[label] || [0, 0]); T[label][0] += Date.now() - t; T[label][1]++ } } }
for (const n of ['execute', 'approach', 'goStand', 'aimAndValidate', 'placeWithSpec', 'provideSupport', 'postActions', 'clearCell']) wrap(Placer.prototype, n, 'placer.' + n)
for (const n of ['tower', 'descend']) wrap(ScaffoldManager.prototype, n, 'scaffold.' + n)
wrapSync(AimSolver.prototype, 'candidates', 'aim.candidates')
;(async () => {
  const ctx = await createEngine(); const { engine } = ctx
  const t0 = Date.now()
  await engine.startJob(path.resolve('schematics/McDs 64 Module Cobblestone Wall Farm.litematic'), new Vec3(0, 64, 0), 0)
  await new Promise(r => setTimeout(r, Number(process.argv[2] || 40000))); engine.stop(); await new Promise(r => setTimeout(r, 300))
  console.log('wall', Date.now() - t0, 'done', engine.planner.getStats().completed)
  for (const [k, v] of Object.entries(T).sort((a, b) => b[1][0] - a[1][0])) console.log(k.padEnd(24), String(v[0]).padStart(7), 'ms', String(v[1]).padStart(6), 'calls', (v[0] / v[1]).toFixed(1), 'ms/call')
  ctx.dispose(); process.exit(0)
})()
