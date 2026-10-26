import { EventEmitter } from 'node:events'
import type { Torrent, Wire } from 'webtorrent'
import { describe, expect, it } from 'vitest'
import { Revealer, packBits } from './revealer.js'
import type { PlayheadPlan } from './scheduler.js'

// The Revealer against fake host wires: what each viewer is told it can fetch from the host, and when.

const P = 1024 * 1024
const N = 64
const MB = 1_000_000

/** A host-side wire to one viewer: records what the host advertises on it. */
class FakeWire extends EventEmitter {
  destroyed = false
  readonly held = new Set<number>()
  readonly peerPieces = { get: (i: number): boolean => this.held.has(i) }
  up = 0
  readonly haves: number[] = []
  readonly bitfields: Uint8Array[] = []
  readonly donthaves: number[] = []
  /** the viewer's requests waiting for the host: held by the upload scheduler, and answered */
  heldRequests: { piece: number; offset: number; length: number }[] = []
  peerRequests: { piece: number; offset: number; length: number }[] = []
  /** BEP 10, as bittorrent-protocol 5.0.9 keeps it: {} until the viewer's extended handshake arrives */
  peerExtendedHandshake: { m?: Record<string, number> } = {}
  peerExtendedMapping: Record<string, number> = {}
  /** lt_donthave's own flag: set by a handshake that listed it, never cleared */
  private peerSupports = false
  /** a donthave after this many throws (a wire that fails under us) */
  failDonthaveAfter = Number.POSITIVE_INFINITY
  donthaveCalls = 0
  readonly lt_donthave = {
    // lt_donthave 2.0.x: silent until a handshake listed it; then wire.extended('lt_donthave', ...) needs a
    // non-zero id in the latest handshake. Upstream bittorrent-protocol throws without one, our patch drops the
    // message: either way the viewer is not told. The throw is the stricter case, so the fake keeps it.
    donthave: (i: number): void => {
      this.donthaveCalls++
      if (!this.peerSupports) return
      if (!this.peerExtendedMapping.lt_donthave) throw new Error('Unrecognized extension: lt_donthave')
      if (this.donthaves.length >= this.failDonthaveAfter) throw new Error('write after end')
      this.donthaves.push(i)
      this.log.push(['donthave', i])
    },
  }
  /** `handshake`: the viewer's BEP 10 extension ids, already in (the default), or null while still on the way */
  constructor(handshake: Record<string, number> | null) {
    super()
    if (handshake) this.extendedHandshake(handshake)
  }
  /** The viewer's extended handshake arriving (bittorrent-protocol _onExtended); a later one updates the ids. */
  extendedHandshake(m: Record<string, number>): void {
    this.peerExtendedHandshake = { m }
    for (const [name, id] of Object.entries(m)) this.peerExtendedMapping[name] = id
    if (this.peerExtendedMapping.lt_donthave) this.peerSupports = true
  }
  uploadSpeed(): number {
    return this.up
  }
  have(i: number): void {
    this.haves.push(i)
    this.log.push(['have', i])
  }
  bitfield(b: Uint8Array): void {
    this.bitfields.push(b)
  }
  haveAll(): void {
    throw new Error('WebTorrent would send have-all: the Revealer must override it')
  }
  haveNone(): void {
    throw new Error('WebTorrent would send have-none: the Revealer must override it')
  }
  /** what the viewer believes the host has: the first bitfield, plus haves, minus donthaves, in order */
  shown(): number[] {
    const out = new Set<number>()
    const b = this.bitfields[0]
    for (let i = 0; b && i < N; i++) if (((b[i >> 3] ?? 0) & (128 >> (i & 7))) !== 0) out.add(i)
    for (const [kind, i] of this.log) {
      if (kind === 'have') out.add(i)
      else out.delete(i)
    }
    return [...out].sort((x, y) => x - y)
  }
  readonly log: ['have' | 'donthave', number][] = []
}

function setup(
  opts: { limitBps?: number | null; pacedBps?: number | null; upBps?: number; clock?: { t: number } } = {},
) {
  const t = Object.assign(new EventEmitter(), { pieces: new Array<null>(N).fill(null), pieceLength: P })
  const members = new Map<FakeWire, string>()
  const clock = opts.clock ?? { t: 0 }
  const r = new Revealer(t as unknown as Torrent, {
    memberOf: (wire) => members.get(wire as unknown as FakeWire) ?? null,
    uploadLimitBps: () => (opts.limitBps === undefined ? 5 * MB : opts.limitBps),
    pacedBps: () => opts.pacedBps ?? null,
    uploadBps: () => opts.upBps ?? 0,
    now: () => clock.t,
  })
  /**
   * A viewer's wire completing its handshake; WebTorrent then sends the host's advertisement. Its BEP 10
   * handshake comes an RTT later on a real link: `handshake` null leaves it on the way.
   */
  const connect = (
    id: string,
    advertise: 'haveAll' | 'haveNone' | 'bitfield' = 'haveAll',
    handshake: Record<string, number> | null = { lt_donthave: 3 },
  ): FakeWire => {
    const wire = new FakeWire(handshake)
    members.set(wire, id)
    t.emit('wire', wire)
    if (advertise === 'bitfield')
      wire.bitfield(new Uint8Array(N / 8).fill(255)) // the Revealer's override by now
    else wire[advertise]()
    return wire
  }
  const link = (...ids: string[]): void => {
    for (const id of ids)
      r.setLinks(
        id,
        ids.filter((x) => x !== id),
      )
  }
  return { r, connect, link, clock }
}

