'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.resolve(__dirname, '..')
const src = path.join(root, 'src')

function walk(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p))
    else if (ent.name.endsWith('.js')) out.push(p)
  }
  return out
}

const files = walk(src)
let failed = false
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(`SYNTAX ERROR: ${path.relative(root, file)}\n${result.stderr}\n`)
  } else {
    process.stdout.write(`OK syntax ${path.relative(root, file)}\n`)
  }
}

const required = [
  'src/index.js',
  'src/core/bot.js',
  'src/interaction/geometry.js',
  'src/interaction/human-interaction.js',
  'src/navigation/controller.js',
  'src/planner/build-planner.js',
  'src/recovery/recovery-manager.js',
  'src/state/persistence.js',
  'src/schematic/loader.js',
  'src/core/material-manager.js',
  'src/core/builder.js',
  'src/interaction/aim.js',
  'src/interaction/look.js',
  'src/interaction/placer.js',
  'src/rules/blocks.js',
  'src/world/ground.js',
  'src/learning/learner.js',
  'src/recovery/scaffold-manager.js'
]
for (const rel of required) {
  if (!fs.existsSync(path.join(root, rel))) {
    failed = true
    process.stderr.write(`MISSING: ${rel}\n`)
  }
}

if (failed) process.exit(1)
console.log(`Validated ${files.length} source files.`)
