'use strict'
// Player commands that move a person around a normal server: /sethome N, /home N, /delhome N (three slots) and
// /tpa <teammate> answered by that teammate's /tpaccept. They are used as the LAST step: only when real walking,
// bridging, pillaring and pearls have failed repeatedly for the same place, or to get back to the site after a
// death / a join far away. No operator command is involved.
const fs = require('fs')
const path = require('path')
const { sleep } = require('../util/async')

const rand = (a, b) => a + Math.random() * (b - a)
const d3 = (a, b) => Math.hypot(a.x - b.x, (a.y - b.y) * 1.5, a.z - b.z)
const center = p => ({ x: Math.floor(p.x) + 0.5, y: Math.floor(p.y), z: Math.floor(p.z) + 0.5 })

class Teleporter {
  constructor ({ bot, config, logger, fleet = null, stateDir = null, nav = null }) {
    this.bot = bot
    this.config = config
    this.logger = logger
    this.fleet = fleet
    this.nav = nav
    this.file = stateDir ? path.join(stateDir, `homes-${String(bot.username || 'bot').replace(/[^\w.-]/g, '_')}.json`) : null
    this.homes = {}
    this.lastCommandAt = 0
    this.recent = []
    this.trouble = new Map()
    this.cooldownUntil = 0
    this.bad = new Map() // method key -> until
    this.lastHomeSetAt = 0
    this.busy = false
    this.load()
    this.listen()
  }

  get cfg () { return this.config.teleport || {} }
  get enabled () { return this.cfg.enabled !== false && (this.cfg.homes !== false || this.cfg.tpa !== false) }
  get maxHomes () { return Math.max(1, Math.min(3, Number(this.cfg.maxHomes ?? 3))) }
  cmd (name) { return (this.cfg.commands && this.cfg.commands[name]) || `/${name}` }

  load () {
    if (!this.file) return
    try { this.homes = JSON.parse(fs.readFileSync(this.file, 'utf8')).homes || {} } catch { this.homes = {} }
  }

