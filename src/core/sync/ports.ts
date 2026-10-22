// The sync core does no I/O of its own. Everything it touches goes through these ports, so the same code runs
// against mpv, the room bus and the transfer engine in production and against the simulator in test/sync/sim.
// All times are milliseconds on the local monotonic clock (Clock.now) unless a name says hostTime.

import type { PlaybackIntent } from '../../shared/ipc/core.js'
import type { SyncBusMessage } from './protocol.js'

export type Unsubscribe = () => void

export interface TimerHandle {
  cancel(): void
}

export interface Clock {
  /** Monotonic ms: performance.now() in production, the clock the player stamps IPC samples with. Never Date.now(). */
  now(): number
  /** setTimeout. A negative delay fires on the next turn. */
  setTimer(ms: number, fn: () => void): TimerHandle
  /** setImmediate. Scheduled unpauses spin on it for the last few ms before their deadline. */
  immediate(fn: () => void): TimerHandle
  /** Current event-loop delay in ms (perf_hooks histogram); drift samples are dropped while it is >= 20. */
  loopLagMs(): number
}

// ---- player ------------------------------------------------------------------------------------

export interface PositionSample {
  /** audio-pts, or time-pos when there is no audio */
  posS: number
  /** Clock.now() just before the get_property request was written, and when its reply was parsed */
  tSend: number
  tRecv: number
}

export interface PlayerSnapshot {
  /** mpv is running and its IPC is connected; false gives phase no-player */
  available: boolean
  /**
   * our file is loaded: a load reached its playback-restart and nothing replaced it since (the player says so
   * before it passes that restart on)
   */
  loaded: boolean
  paused: boolean
  pausedForCache: boolean
  seeking: boolean
  coreIdle: boolean
  eof: boolean
  /** time-pos, quantised to frames by mpv */
  timePosS: number | null
  speed: number
  /** audio-out-params/format starts with 'spdif': speed changes would break passthrough */
  spdif: boolean
  /** frame-drop-count + decoder-frame-drop-count */
  frameDrops: number
  /** 1 / container-fps, at most 1 s; 1/24 when unknown (or above 240 fps) */
  frameS: number
}

export interface PlayerEvents {
  /** OSC input turned into an intent; never applied by the player itself */
  intent: PlaybackIntent
  /**
   * mpv playback-restart: a seek or load finished and frames are flowing (or ready, when paused). Every one, also
   * another file's (another client's, or one our newer loadfile replaces): a load completes at the first one that
   * finds snapshot().loaded.
   */
  playbackRestart: undefined
  audioReconfig: undefined
  /** enforcement saw pause/position/speed/path change behind our back */
  externalChange: { kind: 'pause' | 'seek' | 'speed' | 'path' }
  eof: undefined
  /** paused-for-cache changed */
  buffering: boolean
  /** any field of snapshot() changed */
  state: PlayerSnapshot
  /**
   * The last load() will never reach its playbackRestart. `superseded`: another file replaced it (another
   * client's, while ours opened); otherwise mpv could not open it, or went away under it.
   */
  loadFailed: { superseded: boolean }
}

export interface PlayerPort {
  /**
   * loadfile <src> replace -1 start=<s>,pause=yes|no. Completion is the next playbackRestart that finds
   * snapshot().loaded; a load that will not complete emits loadFailed.
   */
  load(src: string, opts: { startS: number; paused: boolean }): void
  /** seek <pos> absolute+exact. Completion is the next playbackRestart. */
  seek(posS: number): void
  setPaused(paused: boolean): void
  setSpeed(speed: number): void
  /**
   * One audio-pts round trip; null when mpv did not answer. mpv answers in order: a sample sent right after
   * setPaused(true) reads the paused position.
   */
  sample(cb: (s: PositionSample | null) => void): void
  /**
   * One time-pos round trip (null: no answer, or no position). Sent at a seek's or load's playback-restart, it
   * reads the frame mpv landed on: the first at or after target − 5 ms, where playback starts (ADR 0007 Finding 4).
   */
  readTimePos(cb: (posS: number | null) => void): void
  snapshot(): PlayerSnapshot
  on<E extends keyof PlayerEvents>(event: E, fn: (data: PlayerEvents[E]) => void): Unsubscribe
}

// ---- room bus and datagrams ---------------------------------------------------------------------

export interface BusSendOptions {
  /** one peer; omitted means every member */
  to?: string
  /** keep as the latest value of this message type and replay it to members who connect later */
  sticky?: boolean
}

export interface PresenceEvent {
  kind: 'join' | 'leave'
  peerId: string
  name: string
  /**
   * leave: how long ago the peer was last heard from (ms). A crash is noticed only by silence, seconds after
   * the last word; sync's 10 s grace counts from that word. Absent or 0: just now (a bye, a link closing).
   */
  sinceMs?: number
}

export interface BusPort {
  publish(msg: SyncBusMessage, opts?: BusSendOptions): void
  /** Raw bodies; sync validates them with parseBusMessage. Own messages are not echoed back. */
  onMessage(fn: (from: string, raw: unknown) => void): Unsubscribe
  /** Members whose control lane opened or closed (admitted peers only). */
  onPresence(fn: (ev: PresenceEvent) => void): Unsubscribe
}

export interface DatagramPort {
  send(peerId: string, data: Uint8Array): void
  /**
   * The fallback flag: false for via-peer members (relayed links carry datagrams: net's relay test checks it).
   * Sync then sends pings and state over the bus only.
   */
  usable(peerId: string): boolean
  onMessage(fn: (from: string, data: Uint8Array) => void): Unsubscribe
}

// ---- media and transfer --------------------------------------------------------------------------

export type ReadinessReason = 'open' | 'seek' | 'start' | 'rendezvous'
export type PlayheadReason = 'seek' | 'catchup' | 'rendezvous'

export interface MediaPort {
  durationS(): number | null
  /** true once mpv can start at posS without blocking (readiness gate of §4.3) */
  readiness(posS: number, reason: ReadinessReason): boolean
  /** contiguous seconds downloaded from posS */
  bufferedAheadS(posS: number): number
  /** bytes/s the stream needs at 1x (0 when everything is local) */
  needBps(): number
  /** Moves the download playhead; called before mpv is told to seek so the pieces are requested first. */
  playhead: { set(posS: number, reason: PlayheadReason): void }
  /** pieces arrived or the index changed; readiness may have flipped */
  onChange(fn: () => void): Unsubscribe
}

export interface TransferPort {
  /** download rate in bytes/s, 10 s EWMA */
  rateBps(): number
  /** seconds until everything from the playhead to EOF is local; 0 when complete, null when unknown */
  etaToEofS(): number | null
  /** 256-bit coverage bitmap (base64), passed through to the host */
  coverage(): string | null
  diskFull(): boolean
  /** the member's own download limit in bytes/s, null = none; reported to the host, which names it in warnings */
  downLimitBps?(): number | null
}

export interface SyncPorts {
  clock: Clock
  player: PlayerPort
  bus: BusPort
  datagram: DatagramPort
  media: MediaPort
  transfer: TransferPort
}

/** Repeating timer on top of Clock.setTimer. */
export function every(clock: Clock, ms: number, fn: () => void): TimerHandle {
  let handle: TimerHandle | null = null
  let stopped = false
  const arm = (): void => {
    handle = clock.setTimer(ms, () => {
      if (stopped) return
      arm()
      fn()
    })
  }
  arm()
  return {
    cancel() {
      stopped = true
      handle?.cancel()
    },
  }
}
