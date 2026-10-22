// Which settings does it take for a Hyperswarm connection on a loopback testnet to stay relayed?
// Run inside a user+net namespace (block needs nft there):
//   unshare -rn sh -c 'ip link set lo up && npx tsx spikes/s2-transport/experiments/relay-probe.ts [block]'
// Without "block" the direct path wins even though relayThrough is forced; with it, the link is relayed.
import createTestnet from 'hyperdht/testnet.js'
import { startRelay } from '../lib/relay.js'
import { makeSwarm } from '../lib/swarm.js'
import { blockMemberToMember } from '../lib/nft.js'

const block = process.argv[2] === 'block'
const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap
const relay = await startRelay(bootstrap)
console.log('relay at', relay.address, 'ports', relay.ports)
if (block) blockMemberToMember([...testnet.nodes.flatMap((n: any) => [n.io.serverSocket.address().port, n.io.clientSocket.address().port]), ...relay.ports])

const topic = Buffer.alloc(32, 7)
const a = makeSwarm({ bootstrap, relayKey: null })
const b = makeSwarm({ bootstrap, relayKey: relay.publicKey })

let atA = 0
a.on('connection', (c: any) => {
  c.on('error', () => {})
  c.on('message', (m: Buffer) => {
    atA++
    c.send(m)
  })
})
const got = new Promise<any>((resolve) => b.on('connection', resolve))
a.join(topic, { server: true, client: false })
await a.flush()
b.join(topic, { server: false, client: true })
const t0 = Date.now()
const timer = setTimeout(() => {
  console.log('no connection after 30 s; relay stats', JSON.stringify(relay.stats()))
  process.exit(1)
}, 30000)
const conn = await got
clearTimeout(timer)
conn.on('error', () => {})
await conn.opened
const show = (label: string) =>
  console.log(label, `${conn.rawStream.remoteHost}:${conn.rawStream.remotePort}`, 'relayed?', relay.ports.includes(conn.rawStream.remotePort))
show(`opened after ${Date.now() - t0} ms:`)
conn.rawStream.on('remote-changed', () => show('remote-changed:'))
let echoes = 0
conn.on('message', () => echoes++)
for (let i = 0; i < 50; i++) {
  conn.send(Buffer.from('ping' + i))
  await new Promise((r) => setTimeout(r, 100))
}
show('after 5 s:')
console.log('datagrams at A', atA, 'echoes', echoes, '/ 50', 'relay stats', JSON.stringify(relay.stats()))
await Promise.all([a.destroy(), b.destroy()])
await relay.close()
await testnet.destroy()
