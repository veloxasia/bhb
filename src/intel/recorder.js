'use strict'
// Flight recorder: a rolling picture of what the bot did and what was around it, so that every failure (death, damage, leak, stuck,
// loop, rubber-banding, failed task) leaves a postmortem with the CAUSE, the reasons, the evidence and the fix.
//   <stateDir>/events.<name>.jsonl      every notable event (one line each)
//   <stateDir>/postmortems/*.json       one file per serious incident: last 20 s of frames + log lines + blocks around + classification
//   <stateDir>/diagnosis.<name>.md      rolling summary: counts per category, deaths, leaks, stuck spots, failing tasks, what to do
const fs = require('fs')
const path = require('path')
const { Logger } = require('../core/logger')
const { classifyDamage, classifyLeak, classifyStuck, classifyLine } = require('./causes')

const FRAME_MS = 250
const cellKey = (x, y, z) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
const solidName = n => n && !/^(air|cave_air|void_air|water|lava)$/.test(n)

class FlightRecorder {
  constructor ({ bot, world, config, logger, name, getPlanner, getScaffold, getPhase, getTask, isActive = () => true, dir = null }) {
    Object.assign(this, { bot, world, config, logger, name, getPlanner, getScaffold, getPhase, getTask, isActive })
    this.dir = dir || Logger.dir()
    this.frames = []
    this.history = new Map() // 'x,y,z' -> [{t,from,to,by,phase}]
    this.recentDigs = new Map() // 'x,y,z' -> t (this bot broke it)
    this.pours = []
    this.tasks = []
    this.counts = {}
    this.samples = {}
    this.deaths = []; this.leaks = []; this.stucks = []; this.damage = []
    this.failures = new Map()
    this.lastHp = null
    this.lastFood = null
    this.forced = []
    this.postCount = 0
    this.throttle = new Map()
    this.started = Date.now()
    this.timers = []
    this.listeners = []
    this.untap = null
    this.stats = { blocksPlaced: 0, blocksBroken: 0 }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------------
  start () {
    if (this.timers.length) return
    const bot = this.bot
    const on = (ev, fn) => { bot.on(ev, fn); this.listeners.push([ev, fn]) }
    on('health', () => this.onHealth())
    on('death', () => this.onDeath())
    on('blockUpdate', (o, n) => this.onBlock(o, n))
    on('forcedMove', () => this.onForced())
    on('kicked', r => this.event('kicked', { reason: String(r).slice(0, 300) }, 'error'))
    on('end', r => this.event('disconnected', { reason: String(r) }, 'error'))
    this.timers.push(setInterval(() => { try { this.tick() } catch (e) { this.countOnly('recorder-error', e.message) } }, FRAME_MS))
    this.timers.push(setInterval(() => { try { this.writeSummary() } catch { /* never throws */ } }, 60_000))
    for (const t of this.timers) t.unref?.()
    this.untap = Logger.tap((prefix, level, text) => { if (prefix && this.name && prefix !== this.name) return; this.onLogLine(level, text) })
    this.event('recorder-start', { worker: this.name })
  }

  stop () {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const [ev, fn] of this.listeners) this.bot.removeListener(ev, fn)
    this.listeners = []
    this.untap?.()
    try { this.writeSummary() } catch { /* ok */ }
  }

  // ---- generic event stream ----------------------------------------------------------------------------------------------------------
  event (kind, data = {}, severity = 'info') {
    const rec = { t: new Date().toISOString(), w: this.name, kind, sev: severity, ...data }
    this.count(kind)
    if (this.dir) Logger.write(`events.${this.name || 'bot'}.jsonl`, JSON.stringify(rec) + '\n')
    return rec
  }

  count (cat, sample) {
    this.counts[cat] = (this.counts[cat] || 0) + 1
    if (sample && !this.samples[cat]) this.samples[cat] = String(sample).slice(0, 200)
  }

  countOnly (cat, sample) { this.count(cat, sample) }

