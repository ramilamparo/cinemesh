import { mergeRanges } from './ranges.js'
import type { AudioIndex, ByteRange, KeyPoint, MediaIndex } from './types.js'

export type SeekPick = 'keyframe' | 'interp' | 'nextKeyframe'

/** Piece states (plan §4.2): 0 missing, 1 partial or requested, 2 verified. */
export const PIECE_MISSING = 0
export const PIECE_PARTIAL = 1
export const PIECE_VERIFIED = 2
export type PieceState = 0 | 1 | 2

/** [t0 s, t1 s, state] */
export type TimelineSpan = readonly [t0: number, t1: number, state: PieceState]
export type TimeRange = readonly [s: number, e: number]

/** Subtitle packets start up to this long before the frame mpv seeks to in MKV (sub preroll). */
export const MKV_SUBTITLE_PREROLL_MS = 2000
/**
 * Other containers: when p is exactly on a keyframe, lavf's backward seek (dts-based, B-frame CTS offset)
 * lands on the previous GOP, so look this much further back (ADR 0004, finding 6).
 */
export const SEEK_PREROLL_MS = 250
/**
 * Other containers interleave a keyframe's audio beside it, and the index holds video offsets only. S4
 * found up to ~46 KB of audio in front of the keyframe mpv seeks to, and the audio of the last frames
 * before the next keyframe stored after that keyframe's own frame. Covers AVI's 8-byte chunk header too.
 */
export const INTERLEAVE_SLACK_BYTES = 64 * 1024
/**
 * mpv serves a forward seek of up to --stream-buffer-size (1 MiB, MPV_STREAM_OPTS) by reading on, and
 * FFmpeg's avio below it one of up to its TCP receive window (Linux autotunes loopback to ~1 MiB). A start
 * this close past the head that the open reads is reached through every byte in between: our gated AVI
 * at 13.5 s, a case S4 (2 Mbit/s, targets 20 s and 300 s) never hit.
 */
export const STREAM_SKIP_BYTES = 2 * 1024 * 1024
export const MAX_TIMELINE_RANGES = 512

export interface MediaMapInput extends Pick<
  MediaIndex,
  'fileSize' | 'container' | 'seekMode' | 'interleave' | 'durationMs' | 'avgBytesPerSec' | 'keyframes'
> {
  pieceLength: number
  audioIndexes?: AudioIndex[]
  /** The manifest's open-critical ranges: their head range (at byte 0) anchors the read-on rule of seekByte. */
  openCritical?: readonly ByteRange[]
}

export interface MediaMapOptions {
  /** Offset of the video file inside the torrent. The video is file 0, so this is 0 by design. */
  fileOffset?: number
}

/**
 * Time ↔ byte ↔ piece mapping for one video file. Pure: built once from the manifest, never mutated,
 * and safe to share with the renderer. Times are ms unless the name says S (seconds).
 * Bytes are file bytes; pieces are torrent piece indexes.
 */
export class MediaMap {
  readonly fileSize: number
  readonly durationMs: number
  readonly pieceLength: number
  readonly fileOffset: number
  readonly firstPiece: number
  readonly lastPiece: number
  readonly linear: boolean
  readonly prerollMs: number
  /** Bytes added before the first and after the last keyframe of a range (0 for MKV, which seeks to Clusters). */
  readonly slackBytes: number
  /** End of the open-critical range at byte 0, where the open leaves mpv's reader; null when not given. */
  readonly headEnd: number | null
  private readonly input: MediaMapInput
  private readonly kt: Float64Array
  private readonly kb: Float64Array
  // Interpolation anchors: keyframes plus (duration, fileSize), or (0, 0)-(duration, size) without any.
  private readonly at: Float64Array
  private readonly ab: Float64Array
  // Start time (s) of each video piece relative to firstPiece, plus the end: prefix sums of piece durations.
  private readonly bound: Float64Array

