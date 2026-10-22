// Part A.3, coinciding bounds on a live transfer: p = 2 with an urgent [0, 1] (so L3 = [0, 1] too),
// re-planned at 10 Hz, then p = N-1 (no L2) and p = N-w-1 (L1 reaches N-1). Host + one viewer.
//   npx tsx spikes/s3-scheduler/part-a-bounds.ts [--sentinel] [--batched]
import { parseArgs } from 'node:util'
import { deadman, fixture, link, makeHost, makeViewer, PATCHED_WT, peerNamer, sleep, teardown } from './lib/net.js'
import { RequestLog } from './lib/request-log.js'
import { Scheduler, windowPieces } from './lib/scheduler.js'

const { values: args } = parseArgs({
  options: { sentinel: { type: 'boolean', default: false }, batched: { type: 'boolean', default: false } },
})
deadman(60_000)
const P = 256 * 1024
const { torrentFile } = await fixture(256, P)
const host = await makeHost(torrentFile, 4_000_000)
let log!: RequestLog
let s!: Scheduler
const v1 = await makeViewer('v1', torrentFile, (t) => {
  log = new RequestLog(
    t,
    (w) => name(w),
    () => s?.inReplan ?? false,
  )
})
const name = peerNamer([host, v1])
s = new Scheduler(v1.torrent, args.sentinel, args.batched)
const N = v1.torrent.pieces.length
const w = windowPieces(1_000_000, P)

const selCount: number[] = []
const errors: string[] = []
function tick(): void {
  try {
    s.replan(s.last!)
  } catch (err) {
    errors.push((err as Error).message)
  }
  selCount.push(v1.torrent._selections.length)
}

s.critRanges = [[0, 1]]
s.replan({ p: 2, w })
const liveAtStart = s.live.map((x) => `${x.from}-${x.to}`)
const links = [await link(host, v1)]
const hz = setInterval(tick, 100)
await sleep(3000)
const phase1 = log.reqs.slice()
const firstOf2plus = phase1.findIndex((r) => r.piece >= 2)
const lastOf01 = phase1.reduce((m, r, i) => (r.piece <= 1 ? i : m), -1)
const selsAfter01 = v1.torrent.bitfield.get(0) && v1.torrent.bitfield.get(1) ? v1.torrent._selections.length : -1

s.critRanges = []
log.mark('p=N-1')
s.replan({ p: N - 1, w })
const liveEnd = s.live.map((x) => `${x.from}-${x.to}`)
const tEnd = log.now()
await sleep(1500)
const afterEnd = log.reqs.filter((r) => r.t > tEnd)
s.replan({ p: N - w - 1, w })
const liveEdge = s.live.map((x) => `${x.from}-${x.to}`)
const tEdge = log.now()
await sleep(1500)
const afterEdge = log.reqs.filter((r) => r.t > tEdge)
clearInterval(hz)

const counts = new Map<string, number>()
for (const r of log.reqs) counts.set(`${r.piece}:${r.offset}`, (counts.get(`${r.piece}:${r.offset}`) ?? 0) + 1)
console.log(
  JSON.stringify(
    {
      config: { patchedWebTorrent: PATCHED_WT, sentinel: args.sentinel, batched: args.batched, N, w },
      liveAtStart,
      firstRequests: phase1.slice(0, 6).map((r) => r.piece),
      allOf01BeforeAny2plus: lastOf01 < firstOf2plus || firstOf2plus === -1,
      requestsOf01BeforeFirst2plus: phase1.slice(0, Math.max(0, firstOf2plus)).filter((r) => r.piece <= 1).length,
      nonUrgentBefore01Done: phase1
        .slice(0, lastOf01 + 1)
        .filter((r) => r.piece > 1)
        .map((r) => r.piece),
      selectionsAfter01Verified: selsAfter01,
      selectionCountRange: [Math.min(...selCount), Math.max(...selCount)],
      replans: s.replans,
      replanErrors: errors,
      pEqualsNminus1: { live: liveEnd, firstRequests: afterEnd.slice(0, 4).map((r) => r.piece) },
      L1reachesEnd: { live: liveEdge, firstRequests: afterEdge.slice(0, 4).map((r) => r.piece) },
      requestsDuringReplan: log.reqs.filter((r) => r.inReplan).length,
      duplicateBlocks: [...counts.values()].filter((c) => c > 1).length,
    },
    null,
    2,
  ),
)
await teardown([host, v1], links)
process.exit(0)
