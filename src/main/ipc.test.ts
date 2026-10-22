import { EventEmitter } from 'node:events'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { APP_CHANNELS } from '../shared/ipc/app.js'
import type { MpvInfo } from '../shared/ipc/control.js'
import { defaultSettings } from '../shared/settings.js'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
const listeners = new Map<string, Handler>()
const clipboardText: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: Handler) => handlers.set(ch, fn),
    on: (ch: string, fn: Handler) => listeners.set(ch, fn),
  },
  app: { getVersion: () => '0.1.0', isPackaged: false, getPath: () => '/nowhere', on: vi.fn() },
  clipboard: { writeText: (t: string) => void clipboardText.push(t), readText: () => '' },
  dialog: {},
  shell: {},
  protocol: {},
  session: {},
  BrowserWindow: {},
  Menu: {},
  Tray: {},
  nativeImage: {},
}))

const { registerIpc } = await import('./ipc.js')
const { MpvService } = await import('./mpv-service.js')

const trusted = { senderFrame: { url: 'app://bundle/index.html' } }
const untrusted = { senderFrame: { url: 'https://evil.example/' } }
const reports: unknown[] = []
const posted: MpvInfo[] = []
const settings = { current: defaultSettings(), get: () => settings.current }
const locate = vi.fn(() =>
  Promise.resolve({
    status: 'ok' as const,
    kind: 'system' as const,
    path: '/usr/bin/mpv',
    version: '0.41.0',
    source: 'path' as const,
    tried: [{ source: 'path' as const, path: '/usr/bin/mpv', status: 'ok' as const, version: '0.41.0' }],
  }),
)
const mpv = new MpvService(null, { info: vi.fn(), warn: vi.fn() }, locate)
mpv.on('change', (i) => posted.push(i))

function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return fn(event, ...args)
}

beforeAll(() => {
  registerIpc({
    settings: settings as never,
    theme: new EventEmitter() as never,
    deepLinks: { take: () => null } as never,
    mpv,
    onSessionReport: (r) => reports.push(r),
  })
})

describe('registerIpc', () => {
  it('handles every invoke channel the preload uses', () => {
    const sendOnly: string[] = [APP_CHANNELS.reportSession]
    for (const ch of Object.values(APP_CHANNELS)) {
      if (sendOnly.includes(ch)) expect(listeners.has(ch)).toBe(true)
      else expect(handlers.has(ch), ch).toBe(true)
    }
  })

  it('accepts session reports only from our UI, and only well-formed ones', () => {
    const on = listeners.get(APP_CHANNELS.reportSession)
    on?.(untrusted, { inRoom: true, title: 'x' })
    on?.(trusted, { inRoom: 'yes', title: null })
    on?.({ senderFrame: null }, { inRoom: true, title: null })
    expect(reports).toEqual([])
    on?.(trusted, { inRoom: true, title: 'Movie.mkv' })
    expect(reports).toEqual([{ inRoom: true, title: 'Movie.mkv' }])
  })

  it('recheckMpv looks up the saved mpvPath, returns the result and passes it on', async () => {
    settings.current = { ...defaultSettings(), mpvPath: '/usr/bin/mpv' }
    const r = await invoke(APP_CHANNELS.recheckMpv, trusted)
    expect(locate).toHaveBeenLastCalledWith({ mpvPath: '/usr/bin/mpv', resourcesPath: null })
    expect(r).toMatchObject({ ok: true, value: { path: '/usr/bin/mpv', status: 'ok' } })
    expect(posted.at(-1)).toMatchObject({ path: '/usr/bin/mpv', version: '0.41.0' })
    expect(mpv.info.path).toBe('/usr/bin/mpv')
  })

  it('rejects untrusted senders', () => {
    expect(() => invoke(APP_CHANNELS.recheckMpv, untrusted)).toThrow(/untrusted sender/)
  })

  it('copyDiagnostics takes no argument, null, or core diagnostics, and includes main mpv info', async () => {
    expect(await invoke(APP_CHANNELS.copyDiagnostics, trusted)).toEqual({ ok: true, value: null })
    expect(await invoke(APP_CHANNELS.copyDiagnostics, trusted, null)).toEqual({ ok: true, value: null })
    expect(clipboardText.at(-1)).toContain('at /usr/bin/mpv, version 0.41.0 (ok)')
    expect(() => invoke(APP_CHANNELS.copyDiagnostics, trusted, 1, 2)).toThrow()
  })

  it('reports the Linux distro in AppInfo', async () => {
    const info = (await invoke(APP_CHANNELS.info, trusted)) as { distro?: string | null }
    expect('distro' in info).toBe(true)
    if (process.platform !== 'linux') expect(info.distro).toBeNull()
  })
})
