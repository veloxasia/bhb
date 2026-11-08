'use strict'
// Shop menu detection + the dig guard, with fake bots (no server needed).
const test = require('node:test')
const assert = require('node:assert')
const EventEmitter = require('node:events')
const { flattenText, findSlot, itemMatcher, textMatcher, Shop } = require('../src/core/shop')

const item = (name, extra = {}) => ({ name, displayName: name, count: 1, ...extra })
const win = (slots, inventoryStart) => ({ slots, inventoryStart })
const log = { info () {}, warn () {}, debug () {} }

test('flattenText reads chat components and colour codes', () => {
  assert.strictEqual(flattenText('§aCobble §lStone'), 'cobble stone')
  assert.strictEqual(flattenText({ text: 'Next Page' }), 'next page')
  assert.strictEqual(flattenText('{"text":"","extra":[{"text":"Diamond Pickaxe"}]}'), 'diamond pickaxe')
})

test('items are found by icon, by override text, and menu fillers are ignored', () => {
  const w = win([item('gray_stained_glass_pane'), item('stone'), item('cobblestone'), null, item('arrow', { customName: '{"text":"Next Page"}' }), ...new Array(36).fill(null)], 5)
  assert.strictEqual(findSlot(w, itemMatcher('cobblestone')), 2)
  assert.strictEqual(findSlot(w, itemMatcher('anything', { match: 'stone$' })), 1)
  assert.strictEqual(findSlot(w, textMatcher('next|»')), 4)
  assert.strictEqual(findSlot(w, itemMatcher('diamond')), -1)
})

function fakeBot (menu, inv, onClick) {
  const bot = new EventEmitter()
  Object.assign(bot, {
    entity: {}, health: 20, registry: { itemsByName: { cobblestone: { stackSize: 64 } } },
    inventory: { items: () => inv, emptySlotCount: () => 20 },
    chat: m => { bot.said = m; setTimeout(() => { bot.currentWindow = menu; bot.emit('windowOpen', menu) }, 20) },
    clickWindow: async slot => onClick?.(slot),
    closeWindow: () => { bot.currentWindow = null }
  })
  return bot
}

test('shop buys with one click per purchase and learns the amount per click', async () => {
  const inv = []; const clicks = []
  const menu = win([item('cobblestone'), item('dirt'), ...new Array(36).fill(null)], 2)
  const bot = fakeBot(menu, inv, slot => { clicks.push(slot); inv.push({ name: 'cobblestone', count: 64 }) })
  const shop = new Shop(bot, { shop: { command: '/shop', commandCooldownMs: 0, clickDelayMs: [1, 2], afterOpenDelayMs: [1, 2] } }, log)
  const got = await shop.buy('cobblestone', 128)
  assert.strictEqual(bot.said, '/shop')
  assert.deepStrictEqual(clicks, [0, 0])
  assert.strictEqual(got, 128)
  assert.strictEqual(shop.perClick.get('cobblestone'), 64)
})

test('shop reports a missing item and does not retry it at once', async () => {
  const menu = win([item('dirt'), ...new Array(36).fill(null)], 1)
  const bot = fakeBot(menu, [])
  const shop = new Shop(bot, { shop: { commandCooldownMs: 0, clickDelayMs: [1, 2], afterOpenDelayMs: [1, 2], pages: 1 } }, log)
  await assert.rejects(shop.buy('emerald_block', 1), { code: 'NOT_FOUND' })
  await assert.rejects(shop.buy('emerald_block', 1), { code: 'NOT_SOLD' })
})

test('shop reports "nothing arrived" with the server message', async () => {
  const menu = win([item('cobblestone'), ...new Array(36).fill(null)], 1)
  const bot = fakeBot(menu, [], () => bot.emit('messagestr', 'You do not have enough money'))
  const shop = new Shop(bot, { shop: { commandCooldownMs: 0, clickDelayMs: [1, 2], afterOpenDelayMs: [1, 2] } }, log)
  await assert.rejects(shop.buy('cobblestone', 64), e => e.code === 'NO_DELIVERY' && /enough money/.test(e.message))
})

// ---- dig guard ----
const { Vec3 } = require('vec3')
const { HumanInteractionEngine } = require('../src/interaction/human-interaction')

function digRig (accept) {
  const pos = new Vec3(5, 70, 5)
  const state = { air: false }
  const block = { position: pos, type: 1, name: 'stone', digTime: () => 600 }
  const calls = []
  const bot = new EventEmitter()
  Object.assign(bot, {
    game: { gameMode: 'survival' }, heldItem: null, targetDigBlock: null,
    entity: { position: new Vec3(5.5, 70, 8.5), yaw: 0, pitch: 0, eyeHeight: 1.62, attributes: {} },
    inventory: { items: () => [] },
    digTime: () => 600,
    world: { raycast: () => ({ position: pos, face: 3 }) },
    stopDigging () {},
    dig: async (b, look, face) => { calls.push({ look, face, wait: bot.digTime(b) }); if (accept()) state.air = true }
  })
  const world = { isAirLike: b => !b || state.air, blockAt: () => (state.air ? null : block) }
  const engine = new HumanInteractionEngine(bot, world, { dig: { engine: 'mineflayer', marginMs: [70, 170], rejectLimit: 3, settleAfterEquipMs: [1, 2], protectedCooldownMs: 50 } }, log, null)
  return { engine, block, calls, state, bot }
}

