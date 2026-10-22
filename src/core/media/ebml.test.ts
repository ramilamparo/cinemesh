import { describe, expect, it } from 'vitest'
import { BufferSource } from './byte-source.js'
import { ID, indexMkv, readMkvLayout } from './ebml.js'
import { HEAD_MARGIN_MIN } from './margins.js'
import { concat, el, elUnknown, float64, idBytes, simpleBlock, str, uint, voidOf } from './testing/ebml-writer.js'

// Synthetic Matroska files exercise what ffmpeg fixtures cannot: unknown sizes, SeekHead loops,
// truncation, several segments and every track flag.

const EBML_HEADER = el(ID.EBML, el(ID.DocType, str('matroska')))

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8)
  for (let i = 7, v = n; i >= 0; i--, v = Math.floor(v / 256)) b[i] = v % 256
  return b
}

/** SeekHead with fixed-width positions, so its size does not depend on the positions. */
function seekHead(entries: [number, number][]): Uint8Array {
  return el(
    ID.SeekHead,
    ...entries.map(([id, pos]) => el(ID.Seek, el(ID.SeekID, idBytes(id)), el(ID.SeekPosition, u64(pos)))),
  )
}

const TRACKS = el(
  ID.Tracks,
  el(
    ID.TrackEntry,
    el(ID.TrackNumber, uint(1)),
    el(ID.TrackType, uint(1)),
    el(ID.CodecID, str('V_MPEGH/ISO/HEVC')),
    el(
      ID.Video,
      el(ID.PixelWidth, uint(3840)),
      el(ID.PixelHeight, uint(2160)),
      el(ID.Colour, el(ID.TransferCharacteristics, uint(16))),
    ),
  ),
  el(
    ID.TrackEntry,
    el(ID.TrackNumber, uint(2)),
    el(ID.TrackType, uint(2)),
    el(ID.CodecID, str('A_EAC3')),
    el(ID.Language, str('jpn')),
    el(ID.Name, str('Commentary')),
    el(ID.FlagDefault, uint(0)),
    el(ID.Audio, el(ID.Channels, uint(6))),
  ),
  el(
    ID.TrackEntry,
    el(ID.TrackNumber, uint(3)),
    el(ID.TrackType, uint(0x11)),
    el(ID.CodecID, str('S_TEXT/ASS')),
    el(ID.LanguageBCP47, str('en-US')),
    el(ID.FlagForced, uint(1)),
  ),
  el(
    ID.TrackEntry,
    el(ID.TrackNumber, uint(4)),
    el(ID.TrackType, uint(1)),
    el(ID.CodecID, str('V_MPEG4/ISO/AVC')),
    el(ID.Video, el(ID.Colour, el(ID.TransferCharacteristics, uint(18)))),
  ),
)

const INFO = el(ID.Info, el(ID.TimestampScale, uint(1_000_000)), el(ID.Duration, float64(10_000)))

// Cluster k covers [k s, k+1 s): audio first, then the video keyframe 40 ms in, then P-frames.
// Cluster 5 carries its keyframe in a BlockGroup; cluster 7 opens with a non-key video block.
function cluster(k: number, unknown = false): Uint8Array {
  const ts = k * 1000
  const blocks: Uint8Array[] = [el(ID.Timestamp, uint(ts)), el(ID.SimpleBlock, simpleBlock(2, 0, true, 200))]
  if (k === 5) blocks.push(el(ID.BlockGroup, el(ID.Block, simpleBlock(1, 40, false, 4000))))
  else blocks.push(el(ID.SimpleBlock, simpleBlock(1, 40, k !== 7, 4000)))
  for (let f = 1; f < 24; f++) {
    blocks.push(el(ID.SimpleBlock, simpleBlock(1, 40 + f * 40, false, 1500)))
    if (f % 6 === 0) blocks.push(el(ID.SimpleBlock, simpleBlock(2, f * 40, true, 200)))
  }
  return unknown ? elUnknown(ID.Cluster, ...blocks) : el(ID.Cluster, ...blocks)
}

