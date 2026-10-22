import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INTERLEAVE_SLACK_BYTES, MediaMap, needsFullDownload } from '../../../src/shared/media/media-map.js'
import type { ByteRange, KeyPoint, SeekMode } from '../../../src/shared/media/types.js'

// S4's golden data (ADR 0004 §5) belongs to 10 min, 2 Mbit/s fixtures with two AAC tracks that cannot be
// regenerated: x264 does not reproduce its own output run to run (ADR 0004, "Applied"). index.test.ts checks
// the rules on our own fixtures instead. Here the golden numbers drive MediaMap directly wherever S4's
// keyframes are exactly the seek points our index stores: MP4 sync-sample offsets and the ffprobe packet
// positions of the AVI index. MKV (Cluster starts) and fMP4 (moof starts) store other seek points.

const GOLDEN = resolve(import.meta.dirname, '../../../spikes/s4-mpv-http/golden')
const AHEAD_MS = 6000

interface Golden {
  size: number
  pieceLength: number
  container: 'mkv' | 'mp4' | 'fmp4' | 'generic'
  seekMode: SeekMode
  durationMs: number
  openCriticalFixed: ByteRange[]
  /** "ms:pos" */
  keyframes: string[]
  readyRange: Record<string, { plan: ByteRange; fixed: ByteRange }>
}

function golden(name: string): Golden {
  return JSON.parse(readFileSync(join(GOLDEN, `${name}.ranges.json`), 'utf8')) as Golden
}

function mapOf(g: Golden): MediaMap {
  return new MediaMap({
    fileSize: g.size,
    container: g.container === 'generic' ? 'avi' : g.container,
    seekMode: g.seekMode,
    interleave: 'good',
    durationMs: g.durationMs,
    avgBytesPerSec: (g.size * 1000) / g.durationMs,
    keyframes: g.keyframes.map((k): KeyPoint => {
      const [ms = NaN, pos = NaN] = k.split(':').map(Number)
      return [ms, pos]
    }),
    pieceLength: g.pieceLength,
  })
}

describe('MediaMap against the S4 golden ranges', () => {
  for (const name of ['mp4-faststart.mp4', 'mp4-tailmoov.mp4', 'avi.avi']) {
    it(`${name}: readyRange starts where mpv 0.41 started reading, at most the slack earlier`, () => {
      const g = golden(name)
      const map = mapOf(g)
      expect(Object.keys(g.readyRange)).toEqual(['0', '20000', '300000'])
      for (const [t, r] of Object.entries(g.readyRange)) {
        const [lo = NaN, hi = NaN] = map.readyRange(Number(t), AHEAD_MS)[0] ?? []
        // fixed.lo is the first byte mpv read (16 KiB gating): the 250 ms preroll and the audio in front
        expect(lo, `lo at ${t}`).toBeLessThanOrEqual(r.fixed[0])
        expect(r.fixed[0] - lo, `lo at ${t}`).toBeLessThanOrEqual(INTERLEAVE_SLACK_BYTES)
        // plan.hi is the video up to the next keyframe after p + 6 s. fixed.hi adds the audio stored behind
        // that keyframe's I-frame (15-17 KB more here), presented within the B-frame delay before it: after
        // p + 6 s unless the keyframe falls within ~80 ms of it (ADR 0004, "Applied").
        expect(hi, `hi at ${t}`).toBe(Math.min(g.size, r.plan[1] + INTERLEAVE_SLACK_BYTES))
      }
    })
  }

  it('fMP4: the whole file is open-critical without sidx, with or without mfra', () => {
    for (const name of ['fmp4-nosidx.mp4', 'fmp4-mfra.mp4']) {
      const g = golden(name)
      expect(g.seekMode).toBe('linear')
      expect(needsFullDownload({ fileSize: g.size, openCritical: g.openCriticalFixed })).toBe(true)
      expect(mapOf(g).readyRange(300_000, AHEAD_MS)[0]?.[0]).toBe(0)
    }
    const sidx = golden('fmp4-sidx.mp4')
    expect(needsFullDownload({ fileSize: sidx.size, openCritical: sidx.openCriticalFixed })).toBe(false)
  })
})
