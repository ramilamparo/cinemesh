import c, { type Encoder, type State } from 'compact-encoding'
import { mergeRanges, thinKeyPoints } from './ranges.js'
import {
  type AudioIndex,
  type ByteRange,
  CONTAINERS,
  type ExternalSub,
  HDR_KINDS,
  INTERLEAVES,
  type KeyPoint,
  type Manifest,
  type MediaIndex,
  SEEK_MODES,
  TRACK_TYPES,
  type TrackInfo,
} from './types.js'

// Manifest v1 (plan §4.3). Layout, in order:
//   header      uint version, uint flags, fixed20 infoHash, uint videoFileIndex, uint fileSize, uint pieceLength
//   media info  uint8 container, uint8 seekMode, uint8 interleave, uint durationMs, int startMs, uint avgBytesPerSec
//   keyframes   uint count, then per point LEB128 (Δms, Δbyte) from the previous point
//   ranges      openCritical, seekCritical: uint count, then LEB128 (gap from the previous end, length)
//   lists       tracks[], externalSubs[], audioIndexes[] (only with FLAG_AUDIO_INDEXES)
// New fields are appended behind new flag bits, so a v1 decoder ignores trailing bytes it does not know.
// The host cache (media-v1.bin) stores the same media body without the torrent header and subtitles.

export const MANIFEST_VERSION = 1
export const FLAG_MULTI_SEGMENT = 1
export const FLAG_AUDIO_INDEXES = 2

const CACHE_MAGIC = 0x57544d49 // 'WTMI'
// Also bumped when the indexer's rules change, so a host rebuilds what an older build cached. 2: fMP4 with a
// sidx per fragment is open-critical whole (ADR 0004 §8.2).
const CACHE_VERSION = 2
const INFO_HASH_BYTES = 20

// LEB128: a 2 s keyframe gap costs 2 bytes and a 2.5 MB byte gap 4, which keeps a 2 h film near 25 KB.
// compact-encoding's own uint would spend 3 and 5.
const varint: Encoder<number> = {
  preencode(state, n) {
    let v = checkUint(n)
    state.end++
    while (v >= 128) {
      v = Math.floor(v / 128)
      state.end++
    }
  },
  encode(state, n) {
    const buf = state.buffer
    if (!buf) throw new Error('no buffer')
    let v = checkUint(n)
    while (v >= 128) {
      buf[state.start++] = (v % 128) | 0x80
      v = Math.floor(v / 128)
    }
    buf[state.start++] = v
  },
  decode(state) {
    const buf = state.buffer
    if (!buf) throw new Error('no buffer')
    let value = 0
    let mul = 1
    for (;;) {
      if (state.start >= state.end) throw new Error('Out of bounds')
      const b = buf[state.start++] ?? 0
      value += (b & 0x7f) * mul
      if (b < 0x80) return value
      mul *= 128
      if (mul > 2 ** 49) throw new Error('varint too long')
    }
  },
}

function checkUint(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`not a uint: ${n}`)
  return n
}

function enumCodec<T extends string>(values: readonly T[]): Encoder<T> {
  return {
    preencode(state) {
      c.uint8.preencode(state, 0)
    },
    encode(state, v) {
      const i = values.indexOf(v)
      if (i < 0) throw new Error(`unknown value ${v}`)
      c.uint8.encode(state, i)
    },
    decode(state) {
      const i = c.uint8.decode(state)
      const v = values[i]
      if (v === undefined) throw new Error(`unknown enum index ${i}`)
      return v
    },
  }
}

const container = enumCodec(CONTAINERS)
const seekMode = enumCodec(SEEK_MODES)
const interleave = enumCodec(INTERLEAVES)
const trackType = enumCodec(TRACK_TYPES)
const hdr = enumCodec(HDR_KINDS)

const keyPoints: Encoder<KeyPoint[]> = {
  preencode(state, points) {
    c.uint.preencode(state, points.length)
    let pt = 0
    let pb = 0
    for (const [t, b] of points) {
      varint.preencode(state, t - pt)
      varint.preencode(state, b - pb)
      pt = t
      pb = b
    }
  },
  encode(state, points) {
    c.uint.encode(state, points.length)
    let pt = 0
    let pb = 0
    for (const [t, b] of points) {
      varint.encode(state, t - pt)
      varint.encode(state, b - pb)
      pt = t
      pb = b
    }
  },
  decode(state) {
    const n = c.uint.decode(state)
    const out: KeyPoint[] = []
    let t = 0
    let b = 0
    for (let i = 0; i < n; i++) {
      t += varint.decode(state)
      b += varint.decode(state)
      out.push([t, b])
    }
    return out
  },
}

