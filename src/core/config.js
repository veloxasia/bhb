'use strict'
// One place that reads config.json (settings) and accounts.json (logins) and applies the "real server" rules.
// Nothing about a server or a player name is hardcoded: the GUI (npm run gui / gui.bat) writes both files.
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  server: { host: '', port: 25565, version: '', autoReconnect: true, reconnectDelayMs: 15000, resumeOnStart: false },
  control: { allowedUsers: [], chatPrefix: '!', chatCommands: false, announceInChat: false, defaultSchematic: '', defaultRotation: 0 },
  mode: 'donut', // 'donut' = real server (shop, strict rules) | 'test' = own/Aternos server (/give, cracked)
  serverProfiles: {}, // remembered address per mode: { test: {host, port}, donut: {host, port} }
  shop: {
    enabled: true,
    command: '/shop',
    openTimeoutMs: 7000,
    commandCooldownMs: 5000,
    clickDelayMs: [450, 1100],
    afterOpenDelayMs: [500, 1100],
    maxClicksPerVisit: 36,
    stacksPerVisit: 3,
    pages: 4,
    nextPageMatch: 'next|siguiente|>>|»|›|→',
    notSoldRetryMs: 600000,
    autoAdd: true,
    addAmount: null,
    items: {}
  },
  materials: { toolItems: ['diamond_pickaxe', 'diamond_axe', 'diamond_shovel'], foodItem: 'cooked_beef', autoBreakObstructions: true, neverBreakContainers: true },
  teleport: {
    enabled: true, homes: true, tpa: true, maxHomes: 3,
    commands: { sethome: '/sethome', home: '/home', delhome: '/delhome', tpa: '/tpa', tpaccept: '/tpaccept' },
    minFailures: 3, minStuckMs: 45000, cooldownMs: 60000, assistRadius: 12, homeSpacing: 30, homeSetGapMs: 480000, farFromSiteBlocks: 70, warmupMs: 14000, tpaWaitMs: 30000, commandGapMs: 4500
  },
  building: {
    ignoreBlocks: ['bedrock', 'barrier', 'light', 'structure_void', 'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw', 'end_portal', 'end_portal_frame', 'end_gateway', 'nether_portal', 'reinforced_deepslate'],
    substitutes: {
      grass_block: ['dirt', 'cobblestone'], dirt_path: ['dirt', 'cobblestone'], farmland: ['dirt', 'cobblestone'], podzol: ['dirt', 'cobblestone'],
      mycelium: ['dirt', 'cobblestone'], coarse_dirt: ['dirt', 'cobblestone'], rooted_dirt: ['dirt', 'cobblestone'], moss_block: ['dirt', 'cobblestone'], mud: ['dirt', 'cobblestone'],
      dirt: ['cobblestone'], crimson_nylium: ['netherrack', 'cobblestone'], warped_nylium: ['netherrack', 'cobblestone']
    }
  },
  wire: { tickEnd: true, ignoreSignEditor: true, blockModChannels: true },
  dig: { engine: 'ticks', marginTicks: [0, 1], marginMs: [10, 25], swingEveryTicks: 3, rejectLimit: 3, protectedCooldownMs: 90000, settleAfterEquipMs: [5, 15] },
  human: {
    strict: true,
    pace: 'max',
    allowPearls: true,
    placeIntervalMs: [15, 28],
    betweenActionsMs: [0, 4],
    microPauseEveryActions: [999999, 999999],
    microPauseMs: [0, 0]
  },
  fleet: { joinDelayMs: 6000, minGap: 2.6, viewDistance: 6, mode: 'auto', deadAfterMs: 90000, lookAheadOrders: 12, maxBlockingSearchMs: 800, enableSweeperBot: true }
}

function isObj (v) { return v && typeof v === 'object' && !Array.isArray(v) }
function deepMerge (base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base }
  for (const [k, v] of Object.entries(over || {})) out[k] = isObj(v) && isObj(base?.[k]) ? deepMerge(base[k], v) : v
  return out
}

const PACE = {
  careful: { placeIntervalMs: [35, 55], betweenActionsMs: [0, 8], microPauseEveryActions: [999999, 999999], microPauseMs: [0, 0], perSec: 18.0, pauseScale: 0.03, aimScale: 0.05 },
  fast: { placeIntervalMs: [20, 35], betweenActionsMs: [0, 5], microPauseEveryActions: [999999, 999999], microPauseMs: [0, 0], perSec: 20.0, pauseScale: 0.02, aimScale: 0.04 },
  max: { placeIntervalMs: [15, 28], betweenActionsMs: [0, 4], microPauseEveryActions: [999999, 999999], microPauseMs: [0, 0], perSec: 20.0, pauseScale: 0.01, aimScale: 0.03 }
}

