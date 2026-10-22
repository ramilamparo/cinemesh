import {
  CORE_ERRORS,
  CORE_PROTOCOL,
  type CoreEventName,
  type CoreEvents,
  type CoreMethod,
  type CoreSnapshot,
  type CoreToRenderer,
  type NoticeEvent,
  type ParamsOf,
  type RendererToCore,
  type ResultOf,
  type Versions,
} from '../shared/ipc/core.js'
import { CodedError } from '../shared/result.js'
import type { RpcPort } from './host-transport.js'

type Handler<M extends CoreMethod> = (params: ParamsOf<M>) => Promise<ResultOf<M>> | ResultOf<M>
type Validator = (params: unknown) => unknown

interface Registration {
  handler: (params: unknown) => unknown
  validate: Validator | null
}

/** startup notices kept for a window that is not there yet: a handful at most */
const MAX_HELD = 8

/**
 * Serves the renderer contract on any number of attached ports (one per renderer load).
 * Keeps the latest value of every state event so a (re)connecting renderer gets a full snapshot.
 */
export class RpcServer {
  private readonly ports = new Set<RpcPort>()
  /** ports whose renderer said hello: someone is listening there */
  private readonly listening = new WeakSet<RpcPort>()
  private readonly handlers = new Map<CoreMethod, Registration>()
  private readonly state: Partial<Omit<CoreEvents, 'notice'>> = {}
  /** noticeUntilSeen() notices no listening renderer has had yet, and the ports they already went to */
  private readonly held: { notice: NoticeEvent; sentTo: WeakSet<RpcPort> }[] = []

  constructor(private readonly versions: Versions) {}

  handle<M extends CoreMethod>(method: M, handler: Handler<M>, validate: Validator | null = null): void {
    this.handlers.set(method, { handler: handler as (params: unknown) => unknown, validate })
  }

  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void {
    if (event !== 'notice') (this.state as Record<string, unknown>)[event] = data
    this.broadcast({ t: 'evt', e: event, d: data })
  }

  /**
   * A notice no window may miss, e.g. a failed resume after a core restart, which can come before any
   * window has (re)connected: sent like any notice, and kept for the next renderer that says hello until
   * one that is listening has it. Notices are otherwise transient and never part of the snapshot.
   */
  noticeUntilSeen(notice: NoticeEvent): void {
    this.emit('notice', notice)
    if ([...this.ports].some((p) => this.listening.has(p))) return
    this.held.push({ notice, sentTo: new WeakSet(this.ports) })
    if (this.held.length > MAX_HELD) this.held.shift()
  }

  /** Forget a state slice, e.g. timeline when leaving a room. */
  clear(event: Exclude<CoreEventName, 'notice'>): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.state[event]
  }

  snapshot(): CoreSnapshot {
    return { versions: this.versions, ...this.state }
  }

  attach(port: RpcPort): void {
    this.ports.add(port)
    port.onMessage((msg) => {
      void this.onMessage(port, msg)
    })
    port.onClose(() => this.ports.delete(port))
  }

  get connectedPorts(): number {
    return this.ports.size
  }

  private broadcast(msg: CoreToRenderer): void {
    for (const port of this.ports) port.post(msg)
  }

  private async onMessage(port: RpcPort, raw: unknown): Promise<void> {
    const msg = asRendererMessage(raw)
    if (!msg) return
    if (msg.t === 'hello') {
      if (msg.v !== CORE_PROTOCOL) {
        port.post({ t: 'evt', e: 'notice', d: noticeProtocol(msg.v) })
      }
      port.post({ t: 'snapshot', d: this.snapshot() })
      this.listening.add(port)
      // a port that was attached when they went out has them already, queued ahead of its snapshot
      for (const h of this.held.splice(0)) {
        if (!h.sentTo.has(port)) port.post({ t: 'evt', e: 'notice', d: h.notice })
      }
      return
    }
    const reg = this.handlers.get(msg.m)
    if (!reg) {
      port.post({
        t: 'res',
        id: msg.id,
        ok: false,
        code: CORE_ERRORS.notImplemented,
        msg: `${msg.m} is not available yet`,
      })
      return
    }
    try {
      const params = reg.validate ? reg.validate(msg.p) : msg.p
      const value = await reg.handler(params)
      port.post({ t: 'res', id: msg.id, ok: true, v: value ?? null })
    } catch (e) {
      const code = e instanceof CodedError ? e.code : isZodLike(e) ? CORE_ERRORS.badRequest : CORE_ERRORS.internal
      const text = e instanceof Error ? e.message : String(e)
      port.post({ t: 'res', id: msg.id, ok: false, code, msg: text })
    }
  }
}

function noticeProtocol(v: number): CoreEvents['notice'] {
  return {
    level: 'error',
    code: CORE_ERRORS.protocol,
    message: `The window speaks protocol ${String(v)}, the background process ${String(CORE_PROTOCOL)}. Restart the app.`,
  }
}

function isZodLike(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'issues' in e && Array.isArray(e.issues)
}

// The port is trusted (main brokered it) but messages are still checked before use.
function asRendererMessage(raw: unknown): RendererToCore | null {
  if (typeof raw !== 'object' || raw === null || !('t' in raw)) return null
  const m = raw as Record<string, unknown>
  if (m.t === 'hello' && typeof m.v === 'number') return { t: 'hello', v: m.v }
  if (m.t === 'req' && typeof m.id === 'number' && typeof m.m === 'string') {
    return { t: 'req', id: m.id, m: m.m as CoreMethod, p: m.p }
  }
  return null
}
