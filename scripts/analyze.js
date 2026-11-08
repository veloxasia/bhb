'use strict'
// Deep offline analysis of a schematic for a fleet of builders (no server needed):
//   node scripts/analyze.js <schematic> [workers=4] [version=1.21.1]
// Writes data/<name>.analysis.md and data/<name>.analysis.json
const path = require('path')
const fs = require('fs')
const file = process.argv[2]
if (!file) { console.error('usage: node scripts/analyze.js <schematic> [workers] [version]'); process.exit(1) }
const workers = Math.max(1, Number(process.argv[3] || 4))
const version = process.argv[4] || '1.21.1'
const registry = require('prismarine-registry')(version)
const { loadSchematic, buildTransform } = require('../src/schematic/loader')
const { BuildPlanner } = require('../src/planner/build-planner')
const { plan } = require('../src/planner/architect')
const { buildAnalysis } = require('../src/planner/analysis')
const { Vec3 } = require('../src/util/vec3')

;(async () => {
  const loaded = await loadSchematic(path.resolve(file), { registry, version })
  const cfg = fs.existsSync('config.json') ? JSON.parse(fs.readFileSync('config.json', 'utf8')) : { building: {} }
  const planner = new BuildPlanner(loaded, buildTransform(loaded.schematic, new Vec3(0, 64, 0), 0), { bot: { registry, version }, blockAt: () => null }, cfg, { info () {}, warn () {}, debug () {} }).build()
  const { sequence, report } = plan(planner, { start: { x: 0, z: 0 } })
  const name = path.basename(file).replace(/\.[^.]+$/, '')
  const { out, markdown } = buildAnalysis(planner, sequence, report, { workers, name: path.basename(file), config: cfg, registry })
  fs.mkdirSync('data', { recursive: true })
  fs.writeFileSync(path.join('data', `${name}.analysis.json`), JSON.stringify(out, null, 2))
  fs.writeFileSync(path.join('data', `${name}.analysis.md`), markdown)
  console.log(markdown.split('\n').slice(0, 22).join('\n'))
  console.log('written', path.join('data', `${name}.analysis.md`))
})().catch(e => { console.error(e); process.exit(1) })
