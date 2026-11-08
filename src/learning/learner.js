'use strict'
// Remembers which physical placement rule really produced the right block state on THIS server, so a
// wrong guess costs one block once instead of one block per placement. Persisted between runs.
// Also includes Universal + Per-Schematic BuildMemory with Locked Run Replay, Safe Zones / Hazard Memory,
// and Proven Fluid Order so a second run on the same schematic (at ANY coordinates or on ANY server)
// replays proven stands, rules, and supports directly without repeating past mistakes.

const fs = require('fs')
const path = require('path')

// Context-dependent rules whose validity depends on which neighboring blocks are already placed at runtime
// (e.g. double-chest partner rules or trapdoor floor vs side mounting) must NEVER be saved as global
// block-type defaults in OrientationLearner!
const CONTEXT_DEPENDENT_TAGS = new Set(['observer-a', 'chest-partner-side', 'chest-opp', 'chest-single', 'trapdoor-flat', 'trapdoor-side'])
const CURRENT_MEMORY_VERSION = 8
const CURRENT_EXPERIENCE_VERSION = 2

class OrientationLearner {
  constructor (stateDir, logger, name = null) {
    this.baseFile = path.join(path.resolve(stateDir), 'learned-orientation.json')
    this.file = name ? path.join(path.resolve(stateDir), `learned-orientation.${name}.json`) : this.baseFile // one file per worker process
    this.logger = logger
    this.preferred = {} // block name -> spec tag that worked
    this.bad = new Map() // `${name}|${stateKey}` -> Set(tags that produced a wrong state)
    this.load()
  }

  load () {
    this.preferred = {}
    for (const f of [this.baseFile, this.file]) {
      try {
        if (f && fs.existsSync(f)) {
          const data = JSON.parse(fs.readFileSync(f, 'utf8'))
          Object.assign(this.preferred, data.preferred || {})
        }
      } catch (_) {}
    }
    for (const k of Object.keys(this.preferred)) {
      if (CONTEXT_DEPENDENT_TAGS.has(this.preferred[k]) || k.startsWith('chest') || k.includes('trapdoor')) {
        delete this.preferred[k]
      }
    }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = JSON.stringify({ version: 1, preferred: this.preferred }, null, 2)
      fs.writeFileSync(this.file, payload)
      if (this.baseFile && this.baseFile !== this.file) fs.writeFileSync(this.baseFile, payload)
    } catch (error) { this.logger?.warn?.(`learner save failed: ${error.message}`) }
  }

  stateKey (task) { return `${task.name}|${JSON.stringify(task.info.cmp)}` }

  prefKey (task) {
    const face = task?.properties?.face || task?.info?.cmp?.face
    const f = task?.properties?.facing || task?.info?.cmp?.facing
    if (face) return `${task.name}|${face}`
    if (f === 'up' || f === 'down') return `${task.name}|vert`
    if (f) return `${task.name}|horiz`
    return task.name
  }

  preferredFor (task) {
    return this.preferred[this.prefKey(task)] || this.preferred[task.name] || null
  }

  // specs in the order they should be tried
  order (task) {
    const specs = task.info.specs
    if (specs.length < 2) return specs
    const bad = this.bad.get(this.stateKey(task)) || new Set()
    const rawLocked = (task.lockedSpecTag && !CONTEXT_DEPENDENT_TAGS.has(task.lockedSpecTag)) || task.lockedSpecTag === 'trapdoor-side'
      ? task.lockedSpecTag
      : null
    const pref = rawLocked || this.preferredFor(task)
    const ranked = specs.filter(s => !bad.has(s.tag))
    const first = ranked.find(s => s.tag === pref)
    const rest = ranked.filter(s => s !== first)
    const failed = specs.filter(s => bad.has(s.tag))
    return [...(first ? [first] : []), ...rest, ...failed]
  }

  success (task, tag) {
    if (task.info.specs.length < 2) return
    if (CONTEXT_DEPENDENT_TAGS.has(tag)) return
    const pk = this.prefKey(task)
    if (this.preferred[pk] !== tag || this.preferred[task.name] !== tag) {
      this.preferred[pk] = tag
      this.preferred[task.name] = tag
      this.logger?.info?.(`EVOLVE: learned orientation rule '${tag}' for ${pk} (saved for all future builds)`)
      this.save()
    }
  }

  failure (task, tag) {
    const k = this.stateKey(task)
    if (!this.bad.has(k)) this.bad.set(k, new Set())
    this.bad.get(k).add(tag)
    const pk = this.prefKey(task)
    if (this.preferred[pk] === tag) { delete this.preferred[pk]; this.save() }
    if (this.preferred[task.name] === tag) { delete this.preferred[task.name]; this.save() }
  }
}

