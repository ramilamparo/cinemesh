// Pure analysis of what the members recorded (protocol.ts). Times are hrtime ms, comparable across members.
import type {
  AnchorRec,
  BitfieldRec,
  ManifestInfo,
  PlanRec,
  PropRec,
  ReqRec,
  RestartRec,
  RevealRec,
  SampleRec,
  ServedRec,
  TakebackRec,
} from './protocol.js'
import { CLS } from './protocol.js'

// ---- statistics ----------------------------------------------------------------------------------------------

/** Nearest-rank percentile (q in 0..1) of unsorted values; NaN when empty. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))] ?? Number.NaN
}

export interface Summary {
  n: number
  p50: number
  p95: number
  max: number
  mean: number
}

export function summary(values: readonly number[]): Summary {
  const n = values.length
  return {
    n,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: n ? round(Math.max(...values)) : Number.NaN,
    mean: n ? round(values.reduce((s, x) => s + x, 0) / n) : Number.NaN,
  }
}

export const round = (x: number, digits = 1): number => {
  const f = 10 ** digits
  return Math.round(x * f) / f
}

// ---- player timelines ----------------------------------------------------------------------------------------

export interface PlayerLog {
  sample: readonly SampleRec[]
  prop: readonly PropRec[]
  restart: readonly RestartRec[]
}

/** [from, to] hrtime windows in which a member's position is still settling (or not moving at all). */
export function settlingWindows(log: PlayerLog, settleMs: number): [number, number][] {
  const out: [number, number][] = []
  const open = new Map<string, number>()
  for (const [t, name, value] of log.prop) {
    if (name === 'pause') {
      if (value === true) open.set('pause', t)
      else {
        const since = open.get('pause')
        open.delete('pause')
        out.push([since ?? t, t + settleMs]) // paused, then an unpause settling
      }
    } else if (name === 'seeking' || name === 'paused-for-cache') {
      if (value === true) open.set(name, t)
      else {
        const since = open.get(name)
        open.delete(name)
        out.push([since ?? t, t + settleMs])
      }
    }
  }
  for (const since of open.values()) out.push([since, Number.POSITIVE_INFINITY])
  for (const [t] of log.restart) out.push([t, t + settleMs])
  return out.sort((a, b) => a[0] - b[0])
}

const inAny = (t: number, w: readonly [number, number][]): boolean => w.some(([a, b]) => t >= a && t <= b)

export interface PosPoint {
  t: number
  /** seconds */
  pos: number
  rtt: number
}

/**
 * Samples where the player plays steadily: not paused, seeking or waiting on its cache, outside every settling
 * window, with an IPC round trip of at most maxRttMs (the stamp is the request's midpoint, good to rtt / 2). The
 * position is audio-pts when `prop` is 'audio-pts' (smooth; it exists with --ao=null), else time-pos (frame steps).
 */
export function steadySamples(
  log: PlayerLog,
  opts: { settleMs: number; maxRttMs: number; prop: 'audio-pts' | 'time-pos' },
): { points: PosPoint[]; valid: boolean[]; dropped: { settling: number; rtt: number; state: number; noPos: number } } {
  const windows = settlingWindows(log, opts.settleMs)
  const points: PosPoint[] = []
  const valid: boolean[] = []
  const dropped = { settling: 0, rtt: 0, state: 0, noPos: 0 }
  for (const [t, rtt, apts, tpos, pause, seeking, pfc] of log.sample) {
    const pos = opts.prop === 'audio-pts' ? apts : tpos
    let ok = true
    if (pos === null) {
      dropped.noPos++
      ok = false
    } else if (pause !== 0 || seeking === 1 || pfc === 1) {
      dropped.state++
      ok = false
    } else if (rtt > opts.maxRttMs) {
      dropped.rtt++
      ok = false
    } else if (inAny(t, windows)) {
      dropped.settling++
      ok = false
    }
    points.push({ t, pos: pos ?? Number.NaN, rtt })
    valid.push(ok)
  }
  return { points, valid, dropped }
}

export interface DriftResult {
  /** signed viewer - host, ms, with the viewer sample's time */
  series: { t: number; ms: number }[]
  abs: Summary
  signed: Summary
  dropped: { viewer: Record<string, number>; noHostPair: number }
}

/**
 * Each steady viewer sample against the host's position at the same instant, interpolated between the two host
 * samples around it (adjacent in the host's sample stream, both steady, at most maxGapMs apart).
 */
