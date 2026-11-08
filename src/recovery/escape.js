'use strict'
// "Walled in": the bot stands in a pit / pocket whose walls reach above its head (it built or was built around),
// no walk, step up or short drop leads out, and a tower is impossible (ceiling). A player would take the
// pickaxe and dig out through the cheapest wall. Only used after repeated failures, never during normal work.
const { Vec3 } = require('../util/vec3')
const { sleep, withTimeout } = require('../util/async')

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]
const FACE_FOR = { '1,0': 4, '-1,0': 5, '0,1': 2, '0,-1': 3 } // face of the wall block that looks at the bot

function makeProbe (bot) {
  const at = (x, y, z) => bot.blockAt(new Vec3(x, y, z))
  const free = (x, y, z) => { const b = at(x, y, z); return !b || b.boundingBox !== 'block' } // unknown chunk counts as free
  const solid = (x, y, z) => { const b = at(x, y, z); return Boolean(b && b.boundingBox === 'block') }
  const standable = (x, y, z) => free(x, y, z) && free(x, y + 1, z) && solid(x, y - 1, z)
  return { at, free, solid, standable }
}

// how many different standing cells can be reached by walking / stepping up 1 / dropping up to 3
function reachable (bot, limit = 60) {
  const { free, standable } = makeProbe(bot)
  const p = bot.entity.position
  const start = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]
  const seen = new Set([start.join()]); const queue = [start]
  while (queue.length && seen.size < limit) {
    const [x, y, z] = queue.shift()
    for (const [dx, dz] of DIRS) {
      const nx = x + dx; const nz = z + dz
      for (const dy of [0, 1, -1, -2, -3]) {
        if (dy === 1 && !free(x, y + 2, z)) continue
        if (dy <= 0 && !(free(nx, y, nz) && free(nx, y + 1, nz))) continue
        if (dy < 0 && !(free(nx, y + dy, nz) && free(nx, y + dy + 1, nz))) continue
        if (!standable(nx, y + dy, nz)) continue
        const k = [nx, y + dy, nz].join()
        if (!seen.has(k)) { seen.add(k); queue.push([nx, y + dy, nz]) }
        break
      }
    }
  }
  return seen.size
}

// walled in = the walk graph (which knows slabs, stairs, drops, doors, water) from here is tiny and closed
function isEnclosed (bot) {
  try {
    const { makeGraph } = require('../navigation/brain')
    const g = makeGraph((x, y, z) => bot.blockAt(new Vec3(x, y, z)), 4)
    const p = bot.entity.position
    const me = { x: Math.floor(p.x), y: Math.floor(p.y + 0.01), z: Math.floor(p.z) }
    let start = null
    for (const dy of [0, -1, 1]) if (g.walkable(me.x, me.y + dy, me.z)) { start = { x: me.x, y: me.y + dy, z: me.z }; break }
    if (!start) return reachable(bot, 40) < 12
    const r = g.flood(start, g.succ, 40)
    return r.complete && r.cells.size < 12
  } catch { return reachable(bot, 40) < 12 }
}

// cheapest straight tunnel (up to 3 columns) to a column that can be walked on
function planExit (bot, planner, opts = {}) {
  const { free, solid } = makeProbe(bot)
  const p = bot.entity.position
  const x0 = Math.floor(p.x); const y0 = Math.floor(p.y); const z0 = Math.floor(p.z)
  let best = null
  for (const [dx, dz] of DIRS) {
    const dig = []; let cost = 0; let forbidden = false
    for (let k = 1; k <= (opts.maxCols || 3) && !forbidden; k++) {
      const x = x0 + dx * k; const z = z0 + dz * k
      const open = free(x, y0, z) && free(x, y0 + 1, z)
      const floored = [0, -1, -2, -3].some(d => solid(x, y0 + d - 1, z))
      if (forbidden) break
      if (open && floored) { if (!best || cost < best.cost) best = { dx, dz, k, dig, cost }; break }
      for (const y of [y0, y0 + 1]) {
        if (!solid(x, y, z)) continue
        const t = planner?.tasks?.get(`${x},${y},${z}`)
        if (t && t.status === 'completed' && !opts.allowKept) { forbidden = true; break } // never tear a finished part of the build apart to get out
        dig.push({ x, y, z, kept: Boolean(t && t.status === 'completed') })
        cost += t && t.status === 'completed' ? 3 : 1
      }
    }
  }
  return best
}


