'use strict'
// Offline Minecraft: a prismarine-world plus an INDEPENDENT implementation of vanilla placement rules
// (written from the game's block classes, not from src/rules/blocks.js) and a bot that speaks the
// subset of the mineflayer API the builder uses. Used to prove aim, orientation and ordering logic
// without a server.
const EventEmitter = require('events')
const Vec3 = require('vec3')

const VERSION = '1.21.1'
const registry = require('prismarine-registry')(VERSION)
const World = require('prismarine-world')(registry)
const Chunk = require('prismarine-chunk')(registry)
const Block = require('prismarine-block')(registry)
const Item = require('prismarine-item')(registry)

const DIRS = { up: new Vec3(0, 1, 0), down: new Vec3(0, -1, 0), north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) }
const OPP = { up: 'down', down: 'up', north: 'south', south: 'north', east: 'west', west: 'east' }
const FACE_BY_INDEX = ['down', 'up', 'north', 'south', 'west', 'east']
const HORIZ = ['south', 'west', 'north', 'east'] // vanilla Direction.get2DDataValue order

// ---- vanilla view maths, from the PACKET rotation (not from mineflayer yaw) ----------------------
function packetRot (bot) { return { yRot: 180 - bot.entity.yaw * 180 / Math.PI, xRot: -bot.entity.pitch * 180 / Math.PI } }
function viewVector (yRot, xRot) {
  const f = xRot * Math.PI / 180; const f1 = -yRot * Math.PI / 180
  const f2 = Math.cos(f1); const f3 = Math.sin(f1); const f4 = Math.cos(f); const f5 = Math.sin(f)
  return new Vec3(f3 * f4, -f5, f2 * f4)
}
function horizontalDirection (yRot) { return HORIZ[Math.floor(yRot / 90 + 0.5) & 3] }
function nearestLooking (v) {
  const ax = Math.abs(v.x); const ay = Math.abs(v.y); const az = Math.abs(v.z)
  if (ay >= ax && ay >= az) return v.y > 0 ? 'up' : 'down'
  if (ax >= az) return v.x > 0 ? 'east' : 'west'
  return v.z > 0 ? 'south' : 'north'
}
const cw = d => HORIZ[(HORIZ.indexOf(d) + 1) % 4]

const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'tall_grass', 'fern', 'seagrass', 'vine', 'fire'])
const WATERLOGGABLE = b => 'waterlogged' in (b.getProperties?.() || {})