// Points are relative to the first one so a negative start time (B-frame delay) still encodes.
const signedKeyPoints: Encoder<KeyPoint[]> = {
  preencode(state, points) {
    const base = points[0]?.[0] ?? 0
    c.int.preencode(state, base)
    keyPoints.preencode(state, shift(points, -base))
  },
  encode(state, points) {
    const base = points[0]?.[0] ?? 0
    c.int.encode(state, base)
    keyPoints.encode(state, shift(points, -base))
  },
  decode(state) {
    const base = c.int.decode(state)
    return shift(keyPoints.decode(state), base)
  },
}

function shift(points: readonly KeyPoint[], dt: number): KeyPoint[] {
  return points.map(([t, b]) => [t + dt, b])
}

const ranges: Encoder<ByteRange[]> = {
  preencode(state, rs) {
    c.uint.preencode(state, rs.length)
    let end = 0
    for (const [a, b] of rs) {
      varint.preencode(state, a - end)
      varint.preencode(state, b - a)
      end = b
    }
  },
  encode(state, rs) {
    c.uint.encode(state, rs.length)
    let end = 0
    for (const [a, b] of rs) {
      varint.encode(state, a - end)
      varint.encode(state, b - a)
      end = b
    }
  },
  decode(state) {
    const n = c.uint.decode(state)
    const out: ByteRange[] = []
    let end = 0
    for (let i = 0; i < n; i++) {
      const a = end + varint.decode(state)
      end = a + varint.decode(state)
      out.push([a, end])
    }
    return out
  },
}

const track: Encoder<TrackInfo> = {
  preencode(state, t) {
    c.uint.preencode(state, t.id)
    trackType.preencode(state, t.type)
    c.string.preencode(state, t.codec)
    c.string.preencode(state, t.lang)
    c.string.preencode(state, t.name)
    c.uint8.preencode(state, 0)
    hdr.preencode(state, t.hdr)
    c.uint.preencode(state, t.channels)
    c.uint.preencode(state, t.width)
    c.uint.preencode(state, t.height)
  },
  encode(state, t) {
    c.uint.encode(state, t.id)
    trackType.encode(state, t.type)
    c.string.encode(state, t.codec)
    c.string.encode(state, t.lang)
    c.string.encode(state, t.name)
    c.uint8.encode(state, (t.isDefault ? 1 : 0) | (t.forced ? 2 : 0))
    hdr.encode(state, t.hdr)
    c.uint.encode(state, t.channels)
    c.uint.encode(state, t.width)
    c.uint.encode(state, t.height)
  },
  decode(state) {
    const id = c.uint.decode(state)
    const type = trackType.decode(state)
    const codec = c.string.decode(state)
    const lang = c.string.decode(state)
    const name = c.string.decode(state)
    const bits = c.uint8.decode(state)
    return {
      id,
      type,
      codec,
      lang,
      name,
      isDefault: (bits & 1) !== 0,
      forced: (bits & 2) !== 0,
      hdr: hdr.decode(state),
      channels: c.uint.decode(state),
      width: c.uint.decode(state),
      height: c.uint.decode(state),
    }
  },
}

const externalSub: Encoder<ExternalSub> = {
  preencode(state, s) {
    c.uint.preencode(state, s.fileIndex)
    c.string.preencode(state, s.name)
    c.string.preencode(state, s.lang)
    c.string.preencode(state, s.title)
  },
  encode(state, s) {
    c.uint.encode(state, s.fileIndex)
    c.string.encode(state, s.name)
    c.string.encode(state, s.lang)
    c.string.encode(state, s.title)
  },
  decode(state) {
    return {
      fileIndex: c.uint.decode(state),
      name: c.string.decode(state),
      lang: c.string.decode(state),
      title: c.string.decode(state),
    }
  },
}

