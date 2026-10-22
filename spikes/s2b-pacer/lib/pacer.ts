// A delay-based upload pacer (LEDBAT-like) for the host. Prototype for ADR 0006 (S2b); nothing here is in src.
//
// Signal, per viewer, LEDBAT-style: only differences from the lowest delay seen matter, so a clock offset between
// host and viewer cancels out (here every process shares one clock anyway). Three kinds:
//   'ctrl'  the one-way delay of a ping on the room's ctrl lane (host -> viewer, 100 ms apart, the viewer stamps
//           it): it waits behind everything queued on that connection - the netem queue in front of the uplink AND
//           UDX's send queue of the stream that also carries the bt lane (S2b found the second dominates: ~350 ms
//           at 20 Mbit/s while the netem queue held ~75 ms);
//   'dgram' the one-way delay of a datagram ping: it skips the stream, so it sees only the network queue;
//   'udx'   UDX's own smoothed RTT of the viewer's stream (rawStream.rtt, sampled every 50 ms while the stream
//           sends): the network queue on the data's path, with no probe traffic at all - what the app could read.
// Per viewer: base = the lowest delay of the last 60 s (2 s buckets; the idle pings before the transfer seed it);
// current = the lowest of the last 500 ms (LEDBAT's current-delay filter, long enough to ignore one stream's stall:
// UDX's BBR drops a stream to a 4-packet window now and then, which holds that lane's ctrl frames 250-350 ms and
// then floods the uplink for ~300 ms; no rate setting prevents that). The queueing delay is the median of
// (current - base) over viewers: the uplink queue delays every lane alike, one stream's trouble only its own.
//
// Control, every 100 ms, on the rate of WebTorrent's upload throttle (TransferEngine.setUploadLimit). A plain
// proportional law (rate x (1 + k x off)) overshot by ~5 % and then cut to 60 % of the link: the queue signal lags
// the rate by the 300 ms filter plus a round trip, so it oscillated at 77 % of the link (S2b smoke runs). This one
// remembers where the queue appeared (CUBIC's W_max idea):
//   start:  x1.3 per tick while the queue is under target/2 and the throttle is what limits the upload; the first
//           queue at target/2 or more sets wmax = rate, the rate to 90 % of what got through, and switches to steady;
//   queue above target: wmax = rate and the rate drops by 5 % per target's worth of queue (95 % just above the
//           target, 90 % at twice it, never below 80 %). Not again for 2 s unless the queue grew by half since that
//           cut: draining a queue takes (capacity - rate) time, and a second cut 500 ms later (the first version) took
//           the rate to 75 % of the link; a flat 10 % cut averaged 88 % of the link;
//   otherwise, while the throttle binds: grow by off x 2 % per tick below 0.9 wmax, 0.4 % up to wmax, and probe
//           above it at 0.8 % (more capacity may have appeared), with off = (target - queue) / target;
//   always: at most 1.25 x the most that got through in the last 2 s (+ 64 KB/s), so a rate the link or the
//           viewers do not use cannot pile up and leave as a burst later.
// The throttle's token bucket is cut from WebTorrent's 1 s of rate to burstS (50 ms) in 16 KiB slices (member.ts),
// so a paced rate cannot leave as a one-second burst after a pause.
import type { PacerConfig } from './proto.js'

const TICK_MS = 100
const BUCKET_MS = 2000
const BASE_WINDOW_MS = 60_000
const CURRENT_MS = 500
const START_BPS = 1_000_000
const START_GAIN = 1.3
/** a cut takes this share of the rate per target's worth of queueing delay... */
const CUT_PER_TARGET = 0.05
/** ...and leaves at least this much */
const CUT_FLOOR = 0.8
const CUT_HOLD_MS = 2000
/** a cut within CUT_HOLD_MS of the last one needs the queue to have grown this much since */
const RECUT_GROWTH = 1.5
const CAP_WINDOW_MS = 2000
const CAP_OVER = 1.25
const CAP_SLACK_BPS = 64_000
const GROW_FAR = 0.02
const GROW_NEAR = 0.004
const GROW_PROBE = 0.008
/** the throttle binds when what got through is at least this share of the rate */
const BINDING = 0.8

interface ViewerDelay {
  recent: { at: number; d: number }[]
  buckets: { start: number; min: number }[]
}

export interface PacerTick {
  at: number
  rate: number
  queueMs: number | null
  upBps: number
  state: 'start' | 'steady'
}

