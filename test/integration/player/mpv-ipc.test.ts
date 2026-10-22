import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildMpvArgs } from '../../../src/core/player/mpv-args.js'
import { MPV_ERRORS, MpvIpc } from '../../../src/core/player/mpv-ipc.js'
import {
  HAVE_MPV,
  HEADLESS,
  MPV_VERSION,
  OSC_SCRIPT_PATH,
  socketDir,
  spawnMpv,
  stopChild,
  until,
  waitFor,
} from './helpers.js'

describe.skipIf(!HAVE_MPV)('mpv argv against the installed mpv', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-args-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.each(['host', 'viewer'] as const)('accepts the %s argv (exit 0, no option errors)', async (role) => {
    if (!MPV_VERSION) return
    const logFile = join(dir, `${role}.log`)
    const args = buildMpvArgs({
      version: MPV_VERSION,
      os: 'linux',
      sessionType: 'wayland',
      role,
      ipc: { mode: 'fd' },
      script: OSC_SCRIPT_PATH,
      logFile,
      settings: { hwdec: 'auto-safe', alang: ['jpn'], slang: ['eng'], macHdrExperimental: false },
      mediaTitle: 'Movie, with comma.mkv',
    })
    const child = spawn('mpv', [...args, ...HEADLESS, '--idle=no'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))
    const [code] = (await once(child, 'exit')) as [number | null]
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const log = await readFile(logFile, 'utf8')
    expect(log).not.toMatch(/Error parsing option|unknown option|option .* not found/i)
  })
})

describe.skipIf(!HAVE_MPV)('MpvIpc against mpv', () => {
  it('talks over fd://3: client_name, get/set, observe, errors', async () => {
    const mpv = spawnMpv([])
    try {
      const { ipc } = mpv
      const name = await ipc.clientName()
      expect(name).toMatch(/^ipc/)

      const changes: unknown[] = []
      ipc.on('property-change', (p) => {
        if (p.name === 'volume') changes.push(p.value)
      })
      await ipc.observe('volume')
      // mpv coalesces notifications, so wait for the initial value before changing it
      await until(() => changes.length === 1)
      await ipc.setProperty('volume', 42)
      const v = await ipc.getProperty<number>('volume')
      expect(v.value).toBe(42)
      expect(v.tRecv).toBeGreaterThan(v.tSend)
      await until(() => changes.length === 2)
      expect(changes).toEqual([100, 42])

      await expect(ipc.getProperty('no-such-property')).rejects.toMatchObject({
        code: MPV_ERRORS.command,
        mpvError: 'property not found',
      })
      await expect(ipc.command(['no-such-command'])).rejects.toMatchObject({ code: MPV_ERRORS.command })
      // a script-message from inside mpv reaches us as client-message
      const msg = waitFor<[string[]]>(ipc, 'client-message', (args) => args[0] === 'hello')
      await ipc.command(['script-message-to', name, 'hello', 'world'])
      expect((await msg)[0]).toEqual(['hello', 'world'])
    } finally {
      await mpv.stop()
    }
  })

  it('times out and then fails pending requests when mpv dies', async () => {
    const mpv = spawnMpv([])
    try {
      // a subprocess keeps mpv from answering for 3 s
      const sleep3 = { name: 'subprocess', args: ['sleep', '3'], playback_only: false }
      const slow = mpv.ipc.command(sleep3, { timeoutMs: 100 })
      await expect(slow).rejects.toMatchObject({ code: MPV_ERRORS.timeout })
      // SIGTERM makes mpv abort the subprocess and quit; SIGKILL would orphan `sleep`. Whether mpv
      // still answers the aborted command before the socket closes depends on scheduling.
      const pending = mpv.ipc.command(sleep3, { timeoutMs: 10_000 }).then(
        (v) => v,
        (e: unknown) => e,
      )
      const closed = waitFor(mpv.ipc, 'close')
      mpv.child.kill('SIGTERM')
      const settled = await pending
      if (settled instanceof Error) expect(settled).toMatchObject({ code: MPV_ERRORS.closed })
      else expect(settled).toMatchObject({ killed_by_us: true })
      await closed
      await expect(mpv.ipc.getProperty('pause')).rejects.toMatchObject({ code: MPV_ERRORS.closed })
    } finally {
      await mpv.stop()
    }
  })

  it('connects to --input-ipc-server on a Unix socket, with retries', async () => {
    if (process.platform === 'win32') return
    const sock = await socketDir()
    const path = join(sock.dir, 'mpv.sock')
    const child = spawn('mpv', ['--no-config', '--idle=yes', ...HEADLESS, `--input-ipc-server=${path}`], {
      stdio: 'ignore',
    })
    let ipc: MpvIpc | undefined
    try {
      ipc = await MpvIpc.connect(path, { retryMs: 50, timeoutMs: 10_000 })
      expect(await ipc.clientName()).toMatch(/^ipc/)
      const second = await MpvIpc.connect(path)
      await second.setProperty('pause', true)
      expect((await ipc.getProperty('pause')).value).toBe(true)
      second.close()
    } finally {
      ipc?.close()
      await stopChild(child)
      await sock.cleanup()
    }
  })

  it('keeps fd://3 separate from stdio', async () => {
    const child = spawn('mpv', ['--no-config', '--idle=yes', ...HEADLESS, '--input-ipc-client=fd://3'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    })
    const ipc = new MpvIpc(child.stdio[3] as Duplex)
    try {
      expect(await ipc.command(['get_property', 'idle-active'])).toBe(true)
    } finally {
      await stopChild(child, ipc)
    }
  })
})
