// The tables of ADR 0007 from any number of S6-lite runs, pooled by condition (source × load).
//   npx tsx spikes/s6-lite/summarize.ts <dir>... [--json <file>]
// Every <dir> is searched (two levels deep) for run.json files written by s6.ts.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type Prop, type RunData, type RunResult, type Summary, analyzeRun, summary } from './lib.js'

const { values, positionals } = parseArgs({ allowPositionals: true, options: { json: { type: 'string' } } })

function runFiles(dir: string, depth = 2): string[] {
  if (existsSync(join(dir, 'run.json'))) return [join(dir, 'run.json')]
  if (depth === 0) return []
  return readdirSync(dir)
    .map((d) => join(dir, d))
    .filter((p) => statSync(p).isDirectory())
    .flatMap((p) => runFiles(p, depth - 1))
}

const runs: RunResult[] = positionals
  .flatMap((d) => runFiles(d))
  .map((f) => analyzeRun(JSON.parse(readFileSync(f, 'utf8')) as RunData))
const groups = new Map<string, RunResult[]>()
for (const r of runs.sort((a, b) => a.meta.started.localeCompare(b.meta.started))) {
  const key = `${r.meta.source}${r.meta.ipc === 'socket' ? ' socket' : ''} load${String(r.meta.load)}`
  groups.set(key, [...(groups.get(key) ?? []), r])
}
const keys = [...groups.keys()].sort()

const f = (x: number, d = 2): string => (Number.isFinite(x) ? x.toFixed(d) : '–')
const range = (xs: number[], d = 2): string => {
  const s = summary(xs)
  return s.n === 0 ? '–' : s.min === s.max ? f(s.min, d) : `${f(s.min, d)}–${f(s.max, d)}`
}
const pct = (a: number, b: number): string => (b > 0 ? `${((100 * a) / b).toFixed(1)} %` : '–')
const pool = <T>(rs: RunResult[], pick: (r: RunResult) => T[]): T[] => rs.flatMap(pick)
const la1 = (rs: RunResult[]): number[] => pool(rs, (r) => r.meta.loadavg.map((l) => Number(l.text.split(' ')[0])))
const row = (cells: (string | number)[]): string => `| ${cells.map(String).join(' | ')} |`
const head = (cells: string[]): string => `${row(cells)}\n${row(cells.map(() => '---'))}`
const sm = (s: Summary, d = 2): string => `${f(s.p50, d)} / ${f(s.p95, d)} / ${f(s.min, d)}…${f(s.max, d)}`
const out: string[] = []
const json: Record<string, unknown> = {}

out.push('## Runs\n')
out.push(
  head([
    'run',
    'condition',
    'protocols',
    'started (UTC)',
    'loadavg 1 min (min–max)',
    'CPU PSI some avg10, % (mean / max)',
    'runnable tasks (max)',
    'src changed',
  ]),
)
for (const r of runs) {
  const m = r.meta
  const env = r.env
  const psi = summary(env.map((e) => e.psi10))
  out.push(
    row([
      m.tag,
      `${m.source}${m.ipc === 'socket' ? ' socket' : ''} load${String(m.load)}`,
      m.protocols.join(','),
      m.started.slice(0, 19),
      env.length > 0
        ? range(
            env.map((e) => e.la1),
            1,
          )
        : range(la1([r]), 1),
      env.length > 0 ? `${f(psi.mean, 1)} / ${f(psi.max, 1)}` : '–',
      env.length > 0 ? Math.max(...env.map((e) => e.running)) : '–',
      m.src.changed.join(', ') || 'no',
    ]),
  )
}

out.push('\n## (1) IPC round trip, ms (4 Hz samples; p50 / p99 / max, n)\n')
out.push(head(['condition', 'state', 'audio-pts', 'time-pos', 'p99 < 5 ms?']))
for (const k of keys) {
  const rs = groups.get(k) ?? []
  for (const st of ['idle', 'play', 'dense'] as const) {
    const cell = (p: Prop): { txt: string; p99: number } => {
      const s = summary(pool(rs, (r) => r.rtt[st][p]))
      return { txt: s.n ? `${f(s.p50, 3)} / ${f(s.p99, 3)} / ${f(s.max, 2)} (${String(s.n)})` : '–', p99: s.p99 }
    }
    const a = cell('audio-pts')
    const t = cell('time-pos')
    const label = st === 'idle' ? 'paused' : st === 'play' ? 'playing (4 Hz)' : 'trials (20 Hz)'
    const pass = Number.isFinite(a.p99) ? (Math.max(a.p99, t.p99) < 5 ? 'yes' : 'no') : '–'
    out.push(row([k, label, a.txt, t.txt, pass]))
    json[`rtt ${k} ${st}`] = { audioPts: summary(pool(rs, (r) => r.rtt[st]['audio-pts'])) }
  }
}

