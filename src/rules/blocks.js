'use strict'
// Single source of truth for Minecraft block placement mechanics.
//
// For any block state from a schematic, describeBlock() tells the rest of the bot:
//   - kind: 'air' | 'derived' | 'fluid' | 'solid' | 'unsupported'
//   - item: inventory item name needed to place it
//   - phase: build order within a Y layer (0 solid/structural, 1 fragile/attached, 2 waterlog, 3 power, 5 water, 6 lava)
//   - specs: ordered list of placement specifications; if the 1st spec is a hypothesis (version/server dependent),
//            fallback specs follow so the orientation learner can lock in whichever one the server accepts.
//   - post: post-placement right-click actions (repeater delay, comparator mode, note_block pitch, trapdoor/gate/lever open/powered, sign text)
//   - cmp: filtered block-state properties that must match the schematic (ignoring server-computed shape/connection props).

const SIDES = ['north', 'east', 'south', 'west']
const OPP = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' }
const VEC = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }
const FACE_INDEX = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 }

const ALL_FACES = [{ f: 'up' }, { f: 'down' }, { f: 'north' }, { f: 'south' }, { f: 'east' }, { f: 'west' }]
const H_FACES = [{ f: 'north' }, { f: 'south' }, { f: 'east' }, { f: 'west' }]

const AIR = /^(air|cave_air|void_air|structure_void|light)$/

// Blocks that pop off if their supporting block is missing or broken.
// Note: use `(^|soul_)lantern` so full solid blocks like `sea_lantern` and `jack_o_lantern` are NEVER marked fragile!
const FRAGILE = /(torch|(^|soul_)lantern|lever|button|pressure_plate|rail|carpet|banner|sign|ladder|vine|lily_pad|sapling|flower|tulip|orchid|allium|bluet|daisy|dandelion|poppy|cornflower|lily_of_the_valley|wither_rose|rose_bush|peony|lilac|sunflower|fern|grass|dead_bush|mushroom|fungus|roots|sprouts|sugar_cane|cactus|bamboo|kelp|seagrass|sea_pickle|coral|amethyst_bud|amethyst_cluster|pointed_dripstone|spore_blossom|glow_lichen|hanging_roots|Moss_carpet|pink_petals|pitcher_crop|torchflower|sweet_berry|cocoa|tripwire_hook|redstone_wire|repeater|comparator|bell|cake|candle|flower_pot|sculk_vein|frogspawn| snow)$/i

// Blocks that open a GUI or toggle state when right-clicked without sneaking.
const INTERACTIVE = /(chest|trapped_chest|ender_chest|barrel|shulker_box|furnace|blast_furnace|smoker|dispenser|dropper|hopper|crafting_table|stonecutter|cartography_table|fletching_table|smithing_table|grindstone|loom|anvil|chipped_anvil|damaged_anvil|enchanting_table|brewing_stand|beacon|bell|lectern|jukebox|note_block|daylight_detector|repeater|comparator|lever|button|_door|_trapdoor|_fence_gate|cake|cauldron|composter|respawn_anchor|lodestone|chiseled_bookshelf|decorated_pot|crafter|command_block|bed)$/

