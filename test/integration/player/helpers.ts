import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import type { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { type MpvCommand, MpvIpc } from '../../../src/core/player/mpv-ipc.js'
import { type MpvVersion, parseMpvVersion } from '../../../src/core/player/mpv-version.js'
import type { PlayerController } from '../../../src/core/player/player-controller.js'

export const REPO = resolve(import.meta.dirname, '../../..')
export const RESOURCES = join(REPO, 'resources')
export const OSC_SCRIPT_PATH = join(RESOURCES, 'mpv-scripts', 'wt-osc.lua')
export const HEADLESS = ['--vo=null', '--ao=null']

function probe(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
  } catch {
    return null
  }
}

const versionOutput = probe('mpv', ['--version'])
export const MPV_VERSION: MpvVersion | null = versionOutput ? parseMpvVersion(versionOutput) : null
export const HAVE_MPV = MPV_VERSION !== null
export const HAVE_FFMPEG = probe('ffmpeg', ['-version']) !== null

export interface Fixture {
  dir: string
  clip: string
  srt: string
  cleanup: () => Promise<void>
}

/** A testsrc2 clip (10 s by default) with two audio tracks (eng, jpn) and an .srt next to it. */
export async function makeFixture(opts: { durationS?: number; videoBitrate?: string } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'wt-player-'))
  const clip = join(dir, 'clip.mkv')
  const srt = join(dir, 'clip.srt')
  const d = String(opts.durationS ?? 10)
  const rate = opts.videoBitrate ? ['-b:v', opts.videoBitrate] : []
  // prettier-ignore
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${d}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${d}`,
    '-f', 'lavfi', '-i', `sine=frequency=880:duration=${d}`,
    '-map', '0', '-map', '1', '-map', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', ...rate, '-c:a', 'aac',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=jpn',
    clip,
  ], { timeout: 60_000 })
  await writeFile(srt, '1\n00:00:01,000 --> 00:00:09,000\nHello\n')
  return { dir, clip, srt, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export interface RawMpv {
  child: ChildProcess
  ipc: MpvIpc
  stop: () => Promise<void>
}

/** mpv with --input-ipc-client=fd://3 and the given extra arguments. */
export function spawnMpv(args: string[]): RawMpv {
  const child = spawn('mpv', ['--no-config', '--idle=yes', ...HEADLESS, '--input-ipc-client=fd://3', ...args], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  })
  const ipc = new MpvIpc(child.stdio[3] as Duplex)
  return { child, ipc, stop: () => stopChild(child, ipc) }
}

export async function stopChild(child: ChildProcess, ipc?: MpvIpc): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  ipc?.close()
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
  await exited
  clearTimeout(timer)
}

/** Resolves with the event's arguments once `pred` accepts them. */
export function waitFor<A extends unknown[]>(
  emitter: EventEmitter,
  event: string,
  pred: (...args: A) => boolean = () => true,
  timeoutMs = 10_000,
): Promise<A> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, on)
      reject(new Error(`timed out waiting for ${event}`))
    }, timeoutMs)
    const on = (...args: A): void => {
      if (!pred(...args)) return
      clearTimeout(timer)
      emitter.off(event, on)
      resolve(args)
    }
    emitter.on(event, on)
  })
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** What `p` settles to, or 'stalled' after `ms`: a bound on a run that fails, not a wait for something. */
export async function within<T>(p: Promise<T>, ms = 10_000): Promise<T | 'stalled'> {
  let timer: NodeJS.Timeout | undefined
  const stalled = new Promise<'stalled'>((resolve) => {
    timer = setTimeout(() => resolve('stalled'), ms)
  })
  try {
    return await Promise.race([p, stalled])
  } finally {
    clearTimeout(timer)
  }
}

export interface IpcTap {
  commands: MpvCommand[]
  /** set_property calls for aid and sid */
  sets: [string, unknown][]
}

/**
 * Records the commands and the aid/sid set_property calls the controller sends on its current IPC
 * connection. A restarted mpv has a new one: tap it from a 'state' listener on 'idle', which runs
 * before the controller's own reload is sent.
 */
export function tapIpc(p: PlayerController, tap: IpcTap = { commands: [], sets: [] }): IpcTap {
  const ipc = (p as unknown as { ipc: MpvIpc | null }).ipc
  if (!ipc) throw new Error('the player has no IPC connection')
  const command = ipc.command.bind(ipc)
  const setProperty = ipc.setProperty.bind(ipc)
  ipc.command = (args, opts) => {
    tap.commands.push(args)
    return command(args, opts)
  }
  ipc.setProperty = (name, value) => {
    if (name === 'aid' || name === 'sid') tap.sets.push([name, value])
    return setProperty(name, value)
  }
  return tap
}

/** The per-file options of every loadfile in `commands`. */
export const loadfiles = (commands: readonly MpvCommand[]): string[] =>
  commands.flatMap((c) => (Array.isArray(c) && c[0] === 'loadfile' ? [String(c[4])] : []))

/** Lines the OSC logged at error or fatal level: Lua runtime errors are "[f][wt_osc] Lua error: ...". */
export async function oscErrors(logFile: string): Promise<string[]> {
  const text = await readFile(logFile, 'utf8').catch(() => '')
  return text.split('\n').filter((l) => /\[[ef]\]\[wt_osc\]/.test(l) || /wt_osc.*(Lua error|stack traceback)/i.test(l))
}

/** A short directory for Unix sockets (sun_path is limited to ~104 bytes). */
export async function socketDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const base = process.env.XDG_RUNTIME_DIR ?? '/tmp'
  const dir = await mkdtemp(join(base, 'wt-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
