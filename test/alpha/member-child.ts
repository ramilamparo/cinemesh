// One alpha member in its own node process (run with tsx; the test forks it through harness.ts): harness.ts's
// member() with the installed mpv headless (--vo=null --ao=null), driven over the fork IPC channel through its RPC
// surface, as host-child.ts drives a host. Nothing in src/ is changed: before the member exists, this file wraps
// methods on the prototypes of the classes the session creates, and stamps what they see with
// process.hrtime.bigint() (CLOCK_MONOTONIC, so the test can line up stamps from every member):
// - viewer: every block request WebTorrent sends (wire.request), checked against the order WebTorrent itself
//   walks (t._selections) at that moment; the scheduler's plans, playheads and blocked readers; verified pieces;
// - host: the requests viewers send it (what the engine counts as served), each reveal of the Revealer (and why),
//   its group plans, urgent reports and take-backs, the room's anchor at every sync.state it publishes, and at 4 Hz
//   how much each viewer wire has queued for upload;
// - everyone's sync member: what each unpause is planned from, when it is scheduled and sent, and the unpause
//   latency estimate;
// - everyone: mpv's pause / seeking / paused-for-cache / speed changes and playback-restarts as the player sees
//   them, and a 4 Hz sample of audio-pts and time-pos over the player's own IPC connection; the process's RSS at 1 Hz.
// A child whose parent went away (a vitest worker killed on a timeout) sees the IPC channel close and exits.
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Torrent, Wire } from 'webtorrent'
import { log } from '../../src/core/log.js'
import { PlayerHolder } from '../../src/core/session/player-holder.js'
import { GroupController } from '../../src/core/sync/group.js'
import { MemberController } from '../../src/core/sync/member.js'
import type { SyncState } from '../../src/core/sync/protocol.js'
import { TransferEngine } from '../../src/core/transfer/engine.js'
import { Revealer } from '../../src/core/transfer/revealer.js'
import {
  type ByteRange,
  type PieceRange,
  type PlayheadPieces,
  type PlayheadPlan,
  Scheduler,
  orderRanges,
} from '../../src/core/transfer/scheduler.js'
import type { Manifest } from '../../src/shared/media/types.js'
import { type Member, member } from '../integration/session/harness.js'
import {
  CLS,
  type ChildOptions,
  type FromChild,
  type LogBatch,
  type MemberInfo,
  type PeerTag,
  type ToChild,
  emptyBatch,
  tag,
} from './protocol.js'

const hr = (): number => Number(process.hrtime.bigint()) / 1e6

/** performance.now() and hrtime are the same monotonic clock here, offset by the process's time origin. */
function perfToHrOffset(): number {
  const offs: number[] = []
  for (let k = 0; k < 15; k++) {
    const a = hr()
    const p = performance.now()
    const b = hr()
    offs.push((a + b) / 2 - p)
  }
  offs.sort((x, y) => x - y)
  return offs[7] ?? 0
}

const send = (m: FromChild): void => {
  if (process.connected) process.send?.(m)
}

let batch: LogBatch = emptyBatch()
let pending = 0
function record<K extends keyof LogBatch>(k: K, rec: LogBatch[K][number]): void {
  ;(batch[k] as unknown[]).push(rec)
  pending++
}
function flushLogs(): void {
  if (pending === 0) return
  send({ t: 'logs', batch })
  batch = emptyBatch()
  pending = 0
}

// ---- viewer: block requests against WebTorrent's own walk -------------------------------------------------

/** torrent.js SPEED_THRESHOLD: speedRanker runs on a wire at or below it */
const SPEED_THRESHOLD = 3 * 16384

interface PieceGuts {
  _flushed: boolean
  _buffer: unknown[] | null
  _cancellations: number[] | null
  _reservations: number
  _chunks: number
}

/** torrent-piece reserve() would hand out a block (it initialises a fresh piece on demand). */
function freeBlock(p: unknown): boolean {
  if (p === null || p === undefined) return false
  const g = p as PieceGuts
  if (g._flushed) return false
  if (g._buffer === null) return true
  return (g._cancellations?.length ?? 0) > 0 || g._reservations < g._chunks
}