class SimServer extends EventEmitter {
  constructor ({ floorY = 63, size = 12, observerMode = 'opposite', strictLook = true } = {}) {
    super()
    this.registry = registry
    this.world = new World(null).sync
    this.floorY = floorY
    this.observerMode = observerMode
    this.strictLook = strictLook
    this.bots = []
    this.violations = []
    for (let cx = -size; cx <= size; cx++) for (let cz = -size; cz <= size; cz++) {
      const c = new Chunk()
      for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = -64; y <= floorY; y++) c.setBlockStateId(new Vec3(x, y, z), registry.blocksByName.stone.defaultState)
      this.world.setColumn(cx, cz, c)
    }
  }

  getBlock (p) { return this.world.getBlock(new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) }

  setBlock (p, name, props = {}) {
    const type = registry.blocksByName[name]
    if (!type) throw new Error('sim: unknown block ' + name)
    const st = Block.fromProperties(type.id, props, 0)
    const pos = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const old = this.world.getBlock(pos)
    this.world.setBlockStateId(pos, st.stateId)
    const nw = this.world.getBlock(pos)
    for (const bot of this.bots) {
      bot.emit(`blockUpdate:${pos}`, old, nw)
      bot.emit('blockUpdate', old, nw)
    }
    return nw
  }

  setAir (p) { return this.setBlock(p, 'air') }

  fillBox (a, b, name, props) {
    for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) for (let z = Math.min(a.z, b.z); z <= Math.max(a.z, b.z); z++) this.setBlock(new Vec3(x, y, z), name, props)
  }

  solidFull (b) { return b && b.boundingBox === 'block' && b.shapes.some(s => s[0] <= 0 && s[1] <= 0 && s[2] <= 0 && s[3] >= 1 && s[4] >= 1 && s[5] >= 1) }
  sturdy (pos, face) { // can something attach to `face` of the block at pos
    const b = this.getBlock(pos)
    return b && b.boundingBox === 'block' && !/leaves|glass|ice|slab|stairs/.test(b.name) ? true : (b && /^(.*_)?(stairs|slab)$/.test(b.name) ? false : Boolean(b && this.solidFull(b)))
  }

  // ---- placing ----------------------------------------------------------------------------
  // returns { ok, reason }
  place (bot, ref, faceName, cursor, held) {
    const r = this.place0(bot, ref, faceName, cursor, held)
    if (!r.ok && process.env.SIMDEBUG) console.log('SIM REJECT', r.reason, `ref=${ref} face=${faceName} bot=${bot.entity.position}`)
    return r
  }

  place0 (bot, ref, faceName, cursor, held) {
    const refBlock = this.getBlock(ref)
    const face = DIRS[faceName]
    const eye = bot.eyePos()
    const hit = new Vec3(ref.x + cursor.x, ref.y + cursor.y, ref.z + cursor.z)
    if (!refBlock || refBlock.name === 'air') return { ok: false, reason: 'reference is air' }
    if (eye.distanceTo(hit) > 4.7) return { ok: false, reason: `out of reach ${eye.distanceTo(hit).toFixed(2)}` }
    if (this.strictLook) {
      const { yRot, xRot } = packetRot(bot)
      const dir = viewVector(yRot, xRot)
      const r = this.world.raycast(eye, dir, 6)
      const good = r && r.position.equals(ref) && FACE_BY_INDEX[r.face] === faceName && r.intersect.distanceTo(hit) < 0.45
      if (!good) { this.violations.push(`click not under crosshair: ref ${ref} face ${faceName}`); return { ok: false, reason: 'anticheat: crosshair is not on the clicked face' } }
    }
    if (!held) return { ok: false, reason: 'empty hand' }
    // interactive reference blocks eat the click unless sneaking
    if (/(chest|barrel|furnace|crafter|dropper|dispenser|hopper|crafting_table|_door|trapdoor|fence_gate|button|lever|note_block|repeater|comparator|_sign|lectern)$/.test(refBlock.name) && !bot.sneaking) {
      this.interact(refBlock)
      return { ok: false, reason: 'click used by ' + refBlock.name, used: true }
    }
    const target = ref.plus(face)
    const existing = this.world.getBlock(target)
    if (!REPLACEABLE.has(existing.name)) return { ok: false, reason: `target occupied by ${existing.name}` }
    const itemName = held.name
    const blockName = this.blockForItem(itemName)
    if (!blockName) return { ok: false, reason: `item ${itemName} is not a block` }
    // body collision
    const a = bot.aabb()
    const type = registry.blocksByName[blockName]
    if (type && type.boundingBox === 'block') {
      if (a.minX < target.x + 1 && a.maxX > target.x && a.minY < target.y + 1 && a.maxY > target.y && a.minZ < target.z + 1 && a.maxZ > target.z) return { ok: false, reason: 'entity in the way' }
    }
    const props = this.stateFor(blockName, { bot, ref, face: faceName, cursor, target, hit, existing })
    if (!props) return { ok: false, reason: 'cannot place here' }
    if (!this.canSurvive(props._name || blockName, props, target)) return { ok: false, reason: `${blockName} cannot survive at ${target}` }
    if (WATERLOGGABLE({ getProperties: () => props }) && existing.name === 'water') props.waterlogged = 'true'
    const finalName = props._name || blockName
    delete props._name
    this.setBlock(target, finalName, props)
    if (/_door$/.test(blockName)) this.setBlock(target.offset(0, 1, 0), blockName, { ...props, half: 'upper' })
    bot.consume()
    return { ok: true, target }
  }

  interact (b) {
    const p = { ...b.getProperties() }
    if (b.name === 'note_block') p.note = String((+p.note + 1) % 25)
    else if (b.name === 'repeater') p.delay = String((+p.delay % 4) + 1)
    else if (b.name === 'comparator') p.mode = p.mode === 'compare' ? 'subtract' : 'compare'
    else if (/trapdoor|fence_gate/.test(b.name) || (/_door$/.test(b.name) && !/iron/.test(b.name))) p.open = p.open === 'true' ? 'false' : 'true'
    else if (b.name === 'lever') p.powered = p.powered === 'true' ? 'false' : 'true'
    else return
    if (/trapdoor|fence_gate/.test(b.name) && /iron_trapdoor/.test(b.name)) return
    this.setBlock(b.position, b.name, p)
  }

  blockForItem (item) {
    const m = { redstone: 'redstone_wire', string: 'tripwire', oak_sign: 'oak_wall_sign', spruce_sign: 'spruce_wall_sign', water_bucket: null, lava_bucket: null }
    if (item in m) return m[item]
    if (registry.blocksByName[item]) return item
    return null
  }

  defaults (name) {
    const t = registry.blocksByName[name]
    return Block.fromStateId(t.defaultState, 0).getProperties()
  }

  stateFor (name, c) {
    const p = { ...this.defaults(name) }
    const { bot, face, cursor } = c
    const { yRot, xRot } = packetRot(bot)
    const look = viewVector(yRot, xRot)
    const hdir = horizontalDirection(yRot)
    const nearest = nearestLooking(look)
    const sideFace = face !== 'up' && face !== 'down'
    const top = !(face !== 'down' && (face === 'up' || cursor.y <= 0.5))
    let m
    if (name === 'oak_sign' || /_sign$/.test(name) && !/wall/.test(name)) return null
    if (/_stairs$/.test(name)) { p.facing = hdir; p.half = top ? 'top' : 'bottom'; return p }
    if (/_slab$/.test(name)) { p.type = top ? 'top' : 'bottom'; return p }
    if (/_trapdoor$/.test(name)) {
      if (sideFace) { p.facing = face; p.half = cursor.y > 0.5 ? 'top' : 'bottom' } else { p.facing = OPP[hdir]; p.half = face === 'up' ? 'bottom' : 'top' }
      return p
    }
    if (/_door$/.test(name)) {
      p.facing = hdir; p.half = 'lower'
      const s = DIRS[hdir]
      const d0 = cursor.x; const d1 = cursor.z
      p.hinge = ((s.x < 0 && d1 < 0.5) || (s.x > 0 && d1 > 0.5) || (s.z < 0 && d0 > 0.5) || (s.z > 0 && d0 < 0.5)) ? 'right' : 'left'
      return p
    }
    if (/_fence_gate$/.test(name)) { p.facing = hdir; return p }
    if (name === 'hopper') { const d = OPP[face]; p.facing = (d === 'up' || d === 'down') ? 'down' : d; return p }
    if (/^(piston|sticky_piston|dropper|dispenser)$/.test(name)) { p.facing = OPP[nearest]; return p }
    if (name === 'observer') { p.facing = this.observerMode === 'opposite' ? OPP[nearest] : nearest; return p }
    if (name === 'barrel') { p.facing = OPP[nearest]; return p }
    if (name === 'crafter') {
      const front = OPP[nearest]
      let topDir
      if (front === 'down') topDir = OPP[hdir]; else if (front === 'up') topDir = hdir; else topDir = 'up'
      p.orientation = `${front}_${topDir}`
      return p
    }
    if (name === 'chest') { p.facing = OPP[hdir]; p.type = 'single'; return p }
    if (name === 'repeater' || name === 'comparator') { p.facing = OPP[hdir]; return p }
    if (name === 'redstone_torch' || name === 'torch') {
      if (face === 'up') return p
      if (face === 'down') return null
      return { ...this.defaults(name === 'torch' ? 'wall_torch' : 'redstone_wall_torch'), facing: face, _name: name === 'torch' ? 'wall_torch' : 'redstone_wall_torch' }
    }
    if (/_wall_sign$/.test(name)) { if (!sideFace) return null; p.facing = face; return p }
    if (name === 'tripwire_hook') {
      if (!sideFace) return null
      // look direction = first horizontal nearest-looking direction; hook faces opposite
      p.facing = OPP[horizontalDirection(yRot)]
      return p
    }
    if (name === 'lever') {
      if (sideFace) { p.face = 'wall'; p.facing = face } else { p.face = face === 'up' ? 'floor' : 'ceiling'; p.facing = hdir }
      return p
    }
    if (/_button$/.test(name)) { if (sideFace) { p.face = 'wall'; p.facing = face } else { p.face = face === 'up' ? 'floor' : 'ceiling'; p.facing = hdir } return p }
    if ((m = this.defaults(name)) && 'axis' in m) { p.axis = (face === 'up' || face === 'down') ? 'y' : (face === 'east' || face === 'west') ? 'x' : 'z'; return p }
    if ('waterlogged' in p) p.waterlogged = 'false'
    return p
  }

  canSurvive (name, p, target) {
    const below = this.getBlock(target.offset(0, -1, 0))
    const needFloor = /^(redstone_wire|repeater|comparator|powered_rail|rail|tripwire_hook_x)$/.test(name)
    if (needFloor && !(below && this.solidFull(below))) return false
    if (/^(redstone_torch|torch)$/.test(name) && !(below && below.boundingBox === 'block')) return false
    if (/wall_torch$|_wall_sign$|^tripwire_hook$/.test(name) || (name === 'lever' && p.face === 'wall')) {
      const back = DIRS[OPP[p.facing]]
      const b = this.getBlock(target.plus(back))
      if (!(b && b.boundingBox === 'block')) return false
    }
    return true
  }

  // ---- use item (buckets) --------------------------------------------------------------------
  useItem (bot, held) {
    const res = this.useItem0(bot, held)
    if (!res.ok && process.env.SIMDEBUG) console.log('SIM USE REJECT', held && held.name, JSON.stringify(res), 'bot', bot.entity.position.toString(), 'sneak', bot.sneaking, 'yaw/pitch', bot.entity.yaw.toFixed(3), bot.entity.pitch.toFixed(3))
    return res
  }

  useItem0 (bot, held) {
    if (!held || !/^(water|lava)_bucket$/.test(held.name)) return { ok: false }
    const { yRot, xRot } = packetRot(bot)
    const r = this.world.raycast(bot.eyePos(), viewVector(yRot, xRot), 5)
    if (!r) return { ok: false }
    const fluid = held.name.startsWith('water') ? 'water' : 'lava'
    const hitBlock = this.world.getBlock(r.position)
    if (/(chest|barrel|furnace|crafter|hopper|trapdoor|fence_gate|_door|_sign|lever|button|note_block)$/.test(hitBlock.name) && !bot.sneaking) return { ok: false, opened: hitBlock.name }
    if (fluid === 'water' && WATERLOGGABLE(hitBlock) && String(hitBlock.getProperties().waterlogged) === 'false') {
      this.setBlock(r.position, hitBlock.name, { ...hitBlock.getProperties(), waterlogged: 'true' })
      bot.swapBucket(held)
      return { ok: true }
    }
    const target = r.position.plus(DIRS[FACE_BY_INDEX[r.face]])
    const ex = this.world.getBlock(target)
    if (!REPLACEABLE.has(ex.name) || bot.inside(target)) { if (process.env.SIMDEBUG) console.log('SIM BUCKET REJECT hit', hitBlock.name, r.position, 'face', FACE_BY_INDEX[r.face], 'target', target, ex.name); return { ok: false } }
    this.setBlock(target, fluid, { level: '0' })
    bot.swapBucket(held)
    return { ok: true }
  }
}

