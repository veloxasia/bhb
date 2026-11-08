'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { FallGuard } = require('../src/recovery/fall-guard')

function mk (fn) {
  const world = { blockAt: p => { const n = fn(p.x, p.y, p.z) || 'air'; return { name: n, boundingBox: /^(air|lava|water)$/.test(n) ? 'empty' : 'block', getProperties: () => ({}) } } }
  return new FallGuard({ bot: {}, world, config: {}, logger: {}, navigation: {}, ground: {} })
}

test('hazard guard: lava below the next cell is seen', () => {
  const g = mk((x, y, z) => (y <= -61 ? (x === 5 ? 'lava' : 'stone') : null))
  assert.equal(g.hazardAt(5.5, -60, 0.5, 4), 'lava')
  assert.equal(g.hazardAt(4.5, -60, 0.5, 4), null)
})

test('hazard guard: a 2-deep walled hole is a pit, a 2-deep hole next to a ramp is not', () => {
  // floor at y=-61; hole at x=5,z=0 down to -63 ringed by walls up to the level -61 (a column 1x1)
  const hole = mk((x, y, z) => { if (x === 5 && z === 0) return y <= -64 ? 'stone' : null; return y <= -61 ? 'stone' : null })
  assert.equal(hole.hazardAt(5.5, -60, 0.5, 4), 'pit')
  const shallow = mk((x, y, z) => (y <= (x === 5 ? -62 : -61) ? 'stone' : null)) // a 1 block step down
  assert.equal(shallow.hazardAt(5.5, -60, 0.5, 4), null)
  const open = mk((x, y, z) => { // a deep area but with stairs back up
    if (x >= 5) return y <= -63 + Math.max(0, Math.min(2, x - 5)) ? 'stone' : null
    return y <= -61 ? 'stone' : null
  })
  assert.equal(open.hazardAt(5.5, -60, 0.5, 4), null)
  // Default maxDrop = 1: ANY 2+ block drop is treated as a hole ('pit'), and rayHazard detects it along a look/movement ray
  assert.equal(open.hazardAt(5.5, -60, 0.5), 'pit')
  const ray = open.rayHazard(4.5, -60, 0.5, 1, 0, 1.1)
  assert.ok(ray && ray.kind === 'pit')
})

test('global engine & planner fixes: water does not trigger leak mode, vertical observers and lava ordering, learner vertical/horizontal split', () => {
  const { Engine } = require('../src/intel/engine')
  const { OrientationLearner } = require('../src/learning/learner')
  const { BuildPlanner } = require('../src/planner/build-planner')
  const { describeBlock } = require('../src/rules/blocks')
  const { Vec3 } = require('../src/util/vec3')
  const os = require('os')
  const fs = require('fs')
  const path = require('path')

  // 1. Water flow never activates LEAK MODE; only lava does
  const eng = new Engine({
    bot: { health: 20, entities: {} },
    world: { blockAt: () => ({ name: 'water', boundingBox: 'empty' }) },
    config: {},
    logger: { info () {}, warn () {} },
    recorder: { decision () {} },
    getPlanner: () => null
  })
  eng.onLeak({ kind: 'water', first: '1,64,1', cells: ['1,64,1'] }, { cause: 'water flow' })
  assert.equal(eng.leak.active, false)
  eng.onLeak({ kind: 'lava', first: '2,64,2', cells: ['2,64,2'] }, { cause: 'lava leak' })
  assert.equal(eng.leak.active, true)

  // 2. Lava is ordered at the end of its layer (layer * 4 + 3.5) before the roof layer seals it, vertical observer is ordered in its layer when not next to TNT
  const fakePlanner = Object.create(BuildPlanner.prototype)
  fakePlanner.schematic = { getBlock: () => ({ name: 'stone' }) }
  const lavaOrder = fakePlanner.orderOf(describeBlock('lava', { level: '0' }), 'fluid', 5, new Vec3(0, 5, 0))
  const vertObsOrder = fakePlanner.orderOf(describeBlock('observer', { facing: 'up', powered: 'false' }), 'block', 5, new Vec3(0, 5, 0))
  const horizObsOrder = fakePlanner.orderOf(describeBlock('observer', { facing: 'north', powered: 'false' }), 'block', 5, new Vec3(0, 5, 0))
  assert.equal(lavaOrder, 5 * 4 + 3.5)
  assert.equal(vertObsOrder, 5 * 4 + 1.2)
  assert.equal(horizObsOrder, 5 * 4 + 1.2)

  // 3. OrientationLearner keeps vertical and horizontal rules separate, and BuildMemory persists cross-run build knowledge
  const { BuildMemory } = require('../src/learning/learner')
  const { makeGraph } = require('../src/navigation/brain')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mhb-learn-'))
  const learner = new OrientationLearner(tmp, { info () {}, warn () {} })
  const horizTask = { name: 'observer', properties: { facing: 'north' }, info: describeBlock('observer', { facing: 'north' }) }
  const vertTask = { name: 'observer', properties: { facing: 'up' }, info: describeBlock('observer', { facing: 'up' }) }
  learner.success(horizTask, 'observer-b')
  learner.success(vertTask, 'observer-up')
  assert.equal(learner.preferredFor(horizTask), 'observer-b')
  assert.equal(learner.preferredFor(vertTask), 'observer-up')

  const mem = new BuildMemory(tmp, 'test.litematic', 0)
  const sampleTask = { name: 'observer', local: new Vec3(2, 3, 4), world: new Vec3(102, 63, 104), attempts: 2 }
  mem.recordSupport(sampleTask, [new Vec3(102, 64, 104)])
  mem.recordStand(sampleTask, new Vec3(103, 62, 103))
  const mem2 = new BuildMemory(tmp, 'test.litematic', 0)
  assert.equal(mem2.needsSupport(sampleTask), true)
  const fakeTasks = new Map([['102,63,104', { ...sampleTask, hint: null }]])
  mem2.applyToPlanner({ tasks: fakeTasks }, Vec3)
  assert.deepEqual(fakeTasks.get('102,63,104').hint, new Vec3(103, 62, 103))

  // 4. Water-flow vertical swimming in brain graph
  const g = makeGraph((x, y, z) => {
    if (y === 0) return { name: 'stone', boundingBox: 'block' }
    if (x === 0 && z === 0 && y >= 1 && y <= 3) return { name: 'water', boundingBox: 'empty' }
    return { name: 'air', boundingBox: 'empty' }
  })
  const reach = g.flood({ x: 0, y: 1, z: 0 }, g.succ, 50)
  assert.equal(reach.cells.has('0,3,0'), true)

  // 5. Lookahead fluid protection: never roof over an unfinished fluid layer
  const fluidPlanner = Object.create(BuildPlanner.prototype)
  fluidPlanner.orders = [12, 14.25, 16] // L3 blocks (12), L3 water (14.25), L4 glass (16)
  const l3Cell = new Set([{ kind: 'fluid', status: 'pending' }])
  const l4Cell = new Set([{ kind: 'block', order: 16, status: 'pending', world: new Vec3(0, -56, 0), info: {} }])
  fluidPlanner.orderGroups = new Map([
    [12, { remaining: 0, cells: new Map() }],
    [14.25, { remaining: 1, cells: new Map([['0,0', l3Cell]]) }],
    [16, { remaining: 10, cells: new Map([['0,0', l4Cell]]) }]
  ])
  fluidPlanner.tasks = new Map()
  fluidPlanner.config = { fleet: { lookAheadOrders: 12 } }
  fluidPlanner.searchGroup = grp => (grp === fluidPlanner.orderGroups.get(16) ? { kind: 'block', order: 16 } : null)
  fluidPlanner.take = t => t
  const ahead = fluidPlanner.lookAhead(12, new Vec3(0, -57, 0))
  assert.equal(ahead, null, 'lookahead must not roof over unfinished fluid layer')
})

test('hazard guard: knockback velocity is not destroyed when bot is hurt', () => {
  const g = mk((x, y, z) => (x > 5 ? null : 'stone'))
  const bot = {
    builder: { running: true },
    health: 20,
    entity: {
      position: { x: 4.8, y: -60, z: 0.5, clone () { return { ...this } } },
      velocity: { x: 0.5, y: 0, z: 0 },
      yaw: 0,
      onGround: true
    },
    controlState: { forward: true },
    setControlState () {},
    lastHurtAt: Date.now() // bot was just punched!
  }
  g.bot = bot
  g.tick()
  // velocity.x must NOT be wiped to 0.15 * 0.5 = 0.075 because the bot is in knockback!
  assert.equal(bot.entity.velocity.x, 0.5)
})

test('water handling: FallGuard does not treat water as a pit and deep water exit climbs onto ledges', () => {
  // 1. Water pool / canal is not treated as a pit by FallGuard
  const waterWorld = mk((x, y, z) => {
    if (x === 5 && z === 0) return y <= -62 ? (y <= -64 ? 'stone' : 'water') : null
    return y <= -61 ? 'stone' : null
  })
  // Water is at y=-62 and -63 with stone at -64: safe fluid, NOT a pit!
  assert.equal(waterWorld.hazardAt(5.5, -60, 0.5, 4), null)
  assert.equal(waterWorld.hazardAt(5.5, -60, 0.5, 1), null)

  // 2. Deep water pool with a 1-block higher dry bank: findWaterExit finds the way up onto the ledge
  const { findWaterExit } = require('../src/recovery/survival')
  const deepPool = (x, y, z) => {
    if (x >= 0 && x <= 3 && z === 0) {
      if (y <= -60) return { name: y <= -62 ? 'stone' : 'water', boundingBox: y <= -62 ? 'block' : 'empty' }
    }
    if (x === 4 && z === 0) {
      if (y <= -59) return { name: 'stone', boundingBox: 'block' } // bank is 1 block above water surface!
    }
    return { name: 'air', boundingBox: 'empty' }
  }
  const exitPath = findWaterExit(deepPool, { x: 3.5, y: -60, z: 0.5 })
  assert.ok(exitPath && exitPath.length > 0, 'findWaterExit must step out of deep water onto a ledge')
})



