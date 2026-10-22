import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BufferSource } from '../../../src/core/media/byte-source.js'
import { type ElementHeader, ID, children, readMkvLayout } from '../../../src/core/media/ebml.js'
import { concat, el, idBytes, size8, uint, voidOf } from '../../../src/core/media/testing/ebml-writer.js'

// Media fixtures are generated with ffmpeg on first use into a cache under os.tmpdir() and reused by
// later runs (never committed). Every file is written to a temp name and renamed, so test files that
// run in parallel can race on generation safely.

export const FIXTURE_DIR = join(tmpdir(), 'wt-media-fixtures-v1')
export const DURATION_S = 30
export const GOP_FRAMES = 25 // 1 s at 25 fps

/** One master encode (testsrc2 + sine, x264 with B-frames, 1 s GOP) and its remuxes, cached in `dir`. */
export interface FixtureSet {
  dir: string
  durationS: number
  /** testsrc2 frame size */
  size: string
  videoBitrate: string
  audioBitrate: string
}

/** 30 s at 600 kbit/s: what every test uses unless it says otherwise. */
export const SHORT: FixtureSet = {
  dir: FIXTURE_DIR,
  durationS: DURATION_S,
  size: '320x240',
  videoBitrate: '600k',
  audioBitrate: '64k',
}

/**
 * 60 s at 2 Mbit/s: 40 s in lies ~10 MB into the file, far past the open-critical head (about 1.3 MB) plus
 * STREAM_SKIP_BYTES, where readyRange's lo comes from the keyframe rule and not from reading on.
 */
export const LONG: FixtureSet = {
  dir: join(FIXTURE_DIR, 'long-60s-2M'),
  durationS: 60,
  size: '640x360',
  videoBitrate: '2M',
  audioBitrate: '128k',
}

function onPath(cmd: string): boolean {
  return spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0
}

export const HAVE_FFMPEG = onPath('ffmpeg') && onPath('ffprobe')
export const HAVE_MPV = spawnSync('mpv', ['--version'], { stdio: 'ignore' }).status === 0

export type FixtureName =
  | 'mkv-cues.mkv'
  | 'mkv-nocues.mkv'
  | 'mkv-tail.mkv'
  | 'mp4-faststart.mp4'
  | 'mp4-tailmoov.mp4'
  | 'fmp4-sidx.mp4'
  | 'fmp4-nosidx.mp4'
  | 'fmp4-mfra.mp4'
  | 'fmp4-dash.mp4'
  | 'fmp4-dash-global.mp4'
  | 'avi.avi'
  // remux inputs (remux.test.ts), not in FIXTURES: the index, gated-mpv and stream-mpv suites cover the others
  | 'webm-nocues.webm'
  | 'mpegts.ts'
  | 'fmp4-tracks.mp4'
  | 'mp4-poor.mp4'
  | 'mov-poor.mov'
  | 'mkv-poor.mkv'

/**
 * How far the poorly interleaved fixtures store audio behind its video: past FFmpeg's default max_interleave_delta
 * (10 s), and on LONG past the MP4 rule's 2 MiB span.
 */
export const POOR_LAG_S = 20

export const FIXTURES: FixtureName[] = [
  'mkv-cues.mkv',
  'mkv-nocues.mkv',
  'mkv-tail.mkv',
  'mp4-faststart.mp4',
  'mp4-tailmoov.mp4',
  'fmp4-sidx.mp4',
  'fmp4-nosidx.mp4',
  'fmp4-mfra.mp4',
  'fmp4-dash.mp4',
  'fmp4-dash-global.mp4',
  'avi.avi',
]

function ffmpeg(args: string[]): void {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
}

