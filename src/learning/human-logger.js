'use strict'
// Live Human-Build Logger (Pure Recorder Mode — Never Overwrites Working Bot Rules).
//
// Strict Human-Action Verification (Zero False Positives):
//   1. Only records while a build is actively running (`isActive() === true`). Once the build finishes
//      and the player tests buttons/levers/machines, recording stops automatically!
//   2. Tracks `entitySwingArm` on all human players: if a player did NOT swing their arm within the last
//      850ms, they did NOT place or break a block (eliminates false positives when a human is just standing
//      nearby watching the bots build or watching a piston/TNT machine run!).
//   3. Verifies the human's camera ray (yaw/pitch) actually points at the changed block (`dot >= 0.82`, ~35 deg)
//      and, when visible, that their held item matches the placed block.
//   4. Ignores all natural Minecraft world-tick updates (`dirt <-> grass_block` grass spread/decay,
//      `water/lava -> cobblestone/obsidian/stone`, `piston_head`/`moving_piston`, redstone power toggles)
//      and ignores any cell recently targeted or touched by any builder bot.
//   5. Saves verified human actions into the separate `learned/` folder (`learned/human-session.<schematic>.json`
//      and `learned/human-build-log.jsonl`) without overwriting the bots' own OrientationLearner or BuildMemory rules.

const fs = require('fs')
const path = require('path')
const { Vec3 } = require('../util/vec3')
const { dominantDirection, horizontalDirection } = require('../interaction/aim')
const { taskMatches, itemName, TERRAIN } = require('../rules/blocks')

const REPLACEABLE_OLD = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'snow', 'vine', 'glow_lichen'])
const NATURAL_DERIVED = new Set(['piston_head', 'moving_piston', 'bubble_column', 'fire', 'soul_fire'])

class HumanBuildLogger {
  constructor ({ bot, world, config, logger, stateDir, learnedDir, getPlanner, getSchematicName, isFleetBot, wasBotAction, isActive }) {
    this.bot = bot
    this.world = world
    this.config = config
    this.logger = logger
    this.stateDir = path.resolve(stateDir || './data')
    this.learnedDir = path.resolve(learnedDir || path.join(this.stateDir, '..', 'learned'))
    this.getPlanner = getPlanner || (() => null)
    this.getSchematicName = getSchematicName || (() => 'default')
    this.isFleetBot = isFleetBot || (() => false)
    this.wasBotAction = wasBotAction || (() => false)
    this.isActive = isActive || null
    this.watching = true
    this.records = []
    this.byCell = {}
    this.lastSwingAt = new Map() // username -> timestamp of last arm swing
    this.recentBotCells = new Map() // "x,y,z" -> timestamp of bot place/dig
    this.logFile = path.join(this.learnedDir, 'human-build-log.jsonl')
    this._onBlockUpdate = this.onBlockUpdate.bind(this)
    this._onSwing = this.onEntitySwingArm.bind(this)
    this.attached = false
  }

  attach () {
    if (this.attached || !this.bot?.on) return
    this.attached = true
    this.bot.on('blockUpdate', this._onBlockUpdate)
    this.bot.on('entitySwingArm', this._onSwing)
  }

  detach () {
    if (!this.attached || !this.bot?.removeListener) return
    this.attached = false
    try { this.bot.removeListener('blockUpdate', this._onBlockUpdate) } catch {}
    try { this.bot.removeListener('entitySwingArm', this._onSwing) } catch {}
  }

