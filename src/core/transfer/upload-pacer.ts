/** One viewer's connection, as the pacer reads it. */
export interface PacedStream {
  /** member id */
  id: string
  /** UDX's smoothed RTT of the stream, ms (0 before its first sample) */
  rttMs: number
  /** bytes the stream has transmitted so far: an idle stream's srtt is stale, so it is read only while this grows */
  bytesSent: number
  /** the stream itself: a member that re-attaches over a new connection starts its delay history over */
  stream: object
}

export interface UploadPacerDeps {
  /** the paced rate changed (rateBps) */
  apply(): void
  /** bytes the host's upload has handed to its connections so far */
  sentBytes(): number
  /** every viewer's UDX stream (the room's connections; each carries the bt lane) */
  streams(): readonly PacedStream[]
  /** ms clock; tests inject one */
  now?: () => number
}

export type PacerState = 'start' | 'steady'

export const PACER_TICK_MS = 100
/** Each stream's srtt is read this often while it sends. */
export const PACER_SAMPLE_MS = 50
/** The queueing delay the pacer aims for, ms: as `pxjitd` in ADR 0006 §2.4. */
const TARGET_MS = 20
/** The paced rate never goes below this, bytes/s. */
const MIN_BPS = 250_000
/** A new session's start phase begins here, bytes/s. */
export const START_BPS = 1_000_000
const START_GAIN = 1.3
/** A viewer's base delay is the lowest of the last minute, kept as the lowest of each 2 s. */
const BUCKET_MS = 2000
const BASE_WINDOW_MS = 60_000
/** Its current delay is the lowest of the last 500 ms (LEDBAT's current-delay filter). */
const CURRENT_MS = 500
/** A cut takes this share of the rate per target's worth of queueing delay... */
const CUT_PER_TARGET = 0.05
/** ...and leaves at least this much. */
const CUT_FLOOR = 0.8
const CUT_HOLD_MS = 2000
/** A cut within CUT_HOLD_MS of the last one needs the queue to have grown this much since. */
const RECUT_GROWTH = 1.5
/** In start, never above CAP_OVER × the best upload of the last CAP_WINDOW_MS, plus CAP_SLACK_BPS. */
const CAP_WINDOW_MS = 2000
const CAP_OVER = 1.25
const CAP_SLACK_BPS = 64_000
/** Growth per tick × (target − queue) / target: below 0.9 × the rate of the last cut, up to it, and above it. */
const GROW_FAR = 0.02
const GROW_NEAR = 0.004
const GROW_PROBE = 0.008
/** The rate binds when what got through is at least this share of it. */
const BINDING = 0.8
/** The upload over the last this many ms is the pacer's measure of it. */
const UP_WINDOW_MS = 500
/** After the upload stayed under half the rate this long (nothing to send), the pacer starts over (ADR 0006 §6.2). */
const IDLE_RESET_MS = 5000

interface ViewerDelay {
  /** samples of the last CURRENT_MS */
  recent: { at: number; d: number }[]
  /** the lowest sample of each BUCKET_MS, over the last BASE_WINDOW_MS */
  buckets: { start: number; min: number }[]
  /** bytesSent at the last read */
  sent: number
  /** the stream it was read from (null: samples given directly) */
  stream: object | null
}

