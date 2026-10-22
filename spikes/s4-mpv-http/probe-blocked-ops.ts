// What still works while mpv's stream reader is blocked on a missing byte (readahead past readyRange)?
// Loads <fixture> at 300 s with only the S4 'fixed' ranges available, waits until the reader blocks, then:
//   1. sub-add of an (available) external .srt over HTTP → time, track-list
//   2. set aid=2 + unpause → does playback advance? (refresh seek behind the blocked read)
//   3. recovery: loadfile replace start=<time-pos>,pause=no,aid=2 → playback-restart time, advancing?
// Usage: npx tsx probe-blocked-ops.ts [fixture ...]
//   env SKIP_SET=1                 skip step 2 (go straight to the reload)
//   env RELOAD_OPT=aid=2|alang=jpn|aid=2,alang=jpn|on-file-loaded   how the reload carries the audio choice
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LoggingServer } from './server.js'
import { Mpv } from './mpv.js'
import { DATA, loadGolden, roundOut } from './ranges.js'

const RELOAD_OPT = process.env.RELOAD_OPT ?? 'aid=2' // how the reload carries the audio choice
const fixtures = process.argv.slice(2).length ? process.argv.slice(2) : ['mkv-cues.mkv', 'mp4-faststart.mp4']
for (const file of fixtures) {
  const g = loadGolden(file)
  const srv = new LoggingServer(DATA); await srv.listen()
  srv.setAvailable(file, roundOut([...g.openCriticalFixed, ...g.seekCritical, g.readyRange['300000'].fixed], g.pieceLength, g.size))
  const mpv = new Mpv(`blocked-ops-${file}`); mpv.t0 = srv.t0
  const res: Record<string, unknown> = { file }
  try {
    await mpv.start({})
    await mpv.observe('paused-for-cache')
    let r = mpv.waitEvent('playback-restart', 10000)
    await mpv.command(['loadfile', srv.url(file), 'replace', -1, 'start=300,pause=yes'])
    await r
    for (let i = 0; i < 40 && !srv.log.some(q => q.file === file && q.tClose === null && q.blocked.some(b => b.tReleased === null)); i++) await sleep(50)
    res.readerBlocked = srv.log.some(q => q.file === file && q.tClose === null && q.blocked.some(b => b.tReleased === null))
    // 1. sub-add while blocked
    let t = performance.now()
    const subOk = await mpv.command(['sub-add', srv.url('subs.srt'), 'auto', 'SRT ext', 'eng'], 5000).then(() => true, e => String(e))
    res.subAddWhileBlocked = { ok: subOk, ms: +(performance.now() - t).toFixed(1), subTracks: ((await mpv.get('track-list')) as any[]).filter(x => x.type === 'sub').length }
    // 2. aid switch while blocked
    if (!process.env.SKIP_SET) await mpv.set('aid', 2) // SKIP_SET=1: go straight to the reload path
    await mpv.set('pause', false)
    const p0 = Number(await mpv.get('time-pos')); await sleep(3000); const p1 = Number(await mpv.get('time-pos'))
    res.aidSwitchWhileBlocked = { advancedIn3s: +(p1 - p0).toFixed(2), pausedForCache: mpv.props['paused-for-cache'] }
    // 3. recovery through the reload path, carrying aid
    t = srv.now()
    r = mpv.waitEvent('playback-restart', 10000)
    // RELOAD_OPT=on-file-loaded: no option in loadfile; set aid=2 as soon as 'file-loaded' arrives
    if (RELOAD_OPT === 'on-file-loaded') mpv.once('file-loaded', () => { void mpv.set('aid', 2) })
    await mpv.command(['loadfile', srv.url(file), 'replace', -1, `start=${p1},pause=no${RELOAD_OPT === 'on-file-loaded' ? '' : ',' + RELOAD_OPT}`])
    const tr = await r
    const q0 = Number(await mpv.get('time-pos')); await sleep(2000); const q1 = Number(await mpv.get('time-pos'))
    res.reloadWithAid = { opt: RELOAD_OPT, restartMs: tr === null ? null : +(tr - t).toFixed(1), aid: await mpv.get('aid'), lang: await mpv.get('current-tracks/audio/lang').catch(() => null), advancedIn2s: +(q1 - q0).toFixed(2) }
  } finally { await mpv.quit(); await srv.close() }
  console.log(JSON.stringify(res))
  writeFileSync(join(DATA, 'results', `blocked-ops-${file}.json`), JSON.stringify(res, null, 1))
}
