// Where a paused member really is, and so where its next start begins (MemberController, src/core/sync/member.ts):
// - after its own exact seek or load, on the frame mpv landed on (ADR 0007 Finding 4), read, not assumed;
// - after a pause from playback, the audio position read at once, kept even when mpv reports the pause change in a
//   later read than the reply (ADR 0008 §4.2; this was test/alpha/settle-exact.test.ts);
// - not re-read when a state for the position it holds arrives: after a pause from playback, a paused seek or load
//   leaves audio-pts early by the AO's old delay until the next unpause (ADR 0007 Finding 5);
// and what the member learns from its seeks and starts: seekLat from every exact seek (ADR 0007 Finding 6), the
// unpause latency from its first probe, and the start error trimmed toward the anchor (ADR 0008 §4.4).
//
// Deterministic: a virtual clock and a scripted mpv.
import { describe, expect, it } from 'vitest'
import type { DesyncInfo } from '../../src/core/sync/desync.js'
import { DRIFT } from '../../src/core/sync/drift.js'
import { MEMBER, MemberController } from '../../src/core/sync/member.js'
import type {
  Clock,
  MediaPort,
  PlayerEvents,
  PlayerPort,
  PlayerSnapshot,
  PlayheadReason,
  PositionSample,
  TimerHandle,
  TransferPort,
} from '../../src/core/sync/ports.js'
import { type SyncState, type SyncStatus, parseBusMessage } from '../../src/core/sync/protocol.js'

class VirtualClock implements Clock {
  t = 0
  private queue: { at: number; seq: number; fn: () => void; dead: boolean }[] = []
  private seq = 0
  now(): number {
    return this.t
  }
  setTimer(ms: number, fn: () => void): TimerHandle {
    const e = { at: this.t + Math.max(0, ms), seq: this.seq++, fn, dead: false }
    this.queue.push(e)
    return { cancel: () => (e.dead = true) }
  }
  /** a turn of the event loop takes a little time: a spin on immediates (the unpause) gets to its deadline */
  immediate(fn: () => void): TimerHandle {
    return this.setTimer(0.05, fn)
  }
  loopLagMs(): number {
    return 0
  }
  /** runs everything due up to t + ms, in time order */
  advance(ms: number): void {
    const end = this.t + ms
    for (;;) {
      this.queue = this.queue.filter((e) => !e.dead)
      this.queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
      const next = this.queue[0]
      if (!next || next.at > end) break
      this.queue.shift()
      this.t = Math.max(this.t, next.at)
      next.fn()
    }
    this.t = end
  }
}

interface MpvScript {
  /** the file's frame rate: time-pos is quantised to its frames, and the snapshot reports 1/fps (container-fps) */
  fps: number
  /** container-fps as mpv reports it, when it is not the frames' real rate (VFR, a nominal figure) */
  reportedFps?: number
  /** snapshot().paused (the observed property) flips this long after the pause takes effect */
  flagDelayMs: number
  /** audio starts moving this long after an unpause */
  startLatMs: number
  /** seek → playback-restart */
  seekMs: number
  /** seeks and loads land on the first frame at or after target − 5 ms (mpv's exact seek), not on the target */
  frameLanding: boolean
  /** after a pause from playback, a paused seek or load leaves audio-pts this much early (0: never) */
  staleMs: number
}

const SCRIPT: MpvScript = { fps: 24, flagDelayMs: 0.5, startLatMs: 30, seekMs: 50, frameLanding: false, staleMs: 0 }

/**
 * mpv as the member sees it through PlayerPortAdapter: commands take effect in order at once, the observed pause
 * flag follows `flagDelayMs` later, replies come 1 ms after the request, and audio moves at the set speed.
 */
class ScriptedMpv implements PlayerPort {
  private pausedReal = true
  private pausedFlag = true
  private base = 0
  private baseT = 0
  private moving = false
  private speed = 1
  private played = false
  private stale = false
  /** stall(true): stopped for data mpv does not have (paused-for-cache) */
  private stalled = false
  /** nothing is loaded until the first load's restart */
  private loaded = false
  /** frame-drop-count plus decoder-frame-drop-count */
  drops = 0
  readonly samples: number[] = []
  readonly seeks: number[] = []
  readonly unpauses: number[] = []
  private readonly listeners = new Map<string, Set<(d: unknown) => void>>()

