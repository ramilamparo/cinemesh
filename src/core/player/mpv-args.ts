import type { Role } from '../../shared/ipc/core.js'
import type { Settings } from '../../shared/settings.js'
import { MPV_STREAM_OPTS } from '../media/mpv-stream-opts.js'
import { type MpvVersion, atLeast } from './mpv-version.js'

export type MpvOs = 'linux' | 'win32' | 'darwin'
export type SessionType = 'wayland' | 'x11' | null

/** fd: --input-ipc-client=fd://3 (a socketpair on stdio[3]); server: a Unix socket or Windows named pipe. */
export type IpcSpec = { mode: 'fd' } | { mode: 'server'; path: string }

export interface MpvArgsInput {
  version: MpvVersion
  os: MpvOs
  sessionType: SessionType
  role: Role
  ipc: IpcSpec
  /** absolute path of wt-osc.lua */
  script: string
  logFile: string | null
  settings: Pick<Settings, 'hwdec' | 'alang' | 'slang' | 'macHdrExperimental'>
  mediaTitle: string | null
}

type Ver = readonly [major: number, minor: number]

/**
 * Options whose name or existence depends on the mpv version; mpv exits on an unknown option.
 * Rows apply when `since <= version < before`. The source of truth is the version table in ADR 0004
 * §6.1 (options.rst at v0.39.0, v0.40.0 and v0.41.0); mpv-args.test.ts checks every row of it.
 */
export const VERSIONED_ARGS: readonly { since?: Ver; before?: Ver; args: readonly string[]; note: string }[] = [
  { before: [0, 40], args: ['--load-osd-console=yes'], note: 'renamed to --load-console in 0.40' },
  { since: [0, 40], args: ['--load-console=yes'], note: '' },
  { since: [0, 40], args: ['--load-commands=no', '--load-positioning=no'], note: 'scripts split out in 0.40' },
  { since: [0, 41], args: ['--load-context-menu=no'], note: 'context menu script added in 0.41' },
]

const COMMON_ARGS: readonly string[] = [
  '--no-config',
  '--load-scripts=no',
  '--osc=no',
  '--input-default-bindings=no',
  '--input-builtin-bindings=no',
  '--input-media-keys=no',
  // This and --input-builtin-dragging are already in options.rst v0.39.0 (ADR 0004, finding 13).
  '--media-controls=no',
  '--drag-and-drop=no',
  '--terminal=no',
  '--input-terminal=no',
  '--input-builtin-dragging=no',
  '--load-select=yes',
  '--load-auto-profiles=no',
  '--load-stats-overlay=yes',
  '--ytdl=no',
  '--idle=yes',
  '--force-window=immediate',
  '--keep-open=always',
  '--resume-playback=no',
  '--save-position-on-quit=no',
  '--sub-auto=no',
  '--audio-file-auto=no',
  '--cover-art-auto=no',
  '--osd-bar=no',
  '--osd-on-seek=no',
  '--hr-seek=yes',
  '--demuxer-mkv-subtitle-preroll-secs-index=2',
  '--autofit-larger=90%x90%',
]

// Viewers only: the host opens a local file, where mpv's defaults (no demuxer cache) are right.
// The media module owns these (they must match its HTTP server and MediaMap preroll).
export const STREAM_ARGS: readonly string[] = MPV_STREAM_OPTS.filter((a) => !COMMON_ARGS.includes(a))

export function buildMpvArgs(input: MpvArgsInput): string[] {
  const { version, settings } = input
  const args = [`--script=${input.script}`, ...COMMON_ARGS]
  for (const row of VERSIONED_ARGS) {
    if (row.since && !atLeast(version, ...row.since)) continue
    if (row.before && atLeast(version, ...row.before)) continue
    args.push(...row.args)
  }
  if (input.role === 'viewer') args.push(...STREAM_ARGS)
  args.push(...videoArgs(input))
  args.push(`--hwdec=${settings.hwdec}`)
  if (settings.alang.length > 0) args.push(`--alang=${settings.alang.join(',')}`)
  if (settings.slang.length > 0) args.push(`--slang=${settings.slang.join(',')}`)
  if (input.mediaTitle !== null) args.push(`--force-media-title=${input.mediaTitle}`)
  if (input.os === 'linux') args.push('--wayland-app-id=cinemesh-player')
  if (input.logFile !== null) args.push(`--log-file=${input.logFile}`)
  args.push(input.ipc.mode === 'fd' ? '--input-ipc-client=fd://3' : `--input-ipc-server=${input.ipc.path}`)
  return args
}

function videoArgs({ os, version, sessionType, settings }: MpvArgsInput): string[] {
  // auto|yes|no since 0.40 (default no; 0.41 made auto the default); 0.39 only has a yes/no flag.
  const modernHint = atLeast(version, 0, 40)
  switch (os) {
    case 'linux':
      return [
        '--vo=gpu-next',
        '--gpu-api=vulkan,opengl',
        `--target-colorspace-hint=${modernHint ? 'auto' : sessionType === 'wayland' ? 'yes' : 'no'}`,
      ]
    case 'win32':
      return [
        '--vo=gpu-next',
        '--gpu-api=d3d11,vulkan',
        '--d3d11-output-csp=auto',
        `--target-colorspace-hint=${modernHint ? 'auto' : 'yes'}`,
      ]
    case 'darwin':
      // cocoa-cb (selected by --vo=libmpv in the standalone player) is the only EDR-capable path.
      if (settings.macHdrExperimental) return ['--vo=libmpv', '--target-colorspace-hint=yes']
      return ['--vo=gpu-next', '--gpu-api=vulkan', `--target-colorspace-hint=${modernHint ? 'auto' : 'no'}`]
  }
}
