// Part A: does the plan's replan() produce the R6 request order on a real viewer?
// One host (uploadLimit-throttled) + v1 (instrumented) + v2, full mesh, in one process.
//   npx tsx spikes/s3-scheduler/part-a.ts [--delay 25] [--churn] [--peer-plan same|independent]
//     [--sentinel] [--batched] [--host-rate 10] [--out name]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DATA_DIR,
  deadman,
  fixture,
  link,
  makeHost,
  makeViewer,
  MiB,
  PATCHED_WT,
  peerNamer,
  sleep,
  teardown,
} from './lib/net.js'
import { pieceStates } from './lib/piece-states.js'
import { RequestLog, type Req } from './lib/request-log.js'
import { type Range, Scheduler, windowPieces } from './lib/scheduler.js'

const { values: args } = parseArgs({
  options: {
    delay: { type: 'string', default: '0' },
    churn: { type: 'boolean', default: false },
    'peer-plan': { type: 'string', default: 'same' },
    sentinel: { type: 'boolean', default: false },
    batched: { type: 'boolean', default: false },
    'host-rate': { type: 'string', default: '10' },
    out: { type: 'string', default: 'part-a' },
  },
})

const SIZE_MIB = 256
const P = 256 * 1024
const BITRATE = 1_000_000 // bytes/s, ~8 Mbit/s: w = 96 pieces (24 MiB)
const HOST_RATE = Number(args['host-rate']) * 1_000_000
const DELAY = Number(args.delay)
deadman(140_000)

const { torrentFile } = await fixture(SIZE_MIB, P)
const host = await makeHost(torrentFile, HOST_RATE)
let s1!: Scheduler
let log!: RequestLog
const v1 = await makeViewer('v1', torrentFile, (t) => {
  // the 'wire' listener must exist before any wire: install the logger as soon as the torrent exists
  log = new RequestLog(
    t,
    (w) => name(w),
    () => s1?.inReplan ?? false,
  )
})
const v2 = await makeViewer('v2', torrentFile)
const nodes = [host, v1, v2]
const name = peerNamer(nodes)
s1 = new Scheduler(v1.torrent, args.sentinel, args.batched)
const s2 = new Scheduler(v2.torrent, args.sentinel, args.batched)

const N = v1.torrent.pieces.length
const w = windowPieces(BITRATE, P)
const hotLen = Math.ceil((8 * BITRATE) / P)
const verifiedAt = new Map<number, number>()
v1.torrent.on('verified', (i: number) => verifiedAt.set(i, log.now()))
const v2VerifiedAt = new Map<number, number>()
v2.torrent.on('verified', (i: number) => v2VerifiedAt.set(i, log.now()))

// piece-state snapshots at 20 Hz: consistency with the bitfield, monotonic 'verified'
const snap = { samples: 0, bitfieldMismatch: 0, leftVerified: 0, oneToZero: 0, timesUs: [] as number[] }
let prev: Uint8Array | null = null
const snapTimer = setInterval(() => {
  const t0 = performance.now()
  const s = pieceStates(v1.torrent)
  snap.timesUs.push((performance.now() - t0) * 1000)
  snap.samples++
  for (let i = 0; i < N; i++) {
    if ((s[i] === 2) !== v1.torrent.bitfield.get(i)) snap.bitfieldMismatch++
    if (prev && prev[i] === 2 && s[i] !== 2) snap.leftVerified++
    if (prev && prev[i] === 1 && s[i] === 0) snap.oneToZero++
  }
  prev = s
}, 50)

interface Ev {
  t: number
  kind: 'seek' | 'crit' | 'blocked'
  p: number
  urgent: Range[]
  expectFirst: number
  note?: string
}
const events: Ev[] = []

function plan(sched: Scheduler, p: number, hot: Range | null): void {
  sched.replan({ p, w, hot })
}

function seek(frac: number, withHot: boolean): void {
  const p = Math.floor(frac * N)
  const hot: Range | null = withHot ? [p, Math.min(p + hotLen - 1, N - 1)] : null
  plan(s1, p, hot)
  if (args['peer-plan'] === 'same') plan(s2, p, hot)
  const urgent = [...s1.blocked, ...(hot ? [hot] : []), ...s1.critRanges]
  events.push({
    t: log.mark(`seek ${frac * 100}%`),
    kind: 'seek',
    p,
    urgent,
    expectFirst: firstMissing(urgent.length ? urgent[0]![0] : p),
  })
}

function firstMissing(from: number): number {
  for (let i = from; i < N; i++) if (!v1.torrent.bitfield.get(i)) return i
  return -1
}

