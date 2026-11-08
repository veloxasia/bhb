'use strict'

const fs = require('fs/promises')
const fsSync = require('fs')
const path = require('path')

function salvageJson (raw) {
  if (typeof raw !== 'string') return null
  const start = raw.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

class Persistence {
  constructor (stateDir) {
    this.stateDir = path.resolve(stateDir)
    this.activeFile = path.join(this.stateDir, 'active-job.json')
    this.lastBuildFile = path.join(this.stateDir, 'last-build.json')
    this._writeQueues = new Map()
  }

  fileFor (jobId) {
    return path.join(this.stateDir, `${jobId}.json`)
  }

  _enqueueWrite (file, fn) {
    const prev = this._writeQueues.get(file) || Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this._writeQueues.set(file, next)
    next.finally(() => {
      if (this._writeQueues.get(file) === next) this._writeQueues.delete(file)
    }).catch(() => {})
    return next
  }

  async _atomicWriteJson (file, data) {
    return this._enqueueWrite(file, async () => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const uniq = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
      const tmp = `${file}.${uniq}.tmp`
      const payload = JSON.stringify(data, null, 2)
      try {
        await fs.writeFile(tmp, payload, 'utf8')
        await fs.rename(tmp, file)
      } catch (err) {
        try { await fs.unlink(tmp) } catch {}
        throw err
      }
    })
  }

  async _readJsonSafe (file) {
    let raw
    try {
      raw = await fs.readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return null
      throw error
    }
    try {
      return JSON.parse(raw)
    } catch (parseErr) {
      const salvaged = salvageJson(raw)
      if (salvaged && typeof salvaged === 'object') {
        await this._atomicWriteJson(file, salvaged).catch(() => {})
        return salvaged
      }
      return null
    }
  }

  async load (jobId) {
    return this._readJsonSafe(this.fileFor(jobId))
  }

  async loadWithFallback (jobId, sharedJobId = null) {
    const primary = await this.load(jobId)
    if (primary?.planner?.length) return primary
    if (sharedJobId && sharedJobId !== jobId) {
      const shared = await this.load(sharedJobId)
      if (shared?.planner?.length) return shared
    }
    if (sharedJobId) {
      try {
        const prefix = `${sharedJobId}-`
        const files = fsSync.readdirSync(this.stateDir)
          .filter(f => f.startsWith(prefix) && f.endsWith('.json') && !f.endsWith('.tmp'))
          .sort((a, b) => {
            if (a.endsWith('-Build.json')) return -1
            if (b.endsWith('-Build.json')) return 1
            return a.localeCompare(b)
          })
        for (const f of files) {
          const candidate = await this._readJsonSafe(path.join(this.stateDir, f))
          if (candidate?.planner?.length) return candidate
        }
      } catch {}
    }
    return primary
  }

  async save (jobId, state) {
    await this._atomicWriteJson(this.fileFor(jobId), state)
  }

  async loadActive () {
    return this._readJsonSafe(this.activeFile)
  }

  async saveActive (job) {
    await this._atomicWriteJson(this.activeFile, job)
  }

  async clearActive () {
    try { await fs.unlink(this.activeFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  async loadLastBuild () {
    return this._readJsonSafe(this.lastBuildFile)
  }

  async saveLastBuild (job) {
    await this._atomicWriteJson(this.lastBuildFile, job)
  }
}

module.exports = { Persistence, salvageJson }
