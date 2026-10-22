import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PlayerStatus } from '../../shared/ipc/core.js'
import { CodedError } from '../../shared/result.js'
import { Bus, type BusLink, type BusMessage, type BusPolicy } from '../net/bus.js'
import { toHex } from '../net/crypto.js'
import { keyPairFromSeed } from '../net/identity.js'
import type { MemberView, Room, RoomPhase, RoomState } from '../net/room.js'
import { PLAYER_ERRORS } from '../player/player-controller.js'
import { MemberController } from '../sync/member.js'
import type { Clock, PresenceEvent } from '../sync/ports.js'
import type { SyncState } from '../sync/protocol.js'
import type { PlayerLike, PlayerLikeEvents } from './player-like.js'
import {
  BusPortAdapter,
  HOST_SILENT_MS,
  LOOP_RESOLUTION_MS,
  PlayerPortAdapter,
  SYNC_BUS_POLICIES,
  createClock,
  defineSyncPolicies,
  frameSeconds,
  toggleKind,
} from './sync-ports.js'

// ---- a room with a real bus (so net's rules apply) and scripted state/members --------------------------

const hostKp = keyPairFromSeed('01'.repeat(32))
const HOST = toHex(hostKp.publicKey)

class FakeRoom extends EventEmitter<{
  state: [RoomState]
  members: [MemberView[]]
  peer: [{ id: string }]
  'peer-gone': [string]
  bye: [{ peerId: string; end: boolean }]
}> {
  readonly bus: Bus
  readonly self: string
  hostPresent = true
  phase: RoomPhase = 'in-room'
  memberList: MemberView[] = []
  readonly datagramHandlers = new Set<(peer: { id: string }, buf: Buffer) => void>()

  constructor(seedByte: number) {
    super()
    const kp = seedByte === 1 ? hostKp : keyPairFromSeed(seedByte.toString(16).padStart(2, '0').repeat(32))
    this.bus = new Bus({ keyPair: kp, hostKey: HOST })
    // what Room defines from NET_POLICIES
    this.bus.define('sync.state', { hostOnly: true, sticky: true })
    this.bus.define('sync.intentResult', { hostOnly: true })
    this.self = this.bus.self
  }

  publish(name: string, body: unknown, opts: { to?: string } = {}): void {
    this.bus.publish(name, body, opts)
  }
  defineMessage(name: string, policy: BusPolicy): void {
    this.bus.define(name, policy)
  }
  onMessage(ns: string, handler: (msg: BusMessage) => void): () => void {
    return this.bus.subscribe(ns, handler)
  }
  latest(name: string): BusMessage | null {
    return this.bus.latest(name)
  }
  state(): RoomState {
    return { self: this.self, hostKey: HOST, hostPresent: this.hostPresent, phase: this.phase } as RoomState
  }
  members(): MemberView[] {
    return this.memberList
  }
  onDatagram(_prefix: number, handler: (peer: { id: string }, buf: Buffer) => void): () => void {
    this.datagramHandlers.add(handler)
    return () => this.datagramHandlers.delete(handler)
  }
  /** a sync datagram arriving over the link to `from` */
  datagram(from: string): void {
    for (const h of [...this.datagramHandlers]) h({ id: from }, Buffer.from([0x53, 1, 2]))
  }
  emitState(): void {
    this.emit('state', this.state())
  }
  asRoom(): Room {
    return this as unknown as Room
  }
}

function connect(a: FakeRoom, b: FakeRoom): void {
  const toB: BusLink = { id: b.self, sendEnvelope: (env) => b.bus.receive(structuredClone(env), a.self) }
  const toA: BusLink = { id: a.self, sendEnvelope: (env) => a.bus.receive(structuredClone(env), b.self) }
  a.bus.addLink(toB)
  b.bus.addLink(toA)
}

const view = (id: string, name: string, o: Partial<MemberView> = {}): MemberView => ({
  id,
  name,
  role: id === HOST ? 'host' : 'viewer',
  self: false,
  isHost: id === HOST,
  path: 'direct',
  rttMs: 10,
  linked: true,
  ...o,
})

const turn = (): Promise<void> => new Promise((r) => setImmediate(r))