/** ffmpeg writing to a pipe, saved to `path`: a pipe is not seekable, so the muxer writes no index. */
function piped(args: string[], path: string): void {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args, 'pipe:1'], {
    maxBuffer: 256 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr)}`)
  writeFileSync(path, r.stdout)
}

/** The master's video, and its audio muxed POOR_LAG_S late: next to the video of POOR_LAG_S later. */
const lateAudio = (master: string): string[] => [
  '-i',
  master,
  '-itsoffset',
  String(POOR_LAG_S),
  '-i',
  master,
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-c',
  'copy',
]

let seq = 0
function tmpName(path: string): string {
  return `${path}.${String(process.pid)}.${String(seq++)}.tmp`
}

/** Runs `make(tmp)` unless `path` exists, then renames tmp into place. */
async function ensure(path: string, make: (tmp: string) => void | Promise<void>): Promise<string> {
  if (existsSync(path)) return path
  const tmp = tmpName(path)
  await make(tmp)
  renameSync(tmp, path)
  return path
}

/** h:mm:ss.cc */
function assTime(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor(s / 60) % 60
  return `${String(h)}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.00`
}

/** One 3 s line every 5 s. */
const assText = (durationS: number): string => `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 240

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,WTFont,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${Array.from({ length: Math.floor(durationS / 5) }, (_, i) => `Dialogue: 0,${assTime(i * 5)},${assTime(i * 5 + 3)},Default,,0,0,0,,Line ${String(i + 1)}`).join('\n')}
`

function master(set: FixtureSet): Promise<string> {
  return ensure(join(set.dir, 'master.mkv'), (tmp) =>
    ffmpeg([
      '-f',
      'lavfi',
      '-i',
      `testsrc2=size=${set.size}:rate=25:duration=${String(set.durationS)}`,
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${String(set.durationS)}`,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-bf',
      '2',
      '-g',
      String(GOP_FRAMES),
      '-keyint_min',
      String(GOP_FRAMES),
      '-sc_threshold',
      '0',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      set.videoBitrate,
      '-c:a',
      'aac',
      '-b:a',
      set.audioBitrate,
      '-metadata:s:a:0',
      'language=eng',
      '-f',
      'matroska',
      tmp,
    ]),
  )
}

const COPY = ['-map', '0:v', '-map', '0:a', '-c', 'copy']

export interface TailInfo {
  /** Byte ranges of the Tags/Attachments/Chapters moved after the last Cluster. */
  moved: [number, number][]
}

export async function tailInfo(set: FixtureSet = SHORT): Promise<TailInfo> {
  await fixture('mkv-tail.mkv', set)
  return JSON.parse(readFileSync(join(set.dir, 'mkv-tail.json'), 'utf8')) as TailInfo
}

