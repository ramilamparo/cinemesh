import { EventEmitter } from 'node:events'
import type { PlayerEvent, PlayerStatus, Span, TracksEvent } from '../../shared/ipc/core.js'
import type { Timed } from '../player/mpv-ipc.js'
import type { OscKind, OscMessages } from '../player/osc-bridge.js'
import type { LoadOptions, ObservedProperty, SubtitleSpec } from '../player/player-controller.js'
import type { PlayerLike, PlayerLikeEvents } from './player-like.js'

const SEEK_LATENCY_MS = 40

/**
 * A player without mpv (WT_FAKE_PLAYER=1): the position advances with the wall clock while unpaused.
 * Lets e2e tests and headless peers run the whole session (sync, timeline, OSC messages) without a window.
 */
export class FakePlayer extends EventEmitter<PlayerLikeEvents> implements PlayerLike {
  status: PlayerStatus = 'absent'
  readonly pid = null
  readonly oscLog: { kind: OscKind; payload: unknown }[] = []
  private path: string | null = null
  private paused = true
  /** stall(true): stopped as mpv stops for data it does not have (paused-for-cache) */
  private stalled = false
  private speed = 1
  private posAtS = 0
  private atMs = performance.now()
  private durationS: number

  constructor(opts: { durationS?: number } = {}) {
    super()
    this.durationS = opts.durationS ?? 600
  }

  playerEvent(): PlayerEvent {
    return {
      status: this.status,
      version: 'fake',
      hdr: { source: 'sdr', output: 'sdr', gpuContext: null, hwdec: null },
    }
  }

  start(): void {
    this.setStatus('idle')
  }

  reopen(): void {
    this.setStatus(this.path ? 'ready' : 'idle')
  }

  quit(): Promise<void> {
    this.setStatus('absent')
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.setStatus('closedByUser')
    return Promise.resolve()
  }

  dispose(): Promise<void> {
    this.removeAllListeners()
    return Promise.resolve()
  }

  load(url: string, opts: LoadOptions = {}): Promise<void> {
    this.path = url
    this.paused = opts.paused ?? true
    this.stalled = false
    this.jumpTo(opts.start ?? 0)
    this.setStatus('loading')
    return new Promise((resolve) => {
      setTimeout(() => {
        this.setStatus('ready')
        this.emit('fileLoaded', { path: url })
        this.emit('playbackRestart', { pos: this.pos() })
        resolve()
      }, SEEK_LATENCY_MS)
    })
  }

  seek(pos: number): Promise<void> {
    this.jumpTo(pos)
    // a stall ends with a seek: the data is anywhere but where it stopped
    const unstall = this.stalled
    this.stalled = false
    return new Promise((resolve) => {
      setTimeout(() => {
        if (unstall) this.emit('property', 'paused-for-cache', false)
        this.emit('playbackRestart', { pos: this.pos() })
        resolve()
      }, SEEK_LATENCY_MS)
    })
  }

  /**
   * Test hook (production never calls it): playback stops where it is, as mpv's does for data it does not have
   * (paused-for-cache), until stall(false) or a seek.
   */
  stall(on: boolean): void {
    if (on === this.stalled) return
    this.jumpTo(this.pos())
    this.stalled = on
    this.emit('property', 'paused-for-cache', on)
  }

  setPaused(paused: boolean): Promise<void> {
    this.jumpTo(this.pos())
    this.paused = paused
    this.emit('property', 'pause', paused)
    return Promise.resolve()
  }

  setSpeed(speed: number): Promise<void> {
    this.jumpTo(this.pos())
    this.speed = speed
    this.emit('property', 'speed', speed)
    return Promise.resolve()
  }

  setTrack(): Promise<void> {
    return Promise.resolve()
  }

  setVolume(): Promise<void> {
    return Promise.resolve()
  }

  addSubtitle(_sub: SubtitleSpec): Promise<void> {
    return Promise.resolve()
  }

  prop(name: ObservedProperty): unknown {
    switch (name) {
      case 'time-pos':
        return this.path ? this.pos() : null
      case 'pause':
        return this.paused
      case 'speed':
        return this.speed
      case 'duration':
        return this.durationS
      case 'path':
        return this.path
      case 'eof-reached':
        return this.pos() >= this.durationS
      case 'paused-for-cache':
        return this.stalled
      case 'seeking':
      case 'core-idle':
        return false
      default:
        return null
    }
  }

  buffered(): Span[] {
    return []
  }

  tracks(): TracksEvent {
    return { audio: [], sub: [], aid: 'no', sid: 'no', volume: 100, muted: false }
  }

  frameDrops(): { vo: number; decoder: number } {
    return { vo: 0, decoder: 0 }
  }

  sample(): Promise<Timed<number | null> & { prop: 'audio-pts' | 'time-pos' }> {
    const t = performance.now()
    return Promise.resolve({ value: this.path ? this.pos() : null, tSend: t, tRecv: t, prop: 'audio-pts' })
  }

  getProperty<T = unknown>(name: string): Promise<Timed<T>> {
    const t = performance.now()
    return Promise.resolve({ value: (name === 'time-pos' ? this.prop('time-pos') : null) as T, tSend: t, tRecv: t })
  }

  osc<K extends OscKind>(kind: K, payload: OscMessages[K]): void {
    this.oscLog.push({ kind, payload })
    if (this.oscLog.length > 200) this.oscLog.splice(0, 100)
  }

  private pos(): number {
    if (this.paused || this.stalled) return this.posAtS
    const p = this.posAtS + ((performance.now() - this.atMs) / 1000) * this.speed
    return Math.min(p, this.durationS)
  }

  private jumpTo(pos: number): void {
    this.posAtS = Math.max(0, Math.min(pos, this.durationS))
    this.atMs = performance.now()
  }

  private setStatus(next: PlayerStatus): void {
    const prev = this.status
    if (prev === next) return
    this.status = next
    this.emit('state', next, prev)
    this.emit('status', this.playerEvent())
  }
}