  constructor(input: MediaMapInput, opts: MediaMapOptions = {}) {
    if (input.pieceLength <= 0) throw new Error('pieceLength must be positive')
    this.input = input
    this.fileSize = input.fileSize
    this.durationMs = Math.max(0, input.durationMs)
    this.pieceLength = input.pieceLength
    this.fileOffset = opts.fileOffset ?? 0
    this.firstPiece = Math.floor(this.fileOffset / this.pieceLength)
    this.lastPiece = Math.floor((this.fileOffset + Math.max(0, this.fileSize - 1)) / this.pieceLength)
    this.linear = input.seekMode === 'linear'
    const mkv = input.container === 'mkv' || input.container === 'webm'
    this.prerollMs = mkv ? MKV_SUBTITLE_PREROLL_MS : SEEK_PREROLL_MS
    this.slackBytes = mkv ? 0 : INTERLEAVE_SLACK_BYTES
    const head = input.openCritical ? mergeRanges(input.openCritical, this.fileSize)[0] : undefined
    this.headEnd = head?.[0] === 0 ? head[1] : null

    const kfs = input.keyframes.filter(([, b]) => b < this.fileSize)
    this.kt = Float64Array.from(kfs, ([t]) => t)
    this.kb = Float64Array.from(kfs, ([, b]) => b)
    const anchors: KeyPoint[] = kfs.length ? [...kfs] : [[0, 0]]
    const last = anchors.at(-1) ?? [0, 0]
    if (this.fileSize > last[1]) anchors.push([Math.max(this.durationMs, last[0]), this.fileSize])
    this.at = Float64Array.from(anchors, ([t]) => t)
    this.ab = Float64Array.from(anchors, ([, b]) => b)

    const n = this.lastPiece - this.firstPiece + 1
    this.bound = new Float64Array(n + 1)
    for (let k = 1; k < n; k++) {
      this.bound[k] = this.byteToTime((this.firstPiece + k) * this.pieceLength - this.fileOffset) / 1000
    }
    this.bound[n] = this.durationMs / 1000
    for (let k = 1; k <= n; k++) this.bound[k] = Math.max(this.bound[k] ?? 0, this.bound[k - 1] ?? 0)
  }

  get keyframeCount(): number {
    return this.kt.length
  }

  timeToByte(ms: number, pick: SeekPick = 'interp'): number {
    if (pick !== 'interp' && this.kt.length > 0) {
      if (pick === 'keyframe') {
        const i = upperBound(this.kt, ms) - 1
        return this.kb[Math.max(0, i)] ?? 0
      }
      const i = upperBound(this.kt, ms)
      return i < this.kt.length ? (this.kb[i] ?? this.fileSize) : this.fileSize
    }
    return Math.round(interpolate(this.at, this.ab, ms))
  }

  byteToTime(byte: number): number {
    return interpolate(this.ab, this.at, Math.min(byte, this.fileSize))
  }

  /** Bytes the player reads to play [t0, t1]. */
  bytesBetween(t0Ms: number, t1Ms: number): number {
    return Math.max(0, this.timeToByte(t1Ms) - this.timeToByte(t0Ms))
  }

  /** Download rate needed to keep up, around `posMs` when given, else on average. */
  needBps(posMs?: number, horizonMs = 30_000): number {
    if (posMs !== undefined && horizonMs > 0) return (this.bytesBetween(posMs, posMs + horizonMs) * 1000) / horizonMs
    if (this.input.avgBytesPerSec > 0) return this.input.avgBytesPerSec
    return this.durationMs > 0 ? (this.fileSize * 1000) / this.durationMs : 0
  }

  pieceOf(fileByte: number): number {
    const b = Math.min(Math.max(0, fileByte), Math.max(0, this.fileSize - 1))
    return Math.floor((this.fileOffset + b) / this.pieceLength)
  }

  /** Inclusive piece span of a file byte range (end exclusive); null when empty. */
  piecesOf([a, b]: ByteRange): readonly [number, number] | null {
    if (b <= a) return null
    return [this.pieceOf(a), this.pieceOf(b - 1)]
  }

