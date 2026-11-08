'use strict'
// The failure catalogue: turns raw evidence (frames, block history, pours, log lines) into a named cause with the reasons and the fix.
// Everything here is pure (no bot, no I/O) so it can be unit tested and also run over old log files (scripts/diagnose.js).

const HOSTILE = /(zombie|skeleton|creeper|spider|enderman|witch|pillager|vindicator|husk|drowned|stray|phantom|slime|blaze|ghast|piglin|hoglin|warden|evoker|ravager|vex|guardian|silverfish|wither)/

// ---- damage / death ------------------------------------------------------------------------------------------------------------
// ctx: { dmg, hp, food, feet, head, below, oxygen, y, minY, frames:[{t,y,vy,onGround,...}], mobs:[{name,dist}], onFire }
function classifyDamage (ctx) {
  const ev = []
  const feet = ctx.feet || ''; const head = ctx.head || ''; const below = ctx.below || ''
  const frames = ctx.frames || []
  const recentFrames = frames.slice(-16)
  const maxY = recentFrames.length ? Math.max(...recentFrames.map(f => f.y)) : ctx.y
  const fall = maxY - ctx.y
  const out = (category, cause, reasons, fix) => ({ category, cause, reasons: [...reasons, ...ev], fix, dmg: ctx.dmg })
  if (feet === 'lava' || head === 'lava') { ev.push(`standing in lava (${feet}/${head})`); return out('lava', 'burned in lava', ['the bot entered lava: either it walked/fell into a lava cell or lava flowed onto it'], 'LEAK/LAVA: check the preceding FLUID EVENT lines and the pour that started it; the bot must retreat before a pour and never path through unknown fluid') }
  const recentFireOrLava = recentFrames.some(f => f && (f.feet === 'lava' || f.head === 'lava' || f.feet === 'fire' || f.feet === 'soul_fire' || f.below === 'lava'))
  if (feet === 'fire' || feet === 'soul_fire' || ctx.onFire || (recentFireOrLava && ctx.dmg <= 2.5)) { ev.push(`fire/afterburn (${feet}) onFire=${Boolean(ctx.onFire)}`); return out('fire', 'burning', ['standing in fire or afterburn tick after leaving lava/fire'], 'drink/place water or move away from fire; check lava ignition near leaves') }
  if (/magma_block|campfire|cactus|sweet_berry/.test(feet + below)) { ev.push(`touching ${feet}/${below}`); return out('hazard-block', `damaged by ${feet === 'air' ? below : feet}`, ['walked onto a damaging block'], 'path planner must treat these as hazards') }
  if (ctx.oxygen != null && ctx.oxygen <= 0 && (feet === 'water' || head === 'water')) { ev.push(`air supply ${ctx.oxygen}, head in water`); return out('drowning', 'drowned', ['head under water with no air left'], 'escape water earlier; swim to the nearest air cell, never pillar inside a water column') }
  if ((fall >= 3.2 && ctx.dmg >= 2) || (fall >= 2.2 && ctx.dmg >= 0.5 && ctx.dmg <= 4.0)) { ev.push(`fell ${fall.toFixed(1)} blocks (max y ${maxY.toFixed(1)} -> ${ctx.y.toFixed(1)})`); return out('fall', `fall damage from a ${fall.toFixed(1)} block drop`, ['an unplanned drop: hole in the build, edge, collapsed scaffold or missing look-ahead'], 'fall guard: look ahead for drops >= 3 blocks and never step off an unfinished edge; use water/scaffold when a drop is planned') }
  if (/^(stone|cobblestone|dirt|sand|gravel|[a-z_]+_planks|[a-z_]+)$/.test(head) && head !== 'air' && head !== 'cave_air' && head !== 'water' && head !== 'lava' && !/(slab|stairs|carpet|button|sign|torch|ladder|vine|rail|leaves|pane|fence|wall|trapdoor|door|bed|flower|sapling|grass|fern|plant|berry|chain|lantern|head|skull|pot|cake|candle|bars|cauldron|hopper|scaffolding|cobweb|snow|lily)/.test(head)) { ev.push(`head cell is solid ${head}`); return out('suffocation', 'suffocating inside a block', ['a block was placed/fell into the head cell (sand/gravel, scaffold, other bot)'], 'break the head block or move; never place a block above while standing under it') }
  if (ctx.y < (ctx.minY ?? -64) - 2) { ev.push(`y ${ctx.y.toFixed(1)} below the world`); return out('void', 'fell out of the world', ['no floor below and the bot kept falling'], 'never walk over unloaded/air columns near the bottom of the world') }
  if (ctx.food != null && ctx.food <= 0) { ev.push('food 0'); return out('starvation', 'starving', ['no food'], 'eat before the bar reaches 0') }
  const mob = (ctx.mobs || []).filter(m => HOSTILE.test(m.name) && m.dist < 6).sort((a, b) => a.dist - b.dist)[0]
  if (mob) { ev.push(`${mob.name} ${mob.dist.toFixed(1)} blocks away`); return out('mob', `attacked by ${mob.name}`, ['hostile mob nearby'], 'light the site / kill mobs / keep the bot inside lit enclosed work area') }
  const attacker = (ctx.mobs || []).filter(m => m.dist < 5.5).sort((a, b) => a.dist - b.dist)[0]
  if (attacker) { ev.push(`${attacker.name} ${attacker.dist.toFixed(1)} blocks away`); return out('combat', `attacked by ${attacker.name}`, ['nearby player or entity hit the bot'], 'keep non-builder players/entities from hitting the bot during construction') }
  if (ctx.pearlRecent || (ctx.dmg >= 4.5 && ctx.dmg <= 5.5 && fall < 3.2)) { ev.push(`ender pearl impact (${ctx.dmg.toFixed(1)} HP)`); return out('pearl', 'ender pearl landing damage', ['normal 5 HP self-damage from an ender pearl teleport'], 'expected when using ender pearls; prefer short pillars when height <= 4') }
  return out('unknown', 'damage with no recognised cause', ['none of the known damage sources matched the surrounding state'], 'send the postmortem file: it contains the last 20 s of frames and the blocks around the bot')
}

