'use strict'
// The intelligence core. Three jobs, all with written reasons (every decision is logged as "BRAIN: ..." and stored in events.<name>.jsonl):
//  1. preflight(task): look at what is around before acting (leaks, hazards, other bots, own health) and say go / wait, with the reasons.
//  2. leak mode: while stray fluid is loose, nothing that adds fluid runs, and nothing is built next to it.
//  3. strategy book: for each kind of problem (stuck, loop, leak...) an ordered list of ways out; the order is re-ranked by what has
//     actually worked on this server (success rates persisted in <stateDir>/intel.<name>.json), every attempt is recorded.
const fs = require('fs')
const path = require('path')

const HARD = new Set(['leak-near', 'leak-active', 'low-health', 'lava-beside'])

class StrategyBook {
  constructor (file, defaults) {
    this.file = file
    this.defaults = defaults // { problem: [id, id, ...] }
    this.stats = {} // problem -> id -> { ok, fail, ms }
    try { if (file && fs.existsSync(file)) this.stats = JSON.parse(fs.readFileSync(file, 'utf8')).stats || {} } catch { this.stats = {} }
  }

  score (problem, id) {
    const s = (this.stats[problem] || {})[id] || { ok: 0, fail: 0 }
    const idx = (this.defaults[problem] || []).indexOf(id)
    return (s.ok + 1) / (s.ok + s.fail + 2) - idx * 0.04 // success rate with a mild prior towards the designed order
  }

  order (problem, available) {
    const ids = (this.defaults[problem] || []).filter(id => !available || available.includes(id))
    return ids.map(id => ({ id, score: this.score(problem, id) })).sort((a, b) => b.score - a.score)
  }

  record (problem, id, ok, ms) {
    const row = ((this.stats[problem] = this.stats[problem] || {})[id] = this.stats[problem][id] || { ok: 0, fail: 0, ms: 0 })
    if (ok) row.ok++; else row.fail++
    row.ms += ms || 0
    this.save()
  }

  save () { try { if (this.file) { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ version: 1, stats: this.stats }, null, 1)) } } catch { /* ok */ } }
}

const DEFAULT_LADDERS = {
  stuck: ['unstick', 'escape', 'abort-task', 'retreat-home'],
  loop: ['escape', 'abort-task', 'unstick', 'retreat-home'],
  leak: ['retreat', 'contain', 'wait'],
  'lava-near': ['retreat', 'contain']
}

class Engine {
  constructor ({ bot, world, config, logger, recorder, getPlanner, getPlacer, exit, navigation, scaffold, stateDir, name }) {
    Object.assign(this, { bot, world, config, logger, recorder, getPlanner, getPlacer, exit, navigation, scaffold, name })
    this.leak = { active: false, cells: new Set(), since: 0 }
    this.book = new StrategyBook(stateDir ? path.join(stateDir, `intel.${name || 'bot'}.json`) : null, DEFAULT_LADDERS)
    this.busy = false
    this.stats = { preflights: 0, deferred: 0, solved: 0, unsolved: 0 }
    this.pfCount = new Map()
  }

  say (text, data = {}) {
    this.logger.info(`BRAIN: ${text}`)
    this.recorder?.decision(text, data)
  }

  // ---- 1. preflight -----------------------------------------------------------------------------------------------------------------
  strayNear (pos, r) {
    for (const k of this.leak.cells) {
      const [x, y, z] = k.split(',').map(Number)
      if (Math.abs(x - pos.x) <= r && Math.abs(y - pos.y) <= r && Math.abs(z - pos.z) <= r) { const b = this.world.blockAt({ x, y, z }); if (b && b.name === 'lava') return k }
    }
    return null
  }

  refreshLeak () {
    if (!this.leak.active) return
    for (const k of [...this.leak.cells]) { const [x, y, z] = k.split(',').map(Number); const b = this.world.blockAt({ x, y, z }); if (!b || b.name !== 'lava') this.leak.cells.delete(k) }
    if (!this.leak.cells.size || Date.now() - this.leak.since > 180_000) { this.say(`leak mode off (${this.leak.cells.size ? 'timeout' : 'no stray lava left'})`); this.leak.active = false; this.leak.cells.clear() }
  }

