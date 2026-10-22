// Prototype of src/core/player/mpv-args.ts: the plan §4.4 argv, version-aware (0.39 / 0.40 / 0.41).
export interface MpvVersion { major: number, minor: number, patch: number }
export type Os = 'linux' | 'win32' | 'darwin'
export interface ArgsInput {
  version: MpvVersion
  os: Os
  wayland: boolean
  resDir: string
  logFile: string
  mediaTitle: string
  ipc: string // '--input-ipc-client=fd://3' or '--input-ipc-server=…'
}

export function parseMpvVersion (out: string): MpvVersion | null {
  const m = /mpv v?(\d+)\.(\d+)\.(\d+)/.exec(out)
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null
}
const atLeast = (v: MpvVersion, minor: number) => v.major > 0 || v.minor >= minor

export function mpvArgs (i: ArgsInput): string[] {
  const v = i.version
  const a = [
    '--no-config', `--script=${i.resDir}/mpv-scripts/wt-osc.lua`, '--load-scripts=no', '--osc=no',
    '--input-default-bindings=no', '--input-builtin-bindings=no', '--input-media-keys=no', '--media-controls=no',
    '--drag-and-drop=no', '--terminal=no', '--input-terminal=no', '--input-builtin-dragging=no',
    // 0.40 renamed --load-osd-console to --load-console and split out commands.lua / positioning.lua
    atLeast(v, 40) ? '--load-console=yes' : '--load-osd-console=yes',
    '--load-select=yes',
    ...(atLeast(v, 40) ? ['--load-commands=no', '--load-positioning=no'] : []),
    ...(atLeast(v, 41) ? ['--load-context-menu=no'] : []),
    '--load-auto-profiles=no', '--load-stats-overlay=yes', '--ytdl=no',
    '--idle=yes', '--force-window=immediate', '--keep-open=always', '--resume-playback=no', '--save-position-on-quit=no',
    '--sub-auto=no', '--audio-file-auto=no', '--cover-art-auto=no', '--osd-bar=no', '--osd-on-seek=no',
    '--cache=yes', '--cache-on-disk=no', '--demuxer-max-bytes=96MiB', '--demuxer-max-back-bytes=32MiB', '--cache-secs=60',
    '--demuxer-seekable-cache=yes', '--cache-pause=yes', '--cache-pause-initial=no', '--cache-pause-wait=1',
    '--network-timeout=0', '--stream-buffer-size=1MiB', '--hr-seek=yes', '--demuxer-mkv-subtitle-preroll-secs-index=2',
    '--vo=gpu-next', '--hwdec=auto-safe',
    // 0.39: flag only. 0.40: auto|yes|no (default no). 0.41: auto|yes|no (default auto).
    atLeast(v, 40) ? '--target-colorspace-hint=auto' : `--target-colorspace-hint=${i.os === 'win32' || (i.os === 'linux' && i.wayland) ? 'yes' : 'no'}`,
    `--force-media-title=${i.mediaTitle}`, '--autofit-larger=90%x90%', '--wayland-app-id=watch-together-player', `--log-file=${i.logFile}`,
    ...(i.os === 'linux' ? ['--gpu-api=vulkan,opengl'] : i.os === 'win32' ? ['--gpu-api=d3d11,vulkan', '--d3d11-output-csp=auto'] : []),
    i.ipc,
  ]
  return a
}
