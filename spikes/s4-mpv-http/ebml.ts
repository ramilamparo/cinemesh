// Minimal EBML/Matroska walker: level-0/1 layout, SeekHead entries, Info, Cues, Cluster offsets.
import { openSync, readSync, fstatSync, closeSync } from 'node:fs'

export const ID = {
  EBML: 0x1a45dfa3, Segment: 0x18538067, SeekHead: 0x114d9b74, Seek: 0x4dbb, SeekID: 0x53ab,
  SeekPosition: 0x53ac, Info: 0x1549a966, TimestampScale: 0x2ad7b1, Duration: 0x4489,
  Tracks: 0x1654ae6b, Cluster: 0x1f43b675, Timestamp: 0xe7, Cues: 0x1c53bb6b, Tags: 0x1254c367,
  Attachments: 0x1941a469, Chapters: 0x1043a770, Void: 0xec, CRC32: 0xbf,
  CuePoint: 0xbb, CueTime: 0xb3, CueTrackPositions: 0xb7, CueTrack: 0xf7, CueClusterPosition: 0xf1,
} as const
export const NAME: Record<number, string> = Object.fromEntries(Object.entries(ID).map(([k, v]) => [v, k]))

export interface El { id: number, name: string, pos: number, dataPos: number, size: number | null, end: number }

export class Reader {
  fd: number
  size: number
  constructor (path: string) { this.fd = openSync(path, 'r'); this.size = fstatSync(this.fd).size }
  read (pos: number, len: number) {
    const b = Buffer.alloc(Math.max(0, Math.min(len, this.size - pos)))
    readSync(this.fd, b, 0, b.length, pos)
    return b
  }
  close () { closeSync(this.fd) }
  // Reads one element header at pos.
  header (pos: number): El {
    const b = this.read(pos, 16)
    const idLen = vintLen(b[0])
    let id = 0
    for (let i = 0; i < idLen; i++) id = id * 256 + b[i]
    const sLen = vintLen(b[idLen])
    let size = b[idLen] & (0xff >> sLen)
    let allOnes = size === (0xff >> sLen)
    for (let i = 1; i < sLen; i++) { size = size * 256 + b[idLen + i]; if (b[idLen + i] !== 0xff) allOnes = false }
    const dataPos = pos + idLen + sLen
    const s = allOnes ? null : size
    return { id, name: NAME[id] ?? '0x' + id.toString(16), pos, dataPos, size: s, end: s === null ? this.size : dataPos + s }
  }
  children (parent: { dataPos: number, end: number }, unknownSizeStopIds: number[] = []): El[] {
    const out: El[] = []
    let p = parent.dataPos
    while (p < parent.end && p < this.size) {
      const e = this.header(p)
      if (e.size === null) {
        // unknown-size child (live Cluster): scan to the next level-1 id
        e.end = this.scanToLevel1(e.dataPos, unknownSizeStopIds)
      }
      out.push(e)
      if (e.end <= p) break
      p = e.end
    }
    return out
  }
  // Scans byte-by-byte for a level-1 id (used only for unknown-size clusters).
  scanToLevel1 (from: number, ids: number[]): number {
    const want = ids.map(i => Buffer.from(i.toString(16), 'hex'))
    for (let p = from; p < this.size; p += 1 << 20) {
      const b = this.read(p, (1 << 20) + 4)
      for (let i = 0; i < Math.min(b.length - 4, 1 << 20); i++) {
        for (const w of want) if (b[i] === w[0] && b.subarray(i, i + 4).equals(w)) return p + i
      }
    }
    return this.size
  }
  uint (e: El) { const b = this.read(e.dataPos, e.size!); let v = 0; for (const x of b) v = v * 256 + x; return v }
  float (e: El) { const b = this.read(e.dataPos, e.size!); return e.size === 4 ? b.readFloatBE(0) : b.readDoubleBE(0) }
}

export function vintLen (first: number) {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1
  throw new Error('bad vint')
}

export interface MkvLayout {
  segmentDataPos: number
  segmentSize: number | null
  level1: { name: string, pos: number, end: number, sizeKnown: boolean }[]
  seekHead: { id: string, pos: number }[]
  firstCluster: number
  lastClusterEnd: number
  clusters: { pos: number, end: number, tsMs: number }[]
  durationMs: number | null
  cues: { tMs: number, track: number, clusterPos: number }[]
}