  preflight (task) {
    this.stats.preflights++
    this.refreshLeak()
    const reasons = []; let delay = 0
    const w = task.world
    const add = (code, why, ms) => { reasons.push({ code, why }); delay = Math.max(delay, ms) }
    const fluidTask = task.kind === 'fluid' || task.kind === 'waterlog'
    const isLavaTask = task.kind === 'fluid' && (task.name === 'lava' || task.item === 'lava_bucket')
    if (fluidTask && this.leak.active) add('leak-active', `stray ${[...this.leak.cells].length} lava cell(s) are loose: no new fluid until they are gone`, 12_000)
    if (isLavaTask) {
      if (Number(this.bot.health) < 10) add('low-health', `health ${this.bot.health}: a pour needs room to retreat`, 8000)
      if (this.playersNear(w, 3).length) add('fluid-crowded', `another player/bot within 3 blocks of the pour at ${w.x},${w.y},${w.z}`, 1500)
    }
    const stray = this.leak.active ? this.strayNear(w, 6) : null
    if (stray && !fluidTask) add('leak-near', `stray lava at ${stray} is within 6 blocks of ${task.name} at ${w.x},${w.y},${w.z}`, 8000)
    if (this.lavaBeside(w) && !fluidTask) add('lava-beside', `lava next to the target cell ${w.x},${w.y},${w.z}`, 6000)
    if (!reasons.length) return { go: true, reasons }
    // soft reasons never block forever: the 4th time the same task is held back for a soft reason it goes ahead
    const hard = reasons.some(r => HARD.has(r.code))
    const n = (this.pfCount.get(task.key) || 0) + 1; this.pfCount.set(task.key, n)
    if (!hard && n > 3) return { go: true, reasons: [], overridden: true }
    if (hard && n > 12) { this.say(`${task.name} at ${task.key}: waited ${n} times for ${reasons.map(r => r.code).join('+')}; letting the normal rules handle it`); return { go: true, reasons: [], overridden: true } }
    this.stats.deferred++
    return { go: false, reasons, delayMs: delay }
  }

  defer (task, pf) {
    task.status = 'deferred'; task.deferredUntil = Date.now() + (pf.delayMs || 5000)
    if (this.pfLogAt === undefined || Date.now() - this.pfLogAt > 4000) { this.pfLogAt = Date.now(); this.say(`holding ${task.name} at ${task.key} for ${((pf.delayMs || 0) / 1000).toFixed(0)}s: ${pf.reasons.map(r => r.why).join('; ')}`, { task: task.key, codes: pf.reasons.map(r => r.code) }) }
  }

  playersNear (p, r) {
    const out = []; const me = this.bot.entity
    try { for (const id in this.bot.entities) { const e = this.bot.entities[id]; if (!e || e === me || e.type !== 'player' || !e.position) continue; if (Math.hypot(e.position.x - (p.x + 0.5), e.position.y - p.y, e.position.z - (p.z + 0.5)) < r) out.push(e.username || id) } } catch { /* ok */ }
    return out
  }

