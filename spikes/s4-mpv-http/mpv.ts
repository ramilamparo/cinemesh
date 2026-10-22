// Spawns a headless mpv with the plan's argv (where it applies) and drives it over JSON IPC.
import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { EventEmitter, once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, unlinkSync } from 'node:fs'

export const SCRATCH = process.env.S4_SCRATCH ?? new URL('./data/run', import.meta.url).pathname

// Plan §4.4 common argv, minus what needs a window/GPU/our OSC script (marked in the README).
export function headlessArgs (o: { networkTimeout?: number, log: string, sock: string, extra?: string[] }) {
  return [
    '--no-config', '--load-scripts=no', '--osc=no',
    '--input-default-bindings=no', '--input-builtin-bindings=no', '--input-media-keys=no', '--media-controls=no',
    '--drag-and-drop=no', '--terminal=no', '--input-terminal=no', '--input-builtin-dragging=no',
    '--load-console=yes', '--load-select=yes', '--load-commands=no', '--load-context-menu=no', '--load-positioning=no',
    '--load-auto-profiles=no', '--load-stats-overlay=yes', '--ytdl=no',
    '--idle=yes', '--keep-open=always', '--resume-playback=no', '--save-position-on-quit=no',
    '--sub-auto=no', '--audio-file-auto=no', '--cover-art-auto=no', '--osd-bar=no', '--osd-on-seek=no',
    '--cache=yes', '--cache-on-disk=no', '--demuxer-max-bytes=96MiB', '--demuxer-max-back-bytes=32MiB', '--cache-secs=60',
    '--demuxer-seekable-cache=yes', '--cache-pause=yes', '--cache-pause-initial=no', '--cache-pause-wait=1',
    `--network-timeout=${o.networkTimeout ?? 0}`, '--stream-buffer-size=1MiB', '--hr-seek=yes', '--demuxer-mkv-subtitle-preroll-secs-index=2',
    '--vo=null', '--ao=null', `--log-file=${o.log}`, `--input-ipc-server=${o.sock}`,
    ...(o.extra ?? []),
  ]
}

let sockSeq = 0

export class Mpv extends EventEmitter {
  proc!: ChildProcess
  sock!: Socket
  t0 = performance.now()
  events: { t: number, event: string, data?: unknown }[] = []
  props: Record<string, unknown> = {}
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>()
  exitCode: number | null = null
  sockPath = ''

  constructor (public name: string) { super(); this.setMaxListeners(0) }
  now () { return Math.round((performance.now() - this.t0) * 10) / 10 }

  async start (opts: { networkTimeout?: number, extra?: string[], t0?: number }) {
    if (opts.t0 !== undefined) this.t0 = opts.t0
    mkdirSync(SCRATCH, { recursive: true })
    // unix socket paths are limited to 108 bytes: keep the name short
    const sockPath = `${SCRATCH}/${process.pid}-${++sockSeq}.sock`
    this.sockPath = sockPath
    const log = `${SCRATCH}/${this.name}.log`
    this.proc = spawn('mpv', headlessArgs({ networkTimeout: opts.networkTimeout, log, sock: sockPath, extra: opts.extra }), { stdio: 'ignore' })
    this.proc.on('exit', code => { this.exitCode = code; this.emit('exit', code) })
    for (let i = 0; i < 400; i++) { // up to 20 s: startup is slow under heavy disk I/O from other runs
      try {
        this.sock = await new Promise<Socket>((resolve, reject) => { const s = createConnection(sockPath); s.once('connect', () => resolve(s)); s.once('error', reject) })
        break
      } catch { await sleep(50) }
    }
    if (!this.sock) throw new Error('mpv IPC did not come up')
    let buf = ''
    this.sock.on('data', d => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line) this.onMsg(JSON.parse(line))
      }
    })
    this.sock.on('error', () => {})
  }

  private onMsg (m: any) {
    if (m.request_id !== undefined && this.pending.has(m.request_id)) {
      const p = this.pending.get(m.request_id)!
      clearTimeout(p.timer); this.pending.delete(m.request_id)
      if (m.error === 'success') p.resolve(m.data); else p.reject(new Error(`${m.error}`))
      return
    }
    if (m.event === 'property-change') {
      this.props[m.name] = m.data
      this.emit('prop', m.name, m.data, this.now())
      if (['paused-for-cache', 'eof-reached', 'idle-active', 'seeking', 'core-idle'].includes(m.name)) this.events.push({ t: this.now(), event: `prop:${m.name}`, data: m.data })
      return
    }
    if (m.event) {
      if (m.event !== 'log-message') this.events.push({ t: this.now(), event: m.event, data: m.reason ?? m.file_error ?? m.error })
      this.emit('event', m, this.now())
      this.emit(m.event, m, this.now())
    }
  }

  command (cmd: unknown[], timeoutMs = 5000, async = false): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${JSON.stringify(cmd)}`)) }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.sock.write(JSON.stringify({ command: cmd, request_id: id, ...(async ? { async: true } : {}) }) + '\n')
    })
  }

  get (prop: string) { return this.command(['get_property', prop]) }
  set (prop: string, v: unknown) { return this.command(['set_property', prop, v]) }
  observe (...names: string[]) { return Promise.all(names.map((n, i) => this.command(['observe_property', i + 1, n]))) }

  // Resolves with the time of the next event `name` (after now), or null on timeout.
  waitEvent (name: string, timeoutMs: number): Promise<number | null> {
    return new Promise(resolve => {
      const onEv = (_m: unknown, t: number) => { clearTimeout(timer); resolve(t) }
      const timer = setTimeout(() => { this.off(name, onEv); resolve(null) }, timeoutMs)
      this.once(name, onEv)
    })
  }

  waitProp (name: string, pred: (v: unknown) => boolean, timeoutMs: number): Promise<number | null> {
    if (pred(this.props[name])) return Promise.resolve(this.now())
    return new Promise(resolve => {
      const onProp = (n: string, v: unknown, t: number) => { if (n === name && pred(v)) { clearTimeout(timer); this.off('prop', onProp); resolve(t) } }
      const timer = setTimeout(() => { this.off('prop', onProp); resolve(null) }, timeoutMs)
      this.on('prop', onProp)
    })
  }

  async quit () {
    try { await this.command(['quit'], 1000) } catch {}
    if (this.exitCode === null) {
      const exited = once(this.proc, 'exit')
      const t = setTimeout(() => this.proc.kill('SIGKILL'), 2000)
      await exited; clearTimeout(t)
    }
    this.sock?.destroy()
    try { unlinkSync(this.sockPath) } catch {}
  }
}
