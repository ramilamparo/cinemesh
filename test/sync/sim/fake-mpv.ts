import type { PlaybackIntent } from '../../../src/shared/ipc/core.js'
import type {
  PlayerEvents,
  PlayerPort,
  PlayerSnapshot,
  PositionSample,
  TimerHandle,
  Unsubscribe,
} from '../../../src/core/sync/ports.js'
import type { FakeMedia } from './fake-media.js'
import { type EventLoop, type NodeClock, type Rng, uniform } from './loop.js'

export interface MpvOpts {
  /** seek → playback-restart, uniform in [min, max] (plus any wait for data) */
  seekLatMs: [number, number]
  /** unpause → audio actually moving */
  unpauseLatMs: number
  unpauseJitterMs: number
  /** playback-restart → audio moving again when the seek happened while playing */
  restartLatMs: number
  loadLatMs: number
  fps: number
  ipcRttMs: [number, number]
  /** sound-card clock against true time */
  audioSkewPpm: number
  sampleNoiseMs: number
  spdif: boolean
  /**
   * Where a seek or load lands. 'frame': on the first frame at or after target − 5 ms, and playback starts there,
   * as mpv's exact seeks do (ADR 0007 Finding 4); 'exact': on the target.
   */
  landing: 'frame' | 'exact'
  /**
   * After a pause from playback, a paused seek or load leaves audio-pts (sample) this much early until the next
   * unpause: the AO's buffered delay at the pause (push AOs; ADR 0007 Finding 5). 0: never.
   */
  stalePausedMs: number
}

export const DEFAULT_MPV: MpvOpts = {
  seekLatMs: [150, 450],
  unpauseLatMs: 60,
  unpauseJitterMs: 4,
  restartLatMs: 20,
  loadLatMs: 400,
  fps: 24,
  ipcRttMs: [0.5, 3],
  audioSkewPpm: 0,
  sampleNoiseMs: 1,
  spdif: false,
  landing: 'frame',
  stalePausedMs: 170,
}

type Listeners = { [E in keyof PlayerEvents]: Set<(d: PlayerEvents[E]) => void> }

/**
 * mpv as the sync engine sees it: position advances in true time at speed × the audio clock, seeks and unpauses
 * take time, time-pos is frame-quantised, and playback stalls (paused-for-cache) when it reaches the end of the
 * downloaded data, resuming once 1 s is buffered (cache-pause-wait=1).
 */
export class FakeMpv implements PlayerPort {
  readonly o: MpvOpts
  readonly speedCalls: { t: number; speed: number }[] = []
  readonly pauseCalls: { t: number; paused: boolean }[] = []
  /** true times at which audio started moving after an unpause */
  readonly starts: number[] = []
  seekCount = 0
  available = true
  /** the file mpv shows: the last load's src, or another client's */
  src: string | null = null
  /** mpv cannot open what it is given: every load ends without a file, and the controller rejects it */
  unopenable = false
  private loaded = false
  /** a load whose playback-restart has not come yet */
  private loadInFlight = false
  /** loads that reached their playback-restart */
  private loadsDone = 0
  private paused = true
  private speed = 1
  private seeking = false
  private pausedForCache = false
  /** stall(true): stalled whatever the media has */
  private forcedStall = false
  private eof = false
  private running = false
  /** audio ran since the process started: the AO keeps its state from the last pause (stalePausedMs) */
  private played = false
  /** sample() reads stalePausedMs early */
  private stale = false
  private base = 0
  private baseT = 0
  private pendingStart: TimerHandle | null = null
  private seekGen = 0
  private readonly audioRate: number
  private readonly on_: Listeners = {
    intent: new Set(),
    playbackRestart: new Set(),
    audioReconfig: new Set(),
    externalChange: new Set(),
    eof: new Set(),
    buffering: new Set(),
    state: new Set(),
    loadFailed: new Set(),
  }

