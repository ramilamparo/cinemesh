import bencode from 'bencode'
import parseTorrent from 'parse-torrent'
import { describe, expect, it } from 'vitest'
import { buildManifest, decodeManifest, encodeManifest } from '../../shared/media/manifest.js'
import type { ByteRange, KeyPoint, Manifest, MediaIndex, TrackInfo } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import { AnnounceSchema, MAX_CRITICAL_SPANS, announceError, crossCheck, criticalSpans } from './viewer-session.js'

// crossCheck guards the viewer core against a host whose announce, torrent and manifest disagree: nothing
// the host merely states may size a buffer, a journal or a folder (manifest-torrent-not-crosschecked,
// announce-infohash-unverified), or the scheduler's work per replan. criticalSpans turns any number of
// critical ranges into a bounded set of piece spans, so an honest manifest is never refused for them.

const MIB = 1024 * 1024

/** A session torrent as torrent-builder makes it, except that `pieces` can lie about the length. */
async function torrent(lengths: number[], pieceLength: number, pieces?: number) {
  const total = lengths.reduce((n, l) => n + l, 0)
  const count = pieces ?? Math.ceil(total / pieceLength)
  const info = {
    name: 'WatchTogether',
    files: lengths.map((length, i) => ({ length, path: [i === 0 ? 'movie.mkv' : `movie.${String(i)}.srt`] })),
    'piece length': pieceLength,
    pieces: new Uint8Array(count * 20),
    private: 1,
  }
  return parseTorrent(bencode.encode({ info }))
}

function indexOf(fileSize: number): MediaIndex {
  return {
    fileSize,
    container: 'mkv',
    seekMode: 'index',
    interleave: 'good',
    multiSegment: false,
    durationMs: 60_000,
    startMs: 0,
    avgBytesPerSec: Math.round(fileSize / 60),
    keyframes: [
      [0, 1000],
      [30_000, Math.floor(fileSize / 2)],
    ],
    openCritical: [[0, 4096]],
    seekCritical: [[fileSize - 2048, fileSize]],
    tracks: [],
  }
}

/** What an honest host publishes for that torrent, decoded the way the viewer decodes it. */
function manifest(
  t: { infoHash: string; pieceLength: number; files: { length: number }[] },
  subs = t.files.length - 1,
  index = indexOf(t.files[0]?.length ?? 0),
) {
  const m = buildManifest(index, {
    infoHash: Buffer.from(t.infoHash, 'hex'),
    pieceLength: t.pieceLength,
    videoFileIndex: 0,
    externalSubs: Array.from({ length: subs }, (_, i) => ({
      fileIndex: i + 1,
      name: `movie.${String(i + 1)}.srt`,
      lang: '',
      title: `Sub ${String(i + 1)}`,
    })),
  })
  return decodeManifest(encodeManifest(m))
}

function rejection(fn: () => void): string {
  try {
    fn()
  } catch (e) {
    expect(e).toBeInstanceOf(CodedError)
    expect((e as CodedError).code).toBe('bad-session')
    return (e as CodedError).message
  }
  throw new Error('crossCheck accepted it')
}

