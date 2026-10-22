import HyperDHT, { type ConnectOptions, type DhtOptions, type DhtServer, type ServerOptions } from 'hyperdht'
import Hyperswarm, { type HyperswarmOptions } from 'hyperswarm'
import type { Settings } from '../../shared/settings.js'

// One Hyperswarm per room, configured exactly as plan §4.1 describes.

export type NetSettings = Pick<Settings, 'udpPort' | 'bootstrapExtra' | 'relayKey' | 'alwaysRelay'>

/**
 * WT_BOOTSTRAP (comma- or space-separated host:port) replaces the public bootstrap nodes, e.g. for a local
 * testnet; Settings.bootstrapExtra adds to them. Otherwise undefined: hyperdht falls back to its defaults
 * only when the option is absent, and an empty array would mean "no bootstrap nodes" (hyperdht index.js:28).
 */
export function resolveBootstrap(envValue: string | undefined, extra: readonly string[]): string[] | undefined {
  const fromEnv = (envValue ?? '').split(/[\s,]+/).filter((s) => s.length > 0)
  if (fromEnv.length > 0) return fromEnv
  if (extra.length > 0) return [...HyperDHT.BOOTSTRAP, ...extra]
  return undefined
}

export interface SwarmConfig {
  keyPair: { publicKey: Buffer; secretKey: Buffer }
  settings: NetSettings
  maxPeers: number
  bootstrap: string[] | undefined
  /** true = do not accept or keep this key (bans, plus the test hook) */
  firewall: (remotePublicKey: Buffer) => boolean
  /** someone we do not firewall is dialing us (a server-side handshake), before Hyperswarm sees the connection */
  onDial?: (remotePublicKey: Buffer) => void
  /** read on every connection attempt, so a relay learned later applies to the next one */
  relayKey: () => Buffer | null
  alwaysRelay: () => boolean
  /** tests: a pre-made DHT node (bootstrap and port are then ignored); holdRelayed wraps it */
  dht?: unknown
}

export function swarmOptions(cfg: SwarmConfig): HyperswarmOptions {
  return {
    keyPair: cfg.keyPair,
    maxPeers: cfg.maxPeers,
    firewall: (pk, payload) => {
      if (cfg.firewall(pk)) return true
      // hyperdht passes server-side handshakes the remote's payload; Hyperswarm's own dials pass null
      if (payload) cfg.onDial?.(pk)
      return false
    },
    // Function form: also applies to server-side connections, and `force` is set after HOLEPUNCH_* errors.
    relayThrough: (force, sw) => {
      const key = cfg.relayKey()
      return key && (force || sw.dht.randomized || cfg.alwaysRelay()) ? key : null
    },
  }
}

/** The DHT node's own options: Hyperswarm only gets a node, so that holdRelayed can wrap it first. */
export function dhtOptions(cfg: Pick<SwarmConfig, 'settings' | 'bootstrap'>): DhtOptions {
  return {
    ...(cfg.settings.udpPort !== null ? { port: cfg.settings.udpPort } : {}),
    ...(cfg.bootstrap ? { bootstrap: cfg.bootstrap } : {}),
  }
}

type HolepunchDht = Pick<HyperDHT, 'connect' | 'createServer'>

/**
 * alwaysRelay: hyperdht holepunches beside every relayed link and moves it to the direct path as soon as a punch
 * succeeds (ADR 0005 Finding 5). While `hold()` says so:
 * - its `holepunch` callback refuses the punch, on our dials and on the server Hyperswarm creates;
 * - our dials skip the "fast open" probe and the same-public-address LAN shortcut, which connect without asking;
 * - the server takes no part in punching (`_neverPunch`, read per handshake), so it never answers a probe with
 *   its own "fast mode" ping. That ping, between two CONSISTENT NATs, linked the dialer directly while the server
 *   was already on the relay: a link neither side could use (S5 round 6, row a6).
 * Dials to the relay itself are left alone: hyperdht reaches the relay through this same connect. Not held: a
 * peer with an OPEN address (no NAT, or a forwarded port), which hyperdht dials directly before it asks.
 */
export function holdRelayed(dht: HolepunchDht, hold: () => boolean, relayKey: () => Buffer | null): void {
  const holepunch = (): boolean => !hold()
  const connect = dht.connect.bind(dht)
  dht.connect = (remotePublicKey, opts) => {
    if (relayKey()?.equals(remotePublicKey)) return connect(remotePublicKey, opts)
    if (!hold()) return connect(remotePublicKey, { ...opts, holepunch })
    const held: ConnectOptions & { fastOpen: boolean } = { ...opts, holepunch, fastOpen: false, localConnection: false }
    return connect(remotePublicKey, held)
  }
  const createServer = dht.createServer.bind(dht) as (opts: ServerOptions, cb?: unknown) => DhtServer
  dht.createServer = ((opts: ServerOptions, onconnection?: unknown) => {
    const server = createServer({ ...opts, holepunch }, onconnection)
    // hyperdht 6.34.1 lib/server.js:45 and :470: set from `holepunch === false` once, read on every handshake
    Object.defineProperty(server, '_neverPunch', { get: hold, configurable: true })
    return server
  }) as HyperDHT['createServer']
}

export function createSwarm(cfg: SwarmConfig): Hyperswarm {
  const dht = (cfg.dht as HyperDHT | undefined) ?? new HyperDHT(dhtOptions(cfg))
  holdRelayed(dht, () => cfg.alwaysRelay() && cfg.relayKey() !== null, cfg.relayKey)
  return new Hyperswarm({ ...swarmOptions(cfg), dht })
}
