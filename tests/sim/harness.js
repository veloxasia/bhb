'use strict'
const os = require('os')
const fs = require('fs')
const path = require('path')
const Vec3 = require('vec3')
const { SimServer, SimBot } = require('./simbot')
const { ConstructionEngine } = require('../../src/core/builder')
const { RecoveryManager } = require('../../src/recovery/recovery-manager')
const { WorldModel } = require('../../src/core/world-model')
const { isBodyFree, isFullTop, iceStandOk } = require('../../src/world/ground')

const quiet = { info () {}, warn (...a) { if (process.env.SIMLOG) console.log('WARN', ...a) }, error (...a) { console.error(...a) }, debug (...a) { if (process.env.SIMDEBUG) console.log('DBG', ...a) } }

function makeConfig (overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhb-sim-'))
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '../../config.json'), 'utf8'))
  const cfg = {
    ...base,
    server: { ...base.server, resumeOnStart: false },
    paths: { schematicsDir: dir, stateDir: dir },
    building: { ...base.building, speed: 5000, betweenActionsMs: 0, accessRetryDelayMs: 1, maxRetriesPerAction: 4, cleanupTemporaryBlocks: true, giveUpAfterMs: 4000, ...(overrides.building || {}) },
    materials: { ...base.materials, commandDelayMs: 0, commandTimeoutMs: 800, ...(overrides.materials || {}) },
    safety: { ...base.safety, airborneToleranceMs: 2500, ...(overrides.safety || {}) },
    navigation: { ...base.navigation, useHumanController: true },
    dig: { ...(base.dig || {}), engine: 'mineflayer', settleAfterEquipMs: [1, 2] } // the sim server implements bot.dig(); the tick engine has its own unit test
  }
  return cfg
}

// navigation stand-in: teleports to validated standing cells, "human" look with small aiming error
function makeNav (bot, worldModel, opts = {}) {
  let errCount = 0
  const nav = {
    initialized: true,
    mode: 'travel',
    teleports: 0,
    async init () {},
    setConstructionContext () {},
    setToolSupplier () {}, setScaffoldSupplier () {}, setLastResort () {}, setBrain () {},
    stop () {},
    isProtectedBlock () { return false },
    async goTo (pos) {
      const cell = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
      const ok = isBodyFree(worldModel.blockAt(cell)) && isBodyFree(worldModel.blockAt(cell.offset(0, 1, 0))) && (isFullTop(worldModel.blockAt(cell.offset(0, -1, 0))) || iceStandOk(worldModel, cell))
      if (!ok) throw new Error(`sim nav: cannot stand at ${cell}`)
      if (opts.maxWalk && bot.entity.position.distanceTo(pos) > opts.maxWalk) throw new Error('sim nav: too far')
      bot.entity.position = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5)
      bot.entity.velocity = new Vec3(0, -0.0784, 0)
      bot.entity.onGround = true
      nav.teleports++
    },
    human: {
      async lookAt (point) {
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        const d = point.minus(eye)
        let yaw = Math.atan2(-d.x, -d.z)
        let pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
        const wobble = (++errCount % 5 === 0) ? 0.03 : 0.004
        yaw += (Math.random() - 0.5) * wobble; pitch += (Math.random() - 0.5) * wobble
        const q = 0.15 * Math.PI / 180
        bot.entity.yaw = Math.round(yaw / q) * q
        bot.entity.pitch = Math.round(pitch / q) * q
      }
    }
  }
  return nav
}

async function createEngine ({ start = new Vec3(0, 64, 0), serverOpts = {}, cfgOverrides = {}, navOpts = {} } = {}) {
  const server = new SimServer(serverOpts)
  const bot = new SimBot(server, new Vec3(start.x + 0.5, start.y, start.z + 0.5))
  const config = makeConfig(cfgOverrides)
  const worldModel = new WorldModel(bot)
  const nav = makeNav(bot, worldModel, navOpts)
  const engine = new ConstructionEngine(bot, config, quiet, { navigation: nav })
  // the real shop needs a server menu; the sim server simply hands the item over (the shop itself is tested in shop-dig.test.js)
  if (engine.materials) engine.materials.shop = { buy: async (name, n) => { bot.giveItem(name, n); bot.emit('inventory'); return n } }
  await engine.init()
  bot.builder = engine
  bot.recovery = new RecoveryManager(bot, nav, worldModel, config, quiet, engine.ground)
  await new Promise(r => setTimeout(r, 120))
  const dispose = () => { bot.recovery.stop(); engine.ground.dispose(); bot.dispose() }
  return { server, bot, engine, config, nav, dispose }
}

module.exports = { createEngine, makeConfig, quiet }