describe('crossCheck', () => {
  it('accepts what an honest host publishes (video plus subtitles)', async () => {
    const t = await torrent([5 * MIB + 123, 40_000, 700_000], MIB)
    const m = manifest(t)
    expect(() => crossCheck({ infoHash: t.infoHash, fileSize: 5 * MIB + 123 }, t, m)).not.toThrow()
  })

  it('refuses a torrent other than the announced one (the transfer folder is keyed by it)', async () => {
    const real = await torrent([5 * MIB], MIB)
    const other = await torrent([6 * MIB], MIB)
    const m = manifest(real)
    expect(rejection(() => crossCheck({ infoHash: real.infoHash, fileSize: 5 * MIB }, other, m))).toMatch(/\(torrent\)/)
    expect(rejection(() => crossCheck({ infoHash: real.infoHash, fileSize: 5 * MIB }, real, manifest(other)))).toMatch(
      /\(manifest\)/,
    )
  })

  // building a torrent with a 1-byte piece length takes ~3 s alone: past the default 5 s when the machine is busy
  it(
    'refuses piece lengths the segment store cannot take or that size a huge MediaMap',
    { timeout: 30_000 },
    async () => {
      for (const p of [1, 4096, 3 * MIB, 8 * MIB]) {
        const t = await torrent([2 * MIB], p)
        const m: Manifest = { ...manifest(await torrent([2 * MIB], MIB)), infoHash: Buffer.from(t.infoHash, 'hex') }
        expect(
          rejection(() => crossCheck({ infoHash: t.infoHash, fileSize: 2 * MIB }, t, { ...m, pieceLength: p })),
        ).toMatch(/piece length/)
      }
      // a manifest whose piece length differs from the torrent's
      const t = await torrent([2 * MIB], MIB)
      expect(
        rejection(() =>
          crossCheck({ infoHash: t.infoHash, fileSize: 2 * MIB }, t, { ...manifest(t), pieceLength: 2 * MIB }),
        ),
      ).toMatch(/piece length/)
    },
  )

  it('refuses sizes the piece hashes do not cover, before anything is allocated from them', async () => {
    // 2^42 bytes behind 3 piece hashes: a MediaMap for it would need 2^28 entries
    const huge = 2 ** 42
    const t = await torrent([huge], 16 * 1024, 3)
    const m: Manifest = { ...manifest(await torrent([2 * MIB], MIB)), infoHash: Buffer.from(t.infoHash, 'hex') }
    const lie = { ...m, fileSize: huge, pieceLength: 16 * 1024 }
    const t0 = performance.now()
    expect(rejection(() => crossCheck({ infoHash: t.infoHash, fileSize: huge }, t, lie))).toMatch(/pieces/)
    expect(performance.now() - t0).toBeLessThan(100)
    // one hash too many is just as wrong
    const extra = await torrent([2 * MIB], MIB, 3)
    expect(
      rejection(() => crossCheck({ infoHash: extra.infoHash, fileSize: 2 * MIB }, extra, manifest(extra))),
    ).toMatch(/pieces/)
  })

  it('refuses a video size that differs between the announce, the manifest and the torrent', async () => {
    const t = await torrent([3 * MIB, 1000], MIB)
    const m = manifest(t)
    expect(rejection(() => crossCheck({ infoHash: t.infoHash, fileSize: 3 * MIB + 1 }, t, m))).toMatch(/file size/)
    expect(
      rejection(() => crossCheck({ infoHash: t.infoHash, fileSize: 3 * MIB }, t, { ...m, fileSize: 3 * MIB - 1 })),
    ).toMatch(/file size/)
    expect(
      rejection(() => crossCheck({ infoHash: t.infoHash, fileSize: 3 * MIB }, t, { ...m, videoFileIndex: 1 })),
    ).toMatch(/file size/)
  })

  it('refuses subtitles the torrent does not carry, and more files than a host may share', async () => {
    const t = await torrent([3 * MIB, 1000], MIB)
    const m = manifest(t)
    const sub = { fileIndex: 1, name: 's.srt', lang: '', title: 's' }
    const a = { infoHash: t.infoHash, fileSize: 3 * MIB }
    expect(rejection(() => crossCheck(a, t, { ...m, externalSubs: [{ ...sub, fileIndex: 2 }] }))).toMatch(/subtitles/)
    expect(rejection(() => crossCheck(a, t, { ...m, externalSubs: [{ ...sub, fileIndex: 0 }] }))).toMatch(/subtitles/)
    expect(rejection(() => crossCheck(a, t, { ...m, externalSubs: Array.from({ length: 5000 }, () => sub) }))).toMatch(
      /subtitles/,
    )
    const many = await torrent([3 * MIB, ...Array.from({ length: 17 }, () => 10)], MIB)
    expect(rejection(() => crossCheck({ infoHash: many.infoHash, fileSize: 3 * MIB }, many, manifest(many)))).toMatch(
      /file count/,
    )
  })

  it('refuses critical ranges past the video, but not many of them', async () => {
    const t = await torrent([3 * MIB], MIB)
    const m = manifest(t)
    const a = { infoHash: t.infoHash, fileSize: 3 * MIB }
    expect(rejection(() => crossCheck(a, t, { ...m, seekCritical: [[0, 3 * MIB + 1]] }))).toMatch(/ranges/)
    // the count is not the scheduler's cost: startDownload merges them into piece spans
    const lots = Array.from({ length: 2000 }, (_, i): [number, number] => [i * 10, i * 10 + 5])
    expect(() => crossCheck(a, t, { ...m, openCritical: lots })).not.toThrow()
  })

  it('accepts an fMP4 with one sidx per fragment (1,108 ranges in 13 pieces), which the scheduler gets as one span', async () => {
    // a 40 min DASH-style file with a 2 s GOP, as ffmpeg -movflags +frag_keyframe+empty_moov+dash writes it
    const size = 13 * MIB - 5000
    const t = await torrent([size], MIB)
    const sidx = Array.from({ length: 1108 }, (_, i): ByteRange => [12_000 * i + 400, 12_000 * i + 452])
    const index: MediaIndex = { ...indexOf(size), container: 'fmp4', openCritical: [[0, 900], ...sidx] }
    const m = manifest(t, 0, index)
    expect(m.openCritical.length).toBeGreaterThan(1024) // what the round-1 cap refused
    expect(() => crossCheck({ infoHash: t.infoHash, fileSize: size }, t, m)).not.toThrow()
    expect(criticalSpans(m.openCritical, MIB, size)).toEqual([[0, 13 * MIB - 5000]])
  })

  it('refuses more audio indexes or tracks than any honest file has', async () => {
    const t = await torrent([3 * MIB], MIB)
    const m = manifest(t)
    const a = { infoHash: t.infoHash, fileSize: 3 * MIB }
    const audio = (n: number) => Array.from({ length: n }, (_, i) => ({ trackId: i + 2, points: points(4, 10_000) }))
    const poor: Manifest = { ...m, interleave: 'poor' }
    expect(() => crossCheck(a, t, { ...poor, audioIndexes: audio(32) })).not.toThrow()
    // 20,000 indexes (319 KB) were 20,000 urgent ranges on every replan: 2.6 s with the core blocked
    expect(rejection(() => crossCheck(a, t, { ...poor, audioIndexes: audio(33) }))).toMatch(/audio/)
    expect(rejection(() => crossCheck(a, t, { ...poor, audioIndexes: audio(20_000) }))).toMatch(/audio/)
    expect(() => crossCheck(a, t, { ...m, tracks: tracks(256) })).not.toThrow()
    expect(rejection(() => crossCheck(a, t, { ...m, tracks: tracks(257) }))).toMatch(/tracks/)
  })

  it('refuses more seek points than the duration holds at the host minimum gap, or more than 500,000', async () => {
    const t = await torrent([3 * MIB], MIB)
    const m = manifest(t) // 60 s: an honest host keeps at most one point per 250 ms
    const a = { infoHash: t.infoHash, fileSize: 3 * MIB }
    expect(rejection(() => crossCheck(a, t, { ...m, keyframes: points(243, 10) }))).toMatch(/keyframes/)
    const audio = [{ trackId: 2, points: points(243, 10) }]
    expect(rejection(() => crossCheck(a, t, { ...m, interleave: 'poor', audioIndexes: audio }))).toMatch(/audio/)
    // a host can claim any duration: the hard cap still holds (5,000,000 points held 530 MB for the session)
    const long: Manifest = { ...m, durationMs: 2 ** 40, keyframes: points(500_001, 250) }
    expect(rejection(() => crossCheck(a, t, long))).toMatch(/keyframes/)
    expect(() => crossCheck(a, t, { ...long, keyframes: points(500_000, 250) })).not.toThrow()
  })

  it('accepts all-intra seek points (one per 250 ms), also past a duration the container understates', async () => {
    const t = await torrent([3 * MIB], MIB)
    const m = manifest(t)
    const a = { infoHash: t.infoHash, fileSize: 3 * MIB }
    // what thinKeyPoints leaves of an all-intra 60 s file: 0, 250, …, 60,000 ms
    expect(() => crossCheck(a, t, { ...m, keyframes: points(241, 250) })).not.toThrow()
    // a 90 s run of points in a file whose header says 60 s
    expect(() => crossCheck(a, t, { ...m, keyframes: points(361, 250) })).not.toThrow()
    const audio = [{ trackId: 2, points: points(361, 250, -21) }]
    expect(() => crossCheck(a, t, { ...m, interleave: 'poor', audioIndexes: audio })).not.toThrow()
  })
})