/** Path of a fixture of `set`, generating it (and the set's master encode) when missing. */
export async function fixture(name: FixtureName, set: FixtureSet = SHORT): Promise<string> {
  mkdirSync(set.dir, { recursive: true })
  const out = join(set.dir, name)
  if (existsSync(out)) return out
  const m = await master(set)
  switch (name) {
    case 'mkv-cues.mkv':
      return ensure(out, (tmp) => ffmpeg(['-i', m, ...COPY, '-f', 'matroska', tmp]))
    case 'mkv-nocues.mkv':
      // A pipe is not seekable, so matroskaenc writes no Cues, no SeekHead entries and no Duration.
      return ensure(out, (tmp) => piped(['-i', m, ...COPY, '-f', 'matroska'], tmp))
    case 'webm-nocues.webm':
      // VP9 and Opus through a pipe: no Cues either
      return ensure(out, (tmp) =>
        piped(
          [
            '-f',
            'lavfi',
            '-i',
            `testsrc2=size=${set.size}:rate=25:duration=${String(set.durationS)}`,
            '-f',
            'lavfi',
            '-i',
            `sine=frequency=440:sample_rate=48000:duration=${String(set.durationS)}`,
            '-c:v',
            'libvpx-vp9',
            '-deadline',
            'realtime',
            '-cpu-used',
            '8',
            '-b:v',
            set.videoBitrate,
            '-g',
            String(GOP_FRAMES),
            '-c:a',
            'libopus',
            '-b:a',
            set.audioBitrate,
            '-f',
            'webm',
          ],
          tmp,
        ),
      )
    case 'mpegts.ts':
      return ensure(out, (tmp) => ffmpeg(['-i', m, ...COPY, '-f', 'mpegts', tmp]))
    case 'fmp4-tracks.mp4': {
      // fMP4 without sidx (a full download) with a second audio track, a subtitle and a timecode (data) track: what
      // a remux without -map drops, and one with -map 0 alone stops at
      const ass = await ensure(join(set.dir, 'subs.ass'), (tmp) => writeFileSync(tmp, assText(set.durationS)))
      return ensure(out, (tmp) =>
        ffmpeg([
          '-i',
          m,
          '-i',
          m,
          '-i',
          ass,
          '-map',
          '0:v',
          '-map',
          '0:a',
          '-map',
          '1:a',
          '-map',
          '2:s',
          '-c',
          'copy',
          '-c:s',
          'mov_text',
          '-metadata:s:a:1',
          'language=jpn',
          '-timecode',
          '00:00:00:00',
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof+skip_trailer',
          '-f',
          'mp4',
          tmp,
        ]),
      )
    }
    case 'mp4-poor.mp4':
    case 'mov-poor.mov':
      // The audio muxed POOR_LAG_S late, which the muxer undoes with an edit list, and that edit list dropped: each
      // audio sample plays at its own time again but lies next to the video POOR_LAG_S later.
      return ensure(out, (tmp) => {
        const src = `${tmp}.src`
        ffmpeg([...lateAudio(m), '-f', name === 'mov-poor.mov' ? 'mov' : 'mp4', src])
        writeFileSync(tmp, withoutAudioEdits(readFileSync(src)))
        rmSync(src)
      })
    case 'mkv-poor.mkv':
      // The same in Matroska, which has no edit lists: the audio blocks' times are moved back in place.
      return ensure(out, async (tmp) => {
        const src = `${tmp}.src`
        ffmpeg([...lateAudio(m), '-f', 'matroska', src])
        const buf = new Uint8Array(readFileSync(src))
        await shiftAudioBlocks(buf, -POOR_LAG_S * 1000)
        writeFileSync(tmp, buf)
        rmSync(src)
      })
    case 'mkv-tail.mkv': {
      const ass = await ensure(join(set.dir, 'subs.ass'), (tmp) => writeFileSync(tmp, assText(set.durationS)))
      const font = await ensure(join(set.dir, 'WTFont.ttf'), (tmp) => writeFileSync(tmp, fakeFont()))
      const front = await ensure(join(set.dir, 'mkv-front.mkv'), (tmp) =>
        ffmpeg([
          '-i',
          m,
          '-i',
          ass,
          '-map',
          '0:v',
          '-map',
          '0:a',
          '-map',
          '1:s',
          '-c',
          'copy',
          '-metadata',
          'title=WT tail fixture',
          '-metadata:s:s:0',
          'language=eng',
          '-attach',
          font,
          '-metadata:s:t:0',
          'mimetype=font/ttf',
          '-f',
          'matroska',
          tmp,
        ]),
      )
      // The sidecar lands before the fixture, so an existing fixture always has its sidecar.
      const outTmp = tmpName(out)
      const info = await moveToTail(readFileSync(front), outTmp)
      await ensure(join(set.dir, 'mkv-tail.json'), (tmp) => writeFileSync(tmp, JSON.stringify(info)))
      renameSync(outTmp, out)
      return out
    }
    case 'mp4-faststart.mp4':
      return ensure(out, (tmp) => ffmpeg(['-i', m, ...COPY, '-movflags', '+faststart', '-f', 'mp4', tmp]))
    case 'mp4-tailmoov.mp4':
      return ensure(out, (tmp) => ffmpeg(['-i', m, ...COPY, '-f', 'mp4', tmp]))
    case 'fmp4-sidx.mp4':
      return ensure(out, (tmp) =>
        ffmpeg([
          '-i',
          m,
          ...COPY,
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof+global_sidx',
          '-f',
          'mp4',
          tmp,
        ]),
      )
    case 'fmp4-nosidx.mp4':
      return ensure(out, (tmp) =>
        ffmpeg([
          '-i',
          m,
          ...COPY,
          '-movflags',
          '+frag_keyframe+empty_moov+default_base_moof+skip_trailer',
          '-f',
          'mp4',
          tmp,
        ]),
      )
    case 'fmp4-mfra.mp4':
      // no sidx, but the mfra/tfra trailer ffmpeg writes unless skip_trailer (S4: still scanned to EOF at open)
      return ensure(out, (tmp) =>
        ffmpeg(['-i', m, ...COPY, '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', tmp]),
      )
    case 'fmp4-dash.mp4':
      // a sidx per track in front of every fragment, and no index in front of them all
      return ensure(out, (tmp) => ffmpeg(['-i', m, ...COPY, '-movflags', '+dash', '-f', 'mp4', tmp]))
    case 'fmp4-dash-global.mp4': {
      const dash = await fixture('fmp4-dash.mp4', set)
      return ensure(out, (tmp) => writeFileSync(tmp, withGlobalSidx(readFileSync(dash))))
    }
    case 'avi.avi':
      return ensure(out, (tmp) =>
        ffmpeg([
          '-i',
          m,
          '-map',
          '0:v',
          '-map',
          '0:a',
          '-c:v',
          'copy',
          '-bsf:v',
          'h264_mp4toannexb',
          '-c:a',
          'libmp3lame',
          '-b:a',
          '64k',
          '-f',
          'avi',
          tmp,
        ]),
      )
  }
}

