import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { naturalSort } from '../../shared/media-files.js'
import { siblingSubtitles, subtitleFlags } from './playlist-files.js'

describe('subtitleFlags', () => {
  it('reads the language and forced flag from the name', () => {
    expect(subtitleFlags('/v/Ep01.en.srt')).toEqual({ lang: 'en', forced: false })
    expect(subtitleFlags('/v/Ep01.en.forced.srt')).toEqual({ lang: 'en', forced: true })
    expect(subtitleFlags('/v/Ep01.forced.en.srt')).toEqual({ lang: 'en', forced: true })
    expect(subtitleFlags('/v/Ep01.pt-BR.sdh.ass')).toEqual({ lang: 'pt-BR', forced: false })
    expect(subtitleFlags('/v/Ep01.srt')).toEqual({ lang: '', forced: false })
  })

  it('stops at a part that is neither a language nor a flag', () => {
    expect(subtitleFlags('/v/Show.S01E01.1080p.srt')).toEqual({ lang: '', forced: false })
  })
})

describe('naturalSort', () => {
  it('orders episodes by number, case-insensitively', () => {
    expect(naturalSort(['/s/Ep10.mkv', '/s/ep2.mkv', '/s/Ep1.mkv'])).toEqual([
      '/s/Ep1.mkv',
      '/s/ep2.mkv',
      '/s/Ep10.mkv',
    ])
    expect(naturalSort(['C:\\s\\S01E10.mkv', 'C:\\s\\S01E09.mkv'])).toEqual(['C:\\s\\S01E09.mkv', 'C:\\s\\S01E10.mkv'])
  })
})

describe('siblingSubtitles', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it("takes the video's own subtitles, not another episode's", async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-subs-'))
    for (const n of ['Ep01.mkv', 'Ep01.srt', 'Ep01.en.forced.ASS', 'Ep010.srt', 'Ep02.en.srt', 'Ep01.nfo']) {
      await writeFile(join(dir, n), '')
    }
    expect(await siblingSubtitles(join(dir, 'Ep01.mkv'))).toEqual([
      join(dir, 'Ep01.en.forced.ASS'),
      join(dir, 'Ep01.srt'),
    ])
  })

  it('finds none in a folder it cannot read', async () => {
    expect(await siblingSubtitles('/nonexistent-dir-wt/Ep01.mkv')).toEqual([])
  })
})
