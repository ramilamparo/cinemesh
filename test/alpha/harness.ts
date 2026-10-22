// The alpha's test-side harness: members in their own processes (member-child.ts, forked with tsx), a room of
// one host and N viewers on the local HyperDHT testnet, the fixture, and what every measurement is recorded
// with (the 1-minute load average, a fingerprint of src/). Stamps are hrtime ms, as in protocol.ts.
import { type ChildProcess, fork } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CoreEventName, CoreEvents, CoreMethod, ParamsOf, ResultOf } from '../../src/shared/ipc/core.js'
import type { Settings } from '../../src/shared/settings.js'
import { FIXTURE_DIR, type FixtureSet } from '../integration/media/fixtures.js'
import {
  type ChildOptions,
  type FromChild,
  LOG_KEYS,
  type LogBatch,
  type ManifestInfo,
  type MemberInfo,
  type ToChild,
  emptyBatch,
  tag,
} from './protocol.js'

export const ALPHA = process.env.WT_ALPHA === '1'
export const ALPHA_LONG = process.env.WT_ALPHA_LONG === '1'

/** 5 min, 720p, ~4.1 Mbit/s with 128 kbit/s audio, MKV with Cues: ~155 MB, 149 pieces of 1 MiB */
export const ALPHA_SET: FixtureSet = {
  dir: join(FIXTURE_DIR, 'alpha-300s-4M'),
  durationS: 300,
  size: '1280x720',
  videoBitrate: '4M',
  audioBitrate: '128k',
}

/** the long run's 10 min of the same */
export const ALPHA_LONG_SET: FixtureSet = { ...ALPHA_SET, dir: join(FIXTURE_DIR, 'alpha-600s-4M'), durationS: 600 }

/**
 * The host's upload limit (settings.uploadLimitKBps, KiB/s): 1250 KiB/s = 1.28 MB/s, 2.5x the fixture's ~0.52 MB/s.
 * Three viewers each taking their own copy would need 1.55 MB/s, more than the host has: striping is what makes
 * the room work at all, while one striped copy plus the critical pieces fits with room to spare.
 */
export const HOST_UPLOAD_KBPS = 1250

export const hr = (): number => Number(process.hrtime.bigint()) / 1e6
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The 1-, 5- and 15-minute load averages (14 cores on the dev machine). */
export function loadavg(): [number, number, number] {
  const [a = 0, b = 0, c = 0] = readFileSync('/proc/loadavg', 'utf8').split(' ').map(Number)
  return [a, b, c]
}

const REPO = resolve(import.meta.dirname, '../..')

/**
 * src/ changes under a run when other work edits it: a fingerprint of every file's size and mtime, plus the
 * newest file, recorded at the start and the end of each room.
 */
export function srcFingerprint(): { hash: string; files: number; newest: string; newestMtime: string } {
  const h = createHash('sha256')
  let files = 0
  let newest = { path: '', mtime: 0 }
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.isFile()) {
        const st = statSync(p)
        h.update(`${relative(REPO, p)}\0${String(st.size)}\0${String(st.mtimeMs)}\n`)
        files++
        if (st.mtimeMs > newest.mtime) newest = { path: relative(REPO, p), mtime: st.mtimeMs }
      }
    }
  }
  walk(join(REPO, 'src'))
  return {
    hash: h.digest('hex').slice(0, 16),
    files,
    newest: newest.path,
    newestMtime: new Date(newest.mtime).toISOString(),
  }
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')))
  })
}

// ---- results ---------------------------------------------------------------------------------------------

/** Where a run's numbers go: WT_ALPHA_OUT, else <tmpdir>/wt-alpha-results (never the repository). */
export const OUT_DIR = process.env.WT_ALPHA_OUT ?? join(tmpdir(), 'wt-alpha-results')

export class Results {
  readonly file: string
  private readonly data: Record<string, unknown> = {}

