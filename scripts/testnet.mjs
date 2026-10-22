#!/usr/bin/env node
// A local HyperDHT testnet for manual runs and the S5 NAT matrix (plan §7). Prints the bootstrap string to
// pass as WT_BOOTSTRAP, then keeps running until Ctrl+C.
//
//   node scripts/testnet.mjs [--size 3] [--host 127.0.0.1] [--port 0] [--relay] [--quiet]
//
// --host: the address members use to reach the bootstrap node. Use an address that every network namespace
//         can route to (e.g. the veth address of the "public" side in scripts/netns-nat.sh); any address
//         other than 127.0.0.1 makes the nodes listen on 0.0.0.0.
// --relay: also start a blind relay (packages/relay) on the testnet and print its key for Settings → Relay.
//
// Usage:  WT_BOOTSTRAP=$(node scripts/testnet.mjs --quiet | head -1) npm run dev   (or copy the printed line)
import process from 'node:process'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import createTestnet from 'hyperdht/testnet.js'

const { values: args } = parseArgs({
  options: {
    size: { type: 'string', default: '3' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '0' },
    relay: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
})

if (args.help) {
  process.stdout.write('usage: node scripts/testnet.mjs [--size 3] [--host 127.0.0.1] [--port 0] [--relay] [--quiet]\n')
  process.exit(0)
}

const size = Math.max(1, Number(args.size))
const testnet = await createTestnet(size, { host: args.host, port: Number(args.port) })
const bootstrap = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')

let relay = null
if (args.relay) {
  const { startRelay } = await import('../packages/relay/src/index.js')
  relay = await startRelay({ seed: randomBytes(32), port: 0, bootstrap: testnet.bootstrap })
}

if (args.quiet) {
  process.stdout.write(`${bootstrap}\n`)
  if (relay) process.stdout.write(`${relay.publicKey.toString('hex')}\n`)
} else {
  process.stdout.write(`testnet: ${String(size)} nodes\n`)
  process.stdout.write(`export WT_BOOTSTRAP=${bootstrap}\n`)
  if (relay) process.stdout.write(`relay key: ${relay.publicKey.toString('hex')} (UDP ${relay.address.port})\n`)
  process.stdout.write('Ctrl+C stops it.\n')
}

let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await relay?.close().catch(() => undefined)
  await testnet.destroy()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
