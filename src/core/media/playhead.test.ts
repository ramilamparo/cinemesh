import { describe, expect, it } from 'vitest'
import { INTERLEAVE_SLACK_BYTES, MediaMap, type MediaMapInput } from '../../shared/media/media-map.js'
import type { KeyPoint } from '../../shared/media/types.js'
import { MAX_WINDOW_BYTES, Playhead, type PlayheadPlan, planPlayhead } from './playhead.js'

const P = 1 << 20

function input(bytesPerSec: number, over: Partial<MediaMapInput> = {}): MediaMapInput {
  return {
    fileSize: 600 * bytesPerSec,
    container: 'mp4',
    seekMode: 'index',
    interleave: 'good',
    durationMs: 600_000,
    avgBytesPerSec: bytesPerSec,
    keyframes: Array.from({ length: 300 }, (_, i): KeyPoint => [i * 2000, i * 2 * bytesPerSec]),
    pieceLength: P,
    ...over,
  }
}

describe('playhead adapter', () => {
  it('starts where mpv reads (MediaMap.seekByte) and sizes the windows from 25 s and 8 s of bytes', () => {
    const map = new MediaMap(input(1_000_000))
    const plan = planPlayhead(map, 101, 'seek')
    // the keyframe at or before 100.75 s, less the interleaved audio stored in front of it
    const byte = 100 * 1_000_000 - INTERLEAVE_SLACK_BYTES
    expect(plan.byte).toBe(byte)
    expect(plan.byte).toBe(map.seekByte(101_000))
    expect(plan.windowBytes).toBe(126 * 1_000_000 - byte)
    expect(plan.hotBytes).toBe(109 * 1_000_000 - byte)
    expect(plan.seek).toBe(true)
    expect(plan.urgent).toEqual([])
    // exactly on a keyframe, lavf reads the previous GOP (ADR 0004, finding 6)
    expect(planPlayhead(map, 100, 'seek').byte).toBe(98 * 1_000_000 - INTERLEAVE_SLACK_BYTES)
  })

  it('backs up 2 s for the MKV subtitle preroll', () => {
    const map = new MediaMap(input(1_000_000, { container: 'mkv' }))
    expect(planPlayhead(map, 101, 'tick').byte).toBe(98 * 1_000_000)
  })

  it('clamps the window to [2P, 256 MiB]', () => {
    expect(planPlayhead(new MediaMap(input(10_000)), 50, 'play').windowBytes).toBe(2 * P)
    expect(planPlayhead(new MediaMap(input(40_000_000)), 50, 'play').windowBytes).toBe(MAX_WINDOW_BYTES)
  })

  it('flags seeks, joins and catch-ups but not ticks or play', () => {
    const map = new MediaMap(input(1_000_000))
    expect(planPlayhead(map, 1, 'join').seek).toBe(true)
    expect(planPlayhead(map, 1, 'catchup').seek).toBe(true)
    expect(planPlayhead(map, 1, 'tick').seek).toBe(false)
    expect(planPlayhead(map, 1, 'play').seek).toBe(false)
  })

  it('turns the audio of poorly interleaved files into urgent ranges', () => {
    const audioAt = 500_000_000
    const map = new MediaMap(
      input(1_000_000, {
        interleave: 'poor',
        audioIndexes: [
          { trackId: 2, points: Array.from({ length: 600 }, (_, i): KeyPoint => [i * 1000, audioAt + i * 16_000]) },
        ],
      }),
    )
    const plan = planPlayhead(map, 100, 'seek')
    // from 250 ms before the position (the preroll reaches into second 99) to 8 s after it
    expect(plan.urgent).toEqual([[audioAt + 99 * 16_000, audioAt + 109 * 16_000]])
  })

  it('forwards every plan to the scheduler', () => {
    const seen: PlayheadPlan[] = []
    const ph = new Playhead(new MediaMap(input(1_000_000)), { setPlayhead: (p) => seen.push(p) })
    ph.set(10, 'seek')
    ph.set(11, 'tick')
    expect(seen.map((p) => [p.posS, p.reason])).toEqual([
      [10, 'seek'],
      [11, 'tick'],
    ])
    expect(ph.last?.posS).toBe(11)
  })
})
