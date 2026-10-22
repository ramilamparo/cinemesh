import { describe, expect, it } from 'vitest'
import { DRIFT } from '../../src/core/sync/drift.js'
import { MEMBER } from '../../src/core/sync/member.js'
import { DEFAULT_MPV } from './sim/fake-mpv.js'
import { uniform } from './sim/loop.js'
import { HOST, SimRoom, percentile, wanLink } from './sim/room.js'

// §9 sync simulator rows 1, 2, 8 and 9: steady-state drift and start alignment.

function viewers(n: number, room: { spdif?: boolean; skew?: (i: number) => number } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `v${String(i + 1)}`,
    mpv: { audioSkewPpm: room.skew ? room.skew(i) : 0, spdif: room.spdif ?? false },
  }))
}

describe('drift', () => {
  it('(1) 4 viewers, RTT 20–300 ms, 20 ms jitter, 1 % loss: p95 |drift| < 100 ms after 10 s', () => {
    for (const seed of [11, 12, 13]) {
      const room = new SimRoom({
        seed,
        viewers: viewers(4, { skew: (i) => [-100, 100, -60, 60][i] ?? 0 }),
        link: wanLink(0.01),
      })
      room.start()
      room.run(3000)
      void room.intent(HOST, { kind: 'play' })
      room.run(2000)
      expect(room.host.mode).toBe('playing')
      const t0 = room.t
      const drift = room.recordDrift()
      room.run(120_000)
      const settled = drift.abs(t0 + 10_000)
      expect(settled.length).toBeGreaterThan(4 * 1000)
      expect(percentile(settled, 95)).toBeLessThan(100)
      expect(percentile(settled, 99)).toBeLessThan(100)
      for (const v of room.viewers) expect(v.mpv.isRunning).toBe(true)
    }
  })

  it('(2) start alignment p95 < 50 ms', () => {
    const errors: number[] = []
    for (const seed of [21, 22, 23, 24, 25, 26]) {
      const room = new SimRoom({ seed, viewers: viewers(4), link: wanLink(0.01) })
      room.start()
      room.run(3000)
      for (let k = 0; k < 5; k++) {
        void room.intent(HOST, { kind: 'play' })
        room.run(50)
        const anchor = room.anchorTrueTime()
        expect(anchor).not.toBeNull()
        // Halfway into the 1 s drift hold, before any correction: the offset is the start error.
        room.loop.runUntil((anchor ?? 0) + 500)
        const h = room.host.mpv.pos()
        for (const v of room.viewers) errors.push(Math.abs(v.mpv.pos() - h) * 1000)
        room.run(uniform(room.r, 3000, 8000))
        void room.intent(HOST, { kind: 'pause' })
        room.run(3000)
      }
    }
    expect(errors.length).toBe(6 * 5 * 4)
    expect(percentile(errors, 95)).toBeLessThan(50)
  })

  it('(2) start alignment after a paused seek, in the flows that re-send its position (ADR 0007 Finding 5)', () => {
    // FakeMpv lands seeks on frames and, after a pause from playback, reads audio-pts 170 ms early while paused
    const errors: number[] = []
    for (const seed of [31, 32, 33]) {
      for (const flow of ['barrier-paused', 'wait-after-seek'] as const) {
        const room = new SimRoom({ seed, viewers: viewers(3), link: wanLink(0), randomClocks: false })
        room.start()
        room.run(3000)
        void room.intent(HOST, { kind: 'play' })
        room.run(5000)
        if (flow === 'barrier-paused') {
          // a seek barrier that a pause ends: waiting, then paused at the same position
          void room.intent(HOST, { kind: 'seek', posS: 100.013 })
          room.run(50)
          void room.intent(HOST, { kind: 'pause' })
          room.run(3000)
        } else {
          // a paused seek, then a play before everyone is there: waiting at the same position
          void room.intent(HOST, { kind: 'pause' })
          room.run(2000)
          void room.intent(HOST, { kind: 'seek', posS: 100.013 })
          room.run(100)
        }
        void room.intent(HOST, { kind: 'play' })
        const group = room.host.engine.group
        expect(room.runUntil(() => group?.state()?.mode === 'playing', 10_000)).toBe(true)
        const st = group?.state()
        const anchor = room.anchorTrueTime()
        if (!st || anchor === null) throw new Error('no anchor')
        room.loop.runUntil(anchor + 500)
        const expected = st.anchor.pos + (room.host.clock.now() - st.anchor.hostTime) / 1000
        for (const n of [room.host, ...room.viewers]) errors.push((n.mpv.pos() - expected) * 1000)
      }
    }
    expect(errors.length).toBe(3 * 2 * 4)
    expect(Math.max(...errors.map(Math.abs))).toBeLessThan(15)
  })

  it('(8) spdif: never calls setSpeed, p95 < 200 ms', () => {
    const room = new SimRoom({
      seed: 81,
      viewers: viewers(3, { spdif: true, skew: (i) => [100, -100, 80][i] ?? 0 }),
      link: wanLink(0.01),
    })
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(2000)
    const t0 = room.t
    const drift = room.recordDrift()
    room.run(15 * 60_000)
    for (const v of room.viewers) expect(v.mpv.speedCalls).toEqual([])
    expect(percentile(drift.abs(t0 + 10_000), 95)).toBeLessThan(200)
  })

  it('spdif: a play that arrives too late to unpause into is met by a rendezvous, not kept as lateness', () => {
    // bus only (no StateFast): each play reaches the viewer behind a backlog, after the room started
    const room = new SimRoom({
      seed: 87,
      viewers: [{ id: 'v1', datagrams: false, mpv: { spdif: true } }],
      link: () => ({ latencyMs: 40, jitterMs: 0, loss: 0 }),
    })
    room.start()
    room.run(3000)
    const v = room.node('v1')
    const lates: number[] = []
    // the lead the host gives a play grows with the lag it measures, so each backlog is aimed past it
    const leadMs = (): number => (room.host.engine.group as unknown as { leadMs(): number }).leadMs()
    for (const lateMs of [140, 180, 220]) {
      const from = v.applied.length
      const backlogMs = leadMs() - 40 + lateMs
      room.net.backlog(HOST, 'v1', (backlogMs / 1000) * 6.25e6, 50e6)
      void room.intent(HOST, { kind: 'play' })
      room.run(50)
      const anchor = room.anchorTrueTime() ?? NaN
      room.run(10_000)
      const arrived = v.applied.slice(from).find((a) => a.state.mode === 'playing')?.t ?? NaN
      lates.push(arrived - anchor)
      // the drift loop never nudges it and skips only past 300 ms: the start itself must be right
      expect(v.mpv.speedCalls).toEqual([])
      expect(Math.abs(v.mpv.pos() - room.host.mpv.pos()) * 1000).toBeLessThan(40)
      void room.intent(HOST, { kind: 'pause' })
      room.run(3000)
    }
    // each play really came late: unpausing into it would have kept 100–300 ms, which the drift loop leaves alone
    expect(Math.min(...lates)).toBeGreaterThan(MEMBER.LATE_NO_NUDGE_MS)
    expect(Math.max(...lates)).toBeLessThan(-DRIFT.SPDIF_BEHIND_MS - DEFAULT_MPV.unpauseLatMs)
  })

  it('spdif: meets a late play once per state, so seeks slower than it expects cannot keep it from starting', () => {
    // every seek takes 1.5 s while the member plans for DRIFT.SEEK_LAT_INIT_MS: each rendezvous planned on that
    // would be late again (by more than LATE_MS)
    const room = new SimRoom({
      seed: 88,
      viewers: [{ id: 'v1', datagrams: false, mpv: { spdif: true, seekLatMs: [1500, 1500] } }],
      link: () => ({ latencyMs: 40, jitterMs: 0, loss: 0 }),
    })
    room.start()
    room.run(3000)
    const v = room.node('v1')
    room.net.backlog(HOST, 'v1', 0.39 * 6.25e6, 50e6)
    void room.intent(HOST, { kind: 'play' })
    // one rendezvous on the prior (1.5 s, late), then one on the seekLat it timed, which starts on time
    expect(room.runUntil(() => v.mpv.isRunning, 4000)).toBe(true)
    expect(v.mpv.seekCount).toBe(2)
    room.run(1000)
    expect(Math.abs(v.mpv.pos() - room.host.mpv.pos()) * 1000).toBeLessThan(40)
  })

  it('(9) 2 h with 100 ppm clock and audio skew: p95 < 100 ms', () => {
    const room = new SimRoom({
      seed: 91,
      durationS: 3 * 3600,
      host: { skewPpm: 50 },
      viewers: [
        { id: 'v1', skewPpm: 100, mpv: { audioSkewPpm: -100 } },
        { id: 'v2', skewPpm: -100, mpv: { audioSkewPpm: 100 } },
      ],
      link: wanLink(0.01),
    })
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(2000)
    const t0 = room.t
    const drift = room.recordDrift(250)
    room.run(2 * 3600_000)
    expect(room.host.mode).toBe('playing')
    expect(percentile(drift.abs(t0 + 10_000), 95)).toBeLessThan(100)
    expect(drift.abs(t0 + 10_000).length).toBeGreaterThan(2 * 7000 * 4 - 100)
  })
})
