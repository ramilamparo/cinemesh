// One room member in its own process and network namespace (run.ts starts it with `ip netns exec`). It runs what
// the app runs for a striped room: a Room (src/core/net) on the testnet, a TransferEngine attached to every admitted
// peer, and the sessions' striping glue (collectTransferLinks / reportTransferLinks: 'transfer.links' on the bus).
// What the sessions would add on top (the sync engine, mpv, the media index) is simulated:
//   - the room's playhead: the host plays a video of `bitrate` bytes/s and sends its position to every viewer on
//     the ctrl lane at 1 Hz ('play'), like sync.state; a group seek is setGroupPlayhead + a 'seek' ctrl frame;
//   - mpv after a seek: the viewer reads `readPieces` pieces from the target through its PieceSource, blocking on
//     each missing piece as the stream server would (reader.blockedOn -> the scheduler -> 'blocked-changed' ->
//     the host's setViewerUrgent).
// Measured: ctrl-lane pings (host -> viewer -> host, 100 ms apart) and datagram pings, both with one-way delays on
// the shared monotonic clock; per-wire upload queues (lib/upload-sched.ts); UDX state; event-loop delay.
// Commands arrive as JSON lines on stdin, events leave as JSON lines on stdout (lib/proto.ts).
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import readline from 'node:readline'
import type { Torrent, Wire } from 'webtorrent'
import { CoreLog } from '../../../src/core/log.js'
import { Room, type RoomPeer, type RoomTiming } from '../../../src/core/net/room.js'
import { collectTransferLinks, reportTransferLinks } from '../../../src/core/session/striping.js'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { prepareHost } from '../../../src/core/transfer/host-prepare.js'
import type { PlayheadPlan } from '../../../src/core/transfer/scheduler.js'
import { DelayPacer } from './pacer.js'
import {
  CTRL_NS,
  type Command,
  DGRAM_PREFIX,
  type MemberConfig,
  type MemberEvent,
  type PieceRead,
  type Trial,
  now,
} from './proto.js'
import { UploadSched } from './upload-sched.js'

const cfg = JSON.parse(process.argv[2] ?? '{}') as MemberConfig
const isHost = cfg.role === 'host'
const P = cfg.pieceLength
const B = cfg.bitrate
const MIB = 2 ** 20

function emit(e: MemberEvent): void {
  process.stdout.write(`${JSON.stringify(e)}\n`)
}
process.on('uncaughtException', (e) => {
  emit({ ev: 'error', msg: `uncaught: ${e.stack ?? e.message}` })
})

// the integration tests' FAST timing: the mesh forms in seconds instead of tens of seconds
const FAST: Partial<RoomTiming> = {
  admitWaitMs: 1000,
  rejoinMs: 3000,
  hostAwayMs: 3000,
  hostRefreshMs: 3000,
  heartbeatMs: 1000,
  ctrlRetryMs: 500,
  ctrlPairWaitMs: 3000,
  meshRepairMs: 1000,
  kickGraceMs: 300,
  tickMs: 200,
}

// --jit-udx: count what each UDX stream is handed and gets acknowledged. udx-native exposes inflight but not its send
// queue; the binding captures _onack when a stream is built, so the prototype is patched before any stream exists.
interface UdxCounted {
  _wreqs: ({ buffer: Uint8Array | null; buffers: Uint8Array[] | null } | undefined)[]
  inflight: number
  s2bWritten?: number
  s2bAcked?: number
}
if (isHost && cfg.jitUdx) {
  const UDXStream = createRequire(import.meta.url)('udx-native/lib/stream.js') as { prototype: Record<string, unknown> }
  const proto = UDXStream.prototype
  const writev = proto._writev as (this: UdxCounted, buffers: Uint8Array[], cb: unknown) => unknown
  const onack = proto._onack as (this: UdxCounted, id: number) => unknown
  proto._writev = function (this: UdxCounted, buffers: Uint8Array[], cb: unknown): unknown {
    let n = 0
    for (const b of buffers) n += b.byteLength
    this.s2bWritten = (this.s2bWritten ?? 0) + n
    return writev.call(this, buffers, cb)
  }
  proto._onack = function (this: UdxCounted, id: number): unknown {
    const req = this._wreqs[id]
    let n = req?.buffer?.byteLength ?? 0
    for (const b of req?.buffers ?? []) n += b.byteLength
    this.s2bAcked = (this.s2bAcked ?? 0) + n
    return onack.call(this, id)
  }
}

