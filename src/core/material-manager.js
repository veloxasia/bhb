'use strict'
// Materials manager: handles both shop purchases (DonutSMP / real servers) and operator /give + /clear (test / Aternos servers).
const { withTimeout, sleep } = require('../util/async')
const { Shop, ShopError } = require('./shop')

const SPECIAL_BLOCK_ITEMS = Object.freeze({ water: 'water_bucket', lava: 'lava_bucket' })
const DEFAULT_TOOL_KIT = Object.freeze([['diamond_pickaxe', 'pickaxe'], ['diamond_axe', 'axe'], ['diamond_shovel', 'shovel']])
const TOOL_KINDS = ['pickaxe', 'axe', 'shovel']

class MaterialManager {
  constructor (bot, config, logger) {
    this.bot = bot
    this.config = config
    this.logger = logger
    this.planner = null
    this.requirements = new Map()
    this.shop = new Shop(bot, config, logger)
    this.toolChecked = 0
    this.lastShopError = null
    this.lastClearAt = 0
  }

  attachPlanner (planner) {
    this.planner = planner
    this.requirements = new Map(planner.getMaterialDemand())
    return this.requirements
  }

  itemNameForBlock (blockName) {
    if (SPECIAL_BLOCK_ITEMS[blockName]) return SPECIAL_BLOCK_ITEMS[blockName]
    if (this.bot.registry?.itemsByName?.[blockName]) return blockName
    const bt = this.bot.registry?.blocksByName?.[blockName]
    const itemId = bt?.itemId
    if (Number.isInteger(itemId)) return this.bot.registry?.items?.[itemId]?.name || null
    return null
  }

  stackSizeFor (itemName) {
    const n = Number(this.bot.registry?.itemsByName?.[itemName]?.stackSize)
    return Number.isFinite(n) && n > 0 ? Math.min(64, n) : 64
  }

  countItem (itemName) {
    return this.bot.inventory?.items?.()?.filter(item => item?.name === itemName)?.reduce((sum, item) => sum + Number(item.count || 0), 0) || 0
  }

  summary (limit = 30) {
    return [...this.requirements.entries()]
      .map(([item, required]) => { const current = this.countItem(item); return { item, required, current, missing: Math.max(0, required - current) } })
      .sort((a, b) => b.required - a.required)
      .slice(0, limit)
  }

  snapshot () { return this.summary(this.requirements.size) }

  formatSummary (limit = 12) {
    const rows = this.summary(limit)
    return rows.length ? rows.map(r => `${r.item} ${r.current}/${r.required}`).join(', ') : 'no schematic materials'
  }

  getMissingMaterials (limit = 20) { return this.snapshot().filter(r => r.missing > 0).slice(0, limit) }

  // how much to buy in one shop visit: what the build still needs, in whole stacks, capped per visit
  amountToBuy (itemName, minimum) {
    const stack = this.stackSizeFor(itemName)
    const have = this.countItem(itemName)
    const need = Math.max(minimum - have, 1)
    if (stack === 1) {
      if (itemName === 'water_bucket') {
        const demand = this.requirements.get(itemName) || need
        const free = Number(this.bot.inventory?.emptySlotCount?.() ?? 20)
        return Math.min(Math.max(need, Math.min(demand, 6)), Math.max(1, Math.min(8, free - 4)))
      }
      return Math.min(Math.max(need, 1), 4)
    }
    const demand = this.requirements.get(itemName)
    const stillNeeded = demand ? Math.max(0, demand - have) : need
    const free = Number(this.bot.inventory?.emptySlotCount?.() ?? 20)
    const kinds = Math.max(1, this.snapshot().filter(r => r.missing > 0).length)
    const share = Math.floor(Math.max(1, free - 6) / kinds) * stack
    const cap = Math.max(Math.max(1, Number(this.config.shop?.stacksPerVisit || 3)) * stack, share)
    const want = Math.max(need, Math.min(stillNeeded, cap))
    return Math.ceil(want / stack) * stack
  }

