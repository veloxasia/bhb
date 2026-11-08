'use strict'

const fs = require('fs')
const path = require('path')
const cp = require('child_process')
const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const { loadConfig, problems } = require('../src/core/config')
const config = loadConfig(root)

const major = Number(process.versions.node.split('.')[0])
if (major < 22) throw new Error(`Node 22+ required; found ${process.version}`)
for (const issue of problems(config)) console.warn('TODO (GUI): ' + issue)
for (const dir of [config.paths.schematicsDir, config.paths.stateDir]) fs.mkdirSync(path.resolve(root, dir), { recursive: true })

const required = Object.keys(pkg.dependencies)
for (const dep of required) {
  try { require.resolve(dep) } catch { throw new Error(`Missing npm dependency: ${dep}. Run npm install.`) }
}

console.log(`Node ${process.version}: OK`)
console.log(`Mineflayer ${require('mineflayer/package.json').version}: OK`)
try { console.log(`Protocol stack minecraft-protocol=${require('minecraft-protocol/package.json').version} protodef=${require('protodef/package.json').version}`) } catch { console.log('Protocol stack version diagnostic unavailable') }
console.log(`Schematics dir ${path.resolve(root, config.paths.schematicsDir)}: OK`)
console.log(`State dir ${path.resolve(root, config.paths.stateDir)}: OK`)
cp.execFileSync(process.execPath, [path.join(root, 'scripts', 'validate.js')], { stdio: 'inherit' })
console.log('Preflight OK.')
