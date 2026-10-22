// The host's upload path, instrumented ('monitor') or scheduled ('jit'). Prototype for ADR 0006 (S2b); nothing here
// is in src.
//
// As shipped, bittorrent-protocol answers every request at once (Wire._onRequest -> 'request' -> WebTorrent reads the
// store -> respond -> wire.piece -> _push), and _push ignores the readable side's backpressure. The data then waits in
// the wire's readable buffer and the peer's upload throttle (peer.js setThrottlePipes: wire -> throttle -> 'upload'
// Transform -> MuxWireStream), where a cancel cannot reach it and a 'have' queues behind it. The throttle is one
// token bucket shared by every wire's Throttle (speed-limiter), and it is not fair: each waiting Throttle re-arms its
// own timer, and the one that took the tokens last re-arms first. S2b saw one wire take 1015 kB/s of a 1000 KiB/s
// limit for a whole second while the other two, with data and a 'have' queued, got nothing.
//
// 'jit' holds each request (an own-property override of wire._onRequest; the parser calls this._onRequest) and
// releases it into the wire only when
//   - the wire's queue (bytes released and still being read from the store, plus bytes pushed into the wire that
//     have not left it yet) is under max(minBytes, targetMs of the wire's drain rate): data is committed to a
//     connection only when it can leave soon, so a 'have' or an urgent block never waits behind seconds of it, and a
//     stalled connection (UDX's BBR shrinks a stream to 4 packets now and then) does not hoard the uplink; and
//   - with a rate (the app's limit, or the pacer's), the scheduler's own token bucket (burstMs deep) has tokens:
//     the rate is enforced here, in release order, and WebTorrent's throttle is switched off (member.ts).
// Release order: the lowest class first - 0 = a piece some viewer's reader is blocked on (the Revealer's urgent
// reports), 1 = the group's hot window or a critical range, 2 = the rest - FIFO within a class on a wire (the viewer's
// own R6 order), round-robin between wires. Urgent 'global' compares classes across wires (the urgent wire gets the
// whole rate for a moment); 'wire' only within each wire (round-robin decides between wires); 'off' is FIFO.
// A held request can be cancelled (wire._onCancel override) and is rejected on a choke like a served one.
//
// The queue above stops at the 'upload' Transform, i.e. where WebTorrent hands the data to the connection. Below it
// are MuxWireStream, Protomux, secret-stream and UDX's own send queue, which takes ~256 KiB per stream before it
// pushes back, whatever its congestion window allows; a ctrl frame on the same connection waits behind all of it.
// With `udx` (--jit-udx), a wire's queue also counts what its connection handed to UDX and UDX has neither sent nor
// had acknowledged (written - acked - inflight, from counters member.ts adds to udx-native), and its drain rate is
// what UDX got acknowledged: a stream that stalls (BBR's PROBE_RTT, a cwnd-limited stream) stops being fed at once.
// With 'monitor' the same counters are only reported (how much the shipped path leaves in UDX).
//
// 'monitor' only counts (the same _push wrap and the peer's 'upload' events) so every variant reports its queue.
import type { Torrent, Wire } from 'webtorrent'
import type { UrgentMode } from './proto.js'
import { now } from './proto.js'

const BLOCK = 16 * 1024
const PACE_MS = 5

interface Req {
  index: number
  offset: number
  length: number
  at: number
}

interface PeerLike {
  wire: Wire | null
  on(ev: 'upload', cb: (n: number) => void): unknown
  removeListener(ev: 'upload', cb: (n: number) => void): unknown
}

/** what a wire is as bittorrent-protocol builds it (fields the prototypes touch) */
type RawWire = Wire & {
  _onRequest(index: number, offset: number, length: number): void
  _onCancel(index: number, offset: number, length: number): void
  _push(data: Uint8Array): boolean | undefined
  _pull(list: unknown[], piece: number, offset: number, length: number): unknown
  _finished: boolean
  allowedFastSet: number[]
  reject(index: number, offset: number, length: number): void
  choke(): void
  emit(ev: string, ...args: unknown[]): boolean
}

export interface WireQueue {
  id: number
  member: string | null
  wire: RawWire
  pending: Req[]
  /** released, waiting for the store (bytes) */
  reading: number
  /** every byte pushed into the wire / that left the throttle (the peer's 'upload' Transform) */
  pushed: number
  passed: number
  /** pushed piece messages not past the throttle yet: end position in `pushed`, class and piece */
  fifo: { end: number; cls: number; piece: number }[]
  /** callbacks for when everything pushed so far has left the throttle (tracing) */
  watchers: { end: number; cb: () => void }[]
  /** EWMA of `passed` per second (with `udx`: of what UDX got acknowledged) */
  rate: number
  lastPassed: number
  lastRateAt: number
  /** with `udx`: bytes the connection handed to UDX that UDX has not sent yet, and UDX's acked bytes */
  udxUnsent: number
  udxAcked: number
  lastAcked: number
  maxUdxUnsent: number
  // stats
  released: number
  releasedBytes: number
  cancelledHeld: number
  rejectedHeld: number
  reordered: number
  maxQueued: number
  maxPending: number
}

