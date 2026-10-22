import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { keyPairFromSeed } from './identity.js'
import { inviteText } from './invite.js'
import { type NetLog, Room } from './room.js'

// The Room against a stub DHT: no sockets, and the DHT's bootstrap under the test's control.

const quiet: NetLog = { debug: () => undefined, info: () => undefined, warn: () => undefined }
const relayKey = Buffer.alloc(32, 7)

/** Enough of a HyperDHT for Hyperswarm and the Room: records each dial, bootstraps when told to. */
class StubDht extends EventEmitter {
  randomized = false
  bootstrapped = false
  host: string | null = null
  port = 0
  firewalled = true
  readonly dials: { key: string; relayThrough: Buffer | null }[] = []
  private bootstrap!: () => void
  private readonly booted = new Promise<void>((resolve) => (this.bootstrap = resolve))

  /** The NAT sample a RANDOM node takes during bootstrap (dht-rpc sets randomized only then). */
  finishBootstrap(): void {
    Object.assign(this, { randomized: true, bootstrapped: true, host: '192.88.99.12' })
    this.bootstrap()
  }

  fullyBootstrapped(): Promise<void> {
    return this.booted
  }

  connect(key: Buffer, opts: { relayThrough?: Buffer | null } = {}): EventEmitter {
    this.dials.push({ key: key.toString('hex'), relayThrough: opts.relayThrough ?? null })
    return Object.assign(new EventEmitter(), {
      remotePublicKey: key,
      opened: Promise.resolve(false),
      rawStream: null,
      destroy: () => undefined,
    })
  }

  createServer(): unknown {
    return { listen: () => Promise.resolve(), close: () => Promise.resolve(), relayAddresses: [] }
  }

  announce(): unknown {
    return emptyQuery()
  }

  lookup(): unknown {
    return emptyQuery()
  }

  lookupAndUnannounce(): unknown {
    return emptyQuery()
  }

  unannounce(): Promise<void> {
    return Promise.resolve()
  }

  destroy(): Promise<void> {
    return Promise.resolve()
  }
}

function emptyQuery(): unknown {
  return {
    closestNodes: null,
    destroy: () => undefined,
    async *[Symbol.asyncIterator]() {
      // no peers
    },
  }
}

const rooms: Room[] = []
afterEach(async () => {
  await Promise.all(rooms.splice(0).map((r) => r.close()))
})

async function viewerOn(dht: StubDht): Promise<{ room: Room; hostKey: string }> {
  const hostKey = keyPairFromSeed('11'.repeat(32)).publicKey
  const invite = inviteText({ roomSecret: Buffer.alloc(32, 5), hostKey, relayKey, name: 'Stub room' })
  const room = await Room.join(invite.code, {
    displayName: 'V',
    settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
    store: null,
    env: {},
    log: quiet,
    testing: { dht },
  })
  rooms.push(room)
  return { room, hostKey: hostKey.toString('hex') }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

describe("a viewer's first dial", () => {
  it('waits for the DHT to bootstrap, so a RANDOM viewer dials the host through the relay', async () => {
    const dht = new StubDht()
    const { hostKey } = await viewerOn(dht)
    await settle()
    // before bootstrap, randomized still says false: a dial now would go without the relay (ADR 0005 Finding 6)
    expect(dht.dials.filter((d) => d.key === hostKey)).toEqual([])
    dht.finishBootstrap()
    await settle()
    expect(dht.dials.filter((d) => d.key === hostKey)).toEqual([{ key: hostKey, relayThrough: relayKey }])
  })

  it('is never made by a room leaving before the DHT bootstrapped', async () => {
    const dht = new StubDht()
    const { room, hostKey } = await viewerOn(dht)
    // bootstrap ends while the room says goodbye, before its swarm is destroyed
    const leaving = room.leave()
    dht.finishBootstrap()
    await settle()
    expect(dht.dials.filter((d) => d.key === hostKey)).toEqual([])
    await leaving
  })
})
