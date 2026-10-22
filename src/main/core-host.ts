import { EventEmitter } from 'node:events'
import { MessageChannelMain, type UtilityProcess, type WebContents, utilityProcess } from 'electron'
import type { CoreToMain, MainToCore, SelftestReport } from '../shared/ipc/control.js'
import { APP_PUSH } from '../shared/ipc/app.js'
import type { Versions } from '../shared/ipc/core.js'
import { log } from './log.js'
import { coreEntry } from './paths.js'

type InitMessage = Extract<MainToCore, { type: 'init' }>

interface CoreHostEvents {
  ready: [Versions]
  selftest: [SelftestReport]
  power: [boolean]
  'show-app': []
  crashed: [number]
}

const SHUTDOWN_GRACE_MS = 5000

/**
 * Owns the 'wt-core' utilityProcess: forks it, sends init, brokers one MessagePort per renderer load,
 * restarts it once after a crash (with init.resumeActive, so the room that was open resumes from its
 * session.json), and kills an orphaned mpv.
 */
export class CoreHost extends EventEmitter<CoreHostEvents> {
  private proc: UtilityProcess | null = null
  private init: InitMessage | null = null
  private readonly renderers = new Set<WebContents>()
  private mpvPid: number | null = null
  private restarts = 0
  private stopping = false

  start(init: InitMessage): void {
    if (this.stopping) return
    this.init = init
    this.spawn()
  }

  post(msg: MainToCore): void {
    if (msg.type === 'settings' && this.init) this.init = { ...this.init, settings: msg.settings }
    if (msg.type === 'theme' && this.init) this.init = { ...this.init, theme: msg.theme }
    // a restarted core starts from the latest lookup
    if (msg.type === 'mpv' && this.init) this.init = { ...this.init, mpv: msg.mpv }
    this.proc?.postMessage(msg)
  }

  /** Give a renderer a fresh port; call on every did-finish-load (reloads included). */
  connectRenderer(wc: WebContents): void {
    // a reload keeps its WebContents: one 'destroyed' listener each, however often it reloads
    if (!this.renderers.has(wc)) {
      this.renderers.add(wc)
      wc.once('destroyed', () => this.renderers.delete(wc))
    }
    this.sendPort(wc)
  }

  async stop(): Promise<void> {
    this.stopping = true
    const proc = this.proc
    if (!proc) return
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    proc.postMessage({ type: 'shutdown' } satisfies MainToCore)
    const timer = setTimeout(() => proc.kill(), SHUTDOWN_GRACE_MS)
    await exited
    clearTimeout(timer)
    this.killMpv()
  }

  private spawn(): void {
    if (!this.init) throw new Error('CoreHost.start() was not called')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    if (!process.env.WT_BOOTSTRAP?.trim()) delete env.WT_BOOTSTRAP // '' would mean "no bootstrap nodes"
    // ws (under WebTorrent) reads these as it loads: set here, they hold before core's first line, however core
    // is bundled, so its optional native addons stay unloaded (ADR 0001 finding 3; src/core/env-first.ts)
    env.WS_NO_BUFFER_UTIL = '1'
    env.WS_NO_UTF_8_VALIDATE = '1'
    const proc = utilityProcess.fork(coreEntry(), [], { serviceName: 'wt-core', stdio: 'pipe', env })
    this.proc = proc
    proc.stdout?.on('data', (d: Buffer) => log.info(`[core] ${d.toString().trimEnd()}`))
    proc.stderr?.on('data', (d: Buffer) => log.warn(`[core] ${d.toString().trimEnd()}`))
    proc.on('message', (m: CoreToMain) => this.onMessage(m))
    proc.once('exit', (code) => this.onExit(proc, code))
    proc.postMessage(this.init)
    for (const wc of this.renderers) this.sendPort(wc)
  }

  private sendPort(wc: WebContents): void {
    if (!this.proc || wc.isDestroyed()) return
    const { port1, port2 } = new MessageChannelMain()
    this.proc.postMessage({ type: 'renderer-port' } satisfies MainToCore, [port1])
    wc.postMessage(APP_PUSH.corePort, null, [port2])
  }

  private onMessage(m: CoreToMain): void {
    switch (m.type) {
      case 'ready':
        log.info(`core ready (protocol ${String(m.versions.protocol)})`)
        this.emit('ready', m.versions)
        break
      case 'mpv-pid':
        this.mpvPid = m.pid
        break
      case 'power':
        this.emit('power', m.keepAwake)
        break
      case 'show-app':
        this.emit('show-app')
        break
      case 'selftest':
        this.emit('selftest', m.report)
        break
      case 'fatal':
        log.error(`core fatal: ${m.message}`)
        break
    }
  }

  private onExit(proc: UtilityProcess, code: number): void {
    if (proc !== this.proc) return
    this.proc = null
    this.killMpv()
    if (this.stopping) return
    log.error(`core exited with code ${String(code)}`)
    this.emit('crashed', code)
    if (this.restarts < 1) {
      this.restarts += 1
      // the new core rejoins the room the old one was in (its active-room marker survived the crash)
      if (this.init) this.init = { ...this.init, resumeActive: true }
      this.spawn()
    }
  }

  private killMpv(): void {
    if (this.mpvPid === null) return
    try {
      process.kill(this.mpvPid)
    } catch {
      // already gone
    }
    this.mpvPid = null
  }
}
