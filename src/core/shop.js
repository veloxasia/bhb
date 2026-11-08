'use strict'
// Buys items from a server shop the way a player does: type the shop command, wait for the menu to open, look at it,
// click the item once per purchase, wait for the item to arrive, close the menu. No other command is ever sent.
// The shop menu itself is set up by you on the server; the bot only has to FIND the item in it (by the item icon, or by a
// text you give in the GUI under "Shop item overrides") and click it.
const { sleep } = require('../util/async')

class ShopError extends Error {
  constructor (code, message) { super(message); this.code = code }
}

const rand = (a, b) => a + Math.random() * (b - a)
const range = (v, dflt) => (Array.isArray(v) && v.length === 2 ? v : dflt)
const pause = (v, dflt) => sleep(Math.round(rand(...range(v, dflt))))

// "§aCobblestone" / {"text":"Cobblestone"} / nested chat components -> plain lower-case text
function flattenText (value) {
  if (value == null) return ''
  let raw = typeof value === 'string' ? value : ''
  if (!raw) { try { raw = JSON.stringify(value) } catch { raw = String(value) } }
  const parts = []
  raw.replace(/"(?:text|translate)"\s*:\s*"((?:[^"\\]|\\.)*)"/g, (_, t) => { parts.push(t); return '' })
  const text = parts.length ? parts.join('') : raw
  return text.replace(/§./g, '').replace(/\\u00a7./gi, '').toLowerCase()
}

function itemText (item) {
  if (!item) return ''
  const bits = [item.name, item.displayName]
  try { bits.push(item.customName) } catch {}
  try { bits.push(item.customLore) } catch {}
  return bits.map(flattenText).filter(Boolean).join(' | ')
}

function containerSlots (win) {
  const end = Number.isInteger(win.inventoryStart) ? win.inventoryStart : Math.max(0, win.slots.length - 36)
  return { start: 0, end }
}

function findSlot (win, test) {
  const { start, end } = containerSlots(win)
  for (let i = start; i < end; i++) {
    const item = win.slots[i]
    if (item && test(item, itemText(item))) return i
  }
  return -1
}

function itemMatcher (itemName, spec = {}) {
  if (spec.match) {
    const re = new RegExp(spec.match, 'i')
    return (item, text) => re.test(text)
  }
  return item => item.name === itemName
}

function textMatcher (pattern) {
  const re = new RegExp(pattern, 'i')
  return (item, text) => re.test(text)
}

class Shop {
  constructor (bot, config, logger) {
    this.bot = bot
    this.config = config
    this.logger = logger
    this.chain = Promise.resolve()
    this.lastCommandAt = 0
    this.notSold = new Map()
    this.perClick = new Map()
    this.recent = []
    this.stats = { visits: 0, clicks: 0, items: 0, failures: 0 }
    bot.on('messagestr', message => {
      this.recent.push({ at: Date.now(), message: String(message).slice(0, 160) })
      while (this.recent.length > 12) this.recent.shift()
    })
  }

  get cfg () { return this.config.shop || {} }

  count (itemName) {
    const b = this.bot
    let n = b.inventory?.items?.().filter(i => i.name === itemName).reduce((s, i) => s + i.count, 0) || 0
    const win = b.currentWindow
    if (win?.slots) {
      const from = Number.isInteger(win.inventoryStart) ? win.inventoryStart : Math.max(0, win.slots.length - 36)
      let m = 0
      for (let i = from; i < win.slots.length; i++) if (win.slots[i]?.name === itemName) m += win.slots[i].count
      n = Math.max(n, m)
    }
    return n
  }

  // no empty slot and no stack of this item with room left
  inventoryFull (itemName) {
    const inv = this.bot.inventory
    if (!inv?.emptySlotCount || inv.emptySlotCount() > 0) return false
    const max = this.bot.registry?.itemsByName?.[itemName]?.stackSize || 64
    return !inv.items().some(i => i.name === itemName && i.count < max)
  }

  serverReply (sinceMs = 4000) {
    const cutoff = Date.now() - sinceMs
    return this.recent.filter(r => r.at >= cutoff).map(r => r.message).join(' / ')
  }

  // one purchase at a time per bot; returns how many items arrived
  buy (itemName, wanted) {
    const run = this.chain.then(() => this._buy(itemName, wanted))
    this.chain = run.catch(() => {})
    return run
  }

