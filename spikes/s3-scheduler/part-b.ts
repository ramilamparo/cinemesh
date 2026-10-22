// Part B: fan-out with and without host-assigned striping. 1 host (uploadLimit) + V viewers in a mesh,
// all following one shared playhead that advances at the bitrate from piece 0.
//   npx tsx spikes/s3-scheduler/part-b.ts --mode baseline|stripe [--drop v3-v4] [--R auto|4]
//     [--deadline 8] [--deadline-mode rescue|everyone] [--rescue-after 3000]
//     [--eligibility full|connected] [--tick 250] [--delay 0] [--duration 60] [--host-rate 5] [--bitrate 2]
//     [--viewer-up 0] [--viewers 4] [--size 512] [--out name]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  DATA_DIR,
  deadman,
  fixture,
  type Link,
  link,
  makeHost,
  makeViewer,
  MiB,
  type Node,
  peerNamer,
  sleep,
  teardown,
} from './lib/net.js'
import { Revealer, type Range } from './lib/revealer.js'
import { planOrder, planRanges, Scheduler, windowPieces } from './lib/scheduler.js'

const { values: args } = parseArgs({
  options: {
    mode: { type: 'string', default: 'stripe' },
    drop: { type: 'string', default: '' },
    R: { type: 'string', default: 'auto' },
    deadline: { type: 'string', default: '8' },
    'deadline-mode': { type: 'string', default: 'rescue' },
    'rescue-after': { type: 'string', default: '3000' },
    eligibility: { type: 'string', default: 'full' },
    tick: { type: 'string', default: '250' },
    delay: { type: 'string', default: '0' },
    duration: { type: 'string', default: '60' },
    'host-rate': { type: 'string', default: '5' },
    bitrate: { type: 'string', default: '2' },
    'viewer-up': { type: 'string', default: '0' },
    viewers: { type: 'string', default: '4' },
    size: { type: 'string', default: '512' },
    preroll: { type: 'string', default: '3' },
    out: { type: 'string', default: '' },
  },
})
const P = MiB
const HOST_RATE = Number(args['host-rate']) * 1_000_000
const BITRATE = Number(args.bitrate) * 1_000_000
const VIEWER_UP = Number(args['viewer-up']) * 1_000_000 || -1
const DURATION = Number(args.duration)
const PREROLL = Number(args.preroll)
const DELAY = Number(args.delay)
const striping = args.mode === 'stripe'
deadman((DURATION + PREROLL + 45) * 1000)

const { torrentFile } = await fixture(Number(args.size), P)
const host = await makeHost(torrentFile, HOST_RATE)
const viewers: Node[] = []
for (let k = 1; k <= Number(args.viewers); k++)
  viewers.push(await makeViewer(`v${k}`, torrentFile, undefined, VIEWER_UP))
const nodes = [host, ...viewers]
const name = peerNamer(nodes)
const N = host.torrent.pieces.length
const w = windowPieces(BITRATE, P)
const openCritical: Range[] = [
  [0, 1],
  [N - 1, N - 1],
] // head + tail index, as an MKV open would need

// shared playhead ---------------------------------------------------------------------------
const T0 = performance.now()
let tStart = Infinity // set once the mesh is up
const now = () => performance.now() - T0
const playheadByte = () => Math.max(0, ((now() - tStart) / 1000) * BITRATE)
const playheadPiece = () => Math.min(N - 1, Math.floor(playheadByte() / P))
const deadline = (i: number) => {
  const p = playheadPiece()
  if (i < p) return Infinity
  return (i * P - playheadByte()) / BITRATE + Math.max(0, (tStart - now()) / 1000)
}

const dropped = new Set(args.drop ? [args.drop, args.drop.split('-').reverse().join('-')] : [])
const linked = (a: string, b: string) => !dropped.has(`${a}-${b}`)

const revealer = new Revealer(host.torrent, {
  striping,
  pieceLength: P,
  bitrate: BITRATE,
  deadlineS: Number(args.deadline),
  deadlineMode: args['deadline-mode'] as 'everyone' | 'rescue' | 'none',
  rescueAfterMs: Number(args['rescue-after']),
  clock: now,
  eligibility: args.eligibility === 'connected' ? 'connected' : 'full',
  tickMs: Number(args.tick),
  R: args.R === 'auto' ? 'auto' : Number(args.R),
  hostRate: HOST_RATE,
  openCritical,
  plan: () => planOrder(planRanges(playheadPiece(), w, N, openCritical)),
  playheadPiece,
  deadline,
  viewerOf: (wire) => name(wire as never),
  linked,
})

// viewers: the plan's scheduler on the shared playhead -----------------------------------------
const scheds = viewers.map((v) => new Scheduler(v.torrent))
const verifiedAt = viewers.map(() => new Map<number, number>())
viewers.forEach((v, k) => v.torrent.on('verified', (i: number) => verifiedAt[k]!.set(i, now())))
// when each viewer receives the host's 'have' (to split reveal->request into network and queueing)
const haveAt = new Map<string, number>()
viewers.forEach((v) =>
  v.torrent.on('wire', (wire: { peerId: string; on: (e: string, f: (i: number) => void) => void }) => {
    if (name(wire) !== 'host') return
    wire.on('have', (i) => haveAt.set(`${v.name}:${i}`, now()))
  }),
)
for (const s of scheds) {
  s.critRanges = openCritical
  s.replan({ p: 0, w })
}
let plannedP = 0
const replanTimer = setInterval(() => {
  const p = playheadPiece()
  if (p - plannedP < Math.max(1, Math.floor(w / 4))) return
  plannedP = p
  for (const s of scheds) s.replan({ p, w })
}, 100)

