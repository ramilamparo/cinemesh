import type {
  ByteRange,
  HdrKind,
  Interleave,
  KeyPoint,
  MediaIndex,
  TrackInfo,
  TrackType,
} from '../../shared/media/types.js'
import { type ByteSource, type ProgressFn, checkAborted } from './byte-source.js'
import { headMargin } from './margins.js'

// Matroska/WebM index (plan §4.3): a streaming EBML reader over positioned reads. It reads element
// headers and the small metadata elements only; Cluster bodies are skipped, never read in full.

export const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  Name: 0x536e,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Colour: 0x55b0,
  TransferCharacteristics: 0x55ba,
  Audio: 0xe1,
  Channels: 0x9f,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  ReferenceBlock: 0xfb,
  Attachments: 0x1941a469,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Void: 0xec,
  CRC32: 0xbf,
} as const

const LEVEL1 = new Set<number>([
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cues,
  ID.Cluster,
  ID.Attachments,
  ID.Tags,
  ID.Chapters,
  ID.Segment,
  ID.EBML,
])

const KIB = 1024
const MAX_META_BYTES = 64 * 1024 * 1024 // Cues of a long film are a few MB; anything larger is not trusted
const SAMPLE_BYTES = 1024 * KIB
const MAX_HEAD_BLOCKS = 64

export interface ElementHeader {
  id: number
  pos: number
  dataPos: number
  /** null: unknown size (live streams); the element then ends where its parent does. */
  size: number | null
  end: number
}

function vintLength(first: number | undefined): number {
  if (!first) return 0
  return Math.clz32(first) - 23
}

/** Reads an element header at pos; null when the bytes there cannot be an element inside `limit`. */
export async function readHeader(src: ByteSource, pos: number, limit: number): Promise<ElementHeader | null> {
  if (pos >= limit) return null
  const b = await src.read(pos, 12)
  const idLen = vintLength(b[0])
  if (idLen < 1 || idLen > 4 || b.length < idLen + 1) return null
  let id = 0
  for (let i = 0; i < idLen; i++) id = id * 256 + (b[i] ?? 0)
  const sizeLen = vintLength(b[idLen])
  if (sizeLen < 1 || sizeLen > 8 || b.length < idLen + sizeLen) return null
  let size = (b[idLen] ?? 0) & (0xff >> sizeLen)
  let allOnes = size === 0xff >> sizeLen
  for (let i = 1; i < sizeLen; i++) {
    const v = b[idLen + i] ?? 0
    if (v !== 0xff) allOnes = false
    size = size * 256 + v
  }
  const dataPos = pos + idLen + sizeLen
  if (dataPos > limit) return null
  if (allOnes) return { id, pos, dataPos, size: null, end: limit }
  return { id, pos, dataPos, size, end: Math.min(limit, dataPos + size) }
}

/** Iterates child headers in [start, end). Stops at the first malformed header (truncation). */
export async function* children(src: ByteSource, start: number, end: number): AsyncGenerator<ElementHeader> {
  let pos = start
  while (pos < end) {
    const h = await readHeader(src, pos, end)
    if (!h) return
    yield h
    if (h.size === null) return
    pos = h.dataPos + h.size
  }
}

async function readData(src: ByteSource, h: ElementHeader, max = MAX_META_BYTES): Promise<Uint8Array> {
  const len = h.end - h.dataPos
  if (len > max) throw new Error(`element 0x${h.id.toString(16)} is too large (${len} bytes)`)
  return src.read(h.dataPos, len)
}

function uintOf(b: Uint8Array): number {
  let v = 0
  for (const x of b) v = v * 256 + x
  return v
}

function floatOf(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  if (b.length === 4) return dv.getFloat32(0)
  if (b.length === 8) return dv.getFloat64(0)
  return 0
}

function stringOf(b: Uint8Array): string {
  const nul = b.indexOf(0)
  return new TextDecoder().decode(nul >= 0 ? b.subarray(0, nul) : b)
}

