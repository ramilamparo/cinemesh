// A blind relay on HyperDHT (plan §4.1): members that cannot hole-punch to each other pair their UDX
// streams through it. It only forwards encrypted packets; it never sees room keys or video.
import BlindRelay from 'blind-relay'
import HyperDHT from 'hyperdht'

export const DEFAULT_PORT = 49737

/**
 * @param {{ seed: Buffer, port?: number, host?: string, bootstrap?: (string | {host: string, port: number})[] }} opts
 */
export async function startRelay(opts) {
  const keyPair = HyperDHT.keyPair(opts.seed)
  const dht = new HyperDHT({
    port: opts.port ?? DEFAULT_PORT,
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
  })
  const relay = new BlindRelay.Server({
    createStream: (o) => dht.createRawStream({ ...o, framed: true }),
  })
  let connections = 0
  const server = dht.createServer((socket) => {
    connections++
    socket.on('error', () => {})
    socket.on('close', () => connections--)
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
  })
  await server.listen(keyPair)
  await dht.fullyBootstrapped()
  const address = dht.io.serverSocket.address()
  return {
    publicKey: keyPair.publicKey,
    address: { host: address.host, port: address.port },
    dht,
    stats: () => ({ connections, ...relay.stats }),
    async close() {
      await relay.close()
      await server.close()
      await dht.destroy()
    },
  }
}