const log = new CoreLog()
await log.open(join(cfg.dir, `${cfg.name}-log`))
const options = {
  displayName: cfg.name,
  settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
  store: null,
  env: { WT_BOOTSTRAP: cfg.bootstrap },
  log: { debug: () => undefined, info: (m: string) => log.info(m), warn: (m: string) => log.warn(m) },
  maxMembers: 8,
  testing: { timing: FAST },
}
const room = isHost ? await Room.create({ ...options, name: 'S2b' }) : await Room.join(cfg.invite ?? '', options)
await room.ready()
emit({ ev: 'up', id: room.self })
if (isHost) emit({ ev: 'invite', code: room.invite().code })
const meshNow = (): void => emit({ ev: 'mesh', peers: room.peers().length, phase: room.state().phase })
room.on('peer', meshNow)
room.on('peer-gone', meshNow)
room.on('state', meshNow)

// ---- the simulated video and its playhead -------------------------------------------------------------------------

const torrentBuf = readFileSync(cfg.torrentPath)
const fileLength = (await import('parse-torrent').then((m) => m.default(torrentBuf))).length
const clampByte = (b: number): number => Math.max(0, Math.min(fileLength - 1, Math.floor(b)))
function planAt(posS: number, seek: boolean): PlayheadPlan {
  return {
    byte: clampByte(posS * B),
    windowBytes: Math.min(256 * MIB, Math.max(2 * P, 25 * B)),
    hotBytes: Math.min(256 * MIB, 8 * B),
    seek,
    urgent: [],
  }
}
const pieceCount = Math.ceil(fileLength / P)
const openCritical: [number, number][] = [
  [0, Math.min(fileLength, 2 * P)],
  [(pieceCount - 1) * P, fileLength],
]
let anchor = { posS: 0, at: now() }
const posNow = (): number => Math.min(fileLength / B, anchor.posS + (now() - anchor.at) / 1000)

// ---- measurements -------------------------------------------------------------------------------------------------

const marks: { name: string; at: number }[] = []
const eldAll = monitorEventLoopDelay({ resolution: 10 })
eldAll.enable()
const eldMeasure = monitorEventLoopDelay({ resolution: 10 })
/** host: pongs of its pings */
const ctrlRtts: { peer: string; id: number; t0: number; rtt: number; fwd: number }[] = []
const dgramRtts: { peer: string; id: number; t0: number; rtt: number; fwd: number }[] = []
const pingsSent: { peer: string; id: number; t0: number }[] = []
/** host: the viewer's UDX stream when each ping left (BBR state, cwnd and inflight in bytes, srtt ms) */
const pingUdx: { peer: string; id: number; bbr: number; cwnd: number; inflight: number; rtt: number }[] = []
/** viewer: one-way delays of the host's pings */
const ctrlOwd: { id: number; t0: number; owd: number }[] = []
const dgramOwd: { id: number; t0: number; owd: number }[] = []
const samples: Record<string, unknown>[] = []
const trials: Trial[] = []
/**
 * Where a trial's time goes: per piece of the last trials, the first time each step happened, per member.
 * host: reveal (have sent), req (request arrived), rel (jit released it), push (block pushed into the wire),
 *       sent (block past the throttle), sentAll (every block past the throttle);
 * viewer: have, req (request sent), blk (first block in), blkAll (every block in), ver (verified).
 */
const tracked = new Map<number, number>() // piece -> trial seq
const trace: { seq: number; piece: number; ev: string; at: number; member: string | null; info?: number }[] = []
const traceSeen = new Set<string>()
const blockCounts = new Map<string, number>()
const BLOCKS = Math.ceil(P / 16384)
function track(seq: number, from: number, to: number): void {
  for (const [piece, s] of tracked) if (s < seq - 1) tracked.delete(piece)
  for (let i = from; i <= to; i++) tracked.set(i, seq)
}
function traceEv(piece: number, ev: string, member: string | null, everyBlock = false, info?: number): void {
  const seq = tracked.get(piece)
  if (seq === undefined) return
  const key = `${String(seq)}:${String(piece)}:${ev}:${member ?? ''}`
  if (everyBlock) {
    const n = (blockCounts.get(key) ?? 0) + 1
    blockCounts.set(key, n)
    if (n === BLOCKS) trace.push({ seq, piece, ev: `${ev}All`, at: now(), member })
  }
  if (traceSeen.has(key)) return
  traceSeen.add(key)
  trace.push({ seq, piece, ev, at: now(), member, ...(info === undefined ? {} : { info }) })
}
const seeks: { seq: number; S: number; at: number; kind: 'seek' | 'far'; viewer?: string }[] = []

