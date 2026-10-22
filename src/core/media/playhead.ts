import type { MediaMap } from '../../shared/media/media-map.js'
import type { ByteRange } from '../../shared/media/types.js'

// Playhead adapter (plan §4.3): turns a playback position into the byte window the transfer
// scheduler downloads first. Sync calls set() before every mpv seek and at 1 Hz while playing; the
// host's Revealer uses the group playhead the same way.

export type PlayheadReason = 'seek' | 'play' | 'join' | 'catchup' | 'tick'

export const WINDOW_S = 25
export const HOT_S = 8
export const MAX_WINDOW_BYTES = 256 * 1024 * 1024

export interface PlayheadPlan {
  /** File byte the player starts reading from: MediaMap.seekByte (MKV: 2 s earlier, for subtitle preroll). */
  byte: number
  /** L1 window: ~25 s of bytes, clamped to [2P, 256 MiB]. */
  windowBytes: number
  /** Seek hot window: ~8 s of bytes. */
  hotBytes: number
  /** The playhead jumped (seek, join, catch-up): the scheduler installs the hot window. */
  seek: boolean
  /** Audio intervals of poorly interleaved files over the hot window; urgent like blocked pieces. */
  urgent: ByteRange[]
  posS: number
  reason: PlayheadReason
}

/**
 * Windows are measured from `byte`, not from the position: with the MKV preroll, or a long GOP,
 * bytes(pos, pos + 25 s) starting at `byte` would stop short of pos + 25 s.
 */
export function planPlayhead(map: MediaMap, posS: number, reason: PlayheadReason): PlayheadPlan {
  const pos = Math.max(0, posS * 1000)
  const byte = Math.min(map.seekByte(pos), map.timeToByte(pos))
  const span = (s: number) => Math.max(0, map.timeToByte(pos + s * 1000) - byte)
  const P = map.pieceLength
  return {
    byte,
    windowBytes: Math.min(MAX_WINDOW_BYTES, Math.max(2 * P, span(WINDOW_S))),
    hotBytes: Math.min(MAX_WINDOW_BYTES, span(HOT_S)),
    seek: reason === 'seek' || reason === 'join' || reason === 'catchup',
    urgent: map.audioRanges(pos - map.prerollMs, pos + HOT_S * 1000),
    posS,
    reason,
  }
}

export interface PlayheadSink {
  setPlayhead(plan: PlayheadPlan): void
}

export class Playhead {
  private lastPlan: PlayheadPlan | null = null

  constructor(
    private readonly map: MediaMap,
    private readonly sink: PlayheadSink,
  ) {}

  set(posS: number, reason: PlayheadReason): PlayheadPlan {
    const plan = planPlayhead(this.map, posS, reason)
    this.lastPlan = plan
    this.sink.setPlayhead(plan)
    return plan
  }

  get last(): PlayheadPlan | null {
    return this.lastPlan
  }
}
