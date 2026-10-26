import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import BtWire from 'bittorrent-protocol'
import type { Torrent, Wire } from 'webtorrent'
import { describe, expect, it } from 'vitest'
import { HostUplink, type UplinkMember } from './uplink.js'
import { type RequestClass, UploadScheduler, type UploadSchedulerDeps } from './upload-scheduler.js'

// The upload scheduler against real bittorrent-protocol wires (with the hold mode of
// patches/bittorrent-protocol+5.0.9.patch): requests come in through the parser's entry points (_onRequest,
// _onCancel), the store answers WebTorrent's 'request' at once, and the test plays the connection: what crosses the
// peer's 'upload' Transform, and the UDX stream's counters. No timers: the test drives the clock, tick() and pump().

const BLOCK = 16 * 1024
/** what a 16 KiB block takes on the wire: the piece message's 13-byte header and the block */
const MSG = 13 + BLOCK

/** bittorrent-protocol's Wire as the scheduler and the test use it */
type TestWire = Wire & {
  _onRequest(index: number, offset: number, length: number): void
  _onCancel(index: number, offset: number, length: number): void
  _sendReject(index: number, offset: number, length: number): void
  choke(): void
  unchoke(): void
  allowedFastSet: number[]
}

interface Viewer {
  wire: TestWire
  peer: EventEmitter
  /** pieces answered ('request' reached the store), in order */
  served: number[]
  /** pieces rejected (BEP 6) */
  rejects: number[]
  /** the connection takes everything pushed so far (the peer's 'upload' Transform) */
  drain(): void
  /** the store reads of answered requests that are not back yet (store: 'manual') */
  reads: (() => void)[]
}

function setup(
  opts: {
    classes?: Record<number, RequestClass>
    refuse?: number[]
    clock?: { t: number }
    extra?: Pick<UploadSchedulerDeps, 'bucket' | 'mayRelease' | 'maxHoldMs' | 'boosted'>
  } = {},
) {
  const peers = new Map<string, EventEmitter & { wire: Wire | null }>()
  const t = Object.assign(new EventEmitter(), { _peers: peers }) as unknown as Torrent
  const clock = opts.clock ?? { t: 0 }
  const members = new Map<Wire, string>()
  const transports = new Map<Wire, { unsentBytes: number; ackedBytes: number }>()
  const classes = new Map<number, RequestClass>(Object.entries(opts.classes ?? {}).map(([k, c]) => [Number(k), c]))
  const arrivals: number[] = []
  const s = new UploadScheduler(t, {
    memberOf: (w) => members.get(w) ?? null,
    classOf: (i) => classes.get(i) ?? 2,
    transport: (w) => transports.get(w) ?? null,
    onArrival: (_w, i) => {
      arrivals.push(i)
      return !(opts.refuse ?? []).includes(i)
    },
    now: () => clock.t,
    ...opts.extra,
  })
  /** a viewer's wire: the store answers at once ('sync'), or when the test says ('manual'); 'drain' passes it on */
  const connect = (id: string, o: { fast?: boolean; store?: 'sync' | 'manual'; drain?: boolean } = {}): Viewer => {
    const wire = new BtWire() as unknown as TestWire
    wire.hasFast = o.fast ?? true
    wire.unchoke()
    const peer = Object.assign(new EventEmitter(), { wire })
    let passed = wire.pushedBytes
    const v: Viewer = {
      wire,
      peer,
      served: [],
      rejects: [],
      reads: [],
      drain: () => {
        const n = wire.pushedBytes - passed
        passed = wire.pushedBytes
        if (n > 0) peer.emit('upload', n)
      },
    }
    wire._sendReject = (i) => void v.rejects.push(i)
    wire.on('request', (i: number, _offset: number, length: number, cb: (err: Error | null, b?: Buffer) => void) => {
      v.served.push(i)
      const answer = (): void => {
        cb(null, Buffer.alloc(length))
        if (o.drain) v.drain()
      }
      if (o.store === 'manual') v.reads.push(answer)
      else answer()
    })
    peers.set(id, peer)
    members.set(wire, id)
    t.emit('wire', wire)
    v.drain() // what the handshake pushed is gone
    return v
  }
  const request = (v: Viewer, i: number, offset = 0, length = BLOCK): void => v.wire._onRequest(i, offset, length)
  return { s, t, clock, connect, request, transports, classes, arrivals }
}

