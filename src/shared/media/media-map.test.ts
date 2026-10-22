import { describe, expect, it } from 'vitest'
import {
  INTERLEAVE_SLACK_BYTES,
  MediaMap,
  type MediaMapInput,
  PIECE_MISSING,
  PIECE_PARTIAL,
  PIECE_VERIFIED,
  SEEK_PREROLL_MS,
  STREAM_SKIP_BYTES,
  capRanges,
  needsFullDownload,
} from './media-map.js'
import type { ByteRange, KeyPoint } from './types.js'

const P = 1 << 20

// Irregular GOPs (0.5–4 s) and bitrates, with a 300 KB header before the first keyframe and a
// 1 MB index after the last one: the shapes that break naive mappings.
function irregular(): MediaMapInput {
  const keyframes: KeyPoint[] = []
  let t = 0
  let b = 300_000
  let x = 11
  while (t < 600_000) {
    keyframes.push([t, b])
    x = (x * 48271) % 2147483647
    const gop = 500 + (x % 3500)
    t += gop
    b += Math.round(gop * (300 + (x % 2000)))
  }
  const fileSize = b + 1_000_000
  return {
    fileSize,
    container: 'mp4',
    seekMode: 'index',
    interleave: 'good',
    durationMs: 600_000,
    avgBytesPerSec: Math.round((fileSize * 1000) / 600_000),
    keyframes,
    pieceLength: P,
  }
}

function linear(): MediaMapInput {
  return {
    fileSize: 100 * P,
    container: 'generic',
    seekMode: 'linear',
    interleave: 'unknown',
    durationMs: 1_000_000,
    avgBytesPerSec: 0,
    keyframes: [],
    pieceLength: P,
  }
}

function within(r: readonly ByteRange[], a: number, b: number): boolean {
  return r.some(([lo, hi]) => lo <= a && b <= hi)
}