  constructor(
    private readonly loop: EventLoop,
    private readonly r: Rng,
    private readonly clock: NodeClock,
    private readonly media: FakeMedia,
    opts: Partial<MpvOpts> = {},
  ) {
    this.o = { ...DEFAULT_MPV, ...opts }
    this.audioRate = 1 + this.o.audioSkewPpm * 1e-6
    loop.every(100, () => this.poll())
  }

  /** True media position right now. */
  pos(): number {
    if (!this.running) return this.base
    return this.base + ((this.loop.t - this.baseT) / 1000) * this.speed * this.audioRate
  }

  get isRunning(): boolean {
    return this.running
  }

  // ---- PlayerPort ----------------------------------------------------------------------------

  load(src: string, opts: { startS: number; paused: boolean }): void {
    this.src = src
    this.loaded = false
    this.paused = opts.paused
    this.loadInFlight = true
    if (this.unopenable) {
      this.failLoad()
      return
    }
    this.beginSeek(opts.startS, this.o.loadLatMs, () => {
      this.loaded = true
      this.loadInFlight = false
      this.loadsDone++
    })
    this.emitState()
  }

  seek(posS: number): void {
    if (!this.loaded) return
    this.seekCount++
    this.beginSeek(posS, uniform(this.r, this.o.seekLatMs[0], this.o.seekLatMs[1]), () => undefined)
  }

  setPaused(paused: boolean): void {
    this.pauseCalls.push({ t: this.loop.t, paused })
    if (paused === this.paused) return
    this.paused = paused
    if (paused) {
      this.cancelStart()
      this.freeze()
    } else {
      const lat = this.o.unpauseLatMs + uniform(this.r, -this.o.unpauseJitterMs, this.o.unpauseJitterMs)
      this.armStart(lat, true)
    }
    this.emitState()
  }

  setSpeed(speed: number): void {
    this.speedCalls.push({ t: this.loop.t, speed })
    if (this.running) {
      this.base = this.pos()
      this.baseT = this.loop.t
    }
    this.speed = speed
    this.emitState()
  }

  sample(cb: (s: PositionSample | null) => void): void {
    const rtt = uniform(this.r, this.o.ipcRttMs[0], this.o.ipcRttMs[1])
    const tSend = this.clock.now()
    let posS = 0
    this.loop.after(rtt / 2, () => {
      const early = this.stale && !this.running ? this.o.stalePausedMs / 1000 : 0
      posS = this.pos() - early + uniform(this.r, -this.o.sampleNoiseMs, this.o.sampleNoiseMs) / 1000
    })
    this.loop.after(rtt, () => cb(this.loaded ? { posS, tSend, tRecv: this.clock.now() } : null))
  }

  /** The frame shown, where playback starts; with exact landing, a file whose position is not frame-bound. */
  readTimePos(cb: (posS: number | null) => void): void {
    const rtt = uniform(this.r, this.o.ipcRttMs[0], this.o.ipcRttMs[1])
    let at: number | null = null
    this.loop.after(rtt / 2, () => {
      at = this.o.landing === 'frame' ? this.snapshot().timePosS : this.loaded ? this.pos() : null
    })
    this.loop.after(rtt, () => cb(at))
  }

  snapshot(): PlayerSnapshot {
    const p = this.pos()
    return {
      available: this.available,
      loaded: this.loaded,
      paused: this.paused,
      pausedForCache: this.pausedForCache,
      seeking: this.seeking,
      coreIdle: !this.running,
      eof: this.eof,
      timePosS: this.loaded ? Math.floor(p * this.o.fps + 1e-9) / this.o.fps : null,
      speed: this.speed,
      spdif: this.o.spdif,
      frameDrops: 0,
      frameS: 1 / this.o.fps,
    }
  }

  on<E extends keyof PlayerEvents>(event: E, fn: (data: PlayerEvents[E]) => void): Unsubscribe {
    const set = this.on_[event] as Set<(d: PlayerEvents[E]) => void>
    set.add(fn)
    return () => set.delete(fn)
  }

