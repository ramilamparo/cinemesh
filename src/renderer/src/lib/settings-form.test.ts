import { describe, expect, it } from 'vitest'
import { defaultSettings } from '../../../shared/settings'
import { formFromSettings, validateSettingsForm } from './settings-form'

const current = { ...defaultSettings(), displayName: 'Alex' }
const form = formFromSettings(current)

describe('validateSettingsForm', () => {
  it('returns an empty patch when nothing changed', () => {
    expect(validateSettingsForm(form, current)).toMatchObject({ ok: true, patch: {} })
  })

  it('patches only changed fields, nested host defaults included', () => {
    const r = validateSettingsForm(
      { ...form, displayName: '  Robin ', udpPort: '49737', hostMaxMembers: '4', hostStartMode: 'play-through' },
      current,
    )
    expect(r).toMatchObject({
      ok: true,
      patch: {
        displayName: 'Robin',
        udpPort: 49737,
        hostDefaults: { maxMembers: 4, startMode: { kind: 'play-through' } },
      },
    })
  })

  it('normalises a z-base-32 relay key to hex', () => {
    const z32 = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy' // 32 zero bytes
    const r = validateSettingsForm({ ...form, relayKey: z32 }, current)
    expect(r).toMatchObject({ ok: true, patch: { relayKey: '0'.repeat(64) } })
  })

  it('clears optional numbers and the relay key with empty fields', () => {
    const withValues = { ...current, udpPort: 50000, uploadLimitKBps: 800, relayKey: 'ab'.repeat(32) }
    const r = validateSettingsForm(
      { ...formFromSettings(withValues), udpPort: '', uploadLimitKBps: ' ', relayKey: '' },
      withValues,
    )
    expect(r).toMatchObject({ ok: true, patch: { udpPort: null, uploadLimitKBps: null, relayKey: null } })
  })

  it('splits language and bootstrap lists', () => {
    const r = validateSettingsForm(
      { ...form, alang: 'ja, en', slang: 'en', bootstrapExtra: 'node1.example:49737\n10.0.0.2:1' },
      current,
    )
    expect(r).toMatchObject({
      ok: true,
      patch: { alang: ['ja', 'en'], slang: ['en'], bootstrapExtra: ['node1.example:49737', '10.0.0.2:1'] },
    })
  })

  it('reports every bad field at once', () => {
    const r = validateSettingsForm(
      {
        ...form,
        displayName: '',
        cacheCapGB: '1.5',
        udpPort: '80',
        relayKey: 'nope',
        bootstrapExtra: 'no-port',
        hashWorkers: '9',
        uploadLimitKBps: '-3',
        hostMaxMembers: '20',
        alang: 'english-language-please',
      },
      current,
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(Object.keys(r.errors).sort()).toEqual(
      [
        'alang',
        'bootstrapExtra',
        'cacheCapGB',
        'displayName',
        'hashWorkers',
        'hostMaxMembers',
        'relayKey',
        'udpPort',
        'uploadLimitKBps',
      ].sort(),
    )
    expect(r.errors.udpPort).toContain('between 1024 and 65535')
    expect(r.errors.bootstrapExtra).toContain('"no-port" is not host:port')
  })
})