export interface UploadSchedOptions {
  mode: 'monitor' | 'jit'
  urgent: UrgentMode
  targetMs: number
  minBytes: number
  /** jit: the upload rate to enforce at release, bytes/s; null = none (only the per-wire queue caps) */
  rateBps(): number | null
  /** jit: the release token bucket's depth, ms of the rate */
  burstMs: number
  /** member id behind a wire (the engine's mapping) */
  memberOf(wire: Wire): string | null
  /** 0 | 1 | 2 for a piece, see the header */
  classOf(piece: number): number
  /** a request arrived / was released (jit) / its block was pushed into the wire / left the throttle */
  onTrace?(ev: 'req' | 'rel' | 'push' | 'sent', piece: number, wire: Wire): void
  /**
   * jit: the UDX stream under a wire's connection: bytes handed to it, bytes it got acknowledged, bytes in flight.
   * When given, a wire's queue reaches down into UDX (see the header); null = not known (yet).
   */
  udx?(wire: Wire): { written: number; acked: number; inflight: number } | null
}

export class UploadSched {
  readonly queues: WireQueue[] = []
  private seq = 0
  private readonly timer: ReturnType<typeof setInterval>
  private pacer: ReturnType<typeof setInterval> | null = null
  private pumping = false
  private pumpQueued = false
  private rr = 0
  private budget = 0
  private budgetAt = now()
  /** every byte that left the throttle on any wire, ever (closed wires included) */
  totalPassed = 0
  /** releases a wire's full queue deferred / the rate deferred */
  capWaits = 0
  rateWaits = 0
  /** wires the prototype could not hook (no peer found): served as shipped */
  unhooked = 0
  /** held requests rejected to make room for an urgent one (preempt) */
  preempted = 0

  constructor(
    private readonly t: Torrent,
    private readonly o: UploadSchedOptions,
  ) {
    t.on('wire', (wire: Wire) => this.add(wire as RawWire))
    this.timer = setInterval(() => this.tick(), 50)
    if (o.mode === 'jit') this.pacer = setInterval(() => this.pump(), PACE_MS)
  }

  destroy(): void {
    clearInterval(this.timer)
    if (this.pacer) clearInterval(this.pacer)
  }

  queued(q: WireQueue): number {
    return q.reading + (q.pushed - q.passed) + q.udxUnsent
  }

  /** with `udx`: re-read the counters of the wire's UDX stream; false while it is not known */
  private refreshUdx(q: WireQueue): boolean {
    const u = this.o.udx?.(q.wire)
    if (!u) return false
    q.udxUnsent = Math.max(0, u.written - u.acked - u.inflight)
    q.udxAcked = u.acked
    if (q.udxUnsent > q.maxUdxUnsent) q.maxUdxUnsent = q.udxUnsent
    return true
  }

  private cap(q: WireQueue): number {
    return Math.max(this.o.minBytes, (q.rate * this.o.targetMs) / 1000)
  }

