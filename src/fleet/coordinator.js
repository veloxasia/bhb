'use strict'
// Shared state of a group of builder bots that work on ONE schematic at the same time (all in one process).
// It only holds small facts: who is where, which block each bot is working on right now, which blocks
// are finished (an append-only log every planner reads with its own cursor), temporary scaffold blocks
// placed by builders (`tempBlocks` for the 5th Sweeper Bot), and who is done.
// The WORLD stays the single source of truth: planners still verify blocks with their own chunk data.

class Coordinator {
  constructor (count, options = {}) {
    this.count = count
    this.minGap = Number(options.minGap ?? 3.2) // blocks kept between a bot and work that belongs to somebody else
    this.log = [] // { key, id, reopen? } of tasks reported as completed or reopened
    this.workers = new Map() // id -> { id, index, bot, target, done, beat, role }
    this.tempBlocks = new Map() // key -> { x, y, z, createdAt, isAccessStep, by }
    this.lastProgressAt = Date.now()
  }

  register (id, index, bot, role = null) {
    const prev = this.workers.get(id)
    const now = Date.now()
    const resolvedRole = role || (bot && typeof bot.role === 'string' ? bot.role : null) || prev?.role || 'builder'
    this.workers.set(id, { id, index, bot, role: resolvedRole, target: prev?.target || null, done: false, beat: now, lastDoneAt: prev?.lastDoneAt || now })
  }

  listTempBlocks () {
    return [...this.tempBlocks.values()]
  }

  unregister (id) { const w = this.workers.get(id); if (w) { w.target = null; w.beat = 0 } }

  beat (id) { const w = this.workers.get(id); if (w) w.beat = Date.now() }

  // ---- temporary scaffold / bridge blocks shared with the 5th Sweeper Bot ------------------------
  addTempBlock (pos, id = null) {
    if (!pos) return
    const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z)
    const key = `${x},${y},${z}`
    this.tempBlocks.set(key, {
      x, y, z,
      createdAt: pos.createdAt || Date.now(),
      isAccessStep: Boolean(pos.isAccessStep),
      isCatwalk: Boolean(pos.isCatwalk),
      isTempLadder: Boolean(pos.isTempLadder),
      by: id
    })
  }

  removeTempBlock (key, _id = null) {
    if (!key) return
    const k = typeof key === 'string' ? key : `${Math.floor(key.x)},${Math.floor(key.y)},${Math.floor(key.z)}`
    this.tempBlocks.delete(k)
  }

  hasActiveSweeper () {
    const now = Date.now()
    for (const w of this.workers.values()) {
      if (w.role === 'sweeper' && now - (w.beat || 0) < 45_000) return true
    }
    return false
  }

  // ---- finished / reopened blocks ---------------------------------------------------------------
  complete (key, id) {
    this.log.push({ key, id })
    this.tempBlocks.delete(key)
    this.lastProgressAt = Date.now()
    const w = this.workers.get(id)
    if (w) w.lastDoneAt = Date.now()
  }

  reopen (key, id, ownerIndex = null) {
    this.log.push({ key, id, reopen: true, ownerIndex })
    this.lastProgressAt = Date.now()
    for (const w of this.workers.values()) w.done = false
  }

  quarantine (key, id) {
    this.log.push({ key, id, quarantine: true })
    this.lastProgressAt = Date.now()
  }

  // ---- what everybody is doing right now --------------------------------------------------------
  claim (id, task) {
    const w = this.workers.get(id)
    if (w) {
      w.target = task ? { key: task.key, x: task.world.x, y: task.world.y, z: task.world.z, at: Date.now() } : null
    }
  }

  release (id) { this.claim(id, null) }

  position (w) {
    if (w.pos) return w.pos // reported by another process
    const p = w.bot?.entity?.position
    return p ? { x: p.x, y: p.y, z: p.z } : null
  }

  // is this task taken (or too close to what somebody else is doing) for worker `id`?
  // `strict` = also keep a distance (used when a bot helps in somebody else's zone).
  busyFor (id, task, strict) {
    const now = Date.now()
    for (const w of this.workers.values()) {
      if (w.id === id) continue
      if (now - (w.beat || 0) > 30_000) continue
      const lastActive = Math.max(w.lastDoneAt || 0, w.target?.at || 0) || w.beat || 0
      const stalled = now - lastActive > 20_000
      if (w.target && !stalled) {
        if (w.target.key === task.key) return true
        if (task.world && Math.hypot(w.target.x - task.world.x, w.target.z - task.world.z) < 2.0 && Math.abs(w.target.y - task.world.y) <= 2) return true
      }
      if (!strict) continue
      const gap = stalled ? 2.0 : this.minGap
      const posGap = this.minGap > 3.2 ? gap : Math.min(2.6, gap)
      const near = (a, g = gap) => a && Math.hypot(a.x - task.world.x, a.z - task.world.z) < g && Math.abs(a.y - task.world.y) < (stalled ? 2.5 : 3.5)
      if (!stalled && near(w.target)) return true
      if (near(this.position(w), posGap)) return true
    }
    return false
  }

  // ---- finishing --------------------------------------------------------------------------------
  setDone (id, done) { const w = this.workers.get(id); if (w) w.done = Boolean(done) }

  allDone () {
    const now = Date.now()
    let any = false
    for (const w of this.workers.values()) {
      if (now - w.beat > 90_000) continue
      any = true
      if (!w.done) return false
    }
    return any
  }

  othersActive (id) {
    const now = Date.now()
    for (const w of this.workers.values()) if (w.id !== id && !w.done && now - w.beat < 90_000) return true
    return false
  }

  builders () { return [...this.workers.values()].map(w => w.bot?.builder).filter(Boolean) }

  summary () {
    return [...this.workers.values()].map(w => `${w.id}${w.role === 'sweeper' ? '[S]' : ''}:${w.done ? 'done' : w.target ? `${w.target.x},${w.target.y},${w.target.z}` : 'idle'}`).join(' | ')
  }
}

module.exports = { Coordinator }