let engine: TransferEngine | null = null
let torrent: Torrent | null = null
let sched: UploadSched | null = null
let pacer: DelayPacer | null = null
const timers: ReturnType<typeof setInterval>[] = []
const every = (ms: number, fn: () => void): void => {
  timers.push(setInterval(fn, ms))
}

const viewersSorted = (): RoomPeer[] =>
  [...room.peers()].filter((p) => !p.isHost).sort((a, b) => (a.id < b.id ? -1 : 1))

room.onDatagram(DGRAM_PREFIX, (peer, buf) => {
  if (buf.length < 22) return
  const type = buf[1]
  const id = buf.readUInt32LE(2)
  const t0 = buf.readDoubleLE(6)
  const at = now()
  if (type === 1 && !isHost) {
    dgramOwd.push({ id, t0, owd: at - t0 })
    const out = Buffer.from(buf)
    out[1] = 2
    out.writeDoubleLE(at, 14)
    peer.sendDatagram(out)
  } else if (type === 2 && isHost) {
    const fwd = buf.readDoubleLE(14) - t0
    dgramRtts.push({ peer: peer.id, id, t0, rtt: at - t0, fwd })
    pacer?.sample('dgram', peer.id, fwd, at)
  }
})

room.onCtrl(CTRL_NS, (peer, frame) => {
  const at = now()
  const t = frame.t
  if (t === 'ping' && !isHost) {
    const t0 = Number(frame.t0)
    ctrlOwd.push({ id: Number(frame.id), t0, owd: at - t0 })
    peer.sendCtrl({ ns: CTRL_NS, t: 'pong', id: frame.id, t0: frame.t0, t1: at })
  } else if (t === 'pong' && isHost) {
    const t0 = Number(frame.t0)
    const fwd = Number(frame.t1) - t0
    ctrlRtts.push({ peer: peer.id, id: Number(frame.id), t0, rtt: at - t0, fwd })
    pacer?.sample('ctrl', peer.id, fwd, at)
  } else if (t === 'play' && !isHost) {
    anchor = { posS: Number(frame.posS), at }
    engine?.setPlayhead(planAt(anchor.posS, false))
  } else if (t === 'seek' && !isHost) {
    anchor = { posS: Number(frame.posS), at }
    engine?.setPlayhead(planAt(anchor.posS, true))
    void readTrial(
      'seek',
      Number(frame.seq),
      Number(frame.S),
      Number(frame.S) + cfg.readPieces - 1,
      Number(frame.at),
      at,
    )
  } else if (t === 'far' && !isHost) {
    void readTrial('far', Number(frame.seq), Number(frame.K), Number(frame.K), Number(frame.at), at)
  }
})

if (isHost) {
  let pingId = 0
  every(cfg.pingMs, () => {
    const id = ++pingId
    const t0 = now()
    for (const p of viewersSorted()) {
      const u = udxOf(p)
      if (u) pingUdx.push({ peer: p.id, id, bbr: u.bbr, cwnd: u.cwnd, inflight: u.inflight, rtt: u.rtt })
      p.sendCtrl({ ns: CTRL_NS, t: 'ping', id, t0 })
      const buf = Buffer.alloc(22)
      buf[0] = DGRAM_PREFIX
      buf[1] = 1
      buf.writeUInt32LE(id, 2)
      buf.writeDoubleLE(t0, 6)
      if (p.sendDatagram(buf)) pingsSent.push({ peer: p.id, id, t0 })
    }
  })
}

// ---- viewer: reads after a seek ----------------------------------------------------------------------------------

let current: { trial: Trial; abort: AbortController } | null = null