function applyRealServerRules (cfg) {
  const h = cfg.human || {}
  cfg.navigation = cfg.navigation || {}
  cfg.building = cfg.building || {}
  cfg.safety = cfg.safety || {}
  cfg.materials = cfg.materials || {}
  cfg.motion = cfg.motion || {}
  const pace = PACE[h.pace] || PACE.max
  cfg.human = { ...h, pace: PACE[h.pace] ? h.pace : 'max', placeIntervalMs: pace.placeIntervalMs, betweenActionsMs: pace.betweenActionsMs, microPauseEveryActions: pace.microPauseEveryActions, microPauseMs: pace.microPauseMs, pauseScale: pace.pauseScale, aimScale: pace.aimScale }
  cfg.building.maxPlacementsPerSecond = pace.perSec
  cfg.fleet.perBotPlacementsPerSecond = pace.perSec
  cfg.fleet.minGap = Math.min(Number(cfg.fleet.minGap || 2.6), 2.8)
  if (h.strict !== false) {
    cfg.navigation.pearls = h.allowPearls !== false
    cfg.navigation.parkour = false
    cfg.safety.healCommand = ''
    cfg.building.speed = 1
    cfg.building.maxPlacementsPerSecond = Math.min(cfg.building.maxPlacementsPerSecond, 20.0)
    cfg.fleet.perBotPlacementsPerSecond = Math.min(cfg.fleet.perBotPlacementsPerSecond, 20.0)
    cfg.navigation.placementReach = Math.min(Number(cfg.navigation.placementReach || 4.4), 4.4)
    cfg.motion.enabled = true
    cfg.motion.maxSpeedPerTick = 0.56
    cfg.motion.maxYawDegPerTick = Math.max(Number(cfg.motion.maxYawDegPerTick || 75), 75)
    cfg.motion.maxPitchDegPerTick = Math.max(Number(cfg.motion.maxPitchDegPerTick || 55), 55)
    cfg.motion.minKeyHoldMs = 0
    if (cfg.navigation.personality) {
      cfg.navigation.personality.reaction = Math.min(Number(cfg.navigation.personality.reaction ?? 0.005), 0.01)
      cfg.navigation.personality.turnTime = Math.min(Number(cfg.navigation.personality.turnTime ?? 0.06), 0.08)
      cfg.navigation.personality.sprintDelay = 0
    }
    cfg.materials.autoGive = false
    cfg.materials.autoGiveTools = false
    cfg.materials.serverAuthoritativeInventory = false
    cfg.control.announceInChat = Boolean(cfg.control.announceInChat)
  }
  cfg.shop = cfg.shop || {}
  cfg.teleport = cfg.teleport || {}
  if (cfg.mode === 'test') {
    cfg.materials.autoGive = true
    cfg.materials.autoGiveTools = true
    cfg.shop.enabled = false
    cfg.teleport.enabled = false
  } else {
    cfg.mode = 'donut'
    cfg.materials.autoGive = false
    cfg.shop.enabled = cfg.shop.enabled !== false
  }
  return cfg
}

function loadAccounts (root) {
  const file = path.join(root, 'accounts.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : raw.accounts
    return (list || []).filter(a => a && a.enabled !== false)
  } catch { return [] }
}

function loadConfig (root) {
  const file = path.join(root, 'config.json')
  let user = {}
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'))
  else {
    const example = path.join(root, 'config.example.json')
    if (fs.existsSync(example)) user = JSON.parse(fs.readFileSync(example, 'utf8'))
  }
  const cfg = deepMerge(deepMerge(DEFAULTS, require('./legacy-defaults')), user)
  if (process.env.MHB_RESUME === '1' || process.env.MHB_RESUME === '0') cfg.server.resumeOnStart = process.env.MHB_RESUME === '1'
  cfg.accounts = loadAccounts(root)
  cfg.fleet.workers = Math.max(1, cfg.accounts.length)
  return applyRealServerRules(cfg)
}

function problems (cfg) {
  const out = []
  if (!cfg.server.host) out.push('Server address is empty (set it in the GUI).')
  if (!(Number(cfg.server.port) > 0)) out.push('Server port is invalid.')
  if (!cfg.accounts.length) out.push('No account added (add at least one in the GUI).')
  const names = new Set()
  for (const [i, a] of cfg.accounts.entries()) {
    const name = String(a.username || '').trim()
    if (!name) out.push(`Account ${i + 1}: username is empty.`)
    if (names.has(name.toLowerCase())) out.push(`Account ${i + 1}: duplicate username ${name}.`)
    names.add(name.toLowerCase())
    if (a.mode === 'session' && !String(a.accessToken || '').trim()) out.push(`Account ${i + 1} (${name}): session token is empty.`)
  }
  if (!cfg.control.defaultSchematic) out.push('No schematic selected (pick one in the GUI).')
  return out
}

module.exports = { DEFAULTS, deepMerge, loadConfig, loadAccounts, applyRealServerRules, problems }
