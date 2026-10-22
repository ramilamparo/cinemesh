import { describe, expect, it } from 'vitest'
import { EventLoop, NodeClock, rng } from '../../../test/sync/sim/loop.js'
import type { NoticeEvent, PlaybackEvent } from '../../shared/ipc/core.js'
import { SyncEngine } from './engine.js'
import { MEMBER } from './member.js'
import type { PlayerSnapshot, PresenceEvent } from './ports.js'
import type { Cause, SyncBusMessage, SyncState } from './protocol.js'

const HOST = 'host'

const NO_PLAYER: PlayerSnapshot = {
  available: false,
  loaded: false,
  paused: true,
  pausedForCache: false,
  seeking: false,
  coreIdle: true,
  eof: false,
  timePosS: null,
  speed: 1,
  spdif: false,
  frameDrops: 0,
  frameS: 1 / 24,
}

/** An idle mpv (started without --pause, nothing loaded): mpv's own pause flag is off. */
const IDLE_MPV: PlayerSnapshot = { ...NO_PLAYER, available: true, paused: false }

/** A viewer engine on a still clock, fed bus messages by hand; pings go over the bus. */
function viewer(player: PlayerSnapshot = NO_PLAYER) {
  const loop = new EventLoop()
  const clock = new NodeClock(loop, rng(1), { offsetMs: 2e6, skewPpm: 0, timerLateMs: 0 })
  const sent: SyncBusMessage[] = []
  let onBus: (from: string, raw: unknown) => void = () => undefined
  let onPresence: (ev: PresenceEvent) => void = () => undefined
  const engine = new SyncEngine({
    role: 'viewer',
    selfId: 'v1',
    selfName: 'Sam',
    hostId: HOST,
    nudge: true,
    ports: {
      clock,
      player: {
        load: () => undefined,
        seek: () => undefined,
        setPaused: () => undefined,
        setSpeed: () => undefined,
        sample: (cb) => cb(null),
        readTimePos: (cb) => cb(null),
        snapshot: () => player,
        on: () => () => undefined,
      },
      bus: {
        publish: (msg) => sent.push(msg),
        onMessage: (fn) => {
          onBus = fn
          return () => undefined
        },
        onPresence: (fn) => {
          onPresence = fn
          return () => undefined
        },
      },
      datagram: { send: () => undefined, usable: () => false, onMessage: () => () => undefined },
      media: {
        durationS: () => 600,
        readiness: () => true,
        bufferedAheadS: () => 600,
        needBps: () => 0,
        playhead: { set: () => undefined },
        onChange: () => () => undefined,
      },
      transfer: { rateBps: () => 0, etaToEofS: () => 0, coverage: () => null, diskFull: () => false },
    },
  })
  const notices: { t: number; n: NoticeEvent }[] = []
  engine.on('notice', (n) => notices.push({ t: loop.t, n }))
  const playback: PlaybackEvent[] = []
  engine.on('playback', (p) => playback.push(p))
  engine.start()
  const answered = new Set<number>()
  return {
    loop,
    notices,
    playback,
    presence: (ev: PresenceEvent): void => onPresence(ev),
    /** the host answers every outstanding ping with its clock reading hostNow */
    answer(hostNow: number): void {
      for (const m of sent) {
        if (m.t !== 'sync.ping' || answered.has(m.id)) continue
        answered.add(m.id)
        onBus(HOST, { t: 'sync.pong', id: m.id, t0: m.t0, t1: hostNow, t2: hostNow })
      }
    },
    state(o: Partial<SyncState>): void {
      onBus(HOST, {
        t: 'sync.state',
        v: 1,
        syncEpoch: 7,
        seq: 1,
        mode: 'paused',
        anchor: { pos: 10, hostTime: 0, rate: 1 },
        perms: { othersPlayPause: false, othersSeek: false },
        waitForAll: true,
        startMode: { kind: 'buffered', seconds: 0 },
        cause: null,
        members: [],
        sentAt: 0,
        ...o,
      } satisfies SyncState)
    },
    /** θ̂, or null while there is no estimate */
    offset: (): number | null => (engine as unknown as { clockClient: { offset: number | null } }).clockClient.offset,
    engine,
  }
}

