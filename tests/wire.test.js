'use strict'
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { installWireFixes } = require('../src/interaction/wire')

function rig (version = '1.21.4') {
  const written = []
  const client = new EventEmitter()
  client.write = (name, p) => { written.push(name) }
  const bot = new EventEmitter()
  Object.assign(bot, { _client: client, version, entity: {} })
  return { bot, client, written }
}
const tick = (bot, client, flying) => { bot.emit('physicsTick'); if (flying) client.write(flying, {}) }

test('tick_end follows the movement packet, exactly once per tick, also on ticks without movement', async () => {
  const { bot, client, written } = rig()
  installWireFixes(bot, {}, null)
  tick(bot, client, 'position_look'); await Promise.resolve()
  tick(bot, client, null); await Promise.resolve()
  tick(bot, client, 'flying'); await Promise.resolve()
  assert.deepStrictEqual(written, ['position_look', 'tick_end', 'tick_end', 'flying', 'tick_end'])
})

test('old protocols (1.21.1) get no tick_end; mod channels and the sign editor are ignored', async () => {
  const { bot, client, written } = rig('1.21.1')
  installWireFixes(bot, {}, null)
  tick(bot, client, 'position'); await Promise.resolve()
  assert.deepStrictEqual(written, ['position'])
  let signs = 0; let other = 0
  client.on('open_sign_entity', () => signs++)
  client.on('custom_payload', p => { if (p.channel === 'minecraft:brand') other++ })
  client.emit('open_sign_entity', {}); client.emit('custom_payload', { channel: 'voicechat:x', data: Buffer.from('a') }); client.emit('custom_payload', { channel: 'minecraft:brand', data: Buffer.from('a') })
  assert.strictEqual(signs, 0); assert.strictEqual(other, 1)
})
