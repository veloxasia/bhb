'use strict'
// Settings + Control Panel Server (Local, VPS, and Render Cloud compatible).
// Writes config.json (settings) and accounts.json (logins, file mode 600), starts/stops the bots,
// and provides one-click Download (.zip) and Wipe for `learned/` and `data/`.
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { DEFAULTS, deepMerge, loadConfig } = require('../core/config')
const { verifySession } = require('../core/accounts')
const { buildZipBuffer, collectFolderEntries } = require('../util/zip')
let statePaths = null
try { statePaths = require('../state/paths') } catch {}

const root = path.resolve(__dirname, '..', '..')
const configFile = path.join(root, 'config.json')
const accountsFile = path.join(root, 'accounts.json')
const learnedDir = path.join(root, 'learned')
const dataDir = path.join(root, 'data')
const token = crypto.randomBytes(18).toString('hex')
const EDITABLE = ['serverProfiles', 'server', 'control', 'shop', 'materials', 'dig', 'human', 'safety', 'teleport']

let child = null
const logs = []
let logBase = 0
const pushLog = line => { logs.push(line); if (logs.length > 1500) { logs.splice(0, 500); logBase += 500 } }

function readJson (file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }

function schematics (dir) {
  try { return fs.readdirSync(path.resolve(root, dir)).filter(f => /\.(litematic|schem|schematic|nbt)$/i.test(f)).sort() } catch { return [] }
}

function stateFolder () {
  if (process.env.MHB_STATE_DIR) return path.resolve(process.env.MHB_STATE_DIR)
  try {
    if (!statePaths) statePaths = require('../state/paths')
    return statePaths.sharedDir()
  } catch {
    return dataDir
  }
}

function folderSummary (dirPath) {
  let files = 0
  let bytes = 0
  if (!dirPath || !fs.existsSync(dirPath)) return { files, bytes }
  const walk = curr => {
    let entries = []
    try { entries = fs.readdirSync(curr, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === '.' || e.name === '..' || e.name === '.gitkeep') continue
      const full = path.join(curr, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full)
          files++
          bytes += st.size
        } catch {}
      }
    }
  }
  walk(dirPath)
  return { files, bytes }
}

function dataStats () {
  const learned = folderSummary(learnedDir)
  const localData = folderSummary(dataDir)
  const sDir = stateFolder()
  const shared = (path.resolve(sDir) !== path.resolve(dataDir)) ? folderSummary(sDir) : { files: 0, bytes: 0 }
  return {
    learnedFiles: learned.files,
    learnedBytes: learned.bytes,
    dataFiles: localData.files + shared.files,
    dataBytes: localData.bytes + shared.bytes,
    totalFiles: learned.files + localData.files + shared.files,
    totalBytes: learned.bytes + localData.bytes + shared.bytes
  }
}

function systemInfo () {
  return {
    cpus: os.cpus()?.length || 1,
    totalRamGb: +(os.totalmem() / (1024 ** 3)).toFixed(1),
    freeRamGb: +(os.freemem() / (1024 ** 3)).toFixed(1),
    platform: `${os.platform()} (${os.arch()})`,
    node: process.version,
    isRender: Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID)
  }
}

function state () {
  const cfg = loadConfig(root)
  const file = readJson(accountsFile, { accounts: [] })
  const list = (Array.isArray(file) ? file : file.accounts || []).map(a => ({
    enabled: a.enabled !== false,
    mode: a.mode || 'offline',
    username: a.username || '',
    role: a.role || 'auto',
    hasToken: Boolean(a.accessToken),
    hasPassword: Boolean(a.password)
  }))
  const settings = {}
  for (const k of EDITABLE) settings[k] = cfg[k]
  settings.mode = cfg.mode
  return {
    settings,
    accounts: list,
    schematics: schematics(cfg.paths.schematicsDir),
    running: Boolean(child),
    saved: savedJob(),
    dataStats: dataStats(),
    system: systemInfo(),
    defaults: Object.fromEntries(EDITABLE.map(k => [k, DEFAULTS[k]]))
  }
}