  private add(wire: RawWire): void {
    const peer = this.peerOf(wire)
    if (!peer) {
      this.unhooked++
      return
    }
    const q: WireQueue = {
      id: ++this.seq,
      member: null,
      wire,
      pending: [],
      reading: 0,
      pushed: 0,
      passed: 0,
      fifo: [],
      watchers: [],
      rate: 0,
      lastPassed: 0,
      lastRateAt: now(),
      udxUnsent: 0,
      udxAcked: 0,
      lastAcked: -1,
      maxUdxUnsent: 0,
      released: 0,
      releasedBytes: 0,
      cancelledHeld: 0,
      rejectedHeld: 0,
      reordered: 0,
      maxQueued: 0,
      maxPending: 0,
    }
    this.queues.push(q)
    const push = wire._push.bind(wire)
    wire._push = (data: Uint8Array) => {
      q.pushed += data.length
      const queued = this.queued(q)
      if (queued > q.maxQueued) q.maxQueued = queued
      return push(data)
    }
    const piece = wire.piece.bind(wire)
    wire.piece = (index: number, offset: number, buffer: Uint8Array) => {
      piece(index, offset, buffer)
      q.fifo.push({ end: q.pushed, cls: this.o.classOf(index), piece: index })
      this.o.onTrace?.('push', index, wire)
    }
    const onUpload = (n: number): void => {
      q.passed += n
      this.totalPassed += n
      while (q.fifo.length > 0 && (q.fifo[0] as { end: number }).end <= q.passed) {
        const e = q.fifo.shift() as { piece: number }
        this.o.onTrace?.('sent', e.piece, wire)
      }
      while (q.watchers.length > 0 && (q.watchers[0] as { end: number }).end <= q.passed) {
        ;(q.watchers.shift() as { cb: () => void }).cb()
      }
      if (this.o.mode === 'jit') this.pump()
    }
    peer.on('upload', onUpload)
    wire.once('close', () => {
      peer.removeListener('upload', onUpload)
      q.pending = []
      const k = this.queues.indexOf(q)
      if (k >= 0) this.queues.splice(k, 1)
      if (this.o.mode === 'jit') this.pump()
    })
    if (this.o.mode !== 'jit') {
      const onRequest = wire._onRequest.bind(wire)
      wire._onRequest = (index: number, offset: number, length: number) => {
        this.o.onTrace?.('req', index, wire)
        onRequest(index, offset, length)
      }
      return
    }

    wire._onRequest = (index: number, offset: number, length: number) => {
      this.o.onTrace?.('req', index, wire)
      if (wire.amChoking && !(wire.hasFast && wire.allowedFastSet.includes(index))) {
        if (wire.hasFast) wire.reject(index, offset, length) // BEP 6, as the original does
        return
      }
      q.pending.push({ index, offset, length, at: now() })
      if (q.pending.length > q.maxPending) q.maxPending = q.pending.length
      this.pump()
    }
    const cancel = wire._onCancel.bind(wire)
    wire._onCancel = (index: number, offset: number, length: number) => {
      const k = q.pending.findIndex((r) => r.index === index && r.offset === offset && r.length === length)
      if (k >= 0) {
        q.pending.splice(k, 1)
        q.cancelledHeld++
        wire.emit('cancel', index, offset, length)
        return
      }
      cancel(index, offset, length)
    }
    const choke = wire.choke.bind(wire)
    wire.choke = () => {
      const was = wire.amChoking
      choke()
      if (was || !wire.amChoking) return
      // BEP 6: a choke rejects every request not in the allowed-fast set; held ones are requests too
      const keep: Req[] = []
      for (const r of q.pending) {
        if (wire.hasFast && wire.allowedFastSet.includes(r.index)) keep.push(r)
        else {
          q.rejectedHeld++
          if (wire.hasFast) wire.reject(r.index, r.offset, r.length)
        }
      }
      q.pending = keep
    }
  }

  private peerOf(wire: Wire): PeerLike | null {
    const peers = (this.t as unknown as { _peers: Map<string, PeerLike> | null })._peers
    for (const p of peers?.values() ?? []) if (p.wire === wire) return p
    return null
  }

  private tick(): void {
    const t = now()
    for (const q of this.queues) {
      q.member ??= this.o.memberOf(q.wire)
      const dt = (t - q.lastRateAt) / 1000
      if (dt <= 0) continue
      let inst = (q.passed - q.lastPassed) / dt
      if (this.o.udx) {
        // the first reading only sets the base (the counters count from the connection's start)
        const known = this.refreshUdx(q)
        inst = known && q.lastAcked >= 0 ? (q.udxAcked - q.lastAcked) / dt : 0
        if (known) q.lastAcked = q.udxAcked
      }
      q.rate = 0.7 * q.rate + 0.3 * inst
      q.lastPassed = q.passed
      q.lastRateAt = t
    }
  }

