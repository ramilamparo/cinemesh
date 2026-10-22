#!/usr/bin/env node
// wt-relay: run a blind relay for Watch Together. Prints its key; paste it into Settings → Relay.
//   wt-relay [--port 49737] [--host 0.0.0.0] [--seed-file PATH] [--bootstrap host:port,...] [--stats-interval 60]
import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { clearInterval, setInterval } from 'node:timers'
import { parseArgs } from 'node:util'
import { DEFAULT_PORT, startRelay } from './src/index.js'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string' },
    host: { type: 'string' },
    'seed-file': { type: 'string' },
    bootstrap: { type: 'string' },
    'stats-interval': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (args.help) {
  process.stdout.write(
    'usage: wt-relay [--port 49737] [--host 0.0.0.0] [--seed-file PATH] [--bootstrap host:port,...] [--stats-interval 60]\n',
  )
  process.exit(0)
}

function log(level, msg, fields = {}) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields })}\n`)
}

// The seed is the relay's identity: keep it, or every member has to update the key in Settings.
function loadSeed(file) {
  if (existsSync(file)) {
    const seed = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
    if (seed.byteLength !== 32) throw new Error(`${file} does not hold a 32-byte hex seed`)
    return seed
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const seed = randomBytes(32)
  writeFileSync(file, `${seed.toString('hex')}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  log('info', 'created a new seed', { file })
  return seed
}

const seedFile = args['seed-file'] ?? join(process.env.STATE_DIRECTORY ?? process.cwd(), 'seed')
const port = Number(args.port ?? DEFAULT_PORT)
const statsEvery = Number(args['stats-interval'] ?? 60) * 1000
const bootstrap = (args.bootstrap ?? process.env.WT_BOOTSTRAP ?? '').split(/[\s,]+/).filter(Boolean)

const relay = await startRelay({
  seed: loadSeed(seedFile),
  port,
  ...(args.host ? { host: args.host } : {}),
  ...(bootstrap.length ? { bootstrap } : {}),
})
log('info', 'relay listening', {
  key: relay.publicKey.toString('hex'),
  udpPort: relay.address.port,
  nat: { host: relay.dht.host, port: relay.dht.port, firewalled: relay.dht.firewalled },
})
if (port !== 0 && relay.address.port !== port)
  log('warn', `UDP ${port} was busy; members reach this relay on ${relay.address.port}`)
if (relay.dht.firewalled) log('warn', 'the relay looks firewalled: open UDP for it, or members will not reach it')

const timer = setInterval(() => log('info', 'stats', relay.stats()), statsEvery)

let stopping = false
async function stop(signal) {
  if (stopping) return
  stopping = true
  clearInterval(timer)
  log('info', 'stopping', { signal })
  await relay.close().catch((e) => log('error', 'close failed', { error: String(e) }))
  process.exit(0)
}
process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))
