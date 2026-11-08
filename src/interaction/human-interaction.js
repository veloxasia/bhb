'use strict'
// Low-level, single-action primitives. Every one of them assumes the caller has ALREADY physically
// aimed at the target (see look.js) and validated the view (aim.js).
// Includes active anti-current tracking during digByTicks so flowing water never causes blind digging from afar.

const { Vec3, toVec3 } = require('../util/vec3')
const { waitFor, sleep, withTimeout } = require('../util/async')
const { runStore } = require('../util/abort')
const { rayHitBox } = require('./geometry')
const { boxOf } = require('./aim')

const SPECIAL_ITEM_MAP = Object.freeze({ water: 'water_bucket', lava: 'lava_bucket' })

const TOOL_SPEEDS = Object.freeze({
  wooden: 2,
  stone: 4,
  iron: 6,
  diamond: 8,
  netherite: 9,
  golden: 12
})

const PICKAXE_BLOCK = /(obsidian|ancient_debris|netherite_block|crying_obsidian|respawn_anchor|stone|cobblestone|deepslate|blackstone|basalt|netherrack|granite|diorite|andesite|tuff|calcite|dripstone|brick|terracotta|concrete|quartz|prismarine|purpur|end_stone|sandstone|ore|coal_block|iron_block|gold_block|diamond_block|emerald_block|lapis_block|redstone_block|copper|amethyst|furnace|smoker|blast_furnace|dispenser|dropper|observer|piston|hopper|cauldron|anvil|rail|chain|lantern|iron_bars|iron_door|iron_trapdoor|stonecutter|grindstone|bell|lodestone|enchanting_table|ender_chest|spawner|beacon)/
const AXE_BLOCK = /(planks|log|wood|stem|hyphae|stripped_|chest|trapped_chest|barrel|crafting_table|fletching_table|smithing_table|cartography_table|loom|lectern|composter|note_block|jukebox|bookshelf|ladder|sign|banner|fence|gate|door|trapdoor|camp_fire|campfire|bee_nest|beehive|pumpkin|melon|jack_o_lantern|bamboo|mangrove_roots|mushroom_block|scaffolding)/
const SHOVEL_BLOCK = /(^dirt$|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|dirt_path|farmland|mud|muddy_mangrove|clay|sand|gravel|soul_sand|soul_soil|concrete_powder|snow)/
const HOE_BLOCK = /(_leaves$|sponge|wet_sponge|hay_block|target|dried_kelp_block|nether_wart_block|warped_wart_block|shroomlight|sculk|moss_block|moss_carpet|froglight|calibrated_sculk)/
const DIAMOND_REQUIRED = /^(obsidian|crying_obsidian|respawn_anchor|ancient_debris|netherite_block)$/

function toolClassMatchesBlock (toolClass, block) {
  const n = String(block?.name || '')
  const mat = String(block?.material || '')
  if (toolClass === 'pickaxe') return mat.includes('pickaxe') || mat.includes('stone') || mat.includes('metal') || PICKAXE_BLOCK.test(n)
  if (toolClass === 'axe') return mat.includes('/axe') || mat.includes('wood') || (AXE_BLOCK.test(n) && !/iron_door|iron_trapdoor/.test(n))
  if (toolClass === 'shovel') return mat.includes('shovel') || mat.includes('dirt') || SHOVEL_BLOCK.test(n)
  if (toolClass === 'hoe') return mat.includes('hoe') || HOE_BLOCK.test(n)
  if (toolClass === 'shears') return /(_leaves$|_wool$|cobweb|vine|glow_lichen|tripwire)/.test(n)
  return false
}

