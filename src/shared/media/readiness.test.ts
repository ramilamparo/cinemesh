import { describe, expect, it } from 'vitest'
import { MediaMap, PIECE_VERIFIED } from './media-map.js'
import { readiness, readinessAheadS } from './readiness.js'

const P = 1 << 20

// 100 s, 1 MiB per second, a keyframe every 2 s: piece i holds second i.
const map = new MediaMap({
  fileSize: 100 * P,
  container: 'mp4',
  seekMode: 'index',
  interleave: 'good',
  durationMs: 100_000,
  avgBytesPerSec: P,
  keyframes: Array.from({ length: 50 }, (_, i) => [i * 2000, i * 2 * P] as const),
  pieceLength: P,
})

describe('readiness policy', () => {
  it('picks aheadS: 6 by default, 10 above 6 MB/s, 12 for 60 s after a stall', () => {
    expect(readinessAheadS({ avgBytesPerSec: 1e6, nowMs: 1e6, lastStallAtMs: null })).toBe(6)
    expect(readinessAheadS({ avgBytesPerSec: 7e6, nowMs: 1e6, lastStallAtMs: null })).toBe(10)
    expect(readinessAheadS({ avgBytesPerSec: 7e6, nowMs: 1e6, lastStallAtMs: 1e6 - 59_000 })).toBe(12)
    expect(readinessAheadS({ avgBytesPerSec: 1e6, nowMs: 1e6, lastStallAtMs: 1e6 - 61_000 })).toBe(6)
  })

  it('needs the ready range, two pieces past the position and playback-restart', () => {
    const states = new Uint8Array(100)
    const r0 = readiness(map, 21, 'seek', states, { aheadS: 6, playbackRestarted: false })
    // keyframe at or before 20.75 s (20 s) less 64 KiB of interleave slack .. next keyframe after 27 s
    // (28 s) plus 64 KiB → pieces 19..28
    expect(r0.missing).toEqual([19, 20, 21, 22, 23, 24, 25, 26, 27, 28])
    expect(r0.ready).toBe(false)
    states.fill(PIECE_VERIFIED, 19, 29)
    const r1 = readiness(map, 21, 'seek', states, { aheadS: 6, playbackRestarted: false })
    expect(r1.missing).toEqual([])
    expect(r1.waitingForRestart).toBe(true)
    expect(r1.ready).toBe(false)
    expect(readiness(map, 21, 'seek', states, { aheadS: 6, playbackRestarted: true }).ready).toBe(true)
  })

  it('requires the two pieces past pieceOf(pos) even with aheadS = 0', () => {
    // a keyframe every second, so the ready range (29..31 with the slack) stops short of piece 32
    const everySecond = new MediaMap({
      fileSize: 100 * P,
      container: 'mp4',
      seekMode: 'index',
      interleave: 'good',
      durationMs: 100_000,
      avgBytesPerSec: P,
      keyframes: Array.from({ length: 100 }, (_, i) => [i * 1000, i * P] as const),
      pieceLength: P,
    })
    const states = new Uint8Array(100)
    states.fill(PIECE_VERIFIED, 29, 32)
    const r = readiness(everySecond, 30.5, 'buffering', states, { aheadS: 0, playbackRestarted: true })
    expect(r.missing).toEqual([32])
  })

  it('also requires open-critical ranges when given', () => {
    const states = new Uint8Array(100)
    states.fill(PIECE_VERIFIED, 0, 11)
    const r = readiness(map, 2, 'start', states, {
      aheadS: 6,
      playbackRestarted: true,
      openCritical: [[99 * P, 100 * P]],
    })
    expect(r.missing).toEqual([99])
  })
})
