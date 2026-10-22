import { describe, expect, it } from 'vitest'
import { MEMBER } from '../../src/core/sync/member.js'
import { HOST, SimRoom, type SimNode, wanLink } from './sim/room.js'

// §9 sync simulator rows 6 and 7: partitions and a host that goes away. Also a host process that restarts,
// and a viewer's mpv that restarts under it.

const CONVERGED_MS = 100

function inSync(room: SimRoom, id: string): boolean {
  const v = room.node(id)
  return v.mpv.isRunning && room.host.mpv.isRunning && Math.abs(v.mpv.pos() - room.host.mpv.pos()) * 1000 < CONVERGED_MS
}

/** ms after `from` until the viewer stays in sync for 2 s, or Infinity. */
function timeToConverge(room: SimRoom, id: string, maxMs: number): number {
  const from = room.t
  let since: number | null = null
  while (room.t - from < maxMs) {
    if (inSync(room, id)) since ??= room.t
    else since = null
    if (since !== null && room.t - since >= 2000) return since - from
    room.run(20)
  }
  return Infinity
}

function playingRoom(seed: number): SimRoom {
  const room = new SimRoom({
    seed,
    viewers: [{ id: 'v1', mpv: { audioSkewPpm: 80 } }, { id: 'v2' }],
    link: wanLink(0.01),
  })
  room.start()
  room.run(3000)
  void room.intent(HOST, { kind: 'play' })
  room.run(15_000)
  return room
}