function state(seq: number, o: Partial<SyncState> = {}): SyncState {
  return {
    t: 'sync.state',
    v: 1,
    syncEpoch: 7,
    seq,
    mode: 'paused',
    anchor: { pos: 12, hostTime: 1000, rate: 1 },
    perms: { othersPlayPause: false, othersSeek: false },
    waitForAll: true,
    startMode: { kind: 'buffered', seconds: 10 },
    cause: null,
    members: [],
    sentAt: 1000 + seq,
    ...o,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BusPortAdapter.publish', () => {
  it('answers sync.hello with an unaddressed sync.state, because net cannot address a sticky name', () => {
    const host = new FakeRoom(1)
    const viewer = new FakeRoom(2)
    connect(host, viewer)
    const got: BusMessage[] = []
    viewer.onMessage('sync', (m) => got.push(m))
    const log = vi.fn()
    // what the group does for a hello: bus.publish(st, { to: from })
    new BusPortAdapter(host.asRoom(), HOST, log).publish(state(3), { to: viewer.self })
    expect(log).not.toHaveBeenCalled()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ name: 'sync.state', from: HOST, to: null, body: state(3) })
    // and it is the sticky a later link gets
    expect(host.latest('sync.state')?.body).toEqual(state(3))
  })

  it('keeps other messages addressed', () => {
    const host = new FakeRoom(1)
    const sam = new FakeRoom(2)
    const kim = new FakeRoom(3)
    connect(host, sam)
    connect(host, kim)
    const atSam: BusMessage[] = []
    const atKim: BusMessage[] = []
    sam.onMessage('sync', (m) => atSam.push(m))
    kim.onMessage('sync', (m) => atKim.push(m))
    new BusPortAdapter(host.asRoom(), HOST, vi.fn()).publish(
      { t: 'sync.intentResult', intentId: 'a:1', accepted: true },
      { to: sam.self },
    )
    expect(atSam.map((m) => m.to)).toEqual([sam.self])
    expect(atKim).toHaveLength(0)
  })
})

describe('SYNC_BUS_POLICIES', () => {
  const received = (room: FakeRoom): string[] => {
    const names: string[] = []
    room.onMessage('sync', (m) => {
      if (m.via !== null) names.push(m.name)
    })
    return names
  }
  const count = (names: string[], name: string): number => names.filter((n) => n === name).length

  it('let a member flooding hellos and Ask host get a burst through to the host, and no more', () => {
    vi.useFakeTimers({ toFake: ['Date'] }) // the bus refills its buckets on Date.now
    const host = new FakeRoom(1)
    const sam = new FakeRoom(2)
    for (const r of [host, sam]) defineSyncPolicies(r.asRoom())
    connect(host, sam)
    const atHost = received(host)
    for (let i = 0; i < 900; i++) sam.publish('sync.hello', { t: 'sync.hello', resume: null }, { to: HOST })
    for (let i = 0; i < 1000; i++) sam.publish('sync.request', { t: 'sync.request', kind: 'play' }, { to: HOST })
    expect(count(atHost, 'sync.hello')).toBe(3)
    expect(count(atHost, 'sync.request')).toBe(3)
    // refilled: one hello per 2 s
    vi.advanceTimersByTime(2000)
    sam.publish('sync.hello', { t: 'sync.hello', resume: null }, { to: HOST })
    expect(count(atHost, 'sync.hello')).toBe(4)
  })

  it('stop a flood at the first member that forwards it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const host = new FakeRoom(1)
    const sam = new FakeRoom(2)
    const kim = new FakeRoom(3)
    for (const r of [host, sam, kim]) defineSyncPolicies(r.asRoom())
    // sam reaches the host only through kim (via-peer)
    connect(host, kim)
    connect(kim, sam)
    const atHost = received(host)
    const status = { t: 'sync.status' }
    for (let i = 0; i < 500; i++) sam.publish('sync.status', status, { to: HOST })
    for (let i = 0; i < 500; i++) sam.publish('sync.intent', { t: 'sync.intent' }, { to: HOST })
    for (let i = 0; i < 500; i++) sam.publish('sync.ping', { t: 'sync.ping' }, { to: HOST })
    expect(count(atHost, 'sync.status')).toBe(SYNC_BUS_POLICIES['sync.status']?.rate?.burst)
    expect(count(atHost, 'sync.intent')).toBe(SYNC_BUS_POLICIES['sync.intent']?.rate?.burst)
    expect(count(atHost, 'sync.ping')).toBe(SYNC_BUS_POLICIES['sync.ping']?.rate?.burst)
  })

  it("make sync.pong the host's alone, and leave net's own sync names as net defines them", () => {
    const host = new FakeRoom(1)
    const sam = new FakeRoom(2)
    for (const r of [host, sam]) defineSyncPolicies(r.asRoom())
    expect(() => sam.publish('sync.pong', { t: 'sync.pong' }, { to: HOST })).toThrow()
    expect(sam.bus.policy('sync.state')).toEqual({ hostOnly: true, sticky: true })
    expect(sam.bus.policy('sync.intentResult')).toEqual({ hostOnly: true })
  })
})

