// Prints every request mpv makes for one `loadfile start=T` and one `seek T` (after loading at 10 s).
// Usage: npx tsx probe-requests.ts <fixture> <T>
import { LoggingServer } from './server.js'
import { Mpv } from './mpv.js'
import { DATA, loadGolden } from './ranges.js'
import { classify } from './analyze.js'
import { setTimeout as sleep } from 'node:timers/promises'

const [file, Ts = '301'] = process.argv.slice(2)
const T = Number(Ts)
const g = loadGolden(file)
const srv = new LoggingServer(DATA); await srv.listen()
const mpv = new Mpv(`probe-req-${file}`); mpv.t0 = srv.t0
const keys = Object.keys(g.readyRange)
const dump = (from: number, label: string, tRestart: number | null) => {
  console.log(`-- ${label} (restart at ${tRestart} ms)`)
  for (const q of srv.log.slice(from)) console.log(`  #${q.id} conn${q.conn}/${q.connReq} ${q.range} t=${q.tOpen}-${q.tClose} sent=${q.sent} by=${q.closedBy} [${classify(g, q.start, keys)}]`)
}
try {
  await mpv.start({})
  let n = srv.log.length
  let r = mpv.waitEvent('playback-restart', 15000)
  await mpv.command(['loadfile', srv.url(file), 'replace', -1, `start=${T},pause=yes`])
  dump(n, `loadfile start=${T}`, await r); await sleep(300)
  r = mpv.waitEvent('playback-restart', 15000)
  await mpv.command(['loadfile', srv.url(file), 'replace', -1, 'start=10,pause=yes']); await r; await sleep(300)
  n = srv.log.length
  r = mpv.waitEvent('playback-restart', 15000)
  await mpv.command(['seek', T, 'absolute+exact'])
  dump(n, `seek ${T} (after loadfile start=10)`, await r)
} finally { await mpv.quit(); await srv.close() }
