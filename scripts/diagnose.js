#!/usr/bin/env node
'use strict'
// node scripts/diagnose.js [dir|file ...]   — reads session.log / errors.log / incidents.jsonl / events.*.jsonl / postmortems/*.json
// and prints ONE report: what failed, when, why, and what to do about it. Works on logs from older versions too.
const fs = require('fs')
const path = require('path')
const { classifyLine } = require('../src/intel/causes')

const args = process.argv.slice(2)
const targets = args.length ? args : [path.resolve(__dirname, '..', 'data')]
const files = []
for (const t of targets) {
  if (!fs.existsSync(t)) continue
  if (fs.statSync(t).isDirectory()) {
    for (const f of fs.readdirSync(t)) { const p = path.join(t, f); if (fs.statSync(p).isFile()) files.push(p) }
    const pm = path.join(t, 'postmortems'); if (fs.existsSync(pm)) for (const f of fs.readdirSync(pm)) files.push(path.join(pm, f))
  } else files.push(t)
}
const read = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }
const out = []
const h = s => out.push('', `## ${s}`)

const lines = []
for (const f of files) {
  if (!/(session|errors)[^/]*\.log$|\.log$/.test(f)) continue
  for (const l of read(f).split('\n')) if (l) lines.push(l)
}
// de-duplicate lines that appear in both session.log and errors.log
const seen = new Set(); const uniq = []
for (const l of lines) { if (seen.has(l)) continue; seen.add(l); uniq.push(l) }
uniq.sort()

const cats = new Map(); const firstAt = new Map(); const sample = new Map()
const byWorker = new Map()
const leaks = []; const deaths = []; const pours = []; const brains = []
for (const l of uniq) {
  const m = /^\[([^\]]+)\] \[([^\]]+)\] \[(\w+)\] (.*)$/.exec(l)
  if (!m) continue
  const [, time, worker, level, text] = m
  const c = classifyLine(text)
  if (c) {
    const key = c.category
    cats.set(key, (cats.get(key) || 0) + 1)
    if (!firstAt.has(key)) firstAt.set(key, time)
    if (!sample.has(key)) sample.set(key, { reason: c.reason, fix: c.fix, line: text.slice(0, 200) })
    const w = byWorker.get(worker) || {}; w[key] = (w[key] || 0) + 1; byWorker.set(worker, w)
  }
  if (/FLUID EVENT: (lava|water) outside/.test(text)) leaks.push({ time, worker, text })
  if (/FLUID EVENT: LAVA TURNED INTO OBSIDIAN/.test(text)) leaks.push({ time, worker, text })
  if (/FLUID: pouring|OK (lava|water) /.test(text)) pours.push({ time, worker, text })
  if (/died|slain|burned to death|tried to swim in lava|drowned|hit the ground too hard|fell out of the world|went up in flames|suffocated/i.test(text) && !/Task|retry/.test(text)) deaths.push({ time, worker, text })
  if (/BRAIN:|LEAK ANALYSIS|POSTMORTEM/.test(text)) brains.push({ time, worker, text })
}

out.push('# Build diagnosis', '', `Read ${files.length} file(s), ${uniq.length} distinct log lines.`)
if (uniq.length) out.push(`Span: ${uniq[0].slice(1, 25)} -> ${uniq[uniq.length - 1].slice(1, 25)}`)

h('Verdict')
const verdict = []
if (deaths.length) verdict.push(`${deaths.length} death line(s): the bots are dying (see Deaths).`)
if (leaks.length) verdict.push(`${leaks.length} stray-fluid line(s): fluid is leaking outside the design (see Leaks).`)
if ((cats.get('guard-pit') || 0) > 20) verdict.push(`${cats.get('guard-pit')} pit-guard stops: the walking guard keeps interrupting (false positives or a very holey build).`)
if ((cats.get('no-access') || 0) > 30) verdict.push(`${cats.get('no-access')} NO_ACCESS failures: many blocks have no reachable standing spot.`)
if ((cats.get('bug') || 0)) verdict.push(`${cats.get('bug')} code error line(s): there is a bug, send the stack trace.`)
if (!verdict.length) verdict.push('No critical pattern found in these logs.')
out.push(...verdict.map(v => `- ${v}`))

h('Every category found (count, first seen, why, fix)')
for (const [k, n] of [...cats.entries()].sort((a, b) => b[1] - a[1])) { const s = sample.get(k); out.push(`- **${k}** x${n} (first ${String(firstAt.get(k)).slice(11, 19)}): ${s.reason}. Fix: ${s.fix}.\n    e.g. ${s.line}`) }

if (byWorker.size > 1) { h('Per worker'); for (const [w, c] of byWorker) out.push(`- ${w}: ${Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${k} ${n}`).join(', ')}`) }

if (deaths.length) { h('Deaths'); for (const d of deaths.slice(0, 20)) out.push(`- ${d.time.slice(11, 19)} ${d.worker}: ${d.text.slice(0, 200)}`) }

if (leaks.length) {
  h('Leaks (first 12) with the nearest earlier pour')
  const tOf = s => Date.parse(s)
  for (const l of leaks.slice(0, 12)) {
    const prior = pours.filter(p => tOf(p.time) <= tOf(l.time)).slice(-1)[0]
    out.push(`- ${l.time.slice(11, 19)} ${l.worker}: ${l.text.slice(0, 220)}${prior ? `\n    nearest earlier pour: ${prior.time.slice(11, 19)} ${prior.text.slice(0, 160)}` : ''}`)
  }
  const first = leaks[0]; const cell = /at (-?\d+,-?\d+,-?\d+)/.exec(first.text)
  if (cell) out.push('', `The first stray cell is ${cell[1]}. Look at what was built/removed around it just before ${first.time.slice(11, 19)}.`)
}

// postmortems and events written by the flight recorder (v1.22+)
const pms = files.filter(f => /postmortems[\\/].*\.json$/.test(f))
if (pms.length) {
  h(`Postmortems (${pms.length})`)
  for (const f of pms.slice(-40)) { try { const d = JSON.parse(read(f)); out.push(`- ${d.time.slice(11, 19)} ${d.worker} **${d.type}**: ${d.classification.cause}. ${d.classification.reasons.join(' | ')}${(d.classification.evidence || []).length ? ' EVIDENCE: ' + d.classification.evidence.join(' | ') : ''}\n    fix: ${d.classification.fix}  (${path.basename(f)})`) } catch { /* skip */ } }
}
if (brains.length) { h('Decisions of the intelligence engine (last 25)'); for (const b of brains.slice(-25)) out.push(`- ${b.time.slice(11, 19)} ${b.worker}: ${b.text.slice(0, 220)}`) }

h('Send me')
out.push('- data/session.log, data/errors.log, data/incidents.jsonl, the data/postmortems folder and the data/diagnosis.*.md files.')
console.log(out.join('\n'))
