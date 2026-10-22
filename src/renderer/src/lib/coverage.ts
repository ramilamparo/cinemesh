import type { Span } from '../../../shared/ipc/core'

// PeerView.coverage: 256 buckets over the duration, base64, most significant bit of byte 0 = bucket 0.

export const COVERAGE_BUCKETS = 256

export function decodeCoverage(b64: string | null | undefined): boolean[] | null {
  if (!b64) return null
  let bin: string
  try {
    bin = atob(b64)
  } catch {
    return null
  }
  const bits: boolean[] = []
  for (let i = 0; i < COVERAGE_BUCKETS; i++) {
    const byte = bin.charCodeAt(i >> 3)
    bits.push(!Number.isNaN(byte) && ((byte >> (7 - (i & 7))) & 1) === 1)
  }
  return bits
}

export function encodeCoverage(bits: readonly boolean[]): string {
  const bytes = new Array<number>(COVERAGE_BUCKETS / 8).fill(0)
  bits.forEach((on, i) => {
    if (on && i < COVERAGE_BUCKETS) bytes[i >> 3] = (bytes[i >> 3] ?? 0) | (1 << (7 - (i & 7)))
  })
  return btoa(String.fromCharCode(...bytes))
}

/** Merge consecutive set buckets into [start, end] fractions of the duration (0..1). */
export function coverageRuns(bits: readonly boolean[]): Span[] {
  const runs: Span[] = []
  let start = -1
  bits.forEach((on, i) => {
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      runs.push([start / bits.length, i / bits.length])
      start = -1
    }
  })
  if (start >= 0) runs.push([start / bits.length, 1])
  return runs
}