/** Parses an in-memory master element body into its direct children. */
function* parseChildren(b: Uint8Array): Generator<{ id: number; data: Uint8Array }> {
  let p = 0
  while (p < b.length) {
    const idLen = vintLength(b[p])
    if (idLen < 1 || idLen > 4) return
    let id = 0
    for (let i = 0; i < idLen; i++) id = id * 256 + (b[p + i] ?? 0)
    const sizeLen = vintLength(b[p + idLen])
    if (sizeLen < 1 || sizeLen > 8) return
    let size = (b[p + idLen] ?? 0) & (0xff >> sizeLen)
    for (let i = 1; i < sizeLen; i++) size = size * 256 + (b[p + idLen + i] ?? 0)
    const start = p + idLen + sizeLen
    if (start > b.length) return
    const end = Math.min(b.length, start + size)
    yield { id, data: b.subarray(start, end) }
    p = end
  }
}

function childMap(b: Uint8Array): Map<number, Uint8Array> {
  const m = new Map<number, Uint8Array>()
  for (const { id, data } of parseChildren(b)) if (!m.has(id)) m.set(id, data)
  return m
}

interface Block {
  track: number
  rel: number
  keyframe: boolean | null
}

/** Track number, relative timestamp and keyframe flag of a SimpleBlock or Block body. */
function blockHeader(b: Uint8Array, simple: boolean): Block | null {
  const len = vintLength(b[0])
  if (len < 1 || len > 8 || b.length < len + 3) return null
  let track = (b[0] ?? 0) & (0xff >> len)
  for (let i = 1; i < len; i++) track = track * 256 + (b[i] ?? 0)
  const rel = new DataView(b.buffer, b.byteOffset + len, 2).getInt16(0)
  const flags = b[len + 2] ?? 0
  return { track, rel, keyframe: simple ? (flags & 0x80) !== 0 : null }
}

function trackTypeOf(v: number): TrackType {
  if (v === 1) return 'video'
  if (v === 2) return 'audio'
  if (v === 0x11) return 'subtitle'
  return 'other'
}

function parseTrack(b: Uint8Array): TrackInfo {
  const m = childMap(b)
  const get = (id: number) => m.get(id)
  const video = get(ID.Video)
  const vm = video ? childMap(video) : new Map<number, Uint8Array>()
  const colour = vm.get(ID.Colour)
  const transfer = colour ? childMap(colour).get(ID.TransferCharacteristics) : undefined
  const tc = transfer ? uintOf(transfer) : 0
  const audio = get(ID.Audio)
  const channels = audio ? childMap(audio).get(ID.Channels) : undefined
  const flag = (id: number, dflt: boolean) => {
    const v = get(id)
    return v ? uintOf(v) !== 0 : dflt
  }
  const str = (id: number) => {
    const v = get(id)
    return v ? stringOf(v) : ''
  }
  const width = vm.get(ID.PixelWidth)
  const height = vm.get(ID.PixelHeight)
  const tn = get(ID.TrackNumber)
  const tt = get(ID.TrackType)
  const hdr: HdrKind = tc === 16 ? 'pq' : tc === 18 ? 'hlg' : 'none'
  return {
    id: tn ? uintOf(tn) : 0,
    type: trackTypeOf(tt ? uintOf(tt) : 0),
    codec: str(ID.CodecID),
    lang: str(ID.LanguageBCP47) || str(ID.Language) || 'eng',
    name: str(ID.Name),
    isDefault: flag(ID.FlagDefault, true),
    forced: flag(ID.FlagForced, false),
    hdr,
    channels: channels ? uintOf(channels) : 0,
    width: width ? uintOf(width) : 0,
    height: height ? uintOf(height) : 0,
  }
}

export interface MkvLayout {
  docType: string
  segmentDataPos: number
  segmentEnd: number
  firstCluster: number | null
  /** Level-1 elements found by walking up to the first Cluster and through the SeekHead(s). */
  level1: ElementHeader[]
  multiSegment: boolean
  truncated: boolean
}

export interface MkvIndexOptions {
  signal?: AbortSignal
  onProgress?: ProgressFn
  durationHintMs?: number
}

