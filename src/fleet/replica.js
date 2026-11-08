'use strict'
// The coordinator as seen from ONE worker process. It answers the planner's questions from a local copy (no
// waiting on the network) and tells the hub about everything this worker does. Remote events update the copy.
const { Coordinator } = require('./coordinator')

class ReplicaCoordinator extends Coordinator {
  constructor (count, options, send, selfId) {
    super(count, options)
    this.send = send
    this.selfId = selfId
    this.pending = [] // finished blocks not yet sent
    this.flushTimer = null
  }

  ensure (id, index = -1) {
    let w = this.workers.get(id)
    if (!w) { w = { id, index, role: 'builder', bot: null, target: null, done: false, beat: 0, pos: null }; this.workers.set(id, w) }
    return w
  }

  register (id, index, bot, role = 'builder') {
    super.register(id, index, bot, role)
    if (id === this.selfId && role) {
      this.send({ t: 'role', id, role })
    }
  }

  // ---- local actions -> hub ---------------------------------------------------------------------
  addTempBlock (pos, id = this.selfId) {
    super.addTempBlock(pos, id)
    if (!pos) return
    const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
    const cell = this.tempBlocks.get(`${x},${y},${z}`)
    if (cell) this.send({ t: 'temp-add', id: this.selfId, cell })
  }

  removeTempBlock (key, id = this.selfId) {
    const k = typeof key === 'string' ? key : `${Math.floor(key.x)},${Math.floor(key.y)},${Math.floor(key.z)}`
    const existed = this.tempBlocks.has(k)
    super.removeTempBlock(k, id)
    if (existed) this.send({ t: 'temp-rm', id: this.selfId, key: k })
  }

  complete (key, id) {
    super.complete(key, id)
    this.pending.push(key)
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 150)
  }

  reopen (key, id, ownerIndex = null) {
    super.reopen(key, id, ownerIndex)
    for (const w of this.workers.values()) w.done = false
    this.send({ t: 'reopen', id: this.selfId, key, ownerIndex })
  }

  quarantine (key, id = this.selfId) {
    super.quarantine(key, id)
    this.send({ t: 'quarantine', id: this.selfId, key })
  }

  flush () {
    clearTimeout(this.flushTimer); this.flushTimer = null
    if (!this.pending.length) return
    const keys = this.pending; this.pending = []
    this.send({ t: 'complete', id: this.selfId, keys })
  }

  claim (id, task) {
    super.claim(id, task)
    if (id === this.selfId) this.send({ t: 'claim', id, target: this.workers.get(id)?.target || null })
  }

  setDone (id, done) {
    const w = this.workers.get(id)
    const was = w?.done
    super.setDone(id, done)
    if (id === this.selfId && was !== Boolean(done)) this.send({ t: 'done', id, done: Boolean(done) })
  }

  unregister (id) {
    super.unregister(id)
    if (id === this.selfId) this.send({ t: 'offline', id })
  }

  // position + liveness, called by a timer in the worker process
  report () {
    const w = this.workers.get(this.selfId)
    const p = w?.bot?.entity?.position
    this.send({ t: 'pos', id: this.selfId, pos: p ? { x: p.x, y: p.y, z: p.z } : null })
  }

  builders () { const w = this.workers.get(this.selfId); return w?.bot?.builder ? [w.bot.builder] : [] }

  // ---- hub -> local copy ------------------------------------------------------------------------
  apply (m) {
    switch (m.t) {
      case 'state': {
        this.log = (m.log || []).slice()
        if (Array.isArray(m.tempBlocks)) {
          this.tempBlocks = new Map(m.tempBlocks)
        }
        for (const w of m.workers || []) {
          if (w.id !== this.selfId) {
            Object.assign(this.ensure(w.id, w.index), { role: w.role || 'builder', target: w.target, done: w.done, pos: w.pos, beat: w.alive ? Date.now() : 0 })
          }
        }
        break
      }
      case 'role': { if (m.id === this.selfId) break; const w = this.ensure(m.id); if (m.role) w.role = m.role; break }
      case 'pos': { if (m.id === this.selfId) break; const w = this.ensure(m.id); w.pos = m.pos; w.beat = Date.now(); break }
      case 'claim': { if (m.id === this.selfId) break; const w = this.ensure(m.id); w.target = m.target ? { ...m.target, at: Date.now() } : null; w.beat = Date.now(); break }
      case 'done': { if (m.id === this.selfId) break; this.ensure(m.id).done = m.done; break }
      case 'offline': { if (m.id === this.selfId) break; const w = this.ensure(m.id); w.beat = 0; w.target = null; w.pos = null; break }
      case 'temp-add': {
        if (m.id === this.selfId || !m.cell) break
        this.tempBlocks.set(`${m.cell.x},${m.cell.y},${m.cell.z}`, m.cell)
        break
      }
      case 'temp-rm': {
        if (m.id === this.selfId || !m.key) break
        this.tempBlocks.delete(m.key)
        break
      }
      case 'complete': {
        if (m.id === this.selfId) break
        for (const key of m.keys || []) {
          this.log.push({ key, id: m.id })
          this.tempBlocks.delete(key)
        }
        const w = this.ensure(m.id)
        w.lastDoneAt = Date.now()
        this.lastProgressAt = Date.now()
        break
      }
      case 'reopen': {
        for (const w of this.workers.values()) w.done = false
        if (m.id === this.selfId) break
        this.log.push({ key: m.key, id: m.id, reopen: true, ownerIndex: m.ownerIndex })
        this.lastProgressAt = Date.now()
        break
      }
      case 'quarantine': {
        if (m.id === this.selfId) break
        this.log.push({ key: m.key, id: m.id, quarantine: true })
        this.lastProgressAt = Date.now()
        break
      }
      default: break
    }
  }
}

module.exports = { ReplicaCoordinator }