  // ---- full inventory: clear with /clear in autoGive mode, or drop unneeded items on shop servers ----
  isEssential (item) {
    const n = item.name
    if (/_(pickaxe|axe|shovel|sword|hoe)$/.test(n)) return true
    if (/^(ender_pearl|ladder|bucket|water_bucket|lava_bucket|golden_apple|enchanted_golden_apple|bread|apple|baked_potato|carrot|cooked_[a-z_]+)$/.test(n)) return true
    if ((this.remainingNeed().get(n) || 0) > 0) return true
    const scaffold = this.scaffoldBlockName || (this.config.building?.scaffoldBlockNames || ['cobblestone'])[0]
    return n === scaffold
  }

  remainingNeed () {
    if (this._need && Date.now() - this._need.at < 5000) return this._need.map
    const map = new Map()
    if (this.planner) for (const t of this.planner.tasks.values()) if (t.status !== 'completed' && t.item) map.set(t.item, (map.get(t.item) || 0) + 1)
    this._need = { at: Date.now(), map }
    return map
  }

  closeOpenContainer () {
    if (this.bot.currentWindow && !this.shop?.open) {
      try { this.bot.closeWindow(this.bot.currentWindow) } catch {}
    }
  }

  async makeRoom (wantFree = 4) {
    const bot = this.bot
    this.closeOpenContainer()
    const free = () => Number(bot.inventory?.emptySlotCount?.() ?? 99)
    if (free() >= wantFree) return true
    if (this.config.materials?.autoGive) {
      const gap = 800 - (Date.now() - (this.lastClearAt || 0))
      if (gap > 0) await sleep(gap)
      this.lastClearAt = Date.now()
      this.logger.info(`inventory is full (${free()} free slots): sending /clear`)
      bot.chat('/clear')
      const t0 = Date.now()
      while (Date.now() - t0 < 1200 && free() < wantFree) await sleep(60)
      this.toolChecked = 0
      return free() >= 1
    }
    const items = (bot.inventory?.items?.() || []).filter(i => i.slot >= 9 && i.slot <= 44)
    const junk = items.filter(i => !this.isEssential(i))
    const scaffold = this.scaffoldBlockName || (this.config.building?.scaffoldBlockNames || ['cobblestone'])[0]
    const extra = []
    let seen = 0
    for (const i of items.filter(x => x.name === scaffold).sort((a, b) => b.count - a.count)) { if (++seen > 2) extra.push(i) }
    const need = this.remainingNeed()
    const surplus = []
    const byName = new Map()
    for (const i of items) { if (!byName.has(i.name)) byName.set(i.name, []); byName.get(i.name).push(i) }
    for (const [n, list] of byName) {
      const want = need.get(n)
      if (want == null || n === scaffold) continue
      let have = list.reduce((a, i) => a + i.count, 0)
      for (const i of list.sort((a, b) => a.count - b.count)) { if (have - i.count >= want + 32) { surplus.push(i); have -= i.count } }
    }
    const victims = [...junk, ...surplus, ...extra]
    this.logger.info(`inventory is nearly full (${free()} free): getting rid of ${victims.map(i => `${i.count} ${i.name}`).slice(0, 6).join(', ') || 'nothing'}`)
    for (const item of victims) {
      if (free() >= wantFree) break
      try {
        await bot.toss(item.type, item.metadata ?? null, item.count)
        await sleep(180 + Math.random() * 200)
      } catch (error) { this.logger.debug?.(`makeRoom: ${error.message}`) }
    }
    return free() >= 1
  }

