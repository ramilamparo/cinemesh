// Tables for ADR 0006 from a run-all.sh output directory: runs are grouped by label without the trailing -N.
// Delays and read times are pooled over every sample / trial of the group's runs (inside each run's measure
// window); throughput, dupFactor and the netem backlog are medians over runs, with the range.
//   npx tsx spikes/s2b-pacer/summarize.ts OUT            -> markdown tables on stdout, OUT/summary.json
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Trial } from './lib/proto.js'
import { pct, round } from './lib/proto.js'

const out = process.argv[2]
if (!out) {
  process.stderr.write('usage: summarize.ts OUT\n')
  process.exit(2)
}

interface Result {
  label: string
  args?: Record<string, unknown>
  ok: boolean
  env: { loadStart: number[]; loadEnd: number[]; loadSamples?: { load: number[] }[]; srcChanged: boolean }
  marks: { name: string; at: number }[]
  metrics: Record<string, unknown>
}
interface TraceEv {
  seq: number
  piece: number
  ev: string
  at: number
  member: string | null
}
interface Ping {
  peer: string
  id: number
  t0: number
  rtt: number
  fwd: number
}
interface HostReport {
  id: string
  trace: TraceEv[]
  ctrlRtts: Ping[]
  dgramRtts: Ping[]
  pingsSent: { t0: number }[]
  pingUdx?: { peer: string; id: number; bbr: number; cwnd: number; inflight: number; rtt: number }[]
  eldMeasure: { p99: number; max: number } | null
  samples: {
    at: number
    wires?: { member: string | null; queued: number; udxUnsent?: number; pending: number; passed: number }[]
  }[]
}
interface ViewerReport {
  id: string
  trace: TraceEv[]
  trials: Trial[]
  eldMeasure: { p99: number; max: number } | null
}

/** libudx's BBR states as udx-native exposes them (bbrState): PROBE_RTT holds the stream at a 4-packet window */
const BBR_PROBE_RTT = 3
/** a ping whose ctrl frame waited this much longer than its datagram twin waited in the stream (UDX + mux) */
const SPIKE_MS = 50

const results = readdirSync(out)
  .filter((f) => f.endsWith('.json') && f !== 'summary.json')
  .map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')) as Result)
  .filter((r) => r.ok)
const groups = new Map<string, Result[]>()
for (const r of results) {
  const g = r.label.replace(/-\d+$/, '')
  groups.set(g, [...(groups.get(g) ?? []), r])
}
const ORDER = [
  'a3-base',
  'a3-jit',
  'a3-jitu',
  'a3-jitup',
  'a1-base',
  'a1-jitup',
  ...['20', '50'].flatMap((r) =>
    ['base', 'f85', 'f85jd', 'pacer', 'pjit', 'pjitd', 'pxjitd', 'jit', 'jitd'].map((v) => `b${r}-${v}`),
  ),
]
const rank = (g: string): number => (ORDER.includes(g) ? ORDER.indexOf(g) : ORDER.length)
const sortedGroups = [...groups].sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : 1))

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), o)
function medRange(xs: (number | null)[], digits = 2): string {
  const v = xs.filter((x): x is number => x !== null)
  if (v.length === 0) return '-'
  const m = round(pct(v, 50), digits)
  return v.length === 1
    ? String(m)
    : `${String(m)} (${String(round(Math.min(...v), digits))}-${String(round(Math.max(...v), digits))})`
}
const p = (xs: number[], q: number, digits = 0): string => String(round(pct(xs, q), digits) ?? '-')
const share = (n: number, d: number, digits = 1): string => (d ? String(round((100 * n) / d, digits)) : '-')

