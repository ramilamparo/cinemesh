import { EventEmitter } from 'node:events'
import type { MemberPhase, PlaybackEvent } from '../../shared/ipc/core.js'
import { DRIFT, DriftController } from './drift.js'
import type {
  Clock,
  MediaPort,
  PlayerPort,
  PlayerSnapshot,
  PositionSample,
  ReadinessReason,
  TimerHandle,
  TransferPort,
  Unsubscribe,
} from './ports.js'
import { every } from './ports.js'
import {
  type Datagram,
  DGRAM_STATE_FAST,
  isNewer,
  type SyncState,
  type SyncStatus,
  type WarningCode,
} from './protocol.js'

// Everyone's player follower (plan §4.5), the host's own mpv included (over a zero-latency loopback). It applies
// the newest sync.state, schedules unpauses against the host clock, runs the drift loop, detects buffering,
// catches up by skip or rendezvous, and reports sync.status.

export const MEMBER = {
  TICK_MS: DRIFT.TICK_MS,
  STATUS_MS: 1000,
  SPIN_LEAD_MS: 15,
  HOST_GONE_MS: 10_000,
  STALL_MS: 750,
  /** below this much buffered at the skip target, catch up by rendezvous instead */
  SKIP_MIN_AHEAD_S: 2,
  RENDEZVOUS_MARGIN_MS: 300,
  EST_READY_INIT_MS: 6000,
  EST_READY_MIN_MS: 1000,
  EST_READY_MAX_MS: 60_000,
  EST_READY_FACTOR: 1.5,
  UNPAUSE_LAT_INIT_MS: 50,
  UNPAUSE_LAT_MAX_MS: 200,
  UNPAUSE_ALPHA: 0.3,
  /** the unpause-latency probe needs audio to have started */
  PROBE_AFTER_MS: 300,
  /** a state that arrives this late is absorbed by unpausing now; later than this, catch up */
  LATE_MS: DRIFT.SKIP,
  /**
   * The same for a member that cannot nudge (spdif, or nudging off): its drift loop only skips once 300 ms
   * behind, so a later start would keep its lateness. It meets the room instead, once per state.
   */
  LATE_NO_NUDGE_MS: 100,
  /** waiting paused for the room to reach us is fine for a few seconds; beyond that a rendezvous is quicker */
  WAIT_AHEAD_MIN_MS: 5000,
  RECOVER_BEHIND_MS: 300,
  LAG_WINDOW: 20,
  /** a state older than this is a sticky replay, not a measure of how late states arrive */
  LAG_MAX_MS: 5000,
  SLOW_RATE_FACTOR: 1.1,
  SLOW_RATE_MS: 15_000,
  /** mpv lands a seek or load on the first frame at or after target − 5 ms (ADR 0007 Finding 4) */
  LANDING_SLOP_S: 0.005,
  FRAME_DROP_WINDOW_MS: 10_000,
  FRAME_DROP_MIN: 5,
  MAX_REPORTED_S: 1e7,
  /** a load mpv could not open is tried again after this, doubling up to LOAD_RETRY_MAX_MS */
  LOAD_RETRY_MIN_MS: 1000,
  LOAD_RETRY_MAX_MS: 30_000,
} as const

export type StateFast = Extract<Datagram, { type: typeof DGRAM_STATE_FAST }>

/**
 * `seeking`: an exact seek is on its way, until its playback-restart and the read of the frame it landed on.
 * `seekAt`: when that seek went out, if its data was local (its restart then times seekLat), else null.
 */
type Activity =
  | { k: 'idle' }
  /**
   * paused at pos for a paused/waiting/ended room; actual = the exact paused position: the frame our seek or load
   * landed on, or the audio position read after a pause from playback (null until known)
   */
  | { k: 'settle'; pos: number; seeking: boolean; actual: number | null; seekAt: number | null }
  /** paused at target, waiting for the seek and readiness, then scheduling the unpause (start or rendezvous) */
  | {
      k: 'prep'
      target: number
      seeking: boolean
      exact: boolean
      startedAt: number
      needData: boolean
      seekAt: number | null
    }
  /** unpause armed for local time `at` */
  | { k: 'scheduled'; pos: number; at: number; exact: boolean }
  | { k: 'playing' }
  /** seeking forward while playing */
  | { k: 'skip'; target: number; startedAt: number }
  /** host gone for 10 s: paused until it returns */
  | { k: 'hold' }

export interface MemberOptions {
  clock: Clock
  player: PlayerPort
  media: MediaPort
  transfer: TransferPort
  /** θ̂ (hostTime = local + θ̂); constant 0 for the host's own member; null before the first clock sample */
  offset(): number | null
  clockErrMs(): number | null
  /** the user's speed-nudge setting */
  nudge: boolean
}