  // ---- test controls -------------------------------------------------------------------------

  /** Something outside sync paused mpv (e.g. the macOS menu bar); enforcement reports it. */
  externalPause(): void {
    this.paused = true
    this.cancelStart()
    this.freeze()
    this.emit('externalChange', { kind: 'pause' })
  }

  /**
   * Playback stops where it is as for data mpv does not have (paused-for-cache), whatever the media holds, until
   * stall(false) (then it resumes as a stall does, once 1 s is buffered) or a seek or load lands.
   */
  stall(on: boolean): void {
    this.forcedStall = on
    if (!on || !this.loaded) return
    this.cancelStart()
    this.freeze()
    if (this.pausedForCache) return
    this.pausedForCache = true
    this.emit('buffering', true)
    this.emitState()
  }

  userIntent(i: PlaybackIntent): void {
    this.emit('intent', i)
  }

  /** The process died (or the user closed it): no IPC, nothing loaded, a load or seek in flight is lost. */
  crash(): void {
    const lost = this.takeLoad()
    this.seekGen++
    this.cancelStart()
    this.freeze()
    this.available = false
    this.loaded = false
    this.seeking = false
    this.paused = true
    this.played = false
    this.stale = false
    this.emitState()
    if (lost) this.loadFailed(false)
  }

  /**
   * PlayerController's restart: a new process with its IPC up (the member loads from that state event), then
   * the controller's own reload of the last file at `reloadAtS` (its restoreOnSpawn), which replaces the
   * member's load as the second loadfile does in mpv.
   */
  respawn(reloadAtS?: () => number): void {
    this.available = true
    this.emitState()
    if (reloadAtS) this.load('sim://reload', { startS: reloadAtS(), paused: true })
  }

  /**
   * Something loaded another file into mpv: enforcement reports the path change (the member reloads from
   * that event), then the controller reloads the room's file at `reloadAtS` itself (its checkPath).
   */
  externalPathChange(reloadAtS: () => number): void {
    this.emit('externalChange', { kind: 'path' })
    this.load('sim://reload', { startS: reloadAtS(), paused: true })
  }

  /**
   * Another client loaded its file into mpv, and the controller leaves the reload to the caller (selfReload
   * false). `idle`: it gives our file up first (state idle, a seek in flight superseded, a load in flight
   * rejected as superseded), then reports the path; otherwise it only reports the path, still 'ready' on the
   * other file. `restartAfterMs`: that file's own playback-restart comes this much later, as the controller
   * passes every mpv restart on, and it can reach it after our next loadfile went out (mpv sent it before it
   * took that loadfile, so never after our next load's restart). Without it, it never comes.
   */
  foreignFile(opts: { idle: boolean; restartAfterMs?: number }): void {
    this.giveUp('sim://foreign', opts.idle)
    if (opts.restartAfterMs === undefined) return
    const done = this.loadsDone
    this.loop.after(opts.restartAfterMs, () => {
      if (this.loadsDone === done) this.emit('playbackRestart', undefined)
    })
  }

  /**
   * Another client's `stop` (or a playlist removal) ended our file, or dropped our entry before it started: the
   * controller gives our file up as for another client's file (state idle, a seek in flight superseded, a load
   * in flight rejected as superseded, then the path reported). mpv shows nothing, so no restart follows.
   */
  foreignStop(): void {
    this.giveUp(null, true)
  }

  // ---- internals -----------------------------------------------------------------------------

  /** Another client's command ended our file: mpv now shows `src` (null: nothing). See foreignFile. */
  private giveUp(src: string | null, idle: boolean): void {
    // ours in flight is replaced; a load the member starts from the events below is not
    const replaced = idle && this.takeLoad()
    this.seekGen++
    this.cancelStart()
    this.freeze()
    this.seeking = false
    this.src = src
    if (idle) {
      this.loaded = false
      this.emitState()
    }
    this.emit('externalChange', { kind: 'path' })
    if (replaced) this.loadFailed(true)
  }

