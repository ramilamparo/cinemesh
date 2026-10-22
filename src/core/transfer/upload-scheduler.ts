import type { Torrent, Wire } from 'webtorrent'

/** 0 = a piece some viewer's reader is blocked on, 1 = the group's hot window or a critical range, 2 = the rest */
export type RequestClass = 0 | 1 | 2

export interface UploadSchedulerDeps {
  /** member id behind a host wire (the engine's stream -> peer map); null until known */
  memberOf(wire: Wire): string | null
  classOf(piece: number): RequestClass
  /**
   * The UDX stream under the wire's connection: bytes handed to it that it has not sent, and bytes it got
   * acknowledged so far (patches/udx-native+1.21.3.patch). null until known, or on a connection that is not UDX.
   */
  transport(wire: Wire): { unsentBytes: number; ackedBytes: number } | null
  /** a request arrived and is held (the Revealer's activity clock); false refuses it (BEP 6 reject) */
  onArrival(wire: Wire, piece: number): boolean
  /** ms clock; tests inject one */
  now?: () => number
}

export interface UploadSchedulerStats {
  /** the release rate, bytes/s; null = none (only the per-wire queue caps) */
  rateBps: number | null
  /** requests held, every wire */
  held: number
  /** released and not sent yet, every wire: being read, in the wire, in UDX's send queue */
  queuedBytes: number
  /** requests released, refused on arrival, and rejected by preempt, since the start */
  released: number
  refused: number
  preempted: number
}

const QUEUE_TICK_MS = 50
/** A held request goes out only while its wire's queue is under this much of the wire's drain rate... */
const QUEUE_MS = 100
/** ...or under this, whatever the rate (a fresh wire has none yet) */
const MIN_QUEUE_BYTES = 32 * 1024
/** EWMA weight per tick of a wire's drain rate */
const RATE_ALPHA = 0.3
/** With a rate: the release token bucket's depth, ms of the rate. */
const BURST_MS = 20
/** While anything is held, releases are re-checked this often (the bucket refills; UDX acks fire no event). */
const PACE_MS = 5
/**
 * A wire with held requests that got nothing for this long takes the next release, whatever its class: a viewer's
 * WebTorrent drops a wire after 30 s without an answer (torrent.js PIECE_TIMEOUT), and a steady stream of urgent
 * requests to other viewers must not starve it.
 */
const AGING_MS = 2000
const BLOCK = 16 * 1024
/** WebTorrent drops a wire that asks for more in one request (torrent.js MAX_BLOCK_LENGTH) */
const MAX_REQUEST_BYTES = 128 * 1024
/** Twice the reqq we announce (engine.ts REQQ): a wire that keeps more outstanding gets the rest refused. */
const MAX_HELD = 512

/** WebTorrent's peer: its 'upload' Transform counts what the wire hands to the connection (peer.js:135-155). */
interface UploadingPeer {
  wire: Wire | null
  on(event: 'upload', cb: (bytes: number) => void): unknown
  removeListener(event: 'upload', cb: (bytes: number) => void): unknown
}

interface Lane {
  wire: Wire
  peer: UploadingPeer | null
  member: string | null
  /** released, still being read from the store (bytes) */
  reading: number
  /** wire.pushedBytes when the lane began, and the bytes that crossed the peer's 'upload' Transform since */
  pushedBase: number
  passed: number
  /** handed to UDX and not sent yet, at the last reading */
  unsent: number
  /** UDX's acked counter at the last tick; null until the first reading (it counts from the connection's start) */
  acked: number | null
  /** `passed` at the last tick */
  lastPassed: number
  /** EWMA of what drained (UDX acks, else what crossed the 'upload' Transform), bytes/s */
  rate: number
  /** the last release, or when the lane began holding: the aging clock */
  servedAt: number
  onHeld: (index: number, offset: number, length: number) => void
  onUpload: (bytes: number) => void
}

