'use strict'
// Offline check of the rescue movements: can the bot reach a stand inside a walled pocket without digging finished walls?
const Vec3 = require('vec3')
const { SimServer, SimBot } = require('./simbot')
const { Movements, goals } = require('mineflayer-pathfinder')
const AStar = require('mineflayer-pathfinder/lib/astar')
const Move = require('mineflayer-pathfinder/lib/move')

function setup ({ completedWalls = true, rescueConfig }) {
  const server = new SimServer({ floorY: 63, size: 2 })
  // ground y=63 (stone), air above. pocket 5x5 interior at x 10..14, z 10..14, walls 4 high, roof none
  const walls = new Set()
  for (let x = 9; x <= 15; x++) for (let z = 9; z <= 15; z++) {
    const edge = x === 9 || x === 15 || z === 9 || z === 15
    if (!edge) continue
    for (let y = 64; y <= 67; y++) { server.setBlock(new Vec3(x, y, z), 'stone_bricks'); walls.add(`${x},${y},${z}`) }
  }
  const bot = new SimBot(server, new Vec3(3.5, 64, 3.5))
  bot.blockAt = p => server.getBlock(p)
  bot.entities = {}
  bot.inventory = { items: () => [{ type: bot.registry.itemsByName.cobblestone.id, name: 'cobblestone', count: 64 }, { type: bot.registry.itemsByName.diamond_pickaxe.id, name: 'diamond_pickaxe', count: 1 }], slots: [] }
  bot.pathfinder = { bestHarvestTool: () => null }
  const m = new Movements(bot)
  m.scafoldingBlocks = [bot.registry.itemsByName.cobblestone.id]
  m.allow1by1towers = true; m.canDig = true; m.maxDropDown = 3
  rescueConfig(m, walls)
  return { server, bot, m, walls }
}

function search (bot, m, goal) {
  const p = bot.entity.position.floored()
  const a = new AStar(new Move(p.x, p.y, p.z, m.countScaffoldingItems(), 0), m, goal, 5000, 40, 200)
  let r = a.compute()
  for (let i = 0; i < 400 && r.status === 'partial'; i++) r = a.compute()
  return r
}

module.exports = { setup, search, goals, Vec3 }
if (require.main === module) {
  for (const [label, cfg] of [
    ['current (break pending forbidden, place on pending forbidden)', (m, walls) => { m.exclusionAreasBreak = [b => 0]; m.exclusionAreasPlace = [b => 0] }],
    ['never break walls', (m, walls) => { m.exclusionAreasBreak = [b => (b?.position && walls.has(`${b.position.x},${b.position.y},${b.position.z}`) ? 100 : 0)]; m.exclusionAreasPlace = [b => 0] }]
  ]) {
    const { bot, m, server } = setup({ rescueConfig: cfg })
    const r = search(bot, m, new goals.GoalNear(12, 64, 12, 1))
    console.log(label, '->', r.status, 'path', r.path.length, 'breaks', r.path.filter(n => n.toBreak?.length).length, 'places', r.path.filter(n => n.toPlace?.length).length)
    bot.dispose?.()
  }
  process.exit(0)
}