  // ---- tasks / actions (called through thin wrappers set up by the builder) ----------------------------------------------------------
  taskStart (task) { this.tasks.push({ t: Date.now(), name: task.name, key: task.key, kind: task.kind, phase: 'start' }); if (this.tasks.length > 40) this.tasks.shift(); this.curTask = { name: task.name, key: task.key, t: Date.now() }; this.event('task-start', { task: task.name, at: task.key, attempts: task.attempts, pos: this.pos(), hp: this.bot.health }) }
  taskEnd (task, ms) { this.tasks.push({ t: Date.now(), name: task.name, key: task.key, phase: 'ok', ms }); if (this.tasks.length > 40) this.tasks.shift(); this.curTask = null; this.stats.tasksOk = (this.stats.tasksOk || 0) + 1; this.event('task-ok', { task: task.name, at: task.key, ms }) }
  taskFail (task, error) {
    const k = `${task.name}|${error.code || 'ERR'}`
    const row = this.failures.get(k) || { n: 0, at: new Set(), msg: '' }
    row.n++; row.at.add(task.key); row.msg = String(error.message).slice(0, 200)
    this.failures.set(k, row)
    this.tasks.push({ t: Date.now(), name: task.name, key: task.key, phase: 'fail', code: error.code || 'ERR', msg: String(error.message).slice(0, 160) })
    if (this.tasks.length > 40) this.tasks.shift()
    this.curTask = null
    this.event('task-fail', { task: task.name, at: task.key, code: error.code || 'ERR', msg: String(error.message).slice(0, 200), phase: this.getPhase?.(), pos: this.pos(), attempts: task.attempts }, 'warn')
    this.count(`task-fail:${error.code || 'ERR'}`, `${task.name} ${task.key}: ${error.message}`)
    if (row.n === 5 || row.n === 25) this.postmortem('task-failures', { cause: `${row.n} x ${k}`, reasons: [`the same kind of failure keeps repeating (${row.at.size} different blocks)`, row.msg], fix: 'see the failure code table in diagnosis.md' }, 'warn')
  }

  dig (pos, why) { const k = cellKey(pos.x, pos.y, pos.z); this.recentDigs.set(k, Date.now()); this.stats.blocksBroken++; if (this.recentDigs.size > 400) { for (const [kk, t] of this.recentDigs) { if (Date.now() - t > 60_000) this.recentDigs.delete(kk) } } this.event('dig', { at: k, why: why || this.getPhase?.() }) }

  // a pour is the moment a leak is decided: remember what the safety check saw
  pour (task, check, extra = {}) {
    const rec = { t: Date.now(), key: task.key, name: task.name, check: check ? { blocked: Boolean(check.blocked), why: check.why || null, leaks: (check.leaks || []).slice(0, 4) } : null, bot: this.pos(), forced: Boolean(extra.forced), neighbours: this.neighbourhood(task.world, 2) }
    this.pours.push(rec); if (this.pours.length > 40) this.pours.shift()
    this.event('pour', { at: task.key, fluid: task.name, check: rec.check, forced: rec.forced })
  }

  decision (text, data = {}) { this.event('decision', { text, ...data }) }

  // ---- state helpers ---------------------------------------------------------------------------------------------------------------
  pos () { const e = this.bot.entity; return e ? [+e.position.x.toFixed(2), +e.position.y.toFixed(2), +e.position.z.toFixed(2)] : null }
  nameAt (x, y, z) { try { const b = this.world.blockAt({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }); return b ? b.name : 'unloaded' } catch { return 'unloaded' } }
  neighbourhood (p, r) {
    const out = {}
    for (let dx = -r; dx <= r; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -r; dz <= r; dz++) { const n = this.nameAt(p.x + dx, p.y + dy, p.z + dz); if (n !== 'air') out[`${dx},${dy},${dz}`] = n }
    return out
  }

