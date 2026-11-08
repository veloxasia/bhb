'use strict'
// Auto-Dependency & Render / Cloud VPS Launcher.
// 1. Automatically installs npm dependencies (`node_modules`) if missing (on local/VPS machines).
// 2. Initializes `config.json`, `accounts.json`, `data/`, `learned/`, and `schematics/`.
// 3. Starts the Web GUI Control Panel on `0.0.0.0:$PORT` (default 8765 locally, or Render's $PORT)
//    and keeps the HTTP server process alive.

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const root = __dirname

function ensureDependencies () {
  if (process.env.RENDER || process.env.CI || process.env.SKIP_AUTO_DEPS) return
  try {
    require.resolve('mineflayer')
    return
  } catch {}
  if (fs.existsSync(path.join(root, 'node_modules', 'mineflayer'))) return
  try {
    console.log('[boot] node_modules not found — automatically installing dependencies via npm...')
    execSync('npm install --no-audit --no-fund', { cwd: root, stdio: 'inherit', timeout: 120000 })
    console.log('[boot] Dependencies installed successfully.')
  } catch (err) {
    console.warn('[boot] Auto dependency install warning:', err.message)
  }
}

function ensureFilesAndFolders () {
  for (const dir of ['data', 'learned', 'schematics']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true })
  }
  const cfgPath = path.join(root, 'config.json')
  const cfgExample = path.join(root, 'config.example.json')
  if (!fs.existsSync(cfgPath) && fs.existsSync(cfgExample)) {
    fs.copyFileSync(cfgExample, cfgPath)
  }
  const accPath = path.join(root, 'accounts.json')
  const accExample = path.join(root, 'accounts.example.json')
  if (!fs.existsSync(accPath) && fs.existsSync(accExample)) {
    fs.copyFileSync(accExample, accPath)
  }
  if (!process.env.MHB_STATE_DIR) {
    process.env.MHB_STATE_DIR = path.join(root, 'data')
  }
}

ensureDependencies()
ensureFilesAndFolders()

const { runCli } = require('./src/gui/server.js')
runCli().catch(err => {
  console.error('[boot] Failed to start GUI server:', err)
  process.exit(1)
})