/**
 * The host's upload scheduler (ADR 0006 §6.1). As shipped, bittorrent-protocol answers every request at once:
 * WebTorrent reads the store, and the block waits in the wire's buffer, WebTorrent's upload throttle (a token bucket a
 * second deep, unfair between wires) and UDX's send queue, where a cancel cannot reach it and a 'have', a blocked
 * reader's request and the room's ctrl frames queue behind it (ADR 0006 finding 1: 1.9 s for a blocked read at
 * 1 MB/s with 3 viewers).
 *
 * Here every request is held (the hold mode of patches/bittorrent-protocol+5.0.9.patch) and released, exactly as
 * upstream would answer it ('request' with a respond callback, so WebTorrent's store read, the engine's served-block
 * count and the Revealer's hooks are unchanged), when
 * - its wire's queue is under max(32 KiB, 100 ms of the wire's drain rate). The queue is what was released and is
 *   still being read, plus what was pushed into the wire and has not crossed WebTorrent's 'upload' Transform, plus
 *   what the connection handed to UDX and UDX has not sent (UDX takes ~256 KiB per stream before it pushes back,
 *   whatever its congestion window allows). The drain rate is what UDX got acknowledged. So data is committed to a
 *   connection only when it can leave soon, and a stream that stalls stops being fed at once; and
 * - with a rate (the app's limit, or the pacer's), the scheduler's own token bucket (20 ms deep) has tokens.
 *   WebTorrent's throttle stays off on the host.
 *
 * Order: class 0 (a piece some viewer's reader is blocked on), then 1 (the hot window, critical ranges), then 2,
 * across wires: the urgent wire gets the whole rate for a moment. FIFO within a class on a wire (the viewer's own R6
 * order), round-robin between wires. A wire that got nothing for 2 s while holding goes first (aging).
 *
 * A request is offered to onArrival first: one the Revealer does not advertise to that wire is refused there and
 * never held. A cancel drops a held request, a choke rejects held ones (BEP 6), as upstream does with queued ones.
 * preempt() rejects a viewer's held class-2 requests when its reader blocks on a new piece: they were never served, so
 * nothing is sent twice, and its WebTorrent refills the freed pipeline slots at once, the blocked piece first.
 */
export class UploadScheduler {
  private readonly lanes: Lane[] = []
  private rate: number | null = null
  private tokens = 0
  private tokensAt: number
  private lastTick: number
  /** where the next round-robin pass starts */
  private rr = 0
  private pumping = false
  /** pump() calls so far: one made while it ran makes it run again */
  private pumpCalls = 0
  private started = false
  private ticker: ReturnType<typeof setInterval> | null = null
  private paceTimer: ReturnType<typeof setInterval> | null = null
  private released = 0
  private refused = 0
  private preempted = 0
  /** every byte any wire handed to its connection, closed wires included */
  private sent = 0
  private readonly now: () => number

  constructor(
    private readonly t: Torrent,
    private readonly d: UploadSchedulerDeps,
  ) {
    this.now = d.now ?? (() => performance.now())
    this.tokensAt = this.now()
    this.lastTick = this.tokensAt
    t.on('wire', this.onWire)
  }

  /** Bytes the host's wires handed to their connections so far: the pacer's upload counter. */
  get sentBytes(): number {
    return this.sent
  }

  start(): void {
    this.started = true
    this.ticker ??= setInterval(() => this.tick(), QUEUE_TICK_MS)
    this.arm()
  }

  /** Stops holding (the torrent is going): what is still held is refused, as a choke would, so nothing is read for it. */
  destroy(): void {
    this.started = false
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.arm()
    this.t.removeListener('wire', this.onWire)
    for (const l of this.lanes.splice(0)) {
      l.wire.removeListener('request-held', l.onHeld)
      l.peer?.removeListener('upload', l.onUpload)
      l.wire.holdRequests = false
      for (const r of [...l.wire.heldRequests]) l.wire.refuseRequest(r.piece, r.offset, r.length)
    }
  }

