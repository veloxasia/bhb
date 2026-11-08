'use strict'
// Full-bot run against the local test server:  node tests/testbed/run.js [bots=1] [seconds=300] [schematic=bunker] [originZ=10]
// Prints progress (blocks of the schematic that are really in the world) and the bot log lines that matter.
const fs = require('fs'); const os = require('os'); const path = require('path')
const { spawn } = require('child_process')
const { start } = require('./server')
const { bunker } = require('./schem')
const root = path.resolve(__dirname, '..', '..')

async function main () {
  const bots = Number(process.argv[2] || 1); const seconds = Number(process.argv[3] || 300)
  const port = 25600 + Math.floor(Math.random() * 300)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhb-bed-'))
  fs.mkdirSync(path.join(dir, 'schematics'))
  fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true }); fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules')); fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'))
  fs.copyFileSync(path.join(root, 'config.example.json'), path.join(dir, 'config.example.json'))
  const file = process.argv[4] && fs.existsSync(process.argv[4]) ? process.argv[4] : null
  const name = file ? path.basename(file) : 'bunker.litematic'
  if (file) fs.copyFileSync(file, path.join(dir, 'schematics', name)); else bunker(path.join(dir, 'schematics', name))
  const origin = { x: 6, y: -60, z: Number(process.argv[5] || 12) }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'test', server: { host: '127.0.0.1', port, version: '1.21.4' }, control: { defaultSchematic: name }, human: { allowPearls: false }, fleet: { joinDelayMs: 1500 }, paths: { stateDir: path.join(dir, 'state') } }))
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: Array.from({ length: bots }, (_, i) => ({ enabled: true, mode: 'offline', username: 'Bot' + (i + 1) })) }))
  const lines = []
  const srv = start({ port, spawn: { x: 3, y: -60, z: 6 }, log: m => lines.push('[srv] ' + m) })
  const reg = require(path.join(root, 'node_modules', 'prismarine-registry'))('1.21.4')
  const { parseLitematicBuffer } = require(path.join(root, 'src', 'schematic', 'litematic'))
  const sch = parseLitematicBuffer(fs.readFileSync(path.join(dir, 'schematics', name)), reg)
  const want = []
  const s0 = sch.start()
  for (const [k, b] of sch.blocks) { const [x, y, z] = k.split(',').map(Number); if (!b.isAir && b.name !== 'air') want.push([origin.x + x - s0.x, origin.y + y - s0.y, origin.z + z - s0.z, b.name]) }
  const progress = () => { let ok = 0; for (const [x, y, z, n] of want) if (srv.blockNameOf(srv.stateAt(x, y, z)) === n) ok++; return ok }
  const child = spawn(process.execPath, ['src/index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MHB_STATE_DIR: path.join(dir, 'state'), MHB_RESUME: '0', FORCE_COLOR: '0' } })
  const out = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => { lines.push(l); if (process.env.BED_VERBOSE) console.log(l.slice(0, 220)) })
  child.stdout.on('data', out); child.stderr.on('data', out)
  const t0 = Date.now()
  setTimeout(() => child.stdin.write(`build ${name} ${origin.x} ${origin.y} ${origin.z} 0\n`), 6000 + bots * 2500)
  let last = -1; let lastChange = Date.now()
  const timer = setInterval(() => {
    const ok = progress()
    if (ok !== last) { last = ok; lastChange = Date.now() }
    console.log(`t=${Math.round((Date.now() - t0) / 1000)}s placed=${srv.stats.placed} broken=${srv.stats.broken} correct=${ok}/${want.length} idle=${Math.round((Date.now() - lastChange) / 1000)}s`)
    const over = Date.now() - t0 > seconds * 1000
    const finished = !process.env.BED_WAIT_COMPLETE || lines.some(l => /BUILD COMPLETE|FINISHED WITH ISSUES/.test(l))
    if ((ok >= want.length && finished) || over) finish(ok)
  }, 10000)
  let done = false
  function finish (ok) {
    if (done) return; done = true; clearInterval(timer)
    try { child.kill() } catch {}
    const wrong = want.filter(([x, y, z, n]) => srv.blockNameOf(srv.stateAt(x, y, z)) !== n)
    const byLevel = {}; for (const [x, y, z] of wrong) byLevel[y] = (byLevel[y] || 0) + 1
    console.log(`RESULT correct=${ok}/${want.length} placed=${srv.stats.placed} broken=${srv.stats.broken} gives=${srv.stats.gives} secs=${Math.round((Date.now() - t0) / 1000)}`)
    console.log('missing by y:', JSON.stringify(byLevel))
    const kinds = {}
    for (const l of lines) { const m = /\[(WARN|ERROR)\] (.*)/.exec(l); if (m) { const k = m[2].replace(/-?\d+(\.\d+)?/g, 'N').slice(0, 100); kinds[k] = (kinds[k] || 0) + 1 } }
    console.log('warnings:'); Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([k, n]) => console.log(' ', n, k))
    fs.writeFileSync(path.join(dir, 'run.log'), lines.join('\n')); console.log('log:', path.join(dir, 'run.log'))
    srv.close().then(() => process.exit(0))
  }
}
main()