  /** Release held requests: lowest class first, round-robin between wires, within each wire's cap and the rate. */
  pump(): void {
    if (this.pumping) {
      this.pumpQueued = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpQueued = false
        this.pumpOnce()
      } while (this.pumpQueued)
    } finally {
      this.pumping = false
    }
  }

  private pumpOnce(): void {
    const rate = this.o.rateBps()
    const t = now()
    if (rate !== null) {
      const depth = Math.max(BLOCK, (rate * this.o.burstMs) / 1000)
      this.budget = Math.min(depth, this.budget + (rate * (t - this.budgetAt)) / 1000)
    }
    this.budgetAt = t
    const n = this.queues.length
    if (this.o.udx) for (const q of this.queues) this.refreshUdx(q)
    for (;;) {
      if (rate !== null && this.budget <= 0) {
        if (this.queues.some((q) => q.pending.length > 0)) this.rateWaits++
        return
      }
      let best: { q: WireQueue; k: number; cls: number; i: number } | null = null
      for (let i = 0; i < n; i++) {
        const q = this.queues[(this.rr + i) % n] as WireQueue
        if (q.pending.length === 0 || q.wire.destroyed || q.wire._finished) continue
        if (this.queued(q) >= this.cap(q)) {
          this.capWaits++
          continue
        }
        const k = this.pick(q)
        const cls = this.o.urgent === 'global' ? this.o.classOf((q.pending[k] as Req).index) : 0
        if (!best || cls < best.cls) best = { q, k, cls, i }
      }
      if (!best) return
      const r = best.q.pending[best.k] as Req
      best.q.pending.splice(best.k, 1)
      if (best.k > 0) best.q.reordered++
      this.rr = (this.rr + best.i + 1) % Math.max(1, n)
      if (rate !== null) this.budget -= r.length
      this.release(best.q, r)
    }
  }

  private pick(q: WireQueue): number {
    if (this.o.urgent === 'off') return 0
    let best = 0
    let bestCls = 3
    for (let k = 0; k < q.pending.length; k++) {
      const c = this.o.classOf((q.pending[k] as Req).index)
      if (c < bestCls) {
        best = k
        bestCls = c
        if (c === 0) break
      }
    }
    return best
  }

  /** What bittorrent-protocol's _onRequest does after the choke check, with the response counted. */
  private release(q: WireQueue, r: Req): void {
    const wire = q.wire
    if (wire.amChoking && !(wire.hasFast && wire.allowedFastSet.includes(r.index))) {
      q.rejectedHeld++
      if (wire.hasFast) wire.reject(r.index, r.offset, r.length)
      return
    }
    q.reading += r.length
    q.released++
    q.releasedBytes += r.length
    this.o.onTrace?.('rel', r.index, wire)
    let settled = false
    const request = { piece: r.index, offset: r.offset, length: r.length, callback: null as unknown }
    const respond = (err: Error | null, buffer?: Uint8Array): void => {
      if (!settled) {
        settled = true
        q.reading -= r.length
      }
      if (request !== wire._pull(wire.peerRequests, r.index, r.offset, r.length)) {
        this.pump() // cancelled while it was read: nothing to send
        return
      }
      if (err || !buffer) {
        if (wire.hasFast) wire.reject(r.index, r.offset, r.length)
        this.pump()
        return
      }
      wire.piece(r.index, r.offset, buffer) // the wrapper above queues it in the fifo
      this.pump()
    }
    request.callback = respond
    wire.peerRequests.push(request)
    // WebTorrent answers every request of a seeder (store.get -> respond, also with an error); one it drops (a
    // block over 128 KiB) destroys the wire, which removes this queue
    wire.emit('request', r.index, r.offset, r.length, respond)
  }

  /**
   * A viewer's reader just blocked on a piece: reject (BEP 6) its held requests of class 2. They were never served,
   * so nothing is sent twice; WebTorrent cancels each reservation and refills the freed pipeline slots at once, in its
   * R6 order, whose head is now the blocked piece (ADR 0003 Finding 4: otherwise the request waits for a free slot).
   */
  preempt(member: string): number {
    let n = 0
    for (const q of this.queues) {
      if ((q.member ?? this.o.memberOf(q.wire)) !== member || !q.wire.hasFast) continue
      const keep: Req[] = []
      for (const r of q.pending) {
        if (this.o.classOf(r.index) < 2) keep.push(r)
        else {
          q.wire.reject(r.index, r.offset, r.length)
          n++
        }
      }
      q.pending = keep
    }
    this.preempted += n
    return n
  }

  /** cb once everything pushed into `wire` so far has left the throttle; returns the bytes ahead of it */
  watch(wire: Wire, cb: () => void): number | null {
    const q = this.queues.find((x) => x.wire === wire)
    if (!q) return null
    q.watchers.push({ end: q.pushed, cb })
    return q.pushed - q.passed
  }

  /** per-wire numbers for the 1 Hz samples */
  snapshot(): {
    member: string | null
    queued: number
    udxUnsent: number
    pending: number
    rate: number
    passed: number
    pushed: number
  }[] {
    return this.queues.map((q) => ({
      member: q.member ?? this.o.memberOf(q.wire),
      queued: this.queued(q),
      udxUnsent: q.udxUnsent,
      pending: q.pending.length,
      rate: Math.round(q.rate),
      passed: q.passed,
      pushed: q.pushed,
    }))
  }

  summary(): Record<string, unknown>[] {
    return this.queues.map((q) => ({
      member: (q.member ?? '').slice(0, 8),
      released: q.released,
      releasedMiB: Number((q.releasedBytes / 2 ** 20).toFixed(1)),
      cancelledHeld: q.cancelledHeld,
      rejectedHeld: q.rejectedHeld,
      reordered: q.reordered,
      maxQueuedKiB: Math.round(q.maxQueued / 1024),
      maxUdxUnsentKiB: Math.round(q.maxUdxUnsent / 1024),
      maxPending: q.maxPending,
      passedMiB: Number((q.passed / 2 ** 20).toFixed(1)),
    }))
  }
}
