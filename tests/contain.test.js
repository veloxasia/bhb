'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('../src/util/vec3')
const { ExitManager } = require('../src/recovery/exit')

test('containStray covers a stray lava source next to the bot with a block, nearest source first', async () => {
  const cells = new Map()
  const put = (x, y, z, name, metadata = 0) => cells.set(`${x},${y},${z}`, { name, metadata, boundingBox: /^(lava|water|air)$/.test(name) ? 'empty' : 'block', position: new Vec3(x, y, z) })
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) put(x, 63, z, 'stone')
  put(2, 64, 0, 'lava', 0); put(3, 64, 0, 'lava', 2)
  const world = { blockAt: p => cells.get(`${p.x},${p.y},${p.z}`) || { name: 'air', metadata: 0, boundingBox: 'empty', position: p } }
  const placed = []
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, lookAt: async () => {}, clearControlStates () {}, health: 20 }
  const created = new Map()
  const ex = new ExitManager({
    bot, world, config: {}, logger: { warn () {}, info () {}, debug () {} },
    interaction: { sendPlace: async (ref, face) => { const c = ref.position; placed.push(c); put(c.x + face.x, c.y + face.y, c.z + face.z, 'cobblestone') } },
    scaffold: { itemName: 'cobblestone', created },
    materials: { ensureUsableItem: async () => {}, noteConsumed () {} },
    getPlanner: () => ({ fluidCells: new Map(), tasks: new Map() })
  })
  const n = await ex.containStray(4)
  assert.ok(n >= 1)
  assert.equal(world.blockAt(new Vec3(2, 64, 0)).name, 'cobblestone')
  assert.ok(created.has('2,64,0'))
})