const plan = (piece: number, o: { seek?: boolean; windowPieces?: number; hotPieces?: number } = {}): PlayheadPlan => ({
  byte: piece * P,
  windowBytes: (o.windowPieces ?? 20) * P,
  hotBytes: (o.hotPieces ?? 2) * P,
  seek: o.seek ?? true,
})
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, k) => a + k)
/** a take-back at plan(10) with piece 0 critical: plan order is 10..63 (hot, L1, L2), then 1..9 (L3); backwards */
const backwards10 = [...range(1, 9).reverse(), ...range(10, N - 1).reverse()]
/** the pieces the Revealer counts as assigned to viewer `id` (its budget R), ascending */
const exclusiveOf = (r: Revealer, id: string): number[] =>
  [...((r as unknown as { views: Map<string, { exclusive: Set<number> }> }).views.get(id)?.exclusive ?? [])].sort(
    (x, y) => x - y,
  )

describe('Revealer hook', () => {
  it('advertises only the revealed pieces in the first message, whichever one WebTorrent sends', () => {
    const { r, connect } = setup()
    r.setCriticalRanges([
      [0, 2 * P - 100],
      [(N - 1) * P, N * P],
    ])
    for (const how of ['haveAll', 'haveNone', 'bitfield'] as const) {
      const wire = connect(`v-${how}`, how)
      expect(wire.bitfields).toHaveLength(1)
      expect(wire.shown()).toEqual([0, 1, N - 1])
      expect(wire.haves).toEqual([])
    }
    expect(packBits(Uint8Array.from([1, 0, 0, 0, 0, 0, 0, 1, 1]))).toEqual(Uint8Array.from([0x81, 0x80]))
  })

  it('reveals critical ranges set later to every viewer at once', () => {
    const { r, connect } = setup()
    const a = connect('a')
    const b = connect('b')
    r.setCriticalRanges([[5 * P + 10, 6 * P + 1]])
    expect([a.haves, b.haves]).toEqual([
      [5, 6],
      [5, 6],
    ])
  })
})

