// Audio switch: load at 300 s (free, or gated to the S4 'fixed' ranges), set aid=2, unpause 3 s.
// Usage: npx tsx probe-aid.ts <fixture> <free|fixed>
import { setTimeout as sleep } from 'node:timers/promises'
import { LoggingServer } from './server.js'
import { Mpv } from './mpv.js'
import { DATA, loadGolden, roundOut } from './ranges.js'

const [file, mode = 'free'] = process.argv.slice(2)
const g = loadGolden(file)
const srv = new LoggingServer(DATA); await srv.listen()
if (mode === 'fixed') srv.setAvailable(file, roundOut([...g.openCriticalFixed, ...g.seekCritical, g.readyRange['300000'].fixed], g.pieceLength, g.size))
const mpv = new Mpv(`aid-${file}-${mode}`); mpv.t0 = srv.t0
const res: Record<string, unknown> = { file, mode }
try {
  await mpv.start({})
  await mpv.observe('paused-for-cache')
  const r = mpv.waitEvent('playback-restart', 10000)
  await mpv.command(['loadfile', srv.url(file), 'replace', -1, 'start=300,pause=yes'])
  await r
  await sleep(500)
  const n = srv.log.length
  const t = srv.now()
  await mpv.set('aid', 2)
  await sleep(300)
  await mpv.set('pause', false)
  const p0 = Number(await mpv.get('time-pos'))
  await sleep(3000)
  const p1 = Number(await mpv.get('time-pos'))
  res.currentAudio = await mpv.get('current-tracks/audio/lang').catch(e => String(e))
  res.advancedIn3s = +(p1 - p0).toFixed(2)
  res.pausedForCache = mpv.props['paused-for-cache']
  res.eventsAfterSwitch = mpv.events.filter(e => e.t >= t).map(e => `${(e.t - t).toFixed(0)}ms ${e.event}${e.data !== undefined ? '=' + e.data : ''}`)
  res.requestsAfterSwitch = srv.log.slice(n).map(q => `${q.range} +${(q.tOpen - t).toFixed(0)}ms sent=${q.sent} blocked=${q.blocked.length}`)
} finally { await mpv.quit(); await srv.close() }
console.log(JSON.stringify(res))