let churn: NodeJS.Timeout | undefined
if (args.churn) {
  churn = setInterval(() => {
    if (s1.last) s1.replan(s1.last)
    if (s2.last) s2.replan(s2.last)
  }, 100)
}

// Timeline -------------------------------------------------------------------------------------
seek(0, false) // planned at 'ready', before any wire exists (as the app would)
if (args['peer-plan'] !== 'same') plan(s2, 0, null)
const links = [await link(host, v1, DELAY), await link(host, v2, DELAY), await link(v1, v2, DELAY)]
log.mark('linked')

await sleep(4000)
seek(0.4, true)

await sleep(6000)
// a 16-piece critical range (4 MiB of Cues near the end), then a blocked reader far away
const cues: Range = [960, 975]
s1.critRanges = [cues]
plan(s1, s1.last!.p, s1.last!.hot ?? null)
events.push({
  t: log.mark('crit cues'),
  kind: 'crit',
  p: s1.last!.p,
  urgent: [cues],
  expectFirst: firstMissing(cues[0]),
})
await sleep(150)
const b = firstUnrequested(150)
const critPending = countPending(cues)
s1.blocked = [[b, b]]
plan(s1, s1.last!.p, s1.last!.hot ?? null)
events.push({
  t: log.mark('blocked', { b, critPending }),
  kind: 'blocked',
  p: s1.last!.p,
  urgent: [[b, b], cues],
  expectFirst: b,
  note: `cues pieces still unverified: ${critPending.unverified}, not fully requested: ${critPending.notFullyRequested}`,
})
await waitVerified(b, 10_000)
s1.blocked = []
plan(s1, s1.last!.p, s1.last!.hot ?? null)
log.mark('unblocked')

await sleep(Math.max(0, 16_000 - log.now()))
s1.critRanges = []
seek(0.9, false)

const done = await Promise.race([
  new Promise<boolean>((r) => v1.torrent.once('done', () => r(true))),
  sleep(100_000).then(() => false),
])
log.mark(done ? 'done' : 'timeout')
clearInterval(snapTimer)
if (churn) clearInterval(churn)
const endT = log.now()
const selectionsLeft = v1.torrent._selections.length

function firstUnrequested(from: number): number {
  const requested = new Set(log.reqs.map((r) => r.piece))
  for (let i = from; i < N; i++) if (!v1.torrent.bitfield.get(i) && !requested.has(i)) return i
  return -1
}
function countPending([a, z]: Range): { unverified: number; notFullyRequested: number } {
  let unverified = 0
  let notFullyRequested = 0
  for (let i = a; i <= z; i++) {
    if (v1.torrent.bitfield.get(i)) continue
    unverified++
    if (blocksRequested(i, Infinity) < blocksIn(i)) notFullyRequested++
  }
  return { unverified, notFullyRequested }
}
function waitVerified(i: number, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (v1.torrent.bitfield.get(i)) return resolve()
    const on = (j: number) => {
      if (j !== i) return
      v1.torrent.off('verified', on)
      resolve()
    }
    v1.torrent.on('verified', on)
    setTimeout(resolve, ms)
  })
}

// Analysis -------------------------------------------------------------------------------------
function blocksIn(i: number): number {
  const len = i === N - 1 ? v1.torrent.lastPieceLength : P
  return Math.ceil(len / 16384)
}
function blocksRequested(i: number, until: number): number {
  const offs = new Set<number>()
  for (const r of log.reqs) if (r.piece === i && r.t <= until && !r.choked) offs.add(r.offset)
  return offs.size
}
/** time at which every piece of [a, z] missing at `since` had all its blocks requested (Infinity if never) */
function fullyRequestedAt([a, z]: Range, since: number): number {
  let tmax = since
  for (let i = a; i <= z; i++) {
    const vt = verifiedAt.get(i)
    if (vt !== undefined && vt <= since) continue
    tmax = Math.max(tmax, fullAt(i))
  }
  return tmax
}
let fullAtCache: Map<number, number> | null = null
/** first time every block of piece i had been requested at least once (Infinity if never) */
function fullAt(i: number): number {
  if (!fullAtCache) {
    fullAtCache = new Map()
    const offs = new Map<number, Set<number>>()
    for (const r of log.reqs) {
      if (r.choked) continue
      const set = offs.get(r.piece) ?? new Set<number>()
      set.add(r.offset)
      offs.set(r.piece, set)
      if (set.size === blocksIn(r.piece) && !fullAtCache.has(r.piece)) fullAtCache.set(r.piece, r.t)
    }
  }
  return fullAtCache.get(i) ?? Infinity
}
const inRanges = (i: number, rs: Range[]) => rs.some(([a, z]) => i >= a && i <= z)