/**
 * fmp4-dash behind an index: a sidx per track after moov (version 1, as global_sidx writes them), whose
 * references are the fragments, each still led by its own sidx boxes. first_offset skips the index's later
 * boxes, so the last one has 0 and completes FFmpeg's fragment index (ADR 0004 §8.2). The mfra trailer's
 * offsets go stale; FFmpeg reads only its size, which stays right.
 */
function withGlobalSidx(src: Buffer): Buffer {
  const boxes: { type: string; pos: number; end: number }[] = []
  for (let p = 0; p + 8 <= src.length;) {
    const size = src.readUInt32BE(p)
    boxes.push({ type: src.toString('latin1', p + 4, p + 8), pos: p, end: p + size })
    if (size < 8) break
    p += size
  }
  const moov = boxes.find((b) => b.type === 'moov')
  if (!moov) throw new Error('no moov')
  const end = boxes.find((b) => b.type === 'mfra')?.pos ?? src.length
  // a fragment starts at the first of its sidx boxes
  const starts = boxes.filter((b, i) => b.type === 'sidx' && boxes[i - 1]?.type !== 'sidx').map((b) => b.pos)
  const tracks = new Map<number, { timescale: number; ept: bigint; durations: number[] }>()
  for (const b of boxes.filter((x) => x.type === 'sidx')) {
    const v1 = src[b.pos + 8] === 1
    const id = src.readUInt32BE(b.pos + 12)
    const t = tracks.get(id) ?? {
      timescale: src.readUInt32BE(b.pos + 16),
      ept: v1 ? src.readBigUInt64BE(b.pos + 20) : BigInt(src.readUInt32BE(b.pos + 20)),
      durations: [],
    }
    t.durations.push(src.readUInt32BE(b.pos + (v1 ? 40 : 32) + 4)) // the first reference's duration
    tracks.set(id, t)
  }
  const index = [...tracks].map(([id, t]) => {
    if (t.durations.length !== starts.length) throw new Error('expected one sidx per track and fragment')
    const box = Buffer.alloc(40 + 12 * starts.length)
    box.writeUInt32BE(box.length, 0)
    box.write('sidx', 4, 'latin1')
    box.writeUInt8(1, 8)
    box.writeUInt32BE(id, 12)
    box.writeUInt32BE(t.timescale, 16)
    box.writeBigUInt64BE(t.ept, 20)
    box.writeUInt16BE(starts.length, 38)
    starts.forEach((s, i) => {
      const q = 40 + 12 * i
      box.writeUInt32BE((starts[i + 1] ?? end) - s, q)
      box.writeUInt32BE(t.durations[i] ?? 0, q + 4)
      box.writeUInt32BE(0x90000000, q + 8) // starts with SAP, type 1
    })
    return box
  })
  index.forEach((box, i) => box.writeBigUInt64BE(BigInt(index.slice(i + 1).reduce((n, b) => n + b.length, 0)), 28))
  return Buffer.concat([src.subarray(0, moov.end), ...index, src.subarray(moov.end)])
}

