import c from 'compact-encoding'
import { describe, expect, it } from 'vitest'
import {
  MANIFEST_VERSION,
  buildManifest,
  decodeManifest,
  decodeMediaIndex,
  encodeManifest,
  encodeMediaIndex,
} from './manifest.js'
import { needsFullDownload } from './media-map.js'
import type { KeyPoint, Manifest, MediaIndex, TrackInfo } from './types.js'

function track(id: number, type: TrackInfo['type'], extra: Partial<TrackInfo> = {}): TrackInfo {
  return {
    id,
    type,
    codec: type === 'video' ? 'V_MPEGH/ISO/HEVC' : type === 'audio' ? 'A_EAC3' : 'S_TEXT/ASS',
    lang: 'eng',
    name: `${type} ${String(id)}`,
    isDefault: id === 1,
    forced: false,
    hdr: 'none',
    channels: type === 'audio' ? 6 : 0,
    width: type === 'video' ? 3840 : 0,
    height: type === 'video' ? 2160 : 0,
    ...extra,
  }
}

// A deterministic jitter so byte gaps vary like a real encode.
function film(durationS: number, gopMs: number, bytesPerSec: number): KeyPoint[] {
  const out: KeyPoint[] = []
  let byte = 4096
  let x = 7
  for (let t = 0; t < durationS * 1000; t += gopMs) {
    out.push([t, byte])
    x = (x * 48271) % 2147483647
    byte += Math.round(((bytesPerSec * gopMs) / 1000) * (0.6 + (x % 1000) / 1250))
  }
  return out
}

function index(over: Partial<MediaIndex> = {}): MediaIndex {
  const keyframes = film(7200, 2000, 1_250_000)
  const fileSize = (keyframes.at(-1)?.[1] ?? 0) + 5_000_000
  return {
    fileSize,
    container: 'mkv',
    seekMode: 'index',
    interleave: 'good',
    multiSegment: false,
    durationMs: 7_200_000,
    startMs: 0,
    avgBytesPerSec: 1_250_000,
    keyframes,
    openCritical: [
      [0, 300_000],
      [fileSize - 2_000_000, fileSize - 1_000_000],
    ],
    seekCritical: [[fileSize - 1_000_000, fileSize]],
    tracks: [
      track(1, 'video', { hdr: 'pq' }),
      track(2, 'audio'),
      track(3, 'audio', { lang: 'jpn' }),
      track(4, 'subtitle', { forced: true, name: 'Signs — ünïcode' }),
    ],
    ...over,
  }
}

function manifest(over: Partial<MediaIndex> = {}): Manifest {
  return buildManifest(index(over), {
    infoHash: Uint8Array.from({ length: 20 }, (_, i) => i * 7),
    pieceLength: 1 << 20,
    externalSubs: [{ fileIndex: 1, name: 'film.en.srt', lang: 'en', title: 'English' }],
  })
}

describe('manifest v1', () => {
  it('round-trips every field', () => {
    const m = manifest()
    const back = decodeManifest(encodeManifest(m))
    expect(back).toEqual(m)
    expect(back.version).toBe(MANIFEST_VERSION)
    expect(back.audioIndexes).toBeUndefined()
  })

  it('round-trips optional audio indexes, a negative start, flags and sizes above 4 GiB', () => {
    const big = 60 * 2 ** 30
    const m = manifest({
      fileSize: big,
      startMs: -83,
      multiSegment: true,
      interleave: 'poor',
      container: 'mp4',
      keyframes: [
        [-83, 40],
        [1917, 5_000_000_000],
        [3917, 9_000_000_000],
      ],
      openCritical: [[0, 65536]],
      seekCritical: [],
      audioIndexes: [
        {
          trackId: 2,
          points: [
            [-21, 100],
            [979, 6_000_000_000],
          ],
        },
      ],
    })
    const back = decodeManifest(encodeManifest(m))
    expect(back).toEqual(m)
    expect(back.multiSegment).toBe(true)
  })

  it('keeps keyframes at least 250 ms apart and monotonic', () => {
    const m = manifest({
      keyframes: [
        [0, 10],
        [40, 20],
        [300, 30],
        [500, 25],
        [600, 40],
      ],
    })
    expect(decodeManifest(encodeManifest(m)).keyframes).toEqual([
      [0, 10],
      [300, 30],
      [600, 40],
    ])
  })

  it('rejects a higher version and garbage', () => {
    const bytes = encodeManifest(manifest())
    const newer = c.encode(c.uint, MANIFEST_VERSION + 1)
    const forged = new Uint8Array(bytes.length)
    forged.set(bytes)
    forged.set(newer, 0)
    expect(() => decodeManifest(forged)).toThrow(/newer/)
    expect(() => decodeManifest(bytes.subarray(0, bytes.length - 3))).toThrow()
    expect(() => decodeManifest(new Uint8Array([1, 0, 0]))).toThrow()
  })

  it('ignores trailing fields a newer v1 writer appended behind new flag bits', () => {
    const bytes = encodeManifest(manifest())
    const longer = new Uint8Array(bytes.length + 5)
    longer.set(bytes)
    expect(decodeManifest(longer)).toEqual(manifest())
  })

  it('fits a 2 h film with 2 s GOPs in about 25 KB', () => {
    const bytes = encodeManifest(manifest())
    expect(manifest().keyframes.length).toBe(3600)
    expect(bytes.length).toBeGreaterThan(18_000)
    expect(bytes.length).toBeLessThan(27_000)
  })

  it('stays under 175 KB at the 250 ms keyframe floor', () => {
    const keyframes = film(7200, 250, 1_250_000)
    const fileSize = (keyframes.at(-1)?.[1] ?? 0) + 1
    const bytes = encodeManifest(manifest({ keyframes, fileSize, openCritical: [], seekCritical: [] }))
    expect(bytes.length).toBeLessThan(175_000)
  })

  it('adds the head piece and the last two pieces for generic containers', () => {
    const P = 1 << 20
    const m = buildManifest(
      {
        ...index(),
        container: 'avi',
        fileSize: 10 * P + 5,
        openCritical: [[0, 1000]],
        seekCritical: [],
        keyframes: [],
      },
      { infoHash: new Uint8Array(20), pieceLength: P },
    )
    expect(m.openCritical).toEqual([
      [0, P],
      [9 * P, 10 * P + 5],
    ])
  })

  // The viewer decides "plays once fully downloaded" from the manifest it received (SessionEvent.media).
  it('needsFullDownload reads a decoded manifest', () => {
    const fileSize = index().fileSize
    const scanned = manifest({ container: 'fmp4', seekMode: 'linear', openCritical: [[0, fileSize]], seekCritical: [] })
    expect(needsFullDownload(decodeManifest(encodeManifest(scanned)))).toBe(true)
    expect(needsFullDownload(decodeManifest(encodeManifest(manifest())))).toBe(false)
  })

  it('encodes the host cache body without torrent fields', () => {
    const i = index({ audioIndexes: [{ trackId: 3, points: [[0, 1]] }], interleave: 'poor' })
    const back = decodeMediaIndex(encodeMediaIndex(i))
    expect(back).toEqual(i)
    expect(() => decodeMediaIndex(encodeManifest(manifest()))).toThrow()
  })

  it('refuses a cache body an older indexer wrote, so the host indexes again', () => {
    const bytes = encodeMediaIndex(index())
    const v1 = Uint8Array.from(bytes)
    v1[4] = 1 // the uint version after the 4-byte magic
    expect(() => decodeMediaIndex(v1)).toThrow(/version/)
    expect(decodeMediaIndex(bytes)).toEqual(index())
  })
})