class Experience {
  constructor (stateDir, logger, name = null) {
    this.baseFile = path.join(path.resolve(stateDir), 'experience.json')
    this.file = name ? path.join(path.resolve(stateDir), `experience.${name}.json`) : this.baseFile
    this.logger = logger
    this.stats = {} // key -> { ok, fail }
    this.far = { ok: 0, fail: 0 } // clicks from more than 3.9 blocks away
    this.dirty = 0
    this.timing = { tasks: 0, totalMs: 0 }
    this.load()
  }

  load () {
    try {
      const d = JSON.parse(fs.readFileSync(fs.existsSync(this.file) ? this.file : this.baseFile, 'utf8'))
      if (Number(d.version || 0) >= CURRENT_EXPERIENCE_VERSION) {
        this.stats = d.stats || {}; this.far = d.far || this.far; this.timing = d.timing || this.timing
      }
    } catch (_) { /* first run */ }
  }

  save () {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ version: CURRENT_EXPERIENCE_VERSION, stats: this.stats, far: this.far, timing: this.timing }, null, 1))
      this.dirty = 0
    } catch (error) { this.logger?.warn?.(`experience save failed: ${error.message}`) }
  }

  record (key, ok, distance = 0) {
    const e = this.stats[key] || (this.stats[key] = { ok: 0, fail: 0 })
    if (ok) e.ok++; else e.fail++
    if (distance > 3.9) { if (ok) this.far.ok++; else this.far.fail++ }
    if (++this.dirty >= 25) this.save()
  }

  noteTask (ms) { this.timing.tasks++; this.timing.totalMs += ms }

  bias (key) {
    const e = this.stats[key]
    if (!e || e.ok + e.fail < 3) return 0
    return (e.fail / (e.ok + e.fail)) * 6
  }

  reachPenalty () {
    return Math.min(0.5, 0.1 * Math.floor(Math.max(0, this.far.fail - this.far.ok * 0.5) / 3))
  }

  summary () {
    const worst = Object.entries(this.stats).filter(([, v]) => v.ok + v.fail >= 3).sort((a, b) => b[1].fail / (b[1].ok + b[1].fail) - a[1].fail / (a[1].ok + a[1].fail)).slice(0, 3)
    const avg = this.timing.tasks ? Math.round(this.timing.totalMs / this.timing.tasks) : 0
    return `experience: ${Object.keys(this.stats).length} click patterns, reach penalty ${this.reachPenalty().toFixed(1)}, avg task ${avg} ms` + (worst.length ? `; hardest: ${worst.map(([k, v]) => `${k} ${v.fail}/${v.ok + v.fail} failed`).join(', ')}` : '')
  }
}