describe('MediaMap', () => {
  const inputs = { irregular: irregular(), linear: linear() }

  for (const [name, input] of Object.entries(inputs)) {
    describe(name, () => {
      const map = new MediaMap(input)
      const D = input.durationMs
      const times = Array.from({ length: 400 }, (_, i) => (i * D) / 399)

      it('timeToByte is monotonic in every mode, keyframe <= interp <= nextKeyframe', () => {
        for (const pick of ['keyframe', 'interp', 'nextKeyframe'] as const) {
          let prev = -1
          for (const t of times) {
            const b = map.timeToByte(t, pick)
            expect(b).toBeGreaterThanOrEqual(prev)
            prev = b
          }
        }
        for (const t of times) {
          expect(map.timeToByte(t, 'keyframe')).toBeLessThanOrEqual(map.timeToByte(t))
          expect(map.timeToByte(t)).toBeLessThanOrEqual(map.timeToByte(t, 'nextKeyframe'))
        }
      })

      it('byteToTime is monotonic and inverts timeToByte within one keyframe interval', () => {
        let prev = -Infinity
        for (let b = 0; b <= input.fileSize; b += Math.ceil(input.fileSize / 997)) {
          const t = map.byteToTime(b)
          expect(t).toBeGreaterThanOrEqual(prev)
          prev = t
        }
        const kts = input.keyframes.map(([t]) => t)
        for (const t of times) {
          const back = map.byteToTime(map.timeToByte(t))
          const i = kts.findIndex((k) => k > t)
          const gop = i > 0 ? (kts[i] ?? D) - (kts[i - 1] ?? 0) : D
          expect(Math.abs(back - t)).toBeLessThanOrEqual(gop + 1)
          expect(map.byteToTime(map.timeToByte(t, 'keyframe'))).toBeLessThanOrEqual(t + 1)
        }
      })

      it('readyRange covers [p, p + N]', () => {
        for (const p of times.slice(0, -1)) {
          for (const n of [0, 6000, 12_000]) {
            const r = map.readyRange(p, n)
            expect(within(r, map.timeToByte(p), Math.min(map.timeToByte(p + n), input.fileSize))).toBe(true)
          }
        }
      })

      it('pieceToTimeSpan contains the time of every byte of the piece', () => {
        for (let b = 0; b < input.fileSize; b += Math.ceil(input.fileSize / 501)) {
          const span = map.pieceToTimeSpan(map.pieceOf(b))
          expect(span).not.toBeNull()
          const t = map.byteToTime(b)
          expect(t).toBeGreaterThanOrEqual((span?.[0] ?? 0) - 1e-6)
          expect(t).toBeLessThanOrEqual((span?.[1] ?? 0) + 1e-6)
        }
        expect(map.pieceToTimeSpan(map.lastPiece + 1)).toBeNull()
      })

      it('timelineSpans tile [0, D] and merge equal neighbours', () => {
        const n = map.lastPiece + 1
        const states = Uint8Array.from({ length: n }, (_, i) => (i < n / 3 ? 2 : i < n / 2 ? 1 : i % 7 === 0 ? 2 : 0))
        const spans = map.timelineSpans(states)
        expect(spans[0]?.[0]).toBe(0)
        expect(spans.at(-1)?.[1]).toBeCloseTo(D / 1000, 6)
        for (let i = 1; i < spans.length; i++) {
          expect(spans[i]?.[0]).toBe(spans[i - 1]?.[1])
          expect(spans[i]?.[2]).not.toBe(spans[i - 1]?.[2])
        }
        const all = map.timelineSpans(new Uint8Array(n).fill(PIECE_VERIFIED))
        expect(all).toEqual([[0, D / 1000, PIECE_VERIFIED]])
      })
    })
  }

  // ADR 0004 §5: where mpv starts reading, per container
  it('readyRange starts 2 s early for MKV, at the Cluster, and ends at the next keyframe', () => {
    const mkv = new MediaMap({ ...irregular(), container: 'mkv' })
    const p = 300_000
    expect(mkv.prerollMs).toBe(2000)
    expect(mkv.readyRange(p, 6000)[0]).toEqual([
      mkv.timeToByte(p - 2000, 'keyframe'),
      mkv.timeToByte(p + 6000, 'nextKeyframe'),
    ])
    expect(new MediaMap({ ...irregular(), container: 'webm' }).slackBytes).toBe(0)
  })

  it('readyRange starts 250 ms back less 64 KiB elsewhere, and ends 64 KiB past the next keyframe', () => {
    const map = new MediaMap(irregular())
    expect(map.prerollMs).toBe(SEEK_PREROLL_MS)
    expect(map.slackBytes).toBe(INTERLEAVE_SLACK_BYTES)
    for (const p of [300_000, 123_456]) {
      expect(map.readyRange(p, 6000)[0]).toEqual([
        map.timeToByte(p - 250, 'keyframe') - INTERLEAVE_SLACK_BYTES,
        map.timeToByte(p + 6000, 'nextKeyframe') + INTERLEAVE_SLACK_BYTES,
      ])
    }
    // exactly on a keyframe, lavf's dts-based backward seek takes the previous GOP (finding 6)
    const [k1, k2] = [irregular().keyframes[40], irregular().keyframes[41]]
    if (!k1 || !k2) throw new Error('fixture too short')
    expect(map.seekByte(k2[0])).toBe(k1[1] - INTERLEAVE_SLACK_BYTES)
    expect(map.seekByte(k2[0] + 250)).toBe(k2[1] - INTERLEAVE_SLACK_BYTES)
    for (const c of ['mov', 'avi'] as const) {
      expect(new MediaMap({ ...irregular(), container: c }).seekByte(k2[0] + 250)).toBe(k2[1] - INTERLEAVE_SLACK_BYTES)
    }
  })

  it('fMP4 starts one fragment earlier: the audio before a keyframe ends the previous fragment', () => {
    const map = new MediaMap({ ...irregular(), container: 'fmp4' })
    const kfs = irregular().keyframes
    const [k0, , k2] = [kfs[40], kfs[41], kfs[42]]
    if (!k0 || !k2) throw new Error('fixture too short')
    expect(map.seekByte(k2[0])).toBe(k0[1] - INTERLEAVE_SLACK_BYTES)
    expect(map.readyRange(k2[0], 6000)[0]?.[0]).toBe(k0[1] - INTERLEAVE_SLACK_BYTES)
  })

  it('reads on from the open-critical head to a start at most STREAM_SKIP_BYTES past it', () => {
    const base = irregular()
    const H = 2_000_000
    const plain = new MediaMap(base)
    const map = new MediaMap({
      ...base,
      openCritical: [
        [base.fileSize - 1000, base.fileSize],
        [0, H],
      ],
    })
    expect(map.headEnd).toBe(H)
    expect(plain.headEnd).toBeNull()
    let readOn = 0
    for (let p = 0; p < base.durationMs; p += 250) {
      const own = plain.seekByte(p)
      const near = own > H && own - H <= STREAM_SKIP_BYTES
      if (near) readOn++
      expect(map.seekByte(p), `p=${String(p)}`).toBe(near ? H : own)
      expect(map.readyRange(p, 6000)[0]?.[0]).toBe(Math.min(near ? H : own, map.timeToByte(p)))
    }
    expect(readOn).toBeGreaterThan(5)
    // a head range that does not start at 0 is no anchor (the open's first read is at 0)
    expect(new MediaMap({ ...base, openCritical: [[64, H]] }).headEnd).toBeNull()
  })

  it('clamps the ready range to the file and starts at 0 when linear', () => {
    const base = irregular()
    const map = new MediaMap({ ...base, keyframes: [[0, 1000], ...base.keyframes.slice(1)] })
    expect(map.readyRange(0, 6000)[0]?.[0]).toBe(0)
    expect(map.readyRange(base.durationMs - 1000, 6000).at(-1)?.[1]).toBe(base.fileSize)
    expect(new MediaMap({ ...base, seekMode: 'linear' }).readyRange(300_000, 6000)[0]?.[0]).toBe(0)
  })

  it('needsFullDownload: open-critical covering the whole file (an fMP4 whose open walks every fragment)', () => {
    expect(needsFullDownload({ fileSize: 1000, openCritical: [[0, 1000]] })).toBe(true)
    expect(
      needsFullDownload({
        fileSize: 1000,
        openCritical: [
          [0, 600],
          [600, 1000],
        ],
      }),
    ).toBe(true)
    expect(
      needsFullDownload({
        fileSize: 1000,
        openCritical: [
          [0, 600],
          [984, 1000],
        ],
      }),
    ).toBe(false)
    expect(needsFullDownload({ fileSize: 0, openCritical: [] })).toBe(false)
  })

  it('adds the audio intervals of poorly interleaved files', () => {
    const base = irregular()
    const audioAt = base.fileSize - 20_000_000
    const map = new MediaMap({
      ...base,
      interleave: 'poor',
      audioIndexes: [
        {
          trackId: 2,
          points: Array.from({ length: 600 }, (_, i): KeyPoint => [i * 1000, audioAt + i * 20_000]),
        },
      ],
    })
    const r = map.readyRange(100_000, 6000)
    expect(r.length).toBe(2)
    expect(within(r, audioAt + 100 * 20_000, audioAt + 106 * 20_000)).toBe(true)
    expect(new MediaMap(base).audioRanges(0, 1000)).toEqual([])
  })

  it('maps pieces through the file offset inside the torrent', () => {
    const map = new MediaMap(linear(), { fileOffset: 3 * P + 10 })
    expect(map.firstPiece).toBe(3)
    expect(map.pieceOf(0)).toBe(3)
    expect(map.pieceOf(P - 11)).toBe(3)
    expect(map.pieceOf(P - 10)).toBe(4)
    expect(map.lastPiece).toBe(map.pieceOf(100 * P - 1))
  })

  it('linear maps follow byte = size × t / D', () => {
    const map = new MediaMap(linear())
    expect(map.timeToByte(250_000)).toBe(25 * P)
    expect(map.byteToTime(50 * P)).toBe(500_000)
    expect(map.needBps()).toBeCloseTo((100 * P) / 1000, 6)
  })

  it('bufferedAheadS counts verified pieces from the position', () => {
    const map = new MediaMap(linear())
    const states = new Uint8Array(100)
    expect(map.bufferedAheadS(100, states)).toBe(0)
    states.fill(PIECE_VERIFIED, 10, 20)
    expect(map.bufferedAheadS(100, states)).toBeCloseTo(100, 6)
    expect(map.bufferedAheadS(150, states)).toBeCloseTo(50, 6)
    states.fill(PIECE_VERIFIED)
    expect(map.bufferedAheadS(990, states)).toBeCloseTo(10, 6)
  })

  it('timelineRanges splits done from loading and caps the count', () => {
    const map = new MediaMap(linear())
    const states = Uint8Array.from({ length: 100 }, (_, i) =>
      i % 2 ? PIECE_VERIFIED : i % 4 ? PIECE_PARTIAL : PIECE_MISSING,
    )
    const { done, loading } = map.timelineRanges(states, 10)
    expect(done.length).toBe(10)
    expect(loading.length).toBe(10)
    expect(done[0]?.[0]).toBeCloseTo(10, 6)
    expect(done.at(-1)?.[1]).toBeCloseTo(1000, 6)
  })

  it('capRanges merges the smallest gaps first', () => {
    expect(
      capRanges(
        [
          [0, 1],
          [1.1, 2],
          [5, 6],
          [6.5, 7],
        ],
        2,
      ),
    ).toEqual([
      [0, 2],
      [5, 7],
    ])
  })
})