/** speedRanker (torrent.js) may skip j on a slow wire when a faster wire also advertises it. */
function fasterHas(t: Torrent, wire: Wire, j: number, speed: number): boolean {
  for (const o of t.wires) {
    if (o === wire) continue
    const s = o.downloadSpeed()
    if (s >= SPEED_THRESHOLD && s > speed && o.peerPieces.get(j)) return true
  }
  return false
}

interface Snap {
  gen: number
  cls: Uint8Array
}
const snaps = new WeakMap<Torrent, Snap>()
let seen = new Uint8Array(0)

/**
 * The piece trySelectWire (or validateWire) would have asked this wire for before `i`: the first one, in the
 * walk of t._selections (in order, each from from + offset to to), that the peer advertises, that we lack, and
 * that has a block left to reserve. -1 when there is none, i.e. `i` was the head of the plan for this wire.
 * Pieces speedRanker may skip on a slow wire are counted in `exempt` instead.
 */
function walkAhead(t: Torrent, wire: Wire, i: number): { viol: number; exempt: number } {
  const n = t.pieces.length
  if (seen.length < n) seen = new Uint8Array(n)
  else seen.fill(0, 0, n)
  const speed = wire.downloadSpeed() || 1
  const ranked = wire.downloaded > 0 && speed <= SPEED_THRESHOLD
  let exempt = 0
  const sel = t._selections
  for (let s = 0; s < sel.length; s++) {
    const x = sel.get(s)
    for (let j = x.from + x.offset; j <= x.to; j++) {
      if (seen[j]) continue
      seen[j] = 1
      if (j === i) return { viol: -1, exempt }
      if (!wire.peerPieces.get(j) || !freeBlock(t.pieces[j])) continue
      if (ranked && fasterHas(t, wire, j, speed)) {
        exempt++
        continue
      }
      return { viol: j, exempt }
    }
  }
  return { viol: -1, exempt }
}

interface EngineGuts {
  role: 'host' | 'viewer' | null
  revealer: unknown
  memberOf(t: Torrent, wire: Wire): string | null
}

function hookViewerWire(e: EngineGuts, t: Torrent, wire: Wire): void {
  let peer: string | null = null
  const request = wire.request.bind(wire)
  wire.request = (index, offset, length, cb) => {
    peer ??= e.memberOf(t, wire)
    const at = hr()
    const snap = snaps.get(t)
    const { viol, exempt } = walkAhead(t, wire, index)
    record('req', [at, index, offset, tag(peer), snap?.cls[index] ?? CLS.none, snap?.gen ?? -1, viol, exempt])
    request(index, offset, length, cb)
  }
  // the host's take-back (BEP 54), as this wire saw it
  const ext = (wire as unknown as { lt_donthave?: { on(e: 'donthave', fn: (i: number) => void): void } }).lt_donthave
  ext?.on('donthave', (i) => record('donthave', [hr(), tag(peer ?? e.memberOf(t, wire)), i]))
}

// ---- host: served requests, reveals ---------------------------------------------------------------------

interface ViewGuts {
  id: string
  wire: Wire
  revealed: Uint8Array
  open: boolean
}

interface RevealerGuts {
  views: Map<string, ViewGuts>
  playhead: PlayheadPieces | null
  give: (this: RevealerGuts, v: ViewGuts, i: number, now: number) => void
  show: (this: RevealerGuts, v: ViewGuts, i: number, now?: number) => void
  revealUrgent: (this: RevealerGuts, v: ViewGuts, now: number) => void
  openUp: (this: RevealerGuts, v: ViewGuts, now: number) => void
  takeBack: (this: RevealerGuts, v: ViewGuts) => void
  setPlan: (this: RevealerGuts, plan: PlayheadPlan) => void
  setCriticalRanges: (this: RevealerGuts, ranges: readonly ByteRange[]) => void
  setUrgent: (this: RevealerGuts, id: string, pieces: readonly number[]) => void
  tick: (this: RevealerGuts) => void
}

const setPieces = (flags: Uint8Array): number[] => {
  const out: number[] = []
  for (let i = 0; i < flags.length; i++) if (flags[i]) out.push(i)
  return out
}

const hostWires = new Map<Wire, PeerTag>()

/** bytes a wire has pushed that its upload throttle has not taken yet (streamx's readable buffer) */
const queuedBytes = (wire: Wire): number =>
  (wire as unknown as { _readableState?: { buffered?: number } })._readableState?.buffered ?? 0