  constructor(name: string) {
    mkdirSync(OUT_DIR, { recursive: true })
    this.file = join(OUT_DIR, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  }

  set(key: string, value: unknown): void {
    this.data[key] = value
    this.write()
  }

  write(): void {
    writeFileSync(this.file, `${JSON.stringify(this.data, null, 1)}\n`)
  }
}

// ---- a member in its own process ------------------------------------------------------------------------

const CHILD = fileURLToPath(new URL('./member-child.ts', import.meta.url))
const live = new Set<AlphaMember>()

export interface StampedEvent {
  e: CoreEventName
  d: unknown
  /** the child's hrtime ms when its RPC client got the event */
  at: number
}

export interface Stamped<T> {
  v: T
  /** hrtime ms in the child just before the request entered its RPC server, and when the answer came out */
  tReq: number
  tRes: number
}

export class AlphaMember {
  readonly events: StampedEvent[] = []
  readonly logs: LogBatch = emptyBatch()
  readonly fatals: { kind: string; message: string; at: number }[] = []
  dir = ''
  pid = 0
  perfToHr = 0
  info: MemberInfo | null = null
  readonly ready: Promise<void>
  readonly exited: Promise<void>
  private nextId = 1
  private readonly pending = new Map<number, (m: FromChild) => void>()

  constructor(
    readonly name: string,
    readonly proc: ChildProcess,
  ) {
    live.add(this)
    this.exited = new Promise((resolve) => proc.once('exit', () => resolve()))
    void this.exited.then(() => {
      live.delete(this)
      for (const fn of this.pending.values())
        fn({ t: 'res', id: -1, ok: false, error: 'child exited', tReq: 0, tRes: 0 })
      this.pending.clear()
    })
    this.ready = new Promise((resolve, reject) => {
      proc.once('exit', (code, signal) => reject(new Error(`${name}: child exited early (${String(code ?? signal)})`)))
      proc.on('message', (m: FromChild) => {
        switch (m.t) {
          case 'ready':
            this.dir = m.dir
            this.pid = m.pid
            this.perfToHr = m.perfToHr
            resolve()
            break
          case 'evt':
            this.events.push({ e: m.e, d: m.d, at: m.at })
            break
          case 'logs':
            for (const k of LOG_KEYS) {
              const into = this.logs[k] as unknown[]
              for (const r of m.batch[k] as unknown[]) into.push(r)
            }
            break
          case 'fatal':
            this.fatals.push({ kind: m.kind, message: m.message, at: m.at })
            break
          default:
            this.pending.get(m.id)?.(m)
            this.pending.delete(m.id)
        }
      })
    })
    this.ready.catch(() => undefined)
  }

  /** The tag (first 8 hex digits of the member id) the records use for this member; known after info(). */
  get tag(): string {
    return tag(this.info?.self)
  }

  async request<M extends CoreMethod>(m: M, p: ParamsOf<M>, ms = 120_000): Promise<Stamped<ResultOf<M>>> {
    const res = await this.call({ t: 'req', id: this.nextId++, m, p }, ms)
    if (res.t !== 'res') throw new Error(`${this.name}: unexpected reply ${res.t}`)
    if (!res.ok) throw new Error(`${this.name}: ${res.error}`)
    return { v: res.v as ResultOf<M>, tReq: res.tReq, tRes: res.tRes }
  }

  /** A request expected to fail: the error text (it carries the code, e.g. 'playback.intent failed: busy ...'). */
  async requestError<M extends CoreMethod>(m: M, p: ParamsOf<M>): Promise<string> {
    const res = await this.call({ t: 'req', id: this.nextId++, m, p }, 60_000)
    if (res.t !== 'res') throw new Error(`${this.name}: unexpected reply ${res.t}`)
    if (res.ok) throw new Error(`${this.name}: ${m} unexpectedly succeeded`)
    return res.error
  }

