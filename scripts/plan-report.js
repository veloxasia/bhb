'use strict'
// Offline dry run: reads a schematic and prints what the builder will do. No server needed.
//   node scripts/plan-report.js "schematics/McDs 64 Module Cobblestone Wall Farm.litematic" [mcVersion]
const path = require('path')
const fs = require('fs')
const registry = require('prismarine-registry')(process.argv[3] || '1.21.1')
const { loadSchematic, buildTransform } = require('../src/schematic/loader')
const { BuildPlanner } = require('../src/planner/build-planner')
const { Vec3 } = require('../src/util/vec3')

async function main () {
  const file = process.argv[2]
  if (!file) { console.error('usage: node scripts/plan-report.js <schematic> [version]'); process.exit(1) }
  const fakeBot = { registry, version: process.argv[3] || '1.21.1' }
  const loaded = await loadSchematic(path.resolve(file), fakeBot)
  const world = { bot: fakeBot, blockAt: () => null }
  const config = { building: { maxRetriesPerAction: 8 } }
  const planner = new BuildPlanner(loaded, buildTransform(loaded.schematic, new Vec3(0, 64, 0), 0), world, config, { info () {}, warn () {}, debug () {} }).build()
  const c = planner.census
  console.log(`size ${loaded.schematic.size.x}x${loaded.schematic.size.y}x${loaded.schematic.size.z}`)
  console.log(`tasks ${planner.total}  (by kind ${JSON.stringify(c.byKind)})`)
  console.log(`skipped air ${c.skippedAir}, filled by the game itself ${c.derived}, unsupported ${c.unsupported.length}`)
  console.log(`placements that need the camera to look UP ${c.lookUp}`)
  console.log(`by phase ${JSON.stringify(c.byPhase)}`)
  console.log('\nmaterials needed:')
  const rows = [...planner.getMaterialDemand().entries()].sort((a, b) => b[1] - a[1])
  for (const [item, n] of rows) console.log(`  ${String(n).padStart(6)}  ${item}${registry.itemsByName[item] ? '' : '   <-- UNKNOWN ITEM'}`)
  if (c.unsupported.length) { console.log('\nUNSUPPORTED:'); for (const u of c.unsupported) console.log(' ', u.name, JSON.stringify(u.props), u.note || '') }
  const signs = [...planner.tasks.values()].filter(t => t.tile?.hasText).length
  console.log(`\nsigns with text: ${signs}`)
  if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(rows))
}
main().catch(e => { console.error(e); process.exit(1) })
