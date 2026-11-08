'use strict'
const { withHold } = require('./fall-guard')
// Temporary scaffold towers. A tower is built like a player pillar-jumps: look straight down, jump, place
// the block under your feet once you are high enough that it no longer intersects you.
// Also supports temporary ladder climbing (`climbWithLadders`) on vertical solid walls so bots can climb up and down
// without blocking paths with solid stone pillars.

const { Vec3 } = require('../util/vec3')
const { sleep, waitFor, nextTick } = require('../util/async')
const { checkAbort } = require('../util/abort')
const { isAirLike, feetCellOf, isBodyFree, isFullTop } = require('../world/ground')
const { isInteractive } = require('../rules/blocks')

const key = p => `${p.x},${p.y},${p.z}`

class ScaffoldManager {
  constructor (ctx) {
    Object.assign(this, ctx)
    this.created = this._wrapCreatedMap(new Map())
    this.churn = new Map()
    this.badColumns = new Map()
    this.itemName = (this.config.building?.scaffoldBlockNames || ['cobblestone'])[0]
  }

  _wrapCreatedMap (map) {
    const self = this
    const origSet = map.set.bind(map)
    const origDelete = map.delete.bind(map)
    map.set = function (k, v) {
      const res = origSet(k, v)
      try {
        if (!self.bot?.builder?.isSweeper) {
          const coord = self.bot?.builder?.fleet?.coord
          if (coord?.addTempBlock && v && typeof v.x === 'number') {
            coord.addTempBlock(v, self.bot?.username || '')
          }
        }
      } catch {}
      return res
    }
    map.delete = function (k) {
      const res = origDelete(k)
      try {
        const coord = self.bot?.builder?.fleet?.coord
        if (coord?.removeTempBlock) coord.removeTempBlock(k, self.bot?.username || '')
      } catch {}
      return res
    }
    return map
  }

  getCreated () { return [...this.created.values()] }
  setCreated (list) { this.created = this._wrapCreatedMap(new Map((list || []).map(p => [key(p), new Vec3(p.x, p.y, p.z)]))) }

  clearChurn () {
    this.churn.clear()
    this.badColumns.clear()
  }

  hasDependants (pos) { try { return Boolean(this.dependants && this.dependants(pos)) } catch { return false } }

  heightUnderFeet () {
    const p = this.bot.entity?.position
    if (!p) return 0
    let h = 0
    for (let y = Math.floor(p.y - 0.05); h < 40 && this.created.has(key({ x: Math.floor(p.x), y, z: Math.floor(p.z) })); y--) h++
    return h
  }

