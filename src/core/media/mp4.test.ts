import { describe, expect, it } from 'vitest'
import { BufferSource } from './byte-source.js'
import { completesFragmentIndex, judgeMp4Interleave, openScanEnd, walkBoxes } from './mp4.js'

const MIB = 1024 * 1024

function box(type: string, size: number, large = false): Uint8Array {
  const b = new Uint8Array(large ? 16 : 8)
  const dv = new DataView(b.buffer)
  dv.setUint32(0, large ? 1 : size)
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i)
  if (large) dv.setBigUint64(8, BigInt(size))
  return b
}

describe('MP4 top-level walk', () => {
  it('handles largesize and a final size-0 box', async () => {
    const file = new Uint8Array(32 + 100 + 64)
    file.set(box('ftyp', 32), 0)
    file.set(box('mdat', 100, true), 32)
    file.set(box('moov', 0), 132)
    const boxes = await walkBoxes(new BufferSource(file))
    expect(boxes.map((b) => [b.type, b.pos, b.end, b.headerSize])).toEqual([
      ['ftyp', 0, 32, 8],
      ['mdat', 32, 132, 16],
      ['moov', 132, 196, 8],
    ])
  })

  it('stops at a malformed or truncated header', async () => {
    const file = new Uint8Array(64)
    file.set(box('ftyp', 16), 0)
    file.set(box('mdat', 4), 16)
    expect((await walkBoxes(new BufferSource(file))).map((b) => b.type)).toEqual(['ftyp'])
    const cut = new Uint8Array(40)
    cut.set(box('ftyp', 16), 0)
    cut.set(box('mdat', 1000), 16)
    const boxes = await walkBoxes(new BufferSource(cut))
    expect(boxes.at(-1)).toEqual({ type: 'mdat', pos: 16, headerSize: 8, end: 40 })
  })
})

describe('interleave judgement', () => {
  // 10 s of video at 1 MiB/s with audio stored next to it, or all audio at the end of the file.
  function samples(audioAtEnd: boolean) {
    const out = []
    for (let s = 0; s < 10; s++) {
      for (let f = 0; f < 25; f++) out.push({ t: s * 1000 + f * 40, off: s * MIB + f * 40_000, size: 40_000 })
      const audioOff = audioAtEnd ? 10 * MIB + s * 16_000 : s * MIB + 25 * 40_000
      out.push({ t: s * 1000, off: audioOff, size: 16_000 })
    }
    return out
  }

  it('accepts audio stored beside its video', () => {
    expect(judgeMp4Interleave(samples(false))).toBe('good')
  })

  it('flags a window that spans more than 8 MiB', () => {
    expect(judgeMp4Interleave(samples(true))).toBe('poor')
  })

  it('flags a span over 4x its own bytes only above 2 MiB', () => {
    const small = [
      { t: 0, off: 0, size: 10_000 },
      { t: 10, off: 500_000, size: 10_000 },
    ]
    expect(judgeMp4Interleave(small)).toBe('good')
    const wide = [
      { t: 0, off: 0, size: 100_000 },
      { t: 10, off: 3 * MIB, size: 100_000 },
    ]
    expect(judgeMp4Interleave(wide)).toBe('poor')
    expect(judgeMp4Interleave([])).toBe('unknown')
  })
})

// What FFmpeg 9's open reads of a fragmented file (ADR 0004 §8.2, checked against mpv through a gated server).
describe('fMP4 open scan', () => {
  const tracks = new Set([1, 2])
  const SIZE = 10_000

  it('completes the fragment index at a sidx with first_offset 0 that reaches EOF or the mfra trailer', () => {
    const sidx = { version: 1, trackId: 2, first: 0, end: SIZE }
    expect(completesFragmentIndex(sidx, tracks, SIZE, null)).toBe(true)
    expect(completesFragmentIndex({ ...sidx, end: SIZE - 500 }, tracks, SIZE, 500)).toBe(true)
    // the video sidx of global_sidx skips the audio one behind it: only that one completes it
    expect(completesFragmentIndex({ ...sidx, trackId: 1, first: 52 }, tracks, SIZE, null)).toBe(false)
    // a sidx per fragment ends at its own fragment
    expect(completesFragmentIndex({ ...sidx, end: 4000 }, tracks, SIZE, 500)).toBe(false)
    expect(completesFragmentIndex({ ...sidx, end: SIZE - 500 }, tracks, SIZE, null)).toBe(false)
    // FFmpeg ignores a sidx of a track the moov does not have, or of a version it does not know
    expect(completesFragmentIndex({ ...sidx, trackId: 3 }, tracks, SIZE, null)).toBe(false)
    expect(completesFragmentIndex({ ...sidx, version: 2 }, tracks, SIZE, null)).toBe(false)
  })

  const boxes = (spec: string): { type: string; completes: boolean }[] =>
    spec.split(' ').map((t) => ({ type: t.replace('*', ''), completes: t.endsWith('*') }))

  it('stops after the first mdat when a sidx in front completes the index', () => {
    // ffmpeg global_sidx: the video sidx, then the audio one that completes it (*)
    expect(openScanEnd(boxes('ftyp moov sidx sidx* moof mdat moof mdat mfra'))).toBe(5)
    // per-fragment sidx boxes behind an index are not read
    expect(openScanEnd(boxes('ftyp moov sidx sidx* sidx sidx moof mdat sidx sidx moof mdat'))).toBe(7)
  })

  it('walks the fragments up to the sidx that completes the index, or to EOF', () => {
    // -movflags dash: the last fragment's audio sidx
    expect(openScanEnd(boxes('ftyp moov sidx sidx moof mdat sidx sidx moof mdat sidx sidx* moof mdat mfra'))).toBe(11)
    expect(openScanEnd(boxes('ftyp moov moof mdat moof mdat mfra'))).toBe(-1)
    expect(openScanEnd(boxes('ftyp moov sidx moof mdat moof mdat'))).toBe(-1)
    // the index is complete, but no mdat yet: FFmpeg reads on to one
    expect(openScanEnd(boxes('ftyp moov sidx*'))).toBe(-1)
  })
})
