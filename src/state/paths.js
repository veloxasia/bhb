'use strict'
// One state folder for every version of the bot. The saved job, per-worker learning and logs used to live in
// <this version's folder>/data, so unzipping a new version silently started from nothing. Now the default is
// <home>/MinecraftHumanBuilder-data, and files from the old local ./data and from sibling version folders
// (../minecraft-human-builder-v*/mhb/data) are copied in once (never overwriting).
const fs = require('fs')
const os = require('os')
const path = require('path')

const KEEP = /^(active-job\.json|fleet-job\.json|experience.*\.json|learned-orientation.*\.json|.*\.litematic-.*\.json|.*-\d+--?\d+-\d+-\d+.*\.json)$/

function sharedDir () {
  return process.env.MHB_STATE_DIR ? path.resolve(process.env.MHB_STATE_DIR) : path.join(os.homedir(), 'MinecraftHumanBuilder-data')
}

function copyMissing (from, to, log) {
  let n = 0
  let names = []
  try { names = fs.readdirSync(from) } catch { return 0 }
  for (const name of names) {
    if (!KEEP.test(name)) continue
    const dst = path.join(to, name)
    if (fs.existsSync(dst)) continue
    try { fs.copyFileSync(path.join(from, name), dst); n++ } catch (e) { log?.(`state: could not copy ${name}: ${e.message}`) }
  }
  return n
}

// returns the absolute state dir and rewrites config.paths.stateDir to it
function prepareState (root, config, log) {
  const configured = config.paths?.stateDir || './data'
  const useShared = (configured === './data' || configured === 'data') && config.paths?.sharedState !== false
  const dir = useShared ? sharedDir() : path.resolve(root, configured)
  fs.mkdirSync(dir, { recursive: true })
  let copied = 0
  const sources = [path.resolve(root, 'data')]
  try {
    const parent = path.dirname(root) // .../minecraft-human-builder-vX/mhb -> .../minecraft-human-builder-vX
    const grand = path.dirname(parent)
    for (const name of fs.readdirSync(grand)) {
      if (!/minecraft-human-builder|mhb/i.test(name)) continue
      for (const cand of [path.join(grand, name, 'mhb', 'data'), path.join(grand, name, 'data')]) sources.push(cand)
    }
  } catch { /* no siblings */ }
  // newest source first, so the freshest active job wins
  const dated = sources.filter(s => s !== dir && fs.existsSync(s)).map(s => {
    let t = 0
    try { t = Math.max(0, ...fs.readdirSync(s).map(f => fs.statSync(path.join(s, f)).mtimeMs)) } catch {}
    return { s, t }
  }).sort((a, b) => b.t - a.t)
  for (const { s } of dated) copied += copyMissing(s, dir, log)
  if (copied) log?.(`state: copied ${copied} saved file(s) from earlier versions into ${dir}`)
  config.paths.stateDir = dir
  return dir
}

// the saved path may point into an older version's folder: fall back to the same file name in schematics/
function resolveSchematicFile (file, schematicsDir) {
  if (fs.existsSync(file)) return file
  const base = String(file).split(/[\\/]/).pop()
  const alt = path.join(schematicsDir, base)
  return fs.existsSync(alt) ? alt : file
}

module.exports = { prepareState, resolveSchematicFile, sharedDir }
