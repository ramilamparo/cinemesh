import { describe, expect, it } from 'vitest'
import type { TrackInfo as PlayerTrack } from '../../shared/ipc/core.js'
import type { TrackInfo as MediaTrack } from '../../shared/media/types.js'
import { captureChoice, planCarry, sameLang } from './track-carry.js'

function pt(id: number, title: string | null, lang: string | null, extra: Partial<PlayerTrack> = {}): PlayerTrack {
  return { id, title, lang, codec: 'aac', default: false, forced: false, external: false, ...extra }
}

function mt(type: MediaTrack['type'], name: string, lang: string, forced = false): MediaTrack {
  return {
    id: 0,
    type,
    codec: 'x',
    lang,
    name,
    isDefault: false,
    forced,
    hdr: 'none',
    channels: 2,
    width: 0,
    height: 0,
  }
}

const episode = (audio: [string, string][], subs: [string, string, boolean?][]): MediaTrack[] => [
  mt('video', '', 'und'),
  ...audio.map(([n, l]) => mt('audio', n, l)),
  ...subs.map(([n, l, f]) => mt('subtitle', n, l, f ?? false)),
]

describe('captureChoice', () => {
  it('records the playing tracks by title, language and position', () => {
    const c = captureChoice({
      audio: [pt(1, 'English', 'eng'), pt(2, 'Japanese', 'jpn')],
      sub: [pt(1, 'Full', 'eng'), pt(2, 'Signs', 'eng', { forced: true })],
      aid: 2,
      sid: 2,
    })
    expect(c.audio).toEqual({ title: 'Japanese', lang: 'jpn', codec: 'aac', forced: false, external: false, index: 1 })
    expect(c.sub).toMatchObject({ title: 'Signs', forced: true, index: 1 })
  })

  it("keeps subtitles off as 'no', and carries nothing for a type with no tracks", () => {
    expect(captureChoice({ audio: [], sub: [pt(1, 'Full', 'eng')], aid: 'no', sid: 'no' })).toEqual({
      audio: null,
      sub: 'no',
    })
    expect(captureChoice({ audio: [], sub: [], aid: 'no', sid: 'no' }).sub).toBeNull()
  })

  it('counts an external subtitle among the external ones', () => {
    const c = captureChoice({
      audio: [],
      sub: [pt(1, 'Full', 'eng'), pt(2, 'Ep01.en.srt', 'en', { external: true })],
      aid: 'no',
      sid: 2,
    })
    expect(c.sub).toMatchObject({ external: true, index: 0, lang: 'en' })
  })

  it('carries nothing for an id the list does not hold', () => {
    expect(captureChoice({ audio: [pt(1, 'A', 'eng')], sub: [], aid: 5, sid: 'no' }).audio).toBeNull()
  })
})

describe('planCarry', () => {
  const next = episode(
    [
      ['English 5.1', 'eng'],
      ['Japanese', 'jpn'],
    ],
    [
      ['Full', 'eng'],
      ['Signs & Songs', 'eng', true],
      ['Full', 'spa'],
    ],
  )

  it('finds the same-titled audio and subtitle tracks and maps them to mpv ids', () => {
    const plan = planCarry(
      {
        audio: { title: 'japanese', lang: 'jpn', codec: null, forced: false, external: false, index: 0 },
        sub: { title: 'Signs & Songs ', lang: 'eng', codec: null, forced: true, external: false, index: 1 },
      },
      next,
    )
    expect(plan.aid).toBe(2)
    expect(plan.alang).toBe('jpn')
    expect(plan.sid).toBe(2)
    expect(plan.verify).toEqual({
      audio: { title: 'Japanese', lang: 'jpn' },
      sub: { title: 'Signs & Songs', lang: 'eng' },
    })
  })

  it('breaks a title tie by language, then by position', () => {
    const plan = planCarry(
      { audio: null, sub: { title: 'Full', lang: 'es', codec: null, forced: false, external: false, index: 0 } },
      next,
    )
    expect(plan.sid).toBe(3)
    const byPos = planCarry(
      { audio: null, sub: { title: 'Full', lang: null, codec: null, forced: false, external: false, index: 2 } },
      next,
    )
    expect(byPos.sid).toBe(3)
  })

  it('falls back to the language (and forced flag) when no title matches', () => {
    const plan = planCarry(
      {
        audio: { title: 'English Stereo', lang: 'en', codec: null, forced: false, external: false, index: 1 },
        sub: { title: 'Forced', lang: 'eng', codec: null, forced: true, external: false, index: 0 },
      },
      next,
    )
    expect(plan.aid).toBe(1)
    expect(plan.sid).toBe(2)
  })

  it("leaves the choice to mpv when nothing matches, but still names the language for --alang's sake", () => {
    const plan = planCarry(
      {
        audio: { title: 'Commentary', lang: 'fre', codec: null, forced: false, external: false, index: 2 },
        sub: { title: 'Full', lang: 'ger', codec: null, forced: false, external: true, index: 0 },
      },
      next,
    )
    expect(plan.aid).toBeUndefined()
    expect(plan.alang).toBe('fre')
    expect(plan.sid).toBeUndefined()
    expect(plan.externalSub).toBeUndefined()
  })

  it('keeps subtitles off', () => {
    expect(planCarry({ audio: null, sub: 'no' }, next).sid).toBe('no')
  })

  it('matches an external subtitle by language, preferring another external one', () => {
    const plan = planCarry(
      { audio: null, sub: { title: 'Ep01.en.srt', lang: 'en', codec: null, forced: false, external: true, index: 1 } },
      next,
      [
        { lang: 'es', forced: false },
        { lang: 'en', forced: false },
      ],
    )
    expect(plan.externalSub).toBe(1)
    expect(plan.sid).toBeUndefined()
  })

  it('falls back to an embedded track of that language when the next item has no external one', () => {
    const plan = planCarry(
      { audio: null, sub: { title: 'Ep01.es.srt', lang: 'es', codec: null, forced: false, external: true, index: 0 } },
      next,
    )
    expect(plan.sid).toBe(3)
  })

  it('carries nothing into a file without tracks of that type', () => {
    const plan = planCarry(
      {
        audio: { title: 'English', lang: null, codec: null, forced: false, external: false, index: 0 },
        sub: { title: 'Full', lang: 'eng', codec: null, forced: false, external: false, index: 0 },
      },
      [mt('video', '', 'und')],
    )
    expect(plan).toEqual({ verify: {} })
  })
})

describe('sameLang', () => {
  it('treats ISO 639-1 and 639-2 codes and regions sensibly', () => {
    expect(sameLang('en', 'eng')).toBe(true)
    expect(sameLang('ger', 'deu')).toBe(true)
    expect(sameLang('de', 'ger')).toBe(true)
    expect(sameLang('pt-BR', 'pt')).toBe(true)
    expect(sameLang('pt-BR', 'pt-PT')).toBe(false)
    expect(sameLang('en', 'ja')).toBe(false)
    expect(sameLang('und', 'und')).toBe(false)
    expect(sameLang(null, 'en')).toBe(false)
  })
})