  /** Playback times [t0, t1] (ms) whose bytes lie in piece i; null outside the video file. */
  pieceToTimeSpan(i: number): readonly [number, number] | null {
    if (i < this.firstPiece || i > this.lastPiece) return null
    const k = i - this.firstPiece
    return [(this.bound[k] ?? 0) * 1000, (this.bound[k + 1] ?? 0) * 1000]
  }

  /**
   * The first file byte the player reads to start at pMs (ADR 0004 §5): the keyframe at or before
   * p − prerollMs (MKV: its Cluster, 2 s back for the subtitle preroll). Other containers start
   * slackBytes earlier for the audio stored in front of the keyframe. fMP4 keeps each fragment's audio
   * after its video, so the audio before a keyframe is in the previous fragment: start at that moof.
   * A start at most STREAM_SKIP_BYTES past the open-critical head is read on to from the head: headEnd.
   */
  seekByte(pMs: number): number {
    const b = this.keyframeByte(pMs)
    const head = this.headEnd
    return head !== null && b > head && b - head <= STREAM_SKIP_BYTES ? head : b
  }

  private keyframeByte(pMs: number): number {
    if (this.kt.length === 0) return Math.max(0, this.timeToByte(pMs - this.prerollMs) - this.slackBytes)
    let i = Math.max(0, upperBound(this.kt, pMs - this.prerollMs) - 1)
    if (this.input.container === 'fmp4') i = Math.max(0, i - 1)
    return Math.max(0, (this.kb[i] ?? 0) - this.slackBytes)
  }

  /**
   * File bytes that must be present to start at pMs and play aheadMs: from seekByte(pMs) (0 in linear
   * mode, where the demuxer may scan from the start) to the keyframe after pMs + aheadMs, plus the
   * slack for the audio stored after it. Poorly interleaved files add the matching interval of every
   * audio track.
   */
  readyRange(pMs: number, aheadMs: number): ByteRange[] {
    const end = pMs + Math.max(0, aheadMs)
    const lo = this.linear ? 0 : this.seekByte(pMs)
    const hi =
      this.kt.length > 0
        ? Math.min(this.fileSize, this.timeToByte(end, 'nextKeyframe') + this.slackBytes)
        : this.timeToByte(end + 1000) + Math.ceil(this.needBps())
    const out: ByteRange[] = [[Math.min(lo, this.timeToByte(pMs)), hi]]
    out.push(...this.audioRanges(pMs, end))
    return mergeRanges(out, this.fileSize)
  }

  /** Byte intervals of each audio track for [t0, t1]; empty unless the file is poorly interleaved. */
  audioRanges(t0Ms: number, t1Ms: number): ByteRange[] {
    if (this.input.interleave !== 'poor' || !this.input.audioIndexes) return []
    const out: ByteRange[] = []
    for (const a of this.input.audioIndexes) {
      if (a.points.length === 0) continue
      const i0 = Math.max(0, upperBoundPoints(a.points, t0Ms) - 1)
      const i1 = upperBoundPoints(a.points, t1Ms)
      const lo = a.points[i0]?.[1] ?? 0
      const hi = a.points[i1]?.[1] ?? this.fileSize
      out.push([lo, Math.max(lo + 1, hi)])
    }
    return mergeRanges(out, this.fileSize)
  }

  /** Seconds playable from posS before the first piece that is not verified. */
  bufferedAheadS(posS: number, states: ArrayLike<number>): number {
    const start = this.pieceOf(this.timeToByte(posS * 1000))
    for (let i = start; i <= this.lastPiece; i++) {
      if (states[i] !== PIECE_VERIFIED) {
        return Math.max(0, (this.bound[i - this.firstPiece] ?? 0) - posS)
      }
    }
    return Math.max(0, this.durationMs / 1000 - posS)
  }

  /** Merged [t0, t1, state] spans in seconds; pieces that hold no playback time are skipped. */
  timelineSpans(states: ArrayLike<number>): TimelineSpan[] {
    const out: [number, number, PieceState][] = []
    for (let i = this.firstPiece; i <= this.lastPiece; i++) {
      const k = i - this.firstPiece
      const t0 = this.bound[k] ?? 0
      const t1 = this.bound[k + 1] ?? 0
      if (t1 <= t0) continue
      const s = toState(states[i])
      const last = out.at(-1)
      if (last && last[2] === s && last[1] >= t0) last[1] = t1
      else out.push([t0, t1, s])
    }
    return out
  }