describe('criticalSpans', () => {
  it('rounds ranges out to whole pieces, merges overlapping and adjacent ones, and ends at the torrent', () => {
    const length = 10 * MIB + MIB / 2
    const ranges: ByteRange[] = [
      [10 * MIB + 1, length], // the subtitle in the short last piece
      [100, 200],
      [MIB - 1, MIB + 1], // touches piece 0's span
      [5 * MIB + 3, 5 * MIB + 3], // empty
      [2 * MIB, 2 * MIB + 5], // adjacent to piece 1
      [7 * MIB, 8 * MIB], // exactly piece 7
    ]
    expect(criticalSpans(ranges, MIB, length)).toEqual([
      [0, 3 * MIB],
      [7 * MIB, 8 * MIB],
      [10 * MIB, length],
    ])
    expect(criticalSpans([], MIB, length)).toEqual([])
  })

  // ~2.5 s alone (3.3 million ranges); the bound that matters is criticalSpans' own, checked below
  it('bridges the narrowest gaps above the cap, so every critical piece stays covered', { timeout: 30_000 }, () => {
    // pieces 0, 2, 10 and 11: three gaps of 1 piece, 7 pieces and none (11 is adjacent to 10)
    const spans = criticalSpans(
      [
        [0, 1],
        [2 * MIB, 2 * MIB + 1],
        [10 * MIB, 10 * MIB + 1],
        [11 * MIB, 11 * MIB + 1],
      ],
      MIB,
      20 * MIB,
      2,
    )
    expect(spans).toEqual([
      [0, 3 * MIB],
      [10 * MIB, 12 * MIB],
    ])

    // a hostile manifest: every other piece of a 3.3 million piece torrent (the 64 MiB torrent blob's limit)
    const pieces = 3_300_000
    const every: ByteRange[] = Array.from({ length: pieces / 2 }, (_, i) => [2 * i * 16_384, 2 * i * 16_384 + 1])
    const t0 = performance.now()
    const capped = criticalSpans(every, 16_384, pieces * 16_384)
    expect(performance.now() - t0).toBeLessThan(5000)
    expect(capped.length).toBe(MAX_CRITICAL_SPANS)
    // a superset: each original range lies inside one of the spans
    let j = 0
    let uncovered = 0
    for (const [s, e] of every) {
      while ((capped[j]?.[1] ?? Infinity) < e) j++
      const span = capped[j]
      if (!span || span[0] > s || e > span[1]) uncovered++
    }
    expect(uncovered).toBe(0)
  })
})