  lavaBeside (p) {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const b = this.world.blockAt({ x: p.x + dx, y: p.y + dy, z: p.z + dz })
      if (b && b.name === 'lava') { const planner = this.getPlanner(); const k = `${p.x + dx},${p.y + dy},${p.z + dz}`; if (!planner || !planner.fluidCells.has(k)) return true }
    }
    return false
  }

  // ---- 2. leak mode -----------------------------------------------------------------------------------------------------------------
  onLeak (lk, cls) {
    if (lk.kind !== 'lava') {
      // Water flows naturally in channels and waterlogged builds without burning or destroying blocks; never halt bots for water.
      this.recorder?.decision(`water flow observed at ${lk.first} (${cls?.cause || 'water'}); continuing build`, { cause: cls?.cause })
      return
    }
    this.leak.active = true; this.leak.since = Date.now()
    for (const c of lk.cells) this.leak.cells.add(c)
    this.say(`LEAK MODE on: ${lk.kind} at ${lk.first} (${cls.cause}); fluid tasks are held and builders keep away until it is covered`, { cause: cls.cause })
    this.solve('leak', {}).catch(() => {})
  }

  onNearLava (info) {
    const p = this.bot.entity && this.bot.entity.position; if (!p || !info.lava) return
    const k = `${Math.floor(p.x) + info.lava[0]},${Math.floor(p.y) + info.lava[1]},${Math.floor(p.z) + info.lava[2]}`
    const planner = this.getPlanner()
    if (planner && planner.fluidCells.has(k)) return // lava the design wants: the build handles it
    if (this.bot.recovery?.escaping || this.exit?.running) return
    this.say(`lava beside me at ${k} and the design does not want it there: backing away`, { cell: k })
    this.solve('lava-near', { why: `lava at ${k}` }).catch(() => {})
  }

  onDamage (cls) {
    if (cls.category === 'lava' || cls.category === 'fire') {
      if (this.bot.recovery?.escaping || this.exit?.running) return
      const p = this.bot.entity?.position
      const f = p ? p.floored() : null
      const inOrOnHazard = Boolean(
        this.bot.entity?.isInLava ||
        (f && /^(lava|fire|soul_fire|magma_block)$/.test(this.world.blockAt(f)?.name || '')) ||
        (f && /^(lava|fire|soul_fire|magma_block)$/.test(this.world.blockAt(f.offset(0, -1, 0))?.name || '') && !this.bot.entity?.onGround)
      )
      if (!inOrOnHazard) return
      this.say(`taking ${cls.category} damage (${cls.cause}): getting out`)
      this.solve('lava-near', { why: cls.cause }).catch(() => {})
    }
  }

  // ---- 3. strategy book ------------------------------------------------------------------------------------------------------------
  strategies () {
    const nav = this.navigation; const exit = this.exit; const placer = this.getPlacer?.()
    return {
      unstick: async () => { await nav.unstick(); return this.moved() },
      escape: async () => (await exit.escape({ why: 'brain: stuck', force: true, maxMs: 60_000 })).escaped === true,
      'abort-task': async () => { placer?.abortActive('brain: giving this task a new start'); nav.stop(); return true },
      'retreat-home': async () => { const t = this.scaffold?.homeCell || null; if (!t) return false; await nav.goTo(t, 2, 20_000, { human: true, rescue: false }); return true },
      retreat: async () => {
        if (this.bot.entity?.isInLava && this.bot.builder?.survival) {
          const out = await this.bot.builder.survival.escapeLava(8000).catch(() => false)
          if (out) return true
        }
        return (await exit.escape({ why: 'brain: leak', lava: true, force: true, maxMs: 30_000 })).escaped !== false
      },
      contain: async () => (await exit.containStray()) > 0,
      wait: async () => true
    }
  }

  moved () { const f = this.recorder?.frames; if (!f || f.length < 6) return true; const a = f[f.length - 6]; const b = f[f.length - 1]; return Math.hypot(a.x - b.x, a.z - b.z) > 0.3 }

  async solve (problem, ctx = {}) {
    if (this.busy) return false
    this.busy = true
    try {
      const impl = this.strategies()
      const ranked = this.book.order(problem, Object.keys(impl))
      this.say(`problem "${problem}"${ctx.why ? ` (${ctx.why})` : ''}: trying ${ranked.map(r => `${r.id}(${r.score.toFixed(2)})`).join(' > ')}`)
      for (const r of ranked) {
        const t0 = Date.now(); let ok = false
        try { ok = Boolean(await impl[r.id](ctx)) } catch (error) { this.say(`${r.id} failed: ${error.message}`) }
        this.book.record(problem, r.id, ok, Date.now() - t0)
        if (ok) { this.stats.solved++; this.say(`"${problem}" handled by ${r.id} in ${Date.now() - t0} ms`); return true }
      }
      this.stats.unsolved++
      this.say(`"${problem}": nothing worked, leaving it to the normal retry rules`)
      return false
    } finally { this.busy = false }
  }
}

module.exports = { Engine, StrategyBook, DEFAULT_LADDERS, HARD }
