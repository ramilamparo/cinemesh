import { type ISOFile, MP4BoxBuffer, type Sample, type Track, createFile } from 'mp4box'
import type {
  AudioIndex,
  ByteRange,
  HdrKind,
  Interleave,
  KeyPoint,
  MediaIndex,
  TrackInfo,
  TrackType,
} from '../../shared/media/types.js'
import { type ByteSource, type ProgressFn, checkAborted, fourcc, readU32BE, readU64BE } from './byte-source.js'
import { headMargin } from './margins.js'

// MP4/MOV/M4V index (plan §4.3). We walk the top-level boxes ourselves, hand ftyp + moov (only) to
// mp4box.js for the sample tables, and parse sidx/moof/tfdt ourselves for fragmented files.

const KIB = 1024
const MIB = 1024 * KIB
const MAX_MOOV = 256 * MIB
const TAIL_HEAD = 64 * KIB
const BOX_HEADER = 16
const MAX_MOOF = 16 * MIB
// FFmpeg reads the last 4 bytes of a fragmented file at open (the mfro size); keep a box header's worth.
const FMP4_TAIL = 16
// Poor interleave (plan): a 1 s window of samples spans > 8 MiB, or > 4x its own bytes. The 4x rule
// alone flags low-bitrate files whose spans are far below a piece, so it also needs a 2 MiB span.
const POOR_SPAN = 8 * MIB
const POOR_RATIO = 4
const POOR_RATIO_MIN_SPAN = 2 * MIB

export interface Box {
  type: string
  pos: number
  headerSize: number
  end: number
}

export async function readBoxHeader(src: ByteSource, pos: number, limit: number): Promise<Box | null> {
  if (pos + 8 > limit) return null
  const b = await src.read(pos, BOX_HEADER)
  if (b.length < 8) return null
  let size = readU32BE(b, 0)
  const type = fourcc(b, 4)
  let headerSize = 8
  if (size === 1) {
    if (b.length < 16) return null
    size = readU64BE(b, 8)
    headerSize = 16
  } else if (size === 0) size = limit - pos
  if (size < headerSize || !/^[\x20-\x7e]{4}$/.test(type)) return null
  return { type, pos, headerSize, end: Math.min(limit, pos + size) }
}

/** Top-level boxes; stops at the first malformed header (truncated or not an MP4). */
export async function walkBoxes(src: ByteSource, signal?: AbortSignal, onProgress?: ProgressFn): Promise<Box[]> {
  const out: Box[] = []
  let pos = 0
  let lastReport = 0
  while (pos < src.size) {
    const box = await readBoxHeader(src, pos, src.size)
    if (!box) break
    out.push(box)
    pos = box.end
    if (pos - lastReport > 256 * MIB) {
      lastReport = pos
      checkAborted(signal)
      onProgress?.(pos, src.size)
    }
  }
  return out
}

/** Children of an in-memory box body. */
function* boxesIn(b: Uint8Array, start = 0, end = b.length): Generator<{ type: string; data: Uint8Array }> {
  let p = start
  while (p + 8 <= end) {
    let size = readU32BE(b, p)
    let hdr = 8
    if (size === 1) {
      size = readU64BE(b, p + 8)
      hdr = 16
    } else if (size === 0) size = end - p
    if (size < hdr) return
    yield { type: fourcc(b, p + 4), data: b.subarray(p + hdr, Math.min(end, p + size)) }
    p += size
  }
}

interface TrackTiming {
  timescale: number
  /** media_time of the first non-empty edit, in track timescale. */
  mediaTime: number
  /** Leading empty edits, ms. */
  delayMs: number
}

function timingOf(t: Track, movieTimescale: number): TrackTiming {
  let mediaTime = 0
  let delayMs = 0
  for (const e of t.edits ?? []) {
    if (e.media_time === -1) {
      delayMs += (e.segment_duration * 1000) / (movieTimescale || 1000)
      continue
    }
    mediaTime = e.media_time
    break
  }
  return { timescale: t.timescale || 1, mediaTime, delayMs }
}

