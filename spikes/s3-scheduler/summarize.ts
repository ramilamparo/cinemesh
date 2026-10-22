// Prints the tables used in docs/adr/0003 from data/results/*.json (written by run-all.sh).
//   npx tsx spikes/s3-scheduler/summarize.ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './lib/net.js'

const dir = join(DATA_DIR, 'results')
const load = (name: string): any => {
  const p = join(dir, `${name}.json`)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN
}
const group = (prefix: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.json') && (f === `${prefix}.json` || new RegExp(`^${prefix}-\\d+\\.json$`).test(f)))
    .map((f) => {
      const r = load(f.slice(0, -5))
      if (r) r.__name = f.slice(0, -5)
      return r
    })
    .filter(Boolean)

console.log('## Part A (per run)')
for (const prefix of [
  'a-default',
  'a-churn',
  'a-delay25',
  'a-sentinel',
  'a-batched-churn',
  'a-independent',
  'a-patched',
  'a-patched-churn',
]) {
  for (const r of group(prefix)) {
    const ev = Object.fromEntries(r.events.map((e: any) => [e.event, e]))
    // first request on the host wire after each mark, from the raw log (the host has every piece)
    const raw = load(`../${r.__name}`)
    const viaHost = (label: string) => {
      const m = raw?.marks.find((x: any) => x.label === label)
      const q = m && raw.reqs.find((x: any) => x.peer === 'host' && x.t > m.t)
      return q ? `${q.piece}@+${Math.round(q.t - m.t)}ms` : '?'
    }
    // first host-wire request for a piece below p (L3, the wrap) after a seek mark, before an optional end mark
    const hostFirstBelow = (label: string, p: number, endLabel?: string) => {
      const m = raw?.marks.find((x: any) => x.label === label)
      const e = endLabel ? raw?.marks.find((x: any) => x.label === endLabel) : null
      const urgent = [...(ev['crit cues']?.urgent ?? []), ...(ev.blocked?.urgent ?? [])]
      const q =
        m &&
        raw.reqs.find(
          (x: any) =>
            x.peer === 'host' &&
            x.t > m.t &&
            (!e || x.t < e.t) &&
            x.piece < p &&
            !urgent.some(([a, b]: number[]) => x.piece >= a! && x.piece <= b!),
        )
      return q ? `${q.piece}@+${Math.round(q.t - m.t)}ms` : 'none'
    }
    const s0 = ev['seek 0%'],
      s40 = ev['seek 40%'],
      s90 = ev['seek 90%'],
      bl = ev.blocked
    console.log(
      [
        prefix,
        `dur=${r.durationS}s`,
        `replans=${r.replans}`,
        `firstReq(seek0)=${s0.firstRequest}`,
        `seek40 first=${s40.firstRequest} host=${s40.firstViaHost} outside=${JSON.stringify(s40.outsideBeforeWindowFull)} strict=${s40.outsideWhilePeerHadWindowPiece} L3<L2=${JSON.stringify(s40.L3beforeL2Full)} strictL3=${s40.L3whilePeerHadL2Piece}`,
        `cues first=${ev['crit cues'].firstRequest} host=${viaHost('crit cues')}`,
        `blocked expect=${bl.expectFirst} first=${bl.firstRequest} host=${viaHost('blocked')} (${bl.note})`,
        `seek0 host=${viaHost('seek 0%')} outside=${JSON.stringify(s0.outsideBeforeWindowFull)}`,
        `seek90 first=${s90.firstRequest} outside=${JSON.stringify(s90.outsideBeforeWindowFull)} strict=${s90.outsideWhilePeerHadWindowPiece} L2full=${s90.L2fullyRequestedMs} L3<L2=${JSON.stringify(s90.L3beforeL2Full)} strictL3=${s90.L3whilePeerHadL2Piece} firstL3=${s90.firstL3}`,
        `seek90 host: firstL3=${hostFirstBelow('seek 90%', s90.p)} vs L2full=+${s90.L2fullyRequestedMs}ms; seek40 host: firstL3=${hostFirstBelow('seek 40%', s40.p, 'seek 90%')} vs L2full=${s40.L2fullyRequestedMs}`,
        `dups=${r.duplicateBlocks} hotswaps=${r.hotswaps} inReplan=${r.requestsDuringReplan} choked=${r.chokedRequests}`,
        `states: mismatch=${r.pieceStates.bitfieldMismatch} leftVerified=${r.pieceStates.leftVerified} 1->0=${r.pieceStates.oneToZero} med=${r.pieceStates.medianUs}us`,
      ].join('\n   '),
    )
  }
}

console.log('\n## Part B (median of runs)')
for (const prefix of [
  'b-baseline',
  'b-stripe',
  'b-stripe-plan8s',
  'b-stripe-drop',
  'b-stripe-drop-connected',
  'b-stripe-nodeadline',
  'b-baseline-delay25',
  'b-stripe-delay25',
  'b-stripe-vup4',
  'b-stripe-drop-vup4',
  'b-stripe-drop-connected-vup4',
  'b-stripe-R2',
  'b-stripe-R8',
  'b-load7-baseline',
  'b-load7-stripe',
  'b-load7-stripe-R2',
  'b-tight-baseline',
  'b-tight-stripe',
  'b-tight-stripe-R2',
  'b-tight-stripe-R2-nodeadline',
]) {
  const rs = group(prefix)
  if (!rs.length) continue
  const m = (f: (r: any) => number) => median(rs.map(f))
  const all = (f: (r: any) => number) => rs.map(f).join('/')
  console.log(
    `${prefix.padEnd(30)} n=${rs.length} dup=${m((r) => r.host.dupFactor).toFixed(2)} [${all((r) => r.host.dupFactor)}] ` +
      `dup>10s=${m((r) => r.host.dupFactorAfter10s).toFixed(2)} served=${m((r) => r.host.servedMB)}MB distinct=${m((r) => r.host.distinctMB)}MB ` +
      `stalls=${m((r) => r.stalls.count)} [${all((r) => r.stalls.count)}] unrevealed=${m((r) => r.host.servedUnrevealedBlocks)} ` +
      `ahead=${m((r) => Math.min(...r.viewers.map((v: any) => v.contiguousFrom0)) - r.playheadEndPiece)} ` +
      `up=[${rs[0].viewers.map((v: any) => v.upMB).join(',')}]` +
      (rs[0].revealer
        ? ` rescues=${m((r) => r.revealer.rescues)} everyone=${JSON.stringify(rs[0].revealer.everyone)} have p50/p95=${m((r) => r.revealer.revealToHaveReceivedMs.p50)}/${m((r) => r.revealer.revealToHaveReceivedMs.p95)}ms req p50/p95=${m((r) => r.revealer.revealToRequestMs.p50)}/${m((r) => r.revealer.revealToRequestMs.p95)}ms`
        : ''),
  )
}

for (const n of ['bench', 'hook', 'bounds', 'bounds-sentinel', 'bounds-patched']) {
  const r = load(n)
  console.log(`\n## ${n}\n${JSON.stringify(r)}`)
}