  save () {
    if (!this.file) return
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ homes: this.homes }, null, 2)) } catch { /* optional */ }
  }

  // ---- chat in / out --------------------------------------------------------------------------
  listen () {
    this.bot.on('messagestr', raw => {
      const text = String(raw)
      this.recent.push({ at: Date.now(), text: text.slice(0, 200) })
      while (this.recent.length > 14) this.recent.shift()
      if (this.cfg.tpa === false || !this.fleet?.ids) return
      const re = new RegExp(this.cfg.acceptPattern || 'request(ed)? to teleport to you|wants to teleport to you|tpa request|teleport request', 'i')
      if (!re.test(text)) return
      const who = this.fleet.ids.find(n => n !== this.bot.username && text.toLowerCase().includes(n.toLowerCase()))
      if (!who) return // only teammates are ever accepted
      if (Date.now() - (this.lastAccept || 0) < 2500) return
      this.lastAccept = Date.now()
      this.logger.info(`teleport: ${who} asks to come to me, accepting`)
      setTimeout(() => { try { this.bot.chat(this.cmd('tpaccept')); this.lastCommandAt = Date.now() } catch { /* offline */ } }, rand(900, 2200))
    })
  }

  said (sinceMs = 3000) { const t = Date.now() - sinceMs; return this.recent.filter(r => r.at >= t).map(r => r.text).join(' / ') }

  async say (command) {
    const gap = Number(this.cfg.commandGapMs ?? 4500)
    const wait = this.lastCommandAt + gap - Date.now()
    if (wait > 0) await sleep(wait + rand(0, 700))
    await sleep(rand(250, 700))
    this.bot.chat(command)
    this.lastCommandAt = Date.now()
  }

  standStill () {
    try { this.nav?.stop?.() } catch { /* ignore */ }
    try { this.bot.clearControlStates() } catch { /* ignore */ }
    return sleep(rand(250, 500))
  }

  // wait until the bot has been moved by the server (teleport) or `ok(pos)` holds
  async arrived (from, ok, timeoutMs) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const p = this.bot.entity?.position
      if (p && (ok(p) || Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) > 6)) { await sleep(rand(700, 1400)); return true }
      await sleep(250)
    }
    return false
  }

  // ---- homes ----------------------------------------------------------------------------------
  async setHome (slot, why = '') {
    if (this.cfg.homes === false || !(slot >= 1 && slot <= this.maxHomes)) return false
    if (this.bad.get('sethome') > Date.now()) return false
    const p = this.bot.entity?.position
    if (!p) return false
    await this.standStill()
    if (this.homes[slot]) { await this.say(`${this.cmd('delhome')} ${slot}`); await sleep(rand(1200, 2200)) }
    await this.say(`${this.cmd('sethome')} ${slot}`)
    await sleep(rand(1100, 1800))
    if (/limit|maximum|too many|not allowed|no permission|cannot|can't|denied/i.test(this.said(3500))) {
      this.bad.set('sethome', Date.now() + 10 * 60_000)
      this.logger.warn(`teleport: /sethome ${slot} refused (${this.said(3500)})`)
      return false
    }
    this.homes[slot] = { ...center(p), at: Date.now(), why }
    this.lastHomeSetAt = Date.now()
    this.save()
    this.logger.info(`teleport: home ${slot} set at ${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)} ${why}`)
    return true
  }

  async delHome (slot) {
    if (!this.homes[slot]) return false
    await this.say(`${this.cmd('delhome')} ${slot}`)
    delete this.homes[slot]
    this.save()
    await sleep(rand(1000, 1800))
    return true
  }

  nearestHome (target, maxDist = Infinity) {
    let best = null
    for (const [slot, h] of Object.entries(this.homes)) {
      const d = d3(h, target)
      if (d <= maxDist && (!best || d < best.dist)) best = { slot: Number(slot), dist: d, home: h }
    }
    return best
  }

  async goHome (slot) {
    const h = this.homes[slot]
    if (!h || this.cfg.homes === false) return false
    const q = this.bot.entity.position; const from = { x: q.x, y: q.y, z: q.z }
    await this.standStill()
    await this.say(`${this.cmd('home')} ${slot}`)
    const ok = await this.arrived(from, p => d3(p, h) < 8, Number(this.cfg.warmupMs ?? 14000))
    if (!ok) { this.logger.warn(`teleport: /home ${slot} did not move me (${this.said(6000) || 'no message'})`); this.bad.set(`home${slot}`, Date.now() + 3 * 60_000) }
    return ok
  }

  // ---- teammates ------------------------------------------------------------------------------
  teammateNear (target, radius) {
    const workers = this.fleet?.coord?.workers
    if (!workers) return null
    let best = null
    for (const w of workers.values()) {
      if (w.id === this.bot.username || !w.pos || Date.now() - (w.beat || 0) > 30_000) continue
      if (this.bad.get(`tpa:${w.id}`) > Date.now()) continue
      const d = d3(w.pos, target)
      if (d <= radius && (!best || d < best.dist)) best = { id: w.id, dist: d, pos: w.pos }
    }
    return best
  }

  async tpaTo (mate) {
    const q = this.bot.entity.position; const from = { x: q.x, y: q.y, z: q.z }
    await this.standStill()
    await this.say(`${this.cmd('tpa')} ${mate.id}`)
    const ok = await this.arrived(from, p => d3(p, mate.pos) < 8, Number(this.cfg.tpaWaitMs ?? 30000))
    if (!ok) { this.logger.warn(`teleport: ${mate.id} did not answer /tpa`); this.bad.set(`tpa:${mate.id}`, Date.now() + 2 * 60_000) }
    return ok
  }

  // ---- decisions ------------------------------------------------------------------------------
  // called by the navigation as its very last resort. Returns true when the bot was teleported somewhere better.
  async assist (target) {
    if (!this.enabled || this.busy || Date.now() < this.cooldownUntil || !this.bot.entity) return false
    const key = `${Math.floor(target.x / 3)},${Math.floor(target.y / 3)},${Math.floor(target.z / 3)}`
    const rec = this.trouble.get(key) || { n: 0, first: Date.now() }
    rec.n++; rec.last = Date.now(); this.trouble.set(key, rec)
    if (this.trouble.size > 200) this.trouble.clear()
    const minFail = Number(this.cfg.minFailures ?? 3)
    const minMs = Number(this.cfg.minStuckMs ?? 45_000)
    if (rec.n < minFail || Date.now() - rec.first < minMs) return false // not "really stuck" yet: keep walking/building
    const pos = this.bot.entity.position
    const here = d3(pos, target)
    this.busy = true
    try {
      const options = []
      if (this.cfg.tpa !== false) {
        const mate = this.teammateNear(target, Number(this.cfg.assistRadius ?? 12))
        if (mate && d3(pos, mate.pos) > 6) options.push({ kind: 'tpa', dist: mate.dist, mate })
      }
      if (this.cfg.homes !== false) {
        const h = this.nearestHome(target, here - 8)
        if (h && !(this.bad.get(`home${h.slot}`) > Date.now())) options.push({ kind: 'home', dist: h.dist, slot: h.slot })
      }
      options.sort((a, b) => a.dist - b.dist)
      for (const o of options) {
        this.logger.info(`teleport: stuck on ${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)} (${rec.n} failures): ${o.kind === 'tpa' ? `/tpa ${o.mate.id}` : `/home ${o.slot}`}`)
        const ok = o.kind === 'tpa' ? await this.tpaTo(o.mate) : await this.goHome(o.slot)
        if (ok) { this.trouble.delete(key); this.cooldownUntil = Date.now() + Number(this.cfg.cooldownMs ?? 60_000); return true }
      }
      this.cooldownUntil = Date.now() + 20_000
      return false
    } finally { this.busy = false }
  }

  // back to the work after a death or a join far away
  async returnToWork (target, why = '') {
    if (!this.enabled || this.busy || !this.bot.entity || !target) return false
    const far = Number(this.cfg.farFromSiteBlocks ?? 70)
    if (d3(this.bot.entity.position, target) < far) return false
    const h = this.nearestHome(target)
    if (!h || this.bad.get(`home${h.slot}`) > Date.now() || h.dist > d3(this.bot.entity.position, target) - 20) return false
    this.busy = true
    try { this.logger.info(`teleport: ${why || 'far from the site'}: /home ${h.slot}`); return await this.goHome(h.slot) } finally { this.busy = false }
  }

  // keep up to three useful homes: one at the base, others at working levels that took real effort to reach
  async maintain (workSite, standing) {
    if (!this.enabled || this.cfg.homes === false || this.busy || !this.bot.entity || !standing) return false
    if (Date.now() - this.lastHomeSetAt < Number(this.cfg.homeSetGapMs ?? 8 * 60_000)) return false
    const pos = this.bot.entity.position
    const free = []
    for (let s = 1; s <= this.maxHomes; s++) if (!this.homes[s]) free.push(s)
    const nearHome = this.nearestHome(pos)
    // a spot is worth a home when it is far from every saved home (a long walk or a big climb away)
    const worth = !nearHome || nearHome.dist > Number(this.cfg.homeSpacing ?? 30)
    if (!worth) return false
    if (workSite && d3(pos, workSite) > 25) return false // only at the place where work actually happens
    this.busy = true
    try {
      let slot = free[0]
      if (!slot) {
        // replace the home that is farthest from the current work (never the base while it is the only close one)
        let worst = null
        for (const [s, h] of Object.entries(this.homes)) { const d = workSite ? d3(h, workSite) : 0; if (!worst || d > worst.d) worst = { s: Number(s), d } }
        if (!worst || worst.d < Number(this.cfg.homeSpacing ?? 30)) return false
        slot = worst.s
      }
      return await this.setHome(slot, free.length ? 'staging' : 'replaced')
    } finally { this.busy = false }
  }
}

module.exports = { Teleporter, d3 }
