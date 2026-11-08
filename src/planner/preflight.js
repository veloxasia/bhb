'use strict'
// Preflight: before the first block is placed, work out for EVERY block where a player would stand to place it
// (using the plan order: a block only counts as floor / wall once it is built before the one being placed),
// and which blocks have no standing place at all (they need a scaffold / pillar).
// Note: We only record `task.needsScaffold` here; we do NOT lock `task.hint` on every block because static preflight
// stands cannot know which direction the bot is approaching from at runtime and would drag the bot away from its current row.

const { Vec3 } = require('../util/vec3')
const REACH = 4.2
const RINGS = []
for (const dy of [0, -1, -2, 1, 2]) for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
  if (!dx && !dz && !dy) continue
  const dist = Math.hypot(dx, dz)
  if (dist > 4.2) continue
  const vPenalty = dy > 0 ? dy * 2.4 : Math.abs(dy) * 1.1
  const distCost = dist < 1.8 ? (2.2 - dist) * 1.8 : Math.abs(dist - 3.1) * 0.7
  RINGS.push({ dx, dy, dz, cost: distCost + vPenalty })
}
RINGS.sort((a, b) => a.cost - b.cost)

async function run (planner, { registry, world, logger } = {}) {
  const t0 = Date.now()
  const solidName = n => { const b = registry?.blocksByName?.[n]; return Boolean(b && b.boundingBox === 'block') }
  const plan = new Map()
  for (const t of planner.tasks.values()) if (t.kind === 'block') plan.set(`${t.world.x},${t.world.y},${t.world.z}`, t)
  const before = (o, t) => o.order < t.order || (o.order === t.order && (o.seq ?? 0) < (t.seq ?? 0))
  let unknown = 0
  const isTrapOrBottomSlab = o => {
    if (!o) return false
    if (/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(o.name || '')) return true
    const p = o.properties || o.getProperties?.() || {}
    if (/_slab$/.test(o.name || '') && p.type === 'bottom') return true
    return false
  }
  const solid = (x, y, z, t) => {
    const o = plan.get(`${x},${y},${z}`)
    if (o) return o !== t && before(o, t) && solidName(o.name) && !isTrapOrBottomSlab(o)
    const b = world.blockAt(new Vec3(x, y, z))
    if (!b) { unknown++; return false }
    return b.boundingBox === 'block' && !isTrapOrBottomSlab(b)
  }
  const pendingAt = (x, y, z, t) => {
    const o = plan.get(`${x},${y},${z}`)
    return Boolean(o && o !== t && !before(o, t))
  }
  let planned = 0; let scaffold = 0; let n = 0
  for (const t of planner.tasks.values()) {
    if (t.kind !== 'block' || t.status === 'completed') continue
    const { x: tx, y: ty, z: tz } = t.world
    const lookUp = Boolean(t.info?.specs?.some(s => s.look === 'up'))
    let found = null
    let fallback = null
    for (const r of RINGS) {
      if (lookUp && r.dy >= 0) continue
      const sx = tx + r.dx; const sy = ty + r.dy; const sz = tz + r.dz
      if (sx === tx && sz === tz && (sy === ty || sy + 1 === ty)) continue
      const sk = `${sx},${sy},${sz}`
      if (planner.pitCells?.has(sk) || planner.fluidCells?.has(sk)) continue
      if (Math.hypot(r.dx, r.dz, (sy + 1.62) - (ty + 0.5)) > REACH) continue
      if (!solid(sx, sy - 1, sz, t)) continue
      if (solid(sx, sy, sz, t) || solid(sx, sy + 1, sz, t)) continue
      const cand = { x: sx, y: sy, z: sz }
      if (!fallback) fallback = cand
      if (!pendingAt(sx, sy, sz, t) && !pendingAt(sx, sy + 1, sz, t)) {
        found = cand
        break
      }
    }
    found = found || fallback
    if (found) { t.needsScaffold = false; planned++ } else { t.needsScaffold = true; scaffold++ }
    if (++n % 1500 === 0) await new Promise(r => setImmediate(r))
  }
  const ms = Date.now() - t0
  const out = { total: n, planned, needsScaffold: scaffold, unknownCells: unknown, ms }
  logger?.info?.(`PREFLIGHT: ${n} blocks analysed in ${ms} ms: ${planned} have a planned standing cell, ${scaffold} need a scaffold/pillar (planned before the build starts)`)
  return out
}

module.exports = { run }
