'use strict'
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const fs = require('fs'); const os = require('os'); const path = require('path')
const { loadConfig } = require('../src/core/config')
const { MaterialManager } = require('../src/core/material-manager')

const tmp = cfg => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mhb-')); fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify(cfg)); return d }

test('donut mode: shop on, /give off; test mode: /give on, shop and teleports off', () => {
  const d = loadConfig(tmp({ mode: 'donut', materials: { autoGive: true } }))
  assert.strictEqual(d.materials.autoGive, false); assert.notStrictEqual(d.shop.enabled, false)
  const t = loadConfig(tmp({ mode: 'test' }))
  assert.strictEqual(t.materials.autoGive, true); assert.strictEqual(t.shop.enabled, false); assert.strictEqual(t.teleport.enabled, false)
  assert.strictEqual(t.safety.healCommand, '')
  assert.strictEqual(loadConfig(tmp({})).mode, 'donut')
})

test('test mode gives items with one plain /give and reports a refused give', async () => {
  const inv = []; const said = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    username: 'Bot1', version: '1.21.4', registry: { itemsByName: { cobblestone: { stackSize: 64 } } },
    inventory: { items: () => inv },
    chat: m => { said.push(m); if (!bot.deny) inv.push({ name: 'cobblestone', count: 64 }); else bot.emit('messagestr', 'Unknown or incomplete command') }
  })
  const log = { info () {}, warn () {}, debug () {} }
  const mm = new MaterialManager(bot, { materials: { autoGive: true }, shop: { enabled: false } }, log)
  assert.strictEqual(await mm.buy('cobblestone', 64), 64)
  assert.deepStrictEqual(said, ['/give Bot1 cobblestone 64'])
  bot.deny = true; inv.length = 0
  await assert.rejects(mm.buy('cobblestone', 64), e => e.code === 'NO_DELIVERY' && /Unknown or incomplete/.test(e.message))
})