/** first time of `ev` for (seq, piece) in a trace, optionally only from/to `member` */
function firstAt(trace: TraceEv[], seq: number, piece: number, ev: string, member?: string): number | null {
  let best: number | null = null
  for (const e of trace) {
    if (e.seq !== seq || e.piece !== piece || e.ev !== ev || (member !== undefined && e.member !== member)) continue
    if (best === null || e.at < best) best = e.at
  }
  return best
}
const STEPS = [
  ['hostReveal', 'reveal (have pushed)'],
  ['hostRevealSent', 'have past the throttle'],
  ['have', 'viewer: have in'],
  ['req', 'viewer: request out'],
  ['hostReq', 'request in'],
  ['hostRel', 'released'],
  ['hostSent', '1st block past the throttle'],
  ['blk', 'viewer: 1st block in'],
  ['hostSentAll', 'last block past the throttle'],
  ['ver', 'viewer: verified'],
] as const
const decomp = new Map<string, Record<string, number[]>>()

const rows: Record<string, unknown>[] = []
for (const [g, runs] of sortedGroups) {
  const ctrlIdle: number[] = []
  const ctrl: number[] = []
  const ctrlFwd: number[] = []
  const dgIdle: number[] = []
  const dg: number[] = []
  const queueing: number[] = []
  const stream: number[] = []
  let spikes = 0
  let spikesProbeRtt = 0
  let pingsUdx = 0
  let pingsProbeRtt = 0
  let sent = 0
  let got = 0
  const first: number[] = []
  const blocked: number[] = []
  const blockedAny: number[] = []
  const ready: number[] = []
  let trials = 0
  let aborted = 0
  const eldHost: number[] = []
  const eldViewers: number[] = []
  const loadMax: number[] = []
  /** per wire, 1 Hz: the app's queue (above the connection) and, with jit-udx, UDX's unsent bytes (KiB) */
  const appQueue: number[] = []
  const udxUnsent: number[] = []
  // throttle fairness: wire-seconds with work waiting (>= 16 KiB queued or a held request) that got < 10 % of the
  // host's upload in that second, while the host sent at least 100 kB
  let workSeconds = 0
  let starvedSeconds = 0
  /** each second: the busiest wire's share of the host's upload (1/3 is fair with 3 viewers) */
  const busiest: number[] = []
  for (const r of runs) {
    const at = (n: string): number => r.marks.find((m) => m.name === n)?.at ?? Number.NaN
    const idle = [at('idle'), at('start')]
    const meas = [at('measure'), at('finish')]
    const inW = (t: number, w: number[]): boolean => t >= (w[0] as number) && t <= (w[1] as number)
    loadMax.push(Math.max(r.env.loadStart[0] ?? 0, ...(r.env.loadSamples ?? []).map((s) => s.load[0] ?? 0)))
    const dir = join(out, r.label)
    const hostPath = join(dir, 'host.json')
    if (!existsSync(hostPath)) continue
    const h = JSON.parse(readFileSync(hostPath, 'utf8')) as HostReport
    h.trace ??= [] // runs from before the traces
    for (const x of h.ctrlRtts) {
      if (inW(x.t0, idle)) ctrlIdle.push(x.rtt)
      if (inW(x.t0, meas)) {
        ctrl.push(x.rtt)
        ctrlFwd.push(x.fwd)
      }
    }
    const idleDg = pct(
      h.dgramRtts.filter((x) => inW(x.t0, idle)).map((x) => x.fwd),
      50,
    )
    const dgOf = new Map<string, number>()
    for (const x of h.dgramRtts) {
      if (inW(x.t0, idle)) dgIdle.push(x.fwd)
      if (!inW(x.t0, meas)) continue
      dg.push(x.fwd)
      if (idleDg !== null) queueing.push(x.fwd - idleDg)
      dgOf.set(`${x.peer}:${String(x.id)}`, x.fwd)
    }
    // the stream's own queue: how much longer a ctrl ping waited than the datagram sent with it
    const probeRtt = new Map<string, Set<number>>()
    for (const u of h.pingUdx ?? []) {
      if (u.bbr !== BBR_PROBE_RTT) continue
      const s = probeRtt.get(u.peer) ?? new Set<number>()
      s.add(u.id)
      probeRtt.set(u.peer, s)
    }
    const ctrlOf = new Map(h.ctrlRtts.map((x) => [`${x.peer}:${String(x.id)}`, x]))
    for (const u of h.pingUdx ?? []) {
      const c = ctrlOf.get(`${u.peer}:${String(u.id)}`)
      if (!c || !inW(c.t0, meas)) continue
      pingsUdx++
      if (u.bbr === BBR_PROBE_RTT) pingsProbeRtt++
    }
    for (const x of h.ctrlRtts) {
      if (!inW(x.t0, meas)) continue
      const d = dgOf.get(`${x.peer}:${String(x.id)}`)
      if (d === undefined) continue
      const q = x.fwd - d
      stream.push(q)
      if (q <= SPIKE_MS) continue
      spikes++
      // the frame waited through a PROBE_RTT of its stream: one seen from 200 ms before it was sent to 600 ms after
      const s = probeRtt.get(x.peer)
      if (s && [-2, -1, 0, 1, 2, 3, 4, 5, 6].some((k) => s.has(x.id + k))) spikesProbeRtt++
    }
    for (const s of h.samples) {
      if (!inW(s.at, meas)) continue
      for (const w of s.wires ?? []) {
        appQueue.push((w.queued - (w.udxUnsent ?? 0)) / 1024)
        if (w.udxUnsent !== undefined && r.args?.['jit-udx'] === true) udxUnsent.push(w.udxUnsent / 1024)
      }
    }
    for (let i = 1; i < h.samples.length; i++) {
      const s0 = h.samples[i - 1]
      const s1 = h.samples[i]
      if (!s0 || !s1 || !inW(s1.at, meas) || !s0.wires || !s1.wires) continue
      const deltas = s1.wires.map((w) => {
        const before = s0.wires?.find((x) => x.member === w.member)
        return { before, d: before ? w.passed - before.passed : 0 }
      })
      const total = deltas.reduce((x, y) => x + y.d, 0)
      if (total < 100_000) continue
      if (deltas.length > 1) busiest.push(Math.max(...deltas.map((x) => x.d)) / total)
      for (const { before, d } of deltas) {
        if (!before || (before.queued < 16 * 1024 && before.pending === 0)) continue
        workSeconds++
        if (d < 0.1 * total) starvedSeconds++
      }
    }
    sent += h.pingsSent.filter((x) => inW(x.t0, meas)).length
    got += h.dgramRtts.filter((x) => inW(x.t0, meas)).length
    if (h.eldMeasure) eldHost.push(h.eldMeasure.p99)
    for (const f of readdirSync(dir).filter((x) => /^v\d+\.json$/.test(x))) {
      const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ViewerReport
      v.trace ??= []
      if (v.eldMeasure) eldViewers.push(v.eldMeasure.p99)
      // where the first piece's time went, for viewers that fetched it from the host
      const self = v.id.slice(0, 8)
      const hostShort = h.id.slice(0, 8)
      const d = decomp.get(g) ?? Object.fromEntries(STEPS.map(([k]) => [k, [] as number[]]))
      decomp.set(g, d)
      for (const t of v.trials) {
        const S = t.reads[0]?.piece
        if (!inW(t.hostAt, meas) || S === undefined || t.reads[0]?.blockedAt == null) continue
        const blk = v.trace
          .filter((e) => e.seq === t.seq && e.piece === S && e.ev === 'blk')
          .sort((x, y) => x.at - y.at)[0]
        if (blk?.member !== hostShort) continue
        const at: Record<string, number | null> = {
          hostReveal: firstAt(h.trace, t.seq, S, 'reveal', self),
          hostRevealSent: firstAt(h.trace, t.seq, S, 'revealSent', self),
          have: firstAt(v.trace, t.seq, S, 'have', hostShort),
          req: firstAt(v.trace, t.seq, S, 'req', hostShort),
          hostReq: firstAt(h.trace, t.seq, S, 'req', self),
          hostRel: firstAt(h.trace, t.seq, S, 'rel', self),
          hostSent: firstAt(h.trace, t.seq, S, 'sent', self),
          blk: blk.at,
          hostSentAll: firstAt(h.trace, t.seq, S, 'sentAll', self),
          ver: firstAt(v.trace, t.seq, S, 'ver'),
        }
        for (const [k] of STEPS) {
          const x = at[k]
          if (x != null) d[k]?.push(x - t.hostAt)
        }
      }
      for (const t of v.trials) {
        if (!inW(t.hostAt, meas)) continue
        trials++
        if (t.aborted) aborted++
        const r0 = t.reads[0]
        if (r0?.verifiedAt != null) {
          first.push(r0.verifiedAt - t.hostAt)
          if (r0.blockedAt != null) blocked.push(r0.verifiedAt - r0.blockedAt)
        }
        for (const x of t.reads)
          if (x.blockedAt != null && x.verifiedAt != null) blockedAny.push(x.verifiedAt - x.blockedAt)
        const last = t.reads[t.reads.length - 1]
        if (!t.aborted && last?.verifiedAt != null) ready.push(last.verifiedAt - t.hostAt)
      }
    }
  }
  const m = (k: string, ...path: string[]): (number | null)[] => runs.map((r) => num(get(r.metrics, k, ...path)))
  const linkShare = runs.map((r) => num(r.metrics.passedOverLink) ?? num(r.metrics.passedOverLimit))
  rows.push({
    group: g,
    runs: runs.length,
    load: medRange(
      runs.map((r) => r.env.loadStart[0] ?? null),
      1,
    ),
    loadMax: String(round(loadMax.length ? Math.max(...loadMax) : null, 1) ?? '-'),
    srcChanged: runs.filter((r) => r.env.srcChanged).length,
    trials,
    aborted,
    firstP50: p(first, 50),
    firstP95: p(first, 95),
    blockedP50: p(blocked, 50),
    blockedP95: p(blocked, 95),
    blockedAnyP50: p(blockedAny, 50),
    readyP50: p(ready, 50),
    readyP95: p(ready, 95),
    ctrlIdleP50: p(ctrlIdle, 50),
    ctrlP50: p(ctrl, 50),
    ctrlP95: p(ctrl, 95),
    ctrlP99: p(ctrl, 99),
    ctrlFwdP50: p(ctrlFwd, 50),
    ctrlFwdP95: p(ctrlFwd, 95),
    streamP50: p(stream, 50),
    streamP95: p(stream, 95),
    streamP99: p(stream, 99),
    spikePct: share(spikes, stream.length),
    spikeProbeRttPct: share(spikesProbeRtt, spikes, 0),
    probeRttPingPct: share(pingsProbeRtt, pingsUdx),
    dgIdleP50: p(dgIdle, 50),
    dgP50: p(dg, 50),
    dgP95: p(dg, 95),
    dgP99: p(dg, 99),
    queueP50: p(queueing, 50),
    queueP95: p(queueing, 95),
    dgLossPct: String(round(sent ? 100 * (1 - got / sent) : null, 2) ?? '-'),
    backlogP50: medRange(m('qdiscDelayMs', 'p50'), 0),
    backlogP95: medRange(m('qdiscDelayMs', 'p95'), 0),
    wireUse: medRange(m('qdiscSentOverLink')),
    throughput: medRange(linkShare),
    throughputMed: pct(
      linkShare.filter((x): x is number => x !== null),
      50,
    ),
    passedKBps: medRange(
      runs.map((r) => (num(r.metrics.hostPassedBps) ?? Number.NaN) / 1000),
      0,
    ),
    dup: medRange(m('dupFactorWindow'), 3),
    retransmits: medRange(m('udxRetransmits'), 0),
    drops: medRange(m('qdiscDropped'), 0),
    pacerRate: medRange(m('pacerRateKBps', 'p50'), 0),
    pacerQueue: medRange(m('pacerQueueMs', 'p50'), 0),
    starvedPct: share(starvedSeconds, workSeconds),
    busiestP50: p(busiest, 50, 2),
    busiestP90: p(busiest, 90, 2),
    appQueueP50: p(appQueue, 50),
    appQueueP95: p(appQueue, 95),
    udxUnsentP50: p(udxUnsent, 50),
    udxUnsentP95: p(udxUnsent, 95),
    eldHostP99: String(round(eldHost.length ? Math.max(...eldHost) : null, 1) ?? '-'),
    eldViewerP99: String(round(eldViewers.length ? Math.max(...eldViewers) : null, 1) ?? '-'),
  })
}
// payload throughput against the baseline at the same rate (the baseline's median over its runs)
for (const r of rows) {
  const g = String(r.group)
  const base = rows.find((x) => x.group === g.replace(/-[a-z0-9]+$/, '-base'))
  const b = num(base?.throughputMed)
  const t = num(r.throughputMed)
  r.vsBase = b && t ? String(round(t / b, 3)) : '-'
}

