import bencode from 'bencode'
import WebTorrent, { type Torrent } from 'webtorrent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WEBTORRENT_OPTIONS } from './client-options.js'
import { type ByteRange, type PieceRange, Scheduler, mergeSpans, toPieceSpans } from './scheduler.js'

// The scheduler against a real WebTorrent torrent (ADR 0003 bench.ts): after every re-plan, the torrent's
// _selections must be exactly our plan (minus what WebTorrent garbage-collected as done), in order, all
// priority-0 stream selections, and _critical must flag exactly the urgent pieces. No wires, no network.

const P = 64 * 1024
const N = 1024

/** Never read: there are no wires, and the all-zero startup bitfield skips verification. */
class NullStore {
  constructor(readonly chunkLength: number) {}
  get(_i: number, opts: unknown, cb?: (err: Error) => void): void {
    const done = typeof opts === 'function' ? (opts as (err: Error) => void) : cb
    queueMicrotask(() => done?.(new Error('no data')))
  }
  put(_i: number, _b: Buffer, cb: (err: Error | null) => void): void {
    queueMicrotask(() => cb(null))
  }
  close(cb?: (err: Error | null) => void): void {
    queueMicrotask(() => cb?.(null))
  }
  destroy(cb?: (err: Error | null) => void): void {
    queueMicrotask(() => cb?.(null))
  }
}

function syntheticTorrent(): Buffer {
  const info = { name: 'synthetic.bin', 'piece length': P, length: N * P, pieces: Buffer.alloc(N * 20, 7), private: 1 }
  return Buffer.from(bencode.encode({ info }))
}

let client: WebTorrent
let t: Torrent
beforeAll(async () => {
  client = new WebTorrent(WEBTORRENT_OPTIONS)
  t = client.add(syntheticTorrent(), {
    store: NullStore,
    bitfield: new Uint8Array(N / 8),
    deselect: true,
    strategy: 'sequential',
  })
  await new Promise<void>((resolve) => (t.ready ? resolve() : t.once('ready', () => resolve())))
})
afterAll(() => new Promise<void>((resolve) => client.destroy(() => resolve())))

const flush = (): Promise<void> => new Promise((r) => setImmediate(r)) // lets the _gcSelections microtask run
const markVerified = (i: number): void => (t as unknown as { _markVerified(i: number): void })._markVerified(i)

interface Inputs {
  p: number
  w: number
  /** null: no seek happened yet */
  hot: PieceRange | null
  blocked: number[]
  critical: ByteRange[]
  /** the playhead plan's urgent ranges (audio intervals): group 3 with the critical ranges */
  audio?: ByteRange[]
}

/** The plan written out independently: group 3 by marking pieces and reading runs, not by sorting spans. */
function expectedPlan(x: Inputs): { plan: { from: number; to: number }[]; urgent: Set<number> } {
  const clampPiece = (i: number): number => Math.min(N - 1, Math.max(0, i))
  const marked = new Uint8Array(N)
  for (const [a, b] of [...x.critical, ...(x.audio ?? [])])
    if (b > a) marked.fill(1, clampPiece(Math.floor(a / P)), clampPiece(Math.floor((b - 1) / P)) + 1)
  const runs: [number, number][] = []
  for (let i = 0; i < N; i++) {
    if (!marked[i]) continue
    let j = i
    while (j + 1 < N && marked[j + 1]) j++
    runs.push([i, j])
    i = j
  }
  const urgent: [number, number][] = [
    ...x.blocked.map((i): [number, number] => [i, i]),
    ...(x.hot ? [[...x.hot] as [number, number]] : []),
    ...runs,
  ]
  const all = [...urgent, [x.p, x.p + x.w], [x.p + x.w + 1, N - 1], [0, x.p - 1]]
    .map(([a, b]) => [Math.max(0, a ?? 0), Math.min(b ?? 0, N - 1)] as const)
    .filter(([a, b]) => a <= b)
  const flagged = new Set<number>()
  for (const [a, b] of urgent) for (let i = Math.max(0, a); i <= Math.min(b, N - 1); i++) flagged.add(i)
  return { plan: all.map(([from, to]) => ({ from, to })), urgent: flagged }
}

/** Drives the scheduler through its public API; with `hot` null it plans without a seek (a fresh scheduler). */
function apply(x: Inputs, previous: Scheduler | null): Scheduler {
  const s = x.hot === null ? new Scheduler(t) : (previous ?? new Scheduler(t))
  if (s !== previous) previous?.destroy()
  for (let k = 0; k < 4; k++) s.dropBlocked(`r${String(k)}`)
  s.setCriticalRanges(x.critical)
  x.blocked.forEach((i, k) => s.addBlocked(`r${String(k)}`, i))
  const hotBytes = x.hot ? (x.hot[1] - x.p + 1) * P : 0
  s.setPlayhead({ byte: x.p * P, windowBytes: x.w * P, hotBytes, seek: x.hot !== null, urgent: x.audio ?? [] })
  if (x.hot === null) (s as unknown as { replan(): void }).replan() // a non-seek plan is debounced
  return s
}