  async _buy (itemName, wanted) {
    const bot = this.bot
    if (this.cfg.enabled === false) throw new ShopError('DISABLED', `shop is disabled, cannot get ${itemName}`)
    const until = this.notSold.get(itemName)
    if (until && until > Date.now()) throw new ShopError('NOT_SOLD', `${itemName} was not found in the shop recently`)
    if (!bot.entity || bot.health <= 0) throw new ShopError('NO_BOT', 'bot is not in the world')

    const spec = (this.cfg.items && this.cfg.items[itemName]) || {}
    const before = this.count(itemName)
    const target = before + Math.max(1, Math.floor(wanted || 1))
    let win = null
    try {
      win = await this.openShop()
      await pause(this.cfg.afterOpenDelayMs, [500, 1100])
      for (const step of spec.path || []) {
        const slot = findSlot(win, textMatcher(step))
        if (slot < 0) throw new ShopError('NO_PATH', `menu entry "${step}" not found while looking for ${itemName}`)
        win = await this.clickAndSettle(win, slot)
        await pause(this.cfg.clickDelayMs, [450, 1100])
      }
      let slot = await this.locate(win, itemName, spec)
      if (slot.index < 0 && this.cfg.autoAdd !== false) {
        try {
          win = await this.addToQuickBuy(slot.win || win, itemName, spec)
          slot = await this.locate(win, itemName, spec)
        } catch (e) {
          if (e.code !== 'NO_EMPTY_SLOT') throw e
          this.logger.warn(`shop: ${e.message}`)
        }
      }
      if (slot.index < 0) {
        this.notSold.set(itemName, Date.now() + Number(this.cfg.notSoldRetryMs || 600000))
        throw new ShopError('NOT_FOUND', `${itemName} is not in the shop menu`)
      }
      win = slot.win
      let clicks = 0
      const maxClicks = Math.max(1, Number(this.cfg.maxClicksPerVisit || 36))
      while (this.count(itemName) < target && clicks < maxClicks) {
        if (this.inventoryFull(itemName)) throw new ShopError('INVENTORY_FULL', 'inventory is full')
        const had = this.count(itemName)
        const idx = findSlot(win, itemMatcher(itemName, spec))
        if (idx < 0) throw new ShopError('MENU_CHANGED', `${itemName} disappeared from the menu`)
        await bot.clickWindow(idx, 0, 0) // one plain left click = one purchase
        clicks++; this.stats.clicks++
        const got = await this.waitForMore(itemName, had, 3500)
        if (!got) {
          const reply = this.serverReply()
          this.stats.failures++
          throw new ShopError('NO_DELIVERY', `clicked ${itemName} but nothing arrived${reply ? ` (server: ${reply})` : ''}`)
        }
        this.perClick.set(itemName, got - had)
        this.stats.items += got - had
        if (this.count(itemName) < target) await pause(this.cfg.clickDelayMs, [450, 1100])
      }
    } finally {
      await this.closeShop(win)
    }
    const bought = this.count(itemName) - before
    this.logger.info(`shop: bought ${bought} x ${itemName}`)
    return bought
  }