// ---- stray fluid -----------------------------------------------------------------------------------------------------------------
// ctx: { cell:'x,y,z', kind:'water'|'lava', pours:[{t,key,name,check:{blocked,why,leaks},bot,neighbours}], history:Map-like get(cell)->[{t,from,to,by,phase}],
//        now, box, isDesignAir(cell), scaffold:Set }
function classifyLeak (ctx) {
  const reasons = []; const evidence = []
  const [x, y, z] = ctx.cell.split(',').map(Number)
  const near = (ctx.pours || []).filter(p => { const [px, py, pz] = p.key.split(',').map(Number); return Math.hypot(px - x, py - y, pz - z) <= 9 && ctx.now - p.t < 240_000 && p.name === ctx.kind }).sort((a, b) => b.t - a.t)
  const src = near[0]
  let cause = 'fluid outside the design'; let fix = 'send the postmortem: it lists the pour and the block history around the cell'
  if (src) {
    evidence.push(`pour of ${src.name} at ${src.key} ${((ctx.now - src.t) / 1000).toFixed(0)}s earlier (fluid check said: ${src.check ? (src.check.blocked ? 'BLOCKED ' + src.check.why : 'safe') : 'no check'})`)
    if (src.forced) { cause = 'forced pour (the safety check was bypassed)'; reasons.push('the pour went ahead although the fluid check refused it (attempts >= 4 or fluidForce)'); fix = 'never force a pour while the channel is open; wait for the walls instead' }
    else if (src.check && src.check.blocked) { cause = 'pour went ahead against a blocked check'; reasons.push('fluidCheck was blocked but the pour ran') }
  }
  // who touched the cells between the pour and the leak
  const hist = []
  for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) {
    const k = `${x + dx},${y + dy},${z + dz}`
    for (const h of (ctx.history && ctx.history.get ? ctx.history.get(k) : []) || []) hist.push({ k, ...h })
  }
  const removed = hist.filter(h => /^(air|cave_air)$/.test(h.to) && !/^(air|cave_air|water|lava)$/.test(h.from) && (!src || h.t >= src.t - 120_000)).sort((a, b) => b.t - a.t)
  if (removed.length) {
    const r = removed[0]
    evidence.push(`block ${r.from} at ${r.k} was removed ${((ctx.now - r.t) / 1000).toFixed(0)}s earlier (phase "${r.phase || '?'}", by ${r.by || '?'})`)
    if ((ctx.scaffold && ctx.scaffold.has && ctx.scaffold.has(r.k)) || r.temp) { cause = 'a temporary block that held the fluid back was removed'; reasons.push('scaffold / bridge / pillar blocks were used as a wall and then taken away'); fix = 'fluid check must not count temporary or non-design solid blocks as walls (v1.21.2+)' } else if (/clearing|tidy|dig|break|exit/i.test(r.phase || '') || /dig/.test(r.by || '')) { cause = 'a bot broke the wall while it was clearing / digging / tidying'; reasons.push(`phase "${r.phase}" (${r.by}) broke ${r.from}`); fix = 'never break a block next to fluid; re-place the wall before the pour' }
    else { cause = 'a wall block disappeared (broken by a bot, a player, or physics)'; reasons.push('block history shows the wall removal') }
  }
  const placed = hist.filter(h => /^(air|cave_air)$/.test(h.from) && !/^(air|cave_air)$/.test(h.to) && !/^(water|lava)$/.test(h.to)).sort((a, b) => b.t - a.t)
  if (!removed.length && src && src.check && !src.check.blocked) {
    reasons.push('the fluid check judged the channel closed, but the fluid reached this cell: the cell was solid in the check yet is not solid now, or the flow reach/direction model is wrong')
    if (placed.length) evidence.push(`a ${placed[0].to} was placed near ${placed[0].k} ${((ctx.now - placed[0].t) / 1000).toFixed(0)}s earlier (may have been the only "wall")`)
    cause = 'the fluid check did not see this path'
  }
  if (ctx.isDesignAir && ctx.isDesignAir(ctx.cell)) { reasons.push('the design keeps this cell empty: any source touching a connected empty cell leaks into it') }
  if (!src) { reasons.push('no pour of this fluid near here in the last 4 minutes: the fluid came from a bucket used elsewhere, another bot, a player, or natural water/lava'); cause = 'fluid with no known pour behind it' }
  return { category: ctx.kind === 'lava' ? 'leak-lava' : 'leak-water', cause, reasons, evidence, fix }
}