describe('the announce', () => {
  const announce = (manifestSize: number) => ({
    v: 1,
    infoHash: 'a'.repeat(40),
    torrent: { hash: 'b'.repeat(64), size: 1000 },
    manifest: { hash: 'c'.repeat(64), size: manifestSize },
    name: 'movie.mkv',
    fileSize: 1000,
    durationMs: 1000,
  })

  it('caps the manifest at 4 MiB, far above what an honest host sends', () => {
    expect(AnnounceSchema.safeParse(announce(4 * MIB)).success).toBe(true)
    expect(AnnounceSchema.safeParse(announce(4 * MIB + 1)).success).toBe(false)
    expect(AnnounceSchema.safeParse(announce(16 * MIB)).success).toBe(false)
  })

  /** The join's error for an announce AnnounceSchema refuses. */
  const failure = (raw: unknown): CodedError => {
    const parsed = AnnounceSchema.safeParse(raw)
    if (parsed.success) throw new Error('the schema accepted it')
    return announceError(raw, parsed.error.issues)
  }

  it('an unreadable announce from a newer host asks for an update, whatever else changed', () => {
    for (const raw of [
      { ...announce(1000), v: 2 },
      { v: 3, something: 'else' },
      { ...announce(1000), v: 1.5 },
    ]) {
      const e = failure(raw)
      expect(e.code).toBe('update-required')
      expect(e.message).toBe('The host uses a newer version of Watch Together. Update the app to join.')
    }
  })

  it('any other unreadable announce is bad-session, naming the field', () => {
    expect(failure(announce(4 * MIB + 1)).message).toBe(
      'The host sent video details this app cannot read (manifest.size). Ask the host to host it again.',
    )
    for (const raw of [{ ...announce(1000), v: '2' }, { ...announce(1000), v: 0 }, null, 'announce', []]) {
      expect(failure(raw).code).toBe('bad-session')
    }
    expect(failure({ ...announce(1000), name: '' }).message).toMatch(/\(name\)/)
    expect(failure(null).message).toMatch(/\(announce\)/)
  })
})

/** n seek points `gapMs` apart from `t0`, bytes inside a 3 MiB video */
function points(n: number, gapMs: number, t0 = 0): KeyPoint[] {
  return Array.from({ length: n }, (_, i): KeyPoint => [t0 + i * gapMs, Math.floor((i * MIB) / Math.max(1, n))])
}

function tracks(n: number): TrackInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    type: i === 0 ? 'video' : 'subtitle',
    codec: 'S_TEXT/UTF8',
    lang: 'eng',
    name: '',
    isDefault: false,
    forced: false,
    hdr: 'none',
    channels: 0,
    width: 0,
    height: 0,
  }))
}