// Per-schematic AND Universal cross-server / cross-coordinate memory:
// 1. Learning run -> Locked run: records for every block (by schematic-local coordinate `local.x,local.y,local.z@rotation`)
//    which stand offset, click rule (`specTag`), and support blocks worked, plus which fluid pours succeeded without leaking.
//    Because everything is stored in schematic-local coordinates + relative offsets, building on a practice server at
//    one origin and then building on a real server at completely different coordinates transfers 100% of learned knowledge!
// 2. Safe Zones / Hazard Memory: remembers schematic-local cells where lava/fire or hopper trenches exist (`hazardCells`)
//    so stands and paths route around them automatically from the very start of the next build.
class BuildMemory {
  constructor (stateDir, schematicName, rotation = 0, logger = null) {
    const resolvedDir = path.resolve(stateDir)
    const safe = String(schematicName || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_')
    this.safeName = safe
    this.file = path.join(resolvedDir, `build-memory.${safe}.json`)
    this.universalFile = path.join(resolvedDir, 'universal-memory.json')
    const isLiveDataDir = path.basename(resolvedDir) === 'data' || /MinecraftHumanBuilder-data$/i.test(resolvedDir)
    const learnedDir = path.resolve(__dirname, '..', '..', 'learned')
    this.portableFile = isLiveDataDir ? path.join(learnedDir, `build-memory.${safe}.json`) : null
    this.rotation = Number(rotation) || 0
    this.logger = logger
    this.saveCounter = 0
    this.data = {
      version: CURRENT_MEMORY_VERSION,
      runs: 0,
      completedRuns: 0,
      supportNeeded: {},
      bestStands: {},
      lockedSpecs: {},
      provenFluids: [],
      hazardCells: {},
      hardBlocks: {},
      unsealNeeded: {}
    }
    this.universal = { version: 2, patterns: {} }
    this.worldHazards = new Set()
    this.lavaHazards = new Set()
    this.load()
  }

  keyFor (task) {
    if (!task?.local) return null
    return `${task.local.x},${task.local.y},${task.local.z}@${this.rotation}`
  }

  patternKeyFor (task, planner = null) {
    if (!task) return null
    const p = task.properties || task.info?.cmp || {}
    const statePart = [
      task.name,
      p.facing ? `f=${p.facing}` : '',
      p.half ? `h=${p.half}` : '',
      p.type ? `t=${p.type}` : '',
      p.face ? `fc=${p.face}` : '',
      p.axis ? `a=${p.axis}` : ''
    ].filter(Boolean).join(':')
    if (!planner?.tasks || !task.world) return statePart
    const dirs = [
      ['D', 0, -1, 0],
      ['U', 0, 1, 0],
      ['N', 0, 0, -1],
      ['S', 0, 0, 1],
      ['W', -1, 0, 0],
      ['E', 1, 0, 0]
    ]
    const mask = dirs.map(([tag, dx, dy, dz]) => {
      const nt = planner.tasks.get(`${task.world.x + dx},${task.world.y + dy},${task.world.z + dz}`)
      return `${tag}${nt && nt.kind === 'block' && !nt.info?.fragile ? 1 : 0}`
    }).join('')
    return `${statePart}|${mask}`
  }

  _mergeFrom (d) {
    if (!d || typeof d !== 'object') return
    const isLegacyPolluted = Number(d.version || 0) < CURRENT_MEMORY_VERSION || Object.keys(d.supportNeeded || {}).length > 6
    this.data.runs = Math.max(this.data.runs, Number(d.runs) || 0)
    this.data.completedRuns = Math.max(this.data.completedRuns, Number(d.completedRuns) || 0)
    if (!isLegacyPolluted) {
      Object.assign(this.data.supportNeeded, d.supportNeeded || {})
    }
    for (const [k, st] of Object.entries(d.bestStands || {})) {
      // Never retain elevated `st[1] > 0` stand offsets from bottom-up builds (standing on Layer L+1 to build Layer L is impossible before Layer L exists!)
      if (Array.isArray(st) && st.length === 3 && st[1] >= -3 && st[1] <= 0 && Math.abs(st[0]) <= 4 && Math.abs(st[2]) <= 4) {
        this.data.bestStands[k] = st
      }
    }
    for (const [k, v] of Object.entries(d.lockedSpecs || {})) {
      if (v === 'observer-a' || v === 'chest-partner-side' || v === 'chest-opp' || v === 'chest-single' || v === 'trapdoor-flat') continue
      this.data.lockedSpecs[k] = v
    }
    if (Array.isArray(d.provenFluids)) {
      for (const pf of d.provenFluids) {
        if (!this.data.provenFluids.includes(pf)) this.data.provenFluids.push(pf)
      }
    }
    // Only retain hazardCells from current-version clean files
    if (!isLegacyPolluted) {
      for (const [hk, hv] of Object.entries(d.hazardCells || {})) {
        if (hv && (hv.kind === 'lava' || hv.kind === 'trench' || hv.kind === 'pit')) {
          this.data.hazardCells[hk] = hv
        }
      }
      Object.assign(this.data.hardBlocks, d.hazardBlocks || d.hardBlocks || {})
      Object.assign(this.data.unsealNeeded, d.unsealNeeded || {})
    }
  }

  load () {
    for (const f of [this.file, this.portableFile]) {
      try {
        if (f && fs.existsSync(f)) {
          const d = JSON.parse(fs.readFileSync(f, 'utf8'))
          this._mergeFrom(d)
        }
      } catch (_) {}
    }
    try {
      if (fs.existsSync(this.universalFile)) {
        const u = JSON.parse(fs.readFileSync(this.universalFile, 'utf8'))
        this.universal = { version: 2, patterns: u.patterns || {} }
        for (const pk of Object.keys(this.universal.patterns)) {
          const spTag = this.universal.patterns[pk]?.specTag
          if (spTag && CONTEXT_DEPENDENT_TAGS.has(spTag)) {
            delete this.universal.patterns[pk].specTag
          }
          const st = this.universal.patterns[pk]?.stand
          if (Array.isArray(st) && st[1] > 0) {
            delete this.universal.patterns[pk].stand
          }
          if (this.universal.patterns[pk]?.support && !pk.endsWith('D0U0N0S0W0E0') && !pk.includes('f=up') && !pk.includes('f=down')) {
            delete this.universal.patterns[pk].support
          }
        }
      }
    } catch (_) { /* fresh universal memory */ }
  }

  save () {
    try {
      this.data.version = CURRENT_MEMORY_VERSION
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = JSON.stringify(this.data, null, 2)
      fs.writeFileSync(this.file, payload)
      if (this.portableFile) {
        try {
          fs.mkdirSync(path.dirname(this.portableFile), { recursive: true })
          fs.writeFileSync(this.portableFile, payload)
        } catch (_) {}
      }
      fs.writeFileSync(this.universalFile, JSON.stringify(this.universal, null, 2))
    } catch (error) { this.logger?.debug?.(`build-memory save failed: ${error.message}`) }
  }

  applyToPlanner (planner, Vec3Ctor) {
    this.plannerRef = planner
    this.originVec = planner?.transform?.origin || null
    this.data.runs++
    let hintsApplied = 0
    let supportsRemembered = 0
    let universalApplied = 0
    let lockedSpecsApplied = 0
    this.worldHazards.clear()
    this.lavaHazards.clear()
    // Automatically register all true pitCells and hopper trenches as structural hazards!
    if (planner.pitCells) {
      for (const pk of planner.pitCells) this.worldHazards.add(pk)
    }
    for (const task of planner.tasks.values()) {
      if (task.name === 'hopper' && task.local) {
        for (const dy of [0, 1]) {
          const hk = `${task.local.x},${task.local.y + dy},${task.local.z}@${this.rotation}`
          if (!this.data.hazardCells[hk]) {
            this.data.hazardCells[hk] = { kind: 'trench', count: 1 }
          }
        }
      }
    }
    if (this.originVec && this.data.hazardCells) {
      for (const [hk, hv] of Object.entries(this.data.hazardCells)) {
        if (!hv || (hv.kind !== 'lava' && hv.kind !== 'trench' && hv.kind !== 'pit')) {
          delete this.data.hazardCells[hk]
          continue
        }
        const [relPart, rotPart] = hk.split('@')
        if (Number(rotPart) !== this.rotation) continue
        const [dx, dy, dz] = relPart.split(',').map(Number)
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) continue
        const wx = this.originVec.x + dx; const wy = this.originVec.y + dy; const wz = this.originVec.z + dz
        const wk = `${wx},${wy},${wz}`
        const wkBelow = `${wx},${wy - 1},${wz}`
        const tHere = planner.tasks?.get(wk)
        const tBelow = planner.tasks?.get(wkBelow)
        const isSafeTask = t => Boolean(t && t.kind === 'block' && !t.info?.fragile && !/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(t.name || ''))
        const isTrueLava = (hv.kind === 'lava' && !isSafeTask(tHere) && !isSafeTask(tBelow)) || planner.fluidCells?.get(wk) === 'lava' || (planner.fluidCells?.get(wkBelow) === 'lava' && !isSafeTask(tHere))
        const isTruePit = Boolean(planner.pitCells?.has(wk)) || tHere?.name === 'hopper' || tBelow?.name === 'hopper'
        // Only retain hazardCells that are true lava or schematic pit/hopper cells — never allow false runtime pit records on open ground or safe decks!
        if (!isTrueLava && !isTruePit) {
          delete this.data.hazardCells[hk]
          continue
        }
        this.worldHazards.add(wk)
        if (isTrueLava) this.lavaHazards.add(wk)
      }
    }
    const hasUniversalPatterns = Boolean(this.universal?.patterns && Object.keys(this.universal.patterns).length > 0)
    const hasLocalRules = Boolean(
      Object.keys(this.data.bestStands || {}).length > 0 ||
      Object.keys(this.data.lockedSpecs || {}).length > 0 ||
      Object.keys(this.data.supportNeeded || {}).length > 0
    )
    if (hasUniversalPatterns || hasLocalRules) {
      for (const task of planner.tasks.values()) {
        const k = hasLocalRules ? this.keyFor(task) : null
        const pk = hasUniversalPatterns ? this.patternKeyFor(task, planner) : null
        // Sanitize supportNeeded: never keep support rules for ordinary free blocks or chests/hoppers!
        if (k && this.data.supportNeeded[k]) {
          const isLookUp = Boolean(task.info?.specs?.some(s => s.look === 'up'))
          const isFreeOrContainer = task.info?.specs?.[0]?.tag === 'free' || /^(chest|trapped_chest|ender_chest|hopper)$/.test(task.name || '')
          if (isFreeOrContainer && !isLookUp) {
            delete this.data.supportNeeded[k]
          }
        }
        const st = (k && this.data.bestStands[k]) || (pk && this.universal.patterns[pk]?.stand)
        const isLookUp = Boolean(task.info?.specs?.some(s => s.look === 'up'))
        if (Array.isArray(st) && st.length === 3 && st[1] <= 0 && (isLookUp ? st[1] >= -4 : st[1] >= -3)) {
          const hintWorld = new Vec3Ctor(task.world.x + st[0], task.world.y + st[1], task.world.z + st[2])
          const hk = `${hintWorld.x},${hintWorld.y},${hintWorld.z}`
          const hkHead = `${hintWorld.x},${hintWorld.y + 1},${hintWorld.z}`
          const underTask = planner.tasks.get(`${hintWorld.x},${hintWorld.y - 1},${hintWorld.z}`)
          const badFloor = Boolean(underTask && (/^(hopper|cauldron|composter|chest|trapped_chest|ender_chest)$/.test(underTask.name || '') || (/_slab$/.test(underTask.name || '') && underTask.properties?.type === 'bottom')))
          if (!this.worldHazards.has(hk) && !this.worldHazards.has(hkHead) && !planner.pitCells?.has(hk) && !planner.pitCells?.has(hkHead) && !planner.fluidCells?.has(hk) && !badFloor) {
            task.hint = hintWorld
            if (k && this.data.bestStands[k]) hintsApplied++
            else universalApplied++
          } else {
            if (k && this.data.bestStands[k]) delete this.data.bestStands[k]
            if (pk && this.universal.patterns[pk]?.stand) delete this.universal.patterns[pk].stand
          }
        }
        const lockedTag = (k && this.data.lockedSpecs[k]) || (pk && this.universal.patterns[pk]?.specTag)
        if (lockedTag && (!CONTEXT_DEPENDENT_TAGS.has(lockedTag) || lockedTag === 'trapdoor-side') && task.info?.specs?.some(s => s.tag === lockedTag)) {
          task.lockedSpecTag = lockedTag
          lockedSpecsApplied++
        }
        if ((k && this.data.supportNeeded[k]) || (pk && this.universal.patterns[pk]?.support)) {
          supportsRemembered++
        }
      }
    }
    if (!planner?.fleet || planner.fleet.index === 0) this.save()
    if (hintsApplied || supportsRemembered || universalApplied || lockedSpecsApplied || this.worldHazards.size) {
      this.logger?.info?.(`EVOLVE: loaded portable build plan (run #${this.data.runs}, ${this.data.completedRuns} completed): ${hintsApplied} proven stand(s), ${lockedSpecsApplied} locked click rule(s), ${universalApplied} universal pattern(s), ${supportsRemembered} support rule(s), ${this.worldHazards.size} hazard/trench cell(s) avoided`)
    }
  }