export interface MemberEvents {
  status: [SyncStatus]
  /** a newer state was applied, or the reliable copy of one first seen as StateFast */
  state: [SyncState]
  playback: [PlaybackEvent]
  /** true when the 10 s grace ran out and playback paused; false when the host came back */
  hostGone: [boolean]
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const finite = (x: number): number => (Number.isFinite(x) ? clamp(x, -MEMBER.MAX_REPORTED_S, MEMBER.MAX_REPORTED_S) : 0)

export class MemberController extends EventEmitter<MemberEvents> {
  readonly drift = new DriftController()
  private st: SyncState | null = null
  private fastOnly = false
  private forceNext = false
  private act: Activity = { k: 'idle' }
  private phase: MemberPhase = 'joining'
  private readyFor: number | null = null
  private gen = 0
  private unpauseTimer: TimerHandle | null = null
  private hostGone: { timer: TimerHandle; holding: boolean } | null = null
  private unpauseLatMs: number = MEMBER.UNPAUSE_LAT_INIT_MS
  /** the first probe replaces the prior */
  private unpauseProbed = false
  private estReadyMs: number = MEMBER.EST_READY_INIT_MS
  private probe: { sentAt: number; fromPos: number } | null = null
  private lastSample: { posS: number; at: number; speed: number } | null = null
  private readonly lags: number[] = []
  private src: string | null = null
  /** the start position of a load in flight; kept until the read of where it landed answers */
  private loadPending: number | null = null
  /** a seek's or load's playback-restart came: reading the frame it landed on (ADR 0007 Finding 4) */
  private landing: { target: number } | null = null
  /** after loads mpv could not open: the next try waits for this timer (onLoadFailed) */
  private loadRetry: TimerHandle | null = null
  private loadRetryMs = 0
  /** a member that cannot nudge still meets a late start (LATE_NO_NUDGE_MS); cleared once it did, per state */
  private strictLate = true
  private buffering = false
  private lastTimePos: number | null = null
  private lastMoveAt = 0
  private slowSince: number | null = null
  private readonly drops: { at: number; n: number }[] = []
  private lastReportKey = ''
  private timers: TimerHandle[] = []
  private subs: Unsubscribe[] = []
  private nudge: boolean
  private readonly clock: Clock
  private readonly player: PlayerPort
  private readonly media: MediaPort

  constructor(private readonly o: MemberOptions) {
    super()
    this.clock = o.clock
    this.player = o.player
    this.media = o.media
    this.nudge = o.nudge
  }

  start(): void {
    const p = this.player
    this.subs = [
      p.on('playbackRestart', () => this.onPlaybackRestart()),
      p.on('audioReconfig', () => this.drift.hold(this.clock.now(), DRIFT.RESTART_HOLD_MS)),
      p.on('externalChange', (e) => this.onExternal(e.kind)),
      p.on('eof', () => this.onEof()),
      p.on('buffering', () => this.checkStall()),
      p.on('state', (s) => this.onPlayerState(s)),
      p.on('loadFailed', (e) => this.onLoadFailed(e.superseded)),
      this.media.onChange(() => this.onMedia()),
    ]
    this.updateNudge(p.snapshot())
    this.timers = [
      every(this.clock, MEMBER.TICK_MS, () => this.tick()),
      every(this.clock, MEMBER.STATUS_MS, () => this.report(true)),
    ]
  }

  stop(): void {
    for (const u of this.subs) u()
    for (const t of this.timers) t.cancel()
    this.subs = []
    this.timers = []
    this.cancelUnpause()
    this.hostGone?.timer.cancel()
    this.hostGone = null
    this.cancelLoadRetry()
    this.landing = null
    this.gen++
  }

  get state(): SyncState | null {
    return this.st
  }

  get currentPhase(): MemberPhase {
    return this.o.transfer.diskFull() ? 'disk-full' : this.phase
  }

  get unpauseLatencyMs(): number {
    return this.unpauseLatMs
  }

  get lagP95Ms(): number {
    if (this.lags.length === 0) return 0
    const s = [...this.lags].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0
  }

  /** Where the room is now (seconds), for the UI, seekRel and the player's restart position. */
  roomPosition(): number | null {
    const st = this.st
    if (!st) return null
    // a playing room is placed on the host clock: before the first estimate (joining, a restarted host) the
    // anchor is all we know, where our own clock alone would put it anywhere
    if (st.mode !== 'playing' || this.o.offset() === null) return st.anchor.pos
    return Math.max(st.anchor.pos, this.expectedAt(this.clock.now()))
  }

  /** Our own position right now, used by the host's group when it pauses: the last audio-pts sample, extrapolated. */
  localPosition(): number | null {
    const snap = this.player.snapshot()
    if (!snap.loaded) return null
    const s = this.lastSample
    const now = this.clock.now()
    if (this.act.k === 'playing' && !snap.paused && s && now - s.at < 1000)
      return s.posS + ((now - s.at) / 1000) * s.speed
    return this.statusPos(snap)
  }

  setSource(src: string): void {
    this.src = src
    // a new source (or the same one for a new player) is worth a try at once
    this.cancelLoadRetry()
    this.loadRetryMs = 0
    this.load()
  }

  setNudge(on: boolean): void {
    this.nudge = on
    this.updateNudge(this.player.snapshot())
  }

  applyState(next: SyncState): void {
    this.accept(next, 'bus')
  }

  applyFast(f: StateFast): void {
    const cur = this.st
    if (!cur || cur.syncEpoch !== f.syncEpoch || f.seq <= cur.seq) return
    const { wait, ...rest } = cur
    const next: SyncState = {
      ...rest,
      seq: f.seq,
      mode: f.mode,
      anchor: { pos: f.pos, hostTime: f.hostTime, rate: 1 },
      sentAt: f.sentAt,
      ...(f.mode === 'waiting' && wait ? { wait } : {}),
    }
    this.accept(next, 'fast')
  }

