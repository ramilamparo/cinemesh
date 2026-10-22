// Which byte does mpv start reading at for `loadfile start=T` (and for `seek T absolute+exact`)?
// Maps the request start to the video keyframe it belongs to. Usage: npx tsx probe-seek-target.ts [fixture ...]
import { LoggingServer } from './server.js'
import { Mpv } from './mpv.js'
import { DATA, FIXTURES, loadGolden } from './ranges.js'
import { inRanges } from './analyze.js'
import { setTimeout as sleep } from 'node:timers/promises'

const fixtures = process.argv.slice(2).length ? process.argv.slice(2) : FIXTURES
const TARGETS = [300, 300.04, 300.5, 301, 301.96, 120]
await Promise.all(fixtures.map(async file => {
  const g = loadGolden(file)
  const srv = new LoggingServer(DATA); await srv.listen()
  const mpv = new Mpv(`probe-${file}`); mpv.t0 = srv.t0
  const out: string[] = []
  try {
    await mpv.start({})
    for (const how of ['loadfile', 'seek'] as const) {
      for (const T of TARGETS) {
        if (how === 'seek') {
          const r = mpv.waitEvent('playback-restart', 10000)
          await mpv.command(['loadfile', srv.url(file), 'replace', -1, 'start=10,pause=yes']); await r; await sleep(200)
        }
        const n = srv.log.length
        const r = mpv.waitEvent('playback-restart', 10000)
        if (how === 'loadfile') await mpv.command(['loadfile', srv.url(file), 'replace', -1, `start=${T},pause=yes`])
        else await mpv.command(['seek', T, 'absolute+exact'])
        const ok = await r
        await sleep(100)
        const starts = srv.log.slice(n).filter(q => q.method === 'GET' && !inRanges(q.start, g.openCritical) && !inRanges(q.start, g.seekCritical)).map(q => q.start)
        const first = starts[0]
        const kfBefore = g.keyframes.filter(k => k[1] <= first).at(-1)
        const kfT = g.keyframes.filter(k => k[0] <= T * 1000).at(-1)!
        out.push(`${how} T=${T}: restart=${ok !== null} firstRead=${first} (kf ≤ byte: t=${kfBefore?.[0]} pos=${kfBefore?.[1]}, delta=${first - (kfBefore?.[1] ?? 0)}); kf ≤ T: t=${kfT[0]} pos=${kfT[1]}`)
      }
    }
  } finally { await mpv.quit(); await srv.close() }
  console.log(`== ${file}\n${out.join('\n')}`)
}))