function sampleHostQueues(): void {
  const at = hr()
  for (const [wire, peer] of hostWires) {
    if (wire.destroyed) {
      hostWires.delete(wire)
      continue
    }
    record('queue', [at, peer, queuedBytes(wire), wire.peerRequests.length])
  }
}

function hookHostWire(e: EngineGuts, t: Torrent, wire: Wire): void {
  const id = e.memberOf(t, wire)
  const peer = tag(id)
  hostWires.set(wire, peer)
  wire.on('request', (index: number, offset: number, length: number) => {
    record('served', [hr(), index, offset, length, peer])
  })
  // the Revealer's own 'wire' listener ran first: what this viewer is shown before any reveal
  const view = id ? (e.revealer as RevealerGuts | null)?.views.get(id) : undefined
  if (view?.wire === wire) record('bitfield', { t: hr(), viewer: peer, pieces: setPieces(view.revealed) })
}

let revealCtx = 'other'
let tickNo = 0
const lastUrgent = new Map<string, string>()

function patchRevealer(): void {
  const rp = Revealer.prototype as unknown as RevealerGuts
  const { give, show, revealUrgent, openUp, takeBack, setPlan, setCriticalRanges, setUrgent, tick } = rp
  const within = <T>(ctx: string, fn: () => T): T => {
    const prev = revealCtx
    revealCtx = ctx
    try {
      return fn()
    } finally {
      revealCtx = prev
    }
  }
  rp.tick = function () {
    tickNo++
    tick.call(this)
  }
  rp.give = function (v, i, now) {
    let path = 'walk'
    for (const u of this.views.values()) {
      if (u === v) continue
      if (u.wire.peerPieces.get(i)) {
        path = 'holders'
        break
      }
      if (u.revealed[i]) path = 'rescue'
    }
    within(`give:${path}`, () => give.call(this, v, i, now))
  }
  rp.show = function (v, i, now) {
    if (!v.revealed[i]) {
      const [ctx = '?', path = ''] = revealCtx.split(':')
      record('reveal', [hr(), tag(v.id), i, ctx, path, tickNo])
    }
    show.call(this, v, i, now)
  }
  rp.revealUrgent = function (v, now) {
    within('urgent', () => revealUrgent.call(this, v, now))
  }
  rp.openUp = function (v, now) {
    within('open', () => openUp.call(this, v, now))
  }
  rp.setCriticalRanges = function (ranges) {
    within('critical', () => setCriticalRanges.call(this, ranges))
  }
  rp.takeBack = function (v) {
    const before = v.revealed.slice()
    takeBack.call(this, v)
    const gone: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] && !v.revealed[i]) gone.push(i)
    const ext = (v.wire as unknown as { lt_donthave?: { _peerSupports?: boolean } }).lt_donthave
    if (gone.length > 0) {
      record('takeback', {
        t: hr(),
        viewer: tag(v.id),
        pieces: gone,
        peerSupports: ext?._peerSupports ?? null,
        mappingId: v.wire.peerExtendedMapping.lt_donthave ?? null,
      })
    }
  }
  rp.setPlan = function (plan) {
    setPlan.call(this, plan)
    const ph = this.playhead
    const media = plan as PlayheadPlan & { posS?: number; reason?: string }
    record('gplan', {
      t: hr(),
      posS: media.posS ?? null,
      reason: media.reason ?? null,
      seek: plan.seek,
      p: ph?.p ?? null,
      w: ph?.w ?? null,
      hot: ph?.hot ? [ph.hot[0], ph.hot[1]] : null,
    })
  }
  rp.setUrgent = function (id, pieces) {
    within('urgent', () => setUrgent.call(this, id, pieces))
    const key = pieces.join(',')
    if (lastUrgent.get(id) === key) return
    lastUrgent.set(id, key)
    record('urgent', { t: hr(), viewer: tag(id), pieces: [...pieces] })
  }
}

// ---- viewer: the scheduler's plans ----------------------------------------------------------------------

interface SchedulerGuts {
  t: Torrent
  pieceCount: number
  live: { from: number; to: number }[]
  blocked: Map<string, number>
  critical: PieceRange[]
  playhead: PlayheadPieces | null
  paused: boolean
  replan: (this: SchedulerGuts) => void
  setPlayhead: (this: SchedulerGuts, plan: PlayheadPlan) => void
  addBlocked: (this: SchedulerGuts, key: string, piece: number) => void
  dropBlocked: (this: SchedulerGuts, key: string) => void
}

