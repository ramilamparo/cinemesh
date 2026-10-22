// Derives the plan §4.3 critical ranges for each fixture and writes golden JSON
// (data/<fixture>.ranges.json and golden/<fixture>.ranges.json).
// Usage: npx tsx ranges.ts [fixture ...]
import { execFileSync } from 'node:child_process'
import { statSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readMkv } from './ebml.js'
import { topBoxes, readSidx } from './mp4.js'

export type Range = [number, number]
export const DATA = new URL('./data/', import.meta.url).pathname
export const GOLDEN = new URL('./golden/', import.meta.url).pathname
export const FIXTURES = ['mkv-cues.mkv', 'mkv-nocues.mkv', 'mkv-tail.mkv', 'mp4-faststart.mp4', 'mp4-tailmoov.mp4', 'fmp4-sidx.mp4', 'fmp4-nosidx.mp4', 'fmp4-mfra.mp4', 'avi.avi']
const KiB = 1024
const MiB = 1024 * KiB

export interface Golden {
  file: string
  size: number
  pieceLength: number
  container: 'mkv' | 'mp4' | 'fmp4' | 'generic'
  seekMode: 'index' | 'linear'
  durationMs: number
  layout: unknown
  openCritical: Range[] // plan §4.3 table
  openCriticalFixed: Range[] // what S4 found mpv 0.41 / FFmpeg 9 actually needs (see ADR 0004)
  seekCritical: Range[]
  keyframes: [number, number][] // [ptsMs, pos] of video keyframes
  // key: target ms, aheadS = 6. plan = §4.3 rule; fixed = S4 rule; allStreams = plan window over every packet
  readyRange: Record<string, { plan: Range, fixed: Range, allStreams: Range }>
}

export function pieceLength (size: number) {
  let p = MiB
  while (Math.ceil(size / p) > 16384 && p < 4 * MiB) p *= 2
  return p
}
export function merge (rs: Range[]): Range[] {
  const s = rs.filter(r => r[1] > r[0]).sort((a, b) => a[0] - b[0])
  const out: Range[] = []
  for (const r of s) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push([r[0], r[1]])
  }
  return out
}
export function roundOut (rs: Range[], P: number, size: number): Range[] {
  return merge(rs.map(([a, b]) => [Math.floor(a / P) * P, Math.min(size, Math.ceil(b / P) * P)]))
}

interface Pkt { s: number, t: number, pos: number, size: number, key: boolean }
function packets (path: string): Pkt[] {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'packet=stream_index,pts_time,dts_time,pos,size,flags', '-of', 'csv=p=0', path], { maxBuffer: 1 << 28 }).toString()
  const res: Pkt[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [s, pts, dts, size, pos, flags] = line.split(',')
    const t = pts !== 'N/A' ? Number(pts) : Number(dts)
    res.push({ s: Number(s), t: t * 1000, pos: Number(pos), size: Number(size), key: flags.startsWith('K') })
  }
  return res
}

