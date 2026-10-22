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

describe('settings patches', () => {
  it('leave unspecified settings untouched', () => {
    const custom = mergeSettings(defaultSettings(), { displayName: 'Ram', hashWorkers: 3 })
    const next = mergeSettings(custom, { theme: 'dark' })
    expect(next).toMatchObject({ displayName: 'Ram', hashWorkers: 3, theme: 'dark' })
  })
})