  slice (center, rx = 4, ry = 3, rz = 4) {
    const legend = {}; const names = {}; let next = 0
    const code = n => { if (n === 'air' || n === 'cave_air') return '.'; if (n === 'lava') return 'L'; if (n === 'water') return 'W'; if (n === 'unloaded') return '?'; if (!names[n]) { names[n] = String.fromCharCode(97 + (next++ % 26)); legend[names[n]] = n } return names[n] }
    const layers = {}
    const cx = Math.floor(center.x); const cy = Math.floor(center.y); const cz = Math.floor(center.z)
    for (let dy = ry; dy >= -2; dy--) {
      const rows = []
      for (let dz = -rz; dz <= rz; dz++) { let row = ''; for (let dx = -rx; dx <= rx; dx++) row += code(this.nameAt(cx + dx, cy + dy, cz + dz)); rows.push(row) }
      layers[`y${dy >= 0 ? '+' : ''}${dy}`] = rows
    }
    return { origin: [cx, cy, cz], note: 'rows run north->south (z-), columns west->east (x+); y0 is the feet cell; L lava, W water, . air, ? unloaded', legend, layers }
  }

  // ---- frames + detectors -----------------------------------------------------------------------------------------------------------
  tick () {
    const e = this.bot.entity
    if (!e) return
    const p = e.position
    const f = {
      t: Date.now(), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), vy: +e.velocity.y.toFixed(2), hs: +Math.hypot(e.velocity.x, e.velocity.z).toFixed(2),
      g: e.onGround ? 1 : 0, hp: this.bot.health, food: this.bot.food, ph: this.getPhase?.() || '', task: this.curTask ? this.curTask.key : null,
      feet: this.nameAt(p.x, p.y, p.z), head: this.nameAt(p.x, p.y + 1.62, p.z), below: this.nameAt(p.x, p.y - 0.2, p.z), yaw: +e.yaw.toFixed(2), pitch: +e.pitch.toFixed(2)
    }
    this.frames.push(f)
    if (this.frames.length > 320) this.frames.splice(0, 80)
    if (!this.isActive()) return
    if (this.once('beat', 5000)) this.event('beat', { pos: this.pos(), hs: f.hs, g: f.g, hp: f.hp, food: f.food, phase: f.ph, task: f.task, feet: f.feet })
    this.detectNearLava(f)
    this.detectStuck(f)
    this.detectLoop()
  }

  detectNearLava (f) {
    if (f.feet === 'lava' || f.head === 'lava') return // handled by damage
    const e = this.bot.entity
    let lava = null
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) { if (this.nameAt(e.position.x + dx, e.position.y + dy, e.position.z + dz) === 'lava') { lava = [dx, dy, dz]; break } }
    if (lava && this.once('near-lava', 6000)) { this.event('near-lava', { at: this.pos(), lava, phase: f.ph, task: f.task }, 'warn'); this.onNearLava?.({ lava }) }
  }

  detectStuck (f) {
    const n = Math.round(10_000 / FRAME_MS)
    if (this.frames.length < n) return
    const win = this.frames.slice(-n)
    const a = win[0]
    const moved = Math.hypot(f.x - a.x, f.z - a.z) + Math.abs(f.y - a.y)
    const phases = new Set(win.map(x => x.ph))
    const allWorking = win.every(x => x.task && !/between|planning|waiting|paused/i.test(x.ph))
    if (moved < 0.4 && phases.size <= 2 && allWorking && this.once('stuck', 45_000)) {
      const cls = classifyStuck({ kind: 'stuck', phase: f.ph, secs: 10, around: this.openAround() })
      this.stucks.push({ at: this.pos(), phase: f.ph, cause: cls.cause, t: Date.now() }); if (this.stucks.length > 30) this.stucks.shift()
      this.postmortem('stuck', cls, 'warn')
    }
  }

  detectLoop () {
    const n = Math.round(12_000 / FRAME_MS)
    if (this.frames.length < n) return
    const w = this.frames.slice(-n)
    const cells = new Set(w.map(f => `${Math.floor(f.x)},${Math.floor(f.y)},${Math.floor(f.z)}`))
    let path = 0; for (let i = 1; i < w.length; i++) path += Math.hypot(w[i].x - w[i - 1].x, w[i].z - w[i - 1].z)
    if (cells.size <= 4 && path > 9 && this.once('loop', 60_000)) {
      const cls = classifyStuck({ kind: 'loop', phase: w[w.length - 1].ph, cells: cells.size, secs: 12, around: this.openAround() })
      this.stucks.push({ at: this.pos(), phase: w[w.length - 1].ph, cause: cls.cause, t: Date.now() })
      this.postmortem('loop', cls, 'warn')
      this.onLoop?.(cls)
    }
  }

  openAround () {
    const e = this.bot.entity; if (!e) return null
    let open = 0; let wall = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = this.nameAt(e.position.x + dx, e.position.y, e.position.z + dz); if (solidName(a)) wall++; else open++ }
    return { open, wall }
  }

  once (key, ms) { const now = Date.now(); const last = this.throttle.get(key) || 0; if (now - last < ms) return false; this.throttle.set(key, now); return true }

  // ---- damage / death ---------------------------------------------------------------------------------------------------------------
  mobsNear () {
    const out = []; const e = this.bot.entity
    try { for (const id in this.bot.entities) { const m = this.bot.entities[id]; if (!m || m === e || !m.position) continue; if (m.type === 'player' && (m.username === this.name || this.bot.builder?.fleet?.coord?.workers?.has?.(m.username))) continue; const d = m.position.distanceTo(e.position); if (d < 8) out.push({ name: String(m.username || m.name || m.displayName || m.type), dist: d }) } } catch { /* ok */ }
    return out
  }

  damageCtx (dmg) {
    const e = this.bot.entity; const p = e.position
    return { dmg, hp: this.bot.health, food: this.bot.food, feet: this.nameAt(p.x, p.y, p.z), head: this.nameAt(p.x, p.y + 1.62, p.z), below: this.nameAt(p.x, p.y - 0.2, p.z), oxygen: this.bot.oxygenLevel, y: p.y, minY: this.bot.game?.minY ?? -64, frames: this.frames, mobs: this.mobsNear(), onFire: Boolean(e.onFire) }
  }

  onHealth () {
    const hp = this.bot.health
    if (this.lastHp != null && hp < this.lastHp - 0.4) {
      const dmg = this.lastHp - hp
      const cls = classifyDamage(this.damageCtx(dmg))
      this.damage.push({ t: Date.now(), dmg, hp, cause: cls.cause, category: cls.category, at: this.pos() }); if (this.damage.length > 40) this.damage.shift()
      this.count(`damage:${cls.category}`, `${dmg.toFixed(1)} hp: ${cls.cause}`)
      this.event('damage', { dmg: +dmg.toFixed(1), hp, cause: cls.cause, category: cls.category, reasons: cls.reasons, at: this.pos(), phase: this.getPhase?.(), task: this.curTask?.key }, dmg >= 4 ? 'warn' : 'info')
      this.onDamage?.(cls)
      if (dmg >= 4 || hp <= 6) this.postmortem(`damage-${cls.category}`, cls, 'warn')
    }
    this.lastHp = hp
  }

  onDeath () {
    const last = this.damage[this.damage.length - 1]
    const cls = last && Date.now() - last.t < 10_000 ? { category: last.category, cause: last.cause, reasons: ['the last damage before death'], fix: 'see the damage postmortem right before this one' } : classifyDamage(this.damageCtx(20))
    this.deaths.push({ t: Date.now(), cause: cls.cause, category: cls.category, at: this.pos(), phase: this.getPhase?.(), task: this.curTask?.key })
    this.count('death', cls.cause)
    this.postmortem('death', cls, 'error')
  }

  onForced () {
    const now = Date.now(); this.forced.push(now); this.forced = this.forced.filter(t => now - t < 5000)
    if (this.forced.length >= 5 && this.once('rubberband', 30_000)) this.postmortem('rubberband', classifyStuck({ kind: 'rubberband', phase: this.getPhase?.() }), 'warn')
  }

  // ---- blocks: history + stray fluid ------------------------------------------------------------------------------------------------
  onBlock (oldB, newB) {
    try {
      if (!newB || !newB.position) return
      const k = cellKey(newB.position.x, newB.position.y, newB.position.z)
      const from = oldB ? oldB.name : 'unknown'; const to = newB.name
      if (from === to) return
      const interesting = solidName(from) !== solidName(to) || to === 'water' || to === 'lava' || from === 'water' || from === 'lava'
      if (!interesting) return
      const dug = this.recentDigs.get(k)
      const by = dug && Date.now() - dug < 4000 ? 'this bot (dig)' : (this.scaffoldHas(k) ? 'scaffold (this bot)' : 'someone else / physics')
      const row = this.history.get(k) || []
      row.push({ t: Date.now(), from, to, by, phase: this.getPhase?.() || '', temp: this.scaffoldHas(k) })
      if (row.length > 5) row.shift()
      this.history.set(k, row)
      if (this.history.size > 60_000) { let i = 0; for (const kk of this.history.keys()) { this.history.delete(kk); if (++i > 10_000) break } }
      if (solidName(to) && !solidName(from)) this.stats.blocksPlaced++
      if (to === 'water' || to === 'lava') this.onFluidBlock(k, newB, from)
      if (to === 'obsidian' && from === 'lava') this.onObsidian(k)
    } catch { /* diagnostics never throw */ }
  }

  scaffoldHas (k) { try { const sc = this.getScaffold?.(); return Boolean(sc && sc.created && sc.created.has(k)) } catch { return false } }

  onFluidBlock (k, b, from) {
    const planner = this.getPlanner?.()
    if (!planner || planner.fluidCells.has(k) || planner.tasks.has(k)) return
    const kind = b.name
    this.count(`stray-${kind}`)
    this.pendingLeak = this.pendingLeak || { cells: new Set(), kind, first: k, t: Date.now() }
    this.pendingLeak.cells.add(k)
    if (!this.leakTimer) {
      this.leakTimer = setTimeout(() => { this.leakTimer = null; try { this.flushLeak() } catch { /* ok */ } }, 1500) // let the flow settle, then explain it once
      this.leakTimer.unref?.()
    }
  }

  flushLeak () {
    const lk = this.pendingLeak; this.pendingLeak = null
    if (!lk) return
    const planner = this.getPlanner?.()
    const cells = [...lk.cells]
    // the cell nearest to a pour is the likely entry point
    const cls = classifyLeak({
      cell: lk.first, kind: lk.kind, pours: this.pours, history: this.history, now: Date.now(),
      isDesignAir: c => { const box = planner && planner.box; if (!box) return false; const [x, y, z] = c.split(',').map(Number); return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1 && !planner.tasks.has(c) },
      scaffold: this.getScaffold?.()?.created
    })
    this.leaks.push({ t: Date.now(), kind: lk.kind, first: lk.first, cells: cells.length, cause: cls.cause, evidence: cls.evidence }); if (this.leaks.length > 30) this.leaks.shift()
    this.logLine(`LEAK ANALYSIS: ${lk.kind} first seen at ${lk.first}, ${cells.length} stray cell(s): ${cls.cause}. ${cls.reasons.join(' | ')}${cls.evidence.length ? ' EVIDENCE: ' + cls.evidence.join(' | ') : ''}`)
    this.postmortem('leak', { ...cls, cells: cells.slice(0, 40) }, 'error', { cell: lk.first })
    this.onLeak?.(lk, cls)
  }

  onObsidian (k) {
    if (!this.once(`obs:${k}`, 30_000)) return
    const water = this.neighbourWater(k)
    this.event('obsidian', { at: k, waterNeighbour: water }, 'warn')
    this.logLine(`LEAK ANALYSIS: lava at ${k} turned into obsidian${water ? `: water touches it at ${water}` : ''} — water and lava are connected somewhere near; this is what a water leak does to a lava design`)
  }

  neighbourWater (k) {
    const [x, y, z] = k.split(',').map(Number)
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) { if (this.nameAt(x + dx, y + dy, z + dz) === 'water') return `${x + dx},${y + dy},${z + dz}` }
    return null
  }

  logLine (text) { try { if (this.logger) this.logger.warn(text) } catch { /* ok */ } }

  // ---- log lines: every WARN/ERROR gets a category and a reason -----------------------------------------------------------------------
  onLogLine (level, text) {
    const c = classifyLine(text)
    if (!c) return
    this.count(`log:${c.category}`, `${c.reason} | ${text.slice(0, 140)}`)
  }

  // ---- postmortem files -------------------------------------------------------------------------------------------------------------
  postmortem (type, cls, severity = 'warn', extra = {}) {
    if (!this.dir) return null
    if (!this.once(`pm:${type}`, type === 'death' ? 1000 : 20_000)) return null
    if (this.postCount >= 300) return null
    this.postCount++
    const e = this.bot.entity
    const doc = {
      time: new Date().toISOString(), worker: this.name, type, severity,
      classification: { category: cls.category, cause: cls.cause, reasons: cls.reasons, evidence: cls.evidence || [], fix: cls.fix },
      state: e ? { pos: this.pos(), hp: this.bot.health, food: this.bot.food, held: this.bot.heldItem?.name || null, onGround: e.onGround, phase: this.getPhase?.(), task: this.curTask || null } : null,
      recentTasks: this.tasks.slice(-12),
      recentPours: this.pours.slice(-6).map(p => ({ ...p, neighbours: undefined })),
      frames: this.frames.slice(-80).filter((_, i) => i % 2 === 0),
      log: Logger.recent(60, this.name),
      world: e ? this.slice(e.position) : null,
      ...extra
    }
    if (extra.cell) { const h = []; const [x, y, z] = extra.cell.split(',').map(Number); for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) { const kk = `${x + dx},${y + dy},${z + dz}`; const r = this.history.get(kk); if (r) h.push({ cell: kk, changes: r.map(c => ({ ...c, agoS: +((Date.now() - c.t) / 1000).toFixed(0), t: undefined })) }) } doc.blockHistoryNearLeak = h.slice(0, 60); doc.leakWorld = this.slice({ x, y, z }, 5, 4, 5) }
    try {
      const dir = path.join(this.dir, 'postmortems'); fs.mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.${this.name || 'bot'}.${type}.json`)
      fs.writeFileSync(file, JSON.stringify(doc, null, 1))
      this.event('postmortem', { type, file: path.basename(file), cause: cls.cause }, severity)
      this.logLine(`POSTMORTEM ${type}: ${cls.cause} -> ${path.basename(file)}`)
    } catch { /* never throws */ }
    return doc
  }

  // ---- summary ---------------------------------------------------------------------------------------------------------------------
  summaryMarkdown () {
    const lines = []
    const mins = ((Date.now() - this.started) / 60000)
    lines.push(`# Diagnosis for ${this.name || 'bot'}`, '', `Running ${mins.toFixed(1)} min | blocks placed ${this.stats.blocksPlaced} | blocks broken ${this.stats.blocksBroken} | deaths ${this.deaths.length} | leaks ${this.leaks.length} | stuck/loop ${this.stucks.length}`, '')
    const sect = (title, rows) => { if (!rows.length) return; lines.push(`## ${title}`, ...rows, '') }
    sect('Deaths', this.deaths.map(d => `- ${new Date(d.t).toISOString()} at ${d.at} — ${d.cause} (phase "${d.phase}", task ${d.task})`))
    sect('Leaks', this.leaks.map(l => `- ${new Date(l.t).toISOString()} ${l.kind} first at ${l.first} (${l.cells} cells) — ${l.cause}${l.evidence.length ? ' | ' + l.evidence.join(' | ') : ''}`))
    sect('Damage', this.damage.slice(-12).map(d => `- ${new Date(d.t).toISOString()} -${d.dmg.toFixed(1)} hp at ${d.at}: ${d.cause}`))
    sect('Stuck / loops', this.stucks.slice(-12).map(s => `- ${new Date(s.t).toISOString()} at ${s.at} in "${s.phase}": ${s.cause}`))
    const fails = [...this.failures.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => `- ${v.n}x ${k} on ${v.at.size} block(s): ${v.msg}`)
    sect('Failing tasks', fails)
    const cats = Object.entries(this.counts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `- ${v}x ${k}${this.samples[k] ? ` — ${this.samples[k]}` : ''}`)
    sect('Everything counted', cats)
    return lines.join('\n')
  }

  writeSummary () { if (!this.dir) return; fs.writeFileSync(path.join(this.dir, `diagnosis.${this.name || 'bot'}.md`), this.summaryMarkdown()) }
}

module.exports = { FlightRecorder }