export function derive (file: string): Golden {
  const path = join(DATA, file)
  const size = statSync(path).size
  const P = pieceLength(size)
  const pk = packets(path)
  const video = pk.filter(p => p.s === 0)
  const kfs = video.filter(p => p.key).map(p => [Math.round(p.t), p.pos] as [number, number]).sort((a, b) => a[0] - b[0])
  const durationMs = Math.max(...video.map(p => p.t))
  let container: Golden['container'] = 'generic'
  let seekMode: Golden['seekMode'] = 'index'
  let open: Range[] = []
  let seek: Range[] = []
  let layout: unknown = null
  let clusterStart = (pos: number) => pos
  let moofStart = (pos: number) => pos
  let openFixedExtra: Range[] = []
  if (file.endsWith('.mkv')) {
    container = 'mkv'
    const l = readMkv(path)
    const { clusters, cues, ...rest } = l
    layout = { ...rest, clusterCount: clusters.length, cueCount: cues.length }
    open.push([0, l.firstCluster + 256 * KiB])
    for (const e of l.level1) if (e.pos >= l.lastClusterEnd && e.name !== 'Cues' && e.name !== 'Void') open.push([e.pos, e.end])
    const cuesEl = l.level1.find(e => e.name === 'Cues')
    if (cuesEl) seek.push([cuesEl.pos, cuesEl.end]); else seekMode = 'linear'
    const starts = clusters.map(c => c.pos)
    clusterStart = (pos: number) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= pos) lo = m; else hi = m - 1 } return starts[lo] }
  } else if (file.endsWith('.mp4')) {
    const boxes = topBoxes(path)
    const moov = boxes.find(b => b.type === 'moov')!
    const moofs = boxes.filter(b => b.type === 'moof')
    layout = { boxes: boxes.filter(b => b.type !== 'moof' && b.type !== 'mdat').concat(boxes.filter(b => b.type === 'mdat').slice(0, 1)), moofCount: moofs.length }
    if (moofs.length) {
      container = 'fmp4'
      open.push([moov.pos, moov.end])
      // FFmpeg's mov demuxer also reads ftyp and the last 4 bytes (mfro) at open
      openFixedExtra = [[0, moov.end], [size - 16, size]]
      const mp = moofs.map(b => b.pos)
      moofStart = (pos: number) => mp.filter(x => x <= pos).at(-1) ?? 0
      const sidx = boxes.filter(b => b.type === 'sidx')
      for (const s of sidx) open.push([s.pos, s.end])
      const i = boxes.indexOf(moofs[0])
      open.push([moofs[0].pos, boxes[i + 1].end])
      // Without sidx FFmpeg 9 reads every moof to EOF at open, even when an mfra/tfra trailer
      // indexes the fragments (fmp4-mfra.mp4), so open-critical becomes the whole file (below).
      if (!sidx.length) seekMode = 'linear'
      else (layout as any).sidxRefs = sidx.map(s => readSidx(path, s).length)
    } else if (moov.pos < boxes.find(b => b.type === 'mdat')!.pos) {
      container = 'mp4'
      open.push([0, moov.end + 256 * KiB])
    } else {
      container = 'mp4'
      open.push([0, 64 * KiB])
      for (const b of boxes) if (b.pos < moov.pos) open.push([b.pos, b.pos + 16])
      open.push([moov.pos, moov.end])
    }
  } else {
    const n = Math.ceil(size / P)
    open.push([0, P], [(n - 2) * P, size])
  }
  open = merge(open.map(([a, b]) => [a, Math.min(b, size)]))
  const openFixed = merge([...open, ...openFixedExtra])
  if (container === 'fmp4' && seekMode === 'linear') openFixed.splice(0, openFixed.length, [0, size]) // FFmpeg scans every moof at open
  const audio = [...new Set(pk.filter(p => p.s !== 0).map(p => p.s))].map(s => pk.filter(p => p.s === s && p.pos >= 0).sort((a, b) => a.t - b.t))
  const ready = (pMs: number, aheadMs = 6000) => {
    const loT = container === 'mkv' ? pMs - 2000 : pMs
    const before = kfs.filter(k => k[0] <= loT)
    const loKf = before.length ? before[before.length - 1] : kfs[0]
    const after = kfs.find(k => k[0] > pMs + aheadMs)
    const lo = seekMode === 'linear' ? 0 : container === 'mkv' ? clusterStart(loKf[1]) : loKf[1]
    const hi = after ? (container === 'mkv' ? clusterStart(after[1]) : after[1]) : size
    // Same time window, but over every packet of every stream (the interleave check).
    const inWin = pk.filter(p => p.t >= loKf[0] && p.t < (after ? after[0] : Infinity) && p.pos >= 0)
    const allLo = seekMode === 'linear' ? 0 : Math.min(lo, ...inWin.map(p => p.pos))
    const allHi = Math.max(hi, ...inWin.map(p => p.pos + p.size))
    // S4 rule: keyframe at or before p − 0.25 s (mpv/lavf pick the previous GOP when p is exactly
    // on an MP4 keyframe); start at the earliest of that keyframe and, per audio stream, the last
    // packet with pts ≤ keyframe pts − 0.25 s (lavf seeks each stream to the keyframe dts); fMP4 starts at the moof; MKV at
    // the cluster; AVI 8 bytes earlier (chunk header). hi covers every stream up to the hi keyframe.
    const fk = (container === 'mkv' ? before : kfs.filter(k => k[0] <= pMs - 250)).at(-1) ?? kfs[0]
    let fLo = fk[1]
    for (const a of audio) { const last = a.filter(x => x.t <= fk[0] - 250).at(-1); if (last) fLo = Math.min(fLo, last.pos) }
    fLo = seekMode === 'linear' ? 0 : container === 'mkv' ? clusterStart(fk[1]) : container === 'fmp4' ? moofStart(fLo) : container === 'generic' ? fLo - 8 : fLo
    const fixed: Range = [Math.max(0, fLo), allHi]
    return { plan: [lo, hi] as Range, fixed, allStreams: [allLo, allHi] as Range }
  }
  const half = Math.round(durationMs / 2 / 1000) * 1000
  return {
    file, size, pieceLength: P, container, seekMode, durationMs, layout,
    openCritical: open, openCriticalFixed: openFixed, seekCritical: seek, keyframes: kfs,
    readyRange: { 0: ready(0), [half]: ready(half), 20000: ready(20000) },
  }
}

export function loadGolden (file: string): Golden {
  const p = join(DATA, file + '.ranges.json')
  if (!existsSync(p)) throw new Error(`run ranges.ts first (${p})`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = process.argv.slice(2).length ? process.argv.slice(2) : FIXTURES
  for (const f of list) {
    const g = derive(f)
    const json = JSON.stringify(g, (k, v) => k === 'keyframes' ? v.map((x: number[]) => x.join(':')) : v, 1)
    writeFileSync(join(DATA, f + '.ranges.json'), JSON.stringify(g))
    writeFileSync(join(GOLDEN, f + '.ranges.json'), json + '\n')
    const mb = (r: Range[]) => (r.reduce((a, [x, y]) => a + y - x, 0) / MiB).toFixed(2)
    console.log(f.padEnd(18), g.container, g.seekMode, 'open', JSON.stringify(g.openCritical), mb(g.openCritical), 'MiB; fixed', JSON.stringify(g.openCriticalFixed), '; seek', JSON.stringify(g.seekCritical), '; ready', JSON.stringify(g.readyRange))
  }
}