// Deterministic fallback break-time calculator for Minecraft 1.20/1.21 blocks where compound material strings
// (such as `incorrect_for_iron_tool;mineable/pickaxe` on `obsidian`) cause prismarine-block's `block.digTime`
// to misreport 250,000ms instead of 9,400ms with a diamond/netherite pickaxe.
function computeVanillaDigMs (block, item, bot) {
  if (!block) return 0
  if (bot?.game?.gameMode === 'creative') return 0
  const hardness = Number(block.hardness)
  if (!Number.isFinite(hardness) || hardness < 0) return Number.POSITIVE_INFINITY
  if (hardness === 0) return 0
  const itemName = String(item?.name || '')
  const m = itemName.match(/^(wooden|stone|iron|diamond|netherite|golden)_(pickaxe|axe|shovel|hoe|sword)$/)
  const tier = m ? m[1] : null
  const toolClass = m ? m[2] : (itemName === 'shears' ? 'shears' : null)
  const matched = toolClass ? toolClassMatchesBlock(toolClass, block) : false
  const blockName = String(block.name || '')
  let canHarvest = true
  if (DIAMOND_REQUIRED.test(blockName)) {
    canHarvest = toolClass === 'pickaxe' && (tier === 'diamond' || tier === 'netherite')
  } else if (String(block.material || '').includes('pickaxe') || PICKAXE_BLOCK.test(blockName)) {
    canHarvest = toolClass === 'pickaxe'
  }
  let speed = 1
  if (matched) {
    if (toolClass === 'shears') {
      speed = /cobweb|_leaves$/.test(blockName) ? 15 : /_wool$/.test(blockName) ? 5 : 2
    } else if (tier && TOOL_SPEEDS[tier]) {
      speed = TOOL_SPEEDS[tier]
    }
  }
  if (bot?.entity?.isInWater) speed /= 5
  if (bot?.entity && !bot.entity.onGround) speed /= 5
  const dmgPerTick = speed / hardness / (canHarvest ? 30 : 100)
  if (dmgPerTick >= 1) return 0
  return Math.ceil(1 / dmgPerTick) * 50
}

class HumanInteractionEngine {
  constructor (bot, worldModel, config, logger, materials = null) {
    this.bot = bot
    this.world = worldModel
    this.config = config
    this.logger = logger
    this.materials = materials
    this.dig = { ok: 0, rejected: 0, streak: 0, blockedUntil: 0, patched: 0, timeHits: 0, lastReply: '' }
    this.recentChat = []
    this.installDigTimeMargin()
    this.installSequenceHook()
    bot.on('messagestr', m => { this.recentChat.push({ at: Date.now(), m: String(m).slice(0, 140) }); while (this.recentChat.length > 10) this.recentChat.shift() })
  }

  effectiveDigMs (block, item = this.bot.heldItem) {
    const bot = this.bot
    const creative = bot.game?.gameMode === 'creative'
    let pMs = Number.POSITIVE_INFINITY
    try {
      pMs = block.digTime(item?.type ?? null, creative, Boolean(bot.entity?.isInWater), !bot.entity?.onGround, [], bot.entity?.effects || [])
    } catch {
      try { pMs = bot.digTime?.(block) ?? Number.POSITIVE_INFINITY } catch {}
    }
    const vMs = computeVanillaDigMs(block, item, bot)
    if (Number.isFinite(pMs) && Number.isFinite(vMs)) return Math.min(pMs, vMs)
    return Number.isFinite(pMs) ? pMs : vMs
  }

  installDigTimeMargin () {
    const bot = this.bot
    if (typeof bot.digTime !== 'function' || bot.__digTimeMargin) return
    const orig = bot.digTime.bind(bot)
    const [lo, hi] = this.config.dig?.marginMs || [15, 35]
    bot.digTime = (block, ...args) => {
      let t = orig(block, ...args)
      const v = computeVanillaDigMs(block, bot.heldItem, bot)
      if (Number.isFinite(v) && (!Number.isFinite(t) || v < t)) t = v
      this.dig.timeHits++
      if (!Number.isFinite(t) || t <= 0) return t
      return Math.ceil(t / 50) * 50 + Math.round(lo + Math.random() * (hi - lo))
    }
    bot.__digTimeMargin = true
    this.dig.patched = 1
  }

  interactionRange () {
    const value = this.bot.entity?.attributes?.['player.block_interaction_range']?.value
    return Number.isFinite(value) ? value : 4.5
  }

  async equipBestDigTool (block) {
    const TOOL = /(pickaxe|_axe|shovel|hoe|shears|sword)$/
    const timeOf = item => this.effectiveDigMs(block, item)
    const pick = () => {
      const bare = timeOf(null)
      let best = null; let bestTime = bare
      for (const item of this.bot.inventory.items()) {
        if (!TOOL.test(item.name)) continue
        const time = timeOf(item)
        if (Number.isFinite(time) && time < bestTime) { bestTime = time; best = item }
      }
      return best
    }
    let best = pick()
    if (!best && this.materials) {
      await this.materials.ensureToolKit().catch(() => {})
      best = pick()
    }
    let switched = false
    if (best && this.bot.heldItem?.type !== best.type) {
      await withTimeout(this.bot.equip(best, 'hand'), 4000, 'equip')
      switched = true
    }
    return { best, switched }
  }

