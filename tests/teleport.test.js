'use strict'
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { Teleporter } = require('../src/navigation/teleport')

const log = { info () {}, warn () {}, debug () {} }
function rig (cfg = {}, mates = {}) {
  const sent = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'Me', entity: { position: { x: 0, y: 64, z: 0 } }, controlState: {},
    chat: t => sent.push(t), clearControlStates () {}
  })
  const workers = new Map(Object.entries(mates).map(([id, pos]) => [id, { id, pos, beat: Date.now() }]))
  const fleet = { ids: ['Me', ...Object.keys(mates)], coord: { workers } }
  const config = { teleport: { commandGapMs: 0, minStuckMs: 0, minFailures: 3, warmupMs: 1500, tpaWaitMs: 1500, ...cfg } }
  return { bot, sent, tp: new Teleporter({ bot, config, logger: log, fleet }) }
}
const wait = ms => new Promise(r => setTimeout(r, ms))

test('a /tpa request from a teammate is accepted, from a stranger it is not', async () => {
  const { bot, sent } = rig({}, { Mate: { x: 5, y: 64, z: 5 } })
  bot.emit('messagestr', 'Stranger has requested to teleport to you.')
  bot.emit('messagestr', 'Mate has requested to teleport to you.')
  await wait(2600)
  assert.deepStrictEqual(sent, ['/tpaccept'])
})

test('teleport is the last step: it only fires after repeated failures, then asks the nearest teammate', async () => {
  const { bot, sent, tp } = rig({}, { Mate: { x: 100, y: 90, z: 100 }, Far: { x: -300, y: 64, z: 0 } })
  const target = { x: 102, y: 91, z: 100 }
  assert.strictEqual(await tp.assist(target), false)
  assert.strictEqual(await tp.assist(target), false)
  assert.strictEqual(sent.length, 0)
  setTimeout(() => { bot.entity.position = { x: 101, y: 90, z: 100 } }, 700)
  assert.strictEqual(await tp.assist(target), true)
  assert.deepStrictEqual(sent, ['/tpa Mate'])
})

test('homes: set, replace with /delhome first, never more than three, go back with /home', async () => {
  const { bot, sent, tp } = rig({ homeSetGapMs: 0 })
  tp.file = null
  assert.ok(await tp.setHome(1)); assert.ok(await tp.setHome(2)); assert.ok(await tp.setHome(3))
  assert.strictEqual(await tp.setHome(4), false)
  bot.entity.position = { x: 500, y: 64, z: 500 }
  tp.homes[1] = { x: 500, y: 64, z: 500 }
  sent.length = 0
  assert.ok(await tp.setHome(1)) // occupied: delete first, then set again
  assert.deepStrictEqual(sent, ['/delhome 1', '/sethome 1'])
  tp.homes[2] = { x: 0.5, y: 64, z: 0.5 }
  sent.length = 0
  setTimeout(() => { bot.entity.position = { x: 0.5, y: 64, z: 0.5 } }, 600)
  assert.ok(await tp.goHome(2))
  assert.deepStrictEqual(sent, ['/home 2'])
})
