// Open → seek 50 % → audio switch, against the logging server, for each fixture.
// Modes:
//   free        everything available; logs what mpv reads.
//   gated       only openCritical ∪ seekCritical ∪ readyRange(0) available (piece-rounded); before the
//               seek readyRange(50 %) is added. Everything else blocks forever (no timeout).
//   gated-join  like gated but loadfile starts at 50 % directly (late joiner / watchdog reload path).
//   fixed, fixed-join  the same with the S4 rules (openCriticalFixed, readyRange.fixed).
// Usage: npx tsx run-open-seek.ts [--reps 3] [--modes free,gated,gated-join,fixed,fixed-join] [--par 4]
//          [--piece 16384 --tag -p16k] [fixture ...]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LoggingServer } from './server.js'
import { Mpv } from './mpv.js'
import { DATA, FIXTURES, loadGolden, roundOut, type Range } from './ranges.js'
import { phaseReport, openOf, type PhaseReport, type Variant } from './analyze.js'

const args = process.argv.slice(2)
const opt = (n: string, d: string) => { const i = args.indexOf(n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v }
const reps = Number(opt('--reps', '3'))
const modes = opt('--modes', 'free,gated,gated-join,fixed,fixed-join').split(',')
const par = Number(opt('--par', '4'))
const pieceOverride = Number(opt('--piece', '0')) // gate at this granularity instead of the torrent's piece length
const tag = opt('--tag', '') // appended to the mode in result names, e.g. '-p16k'
const only = opt('--jobs', '') // e.g. 'avi.avi:free:2,mkv-nocues.mkv:gated:3' reruns just these
const fixtures = args.length ? args : FIXTURES
const OUT = join(DATA, 'results'); mkdirSync(OUT, { recursive: true })
const WATCHDOG_MS = 3000

async function runOne (file: string, mode: string, rep: number) {
  const g = loadGolden(file)
  const half = Object.keys(g.readyRange).map(Number).sort((a, b) => a - b).at(-1)!
  const srv = new LoggingServer(DATA)
  await srv.listen()
  const v: Variant = mode.startsWith('fixed') ? 'fixed' : 'plan'
  const crit: Range[] = [...openOf(g, v), ...g.seekCritical]
  const isJoin = mode.endsWith('-join')
  const P = pieceOverride || g.pieceLength
  const startMs = isJoin ? half : 0
  if (mode !== 'free') srv.setAvailable(file, roundOut([...crit, g.readyRange[String(startMs)][v]], P, g.size))
  const mpv = new Mpv(`os-${file}-${mode}${tag}-${rep}`)
  mpv.t0 = srv.t0
  const phases: PhaseReport[] = []
  const notes: string[] = []
  try {
    await mpv.start({})
    await mpv.observe('paused-for-cache', 'eof-reached', 'seeking', 'track-list', 'aid', 'time-pos')
    const url = srv.url(file)
    // open
    let t = srv.now(); srv.mark('loadfile')
    const restart = mpv.waitEvent('playback-restart', 20000)
    await mpv.command(['loadfile', url, 'replace', -1, `start=${startMs / 1000},pause=yes`])
    const r0 = await restart
    phases.push(phaseReport(g, srv.log, 'open', t, r0 ?? srv.now(), [String(startMs)], r0 === null ? null : r0 - t, v))
    if (r0 === null) { notes.push('no playback-restart within 20 s of loadfile'); return { file, mode: mode + tag, rep, phases, notes } }
    const tl = (mpv.props['track-list'] as any[]) ?? []
    // seek (not for gated-join: it is already there)
    if (!isJoin) {
      if (mode !== 'free') srv.setAvailable(file, roundOut([...crit, g.readyRange['0'][v], g.readyRange[String(half)][v]], P, g.size))
      await sleep(300)
      t = srv.now(); srv.mark('seek')
      const rs = mpv.waitEvent('playback-restart', WATCHDOG_MS)
      await mpv.command(['seek', half / 1000, 'absolute+exact'])
      let r1 = await rs
      let restartMs = r1 === null ? null : r1 - t
      if (r1 === null) {
        notes.push(`seek: no playback-restart in ${WATCHDOG_MS} ms → watchdog loadfile replace start=${half / 1000}`)
        const tw = srv.now()
        const rw = mpv.waitEvent('playback-restart', 15000)
        await mpv.command(['loadfile', url, 'replace', -1, `start=${half / 1000},pause=yes`])
        r1 = await rw
        notes.push(`watchdog reload → playback-restart in ${r1 === null ? 'NONE (15 s)' : (r1 - tw).toFixed(0) + ' ms'}`)
        restartMs = r1 === null ? null : r1 - t
      }
      phases.push(phaseReport(g, srv.log, 'seek', t, r1 ?? srv.now(), ['0', String(half)], restartMs, v))
    }
    // audio switch
    const audios = tl.filter(x => x.type === 'audio')
    if (audios.length > 1) {
      await sleep(300)
      t = srv.now(); srv.mark('aid')
      const ra = mpv.waitEvent('playback-restart', 3000)
      await mpv.set('aid', 2)
      const r2 = await ra
      await sleep(r2 === null ? 0 : 500)
      phases.push(phaseReport(g, srv.log, 'aid', t, r2 === null ? srv.now() : r2 + 500, [String(half)], r2 === null ? null : r2 - t, v))
      const aid = await mpv.get('aid')
      notes.push(`aid switch: playback-restart ${r2 === null ? 'none in 3 s' : (r2 - t).toFixed(0) + ' ms'}; aid now ${aid}`)
    }
    return { file, mode: mode + tag, rep, phases, notes, tracks: tl.map(x => `${x.type}:${x.id}:${x.lang ?? ''}`) }
  } finally {
    await mpv.quit()
    await srv.close()
    writeFileSync(join(OUT, `open-seek-${file}-${mode}${tag}-${rep}.log.json`), JSON.stringify({ marks: srv.marks, log: srv.log.map(({ slices, ...r }) => ({ ...r, slices: slices.length })), mpvEvents: mpv.events }, null, 1))
  }
}

const jobs: [string, string, number][] = []
if (only) for (const j of only.split(',')) { const [f, m, r] = j.split(':'); jobs.push([f, m, Number(r)]) }
else for (const f of fixtures) for (const m of modes) for (let r = 1; r <= reps; r++) jobs.push([f, m, r])
const results: unknown[] = []
async function worker () {
  while (jobs.length) {
    const [f, m, r] = jobs.shift()!
    const res = await runOne(f, m, r).catch(e => ({ file: f, mode: m, rep: r, error: String(e) }))
    results.push(res)
    writeFileSync(join(OUT, `open-seek-${f}-${m}${tag}-${r}.json`), JSON.stringify(res, null, 1))
    const ph = (res as any).phases?.map((p: PhaseReport) => `${p.phase}:${p.restartMs === null ? 'NO-RESTART' : p.restartMs.toFixed(0) + 'ms'} req=${p.requests.length} par=${p.maxParallel} outNR=${p.outsideExactNotReadahead} starts=${p.requests.map(q => q.start + '/' + q.startClass).join(' ')}`).join(' | ')
    console.log(`${f} ${m}${tag} #${r}: ${ph ?? ''} ${((res as any).notes ?? []).join('; ')} ${(res as any).error ?? ''}`)
  }
}
await Promise.all(Array.from({ length: par }, worker))