const audioIndex: Encoder<AudioIndex> = {
  preencode(state, a) {
    c.uint.preencode(state, a.trackId)
    signedKeyPoints.preencode(state, a.points)
  },
  encode(state, a) {
    c.uint.encode(state, a.trackId)
    signedKeyPoints.encode(state, a.points)
  },
  decode(state) {
    return { trackId: c.uint.decode(state), points: signedKeyPoints.decode(state) }
  },
}

const tracks = c.array(track)
const externalSubs = c.array(externalSub)
const audioIndexes = c.array(audioIndex)

type Body = Omit<MediaIndex, 'fileSize' | 'multiSegment' | 'audioIndexes'>

const body: Encoder<Body> = {
  preencode(state, m) {
    container.preencode(state, m.container)
    seekMode.preencode(state, m.seekMode)
    interleave.preencode(state, m.interleave)
    c.uint.preencode(state, m.durationMs)
    c.int.preencode(state, m.startMs)
    c.uint.preencode(state, m.avgBytesPerSec)
    signedKeyPoints.preencode(state, m.keyframes)
    ranges.preencode(state, m.openCritical)
    ranges.preencode(state, m.seekCritical)
    tracks.preencode(state, m.tracks)
  },
  encode(state, m) {
    container.encode(state, m.container)
    seekMode.encode(state, m.seekMode)
    interleave.encode(state, m.interleave)
    c.uint.encode(state, m.durationMs)
    c.int.encode(state, m.startMs)
    c.uint.encode(state, m.avgBytesPerSec)
    signedKeyPoints.encode(state, m.keyframes)
    ranges.encode(state, m.openCritical)
    ranges.encode(state, m.seekCritical)
    tracks.encode(state, m.tracks)
  },
  decode(state) {
    return {
      container: container.decode(state),
      seekMode: seekMode.decode(state),
      interleave: interleave.decode(state),
      durationMs: c.uint.decode(state),
      startMs: c.int.decode(state),
      avgBytesPerSec: c.uint.decode(state),
      keyframes: signedKeyPoints.decode(state),
      openCritical: ranges.decode(state),
      seekCritical: ranges.decode(state),
      tracks: tracks.decode(state),
    }
  },
}

/** Rounds and normalises an index so that it round-trips exactly through the codecs. */
export function normalizeIndex<T extends MediaIndex>(m: T): T {
  const out: T = {
    ...m,
    durationMs: Math.max(0, Math.round(m.durationMs)),
    startMs: Math.round(m.startMs),
    avgBytesPerSec: Math.max(0, Math.round(m.avgBytesPerSec)),
    keyframes: thinKeyPoints(m.keyframes),
    openCritical: mergeRanges(m.openCritical, m.fileSize),
    seekCritical: mergeRanges(m.seekCritical, m.fileSize),
  }
  if (m.audioIndexes?.length) {
    out.audioIndexes = m.audioIndexes.map((a) => ({ trackId: a.trackId, points: thinKeyPoints(a.points) }))
  } else {
    delete out.audioIndexes
  }
  return out
}

function flagsOf(m: MediaIndex): number {
  return (m.multiSegment ? FLAG_MULTI_SEGMENT : 0) | (m.audioIndexes?.length ? FLAG_AUDIO_INDEXES : 0)
}

function validate(m: MediaIndex): void {
  for (const [, b] of m.keyframes) if (b > m.fileSize) throw new Error('keyframe beyond the end of the file')
  for (const [, b] of [...m.openCritical, ...m.seekCritical]) {
    if (b > m.fileSize) throw new Error('critical range beyond the end of the file')
  }
}

function withBuffer(size: number, fill: (state: State) => void): Uint8Array {
  const state = c.state()
  state.end = size
  state.buffer = new Uint8Array(size)
  fill(state)
  return state.buffer
}

function measure(fill: (state: State) => void): number {
  const state = c.state()
  fill(state)
  return state.end
}

export function encodeManifest(input: Manifest): Uint8Array {
  if (input.infoHash.length !== INFO_HASH_BYTES) throw new Error('infoHash must be 20 bytes')
  const m = normalizeIndex(input)
  validate(m)
  const flags = flagsOf(m)
  const run = (pre: boolean) => (state: State) => {
    const op = pre ? 'preencode' : 'encode'
    c.uint[op](state, MANIFEST_VERSION)
    c.uint[op](state, flags)
    c.fixed(INFO_HASH_BYTES)[op](state, m.infoHash)
    c.uint[op](state, m.videoFileIndex)
    c.uint[op](state, m.fileSize)
    c.uint[op](state, m.pieceLength)
    body[op](state, m)
    externalSubs[op](state, m.externalSubs)
    if (flags & FLAG_AUDIO_INDEXES) audioIndexes[op](state, m.audioIndexes ?? [])
  }
  return withBuffer(measure(run(true)), run(false))
}

