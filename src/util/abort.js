'use strict'
// A task that ran too long is abandoned: its async context is marked dead and every loop that calls
// checkAbort() stops at once instead of carrying on to fight the next task for the controls.
const { AsyncLocalStorage } = require('node:async_hooks')
const runStore = new AsyncLocalStorage()

function checkAbort () {
  if (runStore.getStore()?.dead) {
    const error = new Error('task abandoned after timeout')
    error.code = 'INTERRUPTED'
    throw error
  }
}

module.exports = { runStore, checkAbort }
