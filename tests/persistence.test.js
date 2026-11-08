'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { Persistence } = require('../src/state/persistence')

test('active job persistence survives atomic save/load and can be cleared', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-builder-'))
  try {
    const persistence = new Persistence(dir)
    const active = { file: '/tmp/example.schem', origin: { x: 1, y: 2, z: 3 }, rotation: 90, jobId: 'example' }
    await persistence.saveActive(active)
    assert.deepEqual(await persistence.loadActive(), active)
    await persistence.clearActive()
    assert.equal(await persistence.loadActive(), null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('continue build: unloaded chunk restore, detectResumeLayer, fastForwardBelowLayer, and Hub continue command', async () => {
  const Vec3 = require('vec3')
  const { BuildPlanner } = require('../src/planner/build-planner')
  const { Hub } = require('../src/fleet/hub')

  const blocks = {
    '0,0,0': ['stone'], '1,0,0': ['stone'],
    '0,1,0': ['stone_bricks'], '1,1,0': ['stone_bricks'],
    '0,2,0': ['oak_planks'], '1,2,0': ['oak_planks']
  }
  const size = new Vec3(2, 3, 1)
  const schematic = {
    size, start: () => new Vec3(0, 0, 0), end: () => size.offset(-1, -1, -1), tiles: new Map(),
    getBlock: p => {
      const b = blocks[`${p.x},${p.y},${p.z}`]
      return b
        ? { name: b[0], properties: {}, isAir: false, getProperties: () => ({}) }
        : { name: 'air', properties: {}, isAir: true, getProperties: () => ({}) }
    }
  }
  const transform = { rotation: 0, origin: new Vec3(314, -60, 126), localToWorld: p => p.offset(314, -60, 126) }
  const logger = { info () {}, warn () {}, debug () {} }
  const p0 = new BuildPlanner({ schematic }, transform, { blockAt: () => null }, {}, logger).build()
  for (const t of p0.tasks.values()) {
    if (t.layer <= 1) p0.markCompleted(t)
  }
  const saved = p0.serialize()

  // Worker in an unloaded chunk (blockAt returns null) preserves saved completed status
  const pWorker = new BuildPlanner({ schematic }, transform, { blockAt: () => null }, {}, logger).build()
  pWorker.restore(saved)
  assert.equal(pWorker.getStats().completed, 4)
  assert.equal(pWorker.detectResumeLayer(), 2)

  // Explicit fastForwardBelowLayer skips lower layers on a fresh planner
  const pFresh = new BuildPlanner({ schematic }, transform, { blockAt: () => null }, {}, logger).build()
  const skipped = pFresh.fastForwardBelowLayer(2)
  assert.equal(skipped, 4)
  assert.equal(pFresh.getStats().completed, 4)
  const nextTask = pFresh.nextCandidate(new Vec3(314, -58, 126))
  assert.ok(nextTask && nextTask.layer === 2)

  // Hub 'continue' command preserves log & broadcasts continueMode + startLayer
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'human-builder-hub-'))
  try {
    const hub = new Hub({ logger, jobFile: path.join(dir, 'fleet-job.json'), resume: false })
    const sent = []
    hub.attach('Build', 0, { on () {}, send: m => sent.push(m) })
    hub.command({ cmd: 'start', file: 'farm.litematic', origin: { x: 314, y: -60, z: 126 }, rotation: 0 })
    hub.log.push({ key: '314,-60,126', id: 'Build' })
    hub.command({ cmd: 'continue', file: 'farm.litematic', origin: { x: 314, y: -60, z: 126 }, rotation: 0, startLayer: 13 })
    assert.equal(hub.log.length, 1, 'continuing the same job must preserve hub completion log')
    assert.equal(hub.job.startLayer, 13)
    assert.equal(hub.job.continueMode, true)
    assert.equal(sent[sent.length - 1].continueMode, true)
    assert.equal(sent[sent.length - 1].startLayer, 13)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