const links: Link[] = []
for (const v of viewers) links.push(await link(host, v, DELAY))
for (let a = 0; a < viewers.length; a++) {
  for (let b = a + 1; b < viewers.length; b++) {
    if (linked(viewers[a]!.name, viewers[b]!.name)) links.push(await link(viewers[a]!, viewers[b]!, DELAY))
  }
}
revealer.start()
tStart = now() + PREROLL * 1000

// stalls: a piece not verified when the playhead reaches its first byte ------------------------
const nextNeeded = viewers.map(() => 0)
const stalls: { viewer: string; piece: number; t: number }[] = []
const stallTimer = setInterval(() => {
  const ph = playheadByte()
  viewers.forEach((v, k) => {
    while (nextNeeded[k]! < N && nextNeeded[k]! * P <= ph && now() >= tStart) {
      const i = nextNeeded[k]!
      if (!v.torrent.bitfield.get(i)) stalls.push({ viewer: v.name, piece: i, t: now() })
      nextNeeded[k]!++
    }
  })
}, 20)

await sleep(PREROLL * 1000 + DURATION * 1000)
clearInterval(stallTimer)
clearInterval(replanTimer)
revealer.stop()
const tEnd = now()

// results -------------------------------------------------------------------------------------
const dup = revealer.dupFactor()
const dupSteady = revealer.dupFactor(tStart + 10_000)
const lateness = stalls.map((s) => {
  const k = viewers.findIndex((v) => v.name === s.viewer)
  const vt = verifiedAt[k]!.get(s.piece)
  return vt === undefined ? Infinity : vt - s.t
})
const lat = revealer.revealToRequestMs().sort((a, b) => a - b)
const haveLat: number[] = []
for (const [k, t] of revealer.revealedAt) {
  const h = haveAt.get(k)
  if (h !== undefined) haveLat.push(h - t)
}
haveLat.sort((a, b) => a - b)
const q = (xs: number[], f: number) =>
  xs.length ? +xs[Math.min(xs.length - 1, Math.floor(f * xs.length))]!.toFixed(1) : null
const contiguous = (k: number) => {
  let i = 0
  while (i < N && viewers[k]!.torrent.bitfield.get(i)) i++
  return i
}
const summary = {
  config: {
    mode: args.mode,
    deadlineMode: args['deadline-mode'],
    rescueAfter: Number(args['rescue-after']),
    eligibility: args.eligibility,
    drop: args.drop || null,
    R: args.R,
    deadlineS: Number(args.deadline),
    tickMs: Number(args.tick),
    DELAY,
    HOST_RATE,
    BITRATE,
    VIEWER_UP,
    viewers: viewers.length,
    N,
    w,
    DURATION,
  },
  playheadEndPiece: playheadPiece(),
  host: {
    servedMB: +(dup.total / 1e6).toFixed(1),
    distinctMB: +(dup.distinct / 1e6).toFixed(1),
    dupFactor: +dup.dupFactor.toFixed(3),
    dupFactorAfter10s: +dupSteady.dupFactor.toFixed(3),
    avgRateMBs: +(dup.total / 1e6 / (tEnd / 1000)).toFixed(2),
    servedUnrevealedBlocks: dup.unrevealed,
  },
  stalls: {
    count: stalls.length,
    perViewer: Object.fromEntries(viewers.map((v) => [v.name, stalls.filter((s) => s.viewer === v.name).length])),
    firstAtPlayheadS: stalls.length ? +((stalls[0]!.t - tStart) / 1000).toFixed(1) : null,
    maxLateMs: lateness.length ? Math.round(Math.max(...lateness)) : 0,
    sample: stalls.slice(0, 8).map((s) => `${s.viewer}:${s.piece}`),
  },
  viewers: viewers.map((v, k) => ({
    name: v.name,
    verified: v.torrent.pieces.filter((x) => x === null).length,
    contiguousFrom0: contiguous(k),
    downMB: +(v.torrent.downloaded / 1e6).toFixed(1),
    upMB: +(v.torrent.uploaded / 1e6).toFixed(1),
  })),
  revealer: striping
    ? {
        ...revealer.stats,
        revealToRequestMs: { n: lat.length, p50: q(lat, 0.5), p95: q(lat, 0.95), max: q(lat, 1) },
        revealToHaveReceivedMs: { n: haveLat.length, p50: q(haveLat, 0.5), p95: q(haveLat, 0.95), max: q(haveLat, 1) },
      }
    : null,
}
console.log(JSON.stringify(summary, null, 2))
if (args.out) writeFileSync(join(DATA_DIR, `${args.out}.json`), JSON.stringify(summary))
await teardown(nodes, links)
process.exit(0)