  /** mpv gives up on the file after trying (end-file with an error): the load is rejected, nothing is loaded. */
  private failLoad(): void {
    const g = ++this.seekGen
    this.seeking = true
    this.cancelStart()
    this.freeze()
    this.emitState()
    this.loop.after(this.o.loadLatMs, () => {
      if (g !== this.seekGen || !this.takeLoad()) return
      this.seeking = false
      this.emitState()
      this.loadFailed(false)
    })
  }

  /** Whether a load was in flight; it no longer is. */
  private takeLoad(): boolean {
    const was = this.loadInFlight
    this.loadInFlight = false
    return was
  }

  /** The controller rejected the load: the adapter reports it a turn later (a promise rejection). */
  private loadFailed(superseded: boolean): void {
    this.loop.after(0, () => this.emit('loadFailed', { superseded }))
  }

  private beginSeek(target: number, latMs: number, onLoaded: () => void): void {
    const g = ++this.seekGen
    this.seeking = true
    this.cancelStart()
    this.freeze()
    this.loop.after(latMs, () => {
      const finish = (): void => {
        if (g !== this.seekGen) return
        onLoaded()
        this.base = Math.min(this.landingOf(target), this.media.o.durationS)
        this.baseT = this.loop.t
        if (this.paused && this.played) this.stale = true
        this.seeking = false
        this.eof = false
        this.pausedForCache = false
        this.forcedStall = false
        this.emit('playbackRestart', undefined)
        this.emitState()
        if (!this.paused) this.armStart(this.o.restartLatMs, false)
      }
      const wait = (): void => {
        if (g !== this.seekGen) return
        if (this.media.readiness(target)) finish()
        else this.loop.after(50, wait)
      }
      wait()
    })
  }

  private armStart(latMs: number, isUnpause: boolean): void {
    this.cancelStart()
    if (!this.loaded || this.seeking) return
    this.pendingStart = this.loop.after(Math.max(0, latMs), () => {
      this.pendingStart = null
      if (this.paused || this.seeking || this.pausedForCache || this.eof || !this.loaded) return
      this.base = this.pos()
      this.baseT = this.loop.t
      this.running = true
      this.played = true
      this.stale = false
      if (isUnpause) this.starts.push(this.loop.t)
      this.emitState()
    })
  }

  private landingOf(target: number): number {
    if (this.o.landing === 'exact') return target
    const fps = this.o.fps
    return Math.max(0, Math.ceil((target - 0.005) * fps - 1e-9) / fps)
  }

  private cancelStart(): void {
    this.pendingStart?.cancel()
    this.pendingStart = null
  }

  private freeze(): void {
    this.base = this.pos()
    this.baseT = this.loop.t
    this.running = false
  }

  private poll(): void {
    if (!this.loaded) return
    const dur = this.media.o.durationS
    if (this.running) {
      const end = this.media.contiguousEnd(this.base)
      const p = this.pos()
      if (p >= dur) {
        this.freeze()
        this.base = dur
        this.eof = true
        this.paused = true
        this.emit('eof', undefined)
        this.emitState()
      } else if (p >= end) {
        this.freeze()
        this.base = end
        this.pausedForCache = true
        this.emit('buffering', true)
        this.emitState()
      }
      return
    }
    const enough = this.media.contiguousEnd(this.base) - this.base >= Math.min(1, dur - this.base - 0.01)
    if (this.pausedForCache && !this.forcedStall && enough) {
      this.pausedForCache = false
      this.emit('buffering', false)
      this.emitState()
      if (!this.paused && !this.seeking) this.armStart(this.o.restartLatMs, false)
    }
  }

  private emitState(): void {
    if (this.on_.state.size > 0) this.emit('state', this.snapshot())
  }

  private emit<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    for (const fn of [...(this.on_[event] as Set<(d: PlayerEvents[E]) => void>)]) fn(data)
  }
}
