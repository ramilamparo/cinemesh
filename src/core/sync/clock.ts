import type { Clock, TimerHandle } from './ports.js'

// NTP-style offset between a member's monotonic clock and the host's (plan §4.5 Clock).
// θ = host − local, so hostTime = localTime + θ̂.

export const CLOCK = {
  WINDOW: 12,
  MAX_SLEW_MS: 20,
  AGREE_N: 3,
  /** a change at least this big counts as a jump: the drift loop skips for 3 s after one */
  JUMP_MS: 15,
  POOR_MS: 150,
  BURST_N: 5,
  BURST_MS: 100,
  FAST_MS: 1000,
  FAST_FOR_MS: 20_000,
  SLOW_MS: 5000,
  LOSS_TIMEOUT_MS: 2000,
  LOSSES_TO_FALLBACK: 6,
} as const

export interface ClockSample {
  /** local send */
  t0: number
  /** host receive */
  t1: number
  /** host send */
  t2: number
  /** local receive */
  t3: number
}

interface Measured {
  theta: number
  delta: number
}

export class OffsetEstimator {
  private samples: Measured[] = []
  private theta: number | null = null

  get offset(): number | null {
    return this.theta
  }

  /** ε = δmin/2: the bound on |θ̂ − θ| from the best sample in the window. */
  get errorMs(): number | null {
    if (this.samples.length === 0) return null
    return Math.min(...this.samples.map((s) => s.delta)) / 2
  }

  reset(): void {
    this.samples = []
    this.theta = null
  }

  /** Returns how far θ̂ moved. */
  add(s: ClockSample): number {
    const delta = Math.max(0, s.t3 - s.t0 - (s.t2 - s.t1))
    const theta = (s.t1 - s.t0 + (s.t2 - s.t3)) / 2
    this.samples.push({ theta, delta })
    if (this.samples.length > CLOCK.WINDOW) this.samples.shift()

    let best = this.samples[0] ?? { theta, delta }
    for (const m of this.samples) if (m.delta < best.delta) best = m
    const prev = this.theta
    if (prev === null) {
      this.theta = best.theta
      return Infinity
    }
    const diff = best.theta - prev
    // One unlucky low-δ sample (asymmetric queueing) must not yank the clock; three that confirm it may.
    const recent = this.samples.slice(-CLOCK.AGREE_N)
    const agree =
      recent.length === CLOCK.AGREE_N &&
      recent.every((m) => Math.abs(m.theta - best.theta) <= Math.max(10, (m.delta - best.delta) / 2 + 5))
    const step = agree ? diff : Math.max(-CLOCK.MAX_SLEW_MS, Math.min(CLOCK.MAX_SLEW_MS, diff))
    this.theta = prev + step
    return Math.abs(step)
  }
}

export type PingVia = 'datagram' | 'bus'

export interface ClockClientOptions {
  clock: Clock
  /** Send a ping; the transport is the caller's choice of datagram or bus. */
  send(via: PingVia, id: number, t0: number): void
  datagramUsable(): boolean
  /** θ̂ changed; jumped means by >= JUMP_MS (or the first estimate). */
  onOffset(theta: number, jumped: boolean): void
  /**
   * An estimate of the same host process to carry on from (a playlist's next item runs a new engine against the
   * same host clock); a fresh one otherwise.
   */
  estimator?: OffsetEstimator
}

/**
 * Pings the host on the plan's cadence: 5 at 100 ms on (re)connect, every 1 s for 20 s, then every 5 s.
 * Falls back to bus pings after 6 consecutive datagram losses, or whenever datagrams are unusable.
 */
export class ClockClient {
  readonly estimator: OffsetEstimator
  private timer: TimerHandle | null = null
  private readonly outstanding = new Map<number, { t0: number; via: PingVia; timer: TimerHandle }>()
  private nextId = 1
  private sentInBurst = 0
  private fastUntil = 0
  private losses = 0
  private fallback = false

  constructor(private readonly o: ClockClientOptions) {
    this.estimator = o.estimator ?? new OffsetEstimator()
  }

  get offset(): number | null {
    return this.estimator.offset
  }

  get errorMs(): number | null {
    return this.estimator.errorMs
  }

  get usingBus(): boolean {
    return this.fallback || !this.o.datagramUsable()
  }

  /** (Re)start the cadence; called on join and on every reconnect to the host. */
  restart(opts: { resetEstimate: boolean } = { resetEstimate: false }): void {
    this.stop()
    if (opts.resetEstimate) this.estimator.reset()
    this.sentInBurst = 0
    this.losses = 0
    this.fallback = false
    this.fastUntil = Infinity
    this.tick()
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = null
    for (const p of this.outstanding.values()) p.timer.cancel()
    this.outstanding.clear()
  }

  onPong(p: { id: number; t0: number; t1: number; t2: number }): void {
    const pending = this.outstanding.get(p.id)
    if (pending?.t0 !== p.t0) return
    pending.timer.cancel()
    this.outstanding.delete(p.id)
    if (pending.via === 'datagram') this.losses = 0
    const moved = this.estimator.add({ t0: p.t0, t1: p.t1, t2: p.t2, t3: this.o.clock.now() })
    const theta = this.estimator.offset
    if (theta !== null) this.o.onOffset(theta, moved >= CLOCK.JUMP_MS)
  }

  private tick(): void {
    this.ping()
    let delay: number
    if (this.sentInBurst < CLOCK.BURST_N) {
      delay = CLOCK.BURST_MS
    } else {
      if (this.fastUntil === Infinity) this.fastUntil = this.o.clock.now() + CLOCK.FAST_FOR_MS
      delay = this.o.clock.now() < this.fastUntil ? CLOCK.FAST_MS : CLOCK.SLOW_MS
    }
    this.timer = this.o.clock.setTimer(delay, () => this.tick())
  }

  private ping(): void {
    const id = this.nextId
    this.nextId = (this.nextId + 1) >>> 0 || 1
    const via: PingVia = this.usingBus ? 'bus' : 'datagram'
    const t0 = this.o.clock.now()
    const timer = this.o.clock.setTimer(CLOCK.LOSS_TIMEOUT_MS, () => {
      this.outstanding.delete(id)
      if (via === 'datagram' && ++this.losses >= CLOCK.LOSSES_TO_FALLBACK) this.fallback = true
    })
    this.outstanding.set(id, { t0, via, timer })
    this.sentInBurst++
    this.o.send(via, id, t0)
  }
}

/** Host side: answer a ping. t1 and t2 coincide because the reply is written synchronously. */
export function pong(
  clock: Clock,
  ping: { id: number; t0: number },
): { id: number; t0: number; t1: number; t2: number } {
  const t = clock.now()
  return { id: ping.id, t0: ping.t0, t1: t, t2: t }
}
