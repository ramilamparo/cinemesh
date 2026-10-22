import { type ByteRange, KEYFRAME_MIN_GAP_MS, type KeyPoint } from './types.js'

/** Sorts, clips to [0, size) and merges overlapping or touching ranges; drops empty ones. */
export function mergeRanges(ranges: readonly ByteRange[], size = Number.MAX_SAFE_INTEGER): ByteRange[] {
  const clipped = ranges
    .map(([a, b]): ByteRange => [Math.max(0, a), Math.min(size, b)])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0])
  const out: [number, number][] = []
  for (const [a, b] of clipped) {
    const last = out.at(-1)
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

/**
 * Normalises seek points for MediaMap: sorted by time, strictly increasing times, non-decreasing bytes
 * (a point whose byte goes backwards cannot be mapped both ways and is dropped), and at least
 * `minGapMs` apart (all-intra files would otherwise list every frame).
 */
export function thinKeyPoints(points: readonly KeyPoint[], minGapMs = KEYFRAME_MIN_GAP_MS): KeyPoint[] {
  const sorted = [...points].filter(([t, b]) => Number.isFinite(t) && Number.isFinite(b) && b >= 0)
  sorted.sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const out: KeyPoint[] = []
  for (const [t, b] of sorted) {
    const ms = Math.round(t)
    const last = out.at(-1)
    if (last && (ms < last[0] + minGapMs || b < last[1])) continue
    out.push([ms, b])
  }
  return out
}
