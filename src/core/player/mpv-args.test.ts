import { describe, expect, it } from 'vitest'
import { type MpvArgsInput, type MpvOs, STREAM_ARGS, type SessionType, buildMpvArgs } from './mpv-args.js'
import { versionFromString } from './mpv-version.js'

function input(version: string, os: MpvOs, sessionType: SessionType, over: Partial<MpvArgsInput> = {}): MpvArgsInput {
  const v = versionFromString(version)
  if (!v) throw new Error(version)
  return {
    version: v,
    os,
    sessionType,
    role: 'viewer',
    ipc: os === 'win32' ? { mode: 'server', path: '\\\\.\\pipe\\wt-mpv-1-0123456789abcdef' } : { mode: 'fd' },
    script: '/res/mpv-scripts/wt-osc.lua',
    logFile: '/logs/mpv.log',
    settings: { hwdec: 'auto-safe', alang: [], slang: [], macHdrExperimental: false },
    mediaTitle: 'Movie.mkv',
    ...over,
  }
}

describe('buildMpvArgs', () => {
  const matrix: [string, MpvOs, SessionType][] = [
    ['0.39.0', 'linux', 'wayland'],
    ['0.39.0', 'linux', 'x11'],
    ['0.40.0', 'linux', 'wayland'],
    ['0.40.0', 'linux', 'x11'],
    ['0.41.0', 'linux', 'wayland'],
    ['0.41.0', 'win32', null],
    ['0.41.0', 'darwin', null],
  ]
  it.each(matrix)('mpv %s on %s/%s', (version, os, session) => {
    expect(buildMpvArgs(input(version, os, session))).toMatchSnapshot()
  })

  it('applies the per-version option names', () => {
    const v39 = buildMpvArgs(input('0.39.0', 'linux', 'x11'))
    expect(v39).toContain('--load-osd-console=yes')
    expect(v39.filter((a) => /--load-(console|commands|positioning|context-menu)=/.test(a))).toEqual([])
    expect(v39).toContain('--target-colorspace-hint=no')

    const v40 = buildMpvArgs(input('0.40.0-482-gcd6d2b3', 'linux', 'wayland'))
    expect(v40).toEqual(expect.arrayContaining(['--load-console=yes', '--load-commands=no', '--load-positioning=no']))
    expect(v40).not.toContain('--load-context-menu=no')
    expect(v40).toContain('--target-colorspace-hint=auto')

    const v41 = buildMpvArgs(input('0.41.0', 'linux', 'x11'))
    expect(v41).toContain('--load-context-menu=no')
    expect(v41).toContain('--target-colorspace-hint=auto')
    expect(v41).not.toContain('--load-osd-console=yes')
  })

  // ADR 0004 §6.1 is the source of truth (options.rst at each tag; only 0.41 was executed). Each row: the
  // options it governs, and what each version gets on each platform.
  type Release = '0.39.0' | '0.40.0' | '0.41.0'
  const ADR_TABLE: { row: string; governs: RegExp; args: (v: Release, os: MpvOs, s: SessionType) => string[] }[] = [
    {
      row: 'console script',
      governs: /^--load-(osd-)?console=/,
      args: (v) => [v === '0.39.0' ? '--load-osd-console=yes' : '--load-console=yes'],
    },
    {
      row: '--load-commands=no, --load-positioning=no',
      governs: /^--load-(commands|positioning)=/,
      args: (v) => (v === '0.39.0' ? [] : ['--load-commands=no', '--load-positioning=no']),
    },
    {
      row: '--load-context-menu=no',
      governs: /^--load-context-menu=/,
      args: (v) => (v === '0.41.0' ? ['--load-context-menu=no'] : []),
    },
    {
      row: '--target-colorspace-hint',
      governs: /^--target-colorspace-hint=/,
      args: (v, os, s) => [
        `--target-colorspace-hint=${v !== '0.39.0' ? 'auto' : os === 'win32' || s === 'wayland' ? 'yes' : 'no'}`,
      ],
    },
    {
      row: '--media-controls=no, --input-builtin-dragging=no',
      governs: /^--(media-controls|input-builtin-dragging)=/,
      args: () => ['--media-controls=no', '--input-builtin-dragging=no'],
    },
  ]
  const RELEASES: Release[] = ['0.39.0', '0.40.0', '0.41.0']
  const PLATFORMS: [MpvOs, SessionType][] = [
    ['linux', 'wayland'],
    ['linux', 'x11'],
    ['win32', null],
    ['darwin', null],
  ]

  describe.each(PLATFORMS)('ADR 0004 version table on %s/%s', (os, session) => {
    it.each(ADR_TABLE.map((r) => [r.row, r] as const))('row %s', (_, row) => {
      for (const v of RELEASES) {
        const got = buildMpvArgs(input(v, os, session)).filter((a) => row.governs.test(a))
        expect(got.sort(), `mpv ${v}`).toEqual(row.args(v, os, session).sort())
      }
    })

    it('every other option is identical in 0.39, 0.40 and 0.41', () => {
      const rest = (v: Release) =>
        buildMpvArgs(input(v, os, session)).filter((a) => !ADR_TABLE.some((r) => r.governs.test(a)))
      expect(rest('0.39.0')).toEqual(rest('0.41.0'))
      expect(rest('0.40.0')).toEqual(rest('0.41.0'))
    })
  })

  // The plan §4.4 list as given for 0.41, plus what Linux adds (GPU API, IPC flag).
  // prettier-ignore
  const PLAN_041_LINUX = [
    '--no-config', '--script=/res/mpv-scripts/wt-osc.lua', '--load-scripts=no', '--osc=no',
    '--input-default-bindings=no', '--input-builtin-bindings=no', '--input-media-keys=no', '--media-controls=no',
    '--drag-and-drop=no', '--terminal=no', '--input-terminal=no', '--input-builtin-dragging=no',
    '--load-console=yes', '--load-select=yes', '--load-commands=no', '--load-context-menu=no', '--load-positioning=no',
    '--load-auto-profiles=no', '--load-stats-overlay=yes', '--ytdl=no',
    '--idle=yes', '--force-window=immediate', '--keep-open=always', '--resume-playback=no', '--save-position-on-quit=no',
    '--sub-auto=no', '--audio-file-auto=no', '--cover-art-auto=no', '--osd-bar=no', '--osd-on-seek=no',
    '--cache=yes', '--cache-on-disk=no', '--demuxer-max-bytes=96MiB', '--demuxer-max-back-bytes=32MiB', '--cache-secs=60',
    '--demuxer-seekable-cache=yes', '--cache-pause=yes', '--cache-pause-initial=no', '--cache-pause-wait=1',
    '--network-timeout=0', '--stream-buffer-size=1MiB', '--hr-seek=yes', '--demuxer-mkv-subtitle-preroll-secs-index=2',
    '--vo=gpu-next', '--hwdec=auto-safe', '--target-colorspace-hint=auto', '--force-media-title=Movie.mkv',
    '--autofit-larger=90%x90%', '--wayland-app-id=watch-together-player', '--log-file=/logs/mpv.log',
    '--gpu-api=vulkan,opengl', '--input-ipc-client=fd://3',
  ]
  const sorted = (a: readonly string[]): string[] => [...a].sort()

  it('gives 0.41 on Linux the whole plan §4.4 list, plus the GPU API and the IPC flag', () => {
    expect(sorted(buildMpvArgs(input('0.41.0', 'linux', 'wayland')))).toEqual(sorted(PLAN_041_LINUX))
  })

  it('gives 0.40 the 0.41 list without --load-context-menu (ADR 0004 §6.1)', () => {
    const want = PLAN_041_LINUX.filter((a) => a !== '--load-context-menu=no')
    expect(sorted(buildMpvArgs(input('0.40.0', 'linux', 'wayland')))).toEqual(sorted(want))
    expect(sorted(buildMpvArgs(input('0.40.0', 'linux', 'x11')))).toEqual(sorted(want))
  })

  it('gives 0.39 --load-osd-console, none of the 0.40/0.41 scripts and the hint as a flag (ADR 0004 §6.1)', () => {
    const later = ['--load-console=yes', '--load-commands=no', '--load-positioning=no', '--load-context-menu=no']
    const base = PLAN_041_LINUX.filter((a) => !later.includes(a) && a !== '--target-colorspace-hint=auto')
    expect(sorted(buildMpvArgs(input('0.39.0', 'linux', 'wayland')))).toEqual(
      sorted([...base, '--load-osd-console=yes', '--target-colorspace-hint=yes']),
    )
    expect(sorted(buildMpvArgs(input('0.39.0', 'linux', 'x11')))).toEqual(
      sorted([...base, '--load-osd-console=yes', '--target-colorspace-hint=no']),
    )
  })

  it('uses the right IPC flag', () => {
    expect(buildMpvArgs(input('0.41.0', 'linux', 'wayland'))).toContain('--input-ipc-client=fd://3')
    const sock = buildMpvArgs(input('0.41.0', 'linux', 'wayland', { ipc: { mode: 'server', path: '/run/x.sock' } }))
    expect(sock).toContain('--input-ipc-server=/run/x.sock')
    expect(sock.some((a) => a.startsWith('--input-ipc-client'))).toBe(false)
  })

  it('adds stream options for viewers only, and user settings', () => {
    const host = buildMpvArgs(input('0.41.0', 'linux', 'wayland', { role: 'host' }))
    for (const a of STREAM_ARGS) expect(host).not.toContain(a)
    const viewer = buildMpvArgs(
      input('0.41.0', 'linux', 'wayland', {
        settings: { hwdec: 'no', alang: ['jpn', 'eng'], slang: ['eng'], macHdrExperimental: false },
        mediaTitle: null,
        logFile: null,
      }),
    )
    expect(viewer).toEqual(expect.arrayContaining([...STREAM_ARGS, '--hwdec=no', '--alang=jpn,eng', '--slang=eng']))
    expect(viewer.some((a) => a.startsWith('--force-media-title') || a.startsWith('--log-file'))).toBe(false)
  })

  it('switches macOS to cocoa-cb for experimental HDR', () => {
    const settings = { hwdec: 'auto-safe' as const, alang: [], slang: [], macHdrExperimental: true }
    const mac = buildMpvArgs(input('0.41.0', 'darwin', null, { settings }))
    expect(mac).toEqual(expect.arrayContaining(['--vo=libmpv', '--target-colorspace-hint=yes']))
    expect(mac).not.toContain('--vo=gpu-next')
  })

  it('never passes platform-specific options to another platform', () => {
    const linux = buildMpvArgs(input('0.41.0', 'linux', 'x11'))
    expect(linux.some((a) => a.startsWith('--d3d11'))).toBe(false)
    const win = buildMpvArgs(input('0.41.0', 'win32', null))
    expect(win.some((a) => a.startsWith('--wayland'))).toBe(false)
  })
})
