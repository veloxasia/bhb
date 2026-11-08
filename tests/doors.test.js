'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { Vec3 } = require('../src/util/vec3')
const { NavigationController } = require('../src/navigation/controller')

test('doorAssist right-clicks a closed door in front of the bot, ignores open and iron doors', async () => {
  const blocks = new Map()
  const put = (x, y, z, name, open) => blocks.set(`${x},${y},${z}`, { name, position: new Vec3(x, y, z), getProperties: () => ({ open }) })
  put(0, 64, -1, 'oak_door', false)
  put(0, 64, -2, 'iron_door', false)
  const clicked = []
  const bot = {
    entity: { yaw: 0, position: new Vec3(0.5, 64, 0.5) },
    blockAt: p => blocks.get(`${p.x},${p.y},${p.z}`) || null,
    lookAt: async () => {},
    activateBlock: async b => { clicked.push(b.name) }
  }
  const nav = new NavigationController(bot, { navigation: {} }, { debug () {} })
  await nav.doorAssist()
  assert.deepStrictEqual(clicked, ['oak_door'])
  blocks.get('0,64,-1').getProperties = () => ({ open: true })
  nav._lastDoor = 0
  await nav.doorAssist()
  assert.deepStrictEqual(clicked, ['oak_door'])
})