let planGen = 0

function patchScheduler(): void {
  const sp = Scheduler.prototype as unknown as SchedulerGuts
  const { replan, setPlayhead, addBlocked, dropBlocked } = sp
  sp.replan = function () {
    replan.call(this)
    const n = this.pieceCount
    const cls = new Uint8Array(n).fill(CLS.none)
    const ph = this.playhead
    if (!this.paused) {
      const mark = (a: number, b: number, c: number): void => {
        if (a <= b) cls.fill(c, Math.max(0, a), Math.min(n - 1, b) + 1)
      }
      if (ph) {
        mark(0, ph.p - 1, CLS.l3)
        mark(ph.p + ph.w + 1, n - 1, CLS.l2)
        mark(ph.p, ph.p + ph.w, CLS.l1)
      } else mark(0, n - 1, CLS.l1)
      const { urgent } = orderRanges(n, { blocked: [...this.blocked.values()], playhead: ph, critical: this.critical })
      for (const [a, b] of urgent) mark(a, b, CLS.urgent)
    }
    planGen++
    snaps.set(this.t, { gen: planGen, cls })
    record('plan', {
      t: hr(),
      gen: planGen,
      p: ph?.p ?? null,
      w: ph?.w ?? null,
      hot: ph?.hot ? [ph.hot[0], ph.hot[1]] : null,
      blocked: [...this.blocked.values()],
      critical: this.critical.map(([a, b]): [number, number] => [a, b]),
      live: this.live.map((s): [number, number] => [s.from, s.to]),
      paused: this.paused,
    })
  }
  sp.setPlayhead = function (plan) {
    const media = plan as PlayheadPlan & { posS?: number; reason?: string }
    record('playhead', {
      t: hr(),
      posS: media.posS ?? null,
      reason: media.reason ?? null,
      seek: plan.seek,
      byte: plan.byte,
      windowBytes: plan.windowBytes,
      hotBytes: plan.hotBytes,
    })
    setPlayhead.call(this, plan)
  }
  sp.addBlocked = function (key, piece) {
    if (this.blocked.get(key) !== piece) record('blocked', { t: hr(), op: 'add', key, piece })
    addBlocked.call(this, key, piece)
  }
  sp.dropBlocked = function (key) {
    if (this.blocked.has(key)) record('blocked', { t: hr(), op: 'drop', key, piece: this.blocked.get(key) ?? null })
    dropBlocked.call(this, key)
  }
}

// ---- engine, player, group ----------------------------------------------------------------------------------

function patchEngine(): void {
  const ep = TransferEngine.prototype as unknown as { installWireHooks: (this: EngineGuts, t: Torrent) => void }
  const { installWireHooks } = ep
  ep.installWireHooks = function (t) {
    installWireHooks.call(this, t)
    if (this.role === 'viewer') {
      t.on('verified', (i: number) => record('verified', [hr(), i]))
      t.on('wire', (wire: Wire) => hookViewerWire(this, t, wire))
    } else if (this.role === 'host') {
      t.on('wire', (wire: Wire) => hookHostWire(this, t, wire))
    }
  }
}

const WATCHED = new Set(['pause', 'seeking', 'paused-for-cache', 'eof-reached', 'speed', 'core-idle'])

function patchPlayer(): void {
  const hp = PlayerHolder.prototype as unknown as {
    emit: (this: PlayerHolder, name: string | symbol, ...args: unknown[]) => boolean
  }
  const { emit } = hp
  hp.emit = function (name, ...args) {
    const [a, b] = args
    if (name === 'property' && typeof a === 'string' && WATCHED.has(a)) record('prop', [hr(), a, b])
    else if (name === 'playbackRestart')
      record('restart', [hr(), (a as { pos?: number | null } | undefined)?.pos ?? null])
    return emit.call(this, name, ...args)
  }
}

function patchGroup(perfToHr: number): void {
  const gp = GroupController.prototype as unknown as {
    last: SyncState | null
    publish: (this: { last: SyncState | null }) => void
  }
  const { publish } = gp
  gp.publish = function () {
    publish.call(this)
    const st = this.last
    if (!st) return
    record('anchor', {
      t: hr(),
      seq: st.seq,
      mode: st.mode,
      pos: st.anchor.pos,
      hostTimeHr: st.anchor.hostTime + perfToHr,
    })
  }
}