const ITEM_OVERRIDE = {
  water: 'water_bucket',
  lava: 'lava_bucket',
  redstone_wire: 'redstone',
  tripwire: 'string',
  wall_torch: 'torch',
  soul_wall_torch: 'soul_torch',
  redstone_wall_torch: 'redstone_torch',
  oak_wall_sign: 'oak_sign', spruce_wall_sign: 'spruce_sign', birch_wall_sign: 'birch_sign',
  jungle_wall_sign: 'jungle_sign', acacia_wall_sign: 'acacia_sign', dark_oak_wall_sign: 'dark_oak_sign',
  mangrove_wall_sign: 'mangrove_sign', cherry_wall_sign: 'cherry_sign', bamboo_wall_sign: 'bamboo_sign',
  crimson_wall_sign: 'crimson_sign', warped_wall_sign: 'warped_sign',
  oak_wall_hanging_sign: 'oak_hanging_sign', spruce_wall_hanging_sign: 'spruce_hanging_sign',
  birch_wall_hanging_sign: 'birch_hanging_sign', jungle_wall_hanging_sign: 'jungle_hanging_sign',
  acacia_wall_hanging_sign: 'acacia_hanging_sign', dark_oak_wall_hanging_sign: 'dark_oak_hanging_sign',
  mangrove_wall_hanging_sign: 'mangrove_hanging_sign', cherry_wall_hanging_sign: 'cherry_hanging_sign',
  bamboo_wall_hanging_sign: 'bamboo_hanging_sign', crimson_wall_hanging_sign: 'crimson_hanging_sign',
  warped_wall_hanging_sign: 'warped_hanging_sign',
  white_wall_banner: 'white_banner', orange_wall_banner: 'orange_banner', magenta_wall_banner: 'magenta_banner',
  light_blue_wall_banner: 'light_blue_banner', yellow_wall_banner: 'yellow_banner', lime_wall_banner: 'lime_banner',
  pink_wall_banner: 'pink_banner', gray_wall_banner: 'gray_banner', light_gray_wall_banner: 'light_gray_banner',
  cyan_wall_banner: 'cyan_banner', purple_wall_banner: 'purple_banner', blue_wall_banner: 'blue_banner',
  brown_wall_banner: 'brown_banner', green_wall_banner: 'green_banner', red_wall_banner: 'red_banner',
  black_wall_banner: 'black_banner',
  sweet_berry_bush: 'sweet_berries',
  Wheat: 'wheat_seeds', wheat: 'wheat_seeds', beetroot: 'beetroot_seeds', beetroots: 'beetroot_seeds',
  carrots: 'carrot', potatoes: 'potato',
  melon_stem: 'melon_seeds', attached_melon_stem: 'melon_seeds',
  pumpkin_stem: 'pumpkin_seeds', attached_pumpkin_stem: 'pumpkin_seeds',
  cocoa: 'cocoa_beans',
  kelp_plant: 'kelp',
  tall_seagrass: 'seagrass',
  bamboo_sapling: 'bamboo',
  cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries',
  weeping_vines_plant: 'weeping_vines',
  twisting_vines_plant: 'twisting_vines',
  big_dripleaf_stem: 'big_dripleaf',
  powder_snow: 'powder_snow_bucket',
  farmland: 'dirt',
  dirt_path: 'dirt'
}

// Properties computed automatically by the server from neighbour blocks or redstone signal (never compare on placement).
const GLOBAL_IGNORED = new Set([
  'waterlogged', 'powered', 'power', 'triggered', 'lit', 'occupied', 'has_book', 'has_record', 'has_bottle_0', 'has_bottle_1', 'has_bottle_2',
  'distance', 'persistent', 'stage', 'age', 'moisture', 'honey_level', 'bites', 'dusted', 'charges', 'bloom', 'shrieking', 'can_summon',
  'signal_fire', 'drag', 'instrument', 'in_wall', 'attached', 'disarmed', 'short', 'extended', 'unstable', 'berries', 'natural', 'tilt',
  'trial_spawner_state', 'vault_state', 'ominous', 'crafting', 'enabled', 'locked', 'snowy', 'conditional', 'sculk_sensor_phase', 'cracked', 'bottom'
])

// Properties that may differ transiently or when neighbour blocks are not placed yet.
const SOFT = new Set(['type', 'shape', 'north', 'south', 'east', 'west', 'up', 'down', 'open', 'powered', 'note', 'delay', 'mode', 'hinge', 'in_wall', 'extended'])

function strip (name) { return String(name || '').replace(/^minecraft:/, '') }

function itemName (blockName) {
  const n = strip(blockName)
  return ITEM_OVERRIDE[n] || n
}

function isInteractive (blockName) {
  return INTERACTIVE.test(strip(blockName))
}