  async equipItem (itemName, role = 'block') {
    const wanted = SPECIAL_ITEM_MAP[itemName] || itemName
    if (this.materials) return this.materials.ensureUsableItem(wanted, role)
    const item = this.bot.inventory.items().find(i => i.name === wanted)
    if (!item) throw new Error(`Missing required item ${wanted}`)
    if (!this.bot.heldItem || this.bot.heldItem.type !== item.type) {
      await withTimeout(this.bot.equip(item, 'hand'), 4000, 'equip')
      await waitFor(() => Boolean(this.bot.heldItem && this.bot.heldItem.type === item.type), { timeoutMs: 2500, intervalMs: 15 })
    }
    return { item, slot: null, serverAuthoritative: false }
  }

  async sendPlace (referenceBlock, face, cursor) {
    if (typeof this.bot._placeBlockWithOptions !== 'function') throw new Error('Mineflayer placement primitive missing')
    const { isInteractive } = require('../rules/blocks')
    if (referenceBlock && isInteractive(referenceBlock.name) && !this.bot.getControlState?.('sneak')) {
      this.bot.setControlState('sneak', true)
      await this.ticks(1)
    }
    await this.quick(this.bot._placeBlockWithOptions(referenceBlock, toVec3(face), { forceLook: 'ignore', delta: toVec3(cursor), swingArm: 'right', showHand: true }))
    if (this.bot.currentWindow) {
      try { this.bot.closeWindow(this.bot.currentWindow) } catch {}
    }
  }

  async quick (promise) {
    promise.catch(() => {})
    await Promise.race([promise, sleep(65)])
  }

  async sendUse (block, face, cursor) {
    if (typeof this.bot._genericPlace !== 'function') throw new Error('Mineflayer click primitive missing')
    await this.quick(this.bot._genericPlace(block, toVec3(face), { forceLook: 'ignore', delta: toVec3(cursor), swingArm: 'right', showHand: true }))
  }

  useHeldItem () {
    this.bot.swingArm?.('right')
    this.bot.activateItem()
  }

