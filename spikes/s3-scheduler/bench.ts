// Part A.3 (coinciding bounds, selection invariants) and A.5 (piece-state cost) without any network.
// A synthetic 15,000-piece torrent (fake hashes, never verified) is added to a viewer client.
//   npx tsx spikes/s3-scheduler/bench.ts
import bencode from 'bencode'
import WebTorrent, { type Torrent } from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'
import Piece from 'torrent-piece'
import { WEBTORRENT_OPTIONS } from '../../src/core/transfer/client-options.js'
import { pieceStates } from './lib/piece-states.js'
import { type Range, Scheduler } from './lib/scheduler.js'
import { deadman } from './lib/net.js'

deadman(110_000)
const MiB = 1024 * 1024

function syntheticTorrent(n: number, pieceLength: number): Buffer {
  const info = {
    name: 'synthetic.bin',
    'piece length': pieceLength,
    length: n * pieceLength,
    pieces: Buffer.alloc(n * 20, 7),
    private: 1,
  }
  return Buffer.from(bencode.encode({ info }))
}

async function addViewer(client: WebTorrent, n: number): Promise<Torrent> {
  const t = client.add(syntheticTorrent(n, MiB), { store: MemoryChunkStore, deselect: true } as never)
  await new Promise<void>((r) => (t.ready ? r() : t.once('ready', () => r())))
  return t
}