out.push('\n## (1b) IPC round trip per run: p99, ms (audio-pts / time-pos), with the run’s load\n')
out.push(
  head([
    'run',
    'condition',
    'started (UTC)',
    'loadavg 1 min (min–max)',
    'CPU PSI avg10 mean, %',
    'paused',
    'playing (4 Hz)',
    'trials (20 Hz)',
    'all < 5 ms?',
  ]),
)
for (const r of runs) {
  const m = r.meta
  const p99 = (st: 'idle' | 'play' | 'dense', p: Prop): number => summary(r.rtt[st][p]).p99
  const cell = (st: 'idle' | 'play' | 'dense'): string => `${f(p99(st, 'audio-pts'))} / ${f(p99(st, 'time-pos'))}`
  const worst = Math.max(
    ...(['idle', 'play', 'dense'] as const)
      .flatMap((st) => [p99(st, 'audio-pts'), p99(st, 'time-pos')])
      .filter(Number.isFinite),
  )
  out.push(
    row([
      m.tag,
      `${m.source}${m.ipc === 'socket' ? ' socket' : ''} load${String(m.load)}`,
      m.started.slice(0, 16).replace('T', ' '),
      r.env.length > 0
        ? range(
            r.env.map((e) => e.la1),
            1,
          )
        : '–',
      r.env.length > 0 ? f(summary(r.env.map((e) => e.psi10)).mean, 1) : '–',
      cell('idle'),
      cell('play'),
      cell('dense'),
      Number.isFinite(worst) ? (worst < 5 ? 'yes' : 'no') : '–',
    ]),
  )
}

out.push('\n## (2) Position fit over the 1x window (4 Hz, per run)\n')
out.push(
  head([
    'condition',
    'run',
    'audio-pts n',
    'σ ms',
    'max |res| ms',
    'rate − 1 (ppm)',
    'gated σ ms',
    'median-of-5 p99 |D| ms',
    'time-pos σ ms',
    'time-pos − audio-pts ms (mean, min…max)',
    'time-pos median-of-5 p99 |D| ms',
  ]),
)
for (const k of keys) {
  for (const r of groups.get(k) ?? []) {
    const x = r.fit
    if (!x) continue
    out.push(
      row([
        k,
        r.meta.tag,
        x.ap.n,
        f(x.ap.sd, 3),
        f(x.ap.maxAbs, 2),
        f(x.ap.slopePpm, 1),
        f(x.ap.gatedSd, 3),
        f(x.ap.med5P99, 3),
        f(x.tp.sd, 2),
        `${f(x.tp.biasMean, 1)} (${f(x.tp.biasMin, 1)}…${f(x.tp.biasMax, 1)})`,
        f(x.tp.med5P99, 1),
      ]),
    )
  }
}

out.push('\n## (3) Unpause latency: pause while playing, unpause at a scheduled T (A trials)\n')
out.push('p50 / p95 / min…max, ms. lat = new line reaches the paused audio-pts − command; vs T includes the timer.\n')
out.push(
  head([
    'condition',
    'n',
    'command late vs T',
    'unpause latency',
    'σ',
    'start vs T',
    'member estimate − latency',
    'paused audio-pts − line at pause',
    'paused time-pos − audio-pts',
  ]),
)
for (const k of keys) {
  const t = pool(groups.get(k) ?? [], (r) => r.pause)
  if (t.length === 0) continue
  const lat = summary(t.map((x) => x.latMs))
  const est = t.filter((x) => x.estMs !== null).map((x) => (x.estMs ?? 0) - x.latMs)
  out.push(
    row([
      k,
      t.length,
      sm(summary(t.map((x) => x.lateMs))),
      sm(lat),
      f(lat.sd, 2),
      sm(summary(t.map((x) => x.vsTMs))),
      sm(summary(est)),
      sm(summary(t.map((x) => x.pausedErrMs))),
      sm(summary(t.map((x) => x.tpLeadMs)), 1),
    ]),
  )
  json[`unpause ${k}`] = { lat, vsT: summary(t.map((x) => x.vsTMs)), late: summary(t.map((x) => x.lateMs)) }
}

out.push('\n## (3b, 4) Exact seek while paused, then unpause at T (B trials), ms\n')
out.push(
  head([
    'condition',
    'n',
    'seek → playback-restart',
    'paused audio-pts − target (+50 ms)',
    'paused time-pos − target (where it landed)',
    'paused time-pos − first frame ≥ target − 5 ms',
    'unpause latency (to the frame)',
    'line reaches the target, after the command',
    'member estimate (fromPos = target)',
  ]),
)
for (const k of keys) {
  const t = pool(groups.get(k) ?? [], (r) => r.pseek)
  if (t.length === 0) continue
  out.push(
    row([
      k,
      t.length,
      sm(summary(t.map((x) => x.seekMs))),
      sm(summary(t.map((x) => x.ap50Ms)), 1),
      sm(summary(t.map((x) => x.tpMs)), 1),
      sm(summary(t.map((x) => x.tpVsFrameMs))),
      sm(summary(t.map((x) => x.latFrameMs))),
      sm(summary(t.map((x) => x.latTargetMs)), 1),
      sm(summary(t.filter((x) => x.estMs !== null).map((x) => x.estMs ?? 0)), 1),
    ]),
  )
  json[`pseek ${k}`] = { seek: summary(t.map((x) => x.seekMs)), ap50: summary(t.map((x) => x.ap50Ms)) }
}