interface MemberGuts {
  act: { k: string; pos?: number; target?: number; actual?: number | null; seeking?: boolean; exact?: boolean }
  unpauseLatMs: number
  localWhen: (this: MemberGuts, pos: number) => number
  beginPlay: (this: MemberGuts, meet?: boolean) => void
  schedulePlayFrom: (this: MemberGuts, pos: number, exact: boolean) => void
  unpauseNow: (this: MemberGuts, pos: number, exact: boolean) => void
  onSample: (this: MemberGuts, s: unknown, g: number) => void
}

/** What a member plans its unpauses from, when it schedules and sends them, and how its latency estimate moves. */
function patchMember(perfToHr: number): void {
  const mp = MemberController.prototype as unknown as MemberGuts
  const { beginPlay, schedulePlayFrom, unpauseNow, onSample } = mp
  mp.beginPlay = function (meet) {
    const a = this.act
    record('sync', {
      t: hr(),
      ev: 'beginPlay',
      k: a.k,
      pos: a.pos ?? a.target ?? null,
      actual: a.actual ?? null,
      seeking: a.seeking ?? null,
      lat: this.unpauseLatMs,
    })
    beginPlay.call(this, meet)
  }
  mp.schedulePlayFrom = function (pos, exact) {
    record('sync', {
      t: hr(),
      ev: 'schedule',
      pos,
      exact,
      lat: this.unpauseLatMs,
      atHr: this.localWhen(pos) - this.unpauseLatMs + perfToHr,
    })
    schedulePlayFrom.call(this, pos, exact)
  }
  mp.unpauseNow = function (pos, exact) {
    record('sync', { t: hr(), ev: 'unpause', pos, exact, lat: this.unpauseLatMs })
    unpauseNow.call(this, pos, exact)
  }
  mp.onSample = function (s, g) {
    const before = this.unpauseLatMs
    onSample.call(this, s, g)
    if (this.unpauseLatMs !== before) record('sync', { t: hr(), ev: 'lat', before, after: this.unpauseLatMs })
  }
}

// ---- the 4 Hz position sampler ------------------------------------------------------------------------------

interface Timed<T> {
  value: T
  tSend: number
  tRecv: number
}
interface Controller {
  getProperty<T>(name: string): Promise<Timed<T>>
}

interface SessionGuts {
  role: 'host' | 'viewer'
  room: { self: string; state(): { roomId: string } }
  manifest: Manifest | null
  transfer: { infoHash: string | null; pieceStates(): Uint8Array } | null
  saveDir?: string | null
  info?: { infoHash: string; pieceCount: number } | null
  playerHolder(): PlayerHolder | null
}

const current = (m: Member): SessionGuts | null => (m.manager as unknown as { current: SessionGuts | null }).current

const flag = (v: unknown): number => (v === true ? 1 : v === false ? 0 : -1)
const numOf = (r: PromiseSettledResult<Timed<unknown>>): number | null =>
  r.status === 'fulfilled' && typeof r.value.value === 'number' ? r.value.value : null

function startSampler(m: Member, perfToHr: number): void {
  let busy = false
  const sample = async (): Promise<void> => {
    const holder = current(m)?.playerHolder() ?? null
    if (!holder || holder.status !== 'ready' || busy) return
    busy = true
    try {
      const ctl = holder.player as unknown as Controller
      const [a, tp] = await Promise.allSettled([
        ctl.getProperty<unknown>('audio-pts'),
        ctl.getProperty<unknown>('time-pos'),
      ])
      const ref = a.status === 'fulfilled' ? a.value : tp.status === 'fulfilled' ? tp.value : null
      if (!ref) return
      const speed = holder.prop('speed')
      record('sample', [
        (ref.tSend + ref.tRecv) / 2 + perfToHr,
        ref.tRecv - ref.tSend,
        numOf(a),
        numOf(tp),
        flag(holder.prop('pause')),
        flag(holder.prop('seeking')),
        flag(holder.prop('paused-for-cache')),
        typeof speed === 'number' ? speed : -1,
      ])
    } finally {
      busy = false
    }
  }
  setInterval(() => void sample(), 250)
}