/**
 * The host's upload pacer (ADR 0006 §5.2, §6.2): a delay-based controller, LEDBAT-like, on the upload scheduler's rate.
 * When the host's real uplink, not the app's limit, is the bottleneck, queues build in the host's network stack and
 * router, and the room's ctrl messages and sync datagrams wait in them (ADR 0002: ctrl p95 +3.8 s at a saturated
 * 50 Mbit/s). The pacer keeps that queue near 20 ms by setting the rate the scheduler releases at.
 *
 * Signal, per viewer: UDX's smoothed RTT of its stream, read every 50 ms while the stream sends. Only differences from
 * the lowest seen matter: base = the lowest of the last 60 s (2 s buckets), current = the lowest of the last 500 ms
 * (long enough to ignore one stream's stall: UDX's BBR drops a stream to a 4-packet window now and then). The
 * queueing delay is the median of (current − base) over viewers: the uplink delays every stream alike, one stream's
 * trouble only its own. Without any stream to read (a connection that is not UDX) there is no rate: nothing to pace.
 *
 * Control, every 100 ms. A plain proportional law overshot and then cut to 60 % of the link (S2b smoke runs); this one
 * remembers where the queue appeared (CUBIC's W_max):
 * - start: ×1.3 per tick while the queue is under target/2 and the rate binds; the first queue at target/2 or more
 *   sets wmax = rate, takes the rate to 90 % of what got through, and goes steady;
 * - queue above target: wmax = rate, and the rate drops 5 % per target's worth of queue (at most 20 %). Not again for
 *   2 s unless the queue grew by half: draining a queue takes time, and a second cut 500 ms later took the rate to
 *   75 % of the link;
 * - otherwise, while the rate binds: grow by 2 % × (target − queue) / target per tick below 0.9 × wmax, 0.4 % up to
 *   wmax, and probe above it at 0.8 % (more capacity may have appeared);
 * - in start, at most 1.25 × the best upload of the last 2 s + 64 KB/s (the cap), so the probe never runs far ahead
 *   of what gets through. What got through lags the rate, so the cap, not ×1.3, sets the ramp: ~×1.1 per tick (1 to
 *   4 MB/s in ~1.5 s), as in the spike. Never below the rate start began from: 1 MB/s for a new session (ctrl
 *   traffic gives the first samples before any data moves, and the cap would begin every session at the floor);
 * - a steady rate is not capped: through a pause (little to send) it stays where the queue put it, and the upload
 *   comes back at that rate at once. The spike capped it too, which left it at the floor after 2 s of quiet and took
 *   15 s at 2 % per tick to get back 4 MB/s. The scheduler's token bucket is 20 ms deep, so a rate nobody uses
 *   cannot leave as a burst; if the uplink lost capacity meanwhile, the next cut finds out;
 * - after the upload stayed under half the rate for 5 s (nothing to send), back to start from the current rate: the
 *   burst after a long pause probes for more capacity;
 * - always at least 250 KB/s.
 * Measured (`pxjitd`, ADR 0006 §3): ctrl RTT p50 46 / 42 ms at a saturated 20 / 50 Mbit/s (idle 31; as shipped
 * 427 / 220), 98-99 % of the shipped throughput. Its p95 (127 / 157 ms) comes from this cycle (Follow-up 6).
 */
export class UploadPacer {
  private rate = START_BPS
  private mode: PacerState = 'start'
  private hasSignal = false
  /** the rate at which the queue last went above target */
  private wmax = Number.POSITIVE_INFINITY
  private lastCut = Number.NEGATIVE_INFINITY
  private qAtCut = 0
  private queue: number | null = null
  /** the upload counter over the last UP_WINDOW_MS, and the upload rate per tick over the last CAP_WINDOW_MS */
  private readonly sent: { at: number; bytes: number }[] = []
  private readonly ups: { at: number; up: number }[] = []
  /** since when the upload stayed under half the rate (null: it did not) */
  private lowSince: number | null = null
  /** in start, the cap never takes the rate below this: what the start phase began from */
  private startFloor = START_BPS
  private readonly viewers = new Map<string, ViewerDelay>()
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private readonly now: () => number

  constructor(private readonly d: UploadPacerDeps) {
    this.now = d.now ?? (() => performance.now())
  }

  /** The paced rate, bytes/s; null until a stream gave a delay sample. */
  get rateBps(): number | null {
    return this.hasSignal ? this.rate : null
  }

  get state(): PacerState {
    return this.mode
  }

  /** The queueing delay estimate of the last tick, ms; null without fresh samples. */
  get queueMs(): number | null {
    return this.queue
  }

  start(): void {
    if (this.timers.length > 0) return
    this.timers.push(setInterval(() => this.poll(), PACER_SAMPLE_MS))
    this.timers.push(setInterval(() => this.tick(), PACER_TICK_MS))
  }

  destroy(): void {
    for (const t of this.timers.splice(0)) clearInterval(t)
  }

  /** Read each stream's srtt, if it sent anything since the last read (every 50 ms once started). */
  poll(): void {
    const at = this.now()
    const seen = new Set<string>()
    for (const s of this.d.streams()) {
      seen.add(s.id)
      let v = this.viewers.get(s.id)
      if (!v || v.stream !== s.stream) {
        // a new member, or one that re-attached: its old base delay may belong to another path
        v = { recent: [], buckets: [], sent: -1, stream: s.stream }
        this.viewers.set(s.id, v)
      }
      if (s.rttMs > 0 && s.bytesSent !== v.sent) this.sample(s.id, s.rttMs, at)
      v.sent = s.bytesSent
    }
    for (const id of this.viewers.keys()) if (!seen.has(id)) this.viewers.delete(id) // left
  }