  /** The θ̂ estimate changed; jumped means by >= 15 ms or the first estimate. */
  onOffset(jumped: boolean): void {
    if (jumped) this.drift.hold(this.clock.now(), DRIFT.CLOCK_HOLD_MS)
    const st = this.st
    if (st?.mode !== 'playing') return
    if (this.act.k === 'idle') this.reconcile()
    else if (this.act.k === 'scheduled' && jumped) {
      const a = this.act
      this.schedulePlayFrom(a.pos, a.exact)
    }
  }

  /**
   * The host went away `sinceMs` ago (its last word: silence is noticed only seconds later). Playback goes on
   * from the anchor until HOST_GONE_MS after that word, then pauses until the host is back.
   */
  hostLeft(sinceMs = 0): void {
    if (this.hostGone) return
    // a word older than the grace holds on the next turn (Clock.setTimer: a negative delay)
    this.hostGone = { holding: false, timer: this.clock.setTimer(MEMBER.HOST_GONE_MS - sinceMs, () => this.hold()) }
  }

  hostBack(): void {
    const g = this.hostGone
    if (!g) return
    g.timer.cancel()
    this.hostGone = null
    this.forceNext = true
    if (g.holding) this.emit('hostGone', false)
  }

  // ---- applying state ------------------------------------------------------------------------

  private accept(next: SyncState, via: 'bus' | 'fast'): void {
    const cur = this.st
    if (cur && cur.syncEpoch === next.syncEpoch && next.seq === cur.seq) {
      if (via !== 'bus') return
      if (this.fastOnly) {
        this.st = next
        this.fastOnly = false
        this.emit('state', next)
      }
      if (this.forceNext) {
        this.forceNext = false
        this.reconcile()
      }
      return
    }
    if (!isNewer(cur, next)) return
    this.noteLag(next.sentAt)
    this.st = next
    this.fastOnly = via === 'fast'
    this.emit('state', next)
    const force = this.forceNext && via === 'bus'
    if (force) this.forceNext = false
    if (!force && cur?.syncEpoch === next.syncEpoch && sameActuation(cur, next)) {
      this.report(false)
      return
    }
    this.reconcile()
  }

  /** `meet`: mpv sits somewhere we did not put it; see beginPlay. */
  private reconcile(meet = false): void {
    this.gen++
    this.strictLate = true
    this.lastSample = null
    this.cancelUnpause()
    this.readyFor = null
    this.probe = null
    this.buffering = false
    const st = this.st
    const snap = this.player.snapshot()
    if (!snap.available) {
      this.act = { k: 'idle' }
      this.setPhase('no-player')
      return
    }
    if (this.loadPending !== null) return
    if (!snap.loaded) {
      this.act = { k: 'idle' }
      if (this.src !== null) this.load()
      else this.setPhase('joining')
      return
    }
    if (!st || this.hostGone?.holding) return
    switch (st.mode) {
      case 'idle':
        this.pausePlayer(snap)
        this.act = { k: 'idle' }
        this.setPhase('loading')
        break
      case 'paused':
      case 'waiting':
      case 'ended':
        this.settle(st.anchor.pos)
        break
      case 'playing':
        this.beginPlay(meet)
        break
    }
  }

  private load(): void {
    const snap = this.player.snapshot()
    if (this.src === null || !snap.available || this.loadPending !== null || this.loadRetry !== null) return
    const st = this.st
    // Wait for the room's state (and, if it plays, our clock) so the first load lands where the room is.
    if (!st || (st.mode === 'playing' && this.o.offset() === null)) {
      this.setPhase('joining')
      return
    }
    let startS = st.anchor.pos
    // A late joiner loads straight at its rendezvous target: just ahead of the room when the data there is local
    // (always on the host, whose mpv may have restarted), else as far as a download needs.
    if (st.mode === 'playing') {
      startS = this.rendezvousTarget(this.clock.now())
      this.media.playhead.set(startS, 'rendezvous')
    } else {
      this.media.playhead.set(startS, 'seek')
    }
    this.loadPending = startS
    this.landing = null // a seek's read still out answers for a file this load replaces
    this.act = { k: 'idle' }
    this.setPhase('loading')
    this.player.load(this.src, { startS, paused: true })
  }

  /** Pause at pos (exact seek if more than a frame off), then report ready once readiness passes. */
  private settle(pos: number): void {
    const snap = this.player.snapshot()
    this.pausePlayer(snap)
    const a = this.act
    const inFlight = (a.k === 'settle' || a.k === 'prep') && a.seeking ? a : null
    if (inFlight !== null && Math.abs(targetOf(inFlight) - pos) < 1e-6) {
      // that seek's restart (or its landing read) completes this act
      this.act = { k: 'settle', pos, seeking: true, actual: pos, seekAt: inFlight.seekAt }
      this.setPhase('seeking')
      return
    }
    const still = inFlight === null && !snap.seeking
    // Where our own seek or load landed, or an earlier read, is exact: keep it. After a pause from playback, a
    // paused seek or load leaves audio-pts early by the AO's old delay until the next unpause (push AOs; ADR 0007
    // Finding 5), so reading it again here would start the member that much early.
    const known = still ? exactPausedAt(a) : null
    const at = still ? this.pausedAt(snap) : null
    // within a frame and mpv's 5 ms of pos: an exact seek there would land no closer
    if (known !== null && Math.abs(known - pos) < snap.frameS + MEMBER.LANDING_SLOP_S) {
      this.act = { k: 'settle', pos, seeking: false, actual: known, seekAt: null }
    } else if (at !== null && Math.abs(at - pos) < snap.frameS) {
      // Close enough not to seek, but time-pos is frame-quantised: read the exact audio position so the next
      // unpause can be scheduled from where we really are. mpv answers in order and the read goes out after the
      // pause above, so it is the paused position, even when mpv's pause change arrives later (ADR 0008 §4.2).
      const settle: Activity = { k: 'settle', pos, seeking: false, actual: null, seekAt: null }
      this.act = settle
      this.player.sample((smp) => {
        if (this.act === settle && smp) settle.actual = Math.max(0, smp.posS)
      })
    } else {
      this.media.playhead.set(pos, 'seek')
      const seekAt = this.seekTo(pos)
      this.act = { k: 'settle', pos, seeking: true, actual: pos, seekAt }
      this.setPhase('seeking')
    }
    this.checkSettled()
  }

