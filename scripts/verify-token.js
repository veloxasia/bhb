'use strict'
// node scripts/verify-token.js <accessToken>   -> prints the player name the token belongs to
const { verifySession } = require('../src/core/accounts')
verifySession(process.argv[2]).then(w => console.log(`OK: ${w.name} (${w.id})`), e => { console.error('FAILED: ' + e.message); process.exit(1) })
