// Does a 4-member Hyperswarm mesh form cleanly on a loopback testnet, and does each side's live connection
// to a peer match the peer's (same handshakeHash)? Mismatches are "half-open" duplicates.
//   unshare -rn sh -c 'ip link set lo up && npx tsx spikes/s2-transport/experiments/mesh-probe.ts [topic|ordered] [send]'
import createTestnet from 'hyperdht/testnet.js'
import HyperDHT from 'hyperdht'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { makeSwarm } from '../lib/swarm.js'

const mode = process.argv[2] ?? 'topic'
const useMux = process.argv[3] === 'send' // open a Protomux channel at once, like the app does
const testnet = await createTestnet(3)
const topic = Buffer.alloc(32, 9)
const seeds = [1, 2, 3, 4].map((i) => Buffer.alloc(32, i))
const keys = seeds.map((s) => HyperDHT.keyPair(s).publicKey.toString('hex'))
const name = (k: string) => `m${keys.indexOf(k)}`
const t0 = Date.now()
const at = () => ((Date.now() - t0) / 1000).toFixed(2)
const swarms = seeds.map((seed, i) => {
  const sw = makeSwarm({ bootstrap: testnet.bootstrap, relayKey: null, seed })
  sw.on('connection', (conn: any) => {
    conn.on('error', () => {})
    const peer = name(conn.remotePublicKey.toString('hex'))
    console.log(at(), `m${i} conn ${peer} init=${conn.isInitiator} hh=${conn.handshakeHash.toString('hex').slice(0, 6)}`)
    conn.on('close', () => console.log(at(), `m${i} close ${peer} hh=${conn.handshakeHash.toString('hex').slice(0, 6)}`))
    if (useMux) {
      const ch = Protomux.from(conn).createChannel({ protocol: 'probe' })
      ch?.addMessage({ encoding: c.json })
      ch?.open()
    }
  })
  return sw
})
swarms.forEach((sw, i) => {
  if (mode === 'topic') {
    sw.join(topic, { server: true, client: true })
    if (i > 0) sw.joinPeer(Buffer.from(keys[0] as string, 'hex'))
  } else {
    sw.join(topic, { server: true, client: false })
    for (let j = 0; j < i; j++) sw.joinPeer(Buffer.from(keys[j] as string, 'hex'))
  }
})
const matched = (): number => {
  let ok = 0
  for (let i = 0; i < 4; i++)
    for (let j = i + 1; j < 4; j++) {
      const a = [...swarms[i].connections].find((x: any) => name(x.remotePublicKey.toString('hex')) === `m${j}`)
      const b = [...swarms[j].connections].find((x: any) => name(x.remotePublicKey.toString('hex')) === `m${i}`)
      if (a && b && a.handshakeHash.equals(b.handshakeHash)) ok++
    }
  return ok
}
for (let s = 0; s < 30; s++) {
  await new Promise((r) => setTimeout(r, 1000))
  const m = matched()
  if (s % 5 === 4 || m === 6) console.log(at(), `matched pairs ${m}/6`)
  if (m === 6) break
}
await Promise.all(swarms.map((s) => s.destroy()))
await testnet.destroy()