describe('createClock', () => {
  it("reads the event loop's lag beyond the histogram's own interval: an idle loop is ~0, not 10 ms", () => {
    let maxNs = 0
    const hist = {
      enable: vi.fn(() => true),
      disable: vi.fn(() => true),
      reset: vi.fn(),
      get max() {
        return maxNs
      },
    }
    const clock = createClock(hist)
    maxNs = (LOOP_RESOLUTION_MS + 0.4) * 1e6 // what an idle loop records
    expect(clock.loopLagMs()).toBeCloseTo(0.4, 6)
    maxNs = (LOOP_RESOLUTION_MS + 22) * 1e6
    expect(clock.loopLagMs()).toBeCloseTo(22, 6)
    maxNs = 3e6
    expect(clock.loopLagMs()).toBe(0)
    clock.dispose()
    expect(hist.disable).toHaveBeenCalled()
  })

  it('runs on the real histogram', () => {
    const clock = createClock()
    expect(clock.loopLagMs()).toBeGreaterThanOrEqual(0)
    clock.dispose()
  })
})

describe('BusPortAdapter.onMessage', () => {
  it('hands a late subscriber the sync.state replayed before sync started, unchanged, on the next turn', async () => {
    const host = new FakeRoom(1)
    const viewer = new FakeRoom(2)
    connect(host, viewer) // the link replays nothing yet; the host publishes while the viewer has no handler
    host.publish('sync.state', state(4))
    const calls: [string, unknown][] = []
    new BusPortAdapter(viewer.asRoom(), HOST, vi.fn()).onMessage((from, raw) => calls.push([from, raw]))
    expect(calls).toHaveLength(0)
    await turn()
    // body unchanged: the member dates it by sentAt
    expect(calls).toEqual([[HOST, state(4)]])
  })

  it('replays the newest held state, never an older one, and nothing once unsubscribed', async () => {
    const host = new FakeRoom(1)
    const viewer = new FakeRoom(2)
    connect(host, viewer)
    host.publish('sync.state', state(4))
    const adapter = new BusPortAdapter(viewer.asRoom(), HOST, vi.fn())
    const seqs: number[] = []
    adapter.onMessage((_from, raw) => seqs.push((raw as SyncState).seq))
    host.publish('sync.state', state(5)) // arrives live before the replay fires
    await turn()
    expect(seqs).toEqual([5, 5]) // the member ignores the repeat (same epoch and seq)

    const late: unknown[] = []
    const off = adapter.onMessage((_from, raw) => late.push(raw))
    off()
    await turn()
    expect(late).toEqual([])
  })

  it('on the host: no replay, and its own messages are not echoed (the group loops back itself)', async () => {
    const host = new FakeRoom(1)
    const viewer = new FakeRoom(2)
    connect(host, viewer)
    const adapter = new BusPortAdapter(host.asRoom(), HOST, vi.fn())
    adapter.publish(state(1), { sticky: true })
    const calls: unknown[] = []
    adapter.onMessage((_from, raw) => calls.push(raw))
    adapter.publish(state(2), { sticky: true })
    await turn()
    expect(calls).toEqual([])
    // a viewer's message does arrive
    viewer.publish('sync.hello', { t: 'sync.hello', resume: null }, { to: HOST })
    expect(calls).toEqual([{ t: 'sync.hello', resume: null }])
  })
})