function msOf(ticks: number, tm: TrackTiming): number {
  return ((ticks - tm.mediaTime) * 1000) / tm.timescale + tm.delayMs
}

function trackType(t: Track): TrackType {
  if (t.type === 'video') return 'video'
  if (t.type === 'audio') return 'audio'
  if (t.type === 'subtitles') return 'subtitle'
  return 'other'
}

function hdrOf(file: ISOFile, id: number): HdrKind {
  try {
    const entry = file.getTrackById(id).mdia.minf.stbl.stsd.entries[0]
    for (const b of entry?.boxes ?? []) {
      if (b.type !== 'colr') continue
      const tc = (b as unknown as { transfer_characteristics?: number }).transfer_characteristics
      if (tc === 16) return 'pq'
      if (tc === 18) return 'hlg'
    }
  } catch {
    // tracks without a sample description are reported as SDR
  }
  return 'none'
}

function tracksOf(file: ISOFile, tracks: Track[]): TrackInfo[] {
  const seen = new Set<TrackType>()
  return tracks.map((t) => {
    const type = trackType(t)
    const first = !seen.has(type)
    seen.add(type)
    let enabled = true
    try {
      enabled = (file.getTrackById(t.id).tkhd.flags & 1) !== 0
    } catch {
      // keep enabled
    }
    return {
      id: t.id,
      type,
      codec: t.codec,
      lang: t.language,
      name: t.name,
      isDefault: first && enabled,
      forced: false,
      hdr: type === 'video' ? hdrOf(file, t.id) : 'none',
      channels: t.audio?.channel_count ?? 0,
      width: t.video?.width ?? 0,
      height: t.video?.height ?? 0,
    }
  })
}

function parseMoov(ftyp: Uint8Array | null, moov: Uint8Array): ISOFile {
  const bytes = new Uint8Array((ftyp?.length ?? 0) + moov.length)
  if (ftyp) bytes.set(ftyp, 0)
  bytes.set(moov, ftyp?.length ?? 0)
  const file = createFile()
  file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(bytes.buffer, 0))
  file.flush()
  if (!file.getInfo().hasMoov) throw new Error('moov could not be parsed')
  return file
}

interface Placed {
  t: number
  off: number
  size: number
}

/** Plan rule: any 1 s window whose samples span > 8 MiB, or > 4x (and > 2 MiB) their own bytes. */
export function judgeMp4Interleave(samples: Placed[]): Interleave {
  if (samples.length === 0) return 'unknown'
  const windows = new Map<number, { lo: number; hi: number; own: number }>()
  for (const s of samples) {
    const k = Math.floor(s.t / 1000)
    const w = windows.get(k)
    if (w) {
      w.lo = Math.min(w.lo, s.off)
      w.hi = Math.max(w.hi, s.off + s.size)
      w.own += s.size
    } else windows.set(k, { lo: s.off, hi: s.off + s.size, own: s.size })
  }
  for (const w of windows.values()) {
    const span = w.hi - w.lo
    if (span > POOR_SPAN || (span > POOR_RATIO * w.own && span > POOR_RATIO_MIN_SPAN)) return 'poor'
  }
  return 'good'
}

function placed(samples: Sample[], tm: TrackTiming): Placed[] {
  return samples.map((s) => ({ t: msOf(s.cts, tm), off: s.offset, size: s.size }))
}

interface Fragment {
  pos: number
  timeMs: number
  endMs: number
}

interface Trex {
  duration: number
  flags: number
}

