import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../shared/settings.js'

const written: string[] = []
vi.mock('electron', () => ({
  app: { getVersion: () => '1.2.3', isPackaged: false, getPath: () => '/nowhere' },
  clipboard: { writeText: (t: string) => Promise.resolve(void written.push(t)) },
}))

const { copyDiagnostics, formatDiagnostics, readTail, redactInvites, tildify } = await import('./diagnostics.js')

const CODE = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(4)
const dir = mkdtempSync(join(tmpdir(), 'wt-diag-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('diagnostics', () => {
  it('redacts invite links and bare codes', () => {
    expect(redactInvites(`joining cinemesh://join/${CODE} now`)).toBe('joining cinemesh://join/[invite redacted] now')
    expect(redactInvites(`code ${CODE.toUpperCase()}`)).toBe('code [invite redacted]')
    expect(redactInvites('ordinary words stay')).toBe('ordinary words stay')
  })

  it('shows home paths as ~', () => {
    expect(tildify('/home/ram/Videos/a.mkv and /home/ram', '/home/ram')).toBe('~/Videos/a.mkv and ~')
    expect(tildify('"C:\\\\Users\\\\ram\\\\x"', 'C:\\Users\\ram')).toBe('"~\\\\x"')
  })

  it('reads the last lines of a log, tolerating missing files', async () => {
    const file = join(dir, 'main.log')
    writeFileSync(file, Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join('\n') + '\n')
    const tail = await readTail(file)
    expect(tail).toHaveLength(200)
    expect(tail[0]).toBe('line 100')
    expect(tail.at(-1)).toBe('line 299')
    expect(await readTail(join(dir, 'missing.log'))).toEqual([])
  })

  it('formats a Markdown report', () => {
    const md = formatDiagnostics({
      generatedAt: new Date('2026-10-19T00:00:00Z'),
      app: { version: '1.2.3', electron: '44.9.0', chrome: '140', node: '24', packaged: true, appImage: true },
      os: { platform: 'linux', release: '6.18', arch: 'x64', sessionType: 'wayland', desktop: 'niri' },
      mpv: { path: '/home/ram/bin/mpv', kind: 'system', version: '0.41.0' },
      core: {
        versions: { app: '1.2.3', electron: '44.9.0', node: '24', chrome: '140', protocol: 1 },
        uptimeS: 12,
        eventLoopDelayP99Ms: 4.25,
        rssBytes: 200e6,
        nat: { class: 'RANDOM', host: '198.51.100.7', port: null, bootstrapped: true, hint: 'Use a relay.' },
        peers: [{ id: 'abcdef0123456789', path: 'relayed', rttMs: 141.6 }],
        mpv: { path: null, version: '0.41.0', vo: 'gpu-next', hwdec: 'vaapi' },
        logTail: [],
      },
      settings: { ...defaultSettings(), downloadDir: '/home/ram/Downloads', relayKey: 'ab'.repeat(32) },
      home: '/home/ram',
      logs: [{ name: 'core.log', lines: [`got cinemesh://join/${CODE}`] }],
    })
    expect(md).toContain('## Cinemesh diagnostics')
    expect(md).toContain('- OS: linux 6.18 (x64)')
    expect(md).toContain('- Session: wayland, desktop niri')
    expect(md).toContain('at ~/bin/mpv, version 0.41.0')
    expect(md).toContain('vo gpu-next, hwdec vaapi')
    expect(md).toContain('NAT RANDOM')
    expect(md).not.toContain('198.51.100.7') // the public address stays private
    expect(md).toContain('| abcdef01 | relayed | 142 ms |')
    expect(md).toContain('event-loop delay p99 4.3 ms')
    expect(md).toContain('"downloadDir": "~/Downloads"')
    expect(md).toContain('"relayKey": "abababab…"')
    expect(md).not.toContain(CODE)
  })

  it('copies the report, falling back to core.log when core sent nothing', async () => {
    writeFileSync(join(dir, 'core.log'), `core says hi\ncinemesh://join/${CODE}\n`)
    const r = await copyDiagnostics(
      { settings: defaultSettings, mpv: () => ({ path: null, kind: 'none', version: null }), logsDir: dir },
      { bogus: true },
    )
    expect(r).toEqual({ ok: true, value: null })
    const md = written.at(-1) ?? ''
    expect(md).toContain('core says hi')
    expect(md).toContain('### main.log (last 200 lines)')
    expect(md).toContain('- Not reachable')
    expect(md).not.toContain(CODE)
  })

  it('lists the mpv lookup outcome and every candidate it tried', async () => {
    const r = await copyDiagnostics(
      {
        settings: defaultSettings,
        mpv: () => ({
          path: '/usr/bin/mpv',
          kind: 'system',
          version: '0.41.0',
          status: 'ok',
          tried: [
            { source: 'settings', path: '/home/ram/old/mpv', status: 'tooOld', version: '0.35.1' },
            { source: 'bundled', path: '/opt/wt/mpv', status: 'unusable', version: null, detail: 'EACCES\nmore' },
            { source: 'path', path: '/usr/bin/mpv', status: 'ok', version: '0.41.0' },
          ],
        }),
        logsDir: dir,
      },
      undefined,
    )
    expect(r.ok).toBe(true)
    const md = written.at(-1) ?? ''
    expect(md).toContain('at /usr/bin/mpv, version 0.41.0 (ok)')
    expect(md).toMatch(/tried settings: (~|\/home\/ram)\/old\/mpv → tooOld 0\.35\.1/)
    expect(md).toContain('tried bundled: /opt/wt/mpv → unusable (EACCES)')
    expect(md).toContain('tried path: /usr/bin/mpv → ok 0.41.0')
  })
})
