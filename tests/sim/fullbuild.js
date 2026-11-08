'use strict'
// Runs the REAL engine (planner, placer, aim solver, scaffold, recovery) on a real schematic inside the sim.
//   node tests/sim/fullbuild.js <schematic> [maxSeconds] [maxLayers]
const Vec3 = require('vec3')
const path = require('path')
const { createEngine } = require('./harness')

async function main () {
  const file = path.resolve(process.argv[2] || 'schematics/McDs 64 Module Cobblestone Wall Farm.litematic')
  const maxSeconds = Number(process.argv[3] || 600)
  const ctx = await createEngine({ serverOpts: { observerMode: process.env.OBS || 'opposite' } })
  const { engine, bot, server } = ctx
  const t0 = Date.now()
  await engine.startJob(file, new Vec3(0, 64, 0), 0)
  let lastDone = -1; let ticks = 0
  const timer = setInterval(() => {
    const s = engine.planner.getStats()
    const el = ((Date.now() - t0) / 1000).toFixed(0)
    console.log(`[${el}s] ${s.percent}% done=${s.completed}/${s.total} remaining=${s.remaining} deferred=${s.deferred} blocked=${s.blocked} placed=${engine.placer.stats.placed} dug=${engine.placer.stats.dug} wrong=${engine.placer.stats.wrongState} towers=${engine.placer.stats.towers} tp=${ctx.nav.teleports}`)
    if (s.completed === lastDone && engine.running) console.log('  (no progress in this interval)')
    lastDone = s.completed
    if (++ticks % 6 === 0) for (const l of engine.failureSummary(6)) console.log('    fail:', l)
  }, 10000)
  while (engine.running && Date.now() - t0 < maxSeconds * 1000) await new Promise(r => setTimeout(r, 500))
  clearInterval(timer)
  engine.stop()
  await new Promise(r => setTimeout(r, 800))
  const v = engine.verifyAll()
  console.log(`\nFINAL correct=${v.correct}/${v.total} wrong=${v.wrong} running=${engine.running} violations=${server.violations.length}`)
  console.log('learned:', JSON.stringify(engine.learner.preferred))
  console.log('failure summary:'); for (const l of engine.failureSummary(25)) console.log('  ', l)
  const byName = {}
  for (const t of v.wrongTasks) { const k = `${t.name}${t.status === 'blocked' ? ' [blocked]' : ''}`; byName[k] = (byName[k] || 0) + 1 }
  console.log('unfinished by block:', JSON.stringify(byName))
  console.log('scaffold left:', engine.scaffold.getCreated().length, 'commands:', bot.givenCommands.length)
  ctx.dispose()
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