writeFileSync(join(out, 'summary.json'), JSON.stringify(rows, null, 1))
const table = (title: string, cols: [string, string][], filter: (g: string) => boolean): void => {
  const sel = rows.filter((r) => filter(String(r.group)))
  if (sel.length === 0) return
  process.stdout.write(
    `\n### ${title}\n\n| ${cols.map(([, h]) => h).join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`,
  )
  for (const r of sel) process.stdout.write(`| ${cols.map(([k]) => String(r[k])).join(' | ')} |\n`)
}
table(
  'Part A: app limit 1000 KiB/s, a reader blocked far past the frontier (ms)',
  [
    ['group', 'variant'],
    ['runs', 'runs'],
    ['load', 'load1 start'],
    ['loadMax', 'max'],
    ['trials', 'trials'],
    ['blockedP50', 'blocked p50'],
    ['blockedP95', 'p95'],
    ['throughput', 'up / limit'],
    ['dup', 'dupFactor'],
    ['starvedPct', 'starved wire-s %'],
    ['busiestP50', 'busiest wire share p50'],
    ['busiestP90', 'p90'],
    ['ctrlP50', 'ctrl RTT p50'],
    ['ctrlP95', 'p95'],
    ['eldHostP99', 'loop p99 host'],
    ['eldViewerP99', 'viewers'],
  ],
  (g) => g.startsWith('a'),
)
table(
  'Part B: uplink is the bottleneck, group seeks (ms)',
  [
    ['group', 'variant'],
    ['runs', 'runs'],
    ['load', 'load1 start'],
    ['loadMax', 'max'],
    ['trials', 'seeks x viewers'],
    ['firstP50', 'seek -> 1st piece p50'],
    ['firstP95', 'p95'],
    ['blockedP50', 'blocked p50'],
    ['blockedP95', 'p95'],
    ['readyP50', '4 pieces p50'],
    ['readyP95', 'p95'],
    ['aborted', 'aborted'],
    ['dup', 'dupFactor'],
  ],
  (g) => /^[bum]\d/.test(g),
)
table(
  'Part B: delays during saturation (ms). Stream = ctrl one-way minus the datagram sent with it',
  [
    ['group', 'variant'],
    ['ctrlIdleP50', 'ctrl RTT idle'],
    ['ctrlP50', 'ctrl RTT p50'],
    ['ctrlP95', 'p95'],
    ['ctrlP99', 'p99'],
    ['dgIdleP50', 'dgram 1-way idle'],
    ['dgP50', 'dgram p50'],
    ['dgP95', 'p95'],
    ['queueP50', 'net queue p50'],
    ['queueP95', 'p95'],
    ['streamP50', 'stream p50'],
    ['streamP95', 'p95'],
    ['streamP99', 'p99'],
    ['spikePct', `stream > ${String(SPIKE_MS)} %`],
    ['spikeProbeRttPct', 'of which PROBE_RTT %'],
    ['dgLossPct', 'dgram loss %'],
  ],
  (g) => /^[bum]\d/.test(g),
)
table(
  'Part B: link use',
  [
    ['group', 'variant'],
    ['wireUse', 'wire / link'],
    ['throughput', 'payload / link'],
    ['vsBase', 'vs base'],
    ['passedKBps', 'payload kB/s'],
    ['backlogP50', 'netem backlog p50 (incl. 20 ms line)'],
    ['backlogP95', 'p95'],
    ['retransmits', 'UDX rtx'],
    ['drops', 'netem drops'],
    ['appQueueP50', 'app queue / wire p50 KiB'],
    ['appQueueP95', 'p95'],
    ['udxUnsentP50', 'UDX unsent / wire p50 KiB'],
    ['udxUnsentP95', 'p95'],
    ['pacerRate', 'pacer kB/s p50'],
    ['pacerQueue', 'pacer queue est p50'],
    ['probeRttPingPct', 'pings in PROBE_RTT %'],
    ['eldHostP99', 'loop p99 host'],
    ['eldViewerP99', 'viewers'],
  ],
  (g) => /^[bum]\d/.test(g),
)
{
  const groupsWith = sortedGroups.map(([g]) => g).filter((g) => (decomp.get(g)?.ver?.length ?? 0) > 0)
  if (groupsWith.length > 0) {
    process.stdout.write(
      `\n### Where the first piece's time goes (medians, ms after the trial started; viewers that got it from the host)\n\n` +
        `| step | ${groupsWith.map((g) => `${g} (${String(decomp.get(g)?.ver?.length ?? 0)})`).join(' | ')} |\n|---|${groupsWith.map(() => '---').join('|')}|\n`,
    )
    for (const [k, label] of STEPS) {
      process.stdout.write(`| ${label} | ${groupsWith.map((g) => p(decomp.get(g)?.[k] ?? [], 50)).join(' | ')} |\n`)
    }
  }
}
{
  // every run on its own: what each repeat measured, next to the machine's load (noise shows here)
  const lines = results
    .map((r) => {
      const t = r.metrics.trials as Record<string, Record<string, number | null>> | undefined
      const fwd = (k: string, q: string): unknown => get(r.metrics, k, 'measure', q) ?? '-'
      const loads = (r.env.loadSamples ?? []).map((s) => s.load[0] ?? 0)
      return [
        r.label,
        String(r.env.loadStart[0] ?? '-'),
        String(round(loads.length ? Math.max(...loads) : null, 1) ?? '-'),
        String(r.env.srcChanged),
        String(t?.blockedFirstMs?.p50 ?? '-'),
        String(t?.blockedFirstMs?.p95 ?? '-'),
        String(fwd('ctrlRtt', 'p50')),
        String(fwd('ctrlRtt', 'p95')),
        String(fwd('dgramFwd', 'p50')),
        String(fwd('dgramFwd', 'p95')),
        String(num(r.metrics.passedOverLink) ?? num(r.metrics.passedOverLimit) ?? '-'),
        String(num(r.metrics.dupFactorWindow) ?? '-'),
      ]
    })
    .sort(
      (a, b) =>
        rank(String(a[0]).replace(/-\d+$/, '')) - rank(String(b[0]).replace(/-\d+$/, '')) || (a[0] < b[0] ? -1 : 1),
    )
  process.stdout.write(
    '\n### Per run\n\n| run | load1 start | max | src changed | blocked p50 | p95 | ctrl RTT p50 | p95 | dgram 1-way p50 | p95 | up / link or limit | dupFactor |\n|' +
      '---|'.repeat(12) +
      '\n',
  )
  for (const l of lines) process.stdout.write(`| ${l.join(' | ')} |\n`)
}