describe('UploadScheduler', () => {
  it('holds every request and releases one only while its wire queues under 32 KiB (no drain rate yet)', () => {
    const { s, connect, request } = setup()
    const a = connect('a')
    expect(a.wire.holdRequests).toBe(true)
    for (let k = 0; k < 8; k++) request(a, k, 0)
    // the first block is read and pushed (16 KiB + 13 queued), the second takes it past 32 KiB: then nothing more
    expect(a.served).toEqual([0, 1])
    expect(a.wire.heldRequests.map((r) => r.piece)).toEqual([2, 3, 4, 5, 6, 7])
    expect(s.stats()).toMatchObject({ held: 6, queuedBytes: 2 * MSG, released: 2 })
    a.drain() // the connection took them
    expect(a.served).toEqual([0, 1, 2, 3])
  })

  it('counts a block being read from the store as queued, and a cancel drops a held request unanswered', () => {
    const { s, connect, request } = setup()
    const a = connect('a', { store: 'manual' })
    for (let k = 0; k < 4; k++) request(a, k)
    expect(a.served).toEqual([0, 1]) // two reads of 16 KiB fill the 32 KiB
    const cancelled: number[] = []
    a.wire.on('cancel', (i: number) => cancelled.push(i))
    a.wire._onCancel(3, 0, BLOCK)
    expect([cancelled, a.wire.heldRequests.map((r) => r.piece)]).toEqual([[3], [2]])
    a.reads.shift()?.()
    a.drain()
    expect(a.served).toEqual([0, 1, 2])
    a.reads.splice(0).forEach((read) => read())
    a.drain()
    expect(a.served).toEqual([0, 1, 2]) // 3 never reached the store
    expect(s.stats().held).toBe(0)
  })

  it("sizes a wire's queue to 100 ms of what UDX gets acknowledged, and counts UDX's unsent bytes in it", () => {
    const { s, clock, connect, request, transports } = setup()
    const a = connect('a')
    const u = { unsentBytes: 0, ackedBytes: 0 }
    transports.set(a.wire, u)
    clock.t = 10
    s.tick() // the first reading only sets the base
    for (let k = 0; k < 200; k++) request(a, k)
    expect(a.served).toHaveLength(2)
    // UDX acked 1 MB in 50 ms: the drain rate is 0.3 x 20 MB/s = 6 MB/s, so 100 ms of it is 600 KB
    clock.t = 60
    u.ackedBytes = 1_000_000
    s.tick()
    expect(a.served.length).toBe(Math.ceil(600_000 / MSG))
    // what the connection handed to UDX and UDX has not sent stays queued: a stalled stream gets nothing more
    const before = a.served.length
    u.unsentBytes = 600_000
    a.drain()
    expect(a.served.length).toBe(before)
    u.unsentBytes = 600_000 - 2 * MSG
    s.pump()
    expect(a.served.length).toBe(before + 2)
  })

  it('releases class 0, then 1, then 2 across wires; FIFO within a class on a wire; round-robin between wires', () => {
    const { s, clock, connect, request } = setup({ classes: { 9: 0, 7: 1 } })
    const a = connect('a', { drain: true })
    const b = connect('b', { drain: true })
    s.setRate(BLOCK * 50) // one block per 20 ms
    const order: string[] = []
    a.wire.on('request', (i: number) => order.push(`a${String(i)}`))
    b.wire.on('request', (i: number) => order.push(`b${String(i)}`))
    for (const i of [5, 6]) request(a, i)
    for (const i of [8, 9, 7]) request(b, i)
    for (let k = 1; k <= 5; k++) {
      clock.t = k * 20
      s.pump()
    }
    expect(order).toEqual(['b9', 'b7', 'a5', 'b8', 'a6'])
  })

  it('releases at the rate set, through a token bucket 20 ms deep', () => {
    const { s, clock, connect, request } = setup()
    const a = connect('a', { drain: true })
    const b = connect('b', { drain: true })
    s.setRate(1_000_000)
    for (let k = 0; k < 400; k++) request(k % 2 === 0 ? a : b, k)
    for (clock.t = 0; clock.t <= 1000; clock.t += 5) s.pump()
    const bytes = (a.served.length + b.served.length) * BLOCK
    expect(bytes).toBeGreaterThan(1_000_000 - BLOCK)
    expect(bytes).toBeLessThan(1_000_000 + 20_000 + 2 * BLOCK)
    expect(Math.abs(a.served.length - b.served.length)).toBeLessThanOrEqual(1) // shared fairly
    // after a pause the bucket holds 20 ms of rate, not the whole pause
    clock.t = 5000
    const was = a.served.length + b.served.length
    s.pump()
    expect(a.served.length + b.served.length - was).toBeLessThanOrEqual(Math.ceil(20_000 / BLOCK) + 1)
  })

  it('gives a wire that held requests and got nothing for 2 s the next release, whatever its class', () => {
    const { s, clock, connect, request, classes } = setup()
    const a = connect('a', { drain: true })
    const b = connect('b', { drain: true })
    s.setRate(BLOCK * 50) // one block per 20 ms
    request(b, 1000) // class 2
    const firstB: number[] = []
    b.wire.on('request', () => firstB.push(clock.t))
    for (let k = 1; k <= 150 && firstB.length === 0; k++) {
      classes.set(k, 0)
      request(a, k) // a steady stream of class-0 requests on the other wire
      clock.t = k * 20
      s.pump()
    }
    expect(firstB[0]).toBeGreaterThanOrEqual(2000)
    expect(firstB[0]).toBeLessThanOrEqual(2040)
  })

  it('refuses on arrival what onArrival refuses: BEP 6 reject, or no answer without the fast extension', () => {
    const { s, connect, request, arrivals } = setup({ refuse: [40] })
    const a = connect('a')
    const b = connect('b', { fast: false })
    request(a, 40)
    request(b, 40)
    request(a, 41)
    expect(arrivals).toEqual([40, 40, 41])
    expect([a.served, a.rejects, b.served, b.rejects]).toEqual([[41], [40], [], []])
    expect(s.stats()).toMatchObject({ held: 0, refused: 2 })
  })

  it('rejects held requests on a choke (BEP 6) except allowed-fast ones; without fast the peer drops its own', () => {
    const { connect, request } = setup()
    const a = connect('a', { store: 'manual' })
    const b = connect('b', { store: 'manual', fast: false })
    a.wire.allowedFastSet.push(5)
    for (const i of [1, 2, 3, 4, 5]) request(a, i)
    for (const i of [1, 2, 3]) request(b, i)
    a.wire.choke()
    b.wire.choke()
    expect(a.wire.heldRequests.map((r) => r.piece)).toEqual([5])
    expect(a.rejects).toEqual([1, 2, 3, 4]) // the two being read are upstream's peerRequests, rejected as before
    expect([b.wire.heldRequests, b.rejects]).toEqual([[], []])
  })

  it("preempt rejects that viewer's held class-2 requests only", () => {
    const { s, connect, request } = setup({ classes: { 3: 1, 4: 0 } })
    const a = connect('a', { store: 'manual' })
    const b = connect('b', { store: 'manual' })
    const c = connect('c', { store: 'manual', fast: false })
    for (const i of [0, 1, 2, 3, 4, 5]) for (const v of [a, b, c]) request(v, i)
    // 0 and 1 are being read (32 KiB); held: 2, 3 (class 1), 4 (class 0), 5
    expect(a.wire.heldRequests.map((r) => r.piece)).toEqual([2, 3, 4, 5])
    expect(s.preempt('a')).toBe(2)
    expect([a.rejects, a.wire.heldRequests.map((r) => r.piece)]).toEqual([
      [2, 5],
      [3, 4],
    ])
    expect(b.rejects).toEqual([])
    expect(b.wire.heldRequests).toHaveLength(4)
    expect(s.preempt('c')).toBe(0) // its WebTorrent would wait 30 s for an answer that never comes
    expect(c.wire.heldRequests).toHaveLength(4)
    expect(s.stats().preempted).toBe(2)
  })

  it('preempt with keep spares the pieces it keeps (a viewer starting to catch up: its range)', () => {
    const { s, connect, request } = setup()
    const a = connect('a', { store: 'manual' })
    for (const i of [0, 1, 2, 3, 4, 5]) request(a, i)
    expect(s.preempt('a', (i) => i === 3 || i === 4)).toBe(2)
    expect([a.rejects, a.wire.heldRequests.map((r) => r.piece)]).toEqual([
      [2, 5],
      [3, 4],
    ])
  })

  describe('a boosted member (catch-up priority, ADR 0012)', () => {
    it("goes first within a class, after any wire's class 0", () => {
      const boosted = new Set(['b'])
      const { s, clock, connect, request } = setup({ classes: { 9: 0 }, extra: { boosted: (m) => boosted.has(m) } })
      const a = connect('a', { drain: true })
      const b = connect('b', { drain: true })
      const c = connect('c', { drain: true })
      s.setRate(BLOCK * 50) // one block per 20 ms
      const order: string[] = []
      for (const [v, name] of [
        [a, 'a'],
        [b, 'b'],
        [c, 'c'],
      ] as const)
        v.wire.on('request', (i: number) => order.push(`${name}${String(i)}`))
      for (const i of [1, 2]) request(a, i)
      for (const i of [11, 12, 13]) request(b, i)
      for (const i of [9, 21]) request(c, i)
      for (let k = 1; k <= 7; k++) {
        clock.t = k * 20
        s.pump()
      }
      expect(order.slice(0, 4)).toEqual(['c9', 'b11', 'b12', 'b13'])
      expect(order.slice(4).sort()).toEqual(['a1', 'a2', 'c21'])
      boosted.clear() // no longer boosted: round-robin again
      for (const i of [14, 15]) request(b, i)
      for (const i of [3, 4]) request(a, i)
      order.length = 0
      for (let k = 8; k <= 11; k++) {
        clock.t = k * 20
        s.pump()
      }
      expect(order.filter((r) => r.startsWith('a'))).toHaveLength(2)
    })

    it('still lets every other wire through within 2 s (aging)', () => {
      const { s, clock, connect, request } = setup({ extra: { boosted: (m) => m === 'a' } })
      const a = connect('a', { drain: true })
      const b = connect('b', { drain: true })
      s.setRate(BLOCK * 50)
      request(b, 1000)
      const firstB: number[] = []
      b.wire.on('request', () => firstB.push(clock.t))
      for (let k = 1; k <= 150 && firstB.length === 0; k++) {
        request(a, k) // the boosted wire always holds a class-2 request
        clock.t = k * 20
        s.pump()
      }
      expect(firstB[0]).toBeGreaterThanOrEqual(2000)
      expect(firstB[0]).toBeLessThanOrEqual(2040)
    })

    it('does not hold up the others while its own queue is full', () => {
      const { connect, request } = setup({ extra: { boosted: (m) => m === 'a' } })
      const a = connect('a', { store: 'manual' }) // its reads never come back: its queue stays at the cap
      const b = connect('b', { drain: true })
      for (const i of [1, 2, 3, 4]) request(a, i)
      for (const i of [11, 12]) request(b, i)
      expect(a.served).toEqual([1, 2])
      expect(b.served).toEqual([11, 12])
    })
  })

  it('refuses what a wire asks for past 512 held requests', () => {
    const { s, connect, request } = setup()
    const a = connect('a', { store: 'manual' })
    for (let k = 0; k < 600; k++) request(a, k)
    expect(a.served).toEqual([0, 1])
    expect(a.wire.heldRequests).toHaveLength(512)
    expect(a.rejects).toEqual(Array.from({ length: 86 }, (_, k) => 514 + k))
    expect(s.stats().refused).toBe(86)
  })

  it('refuses what it still holds when destroyed, and holds no more', () => {
    const { s, connect, request } = setup()
    const a = connect('a')
    for (let k = 0; k < 5; k++) request(a, k)
    s.destroy()
    expect([a.served, a.rejects, a.wire.heldRequests]).toEqual([[0, 1], [2, 3, 4], []])
    expect(a.wire.holdRequests).toBe(false)
    request(a, 5) // answered at once, as upstream does
    expect(a.served).toEqual([0, 1, 5])
  })

  it('keeps releasing on a wire whose WebTorrent peer it cannot find, by UDX alone', () => {
    // no peer: nothing counts what left the wire, so that part of its queue is unknown and left out
    const { s, t, clock, transports } = setup()
    const wire = new BtWire() as unknown as TestWire
    wire.hasFast = true
    wire.unchoke()
    const served: number[] = []
    wire.on('request', (i: number, _o: number, length: number, cb: (err: Error | null, b?: Buffer) => void) => {
      served.push(i)
      cb(null, Buffer.alloc(length))
    })
    transports.set(wire, { unsentBytes: 0, ackedBytes: 0 }) // UDX sends and gets acked at once
    t.emit('wire', wire)
    for (let k = 0; k < 10; k++) wire._onRequest(k, 0, BLOCK)
    for (let k = 0; k < 10; k++) {
      clock.t += 50
      s.tick()
    }
    expect(served).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('drops a closed wire', async () => {
    const { s, connect, request } = setup()
    const a = connect('a', { store: 'manual' })
    for (let k = 0; k < 5; k++) request(a, k)
    const closed = new Promise<void>((resolve) => a.wire.once('close', () => resolve()))
    a.wire.destroy()
    await closed
    expect(s.stats()).toMatchObject({ held: 0, queuedBytes: 0 })
  })
})

describe('udx-native as loaded (patches/udx-native+1.21.3.patch)', () => {
  // what the engine reads of a lane's UDX stream: unsent = bytesWritten - bytesAcked - inflight
  it('counts the bytes a stream was handed and the bytes it got acknowledged', async () => {
    const UDX = createRequire(import.meta.url)('udx-native') as new () => UdxLike
    const udx = new UDX()
    const [x, y] = [udx.createSocket(), udx.createSocket()]
    x.bind(0, '127.0.0.1')
    y.bind(0, '127.0.0.1')
    const a = udx.createStream(1)
    const b = udx.createStream(2)
    a.connect(x, 2, y.address().port, '127.0.0.1')
    b.connect(y, 1, x.address().port, '127.0.0.1')
    let got = 0
    b.on('data', (d: Uint8Array) => void (got += d.byteLength))
    const settled = async (bytes: number): Promise<number[]> => {
      const end = Date.now() + 5000
      while ((got < bytes || a.bytesAcked < bytes) && Date.now() < end) await new Promise((r) => setTimeout(r, 5))
      return [got, a.bytesWritten, a.bytesAcked, a.inflight]
    }
    expect([a.bytesWritten, a.bytesAcked]).toEqual([0, 0])
    a.write(Buffer.alloc(56_000)) // alone: one buffer
    expect(await settled(56_000)).toEqual([56_000, 56_000, 56_000, 0])
    for (let k = 0; k < 4; k++) a.write(Buffer.alloc(50_000)) // queued together: several buffers
    expect(await settled(256_000)).toEqual([256_000, 256_000, 256_000, 0])
    for (const s of [a, b]) s.destroy()
    await Promise.all([x.close(), y.close()])
  })
})

interface UdxLike {
  createSocket(): { bind(port: number, host: string): void; address(): { port: number }; close(): Promise<void> }
  createStream(id: number): UdxStreamLike
}
interface UdxStreamLike {
  bytesWritten: number
  bytesAcked: number
  inflight: number
  connect(socket: unknown, remoteId: number, port: number, host: string): void
  write(data: Uint8Array): boolean
  on(event: 'data', cb: (d: Uint8Array) => void): unknown
  destroy(): void
}

describe('UploadScheduler on a shared uplink (playlists, ADR 0011 §5)', () => {
  /** The item playing (tier 0) and one fetched ahead (tier 1), on one uplink. */
  function pair() {
    const clock = { t: 0 }
    const uplink = new HostUplink({ now: () => clock.t })
    let fgS: UploadScheduler | null = null
    let bgS: UploadScheduler | null = null
    const fgM: UplinkMember = { scheduler: () => fgS, streams: () => [] }
    const bgM: UplinkMember = { scheduler: () => bgS, streams: () => [] }
    const fg = setup({ clock, extra: { bucket: uplink.bucket, mayRelease: () => uplink.mayRelease(fgM) } })
    const bg = setup({
      clock,
      extra: { bucket: uplink.bucket, mayRelease: () => uplink.mayRelease(bgM), maxHoldMs: () => 10_000 },
    })
    fgS = fg.s
    bgS = bg.s
    const leaveFg = uplink.register(fgM, 0)
    uplink.register(bgM, 1)
    return { clock, uplink, fg, bg, fgM, bgM, leaveFg, done: () => uplink.destroy() }
  }

  it('the item fetched ahead waits while the playing one holds a request it could send', () => {
    const { clock, uplink, fg, bg, done } = pair()
    uplink.setLimit(16) // 16 KiB/s: one block a second
    const a = fg.connect('a', { drain: true })
    const b = bg.connect('b', { drain: true })
    fg.request(a, 1)
    bg.request(b, 7)
    // no tokens yet: the playing item's request waits, so the other one may not take what comes first
    expect([a.served, b.served]).toEqual([[], []])
    clock.t = 1000
    uplink.pumpAll()
    expect([a.served, b.served]).toEqual([[1], []])
    clock.t = 2000
    uplink.pumpAll()
    expect(b.served).toEqual([7])
    done()
  })

  it('goes on while the playing item cannot send (its wires are at their queue cap)', () => {
    const { fg, bg, done } = pair()
    const a = fg.connect('a', { store: 'manual' })
    const b = bg.connect('b', { drain: true })
    for (let k = 0; k < 4; k++) fg.request(a, k)
    expect(a.served).toEqual([0, 1]) // two reads fill a's 32 KiB
    bg.request(b, 9)
    expect(b.served).toEqual([9])
    done()
  })

  it('refuses what an item fetched ahead held too long, before the viewer would drop the wire', () => {
    const { clock, uplink, fg, bg, done } = pair()
    uplink.setLimit(16)
    const a = fg.connect('a', { drain: true })
    const b = bg.connect('b', { drain: true })
    fg.request(a, 1)
    bg.request(b, 7)
    bg.request(b, 8)
    // the playing item keeps the uplink busy for 10 s
    for (let s = 1; s <= 10; s++) {
      clock.t = s * 1000
      fg.request(a, 100 + s)
      uplink.pumpAll()
    }
    clock.t = 10_050
    bg.s.tick()
    expect(b.rejects).toEqual([7, 8])
    expect(b.wire.heldRequests).toHaveLength(0)
    expect(bg.s.stats().refused).toBe(2)
    done()
  })

  it("keeps counting what a member sent after it left, so the pacer's counter never goes back", () => {
    const { fg, leaveFg, uplink, done } = pair()
    const a = fg.connect('a', { drain: true })
    fg.request(a, 1)
    const sent = (uplink as unknown as { sentBytes(): number }).sentBytes()
    expect(sent).toBeGreaterThan(0)
    leaveFg()
    expect((uplink as unknown as { sentBytes(): number }).sentBytes()).toBe(sent)
    done()
  })
})