function ignoredProp (name, k) {
  if (name === 'lever' && k === 'powered') return false
  if ((name === 'LANTERN' || /^(lantern|soul_lantern)$/i.test(name)) && k === 'hanging') return false
  if (GLOBAL_IGNORED.has(k)) return true
  if ((k === 'north' || k === 'south' || k === 'east' || k === 'west' || k === 'up' || k === 'down') && !/^(piston|sticky_piston|observer|dispenser|dropper|hopper|barrel|command_block)$/.test(name)) return true
  if (k === 'shape' && (/_stairs$/.test(name) || /rail$/.test(name))) return true
  if (k === 'type' && /^(chest|trapped_chest)$/.test(name)) return false
  return false
}

// Build placement specs for a block.
function specsFor (n, p) {
  const f = p.facing
  const push = (...list) => list
  const hyp = list => list.map((s, i) => ({ ...s, hyp: i > 0 }))
  const free = () => [{ faces: ALL_FACES, look: null, horiz: null, tag: 'free' }]

  if (n === 'hopper' && f) {
    const clickFace = OPP[f] || 'down'
    return [{ faces: [{ f: clickFace }], look: null, horiz: null, tag: 'hopper', sneak: true }]
  }
  if (n === 'crafter' && p.orientation) {
    const [front, top] = String(p.orientation).split('_')
    const isVert = front === 'up' || front === 'down'
    return [
      { faces: ALL_FACES, look: OPP[front], horiz: isVert && top ? OPP[top] : null, tag: 'crafter-a' }
    ]
  }
  if (/^(piston|sticky_piston|dispenser|dropper|barrel|command_block|chain_command_block|repeating_command_block)$/.test(n) && f) {
    return hyp([
      { faces: ALL_FACES, look: OPP[f], horiz: null, tag: 'piston-a' },
      { faces: ALL_FACES, look: f, horiz: null, tag: 'piston-b' }
    ])
  }
  if (n === 'observer' && f) {
    const obsFaces = (f === 'up' || f === 'down') ? [{ f: 'up' }, { f: 'down' }, ...H_FACES] : ALL_FACES
    return hyp([
      { faces: obsFaces, look: f, horiz: null, tag: 'observer-b' },
      { faces: obsFaces, look: OPP[f], horiz: null, tag: 'observer-a' }
    ])
  }
  if (/_stairs$/.test(n) && f) {
    const half = p.half === 'top' ? 'top' : 'bottom'
    const faceList = half === 'top'
      ? [{ f: 'down' }, ...H_FACES.map(x => ({ f: x.f, half: 'top' }))]
      : [{ f: 'up' }, ...H_FACES.map(x => ({ f: x.f, half: 'bottom' }))]
    return push({ faces: faceList, look: null, horiz: f, tag: `stairs-${half}` })
  }
  if (/_slab$/.test(n)) {
    if (p.type === 'double') return free()
    const top = p.type === 'top'
    return push({
      faces: top
        ? [{ f: 'down' }, ...H_FACES.map(x => ({ f: x.f, half: 'top' }))]
        : [{ f: 'up' }, ...H_FACES.map(x => ({ f: x.f, half: 'bottom' }))],
      look: null, horiz: null, tag: top ? 'slab-top' : 'slab-bottom'
    })
  }
  if (/_trapdoor$/.test(n) && f) {
    const top = p.half === 'top'
    return push(
      { faces: [{ f: top ? 'down' : 'up' }], look: null, horiz: OPP[f], tag: 'trapdoor-flat' },
      { faces: [{ f, half: top ? 'top' : 'bottom' }], look: null, horiz: null, tag: 'trapdoor-side' }
    )
  }
  if (/_door$/.test(n) && f) {
    const right = p.hinge === 'right'
    const sideDir = right ? CW[f] : CCW[f]
    const cur = (sideDir === 'east' || sideDir === 'west')
      ? { axis: 'x', gt: sideDir === 'east' }
      : { axis: 'z', gt: sideDir === 'south' }
    return push({ faces: [{ f: 'up', cur }], look: null, horiz: f, tag: `door-${right ? 'right' : 'left'}` })
  }
  if (/_fence_gate$/.test(n) && f) {
    return hyp([
      { faces: ALL_FACES, look: null, horiz: f, tag: 'gate-same' },
      { faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'gate-opp' }
    ])
  }
  if (/^(chest|trapped_chest|ender_chest)$/.test(n) && f) {
    if (n === 'ender_chest' || !p.type || p.type === 'single') {
      return [{ faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'chest-sneak', sneak: true }]
    }
    const partnerDir = p.type === 'left' ? CW[f] : CCW[f]
    const partnerClickFace = OPP[partnerDir]
    return [
      { faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'chest-sneak', sneak: true, partnerDir, whenPartner: 'absent' },
      { faces: [{ f: partnerClickFace }], look: null, horiz: null, tag: 'chest-partner-side', sneak: true, partnerDir, whenPartner: 'present' },
      { faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'chest-opp', sneak: false, noSneakRef: true, partnerDir, whenPartner: 'present' }
    ]
  }
  if (/(^|_)(furnace|smoker|blast_furnace|loom|stonecutter|lectern|carved_pumpkin|jack_o_lantern|bee_nest|beehive)$/.test(n) && f) {
    return push({ faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'horiz-opposite' })
  }
  if (/(^|_)(glazed_terracotta|campfire|soul_campfire|decorated_pot|enchanting_table)$/.test(n) && f) {
    return hyp([{ faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'horiz-opposite' }, { faces: ALL_FACES, look: null, horiz: f, tag: 'horiz-same' }])
  }
  if (n === 'repeater' || n === 'comparator') return push({ faces: [{ f: 'up' }], look: null, horiz: OPP[f], tag: 'diode' })
  if (/^(lantern|soul_lantern)$/.test(n)) return push({ faces: [{ f: p.hanging === 'true' ? 'down' : 'up' }], look: null, horiz: null, tag: p.hanging === 'true' ? 'lantern-hang' : 'lantern-stand' })
  if (/(^|_)torch$/.test(n) && !/wall_torch/.test(n)) return push({ faces: [{ f: 'up' }], look: null, horiz: null, tag: 'floor-torch' })
  if (/wall_torch$/.test(n)) return push({ faces: [{ f }], look: null, horiz: null, tag: 'wall-torch' })
  if (/^ladder$|_wall_sign$|_wall_hanging_sign$|_wall_banner$/.test(n)) return push({ faces: [{ f }], look: null, horiz: null, tag: 'wall-attach' })
  if (/_sign$|_banner$/.test(n)) return push({ faces: [{ f: 'up' }], look: null, horiz: null, yaw16: +p.rotation, tag: 'standing-sign' })
  if (n === 'tripwire_hook') return hyp([{ faces: [{ f }], look: null, horiz: null, tag: 'hook-a' }, { faces: [{ f: OPP[f] }], look: null, horiz: null, tag: 'hook-b' }])
  if (/(^|_)button$|^lever$/.test(n)) {
    if (p.face === 'floor') {
      return hyp([
        { faces: [{ f: 'up' }], look: null, horiz: f, tag: 'switch-floor' },
        { faces: [{ f: 'up' }], look: null, horiz: OPP[f], tag: 'switch-floor-opp' }
      ])
    }
    if (p.face === 'ceiling') {
      return hyp([
        { faces: [{ f: 'down' }], look: null, horiz: f, tag: 'switch-ceiling' },
        { faces: [{ f: 'down' }], look: null, horiz: OPP[f], tag: 'switch-ceiling-opp' }
      ])
    }
    return push({ faces: [{ f }], look: null, horiz: null, tag: 'switch-wall' })
  }
  if (n === 'tripwire') return free()
  if (/rail$/.test(n)) {
    const sh = String(p.shape || '')
    const wantH = /east|west/.test(sh) ? 'east' : /north|south/.test(sh) ? 'north' : null
    return wantH
      ? [{ faces: [{ f: 'up' }], look: null, horiz: wantH, tag: 'rail-dir' }, { faces: [{ f: 'up' }], look: null, horiz: OPP[wantH], tag: 'rail-opp' }, { faces: [{ f: 'up' }], look: null, horiz: null, tag: 'floor' }]
      : push({ faces: [{ f: 'up' }], look: null, horiz: null, tag: 'floor' })
  }
  if (/pressure_plate$/.test(n) || n === 'redstone_wire' || /carpet$/.test(n)) return push({ faces: [{ f: 'up' }], look: null, horiz: null, tag: 'floor' })
  if (p.axis) { // logs, pillars, chains, hay ...
    const fs = p.axis === 'y' ? ['up', 'down'] : p.axis === 'x' ? ['east', 'west'] : ['north', 'south']
    return push({ faces: fs.map(x => ({ f: x })), look: null, horiz: null, tag: 'axis' })
  }
  if (f) { // unknown facing block: try every plausible rule, learner will remember what works
    const fallback = []
    if (SIDES.includes(f)) {
      fallback.push({ faces: ALL_FACES, look: null, horiz: f, tag: 'unk-horiz' }, { faces: ALL_FACES, look: null, horiz: OPP[f], tag: 'unk-horiz-opp' })
      fallback.push({ faces: [{ f }], look: null, horiz: null, tag: 'unk-face' }, { faces: [{ f: OPP[f] }], look: null, horiz: null, tag: 'unk-face-opp' })
    }
    fallback.push({ faces: ALL_FACES, look: OPP[f], horiz: null, tag: 'unk-look-opp' }, { faces: ALL_FACES, look: f, horiz: null, tag: 'unk-look' })
    return hyp(fallback)
  }
  return free()
}