  private checkSettled(): void {
    const a = this.act
    const st = this.st
    if (a.k !== 'settle' || a.seeking || !st) return
    if (!this.media.readiness(a.pos, 'seek')) {
      this.setPhase('seeking')
      return
    }
    this.readyFor = st.seq
    this.setPhase(st.mode === 'waiting' ? 'ready' : st.mode === 'ended' ? 'ended' : 'paused')
    this.report(false)
  }

  /**
   * Start playing for a playing room. `meet`: mpv is paused where another load put it, not where we planned,
   * so even a small lag is met with a rendezvous, as a late joiner's load would be, instead of an unpause
   * from a frame-quantised position that leaves the start to the drift loop.
   */
  private beginPlay(meet = false): void {
    const st = this.st
    if (st?.mode !== 'playing') return
    if (this.o.offset() === null) {
      this.act = { k: 'idle' }
      this.setPhase('joining')
      return
    }
    const snap = this.player.snapshot()
    const a = this.act
    if (!snap.paused && (a.k === 'playing' || a.k === 'skip')) return
    let pos: number
    let seeking: boolean
    let exact: boolean
    let seekAt: number | null = null
    if (a.k === 'settle') {
      pos = a.actual ?? a.pos
      seeking = a.seeking
      exact = a.actual !== null
      seekAt = a.seekAt
    } else if (a.k === 'prep') {
      pos = a.target
      seeking = a.seeking
      exact = a.exact
      seekAt = a.seekAt
    } else if (a.k === 'scheduled') {
      pos = a.pos
      seeking = false
      exact = a.exact
    } else {
      pos = this.pausedAt(snap) ?? st.anchor.pos
      seeking = false
      exact = false
    }
    this.pausePlayer(snap)
    const now = this.clock.now()
    const anchorLocal = this.localWhen(st.anchor.pos)
    if (Math.abs(pos - st.anchor.pos) >= snap.frameS && anchorLocal - now > this.drift.seekLatMs + 100) {
      pos = st.anchor.pos
      seeking = true
      exact = true
      this.media.playhead.set(pos, 'seek')
      seekAt = this.seekTo(pos)
    } else {
      const wait = this.localWhen(pos) - this.unpauseLatMs - now
      // Behind, or far ahead (e.g. held at the old position while the host seeked back): meet the room instead.
      if (-wait > (meet ? 0 : this.lateLimitMs())) {
        this.lateCatchUp()
        return
      }
      if (wait > this.maxWaitMs()) {
        this.catchUp()
        return
      }
    }
    this.act = { k: 'prep', target: pos, seeking, exact, startedAt: now, needData: false, seekAt }
    if (seeking) this.setPhase('seeking')
    this.checkPrep()
  }

  private checkPrep(): void {
    const a = this.act
    const st = this.st
    if (a.k !== 'prep' || a.seeking || st?.mode !== 'playing') return
    const reason: ReadinessReason = Math.abs(a.target - st.anchor.pos) < 1e-6 ? 'start' : 'rendezvous'
    if (!this.media.readiness(a.target, reason)) {
      a.needData = true
      this.setPhase('seeking')
      // The room passed the target before the data came: try again further ahead, with a longer estimate.
      const now = this.clock.now()
      if (now - (this.localWhen(a.target) - this.unpauseLatMs) > MEMBER.LATE_MS) {
        const observed = (now - a.startedAt) * MEMBER.EST_READY_FACTOR
        this.estReadyMs = clamp(Math.max(this.estReadyMs, observed), MEMBER.EST_READY_MIN_MS, MEMBER.EST_READY_MAX_MS)
        this.rendezvous()
      }
      return
    }
    if (a.needData) {
      const observed = (this.clock.now() - a.startedAt) * MEMBER.EST_READY_FACTOR
      this.estReadyMs = clamp(observed, MEMBER.EST_READY_MIN_MS, MEMBER.EST_READY_MAX_MS)
    }
    this.schedulePlayFrom(a.target, a.exact)
  }

  private schedulePlayFrom(pos: number, exact: boolean): void {
    this.cancelUnpause()
    const now = this.clock.now()
    const at = this.localWhen(pos) - this.unpauseLatMs
    const late = now - at
    if (late > this.lateLimitMs()) {
      this.lateCatchUp()
      return
    }
    if (late >= 0) {
      this.unpauseNow(pos, exact)
      return
    }
    this.act = { k: 'scheduled', pos, at, exact }
    // A rendezvous can be seconds away; until then this member is still on its way in.
    this.setPhase(at - now > 1000 ? 'seeking' : 'playing')
    const g = this.gen
    // setTimeout is only good to a few ms, so it wakes us early and we spin on setImmediate to the deadline.
    const fire = (): void => {
      if (g !== this.gen) return
      if (this.clock.now() >= at) this.unpauseNow(pos, exact)
      else this.unpauseTimer = this.clock.immediate(fire)
    }
    this.unpauseTimer = this.clock.setTimer(at - MEMBER.SPIN_LEAD_MS - now, fire)
  }