describe('Revealer striping', () => {
  it('gives each piece to one fully linked viewer, at most R each, in plan order, then stops', () => {
    const { r, connect, link } = setup() // 5 MB/s, 2 viewers: R = ceil(1.5 s x 5 MB/s x 1/2 / 1 MiB) = 4
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    r.setPlan(plan(10))
    r.tick()
    expect(a.haves).toEqual([10, 12, 14, 16]) // lowest (exclusive + 1) / rate first: they alternate
    expect(b.haves).toEqual([11, 13, 15, 17])
    r.tick()
    expect(a.haves.length + b.haves.length).toBe(8) // both at R: nothing past 17, the walk stopped
    b.held.add(11) // b fetched one: its budget frees up, and 11 spreads to a by itself
    r.tick()
    expect(b.haves).toEqual([11, 13, 15, 17, 18]) // the next piece in plan order, not a later one
    expect(a.haves).toEqual([10, 12, 14, 16]) // never re-sent by the host: a gets 11 from b
  })

  it('reveals nothing past the first piece where every eligible viewer is full, not even a held piece', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock }) // 3 viewers: R = 3 each
    const a = connect('a')
    const b = connect('b')
    const c = connect('c')
    link('a', 'b') // c has no lane: it gets held pieces from the host
    a.held.add(30) // far ahead of the frontier
    r.setPlan(plan(10))
    clock.t = 2000 // c reported no lane in 2 s: it is taken for isolated
    r.tick()
    expect([...a.haves, ...b.haves].sort((x, y) => x - y)).toEqual(range(10, 15))
    expect(c.haves).toEqual([]) // 30 is past the frontier (16): it waits its turn in plan order
  })

  it('sizes R by the host upload and each viewer’s share of it, never below 2', () => {
    const { r, connect, link } = setup({ limitBps: 20 * MB })
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    a.up = 3 * MB // a takes 3/4 of the host's upload
    b.up = 1 * MB
    r.setPlan(plan(0, { windowPieces: 60 }))
    r.tick()
    expect(a.haves).toHaveLength(Math.ceil((1.5 * 20 * MB * 0.75) / P)) // 22
    expect(b.haves).toHaveLength(Math.ceil((1.5 * 20 * MB * 0.25) / P)) // 8
    // lowest (exclusive + 1) / rate first: at 3:1 the faster one is given the first three
    expect([a.haves.slice(0, 3), b.haves[0]]).toEqual([[0, 1, 2], 3])

    const slow = setup({ limitBps: null }) // no limit, nothing measured yet: 1 MB/s assumed; R floors at 2
    const views = ['a', 'b', 'c', 'd'].map((id) => slow.connect(id))
    slow.link('a', 'b', 'c', 'd')
    slow.r.setPlan(plan(0))
    slow.r.tick()
    for (const w of views) expect(w.haves).toHaveLength(2)
  })

  it('shows everything while there is nothing to stripe: no room playhead yet, or a single viewer', () => {
    const { r, connect, link } = setup()
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    r.tick() // two viewers, but the room's playhead is not known: plain seeding
    expect([a.shown(), b.shown()]).toEqual([range(0, N - 1), range(0, N - 1)])
    const lone = setup()
    const c = lone.connect('c')
    lone.r.setPlan(plan(30))
    lone.r.tick()
    expect(c.shown()).toEqual(range(0, N - 1)) // a single viewer gets everything
    lone.r.tick()
    expect(c.haves).toHaveLength(N) // once
  })

  it('takes back what a lone viewer neither holds nor fetches once a second one joins, then stripes', () => {
    const { r, connect, link } = setup()
    r.setCriticalRanges([[0, P]])
    const a = connect('a')
    r.setPlan(plan(10))
    r.tick()
    expect(a.shown()).toEqual(range(0, N - 1))
    for (let i = 10; i <= 13; i++) a.held.add(i)
    a.peerRequests = [{ piece: 14, offset: 0, length: 16384 }] // being fetched from the host right now
    const b = connect('b')
    link('a', 'b')
    r.tick()
    // a keeps what it holds, what it is fetching, and the critical piece; the rest went back to the walk...
    expect(a.donthaves).toHaveLength(N - 6)
    expect(a.donthaves).not.toContain(14)
    // from the plan's end: what a would refill its pipeline with next (15, 16, ...) goes last (ADR 0008 §4.1)
    expect(a.donthaves).toEqual([...range(1, 9).reverse(), ...range(15, N - 1).reverse()])
    // ...which stripes it from there: a's 14 already counts against its R of 4
    expect(b.shown()).toEqual([0, 15, 17, 19, 21])
    expect(a.shown()).toEqual([0, 10, 11, 12, 13, 14, 16, 18, 20])
  })

  it('refuses a request for a piece it does not advertise to that wire (onArrival, before it is held)', () => {
    const { r, connect, link } = setup()
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const a = connect('a')
    r.tick() // alone: shown everything, so it may ask for anything
    expect(r.onArrival(a as unknown as Wire, 40)).toBe(true)
    connect('b')
    link('a', 'b')
    r.tick() // taken back: 40 is no longer a's
    expect(a.shown()).not.toContain(40)
    // a request that crossed the donthave, a hostile one, one out of range: refused before WebTorrent sees it
    const arrive = (i: number): boolean => r.onArrival(a as unknown as Wire, i)
    expect([40, 41, N, -1].map(arrive)).toEqual([false, false, false, false])
    expect(arrive(0)).toBe(true) // critical: still advertised
    expect(arrive(10)).toBe(true) // given to a by the walk
  })

  it('keeps a piece the viewer has a held request for when it takes back (it is fetching it)', () => {
    const { r, connect, link } = setup()
    r.setPlan(plan(10))
    const a = connect('a')
    r.tick() // alone: shown everything
    a.heldRequests.push({ piece: 40, offset: 0, length: 16384 }) // held by the upload scheduler, not answered yet
    connect('b')
    link('a', 'b')
    r.tick()
    expect(a.shown()).toContain(40)
    expect(a.shown()).not.toContain(41)
  })

  it('classes pieces for the upload scheduler: blocked readers, then the hot window and critical ranges', () => {
    const { r, connect } = setup()
    connect('a')
    connect('b')
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10, { hotPieces: 2 })) // hot window [10, 12)
    r.setUrgent('a', [30, 31])
    r.setUrgent('b', [31])
    expect([30, 31, 0, 10, 11, 12, 20].map((i) => r.classOf(i))).toEqual([0, 0, 1, 1, 1, 2, 2])
    r.setUrgent('a', [])
    expect([30, 31].map((i) => r.classOf(i))).toEqual([2, 0]) // b still waits on 31
    r.removeViewer('b')
    expect(r.classOf(31)).toBe(2)
  })

  it('hands everything to the one left when the other leaves, and keeps it from a peer without lt_donthave', () => {
    const { r, connect, link } = setup()
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    r.setPlan(plan(10))
    r.tick()
    b.emit('close')
    r.tick()
    expect(a.shown()).toEqual(range(0, N - 1))
    connect('old', 'haveAll', {}) // an old client: its handshake lists no lt_donthave
    r.tick() // a and old: striping
    expect(a.donthaves.length).toBeGreaterThan(0)
    const lone = setup()
    const x = lone.connect('x', 'haveAll', {})
    lone.r.setPlan(plan(0))
    lone.r.tick()
    lone.connect('y')
    lone.r.tick()
    expect(x.donthaves).toEqual([])
    expect(x.shown()).toEqual(range(0, N - 1))
  })

  it('keeps a viewer open until its BEP 10 handshake arrives (an RTT after its wire), then takes back and stripes', () => {
    const { r, connect, link } = setup()
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const a = connect('a', 'haveAll', null) // a slow link: its extended handshake is still on the way
    r.tick() // a alone: shown everything
    expect(a.shown()).toEqual(range(0, N - 1))
    const b = connect('b')
    link('a', 'b')
    r.tick() // striping, but a cannot be told anything yet: it stays open, so nothing is striped this tick
    expect([a.donthaves, b.haves]).toEqual([[], []])
    a.extendedHandshake({ lt_donthave: 3 })
    r.tick()
    expect(a.donthaves).toEqual(backwards10) // all but the critical piece, the plan's end first
    expect(a.shown()).toEqual([0, 10, 12, 14, 16])
    expect(b.shown()).toEqual([0, 11, 13, 15, 17])
  })

  it('never tells a viewer whose latest handshake disabled lt_donthave (id 0), which would throw', () => {
    const { r, connect, link } = setup()
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const a = connect('a')
    r.tick() // alone: shown everything
    a.extendedHandshake({ lt_donthave: 0 }) // BEP 10 lets a later handshake disable an extension
    connect('b')
    link('a', 'b')
    expect(() => r.tick()).not.toThrow()
    expect(a.donthaves).toEqual([])
    expect(a.shown()).toEqual(range(0, N - 1)) // it keeps everything, as an old client does
    a.extendedHandshake({ lt_donthave: 5 }) // enabled again: now it can be told
    r.tick()
    expect(a.donthaves).toEqual(backwards10)
  })

  it('assigns a viewer nothing while it is open, so its budget is free once it is taken back', () => {
    const clock = { t: 0 }
    const { r, connect } = setup({ clock }) // no lane reported: each viewer is fed from the host, within R = 4
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const a = connect('a', 'haveAll', null) // its BEP 10 handshake is still on the way: it stays open
    r.tick() // a alone: shown everything
    const b = connect('b')
    clock.t = 2000 // neither reported a lane in 2 s: both are taken for isolated
    for (let i = 40; i <= 49; i++) b.held.add(i) // b resumed a download; a has no lane to it
    r.tick() // striping, but a cannot be told yet: still open, and shown b's pieces already
    expect(exclusiveOf(r, 'a')).toEqual([]) // shown is not assigned: nothing counts against a's R
    a.extendedHandshake({ lt_donthave: 3 })
    r.tick() // a is taken back, and the walk feeds both from 10 on
    for (let k = 0; k < 5; k++) r.tick()
    // a's R holds only what it was really given: it gets its share like b, not just the critical piece
    expect(a.shown()).toEqual([0, 10, 11, 12, 13])
    expect(b.shown()).toEqual([0, 10, 11, 12, 13])
    expect(exclusiveOf(r, 'a')).toEqual([10, 11, 12, 13])
  })

  it('stops telling a viewer whose donthave fails, leaves it the rest, and the tick goes on', () => {
    const { r, connect, link } = setup()
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const a = connect('a')
    r.tick() // alone: shown everything
    a.failDonthaveAfter = 5 // its wire fails under us after 5 donthaves
    const b = connect('b')
    link('a', 'b')
    expect(() => r.tick()).not.toThrow()
    expect([a.donthaves, a.donthaveCalls]).toEqual([[9, 8, 7, 6, 5], 6]) // nothing more after the failure
    expect(a.shown()).toEqual(expect.arrayContaining([...range(1, 4), ...range(10, N - 1)])) // never told: still a's
    expect(b.haves.length).toBeGreaterThan(0) // the walk went on after the failure
    a.failDonthaveAfter = Number.POSITIVE_INFINITY
    r.tick()
    expect(a.donthaves).toHaveLength(5) // not asked again
  })

  it('lets a held piece spread; only a viewer with no lane to any holder gets it from the host', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock })
    const a = connect('a')
    const b = connect('b')
    const c = connect('c')
    link('a', 'b') // c has no lane to either
    for (let i = 0; i <= 4; i++) a.held.add(i) // a has the first pieces (say, a resume)
    r.setPlan(plan(0))
    clock.t = 2000 // c reported no lane in 2 s: it is taken for isolated
    r.tick()
    expect(b.haves.filter((i) => i <= 4)).toEqual([]) // b fetches them from a
    // c can only get them here, at its own pace: R = ceil(1.5 s x 5 MB/s x 1/3 / 1 MiB) = 3 this tick
    expect(c.haves).toEqual([0, 1, 2])
    // c does not stop a and b from striping: unheld pieces go to them alone
    expect(new Set([...a.haves, ...b.haves]).size).toBe(a.haves.length + b.haves.length)
    expect(b.haves.length).toBeGreaterThan(0)
  })

  it('counts a lane once both ends report it; without any, each viewer gets pieces from the host at its own pace', () => {
    const clock = { t: 0 }
    const { r, connect } = setup({ clock })
    const a = connect('a')
    const b = connect('b')
    r.setLinks('a', ['b']) // b has not reported yet
    r.setPlan(plan(10))
    clock.t = 2000 // and still not, 2 s after its wire came up
    r.tick()
    // nobody can pass pieces on, so both get the same ones, but never more than R (4) ahead: not the whole file
    expect(a.haves).toEqual([10, 11, 12, 13])
    expect(b.haves).toEqual([10, 11, 12, 13])
    r.setLinks('b', ['a']) // now striping starts with the next pieces
    a.held.add(10)
    a.held.add(11)
    r.tick()
    expect(a.haves.slice(4)).toEqual([14, 15])
    expect(b.haves).toEqual([10, 11, 12, 13])
  })

  it('waits up to 2 s for a new viewer’s lanes before it takes it for isolated: viewers that join together get each piece once', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock })
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const views = ['a', 'b', 'c'].map((id) => connect(id)) // three join at once; their lanes come in a report (1 Hz)
    r.tick()
    clock.t = 900
    r.tick()
    // taken for isolated, each would be given the same pieces from the host, here 10-12 (R = 3)
    for (const w of views) expect(w.shown()).toEqual([0])
    link('a', 'b', 'c') // the report with their lanes
    clock.t = 1000
    r.tick()
    const given = views.flatMap((w) => w.haves)
    expect(given.length).toBeGreaterThan(0)
    expect(new Set(given).size).toBe(given.length) // each piece to one of them
    // one whose lanes never come is fed from the host once the wait is over: here 10, which a holds
    const d = connect('d')
    views[0]?.held.add(10)
    clock.t = 2900
    r.tick()
    expect(d.haves).toEqual([])
    clock.t = 3100
    r.tick()
    expect(d.haves).toContain(10)

    // a reported lane ends the wait at once: two pairs with no lane between them are fed at their own pace
    const pairs = setup()
    pairs.r.setPlan(plan(10))
    const [p, q, s, u] = ['p', 'q', 's', 'u'].map((id) => pairs.connect(id))
    pairs.link('p', 'q')
    pairs.link('s', 'u')
    pairs.r.tick()
    for (const w of [p, q, s, u]) expect(w?.haves).toEqual([10, 11]) // R = 2 with four viewers
  })

  it('rescues a piece due within 8 s that nobody fetched for 3 s, with the fastest other viewer', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock })
    const a = connect('a')
    const b = connect('b')
    const c = connect('c')
    link('a', 'b', 'c')
    a.up = 3 * MB // a is given the first piece; b is the fastest of the others
    b.up = 2 * MB
    c.up = 1 * MB
    r.setPlan(plan(0, { windowPieces: 25 })) // L1 = 25 MiB: 1 MiB/s of playback, so piece i is due in i s
    r.tick()
    expect(a.haves[0]).toBe(0)
    clock.t = 2900
    r.tick()
    expect(b.haves).not.toContain(0) // idle for less than 3 s
    r.onArrival(a as unknown as Wire, 0) // a starts fetching it: activity
    clock.t = 5000
    r.tick()
    expect([...b.haves, ...c.haves]).not.toContain(0)
    clock.t = 6000 // 3.1 s since that request, and nobody holds it
    r.tick()
    expect(b.haves).toContain(0)
    expect(c.haves).not.toContain(0)
  })

  it('never rescues a piece that is not due within 8 s', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock })
    const x = connect('x')
    const y = connect('y')
    link('x', 'y')
    r.setPlan(plan(0, { windowPieces: 1 })) // L1 = 1 MiB per 25 s: piece 0 is due now, piece 1 in 25 s
    r.tick()
    expect([...x.haves, ...y.haves].sort((m, n) => m - n)).toEqual(range(0, 7))
    clock.t = 10_000
    r.tick()
    const twice = x.haves.filter((i) => y.haves.includes(i))
    expect(twice).toEqual([0])
  })

  it('clears every exclusive set on a group seek, and takes back old reveals outside the new window not fetched', () => {
    const { r, connect, link } = setup()
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    r.setPlan(plan(10))
    r.tick()
    expect([...a.haves, ...b.haves].sort((x, y) => x - y)).toEqual(range(10, 17))
    const [held, fetching, ...rest] = a.haves
    a.held.add(held ?? -1)
    a.peerRequests = [{ piece: fetching ?? -1, offset: 0, length: 16384 }]
    r.setPlan(plan(14, { windowPieces: 2 })) // window [14, 16]: 14 and 16 stay revealed to whoever had them
    // what each could still fetch for the old position goes back (ADR 0008 §4.3), the plan's end first: L3 [0, 13]
    // backwards, then L2 [17, 63] backwards
    const backwards = (xs: number[]): number[] =>
      xs.filter((i) => i < 14 || i > 16).sort((x, y) => (y < 14 ? y + N : y) - (x < 14 ? x + N : x))
    expect(a.donthaves).toEqual(backwards(rest))
    expect(b.donthaves).toEqual(backwards(b.haves))
    expect(exclusiveOf(r, 'a')).toEqual([fetching]) // host work in progress counts against its R
    r.setPlan(plan(40)) // both are at R, but the old assignments no longer come first
    r.tick()
    expect([...a.haves, ...b.haves].filter((i) => i >= 40).sort((x, y) => x - y)).toEqual(range(40, 46))
    expect(a.haves.filter((i) => b.haves.includes(i))).toEqual([]) // nothing given twice
  })

  it("keeps the new plan's urgent audio ranges through a group seek's take-back, even outside its window", () => {
    const { r, connect, link } = setup()
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    r.setPlan(plan(10))
    r.tick()
    const shown = [...a.haves, ...b.haves].sort((x, y) => x - y)
    expect(shown).toEqual(range(10, 17))
    // a poorly interleaved file: the audio for the new position lies in pieces 12-13, far behind window [40, 42]
    r.setPlan({ ...plan(40, { windowPieces: 2 }), urgent: [[12 * P, 14 * P]] })
    const takenBack = [...a.donthaves, ...b.donthaves].sort((x, y) => x - y)
    expect(takenBack).toEqual(shown.filter((i) => i !== 12 && i !== 13))
  })

  it('assigns again what a departed viewer was given and did not fetch', () => {
    for (const leave of ['removeViewer', 'close'] as const) {
      const { r, connect, link } = setup()
      const a = connect('a')
      const b = connect('b')
      const c = connect('c')
      link('a', 'b', 'c')
      r.setPlan(plan(10))
      r.tick()
      const lost = [...b.haves]
      expect(lost.length).toBeGreaterThan(0)
      if (leave === 'removeViewer') r.removeViewer('b')
      else b.emit('close')
      a.held.add(a.haves[0] ?? -1) // budgets free up a little
      c.held.add(c.haves[0] ?? -1)
      a.held.add(a.haves[1] ?? -1)
      c.held.add(c.haves[1] ?? -1)
      r.tick()
      const reassigned = [...a.haves, ...c.haves]
      expect(lost.filter((i) => reassigned.includes(i)).length, leave).toBeGreaterThan(0)
      expect(lost[0] !== undefined && reassigned.includes(lost[0]), leave).toBe(true) // plan order: its first one first
    }
  })

  it("keeps a re-attached member's new wire when the old one closes", () => {
    const { r, connect } = setup()
    const old = connect('a')
    const fresh = connect('a')
    old.emit('close')
    r.setPlan(plan(0))
    r.tick()
    expect(fresh.shown()).toEqual(range(0, N - 1)) // still the room's single viewer
    expect(old.haves).toEqual([])
  })
})

