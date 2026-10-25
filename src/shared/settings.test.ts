import { describe, expect, it } from 'vitest'
import { defaultSettings, mergeSettings, parseSettings } from './settings.js'

describe('settings', () => {
  it('fills every field from defaults', () => {
    const s = defaultSettings()
    expect(s.version).toBe(1)
    expect(s.theme).toBe('system')
    expect(s.hostDefaults).toEqual({
      othersControl: false,
      waitForAll: true,
      startMode: { kind: 'buffered', seconds: 10 },
      admission: 'open',
      maxMembers: 8,
      autoAdvance: true,
    })
    expect(s.relayKey).toBeNull()
    expect(s.hashWorkers).toBe(2)
  })

  it('keeps known values and defaults the rest', () => {
    const { settings, valid } = parseSettings({ theme: 'dark', hostDefaults: { maxMembers: 4 } })
    expect(valid).toBe(true)
    expect(settings.theme).toBe('dark')
    expect(settings.hostDefaults.maxMembers).toBe(4)
    expect(settings.hostDefaults.waitForAll).toBe(true)
  })

  it('rejects invalid files instead of half-applying them', () => {
    const { settings, valid } = parseSettings({ theme: 'purple' })
    expect(valid).toBe(false)
    expect(settings).toEqual(defaultSettings())
    expect(parseSettings(null).valid).toBe(false)
  })

  it('merges nested host defaults field by field', () => {
    const merged = mergeSettings(defaultSettings(), { hostDefaults: { othersControl: true } })
    expect(merged.hostDefaults.othersControl).toBe(true)
    expect(merged.hostDefaults.maxMembers).toBe(8)
  })

  it('validates patches', () => {
    expect(() => mergeSettings(defaultSettings(), { relayKey: 'not-hex' })).toThrow()
    expect(() => mergeSettings(defaultSettings(), { hashWorkers: 9 })).toThrow()
    const key = 'ab'.repeat(32)
    expect(mergeSettings(defaultSettings(), { relayKey: key }).relayKey).toBe(key)
  })
})

describe('the desync warning setting', () => {
  it('is 1 s by default, also for a settings file from before it, and 0 turns it off', () => {
    expect(defaultSettings().desyncWarnMs).toBe(1000)
    const { settings, valid } = parseSettings({ theme: 'dark', speedNudge: false })
    expect(valid).toBe(true)
    expect(settings).toMatchObject({ theme: 'dark', speedNudge: false, desyncWarnMs: 1000 })
    expect(mergeSettings(defaultSettings(), { desyncWarnMs: 0 }).desyncWarnMs).toBe(0)
  })

  it('takes 0.5 to 30 s in whole ms, or 0', () => {
    for (const ms of [0, 500, 1500, 30_000])
      expect(mergeSettings(defaultSettings(), { desyncWarnMs: ms }).desyncWarnMs).toBe(ms)
    for (const ms of [499, 30_001, 1500.5, -1, 1]) {
      expect(() => mergeSettings(defaultSettings(), { desyncWarnMs: ms })).toThrow()
    }
  })
})

describe('the playlist settings', () => {
  it('transfer other items and advance by default, also for a settings file from before them', () => {
    const { settings, valid } = parseSettings({ theme: 'dark', hostDefaults: { maxMembers: 4 } })
    expect(valid).toBe(true)
    expect(settings).toMatchObject({ playlistBackgroundDownload: true, playlistBackgroundUpload: true })
    expect(settings.hostDefaults.autoAdvance).toBe(true)
  })

  it('turn off one at a time', () => {
    const s = mergeSettings(defaultSettings(), {
      playlistBackgroundUpload: false,
      hostDefaults: { autoAdvance: false },
    })
    expect(s).toMatchObject({ playlistBackgroundDownload: true, playlistBackgroundUpload: false })
    expect(s.hostDefaults).toMatchObject({ autoAdvance: false, maxMembers: 8 })
    expect(() => mergeSettings(defaultSettings(), { playlistBackgroundDownload: 'yes' as never })).toThrow()
  })
})

describe('the download limit setting', () => {
  it('is off by default, also for a settings file from before it, and takes whole KiB/s', () => {
    expect(defaultSettings().downloadLimitKBps).toBeNull()
    const { settings, valid } = parseSettings({ theme: 'dark', uploadLimitKBps: 800 })
    expect(valid).toBe(true)
    expect(settings).toMatchObject({ uploadLimitKBps: 800, downloadLimitKBps: null })
    expect(mergeSettings(defaultSettings(), { downloadLimitKBps: 500 }).downloadLimitKBps).toBe(500)
    expect(mergeSettings(defaultSettings(), { downloadLimitKBps: null }).downloadLimitKBps).toBeNull()
    for (const kbps of [0, -1, 1.5]) {
      expect(() => mergeSettings(defaultSettings(), { downloadLimitKBps: kbps })).toThrow()
    }
  })

  it("a newer app's file still reads: a field this version does not know is dropped, not the file", () => {
    const { settings, valid } = parseSettings({ downloadLimitKBps: 300, someFutureField: true })
    expect(valid).toBe(true)
    expect(settings.downloadLimitKBps).toBe(300)
    expect(settings).not.toHaveProperty('someFutureField')
  })
})

describe('settings patches', () => {
  it('leave unspecified settings untouched', () => {
    const custom = mergeSettings(defaultSettings(), { displayName: 'Ram', hashWorkers: 3 })
    const next = mergeSettings(custom, { theme: 'dark' })
    expect(next).toMatchObject({ displayName: 'Ram', hashWorkers: 3, theme: 'dark' })
  })
})