interface Mp4Box {
  type: string
  pos: number
  dataPos: number
  end: number
}

/** The boxes in [start, end) of an MP4/MOV. */
function mp4Boxes(b: Buffer, start: number, end: number): Mp4Box[] {
  const out: Mp4Box[] = []
  for (let p = start; p + 8 <= end;) {
    let size = b.readUInt32BE(p)
    let dataPos = p + 8
    if (size === 1) {
      size = Number(b.readBigUInt64BE(p + 8))
      dataPos = p + 16
    } else if (size === 0) size = end - p
    if (size < 8) break
    out.push({ type: b.toString('latin1', p + 4, p + 8), pos: p, dataPos, end: p + size })
    p += size
  }
  return out
}

/** Every sound track's edit list renamed to `free` (same size): its samples play from media time 0 where they lie. */
function withoutAudioEdits(src: Buffer): Buffer {
  const b = Buffer.from(src)
  let dropped = 0
  for (const moov of mp4Boxes(b, 0, b.length).filter((x) => x.type === 'moov')) {
    for (const trak of mp4Boxes(b, moov.dataPos, moov.end).filter((x) => x.type === 'trak')) {
      const boxes = mp4Boxes(b, trak.dataPos, trak.end)
      const mdia = boxes.find((x) => x.type === 'mdia')
      const hdlr = mdia ? mp4Boxes(b, mdia.dataPos, mdia.end).find((x) => x.type === 'hdlr') : undefined
      // hdlr: version and flags, pre_defined, then the handler type
      if (!hdlr || b.toString('latin1', hdlr.dataPos + 8, hdlr.dataPos + 12) !== 'soun') continue
      for (const edts of boxes.filter((x) => x.type === 'edts')) {
        b.write('free', edts.pos + 4, 'latin1')
        dropped++
      }
    }
  }
  if (dropped === 0) throw new Error('expected an edit list on the audio track')
  return b
}

/** Moves the audio blocks' times by deltaMs in place (cluster-relative int16): their bytes stay where they lie. */
async function shiftAudioBlocks(buf: Uint8Array, deltaMs: number): Promise<void> {
  const src = new BufferSource(buf)
  const l = await readMkvLayout(src)
  const uintOf = (h: ElementHeader): number => buf.subarray(h.dataPos, h.end).reduce((a, x) => a * 256 + x, 0)
  const info = l.level1.find((h) => h.id === ID.Info)
  const tracks = l.level1.find((h) => h.id === ID.Tracks)
  if (!info || !tracks || l.firstCluster === null) throw new Error('no Info, Tracks or Cluster')
  for await (const h of children(src, info.dataPos, info.end)) {
    if (h.id === ID.TimestampScale && uintOf(h) !== 1_000_000) throw new Error('expected millisecond timestamps')
  }
  let audio = 0
  for await (const entry of children(src, tracks.dataPos, tracks.end)) {
    if (entry.id !== ID.TrackEntry) continue
    const fields = new Map<number, number>()
    for await (const f of children(src, entry.dataPos, entry.end)) fields.set(f.id, uintOf(f))
    if (fields.get(ID.TrackType) === 2) audio ||= fields.get(ID.TrackNumber) ?? 0
  }
  // a Block starts with its track number (a one-byte vint below 127), then its time relative to the Cluster
  if (audio < 1 || audio > 126) throw new Error('expected an audio track number below 127')
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let moved = 0
  const shift = (at: number): void => {
    if (buf[at] !== (0x80 | audio)) return
    const t = view.getInt16(at + 1) + deltaMs
    if (t < -0x8000 || t > 0x7fff) throw new Error('block time out of range')
    view.setInt16(at + 1, t)
    moved++
  }
  for await (const cluster of children(src, l.firstCluster, l.segmentEnd)) {
    if (cluster.id !== ID.Cluster) continue
    for await (const b of children(src, cluster.dataPos, cluster.end)) {
      if (b.id === ID.SimpleBlock) shift(b.dataPos)
      if (b.id !== ID.BlockGroup) continue
      for await (const g of children(src, b.dataPos, b.end)) if (g.id === ID.Block) shift(g.dataPos)
    }
  }
  if (moved === 0) throw new Error('no audio blocks')
}

