import { describe, expect, it } from 'vitest'
import { EventLoop, NodeClock, rng } from '../../../test/sync/sim/loop.js'
import { CLOCK, ClockClient, OffsetEstimator, type PingVia } from './clock.js'

/** A sample with true offset theta, one-way delays up and down (ms). */
function sample(t0: number, theta: number, up: number, down: number) {
  const t1 = t0 + up + theta
  const t2 = t1
  return { t0, t1, t2, t3: t2 - theta + down }
}

describe('OffsetEstimator', () => {
  it('measures θ and ε = δmin/2 from the lowest-δ sample', () => {
    const e = new OffsetEstimator()
    e.add(sample(0, 5000, 40, 40))
    expect(e.offset).toBe(5000)
    expect(e.errorMs).toBe(40)
    // A queued, asymmetric sample has a higher δ and is not trusted over the clean one.
    e.add(sample(1000, 5000, 140, 40))
    expect(e.offset).toBe(5000)
    expect(e.errorMs).toBe(40)
  })

  it('slews at most 20 ms per update unless 3 samples agree', () => {
    const e = new OffsetEstimator()
    e.add(sample(0, 0, 50, 50))
    // One lucky low-δ sample claims θ moved by 100 ms.
    expect(e.add(sample(1000, 100, 10, 10))).toBe(CLOCK.MAX_SLEW_MS)
    expect(e.offset).toBe(20)
    e.add(sample(2000, 100, 10, 10))
    expect(e.offset).toBe(40)
    // The third agreeing sample lets it jump the rest of the way.
    e.add(sample(3000, 100, 10, 10))
    expect(e.offset).toBe(100)
  })

  it('forgets samples beyond the window of 12', () => {
    const e = new OffsetEstimator()
    e.add(sample(0, 0, 5, 5))
    for (let i = 1; i <= CLOCK.WINDOW; i++) e.add(sample(i * 1000, 0, 30, 30))
    expect(e.errorMs).toBe(30)
  })
})

function client(datagramOk = true, answer: (via: PingVia) => boolean = () => true) {
  const loop = new EventLoop()
  const host = new NodeClock(loop, rng(1), { offsetMs: 3.6e6, skewPpm: 0, timerLateMs: 0 })
  const local = new NodeClock(loop, rng(2), { offsetMs: 1000, skewPpm: 0, timerLateMs: 0 })
  const sent: { t: number; via: PingVia }[] = []
  const offsets: { theta: number; jumped: boolean }[] = []
  const c: ClockClient = new ClockClient({
    clock: local,
    datagramUsable: () => datagramOk,
    send: (via, id, t0) => {
      sent.push({ t: loop.t, via })
      if (!answer(via)) return
      loop.after(20, () => {
        const t = host.now()
        loop.after(20, () => c.onPong({ id, t0, t1: t, t2: t }))
      })
    },
    onOffset: (theta, jumped) => offsets.push({ theta, jumped }),
  })
  return { loop, c, sent, offsets }
}

describe('ClockClient', () => {
  it('pings 5× at 100 ms, then every 1 s for 20 s, then every 5 s', () => {
    const { loop, c, sent, offsets } = client()
    c.restart({ resetEstimate: true })
    loop.runUntil(60_000)
    c.stop()
    const times = sent.map((s) => Math.round(s.t))
    expect(times.slice(0, 7)).toEqual([0, 100, 200, 300, 400, 1400, 2400])
    expect(times.filter((t) => t > 400 && t <= 20_500)).toHaveLength(20)
    const slow = times.filter((t) => t > 21_000)
    expect(slow.slice(1).map((t, i) => t - (slow[i] ?? 0))).toEqual(slow.slice(1).map(() => 5000))
    expect(offsets[0]).toEqual({ theta: 3.6e6 - 1000, jumped: true })
    expect(c.offset).toBe(3.6e6 - 1000)
    expect(c.errorMs).toBe(20)
  })

  it('falls back to bus pings after 6 lost datagram pings', () => {
    const { loop, c, sent } = client(true, (via) => via === 'bus')
    c.restart()
    loop.runUntil(15_000)
    c.stop()
    const firstBus = sent.findIndex((s) => s.via === 'bus')
    expect(sent.slice(0, firstBus).every((s) => s.via === 'datagram')).toBe(true)
    expect(firstBus).toBeGreaterThanOrEqual(CLOCK.LOSSES_TO_FALLBACK)
    expect(sent.slice(firstBus).every((s) => s.via === 'bus')).toBe(true)
    expect(c.usingBus).toBe(true)
    expect(c.offset).not.toBeNull()
  })

  it('uses the bus from the start when datagrams are unusable', () => {
    const { loop, c, sent } = client(false)
    c.restart()
    loop.runUntil(1000)
    c.stop()
    expect(sent.every((s) => s.via === 'bus')).toBe(true)
  })

  it('ignores pongs it did not ask for', () => {
    const { c, offsets } = client()
    c.onPong({ id: 77, t0: 1, t1: 2, t2: 2 })
    expect(offsets).toEqual([])
  })
})
