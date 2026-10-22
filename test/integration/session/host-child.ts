// A host member in its own node process: harness.ts's member() (SessionManager, fake player) driven over
// IPC through its RPC surface, so a test can SIGKILL it. That is a real crash: no bye, no unannounce, its
// UDP sockets just stop answering, which manager.shutdown() or room.close() in the test's own process
// cannot fake. Restart it from the same folder with resumeActive, as main's core restart does.
// This file is both the test's API (spawnHost) and the child's entry (run with WT_HOST_CHILD set).
// A child whose test process went away without killing it (a vitest worker killed on a timeout, a crash) sees
// its IPC channel close: it shuts its manager down and exits, instead of living on with a room and a swarm.
import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Room } from '../../../src/core/net/room.js'
import type { CoreEventName, CoreEvents, CoreMethod, ParamsOf, ResultOf } from '../../../src/shared/ipc/core.js'
import { member } from './harness.js'

export interface HostChildOptions {
  root: string
  /** the member's folder: a killed child's, to restart it */
  dir: string
  name?: string
  /** resume the room that was open when the last process in `dir` died (main's automatic core restart) */
  resumeActive?: boolean
}

type ToChild = { t: 'req'; id: number; m: CoreMethod; p: unknown } | { t: 'banned'; id: number; keys: string[] }

type FromChild =
  | { t: 'ready' }
  | { t: 'evt'; e: CoreEventName; d: unknown }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'banned'; id: number; keys: string[] }
  | { t: 'auth-failed'; peerId: string; code: string }

const live = new Set<HostChild>()

export class HostChild {
  /** the child's RPC events in order, stamped with the test process's Date.now() on arrival */
  readonly events: { e: CoreEventName; d: unknown; at: number }[] = []
  /** auth failures of the child's rooms, across sessions */
  readonly authFailures: { peerId: string; code: string }[] = []
  readonly ready: Promise<void>
  private nextId = 1
  private readonly pending = new Map<number, (m: FromChild) => void>()
  private readonly exited: Promise<void>

  constructor(readonly proc: ChildProcess) {
    live.add(this)
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()))
    void this.exited.then(() => live.delete(this))
    this.ready = new Promise((resolve, reject) => {
      proc.once('exit', (code, signal) => reject(new Error(`host child exited early (${String(code ?? signal)})`)))
      proc.on('message', (m: FromChild) => {
        if (m.t === 'ready') resolve()
        else if (m.t === 'evt') this.events.push({ e: m.e, d: m.d, at: Date.now() })
        else if (m.t === 'auth-failed') this.authFailures.push({ peerId: m.peerId, code: m.code })
        else {
          this.pending.get(m.id)?.(m)
          this.pending.delete(m.id)
        }
      })
    })
    this.ready.catch(() => undefined)
  }

  async request<M extends CoreMethod>(m: M, p: ParamsOf<M>): Promise<ResultOf<M>> {
    const res = await this.call({ t: 'req', id: this.nextId++, m, p })
    if (res.t !== 'res') throw new Error(`unexpected reply ${res.t}`)
    if (!res.ok) throw new Error(`${m} failed: ${res.error}`)
    return res.v as ResultOf<M>
  }

  last<E extends CoreEventName>(e: E): CoreEvents[E] | undefined {
    return this.events.findLast((x) => x.e === e)?.d as CoreEvents[E] | undefined
  }

  async until<E extends CoreEventName>(e: E, pred: (d: CoreEvents[E]) => boolean, ms = 30_000): Promise<CoreEvents[E]> {
    const t0 = Date.now()
    for (;;) {
      const hit = this.events.findLast((x) => x.e === e && pred(x.d as CoreEvents[E]))
      if (hit) return hit.d as CoreEvents[E]
      if (Date.now() - t0 > ms)
        throw new Error(`host child: timed out waiting for ${e}; last: ${JSON.stringify(this.last(e))}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** The keys among `keys` that the child's current room has banned. */
  async banned(keys: string[]): Promise<string[]> {
    const res = await this.call({ t: 'banned', id: this.nextId++, keys })
    return res.t === 'banned' ? res.keys : []
  }

  /** SIGKILL: resolves once the process is gone. */
  async kill(): Promise<void> {
    this.proc.kill('SIGKILL')
    await this.exited
  }

  private call(msg: ToChild): Promise<FromChild> {
    return new Promise((resolve) => {
      this.pending.set(msg.id, resolve)
      this.proc.send(msg)
    })
  }
}

/** A host member in a new process; WT_BOOTSTRAP and the rest of the environment are passed on. */
export async function spawnHost(opts: HostChildOptions): Promise<HostChild> {
  const proc = fork(fileURLToPath(import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, WT_HOST_CHILD: JSON.stringify(opts) },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const child = new HostChild(proc)
  await child.ready
  return child
}

/** SIGKILLs every host child still running (afterEach). */
export async function killHosts(): Promise<void> {
  await Promise.all([...live].map((c) => c.kill()))
}

/** how long the child's shutdown may take once its parent is gone */
const ORPHAN_SHUTDOWN_MS = 3000

// ---- the child --------------------------------------------------------------------------------

function childMain(opts: HostChildOptions): void {
  const send = (m: FromChild): void => {
    if (process.connected) process.send?.(m)
  }
  // the auth failures of every room this process opens (a session keeps its room to itself); before the
  // member exists, since resumeActive starts resuming from its constructor
  const factories = Room as unknown as Record<'create' | 'join' | 'resume', (...a: unknown[]) => Promise<Room>>
  for (const name of ['create', 'join', 'resume'] as const) {
    const make = factories[name].bind(Room)
    factories[name] = async (...a) => {
      const room = await make(...a)
      room.on('auth-failed', (f) => send({ t: 'auth-failed', ...f }))
      return room
    }
  }
  const m = member(opts.name ?? 'Host', opts.root, {
    dir: opts.dir,
    ...(opts.resumeActive ? { resumeActive: true } : {}),
  })
  process.once('disconnect', () => {
    const bounded = new Promise((resolve) => setTimeout(resolve, ORPHAN_SHUTDOWN_MS))
    void Promise.race([m.manager.shutdown(), bounded]).finally(() => process.exit(0))
  })
  // every event: those recorded already (state replayed when the client attached) first, then each as it comes
  const events = m.client.events
  for (const ev of events) send({ t: 'evt', e: ev.e, d: ev.d })
  const push = events.push.bind(events)
  events.push = (...items) => {
    for (const ev of items) send({ t: 'evt', e: ev.e, d: ev.d })
    return push(...items)
  }
  const current = (): Room | null => (m.manager as unknown as { current: { room: Room } | null }).current?.room ?? null
  process.on('message', (msg: ToChild) => {
    if (msg.t === 'banned') {
      const bans = (current() as unknown as { bans: { has(k: string): boolean } } | null)?.bans
      send({ t: 'banned', id: msg.id, keys: msg.keys.filter((k) => bans?.has(k) === true) })
      return
    }
    m.client.request(msg.m, msg.p as never).then(
      (v) => send({ t: 'res', id: msg.id, ok: true, v }),
      (e: unknown) => send({ t: 'res', id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }),
    )
  })
  setInterval(() => undefined, 1 << 30)
  send({ t: 'ready' })
}

const childOpts = process.env.WT_HOST_CHILD
if (childOpts) childMain(JSON.parse(childOpts) as HostChildOptions)