describe('BusPortAdapter.onPresence on a viewer', () => {
  function viewerRoom(): FakeRoom {
    const room = new FakeRoom(2)
    room.memberList = [view(HOST, 'Host'), view(room.self, 'Sam', { self: true, path: 'none' })]
    return room
  }

  it('follows hostPresent: leave when the host goes away even though members still lists it via-peer', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    expect(events).toEqual([]) // present at start: the engine says hello itself

    // the host's link closed; its last traffic keeps it via-peer for a minute, but net's host presence ends
    room.memberList = [view(HOST, 'Host', { linked: false, path: 'via-peer' }), ...room.memberList.slice(1)]
    room.emit('members', room.memberList)
    expect(events).toEqual([])
    room.hostPresent = false
    room.emitState()
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 0 }])

    room.hostPresent = true
    room.emitState()
    room.emitState()
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])
    off()
  })

  it('keeps a via-peer host present while its traffic is recent', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    room.memberList = [view(HOST, 'Host', { linked: false, path: 'via-peer' }), ...room.memberList.slice(1)]
    const host = new FakeRoom(1)
    const neighbour = new FakeRoom(3)
    connect(host, neighbour)
    connect(neighbour, room)
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    room.emit('members', room.memberList)
    room.emitState()
    // its heartbeat reaches us through the neighbour every 5 s
    for (let i = 1; i <= 6; i++) {
      vi.advanceTimersByTime(5000)
      host.publish('room.hb', { at: i })
    }
    expect(events).toEqual([])
    off()
  })

  it('re-checks every 2 s, so a change net did not announce is still reported', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    room.hostPresent = false // no 'state' event
    vi.advanceTimersByTime(1999)
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 2000 }])
    off()
  })

  it('reports an absent host at once, and a host link that reopens while present as a join', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    room.hostPresent = false
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    expect(events.map((e) => e.kind)).toEqual(['leave'])

    // back from away: the link opening reports it; the state that follows adds nothing
    room.emit('peer', { id: HOST })
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])
    room.hostPresent = true
    room.emitState()
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])

    // a quick host restart: the link drops and reopens within net's 10 s grace, hostPresent never flips
    room.emit('peer', { id: HOST })
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join', 'join'])
    room.emit('peer', { id: 'ab'.repeat(32) }) // another viewer's link is not the host's
    expect(events).toHaveLength(3)
    off()
  })

  it("treats the host's bye as gone at once, until its link or its traffic is back", () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    room.emit('bye', { peerId: 'ab'.repeat(32), end: false }) // another viewer leaving
    expect(events).toEqual([])

    // the host quit (the room lives on); net still counts it present for its 10 s traffic window
    vi.advanceTimersByTime(1500) // no word for a while: the bye itself is its last word
    room.emit('bye', { peerId: HOST, end: false })
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 0 }])
    room.emitState()
    vi.advanceTimersByTime(4000)
    expect(events).toHaveLength(1)

    // it came back reachable only through a neighbour: its heartbeat arrives forwarded
    const host = new FakeRoom(1)
    const neighbour = new FakeRoom(3)
    connect(host, neighbour)
    connect(neighbour, room)
    host.publish('room.hb', { at: 1 })
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])

    room.emit('bye', { peerId: HOST, end: false })
    room.emit('peer', { id: HOST }) // or a direct link again
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join', 'leave', 'join'])

    // the host ending the room closes the session instead
    room.emit('bye', { peerId: HOST, end: true })
    expect(events).toHaveLength(4)
    off()
  })

  it('treats the host link closing in the room as gone at once (a crash: no bye), until the host is back', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    room.emit('peer-gone', 'ab'.repeat(32)) // another viewer's link
    expect(events).toEqual([])

    // net keeps hostPresent for its 10 s traffic window; sync's own 10 s grace must start now
    room.emit('peer-gone', HOST)
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 0 }])
    room.emitState()
    vi.advanceTimersByTime(6000) // the 2 s re-checks see hostPresent still true: not a return
    expect(events).toHaveLength(1)
    room.hostPresent = false // then the window runs out
    room.emitState()
    expect(events).toHaveLength(1)

    // traffic straight from the host is a link's, which 'peer' announces; a dying link's last frames are not
    const direct = new FakeRoom(1)
    connect(direct, room)
    direct.publish('room.hb', { at: 1 })
    expect(events).toHaveLength(1)
    // still reachable through a neighbour: its heartbeat arrives forwarded, and is reported before net
    // refreshes hostPresent (its own bus listener runs after the adapter's)
    const host = new FakeRoom(1)
    const neighbour = new FakeRoom(3)
    connect(host, neighbour)
    connect(neighbour, room)
    host.publish('room.hb', { at: 2 })
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])
    room.hostPresent = true

    room.emit('peer-gone', HOST)
    room.emit('peer', { id: HOST }) // a new link (net retires the old one first when a link is replaced)
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join', 'leave', 'join'])
    off()
  })

  it('reports a host gone after 7 s without a word although its link is still up, with how long ago it spoke', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const host = new FakeRoom(1)
    connect(host, room)
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    vi.advanceTimersByTime(5000)
    host.publish('room.hb', { at: 1 }) // its last word, straight over the link
    // a crash: nothing more, while net keeps the link (and hostPresent) until UDX gives up on it ~15 s later
    vi.advanceTimersByTime(HOST_SILENT_MS - 1) // the 2 s re-checks so far saw 1, 3 and 5 s of silence
    expect(events).toEqual([])
    vi.advanceTimersByTime(1)
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: HOST_SILENT_MS }])
    vi.advanceTimersByTime(4000)
    expect(events).toHaveLength(1)
    // it was only slow: its next word, even straight over that link, brings it back
    host.publish('room.hb', { at: 2 })
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])

    // silent again; then a new link opens: that is a word too, so the next re-check does not see 7 s of silence
    vi.advanceTimersByTime(HOST_SILENT_MS + 2000)
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join', 'leave'])
    room.emit('peer', { id: HOST })
    vi.advanceTimersByTime(2000)
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join', 'leave', 'join'])
    off()
  })

  it('any word from the host counts: sync and session messages, forwarded ones, sync datagrams', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const host = new FakeRoom(1)
    connect(host, room)
    const other = new FakeRoom(3)
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    // 6 s apart: each word alone keeps the host present
    vi.advanceTimersByTime(6000)
    host.publish('sync.state', state(1))
    vi.advanceTimersByTime(6000)
    room.datagram(HOST)
    vi.advanceTimersByTime(6000)
    host.publish('session.preparing', { stage: 'hashing', pct: 0.5 })
    vi.advanceTimersByTime(6000)
    connect(other, room)
    connect(host, other)
    host.publish('room.hb', { at: 1 }) // direct, and forwarded by the neighbour too
    expect(events).toEqual([])
    // words that are not the host's: another member's datagram and heartbeat, and our own message
    vi.advanceTimersByTime(4000)
    room.datagram(other.self)
    other.publish('room.hb', { at: 2 })
    room.publish('room.hb', { at: 3 })
    vi.advanceTimersByTime(4000) // re-check at 32 s: 8 s since the host's heartbeat
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 8000 }])
    room.datagram(HOST)
    expect(events.map((e) => e.kind)).toEqual(['leave', 'join'])
    off()
  })

  it("a link that closes reports how long the host had been silent; a bye is the host's last word", () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const host = new FakeRoom(1)
    connect(host, room)
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    host.publish('room.hb', { at: 1 })
    vi.advanceTimersByTime(4500)
    room.emit('peer-gone', HOST)
    expect(events).toEqual([{ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 4500 }])
    room.emit('peer', { id: HOST })
    vi.advanceTimersByTime(3000)
    room.emit('bye', { peerId: HOST, end: false })
    expect(events.map((e) => [e.kind, e.sinceMs])).toEqual([
      ['leave', 4500],
      ['join', undefined],
      ['leave', 0],
    ])
    off()
  })

  it('ignores the host link closing once the room is closing (our leave, a kick, an ended room)', () => {
    const room = viewerRoom()
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    for (const phase of ['closed', 'kicked', 'ended'] as const) {
      room.phase = phase
      room.emit('peer-gone', HOST)
    }
    expect(events).toEqual([])
    off()
  })

  it('unsubscribing removes every listener and the re-check timer', () => {
    vi.useFakeTimers()
    const room = viewerRoom()
    const events: PresenceEvent[] = []
    const before = vi.getTimerCount()
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    expect(vi.getTimerCount()).toBe(before + 1)
    room.emit('bye', { peerId: HOST, end: false }) // now the host's traffic would bring it back
    expect(events.map((e) => e.kind)).toEqual(['leave'])
    off()
    expect(vi.getTimerCount()).toBe(before)
    const names = ['state', 'members', 'peer', 'peer-gone', 'bye'] as const
    expect(names.map((n) => room.listenerCount(n))).toEqual([0, 0, 0, 0, 0])
    expect(room.datagramHandlers.size).toBe(0)
    room.datagram(HOST)
    room.emit('peer', { id: HOST })
    room.emit('peer-gone', HOST)
    room.hostPresent = false
    room.emitState()
    vi.advanceTimersByTime(10_000)
    const host = new FakeRoom(1)
    const neighbour = new FakeRoom(3)
    connect(host, neighbour)
    connect(neighbour, room)
    host.publish('room.hb', { at: 1 })
    expect(events.map((e) => e.kind)).toEqual(['leave'])
  })
})