async function check(s: Scheduler, x: Inputs, label: string): Promise<void> {
  await flush()
  const { plan, urgent } = expectedPlan(x)
  expect(s.plan(), label).toEqual(plan)
  const done = (r: { from: number; to: number }): boolean => {
    for (let i = r.from; i <= r.to; i++) if (!t.bitfield.get(i)) return false
    return true
  }
  const have: string[] = []
  for (let i = 0; i < t._selections.length; i++) {
    const sel = t._selections.get(i)
    expect(sel.priority === 0 && sel.isStreamSelection === true, `${label}: foreign selection`).toBe(true)
    have.push(`${String(sel.from)}-${String(sel.to)}`)
  }
  expect(have, label).toEqual(plan.filter((r) => !done(r)).map((r) => `${String(r.from)}-${String(r.to)}`))
  for (let i = 0; i < N; i++) {
    if (!!t._critical[i] !== urgent.has(i))
      expect.fail(`${label}: _critical[${String(i)}] should be ${String(urgent.has(i))}`)
  }
}

const bytes = (from: number, to: number): ByteRange => [from * P, (to + 1) * P] // whole pieces [from, to]

describe('toPieceSpans / mergeSpans', () => {
  it('sorts and merges overlapping, nested, identical and adjacent spans, keeping gaps', () => {
    expect(
      mergeSpans([
        [9, 12],
        [0, 1],
        [2, 3],
        [10, 11],
        [9, 12],
        [20, 20],
        [5, 6],
      ]),
    ).toEqual([
      [0, 3],
      [5, 6],
      [9, 12],
      [20, 20],
    ])
    expect(mergeSpans([])).toEqual([])
  })

  it('maps byte ranges [start, end) to the pieces they touch, clamped, dropping empty ones', () => {
    expect(toPieceSpans([[P - 1, P + 1]], P, N)).toEqual([[0, 1]])
    expect(toPieceSpans([[P, 2 * P]], P, N)).toEqual([[1, 1]]) // end is exclusive
    expect(
      toPieceSpans(
        [
          [5, 5],
          [9, 3],
          [Number.NaN, 7],
        ],
        P,
        N,
      ),
    ).toEqual([])
    expect(
      toPieceSpans(
        [
          [-100, 10],
          [N * P + 5, N * P + 9],
        ],
        P,
        N,
      ),
    ).toEqual([
      [0, 0],
      [N - 1, N - 1],
    ])
  })
})