function save (body) {
  const current = readJson(configFile, readJson(path.join(root, 'config.example.json'), {}))
  const next = { ...current }
  for (const k of EDITABLE) if (body.settings?.[k] && typeof body.settings[k] === 'object') next[k] = deepMerge(next[k] || {}, body.settings[k])
  if (body.mode === 'test' || body.mode === 'donut') next.mode = body.mode
  fs.writeFileSync(configFile, JSON.stringify(next, null, 2) + '\n')

  const old = readJson(accountsFile, { accounts: [] })
  const oldList = Array.isArray(old) ? old : old.accounts || []
  const accounts = (body.accounts || []).map(a => {
    const prev = oldList.find(o => String(o.username || '').toLowerCase() === String(a.username || '').trim().toLowerCase()) || {}
    const mode = ['microsoft', 'session', 'offline'].includes(a.mode) ? a.mode : 'offline'
    const out = { enabled: a.enabled !== false, mode, username: String(a.username || '').trim() }
    if (a.role === 'sweeper' || a.role === 'builder') out.role = a.role
    if (mode === 'offline') { const pw = a.password ? String(a.password) : prev.password; if (pw) out.password = pw }
    if (mode === 'session') out.accessToken = a.accessToken ? String(a.accessToken).trim().replace(/^Bearer\s+/i, '') : prev.accessToken || ''
    return out
  })
  fs.writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2) + '\n', { mode: 0o600 })
  try { fs.chmodSync(accountsFile, 0o600) } catch {}
}

// the saved job the bots could continue, if any
function savedJob () {
  const dirs = [...new Set([stateFolder(), dataDir].filter(Boolean))]
  let meta = null
  for (const dir of dirs) {
    for (const fn of ['fleet-job.json', 'active-job.json']) {
      const j = readJson(path.join(dir, fn), null)
      if (j && j.file && j.origin) {
        meta = { file: path.basename(j.file), origin: j.origin, rotation: Number(j.rotation || 0), startLayer: j.startLayer ?? null }
        break
      }
    }
    if (meta) break
  }
  // Also inspect saved planner state files (*.litematic-*.json) to recover job metadata or progress counts
  let bestCompleted = 0
  let bestTotal = 0
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir).filter(f => /\.(litematic|schem|schematic|nbt)-.*\.json$/i.test(f) && !f.endsWith('.tmp'))
      for (const fn of files) {
        const parsed = readJson(path.join(dir, fn), null)
        if (!parsed || !Array.isArray(parsed.planner)) continue
        const total = parsed.planner.length
        let completed = 0
        for (const e of parsed.planner) if (e && e.status === 'completed') completed++
        if (completed >= bestCompleted && total > 0) {
          bestCompleted = completed
          bestTotal = total
          if (!meta) {
            const m = fn.match(/^(.+\.(?:litematic|schem|schematic|nbt))-(-?\d+)-(-?\d+)-(-?\d+)-(\d+)/i)
            const schemList = schematics(loadConfig(root).paths?.schematicsDir || './schematics')
            let fileName = parsed.schematic ? path.basename(parsed.schematic) : (m ? m[1] : null)
            if (fileName && !schemList.includes(fileName)) {
              const match = schemList.find(s => s.replace(/[^a-zA-Z0-9._-]+/g, '_') === fileName)
              if (match) fileName = match
            }
            const origin = parsed.origin || (m ? { x: Number(m[2]), y: Number(m[3]), z: Number(m[4]) } : null)
            const rotation = parsed.rotation != null ? Number(parsed.rotation) : (m ? Number(m[5]) : 0)
            if (fileName && origin) meta = { file: fileName, origin, rotation, startLayer: parsed.startLayer ?? null }
          }
        }
      }
    } catch {}
  }
  if (!meta) return null
  if (bestTotal > 0) {
    meta.completed = bestCompleted
    meta.total = bestTotal
  }
  return meta
}

// a fresh session: forget the saved job and its progress (placed blocks are re-checked in the world anyway)
function wipeSession () {
  for (const dir of [stateFolder(), dataDir]) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/^(active-job|fleet-job)\.json$|\.litematic-.*\.json$/.test(f)) {
          fs.rmSync(path.join(dir, f), { force: true })
        }
      }
    } catch {}
  }
}

// Wipe learned/ and/or data/ folders completely
function clearLearnedAndData (target = 'all') {
  if (child) stopBots()
  let removedCount = 0
  const clearFolder = dirPath => {
    if (!dirPath || !fs.existsSync(dirPath)) return
    let items = []
    try { items = fs.readdirSync(dirPath) } catch { return }
    for (const name of items) {
      if (name === '.' || name === '..' || name === '.gitkeep') continue
      const full = path.join(dirPath, name)
      try {
        fs.rmSync(full, { recursive: true, force: true })
        removedCount++
      } catch {}
    }
  }
  if (target === 'all' || target === 'learned') {
    clearFolder(learnedDir)
    fs.mkdirSync(learnedDir, { recursive: true })
    const sDir = stateFolder()
    if (fs.existsSync(sDir)) {
      try {
        for (const f of fs.readdirSync(sDir)) {
          if (/^(experience|learned-orientation|build-memory|universal-memory)/i.test(f)) {
            fs.rmSync(path.join(sDir, f), { force: true })
            removedCount++
          }
        }
      } catch {}
    }
  }
  if (target === 'all' || target === 'data') {
    clearFolder(dataDir)
    fs.mkdirSync(dataDir, { recursive: true })
    const sDir = stateFolder()
    if (path.resolve(sDir) !== path.resolve(dataDir)) {
      clearFolder(sDir)
      fs.mkdirSync(sDir, { recursive: true })
    }
  }
  pushLog(`[gui] cleared ${target === 'all' ? 'learned/ + data/' : target} (${removedCount} item(s) removed)`)
  return { ok: true, removedCount, dataStats: dataStats() }
}