interface Built {
  bytes: Uint8Array
  clusterPos: number[]
  tagsRange: [number, number] | null
  cuesRange: [number, number] | null
  firstCluster: number
}

function build(opts: { cues?: boolean; unknown?: boolean; tailTags?: boolean; loop?: boolean } = {}): Built {
  const clusters = Array.from({ length: 10 }, (_, k) => cluster(k, opts.unknown))
  const tags = el(ID.Tags, el(0x7373, el(0x67c8, el(0x45a3, str('TITLE')), el(0x4487, str('Tail')))))
  const pass = (positions: Map<string, number>) => {
    const entries: [number, number][] = [
      [ID.Info, positions.get('info') ?? 0],
      [ID.Tracks, positions.get('tracks') ?? 0],
    ]
    if (opts.cues) entries.push([ID.Cues, positions.get('cues') ?? 0])
    // the second SeekHead lists the tail Tags and points back at the first one (a loop)
    if (opts.tailTags) entries.push([ID.SeekHead, positions.get('sh2') ?? 0])
    const parts: [string, Uint8Array][] = [
      ['sh', seekHead(entries)],
      ['void', voidOf(40)],
      ['info', INFO],
      ['tracks', TRACKS],
    ]
    clusters.forEach((c, k) => parts.push([`c${String(k)}`, c]))
    if (opts.cues) {
      const points = clusters.map((_, k) =>
        el(
          ID.CuePoint,
          el(ID.CueTime, uint(k * 1000 + 40)),
          el(ID.CueTrackPositions, el(ID.CueTrack, uint(4)), el(ID.CueClusterPosition, uint(0))),
          el(
            ID.CueTrackPositions,
            el(ID.CueTrack, uint(1)),
            el(ID.CueClusterPosition, u64(positions.get(`c${String(k)}`) ?? 0)),
          ),
        ),
      )
      parts.push(['cues', el(ID.Cues, ...points)])
    }
    if (opts.tailTags) {
      parts.push(['tags', tags])
      parts.push([
        'sh2',
        seekHead([
          [ID.Tags, positions.get('tags') ?? 0],
          [ID.SeekHead, 0],
        ]),
      ])
    }
    const next = new Map<string, number>()
    let off = 0
    for (const [name, b] of parts) {
      next.set(name, off)
      off += b.length
    }
    return { parts, next }
  }
  const first = pass(new Map())
  const { parts, next } = pass(first.next)
  const body = concat(parts.map(([, b]) => b))
  const segment = opts.unknown
    ? elUnknown(ID.Segment, body)
    : concat([idBytes(ID.Segment), [0x01, 0, 0, 0, 0, ...u64(body.length).subarray(5)], body])
  const segDataPos = EBML_HEADER.length + (segment.length - body.length)
  const range = (name: string): [number, number] | null => {
    const at = next.get(name)
    const part = parts.find(([n]) => n === name)?.[1]
    return at === undefined || !part ? null : [segDataPos + at, segDataPos + at + part.length]
  }
  return {
    bytes: concat([EBML_HEADER, segment]),
    clusterPos: clusters.map((_, k) => segDataPos + (next.get(`c${String(k)}`) ?? 0)),
    tagsRange: range('tags'),
    cuesRange: range('cues'),
    firstCluster: segDataPos + (next.get('c0') ?? 0),
  }
}