  private unpauseNow(pos: number, exact: boolean): void {
    this.unpauseTimer = null
    this.lastSample = null
    const now = this.clock.now()
    this.player.setPaused(false)
    this.act = { k: 'playing' }
    this.drift.hold(now, DRIFT.RESTART_HOLD_MS)
    this.drift.trim()
    this.probe = exact ? { sentAt: now, fromPos: pos } : null
    this.lastMoveAt = now
    this.lastTimePos = null
    this.setPhase('playing')
  }

  /** How late a start may unpause and leave the rest to the drift loop. */
  private lateLimitMs(): number {
    return this.drift.canNudge || !this.strictLate ? MEMBER.LATE_MS : MEMBER.LATE_NO_NUDGE_MS
  }

  /** A start too late to unpause into: catch up. Without nudging only once per state, so it cannot loop. */
  private lateCatchUp(): void {
    if (!this.drift.canNudge) this.strictLate = false
    this.catchUp()
  }

  /** Behind the room: skip forward if the target is buffered, otherwise rendezvous. */
  private catchUp(): void {
    const now = this.clock.now()
    const t1 = this.clampPos(this.expectedAt(now + this.drift.seekLatMs))
    const snap = this.player.snapshot()
    if (!snap.paused && this.media.bufferedAheadS(t1) >= MEMBER.SKIP_MIN_AHEAD_S) this.skip(t1)
    else this.rendezvous()
  }

  private skip(target: number): void {
    this.gen++
    this.cancelUnpause()
    this.probe = null
    this.lastSample = null
    this.media.playhead.set(target, 'catchup')
    this.player.seek(target)
    this.act = { k: 'skip', target, startedAt: this.clock.now() }
    this.setPhase('seeking')
  }

  /** Meet the room at T = expected(now + estReady): prefetch from T, seek there paused, unpause when it arrives. */
  private rendezvous(): void {
    this.gen++
    this.cancelUnpause()
    this.probe = null
    this.lastSample = null
    const now = this.clock.now()
    const target = this.rendezvousTarget(now)
    this.media.playhead.set(target, 'rendezvous')
    this.pausePlayer(this.player.snapshot())
    const seekAt = this.seekTo(target)
    const needData = !this.media.readiness(target, 'rendezvous')
    this.act = { k: 'prep', target, seeking: true, exact: true, startedAt: now, needData, seekAt }
    this.setPhase('seeking')
  }

  private pauseWait(pos: number): void {
    this.pausePlayer(this.player.snapshot())
    this.gen++
    if (this.localWhen(pos) - this.unpauseLatMs - this.clock.now() > this.maxWaitMs()) this.rendezvous()
    else this.schedulePlayFrom(pos, true)
  }

  // ---- player and media events ---------------------------------------------------------------

  private onPlaybackRestart(): void {
    const now = this.clock.now()
    const loadedAt = this.loadPending
    if (loadedAt !== null) {
      // The player passes every mpv restart on, and says loaded before the one that completes a load. Not loaded:
      // another file's (another client's, or one our loadfile replaces), which may come after our load went out.
      if (!this.player.snapshot().loaded || this.landing) return
      // The load stays pending (no other load, no reconcile) until we know where it landed.
      this.land(loadedAt, (at) => this.loadLanded(loadedAt, at))
      return
    }
    const a = this.act
    if ((a.k === 'settle' || a.k === 'prep') && a.seeking) {
      // Every exact seek with its data local times seekLat, not only skips (ADR 0007 Finding 6).
      if (a.seekAt !== null) this.drift.noteSeekDone(now - a.seekAt)
      a.seekAt = null
      const target = targetOf(a)
      this.land(target, (at) => this.seekLanded(target, at))
    } else if (a.k === 'skip') {
      this.drift.noteSeekDone(now - a.startedAt)
      this.act = { k: 'playing' }
      this.drift.hold(now, DRIFT.RESTART_HOLD_MS)
      this.lastMoveAt = now
      this.lastTimePos = null
      this.setPhase('playing')
    } else if (a.k === 'playing') {
      this.drift.hold(now, DRIFT.RESTART_HOLD_MS)
    }
  }

  /**
   * Reads where a seek or load landed: the first frame at or after target − 5 ms, where playback starts (ADR 0007
   * Finding 4). Read, not the observed time-pos, which mpv updates only ~50 ms after a paused seek's restart.
   */
  private land(target: number, done: (at: number | null) => void): void {
    const landing = { target }
    this.landing = landing
    this.player.readTimePos((at) => {
      if (this.landing !== landing) return
      this.landing = null
      done(at)
    })
  }