describe('BusPortAdapter.onPresence on the host', () => {
  it('reports linked and via-peer members, never itself, and a via-peer member going stale on the re-check', () => {
    vi.useFakeTimers()
    const room = new FakeRoom(1)
    const [a, b, c] = ['aa', 'bb', 'cc'].map((x) => x.repeat(32)) as [string, string, string]
    room.memberList = [
      view(HOST, 'Host', { self: true, path: 'none' }),
      view(a, 'Ann'),
      view(b, 'Bob', { linked: false, path: 'via-peer' }),
      view(c, 'Cid', { linked: false, path: 'none' }),
    ]
    const events: PresenceEvent[] = []
    const off = new BusPortAdapter(room.asRoom(), HOST, vi.fn()).onPresence((e) => events.push(e))
    expect(events).toEqual([
      { kind: 'join', peerId: a, name: 'Ann' },
      { kind: 'join', peerId: b, name: 'Bob' },
    ])
    room.hostPresent = false // meaningless on the host
    room.emitState()

    // Bob crashed: no link, and his last traffic ages past net's stale window without any members event
    room.memberList = room.memberList.map((m) => (m.id === b ? { ...m, path: 'none' } : m))
    vi.advanceTimersByTime(2000)
    expect(events.slice(2)).toEqual([{ kind: 'leave', peerId: b, name: 'Bob' }])

    room.memberList = room.memberList.filter((m) => m.id !== a)
    room.emit('members', room.memberList)
    expect(events.slice(3)).toEqual([{ kind: 'leave', peerId: a, name: 'Ann' }])
    off()
  })
})

// ---- the player adapter, with the real member on top ----------------------------------------------------

class ScriptedPlayer extends EventEmitter<PlayerLikeEvents> {
  status: PlayerStatus
  readonly loads: { url: string; status: PlayerStatus }[] = []
  /** the next load finds the IPC gone: the status changes without an event yet and the load rejects */
  dropIpcOnLoad = false
  /** the next load rejects with this, mpv staying up and idle */
  rejectNextLoad: Error | null = null
  /** the next load stays in flight until `held` settles it */
  holdNextLoad = false
  held: ((e: Error) => void) | null = null
  /** what get_property time-pos answers */
  timePos: number | null = null
  /** the observed container-fps */
  containerFps: number | null = null
  /** commands as the adapter sent them */
  readonly calls: string[] = []
  /** the next seek throws this, as PlayerController.seek does when the IPC closed (requireIpc) */
  seekThrows: Error | null = null
  /** the next seek rejects with this */
  seekRejects: Error | null = null