  async v<M extends CoreMethod>(m: M, p: ParamsOf<M>, ms?: number): Promise<ResultOf<M>> {
    return (await this.request(m, p, ms)).v
  }

  async refreshInfo(): Promise<MemberInfo> {
    const res = await this.call({ t: 'info', id: this.nextId++ }, 10_000)
    if (res.t !== 'info') throw new Error(`${this.name}: unexpected reply ${res.t}`)
    this.info = res.info
    return res.info
  }

  /** Every record the child holds so far is here once this resolves. */
  async flush(): Promise<void> {
    await this.call({ t: 'flush', id: this.nextId++ }, 10_000)
  }

  last<E extends CoreEventName>(e: E): CoreEvents[E] | undefined {
    return this.events.findLast((x) => x.e === e)?.d as CoreEvents[E] | undefined
  }

  all<E extends CoreEventName>(e: E, since = 0): { d: CoreEvents[E]; at: number }[] {
    return this.events.filter((x) => x.e === e && x.at >= since).map((x) => ({ d: x.d as CoreEvents[E], at: x.at }))
  }

  /** The first event since `since` (hrtime ms) that matches, waiting for it. */
  async until<E extends CoreEventName>(
    e: E,
    pred: (d: CoreEvents[E]) => boolean,
    ms = 60_000,
    since = 0,
  ): Promise<{ d: CoreEvents[E]; at: number }> {
    const t0 = Date.now()
    for (;;) {
      const hit = this.events.find((x) => x.e === e && x.at >= since && pred(x.d as CoreEvents[E]))
      if (hit) return { d: hit.d as CoreEvents[E], at: hit.at }
      if (Date.now() - t0 > ms) {
        throw new Error(
          `${this.name}: timed out waiting for ${e}; last: ${(JSON.stringify(this.last(e)) as string | undefined)?.slice(0, 400) ?? 'none'}`,
        )
      }
      await sleep(50)
    }
  }

  /** When mpv first reported `name` = `value` at or after `since` (hrtime ms), waiting for it. */
  async waitProp(name: string, value: unknown, since: number, ms = 30_000): Promise<number> {
    const t0 = Date.now()
    for (;;) {
      await this.flush()
      for (const [at, n, v] of this.logs.prop) if (at >= since && n === name && v === value) return at
      if (Date.now() - t0 > ms)
        throw new Error(`${this.name}: mpv did not report ${name}=${String(value)} in ${String(ms)} ms`)
      await sleep(100)
    }
  }

  /** Leave as on quit (keep), then exit; SIGKILL after `ms`. */
  async shutdown(ms = 10_000): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    await Promise.race([this.call({ t: 'shutdown', id: this.nextId++ }, ms).catch(() => undefined), sleep(ms)])
    this.proc.kill('SIGKILL')
    await this.exited
  }

  async kill(): Promise<void> {
    this.proc.kill('SIGKILL')
    await this.exited
  }

  private call(msg: ToChild, ms: number): Promise<FromChild> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id)
        reject(new Error(`${this.name}: no answer to ${msg.t} ${msg.t === 'req' ? msg.m : ''} in ${String(ms)} ms`))
      }, ms)
      this.pending.set(msg.id, (m) => {
        clearTimeout(timer)
        resolve(m)
      })
      this.proc.send(msg)
    })
  }
}

/** A member in a new process (WT_BOOTSTRAP and the rest of the environment are passed on); its output goes to `logFile`. */
export async function spawnMember(opts: ChildOptions & { logFile: string }): Promise<AlphaMember> {
  const { logFile, ...childOpts } = opts
  const out = openSync(logFile, 'a')
  const proc = fork(CHILD, [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, WT_ALPHA_CHILD: JSON.stringify(childOpts) },
    stdio: ['ignore', out, out, 'ipc'],
  })
  closeSync(out)
  const m = new AlphaMember(opts.name, proc)
  await m.ready
  return m
}