/** Walks the EBML header, the first Segment, its level-1 elements before the first Cluster and the SeekHeads. */
export async function readMkvLayout(src: ByteSource): Promise<MkvLayout> {
  const ebml = await readHeader(src, 0, src.size)
  if (ebml?.id !== ID.EBML) throw new Error('not an EBML file')
  const docType = childMap(await readData(src, ebml, 4096)).get(ID.DocType)
  let pos = ebml.end
  let seg: ElementHeader | null = null
  while (pos < src.size) {
    const h = await readHeader(src, pos, src.size)
    if (!h) break
    if (h.id === ID.Segment) {
      seg = h
      break
    }
    if (h.size === null) break
    pos = h.end
  }
  if (!seg) throw new Error('no Segment element')
  const truncated = seg.size !== null && seg.dataPos + seg.size > src.size
  const segEnd = seg.end
  const found = new Map<number, ElementHeader>()
  const level1: ElementHeader[] = []
  const add = (h: ElementHeader) => {
    if (found.has(h.pos)) return
    found.set(h.pos, h)
    level1.push(h)
  }
  let firstCluster: number | null = null
  for await (const h of children(src, seg.dataPos, segEnd)) {
    if (h.id === ID.Cluster) {
      firstCluster = h.pos
      break
    }
    add(h)
    if (h.size === null) break
  }

  const visited = new Set<number>()
  const seekHeads = level1.filter((h) => h.id === ID.SeekHead)
  while (seekHeads.length) {
    const sh = seekHeads.shift()
    if (!sh || visited.has(sh.pos)) continue
    visited.add(sh.pos)
    for (const { id, data } of parseChildren(await readData(src, sh))) {
      if (id !== ID.Seek) continue
      const m = childMap(data)
      const sid = m.get(ID.SeekID)
      const sp = m.get(ID.SeekPosition)
      if (!sid || !sp) continue
      const target = seg.dataPos + uintOf(sp)
      if (target >= segEnd || found.has(target)) continue
      const h = await readHeader(src, target, segEnd)
      if (h?.id !== uintOf(sid) || !LEVEL1.has(h.id) || h.id === ID.Cluster) continue
      add(h)
      if (h.id === ID.SeekHead) seekHeads.push(h)
    }
  }

  let multiSegment = false
  if (seg.size !== null && !truncated) {
    for await (const h of children(src, segEnd, src.size)) {
      if (h.id === ID.Segment) multiSegment = true
      if (h.id !== ID.Void && h.id !== ID.CRC32) break
    }
  }
  level1.sort((a, b) => a.pos - b.pos)
  return {
    docType: docType ? stringOf(docType) : 'matroska',
    segmentDataPos: seg.dataPos,
    segmentEnd: segEnd,
    firstCluster,
    level1,
    multiSegment,
    truncated,
  }
}

interface ClusterHead {
  pos: number
  end: number
  timestamp: number
  /** Timestamp of the cluster's first video block when that block is a keyframe, else null. */
  keyTime: number | null
}

// Reads the Cluster Timestamp and the block headers up to the first video block. Clusters may open
// with audio, so the keyframe time is the video block's, not the cluster's. For an unknown-size
// Cluster (live recordings) the end is where the next level-1 element starts.
async function readClusterHead(
  src: ByteSource,
  h: ElementHeader,
  videoTrack: number,
  limit: number,
): Promise<ClusterHead> {
  let timestamp = 0
  let keyTime: number | null = null
  let videoSeen = false
  let end = h.end
  let blocks = 0
  for await (const c of children(src, h.dataPos, h.size === null ? limit : h.end)) {
    if (h.size === null && LEVEL1.has(c.id)) {
      end = c.pos
      break
    }
    if (c.id === ID.Timestamp) timestamp = uintOf(await readData(src, c, 8))
    else if (!videoSeen && blocks < MAX_HEAD_BLOCKS && (c.id === ID.SimpleBlock || c.id === ID.BlockGroup)) {
      blocks++
      const blk = await firstBlock(src, c)
      if (blk?.track === videoTrack) {
        videoSeen = true
        if (blk.keyframe) keyTime = timestamp + blk.rel
      }
    }
    if (h.size === null) end = c.size === null ? limit : c.dataPos + c.size
    else if (videoSeen || blocks >= MAX_HEAD_BLOCKS) break
  }
  return { pos: h.pos, end, timestamp, keyTime }
}