  constructor(
    private readonly clock: VirtualClock,
    private readonly o: MpvScript,
  ) {}

  setSeekMs(ms: number): void {
    this.o.seekMs = ms
  }

  /** playback loses `s` seconds at once, as after a stall the member did not see */
  slip(s: number): void {
    this.base -= s
  }

  /** Playback stops where it is for data it does not have (paused-for-cache), until stall(false) or a seek. */
  stall(on: boolean): void {
    if (on === this.stalled) return
    this.base = this.pos()
    this.baseT = this.clock.t
    this.stalled = on
    this.moving = !on && !this.pausedReal && this.played
    this.fire('buffering', on)
  }

  pos(): number {
    return this.moving ? this.base + ((this.clock.t - this.baseT) / 1000) * this.speed : this.base
  }

  load(_src: string, opts: { startS: number; paused: boolean }): void {
    this.land(opts.startS)
    this.pausedReal = this.pausedFlag = true
    this.moving = false
    this.clock.setTimer(100, () => {
      this.loaded = true
      this.fire('playbackRestart', undefined)
    })
  }

  seek(posS: number): void {
    this.seeks.push(posS)
    this.land(posS)
    // the data is anywhere but where it stopped: playing again from the restart
    const unstall = this.stalled
    this.stalled = false
    this.clock.setTimer(this.o.seekMs, () => {
      if (unstall && !this.pausedReal) {
        this.baseT = this.clock.t
        this.moving = true
      }
      this.fire('playbackRestart', undefined)
    })
  }

  setPaused(paused: boolean): void {
    if (paused === this.pausedReal) return
    this.pausedReal = paused
    if (paused) {
      this.base = this.pos()
      this.moving = false
    } else {
      this.unpauses.push(this.clock.t)
      this.clock.setTimer(this.o.startLatMs, () => {
        if (this.pausedReal || this.stalled) return
        this.baseT = this.clock.t
        this.moving = true
        this.played = true
        this.stale = false
      })
    }
    this.clock.setTimer(this.o.flagDelayMs, () => {
      this.pausedFlag = this.pausedReal
      this.fire('state', this.snapshot())
    })
  }

  setSpeed(speed: number): void {
    this.base = this.pos()
    this.baseT = this.clock.t
    this.speed = speed
  }

  sample(cb: (s: PositionSample | null) => void): void {
    const tSend = this.clock.t
    const early = this.stale && !this.moving ? this.o.staleMs / 1000 : 0
    const posS = this.pos() - early
    this.samples.push(posS)
    this.clock.setTimer(1, () => cb({ posS, tSend, tRecv: this.clock.t }))
  }

  /** the frame shown, where playback starts; with exact landing, a file whose position is not frame-bound */
  readTimePos(cb: (posS: number | null) => void): void {
    const at = this.o.frameLanding ? this.timePos() : this.pos()
    this.clock.setTimer(1, () => cb(at))
  }

  snapshot(): PlayerSnapshot {
    return {
      available: true,
      loaded: this.loaded,
      paused: this.pausedFlag,
      pausedForCache: this.stalled,
      seeking: false,
      coreIdle: false,
      eof: false,
      timePosS: this.timePos(),
      speed: this.speed,
      spdif: false,
      frameDrops: this.drops,
      frameS: 1 / (this.o.reportedFps ?? this.o.fps),
    }
  }

