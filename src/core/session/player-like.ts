import type { EventEmitter } from 'node:events'
import type { PlayerEvent, PlayerStatus, Span, TracksEvent } from '../../shared/ipc/core.js'
import type { Timed } from '../player/mpv-ipc.js'
import type { OscKind, OscMessages } from '../player/osc-bridge.js'
import type {
  ExternalChange,
  LoadOptions,
  ObservedProperty,
  PlayerExit,
  PlayerIntent,
  SubtitleSpec,
} from '../player/player-controller.js'

export interface PlayerLikeEvents {
  state: [PlayerStatus, PlayerStatus]
  status: [PlayerEvent]
  intent: [PlayerIntent]
  fileLoaded: [{ path: string }]
  playbackRestart: [{ pos: number | null }]
  audioReconfig: []
  'external-change': [ExternalChange]
  exit: [PlayerExit]
  tracks: [TracksEvent]
  property: [ObservedProperty, unknown]
  eof: [boolean]
  oscReady: []
}

/** What the session uses from PlayerController; FakePlayer implements it for WT_FAKE_PLAYER runs. */
export interface PlayerLike extends EventEmitter<PlayerLikeEvents> {
  readonly status: PlayerStatus
  readonly pid: number | null
  playerEvent(): PlayerEvent
  start(): void
  reopen(): void
  quit(): Promise<void>
  close(): Promise<void>
  dispose(): Promise<void>
  load(url: string, opts?: LoadOptions): Promise<void>
  seek(pos: number): Promise<void>
  setPaused(paused: boolean): Promise<void>
  setSpeed(speed: number): Promise<void>
  setTrack(kind: 'audio' | 'sub', id: number | 'no'): Promise<void>
  setVolume(volume: number, muted: boolean): Promise<void>
  addSubtitle(sub: SubtitleSpec, select?: boolean): Promise<void>
  prop(name: ObservedProperty): unknown
  buffered(): Span[]
  tracks(): TracksEvent
  frameDrops(): { vo: number; decoder: number }
  sample(): Promise<Timed<number | null> & { prop: 'audio-pts' | 'time-pos' }>
  /** One get_property, answered after every command sent before it. */
  getProperty<T = unknown>(name: string): Promise<Timed<T>>
  osc<K extends OscKind>(kind: K, payload: OscMessages[K]): void
}
