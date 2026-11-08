'use strict'

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor (predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000
  const intervalMs = options.intervalMs ?? 50
  const started = Date.now()
  let lastError = null

  while (Date.now() - started <= timeoutMs) {
    try {
      const result = await predicate()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }

  if (lastError) throw lastError
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

// rejects instead of hanging forever when a server answer never arrives
function withTimeout (promise, ms, label = 'operation') {
  let timer
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

// next physics tick, but never wait forever (ticks stop when the chunk/entity is missing)
function nextTick (bot, ms = 250) {
  const { checkAbort } = require('./abort')
  checkAbort()
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); bot.removeListener('physicsTick', done); resolve() }
    const timer = setTimeout(done, ms)
    bot.once('physicsTick', done)
  }).then(() => checkAbort())
}

module.exports = { sleep, waitFor, withTimeout, nextTick }
