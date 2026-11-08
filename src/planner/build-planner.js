'use strict'

const { Vec3 } = require('../util/vec3')
const { describeBlock, taskMatches, SIDES, usableFaces } = require('../rules/blocks')
const { FACES } = require('../interaction/geometry')
const { SchematicIntelligence } = require('./intelligence')

const DEFAULT_IGNORED = ['bedrock', 'barrier', 'light', 'structure_void', 'command_block', 'chain_command_block', 'repeating_command_block', 'structure_block', 'jigsaw', 'end_portal', 'end_portal_frame', 'end_gateway', 'nether_portal', 'reinforced_deepslate']
const CELL = 8 // spatial bucket size (blocks)

function keyOf (pos) { return `${pos.x},${pos.y},${pos.z}` }

function normalizeRotation (rotation) { return ((Number(rotation) % 360) + 360) % 360 }

function turnHorizontal (value, turns) {
  const i = SIDES.indexOf(value)
  return i === -1 ? value : SIDES[(i + turns) % 4]
}

const RAIL_ROT = {
  north_south: 'east_west', east_west: 'north_south',
  ascending_east: 'ascending_south', ascending_south: 'ascending_west', ascending_west: 'ascending_north', ascending_north: 'ascending_east',
  south_east: 'south_west', south_west: 'north_west', north_west: 'north_east', north_east: 'south_east'
}

// Rotate block-state properties by `rotation` degrees (clockwise, multiples of 90).
function rotateProperties (properties, rotation) {
  const turns = normalizeRotation(rotation) / 90
  const out = {}
  for (const [k, v] of Object.entries(properties || {})) out[k] = String(v)
  if (!turns) return out
  if (out.facing) { for (let i = 0; i < turns; i++) out.facing = turnHorizontal(out.facing, 1) }
  if (out.axis && (turns % 2) === 1) out.axis = out.axis === 'x' ? 'z' : out.axis === 'z' ? 'x' : out.axis
  if (out.rotation !== undefined && Number.isFinite(Number(out.rotation))) out.rotation = String((((Number(out.rotation) + turns * 4) % 16) + 16) % 16)
  if (out.shape && RAIL_ROT[out.shape]) { for (let i = 0; i < turns; i++) out.shape = RAIL_ROT[out.shape] || out.shape }
  if (out.orientation) {
    const [front, top] = out.orientation.split('_')
    const t = (d) => { let x = d; for (let i = 0; i < turns; i++) x = turnHorizontal(x, 1); return x }
    out.orientation = `${t(front)}_${t(top)}`
  }
  const conn = {}
  for (const s of SIDES) if (out[s] !== undefined) conn[s] = out[s]
  if (Object.keys(conn).length) {
    for (const s of SIDES) { delete out[s] }
    for (const [s, v] of Object.entries(conn)) out[turnHorizontal(s, turns)] = v
  }
  return out
}

class BuildPlanner {
  constructor (loaded, transform, worldModel, config, logger) {
    this.schematic = loaded.schematic
    this.bot = worldModel.bot
    this.transform = transform
    this.world = worldModel
    this.config = config
    this.logger = logger

    this.tasks = new Map()
    this.ready = new Set()
    this.blocked = new Set()
    this.quarantined = new Set()
    this.completed = new Set()
    this.failed = new Map()
    this.reverseNeighbors = new Map()
    this.chunkTasks = new Map()
    this.orderGroups = new Map()
    this.orders = []
    this.total = 0
    this.doneAtStart = 0
    this.rotation = transform.rotation
    this.materialDemand = new Map()
    this.ignored = new Set(config?.building?.ignoreBlocks || DEFAULT_IGNORED)
    this.census = { ignored: {}, skippedAir: 0, derived: 0, unsupported: [], byKind: {}, byPhase: {}, lookUp: 0 }
    this.tiles = loaded.schematic.tiles || new Map()
    this.fleet = null
    this.sawBusy = false
    this.fluidCells = new Map()
    this.pitCells = new Set()
  }

  joinFleet (coord, id, index, count) {
    this.fleet = { coord, id, index, count, cursor: 0 }
    const groups = new Map()
    for (const t of this.tasks.values()) {
      let list = groups.get(t.order)
      if (!list) groups.set(t.order, (list = []))
      list.push(t)
    }
    const partition2D = (items, workerIds) => {
      if (!items.length) return
      let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
      for (const t of items) { minX = Math.min(minX, t.world.x); maxX = Math.max(maxX, t.world.x); minZ = Math.min(minZ, t.world.z); maxZ = Math.max(maxZ, t.world.z) }
      // Never split a single vertical 1x1 column across multiple workers!
      if (workerIds.length <= 1 || (minX === maxX && minZ === maxZ)) {
        const owner = workerIds[0] ?? 0
        for (const t of items) t.owner = owner
        return
      }
      const alongX = (maxX - minX) >= (maxZ - minZ)
      const A = t => (alongX ? t.world.x : t.world.z)
      const B = t => (alongX ? t.world.z : t.world.x)
      items.sort((p, q) => A(p) - A(q) || B(p) - B(q) || p.world.y - q.world.y)
      const leftWorkers = Math.floor(workerIds.length / 2)
      const cutIdx = Math.floor(items.length * leftWorkers / workerIds.length)
      partition2D(items.slice(0, cutIdx), workerIds.slice(0, leftWorkers))
      partition2D(items.slice(cutIdx), workerIds.slice(leftWorkers))
    }
    const { builderWorkerIndices } = require('../fleet/sweeper')
    const allWorkers = builderWorkerIndices(count, this.config)
    const partitionClusters = (clusterBuckets, workerIds) => {
      if (!clusterBuckets.length) return
      if (workerIds.length <= 1 || clusterBuckets.length === 1) {
        const owner = workerIds[0] ?? 0
        for (const b of clusterBuckets) for (const t of b.items) t.owner = owner
        return
      }
      let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity
      for (const b of clusterBuckets) {
        minX = Math.min(minX, b.cx); maxX = Math.max(maxX, b.cx)
        minZ = Math.min(minZ, b.cz); maxZ = Math.max(maxZ, b.cz)
      }
      const alongX = (maxX - minX) >= (maxZ - minZ)
      clusterBuckets.sort((p, q) => (alongX ? p.cx - q.cx : p.cz - q.cz) || (alongX ? p.cz - q.cz : p.cx - q.cx))
      const leftWorkers = Math.floor(workerIds.length / 2)
      const cutIdx = Math.max(1, Math.floor(clusterBuckets.length * leftWorkers / workerIds.length))
      partitionClusters(clusterBuckets.slice(0, cutIdx), workerIds.slice(0, leftWorkers))
      partitionClusters(clusterBuckets.slice(cutIdx), workerIds.slice(leftWorkers))
    }
    for (const [ord, list] of groups.entries()) {
      const frac = +(ord - Math.floor(ord)).toFixed(2)
      // Keep sequential chest pairs (.25/.30) and hopper chains (.40-.49) assigned to one primary worker so two bots never collide inside a 1-wide trench
      if (frac >= 0.24 && frac <= 0.49 && list.every(t => /^(chest|trapped_chest|ender_chest|hopper)$/.test(t.name))) {
        const owner = allWorkers[Math.min(1, allWorkers.length - 1)] ?? 0
        for (const t of list) t.owner = owner
        const grp = this.orderGroups.get(ord)
        if (grp && count > 1) { grp.isSingleWorkerChain = true; grp.chainOwner = owner }
      } else if (list.some(t => t.verticalClusterId != null)) {
        const byCluster = new Map()
        const unclustered = []
        for (const t of list) {
          if (t.verticalClusterId == null) { unclustered.push(t); continue }
          if (!byCluster.has(t.verticalClusterId)) byCluster.set(t.verticalClusterId, [])
          byCluster.get(t.verticalClusterId).push(t)
        }
        const buckets = []
        for (const [cid, items] of byCluster.entries()) {
          let sx = 0; let sz = 0
          for (const t of items) { sx += t.world.x; sz += t.world.z }
          buckets.push({ cid, items, cx: sx / items.length, cz: sz / items.length })
        }
        partitionClusters(buckets, allWorkers)
        if (unclustered.length) partition2D(unclustered, allWorkers)
      } else {
        partition2D(list, allWorkers)
      }
    }
    this.materialDemand = new Map()
    for (const t of this.tasks.values()) if (t.owner === index) this.materialDemand.set(t.item, (this.materialDemand.get(t.item) || 0) + 1)
    return this
  }

  ownCount () { let n = 0; for (const t of this.tasks.values()) if (t.owner === this.fleet?.index) n++; return n }

  syncFleet () {
    const f = this.fleet
    if (!f) return
    const log = f.coord.log
    while (f.cursor < log.length) {
      const e = log[f.cursor++]
      if (e.quarantine) {
        const t = this.tasks.get(e.key)
        if (t && t.status !== "completed" && !this.isCorrect(t)) {
          this.setStatus(t, "blocked")
          this.blocked.add(t.key)
          if (!this.quarantined) this.quarantined = new Set()
          this.quarantined.add(t.key)
        }
        continue
      }
      if (e.reopen) {
        const t = this.tasks.get(e.key)
        if (t && !this.isCorrect(t)) {
          if (this.quarantined?.has(t.key) && !e.forceUnquarantine) continue
          t.deferredUntil = 0
          t.anyUntil = 0
          if (e.ownerIndex != null && t.status !== 'completed') {
            t.attempts = 3
            t.totalAttempts = Math.max(t.totalAttempts || 0, 3)
            t.forceSupport = true
            t.hintFailed = true
          } else {
            t.attempts = 0
          }
          t.priorityBoost = true
          if (e.ownerIndex != null) t.owner = e.ownerIndex
          this.blocked.delete(t.key)
          this.quarantined?.delete(t.key)
          this.setStatus(t, 'pending')
        }
        continue
      }
      if (e.id === f.id) continue
      const t = this.tasks.get(e.key)
      if (t && t.status !== 'completed') { t.deferredUntil = 0; this.blocked.delete(t.key); this.quarantined?.delete(t.key); this.setStatus(t, 'completed') }
    }
  }