export function driftVsHost(
  host: PlayerLog,
  viewer: PlayerLog,
  opts: {
    settleMs: number
    maxRttMs: number
    maxGapMs: number
    prop: 'audio-pts' | 'time-pos'
    from?: number
    to?: number
  },
): DriftResult {
  const h = steadySamples(host, opts)
  const v = steadySamples(viewer, opts)
  const series: { t: number; ms: number }[] = []
  let noHostPair = 0
  let k = 0
  for (let i = 0; i < v.points.length; i++) {
    const p = v.points[i]
    if (!p || !v.valid[i]) continue
    if ((opts.from !== undefined && p.t < opts.from) || (opts.to !== undefined && p.t > opts.to)) continue
    while (k + 1 < h.points.length && (h.points[k + 1]?.t ?? Infinity) <= p.t) k++
    const a = h.points[k]
    const b = h.points[k + 1]
    if (!a || !b || a.t > p.t || b.t < p.t || !h.valid[k] || !h.valid[k + 1] || b.t - a.t > opts.maxGapMs) {
      noHostPair++
      continue
    }
    const hostPos = a.pos + ((b.pos - a.pos) * (p.t - a.t)) / (b.t - a.t)
    series.push({ t: p.t, ms: (p.pos - hostPos) * 1000 })
  }
  return {
    series,
    abs: summary(series.map((x) => Math.abs(x.ms))),
    signed: summary(series.map((x) => x.ms)),
    dropped: { viewer: v.dropped, noHostPair },
  }
}

/**
 * Each steady sample of a member (the host's own mpv included) against the room: the host's published anchor
 * (pos, hostTime) extrapolated at 1x to the sample's instant. Only while the latest anchor, published at least
 * settleMs before the sample, is 'playing' and its hostTime is settleMs past.
 */
export function driftVsRoom(
  member: PlayerLog,
  anchors: readonly AnchorRec[],
  opts: { settleMs: number; maxRttMs: number; prop: 'audio-pts' | 'time-pos' },
): { series: { t: number; ms: number }[]; abs: Summary; signed: Summary } {
  const s = steadySamples(member, opts)
  const series: { t: number; ms: number }[] = []
  let k = -1
  for (let i = 0; i < s.points.length; i++) {
    const p = s.points[i]
    if (!p || !s.valid[i]) continue
    while (k + 1 < anchors.length && (anchors[k + 1]?.t ?? Infinity) <= p.t) k++
    const a = anchors[k]
    if (!a || a.mode !== 'playing' || p.t - a.t < opts.settleMs || p.t - a.hostTimeHr < opts.settleMs) continue
    const expected = a.pos + (p.t - a.hostTimeHr) / 1000
    series.push({ t: p.t, ms: (p.pos - expected) * 1000 })
  }
  return { series, abs: summary(series.map((x) => Math.abs(x.ms))), signed: summary(series.map((x) => x.ms)) }
}

/** The first change of a player property to `value` at or after t (hrtime ms), or null. */
export function firstProp(log: PlayerLog, name: string, value: unknown, t: number): number | null {
  for (const [at, n, v] of log.prop) if (at >= t && n === name && v === value) return at
  return null
}

/** The last value of a player property before t. */
export function propBefore(log: PlayerLog, name: string, t: number): unknown {
  let out: unknown = undefined
  for (const [at, n, v] of log.prop) {
    if (at >= t) break
    if (n === name) out = v
  }
  return out
}

/**
 * When playback actually started after an unpause at `unpausedAt`, from the position: each steady-enough sample in
 * [unpausedAt + fromMs, unpausedAt + toMs] (playing, rtt-bounded) gives t - (pos - startPos) s; their median.
 */
export function playbackStart(
  log: PlayerLog,
  unpausedAt: number,
  startPos: number,
  opts: { fromMs: number; toMs: number; maxRttMs: number; prop: 'audio-pts' | 'time-pos' },
): number | null {
  const est: number[] = []
  for (const [t, rtt, apts, tpos, pause, seeking] of log.sample) {
    if (t < unpausedAt + opts.fromMs || t > unpausedAt + opts.toMs) continue
    const pos = opts.prop === 'audio-pts' ? apts : tpos
    if (pos === null || pause !== 0 || seeking === 1 || rtt > opts.maxRttMs) continue
    est.push(t - (pos - startPos) * 1000)
  }
  return est.length ? percentile(est, 0.5) : null
}

/** A member process's RSS over [from, to] (hrtime ms) from its 1 Hz records, in MiB: first, last, max. */
export function rssMiB(
  mem: readonly (readonly [number, number, number])[],
  from = Number.NEGATIVE_INFINITY,
  to = Number.POSITIVE_INFINITY,
): { first: number; last: number; max: number } | null {
  const xs = mem.filter(([t]) => t >= from && t <= to).map(([, rss]) => rss / 1048576)
  if (xs.length === 0) return null
  return { first: round(xs[0] ?? 0), last: round(xs.at(-1) ?? 0), max: round(Math.max(...xs)) }
}