  /** bytes/s: the manual limit and the pacer's rate, whichever is lower; null = none (per-wire caps only) */
  setRate(bps: number | null): void {
    this.rate = bps !== null && bps > 0 ? bps : null
    this.pump()
  }

  /**
   * Reject (BEP 6) the held class-2 requests of member `id`, whose reader just blocked on a new piece; its WebTorrent
   * refills those slots at once in its R6 order, whose head is now that piece. Returns how many. Not on a wire without
   * the fast extension: a request it drops is only failed by the viewer's 30 s timeout.
   */
  preempt(id: string): number {
    let n = 0
    for (const l of this.lanes) {
      if (this.memberOf(l) !== id || !l.wire.hasFast) continue
      for (const r of [...l.wire.heldRequests]) {
        if (this.d.classOf(r.piece) === 2 && l.wire.refuseRequest(r.piece, r.offset, r.length)) n++
      }
    }
    this.preempted += n
    return n
  }

  stats(): UploadSchedulerStats {
    let held = 0
    let queuedBytes = 0
    for (const l of this.lanes) {
      held += l.wire.heldRequests.length
      queuedBytes += this.queued(l)
    }
    return {
      rateBps: this.rate,
      held,
      queuedBytes,
      released: this.released,
      refused: this.refused,
      preempted: this.preempted,
    }
  }

  /** Every 50 ms once started: each wire's drain rate. */
  tick(): void {
    const now = this.now()
    const dt = (now - this.lastTick) / 1000
    this.lastTick = now
    if (dt <= 0) return
    for (const l of this.lanes) {
      const u = this.d.transport(l.wire)
      let drained = l.passed - l.lastPassed
      if (u) {
        l.unsent = Math.max(0, u.unsentBytes)
        drained = l.acked === null ? 0 : u.ackedBytes - l.acked
        l.acked = u.ackedBytes
      }
      l.lastPassed = l.passed
      l.rate = (1 - RATE_ALPHA) * l.rate + (RATE_ALPHA * Math.max(0, drained)) / dt
    }
    this.pump()
  }

  /** Release what is due: lowest class first, round-robin between wires, within each wire's cap and the rate. */
  pump(): void {
    this.pumpCalls++
    if (this.pumping) return // a release answered at once, or a wire closed: the loop below runs again
    this.pumping = true
    try {
      let seen
      do {
        seen = this.pumpCalls
        this.releaseDue()
      } while (this.pumpCalls !== seen)
    } finally {
      this.pumping = false
    }
    this.arm()
  }

  private readonly onWire = (wire: Wire): void => {
    const peer = this.peerOf(wire)
    const lane: Lane = {
      wire,
      peer,
      member: null,
      reading: 0,
      pushedBase: wire.pushedBytes,
      passed: 0,
      unsent: 0,
      acked: null,
      lastPassed: 0,
      rate: 0,
      servedAt: this.now(),
      onHeld: (index, offset, length) => this.onHeld(lane, index, offset, length),
      onUpload: (bytes) => {
        lane.passed += bytes
        this.sent += bytes
        this.pump()
      },
    }
    this.lanes.push(lane)
    wire.holdRequests = true
    wire.on('request-held', lane.onHeld)
    peer?.on('upload', lane.onUpload)
    wire.once('close', () => {
      peer?.removeListener('upload', lane.onUpload)
      const k = this.lanes.indexOf(lane)
      if (k >= 0) this.lanes.splice(k, 1)
      this.pump()
    })
  }

  private onHeld(l: Lane, index: number, offset: number, length: number): void {
    const wire = l.wire
    if (!this.d.onArrival(wire, index) || wire.heldRequests.length > MAX_HELD) {
      wire.refuseRequest(index, offset, length)
      this.refused++
      return
    }
    if (length > MAX_REQUEST_BYTES) {
      wire.releaseRequest(index, offset, length) // as upstream: WebTorrent drops the wire, nothing is read
      return
    }
    if (wire.heldRequests.length === 1) l.servedAt = this.now() // it starts waiting now
    this.pump()
  }