/** The host's engine with a member 'v1' present, every bus publish recorded, members' messages fed by hand. */
function host() {
  const loop = new EventLoop()
  const clock = new NodeClock(loop, rng(2), { offsetMs: 5e6, skewPpm: 0, timerLateMs: 0 })
  const sent: { msg: SyncBusMessage; to: string | undefined }[] = []
  let onBus: (from: string, raw: unknown) => void = () => undefined
  let onPresence: (ev: PresenceEvent) => void = () => undefined
  const engine = new SyncEngine({
    role: 'host',
    selfId: HOST,
    selfName: 'Host',
    hostId: HOST,
    nudge: true,
    ports: {
      clock,
      player: {
        load: () => undefined,
        seek: () => undefined,
        setPaused: () => undefined,
        setSpeed: () => undefined,
        sample: (cb) => cb(null),
        readTimePos: (cb) => cb(null),
        snapshot: () => NO_PLAYER,
        on: () => () => undefined,
      },
      bus: {
        publish: (msg, opts) => sent.push({ msg, to: opts?.to }),
        onMessage: (fn) => {
          onBus = fn
          return () => undefined
        },
        onPresence: (fn) => {
          onPresence = fn
          return () => undefined
        },
      },
      datagram: { send: () => undefined, usable: () => false, onMessage: () => () => undefined },
      media: {
        durationS: () => 600,
        readiness: () => true,
        bufferedAheadS: () => 600,
        needBps: () => 0,
        playhead: { set: () => undefined },
        onChange: () => () => undefined,
      },
      transfer: { rateBps: () => 0, etaToEofS: () => 0, coverage: () => null, diskFull: () => false },
    },
    host: {
      syncEpoch: 7,
      perms: { othersPlayPause: false, othersSeek: false },
      waitForAll: true,
      startMode: { kind: 'buffered', seconds: 0 },
    },
  })
  const notices: NoticeEvent[] = []
  engine.on('notice', (n) => notices.push(n))
  engine.start()
  engine.mediaReady(600)
  onPresence({ kind: 'join', peerId: 'v1', name: 'Sam' })
  return { loop, sent, notices, engine, bus: (from: string, raw: unknown) => onBus(from, raw), presence: onPresence }
}

describe('SyncEngine (host): a member that floods hellos and Ask host', () => {
  it('has its hellos answered at most once a second, the last one late, with the current state', () => {
    const h = host()
    h.loop.runFor(1000)
    const answers = (): SyncBusMessage[] => h.sent.filter((s) => s.to === 'v1').map((s) => s.msg)
    const t0 = h.loop.t
    for (let i = 0; i < 900; i++) {
      h.bus('v1', { t: 'sync.hello', resume: null })
      h.loop.runFor(1)
    }
    expect(answers()).toHaveLength(1)
    h.loop.runUntil(t0 + 3000)
    expect(answers()).toHaveLength(2)
    expect(answers().every((m) => m.t === 'sync.state')).toBe(true)
    // the one held back goes out with the state of when it goes out
    expect(answers()[1]).toEqual(h.engine.group?.state())
    // a hello after a quiet second is answered at once
    h.bus('v1', { t: 'sync.hello', resume: null })
    expect(answers()).toHaveLength(3)
    h.engine.stop()
  })

  it('shows one of its requests per 2 s: the first at once, the latest when the 2 s are up', () => {
    const h = host()
    const requests = (): NoticeEvent[] => h.notices.filter((n) => n.code === 'sync.request')
    const t0 = h.loop.t
    for (let i = 0; i < 1000; i++) {
      h.bus('v1', { t: 'sync.request', kind: 'seek', pos: i })
      h.loop.runFor(1)
    }
    expect(requests().map((n) => n.message)).toEqual(['Sam asks to skip to 0:00'])
    h.loop.runUntil(t0 + 3000)
    expect(requests().map((n) => n.message)).toEqual(['Sam asks to skip to 0:00', 'Sam asks to skip to 16:39'])
    // gone: nothing held for it fires
    h.bus('v1', { t: 'sync.request', kind: 'play' })
    h.presence({ kind: 'leave', peerId: 'v1', name: 'Sam' })
    h.loop.runFor(5000)
    expect(requests()).toHaveLength(2)
    h.engine.stop()
  })
})

describe('SyncEngine (viewer): the host clock across a host restart', () => {
  it('keeps θ̂ for states from the same host process', () => {
    const v = viewer()
    v.answer(9e6)
    const theta = v.offset()
    expect(theta).not.toBeNull()
    v.state({ seq: 5, sentAt: 9e6 })
    v.state({ seq: 6, sentAt: 9e6 + 500, cause: { by: HOST, kind: 'pause', at: 9e6 + 500 } })
    v.state({ seq: 6, sentAt: 9e6 + 500, cause: { by: HOST, kind: 'pause', at: 9e6 + 500 } }) // the reliable copy
    expect(v.offset()).toBe(theta)
    v.engine.stop()
  })

  it('estimates afresh when a state was sent "before" the last one: performance.now started over', () => {
    const v = viewer()
    v.answer(9e6)
    v.state({ seq: 6, sentAt: 9e6 + 500 })
    // e.g. the first state seen from a resumed host that has already moved on from its restore
    v.state({ seq: 1010, sentAt: 4000, cause: { by: HOST, kind: 'play', at: 3900 } })
    expect(v.offset()).toBeNull()
    v.answer(4100)
    expect(v.offset()).toBeCloseTo(4100 - 2e6, 6)
    v.engine.stop()
  })

  it('estimates afresh on a restored group, even when the new clock reads more than the old one did', () => {
    const v = viewer()
    v.answer(9e6)
    v.state({ seq: 6, sentAt: 9e6 + 500 })
    const restore: Cause = { by: HOST, kind: 'restore', at: 9.5e6 }
    v.state({ seq: 1007, sentAt: 9.5e6, cause: restore })
    expect(v.offset()).toBeNull()
    v.answer(9.5e6 + 50)
    // its metadata republishes carry the same restore cause: that is not another restart
    v.state({ seq: 1008, sentAt: 9.5e6 + 1000, cause: restore })
    expect(v.offset()).toBeCloseTo(9.5e6 + 50 - 2e6, 6)
    v.engine.stop()
  })

  it('estimates afresh on another epoch: a host that restarted with nothing to resume', () => {
    const v = viewer()
    v.answer(9e6)
    v.state({ seq: 6, sentAt: 9e6 + 500 })
    v.state({ syncEpoch: 8, seq: 1, sentAt: 9.6e6 })
    expect(v.offset()).toBeNull()
    v.engine.stop()
  })
})