  /** A delay sample to viewer `id` (ms; any constant offset cancels out). */
  sample(id: string, delayMs: number, at: number): void {
    let v = this.viewers.get(id)
    if (!v) {
      v = { recent: [], buckets: [], sent: -1, stream: null }
      this.viewers.set(id, v)
    }
    this.hasSignal = true
    v.recent.push({ at, d: delayMs })
    while (v.recent.length > 0 && (v.recent[0] as { at: number }).at < at - CURRENT_MS) v.recent.shift()
    const start = Math.floor(at / BUCKET_MS) * BUCKET_MS
    const last = v.buckets[v.buckets.length - 1]
    if (last && last.start === start) last.min = Math.min(last.min, delayMs)
    else v.buckets.push({ start, min: delayMs })
    while (v.buckets.length > 0 && (v.buckets[0] as { start: number }).start < at - BASE_WINDOW_MS) v.buckets.shift()
  }

  /** One control step (every 100 ms once started). */
  tick(): void {
    const at = this.now()
    const up = this.uploadBps(at)
    this.ups.push({ at, up })
    while (this.ups.length > 0 && (this.ups[0] as { at: number }).at < at - CAP_WINDOW_MS) this.ups.shift()
    const q = this.estimate(at)
    this.queue = q
    if (!this.hasSignal) return
    if (up < this.rate / 2) {
      this.lowSince ??= at
      if (this.mode === 'steady' && at - this.lowSince >= IDLE_RESET_MS) {
        this.mode = 'start'
        this.wmax = Number.POSITIVE_INFINITY
        this.startFloor = this.rate
      }
    } else {
      this.lowSince = null
    }
    const binding = up >= BINDING * this.rate
    if (q !== null) {
      if (this.mode === 'start') {
        if (q < TARGET_MS / 2) {
          if (binding) this.rate *= START_GAIN
        } else {
          this.mode = 'steady'
          this.wmax = this.rate
          this.rate = 0.9 * Math.min(this.rate, up)
          this.lastCut = at
          this.qAtCut = q
        }
      } else if (q > TARGET_MS) {
        if (at - this.lastCut >= CUT_HOLD_MS || q > RECUT_GROWTH * this.qAtCut) {
          this.wmax = this.rate
          this.rate *= Math.max(CUT_FLOOR, 1 - (CUT_PER_TARGET * q) / TARGET_MS)
          this.lastCut = at
          this.qAtCut = q
        }
      } else if (binding) {
        const off = (TARGET_MS - q) / TARGET_MS
        const g = this.rate < 0.9 * this.wmax ? GROW_FAR : this.rate < this.wmax ? GROW_NEAR : GROW_PROBE
        this.rate *= 1 + g * off
      }
    }
    if (this.mode === 'start') {
      const recent = Math.max(...this.ups.map((u) => u.up))
      this.rate = Math.min(this.rate, Math.max(this.startFloor, CAP_OVER * recent + CAP_SLACK_BPS))
    }
    this.rate = Math.max(MIN_BPS, this.rate)
    this.d.apply()
  }

  /** The queueing delay now (ms): the median over viewers with fresh samples; null without any. */
  private estimate(at: number): number | null {
    const qs: number[] = []
    for (const v of this.viewers.values()) {
      let current = Number.POSITIVE_INFINITY
      for (const s of v.recent) if (s.at >= at - CURRENT_MS) current = Math.min(current, s.d)
      if (current === Number.POSITIVE_INFINITY || v.buckets.length === 0) continue
      let base = Number.POSITIVE_INFINITY
      for (const b of v.buckets) base = Math.min(base, b.min)
      qs.push(Math.max(0, current - base))
    }
    if (qs.length === 0) return null
    qs.sort((x, y) => x - y)
    return qs[Math.floor((qs.length - 1) / 2)] ?? null
  }

  /** The host's upload over the last 500 ms, bytes/s. */
  private uploadBps(at: number): number {
    this.sent.push({ at, bytes: this.d.sentBytes() })
    while (this.sent.length > 1 && (this.sent[0] as { at: number }).at < at - UP_WINDOW_MS) this.sent.shift()
    const first = this.sent[0] as { at: number; bytes: number }
    const last = this.sent[this.sent.length - 1] as { at: number; bytes: number }
    return last.at - first.at > 50 ? ((last.bytes - first.bytes) * 1000) / (last.at - first.at) : 0
  }
}