  private releaseDue(): void {
    const now = this.now()
    const rate = this.rate
    if (rate !== null) {
      const depth = Math.max(BLOCK, (rate * BURST_MS) / 1000)
      this.tokens = Math.min(depth, this.tokens + (rate * (now - this.tokensAt)) / 1000)
    }
    this.tokensAt = now
    for (const l of this.lanes) {
      const u = this.d.transport(l.wire)
      if (u) l.unsent = Math.max(0, u.unsentBytes)
    }
    for (;;) {
      if (rate !== null && this.tokens <= 0) return
      const n = this.lanes.length // a release can close a wire
      let best: { lane: Lane; k: number; rank: number; i: number } | null = null
      for (let i = 0; i < n; i++) {
        const lane = this.lanes[(this.rr + i) % n] as Lane
        if (lane.wire.heldRequests.length === 0 || lane.wire.destroyed) continue
        if (this.queued(lane) >= this.cap(lane)) continue
        const { k, cls } = this.pick(lane)
        const rank = now - lane.servedAt >= AGING_MS ? -1 : cls
        if (!best || rank < best.rank) best = { lane, k, rank, i }
        if (rank < 0) break
      }
      if (!best) return
      const r = best.lane.wire.heldRequests[best.k] as { piece: number; offset: number; length: number }
      this.rr = (this.rr + best.i + 1) % n
      if (rate !== null) this.tokens -= r.length
      this.release(best.lane, r.piece, r.offset, r.length, now)
    }
  }

  /** The wire's next request: its oldest of the lowest class it holds. */
  private pick(l: Lane): { k: number; cls: number } {
    const held = l.wire.heldRequests
    let k = 0
    let cls = 3
    for (let j = 0; j < held.length; j++) {
      const c = this.d.classOf((held[j] as { piece: number }).piece)
      if (c < cls) {
        k = j
        cls = c
        if (c === 0) break
      }
    }
    return { k, cls }
  }

  private release(l: Lane, piece: number, offset: number, length: number, now: number): void {
    l.reading += length
    l.servedAt = now
    this.released++
    const answered = l.wire.releaseRequest(piece, offset, length, () => {
      l.reading -= length
      this.pump()
    })
    if (!answered) l.reading -= length
  }

  private queued(l: Lane): number {
    // without the peer nothing counts what left the wire, so only the store reads and UDX's queue are known
    const inWire = l.peer ? Math.max(0, l.wire.pushedBytes - l.pushedBase - l.passed) : 0
    return l.reading + inWire + l.unsent
  }

  private cap(l: Lane): number {
    return Math.max(MIN_QUEUE_BYTES, (l.rate * QUEUE_MS) / 1000)
  }

  private memberOf(l: Lane): string | null {
    l.member ??= this.d.memberOf(l.wire)
    return l.member
  }

  /** The 5 ms re-check runs only while started and something is held. */
  private arm(): void {
    const due = this.started && this.lanes.some((l) => l.wire.heldRequests.length > 0)
    if (due && !this.paceTimer) this.paceTimer = setInterval(() => this.pump(), PACE_MS)
    else if (!due && this.paceTimer) {
      clearInterval(this.paceTimer)
      this.paceTimer = null
    }
  }

  /**
   * WebTorrent's peer that owns the wire ('wire' fires from the peer's handshake handler, so it is in _peers). Without
   * one the wire's queue counts only what is being read and what UDX has not sent.
   */
  private peerOf(wire: Wire): UploadingPeer | null {
    for (const p of this.t._peers?.values() ?? []) if (p.wire === wire) return p as unknown as UploadingPeer
    return null
  }
}
