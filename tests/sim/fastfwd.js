// Pre-builds every layer below Y0 instantly, then lets the real engine continue. Used to study the later layers quickly.
//   node tests/sim/fastfwd.js <Y0> <seconds>      (TRACE=1 prints each task)
const Vec3 = require('vec3'); const path = require('path')
const { createEngine } = require('./harness')
;(async () => {
  const Y0 = Number(process.argv[2] || 6); const secs = Number(process.argv[3] || 60); const Y1 = Number(process.argv[4] || 999)
  const ctx = await createEngine(); const { engine, bot, server } = ctx
  const origExec = require('../../src/interaction/placer').Placer.prototype.execute
  require('../../src/interaction/placer').Placer.prototype.execute = async function (t) {
    const s0 = this.stats.towers; const t0 = Date.now(); let r = 'ok'
    try { return await origExec.call(this, t) } catch (e) { r = 'ERR ' + e.message.slice(0, 90); throw e } finally { if (process.env.TRACE) console.log(`${t.name} ${t.world.x},${t.world.y},${t.world.z} towers+${this.stats.towers - s0} ${Date.now() - t0}ms ${r}`) }
  }
  engine.manualPaused = true
  await engine.startJob(path.resolve('schematics/McDs 64 Module Cobblestone Wall Farm.litematic'), new Vec3(0, 64, 0), 0)
  engine.manualPaused = true
  await new Promise(r => setTimeout(r, 500))
  let n = 0
  for (const t of engine.planner.tasks.values()) if ((t.kind === 'block' || t.kind === 'fluid') && t.world.y < 64 + Y0 && t.key !== process.env.FOCUS) { server.setBlock(t.world, t.name, t.properties || {}); n++ }
  for (const t of engine.planner.tasks.values()) if ((t.world.y >= 64 + Y1 || (process.env.SKIP && new RegExp(process.env.SKIP).test(t.name))) && t.status !== 'completed') { engine.planner.setStatus(t, 'blocked'); engine.planner.blocked.add(t.key) }
  engine.planner.reconcileWorld()
  console.log('prebuilt', n, JSON.stringify(engine.planner.getStats()))
  bot.entity.position = new Vec3(10.5, 64 + Y0 + 0.0, 10.5)
  engine.manualPaused = false
  const t0 = Date.now()
  const band = () => [...engine.planner.tasks.values()].filter(t => t.world.y < 64 + Y1 && t.world.y >= 64 + Y0 && !engine.planner.completed.has(t.key))
  let lastN = -1; let lastChange = Date.now()
  while (engine.running && Date.now() - t0 < secs * 1000) {
    await new Promise(r => setTimeout(r, 1000))
    const n = band().length
    if (n === 0 && !engine.running) break
    if (n !== lastN) { lastN = n; lastChange = Date.now() }
    if (Date.now() - lastChange > 90000) { console.log('NO PROGRESS for 90s'); break }
    if (Math.floor((Date.now() - t0) / 1000) % 30 === 0) console.log(`  [${Math.round((Date.now() - t0) / 1000)}s] band remaining ${n}`)
  }
  const left = band(); const by = {}
  for (const t of left) by[t.name] = (by[t.name] || 0) + 1
  for (const t of left.slice(0, 12)) console.log(`   left: ${t.name} ${t.world.x},${t.world.y},${t.world.z} ${t.status} attempts=${t.attempts} err=${t.lastError}`)
  console.log(`BAND y ${Y0}..${Y1}: unfinished ${left.length}`, JSON.stringify(by))
  const s = engine.planner.getStats()
  console.log(`after ${secs}s: done=${s.completed}/${s.total} placed=${engine.placer.stats.placed} towers=${engine.placer.stats.towers}`)
  for (const l of engine.failureSummary(10)) console.log('  fail:', l)
  if (process.env.FOCUS) {
    engine.stop(); await new Promise(r => setTimeout(r, 500))
    engine.running = true; engine.stopRequested = false; engine.manualPaused = false; engine.autoPaused = false
    const t = engine.planner.tasks.get(process.env.FOCUS)
    if (t.kind === 'waterlog') { const par = engine.planner.tasks.get(t.parentKey); server.setBlock(par.world, par.name, { ...par.properties, waterlogged: 'false' }); engine.planner.setStatus(t, 'pending') }
    console.log('FOCUS', t.name, JSON.stringify(t.properties), t.status, 'ready', engine.planner.isReady(t))
    for (const d of [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]) { const b = bot.blockAt(t.world.offset(...d)); console.log('  ', d.join(), b.name, b.boundingBox) }
    process.env.SIMDEBUG = '1'
    if (process.env.DIAG) {
      const [sx, sy, sz, ox, oz, sn] = process.env.DIAG.split(',').map(Number)
      const spec = t.info.specs[0]; const A = engine.aim
      const eye = new Vec3(sx + 0.5 + ox, sy + A.eyeHeight(Boolean(sn)), sz + 0.5 + oz)
      { const c = new Vec3(sx, sy, sz); const { isBodyFree, isFullTop, BAD_BODY } = require('../../src/world/ground'); console.log('feet', bot.blockAt(c).name, isBodyFree(bot.blockAt(c)), 'head', bot.blockAt(c.offset(0,1,0)).name, isBodyFree(bot.blockAt(c.offset(0,1,0))), 'ground', bot.blockAt(c.offset(0,-1,0)).name, isFullTop(bot.blockAt(c.offset(0,-1,0))), 'lava', A.lavaNear(c), [...BAD_BODY].join()) }
      console.log('spec', spec.tag, spec.look, spec.horiz, 'faces', spec.faces.map(f => f.f).join(), 'standOk', A.standOk(new Vec3(sx, sy, sz), new Map()))
      const { hitSamples } = require('../../src/interaction/aim')
      for (const fo of spec.faces) {
        const Fv = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }[fo.f]
        const ref = new Vec3(t.world.x - Fv[0], t.world.y - Fv[1], t.world.z - Fv[2]); const rb = bot.blockAt(ref)
        if (!A.isSolidRef(rb)) { console.log(fo.f, 'ref not solid', rb.name); continue }
        const smp = hitSamples ? hitSamples(ref, fo.f, fo, [0,0,0,1,1,1], true, rb.shapes) : []
        const res = smp.slice(0, 40).map(p => { const d = p.minus(eye); const dom = require('../../src/interaction/aim').dominantDirection?.(d); return `${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}:${dom ? dom.name + dom.ratio.toFixed(2) : '?'}:los=${A.los(eye, p, ref, fo.f)}` })
        console.log(fo.f, ref.toString(), res.slice(0, 6).join(' | '))
      }
    }
    if (process.env.MAP) { const [cx, cy, cz] = process.env.FOCUS.split(',').map(Number); for (let y = cy + 3; y >= cy - 3; y--) { console.log('y=' + y); for (let z = cz - 2; z <= cz + 5; z++) { let row = ''; for (let x = cx - 3; x <= cx + 3; x++) { const b = bot.blockAt(new Vec3(x, y, z)); row += (b.name === 'air' ? '.' : b.name === 'water' ? '~' : b.name[0].toUpperCase()).padEnd(2) } console.log('  z=' + z + ' ' + row) } } }
    const { FREE } = require('../../src/interaction/placer')
    for (const o of [{}, { allowScaffold: true }]) { const c = engine.aim.candidates(t.world, FREE, { ...o, max: 5 }); console.log('cands', JSON.stringify(o), c.length, c.map(x => `${x.stand.x},${x.stand.y},${x.stand.z}/${x.faceName}${x.scaffold ? '/T' : ''}${x.sneak ? '/s' : ''}`).join(' ')) }
    if (process.env.WRAP) {
      const orig = engine.interaction.useHeldItem.bind(engine.interaction)
      engine.interaction.useHeldItem = () => { const e = bot.entity; const cp = Math.cos(e.pitch); const dir = new Vec3(-Math.sin(e.yaw) * cp, Math.sin(e.pitch), -Math.cos(e.yaw) * cp); const b = bot.world.raycast(bot.eyePos(), dir, 5); console.log('USE ray hits', b && b.name, b && b.position.toString(), 'face', b && b.face, 'eye', bot.eyePos().toString(), 'dir', dir.toString()); return orig() }
      const og = engine.aim.validateView.bind(engine.aim)
      engine.aim.validateView = (...a) => { const r = og(...a); console.log('validateView', a[3], a[2].toString(), r ? 'OK ' + r.cursor : 'REJECT ' + engine.aim.lastReject); return r }
    }
    try { console.log('RESULT', await engine.placer.execute(t)) } catch (e) { console.log('ERR', e.code, e.message, '|', engine.aim.lastReject) }
    console.log('now', bot.blockAt(t.world).name, 'bot', bot.entity.position.toString())
  }
  engine.stop(); ctx.dispose(); process.exit(0)
})()