  isHazardWorldCell (cell) {
    if (!cell) return false
    const k = `${cell.x},${cell.y},${cell.z}`
    if (!this.worldHazards.has(k)) return false
    if (this.lavaHazards?.has(k)) return true
    if (this.plannerRef?.isActivePitCell) {
      return this.plannerRef.isActivePitCell(cell.x, cell.y, cell.z)
    }
    return true
  }

  recordHazardCell (worldPos, kind = 'lava') {
    if (!worldPos || (kind !== 'lava' && kind !== 'trench' && kind !== 'pit')) return
    const fx = Math.floor(worldPos.x); const fy = Math.floor(worldPos.y); const fz = Math.floor(worldPos.z)
    const wk = `${fx},${fy},${fz}`
    if (this.plannerRef?.tasks) {
      const isTruePit = Boolean(this.plannerRef.pitCells?.has(wk))
      const isTrueLava = this.plannerRef.fluidCells?.get(wk) === 'lava'
      if (!isTruePit && !isTrueLava && kind !== 'lava') {
        return
      }
    }
    this.worldHazards.add(wk)
    if (kind === 'lava') this.lavaHazards?.add(wk)
    if (this.originVec) {
      const hk = `${fx - this.originVec.x},${fy - this.originVec.y},${fz - this.originVec.z}@${this.rotation}`
      const prev = this.data.hazardCells[hk] || { kind, count: 0 }
      prev.count++
      prev.kind = kind
      this.data.hazardCells[hk] = prev
      if (prev.count === 1 || prev.count % 3 === 0) this.save()
    }
  }