// Builds a single .zip buffer containing learned/, data/, and shared stateFolder()
function buildLearnedAndDataZip () {
  const entries = [
    ...collectFolderEntries(learnedDir, 'learned'),
    ...collectFolderEntries(dataDir, 'data')
  ]
  const sDir = stateFolder()
  if (path.resolve(sDir) !== path.resolve(dataDir)) {
    const sharedEntries = collectFolderEntries(sDir, 'shared-data')
    const seen = new Set(entries.map(e => e.name.replace(/^data\//, '')))
    for (const se of sharedEntries) {
      const base = se.name.replace(/^shared-data\//, '')
      if (!seen.has(base)) entries.push(se)
    }
  }
  if (entries.length === 0) {
    entries.push({
      name: 'README.txt',
      data: Buffer.from('Both learned/ and data/ folders are currently empty.\n', 'utf8'),
      mtime: new Date()
    })
  }
  return buildZipBuffer(entries)
}

function startBots (fresh = false) {
  if (child) return false
  if (fresh) wipeSession()
  let totalRamMb = Math.round(os.totalmem() / 1048576)
  try { totalRamMb = require('../fleet/fleet').detectContainerRamMb() } catch {}
  const hubHeapMb = Math.max(512, Math.min(totalRamMb >= 16384 ? 4096 : (totalRamMb >= 8192 ? 2048 : 1024), Math.floor(totalRamMb * 0.75)))
  child = spawn(process.execPath, [`--max-old-space-size=${hubHeapMb}`, path.join(root, 'src', 'index.js')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', MHB_RESUME: fresh ? '0' : '1' }
  })
  const feed = chunk => String(chunk).split(/\r?\n/).filter(Boolean).forEach(pushLog)
  child.stdout.on('data', feed); child.stderr.on('data', feed)
  child.on('exit', code => { pushLog(`[gui] bots stopped (exit ${code})`); child = null })
  pushLog(fresh ? '[gui] starting bots: fresh session' : '[gui] starting bots: continuing the last session if there is one')
  return true
}

function stopBots () {
  if (!child) return false
  try { child.kill('SIGTERM') } catch {}
  return true
}

function sendCmd (line) { if (!child) return false; child.stdin.write(String(line).replace(/[\r\n]+/g, ' ') + '\n'); return true }

function readBody (req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let len = 0
    req.on('data', c => {
      len += c.length
      if (len > maxBytes) { reject(new Error('payload too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const str = Buffer.concat(chunks).toString('utf8')
        resolve(str ? JSON.parse(str) : {})
      } catch (e) { reject(e) }
    })
  })
}

function checkBasicAuth (req, res) {
  const requiredPass = String(process.env.MHB_GUI_PASSWORD || '').trim()
  if (!requiredPass) return true
  const auth = String(req.headers.authorization || '')
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8')
    const idx = decoded.indexOf(':')
    const pass = idx >= 0 ? decoded.slice(idx + 1) : decoded
    if (pass === requiredPass) return true
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="Minecraft Human Builder GUI"',
    'Content-Type': 'text/plain; charset=utf-8'
  })
  res.end('Authentication required')
  return false
}

function start (port = 0, host = process.env.MHB_GUI_HOST || '0.0.0.0') {
  const server = http.createServer(async (req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    try {
      const url = new URL(req.url, 'http://localhost')
      if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/health')) {
        return json(200, { ok: true, running: Boolean(child), system: systemInfo() })
      }
      if (!checkBasicAuth(req, res)) return

      if (req.method === 'GET' && url.pathname === '/') {
        const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('__GUI_TOKEN__', token)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(html)
      }

      if (req.method === 'GET' && url.pathname === '/api/download-data-zip') {
        const qToken = url.searchParams.get('token') || req.headers['x-gui-token']
        if (qToken !== token) return json(403, { error: 'bad token' })
        const zipBuf = buildLearnedAndDataZip()
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="mhb-learned-and-data-${stamp}.zip"`,
          'Content-Length': zipBuf.length,
          'Cache-Control': 'no-store'
        })
        return res.end(zipBuf)
      }

      if (req.headers['x-gui-token'] !== token) return json(403, { error: 'bad token' })
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, state())
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        const since = Number(url.searchParams.get('since') || 0)
        const from = Math.max(0, since - logBase)
        return json(200, { next: logBase + logs.length, lines: logs.slice(from), running: Boolean(child), dataStats: dataStats() })
      }
      if (req.method !== 'POST') return json(404, { error: 'not found' })
      const body = await readBody(req)
      if (url.pathname === '/api/save') { save(body); return json(200, { ok: true }) }
      if (url.pathname === '/api/verify') {
        let tokenValue = body.accessToken
        if (!tokenValue && Number.isInteger(body.index)) { const f = readJson(accountsFile, { accounts: [] }); tokenValue = (f.accounts || [])[body.index]?.accessToken }
        const who = await verifySession(tokenValue)
        return json(200, { name: who.name, id: who.id })
      }
      if (url.pathname === '/api/start-bots') return json(200, { ok: startBots(Boolean(body.fresh)) })
      if (url.pathname === '/api/stop-bots') return json(200, { ok: stopBots() })
      if (url.pathname === '/api/clear-data') {
        const target = ['all', 'learned', 'data'].includes(body.target) ? body.target : 'all'
        return json(200, clearLearnedAndData(target))
      }
      if (url.pathname === '/api/upload-schematic') {
        const rawName = path.basename(String(body.name || '')).trim()
        if (!rawName || !/\.(litematic|schem|schematic|nbt)$/i.test(rawName)) {
          return json(400, { error: 'Invalid schematic filename (.litematic, .schem, .schematic, .nbt)' })
        }
        const buf = Buffer.from(String(body.base64 || ''), 'base64')
        if (!buf.length) return json(400, { error: 'Empty schematic file' })
        const cfg = loadConfig(root)
        const schemDir = path.resolve(root, cfg.paths.schematicsDir || './schematics')
        fs.mkdirSync(schemDir, { recursive: true })
        fs.writeFileSync(path.join(schemDir, rawName), buf)
        pushLog(`[gui] uploaded schematic: ${rawName} (${buf.length} bytes)`)
        return json(200, { ok: true, name: rawName, schematics: schematics(cfg.paths.schematicsDir) })
      }
      if (url.pathname === '/api/cmd') {
        const c = String(body.cmd || '')
        if (!/^((build|continue)( .+)?|pause|resume|stop)$/.test(c)) return json(400, { error: 'unknown command' })
        return json(200, { ok: sendCmd(c) })
      }
      return json(404, { error: 'not found' })
    } catch (error) { json(500, { error: error.message }) }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
}

let _cliServerPromise = null
function runCli () {
  if (_cliServerPromise) return _cliServerPromise
  process.on('uncaughtException', err => {
    console.error('[gui] uncaughtException:', err)
    pushLog(`[gui] uncaughtException: ${err?.message || err}`)
  })
  process.on('unhandledRejection', err => {
    console.error('[gui] unhandledRejection:', err)
    pushLog(`[gui] unhandledRejection: ${err?.message || err}`)
  })
  const port = Number(process.env.PORT || process.env.MHB_GUI_PORT || 8765)
  const host = process.env.MHB_GUI_HOST || '0.0.0.0'
  _cliServerPromise = start(port, host).then(server => {
    const addr = server.address()
    const localUrl = `http://127.0.0.1:${addr.port}/`
    console.log(`Minecraft Human Builder GUI listening on http://${host}:${addr.port}/ (local: ${localUrl})`)
    if (!process.env.RENDER && !process.env.CI && (process.platform === 'win32' || process.platform === 'darwin')) {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', localUrl]] : ['open', [localUrl]]
      try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref() } catch {}
    }
    if (process.env.MHB_AUTOSTART_BOTS === '1' || process.env.MHB_AUTOSTART_BOTS === 'true') {
      startBots(false)
    }
    process.on('SIGINT', () => { stopBots(); process.exit(0) })
    process.on('SIGTERM', () => { stopBots(); process.exit(0) })
    process.on('exit', stopBots)
    return server
  })
  return _cliServerPromise
}

module.exports = { start, runCli, state, save, clearLearnedAndData, buildLearnedAndDataZip }

if (require.main === module) {
  runCli()
}