// ---- stuck / loop ------------------------------------------------------------------------------------------------------------------
// ctx: { kind:'stuck'|'loop'|'rubberband'|'speed', phase, secs, nav, pos, cells, below, around:{wall:[...],open:[...]}, lastEvents:[...] }
function classifyStuck (ctx) {
  const reasons = []; const phase = ctx.phase || ''
  let cause = 'no progress'; let fix = 'send the postmortem'
  if (ctx.kind === 'loop') {
    cause = 'walking in circles'
    reasons.push(`only ${ctx.cells} distinct cells in ${ctx.secs}s while moving: the path is replanned over and over (goal unreachable, a hazard guard keeps stopping the walk, or two bots block each other)`)
    fix = 'ban the failing edge after 2 tries and change strategy (tower/bridge/dig/pearl) instead of replanning the same route'
  } else if (ctx.kind === 'rubberband') {
    cause = 'server keeps moving the bot back'; reasons.push('position corrections from the server: speed/collision mismatch, standing in a block, or anti-cheat'); fix = 'reduce speed near edges, never walk into unloaded or enclosed cells'
  } else if (/pathing|walk/.test(phase)) { cause = 'path never finishes'; reasons.push('navigation is running but the bot is not displacing: blocked by a door/ladder/fence, an unloaded chunk, or another bot') }
  else if (/aiming|click|pause/.test(phase)) { cause = 'waiting for the server'; reasons.push('the bot is looking/clicking and the server does not answer: lag, a plugin cancelling the placement, or protection') }
  else if (/clearing/.test(phase)) { cause = 'clearing a cell takes forever'; reasons.push('the cell holds something that cannot be dug (bedrock, barrier, protected, or wrong tool)') }
  else if (/tower|pillar|bridge/.test(phase)) { cause = 'scaffolding failed'; reasons.push('no support block to place against or no blocks left') }
  else if (/tidy/.test(phase)) { cause = 'tidying a temporary block'; reasons.push('the temporary block cannot be aimed from solid ground') }
  if (ctx.around && ctx.around.open === 0) reasons.push('all 4 horizontal neighbours are solid: the bot is walled in')
  return { category: ctx.kind === 'loop' ? 'loop' : ctx.kind === 'rubberband' ? 'rubberband' : 'stuck', cause, reasons, evidence: [], fix }
}

