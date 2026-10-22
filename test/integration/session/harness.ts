import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { MpvInfo } from '../../../src/shared/ipc/control.js'
import {
  CORE_PROTOCOL,
  type CoreEventName,
  type CoreEvents,
  type CoreMethod,
  type CoreToRenderer,
  type ParamsOf,
  type ResultOf,
} from '../../../src/shared/ipc/core.js'
import { defaultSettings, type Settings } from '../../../src/shared/settings.js'
import { themePayload } from '../../../src/shared/theme-tokens.js'
import { log } from '../../../src/core/log.js'
import { parseMpvVersion } from '../../../src/core/player/mpv-version.js'
import { RoomStore } from '../../../src/core/net/identity.js'
import { RpcServer } from '../../../src/core/rpc-server.js'
import { SessionManager } from '../../../src/core/session/manager.js'

// Shared by the session integration tests: a SessionManager driven through its RPC surface, as the
// renderer would (requests, plus every event kept in order).

export class Client {
  readonly events: { e: CoreEventName; d: unknown }[] = []
  private nextId = 1
  private readonly pending = new Map<number, (m: Extract<CoreToRenderer, { t: 'res' }>) => void>()
  private deliver: (m: unknown) => void = () => undefined

  constructor(rpc: RpcServer) {
    rpc.attach({
      post: (m) => this.onMessage(m as CoreToRenderer),
      onMessage: (cb) => (this.deliver = cb),
      onClose: () => undefined,
      close: () => undefined,
    })
    this.deliver({ t: 'hello', v: CORE_PROTOCOL })
  }

  async request<M extends CoreMethod>(m: M, p: ParamsOf<M>): Promise<ResultOf<M>> {
    const id = this.nextId++
    const res = await new Promise<Extract<CoreToRenderer, { t: 'res' }>>((resolve) => {
      this.pending.set(id, resolve)
      this.deliver({ t: 'req', id, m, p })
    })
    if (!res.ok) throw new Error(`${m} failed: ${res.code} ${res.msg}`)
    return res.v as ResultOf<M>
  }

  last<E extends CoreEventName>(e: E): CoreEvents[E] | undefined {
    for (let i = this.events.length - 1; i >= 0; i--)
      if (this.events[i]?.e === e) return this.events[i]?.d as CoreEvents[E]
    return undefined
  }

  async until<E extends CoreEventName>(e: E, pred: (d: CoreEvents[E]) => boolean, ms = 30_000): Promise<CoreEvents[E]> {
    const t0 = Date.now()
    for (;;) {
      const hit = this.events.findLast((x) => x.e === e && pred(x.d as CoreEvents[E]))
      if (hit) return hit.d as CoreEvents[E]
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${e}; last: ${JSON.stringify(this.last(e))}`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** Request expected to fail: resolves with its error code. */
  async requestError<M extends CoreMethod>(m: M, p: ParamsOf<M>): Promise<string> {
    const id = this.nextId++
    const res = await new Promise<Extract<CoreToRenderer, { t: 'res' }>>((resolve) => {
      this.pending.set(id, resolve)
      this.deliver({ t: 'req', id, m, p })
    })
    if (res.ok) throw new Error(`${m} unexpectedly succeeded`)
    return res.code
  }

  all<E extends CoreEventName>(e: E): CoreEvents[E][] {
    return this.events.filter((x) => x.e === e).map((x) => x.d as CoreEvents[E])
  }

  private onMessage(m: CoreToRenderer): void {
    if (m.t === 'evt') this.events.push({ e: m.e, d: m.d })
    else if (m.t === 'res') {
      this.pending.get(m.id)?.(m)
      this.pending.delete(m.id)
    }
  }
}

/**
 * One control.power call; `at` is client.events.length when it was made: it came after event at - 1 and
 * before event at (calls between the same two events share it).
 */
export interface PowerCall {
  on: boolean
  at: number
}

export interface Member {
  client: Client
  manager: SessionManager
  /** this member's private folder (userData, logs, downloads live under it) */
  dir: string
  /** every control.power call (keep-awake), in order */
  power: PowerCall[]
}

let installedMpv: MpvInfo | null | undefined

/** The mpv on PATH as main's lookup would report it, or null when there is none (probed once). */
export function realMpv(): MpvInfo | null {
  if (installedMpv !== undefined) return installedMpv
  let out = ''
  try {
    out = execFileSync('mpv', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
  } catch {
    // none installed
  }
  const v = parseMpvVersion(out)
  installedMpv = v
    ? { path: 'mpv', kind: 'system', version: `${String(v.major)}.${String(v.minor)}.${String(v.patch)}`, status: 'ok' }
    : null
  return installedMpv
}

/**
 * A fresh member, or (with `dir`) a restarted one reusing an earlier member's folders. `realMpv`: its player is
 * the installed mpv, headless (--vo=null --ao=null), instead of the fake player. `mpvArgs`: more arguments for
 * that mpv, e.g. `--input-ipc-server=<path>`, a second IPC endpoint for another client (the player's own
 * connection is fd://3 on Linux and macOS).
 */
export function member(
  name: string,
  root: string,
  opts: {
    dir?: string
    settings?: Partial<Settings>
    resumeActive?: boolean
    realMpv?: boolean
    mpvArgs?: readonly string[]
    /** how long a session start waits for the startup sweep and export search (default 10 s) */
    sweepWaitMs?: number
  } = {},
): Member {
  const mpv = opts.realMpv ? realMpv() : null
  if (opts.realMpv && !mpv) throw new Error('no mpv on PATH')
  const dir = opts.dir ?? mkdtempSync(join(root, `${name}-`))
  const power: PowerCall[] = []
  let client: Client | null = null
  const rpc = new RpcServer({
    app: '0.0.0-test',
    electron: null,
    node: process.versions.node,
    chrome: null,
    protocol: 1,
  })
  const settings = { ...defaultSettings(), displayName: name, downloadDir: join(dir, 'downloads'), ...opts.settings }
  const manager = new SessionManager(rpc, {
    paths: {
      userData: join(dir, 'userData'),
      logsDir: join(dir, 'logs'),
      downloadDir: join(dir, 'downloads'),
      // absolute for a real mpv: wt-osc.lua is passed to it by path
      resources: resolve(import.meta.dirname, '../../../resources'),
    },
    settings,
    theme: themePayload('system', 'light'),
    mpv: mpv ?? { path: null, kind: 'none', version: null, status: 'missing' },
    appVersion: '0.0.0-test',
    store: new RoomStore(join(dir, 'userData')),
    fakePlayer: !mpv,
    ...(mpv ? { mpvExtraArgs: ['--vo=null', '--ao=null', ...(opts.mpvArgs ?? [])] } : {}),
    ...(opts.resumeActive ? { resumeActive: true } : {}),
    ...(opts.sweepWaitMs !== undefined ? { sweepWaitMs: opts.sweepWaitMs } : {}),
    log,
    control: {
      power: (on) => power.push({ on, at: client?.events.length ?? 0 }),
      mpvPid: () => undefined,
      showApp: () => undefined,
    },
  })
  client = new Client(rpc)
  return { client, manager, dir, power }
}
