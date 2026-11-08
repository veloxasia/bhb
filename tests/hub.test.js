'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Hub } = require('../src/fleet/hub')
const { ReplicaCoordinator } = require('../src/fleet/replica')

const quiet = { info () {}, warn () {}, debug () {} }

// a worker as the hub sees it: two EventEmitters standing in for the IPC pipe
function connect (hub, id, index) {
  const toHub = new EventEmitter(); const fromHub = new EventEmitter()
  const received = []
  const ch = new EventEmitter()
  ch.send = m => { received.push(m); fromHub.emit('message', m) }
  hub.attach(id, index, ch)
  const coord = new ReplicaCoordinator(2, {}, m => ch.emit('message', m), id)
  fromHub.on('message', m => coord.apply(m))
  coord.register(id, index, { entity: { position: { x: index * 10, y: 64, z: 0 } } })
  return { coord, received, ch }
}

test('hub: finished blocks reach the other workers and survive a restart (hello replays the log)', async () => {
  const hub = new Hub({ logger: quiet })
  const a = connect(hub, 'A', 0); const b = connect(hub, 'B', 1)
  a.coord.complete('1,2,3', 'A'); a.coord.complete('4,5,6', 'A'); a.coord.flush()
  assert.deepEqual(b.coord.log.map(e => e.key), ['4,5,6', '1,2,3'].reverse())
  // B's process dies and a new one starts: it asks for the state
  hub.detach('B')
  const b2 = connect(hub, 'B', 1)
  b2.ch.emit('message', { t: 'hello' })
  assert.equal(b2.coord.log.length, 2)
})

test('hub: claims and positions are shared, and an offline worker releases its claim', () => {
  const hub = new Hub({ logger: quiet })
  const a = connect(hub, 'A', 0); const b = connect(hub, 'B', 1)
  a.coord.claim('A', { key: 'k', world: { x: 5, y: 64, z: 5 } })
  assert.equal(b.coord.busyFor('B', { key: 'k', world: { x: 5, y: 64, z: 5 } }, false), true)
  a.coord.report()
  assert.ok(b.coord.workers.get('A').pos)
  hub.detach('A')
  assert.equal(b.coord.busyFor('B', { key: 'k', world: { x: 5, y: 64, z: 5 } }, false), false)
})

test('hub: the job is remembered (also on disk) and sent to every worker that says hello', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-')), 'job.json')
  const hub = new Hub({ logger: quiet, jobFile: file })
  const a = connect(hub, 'A', 0); const b = connect(hub, 'B', 1)
  a.coord.send({ t: 'cmd', cmd: 'start', file: 'farm.litematic', origin: { x: 1, y: 2, z: 3 }, rotation: 90 })
  assert.ok(b.received.some(m => m.t === 'cmd' && m.cmd === 'start' && m.file === 'farm.litematic'))
  const hub2 = new Hub({ logger: quiet, jobFile: file }) // the whole program restarts
  assert.equal(hub2.job.file, 'farm.litematic')
  const c = connect(hub2, 'C', 1)
  c.ch.emit('message', { t: 'hello' })
  assert.equal(c.received.find(m => m.t === 'state').job.rotation, 90)
  a.coord.send({ t: 'cmd', cmd: 'stop' })
  assert.equal(new Hub({ logger: quiet, jobFile: file }).job, null)
})

test('hub: logins are queued one at a time', async () => {
  const hub = new Hub({ logger: quiet, loginGapMs: 120 })
  const a = connect(hub, 'A', 0); const b = connect(hub, 'B', 1)
  const t0 = Date.now()
  a.ch.emit('message', { t: 'login' }); b.ch.emit('message', { t: 'login' })
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.ok(a.received.some(m => m.t === 'login-ok') && b.received.some(m => m.t === 'login-ok'))
  assert.ok(Date.now() - t0 >= 120)
})

test('hub: a silent worker is reported dead', () => {
  const hub = new Hub({ logger: quiet, deadAfterMs: 50 })
  const a = connect(hub, 'A', 0)
  hub.channels.get('A').lastMsg = Date.now() - 1000
  assert.deepEqual(hub.deadWorkers(), ['A'])
  void a
})