  private loadLanded(loadedAt: number, read: number | null): void {
    this.loadPending = null
    this.loadRetryMs = 0
    const snap = this.player.snapshot()
    const at = read ?? snap.timePosS
    // a frame (and mpv's 5 ms) from the target is where our own load lands
    if (at !== null && Math.abs(at - loadedAt) > snap.frameS + MEMBER.LANDING_SLOP_S) {
      // Another loadfile replaced ours (the player's own reload after a crash, a Reopen or a path change):
      // mpv is where that one put it. Settle there and plan from it (exactly, when the read answered).
      this.act = { k: 'settle', pos: at, seeking: false, actual: read, seekAt: null }
      this.reconcile(true)
      return
    }
    // mpv is paused on the frame the load landed on; reconcile decides from there.
    const actual = read === null ? loadedAt : read
    this.act = { k: 'settle', pos: loadedAt, seeking: false, actual, seekAt: null }
    this.reconcile()
  }

  /** The seek to `target` landed at `at`: unless the member has moved on, its act continues from there. */
  private seekLanded(target: number, at: number | null): void {
    const a = this.act
    if ((a.k !== 'settle' && a.k !== 'prep') || !a.seeking || Math.abs(targetOf(a) - target) > 1e-6) return
    a.seeking = false
    // within a frame (and mpv's 5 ms) of the target, as an exact seek lands; anything else is not ours to trust
    const tolerance = this.player.snapshot().frameS + MEMBER.LANDING_SLOP_S
    const landed = at !== null && Math.abs(at - target) < tolerance ? Math.max(0, at) : target
    if (a.k === 'settle') {
      a.actual = landed
      this.checkSettled()
    } else {
      a.target = landed
      this.checkPrep()
    }
  }

  private onMedia(): void {
    if (this.act.k === 'settle') this.checkSettled()
    else if (this.act.k === 'prep') this.checkPrep()
  }

  private onPlayerState(s: PlayerSnapshot): void {
    this.updateNudge(s)
    if (!s.available) {
      if (this.phase !== 'no-player') {
        this.gen++
        this.cancelUnpause()
        this.loadPending = null
        this.landing = null
        this.act = { k: 'idle' }
        this.setPhase('no-player')
      }
      return
    }
    if (!s.loaded && this.loadPending === null && this.src !== null) this.load()
  }

  /**
   * Our load will never reach its playback-restart: another client's file replaced it while it opened, mpv could
   * not open it, or mpv went away. Waiting for a restart would wait for someone else's file (or forever), so the
   * usual rule (available and not loaded) loads ours again: at once after a replacement or once mpv is back, and
   * after a pause doubling from 1 s to 30 s while mpv keeps failing to open it, so that is not a loop.
   */
  private onLoadFailed(superseded: boolean): void {
    if (this.loadPending === null) return
    this.loadPending = null
    this.landing = null
    if (!superseded && this.player.snapshot().available) {
      this.loadRetryMs = clamp(this.loadRetryMs * 2, MEMBER.LOAD_RETRY_MIN_MS, MEMBER.LOAD_RETRY_MAX_MS)
      this.cancelLoadRetry()
      this.loadRetry = this.clock.setTimer(this.loadRetryMs, () => {
        this.loadRetry = null
        this.reconcile()
      })
    }
    this.reconcile()
  }

  private cancelLoadRetry(): void {
    this.loadRetry?.cancel()
    this.loadRetry = null
  }

  private onExternal(kind: 'pause' | 'seek' | 'speed' | 'path'): void {
    const st = this.st
    if (!st || this.loadPending !== null) return
    // Another file replaced ours, and the player leaves the reload to us: reload even while holding for an
    // absent host, or the room would later be met on that file. (A player that gave the file up first is
    // reloaded by onPlayerState already: loadPending is set.)
    if (kind === 'path') {
      this.load()
      return
    }
    if (this.hostGone?.holding) return
    if (kind === 'speed') {
      if (this.drift.speed !== this.player.snapshot().speed) this.player.setSpeed(this.drift.speed)
      return
    }
    // Forget where we think the player is: it moved behind our back.
    this.gen++
    this.cancelUnpause()
    if (st.mode === 'playing') {
      const snap = this.player.snapshot()
      this.act = snap.paused ? { k: 'idle' } : { k: 'playing' }
      if (snap.paused) this.beginPlay()
      else this.catchUp()
    } else {
      this.act = { k: 'idle' }
      this.settle(st.anchor.pos)
    }
  }

  private onEof(): void {
    this.gen++
    this.cancelUnpause()
    this.act = { k: 'idle' }
    this.setPhase('ended')
  }

  private hold(): void {
    if (!this.hostGone) return
    this.hostGone.holding = true
    this.gen++
    this.cancelUnpause()
    this.buffering = false
    this.pausePlayer(this.player.snapshot())
    this.act = { k: 'hold' }
    this.setPhase('paused')
    this.emit('hostGone', true)
  }

  // ---- the 4 Hz loop -------------------------------------------------------------------------

  private tick(): void {
    const st = this.st
    this.checkStall()
    if (this.act.k === 'settle') this.checkSettled()
    else if (this.act.k === 'prep') this.checkPrep()
    if (st?.mode === 'playing' && this.act.k === 'playing' && !this.buffering && !this.hostGone?.holding) {
      const g = this.gen
      this.player.sample((s) => this.onSample(s, g))
    }
    this.emit('playback', this.playbackEvent())
  }