/** SIGKILLs every member still running (afterAll). */
export async function killAll(): Promise<void> {
  await Promise.all([...live].map((m) => m.kill()))
}

// ---- a room ------------------------------------------------------------------------------------------------

export interface AlphaRoom {
  root: string
  host: AlphaMember
  viewers: AlphaMember[]
  all: AlphaMember[]
  invite: string
  manifest: ManifestInfo
  pieceCount: number
  /** record tag -> member name */
  names: Map<string, string>
}

/**
 * The host hosts `video` with the given upload limit; the viewers join at once, each confirming a `save` folder of
 * its own; resolves once every mpv has the file loaded and the room is paused at 0:00.
 */
export async function openRoom(opts: {
  root: string
  video: string
  viewers: string[]
  hostSettings?: Partial<Settings>
  /** false: fake players (default: the installed mpv) */
  realMpv?: boolean
}): Promise<AlphaRoom> {
  const { root } = opts
  mkdirSync(root, { recursive: true })
  const spawn = (name: string, settings?: Partial<Settings>): Promise<AlphaMember> =>
    spawnMember({
      name,
      root,
      logFile: join(root, `${name}.child.log`),
      ...(settings ? { settings } : {}),
      ...(opts.realMpv === false ? { realMpv: false } : {}),
    })
  const [host, ...viewers] = await Promise.all([spawn('Host', opts.hostSettings), ...opts.viewers.map((n) => spawn(n))])
  const { invite } = await host.v('session.host', { videoPath: opts.video, subtitlePaths: [] })
  await host.until('session', (s) => s.phase === 'in-room', 120_000)
  // The viewers join one by one, as rooms usually fill (§9 late join): the first is alone on the host for a moment, so
  // it is shown everything (the Revealer's open mode) and taken back when the next one arrives (ADR 0008 §4.1, fixed
  // in round 6; takeback.test.ts has the bounds). Each is in the room before the next one asks to join.
  for (const v of viewers) {
    await v.v('session.join', { invite })
    await v.until('session', (s) => s.phase === 'confirm-join', 120_000)
    await v.v('session.confirmJoin', { dir: join(v.dir, 'save') })
    await v.until('session', (s) => s.phase === 'in-room', 120_000)
  }
  const all = [host, ...viewers]
  await Promise.all(all.map((m) => m.until('player', (p) => p.status === 'ready', 120_000)))
  await Promise.all(all.map((m) => m.until('sync', (s) => s.mode === 'paused', 120_000)))
  await Promise.all(all.map((m) => m.refreshInfo()))
  const manifest = host.info?.manifest
  const pieceCount = host.info?.pieceCount
  if (!manifest || !pieceCount) throw new Error('host: no manifest')
  return {
    root,
    host,
    viewers,
    all,
    invite,
    manifest,
    pieceCount,
    names: new Map(all.map((m) => [m.tag, m.name])),
  }
}

/** With WT_ALPHA_DUMP=1: each member's records and events next to the results (`<results file>-<label>-<member>.json`). */
export function dumpMembers(results: Results, label: string, members: readonly AlphaMember[]): void {
  if (process.env.WT_ALPHA_DUMP !== '1') return
  for (const m of members) {
    const file = results.file.replace(/\.json$/, `-${label}-${m.name}.json`)
    writeFileSync(
      file,
      JSON.stringify({
        name: m.name,
        info: m.info,
        perfToHr: m.perfToHr,
        fatals: m.fatals,
        logs: m.logs,
        events: m.events,
      }),
    )
  }
}

/** Every member leaves as on quit and exits; then, with WT_ALPHA_DUMP=1, the raw data behind every number is written. */
export async function closeRoom(room: AlphaRoom | null, dump?: { results: Results; room: string }): Promise<void> {
  if (!room) return
  await Promise.all(room.all.map((m) => m.shutdown()))
  if (dump) dumpMembers(dump.results, dump.room, room.all)
}