describe('Revealer urgent pieces (a viewer’s blocked readers)', () => {
  it('reveals them to that viewer at once, outside its budget, and to nobody else', () => {
    const { r, connect, link } = setup()
    const a = connect('a')
    const b = connect('b')
    link('a', 'b')
    r.setPlan(plan(10))
    r.tick()
    expect(a.haves).toEqual([10, 12, 14, 16]) // at R (4)
    r.setUrgent('a', [50, 40, 50, -1, N, 2.5, 12])
    expect(a.haves).toEqual([10, 12, 14, 16, 50, 40]) // at once, in range, each once (12 was shown already)
    r.setUrgent('a', [40, 50]) // reported again: nothing is sent twice
    expect(a.haves).toHaveLength(6)
    a.held.add(10)
    a.held.add(12)
    r.tick()
    // two walk pieces fetched, two more given: 40 and 50 are not fetched yet, and do not count against R
    expect(a.haves.slice(6)).toEqual([18, 19])
    expect(b.haves).toEqual([11, 13, 15, 17]) // b gets 40 and 50 from a, once a has them
  })

  it('keeps them through a take-back and in a re-attached wire’s first bitfield, until cleared or removed', () => {
    const { r, connect, link } = setup()
    r.setCriticalRanges([[0, P]])
    r.setPlan(plan(10))
    const a = connect('a')
    r.tick() // alone: shown everything
    r.setUrgent('a', [40]) // shown already: nothing to send
    expect(a.haves).toHaveLength(N - 1)
    connect('b')
    link('a', 'b')
    r.tick() // striping starts; a reader of a's still waits on 40, so 40 stays a's
    expect(a.donthaves).toHaveLength(N - 2)
    expect(a.donthaves).not.toContain(40)
    expect(connect('a').shown()).toEqual([0, 40]) // a's lane re-attached: 40 is in its first bitfield
    r.setUrgent('a', []) // the reader got its piece
    expect(connect('a').shown()).toEqual([0])
    r.setUrgent('a', [41])
    r.removeViewer('a') // a left the room
    expect(connect('a').shown()).toEqual([0])
  })

  it('leaves a piece on its way through a linked viewer to it (sent once), unless that viewer is idle on it for 3 s', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock })
    const a = connect('a')
    const b = connect('b')
    const c = connect('c')
    link('a', 'b') // c has no lane to either
    r.setPlan(plan(0, { windowPieces: 2 })) // L1 of 2 pieces: piece i is due in 12.5 i s, past any rescue but 0's
    r.tick()
    expect(a.haves).toEqual([0, 2, 4]) // R = 3 with three viewers
    // the readers wait on 4, as in the cache fill after a group seek
    r.setUrgent('c', [4])
    expect(c.haves).toContain(4) // c has no lane to a: only the host can give it to c
    clock.t = 1000
    r.onArrival(a as unknown as Wire, 4) // a fetches it from us
    clock.t = 1500 // (b's reader blocks after that request, so that b's own wait limit is not up first)
    r.setUrgent('b', [4])
    expect(b.haves).not.toContain(4) // b gets it from a once a has it: the host sends it once, not per reader
    clock.t = 3900
    r.tick()
    expect(b.haves).not.toContain(4)
    clock.t = 4100 // 3.1 s without a reveal or a request (b waited 2.6 s so far): a is stuck on it
    r.tick()
    expect(b.haves).toContain(4)

    const heldClock = { t: 0 }
    const held = setup({ clock: heldClock })
    const x = held.connect('x')
    const y = held.connect('y')
    held.link('x', 'y')
    held.r.setPlan(plan(0, { windowPieces: 2 }))
    held.r.tick()
    expect(x.haves).toContain(2)
    heldClock.t = 20_000
    x.held.add(2) // x has it: y fetches it from x, however long ago it was shown
    held.r.setUrgent('y', [2])
    held.r.tick()
    expect(y.haves).not.toContain(2)

    // a viewer that is still open was shown everything: that is no assignment, so a reader waits on nothing
    const openClock = { t: 0 }
    const early = setup({ clock: openClock })
    early.r.setPlan(plan(0, { windowPieces: 2 }))
    early.connect('p', 'haveAll', null) // its BEP 10 handshake is still on the way: it stays open
    early.r.tick()
    const q = early.connect('q')
    early.link('p', 'q')
    openClock.t = 100
    early.r.setUrgent('q', [40])
    expect(q.haves).toContain(40)
  })

  it('helps a reader that waited longer than its piece takes from the host, however that piece is on its way: a linked holder that does not send it, or a fetch that drags on', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock, limitBps: MB }) // R = 2 each
    const x = connect('x')
    const y = connect('y')
    link('x', 'y')
    // two 1 MiB pieces at one lane's share (1 of 2) of 1 MB/s take 4.2 s; with 3 s for the have, the request and
    // the queue, a reader waits on another viewer for 7.2 s at most
    const limit = 3000 + (2 * 1000 * P * 2) / MB
    r.setPlan(plan(0, { windowPieces: 2 })) // L1 of 2 pieces: no rescue reaches piece 2 or 30
    r.tick()
    expect([x.haves, y.haves]).toEqual([
      [0, 2],
      [1, 3],
    ])
    x.held.add(0) // fetched: piece 0 is due now, and a rescue of it would blur what follows
    x.held.add(30) // x holds 30 but never sends it to y: a slow or limited uplink, or a member that lies
    r.setUrgent('y', [30, 2]) // and 2 is x's, being fetched from us
    expect(y.haves).toEqual([1, 3]) // both left to x at first: after a group seek that sends each once
    // past a flat 3 s (3.1) and past one piece's time (5.2): at 1 MiB, either sent a group seek's first piece to
    // every reader, while the first viewer was still fetching it
    for (const t of [1000, 2000, 3100, 5200, limit - 100]) {
      clock.t = t
      r.onArrival(x as unknown as Wire, 2) // x keeps fetching 2: it stays active, but y's reader still waits
      r.setUrgent('y', [2, 30]) // y's reports repeat (1 Hz); the time each piece was first reported stays
      r.tick()
    }
    expect(y.haves).toEqual([1, 3])
    clock.t = limit + 100
    r.tick()
    expect(y.haves).toEqual([1, 3, 2, 30]) // the host sends them itself

    // a piece that leaves the report and comes back starts a new wait; a holder that serves in time is never
    // doubled by the host
    x.held.add(40)
    clock.t = 10_000
    r.setUrgent('y', [40])
    clock.t = 11_000
    r.setUrgent('y', []) // the reader went away
    clock.t = 11_500
    r.setUrgent('y', [40]) // and blocks on it again
    clock.t = 10_000 + limit + 100 // past the limit since the first report, 5.8 s after the second
    r.tick()
    expect(y.haves).not.toContain(40)
    clock.t = 18_000
    y.held.add(40) // x sent it
    r.setUrgent('y', [])
    clock.t = 40_000
    r.tick()
    expect(y.haves).not.toContain(40)
  })

  it('sizes that wait by the upload it measured when the host has no limit', () => {
    const clock = { t: 0 }
    const { r, connect, link } = setup({ clock, limitBps: null, upBps: 10 * MB })
    const x = connect('x')
    const y = connect('y')
    link('x', 'y')
    r.setPlan(plan(0, { windowPieces: 2 }))
    r.tick() // the host has measured 10 MB/s
    x.held.add(30) // x holds 30 and never sends it
    r.setUrgent('y', [30])
    clock.t = 3300
    r.tick()
    expect(y.haves).not.toContain(30)
    clock.t = 3600 // 3 s plus two 1 MiB pieces at half of 10 MB/s: 3.4 s (1 MB/s, the floor, would give 7.2 s)
    r.tick()
    expect(y.haves).toContain(30)
  })

  it('takes a paced rate as at least 1 MB/s, and a limit the user set as it is', () => {
    // the pacer sits at its 250 KB/s floor after a quiet spell: taken as is, a reader would wait 19.8 s on a viewer
    // that holds its piece and never sends it
    const waitUntilShown = (o: { limitBps: number | null; pacedBps: number }): number => {
      const clock = { t: 0 }
      const { r, connect, link } = setup({ clock, ...o })
      const x = connect('x')
      const y = connect('y')
      link('x', 'y')
      r.setPlan(plan(0, { windowPieces: 2 }))
      r.tick()
      x.held.add(30)
      r.setUrgent('y', [30])
      while (!y.haves.includes(30) && clock.t < 60_000) {
        clock.t += 100
        r.tick()
      }
      return clock.t
    }
    /** the wait at host upload `bps` (3 s, plus two 1 MiB pieces at one of two lanes' share), to the 100 ms step */
    const waitAt = (bps: number): number => Math.ceil((3000 + (2 * 1000 * P * 2) / bps) / 100) * 100
    expect(waitUntilShown({ limitBps: null, pacedBps: 250_000 })).toBe(waitAt(MB)) // 7.2 s, not 19.8
    expect(waitUntilShown({ limitBps: null, pacedBps: 10 * MB })).toBe(waitAt(10 * MB))
    // a manual limit of 500 KB/s, below the paced rate's 1 MB/s floor: the limit, as before the pacer
    expect(waitUntilShown({ limitBps: 500_000, pacedBps: 250_000 })).toBe(waitAt(500_000))
  })

  it('takes at most 16 pieces from one report', () => {
    const { r, connect, link } = setup()
    const a = connect('a')
    connect('b')
    link('a', 'b')
    r.setPlan(plan(10))
    r.setUrgent('a', range(20, N - 1))
    expect(a.haves).toEqual(range(20, 35))
  })
})