  private onSample(s: PositionSample | null, g: number): void {
    const st = this.st
    if (g !== this.gen || !s || st?.mode !== 'playing' || this.act.k !== 'playing' || this.buffering) return
    const snap = this.player.snapshot()
    if (snap.paused || snap.seeking) return
    const now = this.clock.now()
    const ts = (s.tSend + s.tRecv) / 2
    const rtt = s.tRecv - s.tSend
    const probe = this.probe
    if (probe && ts - probe.sentAt >= MEMBER.PROBE_AFTER_MS && rtt < DRIFT.MAX_IPC_RTT_MS) {
      const startedAt = ts - ((s.posS - probe.fromPos) * 1000) / this.drift.speed
      const lat = clamp(startedAt - probe.sentAt, 0, MEMBER.UNPAUSE_LAT_MAX_MS)
      // the first probe replaces the prior, which every start is off by until then (ADR 0007 §6.4)
      this.unpauseLatMs += (this.unpauseProbed ? MEMBER.UNPAUSE_ALPHA : 1) * (lat - this.unpauseLatMs)
      this.unpauseProbed = true
      this.probe = null
    }
    this.lastSample = { posS: s.posS, at: ts, speed: this.drift.speed }
    const D = (s.posS - this.expectedAt(ts)) * 1000
    this.drift.offer(D, rtt, this.clock.loopLagMs(), ts)
    const action = this.drift.step(now)
    switch (action.kind) {
      case 'speed':
        this.probe = null
        this.player.setSpeed(action.speed)
        break
      case 'pause-wait':
        this.pauseWait(s.posS + ((now - ts) / 1000) * this.drift.speed)
        break
      case 'skip': {
        const target = this.clampPos(this.expectedAt(now + this.drift.seekLatMs))
        if (this.media.bufferedAheadS(target) >= MEMBER.SKIP_MIN_AHEAD_S) this.skip(target)
        else this.rendezvous()
        break
      }
      case 'none':
        break
    }
  }

  /** Buffering: paused-for-cache, or time-pos stuck for 750 ms with core-idle. */
  private checkStall(): void {
    const st = this.st
    if (st?.mode !== 'playing' || this.act.k !== 'playing') return
    const snap = this.player.snapshot()
    const now = this.clock.now()
    if (snap.timePosS !== this.lastTimePos) {
      this.lastTimePos = snap.timePosS
      this.lastMoveAt = now
    }
    const stalled = snap.pausedForCache || (snap.coreIdle && !snap.paused && now - this.lastMoveAt >= MEMBER.STALL_MS)
    if (stalled && !this.buffering) {
      this.buffering = true
      this.probe = null
      this.drift.hold(now, 0)
      this.setPhase('buffering')
    } else if (!stalled && this.buffering) {
      this.buffering = false
      this.drift.hold(now, DRIFT.RESTART_HOLD_MS)
      this.setPhase('playing')
      const pos = snap.timePosS
      // Behind after the stall: the group kept playing (waitForAll off, or we are exempt).
      if (pos !== null && (pos - this.expectedAt(now)) * 1000 < -MEMBER.RECOVER_BEHIND_MS) this.catchUp()
    }
  }

  // ---- status --------------------------------------------------------------------------------

  private setPhase(p: MemberPhase): void {
    if (p === this.phase) return
    this.phase = p
    this.report(false)
  }

  /** Sends sync.status: always on the 1 Hz timer, otherwise only when phase or barrier changed. */
  private report(periodic: boolean): void {
    const phase = this.currentPhase
    const key = `${phase}|${String(this.readyFor)}`
    if (!periodic && key === this.lastReportKey) return
    this.lastReportKey = key
    this.emit('status', this.buildStatus(phase))
  }

  private buildStatus(phase: MemberPhase): SyncStatus {
    const snap = this.player.snapshot()
    const pos = Math.max(0, finite(this.statusPos(snap)))
    const st = this.st
    const eta = this.o.transfer.etaToEofS()
    const s: SyncStatus = {
      t: 'sync.status',
      syncEpoch: st?.syncEpoch ?? 0,
      seq: st?.seq ?? 0,
      phase,
      pos,
      driftMs: this.drift.driftMs === null ? null : finite(this.drift.driftMs),
      bufferedAheadS: Math.max(0, finite(this.media.bufferedAheadS(pos))),
      rateBps: Math.max(0, finite(this.o.transfer.rateBps())),
      needBps: Math.max(0, finite(this.media.needBps())),
      coverage: this.o.transfer.coverage(),
      canNudge: this.drift.canNudge,
      lagMs: finite(this.lagP95Ms),
      clockErrMs: nullableFinite(this.o.clockErrMs()),
      frameDrops: Math.max(0, Math.floor(finite(snap.frameDrops))),
      warnings: this.warnings(snap),
      etaS: eta === null ? null : finite(eta),
    }
    if (this.readyFor !== null) s.barrierId = this.readyFor
    return s
  }

  private warnings(snap: PlayerSnapshot): WarningCode[] {
    const now = this.clock.now()
    const out: WarningCode[] = []
    const need = this.media.needBps()
    const rate = this.o.transfer.rateBps()
    const done = this.o.transfer.etaToEofS() === 0
    if (need > 0 && !done && rate < MEMBER.SLOW_RATE_FACTOR * need) this.slowSince ??= now
    else this.slowSince = null
    if (this.slowSince !== null && now - this.slowSince >= MEMBER.SLOW_RATE_MS) out.push('slow-download')
    this.drops.push({ at: now, n: snap.frameDrops })
    while (this.drops.length > 0 && now - (this.drops[0]?.at ?? now) > MEMBER.FRAME_DROP_WINDOW_MS) this.drops.shift()
    const first = this.drops[0]
    if (first && snap.frameDrops - first.n >= MEMBER.FRAME_DROP_MIN) out.push('frame-drops')
    return out
  }