async function readTrial(
  kind: 'seek' | 'far',
  seq: number,
  from: number,
  to: number,
  hostAt: number,
  recvAt: number,
): Promise<void> {
  const src = engine?.streamSource
  if (!src) return
  if (current && kind === 'seek') {
    current.trial.aborted = true
    current.abort.abort()
  }
  const trial: Trial = { kind, seq, viewer: room.self, hostAt, recvAt, reads: [], aborted: false }
  track(seq, from, to)
  const abort = new AbortController()
  if (kind === 'seek') current = { trial, abort }
  const deadline = setTimeout(() => {
    trial.aborted = true
    abort.abort()
  }, 30_000)
  const reader = src.openReader(0, from * P)
  try {
    for (let i = from; i <= to && i < pieceCount; i++) {
      const read: PieceRead = { piece: i, blockedAt: null, verifiedAt: null }
      trial.reads.push(read)
      if (src.has(i)) {
        read.verifiedAt = now()
        continue
      }
      read.blockedAt = now()
      reader.blockedOn(i)
      await src.waitVerified(i, abort.signal)
      read.verifiedAt = now()
    }
  } catch {
    trial.aborted = true
  } finally {
    clearTimeout(deadline)
    reader.close()
    if (current?.trial === trial) current = null
  }
  trials.push(trial)
  emit({ ev: 'trial', trial })
}

// ---- host: seeks and far reads ------------------------------------------------------------------------------------