/** Fake wires: enough for _updateWireInterest / pieceStates to do their real per-wire work. */
function fakeWires(t: Torrent, count: number, reqsPerWire: number, has = (i: number) => i % 3 === 0): void {
  const n = t.pieces.length
  for (let k = 0; k < count; k++) {
    const requests = Array.from({ length: reqsPerWire }, (_, j) => ({
      piece: (k * 97 + j * 13) % n,
      offset: 0,
      length: 16384,
    }))
    ;(t.wires as unknown[]).push({
      destroyed: true, // _updateWire() returns at once; _updateWireInterest() still scans every piece
      requests,
      peerPieces: { get: has },
      interested() {},
      uninterested() {},
    })
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const flush = () => new Promise((r) => setImmediate(r)) // lets the _gcSelections microtask run

const client = new WebTorrent(WEBTORRENT_OPTIONS)
const out: Record<string, unknown> = {}

// --- A.5 piece-state snapshot cost, 15k pieces ------------------------------------------------
{
  const N = 15_000
  const t = await addViewer(client, N)
  for (let i = 0; i < N; i += 2) t._markVerified(i) // half verified
  for (let i = 1; i < N; i += 10) (t.pieces[i] as InstanceType<typeof Piece>).missing -= 16384 // some partial
  fakeWires(t, 32, 64)
  const buf = new Uint8Array(N)
  for (let i = 0; i < 200; i++) pieceStates(t, buf) // warm-up
  const times: number[] = []
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now()
    pieceStates(t, buf)
    times.push((performance.now() - t0) * 1000)
  }
  const counts = [0, 0, 0]
  for (const s of buf) counts[s]!++
  out.pieceStates15k = {
    medianUs: +median(times).toFixed(1),
    p99Us: +[...times].sort((a, b) => a - b)[1980]!.toFixed(1),
    counts,
  }

  // replan cost on the same torrent: each _select/_deselect/critical runs _updateInterest over every
  // wire x piece (torrent.js:1516-1576), so the cost scales with wires x N
  for (const batched of [false, true]) {
    const s = new Scheduler(t, false, batched)
    for (const wires of [0, 8, 32]) {
      ;(t.wires as unknown[]).length = 0
      fakeWires(t, wires, 8, () => false) // worst case: _updateWireInterest scans all N pieces per wire
      s.critRanges = [
        [0, 3],
        [N - 2, N - 1],
      ]
      const rt: number[] = []
      for (let i = 0; i < 50; i++) {
        const t0 = performance.now()
        s.replan({ p: 1000 + i, w: 25, hot: [1000 + i, 1008 + i] })
        rt.push(performance.now() - t0)
        await flush()
      }
      out[`replan15k_${batched ? 'batched' : 'plan'}_${wires}wires_ms`] = +median(rt).toFixed(2)
    }
  }
  ;(t.wires as unknown[]).length = 0
  t.destroy()
}

// --- A.3 selection invariants under random plans, incl. coinciding bounds -------------------------
{
  const N = 1024
  for (const batched of [false, true]) {
    const t = await addViewer(client, N)
    const s = new Scheduler(t, false, batched)
    const rnd = (k: number) => Math.floor(Math.random() * k)
    let checks = 0
    const failures: string[] = []
    const cases: { name: string; p: number; w: number; blocked: Range[]; hot: Range | null; crit: Range[] }[] = [
      { name: 'p=2, urgent [0,1] (= L3)', p: 2, w: 96, blocked: [], hot: null, crit: [[0, 1]] },
      { name: 'hot = L1 bounds', p: 100, w: 96, blocked: [], hot: [100, 196], crit: [] },
      { name: 'blocked = p', p: 50, w: 96, blocked: [[50, 50]], hot: null, crit: [] },
      { name: 'p = 0 (no L3)', p: 0, w: 96, blocked: [], hot: null, crit: [] },
      { name: 'p = N-1 (L1 one piece, no L2)', p: N - 1, w: 96, blocked: [], hot: null, crit: [] },
      { name: 'p+w = N-1 exactly (no L2)', p: N - 97, w: 96, blocked: [], hot: null, crit: [] },
      { name: 'p+w+1 = N-1 (L2 one piece)', p: N - 98, w: 96, blocked: [], hot: null, crit: [] },
      {
        name: 'two identical crit ranges',
        p: 10,
        w: 96,
        blocked: [],
        hot: null,
        crit: [
          [500, 515],
          [500, 515],
        ],
      },
    ]
    for (let k = 0; k < 3000; k++) {
      let c = cases[k % cases.length]!
      if (k >= cases.length * 50) {
        const p = rnd(N)
        const w = 1 + rnd(200)
        const b = rnd(N)
        c = {
          name: 'random',
          p,
          w,
          blocked: rnd(3) ? [] : [[b, b]],
          hot: rnd(2) ? [p, Math.min(N - 1, p + rnd(40))] : null,
          crit: rnd(2) ? [] : [[rnd(N - 16), 0]].map(([a]) => [a!, a! + 15] as Range),
        }
      }
      if (rnd(4) === 0) t._markVerified(rnd(N)) // pieces complete underneath the plan (gc runs)
      s.blocked = c.blocked
      s.critRanges = c.crit
      try {
        s.replan({ p: c.p, w: c.w, hot: c.hot })
      } catch (err) {
        failures.push(`${c.name}: threw ${(err as Error).message}`)
        continue
      }
      await flush()
      checks++
      const done = (x: { from: number; to: number }) => {
        for (let i = x.from; i <= x.to; i++) if (!t.bitfield.get(i)) return false
        return true
      }
      const want = s.live.filter((x) => !done(x)).map((x) => `${x.from}-${x.to}`)
      const have: string[] = []
      for (let i = 0; i < t._selections.length; i++) {
        const x = t._selections.get(i) as unknown as {
          from: number
          to: number
          priority: number
          isStreamSelection: boolean
        }
        if (!x.isStreamSelection || x.priority !== 0) failures.push(`${c.name}: foreign selection ${x.from}-${x.to}`)
        have.push(`${x.from}-${x.to}`)
      }
      if (want.join() !== have.join())
        failures.push(`${c.name} p=${c.p}: selections [${have.join(' ')}] != plan [${want.join(' ')}]`)
      const urgent = [...c.blocked, ...(c.hot ? [c.hot] : []), ...c.crit]
      for (let i = 0; i < N; i++) {
        const crit = urgent.some(([a, z]) => i >= a && i <= Math.min(z, N - 1))
        if (!!t._critical[i] !== crit) {
          failures.push(`${c.name}: _critical[${i}] = ${t._critical[i]} but urgent=${crit}`)
          break
        }
      }
    }
    out[`invariants_${batched ? 'batched' : 'plan'}`] = {
      replans: checks,
      failures: failures.length,
      sample: failures.slice(0, 5),
    }
    t.destroy()
  }
}

console.log(JSON.stringify(out, null, 2))
await new Promise((r) => client.destroy(r))
process.exit(0)
