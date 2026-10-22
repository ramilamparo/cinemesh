import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import HyperDHT from 'hyperdht'
import type Hyperswarm from 'hyperswarm'
import { describe, expect, it } from 'vitest'
import { type SwarmConfig, createSwarm, dhtOptions, holdRelayed, resolveBootstrap, swarmOptions } from './swarm.js'

describe('bootstrap', () => {
  it('stays undefined unless WT_BOOTSTRAP or bootstrapExtra is set', () => {
    expect(resolveBootstrap(undefined, [])).toBeUndefined()
    expect(resolveBootstrap('', [])).toBeUndefined()
    expect(resolveBootstrap(' , ', [])).toBeUndefined()
  })

  it('lets WT_BOOTSTRAP replace the defaults and bootstrapExtra add to them', () => {
    expect(resolveBootstrap('127.0.0.1:1, 127.0.0.1:2', ['x:3'])).toEqual(['127.0.0.1:1', '127.0.0.1:2'])
    expect(resolveBootstrap('', ['x:3'])).toEqual([...HyperDHT.BOOTSTRAP, 'x:3'])
  })
})

describe('swarm options', () => {
  const relay = Buffer.alloc(32, 7)
  const config = (over: Partial<SwarmConfig> = {}): SwarmConfig => ({
    keyPair: HyperDHT.keyPair(Buffer.alloc(32, 1)),
    settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
    maxPeers: 12,
    bootstrap: undefined,
    firewall: () => false,
    relayKey: () => relay,
    alwaysRelay: () => false,
    ...over,
  })
  const swarm = (randomized: boolean): Hyperswarm => ({ dht: { randomized } }) as unknown as Hyperswarm

  it('relays only when forced, behind a randomizing NAT, or when always on', () => {
    const fn = swarmOptions(config()).relayThrough
    if (typeof fn !== 'function') throw new Error('relayThrough must be the function form')
    expect(fn(false, swarm(false))).toBeNull()
    expect(fn(true, swarm(false))).toBe(relay)
    expect(fn(false, swarm(true))).toBe(relay)
    const always = swarmOptions(config({ alwaysRelay: () => true })).relayThrough
    if (typeof always !== 'function') throw new Error('relayThrough must be the function form')
    expect(always(false, swarm(false))).toBe(relay)
    const none = swarmOptions(config({ relayKey: () => null })).relayThrough
    if (typeof none !== 'function') throw new Error('relayThrough must be the function form')
    expect(none(true, swarm(true))).toBeNull()
  })

  it('reports dials from others, but not our own dials or firewalled keys', () => {
    const banned = Buffer.alloc(32, 9)
    const other = Buffer.alloc(32, 3)
    const dials: Buffer[] = []
    const firewall = swarmOptions(
      config({ firewall: (pk) => pk.equals(banned), onDial: (pk) => dials.push(pk) }),
    ).firewall
    if (!firewall) throw new Error('no firewall')
    expect(firewall(other, { version: 1 })).toBe(false) // a server-side handshake: hyperdht hands its payload
    expect(firewall(other, null)).toBe(false) // Hyperswarm checks its own dials with null
    expect(firewall(banned, { version: 1 })).toBe(true)
    expect(dials).toEqual([other])
  })

  it('gives the DHT node port and bootstrap only when set', () => {
    const bare = dhtOptions(config())
    expect('port' in bare).toBe(false)
    expect('bootstrap' in bare).toBe(false)
    const set = dhtOptions(
      config({
        settings: { udpPort: 49800, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
        bootstrap: ['127.0.0.1:1'],
      }),
    )
    expect(set.port).toBe(49800)
    expect(set.bootstrap).toEqual(['127.0.0.1:1'])
    expect(swarmOptions(config()).maxPeers).toBe(12)
  })
})

describe('alwaysRelay holds the relayed path', () => {
  const relay = Buffer.alloc(32, 7)
  const peer = Buffer.alloc(32, 3)
  type Opts = Record<string, unknown> & { holepunch?: () => boolean }

  /** What hyperdht would be handed: the options of each connect and of the server Hyperswarm creates. */
  function stubDht(): { dht: unknown; dials: [Buffer, Opts][]; servers: Opts[] } {
    const dials: [Buffer, Opts][] = []
    const servers: Opts[] = []
    const dht = {
      connect: (key: Buffer, opts: Opts = {}) => {
        dials.push([key, opts])
        return {}
      },
      createServer: (opts: Opts) => {
        servers.push(opts)
        return { opts }
      },
      on: () => undefined,
    }
    return { dht, dials, servers }
  }

  it('refuses hyperdht punches, client and server side, while alwaysRelay is on with a relay key', () => {
    let always = true
    let key: Buffer | null = relay
    const { dht, dials, servers } = stubDht()
    const swarm = createSwarm({
      keyPair: HyperDHT.keyPair(Buffer.alloc(32, 1)),
      settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
      maxPeers: 12,
      bootstrap: undefined,
      firewall: () => false,
      relayKey: () => key,
      alwaysRelay: () => always,
      dht,
    })
    const connect = (swarm.dht as unknown as Pick<HyperDHT, 'connect'>).connect
    connect(peer, { relayThrough: relay })
    const server = servers[0]
    const dial = dials[0]?.[1]
    if (!server?.holepunch || !dial?.holepunch) throw new Error('no holepunch callback reached hyperdht')
    // no fast-open probe and no LAN shortcut: both connect without asking the callback
    expect(dial).toMatchObject({ relayThrough: relay, fastOpen: false, localConnection: false })
    expect(dial.holepunch()).toBe(false)
    expect(server.holepunch()).toBe(false)
    // nor a server-side "fast mode" ping, which hyperdht sends before it asks
    const hyperdhtServer = (swarm as unknown as { server: { _neverPunch: boolean } }).server
    expect(hyperdhtServer._neverPunch).toBe(true)
    // read at punch time: the setting applies to links already up
    always = false
    expect(dial.holepunch()).toBe(true)
    expect(server.holepunch()).toBe(true)
    expect(hyperdhtServer._neverPunch).toBe(false)
    // without a relay there is nothing to hold: punch, or there would be no link at all
    always = true
    key = null
    expect(server.holepunch()).toBe(true)
  })

  it('leaves dials to the relay itself alone, and punches as usual with alwaysRelay off', () => {
    const { dht, dials } = stubDht()
    holdRelayed(
      dht as Pick<HyperDHT, 'connect' | 'createServer'>,
      () => true,
      () => relay,
    )
    const connect = (dht as Pick<HyperDHT, 'connect'>).connect
    connect(relay)
    expect(dials[0]?.[1]).toEqual({})
    const off = stubDht()
    holdRelayed(
      off.dht as Pick<HyperDHT, 'connect' | 'createServer'>,
      () => false,
      () => relay,
    )
    ;(off.dht as Pick<HyperDHT, 'connect'>).connect(peer)
    expect(off.dials[0]?.[1].holepunch?.()).toBe(true)
    expect(Object.keys(off.dials[0]?.[1] ?? {})).toEqual(['holepunch'])
  })
})

describe('hyperdht as loaded', () => {
  // patches/hyperdht+6.34.1.patch (ADR 0005 Finding 9): without it, a server-side TRY_LATER loses the address
  // verification and later viewers of a RANDOM host stay relayed for the whole session. Its effect needs NATs
  // (scripts/s5-matrix.mjs --rows m2); here, that the copy every module loads carries it (there is one copy).
  it('keeps the address verification on a server-side TRY_LATER', () => {
    const require = createRequire(import.meta.url)
    const connect = readFileSync(require.resolve('hyperdht/lib/connect.js'), 'utf8')
    const tryLater = connect.slice(
      connect.indexOf('if (error === ERROR.TRY_LATER && c.relayToken && payload.punching) {'),
    )
    expect(tryLater.slice(0, tryLater.indexOf('return {'))).toContain(
      'c.puncher.updateRemote({ punching, firewall, addresses, verified: peerAddress.host })',
    )
    expect(require.resolve('hyperdht', { paths: [require.resolve('hyperswarm')] })).toBe(require.resolve('hyperdht'))
  })
})
