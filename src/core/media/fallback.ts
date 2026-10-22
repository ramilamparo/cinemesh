import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ByteRange, Container, HdrKind, KeyPoint, MediaIndex, TrackInfo } from '../../shared/media/types.js'
import { type ByteSource, type ProgressFn, checkAborted, fourcc, readU32LE } from './byte-source.js'
import { headMargin } from './margins.js'

// Generic containers (AVI, MPEG-TS, anything mpv plays that we cannot parse). With ffprobe on PATH
// we take its keyframe list; without it the map is linear (byte = size × t/D). The head piece and
// the last two pieces are added as open-critical by buildManifest, once the piece length is known.

export async function findFfprobe(): Promise<string | null> {
  const names = process.platform === 'win32' ? ['ffprobe.exe'] : ['ffprobe']
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    for (const n of names) {
      const p = join(dir, n)
      try {
        await access(p, constants.X_OK)
        return p
      } catch {
        // not here
      }
    }
  }
  return null
}

interface ProbeStream {
  index?: number
  codec_type?: string
  codec_name?: string
  channels?: number
  width?: number
  height?: number
  color_transfer?: string
  tags?: { language?: string; title?: string }
  disposition?: { default?: number; forced?: number }
}

interface ProbeResult {
  format?: { duration?: string; start_time?: string; format_name?: string }
  streams?: ProbeStream[]
}

function run(cmd: string, args: string[], signal: AbortSignal | undefined): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true })
    const out: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else reject(new Error(`${cmd} exited with ${String(code)}: ${err.trim().slice(0, 400)}`))
    })
  })
}

export async function probeFormat(ffprobe: string, path: string, signal?: AbortSignal): Promise<ProbeResult> {
  const json = await run(
    ffprobe,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,start_time,format_name:stream=index,codec_type,codec_name,channels,width,height,color_transfer:stream_tags=language,title:stream_disposition=default,forced',
      '-of',
      'json',
      path,
    ],
    signal,
  )
  return JSON.parse(json) as ProbeResult
}

/**
 * Keyframes of the first video stream: [seconds, byte] in file order. dts_time is asked for too
 * because AVI packets carry no pts.
 */
export async function scanKeyframes(
  ffprobe: string,
  path: string,
  size: number,
  signal?: AbortSignal,
  onProgress?: ProgressFn,
): Promise<[number, number][]> {
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'packet=pts_time,dts_time,pos,flags',
    '-of',
    'csv=p=0',
  ]
  const child = spawn(ffprobe, [...args, path], { stdio: ['ignore', 'pipe', 'ignore'], signal, windowsHide: true })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  const out: [number, number][] = []
  let lastReport = 0
  for await (const line of createInterface({ input: child.stdout })) {
    const [pts, dts, pos, flags] = line.split(',')
    if (!flags?.includes('K')) continue
    const t = pts === 'N/A' ? Number(dts) : Number(pts)
    const b = Number(pos)
    if (!Number.isFinite(t) || !Number.isFinite(b)) continue
    out.push([t, b])
    if (b - lastReport > 64 * 1024 * 1024) {
      lastReport = b
      onProgress?.(b, size)
    }
  }
  const code = await exited
  checkAborted(signal)
  if (code !== 0) throw new Error(`ffprobe exited with ${String(code)}`)
  return out
}

function hdrOf(transfer: string | undefined): HdrKind {
  if (transfer === 'smpte2084') return 'pq'
  if (transfer === 'arib-std-b67') return 'hlg'
  return 'none'
}

function tracksOf(streams: ProbeStream[]): TrackInfo[] {
  return streams.map((s, i) => {
    const t = s.codec_type
    return {
      id: s.index ?? i,
      type: t === 'video' ? 'video' : t === 'audio' ? 'audio' : t === 'subtitle' ? 'subtitle' : 'other',
      codec: s.codec_name ?? '',
      lang: s.tags?.language ?? '',
      name: s.tags?.title ?? '',
      isDefault: s.disposition?.default === 1,
      forced: s.disposition?.forced === 1,
      hdr: hdrOf(s.color_transfer),
      channels: s.channels ?? 0,
      width: s.width ?? 0,
      height: s.height ?? 0,
    }
  })
}

export interface AviLayout {
  moviPos: number
  idx1: ByteRange | null
}

/** Top-level RIFF chunks of an AVI: where the movi list starts and where idx1 lies (usually the tail). */
export async function readAviLayout(src: ByteSource): Promise<AviLayout | null> {
  const head = await src.read(0, 12)
  if (fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'AVI ') return null
  const riffEnd = Math.min(src.size, 8 + readU32LE(head, 4))
  let pos = 12
  let moviPos = -1
  let idx1: ByteRange | null = null
  while (pos + 8 <= riffEnd) {
    const h = await src.read(pos, 12)
    const id = fourcc(h, 0)
    const size = readU32LE(h, 4)
    if (id === 'LIST' && fourcc(h, 8) === 'movi' && moviPos < 0) moviPos = pos
    if (id === 'idx1') idx1 = [pos, Math.min(src.size, pos + 8 + size)]
    pos += 8 + size + (size & 1)
  }
  return { moviPos: moviPos < 0 ? 0 : moviPos, idx1 }
}

export function sniffTransportStream(head: Uint8Array): boolean {
  return head[0] === 0x47 && head[188] === 0x47 && head[376] === 0x47
}

export interface GenericOptions {
  path: string
  container: Extract<Container, 'avi' | 'mpegts' | 'generic'>
  ffprobePath: string | null
  durationHintMs?: number
  signal?: AbortSignal
  onProgress?: ProgressFn
}

export async function indexGeneric(src: ByteSource, opts: GenericOptions): Promise<MediaIndex> {
  const { ffprobePath: ffprobe, signal } = opts
  let durationMs = opts.durationHintMs ?? 0
  let startS = 0
  let tracks: TrackInfo[] = []
  let points: KeyPoint[] = []
  if (ffprobe) {
    const probe = await probeFormat(ffprobe, opts.path, signal)
    const d = Number(probe.format?.duration)
    const s = Number(probe.format?.start_time)
    if (Number.isFinite(d) && d > 0) durationMs = d * 1000
    if (Number.isFinite(s)) startS = s
    tracks = tracksOf(probe.streams ?? [])
    if (tracks.some((t) => t.type === 'video')) {
      const kfs = await scanKeyframes(ffprobe, opts.path, src.size, signal, opts.onProgress)
      points = kfs.map(([t, b]) => [(t - startS) * 1000, b])
    }
  }
  checkAborted(signal)

  const openCritical: ByteRange[] = []
  let seekMode: MediaIndex['seekMode'] = 'linear'
  if (opts.container === 'avi') {
    const avi = await readAviLayout(src)
    if (avi) {
      openCritical.push([0, avi.moviPos + headMargin(durationMs > 0 ? (src.size * 1000) / durationMs : 0)])
      if (avi.idx1) {
        openCritical.push(avi.idx1)
        seekMode = 'index'
      }
    }
  }
  return {
    fileSize: src.size,
    container: opts.container,
    seekMode: points.length ? seekMode : 'linear',
    interleave: 'unknown',
    multiSegment: false,
    durationMs,
    startMs: Math.round(startS * 1000),
    avgBytesPerSec: durationMs > 0 ? (src.size * 1000) / durationMs : 0,
    keyframes: points,
    openCritical,
    seekCritical: [],
    tracks,
  }
}
