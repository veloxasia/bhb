'use strict'
// Drops a bot into a walled pit on the local test server and checks that it gets out.
//   node tests/testbed/exit-run.js [variant=open|room|kept] [seconds=90]
const fs = require('fs'); const os = require('os'); const path = require('path')
const { spawn } = require('child_process')
const { start } = require('./server')
const { bunker } = require('./schem')
const root = path.resolve(__dirname, '..', '..')
const variant = process.argv[2] || 'open'
const walk = variant === 'ladder'; const seal = variant === 'seal'; const seconds = Number(process.argv[3] || 90)
const port = 25900 + Math.floor(Math.random() * 90)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhb-exit-'))
fs.mkdirSync(path.join(dir, 'schematics'))
fs.cpSync(path.join(root, 'src'), path.join(dir, 'src'), { recursive: true }); fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules')); fs.copyFileSync(path.join(root, 'package.json'), path.join(dir, 'package.json'))
fs.copyFileSync(path.join(root, 'config.example.json'), path.join(dir, 'config.example.json'))
bunker(path.join(dir, 'schematics', 'bunker.litematic'))
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ mode: 'test', control: { defaultSchematic: 'bunker.litematic' }, server: { host: '127.0.0.1', port, version: '1.21.4' }, human: { allowPearls: false }, fleet: { joinDelayMs: 500 }, paths: { stateDir: path.join(dir, 'state') } }))
fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [{ enabled: true, mode: 'offline', username: 'Bot1' }] }))
const lines = []
const srv = start({ port, spawn: { x: variant === 'ladder' ? 3.5 : 3.5, y: -60, z: 6.5 }, log: m => lines.push('[srv] ' + m) })
const mcData = require(path.join(root, 'node_modules', 'minecraft-data'))('1.21.4')
const id = n => mcData.blocksByName[n].defaultState
const put = (x, y, z, n) => srv.edits.set(`${x},${y},${z}`, id(n))
// pit: spawn cell (3,-60,6); walls on a ring x2..4 z5..7, height 4 (y -60..-57); variant room: ceiling too; variant kept: ring of observers on one side
if (seal) { for (let x = 9; x <= 11; x++) for (let y = -60; y <= -58; y++) for (let z = 5; z <= 7; z++) put(x, y, z, 'cobblestone'); put(10, -60, 6, 'cobblestone') }
if (!walk && !seal) for (let y = -60; y <= -57; y++) for (let x = 2; x <= 4; x++) for (let z = 5; z <= 7; z++) if (!(x === 3 && z === 6)) put(x, y, z, variant === 'obsidian' ? 'obsidian' : 'cobblestone')
if (walk) { for (let y = -60; y <= -54; y++) put(6, y, 6, 'cobblestone'); for (let x = 6; x <= 9; x++) for (let z = 4; z <= 8; z++) put(x, -54, z, 'cobblestone'); for (let y = -60; y <= -55; y++) srv.edits.set(`5,${y},6`, mcData.blocksByName.ladder.minStateId + 2 * 2 + 1) }
if (variant === 'room' || variant === 'kept') { put(3, -57, 6, 'cobblestone') }
if (variant === 'kept') for (let y = -60; y <= -59; y++) put(3, y, 7, 'observer')
srv.edits.set('3,-61,6', id('grass_block'))
if (walk) process.env.MHB_TEST_WALK = '6,-53,5'; else if (!seal) process.env.MHB_TEST_EXIT = '1'
const child = spawn(process.execPath, ['src/index.js'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, MHB_STATE_DIR: path.join(dir, 'state'), MHB_RESUME: '0', FORCE_COLOR: '0', MHB_TEST_EXIT: walk || seal ? '' : '1', MHB_TEST_WALK: walk ? '6,-53,5' : '', MHB_TEST_SEAL: seal ? '10,-60,6' : '' } })
const out = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => { lines.push(l); if (process.env.BED_VERBOSE) console.log(l.slice(0, 240)) })
child.stdout.on('data', out); child.stderr.on('data', out)
const t0 = Date.now()
const timer = setInterval(() => {
  const done = lines.some(l => /TEST-EXIT|TEST-WALK|TEST-SEAL/.test(l)) && Date.now() - t0 > 20000
  if (done || Date.now() - t0 > seconds * 1000) {
    clearInterval(timer); try { child.kill() } catch {}
    console.log(lines.filter(l => /EXIT|TEST-|TIDY|ESCAPE/.test(l)).map(l => l.slice(0, 260)).join('\n'))
    const left = []
    for (let y = -60; y <= -57; y++) for (let x = seal ? 9 : 2; x <= (seal ? 11 : 4); x++) for (let z = 5; z <= 7; z++) { const n = srv.blockNameOf(srv.stateAt(x, y, z)); if (n !== 'air') left.push(`${x},${y},${z}:${n}`) }
    console.log('blocks in the pit area at the end:', left.length, left.join(' '))
    fs.writeFileSync(path.join(dir, 'run.log'), lines.join('\n')); console.log('log:', path.join(dir, 'run.log'))
    srv.close().then(() => process.exit(0))
  }
}, 2000)
