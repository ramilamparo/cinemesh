import type { Span, TimelineEvent } from '../../shared/ipc/core.js'
import { MAX_TIMELINE_RANGES, type MediaMap, type TimeRange } from '../../shared/media/media-map.js'
import type { OscRanges } from '../player/osc-bridge.js'

/** sync.status carries each member's download coverage as 256 buckets over the duration. */
export const COVERAGE_BUCKETS = 256

const toSpans = (ranges: readonly TimeRange[]): Span[] => ranges.map(([a, b]) => [a, b])

/**
 * Piece states -> seconds, in one place (plan §5.3 "Timeline"): the renderer's `timeline` event and the
 * OSC's `ranges` come from the same computation. The host has everything locally, so its three states come
 * from the viewers' coverage bitmaps: everyone has it (groupDone), someone has it, nobody has it.
 */
export class Timeline {
  constructor(private readonly map: MediaMap) {}

  get durationS(): number {
    return this.map.durationMs / 1000
  }

  forViewer(states: ArrayLike<number>, buffered: Span[]): { event: TimelineEvent; osc: OscRanges } {
    const { done, loading } = this.map.timelineRanges(states, MAX_TIMELINE_RANGES)
    const event: TimelineEvent = { durationS: this.durationS, done: toSpans(done), loading: toSpans(loading), buffered }
    return { event, osc: { dur: this.durationS, done: event.done, loading: event.loading } }
  }

  /** `viewerCoverage`: one bitmap per present viewer (null before its first sync.status). */
  forHost(viewerCoverage: readonly (string | null)[], buffered: Span[]): { event: TimelineEvent; osc: OscRanges } {
    const dur = this.durationS
    const all: Span[] = [[0, dur]]
    if (viewerCoverage.length === 0) {
      // nobody to send to: the OSC shows the host's own copy, the renderer has no groupDone to draw
      return {
        event: { durationS: dur, done: all, loading: [], buffered },
        osc: { dur, done: all, loading: [] },
      }
    }
    const groupDone = intersectCoverage(viewerCoverage, dur)
    // someone has it (or part of the group is still being sent it), but not everyone
    const sending = subtractSpans(unionCoverage(viewerCoverage, dur), groupDone)
    return {
      // the renderer draws groupDone as "downloaded" on the host; done stays the host's own copy
      event: { durationS: dur, done: all, loading: sending, buffered, groupDone },
      osc: { dur, done: groupDone, loading: sending, groupDone },
    }
  }

  /** This member's coverage for sync.status: bucket k is set when [k, k+1)·D/256 is fully downloaded. */
  coverage(states: ArrayLike<number>): string {
    const { done } = this.map.timelineRanges(states, Number.MAX_SAFE_INTEGER)
    return encodeCoverage(done, this.durationS)
  }
}

export function encodeCoverage(done: readonly TimeRange[], durationS: number): string {
  const bits = new Uint8Array(COVERAGE_BUCKETS / 8)
  if (durationS <= 0) return Buffer.from(bits).toString('base64')
  let j = 0
  for (let k = 0; k < COVERAGE_BUCKETS; k++) {
    const b0 = (k * durationS) / COVERAGE_BUCKETS
    const b1 = ((k + 1) * durationS) / COVERAGE_BUCKETS
    while (j < done.length && (done[j]?.[1] ?? 0) < b1 - 1e-6 && (done[j]?.[1] ?? 0) <= b0) j++
    const r = done[j]
    if (r && r[0] <= b0 + 1e-6 && r[1] >= b1 - 1e-6) bits[k >> 3] = (bits[k >> 3] ?? 0) | (128 >> (k & 7))
  }
  return Buffer.from(bits).toString('base64')
}

/** Spans (seconds) every member has: the AND of their bitmaps; a member without coverage yet counts as empty. */
export function intersectCoverage(coverage: readonly (string | null)[], durationS: number): Span[] {
  return combineCoverage(coverage, durationS, 'and')
}

/** Spans (seconds) at least one member has: the OR of their bitmaps. */
export function unionCoverage(coverage: readonly (string | null)[], durationS: number): Span[] {
  return combineCoverage(coverage, durationS, 'or')
}

function combineCoverage(coverage: readonly (string | null)[], durationS: number, op: 'and' | 'or'): Span[] {
  if (durationS <= 0) return []
  const n = COVERAGE_BUCKETS / 8
  const acc = new Uint8Array(n).fill(op === 'and' ? 0xff : 0)
  for (const c of coverage) {
    const bits = c ? Buffer.from(c, 'base64') : Buffer.alloc(n)
    for (let i = 0; i < n; i++) acc[i] = op === 'and' ? (acc[i] ?? 0) & (bits[i] ?? 0) : (acc[i] ?? 0) | (bits[i] ?? 0)
  }
  const spans: Span[] = []
  const step = durationS / COVERAGE_BUCKETS
  for (let k = 0; k < COVERAGE_BUCKETS; k++) {
    if (((acc[k >> 3] ?? 0) & (128 >> (k & 7))) === 0) continue
    const last = spans[spans.length - 1]
    if (last && Math.abs(last[1] - k * step) < 1e-6) last[1] = (k + 1) * step
    else spans.push([k * step, (k + 1) * step])
  }
  return spans
}

/** `a` minus `b`; both sorted, non-overlapping spans (as the coverage helpers return them). */
export function subtractSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = []
  let j = 0
  for (const [s0, e] of a) {
    let s = s0
    while (j < b.length && (b[j]?.[1] ?? 0) <= s) j++
    for (let k = j; k < b.length && s < e; k++) {
      const [bs, be] = b[k] ?? [0, 0]
      if (bs >= e) break
      if (bs > s) out.push([s, bs])
      s = Math.max(s, be)
    }
    if (s < e) out.push([s, e])
  }
  return out
}
