import type { Torrent } from 'webtorrent'

/** Byte range [start, end) in torrent coordinates. */
export type ByteRange = readonly [start: number, end: number]
/** Piece range [from, to], both inclusive. */
export type PieceRange = readonly [from: number, to: number]

export interface PlayheadPlan {
  /** torrent byte at (or just before) the playback position */
  byte: number
  /** L1: ~25 s of bytes after the playhead, clamped to [2P, 256 MiB] by the media adapter */
  windowBytes: number
  /** hot window: ~8 s after a seek target, flagged critical */
  hotBytes: number
  seek: boolean
  /** audio intervals of poorly interleaved files over the hot window (media Playhead); urgent like group 3 */
  urgent?: readonly ByteRange[]
}

const DEBOUNCE_MS = 100

/**
 * Byte ranges as piece spans: sorted, with overlapping or adjacent spans merged, so a manifest with
 * thousands of sidx ranges inside a few pieces becomes a few selections (each selection costs WebTorrent a
 * pass per wire on every update). Out-of-range bytes clamp to the first or last piece.
 */
export function toPieceSpans(ranges: readonly ByteRange[], pieceLength: number, pieceCount: number): PieceRange[] {
  const pieceOf = (byte: number): number => Math.min(pieceCount - 1, Math.max(0, Math.floor(byte / pieceLength)))
  return mergeSpans(ranges.filter(([a, b]) => b > a).map(([a, b]) => [pieceOf(a), pieceOf(b - 1)] as const))
}

