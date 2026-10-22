import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

// The S4 rules (ADR 0004 §5), derived from ffprobe's packet list and plain box/chunk walks, so they are
// independent of the code under test. spikes/s4-mpv-http/ranges.ts derives the golden data the same way.

export interface Packet {
  video: boolean
  stream: number
  /** player timeline: pts (dts when there is none) minus the format start time */
  ms: number
  pos: number
  size: number
  key: boolean
}

interface ProbePacket {
  stream_index?: number
  pts_time?: string
  dts_time?: string
  pos?: string
  size?: string
  flags?: string
}

export function probePackets(path: string): Packet[] {
  const json = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=start_time:stream=index,codec_type:packet=stream_index,pts_time,dts_time,pos,size,flags',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const probe = JSON.parse(json) as {
    format?: { start_time?: string }
    streams?: { index?: number; codec_type?: string }[]
    packets?: ProbePacket[]
  }
  const start = Number(probe.format?.start_time ?? 0)
  const video = new Set((probe.streams ?? []).filter((s) => s.codec_type === 'video').map((s) => s.index))
  const out: Packet[] = []
  for (const p of probe.packets ?? []) {
    const t = Number(p.pts_time === undefined || p.pts_time === 'N/A' ? p.dts_time : p.pts_time)
    const pos = Number(p.pos)
    if (!Number.isFinite(t) || !Number.isFinite(pos) || pos < 0) continue
    out.push({
      video: video.has(p.stream_index),
      stream: p.stream_index ?? -1,
      ms: (t - (Number.isFinite(start) ? start : 0)) * 1000,
      pos,
      size: Number(p.size ?? 0),
      key: p.flags?.startsWith('K') ?? false,
    })
  }
  return out
}

export interface TopBox {
  type: string
  pos: number
  end: number
}

/** A plain walk over 32-bit box sizes (no largesize in the fixtures). */
export function topBoxes(path: string): TopBox[] {
  const b = readFileSync(path)
  const out: TopBox[] = []
  for (let p = 0; p + 8 <= b.length;) {
    const size = b.readUInt32BE(p)
    out.push({ type: b.toString('latin1', p + 4, p + 8), pos: p, end: p + size })
    if (size < 8) break
    p += size
  }
  return out
}

/** [start, end) of a top-level RIFF chunk (AVI idx1, ...), header included. */
export function riffChunk(path: string, id: string): [number, number] | null {
  const b = readFileSync(path)
  for (let p = 12; p + 8 <= b.length;) {
    const size = b.readUInt32LE(p + 4)
    if (b.toString('latin1', p, p + 4) === id) return [p, p + 8 + size]
    p += 8 + size + (size & 1)
  }
  return null
}

export type RuleKind = 'mkv' | 'mp4' | 'fmp4' | 'avi'

/** The video keyframe mpv seeks to for pMs: at or before p − 2 s for MKV (subtitle preroll), p − 250 ms else. */
export function seekKeyframe(kind: RuleKind, packets: readonly Packet[], pMs: number): Packet {
  const kfs = packets.filter((p) => p.video && p.key).sort((a, b) => a.ms - b.ms)
  const first = kfs[0]
  if (!first) throw new Error('no video keyframes')
  const pre = kind === 'mkv' ? 2000 : 250
  return kfs.filter((k) => k.ms <= pMs - pre).at(-1) ?? first
}

/**
 * The first byte mpv reads to play from pMs (ranges.ts `fixed` lo): that keyframe and, except for MKV
 * (which starts at its Cluster), the last packet of each audio stream at or before keyframe − 250 ms.
 * fMP4 starts at the moof holding the earliest of those, AVI 8 bytes early (the chunk header).
 */
export function s4ReadStart(kind: RuleKind, packets: readonly Packet[], pMs: number, moofs: readonly number[]): number {
  const fk = seekKeyframe(kind, packets, pMs)
  if (kind === 'mkv') return fk.pos
  let lo = fk.pos
  for (const s of new Set(packets.filter((p) => !p.video).map((p) => p.stream))) {
    const last = packets
      .filter((p) => p.stream === s && p.ms <= fk.ms - 250)
      .sort((a, b) => a.ms - b.ms)
      .at(-1)
    if (last) lo = Math.min(lo, last.pos)
  }
  if (kind === 'fmp4') return moofs.filter((m) => m <= lo).at(-1) ?? 0
  return kind === 'avi' ? Math.max(0, lo - 8) : lo
}

/** One past the last byte of any packet presented by untilMs: what playing up to then needs. */
export function s4PlayEnd(packets: readonly Packet[], untilMs: number): number {
  let end = 0
  for (const p of packets) if (p.ms <= untilMs) end = Math.max(end, p.pos + p.size)
  return end
}
