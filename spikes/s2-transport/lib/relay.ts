// A blind relay on the testnet: the "30-line relay script" of plan §7 S2 / §4.1 packages/relay.
import HyperDHT from 'hyperdht'
import BlindRelay from 'blind-relay'

export interface RelayHandle {
  publicKey: Buffer
  address: { host: string; port: number }
  /** both UDP sockets of the relay's DHT node; relayed raw streams use one of them */
  ports: number[]
  stats: () => unknown
  close: () => Promise<void>
}

export async function startRelay(bootstrap: { host: string; port: number }[]): Promise<RelayHandle> {
  const dht = new HyperDHT({ bootstrap })
  await dht.ready()
  const relay = new BlindRelay.Server({
    createStream: (opts: object) => dht.createRawStream({ ...opts, framed: true }),
  })
  const server = dht.createServer((socket: any) => {
    const session = relay.accept(socket, { id: socket.remotePublicKey })
    session.on('error', () => {})
  })
  await server.listen()
  // the relay's UDP socket: relayed members see this as conn.rawStream.remoteHost/remotePort
  const address = dht.io.serverSocket.address()
  return {
    publicKey: server.publicKey,
    address: { host: '127.0.0.1', port: address.port },
    ports: [address.port, dht.io.clientSocket.address().port],
    stats: () => relay.stats,
    close: async () => {
      await relay.close()
      await server.close()
      await dht.destroy()
    },
  }
}