  private playbackEvent(): PlaybackEvent {
    const snap = this.player.snapshot()
    const a = this.act
    // Nothing loaded (no source yet, a download that must complete first, mpv starting or loading): mpv's own
    // pause flag (false for an idle mpv) and our frozen anchor would show a paused room playing. Show the room.
    if (!snap.loaded) {
      return {
        posS: Math.max(0, this.roomPosition() ?? 0),
        durationS: this.media.durationS(),
        paused: this.st?.mode !== 'playing',
        seeking: false,
        stalled: false,
        at: this.clock.now(),
      }
    }
    return {
      posS: Math.max(0, snap.timePosS ?? this.statusPos(snap)),
      durationS: this.media.durationS(),
      paused: snap.paused,
      seeking: snap.seeking || ((a.k === 'settle' || a.k === 'prep') && a.seeking) || a.k === 'skip',
      stalled: this.buffering,
      at: this.clock.now(),
    }
  }

  // ---- helpers -------------------------------------------------------------------------------

  private statusPos(snap: PlayerSnapshot): number {
    const a = this.act
    if (a.k === 'settle' || a.k === 'prep') return targetOf(a)
    if (a.k === 'scheduled') return a.pos
    return snap.timePosS ?? this.st?.anchor.pos ?? 0
  }

  /** Exact paused position if we put the player there, else mpv's (frame-quantised) time-pos. */
  private pausedAt(snap: PlayerSnapshot): number | null {
    const a = this.act
    if (a.k === 'settle' && !a.seeking) return a.actual ?? a.pos
    if (a.k === 'prep' && !a.seeking) return a.target
    if (a.k === 'scheduled') return a.pos
    return snap.timePosS
  }

  /** Exact seek; returns when it went out if its data is local (its restart then times seekLat), else null. */
  private seekTo(pos: number): number | null {
    this.player.seek(pos)
    return this.media.bufferedAheadS(pos) >= MEMBER.SKIP_MIN_AHEAD_S ? this.clock.now() : null
  }

  private pausePlayer(snap: PlayerSnapshot): void {
    if (!snap.paused) this.player.setPaused(true)
    if (this.drift.speed !== 1) {
      this.drift.noteSpeed(1)
      this.player.setSpeed(1)
    }
  }

  private cancelUnpause(): void {
    this.unpauseTimer?.cancel()
    this.unpauseTimer = null
  }

  private expectedAt(local: number): number {
    const st = this.st
    if (!st) return 0
    if (st.mode !== 'playing') return st.anchor.pos
    const theta = this.o.offset() ?? 0
    return st.anchor.pos + (local + theta - st.anchor.hostTime) / 1000
  }

  /** Local time at which the room's expected position reaches pos. */
  private localWhen(pos: number): number {
    const st = this.st
    const theta = this.o.offset() ?? 0
    if (!st) return this.clock.now()
    return st.anchor.hostTime - theta + (pos - st.anchor.pos) * 1000
  }

  /**
   * Where to meet a playing room: a seek (plus a margin) ahead when 2 s are buffered there, else estReady ahead,
   * the time a download took to get ready.
   */
  private rendezvousTarget(now: number): number {
    const quick = this.media.bufferedAheadS(this.expectedAt(now + this.drift.seekLatMs)) >= MEMBER.SKIP_MIN_AHEAD_S
    const est = quick ? this.drift.seekLatMs + MEMBER.RENDEZVOUS_MARGIN_MS : this.estReadyMs
    return this.clampPos(this.expectedAt(now + est))
  }

  /** Longest pause-wait worth doing: no longer than a rendezvous would take. */
  private maxWaitMs(): number {
    return Math.max(MEMBER.WAIT_AHEAD_MIN_MS, this.estReadyMs + MEMBER.RENDEZVOUS_MARGIN_MS)
  }

  private clampPos(pos: number): number {
    const dur = this.media.durationS()
    return Math.max(0, dur === null ? pos : Math.min(pos, Math.max(0, dur - 0.1)))
  }

  private noteLag(sentAt: number): void {
    const theta = this.o.offset()
    if (theta === null) return
    const lag = this.clock.now() + theta - sentAt
    if (lag > MEMBER.LAG_MAX_MS) return
    this.lags.push(Math.max(0, lag))
    if (this.lags.length > MEMBER.LAG_WINDOW) this.lags.shift()
  }

  private updateNudge(s: PlayerSnapshot): void {
    this.drift.canNudge = this.nudge && !s.spdif
  }
}

function targetOf(a: Extract<Activity, { k: 'settle' | 'prep' }>): number {
  return a.k === 'settle' ? a.pos : a.target
}

/** The exact paused position an activity holds (where our seek or load landed, or a read), if any. */
function exactPausedAt(a: Activity): number | null {
  if (a.k === 'settle') return a.seeking ? null : a.actual
  if (a.k === 'prep') return !a.seeking && a.exact ? a.target : null
  if (a.k === 'scheduled') return a.exact ? a.pos : null
  return null
}

function sameActuation(a: SyncState, b: SyncState): boolean {
  return a.mode === b.mode && a.anchor.pos === b.anchor.pos && a.anchor.hostTime === b.anchor.hostTime
}

function nullableFinite(x: number | null): number | null {
  return x === null ? null : finite(x)
}
