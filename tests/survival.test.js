'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { solveThrow, simulatePearl, findWaterExit } = require('../src/recovery/survival')

const AIR = { name: 'air', boundingBox: 'empty' }
const STONE = { name: 'stone', boundingBox: 'block' }
const WATER = { name: 'water', boundingBox: 'empty' }
const world = (fn) => (x, y, z) => fn(x, y, z) || AIR

test('pearl: solver lands on a roof platform and the simulation agrees', () => {
  // ground at y<=-61, platform (x 20..24, z -2..2) top at y=-50 (blocks at -51)
  const blockAt = world((x, y, z) => (y <= -61 ? STONE : (y === -51 && x >= 20 && x <= 24 && z >= -2 && z <= 2 ? STONE : null)))
  const eye = { x: 0.5, y: -60 + 1.62, z: 0.5 }
  const stand = { x: 22.5, y: -50, z: 0.5 }
  const sol = solveThrow(blockAt, eye, stand)
  assert.ok(sol, 'a throw exists')
  const r = simulatePearl(blockAt, eye, sol.yaw, sol.pitch)
  assert.equal(r.block.y, -51)
  assert.ok(Math.hypot(r.hit.x - 22.5, r.hit.z - 0.5) < 1.2)
})

test('pearl: no solution when a ceiling blocks every arc', () => {
  const blockAt = world((x, y, z) => (y <= -61 ? STONE : (y === -51 && x >= 20 && x <= 24 && z >= -2 && z <= 2 ? STONE : (y === -58 ? STONE : null))))
  assert.equal(solveThrow(blockAt, { x: 0.5, y: -58.4, z: 0.5 }, { x: 22.5, y: -50, z: 0.5 }), null)
})

test('water: finds a way out of a pool and reports none for a sealed pit', () => {
  const pool = world((x, y, z) => (y <= -61 ? STONE : (x >= 0 && x <= 3 && z >= 0 && z <= 3 && y <= -60 ? (y <= -61 ? STONE : WATER) : null)))
  const path = findWaterExit(pool, { x: 1.5, y: -60, z: 1.5 })
  assert.ok(path && path.length >= 2)
  const pit = world((x, y, z) => { if (y <= -61) return STONE; if (x === 1 && z === 1 && y <= -55) return WATER; if (y <= -52 && !(x === 1 && z === 1)) return STONE; return null })
  assert.equal(findWaterExit(pit, { x: 1.5, y: -60, z: 1.5 }), null)
})

test('pearl: water slows the flight (drag 0.8) and the thrower\'s own motion shifts it', () => {
  const AIRW = world(() => null)
  const floor = world((x, y, z) => (y <= -61 ? STONE : null))
  const eye = { x: 0.5, y: -60 + 1.62, z: 0.5 }
  const dry = simulatePearl(floor, eye, 0, -0.2)
  const wetWorld = world((x, y, z) => (y <= -61 ? STONE : (y >= -62 ? WATER : null)))
  const wet = simulatePearl(wetWorld, eye, 0, -0.2)
  assert.ok(Math.hypot(dry.hit.x - 0.5, dry.hit.z - 0.5) > Math.hypot(wet.hit.x - 0.5, wet.hit.z - 0.5) * 1.5 || wet.ticks !== dry.ticks)
  const still = simulatePearl(floor, eye, 0, 0.3)
  const drift = simulatePearl(floor, eye, 0, 0.3, 1.5, 320, null, { vel: { x: 0.15, y: 0, z: 0 }, onGround: true })
  assert.ok(Math.abs(drift.hit.x - still.hit.x) > 1.5, 'drift of 0.15 b/tick moves the landing by blocks')
  assert.ok(AIRW)
})

test('pearl: another bot in the line absorbs the throw', () => {
  const floor = world((x, y, z) => (y <= -61 ? STONE : null))
  const eye = { x: 0.5, y: -60 + 1.62, z: 0.5 }
  assert.ok(simulatePearl(floor, eye, 0, 0))
  assert.equal(simulatePearl(floor, eye, 0, 0, 1.5, 320, [{ x: 0.5, y: -60, z: -2.5 }]), null)
})