test('dig sends the crosshair face and waits slightly longer than the estimate', async () => {
  const r = digRig(() => true)
  await r.engine.digAimed(r.block, 1)
  assert.strictEqual(r.calls.length, 1)
  assert.deepStrictEqual([r.calls[0].face.x, r.calls[0].face.y, r.calls[0].face.z], [0, 0, 1]) // face 3 = +z, not "top"
  assert.ok(r.calls[0].wait >= 670 && r.calls[0].wait <= 780, `wait ${r.calls[0].wait}`)
  assert.strictEqual(r.engine.dig.ok, 1)
})

test('refused breaks are detected, counted, and breaking pauses instead of hammering', async () => {
  const r = digRig(() => false)
  for (let i = 0; i < 3; i++) await assert.rejects(r.engine.digAimed(r.block, 1), { code: 'DIG_REJECTED' })
  await assert.rejects(r.engine.digAimed(r.block, 1), { code: 'DIG_PROTECTED' })
  assert.strictEqual(r.calls.length, 3) // the fourth attempt never touched the server
})

test('tick engine: start packet, finish after the tick count (+margin), rising sequence numbers', async () => {
  const pos = new Vec3(5, 70, 5)
  const state = { air: false }
  const block = { position: pos, type: 1, name: 'stone', digTime: () => 600 } // 12 ticks
  const sent = []
  const bot = new EventEmitter()
  let ticks = 0
  Object.assign(bot, {
    game: { gameMode: 'survival' }, heldItem: null, targetDigBlock: null,
    entity: { position: new Vec3(5.5, 70, 8.5), yaw: 0, pitch: 0, eyeHeight: 1.62, attributes: {}, onGround: true },
    inventory: { items: () => [] }, digTime: () => 600,
    world: { raycast: () => ({ position: pos, face: 3 }) },
    swingArm () {}, stopDigging () {},
    _client: { write (name, p) { sent.push({ name, ...p, at: ticks }); if (p.status === 2) state.air = true } }
  })
  const timer = setInterval(() => { ticks++; bot.emit('physicsTick') }, 5)
  const world = { isAirLike: b => !b || state.air, blockAt: () => (state.air ? null : block) }
  const engine = new HumanInteractionEngine(bot, world, { dig: { marginTicks: [1, 1], settleAfterEquipMs: [1, 2] } }, log, null)
  bot._client.write('block_place', { sequence: 0 })
  await engine.digAimed(block, 1)
  clearInterval(timer)
  const start = sent.find(p => p.status === 0); const finish = sent.find(p => p.status === 2)
  assert.ok(start && finish)
  assert.ok(finish.at - start.at >= 13, `held ${finish.at - start.at} ticks`)
  assert.ok(finish.sequence > start.sequence && start.sequence > 0)
  assert.strictEqual(engine.dig.ok, 1)
})

test('shop adds a missing item to Quick Buy: empty pane -> Search sign -> item -> amount sign', async () => {
  const inv = []; const writes = []; const order = []
  const f = n => new Array(n).fill(null)
  const quick = win([item('gray_stained_glass_pane', { customName: '{"text":"Empty - Click to choose an item to buy"}' }), ...f(36)], 1)
  const select = win([item('oak_sign', { customName: '{"text":"Search"}' }), ...f(36)], 1)
  const results = win([item('ender_pearl'), ...f(36)], 1)
  const quick2 = win([item('ender_pearl'), ...f(36)], 1)
  const bot = new EventEmitter()
  const open = w => setTimeout(() => { bot.currentWindow = w; bot.emit('windowOpen', w) }, 20)
  const sign = () => setTimeout(() => bot.emit('mhbSign', { location: { x: 1, y: 2, z: 3 }, isFrontText: true }), 20)
  Object.assign(bot, {
    entity: {}, health: 20, registry: { itemsByName: { ender_pearl: { stackSize: 16, displayName: 'Ender Pearl' } } },
    inventory: { items: () => inv, emptySlotCount: () => 20 },
    blockAt: () => null,
    _client: { write: (n, p) => { writes.push([n, p]); order.push('write'); if (p.text1 === 'Ender Pearl') open(results); else open(quick2) } },
    chat: () => open(quick),
    clickWindow: async (slot) => {
      const w = bot.currentWindow
      if (w === quick) { order.push('empty'); open(select) } else if (w === select) { order.push('search'); sign() } else if (w === results) { order.push('item'); sign() } else { order.push('buy'); inv.push({ name: 'ender_pearl', count: 16 }) }
    },
    closeWindow: () => { bot.currentWindow = null }
  })
  const shop = new Shop(bot, { shop: { commandCooldownMs: 0, clickDelayMs: [1, 2], afterOpenDelayMs: [1, 2], pages: 0 } }.shop, log)
  const got = await shop.buy('ender_pearl', 16)
  assert.strictEqual(got, 16)
  assert.deepStrictEqual(order, ['empty', 'search', 'write', 'item', 'write', 'buy'])
  assert.strictEqual(writes[0][0], 'update_sign')
  assert.strictEqual(writes[0][1].text1, 'Ender Pearl')
  assert.strictEqual(writes[1][1].text1, '16')
})
