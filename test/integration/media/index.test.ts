import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MEDIA_CACHE_FILE, buildMediaIndex, indexMediaFile } from '../../../src/core/media/build-index.js'
import { HEAD_MARGIN_MIN } from '../../../src/core/media/margins.js'
import { buildManifest } from '../../../src/shared/media/manifest.js'
import { INTERLEAVE_SLACK_BYTES, MediaMap, needsFullDownload } from '../../../src/shared/media/media-map.js'
import { mergeRanges } from '../../../src/shared/media/ranges.js'
import type { ByteRange, MediaIndex } from '../../../src/shared/media/types.js'
import { FIXTURES, type FixtureName, HAVE_FFMPEG, fixture, goldenKeyframes, tailInfo } from './fixtures.js'
import { type RuleKind, probePackets, riffChunk, s4PlayEnd, s4ReadStart, seekKeyframe, topBoxes } from './s4-rules.js'

const indexes = new Map<FixtureName, MediaIndex>()
const paths = new Map<FixtureName, string>()

function covered(ranges: readonly ByteRange[], a: number, b: number): boolean {
  return mergeRanges(ranges).some(([lo, hi]) => lo <= a && b <= hi)
}

/** Lowest byte position of any packet: everything before it is container header. */
function firstPacketPos(path: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=pos', '-of', 'csv=p=0', path], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return Math.min(
    ...out
      .split('\n')
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0),
  )
}