out.push('\n## (4) Exact seek while playing (C trials), ms\n')
out.push(
  head([
    'condition',
    'kind',
    'n',
    'seek → playback-restart',
    'line reaches the target',
    'line reaches the first frame ≥ target',
    'landing D (restart latency − line at target)',
    'D after a skip, seekLat = 400 ms (init)',
    'D after a skip, seekLat = 100 ms (floor)',
  ]),
)
for (const k of keys) {
  for (const short of [true, false]) {
    const t = pool(groups.get(k) ?? [], (r) => r.rseek).filter((x) => x.short === short)
    if (t.length === 0) continue
    out.push(
      row([
        k,
        short ? 'skip +1.5 s' : 'anywhere',
        t.length,
        sm(summary(t.map((x) => x.seekMs))),
        sm(summary(t.map((x) => x.effMs)), 1),
        sm(summary(t.map((x) => x.effFrameMs))),
        sm(summary(t.map((x) => x.landMs)), 1),
        sm(summary(t.map((x) => 400 - x.effMs)), 1),
        sm(summary(t.map((x) => 100 - x.effMs)), 1),
      ]),
    )
    json[`rseek ${k} ${short ? 'short' : 'far'}`] = summary(t.map((x) => x.seekMs))
  }
}

out.push('\n## (5) Speed nudges: measured rate vs set speed (from 1 s after the change)\n')
out.push(
  head([
    'condition',
    'speed',
    'segments',
    'audio-pts rate error, % (each segment)',
    'vs the run’s 1x rate, %',
    'σ ms',
    'time-pos rate error, %',
    'change takes effect after, ms',
    'audio-reconfig events',
  ]),
)
for (const k of keys) {
  const segs = pool(groups.get(k) ?? [], (r) => r.speeds)
  for (const sp of [...new Set(segs.map((s) => s.speed))].sort()) {
    const s = segs.filter((x) => x.speed === sp)
    out.push(
      row([
        k,
        sp,
        s.length,
        s.map((x) => f(x.errPct, 4)).join(', '),
        s.map((x) => f(x.errVs1xPct, 4)).join(', '),
        range(
          s.map((x) => x.sd),
          3,
        ),
        range(
          s.map((x) => x.tpErrPct),
          3,
        ),
        range(
          s.filter((x) => x.changeMs !== null).map((x) => x.changeMs ?? 0),
          0,
        ),
        s.reduce((a, x) => a + x.reconfigs, 0),
      ]),
    )
  }
}

out.push('\n## (6) The drift loop gate on sample() while playing (4 Hz): RTT < 15 ms and loop lag < 20 ms\n')
out.push(
  head([
    'condition',
    'samples',
    'accepted',
    'rejected: RTT',
    'rejected: lag',
    'rejected: both',
    'loopLagMs() paused p50 / p99 / max',
    'loopLagMs() playing p50 / p99 / max',
    'sample() fell back to time-pos',
    'accepted if the lag excluded the 10 ms timer interval',
  ]),
)
for (const k of keys) {
  const rs = groups.get(k) ?? []
  const g = rs.reduce(
    (a, r) => ({
      n: a.n + r.gate.n,
      ok: a.ok + r.gate.ok,
      badRtt: a.badRtt + r.gate.badRtt,
      badLag: a.badLag + r.gate.badLag,
      badBoth: a.badBoth + r.gate.badBoth,
    }),
    { n: 0, ok: 0, badRtt: 0, badLag: 0, badBoth: 0 },
  )
  const li = summary(pool(rs, (r) => r.lag.idle))
  const lp = summary(pool(rs, (r) => r.lag.play))
  out.push(
    row([
      k,
      g.n,
      pct(g.ok, g.n),
      pct(g.badRtt, g.n),
      pct(g.badLag, g.n),
      pct(g.badBoth, g.n),
      `${f(li.p50, 1)} / ${f(li.p99, 1)} / ${f(li.max, 1)}`,
      `${f(lp.p50, 1)} / ${f(lp.p99, 1)} / ${f(lp.max, 1)}`,
      rs.reduce((a, r) => a + r.fallbacks, 0),
      pct(
        rs.reduce((a, r) => a + r.gate.okNoInterval, 0),
        g.n,
      ),
    ]),
  )
  json[`gate ${k}`] = { ...g, lagIdle: li, lagPlay: lp }
}

console.log(out.join('\n'))
if (values.json !== undefined) writeFileSync(values.json, JSON.stringify(json, null, 1))