describe('Scheduler against WebTorrent selections', () => {
  it('turns thousands of tiny ranges inside 13 pieces into one selection (sidx-heavy manifests)', async () => {
    const ranges: ByteRange[] = []
    for (let k = 0; k < 5000; k++) {
      const start = 10 * P + Math.floor((k / 5000) * 13 * P)
      ranges.push([start, start + 100])
    }
    expect(toPieceSpans(ranges, P, N)).toEqual([[10, 22]])
    const s = new Scheduler(t)
    s.setCriticalRanges(ranges)
    s.setPlayhead({ byte: 500 * P, windowBytes: 40 * P, hotBytes: 4 * P, seek: true })
    await flush()
    expect(s.plan()).toEqual([
      { from: 500, to: 503 },
      { from: 10, to: 22 },
      { from: 500, to: 540 },
      { from: 541, to: N - 1 },
      { from: 0, to: 499 },
    ])
    expect(t._selections.length).toBe(5)
    // the worst case for spans: every other piece; still never more selections than pieces
    s.setCriticalRanges(Array.from({ length: N / 2 }, (_, k) => bytes(2 * k, 2 * k)))
    s.setPlayhead({ byte: 3 * P, windowBytes: 40 * P, hotBytes: P, seek: true })
    expect(s.plan().length).toBeLessThanOrEqual(N)
    s.destroy()
  })

  it('keeps coinciding bounds right (p = 2 with urgent [0, 1], p = N-1, L1 reaching N-1, ...)', async () => {
    const cases: (Inputs & { name: string })[] = [
      { name: 'p = 2, urgent [0, 1] = L3', p: 2, w: 96, hot: null, blocked: [], critical: [bytes(0, 1)] },
      { name: 'p = 2, urgent [0, 1], hot [2, 2]', p: 2, w: 96, hot: [2, 2], blocked: [], critical: [bytes(0, 1)] },
      { name: 'hot = L1 bounds', p: 100, w: 96, hot: [100, 196], blocked: [], critical: [] },
      { name: 'blocked = p', p: 50, w: 96, hot: null, blocked: [50], critical: [] },
      { name: 'p = 0 (no L3)', p: 0, w: 96, hot: [0, 3], blocked: [], critical: [] },
      { name: 'p = N-1 (L1 one piece, no L2)', p: N - 1, w: 96, hot: null, blocked: [], critical: [] },
      { name: 'p = N-1 with hot', p: N - 1, w: 96, hot: [N - 1, N - 1], blocked: [N - 1], critical: [] },
      { name: 'p+w = N-1 exactly (no L2)', p: N - 97, w: 96, hot: null, blocked: [], critical: [] },
      { name: 'p+w+1 = N-1 (L2 one piece)', p: N - 98, w: 96, hot: null, blocked: [], critical: [] },
      { name: 'L1 reaching past N-1', p: N - 50, w: 96, hot: [N - 50, N - 1], blocked: [], critical: [] },
      {
        name: 'two identical critical ranges',
        p: 10,
        w: 96,
        hot: null,
        blocked: [],
        critical: [bytes(500, 515), bytes(500, 515)],
      },
      {
        name: 'critical touching L1 and the tail',
        p: 10,
        w: 20,
        hot: [10, 12],
        blocked: [3, 3],
        critical: [bytes(30, 31), bytes(N - 2, N - 1), bytes(32, 40)],
      },
      {
        name: 'audio intervals overlapping and next to critical ranges (one group 3)',
        p: 200,
        w: 20,
        hot: [200, 203],
        blocked: [],
        critical: [bytes(205, 206), bytes(0, 1)],
        audio: [bytes(207, 207), bytes(206, 210), [201 * P + 5, 201 * P + 9]],
      },
    ]
    let s: Scheduler | null = null
    for (const c of cases) {
      s = apply(c, s)
      await check(s, c, c.name)
    }
    s?.destroy()
  })

  it('matches the plan after 3000 random re-plans with pieces completing underneath', async () => {
    let seed = 42 // mulberry32: reproducible, and uniform in every bit
    const rnd = (k: number): number => {
      seed = (seed + 0x6d2b79f5) | 0
      let z = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z
      return Math.floor((((z ^ (z >>> 14)) >>> 0) / 2 ** 32) * k)
    }
    const seen = { hotNull: 0, blocked: 0, critical: 0, overlapping: 0, audio: 0 }
    let s: Scheduler | null = null
    for (let k = 0; k < 3000; k++) {
      const p = rnd(N)
      const w = 1 + rnd(200)
      const x: Inputs = {
        p,
        w,
        hot: rnd(5) === 0 ? null : [p, Math.min(N - 1, p + rnd(40))],
        blocked: Array.from({ length: rnd(3) }, () => rnd(N)),
        critical: Array.from({ length: rnd(4) }, () => {
          const start = rnd(N * P)
          return [start, start + 1 + rnd(20 * P)] as const
        }),
        audio: Array.from({ length: rnd(3) }, () => {
          const start = p * P + rnd(30 * P) // near the playhead, like the hot window's audio intervals
          return [start, start + 1 + rnd(3 * P)] as const
        }),
      }
      if (rnd(4) === 0) markVerified(rnd(N)) // pieces complete underneath the plan (gc runs)
      s = apply(x, s)
      await check(s, x, `replan ${String(k)}`)
      seen.hotNull += x.hot === null ? 1 : 0
      seen.blocked += x.blocked.length > 0 ? 1 : 0
      seen.critical += x.critical.length > 0 ? 1 : 0
      seen.overlapping += toPieceSpans(x.critical, P, N).length < x.critical.length ? 1 : 0
      seen.audio += (x.audio ?? []).length > 0 ? 1 : 0
    }
    s?.destroy()
    // the random cases really cover what they are meant to
    for (const n of Object.values(seen)) expect(n).toBeGreaterThan(50)
  })

  it('pause() leaves no selection and no critical flag; resume() restores the plan', async () => {
    const s = new Scheduler(t)
    const x: Inputs = { p: 7, w: 30, hot: [7, 9], blocked: [], critical: [bytes(0, 0)] }
    s.setCriticalRanges(x.critical)
    s.setPlayhead({ byte: 7 * P, windowBytes: 30 * P, hotBytes: 3 * P, seek: true })
    s.pause()
    await flush()
    expect([s.plan().length, t._selections.length, t._critical.filter(Boolean).length]).toEqual([0, 0, 0])
    s.resume()
    await check(s, x, 'resumed')
    s.destroy()
  })
})

describe('Scheduler blocked readers', () => {
  it('lists the pieces readers are blocked on, once each, until verified, and calls back on every change', () => {
    let changes = 0
    const s = new Scheduler(t, { onBlocked: () => changes++ })
    const missing = Array.from({ length: N }, (_, i) => i).filter((i) => t.pieces[i] !== null) // earlier tests verify some
    const [y, x] = [missing[10] ?? -1, missing[20] ?? -1]
    s.addBlocked('r1', x)
    s.addBlocked('r2', y)
    s.addBlocked('r3', x)
    expect(s.blockedPieces()).toEqual([y, x])
    expect(changes).toBe(3)
    s.addBlocked('r1', x) // the same reader on the same piece: no change
    s.addBlocked('r9', N) // out of range: ignored
    expect(changes).toBe(3)
    s.dropBlocked('r1')
    expect(s.blockedPieces()).toEqual([y, x]) // r3 still waits on x
    markVerified(y) // verified before its reader dropped it (PieceSource drops it a microtask later)
    expect(s.blockedPieces()).toEqual([x])
    s.dropBlocked('r3')
    s.dropBlocked('r2')
    s.dropBlocked('r2') // nothing left to drop: no change
    expect(s.blockedPieces()).toEqual([])
    expect(changes).toBe(6)
    s.destroy()
  })
})
