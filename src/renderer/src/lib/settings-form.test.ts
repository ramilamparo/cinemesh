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

describe('the download limit field', () => {
  it('shows none as empty, and saves only what changed', () => {
    expect(form.downloadLimitKBps).toBe('')
    expect(formFromSettings({ ...current, downloadLimitKBps: 800 }).downloadLimitKBps).toBe('800')
    expect(validateSettingsForm({ ...form, downloadLimitKBps: '500' }, current)).toMatchObject({
      ok: true,
      patch: { downloadLimitKBps: 500 },
      settings: { downloadLimitKBps: 500, uploadLimitKBps: null },
    })
    const r = validateSettingsForm({ ...form, downloadLimitKBps: '500' }, current)
    expect(r.ok && Object.keys(r.patch)).toEqual(['downloadLimitKBps'])
    const limited = { ...current, downloadLimitKBps: 500 }
    for (const empty of ['', ' ']) {
      expect(validateSettingsForm({ ...formFromSettings(limited), downloadLimitKBps: empty }, limited)).toMatchObject({
        ok: true,
        patch: { downloadLimitKBps: null },
      })
    }
  })

  it('takes a whole number of KB/s from 1 to 10000000', () => {
    const error = (text: string): string | undefined => {
      const r = validateSettingsForm({ ...form, downloadLimitKBps: text }, current)
      return r.ok ? undefined : r.errors.downloadLimitKBps
    }
    expect(error('-3')).toBe('Download limit must be a whole number.')
    expect(error('1.5')).toBe('Download limit must be a whole number.')
    expect(error('0')).toBe('Download limit must be between 1 and 10000000.')
    expect(error('20000000')).toBe('Download limit must be between 1 and 10000000.')
    expect(error('10000000')).toBeUndefined()
  })
})

describe('the desync warning fields', () => {
  it('shows the setting as a switch and seconds: off keeps 1 s ready to type over', () => {
    expect(formFromSettings({ ...current, desyncWarnMs: 0 })).toMatchObject({ desyncWarn: false, desyncWarnS: '1' })
    expect(formFromSettings({ ...current, desyncWarnMs: 2500 })).toMatchObject({ desyncWarn: true, desyncWarnS: '2.5' })
    expect(form).toMatchObject({ desyncWarn: true, desyncWarnS: '1' })
  })

  it('saves seconds as ms, and 0 when off whatever the field holds', () => {
    expect(validateSettingsForm({ ...form, desyncWarnS: '1.5' }, current)).toMatchObject({
      ok: true,
      patch: { desyncWarnMs: 1500 },
    })
    // a number field keeps ".5" as typed
    expect(validateSettingsForm({ ...form, desyncWarnS: '.5' }, current)).toMatchObject({
      ok: true,
      patch: { desyncWarnMs: 500 },
    })
    expect(validateSettingsForm({ ...form, desyncWarn: false, desyncWarnS: 'junk' }, current)).toMatchObject({
      ok: true,
      patch: { desyncWarnMs: 0 },
    })
    const off = { ...current, desyncWarnMs: 0 }
    expect(validateSettingsForm({ ...formFromSettings(off), desyncWarn: true }, off)).toMatchObject({
      ok: true,
      patch: { desyncWarnMs: 1000 },
    })
  })

  it('rejects seconds outside 0.5 to 30', () => {
    for (const bad of ['0.2', '.2', '31', 'abc', '', '-1', '1e1', '.', '1.']) {
      expect(validateSettingsForm({ ...form, desyncWarnS: bad }, current)).toEqual({
        ok: false,
        errors: { desyncWarnS: 'Seconds must be between 0.5 and 30.' },
      })
    }
  })
})