// One moof: base decode time and composition offset of the first sample of `trackId`, plus the
// fragment's total duration. Returns null when the fragment has no samples of that track.
function parseMoof(
  b: Uint8Array,
  trackId: number,
  trex: Trex,
): { dts: number; cto: number; dur: number; sync: boolean } | null {
  for (const traf of boxesIn(b)) {
    if (traf.type !== 'traf') continue
    let id = -1
    let dts = 0
    let defDur = trex.duration
    let defFlags = trex.flags
    let cto = 0
    let dur = 0
    let firstFlags: number | null = null
    let seenSample = false
    for (const box of boxesIn(traf.data)) {
      const d = box.data
      if (d.length < 4) continue
      const version = d[0] ?? 0
      const flags = readU32BE(d, 0) & 0xffffff
      if (box.type === 'tfhd') {
        id = readU32BE(d, 4)
        let p = 8
        if (flags & 0x01) p += 8
        if (flags & 0x02) p += 4
        if (flags & 0x08) {
          defDur = readU32BE(d, p)
          p += 4
        }
        if (flags & 0x10) p += 4
        if (flags & 0x20) defFlags = readU32BE(d, p)
      } else if (box.type === 'tfdt') {
        dts = version === 1 ? readU64BE(d, 4) : readU32BE(d, 4)
      } else if (box.type === 'trun') {
        const count = readU32BE(d, 4)
        let p = 8
        if (flags & 0x01) p += 4
        let firstSampleFlags: number | null = null
        if (flags & 0x04) {
          firstSampleFlags = readU32BE(d, p)
          p += 4
        }
        for (let i = 0; i < count && p <= d.length; i++) {
          let sDur = defDur
          let sFlags = defFlags
          let sCto = 0
          if (flags & 0x100) {
            sDur = readU32BE(d, p)
            p += 4
          }
          if (flags & 0x200) p += 4
          if (flags & 0x400) {
            sFlags = readU32BE(d, p)
            p += 4
          }
          if (flags & 0x800) {
            const raw = readU32BE(d, p)
            sCto = version === 1 ? raw | 0 : raw
            p += 4
          }
          if (i === 0 && firstSampleFlags !== null) sFlags = firstSampleFlags
          if (!seenSample) {
            cto = sCto
            firstFlags = sFlags
            seenSample = true
          }
          dur += sDur
        }
      }
    }
    if (id === trackId && seenSample) {
      return { dts, cto, dur, sync: ((firstFlags ?? 0) & 0x10000) === 0 }
    }
  }
  return null
}

interface SidxRef {
  offset: number
  ticks: number
  sap: boolean
}

export interface Sidx {
  version: number
  trackId: number
  timescale: number
  /** first_offset: the references start this far after the box */
  first: number
  refs: SidxRef[]
  /** Where the references end. */
  end: number
}

function parseSidx(b: Uint8Array, boxEnd: number): Sidx {
  const version = b[0] ?? 0
  const trackId = readU32BE(b, 4)
  const timescale = readU32BE(b, 8) || 1
  let p = 12
  let ept: number
  let first: number
  if (version === 0) {
    ept = readU32BE(b, p)
    first = readU32BE(b, p + 4)
    p += 8
  } else {
    ept = readU64BE(b, p)
    first = readU64BE(b, p + 8)
    p += 16
  }
  const count = ((b[p + 2] ?? 0) << 8) | (b[p + 3] ?? 0)
  p += 4
  const refs: SidxRef[] = []
  let offset = boxEnd + first
  let ticks = ept
  for (let i = 0; i < count && p + 12 <= b.length; i++) {
    const a = readU32BE(b, p)
    const dur = readU32BE(b, p + 4)
    const sap = ((b[p + 8] ?? 0) & 0x80) !== 0
    // hierarchical sidx (reference_type 1) is not followed: its media still starts at `offset`
    refs.push({ offset, ticks, sap })
    offset += a & 0x7fffffff
    ticks += dur
    p += 12
  }
  return { version, trackId, timescale, first, refs, end: offset }
}

/**
 * mov_read_sidx (FFmpeg 9) marks its fragment index complete at a sidx of a known track whose first_offset is 0
 * and whose references end at EOF, or where the mfra trailer starts (its size is the file's last 4 bytes).
 */
