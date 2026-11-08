'use strict'
// Plan a schematic offline (no server): node scripts/architect.js <schematic> [x y z rot] [version]
// Prints the architect's report and writes data/<name>.plan.json
const path = require('path')
const fs = require('fs')
const file = process.argv[2]
if (!file) { console.error('usage: node scripts/architect.js <schematic> [x y z rot] [version]'); process.exit(1) }
const [x, y, z, rot] = [3, 4, 5, 6].map(i => Number(process.argv[i] || 0))
const version = process.argv[7] || '1.21.1'
const registry = require('prismarine-registry')(version)
const { loadSchematic, buildTransform } = require('../src/schematic/loader')
const { BuildPlanner } = require('../src/planner/build-planner')
const { plan } = require('../src/planner/architect')
const { Vec3 } = require('../src/util/vec3')
;(async () => {
  const bot = { registry, version }
  const loaded = await loadSchematic(path.resolve(file), bot)
  const world = { bot, blockAt: () => null }
  const cfg = fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json', 'utf8')) : { building: {} }
  const planner = new BuildPlanner(loaded, buildTransform(loaded.schematic, new Vec3(x, y || 64, z), rot), world, cfg, { info () {}, warn () {}, debug () {} }).build()
  const { report } = plan(planner, { start: { x, z } })
  console.log(`${report.tasks} blocks | ${report.layers} layer steps | ${report.pieces} separate pieces | ~${report.walkBlocks} blocks of walking | ~${report.estimatedMinutes} min`)
  console.log(`blocks needing scaffold/reference: ${report.floating} | plant/soil problems: ${report.soilProblems}`)
  for (const w of report.warnings) console.log('WARNING:', w)
  console.log('materials:', report.materials.slice(0, 15).map(([k, v]) => `${v} ${k}`).join(', '))
  fs.mkdirSync('data', { recursive: true })
  const out = path.join('data', `${path.basename(file).replace(/\.[^.]+$/, '')}.plan.json`)
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('written', out)
})().catch(e => { console.error(e); process.exit(1) })
