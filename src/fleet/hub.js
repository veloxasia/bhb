'use strict'
// The hub lives in the parent process. Every builder bot runs in its OWN process (own CPU core, own event loop,
// own memory), so one bot that is busy, stuck or crashing can no longer freeze or drop the others. The hub only
// relays small facts between them and remembers the job so a restarted bot goes straight back to work.
const fs = require('fs')
const path = require('path')

class Hub {
  constructor ({ logger, jobFile = null, resume = true, loginGapMs = 6000, deadAfterMs = 180_000 }) {
    this.logger = logger
    this.jobFile = jobFile
    this.loginGapMs = loginGapMs
    this.deadAfterMs = deadAfterMs
    this.channels = new Map() // id -> { id, index, ch, lastMsg }
    this.state = new Map() // id -> { id, index, role, pos, target, done, alive }
    this.tempBlocks = new Map() // key -> { x, y, z, createdAt, isAccessStep, by }
    this.log = []
    this.job = null
    this.leaderId = null
    this.loginChain = Promise.resolve()
    this.lastLogin = 0
    if (jobFile && resume) { try { this.job = JSON.parse(fs.readFileSync(jobFile, 'utf8')) } catch { this.job = null } }
  }

  attach (id, index, ch) {
    if (index === 0) this.leaderId = id
    const rec = { id, index, ch, lastMsg: Date.now() }
    this.channels.set(id, rec)
    if (!this.state.has(id)) this.state.set(id, { id, index, role: 'builder', pos: null, target: null, done: false, alive: false })
    ch.on('message', m => { rec.lastMsg = Date.now(); try { this.onMessage(id, m) } catch (error) { this.logger.warn(`hub: ${error.message}`) } })
    return rec
  }

  detach (id) {
    this.channels.delete(id)
    const st = this.state.get(id)
    if (st) { st.alive = false; st.target = null; st.pos = null }
    this.broadcast({ t: 'offline', id }, id)
  }

  send (id, m) { try { this.channels.get(id)?.ch.send(m) } catch { /* the process is going away */ } }

  broadcast (m, exceptId = null) { for (const rec of this.channels.values()) if (rec.id !== exceptId) { try { rec.ch.send(m) } catch {} } }

  snapshot () { return [...this.state.values()] }

  saveJob () {
    if (!this.jobFile) return
    try {
      fs.mkdirSync(path.dirname(this.jobFile), { recursive: true })
      if (this.job) fs.writeFileSync(this.jobFile, JSON.stringify(this.job, null, 2))
      else fs.rmSync(this.jobFile, { force: true })
    } catch (error) { this.logger.warn(`hub: job file: ${error.message}`) }
  }

  onMessage (id, m) {
    const st = this.state.get(id)
    switch (m.t) {
      case 'hello':
        if (st) {
          st.alive = true
          if (m.role) st.role = m.role
        }
        this.send(id, { t: 'state', job: this.job, log: this.log, workers: this.snapshot(), tempBlocks: [...this.tempBlocks.entries()] })
        if (m.role) this.broadcast({ t: 'role', id, role: m.role }, id)
        break
      case 'role':
        if (st && m.role) st.role = m.role
        this.broadcast(m, id)
        break
      case 'ping': if (st) st.alive = true; break
      case 'pos': if (st) { st.pos = m.pos; st.alive = true } this.broadcast(m, id); break
      case 'claim': if (st) st.target = m.target; this.broadcast(m, id); break
      case 'done': if (st) st.done = m.done; this.broadcast(m, id); break
      case 'offline': if (st) { st.alive = false; st.target = null; st.pos = null } this.broadcast(m, id); break
      case 'temp-add':
        if (m.cell) {
          const k = `${m.cell.x},${m.cell.y},${m.cell.z}`
          this.tempBlocks.set(k, m.cell)
          this.broadcast(m, id)
        }
        break
      case 'temp-rm':
        if (m.key) {
          this.tempBlocks.delete(m.key)
          this.broadcast(m, id)
        }
        break
      case 'complete':
        for (const key of m.keys || []) {
          this.log.push({ key, id })
          this.tempBlocks.delete(key)
        }
        this.broadcast(m, id)
        break
      case 'reopen':
        this.log.push({ key: m.key, id, reopen: true, ownerIndex: m.ownerIndex })
        for (const w of this.state.values()) w.done = false
        this.broadcast(m, id)
        break
      case 'quarantine':
        this.log.push({ key: m.key, id, quarantine: true })
        this.broadcast(m, id)
        break
      case 'cmd': this.command(m); break
      case 'say': if (this.leaderId) this.send(this.leaderId, { t: 'say', text: m.text }); break
      case 'jobdone': this.job = null; this.saveJob(); this.log = []; this.tempBlocks.clear(); break
      case 'login': this.login(id); break
      default: break
    }
  }

  command (m) {
    const isContinue = m.cmd === 'continue' || Boolean(m.continueMode)
    const effectiveCmd = (m.cmd === 'start' || m.cmd === 'continue') ? 'start' : m.cmd
    if (effectiveCmd === 'start') {
      const prev = this.job
      const file = m.file || prev?.file
      const origin = m.origin || prev?.origin
      const rotation = m.rotation != null ? Number(m.rotation) : (prev?.rotation || 0)
      const startLayer = (m.startLayer !== undefined && m.startLayer !== null && m.startLayer !== '' && Number.isFinite(Number(m.startLayer)))
        ? Math.max(0, Math.floor(Number(m.startLayer)))
        : (isContinue ? (prev?.startLayer ?? null) : null)
      const sameJob = Boolean(prev && prev.file === file && prev.origin?.x === origin?.x && prev.origin?.y === origin?.y && prev.origin?.z === origin?.z && Number(prev.rotation || 0) === rotation)
      this.job = { file, origin, rotation, startLayer, continueMode: isContinue }
      if (!isContinue || !sameJob) {
        this.log = []
        this.tempBlocks.clear()
      }
      this.saveJob()
      this.logger.info(`hub: command ${isContinue ? 'continue' : 'start'}${file ? ` ${file}` : ''}${startLayer != null ? ` (from layer ${startLayer})` : ''} -> ${this.channels.size} workers`)
      this.broadcast({ t: 'cmd', cmd: 'start', file, origin, rotation, startLayer, continueMode: isContinue, from: m.from })
      return
    }
    if (m.cmd === 'stop') { this.job = null; this.tempBlocks.clear(); this.saveJob() }
    this.logger.info(`hub: command ${m.cmd}${m.file ? ` ${m.file}` : ''} -> ${this.channels.size} workers`)
    this.broadcast({ t: 'cmd', cmd: m.cmd, file: m.file, origin: m.origin, rotation: m.rotation, from: m.from })
  }

  // logins one at a time, `loginGapMs` apart (servers answer faster logins from one address with "Connection throttled")
  login (id) {
    this.loginChain = this.loginChain.then(async () => {
      const wait = this.lastLogin + this.loginGapMs * (0.8 + Math.random() * 0.7) - Date.now() // never a fixed rhythm
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
      this.lastLogin = Date.now()
      this.send(id, { t: 'login-ok' })
    }).catch(() => {})
  }

  // workers that stopped talking (hung process) are reported so the parent can restart them
  deadWorkers () {
    const now = Date.now()
    return [...this.channels.values()].filter(r => now - r.lastMsg > this.deadAfterMs).map(r => r.id)
  }
}

module.exports = { Hub }
