import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { MpvCandidateInfo, MpvInfo } from '../shared/ipc/control.js'
import { mpvChildEnv } from '../core/player/child-env.js'
import { MIN_MPV, type MpvVersion, compareVersion, formatVersion, parseMpvVersion } from '../core/player/mpv-version.js'

export { mpvChildEnv }

export const FLATPAK_APP = 'io.mpv.Mpv'

export type MpvSource = MpvCandidateInfo['source']

export type MpvCandidate = MpvCandidateInfo

export interface MpvLocateResult {
  status: 'ok' | 'missing' | 'tooOld'
  kind: MpvInfo['kind']
  /** the executable to spawn; for Flatpak the flatpak binary (spawn as `flatpak run io.mpv.Mpv ...`) */
  path: string | null
  version: string | null
  source: MpvSource | null
  /** every candidate looked at, in order, for MpvSetup and diagnostics */
  tried: MpvCandidate[]
}

export interface LocateOptions {
  /** settings.mpvPath */
  mpvPath: string | null
  /** process.resourcesPath in a packaged app; null in dev */
  resourcesPath: string | null
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/** Where scripts/fetch-mpv.mjs puts the official build inside the packaged resources. */
export function bundledMpvPath(resourcesPath: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return join(resourcesPath, 'mpv', 'mpv.exe')
  if (platform === 'darwin') return join(resourcesPath, 'mpv', 'mpv.app', 'Contents', 'MacOS', 'mpv')
  return join(resourcesPath, 'mpv', 'mpv')
}

/**
 * Finds mpv: settings.mpvPath, then the bundled build, then PATH, then Flatpak io.mpv.Mpv (plan §4.4).
 * The first candidate at or above the minimum version wins; otherwise the first one found decides
 * between 'tooOld' and 'missing'.
 */
export async function locateMpv(opts: LocateOptions): Promise<MpvLocateResult> {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const timeoutMs = opts.timeoutMs ?? 10_000
  const tried: MpvCandidate[] = []
  const bundled = opts.resourcesPath === null ? null : bundledMpvPath(opts.resourcesPath, platform)

  const consider = async (source: MpvSource, path: string): Promise<MpvCandidate> => {
    const c = await probeExecutable(source, path, env, timeoutMs)
    tried.push(c)
    return c
  }

  const sequence: (() => Promise<MpvCandidate | null>)[] = [
    async () => (opts.mpvPath ? consider('settings', opts.mpvPath) : null),
    async () => (bundled && (await isExecutable(bundled, platform)) ? consider('bundled', bundled) : null),
    async () => {
      const found = await findOnPath(platform === 'win32' ? ['mpv.exe', 'mpv.com'] : ['mpv'], platform, env)
      return found ? consider('path', found) : null
    },
    async () => {
      if (platform !== 'linux') return null
      const c = await probeFlatpak(env, timeoutMs)
      if (c) tried.push(c)
      return c
    },
  ]

  for (const step of sequence) {
    const c = await step()
    if (c?.status === 'ok') return result('ok', c, bundled, tried)
  }
  const old = tried.find((c) => c.status === 'tooOld')
  if (old) return result('tooOld', old, bundled, tried)
  return { status: 'missing', kind: 'none', path: null, version: null, source: null, tried }
}

export function toMpvInfo(r: MpvLocateResult): MpvInfo {
  const tried = r.tried.map((c) => ({ ...c }))
  return r.status === 'ok'
    ? { path: r.path, kind: r.kind, version: r.version, status: 'ok', tried }
    : { path: null, kind: 'none', version: r.version, status: r.status, tried }
}

/** Run `<command> ...args` and parse its `mpv --version` banner. */
export async function readMpvVersion(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ version: MpvVersion | null; output: string }> {
  const output = await run(command, args, env, timeoutMs)
  return { version: parseMpvVersion(output), output }
}

function result(
  status: 'ok' | 'tooOld',
  c: MpvCandidate,
  bundled: string | null,
  tried: MpvCandidate[],
): MpvLocateResult {
  const kind: MpvInfo['kind'] =
    c.source === 'flatpak' ? 'flatpak' : c.path === bundled || c.source === 'bundled' ? 'bundled' : 'system'
  return { status, kind, path: c.path, version: c.version, source: c.source, tried }
}

async function probeExecutable(
  source: MpvSource,
  path: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<MpvCandidate> {
  try {
    const { version, output } = await readMpvVersion(path, ['--version'], env, timeoutMs)
    return classify(source, path, version, output)
  } catch (e) {
    return { source, path, status: 'unusable', version: null, detail: e instanceof Error ? e.message : String(e) }
  }
}

async function probeFlatpak(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<MpvCandidate | null> {
  const flatpak = await findOnPath(['flatpak'], 'linux', env)
  if (!flatpak) return null
  let info: string
  try {
    info = await run(flatpak, ['info', FLATPAK_APP], env, timeoutMs)
  } catch {
    return null // not installed
  }
  // `flatpak info` prints "Version: 0.41.0" without starting the sandbox; fall back to running it.
  const m = /^\s*Version:\s*(\S+)/m.exec(info)
  let version = m?.[1] ? parseMpvVersion(`mpv ${m[1]}`) : null
  let output = info
  if (!version) {
    try {
      ;({ version, output } = await readMpvVersion(flatpak, ['run', FLATPAK_APP, '--version'], env, timeoutMs))
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      return { source: 'flatpak', path: flatpak, status: 'unusable', version: null, detail }
    }
  }
  return classify('flatpak', flatpak, version, output)
}

function classify(source: MpvSource, path: string, version: MpvVersion | null, output: string): MpvCandidate {
  if (!version) {
    const first = output.split('\n', 1)[0]?.trim() ?? ''
    return { source, path, status: 'unusable', version: null, detail: `unrecognised version output: ${first}` }
  }
  const status = compareVersion(version, MIN_MPV) >= 0 ? 'ok' : 'tooOld'
  return { source, path, status, version: formatVersion(version) }
}

async function findOnPath(names: string[], platform: NodeJS.Platform, env: NodeJS.ProcessEnv): Promise<string | null> {
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  // Apps started from Finder get a minimal PATH that misses Homebrew.
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      if (await isExecutable(p, platform)) return p
    }
  }
  return null
}

async function isExecutable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false
    if (platform !== 'win32') await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { env: mpvChildEnv(env), timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(new Error(error.message))
        else resolve(stdout)
      },
    )
  })
}
