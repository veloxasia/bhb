'use strict'
// Zero-dependency cross-platform ZIP archive builder using Node's built-in `zlib`.
// Used by the GUI server (`/api/download-data-zip`) so users on Render, Linux VPS, or Windows
// can download `learned/` and `data/` as a single `.zip` file with one click.

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32 (buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime (date = new Date()) {
  const year = Math.max(1980, date.getFullYear())
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const seconds = Math.floor(date.getSeconds() / 2)
  const dosTime = ((hours & 0x1F) << 11) | ((minutes & 0x3F) << 5) | (seconds & 0x1F)
  const dosDate = (((year - 1980) & 0x7F) << 9) | ((month & 0x0F) << 5) | (day & 0x1F)
  return { dosTime, dosDate }
}

/**
 * Builds a standard PKZIP Buffer from an array of `{ name: 'folder/file.ext', data: Buffer, mtime?: Date }`.
 */
function buildZipBuffer (entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8')
    const rawBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ''), 'utf8')
    const crc = crc32(rawBuf)
    const compressed = zlib.deflateRawSync(rawBuf, { level: 6 })
    const useDeflate = compressed.length < rawBuf.length
    const bodyBuf = useDeflate ? compressed : rawBuf
    const method = useDeflate ? 8 : 0
    const { dosTime, dosDate } = dosDateTime(entry.mtime instanceof Date ? entry.mtime : new Date())

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0) // signature
    localHeader.writeUInt16LE(20, 4) // version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6) // UTF-8 flag
    localHeader.writeUInt16LE(method, 8) // compression method
    localHeader.writeUInt16LE(dosTime, 10)
    localHeader.writeUInt16LE(dosDate, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(bodyBuf.length, 18)
    localHeader.writeUInt32LE(rawBuf.length, 22)
    localHeader.writeUInt16LE(nameBuf.length, 26)
    localHeader.writeUInt16LE(0, 28) // extra length

    localParts.push(localHeader, nameBuf, bodyBuf)

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0) // signature
    centralHeader.writeUInt16LE(20, 4) // version made by
    centralHeader.writeUInt16LE(20, 6) // version needed
    centralHeader.writeUInt16LE(0x0800, 8) // UTF-8 flag
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt16LE(dosTime, 12)
    centralHeader.writeUInt16LE(dosDate, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(bodyBuf.length, 20)
    centralHeader.writeUInt32LE(rawBuf.length, 24)
    centralHeader.writeUInt16LE(nameBuf.length, 28)
    centralHeader.writeUInt16LE(0, 30) // extra length
    centralHeader.writeUInt16LE(0, 32) // comment length
    centralHeader.writeUInt16LE(0, 34) // disk number
    centralHeader.writeUInt16LE(0, 36) // internal attrs
    centralHeader.writeUInt32LE(0, 38) // external attrs
    centralHeader.writeUInt32LE(offset, 42) // local header offset

    centralParts.push(centralHeader, nameBuf)
    offset += localHeader.length + nameBuf.length + bodyBuf.length
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD signature
  eocd.writeUInt16LE(0, 4) // disk number
  eocd.writeUInt16LE(0, 6) // central dir disk
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

/**
 * Recursively collects files under `dirPath` into `{ name: '<prefix>/<relPath>', data: Buffer, mtime: Date }`.
 */
function collectFolderEntries (dirPath, prefix = '') {
  const out = []
  if (!dirPath || !fs.existsSync(dirPath)) return out
  const walk = (curr, relPrefix) => {
    let items = []
    try { items = fs.readdirSync(curr, { withFileTypes: true }) } catch { return }
    for (const item of items) {
      if (item.name === '.' || item.name === '..') continue
      const full = path.join(curr, item.name)
      const rel = relPrefix ? `${relPrefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        walk(full, rel)
      } else if (item.isFile()) {
        try {
          const stat = fs.statSync(full)
          if (stat.size > 150 * 1024 * 1024) continue // skip >150MB single files
          out.push({ name: rel, data: fs.readFileSync(full), mtime: stat.mtime })
        } catch {}
      }
    }
  }
  walk(dirPath, prefix)
  return out
}

module.exports = { buildZipBuffer, collectFolderEntries, crc32 }