export function completesFragmentIndex(
  s: Pick<Sidx, 'version' | 'trackId' | 'first' | 'end'>,
  trackIds: ReadonlySet<number>,
  fileSize: number,
  mfraSize: number | null,
): boolean {
  if (s.version > 1 || !trackIds.has(s.trackId) || s.first !== 0) return false
  return s.end === fileSize || (mfraSize !== null && s.end === fileSize - mfraSize)
}

/**
 * The last top-level box FFmpeg 9's header read takes in (mov_read_default at the root): it reads the boxes in
 * order until it has seen moov and an mdat and its fragment index is complete. -1: all of them, to EOF.
 */
export function openScanEnd(boxes: readonly { type: string; completes?: boolean }[]): number {
  let moov = false
  let mdat = false
  let complete = false
  for (const [i, b] of boxes.entries()) {
    if (b.type === 'moov') moov = true
    else if (b.type === 'mdat') mdat = true
    else if (b.type === 'sidx' && b.completes === true) complete = true
    if (moov && mdat && complete) return i
  }
  return -1
}

export interface Mp4IndexOptions {
  signal?: AbortSignal
  onProgress?: ProgressFn
}

/** Builds the MediaIndex of an MP4/MOV/M4V file, fragmented or not. */
export async function indexMp4(src: ByteSource, opts: Mp4IndexOptions = {}): Promise<MediaIndex> {
  const boxes = await walkBoxes(src, opts.signal, opts.onProgress)
  const moovBox = boxes.find((b) => b.type === 'moov')
  if (!moovBox) throw new Error('no moov box')
  if (moovBox.end - moovBox.pos > MAX_MOOV) throw new Error('moov is larger than 256 MiB')
  const ftypBox = boxes.find((b) => b.type === 'ftyp')
  const moovBytes = await src.read(moovBox.pos, moovBox.end - moovBox.pos)
  const ftypBytes = ftypBox ? await src.read(ftypBox.pos, ftypBox.end - ftypBox.pos) : null
  checkAborted(opts.signal)
  const file = parseMoov(ftypBytes, moovBytes)
  const info = file.getInfo()
  const tracks = tracksOf(file, info.tracks)
  const video = info.videoTracks[0]
  const brands = info.brands.join(' ')
  const isMov = brands.includes('qt  ')
  const fragmented = info.isFragmented || boxes.some((b) => b.type === 'moof')
  const movieDurationMs = info.timescale ? (info.duration * 1000) / info.timescale : 0

  if (fragmented) return indexFragmented(src, boxes, file, { tracks, moovBox, video, movieDurationMs, opts })

  const mdats = boxes.filter((b) => b.type === 'mdat')
  const firstMdat = mdats[0]
  let keyframes: KeyPoint[] = []
  const all: Placed[] = []
  const audioIndexes: AudioIndex[] = []
  let durationMs = movieDurationMs
  const timings = new Map<number, TrackTiming>()
  for (const t of info.tracks) timings.set(t.id, timingOf(t, info.timescale))
  if (video) {
    const tm = timings.get(video.id) ?? timingOf(video, info.timescale)
    const samples = file.getTrackSamplesInfo(video.id)
    keyframes = samples.filter((s) => s.is_sync).map((s) => [msOf(s.cts, tm), s.offset])
    all.push(...placed(samples, tm))
    const last = samples.at(-1)
    if (last && !durationMs) durationMs = msOf(last.cts + last.duration, tm)
  }
  checkAborted(opts.signal)
  const audioSamples = new Map<number, Placed[]>()
  for (const t of info.audioTracks) {
    const p = placed(file.getTrackSamplesInfo(t.id), timings.get(t.id) ?? timingOf(t, info.timescale))
    audioSamples.set(t.id, p)
    all.push(...p)
  }
  all.sort((a, b) => a.t - b.t)
  const interleave = video ? judgeMp4Interleave(all) : 'unknown'
  if (interleave === 'poor') {
    for (const [trackId, p] of audioSamples) audioIndexes.push({ trackId, points: p.map((s) => [s.t, s.off]) })
  }

  // Before seeking, ffmpeg's mov demuxer probes the first media bytes (margins.ts), wherever moov is.
  const mediaBytes = mdats.reduce((n, b) => n + (b.end - b.pos), 0)
  const avgBytesPerSec = durationMs > 0 ? (mediaBytes * 1000) / durationMs : 0
  const margin = headMargin(avgBytesPerSec)
  const moovEnd = moovBox.end
  const faststart = !firstMdat || moovBox.pos < firstMdat.pos
  const openCritical: ByteRange[] = faststart
    ? [[0, moovEnd + margin]]
    : [
        [0, TAIL_HEAD],
        ...boxes.filter((b) => b.pos < moovBox.pos).map((b): ByteRange => [b.pos, b.pos + BOX_HEADER]),
        [firstMdat.pos, firstMdat.pos + firstMdat.headerSize + margin],
        [moovBox.pos, moovEnd],
      ]
  const index: MediaIndex = {
    fileSize: src.size,
    container: isMov ? 'mov' : 'mp4',
    seekMode: 'index',
    interleave,
    multiSegment: false,
    durationMs,
    startMs: 0,
    avgBytesPerSec,
    keyframes,
    openCritical,
    seekCritical: [],
    tracks,
  }
  if (audioIndexes.length) index.audioIndexes = audioIndexes
  return index
}

