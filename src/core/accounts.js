'use strict'
// Login for one bot. Three modes, picked per account in the GUI:
//   microsoft : normal Microsoft login (device code, shown once in the console). The login is cached per account
//               and refreshes itself, so nothing has to be pasted again.
//   session   : you paste a Minecraft access token (and the bot reads the name/UUID that belong to it).
//               Tokens expire (about a day), so this is for short use; "microsoft" is the better choice for long builds.
//   offline   : cracked / offline-mode servers. Only a username.
const path = require('path')

const PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

function dashless (uuid) { return String(uuid || '').replace(/-/g, '').toLowerCase() }

// asks Mojang who owns this token (also used by the GUI "Verify" button)
async function verifySession (accessToken, timeoutMs = 10000) {
  const token = String(accessToken || '').trim().replace(/^Bearer\s+/i, '')
  if (!token) throw new Error('empty token')
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal })
    if (res.status === 401 || res.status === 403) throw new Error('token rejected by Minecraft services (expired or wrong token)')
    if (res.status === 404) throw new Error('this account has no Minecraft Java profile')
    if (!res.ok) throw new Error(`profile lookup failed (HTTP ${res.status})`)
    const body = await res.json()
    return { name: body.name, id: dashless(body.id), token }
  } finally { clearTimeout(timer) }
}

// options merged into mineflayer.createBot() for this account
async function authOptions (account, config, stateDir) {
  const mode = account.mode || 'offline'
  if (mode === 'offline') return { username: account.username, auth: 'offline' }
  if (mode === 'microsoft') {
    const folder = path.join(stateDir, 'auth', String(account.username || account.label || 'account').replace(/[^\w.-]/g, '_'))
    return {
      username: account.username,
      auth: 'microsoft',
      profilesFolder: folder,
      onMsaCode: data => console.log(`\n[login ${account.username}] Open ${data.verification_uri} and enter the code ${data.user_code}\n`)
    }
  }
  if (mode === 'session') {
    const who = await verifySession(account.accessToken)
    if (account.username && who.name.toLowerCase() !== String(account.username).toLowerCase()) {
      throw new Error(`token belongs to ${who.name}, but the account is listed as ${account.username}`)
    }
    const session = { accessToken: who.token, clientToken: 'mhb', selectedProfile: { id: who.id, name: who.name } }
    return {
      username: who.name,
      // minecraft-protocol accepts a function here: it only has to leave a session on the client and connect
      auth: (client, options) => {
        client.username = who.name
        client.session = session
        client.uuid = who.id.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
        options.haveCredentials = true
        client.emit('session', session)
        options.accessToken = who.token
        options.connect(client)
      }
    }
  }
  throw new Error(`unknown login mode "${mode}"`)
}

module.exports = { verifySession, authOptions, dashless }
