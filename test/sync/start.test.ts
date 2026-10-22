import { describe, expect, it } from 'vitest'
import { HOST, SimRoom, wanLink } from './sim/room.js'

// §9 sync simulator rows 3 and 4: head-of-line backlog at start, and a slow viewer.

const ON_TIME_MS = 50

/** Worst viewer start error (ms) when play is pressed behind a 4 MB backlog on every host→viewer stream. */
function backloggedStart(seed: number, datagrams: boolean): number {
  const room = new SimRoom({
    seed,
    viewers: [1, 2, 3].map((i) => ({ id: `v${String(i)}`, datagrams })),
    link: wanLink(0.01),
  })
  room.start()
  room.run(4000)
  for (const v of room.viewers) room.net.backlog(HOST, v.id, 4 * 1024 * 1024, 50e6)
  void room.intent(HOST, { kind: 'play' })
  room.run(20)
  room.loop.runUntil((room.anchorTrueTime() ?? 0) + 500)
  const h = room.host.mpv.pos()
  return Math.max(...room.viewers.map((v) => Math.abs(v.mpv.pos() - h) * 1000))
}

const slow = { complete: false, rateX: 4, firstByteMs: 15_000, preloadS: 30 }
const fast = { complete: false, rateX: 4, firstByteMs: 300, preloadS: 30 }