export function decodeManifest(buf: Uint8Array): Manifest {
  const state = c.state(0, buf.length, buf)
  const version = c.uint.decode(state)
  if (version > MANIFEST_VERSION) throw new Error(`manifest version ${version} is newer than this app`)
  if (version < 1) throw new Error('bad manifest version')
  const flags = c.uint.decode(state)
  const infoHash = c.fixed(INFO_HASH_BYTES).decode(state)
  const videoFileIndex = c.uint.decode(state)
  const fileSize = c.uint.decode(state)
  const pieceLength = c.uint.decode(state)
  if (pieceLength <= 0) throw new Error('bad piece length')
  const b = body.decode(state)
  const subs = externalSubs.decode(state)
  const m: Manifest = {
    version,
    infoHash: Uint8Array.from(infoHash),
    videoFileIndex,
    fileSize,
    pieceLength,
    multiSegment: (flags & FLAG_MULTI_SEGMENT) !== 0,
    ...b,
    externalSubs: subs,
  }
  if (flags & FLAG_AUDIO_INDEXES) m.audioIndexes = audioIndexes.decode(state)
  validate(m)
  return m
}

/** The host's cache body (media-v1.bin): the index without anything that depends on the torrent. */
export function encodeMediaIndex(input: MediaIndex): Uint8Array {
  const m = normalizeIndex(input)
  validate(m)
  const flags = flagsOf(m)
  const run = (pre: boolean) => (state: State) => {
    const op = pre ? 'preencode' : 'encode'
    c.uint32[op](state, CACHE_MAGIC)
    c.uint[op](state, CACHE_VERSION)
    c.uint[op](state, flags)
    c.uint[op](state, m.fileSize)
    body[op](state, m)
    if (flags & FLAG_AUDIO_INDEXES) audioIndexes[op](state, m.audioIndexes ?? [])
  }
  return withBuffer(measure(run(true)), run(false))
}

export function decodeMediaIndex(buf: Uint8Array): MediaIndex {
  const state = c.state(0, buf.length, buf)
  if (c.uint32.decode(state) !== CACHE_MAGIC) throw new Error('not a media index')
  if (c.uint.decode(state) !== CACHE_VERSION) throw new Error('unsupported media index version')
  const flags = c.uint.decode(state)
  const fileSize = c.uint.decode(state)
  const m: MediaIndex = { fileSize, multiSegment: (flags & FLAG_MULTI_SEGMENT) !== 0, ...body.decode(state) }
  if (flags & FLAG_AUDIO_INDEXES) m.audioIndexes = audioIndexes.decode(state)
  validate(m)
  return m
}

export interface ManifestInputs {
  infoHash: Uint8Array
  pieceLength: number
  videoFileIndex?: number
  externalSubs?: ExternalSub[]
}

const GENERIC_CONTAINERS = new Set(['avi', 'mpegts', 'generic'])

/**
 * Builds the manifest the host publishes. For generic containers the head piece and the last two
 * pieces are open-critical: demuxers probe the head and may read an index or trailer at the tail
 * (AVI idx1), and only now is the piece length known.
 */
export function buildManifest(index: MediaIndex, inputs: ManifestInputs): Manifest {
  const P = inputs.pieceLength
  const openCritical = [...index.openCritical]
  if (GENERIC_CONTAINERS.has(index.container) && index.fileSize > 0) {
    const lastPieceStart = Math.floor((index.fileSize - 1) / P) * P
    openCritical.push([0, Math.min(P, index.fileSize)], [Math.max(0, lastPieceStart - P), index.fileSize])
  }
  return normalizeIndex({
    ...index,
    openCritical,
    version: MANIFEST_VERSION,
    infoHash: inputs.infoHash,
    videoFileIndex: inputs.videoFileIndex ?? 0,
    pieceLength: P,
    externalSubs: inputs.externalSubs ?? [],
  })
}
