'use strict'
// Every distinct block state of the real schematic, placed in a sim world under three support layouts.
const fs = require('fs')
const Vec3 = require('vec3')
const { createEngine } = require('./harness')
const { parseLitematicBuffer } = require('../../src/schematic/litematic')
const { BuildPlanner } = require('../../src/planner/build-planner')
const { registry } = require('./simbot')
const { taskMatches } = require('../../src/rules/blocks')

const file = process.argv[2] || 'schematics/McDs 64 Module Cobblestone Wall Farm.litematic'
const only = process.argv[3]
const sch = parseLitematicBuffer(fs.readFileSync(file), registry)
const combos = new Map()
for (const b of sch.blocks.values()) {
  if (/^(water|lava)$/.test(b.name)) continue
  const k = b.name + JSON.stringify(b.properties)
  if (!combos.has(k)) combos.set(k, b)
}

function fakeSchematic (block) {
  return {
    size: new Vec3(1, 1, 1), start: () => new Vec3(0, 0, 0), end: () => new Vec3(0, 0, 0), tiles: new Map(),
    getBlock: () => ({ name: block.name, properties: block.properties, isAir: false, getProperties: () => ({ ...block.properties }) })
  }
}

async function main () {
  const ctx = await createEngine({ serverOpts: { observerMode: process.env.OBS || 'opposite' } })
  const { server, bot, engine } = ctx
  const logger = { info () {}, warn () {}, debug () {} }
  const scenarios = (process.env.SC || 'rich,floor,side,ceiling').split(',')
  const T = new Vec3(0, 66, 0)
  let pass = 0; let fail = 0; const failures = []
  for (const [key, block] of combos) {
    if (only && !key.includes(only)) continue
    for (const sc of scenarios) {
      // reset arena
      server.fillBox(new Vec3(-7, 64, -7), new Vec3(7, 74, 7), 'air')
      server.fillBox(new Vec3(-7, 64, -7), new Vec3(7, 64, 7), 'air')
      let target = new Vec3(0, 64, 0)
      if (sc === 'floor') { /* floor = the world floor at y=63 */ }
      if (sc === 'side') { target = T; server.setBlock(new Vec3(1, 66, 0), 'stone') ; server.setBlock(new Vec3(-1, 66, 0), 'stone'); server.setBlock(new Vec3(0, 66, 1), 'stone'); server.setBlock(new Vec3(0, 66, -1), 'stone') }
      if (sc === 'rich') { target = T; for (const d of [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0],[0,-1,0]]) server.setBlock(T.offset(...d), 'stone') }
      if (sc === 'lowceil') { target = new Vec3(0, 65, 0); server.setBlock(new Vec3(0, 66, 0), 'stone') }
      if (sc === 'ceiling') { target = T; server.setBlock(new Vec3(0, 67, 0), 'stone') }
      bot.entity.position = new Vec3(4.5, 64, 4.5); bot.entity.onGround = true
      bot.slots.fill(null); bot.heldItem = null
      const world = { bot, blockAt: p => bot.blockAt(p) }
      const loaded = { schematic: fakeSchematic(block) }
      const transform = { rotation: 0, origin: target, localToWorld: () => target.clone() }
      let planner
      try { planner = new BuildPlanner(loaded, transform, world, engine.config, logger).build() } catch (e) { failures.push([key, sc, 'planner: ' + e.message]); fail++; continue }
      const task = [...planner.tasks.values()].find(t => t.kind === 'block')
      if (!task) { continue }
      engine.planner = planner
      engine.learner.preferred = {}
      try {
        await engine.placer.execute(task)
        const ok = taskMatches(bot.blockAt(target), task)
        if (ok) pass++; else { fail++; failures.push([key, sc, `wrong: ${JSON.stringify(bot.blockAt(target).getProperties())} ${bot.blockAt(target).name}`]) }
      } catch (e) {
        fail++; failures.push([key, sc, `${e.code || 'ERR'}: ${e.message}`])
      }
      await engine.scaffold.descend().catch(() => {})
    }
  }
  console.log(`pass ${pass}  fail ${fail}  violations ${server.violations.length}`)
  for (const f of failures) console.log('FAIL', f.join(' | '))
  if (server.violations.length) console.log(server.violations.slice(0, 5))
  ctx.dispose()
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