describe.skipIf(!HAVE_FFMPEG)('media index on ffmpeg fixtures', () => {
  beforeAll(async () => {
    for (const name of FIXTURES) {
      const path = await fixture(name)
      paths.set(name, path)
      indexes.set(name, await indexMediaFile(path))
    }
  }, 300_000)

  const get = (name: FixtureName) => {
    const index = indexes.get(name)
    const path = paths.get(name)
    if (!index || !path) throw new Error(`no index for ${name}`)
    return { index, path }
  }

  describe('keyframe index matches ffprobe -show_packets', () => {
    // MP4 sync samples and ffprobe's keyframes are the same packets: offsets match exactly.
    for (const name of ['mp4-faststart.mp4', 'mp4-tailmoov.mp4', 'avi.avi'] as const) {
      it(name, () => {
        const { index, path } = get(name)
        const golden = goldenKeyframes(path)
        expect(golden.length).toBeGreaterThan(20)
        expect(index.keyframes.map(([, b]) => b)).toEqual(golden.map((g) => g.pos))
        index.keyframes.forEach(([t], i) => expect(Math.abs(t - (golden[i]?.ms ?? NaN))).toBeLessThanOrEqual(1))
      })
    }

    // MKV seek points are Cluster starts and fMP4 ones moof starts (or the sidx boxes in front of a fragment the
    // sidx index references): the keyframe packet lies inside.
    for (const name of [
      'mkv-cues.mkv',
      'mkv-nocues.mkv',
      'mkv-tail.mkv',
      'fmp4-sidx.mp4',
      'fmp4-nosidx.mp4',
      'fmp4-mfra.mp4',
      'fmp4-dash.mp4',
      'fmp4-dash-global.mp4',
    ] as const) {
      it(name, () => {
        const { index, path } = get(name)
        const golden = goldenKeyframes(path)
        expect(index.keyframes.length).toBe(golden.length)
        index.keyframes.forEach(([t, b], i) => {
          const g = golden[i]
          if (!g) throw new Error('missing golden keyframe')
          expect(Math.abs(t - g.ms)).toBeLessThanOrEqual(1)
          expect(b).toBeLessThanOrEqual(g.pos)
          expect(g.pos).toBeLessThan(index.keyframes[i + 1]?.[1] ?? index.fileSize)
        })
      })
    }
  })

  it('reports seek modes, durations and tracks', () => {
    const modes = Object.fromEntries(FIXTURES.map((n) => [n, get(n).index.seekMode]))
    expect(modes).toEqual({
      'mkv-cues.mkv': 'index',
      'mkv-nocues.mkv': 'linear',
      'mkv-tail.mkv': 'index',
      'mp4-faststart.mp4': 'index',
      'mp4-tailmoov.mp4': 'index',
      'fmp4-sidx.mp4': 'index',
      'fmp4-nosidx.mp4': 'linear',
      // an mfra no longer makes it 'index': FFmpeg scans the fragments to EOF anyway (ADR 0004, finding 8)
      'fmp4-mfra.mp4': 'linear',
      // a sidx per fragment: FFmpeg walks the fragments at open up to the last one (ADR 0004 §8.2)
      'fmp4-dash.mp4': 'linear',
      'fmp4-dash-global.mp4': 'index',
      'avi.avi': 'index',
    })
    for (const n of FIXTURES) {
      const { index } = get(n)
      expect(Math.abs(index.durationMs - 30_000)).toBeLessThan(300)
      expect(index.tracks.filter((t) => t.type === 'video').length).toBe(1)
      expect(index.tracks.filter((t) => t.type === 'audio').length).toBe(1)
      expect(index.interleave).not.toBe('poor')
    }
    const tail = get('mkv-tail.mkv').index
    expect(tail.tracks.find((t) => t.type === 'subtitle')).toMatchObject({ codec: 'S_TEXT/ASS', lang: 'eng' })
    expect(get('mkv-cues.mkv').index.tracks.find((t) => t.type === 'audio')?.lang).toBe('eng')
  })

  describe('open-critical ranges contain every header byte', () => {
    for (const name of ['mkv-cues.mkv', 'mkv-nocues.mkv', 'mkv-tail.mkv', 'avi.avi'] as const) {
      it(`${name}: everything before the first packet`, () => {
        const { index, path } = get(name)
        expect(covered(index.openCritical, 0, firstPacketPos(path))).toBe(true)
      })
    }

    it('mkv-tail.mkv: Tags and Attachments moved after the clusters', async () => {
      const { index } = get('mkv-tail.mkv')
      const { moved } = await tailInfo()
      expect(moved.length).toBe(2)
      for (const [a, b] of moved) expect(covered(index.openCritical, a, b)).toBe(true)
    })

    it('MKV Cues are seek-critical', () => {
      for (const name of ['mkv-cues.mkv', 'mkv-tail.mkv'] as const) {
        const { index } = get(name)
        expect(index.seekCritical.length).toBe(1)
        const [a = 0, b = 0] = index.seekCritical[0] ?? []
        expect(b - a).toBeGreaterThan(100)
      }
      expect(get('mkv-nocues.mkv').index.seekCritical).toEqual([])
    })

    it('MP4: ftyp and moov, and the box headers before a tail moov', () => {
      for (const name of ['mp4-faststart.mp4', 'mp4-tailmoov.mp4'] as const) {
        const { index, path } = get(name)
        const boxes = topBoxes(path)
        const moov = boxes.find((b) => b.type === 'moov')
        const ftyp = boxes.find((b) => b.type === 'ftyp')
        if (!moov || !ftyp) throw new Error('fixture without moov')
        expect(covered(index.openCritical, ftyp.pos, ftyp.end)).toBe(true)
        expect(covered(index.openCritical, moov.pos, moov.end)).toBe(true)
        for (const b of boxes.filter((x) => x.pos < moov.pos)) {
          expect(covered(index.openCritical, b.pos, b.pos + 16)).toBe(true)
        }
      }
      const tail = get('mp4-tailmoov.mp4').index
      const mdat = topBoxes(get('mp4-tailmoov.mp4').path).find((b) => b.type === 'mdat')
      // the head of mdat (probed at open) is critical, the rest of it is not
      const at = mdat?.pos ?? 0
      expect(covered(tail.openCritical, at, at + HEAD_MARGIN_MIN)).toBe(true)
      expect(covered(tail.openCritical, at + 1.5 * HEAD_MARGIN_MIN, at + 1.5 * HEAD_MARGIN_MIN + 1)).toBe(false)
    })

    it('fMP4: moov, the sidx boxes in front and the first moof + mdat', () => {
      for (const name of ['fmp4-sidx.mp4', 'fmp4-nosidx.mp4', 'fmp4-mfra.mp4'] as const) {
        const { index, path } = get(name)
        const boxes = topBoxes(path)
        for (const b of boxes.filter((x) => x.type === 'moov' || x.type === 'sidx' || x.type === 'ftyp')) {
          expect(covered(index.openCritical, b.pos, b.end)).toBe(true)
        }
        const firstMoof = boxes.findIndex((b) => b.type === 'moof')
        const moof = boxes[firstMoof]
        const mdat = boxes[firstMoof + 1]
        expect(covered(index.openCritical, moof?.pos ?? -1, mdat?.end ?? Infinity)).toBe(true)
      }
      expect(topBoxes(get('fmp4-sidx.mp4').path).filter((b) => b.type === 'sidx').length).toBeGreaterThan(0)
    })

    // ADR 0004 §5: FFmpeg also reads ftyp and the last 4 bytes (the mfro size) at open
    it('fMP4 with sidx: [0, moovEnd), every sidx, the first moof + mdat and [size − 16, size)', () => {
      const { index, path } = get('fmp4-sidx.mp4')
      const boxes = topBoxes(path)
      const moov = boxes.find((b) => b.type === 'moov')
      expect(covered(index.openCritical, 0, moov?.end ?? Infinity)).toBe(true)
      expect(covered(index.openCritical, index.fileSize - 16, index.fileSize)).toBe(true)
      expect(index.seekMode).toBe('index')
      expect(needsFullDownload(index)).toBe(false)
    })

    it('fMP4 without sidx, with or without an mfra: the whole file (FFmpeg scans every box at open)', () => {
      for (const name of ['fmp4-nosidx.mp4', 'fmp4-mfra.mp4'] as const) {
        const { index } = get(name)
        expect(index.openCritical).toEqual([[0, index.fileSize]])
        expect(needsFullDownload(index)).toBe(true)
      }
      expect(topBoxes(get('fmp4-mfra.mp4').path).some((b) => b.type === 'mfra')).toBe(true)
      expect(topBoxes(get('fmp4-nosidx.mp4').path).some((b) => b.type === 'mfra')).toBe(false)
    })

    // ADR 0004 §8.2: FFmpeg's open reads boxes until its fragment index is complete, which only a sidx with
    // first_offset 0 reaching the mfra (or EOF) makes it: with a sidx per fragment, the last fragment's.
    it('fMP4 with a sidx per fragment: the whole file (the open walks every fragment to the last sidx)', () => {
      const { index, path } = get('fmp4-dash.mp4')
      const boxes = topBoxes(path)
      const firstMdat = boxes.findIndex((b) => b.type === 'mdat')
      expect(boxes.slice(firstMdat).filter((b) => b.type === 'sidx').length).toBeGreaterThan(20)
      expect(index.openCritical).toEqual([[0, index.fileSize]])
      expect(index.seekMode).toBe('linear')
      expect(needsFullDownload(index)).toBe(true)
    })

    it('fMP4 with a sidx index in front of per-fragment sidx boxes: those behind the first mdat are not critical', () => {
      const { index, path } = get('fmp4-dash-global.mp4')
      const boxes = topBoxes(path)
      const firstMdat = boxes.findIndex((b) => b.type === 'mdat')
      // everything the open reads: ftyp, moov, the index, the first fragment's sidx boxes and moof
      for (const b of boxes.slice(0, firstMdat + 1)) expect(covered(index.openCritical, b.pos, b.end)).toBe(true)
      expect(covered(index.openCritical, index.fileSize - 16, index.fileSize)).toBe(true)
      // that head (with the margin after the first fragment) and the tail, nothing else: a sidx further on is read
      // only by a seek to its fragment, from where that fragment's reference (and readyRange) starts
      const [head, tail, ...rest] = mergeRanges(index.openCritical)
      expect(rest).toEqual([])
      expect(tail?.[1]).toBe(index.fileSize)
      const later = boxes.filter((b) => b.type === 'sidx' && b.pos >= (head?.[1] ?? Infinity))
      expect(later.length).toBeGreaterThan(10)
      for (const b of later)
        expect(mergeRanges(index.openCritical).some(([lo, hi]) => lo < b.end && b.pos < hi)).toBe(false)
      expect(index.seekCritical).toEqual([])
      expect(index.seekMode).toBe('index')
      expect(needsFullDownload(index)).toBe(false)
      // the seek points are the index's references: each fragment from its first sidx box (one per track, two)
      const fragmentStarts = boxes.flatMap((b, k) => (b.type === 'moof' ? [boxes[k - 2]?.pos ?? -1] : []))
      expect(index.keyframes.map(([, b]) => b)).toEqual(fragmentStarts)
    })

    it('AVI: the exact idx1 (it outgrows two pieces in long files)', () => {
      const { index, path } = get('avi.avi')
      const idx1 = riffChunk(path, 'idx1')
      if (!idx1) throw new Error('fixture without idx1')
      expect(covered(index.openCritical, idx1[0], Math.min(idx1[1], index.fileSize))).toBe(true)
    })

    it('generic containers get the head piece and the last two pieces in the manifest', () => {
      const { index } = get('avi.avi')
      const P = 1 << 20
      const m = buildManifest(index, { infoHash: new Uint8Array(20), pieceLength: P })
      expect(covered(m.openCritical, 0, P)).toBe(true)
      const lastPieceStart = Math.floor((index.fileSize - 1) / P) * P
      expect(covered(m.openCritical, lastPieceStart - P, index.fileSize)).toBe(true)
    })
  })

  // The golden ranges of spikes/s4-mpv-http/golden/ belong to fixtures that cannot be regenerated byte for
  // byte (ADR 0004 "Applied"), so the S4 rules are checked here against these fixtures' own packets.
  describe('readyRange follows the S4 rules (ADR 0004 §5)', () => {
    const AHEAD_MS = 6000
    // on keyframes (lavf then takes the previous GOP) and inside a GOP; p + 6 s stays clear of the
    // B-frame delay before a keyframe
    const TIMES = [0, 10_000, 13_500, 20_000]
    const cases: [FixtureName, RuleKind][] = [
      ['mkv-cues.mkv', 'mkv'],
      ['mkv-tail.mkv', 'mkv'],
      ['mp4-faststart.mp4', 'mp4'],
      ['mp4-tailmoov.mp4', 'mp4'],
      ['fmp4-sidx.mp4', 'fmp4'],
      ['fmp4-dash-global.mp4', 'fmp4'],
      ['avi.avi', 'avi'],
    ]
    for (const [name, kind] of cases) {
      it(`${name}: starts at or before the first byte mpv reads, ends after the last one it plays`, () => {
        const { index, path } = get(name)
        // the keyframe rule alone: no open-critical head, whose read-on rule (STREAM_SKIP_BYTES) would pull
        // these near-head starts back to it (media-map.test.ts; end to end in gated-mpv.test.ts)
        const map = new MediaMap({ ...index, pieceLength: 1 << 20, openCritical: [] })
        const packets = probePackets(path)
        const moofs = topBoxes(path)
          .filter((b) => b.type === 'moof')
          .map((b) => b.pos)
        for (const p of TIMES) {
          const [lo = NaN, hi = NaN] = map.readyRange(p, AHEAD_MS)[0] ?? []
          expect(lo, `lo at ${String(p)}`).toBeLessThanOrEqual(s4ReadStart(kind, packets, p, moofs))
          expect(hi, `hi at ${String(p)}`).toBeGreaterThanOrEqual(s4PlayEnd(packets, p + AHEAD_MS))
          const kf = seekKeyframe(kind, packets, p)
          if (kind === 'mkv') {
            // exactly that keyframe's Cluster: after the previous keyframe's packet
            const prev = packets.filter((x) => x.video && x.key && x.ms < kf.ms).at(-1)
            expect(lo).toBeGreaterThan(prev?.pos ?? -1)
          } else if (kind !== 'fmp4') {
            // MP4 and AVI seek points are the keyframe packets themselves (see above)
            expect(lo).toBe(Math.max(0, kf.pos - INTERLEAVE_SLACK_BYTES))
          }
        }
      })
    }

    it('linear files start at 0', () => {
      for (const name of ['mkv-nocues.mkv', 'fmp4-nosidx.mp4', 'fmp4-mfra.mp4', 'fmp4-dash.mp4'] as const) {
        const { index } = get(name)
        expect(new MediaMap({ ...index, pieceLength: 1 << 20 }).readyRange(10_000, AHEAD_MS)[0]?.[0]).toBe(0)
      }
    })
  })

  it('falls back to a linear map without ffprobe', async () => {
    const path = paths.get('avi.avi') ?? ''
    const index = await indexMediaFile(path, { ffprobePath: null, durationHintMs: 31_000 })
    expect(index.seekMode).toBe('linear')
    expect(index.keyframes).toEqual([])
    expect(index.durationMs).toBe(31_000)
    expect(index.container).toBe('avi')
  })

  describe('buildMediaIndex (worker + cache)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-media-cache-'))
    afterAll(() => rmSync(dir, { recursive: true, force: true }))

    it('indexes in a worker, then serves media-v1.bin from the cache', async () => {
      const path = paths.get('mkv-cues.mkv') ?? ''
      const progress: number[] = []
      const first = await buildMediaIndex(path, { cacheDir: dir, onProgress: (d, t) => progress.push(d / t) })
      expect(first.cached).toBe(false)
      expect(first.index).toEqual(get('mkv-cues.mkv').index)
      expect(progress.at(-1)).toBe(1)
      expect(readFileSync(join(dir, MEDIA_CACHE_FILE)).length).toBeGreaterThan(50)
      const second = await buildMediaIndex(path, { cacheDir: dir })
      expect(second.cached).toBe(true)
      expect(second.index).toEqual(first.index)
    })

    it('ignores a cache written for a file of another size', async () => {
      const other = mkdtempSync(join(tmpdir(), 'wt-media-cache-'))
      try {
        await buildMediaIndex(paths.get('mp4-faststart.mp4') ?? '', { cacheDir: other })
        const r = await buildMediaIndex(paths.get('mkv-cues.mkv') ?? '', { cacheDir: other })
        expect(r.cached).toBe(false)
        expect(r.index.container).toBe('mkv')
      } finally {
        rmSync(other, { recursive: true, force: true })
      }
    })

    it('rejects when cancelled', async () => {
      const ac = new AbortController()
      const p = buildMediaIndex(paths.get('mkv-nocues.mkv') ?? '', { signal: ac.signal })
      ac.abort(new Error('user cancelled'))
      await expect(p).rejects.toThrow('user cancelled')
    })

    it('rejects when cancelled while the worker runs', async () => {
      const ac = new AbortController()
      const p = buildMediaIndex(paths.get('mkv-nocues.mkv') ?? '', { signal: ac.signal })
      setTimeout(() => ac.abort(new Error('cancelled later')), 5)
      await expect(p).rejects.toThrow('cancelled later')
    })
  })
})
