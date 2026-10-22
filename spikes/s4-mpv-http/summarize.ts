// Summarizes data/results/open-seek-*.json (written by run-open-seek.ts) into one Markdown table:
// medians over reps of restart times, worst-case parallel requests / overlap, bytes outside the golden ranges.
// Usage: npx tsx summarize.ts [mode ...]   (e.g. fixed-p16k fixed-join-p16k)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA, FIXTURES } from './ranges.js'

const dir = join(DATA, 'results')
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ['free', 'gated', 'gated-join', 'fixed', 'fixed-join']
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const fmt = (x: number | null, unit = 'ms') => x === null ? '—' : `${Math.round(x)} ${unit}`
const runs = readdirSync(dir).filter(f => /^open-seek-.*-\d\.json$/.test(f) && !f.endsWith('.log.json')).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))

console.log('| fixture | mode | n | open → restart | seek → restart | watchdog reload → restart | max parallel | max overlap | reconnects | bytes from requests that start outside the golden ranges |')
console.log('|---|---|---|---|---|---|---|---|---|---|')
for (const file of FIXTURES) {
  for (const mode of MODES) {
    const rs = runs.filter(r => r.file === file && r.mode === mode && r.phases)
    if (!rs.length) continue
    const ph = (r: any, n: string) => r.phases.find((p: any) => p.phase === n)
    const open = rs.map(r => ph(r, 'open')).filter(Boolean)
    const seek = rs.map(r => ph(r, 'seek')).filter(Boolean)
    const openOk = open.filter((p: any) => p.restartMs !== null)
    const seekDirect = seek.filter((p: any) => p.restartMs !== null && p.restartMs < 3000)
    const wd = rs.flatMap(r => (r.notes as string[]).map(n => /watchdog reload → playback-restart in (\d+) ms/.exec(n)).filter(Boolean).map(m => Number(m![1])))
    const wdFail = rs.filter(r => (r.notes as string[]).some(n => n.includes('NONE'))).length
    const both = [...open, ...seek] as any[]
    const openStr = openOk.length === open.length ? fmt(med(openOk.map((p: any) => p.restartMs))) : `NONE ×${open.length - openOk.length}`
    const seekStr = mode.includes('join') ? 'n/a' : seekDirect.length ? `${fmt(med(seekDirect.map((p: any) => p.restartMs)))} (${seekDirect.length}/${seek.length})` : seek.length ? `none in 3 s (${seek.length}/${seek.length})` : (open.length - openOk.length ? 'not reached' : '—')
    const wdStr = wd.length ? `${fmt(med(wd))} (${wd.length}${wdFail ? `, NONE ×${wdFail}` : ''})` : wdFail ? `NONE ×${wdFail}` : '—'
    const outE = Math.max(...both.map(p => p.outsideExactNotReadahead))
    console.log(`| ${file} | ${mode} | ${rs.length} | ${openStr} | ${seekStr} | ${wdStr} | ${Math.max(...both.map(p => p.maxParallel))} | ${Math.max(...both.map(p => p.maxOverlapMs)).toFixed(1)} ms | ${Math.max(...both.map(p => p.reconnects))} | ${(outE / 1024).toFixed(0)} KiB |`)
  }
}