  contains (pos) { return this.created.has(key({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) })) }

  onScaffold () {
    const p = this.bot.entity?.position
    if (!p) return false
    const k = key({ x: Math.floor(p.x), y: Math.floor(p.y - 0.05), z: Math.floor(p.z) })
    const rec = this.created.get(k)
    return Boolean(rec && !rec.isTempLadder && !rec.isAccessStep)
  }

  async climbWithLadders (t) {
    if (!t || !t.base || !t.top || t.height < 2 || t.height > 8) return false
    const wallDx = t.top.x - t.base.x
    const wallDz = t.top.z - t.base.z
    if (Math.abs(wallDx) + Math.abs(wallDz) !== 1) return false
    for (let y = t.base.y; y < t.top.y; y++) {
      const wb = this.world.blockAt(new Vec3(t.top.x, y, t.top.z))
      if (!wb || !isFullTop(wb) || isInteractive(wb.name)) return false
      const airB = this.world.blockAt(new Vec3(t.base.x, y, t.base.z))
      if (!airB || (!isAirLike(airB) && airB.name !== 'ladder')) return false
    }
    const haveLadders = this.materials?.countItem?.('ladder') || 0
    if (haveLadders < t.height) {
      if (!this.config.materials?.autoGive) return false
      try { await this.materials.ensureItem('ladder', t.height) } catch { return false }
    }
    return withHold(this.bot, async () => {
      const faceNormal = new Vec3(-wallDx, 0, -wallDz)
      const cursor = new Vec3(0.5 + faceNormal.x * 0.49, 0.5, 0.5 + faceNormal.z * 0.49)
      const climbX = t.base.x + 0.5 + wallDx * 0.24
      const climbZ = t.base.z + 0.5 + wallDz * 0.24
      for (let y = t.base.y; y < t.top.y; y++) {
        checkAbort()
        const ladderCell = new Vec3(t.base.x, y, t.base.z)
        const existing = this.world.blockAt(ladderCell)
        if (!existing || existing.name !== 'ladder') {
          if (y - this.bot.entity.position.y > 2.6) {
            const midT0 = Date.now()
            while (Date.now() - midT0 < 1500 && this.bot.entity.position.y < y - 1.5) {
              checkAbort()
              await this.bot.lookAt(new Vec3(t.top.x + 0.5, this.bot.entity.position.y + 1.4, t.top.z + 0.5), true).catch(() => {})
              this.bot.setControlState('forward', true)
              this.bot.setControlState('jump', true)
              await sleep(40)
            }
            this.bot.setControlState('forward', false)
            this.bot.setControlState('jump', false)
          }
          await this.materials.ensureUsableItem('ladder', 'block')
          const wallBlock = this.world.blockAt(new Vec3(t.top.x, y, t.top.z))
          if (!wallBlock || wallBlock.boundingBox !== 'block') return false
          const hitPt = new Vec3(t.top.x + cursor.x, y + 0.5, t.top.z + cursor.z)
          await this.look.lookAtPoint(hitPt)
          await sleep(10)
          try { await this.interaction.sendPlace(wallBlock, faceNormal, cursor) } catch {}
          const ok = await waitFor(() => this.world.blockAt(ladderCell)?.name === 'ladder', { timeoutMs: 700, intervalMs: 20 }).catch(() => null)
          if (!ok) return false
          const rec = ladderCell.clone()
          rec.createdAt = Date.now()
          rec.isAccessStep = true
          rec.isTempLadder = true
          this.created.set(key(ladderCell), rec)
        }
      }
      const topGoal = new Vec3(t.top.x + 0.5, t.top.y, t.top.z + 0.5)
      const climbDeadline = Date.now() + 4500
      try {
        while (Date.now() < climbDeadline) {
          checkAbort()
          const p = this.bot.entity.position
          if (Math.hypot(p.x - topGoal.x, p.z - topGoal.z) < 0.38 && Math.abs(p.y - topGoal.y) < 0.35) return true
          this.bot.setControlState('sneak', false)
          const stepOff = p.y >= t.top.y - 0.35
          const aimPt = stepOff
            ? new Vec3(topGoal.x, topGoal.y + 1.0, topGoal.z)
            : new Vec3(climbX + wallDx * 1.2, p.y + 1.2, climbZ + wallDz * 1.2)
          await this.bot.lookAt(aimPt, true).catch(() => {})
          this.bot.setControlState('forward', true)
          this.bot.setControlState('jump', true)
          await sleep(40)
        }
      } finally {
        this.bot.setControlState('forward', false)
        this.bot.setControlState('jump', false)
      }
      const pEnd = this.bot.entity.position
      return Math.abs(pEnd.y - topGoal.y) < 0.5 && Math.hypot(pEnd.x - topGoal.x, pEnd.z - topGoal.z) < 0.55
    })
  }

  planColumn (R, target, isReserved) {
    const maxH = Number(this.config.building?.maxTowerHeight ?? 24)
    const free = c => { const b = this.world.blockAt(c); if (this.noScaffold?.(c)) return false; return Boolean(b && (isAirLike(b) || b.name === 'water')) }
    const col = `${R.x},${R.z}`
    const now = Date.now()
    const churnEntry = this.churn.get(col)
    const churnCount = (churnEntry && typeof churnEntry === 'object')
      ? (now - churnEntry.at < 30_000 ? churnEntry.count : 0)
      : (churnEntry || 0)
    const badEntry = this.badColumns.get(col)
    const badCount = (badEntry && typeof badEntry === 'object')
      ? (now - badEntry.at < 30_000 ? badEntry.count : 0)
      : (badEntry || 0)
    if (churnCount >= 3 || badCount >= 2) return null
    if (!free(R) || (target && R.equals(target))) return null
    for (let h = 0; h <= maxH; h++) {
      const c = R.offset(0, -h - 1, 0)
      const b = this.world.blockAt(c)
      if (!b) return null
      const isSolid = isFullTop(b) && !isAirLike(b) && !/^(water|lava|hopper|chest|trapped_chest|ender_chest)$/.test(b.name)
      if (isSolid && !this.created.has(key(c))) {
        for (let y = c.y + 1; y <= R.y + 2; y++) { const cc = new Vec3(R.x, y, R.z); if (target && cc.equals(target)) return null; if (y <= R.y + 2 && !(y <= R.y ? free(cc) || this.created.has(key(cc)) : free(cc))) return null }
        return { info: { floor: new Vec3(R.x, c.y + 1, R.z), height: h + 1 }, stand: new Vec3(R.x + 0.5, R.y + 1, R.z + 0.5) }
      }
      if (!free(c)) return null
    }
    return null
  }

  async lookDown () {
    await this.look.lookDown()
  }

  async tower (info, stand) { return withHold(this.bot, () => this._tower_h(info, stand)) }

  async _tower_h (info, stand) {
    const col = `${Math.floor(stand.x)},${Math.floor(stand.z)}`
    const now = Date.now()
    try {
      const res = this.bot.__motion
        ? await this.bot.__motion.precisely(() => this._tower(info, stand, col))
        : await this._tower(info, stand, col)
      this.churn.delete(col)
      this.badColumns.delete(col)
      return res
    } catch (error) {
      const cur = this.badColumns.get(col)
      const prev = (cur && typeof cur === 'object' && now - cur.at < 30_000) ? cur.count : 0
      this.badColumns.set(col, { count: prev + 1, at: now })
      throw error
    }
  }

  async _placeBlockOnFloor (cell, isAccessStep = false) {
    const existing = this.world.blockAt(cell)
    if (existing && existing.boundingBox === 'block' && !isAirLike(existing) && existing.name !== 'water') return true
    this.materials?.closeOpenContainer?.()
    await this.materials.ensureUsableItem(this.itemName, 'block')
    const faces = [
      { off: [0, -1, 0], normal: new Vec3(0, 1, 0), cursor: new Vec3(0.5, 1, 0.5) },
      { off: [1, 0, 0], normal: new Vec3(-1, 0, 0), cursor: new Vec3(0, 0.5, 0.5) },
      { off: [-1, 0, 0], normal: new Vec3(1, 0, 0), cursor: new Vec3(1, 0.5, 0.5) },
      { off: [0, 0, 1], normal: new Vec3(0, 0, -1), cursor: new Vec3(0.5, 0.5, 0) },
      { off: [0, 0, -1], normal: new Vec3(0, 0, 1), cursor: new Vec3(0.5, 0.5, 1) }
    ]
    for (const f of faces) {
      const refPos = cell.offset(f.off[0], f.off[1], f.off[2])
      const refBlock = this.world.blockAt(refPos)
      if (!refBlock || refBlock.boundingBox !== 'block' || isAirLike(refBlock)) continue
      const pNow = this.bot.entity.position
      const standingOnRef = f.off[1] === 0 && Math.floor(pNow.x) === refPos.x && Math.floor(pNow.z) === refPos.z
      if (standingOnRef) {
        const edgeSpot = new Vec3(refPos.x + 0.5 - f.off[0] * 0.58, refPos.y + 1, refPos.z + 0.5 - f.off[2] * 0.58)
        await this.slide(edgeSpot, true).catch(() => {})
      }
      const needSneak = isInteractive(refBlock.name) || standingOnRef
      const effCursor = standingOnRef ? new Vec3(f.cursor.x, 0.78, f.cursor.z) : f.cursor
      const hitPt = new Vec3(refPos.x + effCursor.x, refPos.y + effCursor.y, refPos.z + effCursor.z)
      const eye = this.bot.entity.position.offset(0, needSneak ? 1.27 : 1.62, 0)
      const dist = eye.distanceTo(hitPt)
      if (dist > 4.4) continue
      if (this.bot.world?.raycast) {
        const dir = hitPt.minus(eye).scaled(1 / Math.max(0.05, dist))
        const hit = this.bot.world.raycast(eye, dir, dist + 0.25)
        if (hit && hit.position) {
          const hp = hit.position
          const isRef = hp.x === refPos.x && hp.y === refPos.y && hp.z === refPos.z
          const isCell = hp.x === cell.x && hp.y === cell.y && hp.z === cell.z
          if (!isRef && !isCell && hit.intersect && hit.intersect.distanceTo(eye) < dist - 0.05) continue
        }
      }
      if (needSneak) {
        this.bot.setControlState('sneak', true)
        await sleep(10)
      }
      try {
        await this.look.lookAtPoint(hitPt)
        await sleep(10)
        try {
          await this.interaction.sendPlace(refBlock, f.normal, f.cursor)
        } catch {}
        this.materials?.closeOpenContainer?.()
        const ok = await waitFor(() => {
          const b = this.world.blockAt(cell)
          return b && b.boundingBox === 'block' && !isAirLike(b) && b.name !== 'water'
        }, { timeoutMs: 750, intervalMs: 15 }).catch(() => null)
        if (ok) {
          const rec = cell.clone()
          rec.createdAt = Date.now()
          if (isAccessStep) rec.isAccessStep = true
          this.created.set(key(cell), rec)
          this.materials.noteConsumed?.(this.itemName, 1)
          return true
        }
      } finally {
        if (needSneak) this.bot.setControlState('sneak', false)
      }
    }
    return false
  }

  async _stepOntoTop (dryTop, maxMs = 2000) {
    return withHold(this.bot, async () => {
      const bot = this.bot
      const t0 = Date.now()
      try {
        while (Date.now() - t0 < maxMs) {
          checkAbort()
          const p = bot.entity.position
          if (Math.hypot(p.x - dryTop.x, p.z - dryTop.z) < 0.35 && Math.abs(p.y - dryTop.y) < 0.45) return true
          bot.setControlState('sneak', false)
          bot.setControlState('back', false)
          await bot.lookAt(new Vec3(dryTop.x, dryTop.y + 1.0, dryTop.z), true).catch(() => {})
          bot.setControlState('forward', true)
          bot.setControlState('jump', p.y < dryTop.y - 0.05)
          await sleep(35)
        }
      } finally {
        bot.setControlState('forward', false)
        bot.setControlState('jump', false)
      }
      const p = bot.entity.position
      return Math.abs(p.y - dryTop.y) < 0.6 && Math.hypot(p.x - dryTop.x, p.z - dryTop.z) < 0.45
    })
  }

  async _placeWetBaseAndStepUp (floorCell, stand, isAccessStep = false) {
    const bot = this.bot
    const dryTop = new Vec3(stand.x, floorCell.y + 1, stand.z)
    const existing = this.world.blockAt(floorCell)
    if (existing && existing.boundingBox === 'block' && !isAirLike(existing) && existing.name !== 'water') {
      if (await this._stepOntoTop(dryTop, 2000)) return true
      await this.nav.goTo(dryTop, 0.35, 10_000, { human: true }).catch(() => {})
      return Math.abs(bot.entity.position.y - dryTop.y) < 0.6 && Math.hypot(bot.entity.position.x - dryTop.x, bot.entity.position.z - dryTop.z) < 0.45
    }
    const overlapsCell = (c, p = bot.entity.position) => Math.abs(p.x - (c.x + 0.5)) < 0.82 && Math.abs(p.z - (c.z + 0.5)) < 0.82 && p.y < c.y + 1 && p.y + 1.8 > c.y
    if (!overlapsCell(floorCell) && bot.entity.position.distanceTo(new Vec3(floorCell.x + 0.5, floorCell.y + 0.5, floorCell.z + 0.5)) <= 4.2) {
      if (await this._placeBlockOnFloor(floorCell, isAccessStep)) {
        if (await this._stepOntoTop(dryTop, 2200)) return true
      }
    }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const sc = new Vec3(floorCell.x + dx, floorCell.y, floorCell.z + dz)
      if (overlapsCell(sc)) continue
      const f0 = this.world.blockAt(sc)
      if (!f0 || f0.name !== 'water') continue
      if (await this._placeBlockOnFloor(sc, isAccessStep)) {
        await sleep(220)
        if (!bot.entity.isInWater && this.world.blockAt(floorCell)?.name !== 'water') {
          return 'drained'
        }
        const f1 = this.world.blockAt(sc.offset(0, 1, 0))
        const f2 = this.world.blockAt(sc.offset(0, 2, 0))
        if (isBodyFree(f1) && isBodyFree(f2)) {
          const sideTop = new Vec3(sc.x + 0.5, sc.y + 1, sc.z + 0.5)
          if (await this._stepOntoTop(sideTop, 1600)) {
            if (!overlapsCell(floorCell) && await this._placeBlockOnFloor(floorCell, isAccessStep)) {
              if (await this._stepOntoTop(dryTop, 1600)) return true
            }
          }
        }
      }
    }
    const sideCands = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const sc = new Vec3(floorCell.x + dx, floorCell.y, floorCell.z + dz)
      if (overlapsCell(sc)) continue
      const f0 = this.world.blockAt(sc)
      const f1 = this.world.blockAt(sc.offset(0, 1, 0))
      const f2 = this.world.blockAt(sc.offset(0, 2, 0))
      if (!(isBodyFree(f0) || f0?.name === 'water') || !isBodyFree(f1) || !isBodyFree(f2)) continue
      const d = Math.hypot(sc.x + 0.5 - bot.entity.position.x, sc.z + 0.5 - bot.entity.position.z)
      sideCands.push({ sc, d })
    }
    sideCands.sort((a, b) => a.d - b.d)
    for (const { sc } of sideCands.slice(0, 3)) {
      if (await this._placeBlockOnFloor(sc, isAccessStep)) {
        const sideTop = new Vec3(sc.x + 0.5, sc.y + 1, sc.z + 0.5)
        if (await this._stepOntoTop(sideTop, 1600)) {
          if (!overlapsCell(floorCell) && await this._placeBlockOnFloor(floorCell, isAccessStep)) {
            if (await this._stepOntoTop(dryTop, 1600)) return true
          }
        }
      }
    }
    const under = this.world.blockAt(floorCell.offset(0, -1, 0))
    const headAbove = this.world.blockAt(floorCell.offset(0, 2, 0))
    if (under && under.boundingBox === 'block' && (!headAbove || isBodyFree(headAbove))) {
      await this.materials.ensureUsableItem(this.itemName, 'block').catch(() => {})
      await this.lookDown()
      this.bot.setControlState('jump', true)
      const deadline = Date.now() + 900
      let sent = false
      try {
        while (Date.now() < deadline) {
          checkAbort()
          await sleep(20)
          if (this.bot.entity.position.y >= floorCell.y + 0.88 && !sent) {
            sent = true
            try { await this.interaction.sendPlace(under, new Vec3(0, 1, 0), new Vec3(0.5, 1, 0.5)) } catch {}
          }
        }
      } finally {
        this.bot.setControlState('jump', false)
      }
      const ok = await waitFor(() => {
        const b = this.world.blockAt(floorCell)
        return b && b.boundingBox === 'block' && !isAirLike(b) && b.name !== 'water'
      }, { timeoutMs: 500, intervalMs: 20 }).catch(() => null)
      if (ok) {
        const rec = floorCell.clone()
        rec.createdAt = Date.now()
        if (isAccessStep) rec.isAccessStep = true
        this.created.set(key(floorCell), rec)
        this.materials.noteConsumed?.(this.itemName, 1)
        return true
      }
    }
    return false
  }

  // Fast strafe/step to column center WITHOUT rotating the camera to look at the floor center
  // and WITHOUT pulsing sneak on/off every other tick!
  async _centerOnColumn (targetX, targetZ, onHopper = false) {
    const bot = this.bot
    if (!bot?.entity?.position) return
    const p0 = bot.entity.position
    if (Math.hypot(p0.x - targetX, p0.z - targetZ) <= (onHopper ? 0.08 : 0.14)) return
    if (onHopper) bot.setControlState('sneak', true)
    try {
      let prevX = p0.x; let prevZ = p0.z
      for (let step = 0; step < 6; step++) {
        checkAbort()
        const q = bot.entity.position
        const dx = targetX - q.x; const dz = targetZ - q.z
        if (Math.hypot(dx, dz) <= (onHopper ? 0.08 : 0.14)) break
        if (step >= 1 && Math.hypot(q.x - prevX, q.z - prevZ) < 0.002) {
          bot.entity.yaw = Math.atan2(-dx, -dz)
        }
        prevX = q.x; prevZ = q.z
        const fracY = q.y - Math.floor(q.y)
        if (onHopper && fracY > 0.5 && fracY < 0.85) bot.setControlState('jump', true)
        const yaw = bot.entity.yaw
        const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw)
        const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw)
        bot.setControlState('forward', fwd > 0.03)
        bot.setControlState('back', fwd < -0.03)
        bot.setControlState('right', right > 0.03)
        bot.setControlState('left', right < -0.03)
        await nextTick(bot)
      }
    } finally {
      for (const k of ['forward', 'back', 'left', 'right', 'sneak', 'jump']) bot.setControlState(k, false)
    }
  }

  async _tower (info, stand, col) {
    const now = Date.now()
    const cur = this.churn.get(col)
    const prev = (cur && typeof cur === 'object' && now - cur.at < 30_000) ? cur.count : 0
    this.churn.set(col, { count: prev + 1, at: now })
    this.phaseHook?.('tower: getting blocks')
    this.materials?.closeOpenContainer?.()
    await this.materials.ensureItem(this.itemName, info.height + 2)

    let startIdx = 0
    if (this.onScaffold() && this.bot.entity) {
      const fcPre = feetCellOf(this.world, this.bot.entity.position)
      if (fcPre.x === info.floor.x && fcPre.z === info.floor.z && fcPre.y > info.floor.y && fcPre.y <= info.floor.y + info.height) {
        let solidColumn = true
        for (let y = info.floor.y; y < fcPre.y; y++) {
          const b = this.world.blockAt(new Vec3(info.floor.x, y, info.floor.z))
          if (!b || isAirLike(b) || b.boundingBox !== 'block') { solidColumn = false; break }
        }
        if (solidColumn) startIdx = fcPre.y - info.floor.y
        else await this._descend_h(0).catch(() => {})
      } else if (fcPre.y > info.floor.y || fcPre.x !== info.floor.x || fcPre.z !== info.floor.z) {
        await this._descend_h(0).catch(() => {})
      }
    }

    const floorBlock = this.world.blockAt(info.floor)
    const fcNow = this.bot.entity ? feetCellOf(this.world, this.bot.entity.position) : null
    const feetNow = fcNow ? this.world.blockAt(new Vec3(fcNow.x, fcNow.y, fcNow.z)) : null
    const distToFloor = this.bot.entity ? this.bot.entity.position.distanceTo(new Vec3(info.floor.x + 0.5, info.floor.y + 0.5, info.floor.z + 0.5)) : 99
    if (startIdx === 0 && (Boolean(this.bot.entity?.isInWater) || (feetNow && feetNow.name === 'water') || (floorBlock && floorBlock.name === 'water' && distToFloor <= 3.8))) {
      this.phaseHook?.('tower: placing dry base in water')
      const stepped = await this._placeWetBaseAndStepUp(info.floor, stand, Boolean(info.isAccessStep)).catch(() => false)
      if (stepped === true) {
        startIdx = 1
      } else if (stepped !== 'drained' && (Boolean(this.bot.entity?.isInWater) || (feetNow && feetNow.name === 'water'))) {
        throw new Error('tower: could not step onto dry base from water')
      }
    }

    if (startIdx === 0) {
      this.phaseHook?.('tower: walking to the column')
      const base = new Vec3(stand.x, info.floor.y, stand.z)
      const here = this.bot.entity.position
      const floorIsWet = this.world.blockAt(info.floor)?.name === 'water'
      const walkRadius = floorIsWet ? 1.8 : 0.28
      if (Math.abs(here.x - base.x) > (floorIsWet ? 1.8 : 0.36) || Math.abs(here.z - base.z) > (floorIsWet ? 1.8 : 0.36) || Math.abs(here.y - base.y) > (floorIsWet ? 1.5 : 0.45)) {
        await this.nav.goTo(base, walkRadius, 8_000, { human: true, rescue: false })
      }
      const fcAfter = feetCellOf(this.world, this.bot.entity.position)
      if (floorIsWet || this.ground.state() === 'swimming' || Boolean(this.bot.entity?.isInWater) || this.world.blockAt(new Vec3(fcAfter.x, fcAfter.y, fcAfter.z))?.name === 'water') {
        const stepped = await this._placeWetBaseAndStepUp(info.floor, stand, Boolean(info.isAccessStep)).catch(() => false)
        if (stepped === true) startIdx = 1
        else if (stepped !== 'drained') throw new Error('tower: column base is in water and could not place dry base')
      }
    }

    const st = await this.ground.waitSafe(2000)
    if (st !== 'grounded' && st !== 'resting') throw new Error(`cannot start tower: bot is ${st}`)

    for (let i = startIdx; i < info.height; i++) {
      checkAbort()
      const fc0 = feetCellOf(this.world, this.bot.entity.position)
      const under0 = this.world.blockAt(new Vec3(fc0.x, fc0.y - 1, fc0.z))
      const onHopper = under0?.name === 'hopper'
      await this._centerOnColumn(stand.x, stand.z, onHopper)
      const settleT0 = Date.now()
      while (Date.now() - settleT0 < 400 && !this.bot.entity.onGround && !this.bot.entity.isInWater) {
        await nextTick(this.bot)
      }
      const pos = this.bot.entity.position
      const fc = feetCellOf(this.world, pos)
      const feet = (Math.abs(fc.x - info.floor.x) <= 1 && Math.abs(fc.z - info.floor.z) <= 1)
        ? new Vec3(info.floor.x, info.floor.y + i, info.floor.z)
        : new Vec3(fc.x, fc.y, fc.z)
      let existingAtFeet = this.world.blockAt(feet)
      if (existingAtFeet && !isAirLike(existingAtFeet) && (existingAtFeet.name === 'ladder' || this.created.has(key(feet)))) {
        try {
          await this.look.lookAtPoint(new Vec3(feet.x + 0.5, feet.y + 0.5, feet.z + 0.5))
          await this.interaction.digAimed(existingAtFeet, 1)
          this.created.delete(key(feet))
          existingAtFeet = this.world.blockAt(feet)
        } catch {}
      }
      if (existingAtFeet && !isAirLike(existingAtFeet)) {
        if (existingAtFeet.name === 'water') {
          throw new Error(`tower: feet cell ${key(feet)} is submerged in water (cannot jump-pillar in water)`)
        }
        throw new Error(`tower: feet cell ${key(feet)} is already occupied by ${existingAtFeet.name}`)
      }
      const headAbove = this.world.blockAt(feet.offset(0, 2, 0))
      if (headAbove && headAbove.boundingBox === 'block' && !isAirLike(headAbove)) {
        throw new Error(`tower: ceiling ${headAbove.name} at ${key(feet.offset(0, 2, 0))} blocks jumping`)
      }
      const under = this.world.blockAt(feet.offset(0, -1, 0))
      if (!under || isAirLike(under)) throw new Error('tower: no block under feet to build on')
      const otherOverlapsFeet = () => {
        const others = this.bot.builder?.aim?.others?.() || []
        return others.some(o => o && Math.abs(o.x - (feet.x + 0.5)) < 0.82 && Math.abs(o.z - (feet.z + 0.5)) < 0.82 && o.y < feet.y + 1 && o.y + 1.8 > feet.y)
      }
      if (otherOverlapsFeet()) {
        for (let w = 0; w < 6 && otherOverlapsFeet(); w++) await sleep(40)
        if (otherOverlapsFeet()) throw new Error(`tower: partner bot is standing inside column ${key(feet)}`)
      }
      this.phaseHook?.(`tower: block ${i + 1}/${info.height} equip`)
      this.materials?.closeOpenContainer?.()
      await this.materials.ensureUsableItem(this.itemName, 'block')
      this.phaseHook?.(`tower: block ${i + 1}/${info.height} look down`)
      await this.lookDown()
      this.phaseHook?.(`tower: block ${i + 1}/${info.height} jump`)
      const sneakForClick = isInteractive(under.name)
      const topCursorY = /chest/.test(under.name || '') ? 0.875 : (/_slab$/.test(under.name || '') && (under.getProperties?.()?.type || under.properties?.type) === 'bottom') ? 0.5 : 1
      let placedAt = null
      let ok = null
      for (let jumpTry = 0; jumpTry < 2 && !ok; jumpTry++) {
        if (jumpTry > 0) {
          await this.ground.waitSafe(600).catch(() => {})
          await this.lookDown()
        }
        if (sneakForClick) this.bot.setControlState('sneak', true)
        await sleep(10)
        const startY = this.bot.entity.position.y
        const needY = jumpTry === 0 ? Math.max(feet.y + 1.03, startY + 0.95) : Math.max(feet.y + 1.08, startY + 1.00)
        this.bot.setControlState('jump', true)
        placedAt = null
        const deadline = Date.now() + 1200
        try {
          while (Date.now() < deadline) {
            checkAbort()
            await nextTick(this.bot)
            if (this.bot.entity.position.y >= needY && !placedAt) {
              this.bot.setControlState('jump', false)
              try {
                await this.interaction.sendPlace(this.world.blockAt(feet.offset(0, -1, 0)), new Vec3(0, 1, 0), new Vec3(0.5, topCursorY, 0.5))
              } catch (_) { /* verified below */ }
              if (sneakForClick) {
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                  const sideRef = this.world.blockAt(feet.offset(dx, 0, dz))
                  if (sideRef && sideRef.boundingBox === 'block' && !isInteractive(sideRef.name)) {
                    try {
                      await this.interaction.sendPlace(sideRef, new Vec3(-dx, 0, -dz), new Vec3(0.5 - dx * 0.49, 0.5, 0.5 - dz * 0.49))
                    } catch (_) {}
                    break
                  }
                }
              }
              this.materials?.closeOpenContainer?.()
              placedAt = feet
              break
            }
          }
        } finally {
          this.bot.setControlState('jump', false)
          if (sneakForClick) this.bot.setControlState('sneak', false)
        }
        if (!placedAt) {
          if (jumpTry === 1) throw new Error(`tower: jump never gained enough height (y=${this.bot.entity.position.y.toFixed(2)}, start ${startY.toFixed(2)}, onGround=${this.bot.entity.onGround}, head=${this.world.blockAt(feet.offset(0, 2, 0))?.name})`)
          continue
        }
        ok = await waitFor(() => { const b = this.world.blockAt(placedAt); return b && b.name === this.itemName }, { timeoutMs: jumpTry === 0 ? 450 : 850, intervalMs: 15 }).catch(() => null)
      }
      if (!ok) throw new Error('tower: server did not accept the scaffold block')
      placedAt.createdAt = Date.now()
      if (info.isAccessStep && i === 0) placedAt.isAccessStep = true
      this.created.set(key(placedAt), placedAt)
      this.materials.noteConsumed?.(this.itemName, 1)
      const landed = await this.ground.waitSafe(2000)
      if (landed !== 'grounded' && landed !== 'resting') throw new Error(`tower: bot is ${landed} after placing`)
    }
  }

  // Fast strafe/step micro-slide WITHOUT rotating the camera away from the target block!
  // Never looks at `spot` or pulses sneak on/off every other tick ("sneak, see ahead, turn back, move back").
  async slide (spot, keepSneak = false) {
    const bot = this.bot
    if (bot.__motion && !this._inPrecision) { this._inPrecision = true; try { return await bot.__motion.precisely(() => this.slide(spot, keepSneak)) } finally { this._inPrecision = false } }
    return withHold(bot, async () => {
      const dist = () => Math.hypot(bot.entity.position.x - spot.x, bot.entity.position.z - spot.z)
      if (dist() < 0.035) {
        if (keepSneak) bot.setControlState('sneak', true)
        return
      }
      if (dist() > 1.35 || (spot.y !== 0 && Math.abs(bot.entity.position.y - spot.y) > 0.6)) return
      this._sliding = true
      bot.setControlState('sneak', true)
      try {
        let prevX = bot.entity.position.x
        let prevZ = bot.entity.position.z
        for (let i = 0; i < 32; i++) {
          checkAbort()
          const p = bot.entity.position
          const cellCenterX = Math.floor(p.x) + 0.5
          const cellCenterZ = Math.floor(p.z) + 0.5
          const edgeX = Math.abs(spot.x - cellCenterX) > 0.35
          const edgeZ = Math.abs(spot.z - cellCenterZ) > 0.35
          const targetX = (!edgeX && edgeZ) ? cellCenterX : spot.x
          const targetZ = (!edgeZ && edgeX) ? cellCenterZ : spot.z
          const dx = targetX - p.x; const dz = targetZ - p.z
          if (Math.hypot(spot.x - p.x, spot.z - p.z) < 0.035) break
          if (i >= 2 && Math.hypot(p.x - prevX, p.z - prevZ) < 0.002) {
            bot.entity.yaw = Math.atan2(-dx, -dz)
          }
          prevX = p.x; prevZ = p.z
          const yaw = bot.entity.yaw
          const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw)
          const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw)
          bot.setControlState('forward', fwd > 0.025)
          bot.setControlState('back', fwd < -0.025)
          bot.setControlState('right', right > 0.025)
          bot.setControlState('left', right < -0.025)
          await nextTick(bot)
        }
      } finally {
        this._sliding = false
        for (const k of ['forward', 'back', 'left', 'right']) bot.setControlState(k, false)
        const pNow = bot.entity?.position
        const overhangingNow = pNow && !isFullTop(this.world.blockAt(new Vec3(Math.floor(pNow.x), Math.floor(pNow.y - 0.05) - 1, Math.floor(pNow.z))))
        if (!keepSneak && !overhangingNow && !this.onScaffold() && !bot.builder?.placer?._chestSneak) {
          bot.setControlState('sneak', false)
        }
      }
    })
  }

  async descend (keepHeight = 0) { return withHold(this.bot, () => this._descend_h(keepHeight)) }

  async _descend_h (keepHeight = 0) {
    for (let guard = 0; guard < 80; guard++) {
      if (!this.created.size || !this.bot.entity) return
      if (keepHeight > 0 && this.heightUnderFeet() <= keepHeight) return
      const st = await this.ground.waitSafe(2000)
      if (st !== 'grounded' && st !== 'resting') return
      const p = this.bot.entity.position
      const underPos = new Vec3(Math.floor(p.x), Math.floor(p.y - 0.05), Math.floor(p.z))
      const rec = this.created.get(key(underPos))
      if (!rec || rec.isAccessStep || rec.isTempLadder) return
      let walledAtUnder = 0
      let stepOutTop = null
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const w1 = this.world.blockAt(underPos.offset(dx, 1, dz))
        if (w1 && w1.boundingBox === 'block') {
          walledAtUnder++
          const w2 = this.world.blockAt(underPos.offset(dx, 2, dz))
          const w3 = this.world.blockAt(underPos.offset(dx, 3, dz))
          if (!stepOutTop && isFullTop(w1) && isBodyFree(w2) && isBodyFree(w3)) {
            stepOutTop = new Vec3(underPos.x + dx + 0.5, underPos.y + 2, underPos.z + dz + 0.5)
          }
        }
      }
      if ((walledAtUnder >= 3 || this.heightUnderFeet() === 1) && stepOutTop) {
        if (this.heightUnderFeet() === 1) {
          rec.isAccessStep = true
          this.created.set(key(underPos), rec)
        }
        const stepped = await this._stepOntoTop(stepOutTop, 1600).catch(() => false)
        if (stepped) return
      }
      this.bot.setControlState?.('sneak', false)
      if (Math.hypot(p.x - (underPos.x + 0.5), p.z - (underPos.z + 0.5)) > 0.15) {
        await this._centerOnColumn(underPos.x + 0.5, underPos.z + 0.5, false).catch(() => {})
      }
      const block = this.world.blockAt(underPos)
      if (!block || isAirLike(block) || (block.name !== this.itemName && block.name !== 'ladder')) { this.created.delete(key(underPos)); continue }
      await this.lookDown()
      await sleep(10)
      try { await this.interaction.digAimed(block, 1) } catch (error) { this.logger.debug?.(`descend dig failed: ${error.message}`); return }
      this.created.delete(key(underPos))
      const dropDeadline = Date.now() + 750
      while (Date.now() < dropDeadline && this.bot.entity) {
        await sleep(25)
        if (this.bot.entity.position.y <= underPos.y + 0.25 && (this.bot.entity.onGround || this.bot.entity.isInWater)) break
      }
    }
    if (this.bot.entity) await this.ground.waitSafe(1500)
  }

  async removeFromGround () {
    for (let guard = 0; guard < 40; guard++) {
      if (!this.created.size || !this.bot.entity) return 0
      const p = this.bot.entity.position
      const list = this.getCreated()
        .filter(c => { const b = this.world.blockAt(c); if (!b || isAirLike(b) || (b.name !== this.itemName && b.name !== 'ladder')) { this.created.delete(key(c)); return false } return c.distanceTo(p) <= 4.3 && !(Math.floor(p.x) === c.x && Math.floor(p.z) === c.z && Math.floor(p.y - 0.05) === c.y) })
        .sort((a, b) => b.y - a.y)
      if (!list.length) break
      const target = list[0]
      const block = this.world.blockAt(target)
      if (!block || isAirLike(block) || (block.name !== this.itemName && block.name !== 'ladder')) { this.created.delete(key(target)); continue }
      await this.look.lookAtPoint(new Vec3(target.x + 0.5, target.y + 0.5, target.z + 0.5))
      try { await this.interaction.digAimed(block, 1); this.created.delete(key(target)) } catch (_) { break }
    }
    return this.created.size
  }

  async cleanup (isDependant = null, digFn = null) {
    this.churn.clear()
    this.badColumns.clear()
    const dep = typeof isDependant === 'function' ? isDependant : this.dependants
    const isUnderColumn = (p) => {
      const bp = this.bot?.entity?.position
      if (!bp) return false
      return Math.floor(bp.x) === p.x && Math.floor(bp.z) === p.z && p.y <= Math.floor(bp.y - 0.05)
    }
    const list = this.getCreated()
      .filter(p => !isUnderColumn(p) && !(typeof dep === 'function' && dep(p)))
      .sort((a, b) => b.y - a.y)
    for (const p of list) {
      const k = key(p)
      if (!this.created.has(k)) continue
      const b = this.world.blockAt(p)
      if (!b || isAirLike(b)) { this.created.delete(k); continue }
      try {
        if (typeof digFn === 'function') await digFn(p)
        else await this.interaction.digAimed(b, 1)
        const after = this.world.blockAt(p)
        if (!after || isAirLike(after)) this.created.delete(k)
      } catch {}
    }
    if (this.onScaffold()) {
      for (const rec of this.created.values()) rec.isAccessStep = false
      await this.descend(0).catch(() => {})
    }
    await this.removeFromGround().catch(() => {})
    return this.created.size
  }
}

module.exports = { ScaffoldManager }