let rngState = 0x2545f491 ^ cfg.seed
function rand(): number {
  // mulberry32
  rngState = (rngState + 0x6d2b79f5) | 0
  let x = rngState
  x = Math.imul(x ^ (x >>> 15), x | 1)
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

/** nobody holds or is fetching any piece of [S, S + span) */
function untouched(S: number, span: number): boolean {
  const t = torrent
  if (!t) return false
  for (const w of t.wires) {
    for (let i = S; i < S + span; i++) if (w.peerPieces.get(i)) return false
    for (const r of w.peerRequests) if (r.piece >= S && r.piece < S + span) return false
  }
  for (const q of sched?.queues ?? []) for (const r of q.pending) if (r.index >= S && r.index < S + span) return false
  return true
}

let trialSeq = 0
function groupSeek(): void {
  if (!engine || !torrent) return
  const span = cfg.readPieces + Math.ceil((8 * B) / P) + 2
  const p = Math.floor((posNow() * B) / P)
  const w = Math.ceil((25 * B) / P)
  let S: number | null = null
  for (let k = 0; k < 400 && S === null; k++) {
    const c = 2 + Math.floor(rand() * (pieceCount - span - 3))
    if (c + span >= p - 2 && c <= p + w + 2) continue // in or next to the current window
    if (untouched(c, span)) S = c
  }
  if (S === null) {
    emit({ ev: 'log', msg: 'no untouched seek target' })
    return
  }
  const seq = ++trialSeq
  track(seq, S, S + cfg.readPieces - 1)
  const posS = (S * P) / B
  const at = now()
  anchor = { posS, at }
  engine.setGroupPlayhead(planAt(posS, true))
  for (const v of viewersSorted()) v.sendCtrl({ ns: CTRL_NS, t: 'seek', seq, S, posS, at })
  seeks.push({ seq, S, at, kind: 'seek' })
  emit({ ev: 'seek', seq, S, at })
}

let farNext = -1
function farRead(viewerIndex: number): void {
  if (!torrent) return
  const vs = viewersSorted()
  const v = vs[viewerIndex % Math.max(1, vs.length)]
  if (!v) return
  if (farNext < 0) farNext = pieceCount - 2
  while (farNext > 2 && !untouched(farNext, 1)) farNext -= 3
  const K = farNext
  farNext -= 3
  const seq = ++trialSeq
  track(seq, K, K)
  const at = now()
  v.sendCtrl({ ns: CTRL_NS, t: 'far', seq, K, at })
  seeks.push({ seq, S: K, at, kind: 'far', viewer: v.id })
  emit({ ev: 'far', seq, K, viewer: v.id, at })
}

// ---- start --------------------------------------------------------------------------------------------------------

interface RevealerInternals {
  urgent: Map<string, Map<number, number>>
  playhead: { hot: readonly [number, number] | null } | null
  critical: readonly (readonly [number, number])[]
}

async function startHost(e: TransferEngine): Promise<void> {
  const prepared = await prepareHost({
    videoPath: cfg.sourcePath,
    subtitlePaths: [],
    cacheRoot: cfg.cacheRoot,
    pieceLength: P,
  })
  // jit enforces the rate itself, in release order: WebTorrent's throttle (unfair between wires) stays off, and the
  // engine's limit field is set directly so the Revealer's budget R sees the same rate as with the throttle
  const jit = cfg.sched === 'jit'
  await e.startHost(prepared, { uploadLimitKBps: jit ? null : cfg.uploadLimitKBps })
  const limitField = e as unknown as { uploadLimitKBps: number | null }
  let jitRate: number | null = null
  if (jit && cfg.uploadLimitKBps) {
    jitRate = cfg.uploadLimitKBps * 1024
    limitField.uploadLimitKBps = cfg.uploadLimitKBps
  }
  const t = (e as unknown as { torrent: Torrent }).torrent
  torrent = t
  e.setGroupCriticalRanges(openCritical)
  e.setGroupPlayhead(planAt(0, true))
  anchor = { posS: 0, at: now() }
  collectTransferLinks({ room, transfer: e, log })
  const internals = e as unknown as { revealer: RevealerInternals | null; memberOf(t: Torrent, w: Wire): string | null }
  // the request classes the prototype orders by: what the Revealer already knows
  let cache: {
    at: number
    urgent: Set<number>
    hot: readonly [number, number] | null
    crit: readonly (readonly [number, number])[]
  } | null = null
  const classOf = (i: number): number => {
    const t0 = now()
    if (!cache || t0 - cache.at > 20) {
      const rv = internals.revealer
      const urgent = new Set<number>()
      for (const m of rv?.urgent.values() ?? []) for (const k of m.keys()) urgent.add(k)
      cache = { at: t0, urgent, hot: rv?.playhead?.hot ?? null, crit: rv?.critical ?? [] }
    }
    if (cache.urgent.has(i)) return 0
    if (cache.hot && i >= cache.hot[0] && i <= cache.hot[1]) return 1
    for (const [a, b] of cache.crit) if (i >= a && i <= b) return 1
    return 2
  }
  const short = (w: Wire): string | null => internals.memberOf(t, w)?.slice(0, 8) ?? null
  const rawOf = new Map<Wire, UdxCounted>()
  const udx = (w: Wire): { written: number; acked: number; inflight: number } | null => {
    let raw = rawOf.get(w)
    if (!raw) {
      const id = internals.memberOf(t, w)
      const p = id === null ? undefined : room.peers().find((x) => x.id === id)
      raw = (p?.mux.stream as { rawStream?: UdxCounted | null } | null)?.rawStream ?? undefined
      if (!raw) return null
      rawOf.set(w, raw)
    }
    return { written: raw.s2bWritten ?? 0, acked: raw.s2bAcked ?? 0, inflight: raw.inflight }
  }
  sched = new UploadSched(t, {
    mode: cfg.sched === 'jit' ? 'jit' : 'monitor',
    urgent: cfg.urgent,
    targetMs: cfg.jitTargetMs,
    minBytes: cfg.jitMinBytes,
    rateBps: () => jitRate,
    burstMs: cfg.jitBurstMs,
    memberOf: (w) => internals.memberOf(t, w),
    classOf,
    onTrace: (ev, piece, w) => traceEv(piece, ev, short(w), ev === 'sent'),
    // with monitor, only reported (the baseline's UDX send queue); with jit, part of each wire's queue
    ...(cfg.jitUdx ? { udx } : {}),
  })
  if (cfg.preempt && cfg.sched === 'jit') {
    // a newly reported blocked piece: the Revealer shows it (a 'have', inside setViewerUrgent), then the viewer's held
    // requests are rejected behind that have, so its refill asks for the blocked piece first
    const seen = new Map<string, Set<number>>()
    const setUrgent = e.setViewerUrgent.bind(e)
    e.setViewerUrgent = (id: string, pieces: readonly number[]) => {
      setUrgent(id, pieces)
      const before = seen.get(id) ?? new Set<number>()
      const fresh = pieces.some((i) => !before.has(i))
      seen.set(id, new Set(pieces))
      if (fresh) sched?.preempt(id)
    }
  }
  // the Revealer shows a piece with wire.have (an own property here, so its calls come through)
  t.on('wire', (w: Wire) => {
    const have = w.have.bind(w)
    w.have = (i: number) => {
      have(i)
      if (!tracked.has(i)) return
      // the have's bytes ahead of it in this wire, and when they have all left the throttle
      const ahead = sched?.watch(w, () => traceEv(i, 'revealSent', short(w))) ?? undefined
      traceEv(i, 'reveal', short(w), false, ahead === null ? undefined : ahead)
    }
  })
  if (cfg.pacer) {
    const client = (e as unknown as { client: { throttleGroups: { up: ThrottleGroupLike } } }).client
    const group = client.throttleGroups.up
    const burstS = cfg.pacer.burstS
    let lastKBps = 0
    const apply = (bps: number): void => {
      const kbps = Math.max(32, Math.round(bps / 1024))
      if (jit) {
        jitRate = bps // the scheduler releases at this rate
        limitField.uploadLimitKBps = kbps
        return
      }
      if (kbps === lastKBps) return
      lastKBps = kbps
      e.setUploadLimit(kbps) // throttleUpload -> setRate: bucket = 1 s of rate, slices of rate/10
      group.setChunksize(16 * 1024)
      group.bucket.bucketSize = Math.max(16 * 1024, Math.round(kbps * 1024 * burstS))
    }
    const history: { at: number; passed: number }[] = []
    const upBps = (): number => {
      const at = now()
      const passed = sched?.totalPassed ?? 0
      history.push({ at, passed })
      while (history.length > 1 && (history[0] as { at: number }).at < at - 500) history.shift()
      const first = history[0] as { at: number; passed: number }
      return at - first.at > 50 ? ((passed - first.passed) * 1000) / (at - first.at) : 0
    }
    pacer = new DelayPacer(cfg.pacer, apply, upBps, now)
    pacer.start()
    if (cfg.pacer.signal === 'udx') {
      // UDX's smoothed RTT of each viewer's stream, while that stream sends (an idle stream's srtt is stale)
      const lastTx = new Map<string, number>()
      every(50, () => {
        const at = now()
        for (const p of viewersSorted()) {
          const u = udxOf(p)
          if (!u || u.rtt <= 0) continue
          if (u.bytesTx !== lastTx.get(p.id)) pacer?.sample('udx', p.id, u.rtt, at)
          lastTx.set(p.id, u.bytesTx)
        }
      })
    }
  }
  every(1000, () => {
    const posS = posNow()
    e.setGroupPlayhead(planAt(posS, false))
    for (const v of viewersSorted()) v.sendCtrl({ ns: CTRL_NS, t: 'play', posS })
  })
}

interface ThrottleGroupLike {
  setChunksize(n: number): void
  bucket: { bucketSize: number }
}

async function startViewer(e: TransferEngine): Promise<void> {
  await e.joinAsViewer({ torrent: torrentBuf, dir: join(cfg.dir, `${cfg.name}-data`), uploadLimitKBps: null })
  const t = (e as unknown as { torrent: Torrent }).torrent
  torrent = t
  const memberOf = (w: Wire): string | null =>
    (e as unknown as { memberOf(t: Torrent, w: Wire): string | null }).memberOf(t, w)?.slice(0, 8) ?? null
  t.on('wire', (w: Wire) => {
    w.on('have', (i: number) => traceEv(i, 'have', memberOf(w)))
    w.on('piece', (i: number) => traceEv(i, 'blk', memberOf(w), true))
    const request = w.request.bind(w)
    w.request = (i, offset, length, cb) => {
      traceEv(i, 'req', memberOf(w))
      request(i, offset, length, cb)
    }
  })
  t.on('verified', (i: number) => traceEv(i, 'ver', null))
  e.setCriticalRanges(openCritical)
  e.setPlayhead(planAt(posNow(), true))
  reportTransferLinks({ room, hostId: room.state().hostKey, transfer: e, log })
}

async function start(): Promise<void> {
  const e = new TransferEngine()
  engine = e
  e.on('error', (err) => emit({ ev: 'error', msg: `transfer: ${err.message}` }))
  if (isHost) await startHost(e)
  else await startViewer(e)
  room.on('peer', (p) => e.attach(p))
  room.on('peer-gone', (id) => e.detach(id))
  for (const p of room.peers()) e.attach(p)
  every(1000, sample)
  emit({ ev: 'started' })
}

function udxOf(p: RoomPeer): Record<string, number> | null {
  const raw = (p.mux.stream as unknown as { rawStream?: Record<string, number> | null } | null)?.rawStream
  if (!raw) return null
  return {
    rtt: raw.rtt ?? 0,
    cwnd: raw.cwnd ?? 0,
    inflight: raw.inflight ?? 0,
    retransmits: raw.retransmits ?? 0,
    rtoCount: raw.rtoCount ?? 0,
    fastRecoveries: raw.fastRecoveries ?? 0,
    bbr: raw.bbrState ?? -1,
    bytesTx: raw.bytesTransmitted ?? 0,
    packetsTx: raw.packetsTransmitted ?? 0,
    bytesRx: raw.bytesReceived ?? 0,
  }
}

function sample(): void {
  const t = torrent
  if (!t || !engine) return
  const internals = engine as unknown as { servedBytes: number; distinctServedBytes: number }
  let verified = 0
  for (const p of t.pieces) if (p === null) verified++
  const counters = t as unknown as { uploaded: number; downloaded: number }
  samples.push({
    at: now(),
    uploaded: counters.uploaded,
    downloaded: counters.downloaded,
    verified,
    ...(isHost
      ? {
          passed: sched?.totalPassed ?? 0,
          served: internals.servedBytes,
          distinct: internals.distinctServedBytes,
          wires: sched?.snapshot() ?? [],
          udx: Object.fromEntries(room.peers().map((p) => [p.id.slice(0, 8), udxOf(p)])),
          roomRtt: Object.fromEntries(room.members().map((m) => [m.id.slice(0, 8), m.rttMs])),
          limitKBps: (engine as unknown as { uploadLimitKBps: number | null }).uploadLimitKBps,
        }
      : {
          fromPeers: Object.fromEntries(
            (lastStats?.peers ?? []).map((p) => [p.id.slice(0, 8), { down: p.downloaded, up: p.uploaded }]),
          ),
        }),
  })
}
let lastStats: { peers: { id: string; downloaded: number; uploaded: number }[] } | null = null
setInterval(() => {
  if (engine) lastStats = (engine as unknown as { stats(): typeof lastStats }).stats()
}, 1000).unref()

// ---- finish -------------------------------------------------------------------------------------------------------

function eld(h: ReturnType<typeof monitorEventLoopDelay>): Record<string, number> | null {
  if (h.count === 0) return null
  const ms = (x: number): number => Number((x / 1e6).toFixed(2))
  return { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max), count: h.count }
}