// ---- the child ----------------------------------------------------------------------------------------------

function info(m: Member, name: string): MemberInfo {
  const s = current(m)
  const manifest = s?.manifest ?? null
  const holder = s?.playerHolder() ?? null
  const infoHash = s ? (s.role === 'host' ? (s.transfer?.infoHash ?? null) : (s.info?.infoHash ?? null)) : null
  const saveDir = s?.role === 'viewer' ? (s.saveDir ?? null) : null
  return {
    name,
    dir: m.dir,
    role: s?.role ?? null,
    self: s?.room.self ?? null,
    roomId: s?.room.state().roomId ?? null,
    infoHash,
    saveDir,
    transferDir: saveDir && infoHash ? join(saveDir, '.wt-partial', infoHash) : null,
    manifest: manifest
      ? {
          pieceLength: manifest.pieceLength,
          fileSize: manifest.fileSize,
          durationMs: manifest.durationMs,
          container: manifest.container,
          keyframes: manifest.keyframes.map(([t, b]): [number, number] => [t, b]),
          openCritical: manifest.openCritical.map(([a, b]): [number, number] => [a, b]),
          seekCritical: manifest.seekCritical.map(([a, b]): [number, number] => [a, b]),
        }
      : null,
    pieceCount: s?.role === 'host' ? (s.transfer?.pieceStates().length ?? null) : (s?.info?.pieceCount ?? null),
    mpvPid: holder?.pid ?? null,
  }
}

async function childMain(opts: ChildOptions): Promise<void> {
  const perfToHr = perfToHrOffset()
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception', e)
    send({ t: 'fatal', kind: 'uncaughtException', message: e.stack ?? e.message, at: hr() })
  })
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection', e)
    send({
      t: 'fatal',
      kind: 'unhandledRejection',
      message: e instanceof Error ? (e.stack ?? e.message) : String(e),
      at: hr(),
    })
  })
  patchEngine()
  patchScheduler()
  patchRevealer()
  patchPlayer()
  patchGroup(perfToHr)
  patchMember(perfToHr)

  const m = member(opts.name, opts.root, {
    realMpv: opts.realMpv ?? true,
    ...(opts.settings ? { settings: opts.settings } : {}),
  })
  await log.open(join(m.dir, 'logs')) // core.log next to mpv.log (until then the log only buffers)
  // every RPC event: those recorded already first, then each as it comes, stamped
  const events = m.client.events
  for (const ev of events) send({ t: 'evt', e: ev.e, d: ev.d, at: hr() })
  const push = events.push.bind(events)
  events.push = (...items) => {
    const at = hr()
    for (const ev of items) send({ t: 'evt', e: ev.e, d: ev.d, at })
    return push(...items)
  }
  startSampler(m, perfToHr)
  setInterval(sampleHostQueues, 250)
  setInterval(() => {
    const u = process.memoryUsage()
    record('mem', [hr(), u.rss, u.heapUsed])
  }, 1000)
  setInterval(flushLogs, 500)

  let stopping: Promise<void> | null = null
  const stop = (): Promise<void> => {
    stopping ??= Promise.race([
      m.manager.shutdown().catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]).then(() => log.flush())
    return stopping
  }
  process.once('disconnect', () => void stop().finally(() => process.exit(0)))
  process.on('message', (msg: ToChild) => {
    switch (msg.t) {
      case 'req': {
        const tReq = hr()
        m.client.request(msg.m, msg.p as never).then(
          (v) => send({ t: 'res', id: msg.id, ok: true, v, tReq, tRes: hr() }),
          (e: unknown) =>
            send({
              t: 'res',
              id: msg.id,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              tReq,
              tRes: hr(),
            }),
        )
        break
      }
      case 'info':
        send({ t: 'info', id: msg.id, info: info(m, opts.name) })
        break
      case 'flush':
        flushLogs()
        send({ t: 'flushed', id: msg.id })
        break
      case 'shutdown':
        void stop().then(() => {
          flushLogs()
          send({ t: 'down', id: msg.id })
        })
        break
    }
  })
  send({ t: 'ready', dir: m.dir, pid: process.pid, perfToHr })
}

const childOpts = process.env.WT_ALPHA_CHILD
if (childOpts) void childMain(JSON.parse(childOpts) as ChildOptions)