// ---- log lines (old logs and live) -----------------------------------------------------------------------------------------------
const LINE_RULES = [
  [/FLUID EVENT: (lava|water) outside the design/, 'leak', m => `stray ${m[1]} outside the design`, 'see the leak postmortem'],
  [/LAVA TURNED INTO OBSIDIAN/, 'leak', () => 'a lava source touched water and became obsidian (a water leak met a lava cell)', 'find the water leak that started it'],
  [/hazard guard: stopped before a pit/, 'guard-pit', () => 'the pit guard stopped a walk (a 3+ drop it thought the bot could not climb out of)', 'check canReturn; too many of these means a false positive or a really holey build'],
  [/hazard guard: stopped before lava/, 'guard-lava', () => 'stopped before lava / fire', 'expected, but repeated stops mean the route keeps going past lava'],
  [/edge guard: stopped before a/, 'guard-edge', () => 'stopped before a drop of 4+ blocks', 'normal near unfinished edges; many repeats mean a loop'],
  [/non-human speed/, 'motion-speed', () => 'movement faster than a player (corrected)', 'physics/lag: harmless if rare'],
  [/non-human snap/, 'motion-snap', () => 'camera turned too fast in one tick (corrected)', 'look smoothing'],
  [/WRONG STATE (\w+)/, 'wrong-state', m => `block ${m[1]} came out in the wrong state`, 'placement rule / pose; see the learned rule lines'],
  [/NO_ACCESS|no physical access/, 'no-access', () => 'no reachable standing position for a block', 'unreachable pocket: tower/bridge/dig or wait for neighbouring blocks'],
  [/NO_DELIVERY/, 'give-failed', () => '/give or shop delivered nothing', 'inventory update late, full inventory, or the server refused the command'],
  [/\[UNSAFE\]/, 'fluid-refused', () => 'a pour was refused by the safety check', 'expected: waits until the channel is closed'],
  [/EXIT: still stuck/, 'exit-failed', () => 'the exit planner could not get the bot out', 'see the EXIT plan lines above it'],
  [/EXIT: no way found/, 'exit-failed', () => 'the exit planner found no route', 'all moves banned or nothing diggable'],
  [/pose lost/, 'pose-lost', () => 'the aim pose was lost while walking to the stand', 'bot drifted off the planned stand'],
  [/idle for \d+s in/, 'idle', () => 'no movement or progress', 'see the stuck postmortem'],
  [/fell [\d.]+ blocks/, 'fall', () => 'unplanned fall', 'fall guard look-ahead'],
  [/died|was slain|fell out of the world|burned to death|tried to swim in lava|drowned|hit the ground too hard|went up in flames|suffocated/i, 'death', () => 'the bot died', 'see the death postmortem'],
  [/Task retry: ([a-z_]+) .*\[([A-Z_]+)\]/, 'task-retry', m => `${m[1]} failed with ${m[2]}`, 'see failure summary'],
  [/ECONNRESET|ETIMEDOUT|disconnect|kicked|socket closed/i, 'connection', () => 'connection problem', 'server/network'],
  [/Uncaught|TypeError|ReferenceError|RangeError/, 'bug', () => 'a code error (bug)', 'send the stack trace']
]
function classifyLine (text) {
  for (const [re, cat, why, fix] of LINE_RULES) { const m = re.exec(text); if (m) return { category: cat, reason: why(m), fix } }
  return null
}

module.exports = { classifyDamage, classifyLeak, classifyStuck, classifyLine, LINE_RULES, HOSTILE }
