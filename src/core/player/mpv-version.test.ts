import { describe, expect, it } from 'vitest'
import { atLeast, formatVersion, parseMpvVersion } from './mpv-version.js'

describe('parseMpvVersion', () => {
  it.each([
    ['mpv v0.41.0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects\n built on ...', '0.41.0'],
    ['mpv 0.37.0 Copyright © 2000-2023', '0.37.0'],
    ['mpv v0.40.0-482-gcd6d2b3 Copyright', '0.40.0-482-gcd6d2b3'],
    ['mpv v0.41.0-dev Copyright', '0.41.0-dev'],
    ['mpv 0.39.0-UNKNOWN Copyright', '0.39.0-UNKNOWN'],
    ['mpv v0.40 Copyright', '0.40.0'],
    ['[warn] something first\nmpv v0.39.1 Copyright', '0.39.1'],
  ])('%s -> %s', (banner, expected) => {
    const v = parseMpvVersion(banner)
    expect(v && formatVersion(v)).toBe(expected)
  })

  it('rejects banners without a release number', () => {
    expect(parseMpvVersion('mpv git-2016-ab12cd Copyright')).toBeNull()
    expect(parseMpvVersion('vlc 3.0.20')).toBeNull()
    expect(parseMpvVersion('')).toBeNull()
  })

  it('compares by major.minor', () => {
    const v = parseMpvVersion('mpv v0.40.0-482-gcd6d2b3')
    if (!v) throw new Error('unparsed')
    expect(atLeast(v, 0, 40)).toBe(true)
    expect(atLeast(v, 0, 41)).toBe(false)
    expect(atLeast({ major: 1, minor: 0, patch: 0, suffix: '' }, 0, 41)).toBe(true)
  })
})