// Way out of a closed area (`trapped` = every standing cell the bot can walk/swim to): the cheapest straight tunnel whose far end is a standing
// cell OUTSIDE that area. Columns that are open but still inside the area do not count (that was the "digging 0 blocks" mistake: a
// neighbouring pool cell is open and floored but it is the same pit).
function planExitOut (bot, planner, trapped, opts = {}) {
  const { free, solid } = makeProbe(bot)
  const p = bot.entity.position
  const x0 = Math.floor(p.x); const y0 = Math.floor(p.y + 0.01); const z0 = Math.floor(p.z)
  const maxCols = opts.maxCols || 6
  const finished = (x, y, z) => { const t = planner?.tasks?.get(`${x},${y},${z}`); return Boolean(t && t.status === 'completed') }
  let best = null
  for (const [dx, dz] of DIRS) {
    const tunnel = []; let tcost = 0; let blocked = false
    for (let k = 1; k <= maxCols && !blocked; k++) {
      const x = x0 + dx * k; const z = z0 + dz * k
      // a standing cell outside the area at this column
      for (const fy of [y0, y0 + 1, y0 - 1, y0 - 2]) {
        if (!solid(x, fy - 1, z)) continue
        if (trapped && trapped.has(`${x},${fy},${z}`)) continue
        const dig = tunnel.slice(); let cost = tcost; let bad = false
        const need = [[x, fy, z], [x, fy + 1, z]]
        if (fy > y0) need.push([x0 + dx * (k - 1), y0 + 2, z0 + dz * (k - 1)]) // head room for the step up
        for (const [cx, cy, cz] of need) {
          if (!solid(cx, cy, cz)) continue
          if (finished(cx, cy, cz) && !opts.allowKept) { bad = true; break }
          dig.push({ x: cx, y: cy, z: cz, kept: finished(cx, cy, cz) }); cost += finished(cx, cy, cz) ? 3 : 1
        }
        if (bad) continue
        if (!dig.length && trapped) continue // nothing to dig and still outside = already free: not our case
        if (!best || cost + k * 0.1 < best.cost) best = { dx, dz, k, dig, cost: cost + k * 0.1, fy }
      }
      // extend the tunnel through this column (cells at body height) and go on
      for (const y of [y0, y0 + 1]) {
        if (!solid(x, y, z)) continue
        if (finished(x, y, z) && !opts.allowKept) { blocked = true; break }
        tunnel.push({ x, y, z, kept: finished(x, y, z) }); tcost += finished(x, y, z) ? 3 : 1
      }
    }
  }
  return best
}

async function walkTo (bot, x, z, ms = 1800, upTo = null) {
  const t0 = Date.now()
  bot.setControlState('sneak', false)
  while (Date.now() - t0 < ms) {
    const p = bot.entity.position
    if (Math.hypot(p.x - x, p.z - z) < 0.3) break
    await bot.lookAt(new Vec3(x, p.y + 1.6, z), true).catch(() => {})
    bot.setControlState('forward', true)
    bot.setControlState('jump', upTo != null && p.y < upTo - 0.3)
    await sleep(80)
  }
  bot.clearControlStates()
}

// returns { escaped, dug, reason }
async function escapeEnclosure ({ bot, interaction, planner, logger, incident, force = false, trapped = null }) {
  if (!bot.entity || (!force && !isEnclosed(bot))) return { escaped: false, reason: 'not enclosed' }
  // forced (no pearl, no pillar and no way out found by the brain): first through blocks that are not finished build, then, if that is not enough, through finished ones too (the planner re-places them afterwards)
  let plan = trapped && trapped.has ? planExitOut(bot, planner, trapped) : planExit(bot, planner, force ? { maxCols: 5 } : {})
  if (!plan && force) plan = trapped && trapped.has ? planExitOut(bot, planner, trapped, { allowKept: true }) : planExit(bot, planner, { allowKept: true, maxCols: 5 })
  if (!plan) return { escaped: false, reason: 'no wall to dig within 3 blocks' }
  const p0 = bot.entity.position.clone()
  logger.warn(`ESCAPE: walled in at ${p0.floored()}; digging ${plan.dig.length} block(s) towards ${plan.dx},${plan.dz}`)
  incident?.('walled-in', { message: `walled in at ${p0.floored()}`, plan: { dx: plan.dx, dz: plan.dz, columns: plan.k, dig: plan.dig } })
  bot.clearControlStates()
  let dug = 0
  for (const c of plan.dig) {
    const block = bot.blockAt(new Vec3(c.x, c.y, c.z))
    if (!block || block.boundingBox !== 'block') continue
    const dx = Math.sign(c.x - Math.floor(bot.entity.position.x)); const dz = Math.sign(c.z - Math.floor(bot.entity.position.z))
    await bot.lookAt(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5), true).catch(() => {})
    try { await withTimeout(interaction.digAimed(block, FACE_FOR[`${dx},${dz}`] ?? 1), 8000, 'escape dig') } catch (error) { logger.warn(`escape dig failed: ${error.message}`) }
    dug++
    // step into the column once both cells of it are open
    const col = plan.dig.filter(d => d.x === c.x && d.z === c.z)
    if (c === col[col.length - 1]) await walkTo(bot, c.x + 0.5, c.z + 0.5)
  }
  await walkTo(bot, Math.floor(p0.x) + plan.dx * plan.k + 0.5, Math.floor(p0.z) + plan.dz * plan.k + 0.5, 3500, plan.fy ?? null)
  const now = bot.entity.position
  const escaped = trapped && trapped.has ? !trapped.has(`${Math.floor(now.x)},${Math.floor(now.y + 0.01)},${Math.floor(now.z)}`) : force ? Math.hypot(bot.entity.position.x - p0.x, bot.entity.position.z - p0.z) > 1.5 : !isEnclosed(bot)
  logger.warn(escaped ? `ESCAPE: out at ${bot.entity.position.floored()} (dug ${dug})` : `ESCAPE: still walled in after digging ${dug}`)
  return { escaped, dug }
}

module.exports = { planExitOut, escapeEnclosure, isEnclosed, reachable, planExit }
