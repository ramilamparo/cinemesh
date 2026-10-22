import { EventEmitter } from 'node:events'
import type { PlayerEvent, PlayerStatus, Span, TracksEvent } from '../../shared/ipc/core.js'
import type { Timed } from '../player/mpv-ipc.js'
import type { OscKind, OscMessages } from '../player/osc-bridge.js'
import type { LoadOptions, ObservedProperty, SubtitleSpec } from '../player/player-controller.js'
import type { PlayerLike, PlayerLikeEvents } from './player-like.js'

const EVENTS: (keyof PlayerLikeEvents)[] = [
  'state',
  'status',
  'intent',
  'fileLoaded',
  'playbackRestart',
  'audioReconfig',
  'external-change',
  'exit',
  'tracks',
  'property',
  'eof',
  'oscReady',
]

/**
 * The session's player, swappable: when the user fixes the mpv path mid-session a new controller takes
 * over while sync and the OSC bridge keep listening to the holder.
 */
export class PlayerHolder extends EventEmitter<PlayerLikeEvents> implements PlayerLike {
  private unbind: (() => void) | null = null

  constructor(private current: PlayerLike) {
    super()
    this.bind(current)
  }

  get player(): PlayerLike {
    return this.current
  }

  async swap(next: PlayerLike): Promise<void> {
    const prev = this.current
    this.unbind?.()
    this.current = next
    this.bind(next)
    await prev.dispose().catch(() => undefined)
    this.emit('status', next.playerEvent())
  }

  private bind(p: PlayerLike): void {
    const handlers = EVENTS.map((name) => {
      const h = (...args: unknown[]): void => {
        ;(this.emit as (n: string, ...a: unknown[]) => boolean)(name, ...args)
      }
      ;(p.on as (n: string, f: (...a: unknown[]) => void) => unknown)(name, h)
      return () => (p.off as (n: string, f: (...a: unknown[]) => void) => unknown)(name, h)
    })
    this.unbind = () => {
      for (const off of handlers) off()
    }
  }

  get status(): PlayerStatus {
    return this.current.status
  }
  get pid(): number | null {
    return this.current.pid
  }
  playerEvent(): PlayerEvent {
    return this.current.playerEvent()
  }
  start(): void {
    this.current.start()
  }
  reopen(): void {
    this.current.reopen()
  }
  quit(): Promise<void> {
    return this.current.quit()
  }
  close(): Promise<void> {
    return this.current.close()
  }
  async dispose(): Promise<void> {
    this.unbind?.()
    await this.current.dispose()
  }
  load(url: string, opts?: LoadOptions): Promise<void> {
    return this.current.load(url, opts)
  }
  seek(pos: number): Promise<void> {
    return this.current.seek(pos)
  }
  setPaused(paused: boolean): Promise<void> {
    return this.current.setPaused(paused)
  }
  setSpeed(speed: number): Promise<void> {
    return this.current.setSpeed(speed)
  }
  setTrack(kind: 'audio' | 'sub', id: number | 'no'): Promise<void> {
    return this.current.setTrack(kind, id)
  }
  setVolume(volume: number, muted: boolean): Promise<void> {
    return this.current.setVolume(volume, muted)
  }
  addSubtitle(sub: SubtitleSpec, select?: boolean): Promise<void> {
    return this.current.addSubtitle(sub, select)
  }
  prop(name: ObservedProperty): unknown {
    return this.current.prop(name)
  }
  buffered(): Span[] {
    return this.current.buffered()
  }
  tracks(): TracksEvent {
    return this.current.tracks()
  }
  frameDrops(): { vo: number; decoder: number } {
    return this.current.frameDrops()
  }
  sample(): Promise<Timed<number | null> & { prop: 'audio-pts' | 'time-pos' }> {
    return this.current.sample()
  }
  getProperty<T = unknown>(name: string): Promise<Timed<T>> {
    return this.current.getProperty<T>(name)
  }
  osc<K extends OscKind>(kind: K, payload: OscMessages[K]): void {
    this.current.osc(kind, payload)
  }
}