export function readMkv (path: string): MkvLayout {
  const r = new Reader(path)
  try {
    const top = r.children({ dataPos: 0, end: r.size })
    const seg = top.find(e => e.id === ID.Segment)!
    const l1ids = [ID.Cluster, ID.Cues, ID.Tags, ID.Attachments, ID.Chapters, ID.SeekHead, ID.Info, ID.Tracks]
    const kids = r.children(seg, l1ids)
    const out: MkvLayout = {
      segmentDataPos: seg.dataPos, segmentSize: seg.size, level1: [], seekHead: [], firstCluster: -1,
      lastClusterEnd: -1, clusters: [], durationMs: null, cues: [],
    }
    let tsScale = 1000000
    for (const e of kids) {
      if (e.id !== ID.Cluster) out.level1.push({ name: e.name, pos: e.pos, end: e.end, sizeKnown: e.size !== null })
      if (e.id === ID.SeekHead) {
        for (const s of r.children(e)) {
          if (s.id !== ID.Seek) continue
          let id = 0; let pos = 0
          for (const f of r.children(s)) {
            if (f.id === ID.SeekID) id = r.uint(f)
            if (f.id === ID.SeekPosition) pos = r.uint(f)
          }
          out.seekHead.push({ id: NAME[id] ?? id.toString(16), pos: seg.dataPos + pos })
        }
      } else if (e.id === ID.Info) {
        let dur: number | null = null
        for (const f of r.children(e)) {
          if (f.id === ID.TimestampScale) tsScale = r.uint(f)
          if (f.id === ID.Duration) dur = r.float(f)
        }
        out.durationMs = dur === null ? null : dur * tsScale / 1e6
      } else if (e.id === ID.Cluster) {
        if (out.firstCluster < 0) out.firstCluster = e.pos
        out.lastClusterEnd = e.end
        let ts = r.header(e.dataPos)
        if (ts.id === ID.CRC32) ts = r.header(ts.end)
        out.clusters.push({ pos: e.pos, end: e.end, tsMs: ts.id === ID.Timestamp ? r.uint(ts) * tsScale / 1e6 : NaN })
      } else if (e.id === ID.Cues) {
        for (const cp of r.children(e)) {
          if (cp.id !== ID.CuePoint) continue
          let t = 0; let track = 0; let cl = 0
          for (const f of r.children(cp)) {
            if (f.id === ID.CueTime) t = r.uint(f)
            if (f.id === ID.CueTrackPositions) {
              for (const g of r.children(f)) {
                if (g.id === ID.CueTrack) track = r.uint(g)
                if (g.id === ID.CueClusterPosition) cl = r.uint(g)
              }
            }
          }
          out.cues.push({ tMs: t * tsScale / 1e6, track, clusterPos: seg.dataPos + cl })
        }
      }
    }
    // Clusters are not in level1 (too many); summarise them.
    return out
  } finally { r.close() }
}

export function encodeId (id: number) { return Buffer.from(id.toString(16).padStart(2, '0'), 'hex') }
export function encodeSize (n: number, width = 8) {
  const b = Buffer.alloc(width)
  let v = n
  for (let i = width - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256) }
  b[0] |= 0x80 >> (width - 1)
  return b
}
export function element (id: number, data: Buffer, sizeWidth = 8) {
  return Buffer.concat([encodeId(id), encodeSize(data.length, sizeWidth), data])
}
export function uintData (n: number, width = 8) {
  const b = Buffer.alloc(width); let v = n
  for (let i = width - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256) }
  return b
}
// A Void element of exactly `total` bytes (total >= 2).
export function voidOf (total: number) {
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const data = total - 1 - w
    if (data >= 0 && data < 2 ** (7 * w) - 1) return Buffer.concat([Buffer.from([0xec]), encodeSize(data, w), Buffer.alloc(data)])
  }
  throw new Error('void too large')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const l = readMkv(process.argv[2])
  const { clusters, cues, ...rest } = l
  console.log(JSON.stringify({ ...rest, clusterCount: clusters.length, firstClusters: clusters.slice(0, 3), cueCount: cues.length, firstCues: cues.slice(0, 3) }, null, 1))
}