function fakeFont(): Uint8Array {
  // Not a usable font; only its bytes matter (an attachment mpv must read at open).
  const b = new Uint8Array(48 * 1024)
  let x = 0x12345678
  for (let i = 0; i < b.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0
    b[i] = x >>> 24
  }
  b.set([0, 1, 0, 0], 0)
  return b
}

export interface GoldenKeyframe {
  ms: number
  pos: number
}

/** Keyframes of the first video stream from ffprobe -show_packets: player-timeline ms and packet byte. */
export function goldenKeyframes(path: string): GoldenKeyframe[] {
  const start = Number(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=start_time', '-of', 'csv=p=0', path], {
      encoding: 'utf8',
    }).trim(),
  )
  const out = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=pts_time,dts_time,pos,flags',
      '-of',
      'csv=p=0',
      path,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const s = Number.isFinite(start) ? start : 0
  return out
    .split('\n')
    .map((l) => l.split(','))
    .filter(([, , , f]) => f?.includes('K'))
    .map(([pts, dts, p]) => ({ ms: Math.round((Number(pts === 'N/A' ? dts : pts) - s) * 1000), pos: Number(p) }))
}

/**
 * mkvmerge-style tail layout: Tags, Attachments and Chapters are replaced in place by Voids (so no
 * Cluster or Cue offset changes), appended after the last element of the Segment, and the SeekHead
 * is rewritten inside its old span plus the Void that ffmpeg reserves after it.
 */
async function moveToTail(input: Buffer, dst: string): Promise<TailInfo> {
  const buf = new Uint8Array(input)
  const src = new BufferSource(buf)
  {
    const l = await readMkvLayout(src)
    const fc = l.firstCluster ?? buf.length
    const moved: Uint8Array[] = []
    const ranges: [number, number][] = []
    const rel = new Map<number, number>()
    let tail = buf.length
    for (const h of l.level1) {
      if (h.pos >= fc || ![ID.Tags, ID.Attachments, ID.Chapters].includes(h.id as never)) continue
      const bytes = buf.slice(h.pos, h.end)
      buf.set(voidOf(h.end - h.pos), h.pos)
      rel.set(h.id, tail - l.segmentDataPos)
      ranges.push([tail, tail + bytes.length])
      tail += bytes.length
      moved.push(bytes)
    }
    const sh = l.level1.find((h) => h.id === ID.SeekHead)
    if (!sh) throw new Error('no SeekHead')
    const next = l.level1.find((h) => h.pos === sh.end)
    const spanEnd = next?.id === ID.Void ? next.end : sh.end
    const entries = new Map<number, number>()
    for await (const seek of children(src, sh.dataPos, sh.end)) {
      let id = 0
      let pos = 0
      for await (const f of children(src, seek.dataPos, seek.end)) {
        const d = buf.subarray(f.dataPos, f.end)
        const v = d.reduce((a, x) => a * 256 + x, 0)
        if (f.id === ID.SeekID) id = v
        if (f.id === ID.SeekPosition) pos = v
      }
      entries.set(id, pos)
    }
    for (const [id, p] of rel) entries.set(id, p)
    const seeks = [...entries].map(([id, p]) => el(ID.Seek, el(ID.SeekID, idBytes(id)), el(ID.SeekPosition, uint(p))))
    const head = el(ID.SeekHead, ...seeks)
    const span = spanEnd - sh.pos
    if (head.length + 2 > span && head.length !== span) throw new Error('SeekHead does not fit')
    buf.set(head, sh.pos)
    if (head.length < span) buf.set(voidOf(span - head.length), sh.pos + head.length)
    if (buf[l.segmentDataPos - 8] !== 0x01) throw new Error('expected an 8-byte Segment size')
    buf.set(size8(tail - l.segmentDataPos), l.segmentDataPos - 8)
    writeFileSync(dst, concat([buf, ...moved]))
    return { moved: ranges }
  }
}