const results: Record<string, unknown>[] = []
for (let k = 0; k < events.length; k++) {
  const ev = events[k]!
  const next = events.slice(k + 1).find((e) => e.kind === 'seek' || e.kind === 'crit' || e.kind === 'blocked')
  const until = next ? next.t : endT
  const after = log.reqs.filter((r) => r.t > ev.t && r.t < until)
  const first = after[0]
  const firstNonUrgent = after.find((r) => !inRanges(r.piece, ev.urgent))
  const res: Record<string, unknown> = {
    event: log.marks.find((m) => m.t === ev.t)?.label,
    t: Math.round(ev.t),
    p: ev.p,
    urgent: ev.urgent,
    note: ev.note,
    expectFirst: ev.expectFirst,
    firstRequest: first ? `${first.piece} via ${first.peer} @+${(first.t - ev.t).toFixed(1)}ms` : null,
    firstPass: first?.piece === ev.expectFirst,
    hostFirstRequest: hostFirstAfter(after, ev.t),
    hostFirstPass: after.find((r) => r.peer === 'host')?.piece === ev.expectFirst,
  }
  if (ev.kind === 'seek') {
    const L1: Range = [ev.p, Math.min(ev.p + w, N - 1)]
    const L2: Range = [ev.p + w + 1, N - 1]
    const L3: Range = [0, ev.p - 1]
    const tL1 = fullyRequestedAt(L1, ev.t)
    const tUrg = ev.urgent.reduce((m, r) => Math.max(m, fullyRequestedAt(r, ev.t)), ev.t)
    const tWinRaw = Math.max(tL1, tUrg)
    const tWin = Math.min(tWinRaw, until)
    const outside = after.filter((r) => r.t <= tWin && !inRanges(r.piece, [...ev.urgent, L1]))
    const firstPlain = after.find((r) => !inRanges(r.piece, ev.urgent))
    res.firstNonUrgent = firstNonUrgent ? `${firstNonUrgent.piece} via ${firstNonUrgent.peer}` : null
    res.firstNonUrgentPass = firstPlain ? firstPlain.piece === firstMissingAt(L1, ev.t, ev.urgent) : null
    // the host has every piece, so its wire shows the plan order; v2's wire can only offer what v2 holds
    const hostAfter = after.filter((r) => r.peer === 'host')
    const hostFirstPlain = hostAfter.find((r) => !inRanges(r.piece, ev.urgent))
    res.hostFirst = hostAfter[0]?.piece ?? null
    res.hostFirstNonUrgent = hostFirstPlain?.piece ?? null
    res.hostFirstNonUrgentPass = hostFirstPlain ? hostFirstPlain.piece === firstMissingAt(L1, ev.t, ev.urgent) : null
    res.hostOutsideBeforeWindowFull = outside.filter((r) => r.peer === 'host').length
    res.windowFullyRequestedMs =
      tWinRaw <= until ? Math.round(tWinRaw - ev.t) : `not before next event (+${Math.round(until - ev.t)}ms)`
    res.outsideBeforeWindowFull = countBy(outside)
    res.outsideSample = summarize(outside)
    res.outsideWhilePeerHadWindowPiece = strictViolations(outside, [...ev.urgent, L1], ev.t)
    const viaHost = after.find((r) => r.peer === 'host')
    res.firstViaHost = viaHost ? `${viaHost.piece} @+${Math.round(viaHost.t - ev.t)}ms` : null
    if (L2[0] <= L2[1] && L3[0] <= L3[1]) {
      // L2 vs L3 holds until the next seek; crit/blocked events in between only add urgent ranges
      const nextSeek = events.slice(k + 1).find((e) => e.kind === 'seek')
      const untilSeek = nextSeek ? nextSeek.t : endT
      const laterUrgent = events.filter((e) => e.t > ev.t && e.t < untilSeek).flatMap((e) => e.urgent)
      const urg = [...ev.urgent, ...laterUrgent]
      const tL2Raw = fullyRequestedAt(L2, ev.t)
      const tL2 = Math.min(tL2Raw, untilSeek)
      const l3early = log.reqs.filter(
        (r) => r.t > ev.t && r.t < tL2 && inRanges(r.piece, [L3]) && !inRanges(r.piece, urg),
      )
      res.L2fullyRequestedMs =
        tL2Raw <= untilSeek ? Math.round(tL2Raw - ev.t) : `not before next seek (+${Math.round(untilSeek - ev.t)}ms)`
      res.L3beforeL2Full = countBy(l3early)
      res.L3whilePeerHadL2Piece = strictViolations(l3early, [L2], ev.t)
      res.L3beforeL2Sample = summarize(l3early)
      const firstL3 = log.reqs.find(
        (r) => r.t > ev.t && r.t < untilSeek && inRanges(r.piece, [L3]) && !inRanges(r.piece, urg),
      )
      res.firstL3 = firstL3 ? `${firstL3.piece} via ${firstL3.peer} @+${Math.round(firstL3.t - ev.t)}ms` : null
    }
  }
  results.push(res)
}
function hostFirstAfter(rs: Req[], t: number): string | null {
  const r = rs.find((x) => x.peer === 'host')
  return r ? `${r.piece} @+${(r.t - t).toFixed(1)}ms` : null
}
function countBy(rs: Req[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of rs) out[r.peer] = (out[r.peer] ?? 0) + 1
  return out
}
/**
 * A request on wire X for a piece outside `want` is a strict violation only if, at that moment, X's peer
 * had some piece of `want` that v1 still lacked and had not fully requested (the host has everything;
 * v2 has what it verified, with a 20 ms allowance for the 'have' to arrive).
 */