class SimBot extends EventEmitter {
  constructor (server, pos, opts = {}) {
    super()
    this.server = server
    server.bots.push(this)
    this.registry = registry
    this.version = VERSION
    this.username = opts.username || 'BuilderBot'
    this.world = server.world
    this.entity = { position: new Vec3(pos.x, pos.y, pos.z), velocity: new Vec3(0, -0.0784, 0), yaw: 0, pitch: 0, onGround: true, eyeHeight: 1.62, isInWater: false, isInLava: false, attributes: {}, effects: [] }
    this.game = { gameMode: 'survival', minY: -64, dimension: 'overworld' }
    this.abilities = {}
    this.health = 20
    this.physicsEnabled = true
    this.sneaking = false
    this.controls = {}
    this.quickBarSlot = 0
    this.heldItem = null
    this.slots = new Array(46).fill(null)
    this.inventory = { items: () => this.slots.filter(Boolean), slots: this.slots }
    this.givenCommands = []
    this.placements = 0
    this.targetDigFace = 1
    this.digFaces = []
    this.signs = new Map()
    this.setMaxListeners(100)
    this.timer = setInterval(() => this.physicsStep(), Number(process.env.SIMTICK || 50))

  }

  dispose () { clearInterval(this.timer) }
  eyePos () { return this.entity.position.offset(0, this.sneaking ? 1.27 : 1.62, 0) }
  aabb () { const p = this.entity.position; return { minX: p.x - 0.3, maxX: p.x + 0.3, minY: p.y, maxY: p.y + 1.8, minZ: p.z - 0.3, maxZ: p.z + 0.3 } }
  inside (cell) { const a = this.aabb(); return a.minX < cell.x + 1 && a.maxX > cell.x && a.minY < cell.y + 1 && a.maxY > cell.y && a.minZ < cell.z + 1 && a.maxZ > cell.z }