// ---------------------------------------------------------------------------------------------
const _cache = new Map()
function keyFor (name, props) {
  const ks = Object.keys(props || {}).sort()
  return ks.length ? `${strip(name)}[${ks.map(k => `${k}=${props[k]}`).join(',')}]` : strip(name)
}

// describe({name, props}) or describeBlock(name, properties). Properties may be any scalar type.
function describeBlock (name, properties) {
  const props = {}
  for (const [k, v] of Object.entries(properties || {})) props[k] = String(v)
  const key = keyFor(name, props)
  let info = _cache.get(key)
  if (!info) { info = describe({ name, props, key }); _cache.set(key, info) }
  return info
}

function describe (entry) {
  const n = strip(entry.name)
  const props = entry.props || {}
  const info = { name: n, key: entry.key, props, kind: 'solid', item: null, phase: 0, cmp: {}, specs: [], post: [], waterlogged: false, fragile: false, soft: [] }

  if (AIR.test(n)) { info.kind = 'air'; return info }
  if (n === 'water' || n === 'lava') {
    if (props.level === '0') { info.kind = 'fluid'; info.item = ITEM_OVERRIDE[n]; info.phase = n === 'water' ? 5 : 6 } else info.kind = 'derived' // flowing: the game fills it by itself
    return info
  }
  if (/^(bubble_column|moving_piston|piston_head|fire|soul_fire|frosted_ice|end_portal|nether_portal|end_gateway|light)$/.test(n)) { info.kind = 'derived'; return info }
  if (props.half === 'upper' && /(door|tall_|large_fern|peony|rose_bush|lilac|sunflower|pitcher)/.test(n)) { info.kind = 'derived'; return info }
  if (props.part === 'head' && /_bed$/.test(n)) { info.kind = 'derived'; return info }
  if (/^potted_/.test(n)) { info.kind = 'unsupported'; info.note = 'potted plant: place pot + plant manually'; return info }

  info.item = itemName(n)
  info.fragile = FRAGILE.test(n)
  info.phase = info.fragile ? 1 : 0
  if (/^(redstone_block|redstone_torch|redstone_wall_torch|lever)$/.test(n) || /_button$/.test(n)) info.phase = 3
  if (props.waterlogged === 'true') info.waterlogged = true

  for (const [k, v] of Object.entries(props)) if (!ignoredProp(n, k)) info.cmp[k] = v
  // lever/other "powered=true" targets are reached with a post toggle; slab 'type' (bottom/top/double) is never soft
  info.soft = Object.keys(info.cmp).filter(k => SOFT.has(k) && !(k === 'type' && /_slab$/.test(n)))

  info.specs = specsFor(n, props)
  if (!info.specs.length) { info.kind = 'unsupported'; info.note = 'no placement rule'; return info }

  // post actions --------------------------------------------------------------------------
  if (n === 'note_block' && +props.note > 0) info.post.push({ type: 'note', value: +props.note, clicks: +props.note })
  if (n === 'repeater' && +props.delay > 1) info.post.push({ type: 'repeater', value: +props.delay, clicks: +props.delay - 1 })
  if (n === 'comparator' && props.mode === 'subtract') info.post.push({ type: 'comparator' })
  if (props.open === 'true') info.post.push({ type: 'toggle', prop: 'open', want: 'true' })
  if (n === 'lever' && props.powered === 'true') info.post.push({ type: 'toggle', prop: 'powered', want: 'true' })
  if (/_sign$|_hanging_sign$/.test(n)) info.post.push({ type: 'sign' })
  return info
}

