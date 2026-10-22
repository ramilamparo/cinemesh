import { describe, expect, it } from 'vitest'
import { PACER_SAMPLE_MS, PACER_TICK_MS, START_BPS, UploadPacer } from './upload-pacer.js'

// The pacer on a fluid bottleneck: the host releases at the paced rate (the upload scheduler's job), a router in front
// of an uplink of capacity C queues what exceeds it, and each viewer's UDX srtt follows the base RTT plus that queue
// (an EWMA of 1/8 per 10 ms, like a smoothed RTT). Three viewers share the uplink. No timers: the test steps the clock.

const STEP_MS = 10
const BASE_RTT_MS = 31
const VIEWERS = ['a', 'b', 'c']

interface Sample {
  at: number
  rate: number | null
  queueMs: number
  /** bytes/s that left the host this step */
  upBps: number
  state: string
}

function bottleneck(capacityBps: number) {
  const link = { capacity: capacityBps, demand: true, queue: 0, srtt: BASE_RTT_MS, sent: 0, at: 0 }
  /** delay one viewer's stream adds on top (its own trouble: a stall, its own queue), ms */
  const own = new Map<string, number>()
  const streams = VIEWERS.map((id) => ({ id, rttMs: 0, bytesSent: 0, stream: {} }))
  const pacer = new UploadPacer({
    apply: () => undefined,
    sentBytes: () => link.sent,
    streams: () => streams,
    now: () => link.at,
  })
  const samples: Sample[] = []
  /** run for `ms`, the pacer's rate (or 1 MB/s while it has none) as the release rate */
  const run = (ms: number): void => {
    for (const end = link.at + ms; link.at < end;) {
      link.at += STEP_MS
      const dt = STEP_MS / 1000
      const rate = pacer.rateBps ?? 1_000_000
      const out = link.demand ? rate * dt : 0
      link.sent += out
      link.queue = Math.max(0, link.queue + out - link.capacity * dt)
      const rtt = BASE_RTT_MS + (link.queue / link.capacity) * 1000
      link.srtt += (rtt - link.srtt) / 8
      for (const s of streams) {
        s.rttMs = Math.round(link.srtt + (own.get(s.id) ?? 0))
        // the room's ctrl traffic keeps every stream sending a little, data or not
        s.bytesSent += out / streams.length + 10
      }
      if (link.at % PACER_SAMPLE_MS === 0) pacer.poll()
      if (link.at % PACER_TICK_MS === 0) pacer.tick()
      samples.push({
        at: link.at,
        rate: pacer.rateBps,
        queueMs: (link.queue / link.capacity) * 1000,
        upBps: out / dt,
        state: pacer.state,
      })
    }
  }
  /** over [from, to) ms: the median queueing delay and the mean upload */
  const window = (from: number, to: number): { queueMs: number; upBps: number; minRate: number } => {
    const xs = samples.filter((s) => s.at >= from && s.at < to)
    const qs = xs.map((s) => s.queueMs).sort((x, y) => x - y)
    return {
      queueMs: qs[Math.floor(qs.length / 2)] ?? Number.NaN,
      upBps: xs.reduce((sum, s) => sum + s.upBps, 0) / Math.max(1, xs.length),
      minRate: Math.min(...xs.map((s) => s.rate ?? Number.POSITIVE_INFINITY)),
    }
  }
  /** every viewer re-attaches: new connections, so new UDX streams */
  const reattach = (): void => {
    for (const s of streams) s.stream = {}
  }
  return { link, own, pacer, run, window, samples, reattach }
}

const MB = 1_000_000