describe('Revealer catch-up (a viewer whose buffer runs short, ADR 0012)', () => {
  /** a and b hold the first 31 pieces, c nothing; all linked, the room at piece 10 (window [10, 30]) */
  const room = () => {
    const s = setup() // 5 MB/s, 3 viewers: R = 3 each
    const a = s.connect('a')
    const b = s.connect('b')
    const c = s.connect('c')
    s.link('a', 'b', 'c')
    for (const i of range(0, 30)) {
      a.held.add(i)
      b.held.add(i)
    }
    s.r.setPlan(plan(10))
    s.r.tick()
    return { ...s, a, b, c }
  }

  it('shows it the pieces of its range it lacks, held by others or not, 4 at a time, and gives it no walk work', () => {
    const { r, a, b, c } = room()
    // held pieces spread through the viewers' own haves: the host shows c only walk work, past what a and b hold
    const frontier = [...c.haves]
    expect(frontier.length).toBeGreaterThan(0)
    expect(frontier.every((i) => i > 30)).toBe(true)
    r.setCatchUp('c', [10, 25])
    expect(r.catchingUp('c')).toBe(true)
    // its walk work goes back to the others: told, and no longer its budget
    expect([...c.donthaves].sort((x, y) => x - y)).toEqual(frontier)
    expect(exclusiveOf(r, 'c')).toEqual([])
    expect(c.haves.slice(frontier.length)).toEqual([10, 11, 12, 13])
    r.tick()
    expect(c.haves.slice(frontier.length)).toEqual([10, 11, 12, 13]) // nothing more while those 4 are not in
    // a and b fetched theirs: their budgets free up, and what c was given goes to them
    for (const i of [...a.haves, ...b.haves]) {
      a.held.add(i)
      b.held.add(i)
    }
    r.tick()
    expect([...a.haves, ...b.haves]).toContain(Math.min(...frontier))
    c.held.add(10)
    c.held.add(11)
    r.tick()
    expect(c.haves.slice(frontier.length)).toEqual([10, 11, 12, 13, 14, 15])
    expect(c.haves.filter((i) => i > 30)).toEqual(frontier) // still no walk work
  })

  it('takes nothing back when only its range moves, and keeps the range through a group seek', () => {
    const { r, c } = room()
    r.setCatchUp('c', [10, 25])
    const told = c.donthaves.length
    r.setCatchUp('c', [11, 26])
    expect(c.donthaves).toHaveLength(told)
    r.setPlan(plan(40, { windowPieces: 5 }))
    expect(c.donthaves.filter((i) => i >= 11 && i <= 13)).toEqual([]) // 10 left its range: taken back
  })

  it('ends on null and on removeViewer; the walk gives it work again', () => {
    const { r, a, b, c } = room()
    r.setCatchUp('c', [10, 25])
    r.setCatchUp('c', null)
    expect(r.catchingUp('c')).toBe(false)
    for (const i of [...a.haves, ...b.haves]) {
      a.held.add(i)
      b.held.add(i)
    }
    const before = c.haves.length
    r.tick()
    expect(c.haves.slice(before).some((i) => i > 30)).toBe(true)
    r.setCatchUp('c', [10, 25])
    r.removeViewer('c')
    expect(r.catchingUp('c')).toBe(false)
  })

  it('refuses a range outside the torrent', () => {
    const { r } = room()
    r.setCatchUp('c', [N + 5, N + 9])
    expect(r.catchingUp('c')).toBe(false)
  })
})