describe('resilience', () => {
  it('(6) a 20 s partition (connection lost) reconverges within 3 s', () => {
    const room = playingRoom(61)
    room.net.disconnect(HOST, 'v1')
    room.run(5000)
    // The room moves on without v1.
    void room.intent(HOST, { kind: 'seek', posS: 900 })
    room.run(15_000)
    expect(room.node('v1').notices.some((n) => n.code === 'sync.host-gone')).toBe(true)
    room.net.connect(HOST, 'v1')
    expect(timeToConverge(room, 'v1', 10_000)).toBeLessThanOrEqual(3000)
    expect(room.node('v1').notices.at(-1)?.code).toBe('sync.host-back')
    expect(inSync(room, 'v2')).toBe(true)
  })

  it('(6) a 20 s partition (connection kept, traffic held) reconverges within 3 s', () => {
    const room = playingRoom(62)
    room.net.block(HOST, 'v1', 20_000)
    room.run(5000)
    void room.intent(HOST, { kind: 'seek', posS: 900 })
    room.run(15_000)
    // v1 went silent, so the barrier dropped it after 10 s instead of waiting for the 30 s hard timeout.
    expect(room.host.mode).toBe('playing')
    expect(timeToConverge(room, 'v1', 10_000)).toBeLessThanOrEqual(3000)
  })

  it('(7) host gone: viewers extrapolate, pause 10 s after its last word, and the room is kept', () => {
    const room = playingRoom(71)
    const goneAt = room.t
    const pausedAt = new Map<string, number>()
    for (const v of room.viewers) {
      v.engine.on('notice', (n) => {
        if (n.code === 'sync.host-gone') pausedAt.set(v.id, room.t)
      })
    }
    // a crash: nothing closes the links, the host just stops talking (its heartbeat was every 5 s)
    room.net.kill(HOST)
    const heard = room.viewers.map((v) => room.net.lastHeard(v.id, HOST) ?? NaN)
    for (const h of heard) expect(goneAt - h).toBeLessThanOrEqual(room.net.silence.heartbeatMs)
    room.loop.runUntil(Math.min(...heard) + 9500)
    for (const v of room.viewers) {
      expect(v.mpv.isRunning).toBe(true)
      expect(v.mode).toBe('playing')
    }
    room.loop.runUntil(Math.max(...heard) + 10_500)
    for (const [i, v] of room.viewers.entries()) {
      expect(v.mpv.isRunning).toBe(false)
      expect(v.engine.member.currentPhase).toBe('paused')
      expect(v.notices.at(-1)).toMatchObject({ code: 'sync.host-gone', message: 'Host disconnected — waiting' })
      // the 7 s of silence it took to notice are part of the 10 s, not added to them
      expect(Math.abs((pausedAt.get(v.id) ?? NaN) - (heard[i] ?? NaN) - 10_000)).toBeLessThan(5)
    }
    room.run(5 * 60_000)
    // No automatic end: the room state is kept and viewers stay connected to each other.
    for (const v of room.viewers) {
      expect(v.mode).toBe('playing')
      expect(v.mpv.isRunning).toBe(false)
    }
    expect(room.net.connected('v1', 'v2')).toBe(true)
  })

  it('host app restart: resumes the room paused with the same syncEpoch and seq + 1', () => {
    const room = playingRoom(72)
    const snap = room.host.persisted.at(-1)
    expect(snap?.lastAnchor.mode).toBe('playing')
    const before = room.host.engine.snapshot()
    expect(before).not.toBeNull()
    if (!before) return
    const resumed = new SimRoom({ seed: 73, resume: before, viewers: [{ id: 'v1' }] })
    resumed.start()
    resumed.run(3000)
    // The first publish carries seq + 1; metadata republishes (members joining) may follow.
    expect(resumed.host.applied[0]?.state).toMatchObject({ syncEpoch: before.syncEpoch, seq: before.seq + 1 })
    expect(resumed.node('v1').applied.every((a) => a.state.syncEpoch === before.syncEpoch)).toBe(true)
    const st = resumed.host.engine.group?.state()
    expect(st).toMatchObject({ syncEpoch: before.syncEpoch, mode: 'paused' })
    expect(st?.anchor.pos).toBeCloseTo(before.lastAnchor.posS, 3)
    expect(Math.abs(resumed.node('v1').mpv.pos() - before.lastAnchor.posS)).toBeLessThan(0.05)
    void resumed.intent(HOST, { kind: 'play' })
    resumed.run(3000)
    expect(resumed.node('v1').mpv.isRunning).toBe(true)
  })

  it('host process restart under kept viewers: they estimate its new clock afresh and follow the resumed room', () => {
    const room = playingRoom(74)
    const v = room.node('v1')
    const est = { theta: null as number | null }
    v.engine.on('clock', (c) => (est.theta = c.offsetMs))
    const snap = room.host.engine.snapshot()
    if (!snap) throw new Error('no snapshot')
    room.host.engine.stop()
    room.net.kill(HOST)
    room.run(12_000)
    expect(v.engine.member.currentPhase).toBe('paused') // held: host gone
    // performance.now starts over in the new process: its clock reads seconds where the old one read hours,
    // and its engine runs only once the session has re-prepared, so the pings on reconnect go unanswered
    const host = room.restartHost({ offsetMs: 5000 - room.t, resume: snap, engineAfterMs: 3000 })
    expect(room.runUntil(() => v.engine.member.state?.cause?.kind === 'restore', 10_000)).toBe(true)
    room.run(1000)
    const trueTheta = host.clock.now() - v.clock.now()
    expect(est.theta).not.toBeNull()
    expect(Math.abs((est.theta ?? NaN) - trueTheta)).toBeLessThan(100)
    void room.intent(HOST, { kind: 'play' })
    expect(timeToConverge(room, 'v1', 10_000)).toBeLessThanOrEqual(3000)
    expect(timeToConverge(room, 'v2', 10_000)).toBeLessThanOrEqual(3000)
  })

  // PlayerController reloads the last file itself when mpv comes back or loads something else, right after the
  // member's own load (late joiner style, at its rendezvous ahead of the room): mpv lands where the second one
  // put it. Sessions now leave every reload to the member (selfReload: false); the guard stays for other callers.
  function recordLoads(v: SimNode): number[] {
    const loads: number[] = []
    const load = v.mpv.load.bind(v.mpv)
    v.mpv.load = (src, opts) => {
      loads.push(opts.startS)
      load(src, opts)
    }
    return loads
  }

  function expectMetWithin3s(room: SimRoom, v: SimNode, loads: number[]): void {
    expect(room.runUntil(() => v.mpv.snapshot().loaded, 5000)).toBe(true)
    // the race happened: the member loaded ahead, the controller's reload at the room position won
    expect(loads).toHaveLength(2)
    expect((loads[0] ?? 0) - (loads[1] ?? 0)).toBeGreaterThan(MEMBER.RENDEZVOUS_MARGIN_MS / 1000)
    expect(Math.abs((v.mpv.snapshot().timePosS ?? 0) - (loads[1] ?? 0))).toBeLessThan(0.05)
    const restartedAt = room.t
    room.loop.runUntil(restartedAt + 3000)
    expect(v.mpv.isRunning).toBe(true)
    expect(Math.abs(v.mpv.pos() - room.host.mpv.pos()) * 1000).toBeLessThan(CONVERGED_MS)
    expect(timeToConverge(room, v.id, 5000)).toBeLessThan(1000)
  }

  it("a viewer's mpv crashes while the room plays: it meets the room from wherever the controller's reload put mpv", () => {
    const room = playingRoom(81)
    const v = room.node('v1')
    expect(inSync(room, 'v1')).toBe(true)
    v.mpv.crash()
    room.run(1000) // the controller restarts mpv after a delay
    expect(v.engine.member.currentPhase).toBe('no-player')
    const loads = recordLoads(v)
    v.mpv.respawn(() => v.engine.roomPosition() ?? 0)
    expectMetWithin3s(room, v, loads)
  })

  it("a viewer's mpv loads another file while the room plays: same race, met the same way", () => {
    const room = playingRoom(82)
    const v = room.node('v1')
    expect(inSync(room, 'v1')).toBe(true)
    const loads = recordLoads(v)
    v.mpv.externalPathChange(() => v.engine.roomPosition() ?? 0)
    expectMetWithin3s(room, v, loads)
  })

  // What sessions run: the player leaves every reload to the member (selfReload: false), so there is one load.

  /** The member's single load after mpv came back: just ahead of the room (the data is local), met in 3 s. */
  function expectOneLoadMet(room: SimRoom, n: SimNode, loads: number[]): void {
    const roomAt = n.engine.roomPosition() ?? NaN
    expect(room.runUntil(() => n.mpv.snapshot().loaded, 5000)).toBe(true)
    const loadedAt = room.t
    expect(loads).toHaveLength(1)
    // a seek plus a margin ahead of the room, not estReady (6 s) ahead
    expect((loads[0] ?? NaN) - roomAt).toBeGreaterThan(MEMBER.RENDEZVOUS_MARGIN_MS / 1000)
    expect((loads[0] ?? NaN) - roomAt).toBeLessThan(1.5)
    room.loop.runUntil(loadedAt + 3000)
    expect(n.mpv.isRunning).toBe(true)
    expect(Math.abs(n.mpv.pos() - (n.engine.roomPosition() ?? NaN)) * 1000).toBeLessThan(CONVERGED_MS)
    expect(loads).toHaveLength(1)
    expect(n.mpv.src).toBe(`sim://${n.id}`)
  }

  it("a viewer's mpv crashes while the room plays and only its member reloads it: one load, met within 3 s", () => {
    const room = playingRoom(83)
    const v = room.node('v1')
    expect(inSync(room, 'v1')).toBe(true)
    v.mpv.crash()
    room.run(1000)
    const loads = recordLoads(v)
    v.mpv.respawn()
    expectOneLoadMet(room, v, loads)
    expect(timeToConverge(room, 'v1', 5000)).toBeLessThan(1000)
  })

  it("the host's own mpv crashes while the room plays: its member reloads it just ahead, viewers play on", () => {
    const room = playingRoom(84)
    const h = room.host
    h.mpv.crash()
    room.run(1000)
    const loads = recordLoads(h)
    h.mpv.respawn()
    expectOneLoadMet(room, h, loads)
    expect(room.host.mode).toBe('playing')
    for (const v of room.viewers) expect(timeToConverge(room, v.id, 5000)).toBeLessThan(1000)
  })

  it("another client's file while our load opens: that load fails as superseded and ours is loaded again at once", () => {
    const room = playingRoom(87)
    const v = room.node('v1')
    v.mpv.crash()
    room.run(1000)
    const loads = recordLoads(v)
    v.mpv.respawn()
    expect(loads).toHaveLength(1) // the member's load, opening now
    room.run(100)
    // the other file never gets as far as its own playback-restart: nothing but the failed load says ours is gone
    v.mpv.foreignFile({ idle: true })
    expect(room.runUntil(() => v.mpv.snapshot().loaded, 3000)).toBe(true)
    expect(loads).toHaveLength(2)
    expect(v.mpv.src).toBe('sim://v1')
    expect(timeToConverge(room, 'v1', 5000)).toBeLessThan(1000)
    expect(loads).toHaveLength(2)
  })

  // The other file's own playback-restart can reach the member after its next load went out (the player passes
  // every mpv restart on): it does not complete that load, which would otherwise be loaded a third time.
  for (const restartAfterMs of [30, 150]) {
    it(`another client's file while our load opens, its playback-restart ${String(restartAfterMs)} ms later: loaded again once`, () => {
      const room = playingRoom(87)
      const v = room.node('v1')
      v.mpv.crash()
      room.run(1000)
      const loads = recordLoads(v)
      v.mpv.respawn()
      room.run(100)
      const replacedAt = room.t
      v.mpv.foreignFile({ idle: true, restartAfterMs })
      expect(room.runUntil(() => v.mpv.snapshot().loaded, 3000)).toBe(true)
      // the second load's own time, not the other file's restart plus a third load's
      expect(room.t - replacedAt).toBeLessThanOrEqual(v.mpv.o.loadLatMs + 20)
      expect(loads).toHaveLength(2)
      expect(v.mpv.src).toBe('sim://v1')
      expect(timeToConverge(room, 'v1', 5000)).toBeLessThan(1000)
      expect(loads).toHaveLength(2)
    })
  }

  it("another client's stop while our load opens: that load fails as superseded and ours is loaded again at once", () => {
    const room = playingRoom(90)
    const v = room.node('v1')
    v.mpv.crash()
    room.run(1000)
    const loads = recordLoads(v)
    v.mpv.respawn()
    expect(loads).toHaveLength(1)
    room.run(100)
    const stoppedAt = room.t
    // mpv is left empty: no file's restart comes, only the failed load says ours is gone
    v.mpv.foreignStop()
    expect(room.runUntil(() => v.mpv.snapshot().loaded, 3000)).toBe(true)
    expect(room.t - stoppedAt).toBeLessThanOrEqual(v.mpv.o.loadLatMs + 20)
    expect(loads).toHaveLength(2)
    expect(v.mpv.src).toBe('sim://v1')
    expect(timeToConverge(room, 'v1', 5000)).toBeLessThan(1000)
    expect(loads).toHaveLength(2)
  })

  it("another client's stop while the room plays: the member loads its file again, once, and meets the room", () => {
    const room = playingRoom(91)
    const v = room.node('v1')
    expect(inSync(room, 'v1')).toBe(true)
    const loads = recordLoads(v)
    v.mpv.foreignStop()
    expect(v.mpv.src).toBe('sim://v1') // reloaded on the spot: the player went idle
    expectOneLoadMet(room, v, loads)
    expect(timeToConverge(room, 'v1', 5000)).toBeLessThan(1000)
  })

  it('a file mpv cannot open is tried again after 1, 2, 4… s, not in a loop, and the room is met once it opens', () => {
    const room = playingRoom(88)
    const v = room.node('v1')
    v.mpv.crash()
    room.run(1000)
    const loads: number[] = []
    const load = v.mpv.load.bind(v.mpv)
    v.mpv.load = (src, opts) => {
      loads.push(room.t)
      load(src, opts)
    }
    v.mpv.unopenable = true
    v.mpv.respawn()
    room.run(20_000)
    expect(v.engine.member.currentPhase).toBe('loading')
    // each try takes mpv 0.4 s to give up; the pause after it doubles from 1 s (capped at 30 s)
    const gaps = loads.slice(1).map((t, i) => t - (loads[i] ?? 0))
    expect(gaps.length).toBeGreaterThanOrEqual(3)
    expect(gaps.length).toBeLessThanOrEqual(5)
    for (const [i, gap] of gaps.entries()) {
      const pause = Math.min(MEMBER.LOAD_RETRY_MIN_MS * 2 ** i, MEMBER.LOAD_RETRY_MAX_MS)
      expect(gap).toBeGreaterThanOrEqual(pause + v.mpv.o.loadLatMs - 1)
      expect(gap).toBeLessThan(pause + v.mpv.o.loadLatMs + 50)
    }
    // the file can be opened again (e.g. it was moved back): the next try loads it and meets the room
    v.mpv.unopenable = false
    expect(room.runUntil(() => v.mpv.snapshot().loaded, 20_000)).toBe(true)
    expect(timeToConverge(room, 'v1', 5000)).toBeLessThan(1000)
    expect(room.host.mode).toBe('playing')
    // a load that worked ends the streak: the next file mpv cannot open is tried again after 1 s
    v.mpv.crash()
    room.run(1000)
    loads.length = 0
    v.mpv.unopenable = true
    v.mpv.respawn()
    room.run(3000)
    expect(loads).toHaveLength(2)
    expect((loads[1] ?? 0) - (loads[0] ?? 0)).toBeLessThan(MEMBER.LOAD_RETRY_MIN_MS + v.mpv.o.loadLatMs + 50)
  })

  for (const idle of [true, false]) {
    it(`another client's file while the host is gone: the member reloads its own at once (player ${idle ? 'idle' : 'still ready'})`, () => {
      const room = playingRoom(idle ? 85 : 86)
      const v = room.node('v1')
      room.net.disconnect(HOST, 'v1')
      expect(room.runUntil(() => v.notices.at(-1)?.code === 'sync.host-gone', 15_000)).toBe(true)
      const loads = recordLoads(v)
      v.mpv.foreignFile({ idle })
      // reloaded while still holding: paused on our own file again, not on the other one
      expect(room.runUntil(() => v.mpv.snapshot().loaded, 3000)).toBe(true)
      expect(loads).toHaveLength(1)
      expect(v.mpv.src).toBe('sim://v1')
      expect(v.mpv.isRunning).toBe(false)
      room.run(5000)
      expect(v.mpv.isRunning).toBe(false)
      expect(v.engine.member.currentPhase).toBe('paused')
      room.net.connect(HOST, 'v1')
      expect(timeToConverge(room, 'v1', 10_000)).toBeLessThanOrEqual(3000)
      expect(v.mpv.src).toBe('sim://v1')
      expect(loads).toHaveLength(1)
    })
  }
})