  // vertical physics only (enough for towers and ground detection)
  physicsStep () {
    const e = this.entity
    if (this.controls.jump && e.onGround) { e.velocity.y = 0.42; e.onGround = false }
    if (this.controls.forward || this.controls.back) {
      const sp = (this.sneaking ? 0.0647 : 0.1) * (this.controls.forward ? 1 : -1)
      const nx = e.position.x - Math.sin(e.yaw) * sp; const nz = e.position.z - Math.cos(e.yaw) * sp
      const keep = e.position.clone()
      e.position.x = nx; e.position.z = nz
      // sneaking never walks off an edge: the box must keep some support under it
      if (this.sneaking && e.onGround && this.floorUnder(e.position.y + 0.001) < e.position.y - 0.01) { e.position.x = keep.x; e.position.z = keep.z }
    }
    const prev = e.position.y
    if (!e.onGround) { e.position.y += e.velocity.y; e.velocity.y = (e.velocity.y - 0.08) * 0.98 }
    const floor = this.floorUnder(Math.max(prev, e.position.y))
    if (e.velocity.y <= 0 && e.position.y <= floor + 1e-9 && floor >= Math.min(prev, e.position.y) - 1e-6) { e.position.y = floor; e.onGround = true; e.velocity.y = -0.0784 }
    else if (e.onGround && e.position.y > floor + 1e-6) { e.onGround = false; e.velocity.y = 0 }
    this.emit('physicsTick')
  }

