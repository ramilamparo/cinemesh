// Stall behaviour: withhold the bytes of [20 s, 40 s) of the fixture, play from 0 until mpv stalls
// at ~20 s, hold for --hold seconds, then one of:
//   --after watchdog      seek to 400 s while blocked; if no playback-restart in 3 s, loadfile replace start=400
//   --after release-seek  seek to 400 s while blocked; release the range 3 s later
//   --after release       release the range (no seek) and time until playback resumes
//   --after destroy-seek  seek to 400 s while blocked; 200 ms later the server destroys the blocked
//                         response (range stays withheld) — does the seek then complete?
//   --after cache-seek    seek to 5 s (inside the demuxer cache) while blocked
//   --after destroy-503   same, and FFmpeg's reconnect at the blocked offset gets one 503 (or -404, -416)
// Usage: npx tsx run-stall.ts --fixture mkv-cues.mkv --nt 0 --hold 300 --after watchdog --tag a
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { LoggingServer } from './server.js'
import { Mpv, SCRATCH } from './mpv.js'
import { DATA, loadGolden, roundOut } from './ranges.js'

const a = process.argv.slice(2)
const opt = (n: string, d: string) => { const i = a.indexOf(n); return i < 0 ? d : a[i + 1] }
const file = opt('--fixture', 'mkv-cues.mkv')
const nt = Number(opt('--nt', '0'))
const hold = Number(opt('--hold', '300'))
const after = opt('--after', 'watchdog')
const tag = opt('--tag', 'x')
const OUT = join(DATA, 'results'); mkdirSync(OUT, { recursive: true })
const name = `stall-${file}-nt${nt}-h${hold}-${after}-${tag}`

const g = loadGolden(file)
const srv = new LoggingServer(DATA); await srv.listen()
const W = roundOut([[g.readyRange['20000'].fixed[0], g.keyframes.find(k => k[0] >= 40000)![1]]], g.pieceLength, g.size)[0]
srv.withhold(file, W)
const mpv = new Mpv(name); mpv.t0 = srv.t0
const res: Record<string, unknown> = { file, nt, hold, after, withheld: W }
const timeline: string[] = []
const note = (s: string) => { timeline.push(`${srv.now().toFixed(0)} ms: ${s}`) }
srv.on('request', r => note(`request #${r.id} conn${r.conn}/${r.connReq} ${r.range}`))
srv.on('blocked', (r, at) => note(`request #${r.id} blocked at ${at}`))
try {
  await mpv.start({ networkTimeout: nt })
  await mpv.observe('paused-for-cache', 'eof-reached', 'idle-active', 'time-pos', 'seeking', 'core-idle')
  mpv.on('event', (m: any) => { if (!['property-change', 'log-message'].includes(m.event)) note(`mpv event ${m.event}${m.reason ? ' ' + m.reason : ''}${m.file_error ? ' ' + m.file_error : ''}`) })
  mpv.on('prop', (n: string, v: unknown) => { if (n === 'paused-for-cache' || n === 'eof-reached' || n === 'idle-active') note(`${n}=${v}`) })
  const r0 = mpv.waitEvent('playback-restart', 10000)
  await mpv.command(['loadfile', srv.url(file), 'replace', -1, 'start=0,pause=yes'])
  await r0
  await mpv.set('pause', false)
  const tStall = await mpv.waitProp('paused-for-cache', v => v === true, 60000)
  res.stallAtPos = await mpv.get('time-pos')
  note(`stalled at time-pos ${res.stallAtPos}`)
  const reqsBefore = srv.log.length
  // hold, sampling every 5 s
  const holdEnd = srv.now() + hold * 1000
  while (srv.now() < holdEnd) {
    await sleep(Math.min(5000, holdEnd - srv.now()))
    if (mpv.exitCode !== null) { note('mpv exited'); break }
  }
  res.holdObserved = { stalledFromMs: tStall, newRequestsDuringHold: srv.log.length - reqsBefore, eofReached: mpv.props['eof-reached'], pausedForCache: mpv.props['paused-for-cache'], idle: mpv.props['idle-active'], timePos: await mpv.get('time-pos').catch(() => null) }
  note(`hold done: ${JSON.stringify(res.holdObserved)}`)
  if (after === 'release') {
    const t = srv.now(); srv.release(file)
    const tr = await mpv.waitProp('paused-for-cache', v => v === false, 10000)
    const tp0 = Number(await mpv.get('time-pos')); await sleep(1000); const tp1 = Number(await mpv.get('time-pos'))
    res.releaseToResumeMs = tr === null ? null : tr - t
    res.advancingAfterRelease = tp1 - tp0
  } else if (after === 'cache-seek') {
    res.cacheState = await mpv.get('demuxer-cache-state').then((c: any) => c['seekable-ranges']).catch(e => String(e))
    const t = srv.now()
    const r = mpv.waitEvent('playback-restart', 5000)
    await mpv.command(['seek', 5, 'absolute+exact'])
    const rr = await r
    res.cacheSeekRestartMs = rr === null ? null : rr - t
    res.timePosAfter = await mpv.get('time-pos').catch(() => null)
  } else {
    let t = srv.now()
    const rs = mpv.waitEvent('playback-restart', after === 'watchdog' ? 3000 : 30000)
    await mpv.command(['seek', 400, 'absolute+exact'])
    if (after === 'destroy-seek' || after.startsWith('destroy-')) {
      await sleep(200)
      const tD = srv.now()
      const st = Number(after.split('-')[1])
      if (st) srv.failStatus.set(file, st)
      srv.destroyBlocked(file)
      const r = await mpv.waitEvent('playback-restart', 5000)
      res.destroyToRestartMs = r === null ? null : r - tD
      res.seekRestartBeforeDestroy = mpv.events.some(e => e.event === 'playback-restart' && e.t > t && e.t < tD)
    } else if (after === 'release-seek') {
      await sleep(3000)
      res.seekRestartBeforeRelease = mpv.events.some(e => e.event === 'playback-restart' && e.t > t)
      const tRel = srv.now(); srv.release(file)
      const r = await rs
      res.releaseToRestartMs = r === null ? null : r - tRel
    } else {
      const r = await rs
      res.seekWhileBlockedRestartMs = r === null ? null : r - t
      if (r === null) {
        t = srv.now()
        const rw = mpv.waitEvent('playback-restart', 15000)
        await mpv.command(['loadfile', srv.url(file), 'replace', -1, 'start=400,pause=yes'])
        const r2 = await rw
        res.watchdogReloadToRestartMs = r2 === null ? null : r2 - t
      }
    }
    res.timePosAfter = await mpv.get('time-pos').catch(() => null)
  }
} finally {
  await mpv.quit()
  await srv.close()
  // mpv log lines about network trouble after the stall
  try {
    const log = readFileSync(`${SCRATCH}/${name}.log`, 'utf8').split('\n')
    res.mpvLogNetwork = log.filter(l => /reconnect|timed out|timeout|Connection|EOF|error|Will reconnect|end of file|Immediate exit/i.test(l) && !/Command line options|option|property/.test(l)).slice(0, 40)
  } catch {}
  res.requests = srv.log.map(r => ({ id: r.id, conn: r.conn, range: r.range, tOpen: r.tOpen, tClose: r.tClose, sent: r.sent, closedBy: r.closedBy, blocked: r.blocked }))
  res.timeline = timeline
  writeFileSync(join(OUT, name + '.json'), JSON.stringify(res, null, 1))
  const { requests, timeline: _t, mpvLogNetwork, ...summary } = res
  console.log(name, JSON.stringify(summary))
}