describe('start', () => {
  it('(3) 4 MB head-of-line backlog: on-time start in >= 99 % of runs (StateFast datagrams)', () => {
    const runs = 200
    let onTime = 0
    for (let seed = 1; seed <= runs; seed++) if (backloggedStart(seed, true) < ON_TIME_MS) onTime++
    expect(onTime / runs).toBeGreaterThanOrEqual(0.99)
    // Control: over the bus alone the state waits behind the backlog and most starts are late.
    let late = 0
    for (let seed = 1; seed <= 20; seed++) if (backloggedStart(seed, false) >= ON_TIME_MS) late++
    expect(late).toBeGreaterThan(15)
  })

  it('(4) slow viewer: the others start at the 8 s soft timeout; exempt on the 3rd wait', () => {
    const room = new SimRoom({
      seed: 4,
      waitForAll: false,
      viewers: [
        { id: 'v1', media: fast },
        { id: 'v2', media: fast },
        { id: 'slow', name: 'Sam', media: slow },
      ],
    })
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(10_000)
    const delays: number[] = []
    for (const target of [1000, 2000, 3000, 4000]) {
      const t0 = room.t
      void room.intent(HOST, { kind: 'seek', posS: target })
      expect(room.runUntil(() => room.host.mpv.isRunning && room.host.mpv.pos() > target, 40_000)).toBe(true)
      delays.push((room.t - t0) / 1000)
      room.run(200)
      for (const id of ['v1', 'v2']) expect(room.node(id).mpv.isRunning).toBe(true)
      room.run(25_000)
    }
    // Soft timeout (8 s) plus the lead time for the first three; the fourth no longer waits for Sam.
    for (const d of delays.slice(0, 3)) {
      expect(d).toBeGreaterThan(8)
      expect(d).toBeLessThan(10)
    }
    expect(delays[3]).toBeLessThan(3)
    const sam = room.host.engine.group?.memberViews().find((m) => m.id === 'slow')
    expect(sam?.exempt).toBe(true)
    expect(room.host.notices.some((n) => n.code === 'sync.exempt' && n.message.includes('Sam'))).toBe(true)
    expect(room.host.notices.some((n) => n.message === 'Started without Sam')).toBe(true)
    expect(room.node('slow').engine.member.state?.members.find((m) => m.peerId === 'slow')?.exempt).toBe(true)
  })

  it('(4) slow viewer with waitForAll: two buffering waits, exempt on the 3rd, the group keeps playing', () => {
    const room = new SimRoom({
      seed: 44,
      viewers: [{ id: 'v1' }, { id: 'slow', name: 'Sam', media: { complete: false, rateX: 0.7, preloadS: 10 } }],
    })
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(150_000)
    const waits = room.host.applied.filter(
      (a, i, all) => a.state.mode === 'waiting' && all[i - 1]?.state.mode !== 'waiting',
    )
    expect(waits.length).toBe(2)
    expect(waits.every((w) => w.state.wait?.reason === 'buffering' && w.state.cause?.by === 'slow')).toBe(true)
    expect(room.host.engine.group?.memberViews().find((m) => m.id === 'slow')?.exempt).toBe(true)
    expect(room.host.notices.filter((n) => n.message === 'Waiting for Sam to buffer').length).toBe(2)
    expect(room.host.mode).toBe('playing')
    expect(room.host.mpv.pos()).toBeGreaterThan(130)
  })

  it('a hard timeout starts without the straggler when waitForAll is on, and Start anyway works', () => {
    const room = new SimRoom({
      seed: 5,
      viewers: [
        { id: 'v1', media: fast },
        { id: 'slow', media: { ...slow, firstByteMs: 60_000 } },
      ],
    })
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(5000)
    const t0 = room.t
    void room.intent(HOST, { kind: 'seek', posS: 500 })
    expect(room.runUntil(() => room.host.mpv.isRunning && room.host.mpv.pos() > 500, 40_000)).toBe(true)
    expect((room.t - t0) / 1000).toBeGreaterThan(30)
    expect(room.host.engine.syncEvent()?.cause?.kind).toBe('timeout')
    room.run(5000)
    void room.intent(HOST, { kind: 'seek', posS: 900 })
    room.run(3000)
    expect(room.host.mode).toBe('waiting')
    room.host.engine.startAnyway()
    expect(room.runUntil(() => room.host.mpv.isRunning && room.host.mpv.pos() > 900, 3000)).toBe(true)
    expect(room.host.engine.syncEvent()?.cause?.kind).toBe('start-anyway')
  })

  it('a file that plays only once complete: the first play does not wait for a viewer still downloading it', () => {
    for (const fullDownload of [false, true]) {
      const room = new SimRoom({ seed: 7, fullDownload, viewers: [{ id: 'v1' }, { id: 'sam', name: 'Sam' }] })
      // Sam is in the room, but his stream comes only once his download is complete
      room.start([], ['sam'])
      room.run(3000)
      void room.intent(HOST, { kind: 'play' })
      room.run(2000)
      const sam = room.node('sam')
      expect(sam.engine.member.currentPhase).toBe('joining')
      if (!fullDownload) {
        // a file that streams: the first play waits for everyone to load it, as before
        expect(room.host.mode).toBe('waiting')
        expect(room.host.engine.syncEvent()?.wait).toMatchObject({ reason: 'start', waitingFor: ['Sam'] })
        continue
      }
      expect(room.host.mode).toBe('playing')
      expect(room.node('v1').mpv.isRunning).toBe(true)
      // complete: the stream arrives and Sam meets the playing room
      room.run(20_000)
      sam.engine.setSource('sim://sam')
      const met = (): boolean =>
        sam.mpv.isRunning && Math.abs(sam.mpv.pos() - room.host.mpv.pos()) * 1000 < 100 && sam.mode === 'playing'
      expect(room.runUntil(met, 5000)).toBe(true)
      expect(room.host.mpv.pos()).toBeGreaterThan(20)
    }
  })

  it('first play waits for the start gate (N s buffered) and reports who it waits for', () => {
    const room = new SimRoom({
      seed: 6,
      startMode: { kind: 'buffered', seconds: 20 },
      viewers: [{ id: 'v1', name: 'Ann', media: { complete: false, rateX: 2, preloadS: 0 } }],
    })
    room.start()
    room.run(1000)
    void room.intent(HOST, { kind: 'play' })
    room.run(1000)
    expect(room.host.mode).toBe('waiting')
    expect(room.node('v1').engine.syncEvent()?.wait).toMatchObject({ reason: 'start', waitingFor: ['Ann'] })
    expect(room.runUntil(() => room.host.mode === 'playing', 30_000)).toBe(true)
    // 20 s at 2x real time, after the first byte
    expect(room.t).toBeGreaterThan(10_000)
    expect(room.node('v1').media.bufferedAheadS(0)).toBeGreaterThanOrEqual(19.5)
  })
})