async function firstBlock(src: ByteSource, c: ElementHeader): Promise<Block | null> {
  if (c.id === ID.SimpleBlock) return blockHeader(await src.read(c.dataPos, 16), true)
  const body = await src.read(c.dataPos, Math.min(c.end - c.dataPos, 64 * KIB))
  let blk: Block | null = null
  let hasRef = false
  for (const { id, data } of parseChildren(body)) {
    if (id === ID.Block) blk = blockHeader(data.subarray(0, 16), false)
    if (id === ID.ReferenceBlock) hasRef = true
  }
  return blk ? { ...blk, keyframe: !hasRef } : null
}

/** Block times (scaled to ms) per track in a window read from a Cluster position, for interleave sampling. */
async function sampleBlocks(
  src: ByteSource,
  pos: number,
  limit: number,
  scaleMs: number,
): Promise<Map<number, [number, number]>> {
  const out = new Map<number, [number, number]>()
  const stop = Math.min(limit, pos + SAMPLE_BYTES)
  let clusterTs = 0
  for await (const h of children(src, pos, stop)) {
    if (h.id !== ID.Cluster) break
    for await (const c of children(src, h.dataPos, Math.min(h.end, stop))) {
      if (c.id === ID.Timestamp) clusterTs = uintOf(await readData(src, c, 8))
      if (c.id !== ID.SimpleBlock && c.id !== ID.BlockGroup) continue
      const blk = await firstBlock(src, c)
      if (!blk) continue
      const t = (clusterTs + blk.rel) * scaleMs
      const r = out.get(blk.track)
      if (r) {
        r[0] = Math.min(r[0], t)
        r[1] = Math.max(r[1], t)
      } else out.set(blk.track, [t, t])
    }
    if (h.size === null) break
  }
  return out
}

function judgeInterleave(samples: Map<number, [number, number]>[], video: number, audio: number[]): Interleave {
  let judged = 0
  for (const s of samples) {
    const v = s.get(video)
    if (!v || v[1] - v[0] < 1000) continue
    judged++
    for (const a of audio) {
      const r = s.get(a)
      if (!r || r[1] < v[0] - 2000 || r[0] > v[1] + 2000) return 'poor'
    }
  }
  return judged > 0 ? 'good' : 'unknown'
}

