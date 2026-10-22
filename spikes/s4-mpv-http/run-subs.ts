// sub-add of .srt and .ass over HTTP; embedded ASS + attached font at the tail of mkv-tail.mkv.
// Checks track-list, sub-text at 32 s, and renders a screenshot with subtitles (--vo=null keeps the
// last decoded frame; screenshot-to-file … subtitles draws the subs in software via libass).
// Also: what sub-add does while the subtitle file is withheld.
import { setTimeout as sleep } from 'node:timers/promises'
import { statSync, mkdirSync } from 'node:fs'
import { LoggingServer } from './server.js'
import { Mpv, SCRATCH } from './mpv.js'
import { DATA } from './ranges.js'

const shots = `${DATA}results/shots`; mkdirSync(shots, { recursive: true })
const srv = new LoggingServer(DATA); await srv.listen()
const out: Record<string, unknown> = {}
const mpv = new Mpv('subs'); mpv.t0 = srv.t0
const load = async (file: string, start: number) => {
  const r = mpv.waitEvent('playback-restart', 10000)
  await mpv.command(['loadfile', srv.url(file), 'replace', -1, `start=${start},pause=yes`])
  return await r
}
const subTracks = async () => ((await mpv.get('track-list')) as any[]).filter(t => t.type === 'sub').map(t => ({ id: t.id, title: t.title, lang: t.lang, codec: t.codec, external: t.external, selected: t.selected, filename: t['external-filename'] }))
const shot = async (name: string, mode = 'subtitles') => {
  const path = `${shots}/${name}.png`
  try { await mpv.command(['screenshot-to-file', path, mode], 10000); return { path, bytes: statSync(path).size } } catch (e) { return { error: String(e) } }
}
try {
  await mpv.start({ extra: ['--screenshot-format=png', '--sub-font-provider=auto'] })
  out.clientNameIpcServer = await mpv.command(['client_name'])
  await load('mkv-cues.mkv', 32)
  out.noSub = await shot('no-sub', 'video')
  for (const [file, title] of [['subs.srt', 'SRT ext'], ['subs.ass', 'ASS ext']]) {
    const n = srv.log.length
    const t = performance.now()
    await mpv.command(['sub-add', srv.url(file), 'auto', title, 'eng'])
    const addMs = performance.now() - t
    const tracks = await subTracks()
    const tr = tracks.find(x => x.title === title)!
    const selectedAfterAuto = tr.selected
    await mpv.set('sid', tr.id)
    await sleep(300)
    out[file] = {
      addMs: +addMs.toFixed(1), track: tr, selectedAfterAuto, subText: await mpv.get('sub-text'),
      requests: srv.log.slice(n).map(r => `${r.method} ${r.range ?? '(no range)'} sent=${r.sent}`),
      shot: await shot(file.replace('.', '-')),
    }
  }
  // embedded ASS with the font in Attachments at the tail
  await load('mkv-tail.mkv', 32)
  const sidDefault = await mpv.get('sid')
  await mpv.set('sid', 1)
  await sleep(500)
  out['mkv-tail embedded'] = { tracks: await subTracks(), sidDefault, sid: await mpv.get('sid'), subText: await mpv.get('sub-text').catch(e => String(e)), shot: await shot('mkv-tail-embedded') }
  // sub-add while the subtitle file is withheld
  await load('mkv-cues.mkv', 32)
  srv.withhold('subs.srt', [0, 1 << 30])
  await mpv.set('pause', false)
  const t = performance.now()
  const add = mpv.command(['sub-add', srv.url('subs.srt'), 'auto', 'blocked', 'eng'], 20000).then(() => performance.now() - t, e => String(e))
  await sleep(500)
  const t2 = performance.now()
  const probe = await mpv.get('time-pos').then(v => ({ v, ms: performance.now() - t2 }), e => ({ v: String(e), ms: performance.now() - t2 }))
  const tp1 = probe.v
  await sleep(2000)
  const tp2 = await mpv.get('time-pos').catch(e => String(e))
  srv.release('subs.srt')
  out.blockedSubAdd = { getPropertyDuringBlockedAdd: probe, timePosBefore: tp1, timePos2sLater: tp2, subAddResolvedMs: await add }
} finally {
  await mpv.quit(); await srv.close()
}
console.log(JSON.stringify(out, null, 1))
console.log('mpv log:', `${SCRATCH}/subs.log`)
