// Hyperswarm as plan §4.1 builds it, minus firewall/bans: relayThrough uses the function form and is
// always forced when a relay key is given (the harness wants every viewer link relayed).
import HyperDHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'

export interface SwarmOpts {
  bootstrap: { host: string; port: number }[]
  relayKey: Buffer | null
  seed?: Buffer
}

export function makeSwarm({ bootstrap, relayKey, seed }: SwarmOpts): any {
  const relayThrough = relayKey ? (_force: boolean, _swarm: unknown) => relayKey : null
  return new Hyperswarm({ bootstrap, relayThrough, maxPeers: 12, keyPair: seed ? HyperDHT.keyPair(seed) : undefined })
}