// ---- pieces ---------------------------------------------------------------------------------------------------

/** Byte ranges (end exclusive) as the sorted set of pieces they touch. */
export function piecesOf(ranges: readonly (readonly [number, number])[], pieceLength: number): number[] {
  const out = new Set<number>()
  for (const [a, b] of ranges) {
    if (b <= a) continue
    for (let i = Math.floor(a / pieceLength); i <= Math.floor((b - 1) / pieceLength); i++) out.add(i)
  }
  return [...out].sort((x, y) => x - y)
}

/**
 * Plan §4.3 for MKV: the player starts reading at the keyframe at or before target - 2 s (subtitle preroll); that
 * byte's piece is the playhead p. From the manifest's keyframe index, independently of MediaMap.
 */
export function expectedPlayhead(
  m: ManifestInfo,
  targetS: number,
  prerollMs = 2000,
): { keyMs: number; byte: number; p: number } {
  let best: [number, number] = [0, 0]
  for (const k of m.keyframes) if (k[0] <= targetS * 1000 - prerollMs) best = k
  return { keyMs: best[0], byte: best[1], p: Math.floor(best[1] / m.pieceLength) }
}

export interface DupResult {
  servedBytes: number
  distinctBytes: number
  dupAll: number
  criticalPieces: number[]
  /** share of the file's pieces that are critical (shown to every viewer at once) */
  criticalShare: number
  criticalServed: number
  criticalDistinct: number
  dupWithoutCritical: number
  /** host bytes served per piece, / its distinct bytes: how many times it left the host */
  copiesP50: number
  copiesMax: number
}

/** dupFactor from the host's served requests, as the engine counts it (16 KiB blocks), with and without critical pieces. */
export function dupFactor(served: readonly ServedRec[], critical: readonly number[], pieceCount: number): DupResult {
  const crit = new Set(critical)
  const perPiece = new Map<number, { served: number; blocks: Map<number, number> }>()
  for (const [, piece, offset, length] of served) {
    let e = perPiece.get(piece)
    if (!e) {
      e = { served: 0, blocks: new Map() }
      perPiece.set(piece, e)
    }
    e.served += length
    const b = Math.floor(offset / 16384)
    if (!e.blocks.has(b)) e.blocks.set(b, length)
  }
  let servedBytes = 0
  let distinctBytes = 0
  let critServed = 0
  let critDistinct = 0
  const copies: number[] = []
  for (const [piece, e] of perPiece) {
    const distinct = [...e.blocks.values()].reduce((s, x) => s + x, 0)
    servedBytes += e.served
    distinctBytes += distinct
    if (crit.has(piece)) {
      critServed += e.served
      critDistinct += distinct
    }
    if (distinct > 0) copies.push(e.served / distinct)
  }
  return {
    servedBytes,
    distinctBytes,
    dupAll: round(servedBytes / Math.max(1, distinctBytes), 3),
    criticalPieces: [...crit].sort((a, b) => a - b),
    criticalShare: round(crit.size / Math.max(1, pieceCount), 4),
    criticalServed: critServed,
    criticalDistinct: critDistinct,
    dupWithoutCritical: round((servedBytes - critServed) / Math.max(1, distinctBytes - critDistinct), 3),
    copiesP50: round(percentile(copies, 0.5), 2),
    copiesMax: round(copies.length ? Math.max(...copies) : Number.NaN, 2),
  }
}

// ---- R6 order ---------------------------------------------------------------------------------------------------

/** A plan's class for a piece, as the scheduler orders it (orderRanges): urgent, L1, L2, L3. */
export function classOf(plan: PlanRec, piece: number, pieceCount: number): number {
  if (plan.paused) return CLS.none
  if (plan.blocked.includes(piece)) return CLS.urgent
  if (plan.hot && piece >= plan.hot[0] && piece <= plan.hot[1]) return CLS.urgent
  if (plan.critical.some(([a, b]) => piece >= a && piece <= b)) return CLS.urgent
  if (plan.p === null || plan.w === null) return CLS.l1
  if (piece >= plan.p && piece <= Math.min(pieceCount - 1, plan.p + plan.w)) return CLS.l1
  if (piece > plan.p + plan.w) return CLS.l2
  return CLS.l3
}

