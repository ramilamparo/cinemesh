import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledMpvPath, locateMpv, mpvChildEnv, toMpvInfo } from './mpv-locate.js'

// Fake executables are shell scripts, so these run where /bin/sh exists.
describe.skipIf(process.platform === 'win32')('locateMpv', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wt-locate-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function fake(rel: string, script: string): Promise<string> {
    const path = join(root, rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, `#!/bin/sh\n${script}\n`)
    await chmod(path, 0o755)
    return path
  }
  const mpvPrinting = (banner: string): string => `echo "${banner}"\necho " built on Aug 29 2026"`
  const env = (...dirs: string[]): NodeJS.ProcessEnv => ({ PATH: dirs.map((d) => join(root, d)).join(':') })

  it('prefers settings.mpvPath', async () => {
    const custom = await fake(
      'custom/mpv',
      mpvPrinting('mpv v0.41.0 Copyright © 2000-2025 mpv/MPlayer/mplayer2 projects'),
    )
    await fake('bin/mpv', mpvPrinting('mpv v0.40.0 Copyright'))
    const r = await locateMpv({ mpvPath: custom, resourcesPath: null, platform: 'linux', env: env('bin') })
    expect(r).toMatchObject({ status: 'ok', kind: 'system', path: custom, version: '0.41.0', source: 'settings' })
  })

  it('falls back from a broken settings path to the bundled build', async () => {
    const res = join(root, 'res')
    const bundled = await fake('res/mpv/mpv', mpvPrinting('mpv v0.41.0 Copyright'))
    expect(bundledMpvPath(res, 'linux')).toBe(bundled)
    const r = await locateMpv({ mpvPath: join(root, 'nope'), resourcesPath: res, platform: 'linux', env: env() })
    expect(r).toMatchObject({ status: 'ok', kind: 'bundled', path: bundled, source: 'bundled' })
    expect(r.tried[0]).toMatchObject({ source: 'settings', status: 'unusable' })
  })

  it('finds mpv on PATH and parses git builds', async () => {
    await fake('empty/readme', 'true')
    const onPath = await fake('bin/mpv', mpvPrinting('mpv v0.40.0-482-gcd6d2b3 Copyright © 2000-2025'))
    const r = await locateMpv({ mpvPath: null, resourcesPath: null, platform: 'linux', env: env('empty', 'bin') })
    expect(r).toMatchObject({ status: 'ok', kind: 'system', path: onPath, version: '0.40.0-482-gcd6d2b3' })
  })

  it('reports tooOld when only an old mpv exists', async () => {
    await fake('bin/mpv', mpvPrinting('mpv 0.37.0 Copyright © 2000-2023 mpv/MPlayer/mplayer2 projects'))
    const r = await locateMpv({ mpvPath: null, resourcesPath: null, platform: 'linux', env: env('bin') })
    expect(r).toMatchObject({ status: 'tooOld', version: '0.37.0', source: 'path' })
    expect(toMpvInfo(r)).toEqual({
      path: null,
      kind: 'none',
      version: '0.37.0',
      status: 'tooOld',
      tried: [{ source: 'path', path: join(root, 'bin/mpv'), status: 'tooOld', version: '0.37.0' }],
    })
  })

  it('skips an old mpv on PATH for a current Flatpak', async () => {
    await fake('bin/mpv', mpvPrinting('mpv 0.38.0 Copyright'))
    const flatpak = await fake(
      'bin/flatpak',
      [
        'if [ "$1" = info ] && [ "$2" = io.mpv.Mpv ]; then',
        '  printf "\\nmpv - a media player\\n\\n          ID: io.mpv.Mpv\\n     Version: v0.41.0\\n"',
        '  exit 0',
        'fi',
        'exit 1',
      ].join('\n'),
    )
    const r = await locateMpv({ mpvPath: null, resourcesPath: null, platform: 'linux', env: env('bin') })
    expect(r).toMatchObject({ status: 'ok', kind: 'flatpak', path: flatpak, version: '0.41.0', source: 'flatpak' })
    expect(r.tried.map((c) => c.source)).toEqual(['path', 'flatpak'])
  })

  it('runs the Flatpak for its version when info has none', async () => {
    await fake(
      'bin/flatpak',
      [
        'if [ "$1" = info ]; then echo "ID: io.mpv.Mpv"; exit 0; fi',
        'if [ "$1" = run ] && [ "$3" = --version ]; then echo "mpv v0.39.0 Copyright"; exit 0; fi',
        'exit 1',
      ].join('\n'),
    )
    const r = await locateMpv({ mpvPath: null, resourcesPath: null, platform: 'linux', env: env('bin') })
    expect(r).toMatchObject({ status: 'ok', kind: 'flatpak', version: '0.39.0' })
  })

  it('reports missing when nothing is found or flatpak lacks the app', async () => {
    await fake('bin/flatpak', 'exit 1')
    await fake('bin/notmpv', mpvPrinting('mpv v0.41.0'))
    const r = await locateMpv({ mpvPath: null, resourcesPath: join(root, 'res'), platform: 'linux', env: env('bin') })
    expect(r).toEqual({ status: 'missing', kind: 'none', path: null, version: null, source: null, tried: [] })
  })

  it('marks output it cannot parse as unusable', async () => {
    await fake('bin/mpv', 'echo "mpv git-2016-ab12cd"')
    const r = await locateMpv({ mpvPath: null, resourcesPath: null, platform: 'linux', env: env('bin') })
    expect(r.status).toBe('missing')
    expect(r.tried[0]).toMatchObject({ status: 'unusable', detail: expect.stringContaining('git-2016') as unknown })
  })
})

describe('bundledMpvPath', () => {
  it('matches the per-OS layout of fetch-mpv', () => {
    expect(bundledMpvPath('/r', 'win32')).toBe(join('/r', 'mpv', 'mpv.exe'))
    expect(bundledMpvPath('/r', 'darwin')).toBe(join('/r', 'mpv', 'mpv.app', 'Contents', 'MacOS', 'mpv'))
  })
})

describe('mpvChildEnv', () => {
  it('strips the AppImage library overrides only under AppImage', () => {
    const base = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib', LD_PRELOAD: 'x.so', HOME: '/h' }
    expect(mpvChildEnv({ ...base, APPIMAGE: '/a/app.AppImage' })).toEqual({
      PATH: '/usr/bin',
      HOME: '/h',
      APPIMAGE: '/a/app.AppImage',
    })
    expect(mpvChildEnv(base)).toEqual(base)
  })
})