export type PacerSignal = 'ctrl' | 'dgram' | 'udx'

export class DelayPacer {
  rate = START_BPS
  state: 'start' | 'steady' = 'start'
  /** the rate at which the queue last went above target */
  wmax = Number.POSITIVE_INFINITY
  private lastCut = Number.NEGATIVE_INFINITY
  private qAtCut = 0
  private readonly ups: { at: number; up: number }[] = []
  readonly ticks: PacerTick[] = []
  private readonly viewers = new Map<string, ViewerDelay>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly cfg: PacerConfig,
    /** sets the throttle to bytes/s */
    private readonly apply: (bps: number) => void,
    /** the host's upload past the throttle, bytes/s, over the last ~0.5 s */
    private readonly upBps: () => number,
    private readonly clock: () => number,
  ) {}

  start(): void {
    this.apply(this.rate)
    this.timer ??= setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** a one-way delay sample to viewer `id` (ms, any constant clock offset) from a ping of kind `signal` */
  sample(signal: PacerSignal, id: string, delay: number, at: number): void {
    if (signal !== this.cfg.signal) return
    let v = this.viewers.get(id)
    if (!v) {
      v = { recent: [], buckets: [] }
      this.viewers.set(id, v)
    }
    v.recent.push({ at, d: delay })
    while (v.recent.length > 0 && (v.recent[0] as { at: number }).at < at - this.currentMs) v.recent.shift()
    const start = Math.floor(at / BUCKET_MS) * BUCKET_MS
    const last = v.buckets[v.buckets.length - 1]
    if (last && last.start === start) last.min = Math.min(last.min, delay)
    else v.buckets.push({ start, min: delay })
    while (v.buckets.length > 0 && (v.buckets[0] as { start: number }).start < at - BASE_WINDOW_MS) v.buckets.shift()
  }

  /** the queueing delay estimate now (ms): the median over viewers with fresh samples; null without any */
  estimate(at: number): number | null {
    const qs: number[] = []
    for (const v of this.viewers.values()) {
      const fresh = v.recent.filter((s) => s.at >= at - this.currentMs)
      if (fresh.length === 0 || v.buckets.length === 0) continue
      const base = Math.min(...v.buckets.map((b) => b.min))
      qs.push(Math.max(0, Math.min(...fresh.map((s) => s.d)) - base))
    }
    if (qs.length === 0) return null
    qs.sort((x, y) => x - y)
    return qs[Math.floor((qs.length - 1) / 2)] as number
  }

  private get currentMs(): number {
    return this.cfg.currentMs ?? CURRENT_MS
  }

  tick(): void {
    const at = this.clock()
    const q = this.estimate(at)
    const up = this.upBps()
    this.ups.push({ at, up })
    while (this.ups.length > 0 && (this.ups[0] as { at: number }).at < at - CAP_WINDOW_MS) this.ups.shift()
    const binding = up >= BINDING * this.rate
    const target = this.cfg.targetMs
    if (q !== null) {
      if (this.state === 'start') {
        if (q < target / 2) {
          if (binding) this.rate *= START_GAIN
        } else {
          this.state = 'steady'
          this.wmax = this.rate
          this.rate = 0.9 * Math.min(this.rate, up)
          this.lastCut = at
          this.qAtCut = q
        }
      } else if (q > target) {
        if (at - this.lastCut >= (this.cfg.holdMs ?? CUT_HOLD_MS) || q > RECUT_GROWTH * this.qAtCut) {
          this.wmax = this.rate
          this.rate *= Math.max(CUT_FLOOR, 1 - (CUT_PER_TARGET * q) / target)
          this.lastCut = at
          this.qAtCut = q
        }
      } else if (binding) {
        const off = (target - q) / target
        const probe = this.cfg.probe ?? GROW_PROBE
        const g = this.rate < 0.9 * this.wmax ? GROW_FAR : this.rate < this.wmax ? GROW_NEAR : probe
        this.rate *= 1 + g * off
      }
    }
    const recent = Math.max(...this.ups.map((u) => u.up))
    this.rate = Math.min(this.rate, CAP_OVER * recent + CAP_SLACK_BPS)
    this.rate = Math.max(this.cfg.minBps, this.rate)
    this.apply(this.rate)
    this.ticks.push({
      at,
      rate: Math.round(this.rate),
      queueMs: q === null ? null : Number(q.toFixed(1)),
      upBps: Math.round(up),
      state: this.state,
    })
  }
}