/** Why a piece is urgent in a plan: 'blocked' (group 1), 'hot' (group 2), 'critical' (group 3), or null. */
export function urgentKind(plan: PlanRec, piece: number): 'blocked' | 'hot' | 'critical' | null {
  if (plan.blocked.includes(piece)) return 'blocked'
  if (plan.hot && piece >= plan.hot[0] && piece <= plan.hot[1]) return 'hot'
  if (plan.critical.some(([a, b]) => piece >= a && piece <= b)) return 'critical'
  return null
}

export interface WireOrder {
  requests: number
  /** requests for which a piece ahead in WebTorrent's walk was available on that wire */
  violations: number
  /** of those: a request outside urgent ∪ L1 while the wire offered a needed, unreserved urgent or L1 piece */
  windowViolations: number
  /** of those: an L3 request while the wire offered a needed, unreserved L2 piece */
  wrapViolations: number
  /** pieces ahead that speedRanker may skip on a slow wire (not violations) */
  rankerSkips: number
  examples: { t: number; piece: number; peer: string; cls: number; ahead: number; aheadCls: number }[]
}

/** The per-wire R6 rule (ADR 0003 Finding 3) over `reqs`, using the plan each request was made under. */
export function wireOrder(reqs: readonly ReqRec[], plans: ReadonlyMap<number, PlanRec>, pieceCount: number): WireOrder {
  const out: WireOrder = {
    requests: 0,
    violations: 0,
    windowViolations: 0,
    wrapViolations: 0,
    rankerSkips: 0,
    examples: [],
  }
  for (const [t, piece, , peer, cls, gen, viol, exempt] of reqs) {
    out.requests++
    out.rankerSkips += exempt
    if (viol < 0) continue
    out.violations++
    const plan = plans.get(gen)
    const aheadCls = plan ? classOf(plan, viol, pieceCount) : CLS.none
    if ((cls === CLS.l2 || cls === CLS.l3 || cls === CLS.none) && (aheadCls === CLS.urgent || aheadCls === CLS.l1)) {
      out.windowViolations++
    }
    if (cls === CLS.l3 && aheadCls === CLS.l2) out.wrapViolations++
    if (out.examples.length < 10) out.examples.push({ t, piece, peer, cls, ahead: viol, aheadCls })
  }
  return out
}

/** Blocks per piece (16 KiB), the last piece shorter. */
export function blocksOf(piece: number, m: ManifestInfo, pieceCount: number): number {
  const len = piece === pieceCount - 1 ? m.fileSize - piece * m.pieceLength : m.pieceLength
  return Math.ceil(len / 16384)
}

/**
 * When every piece of `pieces` had been fully requested (all of its blocks, by one viewer: `union` false; by
 * the viewers together, each piece by at least one of them: `union` true) or was already verified there, at or
 * after `since`; null if never. `reqs` and `verified` are per viewer.
 */
export function fullyRequestedAt(
  pieces: readonly number[],
  viewers: readonly { reqs: readonly ReqRec[]; verified: readonly (readonly [number, number])[] }[],
  m: ManifestInfo,
  pieceCount: number,
  since: number,
): number | null {
  let latest = since
  for (const piece of pieces) {
    let best = Number.POSITIVE_INFINITY
    for (const v of viewers) {
      const verifiedAt = v.verified.find(([, i]) => i === piece)?.[0]
      if (verifiedAt !== undefined && verifiedAt <= since) {
        best = since
        break
      }
      const need = blocksOf(piece, m, pieceCount)
      const got = new Set<number>()
      let at = Number.POSITIVE_INFINITY
      for (const [t, i, offset] of v.reqs) {
        if (i !== piece || t < since) continue
        got.add(offset)
        if (got.size === need) {
          at = t
          break
        }
      }
      best = Math.min(best, at, verifiedAt ?? Number.POSITIVE_INFINITY)
    }
    if (!Number.isFinite(best)) return null
    latest = Math.max(latest, best)
  }
  return latest
}

/**
 * The walk's assignments (Revealer give, path 'walk') in order, each ranked in the group plan in force when it
 * was made (cyclic from that plan's p: L1, L2, then L3 from 0). A step back within one plan is out of order.
 */
