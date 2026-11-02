import { describe, expect, it } from 'vitest'
import {
  MAX_SHARED_IN_ROOM,
  MAX_SHARED_NAME_CHARS,
  SHARED_SUBS_MAX_BYTES,
  type SharedSubsBody,
  SharedSubsSchema,
  SubtitleOfferSchema,
  checkSharedSubsSize,
  looksLikeText,
  sharedSubName,
  sharedSubsBytes,
  subtitleExt,
} from './shared-subs-wire.js'

const entry = (i: number, name: string, byName: string): SharedSubsBody['items'][number] => ({
  hash: i.toString(16).padStart(64, '0'),
  size: 4 * 1024 * 1024,
  name,
  lang: 'pt-BR-xxxx'.slice(0, 16),
  infoHash: 'f'.repeat(40),
  by: 'e'.repeat(64),
  byName,
})

describe('shared subtitle names', () => {
  it('keeps the file name and its extension, and refuses what is not a text subtitle', () => {
    expect(sharedSubName('/home/a/Movie.en.forced.SRT')).toBe('Movie.en.forced.SRT')
    expect(sharedSubName('C:\\subs\\Ep01.ass')).toBe('Ep01.ass')
    expect(sharedSubName('/x/movie.mkv')).toBeNull()
    expect(sharedSubName('/x/movie.srt.exe')).toBeNull()
    expect(sharedSubName('/x/noext')).toBeNull()
    expect(subtitleExt('a.VTT')).toBe('vtt')
  })

  it('strips control and bidi characters', () => {
    expect(sharedSubName('/x/ev\u202eil\u0007.srt')).toBe('evil.srt')
  })

  it('cuts a long name to MAX_SHARED_NAME_CHARS characters, extension kept', () => {
    const long = `${'é'.repeat(300)}.ssa`
    const n = sharedSubName(`/x/${long}`) ?? ''
    expect(n.length).toBeLessThanOrEqual(MAX_SHARED_NAME_CHARS)
    expect(n.endsWith('.ssa')).toBe(true)
    expect(
      SubtitleOfferSchema.safeParse({ hash: 'a'.repeat(64), size: 10, name: n, infoHash: 'b'.repeat(40) }).success,
    ).toBe(true)
  })
})

describe('session.subtitles', () => {
  it('a full room with the longest names still fits one bus message', () => {
    const name = `${'語'.repeat(MAX_SHARED_NAME_CHARS - 4)}.srt`
    const body: SharedSubsBody = {
      v: 1,
      rev: 0xffff_fffe,
      viewersMayShare: true,
      items: Array.from({ length: MAX_SHARED_IN_ROOM }, (_, i) => entry(i, name, '名'.repeat(32))),
    }
    expect(SharedSubsSchema.safeParse(body).success).toBe(true)
    expect(sharedSubsBytes(body)).toBeLessThanOrEqual(SHARED_SUBS_MAX_BYTES)
    expect(() => checkSharedSubsSize(body)).not.toThrow()
    expect(() => checkSharedSubsSize({ ...body, items: [...body.items, entry(999, 'x.srt', '')] })).toThrow(/too many/)
  })

  it('refuses a file listed twice for one item, and names that are not subtitles', () => {
    const a = entry(1, 'a.srt', 'Sam')
    expect(SharedSubsSchema.safeParse({ v: 1, rev: 1, viewersMayShare: true, items: [a, a] }).success).toBe(false)
    expect(
      SharedSubsSchema.safeParse({ v: 1, rev: 1, viewersMayShare: true, items: [entry(1, 'a.exe', 'Sam')] }).success,
    ).toBe(false)
    // the same file for another item is fine
    const b = { ...a, infoHash: 'c'.repeat(40) }
    expect(SharedSubsSchema.safeParse({ v: 1, rev: 1, viewersMayShare: true, items: [a, b] }).success).toBe(true)
  })
})

describe('looksLikeText', () => {
  it('takes UTF-8 text and UTF-16 with a byte order mark, not binary', () => {
    expect(looksLikeText(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHi\n'))).toBe(true)
    expect(looksLikeText(Buffer.from('Hi', 'utf16le'))).toBe(false)
    expect(looksLikeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Hi', 'utf16le')]))).toBe(true)
    expect(looksLikeText(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x01]))).toBe(false)
    expect(looksLikeText(Buffer.alloc(0))).toBe(false)
  })
})
