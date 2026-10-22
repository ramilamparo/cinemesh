// The plan's R6 scheduler (§4.2), transcribed as literally as possible.
import type { Torrent } from 'webtorrent'

export type Range = [number, number]
export interface Plan {
  p: number
  w: number
  hot?: Range | null
}

/** w = ceil(clamp(25 s of bytes, 2P, 256 MiB) / P) */
export function windowPieces(bitrate: number, pieceLength: number): number {
  const bytes = Math.min(Math.max(25 * bitrate, 2 * pieceLength), 256 * 1024 * 1024)
  return Math.ceil(bytes / pieceLength)
}

/** The plan's group order as ranges: urgent, L1 [p,p+w], L2 [p+w+1,N-1], L3 [0,p-1] (clamped, non-empty). */
export function planRanges(p: number, w: number, n: number, urgent: Range[]): Range[] {
  return [...urgent, [p, p + w] as Range, [p + w + 1, n - 1] as Range, [0, p - 1] as Range]
    .map(([a, b]): Range => [a, Math.min(b, n - 1)])
    .filter(([a, b]) => a <= b)
}

export function planOrder(ranges: Range[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const [a, b] of ranges) {
    for (let i = a; i <= b; i++) {
      if (!seen.has(i)) {
        seen.add(i)
        out.push(i)
      }
    }
  }
  return out
}

export class Scheduler {
  blocked: Range[] = []
  critRanges: Range[] = []
  live: { from: number; to: number }[] = []
  /** true while replan() runs: requests issued then were made against a half-built selection list */
  inReplan = false
  replans = 0
  last: Plan | null = null

  constructor(
    readonly t: Torrent,
    /** experiment only: append a [x, x] stream selection so validateWire() picks the plan head */
    readonly sentinel = false,
    /** experiment only: rebuild t._selections in place and run _updateSelections() once (see report) */
    readonly batched = false,
  ) {}

  replan({ p, w, hot }: Plan): void {
    // all stream selections are ours, all priority 0
    const t = this.t
    const n = t.pieces.length
    this.inReplan = true
    this.replans++
    this.last = { p, w, hot }
    if (!this.batched) for (const s of this.live) t._deselect(s.from, s.to, true) // exact bounds; already gc'd ones are no-ops
    t._critical = [] // upstream never clears critical flags
    const urgent: Range[] = [...this.blocked, ...(hot ? [hot] : []), ...this.critRanges]
    this.live = [...urgent, [p, p + w] as Range, [p + w + 1, n - 1] as Range, [0, p - 1] as Range]
      .map(([a, b]): Range => [a, Math.min(b, n - 1)])
      .filter(([a, b]) => a <= b)
      .map(([from, to]) => ({ from, to }))
    if (this.sentinel) {
      const head = this.firstMissing()
      if (head >= 0) this.live.push({ from: head, to: head })
    }
    if (this.batched) {
      this.applyBatched(urgent)
      this.inReplan = false
      return
    }
    for (const s of this.live) t._select(s.from, s.to, 0, null, true) // insertion order = request order
    for (const [a, b] of urgent) t.critical(a, b)
    this.inReplan = false
  }

  /** The plan as an ordered piece list (deduplicated), for checks and for the Revealer. */
  order(): number[] {
    const seen = new Set<number>()
    const out: number[] = []
    for (const s of this.live) {
      for (let i = s.from; i <= s.to; i++) {
        if (!seen.has(i)) {
          seen.add(i)
          out.push(i)
        }
      }
    }
    return out
  }

  /**
   * Same end state as the _deselect/_select/critical calls, but with one _updateSelections() instead of
   * one per call (each runs _updateInterest over wires x pieces and _update over all wires,
   * torrent.js:1516-1524), and no intermediate selection lists that a wire could request from.
   * Valid only because every selection in the torrent is ours.
   */
  private applyBatched(urgent: Range[]): void {
    const t = this.t as unknown as {
      _selections: { clear(): void; insert(x: object): void }
      _critical: boolean[]
      _updateSelections(): void
    }
    t._selections.clear()
    for (const s of this.live)
      t._selections.insert({ from: s.from, to: s.to, offset: 0, priority: 0, notify: null, isStreamSelection: true })
    for (const [a, b] of urgent) for (let i = a; i <= b; i++) t._critical[i] = true
    t._updateSelections()
  }

  private firstMissing(): number {
    for (const s of this.live) {
      for (let i = s.from; i <= s.to; i++) if (!this.t.bitfield.get(i)) return i
    }
    return -1
  }
}