  needsSupport (task) {
    if (task?.forceSupport) return true
    const k = this.keyFor(task)
    if (k && this.data.supportNeeded[k]) return true
    const pk = this.patternKeyFor(task, this.plannerRef)
    return Boolean(pk && this.universal.patterns[pk]?.support)
  }

  recordSupport (task, supportCells = []) {
    const k = this.keyFor(task)
    if (!task?.world || !supportCells.length) return
    const isLookUp = Boolean(task.info?.specs?.some(s => s.look === 'up'))
    const isFreeOrContainer = task.info?.specs?.[0]?.tag === 'free' || /^(chest|trapped_chest|ender_chest|hopper)$/.test(task.name || '')
    if (isFreeOrContainer && !isLookUp) return
    const rels = supportCells.map(c => [c.x - task.world.x, c.y - task.world.y, c.z - task.world.z])
    if (k && !this.data.supportNeeded[k]) {
      this.data.supportNeeded[k] = rels
    }
    const pk = this.patternKeyFor(task, this.plannerRef)
    if (pk && (pk.endsWith('D0U0N0S0W0E0') || pk.includes('f=up') || pk.includes('f=down'))) {
      this.universal.patterns[pk] = { ...(this.universal.patterns[pk] || {}), support: rels }
    }
    this.logger?.info?.(`EVOLVE: remembered that ${task.name} at local (${k || pk}) needs temporary overhead/side support (${supportCells.length} block(s)); next build will place support immediately`)
    this.save()
  }

