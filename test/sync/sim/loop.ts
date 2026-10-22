import type { Clock, TimerHandle } from '../../../src/core/sync/ports.js'

// Seeded discrete-event core: one queue in "true" milliseconds, per-node clocks derived from it.

export type Rng = () => number

/** mulberry32: small, fast and good enough for jitter and fuzzing. */
export function rng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const uniform = (r: Rng, lo: number, hi: number): number => lo + (hi - lo) * r()

interface Ev {
  at: number
  seq: number
  fn: () => void
  dead: boolean
}

export class EventLoop {
  t = 0
  private heap: Ev[] = []
  private seq = 0

  schedule(at: number, fn: () => void): TimerHandle {
    const ev: Ev = { at: Math.max(at, this.t), seq: this.seq++, fn, dead: false }
    this.push(ev)
    return {
      cancel: () => {
        ev.dead = true
      },
    }
  }

  after(ms: number, fn: () => void): TimerHandle {
    return this.schedule(this.t + ms, fn)
  }

  every(ms: number, fn: () => void): TimerHandle {
    let h: TimerHandle | null = null
    let stopped = false
    const arm = (): void => {
      h = this.after(ms, () => {
        if (stopped) return
        arm()
        fn()
      })
    }
    arm()
    return {
      cancel: () => {
        stopped = true
        h?.cancel()
      },
    }
  }

  runUntil(until: number): void {
    for (;;) {
      const top = this.heap[0]
      if (!top || top.at > until) break
      this.pop()
      if (top.dead) continue
      this.t = top.at
      top.fn()
    }
    this.t = Math.max(this.t, until)
  }

  runFor(ms: number): void {
    this.runUntil(this.t + ms)
  }

  private less(a: Ev, b: Ev): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq)
  }

  private push(ev: Ev): void {
    const h = this.heap
    h.push(ev)
    let i = h.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      const pe = h[p]
      if (!pe || !this.less(ev, pe)) break
      h[i] = pe
      i = p
    }
    h[i] = ev
  }

  private pop(): void {
    const h = this.heap
    const last = h.pop()
    if (!last || h.length === 0) return
    let i = 0
    for (;;) {
      const l = 2 * i + 1
      const r = l + 1
      let m = i
      let me = last
      const le = h[l]
      const re = h[r]
      if (le && this.less(le, me)) {
        m = l
        me = le
      }
      if (re && this.less(re, me)) {
        m = r
        me = re
      }
      if (m === i) break
      h[i] = me
      i = m
    }
    h[i] = last
  }
}

export interface NodeClockOpts {
  offsetMs: number
  skewPpm: number
  /** setTimeout fires late by up to this many ms */
  timerLateMs: number
}

/** A node's monotonic clock: offset + skewed true time. */
export class NodeClock implements Clock {
  loopLag = 0
  private readonly rate: number

  constructor(
    private readonly loop: EventLoop,
    private readonly r: Rng,
    private readonly o: NodeClockOpts,
  ) {
    this.rate = 1 + o.skewPpm * 1e-6
  }

  now(): number {
    return this.o.offsetMs + this.loop.t * this.rate
  }

  /** True time at which this clock reads `local`. */
  toTrue(local: number): number {
    return (local - this.o.offsetMs) / this.rate
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    return this.loop.after(Math.max(0, ms) / this.rate + this.r() * this.o.timerLateMs, fn)
  }

  immediate(fn: () => void): TimerHandle {
    return this.loop.after(0.05, fn)
  }

  loopLagMs(): number {
    return this.loopLag
  }
}