export function revealOrder(
  reveals: readonly RevealRec[],
  plans: readonly { t: number; p: number | null }[],
  pieceCount: number,
  since: number,
): {
  gives: number
  backSteps: number
  examples: { t: number; prev: number; piece: number; p: number }[]
  first: number[]
} {
  const gives = reveals.filter(([t, , , ctx, path]) => t >= since && ctx === 'give' && path === 'walk')
  let backSteps = 0
  const examples: { t: number; prev: number; piece: number; p: number }[] = []
  let prev: { rank: number; plan: number; piece: number } | null = null
  const planAt = (t: number): number => {
    let k = -1
    for (let i = 0; i < plans.length; i++) if ((plans[i]?.t ?? Infinity) <= t) k = i
    return k
  }
  for (const [t, , piece] of gives) {
    const k = planAt(t)
    const p = plans[k]?.p ?? 0
    const rank = (piece - p + pieceCount) % pieceCount
    if (prev && prev.plan === k && rank < prev.rank) {
      backSteps++
      if (examples.length < 10) examples.push({ t, prev: prev.piece, piece, p })
    }
    prev = { rank, plan: k, piece }
  }
  // the first distinct pieces given after `since`
  const first: number[] = []
  for (const [, , piece] of gives) {
    if (!first.includes(piece)) first.push(piece)
    if (first.length >= 12) break
  }
  return { gives: gives.length, backSteps, examples, first }
}

// ---- striping's own bookkeeping ---------------------------------------------------------------------------------

export interface HostRevealLog {
  bitfield: readonly BitfieldRec[]
  reveal: readonly RevealRec[]
  takeback: readonly TakebackRec[]
  served: readonly ServedRec[]
}

/**
 * What the host showed `viewer` just before t: its latest bitfield (a re-attached wire starts over), then every
 * reveal and take-back.
 */
export function shownAt(log: Omit<HostRevealLog, 'served'>, viewer: string, t: number): Set<number> {
  type Ev = { t: number; k: 0 | 1 | 2; x: number | readonly number[] }
  const evs: Ev[] = [
    ...log.bitfield.filter((b) => b.viewer === viewer).map((b): Ev => ({ t: b.t, k: 0, x: b.pieces })),
    ...log.reveal.filter((r) => r[1] === viewer).map((r): Ev => ({ t: r[0], k: 1, x: r[2] })),
    ...log.takeback.filter((b) => b.viewer === viewer).map((b): Ev => ({ t: b.t, k: 2, x: b.pieces })),
  ]
    .filter((e) => e.t < t)
    .sort((a, b) => a.t - b.t || a.k - b.k)
  const shown = new Set<number>()
  for (const e of evs) {
    if (e.k === 0) {
      shown.clear()
      for (const i of e.x as readonly number[]) shown.add(i)
    } else if (e.k === 1) shown.add(e.x as number)
    else for (const i of e.x as readonly number[]) shown.delete(i)
  }
  return shown
}

/**
 * Replays what the host showed each viewer over time (its first bitfield per wire, every reveal, every take-back)
 * against the requests it got: the served records for pieces it did not show that viewer at that moment. A
 * re-attached wire starts over from its new bitfield.
 */
export function unrevealedServed(log: HostRevealLog): {
  served: ServedRec[]
  perViewer: Map<string, { blocks: number; bytes: number; first: { t: number; piece: number } | null }>
} {
  type Ev = { t: number; k: 0 | 1 | 2 | 3; v: string; x: number | readonly number[]; rec?: ServedRec }
  const evs: Ev[] = [
    ...log.bitfield.map((b): Ev => ({ t: b.t, k: 0, v: b.viewer, x: b.pieces })),
    ...log.reveal.map((r): Ev => ({ t: r[0], k: 1, v: r[1], x: r[2] })),
    ...log.takeback.map((b): Ev => ({ t: b.t, k: 2, v: b.viewer, x: b.pieces })),
    ...log.served.map((s): Ev => ({ t: s[0], k: 3, v: s[4], x: s[1], rec: s })),
  ].sort((a, b) => a.t - b.t || a.k - b.k)
  const shown = new Map<string, Set<number>>()
  const perViewer = new Map<string, { blocks: number; bytes: number; first: { t: number; piece: number } | null }>()
  const served: ServedRec[] = []
  for (const e of evs) {
    let set = shown.get(e.v)
    if (!set) {
      set = new Set()
      shown.set(e.v, set)
    }
    if (e.k === 0) {
      set.clear()
      for (const i of e.x as readonly number[]) set.add(i)
    } else if (e.k === 1) set.add(e.x as number)
    else if (e.k === 2) for (const i of e.x as readonly number[]) set.delete(i)
    else if (e.rec && !set.has(e.x as number)) {
      const o = perViewer.get(e.v) ?? { blocks: 0, bytes: 0, first: null }
      o.blocks++
      o.bytes += e.rec[3]
      o.first ??= { t: e.t, piece: e.x as number }
      perViewer.set(e.v, o)
      served.push(e.rec)
    }
  }
  return { served, perViewer }
}
