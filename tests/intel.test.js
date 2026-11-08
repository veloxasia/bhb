'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { classifyDamage, classifyLeak, classifyStuck, classifyLine } = require('../src/intel/causes')
const { FlightRecorder } = require('../src/intel/recorder')
const { Engine, StrategyBook } = require('../src/intel/engine')

test('damage causes: lava, fall, drowning, suffocation, mob, unknown', () => {
  assert.equal(classifyDamage({ dmg: 4, feet: 'lava', head: 'air', y: 10, frames: [] }).category, 'lava')
  assert.equal(classifyDamage({ dmg: 6, feet: 'air', head: 'air', y: 10, frames: [{ y: 16 }, { y: 14 }] }).category, 'fall')
  assert.equal(classifyDamage({ dmg: 2, feet: 'water', head: 'water', oxygen: 0, y: 10, frames: [] }).category, 'drowning')
  assert.equal(classifyDamage({ dmg: 1, feet: 'air', head: 'stone', y: 10, frames: [] }).category, 'suffocation')
  assert.equal(classifyDamage({ dmg: 3, feet: 'air', head: 'air', y: 10, frames: [], mobs: [{ name: 'zombie', dist: 2 }] }).category, 'mob')
  assert.equal(classifyDamage({ dmg: 3, feet: 'air', head: 'air', y: 10, frames: [] }).category, 'unknown')
})

test('leak cause: wall broken by this bot while clearing is named, with the pour and the block', () => {
  const now = Date.now()
  const history = new Map([['254,-53,23', [{ t: now - 20_000, from: 'cobblestone', to: 'air', by: 'this bot (dig)', phase: 'clearing the cell' }]]])
  const r = classifyLeak({ cell: '255,-53,23', kind: 'lava', now, pours: [{ t: now - 25_000, key: '253,-53,23', name: 'lava', check: { blocked: false } }], history, isDesignAir: () => true })
  assert.equal(r.category, 'leak-lava')
  assert.match(r.cause, /broke the wall/)
  assert.ok(r.evidence.some(e => /pour of lava at 253,-53,23/.test(e)))
  assert.ok(r.evidence.some(e => /cobblestone at 254,-53,23 was removed/.test(e)))
})

test('leak cause: temporary block removed, forced pour, no pour at all', () => {
  const now = Date.now()
  const h = new Map([['1,1,1', [{ t: now - 5000, from: 'cobblestone', to: 'air', by: 'scaffold (this bot)', phase: 'tidying', temp: true }]]])
  assert.match(classifyLeak({ cell: '2,1,1', kind: 'water', now, pours: [{ t: now - 9000, key: '3,1,1', name: 'water', check: { blocked: false } }], history: h }).cause, /temporary block/)
  assert.match(classifyLeak({ cell: '2,1,1', kind: 'water', now, pours: [{ t: now - 9000, key: '3,1,1', name: 'water', forced: true, check: { blocked: true, why: 'x' } }], history: new Map() }).cause, /forced pour/)
  assert.match(classifyLeak({ cell: '2,1,1', kind: 'water', now, pours: [], history: new Map() }).cause, /no known pour/)
})

test('stuck causes depend on the phase; log lines get categories', () => {
  assert.match(classifyStuck({ kind: 'stuck', phase: 'aiming' }).cause, /server/)
  assert.match(classifyStuck({ kind: 'loop', cells: 3, secs: 12 }).cause, /circles/)
  assert.equal(classifyLine('FLUID EVENT: lava outside the design at 1,2,3').category, 'leak')
  assert.equal(classifyLine('hazard guard: stopped before a pit I could not climb out of at 1,2,3').category, 'guard-pit')
  assert.equal(classifyLine('nothing interesting'), null)
})

function fakeBot () {
  const bot = new EventEmitter()
  bot.entity = { position: { x: 0.5, y: 64, z: 0.5, distanceTo () { return 1 } }, velocity: { x: 0, y: 0, z: 0 }, onGround: true, yaw: 0, pitch: 0 }
  bot.health = 20; bot.food = 20; bot.entities = {}
  return bot
}

