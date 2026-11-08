'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const Vec3 = require('vec3')
const { createEngine } = require('./sim/harness')
const { BuildPlanner } = require('../src/planner/build-planner')
const { Coordinator } = require('../src/fleet/coordinator')

function makePlanner (ctx, blocks, size) {
  const { bot, engine } = ctx
  const schematic = {
    size, start: () => new Vec3(0, 0, 0), end: () => size.offset(-1, -1, -1), tiles: new Map(),
    getBlock: p => { const b = blocks[`${p.x},${p.y},${p.z}`]; return b ? { name: b[0], properties: b[1] || {}, isAir: false, getProperties: () => ({ ...(b[1] || {}) }) } : { name: 'air', properties: {}, isAir: true, getProperties: () => ({}) } }
  }
  const world = { bot, blockAt: p => bot.blockAt(p) }
  return new BuildPlanner({ schematic }, { rotation: 0, origin: new Vec3(0, 64, 0), localToWorld: p => p.offset(0, 64, 0) }, world, engine.config, { info () {}, warn () {}, debug () {} }).build()
}

function slab (w, h, d) {
  const blocks = {}
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let z = 0; z < d; z++) blocks[`${x},${y},${z}`] = [y === 1 ? 'stone_bricks' : 'stone']
  return blocks
}

test('fleet: zones cover every block once and are balanced per layer', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(30, 80, 30), 'air')
    const coord = new Coordinator(4)
    const planners = [0, 1, 2, 3].map(i => makePlanner(ctx, slab(20, 3, 8), new Vec3(20, 3, 8)).joinFleet(coord, `w${i}`, i, 4))
    const owners = new Map()
    for (const [i, p] of planners.entries()) for (const t of p.tasks.values()) { if (i === 0) owners.set(t.key, t.owner); else assert.equal(owners.get(t.key), t.owner, 'every worker computes the same zones') }
    const perLayer = {}
    for (const t of planners[0].tasks.values()) { const k = `${t.order}|${t.owner}`; perLayer[k] = (perLayer[k] || 0) + 1 }
    for (const v of Object.values(perLayer)) assert.ok(v >= 38 && v <= 42, `balanced slice: ${v}`)
    let share = 0
    for (const p of planners) share += [...p.materialDemand.values()].reduce((a, b) => a + b, 0)
    assert.equal(share, planners[0].total, 'material demand split without loss')
  } finally { ctx.dispose() }
})

test('fleet: 4 planners finish a build together, nobody places a block twice, layers stay in order', async () => {
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(30, 80, 30), 'air')
    const coord = new Coordinator(4)
    const planners = []; const pos = []
    for (let i = 0; i < 4; i++) {
      const p = makePlanner(ctx, slab(20, 3, 8), new Vec3(20, 3, 8)).joinFleet(coord, `w${i}`, i, 4)
      const position = new Vec3(i * 6, 64, 0)
      coord.register(`w${i}`, i, { entity: { position } })
      planners.push(p); pos.push(position)
    }
    const placed = new Map(); const per = [0, 0, 0, 0]
    let idle = 0
    for (let round = 0; round < 5000 && planners[0].getStats().remaining > 0; round++) {
      let did = false
      for (let i = 0; i < 4; i++) {
        coord.release(`w${i}`)
        const p = planners[i]
        const t = p.next(pos[i]) || p.nextCandidate(pos[i])
        if (!t) continue
        assert.ok(!placed.has(t.key), `block ${t.key} placed twice`)
        // layer barrier: nothing of a lower layer step may still be open anywhere
        for (const o of p.orders) { if (o >= t.order) break; assert.equal(p.orderGroups.get(o).remaining, 0, `layer ${o} unfinished while placing layer ${t.order}`) }
        placed.set(t.key, i); per[i]++
        ctx.server.setBlock(t.world, t.name)
        pos[i].x = t.world.x; pos[i].z = t.world.z
        p.rescanTask(t)
        did = true
      }
      if (!did && ++idle > 50) break
    }
    for (const p of planners) p.syncFleet()
    assert.equal(placed.size, planners[0].total, 'everything built')
    assert.equal(planners[0].getStats().remaining, 0)
    for (const n of per) assert.ok(n > planners[0].total / 4 * 0.6, `work shared: ${per}`)
  } finally { ctx.dispose() }
})

test('fleet: a helper keeps its distance and does not take what another bot is working on', async () => {
  const coord = new Coordinator(2, { minGap: 6 })
  coord.register('a', 0, { entity: { position: { x: 0, y: 64, z: 0 } } })
  coord.register('b', 1, { entity: { position: { x: 30, y: 64, z: 0 } } })
  const near = { key: 'n', world: { x: 3, y: 64, z: 0 } }
  const far = { key: 'f', world: { x: 20, y: 64, z: 0 } }
  assert.equal(coord.busyFor('b', near, true), true, 'too close to bot a')
  assert.equal(coord.busyFor('b', far, true), false)
  coord.claim('a', far)
  assert.equal(coord.busyFor('b', far, false), true, 'claimed')
  coord.release('a')
  assert.equal(coord.busyFor('b', far, false), false)
})

test('fleet: finishing needs every living worker; a vanished worker does not block it', () => {
  const coord = new Coordinator(2)
  coord.register('a', 0, {}); coord.register('b', 1, {})
  coord.setDone('a', true)
  assert.equal(coord.allDone(), false)
  coord.workers.get('b').beat = Date.now() - 120_000
  assert.equal(coord.allDone(), true)
})

test('analysis: full plan has the split, time estimate and materials', async () => {
  const { plan } = require('../src/planner/architect')
  const { buildAnalysis } = require('../src/planner/analysis')
  const ctx = await createEngine()
  try {
    ctx.server.fillBox(new Vec3(-8, 64, -8), new Vec3(30, 80, 30), 'air')
    const p = makePlanner(ctx, slab(20, 3, 8), new Vec3(20, 3, 8))
    const { sequence, report } = plan(p, { start: { x: 0, z: 0 } })
    const { out, markdown } = buildAnalysis(p, sequence, report, { workers: 4, name: 't', config: ctx.engine.config })
    assert.equal(out.perWorker.length, 4)
    assert.equal(out.perWorker.reduce((a, w) => a + w.blocks, 0), 480)
    assert.ok(out.estimate.fleetPlannerMin <= out.estimate.soloPlannerMin)
    assert.match(markdown, /Work split/)
  } finally { ctx.dispose() }
})

test('fleet: lookahead only takes plain structure, never fluids, observers or power', () => {
  const lookOk = BuildPlanner.prototype.lookOk
  const mk = (name, kind = 'block', order = 4, fragile = false) => ({ name, kind, order, info: { fragile } })
  assert.equal(lookOk(mk('stone')), true)
  assert.equal(lookOk(mk('water', 'fluid')), false)
  assert.equal(lookOk(mk('observer', 'block', 90003)), false)
  assert.equal(lookOk(mk('redstone_torch', 'block', 100001)), false)
  assert.equal(lookOk(mk('redstone_wire', 'block', 5, true)), false)
  assert.equal(lookOk(mk('lantern')), false)
})
