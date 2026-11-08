'use strict'
// A small but REAL 1.21.4 server for local runs of the whole bot (brain, walker, scaffolding, shop-less /give).
// Flat world: bedrock y=-64, dirt -63..-62, grass -61. It applies block_place / block_dig / /give exactly the way
// a vanilla server would answer (block_change + sequence ack), and keeps a per-player inventory.
//   node tests/testbed/server.js [port]      or  const { start } = require('./server')
const path = require('path')
const root = path.resolve(__dirname, '..', '..')
const nm = p => require(path.join(root, 'node_modules', p))
const mc = nm('minecraft-protocol')
const { Vec3 } = nm('vec3')
const V = '1.21.4'
const mcData = nm('minecraft-data')(V)
const reg = nm('prismarine-registry')(V)
const Chunk = nm('prismarine-chunk')(reg)
const Item = nm('prismarine-item')(reg)

const FACE = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
const GROUND_Y = -61

function start ({ port = 25599, spawn = { x: 8, y: -60, z: 8 }, log = () => {}, giveDelayMs = 0 } = {}) {
  const server = mc.createServer({ 'online-mode': false, host: '127.0.0.1', port, version: V, maxPlayers: 20 })
  const edits = new Map() // "x,y,z" -> stateId (everything that differs from the flat terrain)
  const stats = { placed: 0, broken: 0, gives: 0, rejected: 0, players: new Map() }
  const air = mcData.blocksByName.air.defaultState
  const terrain = (x, y, z) => {
    if (y === -64) return mcData.blocksByName.bedrock.defaultState
    if (y >= -63 && y <= -62) return mcData.blocksByName.dirt.defaultState
    if (y === GROUND_Y) return mcData.blocksByName.grass_block.defaultState
    return air
  }
  const stateAt = (x, y, z) => { const k = `${x},${y},${z}`; return edits.has(k) ? edits.get(k) : terrain(x, y, z) }
  const setState = (x, y, z, s) => { edits.set(`${x},${y},${z}`, s) }
  const blockNameOf = s => (reg.blocksByStateId[s] || {}).name || 'air'

  const base = new Chunk({ minY: -64, worldHeight: 384 })
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
    base.setBlockStateId(new Vec3(x, -64, z), terrain(0, -64, 0))
    for (let y = -63; y <= -61; y++) base.setBlockStateId(new Vec3(x, y, z), terrain(0, y, 0))
    for (let y = -64; y < 320; y++) base.setSkyLight(new Vec3(x, y, z), 15)
  }
  const chunkData = base.dump()
  const players = new Set()
  const broadcast = (name, pkt, except) => { for (const c of players) if (c !== except) { try { c.write(name, pkt) } catch {} } }
  const blockChange = (x, y, z, s) => broadcast('block_change', { location: { x, y, z }, type: s })

  server.on('playerJoin', client => {
    players.add(client)
    const inv = new Map() // slot -> { type, count }
    let held = 0
    let sequenceSeen = 0
    const st = { name: client.username, place: 0, dig: 0, falls: 0, lastPos: null, gives: [] }
    stats.players.set(client.username, st)
    client.write('login', { ...mcData.loginPacket, entityId: client.id, isHardcore: false, gameMode: 0, previousGameMode: 255, worldName: 'minecraft:overworld', hashedSeed: [0, 0], maxPlayers: 20, viewDistance: 8, reducedDebugInfo: false, enableRespawnScreen: true, isDebug: false, isFlat: true })
    for (let cx = -6; cx <= 6; cx++) for (let cz = -6; cz <= 6; cz++) {
      client.write('map_chunk', { x: cx, z: cz, heightmaps: { type: 'compound', name: '', value: {} }, chunkData, blockEntities: [], trustEdges: false, skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] })
    }
    // edits made before this player joined
    for (const [k, s] of edits) { const [x, y, z] = k.split(',').map(Number); client.write('block_change', { location: { x, y, z }, type: s }) }
    client.write('position', { teleportId: 1, x: spawn.x, y: spawn.y, z: spawn.z, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0, flags: { onGround: false, x: false, y: false, z: false, yaw: false, pitch: false } })
    client.write('update_health', { health: 20, food: 20, foodSaturation: 5 })

    const sendSlot = slot => {
      const it = inv.get(slot)
      client.write('set_slot', { windowId: 0, stateId: 0, slot, item: it ? Item.toNotch(new Item(it.type, it.count)) : Item.toNotch(null) })
    }
    const give = (name, count) => {
      const info = mcData.itemsByName[name]
      if (!info) return false
      let left = count
      const stack = info.stackSize || 64
      for (let s = 36; s <= 44 && left > 0; s++) { const it = inv.get(s); if (it && it.type === info.id && it.count < stack) { const n = Math.min(left, stack - it.count); it.count += n; left -= n; sendSlot(s) } }
      for (const s of [36, 37, 38, 39, 40, 41, 42, 43, 44, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]) {
        if (left <= 0) break
        if (inv.has(s)) continue
        const n = Math.min(left, stack); inv.set(s, { type: info.id, count: n }); left -= n; sendSlot(s)
      }
      return left < count
    }
    client.on('chat_command', p => {
      const m = /^give\s+(\S+)\s+(?:minecraft:)?(\S+)(?:\s+(\d+))?/.exec(p.command)
      if (m) { const ok = give(m[2], Number(m[3] || 1)); stats.gives++; st.gives.push([m[2], Number(m[3] || 1)]); log(`give ${m[2]} x${m[3] || 1} -> ${ok}`) }
    })
    client.on('held_item_slot', p => { held = p.slotId })
    client.on('window_click', p => { // the client says which slots changed: apply them like a server that accepted the click
      if (p.windowId !== 0) return
      for (const c of p.changedSlots || []) {
        let it = null
        try { it = Item.fromNotch(c.item) } catch { it = null }
        if (it && it.count > 0) inv.set(c.location, { type: it.type, count: it.count }); else inv.delete(c.location)
      }
    })
    client.on('block_dig', p => {
      const { x, y, z } = p.location
      if (p.status === 2 || p.status === 0 && false) {
        const s = stateAt(x, y, z)
        if (s !== air && blockNameOf(s) !== 'bedrock') { setState(x, y, z, air); blockChange(x, y, z, air); stats.broken++; st.dig++ }
        else stats.rejected++
      }
      if (p.sequence !== undefined) client.write('acknowledge_player_digging', { sequenceId: p.sequence })
    })
    client.on('block_place', p => {
      const it = inv.get(36 + held)
      const { x, y, z } = p.location
      const f = FACE[p.direction] || [0, 1, 0]
      const tx = x + f[0]; const ty = y + f[1]; const tz = z + f[2]
      if (p.sequence !== undefined) client.write('acknowledge_player_digging', { sequenceId: p.sequence })
      if (!it) { stats.rejected++; log(`reject place: no item in held slot ${held}`); return }
      const info = mcData.items[it.type]
      const b = mcData.blocksByName[info.name]
      const cur = stateAt(tx, ty, tz)
      const curName = blockNameOf(cur)
      const replaceable = cur === air || /^(water|lava|short_grass|tall_grass|fern|snow)$/.test(curName)
      if (!b || !replaceable || stateAt(x, y, z) === air) { stats.rejected++; log(`reject place ${info.name} at ${tx},${ty},${tz}: ${!b ? 'not a block' : !replaceable ? 'target is ' + curName : 'reference ' + x + ',' + y + ',' + z + ' is air'}`); client.write('block_change', { location: { x: tx, y: ty, z: tz }, type: cur }); return }
      let placedState = b.defaultState
      if (info.name === 'chest') placedState = chestState(tx, ty, tz) // like vanilla: facing = opposite of the player's SERVER-SIDE yaw, merges unless sneaking
      setState(tx, ty, tz, placedState); blockChange(tx, ty, tz, placedState)
      it.count--; if (it.count <= 0) inv.delete(36 + held); sendSlot(36 + held)
      stats.placed++; st.place++
    })
    client.on('position', p => { st.lastPos = { x: p.x, y: p.y, z: p.z } })
    client.on('position_look', p => { st.lastPos = { x: p.x, y: p.y, z: p.z }; st.yaw = p.yaw })
    client.on('look', p => { st.yaw = p.yaw })
    client.on('player_input', p => { st.sneak = Boolean(p.inputs && p.inputs.shift) })
    client.on('entity_action', p => { if (p.actionId === 'start_sneaking') st.sneak = true; if (p.actionId === 'stop_sneaking') st.sneak = false })
    const DIRS4 = ['south', 'west', 'north', 'east'] // yaw 0 / 90 / 180 / 270
    const OPP4 = { south: 'north', north: 'south', west: 'east', east: 'west' }
    const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
    const VEC4 = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] }
    const chestB = mcData.blocksByName.chest
    const chestId = (facing, type) => chestB.minStateId + ['north', 'south', 'west', 'east'].indexOf(facing) * 6 + ['single', 'left', 'right'].indexOf(type) * 2 + 1 // waterlogged=false is the last value
    const chestOf = (x, y, z) => { const s = stateAt(x, y, z); if (s < chestB.minStateId || s > chestB.maxStateId) return null; const r = s - chestB.minStateId; return { facing: ['north', 'south', 'west', 'east'][Math.floor(r / 6)], type: ['single', 'left', 'right'][Math.floor((r % 6) / 2)] } }
    const chestState = (x, y, z) => {
      const look = DIRS4[Math.floor((((st.yaw || 0) % 360) + 360 + 45) % 360 / 90)]
      const facing = OPP4[look]
      let type = 'single'
      if (!st.sneak) {
        const nb = (dir) => { const v = VEC4[dir]; const c = chestOf(x + v[0], y, z + v[1]); return c && c.type === 'single' && c.facing === facing ? [x + v[0], z + v[1]] : null }
        const cw = nb(CW[facing]); const ccw = nb(OPP4[CW[facing]])
        if (cw) { type = 'right'; setState(cw[0], y, cw[1], chestId(facing, 'left')); blockChange(cw[0], y, cw[1], chestId(facing, 'left')) } else if (ccw) { type = 'left'; setState(ccw[0], y, ccw[1], chestId(facing, 'right')); blockChange(ccw[0], y, ccw[1], chestId(facing, 'right')) }
      }
      return chestId(facing, type)
    }
    client.on('end', () => { players.delete(client); log(`left ${client.username}`) })
    log(`join ${client.username}`)
  })
  return { server, stats, stateAt, blockNameOf, edits, close: () => new Promise(r => { for (const c of players) { try { c.end('bye') } catch {} } server.close(r) }) }
}

module.exports = { start, GROUND_Y }
if (require.main === module) { const s = start({ port: Number(process.argv[2] || 25599), log: m => console.log(m) }); console.log('testbed up'); process.on('SIGINT', () => s.close().then(() => process.exit(0))) }
