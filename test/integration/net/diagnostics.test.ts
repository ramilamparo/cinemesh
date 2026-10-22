import dgram from 'node:dgram'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterEach, expect, it } from 'vitest'
import { networkTest } from '../../../src/core/net/diagnostics.js'
import { Harness, waitFor } from './helpers.js'

// The port-forward hint names udpPort only when the DHT bound it: dht-rpc quietly takes another port when it is busy.
// A local testnet shows the NAT as CONSISTENT, the class the hint is for.

const FORWARD = /does not answer from the internet yet\. Check the port forward on your router\.$/
const IN_USE = /was already in use, so another port was used and the port forward does not apply/

let h: Harness | null = null
let testnet: Testnet | null = null
const sockets: dgram.Socket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close()
  await h?.cleanup()
  h = null
  await testnet?.destroy()
  testnet = null
})

async function holdPort(): Promise<number> {
  const socket = dgram.createSocket('udp4')
  sockets.push(socket)
  await new Promise<void>((resolve) => socket.bind(0, resolve))
  return socket.address().port
}

/** a port nobody holds, as far as anyone can tell */
async function freePort(): Promise<number> {
  const socket = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => socket.bind(0, resolve))
  const { port } = socket.address()
  await new Promise<void>((resolve) => socket.close(resolve))
  return port
}

it('the Network test blames the forward only for a port it bound, and says when the port was in use', async () => {
  testnet = await createTestnet(3)
  const busy = await networkTest({ bootstrap: testnet.bootstrap, port: await holdPort(), timeoutMs: 8000 })
  expect(busy).toMatchObject({ class: 'CONSISTENT', bootstrapped: true })
  expect(busy.hint).toMatch(IN_USE)
  const free = await networkTest({ bootstrap: testnet.bootstrap, port: await freePort(), timeoutMs: 8000 })
  expect(free).toMatchObject({ class: 'CONSISTENT', bootstrapped: true })
  expect(free.hint).toMatch(FORWARD)
})

it("a room's NAT names the port it bound; a second DHT on that port, as a Network test beside it, cannot", async () => {
  h = await Harness.start()
  const port = await freePort()
  const options = h.options('Host')
  const host = await h.host('Host', { settings: { ...options.settings, udpPort: port } })
  await waitFor(() => host.state().nat.bootstrapped, 10_000, 'the room bootstrapped')
  expect(host.state().nat).toMatchObject({ class: 'CONSISTENT', bootstrapped: true })
  expect(host.state().nat.hint).toBe(
    `UDP ${String(port)} does not answer from the internet yet. Check the port forward on your router.`,
  )
  const beside = await networkTest({ bootstrap: h.bootstrap.split(','), port, timeoutMs: 8000 })
  expect(beside.hint).toMatch(IN_USE)
})