  /** `done` and `loading` second ranges for the timeline, each at most maxRanges long. */
  timelineRanges(
    states: ArrayLike<number>,
    maxRanges = MAX_TIMELINE_RANGES,
  ): { done: TimeRange[]; loading: TimeRange[] } {
    const spans = this.timelineSpans(states)
    const pick = (s: PieceState): TimeRange[] =>
      capRanges(
        spans.filter((x) => x[2] === s).map(([a, b]): TimeRange => [a, b]),
        maxRanges,
      )
    return { done: pick(PIECE_VERIFIED), loading: pick(PIECE_PARTIAL) }
  }
}

/**
 * mpv cannot start before the whole file is present: open-critical is all of it. That is an fMP4 whose open
 * walks every fragment: without sidx FFmpeg scans to EOF (ADR 0004, finding 8), and with a sidx per fragment
 * (`-movflags dash`) its fragment index is complete only at the last one, reading every moof and, with small
 * fragments, every mdat on the way (ADR 0004 §8.2). The UI says it plays after the full download and suggests
 * FASTSTART_REMUX. Also true for a file of a few pieces (the manifest's head and tail cover it).
 */
export function needsFullDownload(index: Pick<MediaIndex, 'fileSize' | 'openCritical'>): boolean {
  return mergeRanges(index.openCritical, index.fileSize).some(([a, b]) => a === 0 && b === index.fileSize)
}

// The remux that makes such a file stream (moov in front, no fragments), and those for the other linear or poorly
// interleaved layouts: remux.ts, re-exported here where callers found FASTSTART_REMUX.
export { FASTSTART_REMUX, remuxCommand, remuxFiles } from './remux.js'

function toState(v: number | undefined): PieceState {
  return v === PIECE_VERIFIED ? PIECE_VERIFIED : v === PIECE_PARTIAL ? PIECE_PARTIAL : PIECE_MISSING
}

/** Merges the smallest gaps until at most `max` ranges remain. */
export function capRanges(ranges: readonly TimeRange[], max: number): TimeRange[] {
  const out = ranges.map(([a, b]): [number, number] => [a, b])
  if (out.length <= max) return out
  const gaps = out.slice(1).map((r, i) => r[0] - (out[i]?.[1] ?? 0))
  const cutoff = [...gaps].sort((x, y) => x - y)[out.length - max - 1] ?? 0
  let budget = out.length - max
  const merged: [number, number][] = []
  out.forEach((r, i) => {
    const prev = merged.at(-1)
    if (prev && i > 0 && budget > 0 && (gaps[i - 1] ?? Infinity) <= cutoff) {
      prev[1] = r[1]
      budget--
    } else merged.push(r)
  })
  return merged
}

/** First index with arr[i] > x. */
function upperBound(arr: Float64Array, x: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((arr[mid] ?? 0) <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBoundPoints(points: readonly KeyPoint[], ms: number): number {
  let lo = 0
  let hi = points.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((points[mid]?.[0] ?? 0) <= ms) lo = mid + 1
    else hi = mid
  }
  return lo
}

// Piecewise-linear lookup over non-decreasing xs, clamped outside the anchors: byte → time maps the
// header bytes before the first keyframe to that keyframe's time.
function interpolate(xs: Float64Array, ys: Float64Array, x: number): number {
  const n = xs.length
  if (n === 0) return 0
  if (x <= (xs[0] ?? 0)) return ys[0] ?? 0
  if (x >= (xs[n - 1] ?? 0)) return ys[n - 1] ?? 0
  const i = upperBound(xs, x) - 1
  const x0 = xs[i] ?? 0
  const x1 = xs[i + 1] ?? x0
  const y0 = ys[i] ?? 0
  const y1 = ys[i + 1] ?? y0
  if (x1 <= x0) return y0
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)
}
