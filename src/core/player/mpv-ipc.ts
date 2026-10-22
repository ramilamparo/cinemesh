import { EventEmitter } from 'node:events'
import { type Socket, connect } from 'node:net'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import { CodedError } from '../../shared/result.js'

export const MPV_ERRORS = {
  /** mpv answered with error !== 'success'; the message carries mpv's error string */
  command: 'mpv-command',
  timeout: 'mpv-timeout',
  closed: 'mpv-ipc-closed',
  connect: 'mpv-connect',
} as const

export class MpvIpcError extends CodedError {
  /** mpv's own error text ('property unavailable', 'invalid parameter', ...), when it answered */
  readonly mpvError: string | null

  constructor(code: string, message: string, mpvError: string | null = null) {
    super(code, message)
    this.name = 'MpvIpcError'
    this.mpvError = mpvError
  }
}

/** Any mpv event line; `event` is the name, other fields depend on it. */
export interface MpvEvent {
  event: string
  [key: string]: unknown
}

export interface PropertyChange {
  id: number
  name: string
  /** undefined when the property is unavailable (mpv omits `data`) */
  value: unknown
}

export interface Timed<T> {
  value: T
  /** performance.now() just before the request was written */
  tSend: number
  /** performance.now() when the reply's bytes arrived */
  tRecv: number
}

interface MpvIpcEvents {
  /** every event line, including the ones below */
  event: [MpvEvent]
  'property-change': [PropertyChange]
  /** script-message / script-message-to <our client name>: args[0] is the message name */
  'client-message': [string[]]
  close: [Error | null]
}

interface Pending {
  resolve: (reply: Reply) => void
  reject: (e: Error) => void
  onReply: ((data: unknown) => void) | undefined
  timer: NodeJS.Timeout
  tSend: number
  what: string
}

interface Reply {
  data: unknown
  tRecv: number
}

export type MpvCommand = readonly unknown[] | { readonly name: string; readonly [arg: string]: unknown }

export interface CommandOptions {
  /** only loadfile uses this (plan §4.4): mpv answers once the command finished, not when queued */
  async?: boolean
  timeoutMs?: number
  /**
   * Called with the reply's `data` as soon as its line is parsed, before any later line: events that came in
   * the same chunk are emitted synchronously, while the returned promise settles only after all of them.
   * Only for a successful reply.
   */
  onReply?: (data: unknown) => void
}

export interface ConnectOptions {
  retryMs?: number
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT_MS = 5000
const MAX_LINE = 16 * 1024 * 1024

/**
 * mpv JSON IPC client: newline-delimited JSON over a socketpair (fd://3), a Unix socket or a Windows
 * named pipe. There is no reconnect: losing the connection means the player is restarted.
 */
export class MpvIpc extends EventEmitter<MpvIpcEvents> {
  private readonly pending = new Map<number, Pending>()
  private readonly observed = new Map<number, string>()
  private nextRequestId = 1
  private nextObserveId = 1
  private buffer = ''
  private closed = false

  constructor(
    private readonly stream: Duplex,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    super()
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => this.onData(chunk, performance.now()))
    stream.on('error', (e) => this.shutdown(e))
    stream.on('close', () => this.shutdown(null))
    stream.on('end', () => this.shutdown(null))
  }