  constructor(status: PlayerStatus) {
    super()
    this.status = status
  }

  setStatus(next: PlayerStatus): void {
    const prev = this.status
    this.status = next
    this.emit('state', next, prev)
  }

  load(url: string): Promise<void> {
    this.loads.push({ url, status: this.status })
    const reject = this.rejectNextLoad
    this.rejectNextLoad = null
    if (reject) return Promise.reject(reject)
    if (this.holdNextLoad) {
      this.holdNextLoad = false
      return new Promise((_, rej) => (this.held = rej))
    }
    if (this.dropIpcOnLoad) {
      this.dropIpcOnLoad = false
      this.status = 'crashed'
    }
    const running = this.status === 'idle' || this.status === 'loading' || this.status === 'ready'
    return running ? Promise.resolve() : Promise.reject(new Error('the player is not running'))
  }
  seek(pos: number): Promise<void> {
    this.calls.push(`seek ${String(pos)}`)
    const thrown = this.seekThrows
    const rejected = this.seekRejects
    this.seekThrows = this.seekRejects = null
    if (thrown) throw thrown
    return rejected ? Promise.reject(rejected) : Promise.resolve()
  }
  setPaused(paused: boolean): Promise<void> {
    this.calls.push(`pause ${String(paused)}`)
    return Promise.resolve()
  }
  getProperty(name: string): Promise<{ value: unknown; tSend: number; tRecv: number }> {
    return Promise.resolve({ value: name === 'time-pos' ? this.timePos : null, tSend: 0, tRecv: 0 })
  }
  setSpeed(): Promise<void> {
    return Promise.resolve()
  }
  sample(): Promise<{ value: number | null; tSend: number; tRecv: number; prop: 'time-pos' }> {
    return Promise.resolve({ value: null, tSend: 0, tRecv: 0, prop: 'time-pos' })
  }
  prop(name: string): unknown {
    if (name === 'container-fps') return this.containerFps
    return name === 'pause' ? true : null
  }
  frameDrops(): { vo: number; decoder: number } {
    return { vo: 0, decoder: 0 }
  }
}

/** Timers never fire: these tests drive the member through player events only. */
const stillClock: Clock = {
  now: () => 0,
  setTimer: () => ({ cancel: () => undefined }),
  immediate: () => ({ cancel: () => undefined }),
  loopLagMs: () => 0,
}

/** Timers fire only when told to, each pending one once; cancelled ones never. */
function manualClock(): { clock: Clock; fire: () => void } {
  let pending: { fn: () => void; live: boolean }[] = []
  return {
    clock: {
      ...stillClock,
      setTimer: (_ms, fn) => {
        const t = { fn, live: true }
        pending.push(t)
        return { cancel: () => (t.live = false) }
      },
    },
    fire: () => {
      const due = pending
      pending = []
      for (const t of due) if (t.live) t.fn()
    },
  }
}

function memberOn(
  player: ScriptedPlayer,
  clock: Clock = stillClock,
): { member: MemberController; log: ReturnType<typeof vi.fn> } {
  const log = vi.fn()
  const adapter = new PlayerPortAdapter(player as unknown as PlayerLike, { subtitles: () => [], title: null, log })
  const member = new MemberController({
    clock,
    player: adapter,
    media: {
      durationS: () => 600,
      readiness: () => true,
      bufferedAheadS: () => 600,
      needBps: () => 0,
      playhead: { set: () => undefined },
      onChange: () => () => undefined,
    },
    transfer: { rateBps: () => 0, etaToEofS: () => 0, coverage: () => null, diskFull: () => false },
    offset: () => 0,
    clockErrMs: () => 0,
    nudge: false,
  })
  member.start()
  return { member, log }
}

