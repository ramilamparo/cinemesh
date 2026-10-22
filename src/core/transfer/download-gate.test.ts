import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadGate, GATE_MIN_BYTES } from './download-gate.js'

// The gate alone, on vitest's fake clock (Date.now and the timers). Its hooks in WebTorrent are in engine.test.ts,
// the limit end to end in test/integration/transfer/engine.test.ts.

const KiB = 1024
const BLOCK = 16 * KiB

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** `kicks` counts from after the first setRate (which kicks too) */
function gate(rateBps: number | null): { g: DownloadGate; kicks: () => number } {
  let kicks = 0
  const g = new DownloadGate({ kick: () => kicks++, now: () => Date.now() })
  g.setRate(rateBps)
  const before = kicks
  return { g, kicks: () => kicks - before }
}

/** takes blocks while the gate allows them */
function drain(g: DownloadGate, critical = false): number {
  let n = 0
  while (g.allows(critical)) {
    g.take(BLOCK)
    n++
  }
  return n
}

describe('DownloadGate', () => {
  it('without a limit always allows, and never sets a timer', () => {
    const { g, kicks } = gate(null)
    for (let i = 0; i < 1000; i++) {
      expect(g.allows(false)).toBe(true)
      g.take(BLOCK)
    }
    g.refund(BLOCK)
    expect(vi.getTimerCount()).toBe(0)
    expect(kicks()).toBe(0)
    expect(g.rateBps).toBeNull()
  })

  it('starts full: 64 KiB at 256 KiB/s, then a block per 62.5 ms', () => {
    const { g } = gate(256 * KiB)
    expect(drain(g)).toBe(4) // the depth: max(64 KiB, 0.25 s of the rate)
    vi.advanceTimersByTime(1)
    expect(g.allows(false)).toBe(true) // anything left goes: the block taken on it is paid off before the next
    g.take(BLOCK)
    vi.advanceTimersByTime(61)
    expect(g.allows(false)).toBe(false)
    vi.advanceTimersByTime(1)
    expect(g.allows(false)).toBe(true)
  })

  it('lets critical pieces borrow 1 s of the rate below empty, and nothing else', () => {
    const { g } = gate(256 * KiB)
    drain(g)
    expect(g.allows(false)).toBe(false)
    let borrowed = 0
    while (g.allows(true)) {
      expect(g.allows(false)).toBe(false)
      g.take(BLOCK)
      borrowed += BLOCK
    }
    expect(borrowed).toBe(256 * KiB) // down to -256 KiB, then refused too
    expect(GATE_MIN_BYTES).toBe(64 * KiB)
  })

  it('charges what is taken after a quiet spell, also without asking first: the bucket is full, not more', () => {
    const { g } = gate(256 * KiB)
    drain(g)
    vi.advanceTimersByTime(2000)
    for (let i = 0; i < 5; i++) g.take(BLOCK) // 80 KiB of the 64 KiB it holds
    expect(g.allows(false)).toBe(false)
  })

  it('a refund lets the next request go at once, and never fills it past its depth', () => {
    const { g } = gate(256 * KiB)
    drain(g)
    expect(g.allows(false)).toBe(false)
    g.refund(BLOCK)
    expect(g.allows(false)).toBe(true)
    for (let i = 0; i < 10; i++) g.refund(BLOCK)
    expect(drain(g)).toBe(4)
  })

  it('a refusal sets one timer that kicks once, when the refused request could go (10-1000 ms)', () => {
    const { g, kicks } = gate(256 * KiB)
    drain(g)
    expect(g.allows(false)).toBe(false)
    expect(g.allows(false)).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(9) // it could go a byte later: the timer waits its 10 ms floor
    expect(kicks()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(kicks()).toBe(1)
    expect(g.allows(false)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)

    // at 1 KiB/s a block taken on a few bytes leaves 16 s to wait: the timer is capped at 1 s (refused again, again)
    const slow = gate(KiB)
    drain(slow.g)
    vi.advanceTimersByTime(10)
    expect(slow.kicks()).toBe(1)
    expect(drain(slow.g)).toBe(1)
    vi.advanceTimersByTime(999)
    expect(slow.kicks()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(slow.kicks()).toBe(2)
  })

  it('kicks a refused critical piece as soon as it may borrow again, not once the bucket is positive', () => {
    const { g, kicks } = gate(256 * KiB)
    drain(g)
    vi.advanceTimersByTime(10)
    expect(kicks()).toBe(1)
    expect(drain(g, true)).toBe(17) // ~2.5 KiB, then down past -256 KiB: 13.4 KiB short, 53 ms at this rate
    vi.advanceTimersByTime(60)
    expect(kicks()).toBe(2)
    expect(g.allows(true)).toBe(true)
    expect(g.allows(false)).toBe(false)
  })

  it('setRate: a new limit starts full and kicks, a raise kicks, a lower one is held to its depth, null opens', () => {
    const { g, kicks } = gate(null)
    g.setRate(256 * KiB)
    expect(kicks()).toBe(1)
    expect(drain(g)).toBe(4)
    expect(g.allows(false)).toBe(false) // a timer is set
    g.setRate(512 * KiB) // what is left stays (0): the raise refills at the new rate, and kicks now
    expect(kicks()).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(drain(g)).toBe(8) // 128 KiB deep now
    vi.advanceTimersByTime(1000) // the timer the drain set kicks meanwhile
    expect(kicks()).toBe(3)
    g.setRate(64 * KiB) // full at 128 KiB, held to the new 64 KiB; nothing more may go, so no kick
    expect(kicks()).toBe(3)
    expect(drain(g)).toBe(4)
    g.setRate(null)
    expect(kicks()).toBe(4)
    expect(vi.getTimerCount()).toBe(0)
    expect(g.rateBps).toBeNull()
    for (let i = 0; i < 100; i++) g.take(BLOCK)
    expect(g.allows(false)).toBe(true)
    g.setRate(64 * KiB) // starts full again
    expect(drain(g)).toBe(4)
  })

  it('setRate: a lower limit forgives debt borrowed at the old rate down to its own, so nothing stalls for long', () => {
    const { g, kicks } = gate(5000 * KiB)
    drain(g)
    drain(g, true) // ~5 MiB borrowed: a seek's hot window, or a reader blocked below the bitrate
    g.setRate(500 * KiB)
    // what is owed now is 1 s of the new rate: a critical piece goes on the next kick (not ~9 s later), the rest
    // after that 1 s
    const before = kicks()
    vi.advanceTimersByTime(10)
    expect(kicks()).toBe(before + 1)
    expect(g.allows(true)).toBe(true)
    expect(g.allows(false)).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(g.allows(false)).toBe(true)
    // and from there the new rate holds
    expect(drain(g)).toBeLessThanOrEqual(1)
    vi.advanceTimersByTime(1000)
    expect(drain(g, true)).toBeLessThanOrEqual(Math.ceil((1000 * KiB) / BLOCK) + 1)
  })

  it('holds a greedy requester to the rate over 60 s, critical pieces included', () => {
    const rate = 256 * KiB
    const { g } = gate(rate)
    let total = 0
    for (let ms = 0; ms < 60_000; ms += 5) {
      let k = 0
      while (g.allows(k % 10 === 9)) {
        g.take(BLOCK)
        total += BLOCK
        k++
      }
      vi.advanceTimersByTime(5)
    }
    expect(total).toBeLessThanOrEqual(rate * 60 + 64 * KiB + 256 * KiB)
    expect(total).toBeGreaterThanOrEqual(0.97 * rate * 60)
  })

  it('destroy() cancels a pending kick', () => {
    const { g, kicks } = gate(256 * KiB)
    drain(g)
    expect(g.allows(false)).toBe(false)
    g.destroy()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(2000)
    expect(kicks()).toBe(0)
    expect(g.allows(false)).toBe(true) // refilled, and no timer is set again
    drain(g)
    expect(vi.getTimerCount()).toBe(0)
  })
})
