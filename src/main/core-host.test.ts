import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MainToCore } from '../shared/ipc/control.js'
import { defaultSettings } from '../shared/settings.js'
import { themePayload } from '../shared/theme-tokens.js'

/** A forked 'wt-core' that records what main posts to it; it exits on 'shutdown' like the real one. */
class FakeCore extends EventEmitter {
  readonly sent: MainToCore[] = []
  readonly stdout = null
  readonly stderr = null
  /** utilityProcess.fork's options */
  constructor(readonly options: { env?: Record<string, string> }) {
    super()
  }
  postMessage(msg: MainToCore): void {
    this.sent.push(msg)
    if (msg.type === 'shutdown') setImmediate(() => this.emit('exit', 0))
  }
  kill(): boolean {
    this.emit('exit', 1)
    return true
  }
  init(): Extract<MainToCore, { type: 'init' }> | undefined {
    return this.sent.find((m) => m.type === 'init')
  }
}

const cores: FakeCore[] = []

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (_entry: string, _args: string[], options: { env?: Record<string, string> }) => {
      const core = new FakeCore(options)
      cores.push(core)
      return core
    },
  },
  MessageChannelMain: class {
    port1 = {}
    port2 = {}
  },
}))
vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { CoreHost } = await import('./core-host.js')

/** A window's WebContents: reloading keeps it, closing the window destroys it. */
class FakeWindow extends EventEmitter {
  private destroyed = false
  readonly postMessage = vi.fn()
  isDestroyed(): boolean {
    return this.destroyed
  }
  destroy(): void {
    this.destroyed = true
    this.emit('destroyed')
  }
}

const init = (): Extract<MainToCore, { type: 'init' }> => ({
  type: 'init',
  protocol: 1,
  appVersion: '0.0.0-test',
  paths: { userData: '/u', logsDir: '/l', downloadDir: '/d', resources: '/r' },
  mpv: { path: null, kind: 'none', version: null, status: 'missing' },
  settings: defaultSettings(),
  theme: themePayload('system', 'light'),
  selftest: false,
})

describe('CoreHost', () => {
  beforeEach(() => {
    cores.length = 0
  })

  it('restarts a crashed core once, asking the new one to resume the room that was open', () => {
    const host = new CoreHost()
    const crashed = vi.fn()
    host.on('crashed', crashed)
    host.start(init())
    expect(cores).toHaveLength(1)
    expect(cores[0]?.init()?.resumeActive).toBeUndefined()

    cores[0]?.emit('exit', 1)
    expect(cores).toHaveLength(2)
    expect(cores[1]?.init()).toEqual({ ...init(), resumeActive: true })

    // a second crash is not restarted
    cores[1]?.emit('exit', 1)
    expect(cores).toHaveLength(2)
    expect(crashed).toHaveBeenCalledTimes(2)
  })

  it('the restarted core starts from the latest settings and mpv lookup, and every window gets a new port', () => {
    const host = new CoreHost()
    host.start(init())
    const wc = { isDestroyed: () => false, once: vi.fn(), postMessage: vi.fn() }
    host.connectRenderer(wc as never)
    const settings = { ...defaultSettings(), displayName: 'Changed' }
    const mpv = { path: '/usr/bin/mpv', kind: 'system', version: '0.40.0', status: 'ok' } as const
    host.post({ type: 'settings', settings })
    host.post({ type: 'mpv', mpv })

    cores[0]?.emit('exit', 1)
    expect(cores[1]?.init()).toMatchObject({ settings, mpv, resumeActive: true })
    expect(cores[1]?.sent.filter((m) => m.type === 'renderer-port')).toHaveLength(1)
    expect(wc.postMessage).toHaveBeenCalledTimes(2)
  })

  it('a window that reloads gets a new port each time, and is watched for its end once', () => {
    const host = new CoreHost()
    host.start(init())
    const win = new FakeWindow()
    for (let load = 0; load < 12; load++) host.connectRenderer(win as never)
    expect(win.postMessage).toHaveBeenCalledTimes(12)
    expect(cores[0]?.sent.filter((m) => m.type === 'renderer-port')).toHaveLength(12)
    // 11+ would make Node warn about a listener leak on the WebContents
    expect(win.listenerCount('destroyed')).toBe(1)

    // a closed window is forgotten: a restarted core sends it nothing
    win.destroy()
    cores[0]?.emit('exit', 1)
    expect(cores[1]?.sent.filter((m) => m.type === 'renderer-port')).toHaveLength(0)
    expect(win.postMessage).toHaveBeenCalledTimes(12)
  })

  it("forks core with ws's native addons off, from its first line on", () => {
    const saved = { buf: process.env.WS_NO_BUFFER_UTIL, utf8: process.env.WS_NO_UTF_8_VALIDATE }
    delete process.env.WS_NO_BUFFER_UTIL
    delete process.env.WS_NO_UTF_8_VALIDATE
    process.env.WT_TEST_PASSED_ON = 'yes'
    try {
      new CoreHost().start(init())
      expect(cores[0]?.options.env).toMatchObject({
        WS_NO_BUFFER_UTIL: '1',
        WS_NO_UTF_8_VALIDATE: '1',
        WT_TEST_PASSED_ON: 'yes',
      })
    } finally {
      delete process.env.WT_TEST_PASSED_ON
      if (saved.buf !== undefined) process.env.WS_NO_BUFFER_UTIL = saved.buf
      if (saved.utf8 !== undefined) process.env.WS_NO_UTF_8_VALIDATE = saved.utf8
    }
  })

  it('a core stopped by a quit is not restarted', async () => {
    const host = new CoreHost()
    const crashed = vi.fn()
    host.on('crashed', crashed)
    host.start(init())
    await host.stop()
    expect(cores[0]?.sent.at(-1)).toEqual({ type: 'shutdown' })
    expect(cores).toHaveLength(1)
    expect(crashed).not.toHaveBeenCalled()
  })
})
