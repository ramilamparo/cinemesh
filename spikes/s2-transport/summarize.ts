// Medians of 3 per configuration, from results/<group>-<n>.json. Prints markdown tables and writes
// results/summary.json.
//   npx tsx spikes/s2-transport/summarize.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { median } from './lib/analyze.js'

const dir = join(import.meta.dirname, 'results')
const runs = readdirSync(dir)
  .filter((f) => /-\d+\.json$/.test(f))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
const groups = new Map<string, any[]>()
for (const r of runs) {
  const g = r.label.replace(/-\d+$/, '')
  groups.set(g, [...(groups.get(g) ?? []), r])
}

const get = (o: any, path: string): number | null => {
  const v = path.split('.').reduce((a, k) => (a == null ? a : a[k]), o)
  return typeof v === 'number' ? v : null
}
const med = (rs: any[], f: (r: any) => number | null): number | null => {
  const v = rs.map(f).filter((x): x is number => x !== null && Number.isFinite(x))
  return v.length ? median(v) : null
}
const r1 = (x: number | null): string => (x === null ? '—' : String(Math.round(x * 10) / 10))
const viewersMax = (r: any, k: string): number | null => {
  const v = (r.perProcess ?? []).filter((p: any) => !isHost(p)).map((p: any) => p[k])
  return v.length ? Math.max(...v) : null
}
// in one-process mode the only process is 'host+v1+v2+v3': it counts as the host process
const isHost = (p: any): boolean => p.members.split('+').includes('host')
const hostP = (r: any, k: string): number | null => (r.perProcess ?? []).find(isHost)?.[k] ?? null
const allP = (r: any, k: string): number | null => {
  const v = (r.perProcess ?? []).map((p: any) => p[k])
  return v.length ? Math.max(...v) : null
}

const cols: [string, (r: any) => number | null][] = [
  ['runs ok', () => null],
  ['viewer MB/s (median viewer)', (r) => get(r, 'throughput.viewerMedianMBps')],
  ['viewer MB/s (slowest)', (r) => get(r, 'throughput.viewerMinMBps')],
  ['aggregate viewer MB/s', (r) => get(r, 'throughput.aggregateViewerMBps')],
  ['host upload MB/s', (r) => get(r, 'throughput.hostUploadMBps')],
  ['dupFactor (no striping)', (r) => get(r, 'throughput.dupFactorNoStriping')],
  ['mesh formation ms', (r) => get(r, 'mesh.ms')],
  ['conn opened ms (max)', (r) => get(r, 'handshake.connOpenedMsMax')],
  ['bt opened ms p50', (r) => get(r, 'handshake.chOpenedMsP50')],
  ['bt opened ms max', (r) => get(r, 'handshake.chOpenedMsMax')],
  ['wire ms p50', (r) => get(r, 'handshake.wireMsP50')],
  ['wire ms max', (r) => get(r, 'handshake.wireMsMax')],
  ['ctrl idle RTT p50', (r) => get(r, 'latency.ctrl.idleP50')],
  ['ctrl idle RTT p95', (r) => get(r, 'latency.ctrl.idleP95')],
  ['ctrl extra p50', (r) => get(r, 'latency.ctrl.extraP50')],
  ['ctrl extra p95', (r) => get(r, 'latency.ctrl.extraP95')],
  ['ctrl extra max', (r) => get(r, 'latency.ctrl.extraMax')],
  ['dgram idle p50', (r) => get(r, 'latency.dgramIdle.p50')],
  ['dgram idle p95', (r) => get(r, 'latency.dgramIdle.p95')],
  ['dgram idle loss %', (r) => get(r, 'latency.dgramIdle.lossPct')],
  ['dgram sat p50', (r) => get(r, 'latency.dgramSat.p50')],
  ['dgram sat p95', (r) => get(r, 'latency.dgramSat.p95')],
  ['dgram sat loss %', (r) => get(r, 'latency.dgramSat.lossPct')],
  ['dgram sat p95 / idle p50', (r) => {
    const a = get(r, 'latency.dgramSat.p95')
    const b = get(r, 'latency.dgramIdle.p50')
    return a !== null && b ? a / b : null
  }],
  ['host RSS growth MB', (r) => hostP(r, 'rssGrowthMB')],
  ['viewer RSS growth MB (max)', (r) => viewersMax(r, 'rssGrowthMB')],
  ['host arrayBuffers peak MB', (r) => hostP(r, 'arrayBuffersPeakMB')],
  ['host loop p99 ms', (r) => hostP(r, 'eldP99')],
  ['viewer loop p99 ms (max)', (r) => viewersMax(r, 'eldP99')],
  ['loop p99 ms (any process)', (r) => allP(r, 'eldP99')],
  ['loop max ms (any process)', (r) => allP(r, 'eldMax')],
  ['host CPU %', (r) => hostP(r, 'cpuPct')],
  ['viewer CPU % (max)', (r) => viewersMax(r, 'cpuPct')],
  ['host ELU %', (r) => hostP(r, 'eluPct')],
  ['re-attach: bt opened ms', (r) => get(r, 'reattach.chOpened')],
  ['re-attach: wire ms', (r) => get(r, 'reattach.wire')],
  ['re-attach: first data ms', (r) => get(r, 'reattach.firstData')],
  ['host UDX srtt ms p50', (r) => get(r, 'udx.srttMsP50')],
  ['host UDX srtt ms p95', (r) => get(r, 'udx.srttMsP95')],
  ['host UDX inflight KB p50', (r) => get(r, 'udx.inflightKBP50')],
  ['host UDX inflight KB max', (r) => get(r, 'udx.inflightKBMax')],
  ['host UDX retransmits', (r) => get(r, 'udx.retransmits')],
  ['host live wires at end', (r) => r.live?.host?.wires ?? null],
  ['relay CPU % (transfer)', (r) => get(r, 'relay.stats.cpuPctTransfer')],
  ['relay RSS peak MB', (r) => get(r, 'relay.stats.rssPeakMB')],
  ['load avg (1 min) before', (r) => r.env?.loadavgBefore?.[0] ?? null],
  ['host source reads / upload', (r) => {
    const a = get(r, 'storeStats.bytes')
    const b = get(r, 'throughput.hostUploadedMB')
    return a !== null && b ? a / 1e6 / b : null
  }],
]

