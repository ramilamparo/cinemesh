// Runs inside `unshare -rn` (see relay.test.ts): a private loopback-only network namespace where nft drops
// UDP between members, so the blind relay is the only path. Prints one `RESULT {json}` line.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import createTestnet from 'hyperdht/testnet.js'
import { startRelay } from '../../../packages/relay/src/index.js'
import { type NetLog, Room } from '../../../src/core/net/room.js'
import { DATAGRAM_SYNC } from '../../../src/core/net/wire.js'
import { FAST } from './helpers.js'

const quiet: NetLog = { debug: () => undefined, info: () => undefined, warn: () => undefined }

function blockMemberToMember(allowedPorts: number[]): void {
  const set = `{ ${[...new Set(allowedPorts)].join(', ')} }`
  const script = [
    'add table inet wt',
    'add chain inet wt out { type filter hook output priority 0; policy accept; }',
    `add rule inet wt out udp sport ${set} accept`,
    `add rule inet wt out udp dport ${set} accept`,
    'add rule inet wt out meta l4proto udp drop',
  ].join('\n')
  execFileSync('nft', ['-f', '-'], { input: script })
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

const testnet = await createTestnet(3)
const relay = await startRelay({ seed: randomBytes(32), bootstrap: testnet.bootstrap })
blockMemberToMember([
  ...testnet.nodes.flatMap((n) => [n.io.serverSocket.address().port, n.io.clientSocket.address().port]),
  relay.dht.io.serverSocket.address().port,
  relay.dht.io.clientSocket.address().port,
])

const bootstrap = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
const options = (name: string) => ({
  displayName: name,
  settings: { udpPort: null, bootstrapExtra: [], relayKey: relay.publicKey.toString('hex'), alwaysRelay: true },
  store: null,
  env: { WT_BOOTSTRAP: bootstrap },
  log: quiet,
  testing: { timing: FAST },
})

const host = await Room.create({ ...options('Host'), name: 'Relayed' })
await host.ready()
const viewer = await Room.join(host.invite().code, options('Viewer'))
// Both ends: the side that opens its ctrl lane second sees it open one (relayed) trip before the other.
const linked = await waitFor(
  () => viewer.peers().some((p) => p.isHost) && host.peer(viewer.self) !== null && viewer.state().relay.status === 'ok',
  20_000,
)
const hostPeer = viewer.peers().find((p) => p.isHost)

const chat: unknown[] = []
viewer.onMessage('chat', (m) => chat.push(m.body))
host.publish('chat.say', 'through the relay')
const busOk = await waitFor(() => chat.length > 0, 5000)

let datagrams = 0
viewer.onDatagram(DATAGRAM_SYNC, () => datagrams++)
const toViewer = host.peer(viewer.self)
for (let i = 0; i < 20; i++) {
  toViewer?.sendDatagram(Buffer.from([DATAGRAM_SYNC, 1, 1, i]))
  await new Promise((r) => setTimeout(r, 25))
}
await waitFor(() => datagrams > 0, 2000)

process.stdout.write(
  `RESULT ${JSON.stringify({
    linked,
    path: hostPeer?.path ?? null,
    relayStatus: viewer.state().relay.status,
    busOk,
    datagrams,
    pairings: relay.stats().pairings.matched,
  })}\n`,
)
await Promise.all([host.close(), viewer.close()])
await relay.close()
await testnet.destroy()