  resolveFace (block, hint) {
    const bot = this.bot
    try {
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? (bot.getControlState?.('sneak') ? 1.27 : 1.62), 0)
      const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
      const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      const range = this.interactionRange() + 0.5
      const hit = bot.world.raycast(eye, dir, range)
      if (hit && hit.position && hit.position.equals(block.position) && Number.isInteger(hit.face)) return hit.face
      if (block?.position) {
        const rb = rayHitBox(eye, dir, range, block.position, boxOf(block))
        if (rb && Number.isInteger(rb.face)) return rb.face
      }
    } catch { /* fall through */ }
    try {
      const e = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
      const dx = e.x - (block.position.x + 0.5); const dy = e.y - (block.position.y + 0.5); const dz = e.z - (block.position.z + 0.5)
      const ax = Math.abs(dx); const ay = Math.abs(dy); const az = Math.abs(dz)
      if (ay >= ax && ay >= az) return dy > 0 ? 1 : 0
      if (ax >= az) return dx > 0 ? 5 : 4
      return dz > 0 ? 3 : 2
    } catch { /* use hint */ }
    return Number.isInteger(hint) && hint >= 0 && hint <= 5 ? hint : 1
  }

  installSequenceHook () {
    const client = this.bot._client
    if (!client || client.__seqHooked || typeof client.write !== 'function') return
    client.__seqHooked = true
    const write = client.write.bind(client)
    let seq = 0
    client.write = (name, params, ...rest) => {
      if (params && (name === 'block_dig' || name === 'block_place' || name === 'use_item') && 'sequence' in params && !params.sequence) params.sequence = ++seq
      return write(name, params, ...rest)
    }
  }

  ticks (n) {
    return new Promise(resolve => {
      let left = Math.max(0, Math.round(n)); let guard = null
      if (left <= 0) return resolve()
      const done = () => { clearTimeout(guard); this.bot.removeListener('physicsTick', on); resolve() }
      const on = () => { if (--left <= 0) done() }
      guard = setTimeout(done, n * 65 + 250)
      this.bot.on('physicsTick', on)
    })
  }

  // Vanilla-style break with active anti-current tracking: if flowing water pushes the bot while digging,
  // keep aiming at the target block, counter-thrust against the current if drifting, and abort if pushed out of reach!
  async digByTicks (block, face) {
    const bot = this.bot
    const pos = block.position
    const bx = boxOf(block)
    const center = pos.offset((bx[0] + bx[3]) * 0.5, (bx[1] + bx[4]) * 0.5, (bx[2] + bx[5]) * 0.5)
    const ms = this.effectiveDigMs(block, bot.heldItem)
    if (!Number.isFinite(ms)) throw new Error(`dig time for ${block.name} is Infinity`)
    const [lo, hi] = this.config.dig?.marginTicks || [0, 1]
    const need = ms <= 0 ? 1 : Math.max(1, Math.ceil(ms / 50)) + Math.round(lo + Math.random() * (hi - lo))
    const send = (status, f) => bot._client.write('block_dig', { status, location: pos, face: f, sequence: 0 })
    if (bot.targetDigBlock) bot.stopDigging?.()
    send(0, face)
    bot.swingArm?.('right')
    const every = Math.max(1, Number(this.config.dig?.swingEveryTicks ?? 3))
    bot.targetDigBlock = block
    let heldForward = false
    let aborted = false
    try {
      for (let held = 0; held < need;) {
        const step = Math.min(every, need - held)
        await this.ticks(step); held += step
        if (runStore.getStore()?.dead || bot.builder?.stopRequested || bot.builder?.paused || bot.targetDigBlock !== block) {
          aborted = true
          send(1, face)
          const err = new Error(`digging ${block.name} aborted`)
          err.code = 'INTERRUPTED'
          err.localAbort = true
          throw err
        }
        const mid = this.world.blockAt(pos)
        if (!mid || this.world.isAirLike(mid) || mid.type !== block.type) return
        if (bot.entity) {
          const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
          const nearX = Math.max(pos.x, Math.min(eye.x, pos.x + 1))
          const nearY = Math.max(pos.y, Math.min(eye.y, pos.y + 1))
          const nearZ = Math.max(pos.z, Math.min(eye.z, pos.z + 1))
          const faceDist = Math.hypot(eye.x - nearX, eye.y - nearY, eye.z - nearZ)
          const dist = eye.distanceTo(center)
          if (faceDist > this.interactionRange() + 0.25) {
            aborted = true
            send(1, face) // cancel dig packet
            const err = new Error(`water current pushed bot out of dig reach (${dist.toFixed(2)}b)`)
            err.localAbort = true
            throw err
          }
          if (!this.crosshairOn(block)) {
            try { await bot.lookAt(center, true) } catch {}
          }
          if (bot.entity.isInWater || (bot.entity.velocity && Math.hypot(bot.entity.velocity.x, bot.entity.velocity.z) > 0.03)) {
            if (bot.entity.isInWater && dist > 2.8) {
              bot.setControlState('forward', true)
              heldForward = true
            } else if (heldForward && dist < 2.2) {
              bot.setControlState('forward', false)
              heldForward = false
            }
          }
        }
        if (held < need) bot.swingArm?.('right')
      }
      if (!aborted) {
        if (ms > 0) send(2, face)
        bot._updateBlockState?.(pos, 0)
      }
    } finally {
      if (heldForward) bot.setControlState('forward', false)
      if (bot.targetDigBlock === block) bot.targetDigBlock = null
    }
  }

  crosshairOn (block) {
    const bot = this.bot
    try {
      if (!bot.world?.raycast || !bot.entity) return true
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? (bot.getControlState?.('sneak') ? 1.27 : 1.62), 0)
      const yaw = bot.entity.yaw; const pitch = bot.entity.pitch
      const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
      const range = this.interactionRange() + 0.5
      const hit = bot.world.raycast(eye, dir, range)
      if (hit && hit.position && hit.position.equals(block.position)) return true
      if (block?.position) {
        const rb = rayHitBox(eye, dir, range, block.position, boxOf(block))
        if (rb && (!hit || !hit.intersect || rb.dist <= eye.distanceTo(hit.intersect) + 0.05)) return true
      }
      return false
    } catch { return true }
  }

  digProblem (block, reason) {
    const p = block.position
    const said = this.recentChat.filter(c => Date.now() - c.at < 5000).map(c => c.m).join(' / ')
    this.dig.lastReply = said
    const error = new Error(`${reason} at ${p.x},${p.y},${p.z}${said ? ` (server said: ${said})` : ''}`)
    error.code = 'DIG_REJECTED'
    return error
  }

  async digAimed (block, faceIndex = 1) {
    if (!block || this.world.isAirLike(block)) return
    const bot = this.bot
    const cfg = this.config.dig || {}
    const pos = block.position.clone()
    const isOurTemp = Boolean(bot.builder?.scaffold?.created?.has(`${pos.x},${pos.y},${pos.z}`))
    if (!isOurTemp && Date.now() < this.dig.blockedUntil) {
      const error = new Error(`breaking is paused: the server refused ${cfg.rejectLimit ?? 3} breaks in a row (protected area or anti-cheat?)`)
      error.code = 'DIG_PROTECTED'
      throw error
    }
    if (bot.game?.gameMode === 'adventure') { const e = new Error('adventure mode: breaking is not allowed here'); e.code = 'DIG_PROTECTED'; throw e }

    const { switched } = await this.equipBestDigTool(block)
    if (switched) {
      const [a, b] = cfg.settleAfterEquipMs || [15, 30]
      const ps = Number(this.config?.human?.pauseScale ?? 0.1)
      await sleep(Math.max(10, (a + Math.random() * (b - a)) * ps))
    }

    const originalType = block.type
    if (!this.crosshairOn(block)) {
      const bx = boxOf(block)
      const aimPt = block.position.offset((bx[0] + bx[3]) * 0.5, (bx[1] + bx[4]) * 0.5, (bx[2] + bx[5]) * 0.5)
      try { await bot.lookAt(aimPt, true) } catch {}
      await sleep(12)
    }
    bot.builder?.placer?.setPhase?.(`digging ${block.name}`)
    const face = this.resolveFace(block, faceIndex)
    const faceVec = FACE_VECTORS[face]
    const expected = this.effectiveDigMs(block, bot.heldItem)
    const limit = (Number.isFinite(expected) ? expected : 3000) + 3500
    let failure = null
    const run = (cfg.engine === 'mineflayer' ? bot.dig(block, 'ignore', faceVec) : this.digByTicks(block, face)).catch(error => { failure = error })
    await Promise.race([run, sleep(limit)])
    if (bot.targetDigBlock) { try { bot.stopDigging() } catch {} }
    if (failure && failure.code === 'INTERRUPTED') throw failure

    await sleep(expected >= 4000 ? 80 : 45)
    let gone = false
    const t0 = Date.now()
    while (Date.now() - t0 < 1200) {
      const after = this.world.blockAt(pos)
      if (!after || this.world.isAirLike(after) || after.type !== originalType) { gone = true; break }
      await sleep(15)
    }
    if (gone) { this.dig.ok++; this.dig.streak = 0; return }

    const isLocalAbort = Boolean(failure && (failure.localAbort || /pushed bot out of dig reach|Infinity|aborted/i.test(failure.message || '')))
    const error = this.digProblem(block, failure ? `break failed: ${failure.message}` : 'server restored the block (break refused)')
    // Never count a local reach/movement abort or a temporary block we placed ourselves toward the 90s server-protection lockout!
    if (!isLocalAbort && !isOurTemp) {
      this.dig.rejected++; this.dig.streak++
      const limitStreak = Number(cfg.rejectLimit ?? 3)
      if (this.dig.streak >= limitStreak) {
        this.dig.blockedUntil = Date.now() + Number(cfg.protectedCooldownMs || 90000)
        this.logger.warn(`DIG: ${this.dig.streak} refused breaks in a row. Likely causes: spawn/claim protection or a build permission missing at ${pos.x},${pos.y},${pos.z}; or the server's anti-cheat disliking the timing. Pausing breaking for ${Math.round((cfg.protectedCooldownMs || 90000) / 1000)}s instead of hammering. ${this.dig.lastReply ? `Server message: ${this.dig.lastReply}` : 'The server sent no chat message.'}`)
      }
    }
    throw error
  }
}

const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]

module.exports = { HumanInteractionEngine, SPECIAL_ITEM_MAP, computeVanillaDigMs }