describe('PlayerPortAdapter', () => {
  it('is available only once mpv is up with its IPC connected', () => {
    const player = new ScriptedPlayer('absent')
    const adapter = new PlayerPortAdapter(player as unknown as PlayerLike, {
      subtitles: () => [],
      title: null,
      log: vi.fn(),
    })
    const available = (s: PlayerStatus): boolean => {
      player.status = s
      return adapter.snapshot().available
    }
    const down: PlayerStatus[] = ['absent', 'spawning', 'connecting', 'closedByUser', 'crashed', 'missing', 'tooOld']
    expect(down.map(available)).toEqual(down.map(() => false))
    const up: PlayerStatus[] = ['idle', 'loading', 'ready']
    expect(up.map(available)).toEqual([true, true, true])
  })

  it("the member's first load waits for mpv's IPC instead of being lost while it spawns", async () => {
    const player = new ScriptedPlayer('spawning')
    const { member } = memberOn(player)
    member.applyState(state(1))
    member.setSource('http://127.0.0.1:1/0')
    await turn()
    expect(member.currentPhase).toBe('no-player')
    player.setStatus('connecting')
    await turn()
    expect(player.loads).toEqual([])
    player.setStatus('idle')
    expect(player.loads).toEqual([{ url: 'http://127.0.0.1:1/0', status: 'idle' }])
    expect(member.currentPhase).toBe('loading')
    member.stop()
  })

  it("a load another client's file replaced is loaded again at once, not after that file's playback-restart", async () => {
    const player = new ScriptedPlayer('idle')
    const { member } = memberOn(player)
    member.applyState(state(1))
    // what the controller does when another file comes in while ours opens: idle, our load superseded
    player.rejectNextLoad = new CodedError(PLAYER_ERRORS.superseded, 'another file replaced ours')
    member.setSource('http://127.0.0.1:1/0')
    await turn()
    expect(player.loads.map((l) => l.url)).toEqual(['http://127.0.0.1:1/0', 'http://127.0.0.1:1/0'])
    expect(member.currentPhase).toBe('loading')
    member.stop()
  })

  it("the other file's playback-restart, after our next load went out, does not complete that load", async () => {
    const player = new ScriptedPlayer('idle')
    const { member } = memberOn(player)
    member.applyState(state(1))
    player.holdNextLoad = true
    member.setSource('http://127.0.0.1:1/0')
    // another client's file (or its stop) while ours opens: the controller goes idle, our load is superseded
    player.holdNextLoad = true
    player.setStatus('idle')
    player.held?.(new CodedError(PLAYER_ERRORS.superseded, 'another file replaced ours'))
    await turn()
    expect(player.loads).toHaveLength(2)
    // that file's own restart reaches us now: the controller passes every restart on, still 'loading' for ours
    player.setStatus('loading')
    player.emit('playbackRestart', { pos: 3 })
    await turn()
    expect(player.loads).toHaveLength(2)
    expect(member.currentPhase).toBe('loading')
    // ours completes: 'ready' first, then its restart, and the read of where it landed
    player.setStatus('ready')
    player.emit('playbackRestart', { pos: 12 })
    await turn()
    expect(member.currentPhase).toBe('paused')
    expect(player.loads).toHaveLength(2)
    member.stop()
  })

  it('a load mpv could not open is tried again after a pause, not at once (a file it cannot open must not loop)', async () => {
    const player = new ScriptedPlayer('idle')
    const timers = manualClock()
    const { member, log } = memberOn(player, timers.clock)
    member.applyState(state(1))
    const unopenable = (): CodedError => new CodedError(PLAYER_ERRORS.loadFailed, 'mpv could not open the file')
    player.rejectNextLoad = unopenable()
    member.setSource('http://127.0.0.1:1/0')
    await turn()
    expect(log).toHaveBeenCalledWith('player load failed', expect.any(CodedError))
    // not at once, and a state event does not get past the pause
    player.setStatus('idle')
    expect(player.loads).toHaveLength(1)
    expect(member.currentPhase).toBe('loading')
    player.rejectNextLoad = unopenable()
    timers.fire()
    expect(player.loads).toHaveLength(2)
    await turn()
    // a new source (or the same one for a new player) is tried at once
    player.rejectNextLoad = unopenable()
    member.setSource('http://127.0.0.1:1/0')
    expect(player.loads).toHaveLength(3)
    await turn()
    // stopped (the session left) with a try pending: it never comes
    member.stop()
    timers.fire()
    timers.fire()
    expect(player.loads).toHaveLength(3)
  })

  it('the failure of a load our own later load replaced is no news: that later load is still awaited', async () => {
    const player = new ScriptedPlayer('idle')
    const { member } = memberOn(player)
    member.applyState(state(1))
    player.holdNextLoad = true
    member.setSource('http://127.0.0.1:1/0')
    // mpv goes away and is back before that load settles: the member loads again
    player.setStatus('crashed')
    player.setStatus('idle')
    expect(player.loads).toHaveLength(2)
    // the first one fails only now, replaced by the second (as mpv's controller rejects a load a newer one
    // replaced): reported, it would end the second one's wait, whose load would replace it in turn, and so on
    player.held?.(new CodedError(PLAYER_ERRORS.superseded, 'a newer load replaced this one'))
    await turn()
    await turn()
    expect(player.loads).toHaveLength(2)
    expect(member.currentPhase).toBe('loading')
    member.stop()
  })

  it("reports the file's frame length from container-fps, 1/24 s without one", () => {
    const player = new ScriptedPlayer('ready')
    const adapter = new PlayerPortAdapter(player as unknown as PlayerLike, {
      subtitles: () => [],
      title: null,
      log: vi.fn(),
    })
    const frameS = (fps: number | null): number => {
      player.containerFps = fps
      return adapter.snapshot().frameS
    }
    expect(frameS(12)).toBeCloseTo(1 / 12, 9)
    expect(frameS(59.94)).toBeCloseTo(1 / 59.94, 9)
    expect(frameS(0.25)).toBe(1) // a slideshow: at most a second
    for (const none of [null, 0, -1, Number.NaN, 90_000]) expect(frameS(none)).toBeCloseTo(1 / 24, 9)
    expect(frameSeconds('24')).toBeCloseTo(1 / 24, 9)
  })

  it('a 12 fps load that lands most of a frame past its target is ours: no extra seek', async () => {
    const player = new ScriptedPlayer('idle')
    player.containerFps = 12
    const { member } = memberOn(player)
    member.applyState(state(1, { anchor: { pos: 42.013, hostTime: 1000, rate: 1 } }))
    member.setSource('http://127.0.0.1:1/0')
    expect(player.loads).toHaveLength(1)
    // mpv lands on the first frame at or after target − 5 ms: 42.083, 70 ms past (more than 1/24 s)
    player.timePos = 42 + 1 / 12
    player.setStatus('ready')
    player.emit('playbackRestart', { pos: player.timePos })
    await turn()
    await turn()
    expect(member.currentPhase).toBe('paused')
    expect(player.calls.filter((c) => c.startsWith('seek'))).toEqual([])
    expect(player.loads).toHaveLength(1)
    member.stop()
  })

  it('a load that fails because the IPC dropped re-sends the state, so the member retries once mpv is back', async () => {
    const player = new ScriptedPlayer('idle')
    const { member, log } = memberOn(player)
    player.dropIpcOnLoad = true
    member.applyState(state(1))
    member.setSource('http://127.0.0.1:1/0')
    expect(player.loads).toHaveLength(1)
    await turn()
    expect(log).toHaveBeenCalledWith('player load failed', expect.any(Error))
    expect(member.currentPhase).toBe('no-player')
    player.setStatus('idle')
    expect(player.loads.map((l) => l.status)).toEqual(['idle', 'idle'])
    member.stop()
  })
})