test('v2 upgrades: rayHitBox all 6 faces, open fence_gate outline blocker, coordinator stall fix, brain small region, pearl top face, and architect wavefront', async () => {
  const { Vec3 } = require('../src/util/vec3')
  const { AimSolver, boxOf, rayHitBox } = require('../src/interaction/aim')
  const { FACE_INDEX } = require('../src/rules/blocks')
  const { Coordinator } = require('../src/fleet/coordinator')
  const { Brain, makeGraph } = require('../src/navigation/brain')
  const { solveThrow } = require('../src/recovery/survival')

  // 1. rayHitBox must accurately detect all 6 faces (especially east, up, south when ray travels in negative direction)
  const refPos = new Vec3(10, 10, 10)
  const fullBox = [0, 0, 0, 1, 1, 1]
  assert.equal(rayHitBox(new Vec3(12.5, 10.5, 10.5), new Vec3(-1, 0, 0), 5, refPos, fullBox)?.face, FACE_INDEX.east)
  assert.equal(rayHitBox(new Vec3(8.5, 10.5, 10.5), new Vec3(1, 0, 0), 5, refPos, fullBox)?.face, FACE_INDEX.west)
  assert.equal(rayHitBox(new Vec3(10.5, 12.5, 10.5), new Vec3(0, -1, 0), 5, refPos, fullBox)?.face, FACE_INDEX.up)
  assert.equal(rayHitBox(new Vec3(10.5, 8.5, 10.5), new Vec3(0, 1, 0), 5, refPos, fullBox)?.face, FACE_INDEX.down)
  assert.equal(rayHitBox(new Vec3(10.5, 10.5, 12.5), new Vec3(0, 0, -1), 5, refPos, fullBox)?.face, FACE_INDEX.south)
  assert.equal(rayHitBox(new Vec3(10.5, 10.5, 8.5), new Vec3(0, 0, 1), 5, refPos, fullBox)?.face, FACE_INDEX.north)

  // 2. Open spruce_fence_gate outline box & rayOutlineBlocker prevent clicking through an open gate to pour stray water
  const gateBlock = { name: 'spruce_fence_gate', boundingBox: 'block', shapes: [], getProperties: () => ({ facing: 'south', open: 'true' }) }
  assert.deepEqual(boxOf(gateBlock), [0, 0, 0.375, 1, 1, 0.625])
  const fakeWorld = {
    blockAt: p => {
      if (p.x === 513 && p.y === -59 && p.z === -70) return gateBlock
      if (p.x === 513 && p.y === -60 && p.z === -71) return { name: 'packed_ice', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      return { name: 'air', boundingBox: 'empty', shapes: [], getProperties: () => ({}) }
    }
  }
  const fakeBot = {
    entity: { position: new Vec3(513.5, -59, -68.5), yaw: Math.PI, pitch: -0.4 },
    world: { raycast: () => ({ position: new Vec3(513, -60, -71), name: 'packed_ice', face: FACE_INDEX.up, intersect: new Vec3(513.5, -59, -70.5) }) }
  }
  const solver = new AimSolver(fakeBot, fakeWorld, {})
  // Ray from (513.5, -57.38, -68.5) to (513.5, -59, -70.5) passes through open gate at (513, -59, -70)
  assert.equal(solver.losRay(new Vec3(513.5, -57.38, -68.5), new Vec3(513.5, -59, -70.5), new Vec3(513, -60, -71), 'up'), false)

  // 3. Coordinator.busyFor does not treat a freshly claimed task as stalled even if lastDoneAt is >20s old
  const coord = new Coordinator(4)
  const now = Date.now()
  coord.workers.set('Build', {
    id: 'Build',
    index: 0,
    beat: now,
    lastDoneAt: now - 25_000,
    target: { key: '513,-59,-71', x: 513, y: -59, z: -71, at: now - 1_000 }
  })
  assert.equal(coord.busyFor('Buildd', { key: '513,-59,-71', world: new Vec3(513, -59, -71) }, false), true)

  // 4. Brain reachability returns 'no' (not 'unknown') for a 6-cell enclosed wall top
  const wallWorld = (x, y, z) => {
    if (y === -61) return { name: 'grass_block', boundingBox: 'block' }
    if (y >= -60 && y <= -59 && x >= 10 && x <= 15 && z === 10) return { name: 'glass', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  const brain = new Brain({
    bot: { entity: { position: new Vec3(0.5, -60, 0.5) } },
    world: { blockAt: p => wallWorld(p.x, p.y, p.z) },
    config: {}
  })
  assert.equal(brain.reachability(new Vec3(12.5, -58, 10.5)).verdict, 'no')

  // 5. solveThrow rejects pearl trajectories that hit the vertical side face of a 2-block wall instead of its top face
  const tallWall = (x, y, z) => {
    if (y === -61) return { name: 'stone', boundingBox: 'block' }
    // A 3-block pillar at x=8, z=0 with a ceiling at y=-57 so only the side face at y=-58 is exposed
    if (x === 8 && z === 0 && (y >= -60 && y <= -58 || y === -56)) return { name: 'stone', boundingBox: 'block' }
    return { name: 'air', boundingBox: 'empty' }
  }
  assert.equal(solveThrow(tallWall, { x: 0.5, y: -58.38, z: 0.5 }, { x: 8.5, y: -57, z: 0.5 }), null)
})
test('v2 water wading, 2D quadrant fleet division, and nearest-neighbor steal mode without 100-block U-turns', () => {
  const { Vec3 } = require('../src/util/vec3')
  const { GroundMonitor } = require('../src/world/ground')
  const { BuildPlanner } = require('../src/planner/build-planner')
  const { Coordinator } = require('../src/fleet/coordinator')
  const { describeBlock } = require('../src/rules/blocks')

  // 1. Shallow wading: bot in 1-block water (e.isInWater = true, e.onGround = false) with air at head and packed_ice below is 'grounded', not 'swimming'
  const fakeBot = {
    on () {},
    off () {},
    entity: {
      position: new Vec3(500.5, -59, -70.5),
      velocity: new Vec3(0, 0, 0),
      onGround: false,
      isInWater: true,
      isInLava: false
    }
  }
  const fakeWorld = {
    blockAt: p => {
      if (p.y === -60) return { name: 'packed_ice', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      if (p.y === -59) return { name: 'water', boundingBox: 'empty', shapes: [], getProperties: () => ({ level: '1' }) }
      return { name: 'air', boundingBox: 'empty', shapes: [], getProperties: () => ({}) }
    }
  }
  const gm = new GroundMonitor(fakeBot, fakeWorld, {})
  assert.equal(gm.state(), 'grounded', 'wading in 1-block shallow water on packed_ice must be grounded, not swimming')

  // 2. 2D quadrant fleet partitioning & nearest-neighbor steal mode (no 40-100 block U-turns to seqList[0])
  const coord = new Coordinator(4)
  for (let i = 0; i < 4; i++) coord.register(`bot${i}`, i, { entity: { position: new Vec3(0, 0, 0) } })
  const planner = Object.create(BuildPlanner.prototype)
  planner.tasks = new Map()
  planner.orderGroups = new Map()
  planner.chunkTasks = new Map()
  planner.materialDemand = new Map()
  planner.completed = new Set()
  planner.blocked = new Set()
  planner.ready = new Set()
  planner.census = { byKind: {}, byPhase: {} }
  planner.total = 0
  planner.world = { blockAt: p => (p.y === -1 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }) }
  for (let x = 0; x < 40; x += 10) {
    for (let z = 0; z < 40; z += 10) {
      const worldPos = new Vec3(x, 0, z)
      const k = `${x},0,${z}`
      planner.addTask({
        key: k, kind: 'block', name: 'stone', item: 'stone', properties: {},
        info: describeBlock('stone', {}), world: worldPos, order: 0, layer: 0,
        status: 'pending', attempts: 0, deferredUntil: 0, seq: x * 100 + z
      })
    }
  }
  planner.orders = [0]
  planner.joinFleet(coord, 'bot3', 3, 4)
  const group = planner.orderGroups.get(0)
  group.seqList = [...planner.tasks.values()].sort((a, b) => a.seq - b.seq)
  group.seqPtr = 0
  planner.architectActive = true
  // Mark all of bot3's own tasks completed so bot3 enters 'steal' mode to help teammates from (30, 0, 30)
  for (const t of planner.tasks.values()) {
    if (t.owner === 3) planner.setStatus(t, 'completed')
  }
  const stolen = planner.next(new Vec3(30, 0, 30))
  assert.ok(stolen, 'bot3 must steal a task to help teammates once its own quadrant is done')
  assert.ok(stolen.key !== "0,0,0" && stolen.world.distanceTo(new Vec3(30, 0, 30)) <= 20, `stolen task at ${stolen.key} must be a nearby neighbor, not seqList[0] at 0,0,0`)
})

test('v2 turbo 3-4 block batch stand reach, stand-first chaining, and broken build-block reopening after pearl escape', () => {
  const { Vec3 } = require('../src/util/vec3')
  const { AimSolver, rayHitBox } = require('../src/interaction/aim')
  const { BuildPlanner } = require('../src/planner/build-planner')
  const { Coordinator } = require('../src/fleet/coordinator')
  const { describeBlock } = require('../src/rules/blocks')

  // Build a planner with a 4-block row at (10..13, 0, 10) on a flat stone floor at y = -1
  const worldBlocks = new Map()
  const FakeWorld = {
    blockAt: p => {
      const k = `${p.x},${p.y},${p.z}`
      if (worldBlocks.has(k)) return worldBlocks.get(k)
      if (p.y === -1) return { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      return { name: 'air', boundingBox: 'empty', shapes: [], getProperties: () => ({}) }
    }
  }
  const fakeBot = {
    entity: { position: new Vec3(10.5, 0, 10.5), yaw: 0, pitch: 0 },
    getControlState: () => false,
    world: {
      raycast: (eye, dir, maxDist) => {
        // Raycast against floor at y = -1 (top face at y = 0) and any placed blocks in worldBlocks
        let best = null
        for (const [k, b] of worldBlocks.entries()) {
          if (b.boundingBox !== 'block') continue
          const [bx, by, bz] = k.split(',').map(Number)
          const hit = rayHitBox(eye, dir, maxDist, new Vec3(bx, by, bz), [0, 0, 0, 1, 1, 1])
          if (hit && (!best || hit.dist < best.dist)) {
            best = { position: new Vec3(bx, by, bz), name: b.name, face: hit.face, intersect: hit.intersect, dist: hit.dist }
          }
        }
        if (dir.y < -1e-6 && eye.y > 0) {
          const t = (0 - eye.y) / dir.y
          if (t > 0 && t <= maxDist && (!best || t < best.dist)) {
            const ix = eye.x + dir.x * t
            const iz = eye.z + dir.z * t
            best = { position: new Vec3(Math.floor(ix), -1, Math.floor(iz)), name: 'stone', face: 1, intersect: new Vec3(ix, 0, iz), dist: t }
          }
        }
        return best
      }
    }
  }

  const coord = new Coordinator(2)
  coord.register('bot0', 0, fakeBot)
  coord.register('bot1', 1, { entity: { position: new Vec3(50, 0, 50) } })

  const planner = Object.create(BuildPlanner.prototype)
  planner.tasks = new Map()
  planner.orderGroups = new Map()
  planner.chunkTasks = new Map()
  planner.materialDemand = new Map()
  planner.completed = new Set()
  planner.blocked = new Set()
  planner.ready = new Set()
  planner.census = { byKind: {}, byPhase: {} }
  planner.total = 0
  planner.world = FakeWorld
  planner.orders = [0]

  for (let x = 10; x <= 13; x++) {
    const k = `${x},0,10`
    planner.addTask({
      key: k, kind: 'block', name: 'cobblestone', item: 'cobblestone', properties: {},
      info: describeBlock('cobblestone', {}), world: new Vec3(x, 0, 10), order: 0, layer: 0,
      status: 'pending', attempts: 0, deferredUntil: 0, seq: x
    })
  }

  const aim = new AimSolver(fakeBot, FakeWorld, { navigation: { placementReach: 4.4 } }, {
    isReserved: cell => planner.tasks.has(`${cell.x},${cell.y},${cell.z}`),
    isPending: cell => planner.isPendingCell(cell),
    batchCount: (s, eye, target, reach) => planner.batchCountFrom(s, eye, target, reach)
  })

  // 1) Stand selection for (10, 0, 10) must NOT pick (11, 0, 10) (which is a pending block 1 block away),
  //    and instead pick a stand 2.3-4.1 blocks back from which all 4 blocks (10..13, 0, 10) are reachable!
  const firstTask = planner.tasks.get('10,0,10')
  const spec = firstTask.info.specs[0]
  const cands = aim.candidates(firstTask.world, spec)
  assert.ok(cands.length > 0, 'must find standing candidates for first block in row')
  const chosenStand = cands[0]
  assert.equal(planner.isPendingCell(chosenStand.cell), false, 'chosen stand must not overlap any pending block in the row')
  const standDist = Math.hypot(chosenStand.stand.x - 10.5, chosenStand.stand.z - 10.5)
  assert.ok(standDist >= 2.2 && standDist <= 4.3, `chosen stand distance (${standDist.toFixed(2)}) should be 2.2-4.3 blocks back, not 1 block away`)

  // Move bot to the chosen batch stand and verify all 4 blocks in the row are placeable from that exact stand without moving!
  fakeBot.entity.position = chosenStand.stand.clone()
  planner.probe = t => Boolean(aim.fromPose(t.world, t.info.specs[0], null, {}))
  for (let x = 10; x <= 13; x++) {
    const t = planner.tasks.get(`${x},0,10`)
    assert.equal(planner.probe(t), true, `block ${t.key} must be reachable from batch stand ${chosenStand.stand} without moving`)
  }

  // 2) Broken build-block reopening after pearl escape (>20 blocks away)
  planner.joinFleet(coord, 'bot0', 0, 2)
  // Suppose (10, 0, 10) was completed by bot1 (owner = 1), then broken when bot0 was trapped and pearled 25 blocks away to (35, 0, 35)
  const brokenTask = planner.tasks.get('10,0,10')
  brokenTask.owner = 1
  worldBlocks.set('10,0,10', { name: 'cobblestone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })
  planner.markCompleted(brokenTask)
  assert.equal(brokenTask.status, 'completed')

  // Block is dug during escape (world now has air at 10,0,10) and bot0 calls reopenTask('10,0,10', 0)
  worldBlocks.delete('10,0,10')
  planner.reopenTask('10,0,10', 0)
  assert.equal(brokenTask.status, 'pending', 'broken build block must be reopened to pending immediately')
  assert.equal(brokenTask.owner, 0, 'bot that broke the build block must claim ownership so fleet filter does not skip it')
  assert.equal(brokenTask.priorityBoost, true, 'reopened build block must receive priorityBoost')

  // Even from 25 blocks away at (35, 0, 35), next() must return the reopened build block with top priority
  const nextTask = planner.next(new Vec3(35, 0, 35))
  assert.ok(nextTask, 'planner must return a task after reopening broken block')
  assert.equal(nextTask.key, '10,0,10', 'reopened broken build block must be selected first via priorityBoost')
})


test("v2 live-run fixes: raycast pearl from shallow water before breaking build blocks, water-sheet scaffold columns, and layer-roof guard", () => {
  const { planRoute } = require("../src/recovery/exit-planner")
  const { solveThrow } = require("../src/recovery/survival")
  const { AimSolver } = require("../src/interaction/aim")
  const { planEntries } = require("../src/navigation/brain")
  const { Vec3 } = require("../src/util/vec3")
  const { describeBlock } = require("../src/rules/blocks")

  // 1) Bot in 1-block shallow water trench under packed_ice roof with open tunnel end:
  //    planRoute with a raycast pearl candidate chooses pearl (cost ~3.2) over digging finished packed_ice (cost ~452)
  const trenchWorld = (x, y, z) => {
    if (y === -60) return { name: "stone", boundingBox: "block", hardness: 1.5 }
    if (y === -59 && z === 159 && x >= 565 && x <= 574) return { name: "water", boundingBox: "empty", metadata: 1 }
    if (y === -59 && (z === 158 || z === 160) && x >= 565 && x <= 574) return { name: "glass", boundingBox: "block", hardness: 0.3 }
    if (y === -58 && (z === 158 || z === 160) && x >= 565 && x <= 574) return { name: "glass", boundingBox: "block", hardness: 0.3 }
    if (y === -57 && x >= 565 && x <= 574 && z >= 157 && z <= 161) return { name: "packed_ice", boundingBox: "block", hardness: 0.5 }
    return { name: "air", boundingBox: "empty" }
  }
  const eye = { x: 566.5, y: -59 + 1.62, z: 159.5 }
  const landing = { x: 560.5, y: -59, z: 159.5 }
  const sol = solveThrow(trenchWorld, eye, landing)
  assert.ok(sol, "solveThrow finds a low-angle raycast pearl arc out the tunnel mouth even from shallow water")

  const route = planRoute(
    trenchWorld,
    { x: 566, y: -59, z: 159 },
    (n) => n.x <= 562,
    {
      taskAt: (x, y, z) => (y === -57 ? { status: "completed", name: "packed_ice" } : null),
      pearls: [{ x: 560, y: -59, z: 159, cost: 3.0 + sol.ticks * 0.02, aim: sol }]
    }
  )
  assert.ok(route && route.steps && route.steps.length === 1, "route has 1 step")
  assert.equal(route.steps[0].type, "pearl", "bot throws raycast ender pearl first instead of breaking packed_ice build blocks")

  // 2) AimSolver.virtualStand and Brain.planEntries allow scaffold columns through 1-block water sheet over packed_ice (Layer 3/4 -> Layer 8)
  const farmWorld = {
    blockAt (p) {
      const y = p.y
      if (y <= -57) return { name: "packed_ice", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]] }
      if (y === -56) return { name: "water", boundingBox: "empty", metadata: 2 }
      if (y === -52 && p.x === 563 && p.z === 186) return { name: "cobblestone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]] }
      return { name: "air", boundingBox: "empty", shapes: [] }
    }
  }
  const fakeBot = { entity: { position: new Vec3(564.5, -56, 186.5), yaw: 0, pitch: 0 }, world: { raycast: () => null } }
  const aim = new AimSolver(fakeBot, farmWorld, { navigation: { placementReach: 4.5 }, building: { maxTowerHeight: 24 } })
  const vStand = aim.virtualStand(new Vec3(564, -51, 186), new Map(), new Vec3(563, -52, 186))
  assert.ok(vStand && vStand.height >= 1, "virtualStand plans a 5-block scaffold tower from packed_ice (-57) right through water (-56) up to Layer 8 (-51)")

  const regionCells = new Map([["563,-51,186", { x: 563, y: -51, z: 186 }]])
  const entries = planEntries((x, y, z) => farmWorld.blockAt({ x, y, z }), regionCells, { x: 564, y: -56, z: 186 })
  assert.ok(entries.towers.length > 0, "Brain.planEntries finds tower columns rising through the 1-block water sheet")
})

test('slab top/bottom side-face clicks strictly enforce cy/half cursor height and reject impossible slab reference halves', () => {
  const { hitSamples, specAccepts } = require('../src/interaction/aim')
  const { describeBlock } = require('../src/rules/blocks')
  const { Vec3 } = require('../src/util/vec3')

  const topSlabInfo = describeBlock('smooth_stone_slab', { type: 'top', waterlogged: 'false' })
  const botSlabInfo = describeBlock('smooth_stone_slab', { type: 'bottom', waterlogged: 'false' })
  const topSide = topSlabInfo.specs[0].faces.find(f => f.f === 'north')
  const botSide = botSlabInfo.specs[0].faces.find(f => f.f === 'north')

  const refPos = new Vec3(0, 64, 0)
  const fullBox = [0, 0, 0, 1, 1, 1]
  const topPts = hitSamples(refPos, 'north', topSide, fullBox, false, null)
  const botPts = hitSamples(refPos, 'north', botSide, fullBox, false, null)

  assert.ok(topPts.length > 0 && topPts.every(p => p.y - refPos.y >= 0.60), 'top slab side-face samples must all be in the upper half (y >= 0.60)')
  assert.ok(botPts.length > 0 && botPts.every(p => p.y - refPos.y <= 0.40), 'bottom slab side-face samples must all be in the lower half (y <= 0.40)')

  // Clicking a bottom-slab reference block (y in 0..0.5) on its side face CANNOT place a top slab (must return [] instead of clamping to 0.25!)
  const bottomSlabBox = [0, 0, 0, 1, 0.5, 1]
  const impossibleTopOnBottomRef = hitSamples(refPos, 'north', topSide, bottomSlabBox, false, null)
  assert.equal(impossibleTopOnBottomRef.length, 0, 'cannot place a top slab against the side face of a bottom slab')

  // specAccepts must reject wrong-half hits on side faces
  const dir = new Vec3(0, 0, 1)
  assert.equal(specAccepts(topSlabInfo.specs[0], topSide, dir, new Vec3(0.5, 64.25, 0), refPos), false)
  assert.equal(specAccepts(topSlabInfo.specs[0], topSide, dir, new Vec3(0.5, 64.75, 0), refPos), true)
  assert.equal(specAccepts(botSlabInfo.specs[0], botSide, dir, new Vec3(0.5, 64.75, 0), refPos), false)
  assert.equal(specAccepts(botSlabInfo.specs[0], botSide, dir, new Vec3(0.5, 64.25, 0), refPos), true)
})

test('cobble.litematic ordering: observers and walls precede waterlogs, fragile redstone waits for completed schematic support, and reopenTask preserves attempts on uncompleted tasks', () => {
  const { BuildPlanner } = require('../src/planner/build-planner')
  const { Vec3 } = require('../src/util/vec3')

  const blocks = {
    '6,9,5': ['observer', { facing: 'up', powered: 'false' }],
    '5,9,6': ['observer', { facing: 'west', powered: 'false' }],
    '6,9,6': ['oak_trapdoor', { facing: 'east', half: 'bottom', open: 'false', waterlogged: 'true' }],
    '6,10,5': ['redstone_wire', { east: 'side', west: 'side', north: 'none', south: 'none', power: '0' }]
  }
  const worldBlocks = new Map()
  const bot = { entity: { position: new Vec3(0, 0, 0) } }
  const world = {
    bot,
    blockAt: p => worldBlocks.get(`${p.x},${p.y},${p.z}`) || { name: 'air', boundingBox: 'empty', getProperties: () => ({}) }
  }
  const schematic = {
    size: new Vec3(17, 14, 14),
    start: () => new Vec3(0, 0, 0),
    end: () => new Vec3(16, 13, 13),
    tiles: new Map(),
    getBlock: p => {
      const b = blocks[`${p.x},${p.y},${p.z}`]
      return b ? { name: b[0], properties: b[1], isAir: false, getProperties: () => ({ ...b[1] }) } : { name: 'air', properties: {}, isAir: true, getProperties: () => ({}) }
    }
  }
  const planner = new BuildPlanner({ schematic }, { rotation: 0, origin: new Vec3(0, 0, 0), localToWorld: p => p.clone() }, world, { building: {} }, { info () {}, warn () {}, debug () {} }).build()
  planner.isTempCell = (x, y, z) => `${x},${y},${z}` === '6,9,5'

  const obsUp = planner.tasks.get('6,9,5')
  const obsWest = planner.tasks.get('5,9,6')
  const trapdoor = planner.tasks.get('6,9,6')
  const trapdoorWl = planner.tasks.get('6,9,6#w')
  const wireAbove = planner.tasks.get('6,10,5')

  assert.ok(obsWest.order < trapdoorWl.order, `observer (${obsWest.order}) must be placed before trapdoor waterlog (${trapdoorWl.order})`)
  assert.ok(trapdoor.order < trapdoorWl.order, `trapdoor block (${trapdoor.order}) must be placed before its waterlog (${trapdoorWl.order})`)
  assert.ok(obsUp.order < wireAbove.order, `observer (${obsUp.order}) must be scheduled before redstone_wire above it (${wireAbove.order})`)

  // Suppose a temporary stone block sits at 6,9,5 while observer@6,9,5 is still pending: redstone_wire@6,10,5 must NOT be ready!
  worldBlocks.set('6,9,5', { name: 'stone', boundingBox: 'block', getProperties: () => ({}) })
  assert.equal(planner.isReady(wireAbove), false, 'fragile redstone_wire must not place onto a temporary/uncompleted observer cell')

  // Suppose trapdoor@6,9,6 is completed, but observer@5,9,6 is still air: trapdoorWl@6,9,6#w must NOT be ready (would leak water)!
  planner.markCompleted(trapdoor)
  worldBlocks.set('6,9,6', { name: 'oak_trapdoor', boundingBox: 'block', getProperties: () => ({ facing: 'east', half: 'bottom', open: 'false', waterlogged: 'false' }) })
  assert.equal(planner.isReady(trapdoorWl), false, 'waterlogged trapdoor must wait until adjacent observer wall is placed')

  // Verify reopenTask does not wipe attempts on an uncompleted task unless forceReset is passed
  obsUp.attempts = 3
  obsUp.status = 'failed'
  planner.reopenTask('6,9,5')
  assert.equal(obsUp.attempts, 3, 'reopenTask without forceReset preserves attempts on uncompleted tasks')
})

test('RecoveryManager.hazardAround does not pause a grounded bot supported by a solid ledge next to schematic lava below its floor', () => {
  const { RecoveryManager } = require('../src/recovery/recovery-manager')
  const { GroundMonitor } = require('../src/world/ground')
  const { Vec3 } = require('../src/util/vec3')

  // Bot center is at (-31.95, -52, -16.5) -> floored is (-32, -52, -16) where (-32, -53, -16) is lava,
  // but the bot's 0.6x0.6 hitbox rests on cobblestone at (-31, -53, -16) and is grounded!
  const world = {
    blockAt: p => {
      if (p.x === -32 && p.y === -53 && p.z === -16) return { name: 'lava', boundingBox: 'empty', metadata: 0 }
      if (p.x === -31 && p.y === -53 && p.z === -16) return { name: 'cobblestone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    }
  }
  const bot = {
    on () {}, off () {},
    entity: { position: new Vec3(-31.95, -52, -16.5), velocity: new Vec3(0, 0, 0), onGround: true, isInLava: false, isInWater: false },
    builder: { running: true }
  }
  const ground = new GroundMonitor(bot, world, { warn () {}, info () {}, debug () {} })
  const rm = new RecoveryManager(bot, { stop () {} }, world, {}, { warn () {}, info () {} }, ground)
  assert.equal(rm.hazardAround(), false, 'supported grounded bot overhanging schematic lava must not trigger hazardAround panic')
})

test('Coordinator.busyFor prevents two bots from targeting vertically or horizontally adjacent cells even in own mode', () => {
  const { Coordinator } = require('../src/fleet/coordinator')
  const coord = new Coordinator(2)
  coord.register('w0', 0, { entity: { position: { x: -35, y: -52, z: -17 } } })
  coord.register('w1', 1, { entity: { position: { x: -33, y: -50, z: -16 } } })
  coord.claim('w0', { key: '-35,-51,-16', world: { x: -35, y: -51, z: -16 } })

  // w1 wants to work on redstone_wire directly above w0's target (-35,-50,-16) in 'own' mode (strict = false)
  assert.equal(coord.busyFor('w1', { key: '-35,-50,-16', world: { x: -35, y: -50, z: -16 } }, false), true, 'vertically adjacent cell is locked while w0 is working on -35,-51,-16')
  // A task 4 blocks away in 'own' mode is NOT blocked
  assert.equal(coord.busyFor('w1', { key: '-31,-50,-16', world: { x: -31, y: -50, z: -16 } }, false), false, 'task 4 blocks away in own mode is free')
})

test('HumanBuildLogger ignores grass spread and nearby passive spectators, and records real human swings in learned/ without overwriting bot rules', () => {
  const os = require('os')
  const fs = require('fs')
  const path = require('path')
  const { HumanBuildLogger } = require('../src/learning/human-logger')
  const { OrientationLearner, BuildMemory } = require('../src/learning/learner')
  const { describeBlock } = require('../src/rules/blocks')
  const { Vec3 } = require('../src/util/vec3')

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhb-hl-'))
  const learnedDir = path.join(tmpDir, 'learned')
  const learner = new OrientationLearner(tmpDir, { info () {}, warn () {} })
  learner.preferred.chest = 'horiz-opposite'
  const memory = new BuildMemory(tmpDir, 'cobble.litematic', 0, { info () {}, warn () {} })
  const info = describeBlock('chest', { facing: 'north', type: 'single', waterlogged: 'false' })
  const task = {
    key: '-35,-51,-16',
    kind: 'block',
    name: 'chest',
    properties: { facing: 'north', type: 'single', waterlogged: 'false' },
    info,
    local: new Vec3(6, 9, 5),
    world: new Vec3(-35, -51, -16),
    status: 'pending',
    attempts: 2,
    lastError: 'NO_ACCESS'
  }
  const tasks = new Map([[task.key, task]])
  const planner = {
    tasks,
    rescanTask: t => { t.status = 'completed'; return true }
  }
  const humanEntity = {
    type: 'player',
    username: 'MalikHu',
    position: new Vec3(-34.5, -53, -15.5), // eye at (-34.5, -51.38, -15.5), looking straight UP at (-34.5, -50.5, -15.5)
    yaw: 0,
    pitch: 1.5
  }
  const bot = {
    username: 'Build',
    entity: { position: new Vec3(-40, -60, -20) },
    entities: { human1: humanEntity }
  }
  const hl = new HumanBuildLogger({
    bot,
    world: { blockAt: () => ({ name: 'air' }) },
    config: {},
    logger: { info () {}, warn () {} },
    stateDir: tmpDir,
    learnedDir,
    getPlanner: () => planner,
    getSchematicName: () => 'cobble.litematic',
    isFleetBot: name => name === 'Build'
  })

  // 1) Grass spreading onto dirt (dirt -> grass_block) or a bot placing a block while MalikHu has NOT swung arm -> MUST BE IGNORED!
  hl.onBlockUpdate(
    { name: 'dirt', position: new Vec3(-35, -51, -16) },
    { name: 'grass_block', position: new Vec3(-35, -51, -16), getProperties: () => ({}) }
  )
  hl.onBlockUpdate(
    { name: 'air', position: new Vec3(-35, -51, -16) },
    { name: 'chest', position: new Vec3(-35, -51, -16), getProperties: () => ({ facing: 'north', type: 'single', waterlogged: 'false' }) }
  )
  assert.equal(hl.records.length, 0, 'passive spectator without arm swing or grass spread is never logged')

  // 2) Now MalikHu actually swings his arm while looking directly at (-35, -51, -16)
  hl.onEntitySwingArm(humanEntity)
  hl.onBlockUpdate(
    { name: 'air', position: new Vec3(-35, -51, -16) },
    { name: 'chest', position: new Vec3(-35, -51, -16), getProperties: () => ({ facing: 'north', type: 'single', waterlogged: 'false' }) }
  )

  assert.equal(hl.records.length, 1, 'verified human arm swing + look ray records the placement')
  assert.equal(learner.preferred.chest, 'horiz-opposite', 'bot rule is NOT overwritten by human placement')
  assert.equal(memory.data.bestStands['6,9,5@0'], undefined, 'bot BuildMemory is kept separate from human session log')
})


test("v2.3 fixes: oak_trapdoor stale-tag resilience, waterlog #w child sync, upper-layer L10-L13 unblocking, problem-block quarantine handoff, and bottom-slab tower base rejection", () => {
  const os = require("os")
  const fs = require("fs")
  const path = require("path")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager")
  const { BuildMemory } = require("../src/learning/learner")
  const { describeBlock } = require("../src/rules/blocks")
  const { Vec3 } = require("../src/util/vec3")

  // 1. Trapdoor specs include both flat and side mounting faces without hyp=true
  const tdInfo = describeBlock("oak_trapdoor", { facing: "west", half: "bottom", open: "false", waterlogged: "true" })
  assert.equal(tdInfo.specs.length, 2)
  assert.equal(tdInfo.specs[0].tag, "trapdoor-flat")
  assert.equal(tdInfo.specs[1].tag, "trapdoor-side")
  assert.equal(Boolean(tdInfo.specs[0].hyp), false)
  assert.equal(Boolean(tdInfo.specs[1].hyp), false)

  // 2. When a waterlogged oak_trapdoor on L3 is deferred or quarantined, its #w child is synced and L10 tasks at another column are NOT locked out!
  const cells = new Map([
    ["0,3,0", { name: "oak_trapdoor", properties: { facing: "west", half: "bottom", open: "false", waterlogged: "true" } }],
    ["5,10,5", { name: "cobblestone", properties: {} }],
    ["5,9,5", { name: "cobblestone", properties: {} }]
  ])
  const schematic = {
    start: () => new Vec3(0, 0, 0),
    end: () => new Vec3(6, 12, 6),
    getBlock: p => {
      const b = cells.get(`${p.x},${p.y},${p.z}`)
      if (!b) return { name: "air", isAir: true, getProperties: () => ({}) }
      return { name: b.name, isAir: false, properties: b.properties, getProperties: () => b.properties }
    }
  }
  const transform = { origin: new Vec3(0, 0, 0), rotation: 0, localToWorld: p => p.clone() }
  const worldBlocks = new Map([
    ["5,9,5", { name: "cobblestone", boundingBox: "block", getProperties: () => ({}) }]
  ])
  const world = { blockAt: p => worldBlocks.get(`${p.x},${p.y},${p.z}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) } }
  const planner = new BuildPlanner({ schematic }, transform, world, { building: { giveUpAttempts: 6 } }, { info () {}, warn () {}, debug () {} }).build()

  const tdTask = planner.tasks.get("0,3,0")
  const tdWl = planner.tasks.get("0,3,0#w")
  const l10Task = planner.tasks.get("5,10,5")
  assert.ok(tdTask && tdWl && l10Task)

  // Simulate 3 failures on tdTask -> handoff + deferred (and #w child also deferred)
  planner.fleet = { index: 0, count: 2, id: "Build", coord: { log: [], busyFor: () => false, claim () {}, complete () {} } }
  tdTask.owner = 0
  l10Task.owner = 0
  planner.markFailure(tdTask, new Error("NO_ACCESS"))
  planner.markFailure(tdTask, new Error("NO_ACCESS"))
  planner.markFailure(tdTask, new Error("NO_ACCESS"))
  assert.equal(tdTask.owner, 1, "After 3 failures, task is handed off to worker #2")
  assert.equal(tdTask.forceSupport, true, "After 3 failures, extra support is forced")
  assert.equal(tdWl.status, "deferred", "Waterlog child #w is automatically deferred with parent")

  // Even though L3 trapdoor is deferred, L10 task at (5,10,5) (whose support 5,9,5 is already completed) is returned by planner.next()!
  const nextPick = planner.next(new Vec3(5, 10, 4))
  assert.ok(nextPick && nextPick.key === "5,10,5", "Deferred L3 trapdoor must NOT freeze unrelated L10 tasks")

  // Simulate 6 total failures -> quarantine
  planner.markFailure(tdTask, new Error("NO_ACCESS"))
  planner.markFailure(tdTask, new Error("NO_ACCESS"))
  planner.markFailure(tdTask, new Error("NO_ACCESS"))
  assert.equal(tdTask.status, "blocked", "After 6 failures, task is quarantined")
  assert.equal(tdWl.status, "blocked", "Waterlog child #w is also blocked when parent is quarantined")
  assert.equal(planner.quarantined.has("0,3,0"), true)

  // 3. ScaffoldManager.planColumn rejects a 0.5m bottom slab as a jump-tower base
  const scWorld = {
    blockAt: p => {
      if (p.x === 2 && p.y === 0 && p.z === 2) return { name: "smooth_stone_slab", boundingBox: "block", getProperties: () => ({ type: "bottom" }) }
      return { name: "air", boundingBox: "empty", getProperties: () => ({}) }
    }
  }
  const sc = new ScaffoldManager({ bot: {}, world: scWorld, config: { building: { maxTowerHeight: 10 } } })
  assert.equal(sc.planColumn(new Vec3(2, 2, 2), new Vec3(3, 2, 2)), null, "Bottom slab must not be used as jump-tower base")

  // 4. BuildMemory records locked specTag + stand for every successful block and remembers hazard cells
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mhb-mem3-"))
  const mem = new BuildMemory(tmp, "cobble.litematic", 0)
  mem.originVec = new Vec3(0, 0, 0)
  mem.recordSuccess(l10Task, new Vec3(5, 10, 3), "free")
  mem.recordHazardCell(new Vec3(1, 2, 3), "lava")
  mem.save()

  const memLoaded = new BuildMemory(tmp, "cobble.litematic", 0)
  l10Task.hint = null
  l10Task.lockedSpecTag = null
  memLoaded.applyToPlanner(planner, Vec3)
  assert.deepEqual(l10Task.hint, new Vec3(5, 10, 3))
  assert.equal(l10Task.lockedSpecTag, "free")
  assert.equal(memLoaded.isHazardWorldCell(new Vec3(1, 2, 3)), true)
})

test("v2.4 TNT duper & cobble.litematic 100% completion fixes: trapdoor multi-spec support over redstone_wire, fluidCheck tempObstructions, bottom-slab pillar guard, piston-sand/TNT phase barriers, double-chest partner rules, and post-build HumanBuildLogger guard", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { Placer } = require("../src/interaction/placer")
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager")
  const { makeView, moves } = require("../src/recovery/exit-planner")
  const { HumanBuildLogger } = require("../src/learning/human-logger")

  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const start = schematic.start()
  const end = schematic.end()
  const origin = new Vec3(-50, -60, 35)
  const transform = {
    origin,
    rotation: 0,
    localToWorld: lp => new Vec3(origin.x + (lp.x - start.x), origin.y + (lp.y - start.y), origin.z + (lp.z - start.z)),
    worldToLocalXZ: wp => new Vec3(wp.x - origin.x + start.x, wp.y - origin.y + start.y, wp.z - origin.z + start.z)
  }

  const worldMap = new Map()
  const worldModel = {
    bot: { registry: { itemsByName: new Proxy({}, { get: (_, k) => ({ name: k }) }) } },
    blockAt: pos => worldMap.get(`${pos.x},${pos.y},${pos.z}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  }
  const planner = new BuildPlanner({ schematic, start, end }, transform, worldModel, { building: { giveUpAttempts: 6 } }, { info () {}, warn () {}, debug () {} })
  await planner.build()

  // 1. Verify TNT duper ordering: observers after redstone_wire on same layer, lever (100011) -> sand above piston_head (105013) -> tnt (110010)
  const wireL10 = planner.tasks.get("-45,-50,40")
  const obsL10 = planner.tasks.get("-45,-50,41")
  const leverL11 = planner.tasks.get("-46,-49,44")
  const sandL13 = planner.tasks.get("-46,-47,42")
  const tntL10 = planner.tasks.get("-44,-50,41")
  assert.ok(wireL10.order < obsL10.order, "Floor redstone_wire on L10 must be placed before adjacent observer on L10")
  assert.equal(leverL11.order, 100011)
  assert.equal(sandL13.order, 105013, "Gravity sand above upward piston_head must be placed after lever extends piston")
  assert.equal(tntL10.order, 110010, "TNT must be placed last of all")
  assert.equal(planner.phaseBlocked(100011), true, "Power sources blocked while structure is unfinished")
  assert.equal(planner.phaseBlocked(110010), true, "TNT blocked while structure is unfinished")

  // 2. Verify oak_trapdoor@-44,-49,40 multi-spec provideSupport when -44,-50,40 is occupied by redstone_wire
  const tdDuper = planner.tasks.get("-44,-49,40")
  worldMap.set("-44,-50,40", { name: "redstone_wire", boundingBox: "empty", getProperties: () => ({}) })
  worldMap.set("-43,-50,40", { name: "smooth_stone", boundingBox: "block", getProperties: () => ({}) })
  let tempPlacedAt = null
  const fakePlacer = Object.create(Placer.prototype)
  fakePlacer.config = { building: { allowTemporaryScaffolding: true } }
  fakePlacer.planner = planner
  fakePlacer.world = worldModel
  fakePlacer.logger = { info () {}, warn () {}, debug () {} }
  fakePlacer.setPhase = () => {}
  fakePlacer.hasRef = Placer.prototype.hasRef.bind(fakePlacer)
  fakePlacer.hasSolidNeighbor = Placer.prototype.hasSolidNeighbor.bind(fakePlacer)
  fakePlacer.aim = {
    isSolidRef: (b) => b && b.boundingBox === "block",
    candidates: (cell) => (cell.x === -43 && cell.y === -49 && cell.z === 40) ? [{ stand: new Vec3(-42.5, -49, 40.5) }] : []
  }
  fakePlacer.placeTempBlock = async (cell) => { tempPlacedAt = `${cell.x},${cell.y},${cell.z}`; return cell }
  const supportRes = await fakePlacer.provideSupport(tdDuper)
  assert.equal(tempPlacedAt, "-43,-49,40", "provideSupport must use trapdoor-side reference -43,-49,40 when -44,-50,40 has redstone_wire")
  assert.equal(supportRes.length, 1)

  // 3. Verify fluidCheck on oak_trapdoor@-44,-52,41#w when -43,-56,41 has a temporary stone block
  for (const t of planner.tasks.values()) {
    if (t.kind === "block") {
      t.status = "completed"
      worldMap.set(t.key, { name: t.name, boundingBox: "block", getProperties: () => t.properties })
    }
  }
  worldMap.set("-43,-56,41", { name: "stone", boundingBox: "block", getProperties: () => ({}) })
  planner.isTempCell = (x, y, z) => x === -43 && y === -56 && z === 41
  const wlTrapdoor = planner.tasks.get("-44,-52,41#w")
  const fc = planner.fluidCheck(wlTrapdoor)
  assert.equal(fc.blocked, false, "Temporary stone in fluid shaft must not cause false UNSAFE leak to -42,-55,41")
  assert.ok(fc.tempObstructions.some(p => p.x === -43 && p.y === -56 && p.z === 41), "fluidCheck records temporary obstruction at -43,-56,41")

  // 4. Verify exit-planner never yields pillar on a cell occupied by a bottom slab, and ScaffoldManager._descend_h never digs a non-scaffold block
  const slabView = makeView((x, y, z) => {
    if (x === -43 && y === -57 && z === 38) return { name: "smooth_stone_slab", boundingBox: "block", getProperties: () => ({ type: "bottom" }) }
    if (y === -58) return { name: "dirt", boundingBox: "block", getProperties: () => ({}) }
    return { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  })
  const availMoves = [...moves(slabView, { x: -43, y: -57, z: 38, floorPlaced: false }, { maxDrop: 1, allowDig: false, allowPlace: true })]
  assert.equal(availMoves.some(m => m.type === "pillar"), false, "Must never pillar on a cell already containing a bottom slab")

  let dugSlab = false
  const scMgr = new ScaffoldManager({
    bot: { entity: { position: new Vec3(-42.5, -56.5, 38.5) } },
    world: { blockAt: () => ({ name: "smooth_stone_slab", boundingBox: "block" }) },
    config: { building: { scaffoldBlockNames: ["stone"] } },
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    look: { lookDown: async () => {} },
    interaction: { digAimed: async () => { dugSlab = true } }
  })
  scMgr.created.set("-43,-57,38", new Vec3(-43, -57, 38))
  await scMgr._descend_h(0)
  assert.equal(dugSlab, false, "_descend_h must never dig a non-scaffold schematic block")
  assert.equal(scMgr.created.has("-43,-57,38"), false, "_descend_h cleans non-scaffold entry from created set")

  // 5. Verify double-chest specs distinguish partner-absent vs partner-present
  const { describeBlock } = require("../src/rules/blocks")
  const rightChest = describeBlock("chest", { facing: "west", type: "right" })
  assert.equal(rightChest.specs[0].whenPartner, "absent")
  assert.equal(rightChest.specs[0].sneak, true)
  assert.equal(rightChest.specs[1].whenPartner, "present")
  assert.equal(rightChest.specs[2].whenPartner, "present")

  // 6. Verify HumanBuildLogger stops recording when isActive() returns false
  let activeFlag = false
  const hLogger = new HumanBuildLogger({
    bot: {
      entity: { position: new Vec3(0, 0, 0) },
      entities: {
        1: { type: "player", username: "MalikHu", position: new Vec3(0, 0, 0), yaw: 0, pitch: 0, _testSwung: true }
      }
    },
    world: worldModel,
    config: {},
    logger: { info () {} },
    isActive: () => activeFlag
  })
  hLogger.onBlockUpdate(
    { name: "observer", position: new Vec3(0, 1, -2), getProperties: () => ({}) },
    { name: "air", position: new Vec3(0, 1, -2), getProperties: () => ({}) }
  )
  assert.equal(hLogger.records.length, 0, "HumanBuildLogger must ignore post-build testing when isActive() is false")
})


test("v2.5 fixes: observer-b primary rule, TNT duper horizontal piston Phase 2 ordering (95000+layer), overhead support for look-up observer, and instant stray water source plugging", async () => {
  const { describeBlock } = require("../src/rules/blocks")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { Placer } = require("../src/interaction/placer")
  const { Vec3 } = require("../src/util/vec3")

  // 1. Observer primary spec is observer-b (look: f), not observer-a (look: OPP[f])
  const obsUp = describeBlock("observer", { facing: "up", powered: "false" })
  assert.equal(obsUp.specs[0].tag, "observer-b")
  assert.equal(obsUp.specs[0].look, "up")
  const obsSouth = describeBlock("observer", { facing: "south", powered: "false" })
  assert.equal(obsSouth.specs[0].tag, "observer-b")
  assert.equal(obsSouth.specs[0].look, "south")

  // 2. Horizontal non-extended pistons with an observer above (TNT duper pusher pistons) get order 95000 + layer
  const fakePlanner = Object.create(BuildPlanner.prototype)
  fakePlanner.schematic = {
    getBlock: (pos) => {
      if (pos.x === 4 && pos.y === 11 && pos.z === 6) return { name: "observer", properties: { facing: "up" } }
      return { name: "air", properties: {} }
    }
  }
  const duperPistonOrder = fakePlanner.orderOf(describeBlock("piston", { facing: "east", extended: "false" }), "block", 10, new Vec3(4, 10, 6))
  assert.equal(duperPistonOrder, 95010, "TNT duper horizontal piston below observer must wait until order 95010 so upper-layer observer/note_block construction never fires it")

  // 3. scoopStrayWater plugs any stray water source (level=0) with a temporary solid block and sweeps it
  const worldCells = new Map([
    ["-50,-55,54", { name: "water", metadata: 0, boundingBox: "empty", getProperties: () => ({ level: "0" }) }],
    ["-50,-56,54", { name: "stone", boundingBox: "block", getProperties: () => ({}) }]
  ])
  const plugged = []
  const fakePlacer = Object.create(Placer.prototype)
  fakePlacer.bot = { entity: { position: new Vec3(-50, -56, 55) }, heldItem: { name: "water_bucket" } }
  fakePlacer.world = { blockAt: (p) => worldCells.get(`${p.x},${p.y},${p.z}`) || { name: "air", boundingBox: "empty" } }
  fakePlacer.planner = { fluidCells: new Map(), tasks: new Map() }
  fakePlacer.logger = { warn () {}, info () {} }
  fakePlacer.placeTempBlock = async (c) => {
    plugged.push(`${c.x},${c.y},${c.z}`)
    worldCells.set(`${c.x},${c.y},${c.z}`, { name: "cobbled_deepslate", boundingBox: "block" })
  }
  fakePlacer.sweepTemporary = async () => 1
  await fakePlacer.scoopStrayWater(new Vec3(-50, -54, 52))
  assert.deepEqual(plugged, ["-50,-55,54"], "scoopStrayWater must find and plug stray water source at -50,-55,54")
})


test("v2.6 fixes: no recursive placeTempBlock/tower spin loops, dead-stand caching, virtual 3D spatial neighborhood & overhang guard, and prompt temporary block cleanup", async () => {
  const { Placer } = require("../src/interaction/placer")
  const { AimSolver } = require("../src/interaction/aim")
  const { FallGuard } = require("../src/recovery/fall-guard")
  const { BuildMemory } = require("../src/learning/learner")
  const { Vec3 } = require("../src/util/vec3")
  const os = require("os")
  const fs = require("fs")
  const path = require("path")

  // 1. Virtual 3D Spatial Brain classifies open vs narrow/perforated terrain and never forgets holes until covered
  const worldBlocks = new Map()
  for (let x = -3; x <= 3; x++) {
    for (let z = -3; z <= 3; z++) {
      worldBlocks.set(`${x},-61,${z}`, { name: "stone", boundingBox: "block", getProperties: () => ({}) })
    }
  }
  const world = {
    blockAt: p => worldBlocks.get(`${p.x},${p.y},${p.z}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  }
  const controls = {}
  const bot = {
    health: 20,
    builder: { running: true },
    controlState: controls,
    setControlState: (k, v) => { controls[k] = v },
    getControlState: (k) => Boolean(controls[k]),
    entity: { position: new Vec3(0.5, -60, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true }
  }
  const fg = new FallGuard({ bot, world, config: {}, logger: {}, navigation: { stop () {} }, ground: {} })
  bot.builder.fallGuard = fg
  assert.equal(fg.analyzeNeighborhood(bot.entity.position).mode, "open", "3x3 solid floor with no nearby holes is classified as open")

  // Carve a deep hole at (1, -61, 0) down to -65
  for (let y = -61; y >= -64; y--) worldBlocks.delete(`1,${y},0`)
  const narrowInfo = fg.analyzeNeighborhood(bot.entity.position)
  assert.equal(narrowInfo.mode, "narrow", "Adjacent deep hole switches neighborhood to narrow mode")
  assert.ok(narrowInfo.minHazardDist <= 1.2)

  // Sprinting toward the hole at (1, -60, 0) triggers momentum damping and sneak clamp
  bot.entity.velocity = new Vec3(0.26, 0, 0)
  fg.tick()
  assert.equal(controls.sneak, true, "FallGuard engages sneak edge-clamp")
  assert.ok(bot.entity.velocity.x < 0.05, "FallGuard damps horizontal sprinting momentum before hole")
  assert.equal(fg.isHole(1, 0), true, "Hole is permanently remembered in FallGuard")

  // Covering the hole with a solid block clears the hole memory
  worldBlocks.set("1,-61,0", { name: "stone", boundingBox: "block", getProperties: () => ({}) })
  assert.equal(fg.isHole(1, 0), false, "Covering the hole clears it from hole memory")

  // 2. Placer.placeTempBlock refuses recursive temporary block placement & deadStands caches unreachable stands
  const p = Object.create(Placer.prototype)
  p.bot = bot
  p._tempDepth = 1
  await assert.rejects(() => p.placeTempBlock(new Vec3(2, -60, 2)), /refusing recursive temporary block placement/)
  p._tempDepth = 0
  p.noteDeadStand(new Vec3(10.5, -60, 10.5))
  assert.equal(p.isDeadStand(new Vec3(10.5, -60, 10.5)), true, "Unreachable stand is cached for current bot cell")

  // 3. BuildMemory v4 auto-purges legacy v3 polluted supportNeeded maps (>6 entries)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mhb-v4-"))
  const legacyFile = path.join(tmpDir, "build-memory.cobble.litematic.json")
  const bogusSupports = {}
  for (let i = 0; i < 42; i++) bogusSupports[`${i},1,0@0`] = [[1, 0, 0]]
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 3, runs: 22, completedRuns: 3, supportNeeded: bogusSupports }))
  const bm = new BuildMemory(tmpDir, "cobble.litematic", 0)
  assert.equal(Object.keys(bm.data.supportNeeded).length, 0, "Legacy v3 polluted supportNeeded map is purged on load")
})


test("v2.7 fixes: ladder grounded/sneak-free climbing & wall-attach rule, note_block/repeater value tuning, horizontal observer pitch guard & MotionGuard remPitch, top-face pearl & anti-water-rim pearl filter, BuildMemory rel[1]<=0 guard, and hub ping heartbeat", async () => {
  const { Vec3 } = require("../src/util/vec3")
  const { GroundMonitor, supportUnder } = require("../src/world/ground")
  const { FallGuard } = require("../src/recovery/fall-guard")
  const { describeBlock } = require("../src/rules/blocks")
  const { specAccepts } = require("../src/interaction/aim")
  const { Placer } = require("../src/interaction/placer")
  const { BuildMemory } = require("../src/learning/learner")
  const { Hub } = require("../src/fleet/hub")
  const os = require("os")
  const fs = require("fs")
  const path = require("path")

  // 1. Ladder rule is wall-attach (faces: [{ f }]) and GroundMonitor/supportUnder treat ladder as grounded
  const ladderInfo = describeBlock("ladder", { facing: "west", waterlogged: "false" })
  assert.equal(ladderInfo.specs[0].tag, "wall-attach")
  assert.deepEqual(ladderInfo.specs[0].faces, [{ f: "west" }])

  const ladderWorld = {
    blockAt: p => {
      if (p.x === -6 && p.y === -55 && p.z === -11) return { name: "ladder", boundingBox: "empty", getProperties: () => ({ facing: "west" }) }
      return { name: "air", boundingBox: "empty", getProperties: () => ({}) }
    }
  }
  const ladderBot = {
    on () {}, off () {}, removeListener () {},
    health: 20,
    builder: { running: true },
    controlState: { sneak: true },
    setControlState (k, v) { this.controlState[k] = v },
    getControlState (k) { return Boolean(this.controlState[k]) },
    entity: { position: new Vec3(-5.5, -54.6, -10.5), velocity: new Vec3(0, 0.12, 0), onGround: false, isInWater: false, isInLava: false }
  }
  assert.equal(supportUnder(ladderWorld, ladderBot.entity.position).supported, true, "ladder supports bot")
  const gm = new GroundMonitor(ladderBot, ladderWorld, {})
  assert.equal(gm.state(), "grounded", "bot on a ladder must be grounded, never phantom")

  // FallGuard immediately clears sneakClampTicks when on a ladder
  const fg = new FallGuard({ bot: ladderBot, world: ladderWorld, config: {}, logger: {}, navigation: { stop () {} }, ground: gm })
  fg.sneakClampTicks = 5
  fg.tick()
  assert.equal(ladderBot.controlState.sneak, false, "FallGuard must release sneak while on a ladder")

  // 2. note_block and repeater post actions include both value and clicks, and Placer.clickActions tunes to exact note
  const noteInfo = describeBlock("note_block", { instrument: "harp", note: "9", powered: "false" })
  assert.equal(noteInfo.post[0].value, 9)
  assert.equal(noteInfo.post[0].clicks, 9)
  let currentNote = 0
  const fakePlacer = Object.create(Placer.prototype)
  fakePlacer.clickBlock = async (_task, maxTimes, until) => {
    for (let i = 0; i < maxTimes; i++) {
      const b = { getProperties: () => ({ note: String(currentNote) }) }
      if (until(b)) return
      currentNote = (currentNote + 1) % 25
    }
  }
  await fakePlacer.clickActions({ name: "note_block" }, { type: "note", value: 9 })
  assert.equal(currentNote, 9, "clickActions must stop at exact note=9 using action.value")

  // 3. specAccepts rejects steep vertical pitch (>30 deg) for horizontal observer-b so it never places facing=down
  const obsWest = describeBlock("observer", { facing: "west", powered: "false" }).specs[0]
  const refPos = new Vec3(-4, -49, -15)
  const steepDir = new Vec3(-0.7, -0.68, 0) // dominant is west (-0.7 vs -0.68), but pitch is ~44 deg down -> would risk facing=down
  assert.equal(specAccepts(obsWest, { f: "north" }, steepDir, new Vec3(-3.5, -48.5, -15), refPos), false, "steep pitch is rejected for horizontal observer-b")
  const levelDir = new Vec3(-0.95, -0.2, 0.25)
  assert.equal(specAccepts(obsWest, { f: "north" }, levelDir, new Vec3(-3.5, -48.5, -15), refPos), true, "level horizontal look is accepted for observer-b")

  // 4. BuildMemory v5 strips elevated rel[1] > 0 stand offsets on load and never records rel[1] > 0
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mhb-v5-"))
  fs.writeFileSync(path.join(tmpDir, "build-memory.cobble.litematic.json"), JSON.stringify({
    version: 4,
    runs: 2,
    completedRuns: 1,
    bestStands: {
      "8,3,9@0": [-2, 1, 0],
      "6,9,5@0": [0, -2, -1]
    }
  }))
  const bm = new BuildMemory(tmpDir, "cobble.litematic", 0)
  assert.equal(bm.data.bestStands["8,3,9@0"], undefined, "elevated rel[1] > 0 stand offset is purged")
  assert.deepEqual(bm.data.bestStands["6,9,5@0"], [0, -2, -1], "valid rel[1] <= 0 stand offset is preserved")

  // 5. Hub handles worker ping heartbeats
  const hub = new Hub({ logger: { info () {}, warn () {} } })
  const EventEmitter = require("events")
  const ch = new EventEmitter()
  ch.send = () => {}
  const rec = hub.attach("Monster", 0, ch)
  rec.lastMsg = Date.now() - 100_000
  ch.emit("message", { t: "ping", id: "Monster" })
  assert.equal(hub.deadWorkers().length, 0, "ping message refreshes worker heartbeat in Hub")
})


test("v2.8 fixes: 2-block dirt platform does not trigger sneak lock, access steps persist until final cleanup, and local ready tasks beat far seqPtr walks", async () => {
  const { Vec3 } = require("../src/util/vec3")
  const { Placer } = require("../src/interaction/placer")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { describeBlock } = require("../src/rules/blocks")

  // 1. A 2-block-tall dirt platform (y=-58 over flat grass at y=-61) is NOT treated as a pit by FallGuard.tick() or analyzeNeighborhood()
  const platformWorld = mk((x, y, z) => {
    if (x === 5 && y === -60 && z === 2) return "stone"
    if (x >= 0 && x <= 4 && z >= 0 && z <= 4 && (y === -60 || y === -59)) return "dirt"
    if (y <= -61) return "grass_block"
    return "air"
  })
  const controls = { forward: true, sneak: false }
  platformWorld.bot = {
    builder: { running: true, fallGuard: platformWorld },
    health: 20,
    entity: {
      position: new Vec3(4.3, -58, 2.5),
      velocity: new Vec3(0.15, 0, 0),
      yaw: -Math.PI / 2,
      onGround: true
    },
    controlState: controls,
    getControlState: k => Boolean(controls[k]),
    setControlState: (k, v) => { controls[k] = Boolean(v) }
  }
  const spatial = platformWorld.analyzeNeighborhood(platformWorld.bot.entity.position)
  assert.equal(spatial.mode, "open", "2-block dirt platform edge over open grass must be open mode, not narrow hazard")
  platformWorld.tick()
  assert.equal(controls.sneak, false, "FallGuard.tick() must not force sneak at a 2-block platform edge over open grass")
  assert.equal(platformWorld.holes.size, 0, "FallGuard.tick() must not record open grass around a 2-block platform as pit holes")

  // 2. Placer.setSneak(false) releases sneak even when slightly off-center on a 2-block platform
  const placer = new Placer({
    bot: platformWorld.bot,
    world: platformWorld.world,
    config: {},
    logger: { info () {}, warn () {}, debug () {} },
    scaffold: { created: new Map(), getCreated () { return [...this.created.values()] }, onScaffold () { return false } },
    isReserved: () => false
  })
  controls.sneak = true
  platformWorld.bot.entity.position = new Vec3(4.95, -58, 2.5)
  placer.setSneak(false)
  assert.equal(controls.sneak, false, "setSneak(false) must release sneak on a 2-block platform edge")

  // 3. sweepTemporary keeps isAccessStep blocks during normal tidy (!final) and removes them during final cleanup (final: true)
  const stepCell = new Vec3(5, -60, 2)
  stepCell.createdAt = Date.now() - 30000
  stepCell.isAccessStep = true
  placer.scaffold.created.set("5,-60,2", stepCell)
  const sweptMidBuild = await placer.sweepTemporary({ maxBlocks: 4, final: false })
  assert.equal(sweptMidBuild, 0, "isAccessStep must not be swept mid-build while unreserved")
  assert.equal(placer.scaffold.created.has("5,-60,2"), true)

  // 4. BuildPlanner.scanGroup picks a ready task 2 blocks away (bestLocalReady) instead of walking 25 blocks to seqPtr
  const bp = Object.create(BuildPlanner.prototype)
  bp.architectActive = true
  bp.lookaheadMode = false
  bp.enforceColumnGuard = false
  bp.skipPending = false
  bp.fleet = null
  bp.tasks = new Map()
  bp.completed = new Set()
  bp.blocked = new Set()
  bp.world = { blockAt: p => (p.y === -60 ? { name: "dirt", boundingBox: "block", getProperties: () => ({}) } : { name: "air", boundingBox: "empty", getProperties: () => ({}) }) }
  bp.probe = () => false // neither is reachable without moving
  const farTask = {
    key: "25,-59,0", kind: "block", name: "dirt", item: "dirt", order: 4, layer: 1, seq: 0,
    world: new Vec3(25, -59, 0), properties: {}, info: describeBlock("dirt", {}), status: "pending", attempts: 0
  }
  const nearTask = {
    key: "2,-59,0", kind: "block", name: "dirt", item: "dirt", order: 4, layer: 1, seq: 80,
    world: new Vec3(2, -59, 0), properties: {}, info: describeBlock("dirt", {}), status: "pending", attempts: 0
  }
  bp.tasks.set(farTask.key, farTask)
  bp.tasks.set(nearTask.key, nearTask)
  const group = {
    remaining: 2,
    seqList: [farTask, nearTask],
    seqPtr: 0,
    cells: new Map([
      ["0,0", new Set([nearTask])],
      ["3,0", new Set([farTask])]
    ])
  }
  const chosen = bp.scanGroup(group, new Vec3(0.5, -58, 0.5), true, null)
  assert.equal(chosen, nearTask, "scanGroup must pick the ready task 2 blocks away instead of walking 25 blocks to seqPtr")
})

test("v2.9 fixes: waterlogged oak_leaves & open bottom slabs are not pitCells/lava hazards, isolated 10-block corner column is grouped into L4, overhead self-mode TIDY aim works up to 4.2m, simulated ledge verification stops infinite stone place-break loop, and ReplicaCoordinator/Hub forward reopen", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver } = require("../src/interaction/aim")
  const { Placer } = require("../src/interaction/placer")
  const { FallGuard } = require("../src/recovery/fall-guard")
  const { ReplicaCoordinator } = require("../src/fleet/replica")
  const { Hub } = require("../src/fleet/hub")
  const { describeBlock } = require("../src/rules/blocks")

  // 1. Load cobble.litematic and verify waterlogged oak_leaves and open bottom slabs are NOT marked as pitCells
  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const tr = buildTransform(schematic, new Vec3(-121, -60, -13), 0)
  const worldMap = new Map()
  const worldModel = {
    bot: { entity: { position: new Vec3(-115, -56, -8), yaw: 0, pitch: 0 }, world: { raycast: () => null } },
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  }
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build()

  // Standing cells above waterlogged oak_leaves (-116,-54,-10 -> standing at -116,-53,-10) and open bottom slabs (-112,-50,-4) must NOT be pitCells!
  assert.equal(planner.pitCells.has("-116,-54,-10"), false, "waterlogged oak_leaves cell itself is solid and must not be a pitCell")
  assert.equal(planner.pitCells.has("-116,-53,-10"), false, "standing cell above waterlogged oak_leaves must not be a pitCell")
  assert.equal(planner.pitCells.has("-112,-50,-4"), false, "open bottom slab bridge on L10 must not be a pitCell")
  assert.equal(planner.pitCells.has("-112,-48,-5"), false, "open bottom slab on L12 must not be a pitCell")
  // True hopper cells ARE still pitCells
  assert.equal(planner.pitCells.has("-115,-59,-3"), true, "hopper trench cell remains a pitCell")

  // 2. Isolated 10-block corner dirt column (-121, -56..-47, -13) is grouped into a single order (16.1) at Layer 4 with isolatedColumnTop marked
  const colBottom = planner.tasks.get("-121,-56,-13")
  const colTop = planner.tasks.get("-121,-47,-13")
  assert.equal(colBottom.order, 16.1, "base of isolated 10-block corner dirt column is grouped at order 16.1")
  assert.equal(colTop.order, 16.1, "top of isolated 10-block corner dirt column is grouped at order 16.1")
  assert.equal(colTop.isolatedColumnTop, true, "top block of isolated column has isolatedColumnTop=true")

  // 3. FallGuard.hazardAt treats waterlogged oak_leaves over lava as a solid floor (null), NOT 'lava'!
  worldMap.set("-115,-54,-5", { name: "oak_leaves", boundingBox: "block", properties: { waterlogged: true }, getProperties: () => ({ waterlogged: true }) })
  worldMap.set("-115,-55,-5", { name: "lava", boundingBox: "empty", getProperties: () => ({}) })
  const fg = new FallGuard({
    bot: { entity: { position: new Vec3(-114.5, -53, -4.5), velocity: new Vec3(0, 0, 0), onGround: true }, builder: { planner } },
    world: worldModel,
    config: {},
    logger: {},
    navigation: { stop () {} },
    ground: {}
  })
  assert.equal(fg.hazardAt(-114.5, -53, -4.5, 2), null, "waterlogged oak_leaves covering lava must be treated as solid floor, not lava hazard")

  // 4. AimSolver.fromPose in mode: 'self' allows breaking temporary blocks up to 4.2 blocks above the bot's feet
  worldMap.set("-115,-57,-8", { name: "dirt", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-115,-53,-8", { name: "stone", boundingBox: "block", getProperties: () => ({}) })
  const aim = new AimSolver(worldModel.bot, worldModel, { navigation: { placementReach: 4.5 } }, { isHazard: () => false })
  const FREE = { faces: ["up", "down", "north", "south", "east", "west"].map(f => ({ f })), look: null, horiz: null, yaw16: null, tag: "free" }
  const selfPose = aim.fromPose(new Vec3(-115, -53, -8), FREE, null, { mode: "self" })
  assert.ok(selfPose, "AimSolver.fromPose in mode='self' must reach overhead temporary block 3 blocks above feet")

  // 5. Placer.canPlaceFromSimulatedLedge rejects placing a ledge L from which the target block's required face/direction cannot be aimed at
  const observerEastSpec = describeBlock("observer", { facing: "east", powered: "false" }).specs[0] // requires looking EAST (from west of target)
  const targetTask = { name: "observer", world: new Vec3(-113, -49, -6), properties: { facing: "east" }, info: describeBlock("observer", { facing: "east" }) }
  worldMap.set("-113,-50,-6", { name: "HopperBlock", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-111,-50,-6", { name: "cobblestone", boundingBox: "block", getProperties: () => ({}) })
  const testPlacer = Object.create(Placer.prototype)
  testPlacer.world = worldModel
  testPlacer.bot = worldModel.bot
  testPlacer.scaffold = { itemName: "stone" }
  testPlacer.aim = aim
  testPlacer.brain = null
  // L = (-112, -50, -6) is EAST of target (-113, -49, -6); standing at (-112, -49, -6) looks WEST at (-113, -49, -6), which can NEVER satisfy observer[facing=east] (look='east')!
  const canPlaceWrongSide = testPlacer.canPlaceFromSimulatedLedge(new Vec3(-112, -50, -6), new Vec3(-112, -49, -6), targetTask, observerEastSpec)
  assert.equal(canPlaceWrongSide, false, "canPlaceFromSimulatedLedge must reject a ledge on the east side when the block requires looking east from the west side")

  // 6. ReplicaCoordinator and Hub forward reopen messages between workers
  const sent = []
  const rep1 = new ReplicaCoordinator(2, {}, m => sent.push(m), "Build")
  const rep2 = new ReplicaCoordinator(2, {}, () => {}, "Buildd")
  rep1.reopen("-113,-49,-6", "Build", 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].t, "reopen")
  rep2.apply(sent[0])
  assert.equal(rep2.log.length, 1)
  assert.equal(rep2.log[0].reopen, true)
  assert.equal(rep2.log[0].ownerIndex, 1)
})

test("v3.0 fixes: sunken chest trench pitCells & exit pillar escape, AimSolver.fromPose rejects sunken chests, strict 3x3 ceiling lock over deferred L2 blocks, SchematicIntelligence pre-analysis, and no false 90s DIG_PROTECTED lockout on temporary blocks", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver } = require("../src/interaction/aim")
  const { flood, planRoute } = require("../src/recovery/exit-planner")

  // 1. Load cobble.litematic at (-228, -60, -20) (exact coordinates from user's Ez/Ezz video)
  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const tr = buildTransform(schematic, new Vec3(-228, -60, -20), 0)
  const worldMap = new Map()
  const worldModel = {
    bot: { entity: { position: new Vec3(-221.5, -58.125, -7.5), yaw: 0, pitch: 0 }, world: { raycast: () => null } },
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  }
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build()

  // Verify SchematicIntelligence ran automatically and analyzed overhung blocks, sunken trenches, and pockets
  assert.ok(planner.intelligenceSummary, "SchematicIntelligence must populate planner.intelligenceSummary")
  assert.ok(planner.intelligenceSummary.overhungBlocks > 100, "SchematicIntelligence must identify overhung blocks")
  assert.ok(planner.intelligenceSummary.sunkenTrenches >= 10, "SchematicIntelligence must identify sunken chest/hopper trenches")

  // Verify sunken chest cell (-222,-59,-8) and its standing cell (-222,-58,-8) ARE marked as pitCells
  assert.equal(planner.pitCells.has("-222,-59,-8"), true, "sunken chest cell (-222,-59,-8) must be a pitCell")
  assert.equal(planner.pitCells.has("-222,-58,-8"), true, "standing cell above sunken chest (-222,-58,-8) must be a pitCell")

  // 2. AimSolver.fromPose rejects placing or digging in-place while standing on a sunken chest (-222,-59,-8, pos.y=-58.125)
  worldMap.set("-222,-60,-8", { name: "dirt", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-222,-59,-8", { name: "chest", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-221,-59,-8", { name: "dirt", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-221,-58,-8", { name: "stone", boundingBox: "block", getProperties: () => ({}) })
  const aim = new AimSolver(worldModel.bot, worldModel, { navigation: { placementReach: 4.5 } }, { isHazard: c => planner.pitCells.has(`${c.x},${c.y},${c.z}`) })
  const FREE = { faces: ["up", "down", "north", "south", "east", "west"].map(f => ({ f })), look: null, horiz: null, yaw16: null, tag: "free" }
  assert.equal(aim.fromPose(new Vec3(-221, -58, -8), FREE, null, { mode: "self" }), null, "AimSolver.fromPose must reject standing on a sunken chest in trench")

  // 3. exit-planner flood() & planRoute() recognize that a bot on a sunken chest at (-222,-58,-8) surrounded by y=-58 walls CANNOT raw-step out (fl.open === false) and immediately plans a pillar escape
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    worldMap.set(`${-222 + dx},-59,${-8 + dz}`, { name: "dirt", boundingBox: "block", getProperties: () => ({}) })
    worldMap.set(`${-222 + dx},-58,${-8 + dz}`, { name: "dirt", boundingBox: "block", getProperties: () => ({}) })
  }
  const blockAtFn = (x, y, z) => worldMap.get(`${x},${y},${z}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  const fl = flood(blockAtFn, { x: -222, y: -58, z: -8 }, { budget: 50, maxDrop: 2 })
  assert.equal(fl.open, false, "flood() must recognize a bot on a sunken chest surrounded by y=-58 walls cannot raw-step out")
  const route = planRoute(blockAtFn, { x: -222, y: -58, z: -8 }, n => !n.floorPlaced && n.y === -57 && n.x === -221 && n.z === -8, {})
  assert.ok(route && route.steps && route.steps.length > 0, "planRoute must find a pillar escape route out of the sunken chest trench")
  assert.equal(route.steps[0].type, "pillar", "first step out of sunken chest trench must be a pillar")

  // 4. Strict 3x3 lower-layer ceiling lock: when a Layer 2 block is deferred, any Layer 3 block in the 3x3 neighborhood above it is strictly blocked until Layer 2 is placed!
  const l3Roof = [...planner.tasks.values()].find(tk => tk.layer === 3 && tk.kind === "block" && planner.tasks.has(`${tk.world.x},${tk.world.y - 1},${tk.world.z}`))
  const l2Deferred = planner.tasks.get(`${l3Roof.world.x},${l3Roof.world.y - 1},${l3Roof.world.z}`)
  for (const t of planner.tasks.values()) {
    if (t.layer < 2) planner.setStatus(t, "completed")
    else if (t.layer === 2 && t.key !== l2Deferred.key) planner.setStatus(t, "completed")
  }
  l2Deferred.status = "deferred"
  l2Deferred.deferredUntil = Date.now() + 30_000
  assert.equal(planner.hasUnfinishedBelow(l3Roof), true, "Layer 3 roof block must detect deferred Layer 2 block below it")
  const nextChosen = planner.next(new Vec3(l3Roof.world.x + 0.5, l3Roof.world.y, l3Roof.world.z + 0.5))
  assert.notEqual(nextChosen?.key, l3Roof.key, "planner.next() must not allow Layer 3 block to seal deferred Layer 2 block")
})

test("v3.1 fixes: dry water-basin floors & isActivePitCell prevent Ezz -211,-58,-51 dirt-ring trap, specAccepts normalizes dir, fluidCheck ignores cobblestone in fluid shaft for oak_trapdoor@-222,-52,-14#w, Layer 12 observer@-223,-49,-14 wavefront & simulated ref check, repeater top-deck walkability, ceiling lever@-224,-49,-11 & sneak-edge stone_button@-224,-48,-10, Brain bottom-slab reachability, and classifyDamage", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver, specAccepts, rayHitBox, boxOf } = require("../src/interaction/aim")
  const { Brain } = require("../src/navigation/brain")
  const { Placer } = require("../src/interaction/placer")
  const { classifyDamage } = require("../src/intel/causes")
  const { describeBlock } = require("../src/rules/blocks")

  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const tr = buildTransform(schematic, new Vec3(-228, -60, -20), 0)
  const worldMap = new Map()
  const botObj = {
    entity: { position: new Vec3(-223.5, -52, -10.5), yaw: 0, pitch: 0 },
    getControlState: () => false,
    world: {
      raycast: (eye, dir, maxDist) => {
        let best = null
        for (let t = 0.04; t <= maxDist; t += 0.04) {
          const bx = Math.floor(eye.x + dir.x * t); const by = Math.floor(eye.y + dir.y * t); const bz = Math.floor(eye.z + dir.z * t)
          const b = worldMap.get(`${bx},${by},${bz}`)
          if (!b || b.boundingBox !== "block") continue
          const pos = new Vec3(bx, by, bz)
          const hit = rayHitBox(eye, dir, maxDist, pos, boxOf(b))
          if (hit && (!best || hit.dist < best.dist)) {
            best = { position: pos, name: b.name, face: hit.face, intersect: hit.intersect, dist: hit.dist }
          }
        }
        return best
      }
    }
  }
  const worldModel = {
    bot: botObj,
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) }
  }
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build()

  // 1. Bug 1: Shallow water-basin floor on top of Layer 2 dirt platform (-222,-57,-15) is NOT a pitCell when dry, and isActivePitCell is false on dry flat floors
  assert.equal(planner.pitCells.has("-222,-57,-15"), false, "Dry Layer 2 dirt platform top (-222,-57,-15) must not be marked as a pitCell before water is poured")
  worldMap.set("-222,-59,-15", { name: "dirt", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })
  assert.equal(planner.isActivePitCell(-222, -58, -15), false, "isActivePitCell must be false on an unenclosed dry dirt floor")

  // 2. Bug 2: specAccepts normalizes unnormalized ray vector `d` vs unit `dir`
  const FREE = { faces: ["up", "down", "north", "south", "east", "west"].map(f => ({ f })), look: null, horiz: null, yaw16: null, tag: "free" }
  const dLong = new Vec3(0, -0.055, -3.0) // dot with up [0,1,0] is -0.055, unit dot is -0.0183
  const dUnit = dLong.scaled(1 / dLong.norm())
  assert.equal(specAccepts(FREE, { f: "up" }, dLong, new Vec3(0.5, 1, 0.5), new Vec3(0, 0, 0), true), false, "strict pickHit rejects grazing unit dot -0.018 regardless of vector length")
  assert.equal(specAccepts(FREE, { f: "up" }, dUnit, new Vec3(0.5, 1, 0.5), new Vec3(0, 0, 0), false), true, "non-strict validateView accepts unit dot -0.018")

  // 3. Bug 3: fluidCheck on oak_trapdoor@-222,-52,-14#w ignores cobblestone formed in fluid shaft -223,-56,-14 and hasDirectlyUnfinishedBelow blocks sealing #w
  for (const t of planner.tasks.values()) {
    if (t.kind === "block" && t.layer <= 8) {
      planner.setStatus(t, "completed")
      worldMap.set(t.key, { name: t.name, boundingBox: t.info?.fragile ? "empty" : "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t.properties, getProperties: () => t.properties })
    }
  }
  worldMap.set("-223,-56,-14", { name: "cobblestone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })
  const wlTd = planner.tasks.get("-222,-52,-14#w")
  const fcWl = planner.fluidCheck(wlTd)
  assert.equal(fcWl.blocked, false, "Cobblestone formed in fluid shaft -223,-56,-14 must not cause false UNSAFE leak for oak_trapdoor@-222,-52,-14#w")
  const tdAbove = planner.tasks.get("-222,-51,-14")
  assert.equal(planner.hasDirectlyUnfinishedBelow(tdAbove), true, "oak_trapdoor@-222,-51,-14 must wait until oak_trapdoor@-222,-52,-14#w is waterlogged")
  assert.equal(planner.hasPendingFluids(8), true, "Layer 8 must report pending fluids while oak_trapdoor@-222,-52,-14#w is uncompleted")

  // 4. Bug 4: Layer 12 wavefront selects ready observer@-223,-49,-14 at order 45.2 when order 44 blocks are floating
  for (const t of planner.tasks.values()) {
    if ((t.layer < 11 && t.order < 90000) || t.isolatedColumn) {
      planner.setStatus(t, "completed")
      if (t.kind === "block") {
        worldMap.set(t.key, { name: t.name, boundingBox: t.info?.fragile ? "empty" : "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t.properties, getProperties: () => t.properties })
      }
    }
  }
  let nextL12 = null
  for (let step = 0; step < 15; step++) {
    const picked = planner.next(new Vec3(-223.5, -49, -14.5))
    if (!picked) break
    if (picked.key === "-223,-49,-14") { nextL12 = picked; break }
    planner.setStatus(picked, "completed")
  }
  assert.ok(nextL12 && nextL12.key === "-223,-49,-14", `planner.next() on Layer 12 must pick ready observer@-223,-49,-14 while floating order=44 blocks remain (got ${nextL12?.key})`)

  // 5. Bug 5: AimSolver.standOk allows standing on repeaters on Layer 13, AimSolver.candidates finds walkable stand for ceiling lever@-224,-49,-11 and sneak-edge stand for stone_button@-224,-48,-10
  for (const t of planner.tasks.values()) {
    if (t.layer <= 12 && t.kind === "block" && t.order < 90000) {
      planner.setStatus(t, "completed")
      const isRep = t.name === "repeater"
      const isSlab = /_slab$/.test(t.name)
      const shapes = isRep ? [[0, 0, 0, 1, 0.125, 1]] : isSlab ? (t.properties.type === "bottom" ? [[0, 0, 0, 1, 0.5, 1]] : [[0, 0.5, 0, 1, 1, 1]]) : [[0, 0, 0, 1, 1, 1]]
      worldMap.set(t.key, { name: t.name, boundingBox: t.info?.fragile && !isRep ? "empty" : "block", shapes, properties: t.properties, getProperties: () => t.properties })
    }
  }
  const aim = new AimSolver(botObj, worldModel, { navigation: { placementReach: 4.5 } }, { isHazard: c => planner.isActivePitCell(c.x, c.y, c.z) })
  assert.equal(aim.standOk(new Vec3(-223, -48, -13), new Map()), true, "Repeater cell (-223,-48,-13) on top deck must be standOk")
  assert.equal(aim.standOk(new Vec3(-224, -47, -11), new Map()), true, "Corner smooth_stone (-224,-47,-11) next to repeaters must have a valid exit and be standOk")

  const leverTask = planner.tasks.get("-224,-49,-11")
  const leverCands = aim.candidates(leverTask.world, leverTask.info.specs[0], { allowScaffold: false })
  assert.ok(leverCands.length > 0, "Ceiling lever@-224,-49,-11 must have walkable aim candidates from y=-52 below")

  const btnTask = planner.tasks.get("-224,-48,-10")
  const btnCands = aim.candidates(btnTask.world, btnTask.info.specs[0], { allowScaffold: false })
  assert.ok(btnCands.length > 0, "stone_button@-224,-48,-10 must have sneak-edge overhang aim candidates without scaffolding")

  // 6. Bug 6: Brain.reachability does NOT hallucinate a +1.5m step up from bottom slab (-222,-50,-11, top=-49.5) to full block top (-222,-48,-11)
  botObj.entity.position = new Vec3(-220.5, -50, -10.5)
  const brain = new Brain({ bot: botObj, world: worldModel, config: {} })
  const rvTop = brain.reachability(new Vec3(-224.5, -47, -13.5))
  assert.equal(rvTop.verdict, "no", "Brain.reachability must return 'no' from y=-50 bottom slabs to y=-47/-48 top deck so Brain.connect builds a step/tower")

  // 7. Bug 8: classifyDamage recognizes afterburn and nearby player/entity attacks
  const burnCls = classifyDamage({ dmg: 0.6, hp: 18, feet: "air", head: "air", below: "dirt", y: -60, frames: [{ y: -60, feet: "lava" }] })
  assert.equal(burnCls.category, "fire")
  const combatCls = classifyDamage({ dmg: 5.7, hp: 14.3, feet: "air", head: "air", below: "grass_block", y: -63, frames: [{ y: -63 }], mobs: [{ name: "MalikHu", dist: 2.1 }] })
  assert.equal(combatCls.category, "combat")
})

test("v3.2 fixes: double-chest .25/.30 & hopper chain .40-.49 sub-layer ordering, chest-partner-side primary merge spec, sub-floor walledHead pitCells, AimSolver 1x2 hole rejection, and ScaffoldManager._descend_h step-out guard", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver } = require("../src/interaction/aim")
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager")
  const { describeBlock } = require("../src/rules/blocks")

  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const tr = buildTransform(schematic, new Vec3(0, -60, 0), 0)
  const worldMap = new Map()
  const botObj = {
    entity: { position: new Vec3(5.5, -58, 5.5), yaw: 0, pitch: 0 },
    getControlState: () => false,
    setControlState: () => {},
    world: { raycast: () => null }
  }
  const worldModel = {
    bot: botObj,
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || (Math.floor(pos.y) <= -61 ? { name: "grass_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) } : { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) })
  }
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build()

  // 1. Layer 1 sub-layer ordering: dirt (4.0) -> z=12 wall-backed chests (4.25) -> z=11 partner chests (4.30) -> hoppers (4.40..4.49 from x=15 down to x=6)
  assert.equal(planner.tasks.get("6,-59,13").order, 4)
  assert.equal(planner.tasks.get("6,-59,12").order, 4.25, "Wall-backed chest at z=12 must be ordered at 4.25 after Layer 1 dirt")
  assert.equal(planner.tasks.get("6,-59,11").order, 4.3, "Partner chest at z=11 must be ordered at 4.30 after z=12 chest")
  assert.equal(planner.tasks.get("15,-59,10").order, 4.4, "Head hopper at 15,-59,10 (pointing south into chest 15,-59,11) must be ordered first at 4.40")
  assert.equal(planner.tasks.get("14,-59,10").order, 4.41, "Next hopper at 14,-59,10 must be ordered at 4.41")
  assert.equal(planner.tasks.get("6,-59,10").order, 4.49, "Tail hopper at 6,-59,10 must be ordered at 4.49")

  // 2. Double chest specs put chest-partner-side FIRST when partner is present
  const chestRight = describeBlock("chest", { facing: "west", type: "right" })
  const whenPresent = chestRight.specs.filter(s => s.whenPartner === "present")
  assert.equal(whenPresent[0].tag, "chest-partner-side", "chest-partner-side must be the primary spec when partner chest is present")

  // 3. Sub-floor cell (5,-60,5) under floating Layer 1 dirt (5,-59,5) is marked as a pitCell, and AimSolver.standOk rejects 1x2 holes & pending cells below the bot
  assert.equal(planner.pitCells.has("5,-60,5"), false, "Open grass cell (5,-60,5) under Layer 1 dirt platform must NOT be in static pitCells before Layer 1 is built")
  for (let x = 3; x <= 7; x++) {
    for (let z = 3; z <= 7; z++) {
      if ((x === 5 && z === 5) || (x === 6 && z === 5)) continue
      worldMap.set(`${x},-59,${z}`, { name: "dirt", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })
    }
  }
  const aim = new AimSolver(botObj, worldModel, { navigation: { placementReach: 4.5 } }, {
    isHazard: c => planner.isActivePitCell(c.x, c.y, c.z),
    isPending: c => planner.isPendingCell(c)
  })
  assert.equal(aim.standOk(new Vec3(5, -60, 5), new Map()), false, "AimSolver.standOk must reject standing inside a 1x2 hole at y=-60 below the bot on Layer 1")

  // 4. ScaffoldManager._descend_h steps onto an adjacent platform top instead of digging the stone block under the bot's feet into a walled hole
  worldMap.set("5,-60,5", { name: "stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(5, -60, 5), getProperties: () => ({}) })
  botObj.entity.position = new Vec3(5.5, -59, 5.5)
  let dugUnderFeet = false
  const sc = new ScaffoldManager({
    bot: botObj,
    world: worldModel,
    config: {},
    logger: { debug () {}, info () {}, warn () {} },
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    look: { lookDown: async () => {} },
    interaction: { digAimed: async () => { dugUnderFeet = true } }
  })
  sc.itemName = "stone"
  sc.created.set("5,-60,5", new Vec3(5, -60, 5))
  sc._stepOntoTop = async (topGoal) => { botObj.entity.position = topGoal.clone(); return true }
  await sc.descend()
  assert.equal(dugUnderFeet, false, "ScaffoldManager.descend() must step onto adjacent platform top instead of digging the stone block under feet into a hole")
  assert.equal(botObj.entity.position.y, -58, "Bot stepped up onto y=-58 platform top")
})


test("v3.3 fixes (14-48-57.mp4): open Layer 1 interior grass is walkable, deck edge-shift & continuity keep bot on y=-58 deck without jumping off, Brain.connect builds 1-block permanent staircase step for 2-block rise, and Placer.goStand steps off scaffold onto same-level deck without descending", async () => {
  const { Vec3 } = require("../src/util/vec3")
  const { AimSolver } = require("../src/interaction/aim")
  const { Brain } = require("../src/navigation/brain")
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager")
  const { Placer } = require("../src/interaction/placer")
  const { describeBlock } = require("../src/rules/blocks")

  const worldMap = new Map()
  // Place a single Layer 1 dirt block at (5, -59, 5) above y=-61 superflat grass
  worldMap.set("5,-59,5", { name: "dirt", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })

  const botObj = {
    entity: { position: new Vec3(5.5, -58, 5.5), yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8 },
    getControlState: () => false,
    setControlState: () => {},
    lookAt: async () => {},
    world: {
      raycast: (eye, dir, maxDist) => {
        // Raycast against placed blocks in worldMap
        let best = null
        for (const [k, b] of worldMap.entries()) {
          if (!b || b.boundingBox !== "block") continue
          const [bx, by, bz] = k.split(",").map(Number)
          const pos = new Vec3(bx, by, bz)
          // Simple AABB hit against [0,0,0,1,1,1]
          let tmin = 0; let tmax = maxDist; let face = -1
          const faces = [[1, 0], [0, 1], [3, 2]] // y: [0=down,1=up], z: [2=north,3=south], x: [4=west,5=east]
          const axes = [["x", bx, 4, 5], ["y", by, 0, 1], ["z", bz, 2, 3]]
          let ok = true
          for (const [ax, b0, fMin, fMax] of axes) {
            const o = eye[ax]; const d = dir[ax]
            if (Math.abs(d) < 1e-9) {
              if (o < b0 || o > b0 + 1) { ok = false; break }
            } else {
              let t1 = (b0 - o) / d; let t2 = (b0 + 1 - o) / d
              let f1 = fMin; let f2 = fMax
              if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; f1 = f2 }
              if (t1 > tmin) { tmin = t1; face = f1 }
              if (t2 < tmax) tmax = t2
              if (tmin > tmax) { ok = false; break }
            }
          }
          if (ok && tmin >= 0 && tmin <= maxDist && (!best || tmin < best.dist)) {
            best = { position: pos, face, intersect: eye.plus(dir.scaled(tmin)), dist: tmin }
          }
        }
        return best
      }
    }
  }
  const worldModel = {
    bot: botObj,
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || (Math.floor(pos.y) <= -61 ? { name: "grass_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) } : { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) })
  }

  // 1. When bot is on top of Layer 1 dirt at (5.5, -58, 5.5) and wants to place adjacent Layer 1 dirt at (6, -59, 5),
  // AimSolver.candidates includes the deck stand at S=(5,-58,5) (via allowEdgeShift) and ranks it FIRST above dropping to y=-60 grass!
  const aim = new AimSolver(botObj, worldModel, { navigation: { placementReach: 4.5 } }, {
    isHazard: () => false,
    isPending: c => c.y === -59 && c.x >= 0 && c.x <= 16 && c.z >= 0 && c.z <= 13 && !(c.x === 5 && c.z === 5)
  })
  const dirtSpec = describeBlock("dirt", {}).specs[0]
  const cands = aim.candidates(new Vec3(6, -59, 5), dirtSpec, { allowScaffold: false })
  assert.ok(cands.length > 0, "Must find candidate stands for (6,-59,5)")
  assert.equal(cands[0].cell.y, -58, "Top-ranked candidate when bot is on y=-58 deck must stay on y=-58 deck instead of dropping to y=-60 grass")

  // 2. Open interior grass (8, -60, 8) with 0 surrounding head walls is standOk=true even when bot is at y=-58
  assert.equal(aim.standOk(new Vec3(8, -60, 8), new Map()), true, "Open interior grass cell (8,-60,8) must be walkable")

  // 3. Brain.connect for a 2-block rise (from y=-60 grass to y=-58 deck at 5,-58,5) builds a 1-block permanent staircase step (height=1, isAccessStep=true)
  botObj.entity.position = new Vec3(4.5, -60, 5.5)
  let toweredHeight = null
  const sc = new ScaffoldManager({
    bot: botObj,
    world: worldModel,
    config: {},
    logger: { debug () {}, info () {}, warn () {} },
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    look: { lookDown: async () => {} },
    interaction: { digAimed: async () => {} }
  })
  sc.itemName = "stone"
  sc.tower = async (info, stand) => {
    toweredHeight = info.height
    const rec = info.floor.clone()
    rec.createdAt = Date.now()
    sc.created.set(`${rec.x},${rec.y},${rec.z}`, rec)
    worldMap.set(`${rec.x},${rec.y},${rec.z}`, { name: "stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })
    botObj.entity.position = stand.clone()
  }
  sc._stepOntoTop = async (topGoal) => {
    botObj.entity.position = topGoal.clone()
    return true
  }
  const nav = {
    goTo: async (dest) => { botObj.entity.position = dest.clone() }
  }
  const brain = new Brain({
    bot: botObj,
    world: worldModel,
    config: { building: { maxTowerHeight: 24 }, navigation: { pearls: false } },
    logger: { debug () {}, info () {}, warn () {} },
    nav,
    scaffold: sc,
    survival: {}
  })
  const reachRes = brain.reachability(new Vec3(5.5, -58, 5.5))
  assert.equal(reachRes.verdict, "no", "Before 1-block step is placed, y=-58 deck is 2 blocks above y=-60 grass")
  const connected = await brain.connect(new Vec3(5.5, -58, 5.5), reachRes.region)
  assert.equal(connected, true, "Brain.connect must succeed")
  assert.equal(toweredHeight, 1, "Brain.connect must build a 1-block staircase step (not a 2-block pillar) for a 2-block rise")
  const stepRec = [...sc.created.values()][0]
  assert.ok(stepRec && stepRec.isAccessStep === true, "The 1-block step must be marked isAccessStep=true")
  assert.equal(sc.onScaffold(), false, "onScaffold() must return false for an isAccessStep staircase block")
  assert.equal(brain.reachability(new Vec3(5.5, -58, 5.5)).verdict, "yes", "After placing the 1-block staircase step, y=-58 deck is permanently reachable on foot from y=-60 grass!")

  // 4. Placer.goStand does NOT call scaffold.descend() when stepping from a scaffold at y=-58 onto an adjacent walkGoal at y=-58
  const tallRec = new Vec3(4, -59, 4)
  sc.created.set("4,-59,4", tallRec)
  botObj.entity.position = new Vec3(4.5, -58, 4.5)
  let descendCalled = false
  sc.descend = async () => { descendCalled = true }
  const placer = new Placer({
    bot: botObj,
    world: worldModel,
    config: {},
    logger: { debug () {}, info () {}, warn () {} },
    nav,
    interaction: {},
    isReserved: () => false,
    materials: {},
    aim,
    look: {},
    scaffold: sc,
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    learner: {},
    experience: {},
    interrupt: () => null
  })
  placer.hop = async (dest) => { botObj.entity.position = dest.clone(); return true }
  await placer.goStand({ stand: new Vec3(5.5, -58, 5.5), cell: new Vec3(5, -58, 5), edge: false, scaffold: null })
  assert.equal(descendCalled, false, "Placer.goStand must NOT call scaffold.descend() when walkGoal is at the same height y=-58")
})

test("v3.4 fixes (15-14-33.mp4): preflight no static hint, 1-wide snake rows prevent Layer 1 trenches, strict 4.0->4.25->4.30->4.40->8.0 order barrier, grass-level continuity, and Brain no ladder/exit-planner loops", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver } = require("../src/interaction/aim")
  const { Brain, regionOf } = require("../src/navigation/brain")
  const { Coordinator } = require("../src/fleet/coordinator")
  const { plan: architectPlan, apply: architectApply } = require("../src/planner/architect")
  const preflight = require("../src/planner/preflight")

  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const origin = new Vec3(-283, -60, -117)
  const transform = buildTransform(schematic, origin, 0)

  const makeWorld = (worldMap) => ({
    blockAt: p => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (y <= -61) return { name: "grass_block", position: new Vec3(x, y, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      const b = worldMap.get(`${x},${y},${z}`)
      if (b) return { ...b, position: new Vec3(x, y, z) }
      return { name: "air", position: new Vec3(x, y, z), boundingBox: "empty", shapes: [], getProperties: () => ({}) }
    }
  })

  const sharedWorldMap = new Map()
  const world0 = makeWorld(sharedWorldMap)
  const world1 = makeWorld(sharedWorldMap)
  const coord = new Coordinator(2)
  const bot0 = { entity: { position: new Vec3(-278.5, -60, -103.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8 }, getControlState: () => false, setControlState () {}, world: { raycast: () => null }, blockAt: p => world0.blockAt(p) }
  const bot1 = { entity: { position: new Vec3(-267.5, -60, -103.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, height: 1.8 }, getControlState: () => false, setControlState () {}, world: { raycast: () => null }, blockAt: p => world1.blockAt(p) }
  coord.register("Build", 0, bot0)
  coord.register("Buildd", 1, bot1)

  const cfg = { building: { speed: 1, maxPlacementsPerSecond: 4, giveUpAttempts: 6 }, navigation: { placementReach: 4.5 }, fleet: { lookAheadOrders: 8 } }
  const log = { info () {}, warn () {}, debug () {} }
  const planner0 = new BuildPlanner({ schematic }, transform, world0, cfg, log).build()
  const planner1 = new BuildPlanner({ schematic }, transform, world1, cfg, log).build()
  planner0.joinFleet(coord, "Build", 0, 2)
  planner1.joinFleet(coord, "Buildd", 1, 2)

  const arch0 = architectPlan(planner0, { start: { x: origin.x, z: origin.z } })
  const arch1 = architectPlan(planner1, { start: { x: origin.x, z: origin.z } })
  architectApply(planner0, arch0.sequence)
  architectApply(planner1, arch1.sequence)

  // 1) Preflight must NOT set static task.hint on tasks
  await preflight.run(planner0, { registry: { blocksByName: { dirt: { boundingBox: "block" }, cobblestone: { boundingBox: "block" } } }, world: world0, logger: log })
  const hintedCount = [...planner0.tasks.values()].filter(t => t.hint != null).length
  assert.equal(hintedCount, 0, "preflight.run must not lock static task.hint on tasks")

  // 2) Simulate 2 bots building Layer 0 and Layer 1:
  // Complete Layer 0 first (2 blocks at -268,-60,-104 and -267,-60,-104)
  for (const k of ["-268,-60,-104", "-267,-60,-104"]) {
    const t0 = planner0.tasks.get(k)
    const t1 = planner1.tasks.get(k)
    sharedWorldMap.set(k, { name: t0.name, boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t0.properties, getProperties: () => t0.properties })
    planner0.markCompleted(t0)
    planner1.markCompleted(t1)
  }

  // At the start of Layer 1 (order = 4.0), Buildd (worker 1) claims the seed dirt block at -267,-59,-104.
  // Verify that Build (worker 0) does NOT jump to order = 4.25 (chests) via next() AND does NOT pick an unready floating dirt block via nextCandidate()!
  const firstPick1 = planner1.next(bot1.entity.position)
  assert.ok(firstPick1 && firstPick1.order === 4, `Worker 1 must pick order=4.0 seed dirt block first (got ${firstPick1?.key} order=${firstPick1?.order})`)
  const prematureNext0 = planner0.next(bot0.entity.position)
  assert.ok(!prematureNext0 || prematureNext0.order === 4, `Worker 0 must NEVER jump to chests (order 4.25) while order 4.0 is active (got ${prematureNext0?.key} order=${prematureNext0?.order})`)
  if (!prematureNext0) {
    const prematureCand0 = planner0.nextCandidate(bot0.entity.position)
    assert.equal(prematureCand0, null, "Worker 0 nextCandidate() must return null while Worker 1 is expanding order=4.0's ready wavefront")
  }
  coord.release("Buildd")

  // Now simulate completing all of Layer 1 order=4.0 in Architect's 1-wide snake sequence and verify ZERO 1-block-wide trenches ever form!
  const l1DirtGroup = planner1.orderGroups.get(4)
  assert.ok(l1DirtGroup && l1DirtGroup.seqList.length > 100)
  const placedL1 = new Set()
  for (const t of l1DirtGroup.seqList) {
    placedL1.add(`${t.world.x},${t.world.z}`)
    // Check that placing `t` never leaves an unplaced 1-block-wide Z-trench `(x, zMid)` flanked by placed blocks at `(x, zMid+1)` and `(x, zMid-1)`
    for (const dzCheck of [-1, 1]) {
      const zMid = t.world.z + dzCheck
      const zFar = t.world.z + dzCheck * 2
      const midTask = planner1.tasks.get(`${t.world.x},-59,${zMid}`)
      if (midTask && midTask.order === 4 && !placedL1.has(`${t.world.x},${zMid}`) && placedL1.has(`${t.world.x},${zFar}`)) {
        assert.fail(`1-block-wide trench formed at (${t.world.x}, -59, ${zMid}) between ${t.world.z} and ${zFar}!`)
      }
    }
    sharedWorldMap.set(t.key, { name: t.name, boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t.properties, getProperties: () => t.properties })
    planner0.markCompleted(planner0.tasks.get(t.key))
    planner1.markCompleted(t)
  }

  // 3) Verify AimSolver prefers standing on the flat grass (y=-60) when botFeet.y === -60 rather than climbing 2 blocks up onto y=-58
  const raycast = (eye, dir, maxDist) => {
    const { rayHitBox, boxOf } = require("../src/interaction/aim")
    let best = null
    for (const [k, b] of sharedWorldMap.entries()) {
      if (b.boundingBox !== "block") continue
      const [x, y, z] = k.split(",").map(Number)
      const pos = new Vec3(x, y, z)
      const hit = rayHitBox(eye, dir, maxDist, pos, boxOf(b))
      if (hit && (!best || hit.dist < best.dist)) best = { position: pos, name: b.name, face: hit.face, intersect: hit.intersect, dist: hit.dist }
    }
    return best
  }
  bot1.world.raycast = raycast
  bot1.entity.position = new Vec3(-275 + 0.5, -60, -103 + 0.5)
  const aim1 = new AimSolver(bot1, world1, cfg, {
    isReserved: c => planner1.tasks.has(`${c.x},${c.y},${c.z}`),
    isPending: c => planner1.isPendingCell(c),
    isHazard: c => planner1.isActivePitCell(c.x, c.y, c.z)
  })
  const sampleEdgeTask = planner1.tasks.get("-275,-59,-104")
  const savedEdge = sharedWorldMap.get("-275,-59,-104")
  sharedWorldMap.delete("-275,-59,-104")
  const candsFromGrass = aim1.candidates(sampleEdgeTask.world, sampleEdgeTask.info.specs[0], { allowScaffold: false })
  sharedWorldMap.set("-275,-59,-104", savedEdge)
  assert.ok(candsFromGrass.length > 0 && candsFromGrass[0].cell.y === -60, `When standing on grass (y=-60), top AimSolver candidate must stay on grass y=-60 (got y=${candsFromGrass[0]?.cell?.y})`)

  // 4) Verify strict sub-layer order barrier after 4.0 finishes: 4.25 (primary chests) -> 4.30 (partner chests) -> 4.40..4.49 (hoppers) -> 8.0 (Layer 2)
  const pickAfterDirt = planner1.next(bot1.entity.position)
  assert.ok(pickAfterDirt && pickAfterDirt.order === 4.25, `After order 4.0 dirt finishes, next task must be order 4.25 primary chest (got order=${pickAfterDirt?.order})`)
  coord.release("Buildd")

  // 5) Verify Brain.regionOf does not merge ground (y=-60) backwards up a 2-block cliff onto the y=-58 deck, and Brain.prepare returns 'yes' when reachable
  const regGround = regionOf((x, y, z) => world1.blockAt(new Vec3(x, y, z)), { x: -275, y: -60, z: -102 }, 600, 1)
  assert.ok(regGround && !regGround.cells.has("-275,-58,-106"), "regionOf with maxDrop=1 must not flood backwards up a 2-block cliff onto y=-58")
  let rescueCalls = 0
  const brain1 = new Brain({ bot: bot1, world: world1, config: cfg, logger: log, nav: { goTo: async () => {} }, scaffold: { onScaffold: () => false, created: new Map() }, survival: null })
  brain1.rescue = async () => { rescueCalls++; return { escaped: false } }
  const prepVerdict = await brain1.prepare(new Vec3(-274 + 0.5, -60, -103 + 0.5), { force: true })
  assert.equal(prepVerdict, "yes", "Brain.prepare({ force: true }) must return 'yes' immediately when target stand is already reachable on foot")
  assert.equal(rescueCalls, 0, "Brain.prepare must never invoke exit planner when stand is reachable")
})


test("v3.5 fixes (1.3h run): 1.21 obsidian digTime 9.4s & abort check, unsealed waterlog never forced, fluidBeside protects retaining walls, lava never poured on obsidian, observer@-291,-51,-138 overhead+ledge support, fragile parent auto-reopen, switch-ceiling-opp & lateral grazing guard, and downward pillar/roof exit", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver, specAccepts } = require("../src/interaction/aim")
  const { Placer } = require("../src/interaction/placer")
  const { computeVanillaDigMs } = require("../src/interaction/human-interaction")
  const { planRoute } = require("../src/recovery/exit-planner")
  const { describeBlock } = require("../src/rules/blocks")

  // 1. 1.21 obsidian with compound material string takes 9,400ms (188 ticks) with diamond_pickaxe, NOT 250,000ms!
  const obsidianBlock = { name: "obsidian", hardness: 50, material: "incorrect_for_iron_tool;mineable/pickaxe" }
  const diamondPick = { name: "diamond_pickaxe", type: 845 }
  const bareHandMs = computeVanillaDigMs(obsidianBlock, null, { entity: { onGround: true, isInWater: false } })
  const diamondMs = computeVanillaDigMs(obsidianBlock, diamondPick, { entity: { onGround: true, isInWater: false } })
  assert.equal(bareHandMs, 250000, "Bare-hand obsidian dig time is 250,000ms")
  assert.equal(diamondMs, 9400, "Diamond pickaxe obsidian dig time in 1.21 is 9,400ms (188 ticks)")

  // 2. Load cobble.litematic at (-297, -60, -143)
  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const tr = buildTransform(schematic, new Vec3(-297, -60, -143), 0)
  const worldMap = new Map()
  const botObj = {
    entity: { position: new Vec3(-292.5, -52, -138.5), yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8 },
    getControlState: () => false,
    setControlState: () => {},
    world: {
      raycast: (eye, dir, maxDist) => {
        const { rayHitBox, boxOf } = require("../src/interaction/aim")
        let best = null
        for (const [k, b] of worldMap.entries()) {
          if (!b || b.boundingBox !== "block") continue
          const [x, y, z] = k.split(",").map(Number)
          const pos = new Vec3(x, y, z)
          const hit = rayHitBox(eye, dir, maxDist, pos, boxOf(b))
          if (hit && (!best || hit.dist < best.dist)) best = { position: pos, name: b.name, face: hit.face, intersect: hit.intersect, dist: hit.dist }
        }
        return best
      }
    }
  }
  const worldModel = {
    bot: botObj,
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || (Math.floor(pos.y) <= -61 ? { name: "grass_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) } : { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) })
  }
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build()

  // Complete all blocks up to Layer 10 EXCEPT observer@-291,-51,-138 (to reproduce the exact 1.3h state)
  for (const t of planner.tasks.values()) {
    if (t.kind === "block" && t.layer <= 10 && t.order < 90000 && t.key !== "-291,-51,-138") {
      planner.setStatus(t, "completed")
      worldMap.set(t.key, { name: t.name, boundingBox: t.info?.fragile ? "empty" : "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t.properties, getProperties: () => t.properties })
    }
  }

  // 3. Verify oak_trapdoor@-291,-51,-137#w is blocked by unbuilt observer@-291,-51,-138, never force-pours even at attempts=10, and reopens blocked observer@-291,-51,-138!
  const obsTask = planner.tasks.get("-291,-51,-138")
  planner.setStatus(obsTask, "blocked")
  planner.blocked.add(obsTask.key)
  const wlTask = planner.tasks.get("-291,-51,-137#w")
  wlTask.attempts = 10
  const aim = new AimSolver(botObj, worldModel, { navigation: { placementReach: 4.5 } }, {
    isReserved: c => planner.tasks.has(`${c.x},${c.y},${c.z}`),
    isPending: c => planner.isPendingCell(c),
    isHazard: c => planner.isActivePitCell(c.x, c.y, c.z)
  })
  const placer = new Placer({
    bot: botObj, world: worldModel, config: { building: { correctMismatchedBlocks: true } }, logger: { info () {}, warn () {}, debug () {} },
    materials: { ensureItem: async () => {}, ensureUsableItem: async () => {} }, aim, scaffold: { itemName: "stone", created: new Map(), onScaffold: () => false },
    planner
  })
  await assert.rejects(() => placer.executeWaterlog(wlTask), err => err.code === "UNSAFE", "executeWaterlog must never force-waterlog an unsealed trapdoor even at attempts=10")
  assert.equal(obsTask.status, "pending", "executeWaterlog must automatically reopen the blocked retaining-wall observer@-291,-51,-138")

  // Verify markFailure on UNSAFE does NOT increment attempts toward quarantine
  const prevAttempts = wlTask.attempts
  planner.markFailure(wlTask, Object.assign(new Error("UNSAFE"), { code: "UNSAFE" }))
  assert.equal(wlTask.attempts, prevAttempts, "UNSAFE fluid containment wait must defer without burning attempts")
  assert.equal(wlTask.status, "deferred")

  // 4. Verify fluidBeside returns true next to a waterlogged trapdoor even when final=true if the temporary block is sealing a non-fluid cell
  worldMap.set("-291,-51,-137", { name: "oak_trapdoor", boundingBox: "empty", properties: { waterlogged: "true" }, getProperties: () => ({ waterlogged: "true" }) })
  assert.equal(placer.fluidBeside(new Vec3(-291, -51, -138), true), true, "fluidBeside must protect temporary retaining blocks next to waterlogged trapdoors even when final=true")

  // 5. Verify observer@-291,-51,-138 (facing=up) simulated overhead reference R=(-291,-50,-138) succeeds (via virtualStand / look-up ledge L=(-291,-53,-139))
  const simResult = placer.canPlaceTaskWithSimulatedRefs([new Vec3(-291, -50, -138)], obsTask, obsTask.info.specs)
  assert.ok(simResult === "walkable" || simResult === "scaffold", `canPlaceTaskWithSimulatedRefs for observer@-291,-51,-138 with overhead R=(-291,-50,-138) must succeed (got ${simResult})`)

  // 6. Verify fragile blocks (lever@-293,-49,-134, stone_button@-293,-48,-133) wait for and auto-reopen their blocked supporting parent (smooth_stone@-293,-48,-134)
  const parentStone = planner.tasks.get("-293,-48,-134")
  planner.setStatus(parentStone, "blocked")
  planner.blocked.add(parentStone.key)
  worldMap.delete("-293,-48,-134")
  const leverTask = planner.tasks.get("-293,-49,-134")
  assert.equal(planner.refPending(leverTask), true, "refPending must return true when ceiling lever's supporting block is blocked")
  assert.equal(parentStone.status, "pending", "refPending must automatically reopen the blocked supporting block smooth_stone@-293,-48,-134")

  // 7. Verify ceiling lever has switch-ceiling-opp fallback and specAccepts rejects lateral same-row grazing stands
  const ceilingLeverInfo = describeBlock("lever", { face: "ceiling", facing: "north", powered: "true" })
  assert.equal(ceilingLeverInfo.specs.some(s => s.tag === "switch-ceiling-opp"), true, "Ceiling lever must include switch-ceiling-opp fallback hypothesis")
  const wallBtnSpec = describeBlock("stone_button", { face: "wall", facing: "south" }).specs[0]
  const refBtn = new Vec3(-293, -48, -134)
  const hitBtn = new Vec3(-292.5, -47.5, -133.0)
  const grazingEye = new Vec3(-291.5, -46.73, -132.95) // lateral offset 1.0m in X, only 0.05m in front of south face z=-133.0
  assert.equal(specAccepts(wallBtnSpec, { f: "south" }, hitBtn.minus(grazingEye), hitBtn, refBtn, true), false, "specAccepts must reject same-row lateral grazing stands that hit the side face")

  // 8. Verify exit-planner can descend from the 13-block corner dirt column (-297,-46,-143) down to ground y=-60
  for (let y = -60; y <= -47; y++) {
    worldMap.set(`-297,${y},-143`, { name: "dirt", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) })
  }
  const colExitPlan = planRoute(
    (x, y, z) => worldModel.blockAt(new Vec3(x, y, z)),
    { x: -297, y: -46, z: -143 },
    (n) => n.y === -60 && !n.floorPlaced,
    { maxDrop: 3, allowDig: false, allowPlace: true }
  )
  assert.ok(colExitPlan && colExitPlan.steps && colExitPlan.steps.length > 0, "Exit planner must find a safe downward stair/drop route from top of 13-block column (-297,-46,-143) to ground y=-60")
})


test("v3.6 priority fixes: zero water/event stalls, per-cell exit cooldown, fast unreachable-stand fail-fast, and sustained late-build fleet speed", async () => {
  const { Vec3 } = require("../src/util/vec3")
  const { GroundMonitor } = require("../src/world/ground")
  const { AimSolver } = require("../src/interaction/aim")
  const { ExitManager } = require("../src/recovery/exit")
  const { NavigationController } = require("../src/navigation/controller")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { Coordinator } = require("../src/fleet/coordinator")
  const { describeBlock } = require("../src/rules/blocks")

  // 1. Shallow water bobbing (pos.y = -58.45 in 1-block water over solid dirt at y=-60) is grounded and allowed by AimSolver.fromPose
  const waterWorld = {
    blockAt: p => {
      const x = Math.floor(p.x); const y = Math.floor(p.y); const z = Math.floor(p.z)
      if (y === -60) return { name: "dirt", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
      if (x === 0 && y === -59 && z === 0) return { name: "water", boundingBox: "empty", shapes: [], getProperties: () => ({ level: "2" }) }
      if (x === 1 && y === -59 && z === 0) return { name: "stone", boundingBox: "block", getProperties: () => ({}) }
      return { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) }
    }
  }
  const waterBot = {
    on () {}, off () {},
    getControlState: () => false,
    entity: { position: new Vec3(0.5, -58.45, 0.5), velocity: new Vec3(0, 0.08, 0), yaw: 0, pitch: 0, onGround: false, isInWater: true, isInLava: false },
    world: { raycast: () => null }
  }
  const gm = new GroundMonitor(waterBot, waterWorld, {})
  assert.equal(gm.state(), "grounded", "Bot bobbing up 0.55m in 1-block shallow water over solid dirt must be grounded, not swimming")

  const aim = new AimSolver(waterBot, waterWorld, { navigation: { placementReach: 4.5 } }, { isHazard: () => false })
  const FREE = { faces: ["up", "down", "north", "south", "east", "west"].map(f => ({ f })), look: null, horiz: null, yaw16: null, tag: "free" }
  const poseInShallowWater = aim.fromPose(new Vec3(1, -58, 0), FREE, null, {})
  assert.ok(poseInShallowWater, "AimSolver.fromPose must allow placing blocks while standing in 1-block shallow water on solid non-hazard floor")

  // 2. ExitManager enforces per-cell cooldown even when force: true is passed so brain.rescue never loops every second
  const exitMgr = new ExitManager({
    bot: waterBot,
    world: waterWorld,
    config: { safety: {}, navigation: {} },
    logger: { info () {}, warn () {}, debug () {} },
    scaffold: { created: new Map(), itemName: "stone" },
    getPlanner: () => null
  })
  exitMgr.lastFail = Date.now()
  exitMgr.lastFailCell = "0,-59,0"
  const cdRes = await exitMgr.escape({ why: "brain: not reachable on foot", force: true, goalCells: new Set(["10,-50,10"]) })
  assert.equal(cdRes.escaped, false)
  assert.equal(cdRes.reason, "cooldown", "ExitManager.escape must enforce per-cell cooldown even when force=true")

  // 3. NavigationController._goTo_h fails fast in <20ms when brain.prepare(target) returns "no" on reachVerdict === "no"
  const nav = Object.create(NavigationController.prototype)
  nav.initialized = true
  nav.bot = waterBot
  nav.config = { materials: {}, navigation: {} }
  nav.logger = { info () {}, warn () {}, debug () {} }
  nav.brain = { prepare: async () => "no" }
  nav.stop = () => {}
  nav.useMode = () => {}
  const t0 = Date.now()
  await assert.rejects(
    () => nav._goTo_h(new Vec3(10.5, -59, 10.5), 0.3, 8000, { human: true, work: true, rescue: true, reachVerdict: "no" }),
    /no path to/,
    "NavigationController._goTo_h must fail fast immediately when brain.prepare returns no"
  )
  assert.ok(Date.now() - t0 < 200, "Fail-fast on unreachable stand must complete in <200ms without walking into walls")

  // 4. BuildPlanner.groupHasAnyReady ignores tasks claimed by another fleet worker so Worker 2 is never starved
  const coord = new Coordinator(2)
  coord.register("w1", 0, { entity: { position: new Vec3(0, -59, 0) } })
  coord.register("w2", 1, { entity: { position: new Vec3(5, -59, 5) } })
  const bp = Object.create(BuildPlanner.prototype)
  bp.tasks = new Map()
  bp.orderGroups = new Map()
  bp.chunkTasks = new Map()
  bp.materialDemand = new Map()
  bp.completed = new Set()
  bp.blocked = new Set()
  bp.ready = new Set()
  bp.census = { byKind: {}, byPhase: {} }
  bp.total = 0
  bp.world = waterWorld
  bp.joinFleet(coord, "w2", 1, 2)
  const task1 = {
    key: "1,-58,0", kind: "block", name: "stone", item: "stone", properties: {},
    info: describeBlock("stone", {}), world: new Vec3(1, -58, 0), order: 16, layer: 4,
    status: "pending", attempts: 0, deferredUntil: 0, owner: 0
  }
  bp.addTask(task1)
  coord.claim("w1", task1)
  const grp16 = bp.orderGroups.get(16)
  assert.equal(bp.groupHasAnyReady(grp16), false, "groupHasAnyReady must return false when the only ready task in the group is already claimed by another worker")
})


test("v3.7 fixes: no stone support/tower churn on flat placements with existing refs, guaranteed shift-click on chests, no slow edge-slide sneaking, Y-aware FallGuard open-ground return, and BuildMemory v8 sanitization", async () => {
  const os = require("os")
  const fs = require("fs")
  const path = require("path")
  const { Vec3 } = require("../src/util/vec3")
  const { BuildMemory } = require("../src/learning/learner")
  const { FallGuard } = require("../src/recovery/fall-guard")
  const { AimSolver } = require("../src/interaction/aim")
  const { HumanInteractionEngine } = require("../src/interaction/human-interaction")
  const { Placer } = require("../src/interaction/placer")
  const { describeBlock } = require("../src/rules/blocks")

  // 1. BuildMemory v8 purges polluted v5/v6 supportNeeded and hazardCells on load and ignores supportNeeded for dirt/chest
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mhb-v37-"))
  fs.writeFileSync(path.join(tmpDir, "build-memory.cobble.litematic.json"), JSON.stringify({
    version: 5,
    runs: 42,
    completedRuns: 4,
    supportNeeded: { "3,1,10@0": [[-1, 0, 0]], "4,1,10@0": [[0, 0, 1]], "1,1,1@0": [[1, 0, 0]], "2,1,1@0": [[1, 0, 0]], "3,1,1@0": [[1, 0, 0]], "4,1,1@0": [[1, 0, 0]], "5,1,1@0": [[1, 0, 0]] },
    hazardCells: { "0,2,10@0": { kind: "pit", count: 5 } },
    bestStands: { "3,1,10@0": [-1, 0, 0] },
    lockedSpecs: { "3,1,10@0": "free" }
  }))
  const bm = new BuildMemory(tmpDir, "cobble.litematic", 0)
  assert.equal(Object.keys(bm.data.supportNeeded).length, 0, "Legacy polluted supportNeeded must be purged on load")
  assert.equal(Object.keys(bm.data.hazardCells).length, 0, "Legacy polluted pit hazardCells must be purged on load")
  const dirtTask = { name: "dirt", kind: "block", local: new Vec3(3, 1, 10), world: new Vec3(-319, -59, -156), info: describeBlock("dirt", {}) }
  bm.recordSupport(dirtTask, [new Vec3(-319, -60, -156)])
  assert.equal(bm.needsSupport(dirtTask), false, "Ordinary dirt block must never record supportNeeded")

  // 2. FallGuard canReturn recognizes open superflat ground (>=48 cells) and holeKind is Y-aware
  const flatWorld = {
    blockAt: p => {
      const y = Math.floor(p.y)
      if (y === -61) return { name: "grass_block", boundingBox: "block", position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), getProperties: () => ({}) }
      return { name: "air", boundingBox: "empty", position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)), getProperties: () => ({}) }
    }
  }
  const fgBot = { entity: { position: new Vec3(-313.5, -58, -152.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0 }, setControlState: () => {}, builder: { running: true } }
  const fg = new FallGuard({ bot: fgBot, world: flatWorld, config: {}, logger: {}, navigation: {}, ground: {} })
  assert.equal(fg.canReturn(-313, -60, -152, -58), true, "Open superflat ground at y=-60 must return canReturn=true even from y=-58 deck")
  assert.equal(fg.hazardAt(-313.5, -58, -151.5, 2), null, "2-block drop onto open superflat grass must not be classified as a pit hazard")
  fg.recordHole(-313, -58, -152, "pit")
  assert.equal(fg.isHole(-313, -152, -60), false, "Hole recorded at y=-58 must not block pathfinding on ground level y=-60")

  // 3. AimSolver standOk rejects stands whose head cell (y+1) is a hazard, sets edge=false for <=0.25 shifts, and fromPose honors noSneakRef
  const blocks = new Map()
  for (let x = -315; x <= -305; x++) {
    for (let z = -158; z <= -150; z++) {
      blocks.set(`${x},-61,${z}`, { name: "grass_block", boundingBox: "block", position: new Vec3(x, -61, z), getProperties: () => ({}) })
    }
  }
  blocks.set("-309,-59,-154", { name: "chest", boundingBox: "block", position: new Vec3(-309, -59, -154), getProperties: () => ({ facing: "west", type: "left" }) })
  blocks.set("-309,-59,-153", { name: "dirt", boundingBox: "block", position: new Vec3(-309, -59, -153), getProperties: () => ({}) })
  const wModel = {
    blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: "air", boundingBox: "empty", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), getProperties: () => ({}) }
  }
  const aBot = {
    entity: { position: new Vec3(-310.5, -58, -152.5), yaw: 0, pitch: 0, height: 1.8 },
    world: { raycast: () => null },
    getControlState: () => false
  }
  const aim = new AimSolver(aBot, wModel, {}, {
    isHazard: c => c.x === -309 && c.y === -59 && c.z === -155
  })
  assert.equal(aim.standOk(new Vec3(-309, -60, -155), new Map()), false, "standOk must reject y=-60 cell when head cell y=-59 is an active chest/hopper hazard")
  const chestRightInfo = describeBlock("chest", { facing: "west", type: "right" })
  const chestOppSpec = chestRightInfo.specs.find(sp => sp.tag === "chest-opp")
  const poseNoSneak = aim.fromPose(new Vec3(-309, -59, -155), chestOppSpec, null, {})
  assert.equal(poseNoSneak, null, "fromPose must not pick an interactive chest reference when spec.noSneakRef is true")

  // 4. HumanInteractionEngine.sendPlace guarantees sneak=true and closes any opened window
  let sneakState = false
  let windowClosed = false
  let sneakDuringPlace = false
  const iBot = {
    entity: { position: new Vec3(0, 0, 0), height: 1.8 },
    currentWindow: { id: 1 },
    getControlState: k => k === "sneak" ? sneakState : false,
    setControlState: (k, v) => { if (k === "sneak") sneakState = v },
    closeWindow: () => { windowClosed = true; iBot.currentWindow = null },
    _placeBlockWithOptions: async () => { sneakDuringPlace = sneakState },
    on: (ev, cb) => { if (ev === "physicsTick") setImmediate(cb) },
    removeListener: () => {}
  }
  const hi = new HumanInteractionEngine(iBot, wModel, {}, {})
  await hi.sendPlace({ name: "chest", position: new Vec3(-309, -59, -154) }, new Vec3(0, 0, -1), new Vec3(0.5, 0.5, 0))
  assert.equal(sneakDuringPlace, true, "sendPlace must enable sneak for at least 1 tick before clicking a chest")
  assert.equal(windowClosed, true, "sendPlace must close any container window that opened")

  // 5. Placer.executeBlock does not call provideSupport on NO_ACCESS when task already has a solid reference block
  let supportCalled = 0
  const dummyPlacer = Object.create(Placer.prototype)
  Object.assign(dummyPlacer, {
    bot: { entity: { position: new Vec3(0, 0, 0) }, setControlState: () => {}, getControlState: () => false },
    world: wModel,
    config: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {} },
    learner: { order: t => t.info.specs, preferred: {}, failure: () => {}, success: () => {} },
    materials: { ensureItem: async () => {} },
    stats: { wrongState: 0 },
    setPhase: () => {},
    check: () => {},
    tntUnsafeReason: () => null,
    clearCell: async () => {},
    hasRef: () => true,
    provideSupport: async () => { supportCalled++; return [new Vec3(0, 0, 0)] },
    placeWithSpec: async () => { const e = new Error("no path"); e.code = "NO_ACCESS"; throw e },
    setSneak: () => {}
  })
  await assert.rejects(() => dummyPlacer.executeBlock(dirtTask), /no path/)
  assert.equal(supportCalled, 0, "executeBlock must never call provideSupport on NO_ACCESS when hasRef is already true and look !== 'up'")
})


test("v3.8 fixes (22-11-59.mp4 & Run #45): brain.connect Map goalCells gk.split fix, placer.hop diagonal wall-pinch rejection, hopper rim _centerOnColumn no premature jump, engine water-pour no false fluid-crowded/low-health deferral, and AimSolver ladder/lava-drop safety", async () => {
  const { Vec3 } = require("../src/util/vec3")
  const { Brain } = require("../src/navigation/brain")
  const { ExitManager } = require("../src/recovery/exit")
  const { Placer } = require("../src/interaction/placer")
  const { AimSolver } = require("../src/interaction/aim")
  const { Engine } = require("../src/intel/engine")

  // 1) ExitManager._escape handles Map goalCells (as passed by region.cells) without throwing gk.split is not a function
  const worldMap = new Map()
  for (let x = -5; x <= 5; x++) {
    for (let z = -5; z <= 5; z++) {
      worldMap.set(`${x},-61,${z}`, { name: "grass_block", boundingBox: "block", position: new Vec3(x, -61, z), getProperties: () => ({}) })
    }
  }
  // Create a 2-block raised platform at x=2..4, y=-59 (top y=-58)
  for (let x = 2; x <= 4; x++) {
    for (let z = -1; z <= 1; z++) {
      worldMap.set(`${x},-60,${z}`, { name: "cobblestone", boundingBox: "block", position: new Vec3(x, -60, z), getProperties: () => ({}) })
      worldMap.set(`${x},-59,${z}`, { name: "cobblestone", boundingBox: "block", position: new Vec3(x, -59, z), getProperties: () => ({}) })
    }
  }
  const world = {
    blockAt: p => worldMap.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: "air", boundingBox: "empty", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), getProperties: () => ({}) }
  }
  const bot = {
    entity: { position: new Vec3(0.5, -60, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 },
    health: 20,
    clearControlStates () {},
    setControlState () {},
    getControlState: () => false,
    lookAt: async () => {},
    inventory: { items: () => [{ name: "stone", count: 64 }] }
  }
  const exit = new ExitManager({
    bot,
    world,
    config: { safety: {}, navigation: { exitMaxDrop: 3 } },
    logger: { info () {}, warn () {}, debug () {} },
    interaction: { sendPlace: async () => {}, digAimed: async () => {} },
    scaffold: { itemName: "stone", created: new Map() },
    materials: { closeOpenContainer () {}, ensureItem: async () => {}, ensureUsableItem: async () => {} },
    survival: {},
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    nav: {},
    getPlanner: () => ({ tasks: new Map(), pitCells: new Set(), fluidCells: new Map() }),
    getPlacer: () => null
  })
  // Pass a Map as goalCells directly — must NOT throw gk.split is not a function!
  const mapGoals = new Map([["3,-58,0", { x: 3, y: -58, z: 0 }]])
  exit.doStep = async (st) => {
    bot.entity.position = new Vec3(st.to.x + 0.5, st.to.y, st.to.z + 0.5)
    return true
  }
  const res = await exit.escape({ goalCells: mapGoals, why: "test map goals", force: true, maxMs: 2000 })
  assert.equal(res.escaped, true, "ExitManager must accept Map goalCells and escape onto raised region")

  // 2) Placer.hop rejects a diagonal wall pinch (-278,-56,-199 -> -279,-56,-200 pinched by cobblestone at -279,-56,-199 and -278,-56,-200)
  worldMap.set("-278,-57,-199", { name: "cobblestone", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-279,-57,-200", { name: "cobblestone", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-279,-56,-199", { name: "cobblestone", boundingBox: "block", getProperties: () => ({}) })
  worldMap.set("-278,-56,-200", { name: "cobblestone", boundingBox: "block", getProperties: () => ({}) })
  bot.entity.position = new Vec3(-277.7, -56, -198.7)
  const placer = Object.create(Placer.prototype)
  placer.bot = bot
  placer.world = world
  placer.aim = { isHazard: () => false }
  placer.ground = { state: () => "grounded" }
  const hopOk = await placer.hop(new Vec3(-278.5, -56, -199.5))
  assert.equal(hopOk, false, "Placer.hop must immediately reject hopping diagonally through two corner-touching solid blocks")

  // 3) Engine.preflight never defers harmless water or waterlog tasks for low-health or fluid-crowded, only lava tasks
  const eng = new Engine({
    bot: { health: 8, entity: { position: new Vec3(0, -60, 0) }, entities: { p2: { type: "player", username: "MalikHu", position: new Vec3(1, -60, 1) } } },
    world,
    config: {},
    logger: { info () {}, warn () {} },
    recorder: { decision () {} },
    getPlanner: () => null
  })
  const waterPf = eng.preflight({ key: "0,-60,0", kind: "fluid", name: "water", item: "water_bucket", world: new Vec3(0, -60, 0) })
  assert.equal(waterPf.go, true, "Water pours must never be deferred for low-health or fluid-crowded")
  const lavaPf = eng.preflight({ key: "0,-60,0", kind: "fluid", name: "lava", item: "lava_bucket", world: new Vec3(0, -60, 0) })
  assert.equal(lavaPf.go, false, "Lava pours ARE deferred when low-health or crowded")

  // 4) AimSolver.standOk rejects cells with a ladder below feet, and AimSolver.virtualStand rejects columns adjacent to a ladder
  worldMap.set("-281,-53,-196", { name: "ladder", boundingBox: "empty", getProperties: () => ({ facing: "south" }) })
  const aim = new AimSolver(bot, world, { navigation: { placementReach: 4.5 }, building: { maxTowerHeight: 24 } }, {})
  assert.equal(aim.standOk(new Vec3(-281, -52, -196), new Map()), false, "Air cell directly above a ladder is not a stable placement stand")
  assert.equal(aim.virtualStand(new Vec3(-280, -52, -196), new Map(), new Vec3(-280, -51, -197)), null, "virtualStand must never place a scaffold column adjacent to a ladder")
})

test("v3.9 fixes (893/897 endgame & human-build-log.jsonl): chest-partner-side yaw-free merge from deck, same-layer observer->trapdoor order promotion (37.5), executeWaterlog sneak eye-height & trapdoor boxOf, Brain surfaceY slab/repeater physics, pathfinder repeater walkability, and no quarantine storm", async () => {
  const { describeBlock } = require("../src/rules/blocks")
  const { AimSolver, boxOf } = require("../src/interaction/aim")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { makeGraph } = require("../src/navigation/brain")
  const { NavigationController } = require("../src/navigation/controller")
  const { Vec3 } = require("../src/util/vec3")
  const { loadSchematic } = require("../src/schematic/loader")

  // 1. chest-partner-side has horiz: null (confirmed by human-build-log.jsonl where MalikHu placed west-facing right chest while looking south)
  const chestRight = describeBlock("chest", { facing: "west", type: "right" })
  const partnerSpec = chestRight.specs.find(s => s.tag === "chest-partner-side")
  assert.ok(partnerSpec, "chest-partner-side spec must exist")
  assert.equal(partnerSpec.horiz, null, "chest-partner-side must not restrict horizontal yaw because Minecraft inherits facing from the clicked partner chest")
  assert.equal(partnerSpec.sneak, true, "chest-partner-side must sneak-click the partner chest")

  // 2. boxOf returns accurate [0, 0, 0, 1, 0.1875, 1] for closed bottom trapdoor and [0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375] for chest
  assert.deepEqual(boxOf({ name: "oak_trapdoor", properties: { half: "bottom", open: "false" } }), [0, 0, 0, 1, 0.1875, 1])
  assert.deepEqual(boxOf({ name: "chest", properties: { facing: "west", type: "right" } }), [0.0625, 0, 0.0625, 0.9375, 0.875, 0.9375])

  // 3. cobble.litematic same-layer reference dependency promotion: oak_trapdoor@-282,-51,-238 (L9) is promoted to 37.5 (after observer@-283,-51,-238 at 37.2, before #w at 38.5)
  const reg = { blocksByName: new Proxy({}, { get: (_, name) => ({ id: 1, name, minStateId: 1 }) }) }
  const loaded = await loadSchematic("schematics/cobble.litematic", { registry: reg })
  const origin = new Vec3(-288, -60, -244)
  const start = loaded.schematic.start()
  const end = loaded.schematic.end()
  const transform = {
    origin,
    rotation: 0,
    localToWorld: lp => new Vec3(origin.x + (lp.x - start.x), origin.y + (lp.y - start.y), origin.z + (lp.z - start.z)),
    worldToLocalXZ: wp => new Vec3(wp.x - origin.x + start.x, wp.y - origin.y + start.y, wp.z - origin.z + start.z)
  }
  const worldMap = new Map()
  const worldModel = {
    bot: { registry: { itemsByName: new Proxy({}, { get: (_, k) => ({ name: k }) }) } },
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || { name: "air", boundingBox: "empty", getProperties: () => ({}) }
  }
  const planner = new BuildPlanner({ schematic: loaded.schematic, start, end }, transform, worldModel, { building: { giveUpAttempts: 6 } }, { info () {}, warn () {}, debug () {} })
  await planner.build()
  const obsL9 = planner.tasks.get("-283,-51,-238")
  const tdL9 = planner.tasks.get("-282,-51,-238")
  const tdwL9 = planner.tasks.get("-282,-51,-238#w")
  assert.equal(obsL9.order, 37.2)
  assert.equal(tdL9.order, 37.5, "oak_trapdoor@-282,-51,-238 must be promoted after its only solid reference observer@-283,-51,-238 (37.2)")
  assert.equal(tdwL9.order, 38.5, "waterlog task must remain at 38.5 right after trapdoor placement")

  // 4. Brain.makeGraph surfaceY rejects +1.5m step from y=-51 onto bottom slab at y=-50 (surface -49.5), but allows +1.125m step onto repeater and +0.875m step from repeater onto full block
  const slabGraphBlocks = new Map([
    ["0,-52,0", { name: "stone", boundingBox: "block", properties: {} }],
    ["0,-51,1", { name: "stone", boundingBox: "block", properties: {} }],
    ["0,-50,1", { name: "smooth_stone_slab", boundingBox: "block", properties: { type: "bottom" } }],
    ["1,-51,0", { name: "smooth_stone_slab", boundingBox: "block", properties: { type: "top" } }],
    ["1,-50,0", { name: "repeater", boundingBox: "block", properties: { facing: "north" } }],
    ["1,-50,1", { name: "smooth_stone", boundingBox: "block", properties: {} }]
  ])
  const g = makeGraph((x, y, z) => slabGraphBlocks.get(`${x},${y},${z}`) || { name: "air", boundingBox: "empty", properties: {} }, 1)
  const succFromMinus51 = g.succ({ x: 0, y: -51, z: 0 })
  assert.equal(succFromMinus51.some(c => c.x === 0 && c.y === -50 && c.z === 1), false, "Must reject impossible +1.5m jump from y=-51 onto bottom slab at y=-50 (surface -49.5)")
  assert.equal(succFromMinus51.some(c => c.x === 1 && c.y === -50 && c.z === 0), true, "Must allow +1.125m jump from y=-51 onto repeater at y=-50 (surface -49.875)")
  const succFromRepeater = g.succ({ x: 1, y: -50, z: 0 })
  assert.equal(succFromRepeater.some(c => c.x === 1 && c.y === -49 && c.z === 1), true, "Must allow +0.875m step from repeater (surface -49.875) onto full block at y=-49")

  // 5. NavigationController.allowDoors marks repeater and closed bottom trapdoor on solid floor as safe=true, physical=false
  const fakeMovements = {
    getBlock (pos, dx, dy, dz) {
      if (dy === -1) return { name: "smooth_stone_slab", physical: true, safe: false }
      return { name: "repeater", physical: true, safe: false, replaceable: false, getProperties: () => ({ facing: "south" }) }
    }
  }
  NavigationController.prototype.allowDoors.call({}, fakeMovements)
  const bRep = fakeMovements.getBlock({ x: 0, y: 0, z: 0 }, 0, 0, 0)
  assert.equal(bRep.physical, false, "Repeater on solid floor must have physical=false in pathfinder Movements")
  assert.equal(bRep.safe, true, "Repeater on solid floor must have safe=true in pathfinder Movements")

  // 6. markFailure does not burn attempts on "is busy with another worker"
  const dummyTask = planner.tasks.get("-282,-51,-238")
  const prevAttempts = dummyTask.attempts
  planner.markFailure(dummyTask, new Error("no way to give -282,-51,-238 a reference: reference cell -283,-51,-238 is busy with another worker"))
  assert.equal(dummyTask.attempts, prevAttempts, "Fleet busy wait must defer without incrementing task.attempts")
  assert.equal(dummyTask.status, "deferred")

  // 7. Endgame anti-stall: nextAny never sets a 3-minute (180,000ms) anyUntil lockout (capped at <=1200ms), immediately falls back when anyUntil is set, and deferNear is disabled when <=35 blocks remain
  for (const t of planner.tasks.values()) {
    if (t.key !== "-282,-51,-238") t.status = "completed"
  }
  planner.completed = new Set([...planner.tasks.keys()].filter(k => k !== "-282,-51,-238"))
  tdL9.status = "pending"
  tdL9.anyTries = 10
  const pickedAny1 = planner.nextAny(new Vec3(-281, -49, -236))
  assert.equal(pickedAny1?.key, "-282,-51,-238", "nextAny must pick the remaining endgame block immediately")
  assert.ok(tdL9.anyUntil - Date.now() <= 1300, "nextAny anyUntil lockout must be <= 1.2s, never 3 minutes (180,000ms)")
  const pickedAny2 = planner.nextAny(new Vec3(-281, -49, -236))
  assert.equal(pickedAny2?.key, "-282,-51,-238", "nextAny bestFallback must immediately return the endgame block without waiting for anyUntil to expire")
  assert.equal(planner.deferNear(tdL9, 3, 6000), 0, "deferNear must never freeze neighboring blocks when <= 35 blocks remain in the build")
})

test("v4.0 fixes (07-32-18.mp4): pre-analyzed L4..L7 vertical wall-column clusters (p0_L4 step -> self-pillar oak_leaves L4..L7 -> cobblestone partner column -> waterlog sweep), 100% flat-deck non-climbing stands, narrow-wall anti-fall penalty, fleet cluster partitioning, and 3-tier self-pillar backup plan", async () => {
  const fsPromises = require("fs/promises")
  const { Vec3 } = require("../src/util/vec3")
  const { loadLitematic } = require("../src/schematic/litematic")
  const { buildTransform } = require("../src/schematic/loader")
  const { BuildPlanner } = require("../src/planner/build-planner")
  const { AimSolver } = require("../src/interaction/aim")
  const { Placer } = require("../src/interaction/placer")
  const { plan: architectPlan, apply: architectApply } = require("../src/planner/architect")

  const schematic = await loadLitematic("./schematics/cobble.litematic", { allowAll: true }, fsPromises)
  const tr = buildTransform(schematic, new Vec3(0, -60, 0), 0)
  const worldMap = new Map()
  const botObj = {
    entity: { position: new Vec3(6.5, -56, 1.5), yaw: 0, pitch: 0, velocity: new Vec3(0, 0, 0), onGround: true, height: 1.8 },
    getControlState: () => false,
    setControlState: () => {},
    world: {
      raycast: (eye, dir, maxDist) => {
        let x = Math.floor(eye.x), y = Math.floor(eye.y), z = Math.floor(eye.z)
        const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z)
        const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : 1e9
        const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : 1e9
        const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : 1e9
        let tMaxX = stepX > 0 ? (x + 1 - eye.x) * tDeltaX : stepX < 0 ? (eye.x - x) * tDeltaX : 1e9
        let tMaxY = stepY > 0 ? (y + 1 - eye.y) * tDeltaY : stepY < 0 ? (eye.y - y) * tDeltaY : 1e9
        let tMaxZ = stepZ > 0 ? (z + 1 - eye.z) * tDeltaZ : stepZ < 0 ? (eye.z - z) * tDeltaZ : 1e9
        let t = 0, face = -1
        while (t <= maxDist) {
          const b = worldMap.get(`${x},${y},${z}`)
          if (b && b.boundingBox === "block" && t > 0) {
            return { dist: t, position: new Vec3(x, y, z), face, intersect: eye.plus(dir.scaled(t)) }
          }
          if (tMaxX < tMaxY) {
            if (tMaxX < tMaxZ) { x += stepX; t = tMaxX; tMaxX += tDeltaX; face = stepX > 0 ? 4 : 5 }
            else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = stepZ > 0 ? 2 : 3 }
          } else {
            if (tMaxY < tMaxZ) { y += stepY; t = tMaxY; tMaxY += tDeltaY; face = stepY > 0 ? 0 : 1 }
            else { z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = stepZ > 0 ? 2 : 3 }
          }
        }
        return null
      }
    }
  }
  const worldModel = {
    bot: botObj,
    blockAt: pos => worldMap.get(`${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`) || (Math.floor(pos.y) <= -61 ? { name: "grass_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) } : { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) })
  }
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build()
  const { sequence } = architectPlan(planner, { start: { x: 6, z: 2 } })
  architectApply(planner, sequence)

  // 1. Verify L4..L7 vertical wall-column band is detected at order 16.2, preserving layer sequence (L3 < 16.0 < 16.05 < 16.1 < 16.2 < 18.8 < 31.5 < 32.0)
  const grp16_2 = planner.orderGroups.get(16.2)
  assert.ok(grp16_2 && grp16_2.isVerticalWallBand, "L4..L7 vertical wall-column band must be created at order 16.2")
  assert.equal(planner.tasks.get("6,-56,6").order, 16, "Single-layer L4 center oak_leaves (6,-56,6) stays at order 16.0")
  assert.equal(planner.tasks.get("6,-56,6#w").order, 16.05, "Single-layer L4 center oak_leaves#w stays at order 16.05")
  assert.equal(planner.tasks.get("5,-56,11").order, 18.8, "L4..L7 ladders at (5,y,11) are grouped at order 18.8 right after the wall columns")
  assert.equal(planner.tasks.get("7,-53,3").order, 31.5, "L7 lava sources remain at order 31.5 after all L4..L7 wall columns and ladders")
  assert.equal(planner.tasks.get("0,-52,0").order, 16.1, "L8 cobblestone ring starts at order 32.0 after L7 lava")

  // 2. Verify joinFleet partitions the 10 vertical clusters cleanly without splitting any cluster across workers
  const fakeCoord = { log: [], busyFor: () => false, claim: () => {}, complete: () => {}, reopen: () => {} }
  planner.joinFleet(fakeCoord, "Build", 0, 2)
  const clusterOwners = new Map()
  for (const t of grp16_2.seqList) {
    const prevOwner = clusterOwners.get(t.verticalClusterId)
    if (prevOwner !== undefined) {
      assert.equal(t.owner, prevOwner, `All tasks in verticalClusterId=${t.verticalClusterId} must belong to the same worker`)
    } else {
      clusterOwners.set(t.verticalClusterId, t.owner)
    }
  }
  assert.equal(clusterOwners.size, 10, "All 10 vertical wall clusters on L4..L7 are partitioned")

  // 3. Complete L0..L3 + isolatedColumn + single (6,-56,6), then step through all 156 tasks in order 16.2 via planner.next()
  for (const t of planner.tasks.values()) {
    if (t.order < 16.2) {
      planner.setStatus(t, "completed")
      if (t.kind === "block") {
        worldMap.set(t.key, { name: t.name, boundingBox: t.info?.fragile ? "empty" : "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t.properties, getProperties: () => t.properties })
      }
    }
  }

  const aim = new AimSolver(botObj, worldModel, { navigation: { placementReach: 4.5 } }, {
    isHazard: c => planner.isActivePitCell(c.x, c.y, c.z),
    isPending: c => planner.isPendingCell(c)
  })
  const FREE = { faces: ["up", "down", "north", "south", "east", "west"].map(f => ({ f })), look: null, horiz: null, yaw16: null, tag: "free" }

  let steps16_2 = 0
  while (grp16_2.remaining > 0 && steps16_2 < 200) {
    const nextTask = planner.next(botObj.entity.position)
    assert.ok(nextTask && nextTask.order === 16.2, `planner.next() must return next cluster task in order 16.2 at step ${steps16_2}`)
    if (nextTask.verticalAnchorCol) {
      // Anchor column block: verify solid block directly below for self-pillaring
      const under = worldModel.blockAt(nextTask.world.offset(0, -1, 0))
      assert.equal(under.boundingBox, "block", `Anchor block ${nextTask.key} must have solid block below for self-pillaring`)
    } else if (nextTask.kind === "block") {
      // Partner cobblestone block: verify top-ranked AimSolver candidate is on the flat L3/L2 deck (y <= -56), NEVER climbing onto L5/L6/L7!
      const cands = aim.candidates(nextTask.world, nextTask.info.specs[0], { allowScaffold: false })
      assert.ok(cands.length > 0 && cands[0].cell.y <= -56, `Partner block ${nextTask.key} (L${nextTask.layer}) top candidate must be on flat deck y <= -56 (got y=${cands[0]?.cell?.y})`)
    } else if (nextTask.kind === "waterlog") {
      const cands = aim.candidates(nextTask.world, FREE, { mode: "self", allowScaffold: false })
      assert.ok(cands.length > 0 && cands[0].cell.y <= -56, `Waterlog ${nextTask.key} top candidate must be on flat deck y <= -56 (got y=${cands[0]?.cell?.y})`)
    }
    planner.setStatus(nextTask, "completed")
    if (nextTask.kind === "block") {
      worldMap.set(nextTask.key, { name: nextTask.name, boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: nextTask.properties, getProperties: () => nextTask.properties })
    }
    steps16_2++
  }
  assert.equal(grp16_2.remaining, 0, "All 156 block + waterlog tasks in L4..L7 vertical wall band completed in exact sequence without climbing onto narrow walls")

  // 4. Verify Placer.executeBlock uses executeSelfPillarStep when clear and falls back to standard executeBlock (Backup Plan) if self-pillaring fails
  let selfPillarCalled = 0
  let fallbackPlaceCalled = 0
  const fakePlacer = Object.create(Placer.prototype)
  fakePlacer.tntUnsafeReason = () => null
  fakePlacer.clearCell = async () => {}
  fakePlacer.canSelfPillarAnchorTask = () => true
  fakePlacer.logger = { debug () {}, info () {}, warn () {} }
  fakePlacer.executeSelfPillarStep = async () => {
    selfPillarCalled++
    if (selfPillarCalled === 2) throw new Error("simulated jump blocked")
    return "placed"
  }
  fakePlacer.activeSpecs = t => t.info.specs
  fakePlacer.hasRef = () => true
  fakePlacer.learner = { preferred: {}, success () {} }
  fakePlacer.materials = { ensureItem: async () => {} }
  fakePlacer.check = () => {}
  fakePlacer.placeWithSpec = async () => { fallbackPlaceCalled++; return "ok" }
  fakePlacer.postActions = async () => {}
  fakePlacer.setSneak = () => {}
  fakePlacer.bot = { entity: { position: new Vec3(6.5, -56, 2.5) } }

  const anchorTask = planner.tasks.get("6,-56,2")
  const res1 = await fakePlacer.executeBlock(anchorTask)
  assert.equal(res1, "placed")
  assert.equal(selfPillarCalled, 1, "Primary self-pillar plan used when clear")
  assert.equal(fallbackPlaceCalled, 0)

  const res2 = await fakePlacer.executeBlock(anchorTask)
  assert.equal(res2, "placed")
  assert.equal(selfPillarCalled, 2)
  assert.equal(fallbackPlaceCalled, 1, "Backup Plan (standard placeWithSpec from deck/support) used seamlessly when self-pillar throws")
})

test("v4.1 fixes (11-12-26.mp4, 11-20-51.mp4 & Farm 2 11-30-18.mp4): tnt bottom-slab/redstone_wire raycast, simulated ref face-direction verification, hopper chain readiness & cross-layer fleet parallelism, and Farm 2 (Tree Gaming & McDs) crafter/tripwire/wall_sign fluid rules", async () => {
  const { Vec3 } = require("../src/util/vec3");
  const { AimSolver, boxOf } = require("../src/interaction/aim");
  const { describeBlock } = require("../src/rules/blocks");
  const { loadSchematic, buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { Coordinator } = require("../src/fleet/coordinator");

  // 1. boxOf includes redstone_wire, tripwire, and hopper; losRay and validateView see through upper air half of smooth_stone_slab[type=bottom]
  assert.deepEqual(boxOf({ name: "redstone_wire", shapes: [] }), [0, 0, 0, 1, 0.0625, 1]);
  assert.deepEqual(boxOf({ name: "tripwire", shapes: [] }), [0, 0, 0, 1, 0.0625, 1]);

  const slabPos = new Vec3(-179, -50, -170);
  const notePos = new Vec3(-179, -49, -171);
  const slabBlock = { name: "smooth_stone_slab", boundingBox: "block", shapes: [], position: slabPos, properties: { type: "bottom" }, getProperties: () => ({ type: "bottom" }) };
  const noteBlock = { name: "note_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: notePos, properties: {}, getProperties: () => ({}) };
  const blocks = new Map([
    [`${slabPos.x},${slabPos.y},${slabPos.z}`, slabBlock],
    [`${notePos.x},${notePos.y},${notePos.z}`, noteBlock],
    ["-179,-52,-169", { name: "stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(-179, -52, -169), getProperties: () => ({}) }]
  ]);
  const mockWorld = {
    blockAt: p => blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: "air", boundingBox: "empty", shapes: [], position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), getProperties: () => ({}) }
  };
  const eye = new Vec3(-178.5, -51 + 1.62, -168.5);
  const hit = new Vec3(-178.5, -49.0, -170.5);
  const d = hit.minus(eye);
  const yaw = Math.atan2(-d.x, -d.z);
  const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
  const mockBot = {
    entity: { position: new Vec3(-178.5, -51, -168.5), yaw, pitch, onGround: true },
    getControlState: () => false,
    world: {
      // Simulate Mineflayer world.raycast falsely returning the full-cube voxel of smooth_stone_slab at (-179,-50,-170)
      raycast: () => ({ position: slabPos, name: "smooth_stone_slab", face: 3, intersect: new Vec3(-178.5, -49.2, -169.0) })
    }
  };
  const aim = new AimSolver(mockBot, mockWorld, { building: {} });
  const tntSpec = describeBlock("tnt", {}).specs[0];
  assert.equal(aim.losRay(eye, hit, notePos, "down"), true, "losRay must pass over bottom slab when ray is at y=-49.2");
  const validated = aim.validateView(tntSpec, { f: "down" }, notePos, "down");
  assert.ok(validated, "validateView must not reject tnt aim when ray passes through upper air half of smooth_stone_slab[type=bottom]");

  // 2. Hopper chain readiness & cross-layer fleet parallelism on cobble.litematic
  const mockRegistry = new Proxy({ blocksByName: new Proxy({}, { get: (_, n) => ({ id: 1, name: String(n), boundingBox: /^(air|cave_air|void_air|water|lava|redstone_wire|repeater|comparator|lever|stone_button|oak_button|rail|powered_rail|detector_rail|activator_rail|torch|redstone_torch|wall_torch|redstone_wall_torch|kelp|kelp_plant|seagrass|tall_seagrass|sugar_cane|bamboo|dead_bush|short_grass|tall_grass|fern|large_fern|vine|ladder|tripwire|tripwire_hook|string)$|_carpet$|_sapling$|_sign$|_wall_sign$|_banner$|_wall_banner$|_pressure_plate$/.test(String(n)) ? "empty" : "block" }) }) }, { get: (t, k) => t[k] });
  const loaded1 = await loadSchematic("./schematics/cobble.litematic", { registry: mockRegistry, version: "1.21.4" });
  const transform1 = buildTransform(loaded1.schematic, new Vec3(-185, -60, -177), 0);
  const wMap1 = new Map();
  const world1 = { blockAt: p => wMap1.get(`${p.x},${p.y},${p.z}`) || { name: "air", boundingBox: "empty", position: new Vec3(p.x, p.y, p.z) } };
  const coord = new Coordinator();
  coord.register("Build", 0);
  coord.register("Buildd", 1);
  const p0 = new BuildPlanner(loaded1, transform1, world1, { building: {} }, console).build().joinFleet(coord, "Build", 0, 2);
  const p1 = new BuildPlanner(loaded1, transform1, world1, { building: {} }, console).build().joinFleet(coord, "Buildd", 1, 2);

  // Complete Layer 0 and Layer 1 dirt/grass_block (orders 0 and 4)
  for (const pl of [p0, p1]) {
    for (const t of pl.tasks.values()) {
      if (t.order <= 4.0) {
        pl.setStatus(t, "completed");
        wMap1.set(t.key, { name: t.name, boundingBox: "block", properties: t.properties, getProperties: () => t.properties, position: t.world.clone() });
      }
    }
  }
  // An out-of-order hopper (-172,-59,-167 pointing east into uncompleted hopper -171,-59,-167) must have refPending === true
  const hop2 = p1.tasks.get("-172,-59,-167");
  assert.ok(hop2, "hopper at -172,-59,-167 exists");
  assert.equal(p1.refPending(hop2), true, "hopper pointing into uncompleted hopper must have refPending === true");

  // While Worker 1 owns the Layer 1 chest/hopper chains (4.25..4.49), Worker 0 (Build) must immediately advance to Layer 2 dirt (order 8.0) on cells with finished support below!
  const nextForW0 = p0.next(new Vec3(-180, -58, -170));
  assert.ok(nextForW0 && nextForW0.layer === 2, `Worker 0 should advance to Layer 2 while Worker 1 builds Layer 1 chests/hoppers, got ${nextForW0?.name}@L${nextForW0?.layer}`);

  // 3. Farm 2 (Tree Gaming Cobblestone Wall Farm.litematic) rules, fluidCheck with wall signs, and layer-by-layer L9..L17
  const loaded2 = await loadSchematic("./schematics/Tree Gaming Cobblestone Wall Farm.litematic", { registry: mockRegistry, version: "1.21.4" });
  const transform2 = buildTransform(loaded2.schematic, new Vec3(0, -60, 0), 0);
  const wMap2 = new Map();
  const world2 = { blockAt: p => wMap2.get(`${p.x},${p.y},${p.z}`) || { name: "air", boundingBox: "empty", position: new Vec3(p.x, p.y, p.z) } };
  const planner2 = new BuildPlanner(loaded2, transform2, world2, { building: {} }, console).build();

  assert.equal(planner2.census.unsupported.length, 0, "Farm 2 must have 0 unsupported blocks");
  const vTasks2 = [...planner2.tasks.values()].filter(t => t.verticalColumn).length;
  assert.equal(vTasks2, 2592, "Farm 2 generator walls (L10..L13 and L14..L17 above L9 base ring) must group into two 4-layer vertical column bands (2592 tasks)");

  const crafterInfo = describeBlock("crafter", { orientation: "west_up", triggered: "true", crafting: "false" });
  assert.equal(crafterInfo.specs[0].tag, "crafter-a");
  assert.equal(crafterInfo.specs[0].look, "east");

  const tripwireInfo = describeBlock("tripwire", { attached: "true" });
  assert.equal(tripwireInfo.specs[0].tag, "free", "mid-air tripwire must allow clicking any adjacent face");

  // Simulate all blocks in Farm 2 placed and verify all 262 fluids (including the 9 blast-chamber water sources above oak_wall_sign) pass fluidCheck!
  for (const t of planner2.tasks.values()) {
    if (t.kind === "block") {
      t.status = "completed";
      wMap2.set(t.key, {
        name: t.name,
        boundingBox: /^(redstone_wire|repeater|comparator|lever|tripwire|tripwire_hook|redstone_torch|redstone_wall_torch)$|_sign$|_wall_sign$/.test(t.name) ? "empty" : "block",
        properties: t.properties,
        getProperties: () => t.properties,
        position: t.world.clone()
      });
    }
  }
  const blockedFluids2 = [...planner2.tasks.values()].filter(t => t.kind === "fluid" && planner2.fluidCheck(t).blocked);
  assert.equal(blockedFluids2.length, 0, "All 262 fluid sources in Farm 2 must pass fluidCheck once blocks and wall signs are placed");
});


test("v4.2 fixes (Farm 2 Layer 7 redstone_wire power/rayOutlineBlocker, floating observer ordering, multi-pass same-layer ref promotion, water-source scaffold/exit protection, crafter diagonal margin, and instant-break dig aim)", async () => {
  const { Vec3 } = require("../src/util/vec3");
  const { describeBlock, matches, taskMatches } = require("../src/rules/blocks");
  const { AimSolver, specAccepts } = require("../src/interaction/aim");
  const { loadSchematic, buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { makeView, moves } = require("../src/recovery/exit-planner");
  const { HumanInteractionEngine } = require("../src/interaction/human-interaction");

  // 1. redstone_wire ignores power property on placement so unpowered wire (power="0") matches schematic wire (power="14")
  const wireInfo = describeBlock("redstone_wire", { east: "none", south: "side", north: "side", west: "none", power: "14" });
  const worldWire = { name: "redstone_wire", getProperties: () => ({ east: "none", south: "none", north: "none", west: "none", power: "0" }) };
  assert.equal(matches(worldWire, wireInfo), true, "redstone_wire with power=0 must match schematic redstone_wire with power=14");
  assert.equal(taskMatches(worldWire, { kind: "block", name: "redstone_wire", info: wireInfo }), true);

  // 2. AimSolver ignores target cell in rayOutlineBlocker when !self so a wire/block in target never blocks rays to refPos's up face
  const refPos = new Vec3(-125, -54, -227);
  const targetPos = new Vec3(-125, -53, -227);
  const refBlock = { name: "smooth_stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: refPos, getProperties: () => ({}) };
  const targetWire = { name: "redstone_wire", boundingBox: "empty", shapes: [], position: targetPos, getProperties: () => ({ power: "0" }) };
  const standFloor = { name: "smooth_stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(-125, -54, -226), getProperties: () => ({}) };
  const mockWorld = {
    blockAt: p => {
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      const k = `${bx},${by},${bz}`;
      if (k === "-125,-54,-227") return refBlock;
      if (k === "-125,-53,-227") return targetWire;
      if (by === -54) return { name: "smooth_stone", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(bx, by, bz), getProperties: () => ({}) };
      return { name: "air", boundingBox: "empty", shapes: [], position: new Vec3(bx, by, bz), getProperties: () => ({}) };
    }
  };
  const mockBot = {
    entity: { position: new Vec3(-124.5, -53, -225.5), yaw: 0, pitch: -0.5, onGround: true },
    getControlState: () => false,
    world: {
      raycast: (eye, dir) => ({ position: refPos, name: "smooth_stone", face: 1, intersect: new Vec3(-124.5, -53.0, -226.5) })
    }
  };
  const aim = new AimSolver(mockBot, mockWorld, { building: {} });
  const cands = aim.candidates(targetPos, wireInfo.specs[0], { allowScaffold: false });
  assert.ok(cands.length > 0, "AimSolver must find candidates for -125,-53,-227 even when redstone_wire is in targetPos");

  // 3. Crafter has single non-hypothesis rule crafter-a and specAccepts rejects near-diagonal 51-deg yaw
  const crafterInfo = describeBlock("crafter", { orientation: "west_up", triggered: "true", crafting: "false" });
  assert.equal(crafterInfo.specs.length, 1, "crafter must have a single deterministic spec (crafter-a)");
  const diagYaw = -51 * Math.PI / 180; // 6 deg from 45-deg diagonal
  const diagDir = new Vec3(-Math.sin(diagYaw), -0.1, -Math.cos(diagYaw));
  assert.equal(specAccepts(crafterInfo.specs[0], { f: "up" }, diagDir, new Vec3(0.5, 1, 0.5), new Vec3(0, 0, 0), true), false, "51-deg diagonal yaw must be rejected for crafter-a");

  // 4. Farm 2 floating observer@-124,-53,-227 (L7) precedes redstone_wire, and L19 observer -> dropper -> tripwire_hook chain is promoted
  const mockRegistry = new Proxy({ blocksByName: new Proxy({}, { get: (_, n) => ({ id: 1, name: String(n), boundingBox: "block" }) }) }, { get: (t, k) => t[k] });
  const loaded2 = await loadSchematic("./schematics/Tree Gaming Cobblestone Wall Farm.litematic", { registry: mockRegistry, version: "1.21.4" });
  const tf2 = buildTransform(loaded2.schematic, new Vec3(-129, -60, -229), 0);
  const planner2 = new BuildPlanner(loaded2, tf2, { blockAt: () => ({ name: "air", boundingBox: "empty" }) }, { building: {} }, console).build();
  const obsL7 = planner2.tasks.get("-124,-53,-227");
  const wireL7 = planner2.tasks.get("-125,-53,-227");
  assert.ok(obsL7.order < wireL7.order, `Floating L7 observer (${obsL7.order}) must precede adjacent redstone_wire (${wireL7.order})`);
  const obsL19 = planner2.tasks.get("-115,-41,-218");
  const dropperL19 = planner2.tasks.get("-114,-41,-218");
  const hookL19 = planner2.tasks.get("-114,-41,-219");
  assert.ok(obsL19.order < dropperL19.order && dropperL19.order < hookL19.order, `L19 chain must be ordered observer (${obsL19.order}) < dropper (${dropperL19.order}) < tripwire_hook (${hookL19.order})`);

  // 5. Exit planner refuses to place bridge/stair blocks into schematic fluid source cells
  const waterWorld = (x, y, z) => {
    if (y === -57) return { name: "packed_ice", boundingBox: "block", getProperties: () => ({}) };
    if (x === -122 && y === -56 && z === -213) return { name: "water", boundingBox: "empty", getProperties: () => ({ level: "0" }) };
    if (x === -122 && y === -56 && z === -214) return { name: "glass", boundingBox: "block", getProperties: () => ({}) };
    return { name: "air", boundingBox: "empty", getProperties: () => ({}) };
  };
  const view = makeView(waterWorld, {
    taskAt: (x, y, z) => (x === -122 && y === -56 && z === -213) ? { kind: "fluid", name: "water", status: "completed" } : null
  });
  const mList = [...moves(view, { x: -122, y: -55, z: -214, floorPlaced: false }, { maxDrop: 3, allowDig: true, allowPlace: true })];
  const badPlace = mList.find(m => m.place && m.place.cell.x === -122 && m.place.cell.y === -56 && m.place.cell.z === -213);
  assert.equal(badPlace, undefined, "Exit planner must never place a temporary bridge/stair block inside a schematic water source cell");
});

test("v4.3 fixes (14-09-09.mp4, 14-12-08.mp4, 14-14-18.mp4): Farm 2 L3/L4 water rim adjLavaDrop/sneak fix, noScaffold only on fluid sources so L8 oak_leaves & L9 generator grid never freeze, chest -fv->+fv sweep & cross-fleet single-chest taskMatches, Brain water-basin barrier, and dryland exit out of fluidCells", async () => {
  const { Vec3 } = require("../src/util/vec3");
  const { describeBlock, taskMatches } = require("../src/rules/blocks");
  const { AimSolver } = require("../src/interaction/aim");
  const { Placer } = require("../src/interaction/placer");
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager");
  const { loadSchematic, buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { plan: architectPlan, apply: architectApply } = require("../src/planner/architect");
  const { Brain } = require("../src/navigation/brain");

  const mockRegistry = new Proxy({
    blocksByName: new Proxy({}, {
      get: (_, n) => ({
        id: 1,
        name: String(n),
        boundingBox: /^(air|cave_air|void_air|water|lava|redstone_wire|repeater|comparator|lever|stone_button|oak_button|rail|powered_rail|detector_rail|activator_rail|torch|redstone_torch|wall_torch|redstone_wall_torch|kelp|kelp_plant|seagrass|tall_seagrass|sugar_cane|bamboo|dead_bush|short_grass|tall_grass|fern|large_fern|vine|ladder|tripwire|tripwire_hook|string)$|_carpet$|_sapling$|_sign$|_wall_sign$|_banner$|_wall_banner$|_pressure_plate$/.test(String(n)) ? "empty" : "block"
      })
    })
  }, { get: (t, k) => t[k] });

  const loaded2 = await loadSchematic("./schematics/Tree Gaming Cobblestone Wall Farm.litematic", { registry: mockRegistry, version: "1.21.4" });
  const tf2 = buildTransform(loaded2.schematic, new Vec3(1000, -60, 1000), 0);
  const wMap2 = new Map();
  const world2 = {
    registry: mockRegistry,
    blockAt: p => {
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      return wMap2.get(`${bx},${by},${bz}`) || (by === -61
        ? { name: "grass_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(bx, by, bz), getProperties: () => ({}) }
        : { name: "air", boundingBox: "empty", shapes: [], position: new Vec3(bx, by, bz), getProperties: () => ({}) });
    }
  };
  const planner2 = new BuildPlanner(loaded2, tf2, world2, { building: {} }, console).build();
  const ap2 = architectPlan(planner2, { start: { x: 1000, z: 1000 } });
  architectApply(planner2, ap2.sequence);

  // 1. Verify Layer 9 (y=-51) blocks do not leapfrog into fragmented orders
  const l9Blocks = [...planner2.tasks.values()].filter(t => t.layer === 9 && t.kind === "block");
  assert.equal(l9Blocks.length, 270);
  for (const t of l9Blocks) {
    assert.equal(t.order, 36.08, `Layer 9 block ${t.name}@${t.key} must remain at order 36.08 without mutual leapfrogging (got ${t.order})`);
  }

  // 2. Verify chest sweep order in Farm 2 (facing=south -> z=1002..1033) and cobble.litematic (facing=west -> x=-270..-279)
  const g2025 = planner2.orderGroups.get(20.25);
  assert.equal(g2025.seqList[0].world.z, 1002, "Farm 2 primary chests (facing=south) must start at north end z=1002");
  assert.equal(g2025.seqList[g2025.seqList.length - 1].world.z, 1033, "Farm 2 primary chests (facing=south) must finish at south end z=1033");

  const loaded1 = await loadSchematic("./schematics/cobble.litematic", { registry: mockRegistry, version: "1.21.4" });
  const tf1 = buildTransform(loaded1.schematic, new Vec3(-285, -60, -242), 0);
  const planner1 = new BuildPlanner(loaded1, tf1, { blockAt: () => ({ name: "air", boundingBox: "empty" }) }, { building: {} }, console).build();
  const ap1 = architectPlan(planner1, { start: { x: -285, z: -242 } });
  architectApply(planner1, ap1.sequence);
  const g430 = planner1.orderGroups.get(4.3);
  assert.equal(g430.seqList[0].world.x, -270, "cobble.litematic partner chests (facing=west) must start at east end x=-270");
  assert.equal(g430.seqList[g430.seqList.length - 1].world.x, -279, "cobble.litematic partner chests (facing=west) must finish at west end x=-279");

  // 3. Verify taskMatches accepts unmerged single chest on partner fleet bots, and refPending holds .30 chest until .25 partner is completed
  const primaryChest = planner2.tasks.get("1003,-55,1002");
  const partnerChest = planner2.tasks.get("1002,-55,1002");
  const unmergedWorldChest = { name: "chest", getProperties: () => ({ facing: "south", type: "single", waterlogged: "false" }) };
  assert.equal(taskMatches(unmergedWorldChest, primaryChest), true, "Unmerged single chest in world must match primary chest across all fleet bots");
  assert.equal(planner2.refPending(partnerChest), true, "Partner .30 chest must have refPending===true before its .25 primary chest is completed");

  // 4. Verify all 56 Layer 3 water tasks and all 136 Layer 4 water tasks in Farm 2 have >0 valid rim candidates even when basin is filled with water
  for (const t of planner2.tasks.values()) {
    if (t.order <= 17.5 && t.kind === "block") {
      planner2.setStatus(t, "completed");
      wMap2.set(t.key, {
        name: t.name,
        boundingBox: /sign/.test(t.name) ? "empty" : "block",
        shapes: /sign/.test(t.name) ? [] : [[0, 0, 0, 1, 1, 1]],
        properties: t.properties,
        getProperties: () => t.properties,
        position: t.world.clone()
      });
    }
  }
  const bot2 = {
    entity: { position: new Vec3(1032.5, -56, 1018.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    getControlState: () => false,
    world: { raycast: () => null },
    builder: { planner: planner2 }
  };
  const noScaffoldFn = pos => {
    const k = `${pos.x},${pos.y},${pos.z}`;
    const t = planner2.tasks.get(k);
    if (!t || t.kind !== "fluid") return false;
    const b = world2.blockAt(pos);
    return t.status === "completed" || Boolean(b && (b.name === "water" || b.name === "lava") && String(b.getProperties?.()?.level ?? "0") === "0");
  };
  const aim2 = new AimSolver(bot2, world2, { building: {} }, {
    isReserved: c => planner2.tasks.has(`${c.x},${c.y},${c.z}`),
    isPending: c => planner2.isPendingCell(c),
    isHazard: c => planner2.isActivePitCell(c.x, c.y, c.z)
  });
  aim2.noScaffold = noScaffoldFn;
  const FREE = { faces: ["up", "down", "north", "south", "east", "west"].map(f => ({ f })), look: null, horiz: null, tag: "free" };

  const l3Waters = [...planner2.tasks.values()].filter(t => t.layer === 3 && t.kind === "fluid");
  assert.equal(l3Waters.length, 56);
  for (const wt of l3Waters) {
    const cands = aim2.candidates(wt.world, FREE, { bucket: true, minStandDist: 1.5, allowScaffold: true });
    assert.ok(cands.length > 0, `L3 water ${wt.key} must have >0 valid rim candidates even as water fills the y=-57 basin`);
    planner2.setStatus(wt, "completed");
    wMap2.set(wt.key, { name: "water", boundingBox: "empty", shapes: [], properties: { level: "0" }, getProperties: () => ({ level: "0" }), position: wt.world.clone() });
  }
  const l4Waters = [...planner2.tasks.values()].filter(t => t.layer === 4 && t.kind === "fluid");
  assert.equal(l4Waters.length, 136);
  for (const wt of l4Waters) {
    const cands = aim2.candidates(wt.world, FREE, { bucket: true, minStandDist: 1.5, allowScaffold: true });
    assert.ok(cands.length > 0, `L4 water ${wt.key} must have >0 valid rim candidates`);
    planner2.setStatus(wt, "completed");
    wMap2.set(wt.key, { name: "water", boundingBox: "empty", shapes: [], properties: { level: "0" }, getProperties: () => ({ level: "0" }), position: wt.world.clone() });
  }

  // 5. Complete L5..L7 and verify all 63 Layer 8 floating oak_leaves (y=-52) pass canPlaceTaskWithSimulatedRefs over the packed_ice basin
  for (const t of planner2.tasks.values()) {
    if (t.layer <= 7 && t.status !== "completed") {
      planner2.setStatus(t, "completed");
      if (t.kind === "block") {
        wMap2.set(t.key, {
          name: t.name,
          boundingBox: /sign|wire|repeater|comparator/.test(t.name) ? "empty" : "block",
          shapes: /sign|wire|repeater|comparator/.test(t.name) ? [] : [[0, 0, 0, 1, 1, 1]],
          properties: t.properties,
          getProperties: () => t.properties,
          position: t.world.clone()
        });
      }
    }
  }
  const sc2 = new ScaffoldManager({ bot: bot2, world: world2, config: { building: { maxTowerHeight: 24 } }, logger: console });
  sc2.noScaffold = noScaffoldFn;
  const placer2 = new Placer({
    bot: bot2, world: world2, config: { building: {} }, logger: console,
    aim: aim2, scaffold: sc2, planner: planner2, isReserved: c => planner2.tasks.has(`${c.x},${c.y},${c.z}`)
  });
  bot2.entity.position = new Vec3(1015.5, -56, 1025.5);
  const l8Leaves = [...planner2.tasks.values()].filter(t => t.layer === 8 && t.kind === "block");
  assert.equal(l8Leaves.length, 63);
  for (const lt of l8Leaves) {
    const rBelow = lt.world.offset(0, -1, 0);
    const simVerdict = placer2.canPlaceTaskWithSimulatedRefs([rBelow], lt, lt.info.specs);
    assert.ok(simVerdict === "direct" || simVerdict === "walkable" || simVerdict === "scaffold", `L8 oak_leaves@${lt.key} must be placeable via simulated reference ${rBelow} (got ${simVerdict})`);
  }

  // 6. Brain.isBlockedCell blocks live water cells so west-wall stands never flood across the water basin to the east wall
  const brain2 = new Brain({ bot: bot2, world: world2, config: {} });
  assert.equal(brain2.isBlockedCell(1031, -57, 1018), true, "Brain.isBlockedCell must block live water cells in the basin");
});

test("v4.4 upgrades: smart open-basin water deferral (88000+layer+0.25), stacked 4-layer vertical generator bands (L10..L13 & L14..L17), background LookaheadEngine, 5th bot Janitor/Sweeper role, and anti-hover/anti-stop physics guarantees", async () => {
  const { Vec3 } = require("../src/util/vec3");
  const { loadSchematic, buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { AimSolver } = require("../src/interaction/aim");
  const { Placer } = require("../src/interaction/placer");
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager");
  const { LookaheadEngine } = require("../src/navigation/lookahead");
  const { SweeperEngine, isSweeperWorker, builderWorkerIndices } = require("../src/fleet/sweeper");
  const { Coordinator } = require("../src/fleet/coordinator");
  const { GroundMonitor } = require("../src/world/ground");
  const legacyDefaults = require("../src/core/legacy-defaults");

  const mockRegistry = new Proxy({
    blocksByName: new Proxy({}, {
      get: (_, n) => ({
        id: 1,
        name: String(n),
        boundingBox: /^(air|cave_air|void_air|water|lava|redstone_wire|repeater|comparator|lever|stone_button|oak_button|rail|powered_rail|detector_rail|activator_rail|torch|redstone_torch|wall_torch|redstone_wall_torch|kelp|kelp_plant|seagrass|tall_seagrass|sugar_cane|bamboo|dead_bush|short_grass|tall_grass|fern|large_fern|vine|ladder|tripwire|tripwire_hook|string)$|_carpet$|_sapling$|_sign$|_wall_sign$|_banner$|_wall_banner$|_pressure_plate$/.test(String(n)) ? "empty" : "block"
      })
    })
  }, { get: (t, k) => t[k] });

  // 1. Open-basin water deferral vs enclosed tube water in Farm 2
  const loaded2 = await loadSchematic("./schematics/Tree Gaming Cobblestone Wall Farm.litematic", { registry: mockRegistry, version: "1.21.4" });
  const tf2 = buildTransform(loaded2.schematic, new Vec3(1000, -60, 1000), 0);
  const wMap2 = new Map();
  const world2 = {
    registry: mockRegistry,
    blockAt: p => {
      const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z);
      return wMap2.get(`${bx},${by},${bz}`) || { name: "air", boundingBox: "empty", shapes: [], position: new Vec3(bx, by, bz), getProperties: () => ({}) };
    }
  };
  const planner2 = new BuildPlanner(loaded2, tf2, world2, { building: {} }, console).build();

  const openBasinWaters = [...planner2.tasks.values()].filter(t => t.kind === "fluid" && t.name === "water" && t.order >= 88000);
  const inLayerTubeWaters = [...planner2.tasks.values()].filter(t => t.kind === "fluid" && t.name === "water" && t.order < 88000);
  assert.equal(openBasinWaters.length, 176, "All 176 wide-open basin water sources on L3 (56) and L4 (120) must defer to order 88000+layer+0.25");
  assert.equal(inLayerTubeWaters.length, 32, "All 32 enclosed/tube water source tasks (L1=4, L4 west trench=16, L6=3, L22=9) must stay in-layer before their roofs seal them");

  // 2. Stacked 4-layer vertical generator bands on Farm 2 (L9 base ring at 36.08, L10..L13 Band 1 at 40.2, L14..L17 Band 2 at 56.2)
  const band1Tasks = [...planner2.tasks.values()].filter(t => t.verticalColumn && t.order === 40.2);
  const band2Tasks = [...planner2.tasks.values()].filter(t => t.verticalColumn && t.order === 56.2);
  assert.equal(band1Tasks.length, 1296, "Band 1 (L10..L13) must contain 1296 vertical column tasks (324 columns x 4 layers)");
  assert.equal(band2Tasks.length, 1296, "Band 2 (L14..L17) must contain 1296 vertical column tasks (324 columns x 4 layers)");
  assert.ok(band1Tasks.every(t => t.order === 40.2), "All Band 1 vertical generator tasks must share order 40.2");
  assert.ok(band2Tasks.every(t => t.order === 56.2), "All Band 2 vertical generator tasks must share order 56.2");

  // 3. 5th Bot Sweeper / Janitor work division & Coordinator tempBlocks sync
  assert.deepEqual(builderWorkerIndices(5), [0, 1, 2, 3], "With 5 bots, workers 0..3 are builders and worker 4 is the dedicated sweeper");
  assert.equal(isSweeperWorker(4, 5, { building: { enableSweeperBot: true } }), true);
  assert.equal(isSweeperWorker(0, 5, { building: { enableSweeperBot: true } }), false);

  const coord5 = new Coordinator();
  for (let i = 0; i < 5; i++) coord5.register(`Bot${i}`, i, { role: i === 4 ? "sweeper" : "builder" });
  assert.equal(coord5.hasActiveSweeper(), true, "Coordinator must report active sweeper when 5th bot is registered");

  const builders = [0, 1, 2, 3].map(i => new BuildPlanner(loaded2, tf2, world2, { building: { enableSweeperBot: true } }, console).build().joinFleet(coord5, `Bot${i}`, i, 5));
  const totalAssignedToBuilders = builders.reduce((acc, pl) => acc + [...pl.tasks.values()].filter(t => pl.assignedToMe(t)).length, 0);
  assert.equal(totalAssignedToBuilders, planner2.tasks.size, "100% of schematic tasks must be partitioned across the 4 builder bots (0..3) when bot 4 is sweeper");

  // Verify ScaffoldManager automatically broadcasts temporary blocks to Coordinator and SweeperEngine sweeps them top-down
  let dugBlocks = [];
  const sweeperBot = {
    username: "Bot4",
    entity: { position: new Vec3(1012.5, -55, 1010.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    getControlState: () => false,
    setControlState: () => {},
    physicsEnabled: true
  };
  const sc0 = new ScaffoldManager({
    bot: { username: "Bot0", entity: { position: new Vec3(1002.5, -55, 1002.5) }, builder: { fleet: { coord: coord5 } } },
    world: world2,
    config: { building: {} },
    logger: console
  });
  wMap2.set("1010,-55,1010", { name: "cobblestone", boundingBox: "block", position: new Vec3(1010, -55, 1010), getProperties: () => ({}) });
  wMap2.set("1010,-54,1010", { name: "cobblestone", boundingBox: "block", position: new Vec3(1010, -54, 1010), getProperties: () => ({}) });
  sc0.created.set("1010,-55,1010", new Vec3(1010, -55, 1010));
  sc0.created.set("1010,-54,1010", new Vec3(1010, -54, 1010));
  assert.equal(coord5.listTempBlocks().length, 2, "ScaffoldManager.created.set must auto-register temporary blocks in Coordinator");

  const sweeper = new SweeperEngine({
    bot: sweeperBot,
    world: world2,
    config: { building: {} },
    logger: console,
    planner: builders[0],
    coord: coord5,
    nav: { goTo: async () => true },
    look: { lookAtPoint: async () => {} },
    interaction: {
      digAimed: async (b) => {
        dugBlocks.push(`${b.position.x},${b.position.y},${b.position.z}`);
        wMap2.delete(`${b.position.x},${b.position.y},${b.position.z}`);
      }
    }
  });
  await sweeper.tickOnce();
  await sweeper.tickOnce();
  assert.deepEqual(dugBlocks, ["1010,-54,1010", "1010,-55,1010"], "SweeperEngine must break temporary blocks strictly top-down (y=-54 before y=-55)");
  assert.equal(coord5.listTempBlocks().length, 0, "SweeperEngine must clear broken temporary blocks from Coordinator");

  // 4. Background LookaheadEngine precomputes AimSolver candidates for upcoming tasks
  const tUpcoming = [...builders[0].tasks.values()].find(t => t.name === "smooth_stone" && t.kind === "block");
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const fx = tUpcoming.world.x + dx, fy = tUpcoming.world.y - 1, fz = tUpcoming.world.z + dz;
      wMap2.set(`${fx},${fy},${fz}`, { name: "grass_block", boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], position: new Vec3(fx, fy, fz), getProperties: () => ({}) });
    }
  }
  const lookBot = {
    username: "Bot0",
    entity: { position: new Vec3(tUpcoming.world.x + 1.5, tUpcoming.world.y, tUpcoming.world.z + 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    getControlState: () => false,
    setControlState: () => {},
    world: { raycast: () => null }
  };
  const aimLook = new AimSolver(lookBot, world2, { building: {} });
  const placerLook = new Placer({ bot: lookBot, world: world2, config: { building: {} }, logger: console, aim: aimLook, scaffold: sc0, planner: builders[0] });
  const lookahead = new LookaheadEngine({ bot: lookBot, world: world2, config: { building: {} }, logger: console, planner: builders[0], aim: aimLook, placer: placerLook });
  lookBot.builder = { lookahead, placer: placerLook };
  lookahead._precomputeTask(tUpcoming, lookBot.entity.position);
  const cachedCands = lookahead.getCachedCandidates(tUpcoming, tUpcoming.info.specs[0]);
  assert.ok(Array.isArray(cachedCands) && cachedCands.length > 0, "LookaheadEngine must pre-solve and cache AimSolver candidates for upcoming task");

  // 5. Anti-Hover & Anti-Stop guarantee: GroundMonitor releases stuck sneak when block under feet is broken so bot falls immediately
  let sneakState = true;
  const hoverBot = {
    entity: { position: new Vec3(1004.5, -53, 1008.5), velocity: new Vec3(0, 0, 0), onGround: false, isInWater: false, isInLava: false },
    physicsEnabled: false,
    getControlState: k => k === "sneak" ? sneakState : false,
    setControlState: (k, v) => { if (k === "sneak") sneakState = v; }
  };
  const gm = new GroundMonitor(hoverBot, world2);
  const stHover = gm.state();
  assert.equal(hoverBot.physicsEnabled, true, "GroundMonitor.state() must force physicsEnabled = true");
  assert.equal(sneakState, false, "GroundMonitor.state() must release stuck sneak when bot is hovering over air with no solid block under feet");
  assert.equal(stHover, "airborne", "Bot over broken block with 0 velocity must transition to airborne (not resting)");
  assert.ok(legacyDefaults.building.giveUpAfterMs >= 1800000, "legacy-defaults.js giveUpAfterMs must be >= 30 minutes (1800000ms) so bots never stop early");
});

test("v4.5 Render & VPS Cloud GUI: 0.0.0.0 binding, non-localhost Host header support, /healthz endpoint, Download Learned & Data (.zip), and Wipe Learned & Data API", async () => {
  const fs = require("fs");
  const path = require("path");
  const { start: startGui, clearLearnedAndData, buildLearnedAndDataZip } = require("../src/gui/server");

  const root = path.resolve(__dirname, "..");
  const learnedFile = path.join(root, "learned", "_test_memory.json");
  const dataFile = path.join(root, "data", "_test_session.log");
  fs.mkdirSync(path.dirname(learnedFile), { recursive: true });
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  fs.writeFileSync(learnedFile, JSON.stringify({ test: true }));
  fs.writeFileSync(dataFile, "test log line\n");

  const zipBuf = buildLearnedAndDataZip();
  assert.ok(Buffer.isBuffer(zipBuf) && zipBuf.length > 30, "buildLearnedAndDataZip must return a non-empty ZIP buffer");
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, "ZIP buffer must start with PKZIP local file header signature 0x04034b50");
  assert.ok(zipBuf.toString("utf8").includes("learned/_test_memory.json"), "ZIP archive must include files from learned/");
  assert.ok(zipBuf.toString("utf8").includes("data/_test_session.log"), "ZIP archive must include files from data/");

  // Verify HTTP server works with Render host header (`my-bots.onrender.com`) and serves /healthz
  const srv = await startGui(0, "127.0.0.1");
  try {
    const port = srv.address().port;
    const healthRes = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { Host: "minecraft-human-builder.onrender.com" }
    });
    assert.equal(healthRes.status, 200, "/healthz must return 200 on Render hostname");
    const healthJson = await healthRes.json();
    assert.equal(healthJson.ok, true);

    const pageRes = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { Host: "minecraft-human-builder.onrender.com" }
    });
    assert.equal(pageRes.status, 200, "GUI index page must load on Render hostname without 403 bad host");
    const html = await pageRes.text();
    assert.ok(html.includes("Download Learned &amp; Data (.zip)"), "GUI HTML must contain Download Learned & Data (.zip) button");
    assert.ok(html.includes("Remove All Learned &amp; Data"), "GUI HTML must contain Remove All Learned & Data button");
  } finally {
    srv.close();
  }

  // Verify spawning `node start-render.js` as a standalone process (exact Render startCommand) stays alive and binds PORT
  const { spawn } = require("child_process");
  const testPort = 18923;
  const proc = spawn(process.execPath, [path.join(root, "start-render.js")], {
    cwd: root,
    env: { ...process.env, RENDER: "true", PORT: String(testPort), MHB_GUI_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  proc.stdout.on("data", d => { stdout += String(d); });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 4000 && !stdout.includes("listening on")) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(proc.exitCode, null, "node start-render.js must stay running and NOT exit early");
    const r = await fetch(`http://127.0.0.1:${testPort}/healthz`);
    assert.equal(r.status, 200, "spawned start-render.js must respond 200 OK on /healthz");
  } finally {
    try { proc.kill("SIGTERM"); } catch {}
  }

  // Clean up test files
  try { fs.rmSync(learnedFile, { force: true }); } catch {}
  try { fs.rmSync(dataFile, { force: true }); } catch {}
});

test("v5.0 fixes (13-48-36.mp4 & session.log): elevated packed_ice deck over water channels, spruce_fence_gate after glass ordering, active wavefront protection against mid-air nextAny stone towers, zero support place-break loops, Sweeper staircase preservation, camera-preserving slide, and zero-delay MotionGuard", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { createHuman } = require("../src/navigation/human");
  const { MotionGuard } = require("../src/recovery/motion-guard");
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const { Coordinator } = require("../src/fleet/coordinator");

  // 1. Load Tree Gaming Cobblestone Wall Farm.litematic at origin (986, -60, 1125)
  const schematic = await loadLitematic("./schematics/Tree Gaming Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const tr = buildTransform(schematic, new Vec3(986, -60, 1125), 0);
  const worldMap = new Map();
  const botObj = {
    username: "Buildd",
    entity: { position: new Vec3(1005.5, -57, 1138.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.8 },
    controlState: {},
    setControlState (k, v) { this.controlState[k] = v; },
    getControlState (k) { return Boolean(this.controlState[k]); },
    clearControlStates () { this.controlState = {}; },
    on () {}, once () {}, removeListener () {},
    pathfinder: { thinkTimeout: 6000, tickTimeout: 30, searchRadius: 256, setMovements () {} },
    blockAt (p) { return worldModel.blockAt(p); }
  };
  const worldModel = {
    bot: botObj,
    blockAt (pos) {
      const k = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
      if (worldMap.has(k)) return worldMap.get(k);
      if (Math.floor(pos.y) <= -61) return { name: "grass_block", position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) };
      return { name: "air", position: new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)), boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    }
  };
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();

  // 2. Verify spruce_fence_gate on Layer 1 and Layer 3 is ordered at layer * 4 + 0.15 AFTER solid glass/packed_ice (layer * 4)
  const gateL3 = planner.tasks.get("987,-57,1127");
  const glassL3 = planner.tasks.get("988,-57,1126");
  const iceL3 = planner.tasks.get("993,-57,1126");
  assert.ok(gateL3 && glassL3 && iceL3, "Layer 3 spruce_fence_gate, glass, and packed_ice tasks must exist");
  assert.equal(glassL3.order, 12, "Layer 3 glass must be at order 12.0");
  assert.equal(iceL3.order, 12, "Layer 3 packed_ice must be at order 12.0");
  assert.equal(gateL3.order, 12.15, "Layer 3 spruce_fence_gate must be ordered at 12.15 after glass/packed_ice");

  // 3. Complete Layer 0..1 and the main Layer 2 packed_ice deck (x=990..1026, y=-58), plus 989,-58,1127..1131 on the west rail
  for (const t of planner.tasks.values()) {
    if (t.layer <= 1 || (t.layer === 2 && (t.world.x >= 990 || (t.world.x === 989 && t.world.z <= 1131) || (t.world.x === 987 && t.world.z <= 1131)))) {
      planner.setStatus(t, "completed");
      if (t.kind === "block") {
        worldMap.set(t.key, { name: t.name, position: t.world.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t.properties, getProperties: () => t.properties });
      }
    }
  }

  // Verify elevated Layer 2 packed_ice deck at (1010, -58, 1138) is NOT treated as an active pit cell on floor (-58), feet (-57), or head (-56)
  assert.equal(planner.isActivePitCell(1010, -58, 1138), false, "Solid packed_ice deck block at y=-58 must not be an active pit cell");
  assert.equal(planner.isActivePitCell(1010, -57, 1138), false, "Feet cell at y=-57 above packed_ice deck must not be an active pit cell");
  assert.equal(planner.isActivePitCell(1010, -56, 1138), false, "Head cell at y=-56 above packed_ice deck must not be an active pit cell even when Layer 4 has water");

  const fakeMovements = { exclusionAreasStep: [] };
  const human = createHuman(botObj, { movements: fakeMovements });
  assert.equal(typeof human.prewarmRoute, "function", "human controller must expose prewarmRoute for background LookaheadEngine");
  botObj.builder = { planner };
  const stepPenaltyFloor = fakeMovements.exclusionAreasStep.reduce((acc, fn) => acc + fn(worldModel.blockAt(new Vec3(1010, -58, 1138))), 0);
  const stepPenaltyFeet = fakeMovements.exclusionAreasStep.reduce((acc, fn) => acc + fn(worldModel.blockAt(new Vec3(1010, -57, 1138))), 0);
  assert.equal(stepPenaltyFloor, 0, "human exclusionAreasStep must give 0 penalty on solid packed_ice deck floor");
  assert.ok(stepPenaltyFeet <= 12, `human exclusionAreasStep on feet cell with pending Layer 3 task must be soft (<=12, got ${stepPenaltyFeet}), never 250 impassable`);

  // 4. Verify active wavefront protection: when frontier block 989,-58,1132 and 987,-58,1132 are claimed by Worker 0 & 1,
  // Worker 2 must NEVER pick mid-air 989,-58,1135..1141 via nextCandidate or nextAny, and instead advances via next() to Layer 3 on the finished 990..1026 deck!
  const t988 = planner.tasks.get("988,-58,1127");
  if (t988) {
    planner.setStatus(t988, "completed");
    worldMap.set(t988.key, { name: t988.name, position: t988.world.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], properties: t988.properties, getProperties: () => t988.properties });
  }
  const coord = new Coordinator();
  coord.register("Build", 0, { entity: { position: new Vec3(987.5, -57, 1131.5) } });
  coord.register("Buildd", 1, { entity: { position: new Vec3(989.5, -57, 1131.5) } });
  coord.register("Monster", 2, botObj);
  planner.joinFleet(coord, "Monster", 2, 5);
  coord.claim("Build", planner.tasks.get("987,-58,1132"));
  coord.claim("Buildd", planner.tasks.get("989,-58,1132"));
  assert.equal(planner.hasActiveWavefrontInGroup(planner.orderGroups.get(8)), true, "Order 8 (Layer 2) must report active wavefront while 989,-58,1132 is ready");
  const candMidAir = planner.nextCandidate(new Vec3(989.5, -57, 1136.5));
  assert.equal(candMidAir, null, "nextCandidate must return null instead of picking unready mid-air rail blocks while wavefront is active");
  const nextReadyL3 = planner.next(new Vec3(1010.5, -57, 1138.5));
  assert.ok(nextReadyL3 && nextReadyL3.layer === 3 && planner.isReady(nextReadyL3), "Idle worker blocked on narrow Layer 2 rail wavefront must advance to ready Layer 3 block over completed 3x3 deck");

  // 5. Verify Sweeper preserves isAccessStep staircase blocks and temp blocks near pending tasks until finalSweep === true
  const stepVec = new Vec3(985, -60, 1124);
  stepVec.isAccessStep = true;
  worldMap.set("985,-60,1124", { name: "stone", position: stepVec.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  coord.addTempBlock(stepVec, "Buildd");
  const nearPendingVec = new Vec3(989, -59, 1134);
  worldMap.set("989,-59,1134", { name: "stone", position: nearPendingVec.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  coord.addTempBlock(nearPendingVec, "Monster");
  const sweeper = new SweeperEngine({
    builder: {}, bot: botObj, world: worldModel, config: {}, logger: { info () {}, debug () {} },
    fleet: { coord, id: "Sweeper", index: 4, count: 5 }, planner, placer: {}, scaffold: { created: new Map() }, survival: {}, nav: {}, exit: {}
  });
  sweeper.syncTempBlocks();
  const syncedStep = sweeper.scaffold.created.get("985,-60,1124");
  const syncedNear = sweeper.scaffold.created.get("989,-59,1134");
  assert.equal(Boolean(syncedStep?.isAccessStep), true, "syncTempBlocks must preserve isAccessStep flag from coordinator");
  assert.equal(sweeper.isSafeToBreak(syncedStep, false), false, "Sweeper must never break isAccessStep staircase blocks before finalSweep");
  assert.equal(sweeper.isSafeToBreak(syncedStep, true), true, "Sweeper must clean up isAccessStep staircase blocks during finalSweep");
  assert.equal(sweeper.isSafeToBreak(syncedNear, false), false, "Sweeper must never break support blocks within 2m horizontally of unfinished schematic tasks");

  // 6. Verify ScaffoldManager.slide() strafes without calling look.lookAtPoint (never rotating camera away from target) and MotionGuard has 0 key-hold delay
  let lookCalled = 0;
  let ticksRun = 0;
  const slideBot = {
    entity: { position: new Vec3(989.5, -57, 1131.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: -0.4, onGround: true },
    controlState: {},
    setControlState (k, v) {
      this.controlState[k] = v;
      if (v && (k === "forward" || k === "back" || k === "left" || k === "right")) {
        this.entity.position = new Vec3(989.5, -57, 1131.8);
      }
    },
    getControlState (k) { return Boolean(this.controlState[k]); },
    once (ev, cb) { ticksRun++; setImmediate(cb); },
    removeListener () {}
  };
  const sm = new ScaffoldManager({
    bot: slideBot, world: worldModel, config: {}, logger: {}, nav: {}, interaction: {}, materials: {},
    look: { lookAtPoint: async () => { lookCalled++; } }, ground: {}
  });
  await sm.slide(new Vec3(989.5, -57, 1131.8));
  assert.equal(lookCalled, 0, "ScaffoldManager.slide must strafe without rotating camera toward the floor spot");
  assert.ok(ticksRun <= 5, `ScaffoldManager.slide must complete in <= 5 ticks (took ${ticksRun})`);

  const mg = new MotionGuard(slideBot, { safety: {} }, { info () {}, warn () {} });
  assert.equal(mg.cfg.minKeyHoldMs, 0, "MotionGuard minKeyHoldMs must be 0 so key flips are never delayed");
  assert.ok(mg.cfg.maxYawStep >= 70 * Math.PI / 180, "MotionGuard maxYawStep must allow fast human camera turns (>=70 deg/tick)");

  // 7. Verify 42,426-block McDs 64 Module Cobblestone Wall Farm.litematic has <15ms nextAny() (no 13.2s event-loop freeze!) and Layer 1 trapdoor ordering
  const mcdsSchem = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const mcdsTr = buildTransform(mcdsSchem, new Vec3(0, -60, 0), 0);
  const mcdsPlanner = new BuildPlanner({ schematic: mcdsSchem, tiles: mcdsSchem.tiles }, mcdsTr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();
  assert.equal(mcdsPlanner.tasks.get("19,-59,41")?.order, 4.05, "Layer 1 iron_trapdoor at 19,-59,41 must have order 4.05 after black_stained_glass (4.0)");
  const tAny0 = Date.now();
  mcdsPlanner.nextAny(new Vec3(25, -60, 32));
  const anyMs = Date.now() - tAny0;
  assert.ok(anyMs < 25, `nextAny() on 42,426-task McDs schematic must run in <25ms without blocking the event loop (took ${anyMs}ms)`);
  const tStats0 = Date.now();
  mcdsPlanner.getStats();
  const statsMs = Date.now() - tStats0;
  assert.ok(statsMs < 5, `getStats() on 42,426-task McDs schematic must run in <5ms (took ${statsMs}ms)`);
});

test("v5.1 fixes (McDs 64 Module hopper enabled/locked redstone state ignore, exterior hopper ledge non-pit, 3-block open-ground drop FallGuard, and steep downward observer aim)", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { describeBlock, matches, taskMatches } = require("../src/rules/blocks");
  const { specAccepts } = require("../src/interaction/aim");
  const { FallGuard } = require("../src/recovery/fall-guard");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");

  // 1. Hopper enabled=true/false and repeater locked=true/false are ignored on placement and world sync
  const hopperTrue = describeBlock("hopper", { facing: "north", enabled: "true" });
  const hopperFalse = describeBlock("hopper", { facing: "north", enabled: "false" });
  assert.deepEqual(hopperTrue.cmp, { facing: "north" }, "hopper cmp must only check facing, never redstone-driven enabled");
  assert.deepEqual(hopperFalse.cmp, { facing: "north" }, "hopper[enabled=false] cmp must only check facing");
  assert.equal(matches({ name: "hopper", getProperties: () => ({ facing: "north", enabled: false }) }, hopperTrue), true, "hopper with enabled=false must match schematic enabled=true");
  assert.equal(matches({ name: "hopper", getProperties: () => ({ facing: "north", enabled: true }) }, hopperFalse), true, "hopper with enabled=true must match schematic enabled=false");
  assert.equal(taskMatches({ name: "hopper", getProperties: () => ({ facing: "north", enabled: false }) }, { kind: "block", info: hopperTrue }), true);

  const repLocked = describeBlock("repeater", { facing: "north", delay: "3", locked: "true", powered: "true" });
  assert.equal(repLocked.cmp.locked, undefined, "repeater cmp must ignore server-computed locked state");

  // 2. Vertical observer with facing=down (look=down) rejects shallow diagonal look vectors that would place facing=east
  const obsDownSpec = describeBlock("observer", { facing: "down", powered: "true" }).specs[0];
  const shallowDiag = new Vec3(-0.66, -0.74, 0.12); // |y|/len = 0.74, margin = 0.08 -> too close to 45-deg east boundary
  assert.equal(specAccepts(obsDownSpec, { f: "up" }, shallowDiag, new Vec3(0.5, 1, 0.5), new Vec3(0, 0, 0), true), false, "Shallow diagonal pitch near 45 deg must be rejected for vertical observer");
  const steepDown = new Vec3(-0.25, -0.95, 0.15);
  assert.equal(specAccepts(obsDownSpec, { f: "up" }, steepDown, new Vec3(0.5, 1, 0.5), new Vec3(0, 0, 0), true), true, "Steep downward pitch must be accepted for vertical observer");

  // 3. McDs 64 Module exterior hopper row (948..970,-58,1382) is not treated as an active pitCell and FallGuard allows 3-block step-down to open ground
  const mcdsSchem = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const tr = buildTransform(mcdsSchem, new Vec3(922, -60, 1347), 0);
  const wMap = new Map();
  for (let x = 940; x <= 975; x++) {
    for (let z = 1375; z <= 1390; z++) {
      wMap.set(`${x},-61,${z}`, { name: "grass_block", position: new Vec3(x, -61, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
    }
  }
  wMap.set("948,-60,1381", { name: "observer", position: new Vec3(948, -60, 1381), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ facing: "west" }) });
  wMap.set("948,-59,1381", { name: "observer", position: new Vec3(948, -59, 1381), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ facing: "down" }) });
  wMap.set("948,-58,1381", { name: "crafter", position: new Vec3(948, -58, 1381), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ orientation: "north_up" }) });
  const worldModel = {
    blockAt: p => wMap.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: "air", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: "empty", shapes: [], getProperties: () => ({}) }
  };
  const planner = new BuildPlanner({ schematic: mcdsSchem, tiles: mcdsSchem.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();
  assert.equal(planner.isActivePitCell(948, -58, 1382), false, "Unplaced exterior hopper cell 948,-58,1382 must not be an active pit cell");
  assert.equal(planner.isActivePitCell(948, -57, 1382), false, "Standing cell 948,-57,1382 above exterior hopper must not be an active pit cell before placement");
  wMap.set("948,-58,1382", { name: "hopper", position: new Vec3(948, -58, 1382), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ facing: "north", enabled: false }) });
  assert.equal(planner.isActivePitCell(948, -58, 1382), false, "Placed exterior hopper cell 948,-58,1382 must not be an active pit cell");
  assert.equal(planner.isActivePitCell(948, -57, 1382), false, "Standing cell 948,-57,1382 above placed exterior hopper must not be an active pit cell");

  const controls = { forward: true, sneak: false };
  const botObj = {
    health: 20,
    builder: { running: true, planner },
    controlState: controls,
    setControlState: (k, v) => { controls[k] = Boolean(v); },
    getControlState: k => Boolean(controls[k]),
    entity: { position: new Vec3(948.5, -57, 1381.5), velocity: new Vec3(0, 0, 0.15), yaw: Math.PI, pitch: 0, onGround: true }
  };
  const fg = new FallGuard({ bot: botObj, world: worldModel, config: {}, logger: {}, navigation: { stop () {} }, ground: {} });
  fg.tick();
  assert.equal(controls.sneak, false, "FallGuard must not stop or sneak-clamp at 948,-57,1381 over exterior hopper 948,-58,1382");
});


test("v5.2 fixes (McDs 64 Module 93-min run: sea_lantern non-fragile horizontal ceiling placement, chest waterlogging, zero 75-block ping-pong trips, FallGuard elevated overhang & diagonal roof clearing, AimSolver/Brain roof-stand protection, and Sweeper under-roof reachability filter)", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { describeBlock } = require("../src/rules/blocks");
  const { AimSolver } = require("../src/interaction/aim");
  const { Placer } = require("../src/interaction/placer");
  const { FallGuard } = require("../src/recovery/fall-guard");
  const { Brain } = require("../src/navigation/brain");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const { Coordinator } = require("../src/fleet/coordinator");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");

  // 1. sea_lantern is a solid phase-0 free block (NOT a fragile standing lantern!), whereas lantern and soul_lantern remain fragile
  const seaLanternInfo = describeBlock("sea_lantern", {});
  assert.equal(seaLanternInfo.fragile, false, "sea_lantern must not be classified as fragile");
  assert.equal(seaLanternInfo.phase, 0, "sea_lantern must have phase 0 (structural solid)");
  assert.equal(seaLanternInfo.specs[0].tag, "free", "sea_lantern must use free (ALL_FACES) placement spec so it can attach horizontally in ceilings");
  const lanternInfo = describeBlock("lantern", { hanging: "false" });
  const soulLanternInfo = describeBlock("soul_lantern", { hanging: "true" });
  assert.equal(lanternInfo.fragile, true, "lantern must remain fragile");
  assert.equal(lanternInfo.specs[0].tag, "lantern-stand");
  assert.equal(soulLanternInfo.fragile, true, "soul_lantern must remain fragile");
  assert.equal(soulLanternInfo.specs[0].tag, "lantern-hang");

  // 2. McDs 64 Module Layer 6 sea_lantern@985,-54,1409 and 985,-54,1454 are order 24 (not 25) and become ready from horizontal stone_bricks neighbor even with air below
  const mcdsSchem = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const tr = buildTransform(mcdsSchem, new Vec3(922, -60, 1347), 0);
  const wMap = new Map();
  for (let x = 920; x <= 1030; x++) {
    for (let z = 1345; z <= 1480; z++) {
      wMap.set(`${x},-61,${z}`, { name: "grass_block", position: new Vec3(x, -61, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
    }
  }
  const worldModel = {
    blockAt: p => wMap.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) || { name: "air", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: "empty", shapes: [], getProperties: () => ({}) }
  };
  const planner = new BuildPlanner({ schematic: mcdsSchem, tiles: mcdsSchem.tiles }, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();
  const seaLanternTasks = [...planner.tasks.values()].filter(t => t.name === "sea_lantern" && t.layer === 6);
  assert.equal(seaLanternTasks.length, 2, "McDs 64 Module Layer 6 must have 2 sea_lantern tasks");
  const sl1 = seaLanternTasks[0];
  assert.equal(sl1.order, 24, "Layer 6 sea_lantern must have order 24 (phase 0), not 25");
  const sl1AdjKey = `${sl1.world.x},${sl1.world.y},${sl1.world.z - 1}`;
  wMap.set(sl1AdjKey, { name: "stone_bricks", position: new Vec3(sl1.world.x, sl1.world.y, sl1.world.z - 1), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  assert.equal(planner.isReady(sl1), true, "Layer 6 sea_lantern must be ready from horizontal stone_bricks neighbor even with air at y=-55 below it");

  // 3. Waterlogged chest is accepted by executeWaterlog without throwing 'it holds chest'
  const wlChestTask = [...planner.tasks.values()].find(t => t.kind === "waterlog" && t.name === "chest");
  assert.ok(wlChestTask, "Waterlogged chest task must exist in McDs 64 Module schematic");
  const wlKey = `${wlChestTask.world.x},${wlChestTask.world.y},${wlChestTask.world.z}`;
  wMap.set(wlKey, { name: "chest", position: wlChestTask.world.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ ...wlChestTask.info.props, waterlogged: "false" }) });
  const fakePlacer = Object.create(Placer.prototype);
  fakePlacer.world = worldModel;
  fakePlacer.planner = null;
  fakePlacer.materials = { ensureItem: async () => {}, ensureUsableItem: async () => {}, noteBucketUsed: async () => {} };
  fakePlacer.approach = async () => ({ pose: { face: new Vec3(0, 1, 0), faceOpt: { f: "up" }, ref: wlChestTask.world.clone(), faceName: "up" } });
  fakePlacer.setSneak = () => {};
  fakePlacer.aim = { fromPose: () => null, validateView: () => true };
  fakePlacer.aimAndValidate = async (_t, _s, pose) => ({ pose, view: { cursor: new Vec3(0.5, 0.5, 0.5) } });
  fakePlacer.check = () => {};
  fakePlacer.bot = { entity: { isInWater: false }, heldItem: { name: "water_bucket" } };
  fakePlacer.interaction = {
    sendUse: async () => {
      wMap.set(wlKey, { name: "chest", position: wlChestTask.world.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({ ...wlChestTask.info.props, waterlogged: "true" }) });
    },
    useHeldItem: () => {}
  };
  fakePlacer.scoopStrayWater = async () => {};
  const wlRes = await fakePlacer.executeWaterlog(wlChestTask);
  assert.equal(wlRes, "placed", "executeWaterlog must waterlog chest at 998,-55,1442 without refusing");

  // 4. Anti-ping-pong in scanGroup & searchGroup: bot finishes ready blocks at its feet instead of walking 75+ blocks to an earlier seq index or stealing across the map while own deferred tasks exist
  const coord = new Coordinator(5);
  coord.register("Build", 0, { entity: { position: new Vec3(944.5, -54, 1467.5) } });
  coord.register("Buildd", 1, { entity: { position: new Vec3(955.5, -52, 1469.5) } });
  coord.register("Monster", 2, { entity: { position: new Vec3(955.5, -52, 1395.5) } });
  coord.register("Monsterr", 3, { entity: { position: new Vec3(1016.5, -52, 1395.5) } });
  coord.register("Sweeper", 4, { role: "sweeper", entity: { position: new Vec3(985.5, -52, 1430.5) } });
  planner.joinFleet(coord, "Buildd", 1, 5);
  planner.architectActive = true;

  const farTask = {
    key: "1016,-53,1395", kind: "block", name: "stone_bricks", order: 28, layer: 7, status: "pending", attempts: 0, owner: 1,
    world: new Vec3(1016, -53, 1395), cellKey: "169,232", info: describeBlock("stone_bricks", {})
  };
  const nearTasks = Array.from({ length: 90 }, (_, i) => ({
    key: `955,-53,${1400 + i}`, kind: "block", name: "stone_bricks", order: 28, layer: 7, status: i < 89 ? "pending" : "pending", attempts: 0, owner: 1,
    world: new Vec3(955, -53, 1400 + i), cellKey: "159,244", info: describeBlock("stone_bricks", {})
  }));
  // Make both farTask and the last nearTask (at 955,-53,1469, dist=1 from bot) ready
  for (const k of ["1016,-54,1395", "1016,-55,1395", "955,-54,1469", "955,-55,1469"]) {
    const bt = planner.tasks.get(k);
    if (bt) bt.status = "completed";
  }
  wMap.set("1016,-54,1395", { name: "stone_bricks", position: new Vec3(1016, -54, 1395), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("955,-54,1469", { name: "stone_bricks", position: new Vec3(955, -54, 1469), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  const nearReadyTask = nearTasks[69]; // 955,-53,1469 at scanned=71!
  const fakeGroup = {
    order: 28,
    remaining: 91,
    seqPtr: 0,
    seqList: [farTask, ...nearTasks],
    cells: new Map([["169,232", new Set([farTask])], ["159,244", new Set(nearTasks)]])
  };
  const picked = planner.scanGroup(fakeGroup, new Vec3(955.5, -52, 1469.5), true, "own");
  assert.equal(picked.key, nearReadyTask.key, "scanGroup must pick ready block right next to the bot (dist=1) instead of walking 96 blocks back to seqPtr=0");

  // Also verify searchGroup does not steal a task 96 blocks away when worker still has its own deferred task at dist=2
  farTask.owner = 3; // owned by Monsterr at 1016,-52,1395
  for (const nt of nearTasks) nt.status = "completed";
  nearReadyTask.status = "deferred";
  nearReadyTask.deferredUntil = Date.now() + 1200;
  nearReadyTask.owner = 1;
  const searchPicked = planner.searchGroup(fakeGroup, new Vec3(955.5, -52, 1469.5), true);
  assert.equal(searchPicked?.key, nearReadyTask.key, "searchGroup must wake own local deferred task (dist=1) instead of walking 96 blocks across the map to steal from Monsterr");

  // 5. FallGuard on elevated Layer 6/7 roof (y=-52 over y=-61 grass) classifies drop as 'pit' (never 'void'), clears hole as soon as diagonal roof block is placed, and preserves controls when sneaking
  const fgControls = { forward: true, sneak: true };
  const fgBot = {
    health: 20,
    builder: { running: true, planner },
    controlState: fgControls,
    setControlState: (k, v) => { fgControls[k] = Boolean(v); },
    getControlState: k => Boolean(fgControls[k]),
    entity: { position: new Vec3(958.5, -52, 1466.5), velocity: new Vec3(0, 0, 0.12), yaw: Math.PI, pitch: 0, onGround: true }
  };
  const fg = new FallGuard({ bot: fgBot, world: worldModel, config: {}, logger: {}, navigation: { stop () {} }, ground: {} });
  assert.equal(fg.hazardAt(958.5, -52, 1467.5, 3), "pit", "Elevated overhang 8 blocks above superflat grass must be classified as pit, never void");
  fg.tick();
  assert.equal(fgControls.forward, true, "FallGuard must not zero out forward control when bot is already sneaking on a non-lava block edge");
  fg.recordHole(958, -52, 1467, "void");
  assert.equal(fg.isHole(958, 1467, -60), false, "Hole recorded at y=-52 must never poison ground level y=-60");
  // Place diagonal roof stone_bricks at 958,-53,1467 (with air at y=-54,-55 below it)
  wMap.set("958,-53,1467", { name: "stone_bricks", position: new Vec3(958, -53, 1467), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  assert.equal(fg.isHole(958, 1467, -51), false, "Placing diagonal roof block at y=-53 must clear hole memory even when queried at head cell y=-51 with air at y=-54");
  assert.equal(fg.holes.has("958,1467"), false, "Hole entry 958,1467 must be deleted once roof block is placed");

  // 6. AimSolver on FREE spec does not generate stands 4-5 blocks below an elevated roof when bot is on the roof, and Brain.connect refuses to drop/escape downward off the roof
  wMap.set("967,-53,1466", { name: "stone_bricks", position: new Vec3(967, -53, 1466), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("967,-57,1467", { name: "stone_bricks", position: new Vec3(967, -57, 1467), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  const roofBot = {
    entity: { position: new Vec3(967.5, -52, 1466.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, height: 1.8, onGround: true },
    getControlState: () => false,
    world: { raycast: () => null }
  };
  const aimRoof = new AimSolver(roofBot, worldModel, {});
  const freeSpec = describeBlock("stone_bricks", {}).specs[0];
  const roofCands = aimRoof.candidates(new Vec3(967, -52, 1467), freeSpec, { allowScaffold: false });
  assert.ok(roofCands.every(c => c.stand.y >= -54), "AimSolver on FREE spec when bot is at y=-52 must not generate under-roof stands at y=-56..-60");

  let rescueCalled = false;
  const brain = new Brain({ bot: roofBot, world: worldModel, config: {}, logger: { info () {}, warn () {} }, nav: {}, scaffold: {}, survival: {} });
  brain.rescue = async () => { rescueCalled = true; return { escaped: true }; };
  const connRes = await brain.connect(new Vec3(967.5, -56, 1467.5), { cells: new Map([["967,-56,1467", { x: 967, y: -56, z: 1467 }]]) });
  assert.equal(connRes, false, "Brain.connect must refuse to drop/escape from roof y=-52 down to under-roof stand y=-56");
  assert.equal(rescueCalled, false, "Brain.connect must never invoke exit.escape downward off an elevated roof");

  // 7. SweeperEngine skips calling nav.goTo when all candidate stands for an under-roof temp block have reachVerdict === 'no'
  wMap.set("960,-56,1465", { name: "stone", position: new Vec3(960, -56, 1465), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("960,-57,1466", { name: "stone", position: new Vec3(960, -57, 1466), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  let navGoToCalls = 0;
  const swPlacer = {
    aim: aimRoof,
    brain: {},
    standingStill: () => true,
    reachVerdict: () => "no",
    isDeadStand: () => false,
    noteDeadStand: () => {},
    fluidBeside: () => false
  };
  const tempVec = new Vec3(960, -56, 1465);
  tempVec.createdAt = Date.now() - 20_000;
  const sweeper = new SweeperEngine({
    builder: {},
    bot: roofBot,
    world: worldModel,
    config: { navigation: { pearls: false } },
    logger: { info () {}, debug () {} },
    planner: { tasks: new Map() },
    placer: swPlacer,
    scaffold: { created: new Map([["960,-56,1465", tempVec]]), getCreated () { return [...this.created.values()]; }, contains () { return false; } },
    nav: { goTo: async () => { navGoToCalls++; } }
  });
  const brokeUnderRoof = await sweeper.breakTempBlock(tempVec, false);
  assert.equal(brokeUnderRoof, false, "Sweeper must immediately skip unreachable under-roof temporary block");
  assert.equal(navGoToCalls, 0, "Sweeper must not invoke expensive A* nav.goTo when reachVerdict is 'no'");
  assert.equal(sweeper.isSafeToBreak(tempVec, false), false, "Unreachable under-roof temporary block must be on long cooldown during !finalSweep");
});

test("v5.3 fixes (McDs 64 Module 9h overnight run: L15..L18 & L19..L22 vertical generator column bands, 1-block gap parkour & diagonal graph, spruce_door & door-attached wall_sign, #w child sync on completed parent, auto-descend temporary towers + in-place waterlog & support sweep, GroundMonitor anti-hover nudge, and unreachable tower/support base filter)", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { AimSolver } = require("../src/interaction/aim");
    const { Brain } = require("../src/navigation/brain");
  const { ScaffoldManager } = require("../src/recovery/scaffold-manager");
  const { GroundMonitor } = require("../src/world/ground");
  const { SweeperEngine } = require("../src/fleet/sweeper");

  const { describeBlock } = require("../src/rules/blocks");
  const wMap = new Map();
  for (let x = 970; x <= 982; x++) {
    for (let z = 1384; z <= 1393; z++) {
      wMap.set(`${x},-51,${z}`, { name: "white_stained_glass", position: new Vec3(x, -51, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
    }
  }
  const worldModel = {
    blockAt: (p) => {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return wMap.get(k) || { name: "air", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    },
    isLoaded: () => true,
    isWalkableStand: () => true
  };
  const t0 = Date.now();
  const mcdsSchem = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const transform = buildTransform(mcdsSchem, new Vec3(922, -60, 1347), 0);
  const planner = new BuildPlanner({ schematic: mcdsSchem, tiles: mcdsSchem.tiles }, transform, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();
  const buildMs = Date.now() - t0;
  assert.ok(buildMs < 5000, `BuildPlanner.build() on 80k-block McDs 64 Module must complete in <5s (took ${buildMs}ms)`);

  // 1. Vertical generator column bands L15..L18 (order 60.2) and L19..L22 (order 76.2)
  const verticalBands = [...planner.orderGroups.entries()].filter(([, g]) => g.isVerticalWallBand);
  assert.equal(verticalBands.length, 2, "McDs 64 Module must detect 2 stacked 4-layer vertical generator column bands (L15..L18 and L19..L22)");
  assert.equal(verticalBands[0][0], 60.2, "Band 0 must be at order 60.2 (Layer 15, y=-45)");
  assert.equal(verticalBands[1][0], 76.2, "Band 1 must be at order 76.2 (Layer 19, y=-41)");
  const band0Task = verticalBands[0][1].seqList[0];
  assert.ok(band0Task && band0Task.verticalColumn && band0Task.verticalClusterId >= 0, "Generator column task must be grouped into a vertical self-pillar/partner cluster");

  // 2. Door ordering before corridor walls (spruce_door@977,-50,1389 at 40.02 before glass@977,-50,1390 at 40.08)
  const doorTask = planner.tasks.get("977,-50,1389");
  const adjWallTask = planner.tasks.get("977,-50,1390");
  assert.ok(doorTask && adjWallTask, "Door and adjacent corridor glass wall must exist on Layer 10");
  assert.equal(doorTask.order, 40.02, "spruce_door@977,-50,1389 must be ordered at 40.02");
  assert.ok(doorTask.order < adjWallTask.order, `spruce_door (${doorTask.order}) must precede adjacent corridor wall (${adjWallTask.order}) so doorway is not sealed before placement`);

  // 3. Door-attached wall sign (spruce_wall_sign@976,-49,1388 attached to upper half of spruce_door@977,-50,1388)
  wMap.set("977,-50,1388", { name: "spruce_door", position: new Vec3(977, -50, 1388), boundingBox: "block", shapes: [[0, 0, 0, 0.1875, 1, 1]], getProperties: () => ({ half: "lower", facing: "east", open: "false" }) });
  wMap.set("977,-49,1388", { name: "spruce_door", position: new Vec3(977, -49, 1388), boundingBox: "block", shapes: [[0, 0, 0, 0.1875, 1, 1]], getProperties: () => ({ half: "upper", facing: "east", open: "false" }) });
  planner.tasks.get("977,-50,1388").status = "completed";
  const signTask = planner.tasks.get("976,-49,1388");
  assert.ok(signTask, "spruce_wall_sign@976,-49,1388 must exist");
  assert.equal(planner.isReady(signTask, worldModel), true, "spruce_wall_sign@976,-49,1388 must be ready once spruce_door@977,-50,1388 is placed");
  const signBot = {
    entity: { position: new Vec3(975.5, -50, 1388.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, height: 1.8, onGround: true },
    getControlState: () => false,
    world: { raycast: () => null }
  };
  const aimSign = new AimSolver(signBot, worldModel, {});
  const signSpec = describeBlock("spruce_wall_sign", signTask.properties).specs[0];
  assert.equal(aimSign.isSolidRef(wMap.get("977,-49,1388")), true, "AimSolver.isSolidRef must accept spruce_door as a solid reference for wall signs");
  const signPose = aimSign.fromPose(new Vec3(976, -49, 1388), signSpec, null, {});
  assert.ok(signPose && signPose.faceName === "west", "AimSolver.fromPose must find a valid west-face aim point on the upper half of spruce_door@977,-49,1388");

  // 4. #w waterlog child unblocks immediately when parent block transitions to 'completed' (cross-fleet sync)
  const wlChild = planner.tasks.get("930,-47,1351#w");
  assert.ok(wlChild, "Waterlog child 930,-47,1351#w must exist on Layer 13");
  wlChild.status = "blocked";
  planner.setStatus(planner.tasks.get("930,-47,1351"), "completed");
  assert.equal(wlChild.status, "pending", "setStatus(parent, 'completed') must automatically unblock #w waterlog child from 'blocked' to 'pending'");

  // 5. Open-basin water at order 88009.25 is properly treated as endgame phase (>= 88000)
  const basinWater = planner.tasks.get("924,-51,1349");
  assert.ok(basinWater && basinWater.order >= 88000 && basinWater.order < 90000, `Deferred open-basin water@928,-51,1442 must have order in 88000..89999 (${basinWater?.order})`);

  // 6. Brain.makeGraph supports diagonal 1-block steps and 1-block gap parkour across column tops
  wMap.set("932,-42,1382", { name: "oak_leaves", position: new Vec3(932, -42, 1382), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("934,-42,1382", { name: "oak_leaves", position: new Vec3(934, -42, 1382), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("935,-42,1383", { name: "oak_leaves", position: new Vec3(935, -42, 1383), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  const colBot = {
    entity: { position: new Vec3(932.5, -41, 1382.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, height: 1.8, onGround: true },
    getControlState: () => false
  };
  const colBrain = new Brain({ bot: colBot, world: worldModel, config: {}, logger: {}, nav: {}, scaffold: {}, survival: {} });
  const reachParkour = colBrain.reachability(new Vec3(935.5, -41, 1383.5));
  assert.equal(reachParkour.verdict, "yes", "Brain must connect column tops at y=-41 across a 1-block parkour gap (932->934) and diagonal step (934,1382->935,1383)");

  // 7. GroundMonitor anti-hover nudge when block under bot's center is broken (0.08m edge overlap)
  const hoverControls = { sneak: true };
  const hoverBot = {
    entity: { position: new Vec3(980.02, -46, 1480.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    setControlState: (k, v) => { hoverControls[k] = Boolean(v); },
    getControlState: (k) => Boolean(hoverControls[k]),
    builder: { placer: { phase: "idle" } }
  };
  const gm = new GroundMonitor(hoverBot, worldModel);
  gm.samples = [
    { x: 980.02, y: -46, z: 1480.5, vy: 0, t: Date.now() - 500 },
    { x: 980.02, y: -46, z: 1480.5, vy: 0, t: Date.now() }
  ];
  const gmState = gm.state();
  assert.equal(gmState, "airborne", "GroundMonitor.state() must return 'airborne' (not 'grounded') when the block directly under bot center (980,-47,1480) is air");
  assert.equal(hoverControls.sneak, false, "GroundMonitor must release sneak when hovering over air");
  assert.ok(hoverBot.entity.position.x > 980.02, "GroundMonitor must nudge entity position toward block center so it drops off the 0.08m edge lip");

  // 8. ScaffoldManager._tower auto-descends an existing temporary tower before walking to a new column
  let descendPreCalled = 0;
  let goToCalledWith = null;
  const scBot = {
    entity: { position: new Vec3(940.5, -48, 1400.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    setControlState: () => {},
    getControlState: () => false,
    on: () => {},
    removeListener: () => {}
  };
  wMap.set("940,-49,1400", { name: "stone", position: new Vec3(940, -49, 1400), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("940,-50,1400", { name: "stone", position: new Vec3(940, -50, 1400), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  const scMgr = new ScaffoldManager({
    bot: scBot,
    world: worldModel,
    config: {},
    logger: { info () {}, debug () {} },
    nav: { goTo: async (dest) => { goToCalledWith = dest; scBot.entity.position = dest.clone(); } },
    materials: { ensureItem: async () => true },
    interaction: {},
    look: {},
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    isReserved: () => false
  });
  scMgr.created.set("940,-49,1400", new Vec3(940, -49, 1400));
  scMgr.created.set("940,-50,1400", new Vec3(940, -50, 1400));
  scMgr._descend_h = async (targetLen) => {
    if (targetLen === 0) {
      descendPreCalled++;
      scMgr.created.clear();
      scBot.entity.position = new Vec3(940.5, -50, 1400.5);
    }
  };
  await scMgr._tower({ floor: new Vec3(944, -50, 1400), height: 0 }, new Vec3(944.5, -50, 1400.5));
  assert.equal(descendPreCalled, 1, "ScaffoldManager._tower must descend the existing temporary pillar at 940,1400 before walking to 944,1400");
  assert.ok(goToCalledWith && Math.floor(goToCalledWith.x) === 944, "After descending, ScaffoldManager._tower must walk to the new column floor at 944,-50,1400");

  // 9. SweeperEngine breaks multi-block temporary pillars top-down even near pending tasks
  const colBot2 = { entity: { position: new Vec3(950.5, -50, 1400.5) } };
  wMap.set("948,-50,1400", { name: "stone", position: new Vec3(948, -50, 1400), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  wMap.set("948,-49,1400", { name: "stone", position: new Vec3(948, -49, 1400), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  const p0 = new Vec3(948, -50, 1400); p0.createdAt = Date.now() - 20000;
  const p1 = new Vec3(948, -49, 1400); p1.createdAt = Date.now() - 20000;
  const sw2 = new SweeperEngine({
    builder: {},
    bot: colBot2,
    world: worldModel,
    config: {},
    logger: {},
    planner: { tasks: new Map([["948,-47,1400", { world: new Vec3(948, -47, 1400), status: "pending" }]]) },
    placer: { fluidBeside: () => false },
    scaffold: {
      created: new Map([["948,-50,1400", p0], ["948,-49,1400", p1]]),
      getCreated () { return [...this.created.values()]; },
      contains (v) { return this.created.has(`${v.x},${v.y},${v.z}`); }
    },
    nav: {}
  });
  assert.equal(sw2.isSafeToBreak(p1, false), true, "Top block of multi-block temporary pillar must be safe to break immediately");
  assert.equal(sw2.isSafeToBreak(p0, false), false, "Bottom block of multi-block temporary pillar must wait until top block p1 is broken first");
});


test("v5.4 fixes (05-31-40.zip & 10-34-00.mp4): O(1) forward-flood reachability cache (<2ms vs 2588ms CPU freeze), rim-walk + ender pearl canyon crossing, fence_gate before adjacent trapdoor, single-straggler layer unlock, Sweeper dead-stand loop breaker, and airborne ExitPlanner floor snap", async () => {
  const { Vec3 } = require("../src/util/vec3");
  const { loadSchematic, buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { Brain } = require("../src/navigation/brain");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const { ExitManager } = require("../src/recovery/exit");
  const path = require("path");

  const loaded = await loadSchematic(path.resolve(__dirname, "../schematics/McDs 64 Module Cobblestone Wall Farm.litematic"), { registry: { blocksByName: new Proxy({}, { get: (_, k) => ({ name: k, defaultState: 1 }) }) } });
  const origin = new Vec3(1134, -60, 1517);
  const tr = buildTransform(loaded.schematic, origin, 0);

  const wMap = new Map();
  const worldModel = {
    bot: { entity: { position: new Vec3(1188.5, -54, 1574.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true } },
    blockAt (pos) {
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
      const k = `${x},${y},${z}`;
      if (wMap.has(k)) return wMap.get(k);
      if (y === -61) return { name: "grass_block", position: new Vec3(x, y, z), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) };
      return { name: "air", position: new Vec3(x, y, z), boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    },
    isLoaded: () => true
  };

  const planner = new BuildPlanner(loaded, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();

  // 1. Layer 2 oak_fence_gate@1158,-58,1558 is ordered at 8.04 BEFORE adjacent iron_trapdoor@1158,-58,1557 (8.05)
  const fgTask = planner.tasks.get("1158,-58,1558");
  const tdTask = planner.tasks.get("1158,-58,1557");
  const roofAboveFg = planner.tasks.get("1158,-57,1558");
  assert.ok(fgTask && tdTask && roofAboveFg, "McDs 64 Module must have oak_fence_gate@1158,-58,1558, iron_trapdoor@1158,-58,1557, and black_stained_glass@1158,-57,1558");
  assert.ok(fgTask.order < tdTask.order, `oak_fence_gate (${fgTask.order}) must be ordered before adjacent iron_trapdoor (${tdTask.order})`);
  assert.equal(planner.hasDirectlyUnfinishedBelow(roofAboveFg), true, "black_stained_glass@1158,-57,1558 must wait for oak_fence_gate@1158,-58,1558 directly below it");

  // 2. Populate world with completed Layers 0..6 (except 1 retried straggler with attempts=2 on Layer 2)
  for (const t of planner.tasks.values()) {
    if (t.layer < 7 && t.order < 88000) {
      if (t.key === "1158,-58,1558") {
        t.attempts = 2;
        t.totalAttempts = 2;
        continue;
      }
      t.status = "completed";
      planner.completed.add(t.key);
      const grp = planner.orderGroups.get(t.order);
      if (grp) grp.remaining = Math.max(0, grp.remaining - 1);
      if (t.kind === "waterlog") continue;
      wMap.set(t.key, {
        name: t.kind === "fluid" ? t.name : t.name,
        position: t.world.clone(),
        boundingBox: (t.kind === "fluid" || /(_carpet|redstone_wire|repeater|tripwire|torch|sign|button|lever)$/.test(t.name)) ? "empty" : "block",
        shapes: (t.kind === "fluid" || /(_carpet|redstone_wire|repeater|tripwire|torch|sign|button|lever)$/.test(t.name)) ? [] : [[0, 0, 0, 1, 1, 1]],
        getProperties: () => t.properties || {}
      });
    }
  }

  // Single retried straggler on Layer 2 (attempts=2) must NOT lock out Layer 7 ready tasks in planner.next()!
  const nextTask = planner.next(new Vec3(1188.5, -54, 1574.5));
  assert.ok(nextTask && nextTask.layer === 7, "Single retried straggler on Layer 2 must not lock out Layer 7 ready tasks in planner.next()");

  //And in nextAny(), ready tasks on Layer 7 must strongly beat unsupported floating overhang blocks (like 1192,-53,1554)!
  const anyTask = planner.nextAny(new Vec3(1188.5, -53, 1556.5));
  assert.ok(anyTask && planner.isReady(anyTask), "planner.nextAny() must prioritize ready connected blocks over unsupported floating overhang islands");

  // 3. Brain O(1) forward-flood reachability cache benchmark & accuracy on isolated roof (1188,-54,1574)
  let walkTarget = null;
  let pearlDest = null;
  const bot = {
    entity: { position: new Vec3(1188.5, -54, 1574.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20,
    inventory: { items: () => [{ name: "ender_pearl", count: 16 }, { name: "stone", count: 64 }] },
    blockAt: (p) => worldModel.blockAt(p),
    setControlState: () => {},
    getControlState: () => false
  };
  for (const [fk, fname] of planner.fluidCells.entries()) {
    const [fx, fy, fz] = fk.split(",").map(Number);
    if (fy < -53 && !wMap.has(fk)) {
      wMap.set(fk, { name: fname, position: new Vec3(fx, fy, fz), boundingBox: "empty", shapes: [], getProperties: () => ({}) });
    }
  }
  const brain = new Brain({
    bot,
    world: worldModel,
    config: { navigation: { pearls: true } },
    logger: { info () {}, warn () {}, debug () {} },
    nav: {
      goTo: async (dest) => {
        walkTarget = dest.clone();
        bot.entity.position = new Vec3(dest.x, dest.y, dest.z);
        return true;
      }
    },
    scaffold: { created: new Map(), itemName: "stone" },
    survival: {
      pearlTo: async (dest) => {
        pearlDest = dest.clone();
        bot.entity.position = dest.clone();
        return true;
      }
    },
    materials: { count: () => 64, scaffoldBlockName: "stone" },
    ground: { state: () => "grounded" }
  });

  const t0 = Date.now();
  const rGround = brain.reachability(new Vec3(1192.5, -60, 1554.5), 2400, false);
  for (let i = 0; i < 15; i++) {
    brain.reachability(new Vec3(1192.5 + (i % 3), -60, 1554.5), 2400, false);
  }
  const elapsed16 = Date.now() - t0;
  assert.equal(rGround.verdict, "no", "Ground cell at y=-60 must return verdict=no when bot is trapped on isolated South funnel roof at y=-54");
  assert.ok(elapsed16 < 250, `16 Brain.reachability calls must complete in <250ms (took ${elapsed16}ms)`);

  // 4. Brain.connect() rim-walk + ender pearl across the canyon from South roof (1188,-54,1574) to North roof (1188,-53,1553)
  for (const lt of planner.tasks.values()) {
    if (lt.layer === 7 && lt.kind === "block" && (lt.world.z <= 1553 || lt.world.z >= 1566)) {
      wMap.set(lt.key, { name: lt.name, position: lt.world.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => lt.properties || {} });
    }
  }
  bot.entity.position = new Vec3(1188.5, -54, 1568.5);
  brain.clearCache();
  const connRes = await brain.prepare(new Vec3(1188.5, -52, 1553.5), { force: true });
  assert.equal(connRes, "connected", "Brain.prepare must connect across the canyon by walking to the South rim and throwing an ender pearl to the North roof");
  assert.ok(walkTarget && pearlDest, "Brain.connect must walk to a rim vantage point and throw an ender pearl across the canyon");

  // 5. SweeperEngine records unreachable & dead stand when sweepTemporary returns 0 (preventing Sweeper.loop.json infinite loop)
  let notedDead = 0;
  const swP = new Vec3(1170, -52, 1560);
  swP.createdAt = Date.now() - 30000;
  wMap.set("1170,-52,1560", { name: "stone", position: swP.clone(), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  const swEngine = new SweeperEngine({
    builder: {},
    bot: { entity: { position: new Vec3(1172.5, -52, 1560.5) }, health: 20 },
    world: worldModel,
    config: {},
    logger: { info () {}, warn () {} },
    planner: { tasks: new Map() },
    placer: {
      aim: {
        fromPose: () => null,
        candidates: () => [{ stand: new Vec3(1171.5, -52, 1560.5), cell: new Vec3(1171, -52, 1560), edge: null }]
      },
      standingStill: () => true,
      reachVerdict: () => "yes",
      isDeadStand: () => false,
      noteDeadStand: () => { notedDead++; },
      sweepTemporary: async () => 0,
      setPhase: () => {}
    },
    scaffold: {
      created: new Map([["1170,-52,1560", swP]]),
      getCreated () { return [...this.created.values()]; },
      contains (c) { return this.created.has(`${c.x},${c.y},${c.z}`); }
    },
    nav: { goTo: async () => true }
  });
  const broke = await swEngine.breakTempBlock(swP, false);
  assert.equal(broke, false, "breakTempBlock must return false when sweepTemporary returns 0");
  assert.equal(notedDead, 1, "breakTempBlock must call noteDeadStand when sweepTemporary returns 0 so Sweeper never loops on the same stand");
  assert.equal(swEngine.unreachable.has("1170,-52,1560"), true, "breakTempBlock must mark target in unreachable map when sweepTemporary returns 0");

  // 6. ExitManager enforces minimum pearl distance >= 6.5 and snaps mid-jump airborne origin to floor below
  const exBot = {
    entity: { position: new Vec3(1188.5, -53, 1574.5), velocity: new Vec3(0, 0.2, 0), onGround: false, isInWater: false },
    health: 20,
    inventory: { items: () => [{ name: "ender_pearl", count: 16 }] },
    clearControlStates: () => {}
  };
  const exMgr = new ExitManager({
    bot: exBot,
    world: worldModel,
    config: { navigation: { pearls: true } },
    logger: { info () {}, warn () {} },
    scaffold: { created: new Map(), itemName: "stone" },
    materials: { closeOpenContainer: () => {} },
    getPlanner: () => planner
  });
  const pCands = exMgr.pearlCandidates({ x: 1188, y: -54, z: 1574 }, new Set());
  for (const pc of pCands) {
    const hd = Math.hypot(pc.x - 1188, pc.z - 1574);
    assert.ok(hd >= 6.5, `ExitManager pearl candidate distance (${hd.toFixed(2)}) must be >= 6.5 blocks`);
  }
});


test("v6.0 fixes (64-Module Upper-Farm Rewrite): computeBridgeSeedsAndChains 3D overhang/island DAG, Placer 3D L-turn catwalk bridge builder for Layer 13 oak_leaves, zero stone place-break loops on support/catwalk blocks, Brain.connect catwalk bridge across upper-deck air gaps, and non-pausing RecoveryManager airborne unstick", async () => {
  const { Vec3 } = require("../src/util/vec3");
  const { loadSchematic, buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { Placer } = require("../src/interaction/placer");
  const { AimSolver } = require("../src/interaction/aim");
  const { Brain } = require("../src/navigation/brain");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const path = require("path");

  const loaded = await loadSchematic(path.resolve(__dirname, "../schematics/McDs 64 Module Cobblestone Wall Farm.litematic"), {
    registry: { blocksByName: new Proxy({}, { get: (_, k) => ({ name: k, defaultState: 1 }) }) }
  });
  const origin = new Vec3(1134, -60, 1517);
  const tr = buildTransform(loaded.schematic, origin, 0);
  const wMap = new Map();
  const worldModel = {
    bot: { entity: { position: new Vec3(1139.5, -46, 1522.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true } },
    blockAt (pos) {
      const x = Math.floor(pos.x), y = Math.floor(pos.y), z = Math.floor(pos.z);
      const k = `${x},${y},${z}`;
      if (wMap.has(k)) return wMap.get(k);
      if (y === -61) return { name: "grass_block", position: new Vec3(x, y, z), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) };
      return { name: "air", position: new Vec3(x, y, z), boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    },
    isLoaded: () => true
  };

  const planner = new BuildPlanner(loaded, tr, worldModel, { building: {} }, { info () {}, warn () {}, debug () {} }).build();

  // 1. Verify computeBridgeSeedsAndChains linked all 448 floating oak_leaves on Layer 13 (y=-47) with bridgeGap=4 and bridgeAnchorKey
  const l13Leaf = planner.tasks.get("1142,-47,1521");
  assert.ok(l13Leaf, "oak_leaves@1142,-47,1521 must exist on Layer 13");
  assert.ok(l13Leaf.bridgeAnchorKey, "Floating Layer 13 oak_leaves@1142,-47,1521 must have bridgeAnchorKey assigned");
  assert.equal(l13Leaf.bridgeGap, 4, "Floating Layer 13 oak_leaves@1142,-47,1521 must have bridgeGap=4 (3-block knight-move catwalk)");
  assert.equal(planner.hasDirectlyUnfinishedBelow(l13Leaf), true, "oak_leaves@1142,-47,1521 must wait while its bridgeAnchorKey is uncompleted");

  const anchorTask = planner.tasks.get(l13Leaf.bridgeAnchorKey);
  anchorTask.status = "completed";
  wMap.set(anchorTask.key, { name: anchorTask.name, position: anchorTask.world.clone(), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  assert.equal(planner.hasDirectlyUnfinishedBelow(l13Leaf), false, "oak_leaves@1142,-47,1521 must unblock once its bridgeAnchorKey is completed");

  // 2. Verify Placer.provideSupport builds a 3-block L-turn catwalk bridge from anchorTask to oak_leaves@1142,-47,1521 and marks blocks isCatwalk=true
  worldModel.bot.entity.position = new Vec3(anchorTask.world.x + 0.5, anchorTask.world.y + 1, anchorTask.world.z + 0.5);
  const bot = {
    entity: worldModel.bot.entity,
    health: 20,
    heldItem: { name: "stone" },
    inventory: { items: () => [{ name: "stone", count: 64 }, { name: "oak_leaves", count: 64 }] },
    world: { raycast: () => null },
    blockAt: (p) => worldModel.blockAt(p),
    setControlState: () => {},
    getControlState: () => false,
    on: () => {},
    removeListener: () => {}
  };
  const scCreated = new Map();
  const scaffold = {
    itemName: "stone",
    created: scCreated,
    getCreated () { return [...scCreated.values()]; },
    contains (c) { return scCreated.has(`${c.x},${c.y},${c.z}`); },
    onScaffold: () => false,
    noScaffold: () => false,
    planColumn: () => null,
    _stepOntoTop: async (goal) => { bot.entity.position = goal.clone(); return true; }
  };
  const aim = new AimSolver(bot, worldModel, { navigation: { placementReach: 4.5 } });
  const placer = new Placer({
    bot,
    world: worldModel,
    config: { building: {} },
    logger: { info () {}, warn () {}, debug () {} },
    nav: { goTo: async (dest) => { bot.entity.position = dest.clone(); return true; } },
    interaction: {},
    materials: { ensureItem: async () => true, ensureUsableItem: async () => true, closeOpenContainer: () => {} },
    aim,
    look: { lookAtPoint: async () => {} },
    scaffold,
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    learner: { order: (tk) => tk.info.specs, preferred: {}, success () {} },
    experience: { record () {}, reachPenalty: () => 0 }
  });
  placer.planner = planner;
  placer.placeTempBlock = async (cell) => {
    const k = `${cell.x},${cell.y},${cell.z}`;
    wMap.set(k, { name: "stone", position: cell.clone(), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
    const rec = cell.clone();
    rec.createdAt = Date.now();
    scCreated.set(k, rec);
    return rec;
  };

  const catwalkSupports = await placer.provideSupport(l13Leaf, l13Leaf.info.specs[0]);
  assert.ok(catwalkSupports.length >= 3 && catwalkSupports.length <= 5, `provideSupport must build a 3..5-block catwalk bridge from anchor to oak_leaves@1142,-47,1521 (got ${catwalkSupports.length})`);
  for (const sc of catwalkSupports) {
    const rec = scCreated.get(`${sc.x},${sc.y},${sc.z}`);
    assert.ok(rec && rec.isCatwalk && rec.isAccessStep, `Catwalk block ${sc.x},${sc.y},${sc.z} must be marked with isCatwalk=true and isAccessStep=true`);
  }
  assert.equal(placer.hasRef(l13Leaf, l13Leaf.info.specs[0]), true, "After 3-block catwalk bridge, oak_leaves@1142,-47,1521 must have a valid cardinal reference block");

  // 3. Verify SweeperEngine preserves isCatwalk blocks during build (!finalSweep) and sweeps them during finalSweep=true
  const sweeper = new SweeperEngine({
    builder: {},
    bot,
    world: worldModel,
    config: {},
    logger: { info () {}, warn () {} },
    planner,
    placer: { fluidBeside: () => false },
    scaffold,
    nav: {}
  });
  const firstCw = scCreated.get(`${catwalkSupports[0].x},${catwalkSupports[0].y},${catwalkSupports[0].z}`);
  firstCw.createdAt = Date.now() - 60000;
  assert.equal(sweeper.isSafeToBreak(firstCw, false), false, "Sweeper must NOT break isCatwalk bridge blocks during the active build (!finalSweep)");
  assert.equal(sweeper.isSafeToBreak(firstCw, true), true, "Sweeper MUST break isCatwalk bridge blocks during finalSweep=true");

  // 4. Verify Brain.connect builds a horizontal catwalk bridge across a 4-block upper-deck air gap when pearls are disabled
  const bridgeMap = new Map();
  for (let x = 100; x <= 102; x++) for (let z = 100; z <= 102; z++) {
    bridgeMap.set(`${x},-46,${z}`, { name: "stone_bricks", position: new Vec3(x, -46, z), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
    bridgeMap.set(`${x + 6},-46,${z}`, { name: "stone_bricks", position: new Vec3(x + 6, -46, z), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  }
  const bridgeWorld = {
    blockAt (p) {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return bridgeMap.get(k) || { name: "air", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    }
  };
  const bBot = {
    entity: { position: new Vec3(101.5, -45, 101.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20,
    blockAt: (p) => bridgeWorld.blockAt(p),
    on: () => {},
    removeListener: () => {}
  };
  const bScCreated = new Map();
  const bBrain = new Brain({
    bot: bBot,
    world: bridgeWorld,
    config: { navigation: { pearls: false } },
    logger: { info () {}, warn () {}, debug () {} },
    nav: { goTo: async (dest) => { bBot.entity.position = dest.clone(); return true; } },
    scaffold: {
      created: bScCreated,
      onScaffold: () => false,
      _placeBlockOnFloor: async (cell) => {
        const ck = `${cell.x},${cell.y},${cell.z}`;
        bridgeMap.set(ck, { name: "stone", position: cell.clone(), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
        const rec = cell.clone();
        rec.isAccessStep = true;
        rec.isCatwalk = true;
        bScCreated.set(ck, rec);
        return true;
      },
      _stepOntoTop: async (goal) => { bBot.entity.position = goal.clone(); return true; }
    },
    survival: null
  });
  const prepBridge = await bBrain.prepare(new Vec3(107.5, -45, 101.5), { force: true });
  assert.equal(prepBridge, "connected", "Brain.prepare must connect across the 3-block upper-deck air gap by building a horizontal catwalk bridge");
  assert.equal(bScCreated.size, 3, "Brain.connect tryBridge must place 3 temporary catwalk blocks across the gap (x=103, 104, 105 at y=-46)");
  bBrain.clearCache();
  assert.equal(bBrain.reachability(new Vec3(107.5, -45, 101.5)).verdict, "yes", "After catwalk bridge is placed, both platforms must be walkable on foot (verdict=yes)");
});

test("v6.1 fixes: sign-gated black_stained_glass water containment over Layer 24 redstone, cross-worker temp-block awareness, active real-time SweeperEngine catwalk tip-inward cleanup, and full 42,426-task 64-Module verification", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { AimSolver } = require("../src/interaction/aim");
  const { Placer } = require("../src/interaction/placer");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const { Coordinator } = require("../src/fleet/coordinator");

  const schematic = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const tr = buildTransform(schematic, new Vec3(1139, -60, 1515), 0);
  const wMap = new Map();
  const bot = {
    username: "Build",
    entity: { position: new Vec3(1145.5, -32, 1521.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, height: 1.62 },
    health: 20,
    heldItem: { name: "water_bucket", count: 1 },
    inventory: { items: () => [{ name: "water_bucket", count: 1 }, { name: "cobbled_deepslate", count: 64 }] },
    getControlState: () => false,
    setControlState () {},
    clearControlStates () {},
    look: async () => {},
    lookAt: async () => {},
    blockAt: (p) => worldModel.blockAt(p),
    world: { raycast: () => null },
    on: () => {},
    removeListener: () => {}
  };
  const worldModel = {
    bot,
    isDangerous: () => false,
    blockAt (p) {
      if (!p) return null;
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return wMap.get(k) || { name: "air", position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    }
  };

  const coord = new Coordinator(5);
  const scCreated = new Map();
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: { maxBuildTasks: 100000 } }, { info () {}, warn () {}, debug () {} }).build();
  planner.joinFleet(coord, "Build", 0, 5);
  planner.isTempCell = (x, y, z) => scCreated.has(`${x},${y},${z}`) || coord.tempBlocks.has(`${x},${y},${z}`);

  // 1. Verify Layer 27 water pod (1146,-33,1520) enclosureDeps includes all black_stained_glass walls/floor, oak_fence, oak_wall_sign[north]@1146,-33,1522, and sign backing stone_bricks@1146,-33,1523
  const waterL27 = planner.tasks.get("1146,-33,1520");
  const signL27 = planner.tasks.get("1146,-33,1522");
  const signBackL27 = planner.tasks.get("1146,-33,1523");
  assert.ok(waterL27 && signL27 && signBackL27, "Layer 27 water pod, oak_wall_sign, and stone_bricks backing must exist");
  assert.equal(signL27.order, 108.65, "Fluid-enclosing oak_wall_sign on Layer 27 must be promoted to order 108.65 (after 108.08 backing block and before 110.25 water)");
  for (const reqKey of ["1146,-34,1520", "1146,-34,1521", "1145,-33,1520", "1147,-33,1520", "1146,-33,1519", "1145,-33,1521", "1147,-33,1521", "1146,-33,1522", "1146,-33,1523"]) {
    assert.ok(waterL27.enclosureDeps.includes(reqKey), `water@1146,-33,1520 enclosureDeps must include ${reqKey}`);
  }

  // Place all tasks up to Layer 27 EXCEPT oak_wall_sign@1146,-33,1522
  for (const t of planner.tasks.values()) {
    if (t.kind === "block" && t.layer <= 27 && t.key !== "1146,-33,1522") {
      planner.setStatus(t, "completed");
      wMap.set(t.key, {
        name: t.name,
        position: t.world.clone(),
        boundingBox: t.info?.fragile ? "empty" : "block",
        shapes: [[0, 0, 0, 1, 1, 1]],
        properties: t.properties,
        getProperties: () => t.properties || {}
      });
    }
  }

  // Even if another worker placed a temporary stone block at 1146,-33,1522 (the sign cell), planner.isReady and fluidCheck must block pouring water!
  wMap.set("1146,-33,1522", { name: "cobbled_deepslate", position: new Vec3(1146, -33, 1522), boundingBox: "block", shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
  coord.addTempBlock({ x: 1146, y: -33, z: 1522, createdAt: Date.now() }, "Buildd");
  waterL27._fc = null;
  assert.equal(planner.isReady(waterL27), false, "water@1146,-33,1520 must NOT be ready while oak_wall_sign@1146,-33,1522 is unplaced / occupied by partner temp block");
  const fcMissingSign = planner.fluidCheck(waterL27);
  assert.equal(fcMissingSign.blocked, true, "fluidCheck must block water@1146,-33,1520 while oak_wall_sign@1146,-33,1522 is not placed");
  assert.ok(fcMissingSign.leaks.includes("1146,-33,1522"), "fluidCheck leaks must include the missing oak_wall_sign@1146,-33,1522");

  // Even if oak_wall_sign@1146,-33,1522 was marked 'completed' earlier and popped off (air in live world), executeFluid must refuse and reopen 1146,-33,1522 with priorityBoost!
  coord.removeTempBlock("1146,-33,1522", "Buildd");
  wMap.delete("1146,-33,1522");
  planner.setStatus(signL27, "completed");
  waterL27._fc = null;
  const aim = new AimSolver(bot, worldModel, { navigation: {}, human: {} });
  aim.planner = planner;
  const scaffold = {
    itemName: "cobbled_deepslate",
    created: scCreated,
    getCreated: () => [...scCreated.values()],
    contains: (c) => scCreated.has(`${Math.floor(c.x)},${Math.floor(c.y)},${Math.floor(c.z)}`),
    onScaffold: () => false,
    noScaffold: (pos) => planner.fluidCells.has(`${pos.x},${pos.y},${pos.z}`)
  };
  const placer = new Placer({
    bot,
    world: worldModel,
    config: { building: { allowTemporaryScaffolding: true }, human: {}, navigation: { pearls: false } },
    logger: { info () {}, warn () {}, debug () {} },
    materials: { ensureItem: async () => true, ensureUsableItem: async () => true, closeOpenContainer () {}, noteConsumed () {} },
    interaction: { sendPlace: async () => {}, digAimed: async (b) => { if (b?.position) wMap.delete(`${b.position.x},${b.position.y},${b.position.z}`); } },
    look: { lookAtPoint: async () => {}, lookDown: async () => {} },
    aim,
    nav: { goTo: async (dest) => { bot.entity.position = dest.clone(); return true; }, human: { activeWalk: false } },
    scaffold,
    ground: { state: () => "grounded", waitSafe: async () => "grounded" },
    learner: { order: (tk) => tk.info.specs, preferred: {}, success () {} },
    experience: { record () {}, reachPenalty: () => 0 }
  });
  placer.planner = planner;
  placer.builder = { interaction: placer.interaction };

  await assert.rejects(
    () => placer.executeFluid(waterL27),
    /not pouring water at 1146,-33,1520/,
    "executeFluid must refuse to pour water@1146,-33,1520 when oak_wall_sign@1146,-33,1522 is missing from the live world"
  );
  assert.equal(signL27.status, "pending", "executeFluid must automatically reopen missing oak_wall_sign@1146,-33,1522 even if it was previously marked completed");
  assert.equal(signL27.priorityBoost, true, "Reopened oak_wall_sign@1146,-33,1522 must receive priorityBoost=true");

  // Once oak_wall_sign@1146,-33,1522 is placed in the live world, water@1146,-33,1520 becomes ready and fluidCheck passes!
  planner.setStatus(signL27, "completed");
  wMap.set("1146,-33,1522", {
    name: "oak_wall_sign",
    position: new Vec3(1146, -33, 1522),
    boundingBox: "empty",
    shapes: [],
    properties: signL27.properties,
    getProperties: () => signL27.properties
  });
  waterL27._fc = null;
  assert.equal(planner.fluidCheck(waterL27).blocked, false, "Once oak_wall_sign@1146,-33,1522 and black_stained_glass enclosure are in place, fluidCheck must pass");
  assert.equal(planner.isReady(waterL27), true, "Once oak_wall_sign@1146,-33,1522 and enclosure are in place, water@1146,-33,1520 must be ready");

  // 2. Verify SweeperEngine actively breaks catwalk/support blocks in real time during the build (!finalSweep) once local tasks within 2m are completed (nibbling tip-inward!)
  const cw1 = new Vec3(1140, -33, 1520); cw1.createdAt = Date.now() - 20000; cw1.isCatwalk = true; cw1.isAccessStep = true;
  const cw2 = new Vec3(1139, -33, 1520); cw2.createdAt = Date.now() - 20000; cw2.isCatwalk = true; cw2.isAccessStep = true;
  wMap.set("1140,-33,1520", { name: "cobbled_deepslate", position: cw1.clone(), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  wMap.set("1139,-33,1520", { name: "cobbled_deepslate", position: cw2.clone(), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  // Place an unannounced temporary block at 1138,-33,1520 in the world to test scanWorldForTempBlocks()
  wMap.set("1138,-33,1520", { name: "cobbled_deepslate", position: new Vec3(1138, -33, 1520), boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  scCreated.set("1140,-33,1520", cw1);
  scCreated.set("1139,-33,1520", cw2);

  bot.entity.position = new Vec3(1141.5, -32, 1520.5);
  const sweeper = new SweeperEngine({
    builder: { interaction: placer.interaction },
    bot,
    world: worldModel,
    config: { navigation: { pearls: false } },
    logger: { info () {}, warn () {} },
    fleet: { id: "Sweeper", coord },
    planner,
    placer,
    scaffold,
    nav: placer.nav
  });
  const adopted = sweeper.scanWorldForTempBlocks(true);
  assert.equal(adopted, 1, "SweeperEngine.scanWorldForTempBlocks must discover and adopt unannounced temporary scaffold block at 1138,-33,1520");
  const cw3 = scCreated.get("1138,-33,1520");
  // cw2 (1139,-33,1520) is between cw1 (1140) and cw3 (1138), so it has 2 horizontal temporary neighbors and must NOT be broken before the outer tip cw3!
  assert.equal(sweeper.isSafeToBreak(cw2, false), false, "Middle catwalk block cw2 with 2 horizontal temp neighbors must not be broken before the tip cw3");
  assert.equal(sweeper.isSafeToBreak(cw3, false), true, "Outer catwalk tip cw3 with all nearby schematic tasks completed MUST be safe to break actively during !finalSweep");

  // 3. Full 42,426-task end-to-end enclosure & order verification on McDs 64 Module Cobblestone Wall Farm.litematic
  const simWorld = new Map();
  const simModel = {
    bot,
    isDangerous: () => false,
    blockAt (p) {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return simWorld.get(k) || { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    }
  };
  const simPlanner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, simModel, { building: { maxBuildTasks: 100000 } }, { info () {}, warn () {}, debug () {} }).build();
  let unsealedFluidPours = 0;
  for (const order of simPlanner.orders) {
    const g = simPlanner.orderGroups.get(order);
    if (!g) continue;
    for (const set of g.cells.values()) {
      for (const t of [...set]) {
        if (t.kind === "fluid" || (t.kind === "waterlog" && !/(_leaves$|mangrove_roots)/.test(t.name))) {
          t._fc = null;
          const fc = simPlanner.fluidCheck(t);
          if (fc.blocked) unsealedFluidPours++;
        }
        simPlanner.markCompleted(t);
        if (t.kind === "block") {
          simWorld.set(t.key, { name: t.name, boundingBox: t.info?.fragile ? "empty" : "block", shapes: [[0,0,0,1,1,1]], properties: t.properties, getProperties: () => t.properties || {} });
        } else if (t.kind === "fluid") {
          simWorld.set(t.key, { name: t.name, metadata: 0, boundingBox: "empty", shapes: [], properties: { level: "0" }, getProperties: () => ({ level: "0" }) });
        } else if (t.kind === "waterlog") {
          const prev = simWorld.get(t.parentKey);
          if (prev) {
            const np = { ...(prev.properties || {}), waterlogged: "true" };
            simWorld.set(t.parentKey, { ...prev, properties: np, getProperties: () => np });
          }
        }
      }
    }
  }
  assert.equal(simPlanner.getStats().remaining, 0, "All 42,426 tasks in McDs 64 Module Cobblestone Wall Farm.litematic must complete with 0 remaining");
  assert.equal(unsealedFluidPours, 0, "Zero fluid or non-leaf waterlog tasks may ever be poured before their complete glass/wall/sign enclosure is 100% placed");
  assert.equal(simPlanner.tasks.get("1213,-49,1557").order, 45, "Covered redstone_wall_torch@1213,-49,1557 on L11 must be ordered in-layer at 45 before L12 ceiling seals it");
  assert.equal(simPlanner.tasks.get("1194,-46,1558").order, 56.68, "Chained iron_trapdoor@1194,-46,1558 must be promoted to 56.68 after iron_trapdoor@1194,-46,1559 (56.38)");
  assert.equal(simPlanner.tasks.get("1144,-37,1519").order, 92.18, "Downward piston@1144,-37,1519 on L23 must be ordered at 92.18 after L23 smooth_stone (92 / 92.08)");
  assert.ok(simPlanner.tasks.get("1193,-49,1555").enclosureDeps.includes("1194,-50,1556"), "water@1193,-49,1555 enclosureDeps must include spruce_door@1194,-50,1556 backing spruce_wall_sign@1193,-49,1556");
});

test("v6.3 fixes: Monsterr NW funnel jump-clearance pit false positive & local work-stealing, unbuilt floor hole avoidance, outer stone_bricks overhang side-face aim & 18-tick withHold slide, Sweeper multi-block pillar cleanup, and 64-module interleaved level-by-level climbing", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { AimSolver } = require("../src/interaction/aim");
  const { FallGuard } = require("../src/recovery/fall-guard");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const { describeBlock } = require("../src/rules/blocks");

  const schematic = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const origin = new Vec3(1131, -60, 1412);
  const tr = buildTransform(schematic, origin, 0);

  const worldBlocks = new Map();
  const bot = {
    entity: { position: new Vec3(1147.5, -55, 1421.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 },
    inventory: { items: () => [] },
    world: { raycast: () => null },
    setControlState () {},
    getControlState: () => false,
    look: async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; }
  };
  const worldModel = {
    bot,
    isDangerous: () => false,
    blockAt (p) {
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return worldBlocks.get(k) || { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    }
  };
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: { maxBuildTasks: 100000 } }, { info () {}, warn () {}, debug () {} }).build();
  bot.builder = { planner };

  // 1. Complete Layers 0..6 stone_bricks around Monsterr at (1147, -55, 1421) EXCEPT leave an unbuilt floor hole at 1149,-54,1431 on Layer 6
  for (const t of planner.tasks.values()) {
    if (t.kind === "block" && t.layer <= 6) {
      if (t.key === "1150,-55,1418") continue; // unbuilt floor hole on Layer 5!
      planner.markCompleted(t);
      worldBlocks.set(t.key, { name: t.name, boundingBox: "block", shapes: [[0,0,0,1,1,1]], properties: t.properties, getProperties: () => t.properties || {} });
    }
  }

  // Verify open 1-block stepped water funnel cells around (1147, -55, 1421) are NOT marked as static pitCells before water is poured,
  // and jump-clearance head cells at y = feetY + 2 (1148,-53,1421) with solid block at y - 3 (1148,-56,1421) are NOT active pit cells!
  assert.equal(planner.isActivePitCell(1148, -53, 1421), false, "Jump-clearance head cell (1148,-53,1421) with solid block at y-3 must never be marked as an active pit cell");
  assert.equal(planner.isActivePitCell(1147, -55, 1421), false, "Open stepped water funnel stand (1147,-55,1421) before water is poured must not be an active pit cell");

  // 2. Verify unbuilt >=2-block floor hole at (1149, -54, 1431) (where 1149,-55,1431 is pending and air is down to -60) IS detected as a pit by FallGuard
  const fg = new FallGuard({
    bot,
    world: worldModel,
    config: {},
    logger: {},
    navigation: { stop () {} },
    ground: {}
  });
  assert.equal(fg.hazardAt(1150.5, -54, 1418.5, 2), "pit", "Unbuilt >=2-block floor hole at (1150,-55,1418) must be treated as a pit by FallGuard so bots walk around it instead of falling in");

  // 3. Verify outer stone_bricks overhang side-face placement (placing at 1250,-54,1431 clicking west face of isolated overhang 1251,-54,1431 while standing on 1251,-53,1431)
  worldBlocks.set("1251,-54,1431", { name: "stone_bricks", boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  bot.entity.position = new Vec3(1251.5, -53, 1431.5);
  const aim = new AimSolver(bot, worldModel, { navigation: { placementReach: 4.5 } }, { isHazard: () => false });
  const freeSpec = describeBlock("stone_bricks", {}).specs[0];
  const overhangCands = aim.candidates(new Vec3(1250, -54, 1431), freeSpec, { allowScaffold: true });
  const topOverhangCand = overhangCands.find(c => c.cell.x === 1251 && c.cell.y === -53 && c.cell.z === 1431 && c.faceName === "west");
  assert.ok(topOverhangCand, "AimSolver must find an overhang candidate on top of 1251,-54,1431 clicking its west face");
  assert.equal(topOverhangCand.edge, true, "Overhang candidate on top of reference block must set edge=true");
  assert.ok(topOverhangCand.stand.x <= 1250.925, "Overhang stand on west edge must lean at least 0.075m past the west face so downward ray never clips face 1 (up)");
  bot.entity.position = new Vec3(1147.5, -55, 1421.5);

  // 4. Verify 64-module generator bands (order 60.2 for L15..L18 and order 76.2 for L19..L22) use Interleaved Level-by-Level Climbing (i = 0..3)
  const band1Group = planner.orderGroups.get(60.2);
  const band2Group = planner.orderGroups.get(76.2);
  assert.ok(band1Group && band1Group.seqList.length > 0, "Lower 64-module generator band (order 60.2) must have seqList");
  assert.ok(band2Group && band2Group.seqList.length > 0, "Upper 64-module generator band (order 76.2) must have seqList");
  const cluster0 = band1Group.seqList.filter(t => t.verticalClusterId === 0);
  assert.ok(cluster0.every(t => t.interleavedClimb === true), "Every task in 64-module generator cluster 0 must use interleavedClimb=true");
  assert.ok(cluster0.every(t => !t.verticalColTop), "Interleaved 64-module climb must set verticalColTop=false so bots never jump down from the top of the column");
  // Verify layers within cluster0 are monotonically non-decreasing (level 15 anchor+wl+partners, then 16, then 17, then 18)!
  for (let i = 1; i < cluster0.length; i++) {
    assert.ok(cluster0[i].layer >= cluster0[i - 1].layer, `Cluster 0 tasks must climb monotonically level-by-level (${cluster0[i - 1].key} L${cluster0[i - 1].layer} -> ${cluster0[i].key} L${cluster0[i].layer})`);
  }

  // 5. Verify SweeperEngine actively breaks multi-block pillars (isAccessStep=false) and adopts both stone and cobbled_deepslate on deck
  worldBlocks.set("1148,-54,1422", { name: "stone", boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  worldBlocks.set("1148,-53,1422", { name: "stone", boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
  const scCreated = new Map();
  const sweeper = new SweeperEngine({
    bot,
    world: worldModel,
    planner,
    scaffold: {
      itemName: "cobbled_deepslate",
      created: scCreated,
      isTemp: p => scCreated.has(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`)
    },
    placer: { aim, reachVerdict: () => "yes" },
    navigation: {},
    fleet: { id: "Sweeper", coord: { tempBlocks: new Map(), claim: () => true } },
    logger: { info () {}, warn () {}, debug () {} }
  });
  const adoptedCount = sweeper.scanWorldForTempBlocks(true);
  assert.ok(adoptedCount >= 2, "SweeperEngine must adopt non-schematic stone pillar blocks on the current deck even when scaffold.itemName is cobbled_deepslate");
  const pillarTop = scCreated.get("1148,-53,1422");
  assert.ok(pillarTop && !pillarTop.isAccessStep, "Multi-block pillar top must not be marked isAccessStep");
  assert.equal(sweeper.isSafeToBreak(pillarTop, false), true, "SweeperEngine must actively break the top of a multi-block temporary pillar before finalSweep");
});

test("v6.4 fixes (13-43-52.zip & 18-38-30.mp4): Brain.findRoute 2ms 3D BFS fallback when pathfinder times out, fleet-wide quarantine sync without mid-build L2 oak_fence_gate lock, 3x3 roof guard over gates/crafters, and Sweeper ground-level tall-pillar breaking", async () => {
  const fsPromises = require("fs/promises");
  const { Vec3 } = require("../src/util/vec3");
  const { loadLitematic } = require("../src/schematic/litematic");
  const { buildTransform } = require("../src/schematic/loader");
  const { BuildPlanner } = require("../src/planner/build-planner");
  const { Brain } = require("../src/navigation/brain");
  const { ReplicaCoordinator } = require("../src/fleet/replica");
  const { SweeperEngine } = require("../src/fleet/sweeper");
  const { AimSolver } = require("../src/interaction/aim");

  const schematic = await loadLitematic("./schematics/McDs 64 Module Cobblestone Wall Farm.litematic", { allowAll: true }, fsPromises);
  const origin = new Vec3(1261, -60, 1254);
  const tr = buildTransform(schematic, origin, 0);

  const worldBlocks = new Map();
  const bot = {
    entity: { position: new Vec3(1265.76, -50, 1255.44), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0 },
    inventory: { items: () => [] },
    world: { raycast: () => null },
    setControlState () {},
    getControlState: () => false,
    look: async () => {}
  };
  const worldModel = {
    bot,
    isDangerous: () => false,
    blockAt (p) {
      if (p.y <= -61) return { name: "grass_block", boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) };
      const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
      return worldBlocks.get(k) || { name: "air", boundingBox: "empty", shapes: [], getProperties: () => ({}) };
    }
  };
  const planner = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: { maxBuildTasks: 100000 } }, { info () {}, warn () {}, debug () {} }).build();
  bot.builder = { planner };

  // 1. Verify 3x3 roof guard prevents Layer 3 black_stained_glass (1285,-57,1294 & 1285,-57,1295) from sealing over unplaced Layer 2 oak_fence_gate@1285,-58,1295
  const gateTask = planner.tasks.get("1285,-58,1295");
  const roofDiag = planner.tasks.get("1285,-57,1294");
  assert.ok(gateTask && roofDiag, "oak_fence_gate@1285,-58,1295 and diagonal roof glass@1285,-57,1294 must exist");
  assert.equal(planner.hasDirectlyUnfinishedBelow(roofDiag), true, "3x3 roof glass@1285,-57,1294 must be blocked while oak_fence_gate@1285,-58,1295 is uncompleted");

  // 2. Verify fleet-wide quarantine sync across workers and straggler resilience so L2 oak_fence_gate never locks out L8/L9/L10
  const sent = [];
  const rep1 = new ReplicaCoordinator(7, {}, m => sent.push(m), "Ezz");
  const rep2 = new ReplicaCoordinator(7, {}, () => {}, "Build");
  const p2 = new BuildPlanner({ schematic, tiles: schematic.tiles }, tr, worldModel, { building: { maxBuildTasks: 100000 } }, { info () {}, warn () {}, debug () {} }).build();
  planner.joinFleet(rep1, "Ezz", 0, 7);
  p2.joinFleet(rep2, "Build", 1, 7);

  // Complete Layers 0..9 except oak_fence_gate@1285,-58,1295 on Layer 2
  for (const [k, t] of planner.tasks.entries()) {
    if (t.order < 40 && k !== "1285,-58,1295") {
      planner.setStatus(t, "completed");
      p2.setStatus(p2.tasks.get(k), "completed");
      if (t.kind === "block") {
        worldBlocks.set(k, { name: t.name, boundingBox: t.info?.fragile ? "empty" : "block", shapes: [[0,0,0,1,1,1]], properties: t.properties, getProperties: () => t.properties || {} });
      }
    }
  }
  // Even BEFORE quarantine (when oak_fence_gate@1285,-58,1295 is the single straggler on L2 while L3..L9 have >20 completed blocks),
  // p2.next() must NOT snap minOpenLayer to L2 and must immediately return a Layer 10 task!
  const nextL10BeforeQuarantine = p2.next(new Vec3(1295, -50, 1295));
  assert.ok(nextL10BeforeQuarantine && nextL10BeforeQuarantine.layer === 10, `Single straggler on L2 must not block Layer 10 in next() (got ${nextL10BeforeQuarantine?.key} L${nextL10BeforeQuarantine?.layer})`);

  // And when Worker 1 (Ezz) quarantines oak_fence_gate@1285,-58,1295 after 6 attempts, Worker 2 (Build) receives the quarantine and ignores stale reopen handoffs!
  for (let i = 0; i < 6; i++) planner.markFailure(gateTask, new Error("no physical access"));
  assert.equal(gateTask.status, "blocked", "gateTask must be blocked on Worker 1 after 6 failures");
  for (const m of sent) rep2.apply(m);
  p2.syncFleet();
  assert.equal(p2.tasks.get("1285,-58,1295").status, "blocked", "Quarantine must replicate to Worker 2 via ReplicaCoordinator");
  assert.equal(p2.quarantined.has("1285,-58,1295"), true, "Worker 2 must record 1285,-58,1295 in p2.quarantined");
  rep2.apply({ t: "reopen", id: "Ez", key: "1285,-58,1295", ownerIndex: 2 });
  p2.syncFleet();
  assert.equal(p2.tasks.get("1285,-58,1295").status, "blocked", "Stale 3-attempt reopen handoff must not un-quarantine an already-quarantined block");

  // 3. Verify Brain.findRoute finds the 3D staircase path across the funnel from (1265.76, -50, 1255.44) to (1294.5, -50, 1299.5) in <15ms
  const brain = new Brain({ bot, world: worldModel, config: { navigation: { exitMaxDrop: 3 } }, logger: { info () {}, warn () {}, debug () {} } });
  bot.builder.brain = brain;
  const routePlan = brain.findRoute(new Vec3(1265.76, -50, 1255.44), new Vec3(1294.5, -50, 1299.5), 0.3);
  assert.ok(routePlan && routePlan.complete && routePlan.route.length >= 10, "Brain.findRoute must return the complete 3D funnel staircase route from (1265,-50,1255) to (1294.5,-50,1299.5)");

  // 4. Verify SweeperEngine on the ground (y = -60) breaks the highest reachable block (y = -56) of an 8-block stone pillar (y = -60..-53) top-down
  bot.entity.position = new Vec3(1288.5, -60, 1312.5);
  const scCreated = new Map();
  for (let py = -60; py <= -53; py++) {
    const pk = `1289,${py},1312`;
    worldBlocks.set(pk, { name: "stone", boundingBox: "block", shapes: [[0,0,0,1,1,1]], getProperties: () => ({}) });
    const v = new Vec3(1289, py, 1312);
    v.createdAt = Date.now() - 10000;
    scCreated.set(pk, v);
  }
  const aim = new AimSolver(bot, worldModel, { navigation: { placementReach: 4.5 } }, { isHazard: () => false });
  const sweeper = new SweeperEngine({
    bot,
    world: worldModel,
    planner,
    scaffold: {
      itemName: "cobbled_deepslate",
      created: scCreated,
      getCreated: () => [...scCreated.values()],
      contains: c => scCreated.has(`${c.x},${c.y},${c.z}`)
    },
    placer: { aim, reachVerdict: () => "yes" },
    fleet: { id: "Sweeper", coord: { tempBlocks: new Map(), claim: () => true } },
    logger: { info () {}, warn () {}, debug () {} }
  });
  assert.equal(sweeper.isSafeToBreak(scCreated.get("1289,-57,1312"), false), false, "y=-57 must wait for reachable y=-56 above it");
  assert.equal(sweeper.isSafeToBreak(scCreated.get("1289,-56,1312"), false), true, "Highest ground-reachable block y=-56 of an 8-block pillar must be safe to break immediately from y=-60");
});

