import { type MediaMap, PIECE_VERIFIED } from './media-map.js'
import { mergeRanges } from './ranges.js'
import type { ByteRange } from './types.js'

// The readiness policy (plan §4.3) lives here only. The host computes aheadS and sends it in
// `waiting.aheadS`; every member evaluates readiness() against its own piece states.

export const AHEAD_DEFAULT_S = 6
export const AHEAD_HIGH_BITRATE_S = 10
export const AHEAD_AFTER_STALL_S = 12
export const HIGH_BITRATE_BPS = 6_000_000
export const STALL_MEMORY_MS = 60_000
export const PIECES_PAST_POSITION = 2

export interface AheadPolicyInput {
  avgBytesPerSec: number
  nowMs: number
  /** When anyone in the room last stalled, or null. */
  lastStallAtMs: number | null
}

export function readinessAheadS({ avgBytesPerSec, nowMs, lastStallAtMs }: AheadPolicyInput): number {
  if (lastStallAtMs !== null && nowMs - lastStallAtMs < STALL_MEMORY_MS) return AHEAD_AFTER_STALL_S
  if (avgBytesPerSec > HIGH_BITRATE_BPS) return AHEAD_HIGH_BITRATE_S
  return AHEAD_DEFAULT_S
}

export type ReadinessReason = 'start' | 'seek' | 'join' | 'buffering' | 'catchup'

export interface ReadinessOptions {
  /** From the host's `waiting.aheadS`; for reason 'start' the host's start mode decides it. */
  aheadS: number
  /** mpv reported `playback-restart` at this position. */
  playbackRestarted: boolean
  /** Also require the open-critical ranges (true until the player has opened the file). */
  openCritical?: readonly ByteRange[]
}

export interface Readiness {
  ready: boolean
  reason: ReadinessReason
  /** File byte ranges that must be verified. */
  ranges: ByteRange[]
  /** Pieces still missing among those required, in order. */
  missing: number[]
  waitingForRestart: boolean
}

/**
 * Ready to play from posS when every piece of readyRange(pos, aheadS) is verified, at least two pieces
 * past pieceOf(pos) are verified, and mpv has reported playback-restart.
 */
export function readiness(
  map: MediaMap,
  posS: number,
  reason: ReadinessReason,
  states: ArrayLike<number>,
  opts: ReadinessOptions,
): Readiness {
  const posMs = posS * 1000
  const ranges = mergeRanges([...map.readyRange(posMs, opts.aheadS * 1000), ...(opts.openCritical ?? [])], map.fileSize)
  const need = new Set<number>()
  for (const r of ranges) {
    const span = map.piecesOf(r)
    if (span) for (let i = span[0]; i <= span[1]; i++) need.add(i)
  }
  const p = map.pieceOf(map.timeToByte(posMs))
  for (let k = 1; k <= PIECES_PAST_POSITION; k++) need.add(Math.min(map.lastPiece, p + k))
  const missing = [...need].filter((i) => states[i] !== PIECE_VERIFIED).sort((a, b) => a - b)
  return {
    ready: missing.length === 0 && opts.playbackRestarted,
    reason,
    ranges,
    missing,
    waitingForRestart: !opts.playbackRestarted,
  }
}