// Does an actual world block satisfy the wanted state?
function matches (block, info, { withWater = false, ignore = null } = {}) {
  if (!block) return false
  if (info.kind === 'air') return block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air'
  if (block.name !== info.name) return false
  const pr = block.getProperties ? block.getProperties() : {}
  for (const [k, v] of Object.entries(info.cmp)) {
    if (ignore && ignore.includes(k)) continue
    if (String(pr[k]) !== String(v)) return false
  }
  if (withWater && info.waterlogged && String(pr.waterlogged) !== 'true') return false
  return true
}

// like matches() but names the first thing that is off (used for retry decisions)
function diff (block, info) {
  if (!block) return { key: 'unloaded', text: 'unloaded' }
  if (block.name !== info.name) return { key: 'name', text: `is ${block.name}` }
  const pr = block.getProperties ? block.getProperties() : {}
  for (const [k, v] of Object.entries(info.cmp)) if (String(pr[k]) !== String(v)) return { key: k, text: `${k}=${pr[k]} wanted ${v}` }
  return null
}

// Does the world block satisfy a planner task (kind: block | waterlog | fluid)?
const TERRAIN = new Set(['dirt', 'grass_block', 'podzol', 'mycelium', 'coarse_dirt', 'rooted_dirt'])
function taskMatches (block, task) {
  if (!block) return false
  if (task.kind !== 'fluid' && task.kind !== 'waterlog' && task.info && TERRAIN.has(task.info.name) && TERRAIN.has(block.name)) return true // grass spreads onto dirt: same thing
  if (task.accept && task.accept.includes(block.name)) return true // substituted block: the original is fine too
  const info = task.info
  if (task.kind === 'fluid') {
    if (block.name !== info.name) return false
    const pr = block.getProperties ? block.getProperties() : {}
    return String(pr.level) === '0'
  }
  const ignore = task.softOk
    ? info.soft
    : (/^(chest|trapped_chest)$/.test(info?.name || '')
        ? ['type']
        : (/(_door$|_fence_gate$)/.test(info?.name || '') ? ['open', 'hinge'] : null))
  return matches(block, info, { withWater: task.kind === 'waterlog', ignore })
}

// Faces of a spec that a real player can actually use. A ray hitting a face travels against its normal, so a face
// equal to the look/facing direction is impossible. Looking UP means the eye must be below the hit: in practice
// only the underside of a block above is reachable.
function usableFaces (spec) {
  let faces = spec.faces.map(f => f.f).filter(f => f !== spec.look && f !== spec.horiz)
  if (spec.look === 'up') faces = faces.filter(f => f === 'down')
  return faces
}

module.exports = { TERRAIN, usableFaces, taskMatches, describe, describeBlock, keyFor, matches, diff, isInteractive, itemName, SIDES, OPP, VEC, FACE_INDEX, CW, CCW, strip, SOFT, AIR }