  /** Connect to --input-ipc-server (Unix socket path or \\.\pipe\name), retrying until mpv created it. */
  static async connect(path: string, opts: ConnectOptions = {}): Promise<MpvIpc> {
    const retryMs = opts.retryMs ?? 50
    const deadline = performance.now() + (opts.timeoutMs ?? 10_000)
    for (;;) {
      if (opts.signal?.aborted) throw new MpvIpcError(MPV_ERRORS.connect, 'connect aborted')
      try {
        return new MpvIpc(await connectOnce(path))
      } catch (e) {
        if (performance.now() + retryMs > deadline) {
          const why = e instanceof Error ? e.message : String(e)
          throw new MpvIpcError(MPV_ERRORS.connect, `could not connect to mpv at ${path}: ${why}`)
        }
        await new Promise((r) => setTimeout(r, retryMs))
      }
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Runs a command, positional (['seek', 5, 'absolute']) or named ({name: 'subprocess', args: [...]});
   * resolves with its `data`, rejects with MpvIpcError when mpv reports an error.
   */
  async command(args: MpvCommand, opts: CommandOptions = {}): Promise<unknown> {
    return (await this.request(args, opts)).data
  }

  async getProperty<T = unknown>(name: string, timeoutMs?: number): Promise<Timed<T>> {
    const opts: CommandOptions = timeoutMs === undefined ? {} : { timeoutMs }
    const tSend = performance.now()
    const reply = await this.request(['get_property', name], opts)
    return { value: reply.data as T, tSend, tRecv: reply.tRecv }
  }

  async setProperty(name: string, value: unknown): Promise<void> {
    await this.request(['set_property', name, value])
  }

  /** Observe a property; the current value arrives at once as a 'property-change'. Returns the id. */
  async observe(name: string): Promise<number> {
    const id = this.nextObserveId++
    this.observed.set(id, name)
    try {
      await this.request(['observe_property', id, name])
    } catch (e) {
      this.observed.delete(id)
      throw e
    }
    return id
  }

  async unobserve(id: number): Promise<void> {
    this.observed.delete(id)
    await this.request(['unobserve_property', id])
  }

  /** The name mpv gave this connection; scripts reach us with `script-message-to <name>`. */
  async clientName(): Promise<string> {
    const name = await this.command(['client_name'])
    if (typeof name !== 'string') throw new MpvIpcError(MPV_ERRORS.command, 'client_name returned no string')
    return name
  }

  close(): void {
    this.stream.destroy()
    this.shutdown(null)
  }

  private request(args: MpvCommand, opts: CommandOptions = {}): Promise<Reply> {
    if (this.closed) return Promise.reject(new MpvIpcError(MPV_ERRORS.closed, 'mpv IPC is closed'))
    const id = this.nextRequestId++
    const what = String(isNamed(args) ? args.name : args[0])
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new MpvIpcError(MPV_ERRORS.timeout, `mpv did not answer ${what} within ${String(timeoutMs)} ms`))
      }, timeoutMs)
      const tSend = performance.now()
      this.pending.set(id, { resolve, reject, onReply: opts.onReply, timer, tSend, what })
      const msg: Record<string, unknown> = { command: args, request_id: id }
      if (opts.async) msg.async = true
      this.stream.write(`${JSON.stringify(msg)}\n`)
    })
  }

  private onData(chunk: string, tRecv: number): void {
    this.buffer += chunk
    let nl = this.buffer.indexOf('\n')
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl)
      this.buffer = this.buffer.slice(nl + 1)
      if (line.length > 0) this.onLine(line, tRecv)
      nl = this.buffer.indexOf('\n')
    }
    if (this.buffer.length > MAX_LINE) this.shutdown(new Error('mpv IPC line too long'))
  }

  private onLine(line: string, tRecv: number): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as Record<string, unknown>
    if (typeof m.event === 'string') {
      this.onEvent(m as MpvEvent)
      return
    }
    if (typeof m.request_id !== 'number') return
    const p = this.pending.get(m.request_id)
    if (!p) return
    this.pending.delete(m.request_id)
    clearTimeout(p.timer)
    if (m.error === 'success') {
      try {
        p.onReply?.(m.data)
      } catch (e) {
        p.reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      p.resolve({ data: m.data, tRecv })
    } else {
      const err = typeof m.error === 'string' ? m.error : 'unknown error'
      p.reject(new MpvIpcError(MPV_ERRORS.command, `mpv ${p.what}: ${err}`, err))
    }
  }

  private onEvent(e: MpvEvent): void {
    this.emit('event', e)
    if (e.event === 'property-change' && typeof e.id === 'number') {
      const name = typeof e.name === 'string' ? e.name : (this.observed.get(e.id) ?? '')
      this.emit('property-change', { id: e.id, name, value: e.data })
    } else if (e.event === 'client-message' && Array.isArray(e.args)) {
      this.emit('client-message', e.args.map(String))
    }
  }

  private shutdown(error: Error | null): void {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new MpvIpcError(MPV_ERRORS.closed, `mpv IPC closed before ${p.what} answered`))
    }
    this.pending.clear()
    this.emit('close', error)
  }
}

function isNamed(c: MpvCommand): c is { readonly name: string } {
  return !Array.isArray(c)
}

function connectOnce(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path)
    const onError = (e: Error): void => {
      sock.destroy()
      reject(e)
    }
    sock.once('error', onError)
    sock.once('connect', () => {
      sock.off('error', onError)
      resolve(sock)
    })
  })
}