const order = ['lo-strict', 're-rep', 're-repfix', 'lo-fixreqq', 'ne-udx', 'ne-reqq256', 'ne-reqq32', 'lo-soft', 'lo1v-strict', 'op-strict', 're-strict', 'rl-strict', 'lo-dl50', 'lo-reqq', 'ne-strict', 'ne-soft', 'ne-up', 'ne-up78', 'rlne-strict']
const names = [...groups.keys()].sort((a, b) => (order.indexOf(a) + 99) % 99 - ((order.indexOf(b) + 99) % 99))
const summary: Record<string, Record<string, number | string | null>> = {}
for (const g of names) {
  const rs = groups.get(g)!
  const ok = rs.filter((r) => !r.failure && r.throughput)
  const s: Record<string, number | string | null> = {
    'runs ok': `${ok.length}/${rs.length}`,
    failures: rs.filter((r) => r.failure).map((r) => `${r.label}: ${r.failure}`).join('; ') || null,
    'all paths relayed': ok.every((r) => (r.paths ?? []).every((p: string) => p.endsWith(':relayed'))) ? 'yes' : 'no',
    'source unchanged (size+mtime)': rs.every((r) => r.source?.unchanged) ? 'yes' : 'NO',
    'viewers done (min of runs)': Math.min(...ok.map((r) => r.throughput.perViewer.filter((v: any) => v.done).length)),
  }
  for (const [name, f] of cols.slice(1)) s[name] = med(ok, f)
  summary[g] = s
}
writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2))

const rows = ['runs ok', 'viewers done (min of runs)', ...cols.slice(1).map(([n]) => n), 'all paths relayed', 'source unchanged (size+mtime)']
console.log(`| metric (median of runs) | ${names.join(' | ')} |`)
console.log(`|---|${names.map(() => '---').join('|')}|`)
for (const row of rows) {
  const vals = names.map((g) => summary[g]![row])
  if (vals.every((v) => v === null)) continue
  console.log(`| ${row} | ${vals.map((v) => (typeof v === 'number' ? r1(v) : (v ?? '—'))).join(' | ')} |`)
}
for (const g of names) if (summary[g]!.failures) console.log(`\n${g} failures: ${summary[g]!.failures}`)
