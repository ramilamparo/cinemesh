import { describe, expect, it } from 'vitest'
import { err, ok } from '../../../shared/result'
import { mpvCheckText } from './mpv-check'

describe('mpvCheckText', () => {
  it('names the version that was found', () => {
    expect(mpvCheckText(ok({ path: '/usr/bin/mpv', kind: 'system', version: '0.41.0', status: 'ok' }))).toEqual({
      ok: true,
      text: 'mpv 0.41.0 found',
    })
    // status absent: ok when a path is set
    expect(mpvCheckText(ok({ path: '/usr/bin/mpv', kind: 'system', version: null })).text).toBe('mpv found')
  })

  it('explains why the first candidate is not usable', () => {
    const first = { source: 'settings' as const, path: '/x/mpv', status: 'unusable' as const, version: null }
    const tried = [first]
    expect(mpvCheckText(ok({ path: null, kind: 'none', version: null, status: 'missing', tried })).text).toBe(
      'mpv not usable: /x/mpv cannot be started',
    )
    const old = [{ source: 'path' as const, path: '/usr/bin/mpv', status: 'tooOld' as const, version: '0.35.1' }]
    expect(mpvCheckText(ok({ path: null, kind: 'none', version: '0.35.1', status: 'tooOld', tried: old })).text).toBe(
      'mpv not usable: /usr/bin/mpv 0.35.1 too old',
    )
    const detailed = [{ ...first, detail: 'permission denied' }]
    expect(mpvCheckText(ok({ path: null, kind: 'none', version: null, tried: detailed })).text).toBe(
      'mpv not usable: permission denied',
    )
    expect(mpvCheckText(ok({ path: null, kind: 'none', version: null })).text).toBe('mpv not usable: not found')
    expect(mpvCheckText(err('mpv-missing', 'mpv was not found'))).toEqual({
      ok: false,
      text: 'mpv not usable: mpv was not found',
    })
  })
})