  // ---- adding an item to the Quick Buy menu (empty slot -> Search sign -> pick the item -> amount sign) --------
  expectSign (timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.bot.removeListener('mhbSign', on); reject(new ShopError('NO_SIGN', 'the sign editor did not open')) }, timeoutMs)
      const on = packet => { clearTimeout(timer); resolve(packet) }
      this.bot.once('mhbSign', on)
    })
  }

  // answers the sign editor the way the client does when "Done" is pressed: the text goes into line 1, the lines the
  // server put there (the arrows and hints) are sent back unchanged
  async typeSign (signPromise, text) {
    signPromise.catch(() => {})
    const packet = await signPromise
    await sleep(Math.round(rand(500, 900) + String(text).length * rand(90, 170) + rand(250, 600))) // read, type, press Done
    let hints = []
    try {
      const block = this.bot.blockAt(new (require('../util/vec3').Vec3)(packet.location.x, packet.location.y, packet.location.z))
      const t = block?.getSignText?.()
      const front = Array.isArray(t) ? t[0] : t
      if (typeof front === 'string') hints = front.split('\n')
    } catch { /* blank hint lines */ }
    this.bot._client.write('update_sign', {
      location: packet.location, isFrontText: packet.isFrontText !== false,
      text1: String(text), text2: String(hints[1] || ''), text3: String(hints[2] || ''), text4: String(hints[3] || '')
    })
    this.stats.signs = (this.stats.signs || 0) + 1
    await sleep(rand(400, 800))
  }

  // the next menu appears a moment after a click / after the sign is confirmed
  async nextWindow (prev, timeoutMs = 6000) {
    const sig = w => (w?.slots || []).map(x => (x ? `${x.name}:${x.count}` : '-')).join(',')
    const before = sig(prev)
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const w = this.bot.currentWindow
      if (w && w !== prev) { await this.waitFilled(w); return w }
      if (prev && w === prev && sig(prev) !== before) { await sleep(300); return prev } // refreshed in place
      await sleep(80)
    }
    return this.bot.currentWindow || null
  }

  async addToQuickBuy (win, itemName, spec) {
    const bot = this.bot
    const info = bot.registry?.itemsByName?.[itemName]
    const amount = Math.max(1, Number(spec.amount || this.cfg.addAmount || info?.stackSize || 64))
    const query = String(spec.search || info?.displayName || itemName.replace(/_/g, ' '))
    const empty = findSlot(win, (item, text) => /\bempty\b|click to choose/.test(text))
    if (empty < 0) throw new ShopError('NO_EMPTY_SLOT', 'the Quick Buy menu has no empty slot left to add an item to (remove one in the shop)')
    this.logger.info(`shop: adding ${itemName} (x${amount}) to the Quick Buy menu`)
    await pause(this.cfg.clickDelayMs, [450, 1100])
    await bot.clickWindow(empty, 0, 0)
    let sel = await this.nextWindow(win)
    if (!sel || sel === win) throw new ShopError('NO_SELECT_MENU', 'clicking the empty slot did not open the item chooser')
    await pause(this.cfg.afterOpenDelayMs, [500, 1100])
    // the "Search" sign button
    let search = findSlot(sel, (item, text) => /sign/.test(item.name) && /search/.test(text))
    if (search < 0) search = findSlot(sel, (item, text) => /sign/.test(item.name))
    if (search < 0) throw new ShopError('NO_SEARCH', 'no Search button in the item chooser')
    const sign1 = this.expectSign()
    await bot.clickWindow(search, 0, 0)
    await this.typeSign(sign1, query)
    let results = await this.nextWindow(sel)
    if (!results) throw new ShopError('NO_RESULTS', 'the search did not show a result menu')
    await pause(this.cfg.afterOpenDelayMs, [500, 1100])
    const hit = findSlot(results, itemMatcher(itemName, spec))
    if (hit < 0) throw new ShopError('NOT_FOUND', `"${query}" has no ${itemName} in the search results`)
    const sign2 = this.expectSign()
    await pause(this.cfg.clickDelayMs, [450, 1100])
    await bot.clickWindow(hit, 0, 0)
    await this.typeSign(sign2, String(amount))
    const back = await this.nextWindow(results)
    this.logger.info(`shop: ${itemName} added to Quick Buy`)
    return back || bot.currentWindow
  }

  async locate (win, itemName, spec) {
    const test = itemMatcher(itemName, spec)
    const pages = Math.max(0, Number(this.cfg.pages ?? 4))
    for (let page = 0; page <= pages; page++) {
      const index = findSlot(win, test)
      if (index >= 0) return { index, win }
      const next = findSlot(win, textMatcher(this.cfg.nextPageMatch || 'next|>>|»|›'))
      if (next < 0) break
      await pause(this.cfg.clickDelayMs, [450, 1100])
      win = await this.clickAndSettle(win, next)
      await pause([300, 700], [300, 700])
    }
    return { index: -1, win }
  }

  async openShop () {
    const bot = this.bot
    const wait = this.lastCommandAt + Number(this.cfg.commandCooldownMs || 5000) - Date.now()
    if (wait > 0) await sleep(wait + rand(0, 600))
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch {} await sleep(250) }
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bot.removeListener('windowOpen', on); reject(new ShopError('NO_WINDOW', `no menu opened after ${this.cfg.command || '/shop'}${this.serverReply(8000) ? ` (server: ${this.serverReply(8000)})` : ''}`)) }, Number(this.cfg.openTimeoutMs || 7000))
      const on = w => { clearTimeout(timer); resolve(w) }
      bot.once('windowOpen', on)
    })
    opened.catch(() => {})
    this.lastCommandAt = Date.now()
    this.stats.visits++
    bot.chat(this.cfg.command || '/shop')
    const win = await opened
    await this.waitFilled(win)
    return win
  }

  // the menu content arrives a moment after the window opens
  async waitFilled (win) {
    const t0 = Date.now()
    while (Date.now() - t0 < 3000) {
      const { start, end } = containerSlots(win)
      for (let i = start; i < end; i++) if (win.slots[i]) return
      await sleep(80)
    }
  }

  async clickAndSettle (win, slot) {
    const bot = this.bot
    const signature = () => win.slots.map(s => (s ? `${s.name}:${s.count}` : '-')).join(',')
    const first = signature()
    await bot.clickWindow(slot, 0, 0)
    const t0 = Date.now()
    while (Date.now() - t0 < 3000) {
      await sleep(80)
      if (bot.currentWindow && bot.currentWindow !== win) { win = bot.currentWindow; await this.waitFilled(win); return win }
      if (signature() !== first) return win
    }
    return win
  }

  async waitForMore (itemName, had, timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const now = this.count(itemName)
      if (now > had) return now
      await sleep(60)
    }
    return 0
  }

  async closeShop (win) {
    try { await sleep(rand(250, 700)); if (this.bot.currentWindow) this.bot.closeWindow(this.bot.currentWindow) } catch {}
    await sleep(200)
  }
}

module.exports = { Shop, ShopError, flattenText, itemText, findSlot, itemMatcher, textMatcher }