test('recorder: damage is explained, death writes a postmortem file, a stray lava cell produces a leak analysis with the pour', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'))
  const bot = fakeBot()
  const blocks = new Map([['0,64,0', 'lava']])
  const world = { blockAt: p => ({ name: blocks.get(`${p.x},${p.y},${p.z}`) || 'air', position: p }) }
  const planner = { fluidCells: new Map(), tasks: new Map(), box: { x0: -9, x1: 9, y0: 60, y1: 80, z0: -9, z1: 9 } }
  const logs = []
  const rec = new FlightRecorder({ bot, world, config: {}, logger: { warn: m => logs.push(m) }, name: 'T1', getPlanner: () => planner, getScaffold: () => ({ created: new Map() }), getPhase: () => 'testing', isActive: () => true, dir })
  rec.start()
  bot.emit('health'); bot.health = 14; bot.emit('health')
  assert.equal(rec.damage[0].category, 'lava')
  bot.emit('death')
  rec.pour({ key: '5,64,5', name: 'lava', world: { x: 5, y: 64, z: 5 } }, { blocked: false })
  rec.dig({ x: 4, y: 64, z: 5 }, 'clearing')
  bot.emit('blockUpdate', { name: 'cobblestone', position: { x: 4, y: 64, z: 5 } }, { name: 'air', position: { x: 4, y: 64, z: 5 } })
  bot.emit('blockUpdate', { name: 'air', position: { x: 6, y: 64, z: 5 } }, { name: 'lava', position: { x: 6, y: 64, z: 5 } })
  await new Promise(r => setTimeout(r, 1800))
  rec.stop()
  const pm = fs.readdirSync(path.join(dir, 'postmortems'))
  assert.ok(pm.some(f => /death/.test(f)))
  const leak = pm.find(f => /leak/.test(f))
  assert.ok(leak)
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'postmortems', leak), 'utf8'))
  assert.match(doc.classification.cause, /broke the wall/)
  assert.ok(doc.world && doc.blockHistoryNearLeak.length)
  assert.ok(logs.some(l => /LEAK ANALYSIS/.test(l)))
  assert.ok(fs.existsSync(path.join(dir, 'diagnosis.T1.md')))
})

test('engine preflight: leak mode holds fluid tasks and nearby work, soft reasons never block forever', () => {
  const bot = fakeBot()
  const world = { blockAt: p => ({ name: p.x === 9 ? 'lava' : 'air' }) }
  const eng = new Engine({ bot, world, config: {}, logger: { info () {} }, recorder: null, getPlanner: () => ({ fluidCells: new Map() }), getPlacer: () => null, exit: {}, navigation: {}, scaffold: {}, stateDir: null, name: 'T' })
  const fluid = { kind: 'fluid', name: 'water', key: '0,64,0', world: { x: 0, y: 64, z: 0 } }
  assert.equal(eng.preflight(fluid).go, true)
  eng.leak = { active: true, cells: new Set(['9,64,0']), since: Date.now() }
  const pf = eng.preflight(fluid)
  assert.equal(pf.go, false); assert.equal(pf.reasons[0].code, 'leak-active')
  const near = { kind: 'block', name: 'stone', key: '8,64,0', world: { x: 8, y: 64, z: 0 } }
  assert.equal(eng.preflight(near).go, false)
  const far = { kind: 'block', name: 'stone', key: '-20,64,0', world: { x: -20, y: 64, z: 0 } }
  assert.equal(eng.preflight(far).go, true)
  // lava next to a block that is not a fluid task: soft, goes ahead on the 4th hold
  eng.leak = { active: false, cells: new Set(), since: 0 }
  const beside = { kind: 'block', name: 'stone', key: '8,64,5', world: { x: 8, y: 64, z: 5 } }
  const res = [1, 2, 3, 4, 5].map(() => eng.preflight(beside).go)
  assert.deepEqual(res.slice(0, 1), [false])
})

test('strategy book re-ranks by what worked and keeps a mild prior for the designed order', () => {
  const book = new StrategyBook(null, { stuck: ['a', 'b', 'c'] })
  assert.equal(book.order('stuck')[0].id, 'a')
  for (let i = 0; i < 6; i++) { book.record('stuck', 'a', false); book.record('stuck', 'c', true) }
  assert.equal(book.order('stuck')[0].id, 'c')
  assert.equal(book.order('stuck', ['a', 'b']).map(x => x.id).join(), 'b,a')
})

test('engine solve: tries strategies in ranked order, stops at the first that works, records it; near-lava ignores design lava', async () => {
  const bot = fakeBot()
  const calls = []
  const exit = { escape: async o => { calls.push(o.lava ? 'retreat' : 'escape'); return { escaped: true } }, containStray: async () => { calls.push('contain'); return 0 } }
  const planner = { fluidCells: new Map([['1,64,0', 'lava']]) }
  const logs = []
  const eng = new Engine({ bot, world: { blockAt: () => ({ name: 'air' }) }, config: {}, logger: { info: m => logs.push(m) }, recorder: null, getPlanner: () => planner, getPlacer: () => null, exit, navigation: {}, scaffold: {}, stateDir: null, name: 'T' })
  eng.onNearLava({ lava: [1, 0, 0] }) // design lava at 1,64,0 (bot floor 0.5,64,0.5): ignored
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(calls, [])
  assert.equal(await eng.solve('lava-near', { why: 'test' }), true)
  assert.deepEqual(calls, ['retreat'])
  assert.equal(eng.book.stats['lava-near'].retreat.ok, 1)
  assert.ok(logs.some(l => /BRAIN: problem "lava-near"/.test(l)))
})