function strictViolations(rs: Req[], want: Range[], since: number): number {
  let bad = 0
  for (const r of rs) {
    const peerHas = (i: number) => r.peer === 'host' || (v2VerifiedAt.get(i) ?? Infinity) + 20 < r.t
    let avail = false
    for (const [a, z] of want) {
      for (let i = a; i <= z && !avail; i++) {
        const vt = verifiedAt.get(i)
        if (vt !== undefined && vt <= r.t) continue
        if (!peerHas(i)) continue
        if (fullAt(i) > r.t) avail = true
      }
    }
    if (avail) bad++
  }
  void since
  return bad
}
/** first piece of [a, z] that v1 lacked at time t and that is not in `skip` (the urgent ranges) */
function firstMissingAt([a, z]: Range, t: number, skip: Range[] = []): number {
  for (let i = a; i <= z; i++) {
    if (inRanges(i, skip)) continue
    const vt = verifiedAt.get(i)
    if (vt === undefined || vt > t) return i
  }
  return -1
}
function summarize(rs: Req[]): string {
  const byPeer = new Map<string, number[]>()
  for (const r of rs) {
    const l = byPeer.get(r.peer) ?? []
    if (!l.includes(r.piece)) l.push(r.piece)
    byPeer.set(r.peer, l)
  }
  return [...byPeer]
    .map(([p, l]) => `${p}: [${l.slice(0, 12).join(',')}${l.length > 12 ? ',…' : ''}] (${l.length} pieces)`)
    .join('; ')
}

// first requests per wire: validateWire() picks the last selection's highest piece on a fresh wire
const firstPerPeer: Record<string, string> = {}
for (const r of log.reqs) if (!(r.peer in firstPerPeer)) firstPerPeer[r.peer] = `${r.piece}@${Math.round(r.t)}ms`

const counts = new Map<string, number>()
for (const r of log.reqs)
  if (!r.choked) counts.set(`${r.piece}:${r.offset}`, (counts.get(`${r.piece}:${r.offset}`) ?? 0) + 1)
const dupBlocks = [...counts.values()].filter((c) => c > 1).length
const sortedSnap = [...snap.timesUs].sort((a, b) => a - b)

const summary = {
  config: {
    patchedWebTorrent: PATCHED_WT,
    SIZE_MIB,
    P,
    N,
    w,
    hotLen,
    HOST_RATE,
    DELAY,
    churn: args.churn,
    peerPlan: args['peer-plan'],
    sentinel: args.sentinel,
    batched: args.batched,
  },
  done,
  durationS: +(endT / 1000).toFixed(1),
  replans: s1.replans,
  requests: log.reqs.length,
  chokedRequests: log.reqs.filter((r) => r.choked).length,
  requestsDuringReplan: log.reqs.filter((r) => r.inReplan).length,
  duplicateBlocks: dupBlocks,
  hotswaps: log.hotswaps.length,
  selectionsLeftAtEnd: selectionsLeft,
  firstRequestPerPeer: firstPerPeer,
  pieceStates: {
    samples: snap.samples,
    bitfieldMismatch: snap.bitfieldMismatch,
    leftVerified: snap.leftVerified,
    oneToZero: snap.oneToZero,
    medianUs: +sortedSnap[Math.floor(sortedSnap.length / 2)]!.toFixed(1),
  },
  events: results,
}
console.log(JSON.stringify(summary, null, 2))
writeFileSync(
  join(DATA_DIR, `${args.out}.json`),
  JSON.stringify({ summary, reqs: log.reqs, marks: log.marks }, null, 0),
)
await teardown(nodes, links)
process.exit(0)