  // Records the winning stand and click rule for successful block placements on solid non-scaffold, non-hazard ground
  recordSuccess (task, standCell, specTag = null) {
    const k = this.keyFor(task)
    if (!task?.world || !standCell) return
    if (this.plannerRef?.isTempCell?.(standCell.x, standCell.y - 1, standCell.z)) return
    const sk = `${standCell.x},${standCell.y},${standCell.z}`
    const skHead = `${standCell.x},${standCell.y + 1},${standCell.z}`
    if (this.worldHazards.has(sk) || this.worldHazards.has(skHead) || this.plannerRef?.pitCells?.has(sk) || this.plannerRef?.pitCells?.has(skHead) || this.plannerRef?.fluidCells?.has(sk)) return
    const cleanTag = specTag && (!CONTEXT_DEPENDENT_TAGS.has(specTag) || specTag === 'trapdoor-side') ? specTag : null
    const isLookUp = Boolean(task.info?.specs?.some(s => s.look === 'up'))
    const rel = [standCell.x - task.world.x, standCell.y - task.world.y, standCell.z - task.world.z]
    const minRelY = isLookUp ? -4 : -3
    // Only record bestStands with rel[1] <= 0 so a bottom-up build never tries to stand on a higher layer (rel[1] > 0) before that layer exists!
    if (Math.abs(rel[0]) <= 4 && rel[1] >= minRelY && rel[1] <= 0 && Math.abs(rel[2]) <= 4) {
      if (k) {
        this.data.bestStands[k] = rel
        if (cleanTag) this.data.lockedSpecs[k] = cleanTag
      }
      const pk = this.patternKeyFor(task, this.plannerRef)
      if (pk && (task.attempts > 0 || (task.info?.specs?.length || 0) > 1)) {
        const univTag = cleanTag && cleanTag !== 'trapdoor-side' ? cleanTag : null
        this.universal.patterns[pk] = {
          ...(this.universal.patterns[pk] || {}),
          stand: rel,
          ...(univTag ? { specTag: univTag } : {})
        }
      }
      if (++this.saveCounter >= 25) {
        this.saveCounter = 0
        this.save()
      }
    } else if (k && cleanTag) {
      this.data.lockedSpecs[k] = cleanTag
    }
  }