async function indexFragmented(
  src: ByteSource,
  boxes: Box[],
  file: ISOFile,
  ctx: {
    tracks: TrackInfo[]
    moovBox: Box
    video: Track | undefined
    movieDurationMs: number
    opts: Mp4IndexOptions
  },
): Promise<MediaIndex> {
  const { video, moovBox, opts } = ctx
  const moofs = boxes.filter((b) => b.type === 'moof')
  const mfra = boxes.find((b) => b.type === 'mfra')
  const info = file.getInfo()
  const tm: TrackTiming = video ? timingOf(video, info.timescale) : { timescale: 1000, mediaTime: 0, delayMs: 0 }
  const trex: Trex = { duration: 0, flags: 0 }
  try {
    const t = file.moov.mvex?.trexs.find((x) => x.track_id === video?.id)
    if (t) {
      trex.duration = t.default_sample_duration
      trex.flags = t.default_sample_flags
    }
  } catch {
    // no mvex: defaults stay 0
  }

  // The boxes the open reads (openScanEnd). Only a box in front of the second mdat ends it within the first
  // fragment, so a sidx further on is not read here (one per fragment would double this index's reads).
  // FFmpeg reads the mfra size at the first sidx that does not end at EOF.
  const secondMdat = boxes.filter((b) => b.type === 'mdat')[1]
  const front = secondMdat ? boxes.slice(0, boxes.indexOf(secondMdat)) : boxes
  const sidxAt = new Map<number, Sidx>()
  for (const [i, b] of front.entries()) {
    if (b.type !== 'sidx') continue
    sidxAt.set(i, parseSidx(await src.read(b.pos + b.headerSize, b.end - b.pos - b.headerSize), b.end))
  }
  const mfraSize = sidxAt.size > 0 && src.size >= 4 ? readU32BE(await src.read(src.size - 4, 4), 0) : null
  const trackIds = new Set(info.tracks.map((t) => t.id))
  const scanEnd = openScanEnd(
    front.map((b, i) => {
      const s = sidxAt.get(i)
      return { type: b.type, completes: s !== undefined && completesFragmentIndex(s, trackIds, src.size, mfraSize) }
    }),
  )
  // An open that does not end there walks every fragment: no sidx (S4: fmp4-nosidx, fmp4-mfra), or a sidx per
  // fragment (fmp4-dash), whose last one completes the index. It reads every sidx and moof, and an mdat to its end
  // unless that skip is too long to read on (STREAM_SKIP_BYTES): our 1 s fragments were read whole, 4 MB ones only
  // to the moof. Such a file plays only once (nearly) complete; the whole file is open-critical (ADR 0004 §8.2).
  const scansAll = scanEnd < 0
  const read = front.slice(0, scanEnd + 1)

  let keyframes: KeyPoint[] = []
  let seekMode: MediaIndex['seekMode'] = 'linear'
  if (!scansAll) {
    for (const [i, sidx] of sidxAt) {
      if (i > scanEnd || !video || sidx.trackId !== video.id) continue
      const stm: TrackTiming = { ...tm, timescale: sidx.timescale }
      keyframes = sidx.refs.filter((r) => r.sap).map((r) => [msOf(r.ticks, stm), r.offset])
      seekMode = 'index'
      break
    }
  }

  // The fragment scan also yields the duration, so it runs even with a sidx.
  const fragments: Fragment[] = []
  let lastReport = 0
  for (const m of video ? moofs : []) {
    if (m.end - m.pos > MAX_MOOF) continue
    const body = await src.read(m.pos + m.headerSize, m.end - m.pos - m.headerSize)
    const f = parseMoof(body, video?.id ?? 0, trex)
    if (f?.sync) fragments.push({ pos: m.pos, timeMs: msOf(f.dts + f.cto, tm), endMs: msOf(f.dts + f.dur, tm) })
    else if (f) {
      const prev = fragments.at(-1)
      if (prev) prev.endMs = msOf(f.dts + f.dur, tm)
    }
    if (m.pos - lastReport > 64 * MIB) {
      lastReport = m.pos
      checkAborted(opts.signal)
      opts.onProgress?.(m.pos, src.size)
    }
  }
  if (keyframes.length === 0) keyframes = fragments.map((f) => [f.timeMs, f.pos])

  const durationMs = Math.max(ctx.movieDurationMs, fragments.at(-1)?.endMs ?? 0, keyframes.at(-1)?.[0] ?? 0)
  const mediaBytes = boxes.filter((b) => b.type === 'mdat').reduce((n, b) => n + (b.end - b.pos), 0)
  const avgBytesPerSec = durationMs > 0 ? (mediaBytes * 1000) / durationMs : 0
  // Every box the open reads in front of the first fragment's media: ftyp, moov, the sidx index, the moof.
  // A sidx further on (one per fragment behind an index in front) is read only by a seek that starts at it,
  // as part of a reference readyRange covers: neither open- nor seek-critical (ADR 0004 §8.2).
  const openCritical: ByteRange[] = [[0, moovBox.end]]
  for (const b of read) openCritical.push([b.pos, b.type === 'mdat' ? b.pos + b.headerSize : b.end])
  const firstMoof = moofs[0]
  if (firstMoof) {
    const i = boxes.indexOf(firstMoof)
    const next = boxes[i + 1]
    const end = next?.type === 'mdat' ? next.end : firstMoof.end
    openCritical.push([firstMoof.pos, Math.max(end, firstMoof.pos + headMargin(avgBytesPerSec))])
  }
  // ftyp is read too ([0, moovEnd) above), and the last 4 bytes (bytes=size-4 in S4, fmp4-sidx): the open
  // hangs without them. S4 never saw the mfra itself read; it stays as a small superset (ADR 0004 §6.3).
  openCritical.push([Math.max(0, src.size - FMP4_TAIL), src.size])
  if (mfra) openCritical.push([mfra.pos, src.size])
  return {
    fileSize: src.size,
    container: 'fmp4',
    seekMode,
    interleave: 'unknown',
    multiSegment: false,
    durationMs,
    startMs: 0,
    avgBytesPerSec,
    keyframes,
    openCritical: scansAll ? [[0, src.size]] : openCritical,
    seekCritical: [],
    tracks: ctx.tracks,
  }
}