  on<E extends keyof PlayerEvents>(event: E, fn: (data: PlayerEvents[E]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(fn as (d: unknown) => void)
    this.listeners.set(event, set)
    return () => set.delete(fn as (d: unknown) => void)
  }

  private timePos(): number {
    return Math.floor(this.pos() * this.o.fps + 1e-9) / this.o.fps
  }

  private land(target: number): void {
    this.base = this.o.frameLanding ? Math.ceil((target - 0.005) * this.o.fps - 1e-9) / this.o.fps : target
    this.baseT = this.clock.t
    if (!this.moving && this.played) this.stale = true
  }

  private fire(event: string, data: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(data)
  }
}

/** The bitrate the file needs and the download's rate and ETA, read live: a test may change them. */
interface Rates {
  needBps: number
  rateBps: number
  etaToEofS: number | null
  /** the member's own download limit; absent, the port has no downLimitBps (the host's) */
  downLimitBps?: number | null
}

/** `bufferedS`: seconds buffered at any position, or a function a test changes; playhead calls go to `playheads`. */
function mediaWith(
  bufferedS: number | (() => number),
  rates: Rates,
  playheads: { posS: number; reason: PlayheadReason }[] = [],
): MediaPort {
  return {
    durationS: () => 600,
    readiness: () => true,
    bufferedAheadS: () => (typeof bufferedS === 'number' ? bufferedS : bufferedS()),
    needBps: () => rates.needBps,
    playhead: { set: (posS, reason) => playheads.push({ posS, reason }) },
    onChange: () => () => undefined,
  }
}
const transferWith = (rates: Rates): TransferPort => ({
  rateBps: () => rates.rateBps,
  etaToEofS: () => rates.etaToEofS,
  coverage: () => null,
  diskFull: () => false,
  ...('downLimitBps' in rates ? { downLimitBps: () => rates.downLimitBps ?? null } : {}),
})

/** A member on the host clock (θ̂ = 0), states applied by hand, the room's position computed from them. */
function room(
  script: Partial<MpvScript> = {},
  bufferedS: number | (() => number) = 600,
  rates: Rates = { needBps: 0, rateBps: 1e6, etaToEofS: 0 },
  opts: { desyncWarnMs?: number } = {},
) {
  const clock = new VirtualClock()
  const mpv = new ScriptedMpv(clock, { ...SCRIPT, ...script })
  const playheads: { posS: number; reason: PlayheadReason }[] = []
  const member = new MemberController({
    clock,
    player: mpv,
    media: mediaWith(bufferedS, rates, playheads),
    transfer: transferWith(rates),
    offset: () => 0,
    clockErrMs: () => 0,
    nudge: true,
    ...opts,
  })
  member.start()
  let seq = 0
  let last: SyncState | null = null
  const apply = (mode: SyncState['mode'], pos: number, hostTime = clock.t): void => {
    last = {
      t: 'sync.state',
      v: 1,
      syncEpoch: 7,
      seq: ++seq,
      mode,
      anchor: { pos, hostTime, rate: 1 },
      perms: { othersPlayPause: false, othersSeek: false },
      waitForAll: true,
      startMode: { kind: 'buffered', seconds: 0 },
      cause: null,
      members: [],
      sentAt: clock.t,
    }
    member.applyState(last)
  }
  /** the room's position now */
  const roomPos = (): number => {
    if (!last) return 0
    return last.mode === 'playing' ? last.anchor.pos + (clock.t - last.anchor.hostTime) / 1000 : last.anchor.pos
  }
  /** ms the member's mpv is ahead of the room */
  const ahead = (): number => (mpv.pos() - roomPos()) * 1000
  const statuses: SyncStatus[] = []
  member.on('status', (s) => statuses.push(s))
  return { clock, mpv, member, apply, roomPos, ahead, statuses, playheads }
}

/**
 * How far ahead of the room the member plays after: load, play, pause 3.01 s in, play again. Its first start is 20 ms
 * early (its unpause-latency estimate starts at 50 ms, this mpv takes 30), so it is paused 20 ms past the room's
 * position, under a frame: it does not seek, it reads where it is.
 */
function aheadAfterRepause(flagDelayMs: number): number {
  // no speed changes: the 20 ms must still be there at the pause, whatever the trim does
  const r = room({ flagDelayMs })
  r.mpv.setSpeed = () => undefined
  r.apply('paused', 0)
  r.member.setSource('file')
  r.clock.advance(1000)
  r.apply('playing', 0, r.clock.t + 500)
  r.clock.advance(500 + 3010)
  r.apply('paused', r.roomPos())
  r.clock.advance(1000)
  r.apply('playing', r.roomPos(), r.clock.t + 500)
  r.clock.advance(1500)
  r.member.stop()
  return r.ahead()
}

describe('settle: the exact paused position after a pause from playback (ADR 0008 §4.2)', () => {
  it('is read and kept when mpv reports the pause before the reply: the restart meets the room', () => {
    // the first probe taught it this mpv's 30 ms, so the second start is on time
    expect(Math.abs(aheadAfterRepause(0.5))).toBeLessThan(0.5)
  })

  it('is kept as well when the pause is reported in a later read than the reply (mpv answers in order)', () => {
    // dropping the read would leave the 20 ms it was paused ahead in the second start
    expect(Math.abs(aheadAfterRepause(2))).toBeLessThan(0.5)
  })
})

/**
 * Plays, pauses (the AO keeps its delay), then the room seeks to `to` while paused and the flow before the play
 * re-sends a state for that position: the member's start, measured against the room 500 ms after the anchor, and
 * the seeks it took (a start planned from a wrong position may be rescued by a corrective seek, when there is time).
 */
function startAfterPausedSeek(
  flow: 'barrier-paused' | 'wait-after-seek',
  script: Partial<MpvScript>,
): { ahead: number; seeks: number } {
  const r = room({ startLatMs: MEMBER.UNPAUSE_LAT_INIT_MS, ...script })
  r.apply('paused', 0)
  r.member.setSource('file')
  r.clock.advance(1000)
  r.apply('playing', 0, r.clock.t + 500)
  r.clock.advance(4010) // a pause off the frame grid: within a frame of time-pos, so no seek, a read
  r.apply('paused', r.roomPos())
  r.clock.advance(1000)
  const to = 60.013 // 8.7 ms past a frame at 24 fps: an exact seek lands 33 ms past it
  if (flow === 'barrier-paused') {
    r.apply('waiting', to) // a seek barrier...
    r.clock.advance(1000)
    r.apply('paused', to) // ...that a pause ends
  } else {
    r.apply('paused', to) // a paused seek...
    r.clock.advance(1000)
    r.apply('waiting', to) // ...then a play that waits for someone else at the same position
  }
  r.clock.advance(1000)
  r.apply('playing', to, r.clock.t + 300)
  r.clock.advance(800)
  r.member.stop()
  return { ahead: r.ahead(), seeks: r.mpv.seeks.length }
}

describe('a paused seek after a pause from playback (ADR 0007 Findings 4 and 5)', () => {
  for (const flow of ['barrier-paused', 'wait-after-seek'] as const) {
    it(`${flow}: a state for the position it already holds does not re-read the stale audio-pts`, () => {
      // audio-pts reads 170 ms early until the next unpause: re-read, it would plan the start that much early
      const { ahead, seeks } = startAfterPausedSeek(flow, { staleMs: 170 })
      expect(Math.abs(ahead)).toBeLessThan(1)
      expect(seeks).toBe(1) // the room's seek, and no second one to repair the plan
    })

    it(`${flow}: the start begins on the frame the seek landed on, not the target`, () => {
      for (const staleMs of [0, 170]) {
        const { ahead, seeks } = startAfterPausedSeek(flow, { frameLanding: true, staleMs })
        expect(Math.abs(ahead)).toBeLessThan(1)
        expect(seeks).toBe(1)
      }
    })
  }

  it('a load lands on a frame too: the start after it begins there', () => {
    const r = room({ frameLanding: true, startLatMs: MEMBER.UNPAUSE_LAT_INIT_MS })
    r.apply('paused', 42.013)
    r.member.setSource('file')
    r.clock.advance(1000)
    expect(r.mpv.seeks).toEqual([]) // the load put it there: no seek
    r.apply('playing', 42.013, r.clock.t + 300)
    r.clock.advance(800)
    expect(Math.abs(r.ahead())).toBeLessThan(1)
  })
})

// Below ~21 fps a frame is longer than the 1/24 s once assumed: a landing up to 78 ms past the target looked like
// someone else's load (an extra seek in a paused room) and a seek's landing read was discarded (a start that early).
describe('a 12 fps file: frames of 83 ms', () => {
  it('a load lands up to a frame past its target: no extra seek, and the start begins there', () => {
    const r = room({ fps: 12, frameLanding: true, startLatMs: MEMBER.UNPAUSE_LAT_INIT_MS })
    r.apply('paused', 42.013) // lands at 42.083, 70 ms past
    r.member.setSource('file')
    r.clock.advance(1000)
    expect(r.mpv.seeks).toEqual([])
    r.apply('playing', 42.013, r.clock.t + 300)
    r.clock.advance(800)
    expect(Math.abs(r.ahead())).toBeLessThan(1)
    expect(r.mpv.seeks).toEqual([])
  })

  it('a nominal container-fps a little above the real rate still takes the landing for ours (mpv’s 5 ms)', () => {
    // 13 fps reported (77 ms frames), 12 real: 42.0053 lands at 42.0833, 78 ms past
    const r = room({ fps: 12, reportedFps: 13, frameLanding: true, startLatMs: MEMBER.UNPAUSE_LAT_INIT_MS })
    r.apply('paused', 42.0053)
    r.member.setSource('file')
    r.clock.advance(1000)
    expect(r.mpv.seeks).toEqual([])
    r.apply('playing', 42.0053, r.clock.t + 300)
    r.clock.advance(800)
    expect(Math.abs(r.ahead())).toBeLessThan(1)
  })

  for (const flow of ['barrier-paused', 'wait-after-seek'] as const) {
    it(`${flow}: the start begins on the frame a paused seek landed on`, () => {
      for (const staleMs of [0, 170]) {
        const { ahead, seeks } = startAfterPausedSeek(flow, { fps: 12, frameLanding: true, staleMs })
        expect(Math.abs(ahead)).toBeLessThan(1)
        expect(seeks).toBe(1)
      }
    })
  }
})

describe('seekLat (ADR 0007 Finding 6)', () => {
  it('is timed by every exact seek whose data is local, the first replacing the prior', () => {
    const r = room({ seekMs: 45 })
    r.apply('paused', 0)
    r.member.setSource('file')
    r.clock.advance(1000)
    expect(r.member.drift.seekLatMs).toBe(DRIFT.SEEK_LAT_INIT_MS) // a load is not a seek
    r.apply('paused', 30) // a paused seek
    r.clock.advance(1000)
    expect(r.member.drift.seekLatMs).toBeCloseTo(45, 6)
    r.mpv.setSeekMs(65)
    r.apply('paused', 90)
    r.clock.advance(1000)
    expect(r.member.drift.seekLatMs).toBeCloseTo(45 + DRIFT.SEEK_LAT_ALPHA * 20, 6)
  })

  it('is not timed by a seek that waits for data', () => {
    const r = room({ seekMs: 45 }, 0.5)
    r.apply('paused', 0)
    r.member.setSource('file')
    r.clock.advance(1000)
    r.apply('paused', 30)
    r.clock.advance(1000)
    expect(r.member.drift.seekLatMs).toBe(DRIFT.SEEK_LAT_INIT_MS)
  })
})

describe('the start error (ADR 0008 §4.4)', () => {
  // mpv's own unpause latency is a fraction of a ms (ADR 0007 Finding 7): the 50 ms prior starts 45 ms early
  it('is trimmed toward the anchor, though it lies inside the dead band', () => {
    const r = room({ startLatMs: 5 })
    r.apply('paused', 0)
    r.member.setSource('file')
    r.clock.advance(1000)
    r.apply('playing', 0, r.clock.t + 500)
    r.clock.advance(1000)
    expect(r.ahead()).toBeCloseTo(MEMBER.UNPAUSE_LAT_INIT_MS - 5, 0)
    r.clock.advance(10_000)
    expect(Math.abs(r.ahead())).toBeLessThan(DRIFT.OFF)
    expect(r.member.drift.speed).toBe(1)
  })

  it('is gone from the next start: the first probe replaces the prior', () => {
    const r = room({ startLatMs: 5 })
    r.apply('paused', 0)
    r.member.setSource('file')
    r.clock.advance(1000)
    r.apply('playing', 0, r.clock.t + 500)
    r.clock.advance(2000)
    expect(Math.abs(r.member.unpauseLatencyMs - 5)).toBeLessThan(1) // the read's half round trip
    r.apply('paused', r.roomPos())
    r.clock.advance(1000)
    r.apply('playing', r.roomPos(), r.clock.t + 500)
    r.clock.advance(800)
    expect(Math.abs(r.ahead())).toBeLessThan(0.5)
  })
})

describe('warnings in sync.status', () => {
  const warned = (s: SyncStatus | undefined, code: SyncStatus['warnings'][number]): boolean =>
    s?.warnings.includes(code) ?? false

  it('slow download: on after 15 s below 1.1 × need, off only after 10 s above it', () => {
    const rates: Rates = { needBps: 1_000_000, rateBps: 900_000, etaToEofS: 300 }
    const r = room({}, 600, rates)
    const last = (): SyncStatus | undefined => r.statuses.at(-1)
    r.clock.advance(MEMBER.SLOW_RATE_MS - 1000)
    expect(warned(last(), 'slow-download')).toBe(false)
    r.clock.advance(2000)
    expect(warned(last(), 'slow-download')).toBe(true)
    // a rate wavering ±5 % around the threshold, a second each way: the warning holds
    const edge = MEMBER.SLOW_RATE_FACTOR * rates.needBps
    const from = r.statuses.length
    for (let i = 0; i < 30; i++) {
      rates.rateBps = i % 2 === 0 ? edge * 1.05 : edge * 0.95
      r.clock.advance(1000)
    }
    expect(r.statuses.slice(from).every((s) => warned(s, 'slow-download'))).toBe(true)
    // fast enough for good
    rates.rateBps = edge * 1.2
    r.clock.advance(MEMBER.SLOW_CLEAR_MS - 1000)
    expect(warned(last(), 'slow-download')).toBe(true)
    r.clock.advance(2000)
    expect(warned(last(), 'slow-download')).toBe(false)
    // a finished download clears it at once
    rates.rateBps = 0
    r.clock.advance(MEMBER.SLOW_RATE_MS + 1000)
    expect(warned(last(), 'slow-download')).toBe(true)
    rates.etaToEofS = 0
    r.clock.advance(1000)
    expect(warned(last(), 'slow-download')).toBe(false)
  })

  it("reports the member's own download limit while one is set, read live; the host parses what it sends", () => {
    const rates: Rates = { needBps: 1_000_000, rateBps: 400_000, etaToEofS: 300, downLimitBps: 409_600 }
    const r = room({}, 600, rates)
    r.clock.advance(1500)
    expect(r.statuses.at(-1)?.downLimitBps).toBe(409_600)
    // a limited member still warns: the room will buffer because of it
    r.clock.advance(MEMBER.SLOW_RATE_MS)
    expect(r.statuses.at(-1)).toMatchObject({ warnings: ['slow-download'], downLimitBps: 409_600 })
    rates.downLimitBps = null
    r.clock.advance(1000)
    expect(r.statuses.at(-1)).not.toHaveProperty('downLimitBps')
    // a transfer port without it, as the host's
    const host = room()
    host.clock.advance(1500)
    expect(host.statuses.at(-1)).not.toHaveProperty('downLimitBps')
    for (const s of [...r.statuses, ...host.statuses]) expect(parseBusMessage(s)).toEqual(s)
  })

  /** Plays from 0; returns the room after `ms` of playing. */
  const playing = (ms: number) => {
    const r = room()
    r.apply('paused', 0)
    r.member.setSource('file')
    r.clock.advance(1000)
    r.apply('playing', 0, r.clock.t + 500)
    r.clock.advance(500 + ms)
    return r
  }

  it('frame drops: counted while playing', () => {
    const r = playing(5000)
    expect(warned(r.statuses.at(-1), 'frame-drops')).toBe(false)
    r.mpv.drops += 20
    r.clock.advance(1000)
    expect(warned(r.statuses.at(-1), 'frame-drops')).toBe(true)
  })

  it('frame drops: not those of a catch-up skip', () => {
    const r = playing(5000)
    const seek = r.mpv.seek.bind(r.mpv)
    // mpv drops frames as it restarts after the seek
    r.mpv.seek = (posS) => {
      seek(posS)
      r.clock.setTimer(300, () => (r.mpv.drops += 20))
    }
    // mpv falls 2 s behind the room: the drift loop skips forward
    const seeks = r.mpv.seeks.length
    r.mpv.slip(2)
    r.clock.advance(3000)
    expect(r.mpv.seeks.length).toBe(seeks + 1)
    expect(r.mpv.drops).toBe(20)
    const from = r.statuses.length
    r.clock.advance(MEMBER.FRAME_DROP_WINDOW_MS + 2000)
    expect(r.statuses.length - from).toBeGreaterThan(10)
    expect(r.statuses.slice(from).some((s) => warned(s, 'frame-drops'))).toBe(false)
    expect(Math.abs(r.ahead())).toBeLessThan(100)
  })
})

describe('the desync warning and Resync to live', () => {
  const T = 1000

  /** Plays from 0 for 5 s with the warning at `desyncWarnMs`; `buffered` says what is buffered at any position. */
  const playing = (opts: { desyncWarnMs?: number; buffered?: () => number } = {}) => {
    const r = room({}, opts.buffered ?? 600, undefined, { desyncWarnMs: opts.desyncWarnMs ?? T })
    const desync: { t: number; d: DesyncInfo | null }[] = []
    r.member.on('desync', (d) => desync.push({ t: r.clock.t, d }))
    r.apply('paused', 0)
    r.member.setSource('file')
    r.clock.advance(1000)
    r.apply('playing', 0, r.clock.t + 500)
    r.clock.advance(5500)
    expect(Math.abs(r.ahead())).toBeLessThan(DRIFT.ON)
    return { ...r, desync }
  }
  const behindAt = (x: ReturnType<typeof playing>): number | undefined =>
    x.desync.find((e) => e.d?.state === 'behind')?.t

  it('a stall in a playing room shows behind about 3 s in (1 s to the threshold, then 2 s), growing by 0.5 s', () => {
    const r = playing()
    const t0 = r.clock.t
    r.mpv.stall(true)
    r.clock.advance(6000)
    const at = behindAt(r) ?? NaN
    expect(at - t0).toBeGreaterThanOrEqual(3000)
    expect(at - t0).toBeLessThanOrEqual(3500)
    const numbers = r.desync.flatMap((e) => (e.d?.state === 'behind' ? [e.d.behindS] : []))
    expect(numbers[0]).toBeGreaterThanOrEqual(3)
    expect(numbers.every((n, i) => i === 0 || n - (numbers[i - 1] ?? 0) === 0.5)).toBe(true)
    expect(numbers.at(-1)).toBeGreaterThanOrEqual(5.5)
    expect(numbers.at(-1)).toBeLessThanOrEqual(6)
    // the host hears it in sync.status, once a second
    expect(r.statuses.at(-1)?.behindS).toBeGreaterThanOrEqual(5)
    expect(r.member.desyncState).toEqual(r.desync.at(-1)?.d)
  })

  it('Resync in a stall without the data at the room: rendezvous further ahead, paused, then in sync', () => {
    let buffered = 600
    const r = playing({ buffered: () => buffered })
    r.mpv.stall(true)
    r.clock.advance(4000)
    expect(r.member.desyncState?.state).toBe('behind')
    buffered = 0
    const seeks = r.mpv.seeks.length
    const room = r.roomPos()
    expect(r.member.resync()).toBe('rendezvous')
    expect(r.mpv.seeks.length).toBe(seeks + 1)
    // estReady (its 6 s prior) ahead of the room, where the download goes too
    expect(r.mpv.seeks.at(-1)).toBeCloseTo(room + MEMBER.EST_READY_INIT_MS / 1000, 2)
    expect(r.playheads.at(-1)).toEqual({ posS: r.mpv.seeks.at(-1), reason: 'rendezvous' })
    expect(r.member.desyncState).toEqual({ state: 'catching-up' })
    r.clock.advance(1)
    expect(r.mpv.snapshot().paused).toBe(true)
    buffered = 600
    r.clock.advance(MEMBER.EST_READY_INIT_MS + 1000)
    expect(r.mpv.snapshot().paused).toBe(false)
    expect(Math.abs(r.ahead())).toBeLessThan(100)
    expect(r.member.desyncState).toBeNull()
    // never 'behind' again on the way: catching-up straight to in sync
    const since = r.desync.findIndex((e) => e.d?.state === 'catching-up')
    expect(r.desync.slice(since).map((e) => e.d?.state ?? null)).toEqual(['catching-up', null])
  })

  it('Resync behind with the data at the room: a skip to it, without pausing', () => {
    const r = playing()
    r.mpv.slip(3)
    r.clock.advance(300)
    const seeks = r.mpv.seeks.length
    const target = r.roomPos() + r.member.drift.seekLatMs / 1000
    expect(r.member.resync()).toBe('skip')
    expect(r.mpv.seeks.length).toBe(seeks + 1)
    expect(r.mpv.seeks.at(-1)).toBeCloseTo(target, 2)
    expect(r.playheads.at(-1)?.reason).toBe('catchup')
    r.clock.advance(1)
    expect(r.mpv.snapshot().paused).toBe(false)
    r.clock.advance(1000)
    // it skipped to where the room is a seek later (this mpv seeks faster than the 150 ms prior)
    expect(Math.abs(r.ahead())).toBeLessThan(200)
  })

  it('answers busy while a catch-up is on its way, and for 2 s after the last Resync, doing nothing', () => {
    const r = playing()
    r.mpv.slip(3)
    r.clock.advance(300)
    expect(r.member.resync()).toBe('skip')
    const seeks = r.mpv.seeks.length
    expect(r.member.resync()).toBe('busy') // the skip is on its way
    r.clock.advance(500)
    r.mpv.slip(3)
    r.clock.advance(300)
    expect(r.member.resync()).toBe('busy') // landed, but the last Resync was 0.8 s ago
    expect(r.mpv.seeks.length).toBe(seeks)
    expect(r.mpv.snapshot().paused).toBe(false)
  })

  it('answers in-sync within 300 ms, a stall’s first moments included, and leaves the player alone', () => {
    const r = playing()
    const seeks = r.mpv.seeks.length
    const unpauses = r.mpv.unpauses.length
    expect(r.member.resync()).toBe('in-sync')
    r.mpv.stall(true)
    r.clock.advance(250)
    expect(r.member.currentPhase).toBe('buffering')
    expect(r.member.resync()).toBe('in-sync')
    expect(r.mpv.seeks.length).toBe(seeks)
    expect(r.mpv.unpauses.length).toBe(unpauses)
    expect(r.mpv.snapshot().paused).toBe(false)
  })

  it('ahead of the room: waits paused for it, then plays on in sync', () => {
    const r = playing()
    r.mpv.slip(-1)
    r.clock.advance(300)
    const seeks = r.mpv.seeks.length
    expect(r.member.resync()).toBe('wait')
    r.clock.advance(1)
    expect(r.mpv.snapshot().paused).toBe(true)
    expect(r.member.desyncState).toEqual({ state: 'catching-up' })
    r.clock.advance(1500)
    expect(r.mpv.snapshot().paused).toBe(false)
    expect(Math.abs(r.ahead())).toBeLessThan(100)
    expect(r.mpv.seeks.length).toBe(seeks)
    expect(r.member.desyncState).toBeNull()
  })

  it('answers not-playing for a room that does not play or a host that is gone, and not-ready while loading', () => {
    const r = playing()
    r.apply('paused', r.roomPos())
    r.clock.advance(500)
    const seeks = r.mpv.seeks.length
    expect(r.member.resync()).toBe('not-playing')
    r.apply('playing', r.roomPos(), r.clock.t + 300)
    r.clock.advance(2000)
    r.member.hostLeft()
    expect(r.member.resync()).toBe('not-playing')
    expect(r.mpv.seeks.length).toBe(seeks)
    expect(r.mpv.snapshot().paused).toBe(false)

    const loading = room({}, 600, undefined, { desyncWarnMs: T })
    loading.apply('playing', 0)
    loading.member.setSource('file') // the load is out; its restart comes 100 ms later
    expect(loading.member.resync()).toBe('not-ready')
  })

  it('off (0, as for the host): never warns, however long the stall', () => {
    const r = playing({ desyncWarnMs: 0 })
    r.mpv.stall(true)
    r.clock.advance(20_000)
    expect(r.desync).toEqual([])
    expect(r.statuses.some((s) => s.behindS !== undefined)).toBe(false)
  })

  it('clears at once for a newly applied state, and after a θ̂ jump counts its 2 s afresh', () => {
    const r = playing()
    r.mpv.stall(true)
    r.clock.advance(4000)
    expect(r.member.desyncState?.state).toBe('behind')
    r.apply('playing', r.roomPos()) // the room seeks
    expect(r.member.desyncState).toBeNull()

    const q = playing()
    const t0 = q.clock.t
    q.mpv.stall(true)
    q.clock.advance(2500) // 1.5 s past the threshold
    q.member.onOffset(true)
    q.clock.advance(3000)
    const at = behindAt(q) ?? NaN
    expect(at - t0).toBeGreaterThanOrEqual(4500)
    expect(at - t0).toBeLessThanOrEqual(5000)
  })

  it('a new setting applies at once: 0 hides the warning, a higher threshold hides a smaller lag', () => {
    const r = playing()
    r.mpv.stall(true)
    r.clock.advance(4000)
    expect(r.member.desyncState?.state).toBe('behind')
    r.member.setDesyncWarn(0)
    expect(r.desync.at(-1)?.d).toBeNull()
    r.member.setDesyncWarn(T)
    r.clock.advance(2500)
    expect(r.member.desyncState?.state).toBe('behind')
    r.member.setDesyncWarn(30_000) // the lag is about 6.5 s
    expect(r.member.desyncState).toBeNull()
    r.clock.advance(3000)
    expect(r.member.desyncState).toBeNull()
  })
})