  // test mode only (own / Aternos server where the bots are operators): one plain /give
  async giveCommand (itemName, amount) {
    const bot = this.bot
    this.closeOpenContainer()
    if (Number(bot.inventory?.emptySlotCount?.() ?? 99) < 3) await this.makeRoom(6)
    const before = this.countItem(itemName)
    const gap = 650 - (Date.now() - (this.lastGiveAt || 0))
    if (gap > 0) await sleep(gap)
    const replies = []
    const on = m => replies.push(String(m))
    bot.on('messagestr', on)
    try {
      this.lastGiveAt = Date.now()
      bot.chat(`/give ${bot.username} ${itemName} ${Math.max(1, Math.floor(amount))}`)
      const t0 = Date.now()
      while (Date.now() - t0 < 5000 && this.countItem(itemName) <= before) await sleep(80)
    } finally { bot.removeListener('messagestr', on) }
    let got = this.countItem(itemName) - before
    if (got <= 0 && replies.some(r => /(^|\b)Gave /i.test(r))) {
      await this.makeRoom(6)
      const t1 = Date.now()
      while (Date.now() - t1 < 2500 && this.countItem(itemName) <= before) await sleep(120)
      got = this.countItem(itemName) - before
    }
    if (got <= 0 && replies.some(r => /(^|\b)Gave /i.test(r) && r.includes(bot.username))) {
      const t2 = Date.now()
      while (Date.now() - t2 < 5000 && this.countItem(itemName) <= before) await sleep(120)
      got = this.countItem(itemName) - before
    }
    if (got <= 0) { const e = new Error(`/give ${itemName} delivered nothing${replies.length ? ` (server: ${replies.slice(-2).join(' / ')})` : ''}`); e.code = 'NO_DELIVERY'; throw e }
    this.logger.info(`give: ${got} x ${itemName}`)
    return got
  }

  async buy (itemName, amount) {
    if (!this.bot.registry?.itemsByName?.[itemName]) throw new Error(`Unknown item ${itemName} for ${this.bot.version}`)
    if (this.config.materials?.autoGive) return this.giveCommand(itemName, amount)
    try {
      if (Number(this.bot.inventory?.emptySlotCount?.() ?? 99) < 2) await this.makeRoom(4)
      return await this.shop.buy(itemName, amount)
    } catch (error) {
      this.lastShopError = error
      if (error instanceof ShopError) this.logger.warn(`shop: ${error.code}: ${error.message}`)
      throw error
    }
  }

  async give (itemName, amount) { return this.buy(itemName, amount) }

  substituteFor (itemName) {
    const chains = this.config.building?.substitutes || {}
    const chain = chains[itemName]
    if (!chain || !this.planner?.substituteItem) return null
    this.skipped = this.skipped || new Set()
    this.skipped.add(itemName)
    for (const next of chain) {
      if (this.skipped.has(next) || !this.bot.registry?.itemsByName?.[next]) continue
      const n = this.planner.substituteItem(itemName, next)
      this.logger.warn(`materials: ${itemName} is not available, ${n} blocks will be ${next} instead`)
      this.requirements = new Map(this.planner.getMaterialDemand())
      return next
    }
    return null
  }

  async ensureItem (itemName, minimum = 1) {
    this.closeOpenContainer()
    if (this.config.materials?.autoGive && Number(this.bot.inventory?.emptySlotCount?.() ?? 99) <= 1 && this.countItem(itemName) < minimum) {
      await this.makeRoom(6)
    }
    if (this.countItem(itemName) >= minimum) return this.countItem(itemName)
    try {
      await this.buy(itemName, this.amountToBuy(itemName, minimum))
    } catch (error) {
      if (error.code === 'NOT_FOUND' || error.code === 'NOT_SOLD') {
        const next = this.substituteFor(itemName)
        if (next) { const e = new Error(`${itemName} replaced by ${next}`); e.code = 'MATERIAL_SUBSTITUTED'; throw e }
      }
      throw error
    }
    if (this.countItem(itemName) < 1) throw new Error(`Missing ${itemName}; the shop did not deliver it`)
    return this.countItem(itemName)
  }