async function finish(): Promise<void> {
  for (const t of timers) clearInterval(t)
  pacer?.stop()
  eldAll.disable()
  eldMeasure.disable()
  sample()
  const report = {
    name: cfg.name,
    role: cfg.role,
    id: room.self,
    cfg,
    marks,
    eldAll: eld(eldAll),
    eldMeasure: eld(eldMeasure),
    samples,
    ctrlRtts,
    dgramRtts,
    pingsSent,
    pingUdx,
    ctrlOwd,
    dgramOwd,
    trials,
    seeks,
    trace,
    sched: sched
      ? {
          capWaits: sched.capWaits,
          rateWaits: sched.rateWaits,
          preempted: sched.preempted,
          unhooked: sched.unhooked,
          wires: sched.summary(),
        }
      : null,
    pacer: pacer ? pacer.ticks : null,
    stats: engine ? (engine as unknown as { stats(): unknown }).stats() : null,
  }
  const path = join(cfg.dir, `${cfg.name}.json`)
  writeFileSync(path, JSON.stringify(report))
  emit({ ev: 'report', path })
  sched?.destroy()
  if (engine) {
    if (isHost) await engine.destroy()
    else await engine.leave({ data: 'delete' }).catch(() => undefined)
  }
  await room.close().catch(() => undefined)
  await log.flush()
  process.exit(0)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let cmd: Command
  try {
    cmd = JSON.parse(line) as Command
  } catch {
    return
  }
  if (cmd.t === 'start') {
    start().catch((e: unknown) =>
      emit({ ev: 'error', msg: `start: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}` }),
    )
  } else if (cmd.t === 'mark') {
    marks.push({ name: cmd.name, at: cmd.at })
    if (cmd.name === 'measure') eldMeasure.enable()
  } else if (cmd.t === 'seek') {
    groupSeek()
  } else if (cmd.t === 'far') {
    farRead(cmd.viewer)
  } else {
    void finish()
  }
})
rl.on('close', () => void finish())