  recordStand (task, standCell, specTag = null) {
    this.recordSuccess(task, standCell, specTag)
    this.save()
  }

  recordProvenFluid (task) {
    const k = this.keyFor(task)
    if (!k) return
    if (!this.data.provenFluids.includes(k)) {
      this.data.provenFluids.push(k)
      if (++this.saveCounter >= 10) { this.saveCounter = 0; this.save() }
    }
  }

  recordUnseal (task, brokenPos) {
    const k = this.keyFor(task)
    if (!task?.world || !brokenPos) return
    const rel = [brokenPos.x - task.world.x, brokenPos.y - task.world.y, brokenPos.z - task.world.z]
    if (k) this.data.unsealNeeded[k] = rel
    const pk = this.patternKeyFor(task, this.plannerRef)
    if (pk) {
      this.universal.patterns[pk] = { ...(this.universal.patterns[pk] || {}), unseal: rel }
    }
    this.save()
  }

  recordFailure (task, error) {
    const k = this.keyFor(task)
    if (!k) return
    const row = this.data.hardBlocks[k] || { name: task.name, fails: 0, lastCode: null }
    row.fails++
    row.lastCode = error?.code || 'ERR'
    this.data.hardBlocks[k] = row
    if (row.fails === 2 || row.fails === 5) this.save()
  }

  markBuildComplete (stats) {
    this.data.completedRuns++
    if (this.plannerRef?.tasks) {
      for (const task of this.plannerRef.tasks.values()) {
        const k = this.keyFor(task)
        if (!k) continue
        if (task.kind === 'block' && !this.data.lockedSpecs[k] && task.info?.specs?.length === 1) {
          const tag = task.info.specs[0].tag
          if (tag && !CONTEXT_DEPENDENT_TAGS.has(tag)) this.data.lockedSpecs[k] = tag
        } else if (task.kind === 'fluid' || task.kind === 'waterlog') {
          if (!this.data.provenFluids.includes(k)) this.data.provenFluids.push(k)
        }
      }
    }
    this.save()
    this.logger?.info?.(`EVOLVE: build memory saved after completion (completedRuns=${this.data.completedRuns}, learnedStands=${Object.keys(this.data.bestStands).length}, lockedSpecs=${Object.keys(this.data.lockedSpecs).length}, universalPatterns=${Object.keys(this.universal.patterns).length}, supportRules=${Object.keys(this.data.supportNeeded).length}, hazardCells=${Object.keys(this.data.hazardCells).length}, verified=${stats?.correct}/${stats?.total})`)
  }
}

module.exports = { OrientationLearner, Experience, BuildMemory }