  async ensureUsableItem (itemName) {
    this.closeOpenContainer()
    if (this.bot.heldItem?.name === itemName && Number(this.bot.heldItem?.count || 0) > 1) {
      return { item: this.bot.heldItem, slot: this.bot.quickBarSlot, serverAuthoritative: true }
    }
    const pickBest = () => {
      const list = (this.bot.inventory?.items?.() || []).filter(i => i?.name === itemName && i.count > 0)
      if (!list.length) return null
      list.sort((a, b) => {
        const aHot = a.slot >= 36 && a.slot <= 44 && a.count > 1 ? 100 : 0
        const bHot = b.slot >= 36 && b.slot <= 44 && b.count > 1 ? 100 : 0
        return (bHot + b.count) - (aHot + a.count)
      })
      return list[0]
    }
    let item = pickBest()
    if (!item || (item.count <= 1 && this.countItem(itemName) <= 1)) {
      await this.ensureItem(itemName, 1)
      item = pickBest()
    }
    if (!item) throw new Error(`Unable to get ${itemName}`)
    if (this.bot.heldItem?.type !== item.type || (this.bot.heldItem?.count || 0) <= 0) {
      this.closeOpenContainer()
      try { await withTimeout(this.bot.equip(item, 'hand'), 4000, 'equip') } catch (equipError) {
        this.closeOpenContainer()
        if (item.slot >= 36 && item.slot <= 44) this.bot.setQuickBarSlot(item.slot - 36)
        else {
          await sleep(50)
          await withTimeout(this.bot.equip(item, 'hand'), 3000, 'equip retry')
        }
      }
      await sleep(Math.max(15, (20 + Math.random() * 25) * Number(this.config.human?.pauseScale ?? 0.05)))
    }
    return { item, slot: this.bot.quickBarSlot, serverAuthoritative: true }
  }

  ensureBlockItem (blockName) {
    const item = this.itemNameForBlock(blockName)
    if (!item) throw new Error(`No item mapping for schematic block '${blockName}'`)
    return this.ensureUsableItem(item, 'block')
  }

  hasToolOfKind (kind) { return Boolean(this.bot.inventory?.items?.()?.some(i => i.name.endsWith(`_${kind}`))) }

  async ensureToolKit () {
    const wanted = this.config.materials?.toolItems
    if (!Array.isArray(wanted) || !wanted.length) return
    if (Date.now() - this.toolChecked < 60_000) return
    this.toolChecked = Date.now()
    for (const name of wanted) {
      const kind = TOOL_KINDS.find(k => name.endsWith(`_${k}`))
      if (kind && this.hasToolOfKind(kind)) continue
      if (!this.bot.registry?.itemsByName?.[name]) continue
      try { await this.buy(name, 1) } catch (error) { this.logger.warn(`tool ${name}: ${error.message}`) }
    }
    // Keep temporary ladders available in operator / autoGive mode so bots can climb vertical walls with ladders instead of blocking corridors with stone!
    if (this.config.materials?.autoGive && this.bot.registry?.itemsByName?.ladder && this.countItem('ladder') < 12) {
      try { await this.giveCommand('ladder', 32) } catch {}
    }
  }

  noteConsumed () {}
  noteBucketUsed () {}
  async clearEmptyBuckets () {
    this.closeOpenContainer()
    const emptyBuckets = (this.bot.inventory?.items?.() || []).filter(i => i?.name === 'bucket')
    if (emptyBuckets.length >= 4) {
      for (const b of emptyBuckets) {
        try { await this.bot.toss(b.type, b.metadata ?? null, b.count); await sleep(60) } catch {}
      }
    }
    if (this.config.materials?.autoGive && Number(this.bot.inventory?.emptySlotCount?.() ?? 99) <= 2) {
      await this.makeRoom(6).catch(() => {})
    }
  }
  serverSlotState () { return null }
}

module.exports = { MaterialManager, SPECIAL_BLOCK_ITEMS, DEFAULT_TOOL_KIT }
