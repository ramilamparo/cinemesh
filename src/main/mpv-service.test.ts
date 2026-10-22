import { describe, expect, it, vi } from 'vitest'
import type { LocateOptions, MpvLocateResult } from './mpv-locate.js'
import { MpvService } from './mpv-service.js'

const quiet = { info: vi.fn(), warn: vi.fn() }

function found(path: string, version = '0.41.0'): MpvLocateResult {
  return {
    status: 'ok',
    kind: 'system',
    path,
    version,
    source: 'path',
    tried: [{ source: 'path', path, status: 'ok', version }],
  }
}

/** A locate() whose calls resolve only when the test says so. */
function controlledLocate() {
  const calls: { opts: LocateOptions; resolve: (r: MpvLocateResult) => void; reject: (e: Error) => void }[] = []
  const locate = vi.fn(
    (opts: LocateOptions) =>
      new Promise<MpvLocateResult>((resolve, reject) => {
        calls.push({ opts, resolve, reject })
      }),
  )
  return { locate, calls }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('MpvService', () => {
  it('starts as missing, then keeps and emits each lookup result', async () => {
    const svc = new MpvService('/res', quiet, () => Promise.resolve(found('/usr/bin/mpv')))
    expect(svc.info).toMatchObject({ path: null, status: 'missing' })
    const changes: unknown[] = []
    svc.on('change', (i) => changes.push(i))
    const info = await svc.lookup(null)
    expect(info).toMatchObject({ path: '/usr/bin/mpv', kind: 'system', version: '0.41.0', status: 'ok' })
    expect(info.tried).toHaveLength(1)
    expect(svc.info).toBe(info)
    expect(changes).toEqual([info])
  })

  it('passes mpvPath and the resources path to the lookup', async () => {
    const locate = vi.fn(() => Promise.resolve(found('/x/mpv')))
    await new MpvService('/opt/app/resources', quiet, locate).lookup('/x/mpv')
    expect(locate).toHaveBeenCalledWith({ mpvPath: '/x/mpv', resourcesPath: '/opt/app/resources' })
  })

  it('joins a pending lookup for the same mpvPath (settings change + recheck = one result)', async () => {
    const { locate, calls } = controlledLocate()
    const svc = new MpvService(null, quiet, locate)
    const changes: unknown[] = []
    svc.on('change', (i) => changes.push(i))
    const a = svc.settingsChanged('/a/mpv')
    const b = svc.lookup('/a/mpv')
    expect(a).toBe(b)
    await flush()
    expect(calls).toHaveLength(1)
    calls[0]?.resolve(found('/a/mpv'))
    await b
    expect(changes).toHaveLength(1)
  })

  it('runs lookups in order, so the latest request wins', async () => {
    const { locate, calls } = controlledLocate()
    const svc = new MpvService(null, quiet, locate)
    const first = svc.lookup('/old/mpv')
    const second = svc.lookup('/new/mpv')
    await flush()
    expect(calls).toHaveLength(1) // the second waits for the first
    calls[0]?.resolve(found('/old/mpv'))
    await first
    await flush()
    expect(calls[1]?.opts.mpvPath).toBe('/new/mpv')
    calls[1]?.resolve(found('/new/mpv'))
    await second
    expect(svc.info.path).toBe('/new/mpv')
  })

  it('looks again on a settings change only when mpvPath changed', async () => {
    const locate = vi.fn((o: LocateOptions) => Promise.resolve(found(o.mpvPath ?? '/usr/bin/mpv')))
    const svc = new MpvService(null, quiet, locate)
    await svc.lookup(null)
    expect(svc.settingsChanged(null)).toBeNull()
    await svc.settingsChanged('/custom/mpv')
    expect(svc.settingsChanged('/custom/mpv')).toBeNull()
    expect(locate).toHaveBeenCalledTimes(2)
    // an explicit recheck always looks again
    await svc.lookup('/custom/mpv')
    expect(locate).toHaveBeenCalledTimes(3)
  })

  it('treats a failing lookup as missing and keeps going', async () => {
    const locate = vi
      .fn<(o: LocateOptions) => Promise<MpvLocateResult>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(found('/usr/bin/mpv'))
    const svc = new MpvService(null, quiet, locate)
    expect(await svc.lookup(null)).toMatchObject({ path: null, status: 'missing' })
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining('boom'))
    expect(await svc.lookup(null)).toMatchObject({ status: 'ok' })
  })

  it('reports tooOld without a path to spawn', async () => {
    const old: MpvLocateResult = {
      status: 'tooOld',
      kind: 'system',
      path: '/usr/bin/mpv',
      version: '0.35.1',
      source: 'path',
      tried: [{ source: 'path', path: '/usr/bin/mpv', status: 'tooOld', version: '0.35.1' }],
    }
    const svc = new MpvService(null, quiet, () => Promise.resolve(old))
    expect(await svc.lookup(null)).toEqual({
      path: null,
      kind: 'none',
      version: '0.35.1',
      status: 'tooOld',
      tried: old.tried,
    })
  })
})