  reopenTask (keyOrPos, claimOwnerIndex = null, { forceReset = false } = {}) {
    const baseKey = typeof keyOrPos === 'string'
      ? keyOrPos.replace(/#w$/, '')
      : `${Math.floor(keyOrPos.x)},${Math.floor(keyOrPos.y)},${Math.floor(keyOrPos.z)}`
    let reopened = 0
    for (const k of [baseKey, `${baseKey}#w`]) {
      const t = this.tasks.get(k)
      if (!t) continue
      if (this.isCorrect(t)) continue
      const wasCompleted = t.status === 'completed'
      if (wasCompleted || forceReset) {
        t.deferredUntil = 0
        t.anyUntil = 0
        t.attempts = 0
        t.lastError = null
        t.priorityBoost = true
      }
      const newOwner = claimOwnerIndex != null ? claimOwnerIndex : (this.fleet ? this.fleet.index : t.owner)
      if (newOwner != null) t.owner = newOwner
      this.blocked.delete(t.key)
      this.quarantined?.delete(t.key)
      this.setStatus(t, 'pending')
      if (this.fleet && (wasCompleted || forceReset)) this.fleet.coord.reopen?.(t.key, this.fleet.id, newOwner)
      reopened++
    }
    return reopened
  }

  isPendingCell (cell) {
    const t = this.tasks.get(`${cell.x},${cell.y},${cell.z}`)
    return Boolean(t && t.kind === 'block' && t.status !== 'completed')
  }

  batchCountFrom (standCell, eye, target, reach = 4.35) {
    const targetTask = this.tasks.get(`${target.x},${target.y},${target.z}`)
    const order = targetTask ? targetTask.order : null
    const group = order != null ? this.orderGroups.get(order) : null
    if (!group || !group.cells) return 0
    const bx = Math.floor(standCell.x / CELL); const bz = Math.floor(standCell.z / CELL)
    let count = 0
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const set = group.cells.get(`${bx + dx},${bz + dz}`)
        if (!set) continue
        for (const t of set) {
          if (t.kind !== 'block' || t.status === 'completed' || t.status === 'blocked') continue
          if (t.world.x === target.x && t.world.y === target.y && t.world.z === target.z) continue
          if (this.fleet && t.owner !== undefined && t.owner !== this.fleet.index && group.remaining > 4) continue
          if (t.world.x === standCell.x && t.world.z === standCell.z && (t.world.y === standCell.y || t.world.y === standCell.y + 1)) continue
          const d = Math.hypot(t.world.x + 0.5 - eye.x, t.world.y + 0.5 - eye.y, t.world.z + 0.5 - eye.z)
          if (d >= 1.25 && d <= reach) {
            count++
            if (count >= 6) return count
          }
        }
      }
    }
    return count
  }

  assignedToMe (task) {
    if (!this.fleet) return true
    return task?.owner === this.fleet.index
  }

  fleetOk (task, mode, botPosition = null) {
    const f = this.fleet
    if (task.priorityBoost && (task.owner === f.index || !f.coord.busyFor(f.id, task, false))) return true
    if (mode === 'own') {
      if (task.owner !== f.index) return false
      if (f.coord.busyFor(f.id, task, false)) { this.sawBusy = true; return false }
      return true
    }
    if (task.owner === f.index) return false
    if (f.coord.busyFor(f.id, task, true)) { this.sawBusy = true; return false }
    if (botPosition && f.coord?.workers) {
      const myDist = Math.hypot(task.world.x - botPosition.x, task.world.z - botPosition.z)
      if (myDist > 24) {
        for (const w of f.coord.workers.values()) {
          if (w.id === f.id || w.done) continue
          const wp = f.coord.position(w)
          if (wp && Math.hypot(task.world.x - wp.x, task.world.z - wp.z) < Math.min(16, myDist * 0.45)) {
            this.sawBusy = true
            return false
          }
        }
      }
    }
    return true
  }

  take (task) {
    if (this.fleet && task) this.fleet.coord.claim(this.fleet.id, task)
    return task
  }

  orderOf (info, kind, layer, local = null) {
    if (kind === 'waterlog') return layer * 4 + 2.5
    if (kind === 'fluid') {
      if (info.name === 'lava') return layer * 4 + 3.5
      if (info.name === 'water' && local && this.schematic && typeof this.schematic.start === 'function' && typeof this.schematic.end === 'function' && this.config?.building?.deferOpenBasinWater !== false) {
        const isAirOrWaterLocal = (lx, ly, lz) => {
          const b = this.schematic.getBlock(new Vec3(lx, ly, lz))
          const n = b?.name ? b.name.replace(/^minecraft:/, '') : 'air'
          return /^(air|cave_air|void_air|water)$/.test(n)
        }
        const isWallOrSignLocal = (lx, ly, lz) => !isAirOrWaterLocal(lx, ly, lz)
        let clearAbove = true
        for (let dy = 1; dy <= 4; dy++) {
          if (!isAirOrWaterLocal(local.x, local.y + dy, local.z)) { clearAbove = false; break }
        }
        if (clearAbove) {
          const isWallOrOverhang = (lx, ly, lz) => isWallOrSignLocal(lx, ly, lz) || isWallOrSignLocal(lx, ly + 1, lz)
          const narrowX = (isWallOrOverhang(local.x - 1, local.y, local.z) || isWallOrOverhang(local.x - 2, local.y, local.z)) &&
            (isWallOrOverhang(local.x + 1, local.y, local.z) || isWallOrOverhang(local.x + 2, local.y, local.z) || isWallOrOverhang(local.x + 3, local.y, local.z))
          const narrowZ = (isWallOrOverhang(local.x, local.y, local.z - 1) || isWallOrOverhang(local.x, local.y, local.z - 2)) &&
            (isWallOrOverhang(local.x, local.y, local.z + 1) || isWallOrOverhang(local.x, local.y, local.z + 2) || isWallOrOverhang(local.x, local.y, local.z + 3))
          if (!narrowX && !narrowZ) {
            return +(88000 + layer + 0.25).toFixed(2)
          }
        }
      }
      return layer * 4 + 2.25
    }
    if (info.name === 'tnt') return 110000 + layer
    if (/^(sand|red_sand|gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg)$|_concrete_powder$/.test(info.name) && local && this.schematic) {
      const below = this.schematic.getBlock(new Vec3(local.x, local.y - 1, local.z))
      const bName = below?.name ? below.name.replace(/^minecraft:/, '') : ''
      if (bName === 'piston_head' || bName === 'piston' || bName === 'sticky_piston') return 105000 + layer
    }
    if (info.phase === 3) {
      if (/^(redstone_torch|redstone_wall_torch)$/.test(info.name || "") && local && this.schematic) {
        const upB = this.schematic.getBlock(new Vec3(local.x, local.y + 1, local.z))
        const upN = upB?.name ? upB.name.replace(/^minecraft:/, "") : ""
        if (upN && !/^(air|cave_air|void_air|water|lava|bubble_column|redstone_wire|tripwire)$/.test(upN)) {
          let nearTntOrSand = false
          for (let dx = -2; dx <= 2 && !nearTntOrSand; dx++) {
            for (let dy = -2; dy <= 2 && !nearTntOrSand; dy++) {
              for (let dz = -2; dz <= 2 && !nearTntOrSand; dz++) {
                const nb = this.schematic.getBlock(new Vec3(local.x + dx, local.y + dy, local.z + dz))
                const nn = nb?.name ? nb.name.replace(/^minecraft:/, "") : ""
                if (/^(tnt|sand|red_sand|gravel)$|_concrete_powder$/.test(nn)) nearTntOrSand = true
              }
            }
          }
          if (!nearTntOrSand) return layer * 4 + 1
        }
      }
      return 100000 + layer
    }
    if (/^(piston|sticky_piston)$/.test(info.name) && info.props?.extended === 'false' && /^(north|south|east|west)$/.test(info.props?.facing || '') && local && this.schematic) {
      const upDirect = this.schematic.getBlock(new Vec3(local.x, local.y + 1, local.z))
      const upName = upDirect?.name ? upDirect.name.replace(/^minecraft:/, '') : ''
      const upInfo = upName ? describeBlock(upName, upDirect.properties || {}) : null
      if (!upInfo?.fragile) {
        let hasObserverAbove = upName === 'observer'
        if (!hasObserverAbove) {
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nb = this.schematic.getBlock(new Vec3(local.x + dx, local.y + 1, local.z + dz))
            if (nb?.name && nb.name.replace(/^minecraft:/, '') === 'observer') { hasObserverAbove = true; break }
          }
        }
        if (hasObserverAbove) return 95000 + layer
      }
    }
    if (info.name === 'observer') {
      if (local && this.schematic) {
        let hasSolidSupport = false
        for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
          const nb = this.schematic.getBlock(new Vec3(local.x + dx, local.y + dy, local.z + dz))
          const nn = nb?.name ? nb.name.replace(/^minecraft:/, '') : ''
          if (!nn || /^(air|cave_air|void_air|water|lava)$/.test(nn)) continue
          const nInfo = describeBlock(nn, nb.getProperties ? nb.getProperties() : (nb.properties || {}))
          if (nInfo && nInfo.kind === 'solid' && !nInfo.fragile && nInfo.phase === 0) {
            hasSolidSupport = true
            break
          }
        }
        if (!hasSolidSupport) return +(layer * 4 + 0.85).toFixed(2)
        return layer * 4 + 1.2
      }
      return 90000 + layer
    }
    if (/^(lantern|soul_lantern)$/.test(info.name) && info.props?.hanging === 'true') return (layer + 1) * 4 + 1.5
    if (/^(chest|trapped_chest|ender_chest)$/.test(info.name) && local && this.schematic) {
      const f = info.props?.facing
      const t = info.props?.type
      if ((t === 'left' || t === 'right') && f) {
        const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
        const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }
        const V = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
        const pDir = t === 'left' ? CW[f] : CCW[f]
        const pv = V[pDir] || [0, 0, 0]
        const partnerLocal = new Vec3(local.x + pv[0], local.y + pv[1], local.z + pv[2])
        const touchesSolidWall = pos => {
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
            const nb = this.schematic.getBlock(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
            const nn = nb?.name ? nb.name.replace(/^minecraft:/, '') : ''
            if (nn && !/^(air|cave_air|void_air|water|lava|chest|trapped_chest|ender_chest|hopper)$/.test(nn)) return true
          }
          return false
        }
        const selfSolid = touchesSolidWall(local)
        const partnerSolid = touchesSolidWall(partnerLocal)
        if (selfSolid && !partnerSolid) return layer * 4 + 0.25
        if (!selfSolid && partnerSolid) return layer * 4 + 0.30
        return layer * 4 + (t === 'left' ? 0.25 : 0.30)
      }
      return layer * 4 + 0.25
    }
    if (info.name === 'hopper' && local && this.schematic) {
      const V = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], down: [0, -1, 0] }
      let depth = 0
      let cur = local.clone()
      for (let step = 0; step < 12; step++) {
        const b = this.schematic.getBlock(cur)
        const bn = b?.name ? b.name.replace(/^minecraft:/, '') : ''
        if (bn !== 'hopper') break
        const bp = b.getProperties ? b.getProperties() : (b.properties || {})
        const fv = V[bp.facing]
        if (!fv) break
        const nextPos = new Vec3(cur.x + fv[0], cur.y + fv[1], cur.z + fv[2])
        const nb = this.schematic.getBlock(nextPos)
        const nn = nb?.name ? nb.name.replace(/^minecraft:/, '') : ''
        if (nn === 'hopper') {
          depth++
          cur = nextPos
        } else break
      }
      return +(layer * 4 + 0.40 + Math.min(9, depth) * 0.01).toFixed(2)
    }
    // Doors click the top face of Layer (L - 1) and must be placed at the start of Layer L (`+0.02`) before surrounding Layer L corridor walls (`+0.08`) enclose the doorway!
    if (/_door$/.test(info.name || '')) {
      return +(layer * 4 + 0.02).toFixed(2)
    }
    if (info.phase === 0 && /_fence_gate$/.test(info.name || "") && local && this.schematic) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nb = this.schematic.getBlock(new Vec3(local.x + dx, local.y, local.z + dz))
        if (/_trapdoor$/.test(nb?.name || "")) return +(layer * 4 + 0.04).toFixed(2)
      }
    }
    if (info.phase === 0 && /_trapdoor$/.test(info.name || "")) {
      return +(layer * 4 + 0.05).toFixed(2)
    }
    if (local && this.schematic && info.phase === 0 && !/_door$/.test(info.name || '')) {
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          const nb = this.schematic.getBlock(new Vec3(local.x + dx, local.y, local.z + dz))
          if (/_door$/.test(nb?.name || '')) {
            return +(layer * 4 + 0.08).toFixed(2)
          }
        }
      }
    }
    if (layer >= 8 && local && this.schematic && info.phase === 0) {
      if (/_leaves$/.test(info.name)) {
        let nearTrapdoor = false
        for (let dx = -2; dx <= 2 && !nearTrapdoor; dx++) {
          for (let dz = -2; dz <= 2 && !nearTrapdoor; dz++) {
            const nb = this.schematic.getBlock(new Vec3(local.x + dx, local.y, local.z + dz))
            if (/_trapdoor$/.test(nb?.name || '')) nearTrapdoor = true
          }
        }
        if (nearTrapdoor) return +(layer * 4 + 0.15).toFixed(2)
      }
      if (layer >= 9) {
        const below = this.schematic.getBlock(new Vec3(local.x, local.y - 1, local.z))
        const bn = below?.name ? below.name.replace(/^minecraft:/, "") : ""
        if (!bn || /^(air|cave_air|void_air|water|lava)$/.test(bn)) {
          return +(layer * 4 + 0.08).toFixed(2)
        }
      }
    }
    if (info.phase === 0 && /_(fence_gate|fence|wall|pane|bars|door)$|^iron_bars$|^glass_pane$|^chain$/.test(info.name || "")) {
      return +(layer * 4 + 0.15).toFixed(2)
    }
    if (info.phase === 0 && info.specs?.[0]?.look === "up") {
      return +(layer * 4 + 0.18).toFixed(2)
    }
    return layer * 4 + (info.phase === 1 ? 1 : 0)
  }

  addTask (task) {
    this.tasks.set(task.key, task)
    this.total += 1
    this.census.byKind[task.kind] = (this.census.byKind[task.kind] || 0) + 1
    let group = this.orderGroups.get(task.order)
    if (!group) { group = { remaining: 0, cells: new Map() }; this.orderGroups.set(task.order, group) }
    group.remaining += 1
    task.cellKey = `${Math.floor(task.world.x / CELL)},${Math.floor(task.world.z / CELL)}`
    let set = group.cells.get(task.cellKey)
    if (!set) { set = new Set(); group.cells.set(task.cellKey, set) }
    set.add(task)
    this.addToChunkIndex(task)
    this.materialDemand.set(task.item, (this.materialDemand.get(task.item) || 0) + 1)
  }

  chunkKey (pos) { return `${Math.floor(pos.x / 16)},${Math.floor(pos.z / 16)}` }

  addToChunkIndex (task) {
    const key = this.chunkKey(task.world)
    let bucket = this.chunkTasks.get(key)
    if (!bucket) { bucket = new Set(); this.chunkTasks.set(key, bucket) }
    bucket.add(task.key)
  }

  tasksNear (center, radius = 32) {
    const out = []
    for (let cx = Math.floor((center.x - radius) / 16); cx <= Math.floor((center.x + radius) / 16); cx++) {
      for (let cz = Math.floor((center.z - radius) / 16); cz <= Math.floor((center.z + radius) / 16); cz++) {
        const bucket = this.chunkTasks.get(`${cx},${cz}`)
        if (!bucket) continue
        for (const key of bucket) {
          const task = this.tasks.get(key)
          if (task && task.world.distanceTo(center) <= radius + 2) out.push(task)
        }
      }
    }
    return out
  }

  build (opts = {}) {
    const start = this.schematic.start()
    const end = this.schematic.end()
    const { schematic } = this
    const originY = this.transform.origin?.y ?? 0
    { const a = this.transform.localToWorld(start); const b = this.transform.localToWorld(end)
      this.box = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) } }

    for (let y = start.y; y <= end.y; y++) {
      for (let z = start.z; z <= end.z; z++) {
        for (let x = start.x; x <= end.x; x++) {
          const local = new Vec3(x, y, z)
          const block = schematic.getBlock(local)
          if (!block || block.isAir) { this.census.skippedAir++; continue }
          const name = block.name
          if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') { this.census.skippedAir++; continue }

          if (this.ignored.has(name)) { this.census.ignored[name] = (this.census.ignored[name] || 0) + 1; continue }
          const props = rotateProperties(block.getProperties ? block.getProperties() : block.properties, this.rotation)
          const info = describeBlock(name, props)
          if (info.kind === 'air') continue
          if (info.kind === 'derived' || info.kind === 'fluid') { if (name === 'water' || name === 'bubble_column' || name === 'lava') this.fluidCells.set(keyOf(this.transform.localToWorld(local)), name === 'lava' ? 'lava' : 'water') }
          if (info.kind === 'derived') { this.census.derived++; continue }
          if (info.kind === 'unsupported') { this.census.unsupported.push({ name, props, note: info.note }); continue }

          const worldPos = this.transform.localToWorld(local)
          const layer = worldPos.y - originY
          const key = keyOf(worldPos)
          const kind = info.kind === 'fluid' ? 'fluid' : 'block'
          if (kind === 'fluid' && y < end.y) {
            const aboveBlock = schematic.getBlock(new Vec3(x, y + 1, z))
            const aboveName = aboveBlock?.name ? aboveBlock.name.replace(/^minecraft:/, '') : null
            if (aboveName === name) {
              this.fluidCells.set(key, name)
              this.census.derived++
              continue
            }
          }
          const base = {
            key, kind, name, properties: props, info, item: info.item,
            local: local.clone(), world: worldPos,
            order: this.orderOf(info, kind, layer, local), layer,
            status: 'pending', attempts: 0, lastError: null, deferredUntil: 0, specTag: null
          }
          const tile = this.tiles.get(`${local.x},${local.y},${local.z}`)
          if (tile) base.tile = tile
          this.addTask(base)
          this.census.byPhase[info.phase] = (this.census.byPhase[info.phase] || 0) + 1
          if (kind === 'block' && info.specs.some(s => s.look === 'up')) this.census.lookUp++

          for (const face of FACES) {
            const nk = keyOf(worldPos.plus(face))
            let bucket = this.reverseNeighbors.get(nk)
            if (!bucket) { bucket = []; this.reverseNeighbors.set(nk, bucket) }
            bucket.push(key)
          }

          if (kind === 'block' && info.waterlogged) {
            this.fluidCells.set(key, 'water')
            this.addTask({
              key: key + '#w', parentKey: key, kind: 'waterlog', name, properties: props, info, item: 'water_bucket',
              local: local.clone(), world: worldPos, order: this.orderOf(info, 'waterlog', layer, local), layer,
              status: 'pending', attempts: 0, lastError: null, deferredUntil: 0
            })
          }
        }
      }
    }
    this.promoteSameLayerRefDependencies()
    this.groupIsolatedVerticalColumns()
    this.analyzeAndGroupVerticalWallClusters()
    this.computeBridgeSeedsAndChains()
    this.expandExpectedFluidFlow()
    this.computeFluidEnclosureDeps()
    this.computePitCells()
    try { new SchematicIntelligence(this).analyze() } catch {}
    this.orders = [...this.orderGroups.keys()].sort((a, b) => a - b)
    if (!opts?.skipWorldReconcile) {
      this.reconcileWorld()
      this.recomputeReady()
    }
    return this
  }

  async buildAsync (opts = {}) {
    const yieldLoop = () => new Promise(resolve => setImmediate(resolve))
    const start = this.schematic.start()
    const end = this.schematic.end()
    const { schematic } = this
    const originY = this.transform.origin?.y ?? 0
    { const a = this.transform.localToWorld(start); const b = this.transform.localToWorld(end)
      this.box = { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y), z0: Math.min(a.z, b.z), z1: Math.max(a.z, b.z) } }

    let lastYieldAt = Date.now()
    for (let y = start.y; y <= end.y; y++) {
      if (Date.now() - lastYieldAt >= 35) {
        await yieldLoop()
        lastYieldAt = Date.now()
      }
      for (let z = start.z; z <= end.z; z++) {
        for (let x = start.x; x <= end.x; x++) {
          const local = new Vec3(x, y, z)
          const block = schematic.getBlock(local)
          if (!block || block.isAir) { this.census.skippedAir++; continue }
          const name = block.name
          if (!name || name === 'air' || name === 'cave_air' || name === 'void_air') { this.census.skippedAir++; continue }

          if (this.ignored.has(name)) { this.census.ignored[name] = (this.census.ignored[name] || 0) + 1; continue }
          const props = rotateProperties(block.getProperties ? block.getProperties() : block.properties, this.rotation)
          const info = describeBlock(name, props)
          if (info.kind === 'air') continue
          if (info.kind === 'derived' || info.kind === 'fluid') { if (name === 'water' || name === 'bubble_column' || name === 'lava') this.fluidCells.set(keyOf(this.transform.localToWorld(local)), name === 'lava' ? 'lava' : 'water') }
          if (info.kind === 'derived') { this.census.derived++; continue }
          if (info.kind === 'unsupported') { this.census.unsupported.push({ name, props, note: info.note }); continue }

          const worldPos = this.transform.localToWorld(local)
          const layer = worldPos.y - originY
          const key = keyOf(worldPos)
          const kind = info.kind === 'fluid' ? 'fluid' : 'block'
          if (kind === 'fluid' && y < end.y) {
            const aboveBlock = schematic.getBlock(new Vec3(x, y + 1, z))
            const aboveName = aboveBlock?.name ? aboveBlock.name.replace(/^minecraft:/, '') : null
            if (aboveName === name) {
              this.fluidCells.set(key, name)
              this.census.derived++
              continue
            }
          }
          const base = {
            key, kind, name, properties: props, info, item: info.item,
            local: local.clone(), world: worldPos,
            order: this.orderOf(info, kind, layer, local), layer,
            status: 'pending', attempts: 0, lastError: null, deferredUntil: 0, specTag: null
          }
          const tile = this.tiles.get(`${local.x},${local.y},${local.z}`)
          if (tile) base.tile = tile
          this.addTask(base)
          this.census.byPhase[info.phase] = (this.census.byPhase[info.phase] || 0) + 1
          if (kind === 'block' && info.specs.some(s => s.look === 'up')) this.census.lookUp++

          for (const face of FACES) {
            const nk = keyOf(worldPos.plus(face))
            let bucket = this.reverseNeighbors.get(nk)
            if (!bucket) { bucket = []; this.reverseNeighbors.set(nk, bucket) }
            bucket.push(key)
          }

          if (kind === 'block' && info.waterlogged) {
            this.fluidCells.set(key, 'water')
            this.addTask({
              key: key + '#w', parentKey: key, kind: 'waterlog', name, properties: props, info, item: 'water_bucket',
              local: local.clone(), world: worldPos, order: this.orderOf(info, 'waterlog', layer, local), layer,
              status: 'pending', attempts: 0, lastError: null, deferredUntil: 0
            })
          }
        }
      }
    }
    await yieldLoop()
    this.promoteSameLayerRefDependencies()
    this.groupIsolatedVerticalColumns()
    await yieldLoop()
    this.analyzeAndGroupVerticalWallClusters()
    await yieldLoop()
    this.computeBridgeSeedsAndChains()
    await yieldLoop()
    this.expandExpectedFluidFlow()
    await yieldLoop()
    this.computeFluidEnclosureDeps()
    await yieldLoop()
    this.computePitCells()
    await yieldLoop()
    try { new SchematicIntelligence(this).analyze() } catch {}
    await yieldLoop()
    this.orders = [...this.orderGroups.keys()].sort((a, b) => a - b)
    if (!opts?.skipWorldReconcile) {
      this.reconcileWorld()
      this.recomputeReady()
    }
    return this
  }

  // Fast copy of a pristine (never-built-on) planner: the schematic, fluid/pit/neighbour indexes are shared read-only,
  // every task and order group is a fresh object. Used when several bots in ONE process start the same job so the
  // expensive analysis runs once instead of once per bot.
  static cloneFromTemplate (template, worldModel, config, logger) {
    const p = new BuildPlanner({ schematic: template.schematic }, template.transform, worldModel, config, logger)
    p.box = template.box ? { ...template.box } : null
    p.total = template.total
    p.rotation = template.rotation
    p.orders = template.orders.slice()
    p.materialDemand = new Map(template.materialDemand)
    p.ignored = template.ignored
    p.census = {
      ignored: { ...(template.census?.ignored || {}) },
      skippedAir: template.census?.skippedAir || 0,
      derived: template.census?.derived || 0,
      unsupported: (template.census?.unsupported || []).slice(),
      byKind: { ...(template.census?.byKind || {}) },
      byPhase: { ...(template.census?.byPhase || {}) },
      lookUp: template.census?.lookUp || 0
    }
    p.tiles = template.tiles
    p.fluidCells = template.fluidCells
    p.pitCells = template.pitCells
    p.reverseNeighbors = template.reverseNeighbors
    p.chunkTasks = template.chunkTasks
    p.intelligenceSummary = template.intelligenceSummary
    p.architectActive = Boolean(template.architectActive)

    const map = new Map() // template task -> clone
    for (const [k, st] of template.tasks.entries()) {
      const c = { ...st } // world/local Vec3s are never mutated: shared to save memory
      c.status = 'pending'; c.attempts = 0; c.totalAttempts = 0; c.lastError = null
      c.deferredUntil = 0; c.anyUntil = 0; c.anyTries = 0; c.priorityBoost = false; c.specTag = null
      delete c.owner; delete c._fc; delete c.hint; delete c.lockedSpecTag
      map.set(st, c)
      p.tasks.set(k, c)
    }
    const remap = v => {
      if (v && typeof v === 'object') {
        if (map.has(v)) return map.get(v)
        if (Array.isArray(v) && v.length && map.has(v[0])) return v.map(x => map.get(x) || x)
      }
      return v
    }
    for (const c of map.values()) {
      for (const f of Object.keys(c)) { const nv = remap(c[f]); if (nv !== c[f]) c[f] = nv }
    }
    const remaining = new Map()
    for (const c of p.tasks.values()) remaining.set(c.order, (remaining.get(c.order) || 0) + 1)
    for (const [ord, sg] of template.orderGroups.entries()) {
      const grp = {}
      for (const f of Object.keys(sg)) {
        const v = sg[f]
        if (f === 'cells') {
          const cells = new Map()
          for (const [ck, sset] of v.entries()) {
            const set = new Set()
            for (const st of sset) { const mt = map.get(st); if (mt) set.add(mt) }
            cells.set(ck, set)
          }
          grp.cells = cells
        } else if (v instanceof Map) {
          const m2 = new Map()
          for (const [mk, mv] of v.entries()) {
            if (mv && typeof mv === 'object' && !Array.isArray(mv) && !map.has(mv)) {
              const o = {}
              for (const ofk of Object.keys(mv)) o[ofk] = remap(mv[ofk])
              if (Array.isArray(o.items)) { o.ptr = 0; o.remaining = o.items.length }
              m2.set(mk, o)
            } else m2.set(mk, remap(mv))
          }
          grp[f] = m2
        } else if (v instanceof Set) {
          grp[f] = new Set([...v].map(remap))
        } else if (Array.isArray(v)) {
          grp[f] = v.map(remap)
        } else {
          grp[f] = remap(v)
        }
      }
      grp.remaining = remaining.get(ord) || 0
      if ('seqPtr' in grp) grp.seqPtr = 0
      delete grp.isSingleWorkerChain; delete grp.chainOwner
      p.orderGroups.set(ord, grp)
    }
    p.reconcileWorld()
    p.recomputeReady()
    return p
  }

  // Detects isolated 1x1 vertical columns of simple full blocks (3+ blocks high with zero horizontal neighbors in `this.tasks`
  // across the vertical run, such as the 10-block corner dirt pillar in `cobble.litematic`) and groups them into a single order
  // (`baseOrder + 0.1`) so one bot builds the entire column in one continuous pass instead of walking back and forth on every layer!
  promoteSameLayerRefDependencies () {
    const V = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
    const ALL_FACES = ['up', 'down', 'north', 'south', 'east', 'west']
    const isValidSchematicRef = (rt, fname) => {
      if (!rt || rt.kind !== 'block' || rt.info?.fragile) return false
      if (/^(repeater|comparator|daylight_detector)$|_carpet$/.test(rt.name || '')) return false
      if (/_slab$/.test(rt.name || '')) {
        const rp = rt.properties || {}
        if (rp.type === 'bottom' && fname === 'up') return false
        if (rp.type === 'top' && fname === 'down') return false
      }
      if (/_trapdoor$/.test(rt.name || '')) return Boolean(fname !== 'up' && fname !== 'down')
      return true
    }
    const promotedFree = new Set()
    for (let pass = 0; pass < 3; pass++) {
      let changed = false
      for (const t of this.tasks.values()) {
        if (t.kind !== 'block' || t.layer <= 0 || t.order >= 88000) continue
        const specs = t.info?.specs
        const isFreeBlock = Boolean(specs && specs.length === 1 && specs[0].tag === 'free')
        if (isFreeBlock) {
          if (promotedFree.has(t.key)) continue
          const below = this.tasks.get(`${t.world.x},${t.world.y - 1},${t.world.z}`)
          if (below && below.order <= t.order && isValidSchematicRef(below, 'up')) continue
        }
        let faces
        if (isFreeBlock) {
          faces = ALL_FACES
        } else {
          const nonHyp = specs?.filter(sp => !sp.hyp) || []
          const checkSpecs = nonHyp.length ? nonHyp : [specs?.[0]].filter(Boolean)
          faces = [...new Set(checkSpecs.flatMap(sp => usableFaces(sp)))]
        }
        let hasEarlierOrEqualRef = false
        let minSameLayerLaterOrder = Infinity
        for (const fname of faces) {
          const v = V[fname]
          if (!v) continue
          const rk = `${t.world.x - v[0]},${t.world.y - v[1]},${t.world.z - v[2]}`
          const rt = this.tasks.get(rk)
          if (!isValidSchematicRef(rt, fname)) continue
          if (rt.order <= t.order) {
            hasEarlierOrEqualRef = true
            break
          }
          if (rt.layer === t.layer && rt.order > t.order && rt.order < t.layer * 4 + 2.2) {
            if (isFreeBlock && rt.order < t.layer * 4 + 0.8) continue
            if (rt.order < minSameLayerLaterOrder) minSameLayerLaterOrder = rt.order
          }
        }
        if (!hasEarlierOrEqualRef && Number.isFinite(minSameLayerLaterOrder)) {
          if (isFreeBlock) promotedFree.add(t.key)
          const newOrder = +(minSameLayerLaterOrder + 0.3).toFixed(2)
          if (newOrder !== t.order && newOrder < t.layer * 4 + 2.25) {
            const oldGroup = this.orderGroups.get(t.order)
            if (oldGroup) {
              oldGroup.remaining = Math.max(0, oldGroup.remaining - 1)
              oldGroup.cells.get(t.cellKey)?.delete(t)
              if (oldGroup.remaining === 0) this.orderGroups.delete(t.order)
            }
            t.order = newOrder
            let newGroup = this.orderGroups.get(newOrder)
            if (!newGroup) {
              newGroup = { remaining: 0, cells: new Map() }
              this.orderGroups.set(newOrder, newGroup)
            }
            newGroup.remaining += 1
            let set = newGroup.cells.get(t.cellKey)
            if (!set) { set = new Set(); newGroup.cells.set(t.cellKey, set) }
            set.add(t)
            changed = true
          }
        }
      }
      if (!changed) break
    }
  }

  groupIsolatedVerticalColumns () {
    const H4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const D4 = [[1, 1], [1, -1], [-1, 1], [-1, -1]]
    const isSimpleColumnTask = t => Boolean(
      t && t.kind === 'block' && !t.info?.fragile && !t.info?.waterlogged &&
      t.info?.phase === 0 && t.order < 88000 &&
      t.info?.specs?.length === 1 && t.info.specs[0].tag === 'free'
    )
    const hasHorizTask = (x, y, z) => H4.some(([dx, dz]) => this.tasks.has(`${x + dx},${y},${z + dz}`))
    const hasDiagTask = (x, y, z) => D4.some(([dx, dz]) => this.tasks.has(`${x + dx},${y},${z + dz}`))
    const visited = new Set()
    for (const t of this.tasks.values()) {
      if (visited.has(t.key) || !isSimpleColumnTask(t)) continue
      const { x, z } = t.world
      if (hasHorizTask(x, t.world.y, z)) continue
      let y0 = t.world.y
      while (true) {
        const below = this.tasks.get(`${x},${y0 - 1},${z}`)
        if (below && isSimpleColumnTask(below) && !hasHorizTask(x, y0 - 1, z)) y0--
        else break
      }
      const run = []
      let y = y0
      while (true) {
        const cur = this.tasks.get(`${x},${y},${z}`)
        if (cur && isSimpleColumnTask(cur) && !hasHorizTask(x, y, z)) {
          run.push(cur)
          visited.add(cur.key)
          y++
        } else break
      }
      if (run.length < 3) continue
      const hasBaseSupport = (this.box && y0 === this.box.y0) || Boolean(this.tasks.get(`${x},${y0 - 1},${z}`)?.kind === 'block')
      if (!hasBaseSupport) continue
      if (run.every(ct => hasDiagTask(x, ct.world.y, z))) continue
      const baseOrder = run[0].order
      const targetOrder = baseOrder + 0.1
      let targetGroup = this.orderGroups.get(targetOrder)
      if (!targetGroup) {
        targetGroup = { remaining: 0, cells: new Map() }
        this.orderGroups.set(targetOrder, targetGroup)
      }
      for (let i = 0; i < run.length; i++) {
        const ct = run[i]
        const oldGroup = this.orderGroups.get(ct.order)
        if (oldGroup) {
          oldGroup.remaining = Math.max(0, oldGroup.remaining - 1)
          oldGroup.cells.get(ct.cellKey)?.delete(ct)
          if (oldGroup.remaining === 0) this.orderGroups.delete(ct.order)
        }
        ct.order = targetOrder
        ct.isolatedColumn = true
        if (i === run.length - 1) ct.isolatedColumnTop = true
        targetGroup.remaining += 1
        let set = targetGroup.cells.get(ct.cellKey)
        if (!set) { set = new Set(); targetGroup.cells.set(ct.cellKey, set) }
        set.add(ct)
      }
    }
  }

  // Pre-computes a complete 3D support & catwalk-bridge DAG across all layers (L1..maxLayer) in <300ms using
  // bucketed O(W*D) grid Dijkstra so that:
  //   1. Overhang blocks (no block below at y-1, attached horizontally to a supported root on layer l) get `islandPrevKey`
  //      pointing 1 step toward the supported root — bots ALWAYS build overhangs from the supported inner edge outward!
  //   2. Disconnected 2D floating islands (such as diagonal funnel tiers on L5/L7/L8, the 448 isolated waterlogged oak_leaves
  //      on L13, the 64 generator module bases on L14, and upper flushing channels on L26..L28) have their closest block to an
  //      already-reached block on l, l-1, or l-2 marked with `bridgeAnchorKey` and `bridgeGap`, and all other blocks in that
  //      island linked via `islandPrevKey` toward that seed block!
  computeBridgeSeedsAndChains () {
    const isStructural = t => Boolean(
      t && t.kind === "block" && t.order < 88000 && !t.info?.fragile &&
      t.info?.phase === 0 && !/_(trapdoor|door|fence_gate|sign|banner)$/.test(t.name || "")
    )
    const byLayer = new Map()
    let minLayer = Infinity
    let maxLayer = -Infinity
    for (const t of this.tasks.values()) {
      if (!isStructural(t)) continue
      if (t.layer < minLayer) minLayer = t.layer
      if (t.layer > maxLayer) maxLayer = t.layer
      let list = byLayer.get(t.layer)
      if (!list) { list = []; byLayer.set(t.layer, list) }
      list.push(t)
    }
    if (!Number.isFinite(minLayer) || maxLayer <= minLayer) return
    const bx = this.box || { x0: -1000, x1: 1000, z0: -1000, z1: 1000 }

    for (let l = minLayer + 1; l <= maxLayer; l++) {
      const tasks = byLayer.get(l)
      if (!tasks || !tasks.length) continue
      const layerMap = new Map(tasks.map(t => [`${t.world.x},${t.world.z}`, t]))
      const reached = new Set()
      const buckets = Array.from({ length: 256 }, () => [])
      const bestDist = new Map()
      let curD = 0

      const pushNode = (x, z, nd, anchorKey, fromTaskKey, hopD = 0) => {
        if (nd >= buckets.length) return
        if (x < bx.x0 - 1 || x > bx.x1 + 1 || z < bx.z0 - 1 || z > bx.z1 + 1) return
        const k2 = `${x},${z}`
        const score = nd * 64 + Math.min(63, hopD)
        const prev = bestDist.get(k2)
        if (prev !== undefined && prev <= score) return
        bestDist.set(k2, score)
        buckets[nd].push({ x, z, d: nd, score, anchorKey, fromTaskKey, hopD })
        if (nd < curD) curD = nd
      }

      for (const t of tasks) {
        const below = this.tasks.get(`${t.world.x},${t.world.y - 1},${t.world.z}`)
        if (isStructural(below)) {
          reached.add(t.key)
          pushNode(t.world.x, t.world.z, 0, t.key, t.key, 0)
        }
      }

      for (const dl of [1, 2]) {
        const prevTasks = byLayer.get(l - dl)
        if (!prevTasks) continue
        for (const pt of prevTasks) {
          if (!layerMap.has(`${pt.world.x},${pt.world.z}`)) {
            pushNode(pt.world.x, pt.world.z, dl, pt.key, null, dl)
          } else if (dl === 2) {
            pushNode(pt.world.x, pt.world.z, 1, pt.key, null, 1)
          }
        }
      }

      while (curD < buckets.length && reached.size < tasks.length) {
        const q = buckets[curD]
        if (!q.length) { curD++; continue }
        const cur = q.shift()
        const k2 = `${cur.x},${cur.z}`
        if (bestDist.get(k2) < cur.score) continue
        const tHere = layerMap.get(k2)
        let nextAnchor = cur.anchorKey
        let nextFromTask = cur.fromTaskKey
        const nextBaseD = cur.d
        let nextHopD = cur.hopD || 0

        if (tHere && !reached.has(tHere.key)) {
          reached.add(tHere.key)
          if (nextHopD === 0 && cur.fromTaskKey && cur.fromTaskKey !== tHere.key) {
            if (!tHere.islandPrevKey && !tHere.verticalPrevKey && !tHere.isolatedColumn) {
              tHere.islandPrevKey = cur.fromTaskKey
            }
          } else if (nextHopD >= 1 && cur.anchorKey) {
            tHere.bridgeAnchorKey = cur.anchorKey
            tHere.bridgeGap = nextHopD
          }
          nextAnchor = tHere.key
          nextFromTask = tHere.key
          nextHopD = 0
        }

        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cur.x + dx; const nz = cur.z + dz
          const nt = layerMap.get(`${nx},${nz}`)
          if (nextHopD === 0 && nt) {
            pushNode(nx, nz, nextBaseD, nextAnchor, nextFromTask, 0)
          } else {
            const h = nextHopD + 1
            const stepCost = h <= 3 ? 1 : (h === 4 ? 16 : 32)
            pushNode(nx, nz, nextBaseD + stepCost, nextAnchor, null, h)
          }
        }
      }
    }
  }

  moveTaskToOrder (task, newOrder) {
    if (!task || task.order === newOrder) return
    const oldGroup = this.orderGroups.get(task.order)
    if (oldGroup) {
      oldGroup.remaining = Math.max(0, oldGroup.remaining - 1)
      oldGroup.cells.get(task.cellKey)?.delete(task)
      if (oldGroup.remaining === 0) this.orderGroups.delete(task.order)
    }
    task.order = newOrder
    let newGroup = this.orderGroups.get(newOrder)
    if (!newGroup) {
      newGroup = { remaining: 0, cells: new Map() }
      this.orderGroups.set(newOrder, newGroup)
    }
    newGroup.remaining += 1
    let set = newGroup.cells.get(task.cellKey)
    if (!set) { set = new Set(); newGroup.cells.set(task.cellKey, set) }
    set.add(task)
  }

  // Pre-analyzes 3-4 layer vertical wall/column bands (such as L4..L7 in cobble.litematic, L10..L13 & L14..L17 in Tree Gaming,
  // and L15..L18 & L19..L22 in McDs 64 Module) where full-height anchor columns (e.g. 4-block oak_leaves columns) sit on a flat
  // deck and are horizontally adjacent to partner columns (e.g. cobblestone & stained_glass columns).
  analyzeAndGroupVerticalWallClusters () {
    let minLayer = Infinity
    let maxLayer = -Infinity
    for (const t of this.tasks.values()) {
      if (t.kind === "block" && t.order < 88000 && !t.isolatedColumn) {
        if (t.layer < minLayer) minLayer = t.layer
        if (t.layer > maxLayer) maxLayer = t.layer
      }
    }
    if (!Number.isFinite(minLayer) || maxLayer - minLayer < 3) return
    const SUNKEN = /^(hopper|chest|trapped_chest|ender_chest|cauldron|composter)$/
    const isSimpleFreeTask = t => Boolean(
      t && t.kind === "block" && !t.isolatedColumn && !t.info?.fragile &&
      t.info?.phase === 0 && t.order < 88000 && !SUNKEN.test(t.name || "") &&
      t.info?.specs?.length === 1 && t.info.specs[0].tag === "free"
    )
    const hasSolidFloorAt = (x, y, z) => {
      const bt = this.tasks.get(`${x},${y},${z}`)
      if (bt && bt.kind === "block" && !bt.info?.fragile && !SUNKEN.test(bt.name || "")) return true
      const wb = this.world?.blockAt?.({ x, y, z })
      return Boolean(wb && wb.boundingBox === "block")
    }
    const bx = this.box || { x0: 0, x1: 0, z0: 0, z1: 0 }
    const centerX = (bx.x0 + bx.x1) * 0.5
    const centerZ = (bx.z0 + bx.z1) * 0.5

    const tasksByLayer = new Map()
    for (const t of this.tasks.values()) {
      if (t.order >= 88000 || t.isolatedColumn) continue
      let list = tasksByLayer.get(t.layer)
      if (!list) { list = []; tasksByLayer.set(t.layer, list) }
      list.push(t)
    }

    for (let l0 = Math.max(1, minLayer + 1); l0 <= maxLayer - 2; l0++) {
      let matchedBand = false
      for (const bandH of [4, 3]) {
        const l1 = l0 + bandH - 1
        if (l1 > maxLayer) continue
        let bandValid = true
        const bandBlockTasks = []
        const attachedTasks = []
        for (let l = l0; l <= l1; l++) {
          const lTasks = tasksByLayer.get(l)
          if (!lTasks) continue
          for (const t of lTasks) {
            if (t.order >= 88000 || t.isolatedColumn) continue
            if (t.kind === "fluid") {
              if (t.layer < l1) { bandValid = false }
              continue
            }
            if (t.kind === "waterlog") {
              if (t.layer < l1 && !/(_leaves$|mangrove_roots)/.test(t.name || "")) { bandValid = false }
              continue
            }
            if (t.kind === "block") {
              if (t.info?.phase === 1) {
                attachedTasks.push(t)
                continue
              }
              if (!isSimpleFreeTask(t)) { bandValid = false; continue }
              bandBlockTasks.push(t)
            }
          }
        }
        if (bandBlockTasks.length < 12) continue

        const cols = new Map()
        for (const t of bandBlockTasks) {
          const ck = `${t.world.x},${t.world.z}`
          if (!cols.has(ck)) cols.set(ck, [])
          cols.get(ck).push(t)
        }
        for (const list of cols.values()) list.sort((a, b) => a.layer - b.layer)

        let singleLayerCols = []
        let multiLayerCols = []
        let floorsOk = bandValid
        if (floorsOk) {
          for (const [ck, list] of cols.entries()) {
            const x = list[0].world.x
            const z = list[0].world.z
            if (list[0].layer !== l0) {
              floorsOk = false
              break
            }
            if (list.length === 1 && list[0].layer === l0) {
              singleLayerCols.push({ ck, x, z, list })
            } else {
              multiLayerCols.push({ ck, x, z, list, hasFloor: hasSolidFloorAt(x, list[0].world.y - 1, z), partners: [] })
            }
          }
        }

        // If unrelated perimeter/staircase/central-wall blocks exist on l0..l1 (such as in McDs 64 Module),
        // extract the connected 4-layer generator column lattice (`genCols`) directly!
        let extractedGeneratorSubBand = false
        if ((!floorsOk || multiLayerCols.length < 4) && bandH === 4) {
          const fullCols = []
          for (const [ck, list] of cols.entries()) {
            if (list.length !== 4 || !list.every((t, i) => t.layer === l0 + i)) continue
            const x = list[0].world.x; const z = list[0].world.z
            if (!hasSolidFloorAt(x, list[0].world.y - 1, z)) continue
            fullCols.push({ ck, x, z, list, hasFloor: true, partners: [] })
          }
          const fullColMap = new Map(fullCols.map(c => [c.ck, c]))
          const seedCols = fullCols.filter(c => c.list.some(t => t.info?.waterlogged))
          if (seedCols.length >= 8) {
            const genSet = new Set(seedCols.map(c => c.ck))
            const q = [...seedCols]
            while (q.length) {
              const cur = q.shift()
              for (let dx = -1; dx <= 1; dx++) {
                for (let dz = -1; dz <= 1; dz++) {
                  if (dx === 0 && dz === 0) continue
                  const nk = `${cur.x + dx},${cur.z + dz}`
                  if (fullColMap.has(nk) && !genSet.has(nk)) {
                    genSet.add(nk)
                    q.push(fullColMap.get(nk))
                  }
                }
              }
            }
            const genCols = fullCols.filter(c => genSet.has(c.ck))
            if (genCols.length >= 24) {
              singleLayerCols = []
              multiLayerCols = genCols
              floorsOk = true
              extractedGeneratorSubBand = true
            }
          }
        }
        if (!floorsOk || multiLayerCols.length < 4) continue

        // Verify that the band does not simply continue upward as a tall 6+ block tower (unless it is a 4-layer stacked generator band)
        // AND that there is a walkable horizontal deck around the columns at baseY - 1!
        const baseY0 = multiLayerCols[0].list[0].world.y
        const topY0 = baseY0 + bandH - 1
        let continuingAbove = 0
        const adjDeckCells = new Set()
        let adjDeckSolid = 0
        for (const col of multiLayerCols) {
          if (this.tasks.has(`${col.x},${topY0 + 1},${col.z}`)) continuingAbove++
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = col.x + dx; const nz = col.z + dz
            const nk = `${nx},${nz}`
            if (cols.has(nk) || adjDeckCells.has(nk)) continue
            adjDeckCells.add(nk)
            if (hasSolidFloorAt(nx, baseY0 - 1, nz)) adjDeckSolid++
          }
        }
        const isStackedGeneratorBand = extractedGeneratorSubBand || (bandH === 4 && singleLayerCols.length === 0 && multiLayerCols.length >= 24 &&
          multiLayerCols.every(c => c.hasFloor && c.list.length === 4) &&
          multiLayerCols.some(c => c.list.some(t => t.info?.waterlogged)))
        if (!isStackedGeneratorBand) {
          if (continuingAbove > multiLayerCols.length * 0.35) continue
          if (adjDeckCells.size === 0 || adjDeckSolid < adjDeckCells.size * 0.25) continue
        }

        // Identify full-height continuous columns sitting on a solid floor with clear 2-block headroom above l1
        const anchorCandidates = multiLayerCols.filter(col => {
          if (!col.hasFloor || col.list.length !== bandH) return false
          for (let i = 0; i < bandH; i++) {
            if (col.list[i].layer !== l0 + i) return false
          }
          const topY = col.list[bandH - 1].world.y
          for (const dy of [1, 2]) {
            const aboveTask = this.tasks.get(`${col.x},${topY + dy},${col.z}`)
            if (aboveTask && aboveTask.order <= l1 * 4 + 2) return false
          }
          return true
        })
        if (anchorCandidates.length < 2) continue

        // Fast O(N) greedy anchor selection using `coveredSet` and `multiColMap`
        const multiColMap = new Map(multiLayerCols.map(c => [c.ck, c]))
        const selectedAnchors = []
        const selectedSet = new Set()
        const coveredSet = new Set()
        const addAnchor = a => {
          if (selectedSet.has(a.ck)) return
          selectedAnchors.push(a)
          selectedSet.add(a.ck)
          coveredSet.add(a.ck)
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nk = `${a.x + dx},${a.z + dz}`
            if (multiColMap.has(nk)) coveredSet.add(nk)
          }
        }
        for (const c of anchorCandidates) {
          if (c.list.some(t => t.info?.waterlogged)) addAnchor(c)
        }

        while (coveredSet.size < multiLayerCols.length) {
          let bestCand = null
          let bestGain = 0
          for (const cand of anchorCandidates) {
            if (selectedSet.has(cand.ck)) continue
            let gain = coveredSet.has(cand.ck) ? 0 : 1
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nk = `${cand.x + dx},${cand.z + dz}`
              if (multiColMap.has(nk) && !coveredSet.has(nk)) gain++
            }
            if (gain > bestGain) { bestGain = gain; bestCand = cand }
          }
          if (!bestCand) break
          addAnchor(bestCand)
        }
        if (coveredSet.size < multiLayerCols.length) continue

        // Assign each non-anchor multiLayerCol to an adjacent anchor column, balancing partner counts in O(1) via anchorMap
        const anchorMap = new Map(selectedAnchors.map(a => [a.ck, a]))
        const partnerCols = multiLayerCols.filter(c => !selectedSet.has(c.ck))
        for (const p of partnerCols) {
          const adj = []
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const a = anchorMap.get(`${p.x + dx},${p.z + dz}`)
            if (a) adj.push(a)
          }
          adj.sort((a, b) => a.partners.length - b.partners.length)
          adj[0].partners.push(p)
        }

        // For stacked generator bands, compute distance to non-generator perimeter/divider walls so outer wall-adjacent modules are built before interior modules!
        const wallPts = []
        if (isStackedGeneratorBand) {
          const genColKeys = new Set(multiLayerCols.map(c => c.ck))
          for (const t of this.tasks.values()) {
            if (t.kind === 'block' && (t.layer === l0 - 1 || t.layer === l0 - 2) && !t.info?.fragile && !genColKeys.has(`${t.world.x},${t.world.z}`)) {
              if (t.layer === l0 - 2 && t.info?.waterlogged) continue
              wallPts.push({ x: t.world.x, z: t.world.z })
            }
          }
          for (const a of selectedAnchors) {
            let md = Infinity
            for (let i = 0; i < wallPts.length; i++) {
              const d = Math.hypot(a.x - wallPts[i].x, a.z - wallPts[i].z)
              if (d < md) md = d
            }
            a.wallDist = Number.isFinite(md) ? md : 0
            a.wallRing = a.wallDist <= 6.2 ? 0 : 1
          }
        }
        const orderedAnchors = []
        const remAnchors = selectedAnchors.slice()
        if (isStackedGeneratorBand) {
          remAnchors.sort((a, b) => (a.wallRing - b.wallRing) || (a.wallDist - b.wallDist) || (a.z - b.z) || (a.x - b.x))
        } else {
          remAnchors.sort((a, b) => (b.partners.length - a.partners.length) || (a.z - b.z) || (a.x - b.x))
        }
        let curA = remAnchors.shift()
        orderedAnchors.push(curA)
        while (remAnchors.length) {
          let bi = 0; let bd = Infinity
          for (let i = 0; i < remAnchors.length; i++) {
            const cand = remAnchors[i]
            const ringPenalty = isStackedGeneratorBand ? Math.max(0, (cand.wallRing - curA.wallRing)) * 500 : 0
            const d = Math.hypot(cand.x - curA.x, cand.z - curA.z) + ringPenalty
            if (d < bd) { bd = d; bi = i }
          }
          curA = remAnchors.splice(bi, 1)[0]
          orderedAnchors.push(curA)
        }

        const baseOrder = l0 * 4
        const singleWlOrder = +(baseOrder + 0.05).toFixed(2)
        const clusterOrder = +(baseOrder + 0.2).toFixed(2)
        const attachedOrder = +(baseOrder + 2.8).toFixed(2)

        for (const sc of singleLayerCols) {
          for (const st of sc.list) {
            this.moveTaskToOrder(st, baseOrder)
            const swl = this.tasks.get(`${st.key}#w`)
            if (swl) this.moveTaskToOrder(swl, singleWlOrder)
          }
        }

        const allClusterTasks = []
        let globalClusterSeq = 0
        for (let cid = 0; cid < orderedAnchors.length; cid++) {
          const a = orderedAnchors[cid]
          // Sort partner columns so exterior partner (farther from schematic center, on wide deck) is placed FIRST (Step 0/2)
          // and any interior partner is placed LAST (Step 4) after waterlogging!
          a.partners.sort((p1, p2) => ((p2.hasFloor ? 1 : 0) - (p1.hasFloor ? 1 : 0)) || (Math.hypot(p2.x - centerX, p2.z - centerZ) - Math.hypot(p1.x - centerX, p1.z - centerZ)))
          const clusterSeq = []
          const baseY = a.list[0].world.y
          const p0HasFloor = Boolean(a.partners[0]?.hasFloor)
          const p0Hint = p0HasFloor ? { x: a.partners[0].x, y: baseY, z: a.partners[0].z } : null

          if (isStackedGeneratorBand) {
            // Interleaved Level-by-Level Climbing for 64-Module Generator Bands:
            // At each level i (0..3), self-pillar anchor block a.list[i], immediately waterlog it,
            // then place all adjacent partner blocks (cobblestone / oak_leaves) at level i from on top of a.list[i]
            // and waterlog any partner oak_leaves immediately—before climbing to level i + 1!
            // Never jump down from the top of the column: finish at the top ready for the next module/band.
            for (let i = 0; i < a.list.length; i++) {
              const at = a.list[i]
              const standAboveAnchor = new Vec3(a.x, baseY + i + 1, a.z)
              at.verticalColumn = true
              at.verticalAnchorCol = true
              at.verticalAnchorBase = (i === 0)
              at.verticalColTop = false
              at.interleavedClimb = true
              at.verticalBaseY = baseY
              at.verticalPartnerHint = p0Hint
              clusterSeq.push(at)
              const awl = this.tasks.get(`${at.key}#w`)
              if (awl) {
                awl.verticalColumn = true
                awl.interleavedClimb = true
                awl.verticalBaseY = baseY
                awl._preferredStand = standAboveAnchor
                clusterSeq.push(awl)
              }
              for (const p of a.partners) {
                const pt = p.list.find(t => t.layer === l0 + i)
                if (!pt) continue
                pt.verticalColumn = true
                pt.verticalPartnerCol = true
                pt.interleavedClimb = true
                pt.verticalBaseY = baseY
                pt._preferredStand = standAboveAnchor
                clusterSeq.push(pt)
                const pwl = this.tasks.get(`${pt.key}#w`)
                if (pwl) {
                  pwl.verticalColumn = true
                  pwl.interleavedClimb = true
                  pwl.verticalBaseY = baseY
                  pwl._preferredStand = standAboveAnchor
                  clusterSeq.push(pwl)
                }
              }
            }
          } else {
            // Step 0: Place L4 base block of first floor-backed partner column from the flat deck (provides a 3-block zero-fall-damage step-down from L7!)
            if (p0HasFloor && a.partners[0].list.length > 0) {
              const p0Base = a.partners[0].list[0]
              p0Base.verticalColumn = true
              p0Base.verticalPartnerCol = true
              p0Base.verticalBaseY = baseY
              clusterSeq.push(p0Base)
              const p0BaseWl = this.tasks.get(`${p0Base.key}#w`)
              if (p0BaseWl) { p0BaseWl.verticalColumn = true; p0BaseWl.verticalBaseY = baseY; clusterSeq.push(p0BaseWl) }
            }

            // Step 1: Self-pillar the full-height Anchor Column bottom-to-top (L4 -> L5 -> L6 -> L7)
            for (let i = 0; i < a.list.length; i++) {
              const at = a.list[i]
              at.verticalColumn = true
              at.verticalAnchorCol = true
              at.verticalAnchorBase = (i === 0)
              at.verticalColTop = (i === a.list.length - 1)
              at.verticalBaseY = baseY
              at.verticalPartnerHint = p0Hint
              clusterSeq.push(at)
            }

            // Step 2: Place remaining blocks of the first partner column from the flat deck against the anchor column
            if (a.partners.length > 0) {
              for (const pt of a.partners[0].list.slice(p0HasFloor ? 1 : 0)) {
                pt.verticalColumn = true
                pt.verticalPartnerCol = true
                pt.verticalBaseY = baseY
                clusterSeq.push(pt)
                const pwl = this.tasks.get(`${pt.key}#w`)
                if (pwl) { pwl.verticalColumn = true; pwl.verticalBaseY = baseY; clusterSeq.push(pwl) }
              }
            }

            // Step 3: Waterlog all blocks of the Anchor Column from top to bottom (L7#w -> L6#w -> L5#w -> L4#w) while sides are open
            for (const at of [...a.list].reverse()) {
              const awl = this.tasks.get(`${at.key}#w`)
              if (awl) {
                awl.verticalColumn = true
                awl.verticalBaseY = baseY
                clusterSeq.push(awl)
              }
            }

            // Step 4: Place any remaining partner columns (L4 -> L5 -> [L6] -> L7) from the flat deck against the anchor column
            for (const p of a.partners.slice(1)) {
              for (const pt of p.list) {
                pt.verticalColumn = true
                pt.verticalPartnerCol = true
                pt.verticalBaseY = baseY
                clusterSeq.push(pt)
                const pwl = this.tasks.get(`${pt.key}#w`)
                if (pwl) { pwl.verticalColumn = true; pwl.verticalBaseY = baseY; clusterSeq.push(pwl) }
              }
            }
          }

          const rootKey = clusterSeq[0].key
          for (let idx = 0; idx < clusterSeq.length; idx++) {
            const ct = clusterSeq[idx]
            this.moveTaskToOrder(ct, clusterOrder)
            ct.verticalClusterId = cid
            ct.verticalClusterRootKey = rootKey
            ct.verticalClusterSeq = globalClusterSeq++
            ct.verticalPrevKey = idx > 0 ? clusterSeq[idx - 1].key : null
            allClusterTasks.push(ct)
          }
        }

        const clusterGroup = this.orderGroups.get(clusterOrder)
        if (clusterGroup) {
          clusterGroup.isVerticalWallBand = true
          clusterGroup.seqList = allClusterTasks
          clusterGroup.seqPtr = 0
        }

        if (!extractedGeneratorSubBand && attachedTasks.length) {
          attachedTasks.sort((a, b) => (a.layer - b.layer) || (a.world.x - b.world.x) || (a.world.z - b.world.z))
          for (const lt of attachedTasks) {
            lt.verticalColumn = true
            this.moveTaskToOrder(lt, attachedOrder)
          }
        }

        l0 = l1
        matchedBand = true
        break
      }
      if (matchedBand) continue
    }
  }

  expandExpectedFluidFlow () {
    const bx = this.box
    if (!bx) return
    const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const FLUID_BLOCKER = /(_sign$|_wall_sign$|_hanging_sign$|^ladder$|_door$|_fence_gate$|_trapdoor$|_pressure_plate$|_banner$|^sugar_cane$|_fence$|_wall$|_pane$|_bars$|^iron_bars$|^glass_pane$)/
    const isSolidInDesign = (x, y, z) => {
      const t = this.tasks.get(`${x},${y},${z}`)
      if (!t || t.kind !== 'block') return false
      if (FLUID_BLOCKER.test(t.name || '')) return true
      return !t.info?.fragile
    }
    const isWorldFloorWithoutTask = (x, y, z) => {
      const k = `${x},${y},${z}`
      if (this.tasks.has(k)) return false
      const wb = this.world?.blockAt?.({ x, y, z })
      return Boolean(wb && wb.boundingBox === 'block' && wb.name !== 'air' && wb.name !== 'water' && wb.name !== 'lava')
    }
    const sources = []
    for (const [k, kind] of this.fluidCells.entries()) {
      const [x, y, z] = k.split(',').map(Number)
      const t = this.tasks.get(k)
      if (t && t.kind === 'block' && /_leaves$/.test(t.name)) continue
      // Skip intermediate vertical waterfall cells whose lower cell (x, y - 1, z) is already a registered fluid cell of the same kind
      if (y > bx.y0 && !isSolidInDesign(x, y - 1, z) && this.fluidCells.get(`${x},${y - 1},${z}`) === kind) continue
      sources.push([x, y, z, kind, kind === 'water' ? 7 : 3])
    }
    const isSmallBox = (bx.x1 - bx.x0 <= 8 && bx.z1 - bx.z0 <= 8)
    const globalBestReach = new Map()
    for (const [sx, sy, sz, kind, maxReach] of sources) {
      const queue = [[sx, sy, sz, maxReach]]
      const visited = new Set([`${sx},${sy},${sz}`])
      const horizCandidates = []
      let horizEnclosed = true
      let steps = 0
      while (queue.length && steps++ < 256) {
        const [x, y, z, reach] = queue.shift()
        if (!isSmallBox) {
          const gk = `${kind}:${x},${y},${z}`
          const prevR = globalBestReach.get(gk) || 0
          if (prevR >= reach) continue
          globalBestReach.set(gk, reach)
        }
        if (y > bx.y0 && !isSolidInDesign(x, y - 1, z) && !isWorldFloorWithoutTask(x, y - 1, z)) {
          const dk = `${x},${y - 1},${z}`
          if (!this.fluidCells.has(dk)) this.fluidCells.set(dk, kind)
          if (!visited.has(dk)) {
            visited.add(dk)
            queue.push([x, y - 1, z, maxReach])
          }
          continue
        }
        if (reach <= 1) continue
        for (const [dx, dz] of D4) {
          const nx = x + dx; const nz = z + dz
          if (nx < bx.x0 || nx > bx.x1 || nz < bx.z0 || nz > bx.z1) {
            if (isSmallBox) horizEnclosed = false
            continue
          }
          if (isSolidInDesign(nx, y, nz)) continue
          const nk = `${nx},${y},${nz}`
          if (visited.has(nk)) continue
          visited.add(nk)
          horizCandidates.push(nk)
          queue.push([nx, y, nz, reach - 1])
        }
      }
      if (horizEnclosed && horizCandidates.length > 0) {
        for (const nk of horizCandidates) {
          if (!this.fluidCells.has(nk)) this.fluidCells.set(nk, kind)
        }
      }
    }
  }

  computeFluidEnclosureDeps () {
    const FLUID_BLOCKER = /(_sign$|_wall_sign$|_hanging_sign$|^ladder$|_door$|_fence_gate$|_trapdoor$|_pressure_plate$|_banner$|^sugar_cane$|_fence$|_wall$|_pane$|_bars$|^iron_bars$|^glass_pane$)/
    const BACK_VEC = { north: [0, 0, 1], south: [0, 0, -1], west: [1, 0, 0], east: [-1, 0, 0] }
    const isSolidInDesign = (x, y, z) => {
      const t = this.tasks.get(`${x},${y},${z}`)
      if (!t || t.kind !== "block") return false
      if (FLUID_BLOCKER.test(t.name || "")) return true
      return !t.info?.fragile
    }
    for (const task of this.tasks.values()) {
      if (task.kind !== "fluid" && !(task.kind === "waterlog" && !/(_leaves$|mangrove_roots)/.test(task.name || ""))) continue
      const reach = (task.name === "water" || task.kind === "waterlog") ? 7 : 3
      const deps = new Set()
      const flowCells = new Set()
      const baseKey = task.key.replace(/#w$/, "")
      const seen = new Set([baseKey])
      const q = [[task.world.x, task.world.y, task.world.z, reach + 1]]
      const addDepTask = (t) => {
        if (!t || t.kind !== "block") return
        if (t.order >= 90000 || t.layer > task.layer) return
        deps.add(t.key)
        t.isFluidEnclosure = true
        if (/(_sign$|_wall_sign$|_hanging_sign$)/.test(t.name || "") && t.order === t.layer * 4 + 1) {
          this.moveTaskToOrder(t, +(t.layer * 4 + 0.65).toFixed(2))
        }
        if (/(_wall_sign$|^ladder$|^tripwire_hook$)/.test(t.name || "") && t.properties?.facing) {
          const bv = BACK_VEC[t.properties.facing]
          if (bv) {
            const bx = t.world.x + bv[0]; const by = t.world.y + bv[1]; const bz = t.world.z + bv[2]
            const bt = this.tasks.get(`${bx},${by},${bz}`) || (/_door$/.test(this.tasks.get(`${bx},${by - 1},${bz}`)?.name || "") ? this.tasks.get(`${bx},${by - 1},${bz}`) : null)
            if (bt && bt.kind === "block" && bt.order < 90000 && bt.layer <= task.layer) {
              deps.add(bt.key)
              bt.isFluidEnclosure = true
            }
          }
        } else if (/(_sign$|_door$|_pressure_plate$)/.test(t.name || "") && !/_wall_sign$|_hanging_sign$/.test(t.name || "")) {
          const bt = this.tasks.get(`${t.world.x},${t.world.y - 1},${t.world.z}`)
          if (bt && bt.kind === "block" && bt.order < 90000 && bt.layer <= task.layer) {
            deps.add(bt.key)
            bt.isFluidEnclosure = true
          }
        }
      }
      let steps = 0
      while (q.length && steps++ < 500) {
        const [x, y, z, lvl] = q.shift()
        flowCells.add(`${x},${y},${z}`)
        const bk = `${x},${y - 1},${z}`
        const bt = this.tasks.get(bk)
        if (bt && bt.kind === "block") addDepTask(bt)
        if (!isSolidInDesign(x, y - 1, z)) {
          if (this.fluidCells.has(bk) && !seen.has(bk)) {
            seen.add(bk)
            q.push([x, y - 1, z, reach])
          }
          continue
        }
        if (lvl <= 1) continue
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx; const nz = z + dz
          const nk = `${nx},${y},${nz}`
          const nt = this.tasks.get(nk)
          if (nt && nt.kind === "block") addDepTask(nt)
          if (!isSolidInDesign(nx, y, nz) && this.fluidCells.has(nk) && !seen.has(nk)) {
            seen.add(nk)
            q.push([nx, y, nz, lvl - 1])
          }
        }
      }
      task.enclosureDeps = [...deps]
      task.flowCells = [...flowCells]
    }
  }

  computePitCells () {
    const bx = this.box
    if (!bx) return
    const isSolidFullTask = (x, y, z) => {
      const t = this.tasks.get(`${x},${y},${z}`)
      if (!t || t.kind !== "block" || t.info?.fragile) return false
      if (/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(t.name)) return false
      if (/_slab$/.test(t.name) && t.properties?.type === "bottom") return false
      if (/_(fence|wall|pane|door|trapdoor|carpet)$|^glass_pane$/.test(t.name)) return false
      return true
    }
    const isChannelWallTask = (x, y, z) => {
      const t = this.tasks.get(`${x},${y},${z}`)
      return Boolean(t && t.kind === "block" && !t.info?.fragile)
    }
    this.pitCells.clear()
    for (const [k, kind] of this.fluidCells.entries()) {
      const [x, y, z] = k.split(",").map(Number)
      // Solid waterlogged blocks (such as oak_leaves[waterlogged=true]) are solid walkable platforms, NOT open fluid pits!
      if (isSolidFullTask(x, y, z)) continue
      const tHere = this.tasks.get(k)
      if (tHere && tHere.kind === "block" && /_slab$/.test(tHere.name) && tHere.properties?.type === "bottom") continue
      const isNarrowTrough = (isChannelWallTask(x - 1, y, z) && isChannelWallTask(x + 1, y, z)) ||
        (isChannelWallTask(x, y, z - 1) && isChannelWallTask(x, y, z + 1))
      // A wide shallow 1-block water basin or open 1-block stepped water funnel sitting on a solid full floor within 1..2 blocks below
      // is walkable dry floor/staircase until water is poured; narrow 1-wide water troughs/pods (such as L27 water pods), lava cells, and deep vertical drop shafts are static pitCells!
      if (kind === "water" && (isSolidFullTask(x, y - 1, z) || isSolidFullTask(x, y - 2, z)) && !isNarrowTrough) continue
      this.pitCells.add(`${x},${y},${z}`)
      if (!isSolidFullTask(x, y + 1, z)) this.pitCells.add(`${x},${y + 1},${z}`)
    }
    for (const t of this.tasks.values()) {
      if (t.kind !== 'block') continue
      const { x, y, z } = t.world
      // Mark sunken trap containers (hopper, cauldron, composter, chest, trapped_chest, ender_chest) as pitCells so bots never walk into or stand in chest/hopper trenches!
      if (/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(t.name)) {
        this.pitCells.add(`${x},${y},${z}`)
        if (!isSolidFullTask(x, y + 1, z)) this.pitCells.add(`${x},${y + 1},${z}`)
      }
    }
    const checkedShafts = new Set()
    for (const t of this.tasks.values()) {
      if (t.kind !== 'block') continue
      const wx = t.world.x; const wy = t.world.y; const wz = t.world.z
      if (!isSolidFullTask(wx, wy, wz) || !isSolidFullTask(wx, wy + 1, wz)) continue
      for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = wx + ox; const y = wy; const z = wz + oz
        if (x < bx.x0 || x > bx.x1 || z < bx.z0 || z > bx.z1) continue
        const ck = `${x},${y},${z}`
        if (checkedShafts.has(ck)) continue
        checkedShafts.add(ck)
        if (isSolidFullTask(x, y, z)) continue
        let walledBoth = 0
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (isSolidFullTask(x + dx, y, z + dz) && isSolidFullTask(x + dx, y + 1, z + dz)) walledBoth++
        }
        // Only mark 2-block-deep enclosed shafts (where both w0 at y and w1 at y+1 are solid tasks on all 4 sides)
        // as static pitCells. Do NOT mark open ground under a floating platform (where w0 is air) as static pitCells!
        if (walledBoth === 4) {
          this.pitCells.add(ck)
        }
      }
    }
  }

  // Checks if a static `pitCells` entry `(x, y, z)` is currently an active hazard in the live world
  // (e.g. contains fluid or a sunken container at y / y-1, is enclosed by 2-block walls on all 4 sides, or has a >=2-block drop below).
  // Prevents unbuilt future walls/containers from trapping a bot on a flat dry floor during early layers!
  isActivePitCell (x, y, z) {
    const k = `${x},${y},${z}`
    if (!this.pitCells.has(k)) return false
    if (!this.world?.blockAt) return true
    const b0 = this.world.blockAt({ x, y, z })
    const bBelow = this.world.blockAt({ x, y: y - 1, z })
    if (!b0 || !bBelow) return true
    if (b0.boundingBox === "block" && !/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(b0.name || "")) return false
    if (/^(lava|water|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(b0.name || "")) return true
    if (/^(lava|water|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(bBelow.name || "")) return true
    const t0 = this.tasks.get(k)
    const tBelow = this.tasks.get(`${x},${y - 1},${z}`)
    const isHopperPit = (b0.name === "hopper" || bBelow.name === "hopper" || t0?.name === "hopper" || tBelow?.name === "hopper") && !this.fluidCells.has(k) && !this.fluidCells.has(`${x},${y - 1},${z}`)
    if (isHopperPit) {
      const standY = (b0.name === "hopper" || (t0?.name === "hopper" && bBelow.name !== "hopper" && tBelow?.name !== "hopper")) ? y + 1 : y
      let walledStand = 0
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ws = this.world.blockAt({ x: x + dx, y: standY, z: z + dz })
        if (ws && ws.boundingBox === "block" && ws.name !== "hopper") walledStand++
      }
      return walledStand >= 2
    }
    let walledBoth = 0
    let walledHead = 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const w0 = this.world.blockAt({ x: x + dx, y, z: z + dz })
      const w1 = this.world.blockAt({ x: x + dx, y: y + 1, z: z + dz })
      if (w1 && w1.boundingBox === "block") {
        walledHead++
        if (w0 && w0.boundingBox === "block") walledBoth++
      }
    }
    if (walledBoth >= 3 || walledHead >= 4) return true
    if (this.fluidCells.get(k) === "water") {
      const isWallAt = (wx, wy, wz) => {
        const wb = this.world.blockAt({ x: wx, y: wy, z: wz })
        return Boolean(wb && (wb.boundingBox === "block" || /_(fence|wall|pane|bars)$|^iron_bars$|^glass_pane$/.test(wb.name || "")))
      }
      if ((isWallAt(x - 1, y, z) && isWallAt(x + 1, y, z)) || (isWallAt(x, y, z - 1) && isWallAt(x, y, z + 1))) {
        return true
      }
    }
    if (bBelow.boundingBox !== "block") {
      const bBelow2 = this.world.blockAt({ x, y: y - 2, z })
      const bBelow3 = this.world.blockAt({ x, y: y - 3, z })
      const isSolidSupport = blk => Boolean(blk && blk.boundingBox === "block" && !/^(lava|water|hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(blk.name || ""))
      if (!isSolidSupport(bBelow2) && !isSolidSupport(bBelow3)) return true
    }
    return false
  }

  isCorrect (task) {
    const block = this.world?.blockAt?.(task.world)
    if (!block) return false
    return taskMatches(block, task)
  }

  setStatus (task, status) {
    const was = task.status
    task.status = status
    if (status === 'completed') {
      task.priorityBoost = false
      if (/^(chest|trapped_chest)$/.test(task.name || '')) task.softOk = true
      this.blocked.delete(task.key)
      this.quarantined?.delete(task.key)
    } else if (status === 'blocked') {
      this.completed.delete(task.key)
      this.blocked.add(task.key)
    } else {
      this.blocked.delete(task.key)
      if (status === 'pending') this.quarantined?.delete(task.key)
    }
    const group = this.orderGroups.get(task.order)
    if (group) {
      const set = group.cells.get(task.cellKey)
      const wasClosed = was === 'completed' || was === 'blocked'
      const isClosed = status === 'completed' || status === 'blocked'
      if (status === 'completed') this.completed.add(task.key); else this.completed.delete(task.key)
      if (isClosed && !wasClosed) {
        group.remaining -= 1
        set?.delete(task)
      } else if (!isClosed && wasClosed) {
        group.seqPtr = 0
        group.remaining += 1
        if (set) set.add(task)
        else group.cells.set(task.cellKey, new Set([task]))
      }
    }
    // Always sync dependent waterlog child (`#w`) when a waterlogged block parent is blocked, reopened, or completed!
    if (task.kind === 'block' && task.info?.waterlogged) {
      const wl = this.tasks.get(`${task.key}#w`)
      if (wl && wl.status !== 'completed') {
        if (status === 'blocked' && wl.status !== 'blocked') {
          this.blocked.add(wl.key)
          this.setStatus(wl, 'blocked')
        } else if ((status === 'pending' || status === 'completed') && (wl.status === 'blocked' || wl.status === 'deferred')) {
          this.blocked.delete(wl.key)
          wl.deferredUntil = 0
          this.setStatus(wl, 'pending')
        }
      }
    }
  }

  reconcileWorld () {
    for (const task of this.tasks.values()) {
      const block = this.world.blockAt(task.world)
      if (!block) continue
      const correct = taskMatches(block, task)
      if (correct && task.status !== 'completed') this.setStatus(task, 'completed')
      else if (!correct && task.status === 'completed') this.reopenTask(task.key)
    }
    this.doneAtStart = this.completed.size
  }

  reconcileRegion (center, radius = 32) {
    const tasks = this.tasksNear(center, radius)
    for (const task of tasks) {
      const block = this.world.blockAt(task.world)
      if (!block) continue
      const correct = taskMatches(block, task)
      if (correct && task.status !== 'completed') this.markCompleted(task)
      else if (!correct && task.status === 'completed') this.reopenTask(task.key)
    }
    return tasks.length
  }

  recomputeReady () { /* evaluated lazily */ }

  fluidCheck (task) {
    const now = Date.now()
    if (task._fc && now - task._fc.at < 2500) return task._fc.res
    const water = task.name === "water" || task.kind === "waterlog"
    const reach = water ? 7 : 3
    const W = this.world
    const FLUID_BLOCKER = /(_sign$|_wall_sign$|_hanging_sign$|^ladder$|_door$|_fence_gate$|_trapdoor$|_pressure_plate$|_banner$|^sugar_cane$|_fence$|_wall$|_pane$|_bars$|^iron_bars$|^glass_pane$)/
    const WASHABLE_FRAGILE = /^(redstone_wire|repeater|comparator|redstone_torch|redstone_wall_torch|tripwire|tripwire_hook|lever|.*_button|.*_rail|rail|torch|wall_torch|soul_torch|soul_wall_torch)$/
    const BACK_VEC = { north: [0, 0, 1], south: [0, 0, -1], west: [1, 0, 0], east: [-1, 0, 0] }
    const solid = b => !b || b.boundingBox === "block" || FLUID_BLOCKER.test(b.name || "")
    const isLavaSrc = b => b && b.name === "lava" && Number(b.metadata) === 0
    const isWater = b => b && b.name === "water"
    const seen = new Set()
    const leaks = []
    const leakSet = new Set()
    const addLeak = k => { if (k && !leakSet.has(k)) { leakSet.add(k); leaks.push(k) } }
    const tempObstructions = []
    const tempSet = new Set()
    const addTempObs = (x, y, z) => {
      const tk = `${x},${y},${z}`
      if (!tempSet.has(tk)) { tempSet.add(tk); tempObstructions.push({ x, y, z }) }
    }
    if (task.kind === "fluid" && this.isTempCell && this.isTempCell(task.world.x, task.world.y, task.world.z)) {
      addLeak(keyOf(task.world))
      addTempObs(task.world.x, task.world.y, task.world.z)
    }
    if (Array.isArray(task.flowCells)) {
      for (const fk of task.flowCells) {
        const [fx, fy, fz] = fk.split(",").map(Number)
        if (this.isTempCell && this.isTempCell(fx, fy, fz)) {
          addTempObs(fx, fy, fz)
        }
      }
    }
    if (Array.isArray(task.enclosureDeps)) {
      for (const dk of task.enclosureDeps) {
        const dt = this.tasks.get(dk)
        if (!dt || dt.kind !== "block") continue
        const dTemp = Boolean(this.isTempCell && this.isTempCell(dt.world.x, dt.world.y, dt.world.z))
        if (dTemp) addTempObs(dt.world.x, dt.world.y, dt.world.z)
        const db = W.blockAt(dt.world)
        if ((this.fleet && dt.status !== "completed") || dTemp || !db || !taskMatches(db, dt)) {
          addLeak(dk)
        }
      }
    }
    let contact = null
    let why = null
    const queue = [[task.world.x, task.world.y, task.world.z, reach + 1]]
    seen.add(keyOf(task.world))
    let n = 0
    const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    while (queue.length && n++ < 500) {
      const [x, y, z, lvl] = queue.shift()
      if (water) {
        for (const f of FACES) { const nb = W.blockAt({ x: x + f.x, y: y + f.y, z: z + f.z }); if (isLavaSrc(nb)) { contact = contact || keyOf({ x: x + f.x, y: y + f.y, z: z + f.z }); why = why || "water would touch a lava source" } }
      } else {
        const isSourceCell = x === task.world.x && y === task.world.y && z === task.world.z
        for (const f of FACES) {
          if (f.y < 0) continue
          const nx = x + f.x; const ny = y + f.y; const nz = z + f.z
          const nb = W.blockAt({ x: nx, y: ny, z: nz })
          if (isWater(nb)) {
            const nbKey = `${nx},${ny},${nz}`
            // Only flag obsidian contact if water is directly touching the lava source cell itself, OR if the water is stray (not an intentional schematic fluid cell in a cobblestone generator)!
            if (isSourceCell || !this.fluidCells.has(nbKey)) {
              contact = contact || nbKey
              why = why || "lava source would touch water (obsidian)"
            }
          }
        }
      }
      const visit = (nx, ny, nz, nl) => {
        const k = keyOf({ x: nx, y: ny, z: nz })
        if (seen.has(k)) return
        const b = W.blockAt({ x: nx, y: ny, z: nz })
        const t = this.tasks.get(k)
        const bx = this.box
        const isExplicitTemp = Boolean(this.isTempCell && this.isTempCell(nx, ny, nz))
        const isForeignFluidChannel = Boolean(b && solid(b) && !this.tasks.has(k) && this.fluidCells.has(k))
        if (isExplicitTemp || isForeignFluidChannel) addTempObs(nx, ny, nz)
        const strayInside = Boolean(bx && nx >= bx.x0 && nx <= bx.x1 && ny >= bx.y0 && ny <= bx.y1 && nz >= bx.z0 && nz <= bx.z1 && !this.tasks.has(k) && !this.fluidCells.has(k))
        const temp = strayInside || isExplicitTemp || isForeignFluidChannel
        if (t && t.kind === "block" && !this.fluidCells.has(k)) {
          if ((this.fleet && t.status !== "completed") || temp || !b || !taskMatches(b, t)) {
            if (/(_wall_sign$|^ladder$|^tripwire_hook$)/.test(t.name || "") && t.properties?.facing) {
              const bv = BACK_VEC[t.properties.facing]
              if (bv) {
                const bk = `${nx + bv[0]},${ny + bv[1]},${nz + bv[2]}`
                const bt = this.tasks.get(bk)
                const bb = W.blockAt({ x: nx + bv[0], y: ny + bv[1], z: nz + bv[2] })
                if (bt && ((this.fleet && bt.status !== "completed") || !bb || !taskMatches(bb, bt))) addLeak(bk)
              }
            }
            addLeak(k)
          }
          return
        }
        if (b && WASHABLE_FRAGILE.test(b.name || "") && !this.fluidCells.has(k)) {
          contact = contact || k
          why = why || `${task.name} would wash away ${b.name} at ${k}`
          addLeak(k)
          return
        }
        if (t && t.kind === "block" && WASHABLE_FRAGILE.test(t.name || "") && !t.info?.waterlogged && !this.fluidCells.has(k)) {
          contact = contact || k
          why = why || `${task.name} would flow into planned ${t.name} cell at ${k}`
          addLeak(k)
          return
        }
        if (solid(b) && !temp) return
        seen.add(k)
        if (this.fluidCells.has(k)) { queue.push([nx, ny, nz, nl]); return }
        addLeak(k)
      }
      const below = W.blockAt({ x, y: y - 1, z })
      const belowKey = `${x},${y - 1},${z}`
      const belowTask = this.tasks.get(belowKey)
      const belowTemp = Boolean(this.isTempCell && this.isTempCell(x, y - 1, z))
      const belowForeignFluid = Boolean(below && solid(below) && !this.tasks.has(belowKey) && this.fluidCells.has(belowKey))
      if (belowTemp || belowForeignFluid) addTempObs(x, y - 1, z)
      const belowTaskUnfinished = Boolean(belowTask && belowTask.kind === "block" && ((this.fleet && belowTask.status !== "completed") || belowTemp || !below || !taskMatches(below, belowTask)))
      if (!solid(below) || belowTaskUnfinished || ((belowTemp || belowForeignFluid) && this.fluidCells.has(belowKey))) { visit(x, y - 1, z, reach); continue }
      if (lvl <= 1) continue
      for (const [dx, dz] of D4) visit(x + dx, y, z + dz, lvl - 1)
    }
    const res = {
      blocked: leaks.length > 0 || Boolean(contact),
      why: contact ? why : (leaks.length ? `would run into ${leaks.length} cell(s) that are not closed yet or that the design keeps empty, e.g. ${leaks[0]}` : (tempObstructions.length ? `fluid channel has ${tempObstructions.length} temporary obstruction(s)` : null)),
      leaks,
      contact,
      tempObstructions
    }
    task._fc = { at: now, res }
    return res
  }

  isReady (task) {
    if (task.kind === "waterlog") {
      const parent = this.tasks.get(task.parentKey)
      if (!parent || parent.status !== "completed") return false
      if (!/(_leaves$|mangrove_roots)/.test(task.name)) {
        if (!task.fluidForce && Array.isArray(task.enclosureDeps)) {
          for (const dk of task.enclosureDeps) {
            const dt = this.tasks.get(dk)
            if (!dt || dt.kind !== "block") continue
            if (dt.status !== "completed") return false
            if (this.isTempCell && this.isTempCell(dt.world.x, dt.world.y, dt.world.z)) return false
            const db = this.world.blockAt(dt.world)
            if (!db || !taskMatches(db, dt)) return false
          }
        }
        if (!task.fluidForce && this.fluidCheck(task).blocked) return false
        for (const f of FACES) {
          if (f.y > 0) continue
          const n = this.tasks.get(`${task.world.x + f.x},${task.world.y + f.y},${task.world.z + f.z}`)
          if (!n || n.kind !== "block") continue
          const nb = this.world.blockAt(n.world)
          if (!nb || nb.name === "air" || nb.name === "cave_air" || nb.name === "void_air" || !taskMatches(nb, n)) return false
          if (this.isTempCell && this.isTempCell(n.world.x, n.world.y, n.world.z)) return false
        }
      }
      return true
    }
    if (task.kind === "fluid") {
      if (!task.fluidForce && Array.isArray(task.enclosureDeps)) {
        for (const dk of task.enclosureDeps) {
          const dt = this.tasks.get(dk)
          if (!dt || dt.kind !== "block") continue
          if (dt.status !== "completed") return false
          if (this.isTempCell && this.isTempCell(dt.world.x, dt.world.y, dt.world.z)) return false
          const db = this.world.blockAt(dt.world)
          if (!db || !taskMatches(db, dt)) return false
        }
      }
      if (!task.fluidForce && Array.isArray(task.flowCells)) {
        for (const fk of task.flowCells) {
          const [fx, fy, fz] = fk.split(",").map(Number)
          if (this.isTempCell && this.isTempCell(fx, fy, fz)) return false
        }
      }
      if (!task.fluidForce && this.fluidCheck(task).blocked) return false
      for (const f of FACES) {
        if (f.y > 0) continue
        const n = this.tasks.get(`${task.world.x + f.x},${task.world.y + f.y},${task.world.z + f.z}`)
        if (!n || n.kind !== "block") continue
        const nb = this.world.blockAt(n.world)
        if (!nb || nb.name === "air" || nb.name === "cave_air" || nb.name === "void_air" || !taskMatches(nb, n)) return false
        if (this.isTempCell && this.isTempCell(n.world.x, n.world.y, n.world.z)) return false
      }
      for (const f of FACES) {
        const b = this.world.blockAt(task.world.plus(f))
        if (b && b.boundingBox === "block") return true
      }
      return false
    }
    if (task.name === 'hopper' && this.tasks) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (dx === 0 && dz === 0) continue
          const ct = this.tasks.get(`${task.world.x + dx},${task.world.y},${task.world.z + dz}`)
          if (ct && /^(chest|trapped_chest|ender_chest)$/.test(ct.name) && ct.status !== 'completed' && ct.status !== 'blocked' && (ct.attempts || 0) < 4) {
            return false
          }
        }
      }
    }
    const pref = this.learner?.preferredFor ? this.learner.preferredFor(task) : this.learner?.preferred?.[task.name]
    const cache = task.info._rf
    let faces
    if (cache && cache.pref === pref) faces = cache.faces
    else {
      faces = [...new Set(task.info.specs.filter(sp => !sp.hyp || sp.tag === pref).flatMap(sp => usableFaces(sp)))]
      task.info._rf = { pref, faces }
    }
    const V = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
    for (const name of faces) {
      const v = V[name]
      const rx = task.world.x - v[0]; const ry = task.world.y - v[1]; const rz = task.world.z - v[2]
      const ref = this.world.blockAt({ x: rx, y: ry, z: rz })
      if (!ref || (ref.boundingBox !== 'block' && !/_door$|_trapdoor$|_fence_gate$/.test(ref.name || '')) || /^(repeater|comparator|daylight_detector)$|_carpet$/.test(ref.name || '')) continue
      if (/_slab$/.test(ref.name)) {
        const rp = ref.getProperties?.() || ref.properties || {}
        if (rp.type === 'bottom' && name === 'up') continue
        if (rp.type === 'top' && name === 'down') continue
      }
      if (task.info?.fragile) {
        if (this.isTempCell && this.isTempCell(rx, ry, rz)) continue
        const refTask = this.tasks.get(`${rx},${ry},${rz}`) || (/_door$/.test(this.tasks.get(`${rx},${ry - 1},${rz}`)?.name || '') ? this.tasks.get(`${rx},${ry - 1},${rz}`) : null)
        if (refTask && refTask.kind === 'block' && refTask.status !== 'completed') continue
      }
      return true
    }
    return false
  }

  refPending (task) {
    if (task.kind !== 'block') return false
    if (/^(chest|trapped_chest)$/.test(task.name || "") && this.tasks && task.properties?.facing) {
      const f = task.properties.facing
      const t = task.properties.type
      const CW = { north: "east", east: "south", south: "west", west: "north" }
      const CCW = { north: "west", west: "south", south: "east", east: "north" }
      const VDIR = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
      if ((t === "left" || t === "right") && +(task.order - Math.floor(task.order)).toFixed(2) === 0.30) {
        const pDir = t === "left" ? CW[f] : CCW[f]
        const pv = VDIR[pDir]
        if (pv) {
          const pt = this.tasks.get(`${task.world.x + pv[0]},${task.world.y + pv[1]},${task.world.z + pv[2]}`)
          if (pt && pt.status !== "completed" && pt.status !== "blocked" && (pt.attempts || 0) < 4) return true
        }
      }
      const fv = VDIR[f]
      if (fv) {
        const prevChest = this.tasks.get(`${task.world.x - fv[0]},${task.world.y},${task.world.z - fv[2]}`)
        if (prevChest && prevChest.name === task.name && prevChest.order === task.order && prevChest.properties?.facing === f && prevChest.status !== "completed" && prevChest.status !== "blocked" && (prevChest.attempts || 0) < 3) {
          return true
        }
      }
    }
    if (/^(repeater|comparator)$/.test(task.name || "") && this.tasks) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const adj = this.tasks.get(`${task.world.x + dx},${task.world.y},${task.world.z + dz}`)
        if (adj && adj.kind === "block" && !adj.info?.fragile && adj.status !== "completed" && adj.status !== "blocked" && (adj.attempts || 0) < 3) {
          return true
        }
      }
    }
    const V = { up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
    const nonHyp = task.info.specs.filter(sp => !sp.hyp)
    const checkSpecs = nonHyp.length ? nonHyp : [task.info.specs[0]]
    let sawPending = false
    for (const spec of checkSpecs) {
      if (!spec) continue
      for (const name of usableFaces(spec)) {
        const v = V[name]
        const rx = task.world.x - v[0]; const ry = task.world.y - v[1]; const rz = task.world.z - v[2]
        const ref = this.world.blockAt({ x: rx, y: ry, z: rz })
        const refSolid = ref && (ref.boundingBox === 'block' || /_door$|_trapdoor$|_fence_gate$/.test(ref.name || ''))
        if (refSolid && !(task.info?.fragile && this.isTempCell && this.isTempCell(rx, ry, rz))) {
          if (!task.info?.fragile) return false
          const rt = this.tasks.get(`${rx},${ry},${rz}`) || (/_door$/.test(this.tasks.get(`${rx},${ry - 1},${rz}`)?.name || '') ? this.tasks.get(`${rx},${ry - 1},${rz}`) : null)
          if (!rt || rt.status === 'completed' || taskMatches(ref, rt)) return false
        }
        const n = this.tasks.get(`${rx},${ry},${rz}`) || (/_door$/.test(this.tasks.get(`${rx},${ry - 1},${rz}`)?.name || '') ? this.tasks.get(`${rx},${ry - 1},${rz}`) : null)
        if (n && n.kind === 'block' && n.status !== 'completed') {
          if (task.info?.fragile || task.name === 'hopper') {
            if (n.status === 'blocked' && (n._autoReopenCount || 0) < 1 && Date.now() - (n._lastAutoReopen || 0) > 15_000) {
              n._lastAutoReopen = Date.now()
              n._autoReopenCount = (n._autoReopenCount || 0) + 1
              this.reopenTask(n.key, this.fleet?.index, { forceReset: true })
            }
            if (n.status !== 'blocked') sawPending = true
          } else if (n.status !== 'blocked' && n.attempts < 6 && !n.info?.fragile) {
            sawPending = true
          }
        }
      }
    }
    return sawPending
  }

  hasDirectlyUnfinishedBelow (task) {
    if (task?.verticalPrevKey && this.tasks) {
      let curKey = task.verticalPrevKey
      for (let hop = 0; hop < 24 && curKey; hop++) {
        const prev = this.tasks.get(curKey)
        if (!prev || prev.status === "completed") break
        if (prev.status !== "blocked") return true
        curKey = prev.verticalPrevKey
      }
    }
    if (!task?.world || !this.tasks || task.kind !== 'block') return false
    for (let dy = 1; dy <= 2; dy++) {
      const k = `${task.world.x},${task.world.y - dy},${task.world.z}`
      const bTask = this.tasks.get(k)
      if (bTask && bTask.kind === 'block' && bTask.status !== 'completed' && ((dy === 1 && task.info?.fragile) || (/^(chest|trapped_chest|ender_chest|hopper|barrel)$/.test(bTask.name || '') && (bTask.totalAttempts || 0) < 12) || (dy === 1 && /_(fence_gate|door|trapdoor)$/.test(bTask.name || '') && (bTask.totalAttempts || 0) < 8))) {
        if (bTask.status === 'blocked' && (bTask._autoReopenCount || 0) < 1 && Date.now() - (bTask._lastAutoReopen || 0) > 15_000) {
          bTask._lastAutoReopen = Date.now()
          bTask._autoReopenCount = (bTask._autoReopenCount || 0) + 1
          this.reopenTask(bTask.key, this.fleet?.index, { forceReset: true })
        }
        if (bTask.status !== 'blocked') return true
      }
      if (bTask && (bTask.kind === 'block' || bTask.kind === 'fluid') && bTask.status !== 'completed' && bTask.status !== 'blocked' && bTask.order < 88000 && (bTask.order < task.order || ((task.isolatedColumn || task.verticalColumn) && bTask.world.y < task.world.y))) {
        const bFaces = bTask.info?.specs?.[0] ? usableFaces(bTask.info.specs[0]) : []
        if (bFaces.length === 1 && bFaces[0] === 'down') continue
        return true
      }
      const wTask = this.tasks.get(`${k}#w`)
      if (wTask && wTask.status !== 'completed' && wTask.status !== 'blocked' && wTask.order < task.order && (!bTask || bTask.status === 'completed')) {
        return true
      }
      // Never seal the 3x3 roof directly above an uncompleted gate/trapdoor/door/container/crafter/observer within 1..2 layers below!
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dz === 0) continue
          const nk = `${task.world.x + dx},${task.world.y - dy},${task.world.z + dz}`
          const nb = this.tasks.get(nk)
          if (nb && nb.kind === 'block' && nb.status !== 'completed' && nb.status !== 'blocked' && nb.order < task.order && (nb.totalAttempts || 0) < 6 &&
              /_(fence_gate|door|trapdoor)$|^(chest|trapped_chest|ender_chest|hopper|barrel|crafter|observer|dropper|dispenser)$/.test(nb.name || '')) {
            return true
          }
        }
      }
    }
    if ((task.islandPrevKey || task.bridgeAnchorKey) && !this.isReady(task)) {
      if (task.islandPrevKey) {
        const prev = this.tasks.get(task.islandPrevKey)
        if (prev && prev.order <= task.order && prev.status !== 'completed' && prev.status !== 'blocked' && (prev.attempts || 0) < 2) {
          if (!(this.fleet && prev.owner !== task.owner && (prev.attempts || 0) >= 1)) {
            return true
          }
        }
      }
      if (task.bridgeAnchorKey) {
        const anc = this.tasks.get(task.bridgeAnchorKey)
        if (anc && anc.order <= task.order && anc.status !== 'completed' && anc.status !== 'blocked' && (anc.attempts || 0) < 2) {
          const sameZone = !this.fleet || anc.owner === task.owner
          const ancBusy = Boolean(this.fleet && this.fleet.coord?.busyFor?.(this.fleet.id, anc, false))
          if (anc.order < task.order || (sameZone && !ancBusy && (anc.attempts || 0) < 1)) {
            return true
          }
        }
      }
    }
    return false
  }

  hasUnfinishedBelow (task) {
    if (!task?.world || !this.tasks) return false
    for (let dy = 1; dy <= 3; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dy > 2 && (dx !== 0 || dz !== 0)) continue
          const k = `${task.world.x + dx},${task.world.y - dy},${task.world.z + dz}`
          const bTask = this.tasks.get(k)
          if (bTask && bTask.order < 88000 && bTask.order < task.order && bTask.status !== 'completed' && bTask.status !== 'blocked') return true
          const wTask = this.tasks.get(`${k}#w`)
          if (wTask && wTask.order < task.order && wTask.status !== 'completed' && wTask.status !== 'blocked' && (!bTask || bTask.status === 'completed')) return true
        }
      }
    }
    return false
  }

  hasOpenBlockBelowOrder (thresholdOrder) {
    for (const [ord, g] of this.orderGroups.entries()) {
      if (ord >= thresholdOrder) continue
      if (!g || g.remaining <= 0) continue
      for (const set of g.cells.values()) {
        for (const t of set) {
          if (t.kind === 'block' && t.status !== 'completed' && t.status !== 'blocked' && (ord >= 88000 || (t.attempts || 0) < 3)) return true
        }
      }
    }
    return false
  }

  phaseBlocked (order) {
    if (order >= 110000 && this.hasOpenBlockBelowOrder(110000)) return true
    if (order >= 105000 && this.hasOpenBlockBelowOrder(105000)) return true
    if (order >= 100000 && this.hasOpenBlockBelowOrder(100000)) return true
    if (order >= 95000 && this.hasOpenBlockBelowOrder(95000)) return true
    if (order >= 88000 && this.hasOpenBlockBelowOrder(88000)) return true
    return false
  }

  activeClusterBonus (task) {
    if (!task?.verticalClusterRootKey || !this.tasks) return 0
    const root = this.tasks.get(task.verticalClusterRootKey)
    return (root && root.status === "completed") ? -300 : 0
  }

  priority (task, botPosition) {
    const distance = task.world.distanceTo(botPosition)
    const vertical = Math.abs(task.world.y - botPosition.y)
    const readyBonus = (!this.lookaheadMode && this.isReady(task)) ? -35 : 0
    const seedBonus = (!readyBonus && task.bridgeAnchorKey && this.tasks?.get(task.bridgeAnchorKey)?.status === 'completed') ? -22 : 0
    const encBonus = task.isFluidEnclosure ? -15 : 0
    const boost = (task.priorityBoost ? -1000 : 0) + this.activeClusterBonus(task) + readyBonus + seedBonus + encBonus
    const retreatBonus = Math.min(8, (task.retreatScore || 0) * 0.15) + (task.verticalClusterSeq != null ? -task.verticalClusterSeq * 0.02 : 0)
    return boost + distance + vertical * 1.4 + task.attempts * 50 - retreatBonus
  }

  usable (task, now) {
    if (task.status === 'completed' || task.status === 'blocked') return false
    if (task.status === 'deferred' && Number(task.deferredUntil || 0) > now) return false
    if (this.isCorrect(task)) { this.markCompleted(task); return false }
    if (task.kind === 'waterlog') {
      const parent = this.tasks.get(task.parentKey)
      if (!parent || parent.status !== 'completed') return false
    }
    return true
  }

  groupHasUsableNow (group, now = Date.now()) {
    if (!group || group.remaining <= 0) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (this.usable(t, now)) return true
      }
    }
    return false
  }

  groupHasOpenBlock (group) {
    if (!group || group.remaining <= 0) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if ((t.kind === 'block' || t.kind === 'fluid' || t.kind === 'waterlog') && t.status !== 'completed' && t.status !== 'blocked') return true
      }
    }
    return false
  }

  groupHasAnyReady (group, now = Date.now()) {
    if (!group || group.remaining <= 0) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (!this.usable(t, now) || this.hasDirectlyUnfinishedBelow(t)) continue
        if (this.enforceColumnGuard && this.hasUnfinishedBelow(t)) continue
        if (t.info?.fragile && this.refPending(t)) continue
        if (this.fleet && this.fleet.coord?.busyFor?.(this.fleet.id, t, false)) continue
        if (this.isReady(t)) return true
      }
    }
    return false
  }

  groupHasOwnBridgeSeedReady (group, now = Date.now()) {
    if (!this.fleet || !group || group.remaining <= 0) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (t.owner !== this.fleet.index) continue
        if (!this.usable(t, now) || this.hasDirectlyUnfinishedBelow(t)) continue
        if (t.bridgeAnchorKey && this.tasks.get(t.bridgeAnchorKey)?.status === 'completed') return true
      }
    }
    return false
  }

  hasActiveWavefrontInGroup (group, now = Date.now()) {
    if (!group || group.remaining <= 0) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (!this.usable(t, now)) continue
        if ((t.attempts || 0) >= 3) continue
        if (this.hasDirectlyUnfinishedBelow(t)) continue
        if (this.isReady(t)) return true
      }
    }
    return false
  }

  isRetriedStragglerGroup (group, layer, now = Date.now()) {
    if (!group || layer >= 9999 || !this.groupHasUsableNow(group, now)) return false
    return Boolean(
      (group.remaining <= 2 && !this.groupHasUnfinishedBelowMaxAttempts(group, 2)) ||
      (group.remaining <= 4 && (!this.groupHasUnfinishedBelowMaxAttempts(group, 1) || this.hasHigherLayerProgress(layer, 20)))
    )
  }

  groupHasUnfinishedBelowMaxAttempts (group, maxAttempts = 3) {
    if (!group || group.remaining <= 0) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (t.status !== 'completed' && t.status !== 'blocked' && (t.attempts || 0) < maxAttempts) {
          if (t.name === 'observer' && (t.properties?.facing === 'down' || t.properties?.facing === 'up')) continue
          if (this.fleet && group.remaining <= 4 && this.fleet.coord.busyFor(this.fleet.id, t, false)) continue
          return true
        }
      }
    }
    return false
  }

  hasOwnDeferredInGroup (group) {
    if (!this.fleet || !group) return false
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (t.status === 'deferred' && t.owner === this.fleet.index) return true
      }
    }
    return false
  }

  undeferOwnInGroup (group, botPosition = null) {
    if (!this.fleet || !group) return false
    let best = null
    let bestScore = Infinity
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (t.status === 'deferred' && t.owner === this.fleet.index) {
          const d = botPosition ? t.world.distanceTo(botPosition) : 0
          const s = d * 2 + ((t.deferredUntil || 0) - Date.now()) * 0.005
          if (s < bestScore) { bestScore = s; best = t }
        }
      }
    }
    if (best) {
      best.deferredUntil = 0
      best.status = 'pending'
      return true
    }
    return false
  }

  searchGroup (group, botPosition, wantReady) {
    if (!this.fleet) return this.scanGroup(group, botPosition, wantReady, null)
    this.sawBusy = false
    const ownTask = this.scanGroup(group, botPosition, wantReady, 'own')
    if (ownTask) {
      if (wantReady && botPosition && !group.isSingleWorkerChain) {
        const ownDist = ownTask.world.distanceTo(botPosition)
        if (ownDist > 22) {
          const nearbySteal = this.scanGroup(group, botPosition, true, 'steal')
          if (nearbySteal) {
            const stealDist = nearbySteal.world.distanceTo(botPosition)
            if (stealDist <= 9.5 && stealDist < ownDist * 0.4) {
              return nearbySteal
            }
          }
        }
      }
      return ownTask
    }
    if (group.isSingleWorkerChain && group.chainOwner !== undefined && group.chainOwner !== this.fleet.index) {
      const isBackupWorker = this.fleet.count > 1 && this.fleet.index === ((group.chainOwner + 1) % this.fleet.count)
      if (!this.hasDeferredInGroup(group) || !isBackupWorker) {
        this.sawBusy = true
        return null
      }
    }
    if (wantReady) {
      const ownCand = this.scanGroup(group, botPosition, false, 'own')
      if (ownCand) {
        this.sawBusy = true
        return null
      }
    }
    const stealTask = this.scanGroup(group, botPosition, wantReady, 'steal')
    if (this.hasOwnDeferredInGroup(group)) {
      const stealDist = (stealTask && botPosition) ? stealTask.world.distanceTo(botPosition) : Infinity
      // Never walk >20 blocks to steal a single task on the opposite side of the map (or return null when far steals were filtered) while we still have our own deferred tasks in this group!
      if (!stealTask || stealDist > 20) {
        if (this.undeferOwnInGroup(group, botPosition)) {
          const wokenOwn = this.scanGroup(group, botPosition, wantReady, 'own')
          if (wokenOwn) return wokenOwn
        }
        this.sawBusy = true
        return null
      }
    }
    return stealTask
  }

  scanGroup (group, botPosition, wantReady, mode) {
    const now = Date.now()
    if ((group.isVerticalWallBand || group.isModuleClusterBase) && group.clusters) {
      let best = null; let bestScore = Infinity
      for (const cl of group.clusters) {
        while (cl.ptr < cl.tasks.length) {
          const _ct = cl.tasks[cl.ptr]
          if (_ct.status === 'completed' || _ct.status === 'blocked') { cl.ptr++; continue }
          if (this.isCorrect(_ct)) { this.markCompleted(_ct); cl.ptr++; continue }
          break
        }
        if (cl.ptr >= cl.tasks.length) continue
        const task = cl.tasks[cl.ptr]
        if (!this.usable(task, now)) continue
        if (this.hasDirectlyUnfinishedBelow(task)) continue
        if (this.enforceColumnGuard && this.hasUnfinishedBelow(task)) continue
        if (this.lookaheadMode && !this.lookOk(task)) continue
        if (mode && !this.fleetOk(task, mode, botPosition)) continue
        if (wantReady && !this.isReady(task)) continue
        const dist = task.world.distanceTo(botPosition)
        const clusterBonus = cl.ptr > 0 ? -300 : 0
        if (wantReady && !this.lookaheadMode && cl.ptr > 0 && dist <= 4.7 && (!this.probe || this.probe(task))) {
          return task
        }
        const score = (task.priorityBoost ? -1000 : 0) + clusterBonus + dist + Math.abs(task.world.y - botPosition.y) * 1.4 + task.attempts * 50 + (task.verticalClusterSeq || 0) * 0.01
        if (score < bestScore) { bestScore = score; best = task }
      }
      return best
    }
    const bx = Math.floor(botPosition.x / CELL); const bz = Math.floor(botPosition.z / CELL)

    // When Architect sequence (`group.seqList`) is active, follow the local snake row sequence within the bot's neighborhood
    // while weighting physical distance heavily so a bot NEVER abandons ready blocks nearby to walk 50-100 blocks to an earlier un-deferred seq index!
    if (this.architectActive && group.seqList) {
      const list = group.seqList
      while (group.seqPtr < list.length && (list[group.seqPtr].status === 'completed' || list[group.seqPtr].status === 'blocked')) group.seqPtr++
      let scanned = 0; let bestReady = null; let bestReadyScore = Infinity
      for (let i = group.seqPtr; i < list.length && scanned < 2500; i++) {
        const task = list[i]
        if (!this.usable(task, now)) continue
        if (this.hasDirectlyUnfinishedBelow(task)) continue
        if (this.enforceColumnGuard && this.hasUnfinishedBelow(task)) continue
        if (this.lookaheadMode && !this.lookOk(task)) continue
        if ((this.skipPending || task.info?.fragile || task.name === 'hopper') && (!wantReady || task.info?.fragile || task.name === 'hopper') && this.refPending(task)) continue
        if (mode && !this.fleetOk(task, mode, botPosition)) continue
        scanned++
        if (wantReady && !this.isReady(task)) continue
        if (!wantReady || this.lookaheadMode) return task
        const dist = task.world.distanceTo(botPosition)
        if (this.probe && scanned === 1 && dist <= 5.0 && mode !== 'steal' && this.probe(task)) return task
        const localSeq = Math.min(scanned, 16)
        const inPlaceBonus = (this.probe && dist <= 4.7 && this.probe(task)) ? (scanned <= 12 ? -28 : -18) : 0
        const seqDistCost = mode === 'steal'
          ? dist * 3.0 + localSeq * 0.25 + (dist > 20 ? 120 : 0)
          : (dist <= 6.5
              ? localSeq * 0.45 + dist * 1.8
              : (dist <= 16.0 ? localSeq * 0.45 + dist * 2.8 + 18 : localSeq * 0.35 + dist * 4.2 + 95))
        const score = (task.priorityBoost ? -1000 : 0) + this.activeClusterBonus(task) + inPlaceBonus + seqDistCost + task.attempts * 40
        if (score < bestReadyScore) { bestReadyScore = score; bestReady = task }
      }
      if (bestReady) return bestReady
      if (!wantReady || scanned < 2500) return null
    }

    if (wantReady && !this.lookaheadMode && !this.architectActive) {
      let bestInPlace = null; let bestInPlaceScore = Infinity
      let bestBoost = null; let bestBoostScore = Infinity
      let bestLocalReady = null; let bestLocalReadyScore = Infinity
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const set = group.cells.get(`${bx + dx},${bz + dz}`)
          if (!set || !set.size) continue
          for (const task of set) {
            if (!this.usable(task, now)) continue
            if (this.hasDirectlyUnfinishedBelow(task)) continue
            if (this.enforceColumnGuard && this.hasUnfinishedBelow(task)) continue
            if (task.info?.fragile && this.refPending(task)) continue
            if (mode && !this.fleetOk(task, mode, botPosition)) continue
            if (!this.isReady(task)) continue
            const dist = task.world.distanceTo(botPosition)
            const retreatBonus = Math.min(4, (task.retreatScore || 0) * 0.08)
            if (task.priorityBoost) {
              if (dist < bestBoostScore) { bestBoostScore = dist; bestBoost = task }
            }
            const clusterBonus = this.activeClusterBonus(task)
            if (this.probe && dist <= 4.7 && this.probe(task) && (!group.isVerticalWallBand || clusterBonus < 0)) {
              const s = (task.priorityBoost ? -500 : 0) + clusterBonus + dist + task.attempts * 20 - retreatBonus
              if (s < bestInPlaceScore) { bestInPlaceScore = s; bestInPlace = task }
            } else if (dist <= 7.5) {
              const s = clusterBonus + dist + Math.abs(task.world.y - botPosition.y) * 1.2 + task.attempts * 25 + ((task.verticalClusterSeq ?? task.seq) || 0) * 0.02 - retreatBonus
              if (s < bestLocalReadyScore) { bestLocalReadyScore = s; bestLocalReady = task }
            }
          }
        }
      }
      if (bestInPlace) return bestInPlace
      if (bestBoost) return bestBoost
      if (bestLocalReady) return bestLocalReady
    }

    let best = null; let bestScore = Infinity
    const maxRing = 40
    let foundRing = -1
    for (let r = 0; r <= maxRing; r++) {
      if (best && r > foundRing + 1) break
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          const set = group.cells.get(`${bx + dx},${bz + dz}`)
          if (!set || !set.size) continue
          for (const task of set) {
            if (!this.usable(task, now)) continue
            if (this.hasDirectlyUnfinishedBelow(task)) continue
            if (this.enforceColumnGuard && this.hasUnfinishedBelow(task)) continue
            if (this.lookaheadMode && !this.lookOk(task)) continue
            if ((this.skipPending || task.info?.fragile || task.name === 'hopper') && (!wantReady || task.info?.fragile || task.name === 'hopper') && this.refPending(task)) continue
            if (mode && !this.fleetOk(task, mode, botPosition)) continue
            if (wantReady && !this.isReady(task)) continue
            const score = this.priority(task, botPosition)
            if (score < bestScore) { bestScore = score; best = task; if (foundRing < 0) foundRing = r }
          }
        }
      }
    }
    return best
  }

  hasDeferredInGroup (group) {
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (t.status === 'deferred') return true
      }
    }
    return false
  }

  undeferGroup (group) {
    let earliest = null
    for (const set of group.cells.values()) {
      for (const t of set) {
        if (t.status === 'deferred') {
          if (!earliest || (t.deferredUntil || 0) < (earliest.deferredUntil || 0)) earliest = t
        }
      }
    }
    if (earliest) {
      earliest.deferredUntil = 0
      earliest.status = 'pending'
      return true
    }
    return false
  }

  peekUpcoming (botPosition, limit = 3) {
    if (!botPosition) return []
    const out = []
    const now = Date.now()
    for (const order of this.orders) {
      if (out.length >= limit) break
      if (this.phaseBlocked(order)) continue
      const group = this.orderGroups.get(order)
      if (!group || group.remaining <= 0) continue
      if (group.seqList) {
        for (let i = group.seqPtr || 0; i < group.seqList.length && out.length < limit; i++) {
          const t = group.seqList[i]
          if (!this.usable(t, now) || this.hasDirectlyUnfinishedBelow(t)) continue
          if (this.fleet && t.owner !== this.fleet.index && group.isSingleWorkerChain) continue
          out.push(t)
        }
      } else {
        for (const set of group.cells.values()) {
          for (const t of set) {
            if (out.length >= limit) break
            if (!this.usable(t, now) || this.hasDirectlyUnfinishedBelow(t)) continue
            out.push(t)
          }
          if (out.length >= limit) break
        }
      }
    }
    return out
  }

  next (botPosition) {
    this.syncFleet()
    const now = Date.now()
    let minOpenLayer = null
    let minDeferredGroup = null
    let sawUnreadyOnMinLayer = false
    for (const order of this.orders) {
      const group = this.orderGroups.get(order)
      if (!group || group.remaining <= 0) continue
      if (order >= 88000 && this.phaseBlocked(order)) continue
      const layer = order < 88000 ? Math.floor(order / 4) : 9999
      const hasUsable = this.groupHasUsableNow(group, now)
      const isRetriedStragglerGroup = hasUsable && layer < 9999 && (
        (group.remaining <= 2 && !this.groupHasUnfinishedBelowMaxAttempts(group, 2)) ||
        (group.remaining <= 4 && (!this.groupHasUnfinishedBelowMaxAttempts(group, 1) || this.hasHigherLayerProgress(layer, 20)))
      )
      if (minOpenLayer === null && layer < 9999 && hasUsable && !isRetriedStragglerGroup) {
        minOpenLayer = layer
      }
      if (!minDeferredGroup && this.hasDeferredInGroup(group)) {
        minDeferredGroup = group
      }
      const needColumnGuard = minOpenLayer !== null && layer > minOpenLayer
      if (sawUnreadyOnMinLayer && minOpenLayer !== null && order >= minOpenLayer * 4 + 2) {
        return null
      }
      if (needColumnGuard && (layer > minOpenLayer + 1 || order >= (minOpenLayer + 1) * 4 + 2 || this.hasPendingFluids(minOpenLayer) || (minOpenLayer >= 4 && !group.isVerticalWallBand && this.layerRemainingCount(minOpenLayer) > 12))) {
        return null
      }
      this.enforceColumnGuard = needColumnGuard
      let ready
      try {
        ready = this.searchGroup(group, botPosition, true)
      } finally {
        this.enforceColumnGuard = false
      }
      if (ready && (!isRetriedStragglerGroup || !botPosition || ready.world.distanceTo(botPosition) <= 12)) return this.take(ready)
      if (hasUsable && !isRetriedStragglerGroup) {
        if (group.isVerticalWallBand && this.groupHasOpenBlock(group)) {
          return null
        }
        const isInitialSeedWavefront = order === minOpenLayer * 4 && group.remaining > 6 && !this.sawBusy
        if (isInitialSeedWavefront && this.groupHasAnyReady(group, now)) {
          return null
        }
        this.enforceColumnGuard = needColumnGuard
        let hasCand
        try {
          hasCand = Boolean(this.searchGroup(group, botPosition, false))
        } finally {
          this.enforceColumnGuard = false
        }
        if (hasCand && !needColumnGuard) {
          const isOtherWorkerChain = Boolean(this.fleet && group.isSingleWorkerChain && group.chainOwner !== this.fleet.index)
          if (order < minOpenLayer * 4 + 2 && !isOtherWorkerChain) {
            sawUnreadyOnMinLayer = true
            continue
          }
          if (!isOtherWorkerChain) return null
        }
      }
    }
    if (sawUnreadyOnMinLayer) return null
    if (minDeferredGroup && this.undeferGroup(minDeferredGroup)) {
      const woken = this.searchGroup(minDeferredGroup, botPosition, true)
      if (woken) return this.take(woken)
    }
    return null
  }

  layerRemainingCount (layer) {
    let rem = 0
    for (const [order, g] of this.orderGroups.entries()) {
      if (order >= 80000) continue
      if (Math.floor(order / 4) !== layer) continue
      if (g && g.remaining > 0) rem += g.remaining
    }
    return rem
  }

  hasHigherLayerProgress (layer, minCompleted = 20) {
    let doneHigher = 0
    for (const key of this.completed) {
      const t = this.tasks.get(key)
      if (t && t.layer > layer && t.order < 88000) {
        if (++doneHigher >= minCompleted) return true
      }
    }
    return false
  }

  hasPendingFluids (layer) {
    for (const [order, g] of this.orderGroups.entries()) {
      if (order >= 80000) continue
      if (Math.floor(order / 4) !== layer) continue
      if (g && g.remaining > 0) {
        for (const cellSet of g.cells.values()) {
          for (const t of cellSet) {
            if ((t.kind === 'fluid' || t.kind === 'waterlog') && t.status !== 'completed' && t.status !== 'blocked') {
              if (t.kind === 'waterlog') {
                const parent = this.tasks.get(t.parentKey)
                if (!parent || parent.status !== 'completed') continue
              }
              return true
            }
          }
        }
      }
    }
    return false
  }

  lookAhead (currentOrder, botPosition) {
    const window = Number(this.config.fleet?.lookAheadOrders ?? 8)
    if (!window) return null
    const currentLayer = Math.floor(currentOrder / 4)
    const hasFluids = this.hasPendingFluids(currentLayer)
    this.lookaheadMode = true
    try {
      for (const order of this.orders) {
        if (order <= currentOrder) continue
        if (order > currentOrder + window) break
        const taskLayer = Math.floor(order / 4)
        if (taskLayer > currentLayer) break
        if (taskLayer > currentLayer && hasFluids) break
        const group = this.orderGroups.get(order)
        if (!group || group.remaining <= 0) continue
        const t = this.searchGroup(group, botPosition, true)
        if (t) return this.take(t)
      }
    } finally { this.lookaheadMode = false }
    return null
  }

  lookOk (task) {
    if (task.kind !== 'block' || task.order >= 88000 || task.info?.fragile || task.name === 'observer' || /^(lantern|soul_lantern)$/.test(task.name)) return false
    if (this?.hasUnfinishedBelow?.(task)) return false
    return true
  }

  nextCandidate (botPosition) {
    this.syncFleet()
    const now = Date.now()
    let minOpenLayer = null
    let minDeferredGroup = null
    for (const order of this.orders) {
      const group = this.orderGroups.get(order)
      if (!group || group.remaining <= 0) continue
      if (order >= 88000 && this.phaseBlocked(order)) continue
      const layer = order < 88000 ? Math.floor(order / 4) : 9999
      const hasUsable = this.groupHasUsableNow(group, now)
      const isRetriedStragglerGroup = this.isRetriedStragglerGroup(group, layer, now)
      if (isRetriedStragglerGroup) {
        const straggler = this.searchGroup(group, botPosition, false)
        if (straggler && (!botPosition || straggler.world.distanceTo(botPosition) <= 12)) {
          return this.take(straggler)
        }
        continue
      }
      if (minOpenLayer === null && layer < 9999 && hasUsable) minOpenLayer = layer
      if (!minDeferredGroup && this.hasDeferredInGroup(group)) minDeferredGroup = group
      const needColumnGuard = minOpenLayer !== null && layer > minOpenLayer
      if (needColumnGuard && this.hasPendingFluids(minOpenLayer)) break
      const activeWavefront = this.hasActiveWavefrontInGroup(group, now)
      if (this.fleet && (this.groupHasAnyReady(group, now) || activeWavefront)) {
        this.enforceColumnGuard = needColumnGuard
        let readyTask = null
        try {
          readyTask = this.searchGroup(group, botPosition, true)
        } finally {
          this.enforceColumnGuard = false
        }
        if (readyTask) return this.take(readyTask)
        if (activeWavefront && !this.groupHasOwnBridgeSeedReady(group, now)) return null
      }
      this.enforceColumnGuard = needColumnGuard
      let task
      try {
        this.skipPending = true
        try { task = this.searchGroup(group, botPosition, false) } finally { this.skipPending = false }
        if (task) return this.take(task)
        task = this.searchGroup(group, botPosition, false)
        if (task) return this.take(task)
      } finally {
        this.enforceColumnGuard = false
      }
      if (this.fleet && this.sawBusy && group.remaining <= 4) return null
      if (!needColumnGuard && this.groupHasUnfinishedBelowMaxAttempts(group, 3)) {
        if (this.hasDeferredInGroup(group) && this.undeferGroup(group)) {
          const woken = this.searchGroup(group, botPosition, false)
          if (woken) return this.take(woken)
        }
        return null
      }
    }
    if (minDeferredGroup && this.undeferGroup(minDeferredGroup)) {
      const woken = this.searchGroup(minDeferredGroup, botPosition, false)
      if (woken) return this.take(woken)
    }
    return null
  }

  nextAny (botPosition) {
    this.syncFleet()
    const now = Date.now()
    let best = null; let bestScore = Infinity
    let bestFallback = null; let bestFallbackScore = Infinity
    const counts = {}
    let minOpenLayer = Infinity
    let minStrictOrder = Infinity
    for (const order of this.orders) {
      const g = this.orderGroups.get(order)
      if (!g || g.remaining <= 0) continue
      const l = order < 88000 ? Math.floor(order / 4) : 9999
      const isStragglerGrp = this.isRetriedStragglerGroup(g, l, now)
      if (order < 88000 && this.groupHasUsableNow(g, now) && !isStragglerGrp) {
        if (l < minOpenLayer) minOpenLayer = l
        if (!Number.isFinite(minStrictOrder) && this.groupHasUnfinishedBelowMaxAttempts(g, 2)) {
          minStrictOrder = order
        }
      }
      if (Number.isFinite(minOpenLayer) && Number.isFinite(minStrictOrder)) break
    }
    const pendingFluidsOnMin = Number.isFinite(minOpenLayer) ? this.hasPendingFluids(minOpenLayer) : false
    let groupsChecked = 0
    for (const order of this.orders) {
      if (Number.isFinite(minStrictOrder) && order > minStrictOrder && (best || bestFallback)) break
      if (order >= 88000 && this.phaseBlocked(order)) continue
      const g = this.orderGroups.get(order)
      if (!g || g.remaining <= 0) continue
      const layer = order < 88000 ? Math.floor(order / 4) : 9999
      if (Number.isFinite(minOpenLayer) && order < 88000 && layer > minOpenLayer && pendingFluidsOnMin) continue
      const activeWf = this.hasActiveWavefrontInGroup(g, now)
      let sawInGroup = false
      for (const set of g.cells.values()) {
        for (const t of set) {
          if (t.status === "completed") continue
          if (this.isCorrect(t)) { this.markCompleted(t); continue }
          const k = `${t.status}${this.fleet ? "/own" + (t.owner === this.fleet.index ? "1" : "0") : ""}`
          counts[k] = (counts[k] || 0) + 1
          if (t.status === "blocked" || this.quarantined?.has(t.key)) continue
          if (this.fleet && this.fleet.coord.busyFor(this.fleet.id, t, true)) continue
          if ((t.kind === "fluid" || t.kind === "waterlog" || t.info?.fragile || t.name === "hopper") && (!this.isReady(t) || this.refPending(t))) continue
          if (this.hasDirectlyUnfinishedBelow(t)) continue
          if (activeWf && !this.isReady(t) && this.refPending(t)) continue
          if (Number.isFinite(minOpenLayer) && t.order < 88000 && t.layer > minOpenLayer && !t.isolatedColumn && !t.verticalColumn && this.hasUnfinishedBelow(t)) continue
          const readyNow = this.isReady(t)
          const otherFailed = Boolean(this.fleet && t.owner !== this.fleet.index && (t.status === "failed" || (t.attempts || 0) >= 1))
          const s = t.order * 200 + (readyNow ? -5000 : 0) + (otherFailed ? 400 : 0) + this.priority(t, botPosition)
          if (s < bestFallbackScore) { bestFallbackScore = s; bestFallback = t }
          if ((t.attempts || 0) >= 2 && this.remainingCount() > 25) continue
          if (otherFailed) continue
          sawInGroup = true
          if ((t.anyUntil || 0) > now) continue
          if (s < bestScore) { bestScore = s; best = t }
        }
      }
      if (sawInGroup && ++groupsChecked >= 2) break
    }
    if (!best && bestFallback) best = bestFallback
    this.lastAnyCounts = counts
    if (best) {
      best.deferredUntil = 0; if (best.status === "deferred") best.status = "pending"
      best.anyTries = (best.anyTries || 0) + 1
      best.anyUntil = now + Math.min(1_200, 300 * Math.min(4, best.anyTries))
    }
    return best ? this.take(best) : null
  }

  markCompleted (task) {
    if (task.status === 'completed') return
    task.deferredUntil = 0
    task.lastError = null
    this.setStatus(task, 'completed')
    this.ready.delete(task.key)
    this.blocked.delete(task.key)
    this.quarantined?.delete(task.key)
    if (this.fleet) this.fleet.coord.complete(task.key, this.fleet.id)
  }

  markFailure (task, error, { permanent = false } = {}) {
    task.lastError = String(error?.message || error)
    // Fluid containment / TNT safety wait (`UNSAFE`), travel/approach delays (`TRAVEL_TIMEOUT`), and temporary entity/bot collision (`entityObstruction`) are transit/environmental waits, NOT placement failures — defer without burning attempts toward quarantine!
    if ((error?.code === 'UNSAFE' || error?.code === 'TRAVEL_TIMEOUT' || error?.isTravel || error?.entityObstruction || /is busy with another worker/i.test(task.lastError)) && !permanent) {
      task.status = 'deferred'
      task.deferredUntil = Date.now() + (error?.code === 'UNSAFE' ? 2_500 : 1_500)
      return
    }
    task.attempts += 1
    task.totalAttempts = (task.totalAttempts || 0) + 1
    if (permanent) {
      this.setStatus(task, 'blocked')
      this.blocked.add(task.key)
      return
    }
    const isHardNoAccess = error?.code === 'NO_ACCESS' || error?.code === 'DIG_REJECTED' || error?.code === 'DIG_PROTECTED'
    const isFoundationLayer = (task.layer != null && task.layer <= 1) || task.order <= 12
    const giveUp = isHardNoAccess
      ? 2
      : (isFoundationLayer
          ? Math.min(6, Math.max(5, Number(this.config.building.giveUpAttempts || 6)))
          : (this.remainingCount() > 35 ? 3 : Math.min(6, Math.max(4, Number(this.config.building.giveUpAttempts || 6)))))
    if (task.attempts === 3 && task.totalAttempts === 3) {
      task.forceSupport = true
      task.hintFailed = true
      if (this.fleet && this.fleet.count > 1) {
        const nextOwner = ((task.owner ?? this.fleet.index) + 1) % this.fleet.count
        task.owner = nextOwner
        this.fleet.coord.reopen?.(task.key, this.fleet.id, nextOwner)
        this.logger?.info?.(`QUARANTINE-HANDOFF: ${task.name}@${task.key} failed 3x; handing off to worker #${nextOwner + 1} with extra support enabled`)
      }
    }
    if (task.attempts >= giveUp || (task.totalAttempts || 0) >= giveUp) {
      this.setStatus(task, 'blocked')
      this.blocked.add(task.key)
      if (!this.quarantined) this.quarantined = new Set()
      this.quarantined.add(task.key)
      task._quarantineMask = this.neighborSolidMask(task.world)
      if (this.fleet) this.fleet.coord.quarantine?.(task.key, this.fleet.id)
      this.logger?.warn?.(`QUARANTINE: ${task.name}@${task.key} quarantined after ${task.totalAttempts || task.attempts} attempts (${task.lastError}); queued for end-of-build verify-and-repair pass`)
      return
    }
    if (task.attempts >= 2) {
      const isEndgame = this.remainingCount() <= 20
      const backoffMs = isEndgame
        ? 500
        : (task.attempts === 3 && task.totalAttempts === 3 && this.fleet && this.fleet.count > 1
            ? 800
            : Math.min(2_000, 750 * (2 ** Math.min(2, task.attempts - 2))))
      task.status = 'deferred'
      task.deferredUntil = Date.now() + backoffMs
      if (task.kind === 'block' && task.info?.waterlogged) {
        const wl = this.tasks.get(`${task.key}#w`)
        if (wl && wl.status !== 'completed' && wl.status !== 'blocked') {
          wl.status = 'deferred'
          wl.deferredUntil = task.deferredUntil
        }
      }
    } else {
      task.status = 'failed'
      task.deferredUntil = 0
    }
  }

  neighborSolidMask (pos) {
    if (!pos || !this.world?.blockAt) return 0
    let m = 0
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],[0,2,0]]) {
      const b = this.world.blockAt({ x: pos.x + dx, y: pos.y + dy, z: pos.z + dz })
      m = (m << 1) | (b && b.boundingBox === 'block' ? 1 : 0)
    }
    return m
  }

  revive ({ includeQuarantined = false } = {}) {
    let n = 0
    const isEndgame = this.remainingCount() <= 25
    for (const t of this.tasks.values()) {
      if (t.status === 'completed') continue
      if (this.quarantined?.has(t.key)) {
        if (!includeQuarantined) continue
        if (!isEndgame && !includeQuarantined && t._quarantineMask !== undefined && this.neighborSolidMask(t.world) === t._quarantineMask) continue
      }
      if (t.status === 'blocked' || t.status === 'deferred' || t.status === 'failed' || (t.anyUntil || 0) > 0) {
        if (t.status === 'blocked') this.blocked.delete(t.key)
        this.quarantined?.delete(t.key)
        this.setStatus(t, 'pending')
        t.deferredUntil = 0
        t.anyUntil = 0
        t.anyTries = 0
        t.attempts = includeQuarantined ? 0 : Math.min(t.attempts, 2)
        n++
      }
    }
    return n
  }

  deferNear (task, radius = 3, ms = 1_500, forceFar = false) {
    if (this.remainingCount() <= 35) return 0
    const now = Date.now()
    if (!forceFar && now - (this.lastClusterDefer || 0) < 4000) return 0
    ms = Math.min(ms, forceFar ? 8_000 : 2_500)
    this.lastClusterDefer = now
    let n = 0
    const r2 = radius * radius
    const candidates = this.tasksNear(task.world, radius + 2)
    for (const t of candidates) {
      if (t === task || t.status === "completed" || t.status === "blocked" || t.status === "deferred") continue
      if (Math.abs(t.world.y - task.world.y) > 2 || Math.abs(t.order - task.order) > 4) continue
      const dx = t.world.x - task.world.x; const dz = t.world.z - task.world.z
      if (dx * dx + dz * dz > r2) continue
      t.status = "deferred"; t.deferredUntil = now + ms; n++
    }
    return n
  }

  substituteItem (fromItem, toBlock) {
    const info = describeBlock(toBlock, {})
    if (!info || info.kind === 'unsupported' || info.kind === 'air') return 0
    let n = 0
    for (const t of this.tasks.values()) {
      if (t.item !== fromItem || t.kind !== 'block' || t.status === 'completed' || t.status === 'blocked') continue
      t.accept = [...new Set([...(t.accept || []), t.name])]
      t.name = toBlock; t.properties = {}; t.info = info; t.item = info.item
      t.status = 'pending'; t.deferredUntil = 0; t.attempts = 0; t.lastError = null
      n++
    }
    if (n) {
      this.materialDemand.set(fromItem, Math.max(0, (this.materialDemand.get(fromItem) || 0) - n))
      this.materialDemand.set(info.item, (this.materialDemand.get(info.item) || 0) + n)
      this.recomputeReady()
    }
    return n
  }

  rescanTask (task) {
    if (this.isCorrect(task)) { this.markCompleted(task); return true }
    return false
  }

  remainingCount () { return Math.max(0, this.total - this.completed.size - this.blocked.size) }

  getMaterialDemand () { return new Map(this.materialDemand) }

  getStats (full = false) {
    this.syncFleet()
    const completed = this.completed.size
    const current = this.orders.find(o => (this.orderGroups.get(o)?.remaining || 0) > 0)
    let failed = 0; let deferred = 0
    if (full) {
      for (const t of this.tasks.values()) { if (t.status === "failed") failed++; else if (t.status === "deferred") deferred++ }
    } else if (current !== undefined) {
      const cg = this.orderGroups.get(current)
      if (cg) {
        for (const set of cg.cells.values()) {
          for (const t of set) { if (t.status === "failed") failed++; else if (t.status === "deferred") deferred++ }
        }
      }
    }
    return {
      total: this.total,
      completed,
      remaining: this.remainingCount(),
      ready: current !== undefined ? (this.orderGroups.get(current)?.remaining || 0) : 0,
      blocked: this.blocked.size,
      failed,
      deferred,
      doneAtStart: this.doneAtStart,
      currentOrder: current ?? null,
      currentLayer: current !== undefined ? Math.floor(current / 4) : null
    }
  }

  serialize () {
    const out = []
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending' || task.attempts > 0 || task.specTag) {
        out.push({ key: task.key, status: task.status, attempts: task.attempts, lastError: task.lastError, specTag: task.specTag })
      }
    }
    return out
  }

  restore (entries = [], opts = {}) {
    for (const saved of entries) {
      const task = this.tasks.get(saved.key)
      if (!task) continue
      task.attempts = saved.attempts || 0
      task.lastError = saved.lastError || null
      task.specTag = saved.specTag || null
      if (saved.status === 'completed' && (opts.trustSaved || !this.world?.blockAt?.(task.world) || this.isCorrect(task))) this.setStatus(task, 'completed')
      else if (saved.status === 'blocked') { this.setStatus(task, 'blocked'); this.blocked.add(task.key) }
    }
    this.reconcileWorld()
    this.recomputeReady()
  }

  fastForwardBelowLayer (startLayer) {
    const minL = Number(startLayer)
    if (!Number.isFinite(minL) || minL <= 0) return 0
    let count = 0
    for (const task of this.tasks.values()) {
      if (task.layer < minL && task.status !== 'completed') {
        this.setStatus(task, 'completed')
        this.ready.delete(task.key)
        this.blocked.delete(task.key)
        count++
      }
    }
    this.doneAtStart = this.completed.size
    this.recomputeReady()
    return count
  }

  detectResumeLayer () {
    const byLayer = new Map()
    let maxLayer = -1
    for (const task of this.tasks.values()) {
      if (task.kind !== 'block') continue
      const l = task.layer
      if (l > maxLayer) maxLayer = l
      let st = byLayer.get(l)
      if (!st) { st = { total: 0, loaded: 0, done: 0 }; byLayer.set(l, st) }
      st.total++
      const b = this.world?.blockAt?.(task.world)
      if (b) st.loaded++
      if (task.status === 'completed' || (b && taskMatches(b, task))) st.done++
    }
    let resumeLayer = 0
    for (let l = 0; l <= maxLayer; l++) {
      const st = byLayer.get(l)
      if (!st || st.total === 0) continue
      const denom = st.loaded > 0 ? st.loaded : st.total
      const ratio = st.done / denom
      let higherHasBuilt = false
      for (let h = l + 1; h <= maxLayer; h++) {
        const hst = byLayer.get(h)
        if (hst && hst.done >= Math.min(8, Math.max(1, Math.floor(hst.total * 0.5)))) {
          higherHasBuilt = true
          break
        }
      }
      if (ratio >= 0.85 && (ratio >= 0.98 || higherHasBuilt)) {
        resumeLayer = l + 1
      } else {
        break
      }
    }
    return resumeLayer
  }
}

module.exports = { BuildPlanner, rotateProperties, keyOf }