/** Sorted, with overlapping or adjacent spans merged. */
export function mergeSpans(spans: readonly PieceRange[]): PieceRange[] {
  const out: [number, number][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/** A plan applied to the pieces. */
export interface PlayheadPieces {
  p: number
  /** L1 length in pieces */
  w: number
  /** the hot window of the last seek */
  hot: PieceRange | null
  /** the plan's audio intervals (group 3), as merged spans */
  urgent: PieceRange[]
}

/**
 * How a plan moves the playhead: a seek installs the hot window, which stays until the next seek; a tick that
 * moved less than a quarter of L1 forward changes nothing (null), so the order is not rebuilt for it.
 */
export function applyPlayhead(
  prev: PlayheadPieces | null,
  plan: PlayheadPlan,
  pieceLength: number,
  pieceCount: number,
): PlayheadPieces | null {
  const pieceOf = (byte: number): number => Math.min(pieceCount - 1, Math.max(0, Math.floor(byte / pieceLength)))
  const p = pieceOf(plan.byte)
  const w = Math.max(1, Math.ceil(plan.windowBytes / pieceLength))
  if (!plan.seek && prev && p >= prev.p && p - prev.p < Math.max(1, Math.floor(prev.w / 4))) return null
  const hot: PieceRange | null = plan.seek
    ? [p, pieceOf(plan.byte + Math.max(plan.hotBytes, 1) - 1)]
    : (prev?.hot ?? null)
  return { p, w, hot, urgent: toPieceSpans(plan.urgent ?? [], pieceLength, pieceCount) }
}

/**
 * The R6 order as piece ranges, first to last (plan §4.2): blocked pieces, the hot window, group 3 (critical
 * ranges and the plan's audio intervals, merged), L1 [p, p+w], L2 [p+w+1, N-1], L3 [0, p-1]; clamped, empty ones
 * dropped. `urgent` (groups 1-3) is what is flagged critical. The host's Revealer walks the same order.
 */
export function orderRanges(
  pieceCount: number,
  o: { blocked: readonly number[]; playhead: PlayheadPieces | null; critical: readonly PieceRange[] },
): { ranges: PieceRange[]; urgent: PieceRange[] } {
  const n = pieceCount
  const urgent: PieceRange[] = o.blocked.map((i) => [i, i] as const)
  if (o.playhead?.hot) urgent.push(o.playhead.hot)
  urgent.push(...mergeSpans([...o.critical, ...(o.playhead?.urgent ?? [])]))
  const base: PieceRange[] = []
  if (o.playhead) {
    const { p, w } = o.playhead
    base.push([p, p + w], [p + w + 1, n - 1], [0, p - 1])
  } else {
    base.push([0, n - 1])
  }
  const fit = (ranges: PieceRange[]): PieceRange[] =>
    ranges.map(([a, b]) => [Math.max(0, a), Math.min(b, n - 1)] as const).filter(([a, b]) => a <= b)
  return { ranges: fit([...urgent, ...base]), urgent: fit(urgent) }
}

/**
 * R6 download order (plan §4.2). WebTorrent facts this relies on (torrent.js:1236-1287, 1715-1790):
 * selections with priority > 0 are rotated by shufflePriority after each use, so only priority-0
 * selections keep a stable order, served in insertion order and sequentially inside each one;
 * _deselect(from, to, true) removes the first stream selection with exactly those bounds.
 * So every selection here is a stream selection we own, at priority 0, rebuilt in strict order:
 *   1. pieces an HTTP reader is blocked on      (critical)
 *   2. the hot window after a seek              (critical)
 *   3. open-/seek-critical ranges, subtitles,   (critical)
 *      audio intervals of poorly interleaved files
 *   4. L1 [p, p+w]   5. L2 [p+w+1, N-1]   6. L3 [0, p-1] (wrap)
 * Group 3 is one class: its ranges are merged into sorted piece spans (toPieceSpans).
 * The viewer's torrent must be added with `deselect: true` and nothing may call select() or
 * file.createReadStream() (its FileIterator would add its own priority-1 selection). A fresh wire's first
 * request is the head of this order only with patches/webtorrent+3.0.21.patch (validateWire walks forwards).
 */
export class Scheduler {
  private readonly t: Torrent
  private readonly pieceLength: number
  private readonly pieceCount: number
  private live: { from: number; to: number }[] = []
  private readonly blocked = new Map<string, number>()
  private critical: PieceRange[] = []
  private playhead: PlayheadPieces | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private paused = false
  private destroyed = false
  /** called when the set of blocked readers changed (the engine reports blockedPieces() to the host) */
  private readonly onBlocked: () => void

  constructor(torrent: Torrent, opts: { onBlocked?: () => void } = {}) {
    this.t = torrent
    this.pieceLength = torrent.pieceLength
    this.pieceCount = torrent.pieces.length
    this.onBlocked = opts.onBlocked ?? (() => undefined)
  }

  setPlayhead(plan: PlayheadPlan): void {
    const next = applyPlayhead(this.playhead, plan, this.pieceLength, this.pieceCount)
    if (!next) return // ticks only matter once the playhead moved a quarter of the window
    this.playhead = next
    if (plan.seek) this.replan()
    else this.schedule()
  }

  /** Open-/seek-critical ranges, external subtitles and urgent audio intervals, in torrent bytes. */
  setCriticalRanges(ranges: readonly ByteRange[]): void {
    this.critical = toPieceSpans(ranges, this.pieceLength, this.pieceCount)
    this.schedule()
  }

  /** An HTTP reader waits on this piece: request it before anything else, now. */
  addBlocked(key: string, piece: number): void {
    if (piece < 0 || piece >= this.pieceCount || this.blocked.get(key) === piece) return
    this.blocked.set(key, piece)
    this.replan()
    this.onBlocked()
  }

  dropBlocked(key: string): void {
    if (!this.blocked.delete(key)) return
    this.schedule()
    this.onBlocked()
  }

  /**
   * The pieces HTTP readers are blocked on and that are not verified yet: ascending, each once. With striping,
   * the host has to be told (setViewerUrgent): it shows a viewer only what it revealed to it.
   */
  blockedPieces(): number[] {
    const out = new Set<number>()
    for (const i of this.blocked.values()) if (this.t.pieces[i] !== null) out.add(i)
    return [...out].sort((a, b) => a - b)
  }

  /** Disk full: stop asking for anything new (seeding continues). */
  pause(): void {
    this.paused = true
    this.replan()
  }

  resume(): void {
    this.paused = false
    this.replan()
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** The current request order as piece ranges, for diagnostics and tests. */
  plan(): readonly { from: number; to: number }[] {
    return this.live
  }

  private schedule(): void {
    if (this.timer || this.destroyed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.replan()
    }, DEBOUNCE_MS)
  }

  private replan(): void {
    if (this.destroyed || this.t.destroyed) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const t = this.t
    const n = this.pieceCount
    // One rebuild and one _updateSelections() instead of one per _deselect/_select/critical call. Each of those
    // runs _updateInterest (wires x pieces) and _update over every wire synchronously (torrent.js:1516-1524), so a
    // wire with a free pipeline could request from a half-built list. S3: 11.5 ms -> 0.8 ms at 15k pieces x 32 wires.
    // Valid only because every selection is ours (deselect: true, never select() or createReadStream()).
    t._selections.clear()
    t._critical = [] // upstream never clears critical flags
    this.live = []
    if (this.paused) {
      t._updateSelections()
      return
    }

    const { ranges, urgent } = orderRanges(n, {
      blocked: [...this.blocked.values()],
      playhead: this.playhead,
      critical: this.critical,
    })
    this.live = ranges.map(([from, to]) => ({ from, to }))
    for (const { from, to } of this.live) {
      // insertion order = request order (priority 0 is never shuffled, torrent.js:1764/1779)
      t._selections.insert({ from, to, offset: 0, priority: 0, notify: null, isStreamSelection: true })
    }
    for (const [a, b] of urgent) for (let i = a; i <= b; i++) t._critical[i] = true
    t._updateSelections()
  }
}