describe('MKV index (synthetic)', () => {
  it('reads Info, Tracks and the Cues of the first video track', async () => {
    const f = build({ cues: true })
    const idx = await indexMkv(new BufferSource(f.bytes))
    expect(idx.seekMode).toBe('index')
    expect(idx.durationMs).toBe(10_000)
    expect(idx.keyframes).toEqual(f.clusterPos.map((p, k) => [k * 1000 + 40, p]))
    expect(idx.seekCritical).toEqual([f.cuesRange])
    expect(idx.openCritical).toEqual([[0, f.firstCluster + HEAD_MARGIN_MIN]])
    expect(idx.multiSegment).toBe(false)
    expect(idx.tracks).toEqual([
      expect.objectContaining({
        id: 1,
        type: 'video',
        hdr: 'pq',
        width: 3840,
        height: 2160,
        isDefault: true,
        lang: 'eng',
      }),
      expect.objectContaining({ id: 2, type: 'audio', lang: 'jpn', name: 'Commentary', isDefault: false, channels: 6 }),
      expect.objectContaining({ id: 3, type: 'subtitle', lang: 'en-US', forced: true }),
      expect.objectContaining({ id: 4, type: 'video', hdr: 'hlg' }),
    ])
  })

  it('scans cluster headers without Cues and goes linear', async () => {
    const f = build()
    const src = new BufferSource(f.bytes)
    const idx = await indexMkv(src)
    expect(idx.seekMode).toBe('linear')
    // cluster 7 opens with a non-key video block, so it is not a seek point
    const expected = f.clusterPos.map((p, k) => [k * 1000 + 40, p]).filter((_, k) => k !== 7)
    expect(idx.keyframes).toEqual(expected)
  })

  it('handles unknown-size Segment and Clusters, and takes the duration from the last blocks', async () => {
    const f = build({ unknown: true })
    const idx = await indexMkv(new BufferSource(f.bytes))
    expect(idx.seekMode).toBe('linear')
    expect(idx.keyframes.length).toBe(9)
    expect(idx.keyframes[3]?.[0]).toBe(3040)
    expect(idx.durationMs).toBe(10_000) // Info.Duration still present
    const noInfo = build({ unknown: true })
    // patch Duration out: rename the element to Void keeps every offset
    const at = indexOf(noInfo.bytes, Uint8Array.from([0x44, 0x89]))
    noInfo.bytes[at] = 0xec
    noInfo.bytes[at + 1] = 0x88
    const idx2 = await indexMkv(new BufferSource(noInfo.bytes))
    expect(idx2.durationMs).toBe(9000 + 960)
  })

  it('follows nested SeekHeads once each and makes tail Tags open-critical', async () => {
    const f = build({ cues: true, tailTags: true })
    const layout = await readMkvLayout(new BufferSource(f.bytes))
    expect(layout.level1.filter((h) => h.id === ID.SeekHead).length).toBe(2)
    const idx = await indexMkv(new BufferSource(f.bytes))
    const tags = f.tagsRange
    expect(tags).not.toBeNull()
    expect(idx.openCritical.some(([a, b]) => tags && a <= tags[0] && tags[1] <= b)).toBe(true)
    expect(idx.seekCritical).toEqual([f.cuesRange])
  })

  it('survives a truncated file', async () => {
    const f = build({ cues: true })
    const cut = f.bytes.subarray(0, (f.clusterPos[6] ?? 0) + 400)
    const layout = await readMkvLayout(new BufferSource(cut))
    expect(layout.truncated).toBe(true)
    const idx = await indexMkv(new BufferSource(cut))
    expect(idx.seekMode).toBe('linear')
    expect(idx.keyframes.map(([t]) => t)).toEqual([40, 1040, 2040, 3040, 4040, 5040, 6040])
  })

  it('flags a second Segment', async () => {
    const f = build({ cues: true })
    const two = concat([f.bytes, f.bytes.subarray(EBML_HEADER.length)])
    const idx = await indexMkv(new BufferSource(two))
    expect(idx.multiSegment).toBe(true)
    expect(idx.keyframes.length).toBe(10)
  })

  it('rejects files that are not EBML', async () => {
    await expect(indexMkv(new BufferSource(new Uint8Array(100)))).rejects.toThrow()
  })
})

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}