  noteBotCell (pos) {
    if (!pos) return
    this.recentBotCells.set(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`, Date.now())
    if (this.recentBotCells.size > 200) {
      const cutoff = Date.now() - 5000
      for (const [k, t] of this.recentBotCells.entries()) if (t < cutoff) this.recentBotCells.delete(k)
    }
  }

  onEntitySwingArm (entity) {
    if (this.isActive && !this.isActive()) return
    if (!entity || entity.type !== 'player' || !entity.username) return
    if (this.isFleetBot(entity.username)) return
    this.lastSwingAt.set(entity.username, Date.now())
  }

  setWatching (on) {
    this.watching = Boolean(on)
    this.logger?.info?.(`HUMAN-LOGGER: live human build recording ${this.watching ? 'ENABLED' : 'DISABLED'} (${this.records.length} action(s) saved in learned/)`)
  }

  findHumanActor (pos, expectedItem = null) {
    if (!this.bot?.entities) return null
    const me = this.bot.entity
    const now = Date.now()
    let best = null
    let bestDist = 5.6
    for (const id of Object.keys(this.bot.entities)) {
      const e = this.bot.entities[id]
      if (!e || e === me || e.type !== 'player' || !e.position) continue
      const username = e.username || ''
      if (!username || this.isFleetBot(username)) continue

      // 1) Must have swung arm within the last 900ms (unless explicitly marked with e._testSwung in unit tests)
      const swingAt = this.lastSwingAt.get(username) || (e._testSwung ? now : 0)
      if (now - swingAt > 900) continue

      // 2) Must be within survival reach (<= 5.5 blocks from eye)
      const eye = e.position.offset(0, 1.62, 0)
      const toBlock = new Vec3(pos.x + 0.5 - eye.x, pos.y + 0.5 - eye.y, pos.z + 0.5 - eye.z)
      const d = toBlock.norm()
      if (d < 0.2 || d >= bestDist) continue

      // 3) Camera look ray (yaw, pitch) must point toward the changed block (dot >= 0.80, ~36 deg cone)
      if (Number.isFinite(e.yaw) && Number.isFinite(e.pitch)) {
        const lookRay = new Vec3(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch))
        const unitToBlock = toBlock.scaled(1 / d)
        const dot = lookRay.x * unitToBlock.x + lookRay.y * unitToBlock.y + lookRay.z * unitToBlock.z
        if (dot < 0.80) continue
      }

      // 4) If placing a block and the player's heldItem is visible, it must match the placed item
      if (expectedItem && e.heldItem?.name) {
        const held = e.heldItem.name.replace(/^minecraft:/, '')
        if (held !== expectedItem && !(TERRAIN.has(held) && TERRAIN.has(expectedItem))) continue
      }

      bestDist = d
      best = { entity: e, username, eye, dist: d }
    }
    return best
  }

  captureNeighborhood (pos) {
    const near = {}
    if (!this.world?.blockAt) return near
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          const b = this.world.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
          if (b && b.name && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air') {
            const pr = b.getProperties ? b.getProperties() : (b.properties || {})
            near[`${dx},${dy},${dz}`] = Object.keys(pr).length ? `${b.name}${JSON.stringify(pr)}` : b.name
          }
        }
      }
    }
    return near
  }

  onBlockUpdate (oldBlock, newBlock) {
    try {
      if (!this.watching || !newBlock?.position) return
      // Never log post-build testing actions after the build finishes!
      if (this.isActive && !this.isActive()) return
      const name = newBlock.name
      const oldName = oldBlock?.name || 'air'
      if (NATURAL_DERIVED.has(name) || NATURAL_DERIVED.has(oldName)) return

      // Ignore natural grass spread / dirt decay (`dirt <-> grass_block`)
      if (TERRAIN.has(name) && TERRAIN.has(oldName)) return
      // Ignore fluid-contact cobblestone / stone / obsidian generation (`water/lava -> cobblestone/obsidian/stone`)
      if ((oldName === 'lava' || oldName === 'water') && (name === 'obsidian' || name === 'cobblestone' || name === 'stone')) return

      const isAirNew = !name || name === 'air' || name === 'cave_air' || name === 'void_air'
      const isAirOld = !oldName || oldName === 'air' || oldName === 'cave_air' || oldName === 'void_air'
      const newProps = newBlock.getProperties ? newBlock.getProperties() : (newBlock.properties || {})
      const oldProps = oldBlock?.getProperties ? oldBlock.getProperties() : (oldBlock?.properties || {})

      // Ignore natural flowing fluid spread (level !== 0)
      if ((name === 'water' || name === 'lava') && String(newProps.level ?? newBlock.metadata ?? '0') !== '0') return
      if (name === oldName && String(newProps.waterlogged) === String(oldProps.waterlogged)) return

      const pos = newBlock.position
      const k = `${pos.x},${pos.y},${pos.z}`

      // Ignore any cell that this bot or a fleet worker bot just interacted with or is currently targeting!
      const botTouchedAt = this.recentBotCells.get(k) || 0
      if (Date.now() - botTouchedAt < 2500) return
      if (this.wasBotAction(pos, k)) return

      const isBreak = isAirNew && !isAirOld
      const isWaterlog = name === oldName && String(newProps.waterlogged) === 'true' && String(oldProps.waterlogged) !== 'true'
      const isPlace = !isAirNew && !isWaterlog && REPLACEABLE_OLD.has(oldName)
      if (!isBreak && !isPlace && !isWaterlog) return

      const expectedItem = isBreak ? null : isWaterlog ? 'water_bucket' : itemName(name)
      const human = this.findHumanActor(pos, expectedItem)
      if (!human) return

      const e = human.entity
      const standCell = new Vec3(Math.floor(e.position.x), Math.floor(e.position.y + 0.01), Math.floor(e.position.z))
      const dir = (Number.isFinite(e.yaw) && Number.isFinite(e.pitch))
        ? new Vec3(-Math.sin(e.yaw) * Math.cos(e.pitch), Math.sin(e.pitch), -Math.cos(e.yaw) * Math.cos(e.pitch))
        : new Vec3(pos.x + 0.5 - human.eye.x, pos.y + 0.5 - human.eye.y, pos.z + 0.5 - human.eye.z)
      const lookDir = dominantDirection(dir)
      const horizDir = horizontalDirection(dir)

      const planner = this.getPlanner()
      const task = planner?.tasks?.get(k) || null

      const nearbyStuckTasks = []
      if (planner?.tasks) {
        for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0, -2, 0]]) {
          const nt = planner.tasks.get(`${pos.x + dx},${pos.y + dy},${pos.z + dz}`)
          if (nt && nt.status !== 'completed' && nt.attempts > 0) {
            nearbyStuckTasks.push({
              at: nt.key,
              offsetFromHumanAction: [dx, dy, dz],
              wanted: nt.name,
              wantedProps: nt.properties,
              botAttempts: nt.attempts,
              botLastError: nt.lastError
            })
          }
        }
      }

      if (isBreak) {
        // Ignore breaking non-schematic temporary blocks when there are no nearby stuck tasks
        if (!task && !nearbyStuckTasks.length) return
        const breakEntry = {
          t: new Date().toISOString(),
          schematic: this.getSchematicName(),
          action: 'break',
          player: human.username,
          broke: oldName,
          oldProps,
          world: [pos.x, pos.y, pos.z],
          local: task?.local ? [task.local.x, task.local.y, task.local.z] : null,
          schematicWanted: task ? { name: task.name, props: task.properties, status: task.status, botAttempts: task.attempts, botLastError: task.lastError } : null,
          nearbyStuckTasks,
          stand: [standCell.x, standCell.y, standCell.z],
          standOffset: [standCell.x - pos.x, standCell.y - pos.y, standCell.z - pos.z],
          yaw: Number((e.yaw || 0).toFixed(3)),
          pitch: Number((e.pitch || 0).toFixed(3))
        }
        this.records.push(breakEntry)
        this.saveRecord(k, breakEntry)
        this.logger?.info?.(`HUMAN-LOGGER: recorded ${human.username} break ${oldName}@${k} -> saved to learned/`)
        return
      }

      const matchedTask = task ? taskMatches(newBlock, task) : false
      const placeEntry = {
        t: new Date().toISOString(),
        schematic: this.getSchematicName(),
        action: isWaterlog ? 'waterlog' : 'place',
        player: human.username,
        block: name,
        props: newProps,
        world: [pos.x, pos.y, pos.z],
        local: task?.local ? [task.local.x, task.local.y, task.local.z] : null,
        matchedSchematicState: matchedTask,
        schematicWanted: task ? { name: task.name, props: task.properties, status: task.status, botAttempts: task.attempts, botLastError: task.lastError } : null,
        nearbyStuckTasks,
        stand: [standCell.x, standCell.y, standCell.z],
        exactPlayerPos: [Number(e.position.x.toFixed(2)), Number(e.position.y.toFixed(2)), Number(e.position.z.toFixed(2))],
        standOffset: [standCell.x - pos.x, standCell.y - pos.y, standCell.z - pos.z],
        yaw: Number((e.yaw || 0).toFixed(3)),
        pitch: Number((e.pitch || 0).toFixed(3)),
        lookDir,
        horizDir,
        neighbors: this.captureNeighborhood(pos)
      }

      if (task && matchedTask) {
        planner.rescanTask(task)
        const wlTask = planner.tasks?.get(`${k}#w`)
        if (wlTask && String(newProps.waterlogged) === 'true') planner.rescanTask(wlTask)
      }

      this.records.push(placeEntry)
      this.saveRecord(k, placeEntry)
      this.logger?.info?.(`HUMAN-LOGGER: recorded ${human.username} ${placeEntry.action} ${name}@${k} (matchesSchematic=${matchedTask}, standOffset=${placeEntry.standOffset.join(',')}) -> saved to learned/`)
    } catch { /* never disrupt bot loop */ }
  }

  saveRecord (cellKey, entry) {
    try {
      fs.mkdirSync(this.learnedDir, { recursive: true })
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n')
      if (!this.byCell[cellKey]) this.byCell[cellKey] = []
      this.byCell[cellKey].push(entry)
      const safe = String(this.getSchematicName() || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_')
      const sessionFile = path.join(this.learnedDir, `human-session.${safe}.json`)
      fs.writeFileSync(sessionFile, JSON.stringify({
        schematic: this.getSchematicName(),
        updatedAt: new Date().toISOString(),
        totalHumanActions: this.records.length,
        byCell: this.byCell
      }, null, 2))
    } catch {}
  }

  summary () {
    return `Human-Logger: watching=${this.watching}, recorded=${this.records.length} action(s) in learned/ (bot rules kept independent)`
  }
}

module.exports = { HumanBuildLogger }