describe('SyncEngine (viewer): host gone', () => {
  const goneAt = (v: ReturnType<typeof viewer>): number | undefined =>
    v.notices.find((x) => x.n.code === 'sync.host-gone')?.t

  it("pauses 10 s after the host's last word: a silence noticed after 7 s leaves 3 s", () => {
    const v = viewer()
    v.state({ mode: 'playing', seq: 2 })
    v.loop.runFor(1000)
    const at = v.loop.t
    v.presence({ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 7000 })
    v.loop.runUntil(at + MEMBER.HOST_GONE_MS - 7000 - 5)
    expect(goneAt(v)).toBeUndefined()
    v.loop.runFor(10)
    expect(goneAt(v)).toBeCloseTo(at + 3000, 0)
    expect(v.engine.member.currentPhase).toBe('paused')
    v.engine.stop()
  })

  it('a bye or a closed link (no silence) gives the whole 10 s; a word older than that pauses at once', () => {
    const v = viewer()
    v.state({ mode: 'playing', seq: 2 })
    const at = v.loop.t
    v.presence({ kind: 'leave', peerId: HOST, name: 'Host' })
    v.loop.runUntil(at + MEMBER.HOST_GONE_MS - 5)
    expect(goneAt(v)).toBeUndefined()
    v.loop.runFor(10)
    expect(goneAt(v)).toBeCloseTo(at + MEMBER.HOST_GONE_MS, 0)

    // back, then gone again long after its last word (e.g. a link that closed only when UDX gave up)
    v.presence({ kind: 'join', peerId: HOST, name: 'Host' })
    v.notices.length = 0
    const again = v.loop.t
    v.presence({ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 15_000 })
    v.loop.runFor(5)
    expect(goneAt(v)).toBeCloseTo(again, 0)
    v.engine.stop()
  })

  it('a host that is back before the 10 s are up never pauses the room', () => {
    const v = viewer()
    v.state({ mode: 'playing', seq: 2 })
    v.presence({ kind: 'leave', peerId: HOST, name: 'Host', sinceMs: 8000 })
    v.loop.runFor(1500)
    v.presence({ kind: 'join', peerId: HOST, name: 'Host' })
    v.loop.runFor(20_000)
    expect(goneAt(v)).toBeUndefined()
    v.engine.stop()
  })
})

describe('SyncEngine (viewer): playback with nothing loaded', () => {
  // a full download still running, a member without its source yet, mpv starting: the transport shows the room

  it('a playing room runs on from where it is, whatever the idle mpv says', () => {
    const v = viewer(IDLE_MPV)
    v.answer(9e6) // the host clock reads 9e6 when ours reads 2e6
    v.state({ mode: 'playing', seq: 2, anchor: { pos: 10, hostTime: 9e6 - 3000, rate: 1 }, sentAt: 9e6 })
    v.loop.runFor(2000)
    const last = v.playback.at(-1)
    expect(last).toMatchObject({ paused: false, seeking: false, stalled: false, durationS: 600 })
    // 3 s past the anchor when the state came, 2 s since: the frozen anchor would say 10
    expect(last?.posS).toBeCloseTo(15, 0)
    v.engine.stop()
  })

  it('a paused room shows paused where it is, although an idle mpv reports pause off', () => {
    const v = viewer(IDLE_MPV)
    v.answer(9e6)
    v.state({ mode: 'paused', seq: 2, anchor: { pos: 42, hostTime: 9e6, rate: 1 }, sentAt: 9e6 })
    v.loop.runFor(1000)
    expect(v.playback.at(-1)).toMatchObject({ posS: 42, paused: true, seeking: false, stalled: false })
    v.engine.stop()
  })

  it('before the host clock is known a playing room shows its anchor, not a position from our own clock', () => {
    const v = viewer(IDLE_MPV)
    v.state({ mode: 'playing', seq: 2, anchor: { pos: 10, hostTime: 0, rate: 1 } })
    v.loop.runFor(500)
    expect(v.offset()).toBeNull()
    expect(v.playback.at(-1)).toMatchObject({ posS: 10, paused: false })
    expect(v.engine.roomPosition()).toBe(10)
    v.engine.stop()
  })
})