  // highest collision top at or below `fromY` under the footprint
  floorUnder (fromY = this.entity.position.y) {
    const p = this.entity.position
    let best = -1e9
    for (const dx of [-0.29, 0.29]) for (const dz of [-0.29, 0.29]) {
      for (let y = Math.floor(fromY + 0.001); y >= Math.floor(fromY) - 3; y--) {
        const b = this.server.world.getBlock(new Vec3(Math.floor(p.x + dx), y, Math.floor(p.z + dz)))
        if (b && b.shapes) for (const s of b.shapes) { const top = y + s[4]; if (top <= fromY + 0.0001 && top > best) best = top }
      }
    }
    return best
  }

  blockAt (pos) { const p = new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)); return this.server.world.getBlock(p) }
  getControlState (k) { return k === 'sneak' ? this.sneaking : Boolean(this.controls[k]) }
  setControlState (k, v) { this.controls[k] = v; if (k === 'sneak') this.sneaking = v }
  clearControlStates () { this.controls = {}; this.sneaking = false }
  async look (yaw, pitch) { this.entity.yaw = yaw; this.entity.pitch = pitch }
  swingArm () {}
  supportFeature () { return false }
  setQuickBarSlot (n) { this.quickBarSlot = n; this.heldItem = this.slots[36 + n] }
  async equip (item) {
    const idx = this.slots.indexOf(item)
    if (idx < 0) throw new Error('item not in inventory')
    if (idx < 36 || idx > 44) { this.slots[idx] = null; const slot = 36 + this.quickBarSlot; this.slots[idx] = this.slots[slot]; this.slots[slot] = item } 
    this.heldItem = this.slots[36 + this.quickBarSlot] === item ? item : (this.setQuickBarSlot(idx - 36), item)
    this.heldItem = item
  }

  giveItem (name, n) {
    const type = registry.itemsByName[name]
    if (!type) return false
    const stack = type.stackSize
    let left = n
    for (const [i, it] of this.slots.entries()) { if (left > 0 && it && it.name === name && it.count < stack) { const add = Math.min(left, stack - it.count); it.count += add; left -= add } void i }
    while (left > 0) {
      const slot = [...Array(9).keys()].map(i => 36 + i).concat([...Array(27).keys()].map(i => 9 + i)).find(i => !this.slots[i])
      if (slot == null) return false
      const c = Math.min(left, stack)
      this.slots[slot] = new Item(type.id, c)
      left -= c
    }
    return true
  }

  consume () {
    const it = this.heldItem
    if (!it) return
    it.count -= 1
    if (it.count <= 0) { const i = this.slots.indexOf(it); if (i >= 0) this.slots[i] = null; this.heldItem = null }
  }

  swapBucket (held) { const i = this.slots.indexOf(held); if (i >= 0) { this.slots[i] = new Item(registry.itemsByName.bucket.id, 1); this.heldItem = this.slots[i] } }

  chat (msg) {
    this.givenCommands.push(msg)
    let m
    if ((m = msg.match(/^\/give (\S+) minecraft:(\S+) (\d+)/))) setTimeout(() => { this.giveItem(m[2], +m[3]); this.emit('inventory') }, 20)
    else if ((m = msg.match(/^\/clear (\S+) minecraft:(\S+)/))) setTimeout(() => { for (let i = 0; i < this.slots.length; i++) if (this.slots[i]?.name === m[2]) this.slots[i] = null }, 20)
  }

  async _genericPlace (ref, faceVec, opts) {
    const faceName = Object.keys(DIRS).find(k => DIRS[k].equals(faceVec))
    const cursor = opts.delta || new Vec3(0.5, 0.5, 0.5)
    if (!this.heldItem) throw new Error('must be holding an item to place')
    this.placements++
    const r = this.server.place(this, ref.position, faceName, cursor, this.heldItem)
    this.lastPlaceResult = r
    // server answers a block_place with an update for the reference block
    setTimeout(() => this.emit(`blockUpdate:${ref.position}`, ref, this.blockAt(ref.position)), 5)
    return ref.position
  }

  async _placeBlockWithOptions (ref, faceVec, opts) {
    const dest = ref.position.plus(faceVec)
    const old = this.blockAt(dest)
    const wait = new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off(`blockUpdate:${dest}`, h); reject(new Error(`Server did not answer the placement at ${dest}`)) }, 1200)
      const h = (o, n) => { if (!o || !n || o.type !== n.type) { clearTimeout(t); this.off(`blockUpdate:${dest}`, h); resolve(n) } }
      this.on(`blockUpdate:${dest}`, h)
    })
    await this._genericPlace(ref, faceVec, opts)
    const nw = await wait.catch(async e => { await new Promise(r => setTimeout(r, 30)); throw e })
    if (nw && nw.type === old.type) throw new Error('refused')
  }

  activateItem () { this.server.useItem(this, this.heldItem) }

  async dig (block) {
    const b = this.blockAt(block.position)
    if (!b || b.name === 'air') throw new Error('nothing to dig')
    if (this.eyePos().distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 6) throw new Error('too far to dig')
    this.digFaces.push(this.targetDigFace)
    await new Promise(r => setTimeout(r, 15))
    this.server.setAir(block.position)
  }

  updateSign (block, text, back) { this.signs.set(`${block.position}${back ? 'b' : 'f'}`, text) }
}

module.exports = { SimServer, SimBot, registry, Block, DIRS, OPP, viewVector, packetRot, horizontalDirection, nearestLooking, REPLACEABLE }