describe('PlayerPortAdapter commands', () => {
  const adapterOn = (player: ScriptedPlayer): { adapter: PlayerPortAdapter; log: ReturnType<typeof vi.fn> } => {
    const log = vi.fn()
    return {
      adapter: new PlayerPortAdapter(player as unknown as PlayerLike, { subtitles: () => [], title: null, log }),
      log,
    }
  }

  it('a seek that throws (the IPC closed) is logged, never thrown into the member, and sent in order at once', async () => {
    const player = new ScriptedPlayer('ready')
    const { adapter, log } = adapterOn(player)
    const err = new CodedError(PLAYER_ERRORS.notRunning, 'the player is not running')
    player.seekThrows = err
    // the member's timer: an uncaught throw here is core's 'fatal'
    expect(() => {
      adapter.setPaused(true)
      adapter.seek(5)
    }).not.toThrow()
    expect(player.calls).toEqual(['pause true', 'seek 5'])
    await turn()
    expect(log).toHaveBeenCalledWith('player seek failed', err)
    // and one that rejects
    player.seekRejects = err
    adapter.seek(6)
    await turn()
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('a read that throws or has no number answers null', async () => {
    const player = new ScriptedPlayer('ready')
    const { adapter } = adapterOn(player)
    const got: (number | null)[] = []
    player.timePos = 12.5
    adapter.readTimePos((p) => got.push(p))
    player.timePos = null
    adapter.readTimePos((p) => got.push(p))
    player.getProperty = () => {
      throw new CodedError(PLAYER_ERRORS.notRunning, 'the player is not running')
    }
    expect(() => adapter.readTimePos((p) => got.push(p))).not.toThrow()
    await turn()
    expect(got).toEqual([12.5, null, null])
  })
})

describe('toggleKind (OSC Space)', () => {
  it('pauses a room that plays or waits to resume playing, plays otherwise', () => {
    const wait = (resumeAs: 'playing' | 'paused'): SyncState =>
      state(2, {
        mode: 'waiting',
        wait: { reason: 'buffering', aheadS: 1, waitingFor: ['x'], softDeadline: null, resumeAs },
      })
    expect(toggleKind(state(1, { mode: 'playing' }))).toBe('pause')
    expect(toggleKind(wait('playing'))).toBe('pause')
    expect(toggleKind(wait('paused'))).toBe('play')
    expect(toggleKind(state(1, { mode: 'paused' }))).toBe('play')
    expect(toggleKind(state(1, { mode: 'ended' }))).toBe('play')
    expect(toggleKind(null)).toBe('play')
    expect(toggleKind(undefined)).toBe('play')
  })
})