describe('UploadPacer', () => {
  it('has no rate until a stream gives a delay sample', () => {
    const b = bottleneck(2.5 * MB)
    b.link.demand = false
    expect(b.pacer.rateBps).toBeNull()
    b.pacer.tick()
    expect(b.pacer.rateBps).toBeNull()
    b.run(100) // the streams' first reads are samples
    expect(b.pacer.rateBps).not.toBeNull()
  })

  it('starts at 1 MB/s though ctrl traffic gives samples before any data moves, then ramps under its cap', () => {
    const b = bottleneck(20 * MB)
    b.link.demand = false
    b.run(1000)
    expect([b.pacer.rateBps, b.pacer.state]).toEqual([START_BPS, 'start'])
    b.link.demand = true
    b.run(3000)
    const ticks = b.samples.filter((x) => x.at > 1000 && x.at % 100 === 0).map((x) => x.rate ?? 0)
    const growth = ticks.slice(1).map((r, k) => r / (ticks[k] ?? r))
    expect(Math.max(...growth)).toBeLessThanOrEqual(1.3 + 1e-9) // ×1.3 per tick at most...
    // ...and the cap (1.25 × what got through, which lags) makes it ~×1.1: 1 to 4 MB/s in ~1.5 s
    const at4 = b.samples.find((x) => (x.rate ?? 0) >= 4 * MB)?.at ?? Infinity
    expect(at4 - 1000).toBeGreaterThan(1000)
    expect(at4 - 1000).toBeLessThan(2000)
  })

  it('converges on its 20 ms target, using most of the uplink', () => {
    const b = bottleneck(2.5 * MB)
    b.run(30_000)
    const w = b.window(10_000, 30_000)
    const summary = JSON.stringify(w)
    expect(b.pacer.state).toBe('steady')
    expect(w.queueMs, summary).toBeLessThan(30)
    expect(w.upBps, summary).toBeGreaterThan(0.85 * 2.5 * MB)
    expect(w.upBps, summary).toBeLessThan(1.02 * 2.5 * MB)
  })

  it('cuts when the uplink steps down, and keeps the queue near target at the new capacity', () => {
    const b = bottleneck(5 * MB)
    b.run(20_000)
    b.link.capacity = 2.5 * MB // another upload took half, say
    b.run(20_000)
    const after = b.samples.find((s) => s.at > 20_000 && (s.rate ?? Infinity) < 2.5 * MB)
    expect(after?.at).toBeLessThan(23_000)
    const w = b.window(30_000, 40_000)
    const summary = JSON.stringify(w)
    expect(w.queueMs, summary).toBeLessThan(30)
    expect(w.upBps, summary).toBeGreaterThan(0.85 * 2.5 * MB)
  })

  it('regrows when the uplink steps up', () => {
    const b = bottleneck(2.5 * MB)
    b.run(20_000)
    b.link.capacity = 5 * MB
    b.run(30_000)
    const w = b.window(40_000, 50_000)
    const summary = JSON.stringify(w)
    expect(w.upBps, summary).toBeGreaterThan(0.85 * 5 * MB)
    expect(w.queueMs, summary).toBeLessThan(30)
  })

  it("goes by the median viewer: one stream's own delay does not cut the rate", () => {
    const b = bottleneck(2.5 * MB)
    b.run(20_000)
    b.own.set('c', 200) // c's stream stalls behind its own trouble for 10 s
    b.run(10_000)
    const w = b.window(20_000, 30_000)
    expect(w.upBps, JSON.stringify(w)).toBeGreaterThan(0.85 * 2.5 * MB)
  })

  it('keeps a steady rate through a short pause: the upload comes back at that rate at once', () => {
    const b = bottleneck(5 * MB)
    b.run(20_000)
    const before = b.pacer.rateBps ?? 0
    b.link.demand = false
    b.run(3000)
    expect([b.pacer.state, b.pacer.rateBps]).toEqual(['steady', before])
    b.link.demand = true
    b.run(2000)
    const w = b.window(23_000, 23_500)
    expect(w.upBps, JSON.stringify(w)).toBeGreaterThan(0.85 * 5 * MB)
  })

  it("starts a viewer's delay history over when it re-attaches over a longer path", () => {
    const b = bottleneck(2.5 * MB)
    b.run(20_000)
    b.reattach()
    for (const id of VIEWERS) b.own.set(id, 80) // e.g. relayed now: 80 ms more RTT, but no queue
    b.run(10_000)
    const w = b.window(20_000, 30_000)
    expect(w.upBps, JSON.stringify(w)).toBeGreaterThan(0.85 * 2.5 * MB)
  })

  it('never paces below 250 KB/s, however slow the uplink', () => {
    const b = bottleneck(100_000)
    b.run(20_000)
    expect(b.window(1000, 20_000).minRate).toBeGreaterThanOrEqual(250_000)
  })

  it('starts over after 5 s with little to send, from the rate it had: the burst after it comes back at once', () => {
    const b = bottleneck(5 * MB)
    b.run(20_000)
    expect(b.pacer.state).toBe('steady')
    const before = b.pacer.rateBps
    b.link.demand = false // paused: nothing to send
    b.run(4000)
    expect(b.pacer.state).toBe('steady')
    b.run(1500)
    expect([b.pacer.state, b.pacer.rateBps]).toEqual(['start', before])
    b.link.demand = true
    b.run(10_000)
    const full = b.samples.find((s) => s.at > 25_500 && s.upBps >= 0.85 * 5 * MB)
    expect(full?.at).toBeLessThan(25_500 + 500)
    expect(b.pacer.state).toBe('steady') // and the probe found the queue again
  })
})