/** Builds the MediaIndex of a Matroska or WebM file. */
export async function indexMkv(src: ByteSource, opts: MkvIndexOptions = {}): Promise<MediaIndex> {
  const layout = await readMkvLayout(src)
  const { segmentDataPos, segmentEnd, level1 } = layout
  const first = (id: number) => level1.find((h) => h.id === id)

  let scaleNs = 1_000_000
  let durationMs = 0
  const info = first(ID.Info)
  if (info) {
    const m = childMap(await readData(src, info))
    const ts = m.get(ID.TimestampScale)
    if (ts) scaleNs = uintOf(ts) || scaleNs
    const d = m.get(ID.Duration)
    if (d) durationMs = (floatOf(d) * scaleNs) / 1e6
  }
  const scaleMs = scaleNs / 1e6

  const tracks: TrackInfo[] = []
  const tracksEl = first(ID.Tracks)
  if (tracksEl) {
    for (const { id, data } of parseChildren(await readData(src, tracksEl))) {
      if (id === ID.TrackEntry) tracks.push(parseTrack(data))
    }
  }
  const videoTrack = tracks.find((t) => t.type === 'video')?.id ?? 0
  const audioTracks = tracks.filter((t) => t.type === 'audio').map((t) => t.id)

  let startMs = 0
  let firstHead: ClusterHead | null = null
  if (layout.firstCluster !== null) {
    const h = await readHeader(src, layout.firstCluster, segmentEnd)
    if (h) firstHead = await readClusterHead(src, h, videoTrack, segmentEnd)
    startMs = (firstHead?.timestamp ?? 0) * scaleMs
  }

  const cuesEl = first(ID.Cues)
  const points: KeyPoint[] = []
  if (cuesEl && cuesEl.size !== null) {
    checkAborted(opts.signal)
    for (const { id, data } of parseChildren(await readData(src, cuesEl))) {
      if (id !== ID.CuePoint) continue
      let time: number | null = null
      let cluster: number | null = null
      for (const c of parseChildren(data)) {
        if (c.id === ID.CueTime) time = uintOf(c.data)
        if (c.id === ID.CueTrackPositions && cluster === null) {
          const m = childMap(c.data)
          const track = m.get(ID.CueTrack)
          const cp = m.get(ID.CueClusterPosition)
          if (track && cp && uintOf(track) === videoTrack) cluster = uintOf(cp)
        }
      }
      if (time !== null && cluster !== null) points.push([time * scaleMs - startMs, segmentDataPos + cluster])
    }
  }
  let seekMode: MediaIndex['seekMode'] = 'index'
  let lastClusterEnd = segmentEnd
  const clusters: ClusterHead[] = []
  if (points.length === 0) {
    seekMode = 'linear'
    if (firstHead) {
      clusters.push(firstHead)
      let pos = firstHead.end
      let lastReport = 0
      while (pos < segmentEnd) {
        const h = await readHeader(src, pos, segmentEnd)
        if (!h) break
        if (h.id === ID.Cluster) {
          const head = await readClusterHead(src, h, videoTrack, segmentEnd)
          clusters.push(head)
          pos = head.end
        } else if (h.size === null) break
        else pos = h.end
        if (pos - lastReport > 64 * 1024 * 1024) {
          lastReport = pos
          checkAborted(opts.signal)
          opts.onProgress?.(pos, src.size)
        }
      }
      lastClusterEnd = pos
    }
    for (const c of clusters) if (c.keyTime !== null) points.push([c.keyTime * scaleMs - startMs, c.pos])
  }

  if (durationMs <= 0) {
    const last = clusters.at(-1)
    if (last) {
      const s = await sampleBlocks(src, last.pos, Math.min(segmentEnd, lastClusterEnd), scaleMs)
      durationMs = Math.max(0, ...[...s.values()].map(([, b]) => b)) - startMs
    }
    if (durationMs <= 0) durationMs = opts.durationHintMs ?? points.at(-1)?.[0] ?? 0
  }

  // open-critical: the head through the first Cluster (plus a margin of media, margins.ts), and every
  // level-1 element after the clusters other than Cues: mpv reads Tags, Attachments (fonts) and
  // Chapters when it opens the file. Cues are seek-critical.
  const fc = layout.firstCluster ?? src.size
  const contentBytes = Math.max(0, Math.min(lastClusterEnd, src.size) - fc)
  const avgBytesPerSec = durationMs > 0 ? (contentBytes * 1000) / durationMs : 0
  const openCritical: ByteRange[] = [[0, fc + headMargin(avgBytesPerSec)]]
  const seekCritical: ByteRange[] = []
  for (const h of level1) {
    const end = h.size === null ? h.end : h.dataPos + h.size
    if (h.id === ID.Cues) seekCritical.push([h.pos, end])
    else if (h.pos >= fc) openCritical.push([h.pos, end])
  }

  let interleave: Interleave = 'unknown'
  const refs = points.length ? points : clusters.map((c): KeyPoint => [c.timestamp, c.pos])
  if (refs.length && videoTrack) {
    const samples = []
    for (const f of [0.25, 0.5, 0.75]) {
      const ref = refs[Math.min(refs.length - 1, Math.floor(refs.length * f))]
      if (ref) samples.push(await sampleBlocks(src, ref[1], segmentEnd, scaleMs))
    }
    interleave = judgeInterleave(samples, videoTrack, audioTracks)
  }

  return {
    fileSize: src.size,
    container: layout.docType === 'webm' ? 'webm' : 'mkv',
    seekMode,
    interleave,
    multiSegment: layout.multiSegment,
    durationMs,
    startMs,
    avgBytesPerSec,
    keyframes: points,
    openCritical,
    seekCritical,
    tracks,
  }
}
