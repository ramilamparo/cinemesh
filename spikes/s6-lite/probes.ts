// Small probes behind ADR 0007's findings, through the production PlayerController (as in s6.ts):
//   landing     where an exact seek lands: targets 0…39 ms past a frame, paused; time-pos after playback-restart
//   speed-step  audio-pts at ~100 Hz around set_property speed: the step at the change and when the new rate shows
//   paused      audio-pts while paused: after a fresh load, after a pause from playback, after paused seeks
//   reload      loadfile at a position, paused (the member's loads and the player's reload path): time to
//               playback-restart, where it lands and the paused audio-pts; then a paused exact seek, for comparison
//   npx tsx spikes/s6-lite/probes.ts landing|speed-step|paused|reload [--source local|stream] [--fixtures <dir>]
//     [--mpv-arg=--ao-null-buffer=0.05]...
// Silent: --vo=null --ao=null. --mpv-arg adds mpv options (e.g. the null AO's own) and refuses output selections.

import { execFileSync } from 'node:child_process'
import { open } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { StreamServer } from '../../src/core/media/stream-server.js'
import { FakeSource } from '../../src/core/media/testing/fake-source.js'
import { parseMpvVersion } from '../../src/core/player/mpv-version.js'
import { PlayerController } from '../../src/core/player/player-controller.js'
import { defaultSettings } from '../../src/shared/settings.js'
import { themePayload } from '../../src/shared/theme-tokens.js'
import { LONG, fixture } from '../../test/integration/media/fixtures.js'
import { fitLine, landingMs, lineAt, summary } from './lib.js'

const REPO = resolve(import.meta.dirname, '../..')
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fixtures: { type: 'string' },
    source: { type: 'string', default: 'local' },
    trials: { type: 'string', default: '20' },
    'mpv-arg': { type: 'string', multiple: true },
  },
})
const which = positionals[0] ?? 'landing'
const STREAM = values.source === 'stream'
const mpvArgs = values['mpv-arg'] ?? []
// nothing may make a sound or open a window: only the null outputs, and their options
for (const a of mpvArgs) {
  if (/^--(ao|vo|audio-device|audio-spdif|af|vf|vd|ad)(=|$)/.test(a)) throw new Error(`--mpv-arg ${a}: not allowed`)
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const version = parseMpvVersion(execFileSync('mpv', ['--version'], { encoding: 'utf8' }))
if (!version) throw new Error('mpv --version: unparsable')
const path = await fixture('mkv-cues.mkv', {
  ...LONG,
  dir: resolve(values.fixtures ?? '/tmp/wt-s6-fixtures'),
  durationS: 300,
})
// stream: as a viewer plays it, through the StreamServer, every piece present (as in s6.ts)
const fh = STREAM ? await open(path, 'r') : null
let server: StreamServer | null = null
let url = path
if (fh) {
  const size = (await fh.stat()).size
  const source = new FakeSource(
    [{ index: 0, name: basename(path), offset: 0, length: size }],
    256 * 1024,
    async (a, n) => {
      const buf = new Uint8Array(n)
      const { bytesRead } = await fh.read(buf, 0, n, a)
      return buf.subarray(0, bytesRead)
    },
  )
  source.releaseAll()
  server = await StreamServer.listen(source)
  url = server.url(0)
}
const srv = server
const player = new PlayerController({
  mpv: { path: 'mpv', kind: 'system', version },
  role: STREAM ? 'viewer' : 'host',
  resourcesDir: join(REPO, 'resources'),
  logFile: null,
  settings: defaultSettings(),
  theme: themePayload('dark', 'dark'),
  perms: { isHost: true, canPlayPause: true, canSeek: true },
  extraArgs: ['--vo=null', '--ao=null', ...mpvArgs],
  selfReload: false,
  hooks: srv ? { readerBlocked: () => srv.isBlocked(0) } : {},
})
const idle = new Promise<void>((res) => player.on('state', (s) => s === 'idle' && res()))
player.start()
await idle
await player.load(url, { start: 30, paused: true })
const frameMs = 1000 / Number((await player.getProperty('container-fps')).value)

if (which === 'landing') {
  const rows: string[] = []
  let mismatches = 0
  for (const base of [20, 31.24, 44.96, 101.2]) {
    for (const d of [0, 1, 3, 4.5, 4.9, 5.1, 6, 10, 20, 30, 39]) {
      const target = Math.round((base + d / 1000) * 1e6) / 1e6
      await player.seek(target)
      await sleep(30)
      const tp = Number((await player.getProperty('time-pos')).value)
      const ap = Number((await player.getProperty('audio-pts')).value)
      const predicted = landingMs(target, frameMs)
      if (Math.abs(tp * 1000 - predicted) > 0.5) mismatches++
      rows.push(
        `| ${target.toFixed(4)} | +${String(d)} | ${(tp * 1000 - target * 1000).toFixed(1)} | ` +
          `${(tp * 1000 - predicted).toFixed(1)} | ${(ap * 1000 - target * 1000).toFixed(1)} |`,
      )
    }
  }
  console.log(`frame ${frameMs.toFixed(3)} ms; rule: first frame ≥ target − 5 ms; ${String(mismatches)} mismatches`)
  console.log('| target s | past a frame, ms | time-pos − target | − rule | paused audio-pts − target |')
  console.log('| --- | --- | --- | --- | --- |')
  console.log(rows.join('\n'))
} else if (which === 'paused') {
  const seekTo = async (t: number): Promise<void> => {
    await player.seek(t)
    await sleep(50)
  }
  const show = async (label: string, ref: number): Promise<void> => {
    const ap = Number((await player.getProperty('audio-pts')).value)
    const tp = Number((await player.getProperty('time-pos')).value)
    console.log(`| ${label} | ${((ap - ref) * 1000).toFixed(1)} | ${((tp - ref) * 1000).toFixed(1)} |`)
  }
  const pos = async (): Promise<number> => Number((await player.getProperty('audio-pts')).value)
  console.log('| state | audio-pts − reference, ms | time-pos − reference, ms |')
  console.log('| --- | --- | --- |')
  await seekTo(40.02)
  await show('fresh load, paused seek to 40.02 (ref: target)', 40.02)
  await seekTo(50.02)
  await show('2nd paused seek, 50.02', 50.02)
  await player.setPaused(false)
  await sleep(2000)
  await player.setPaused(true)
  await sleep(50)
  await show('played 2 s, paused (ref: the paused audio-pts)', await pos())
  for (const t of [60.02, 70.02, 80.02]) {
    await seekTo(t)
    await show(`then paused seek to ${t.toFixed(2)}`, t)
  }
  await player.setPaused(false)
  await sleep(30)
  await player.setPaused(true)
  await sleep(50)
  await show('unpaused 30 ms, paused again', await pos())
  await seekTo(90.02)
  await show('then paused seek to 90.02', 90.02)
  await player.setPaused(false)
  await sleep(500)
  await seekTo(100.02)
  await sleep(300)
  await player.setPaused(true)
  await sleep(50)
  await show('seek while playing, then pause', await pos())
} else if (which === 'reload') {
  let seed = 4242
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const durationS = Number((await player.getProperty('duration')).value)
  const far = (): number => Math.round((20 + rnd() * (durationS - 60)) * 1000) / 1000
  const loads: number[] = []
  const seeks: number[] = []
  const aps: number[] = []
  const ap0s: number[] = []
  const landed: number[] = []
  let misses = 0
  const rows: string[] = []
  for (let i = 0; i < Number(values.trials); i++) {
    // as in a session: it played, then paused, before the load
    await player.setPaused(false)
    await sleep(1000)
    await player.setPaused(true)
    await sleep(100)
    const target = far()
    const t0 = performance.now()
    await player.load(url, { start: target, paused: true })
    const loadMs = performance.now() - t0
    // what the member's sample right at the restart sees (onPlaybackRestart → reconcile → settle → sample)
    const ap0 = Number((await player.getProperty('audio-pts')).value) * 1000
    await sleep(50)
    const tp = Number((await player.getProperty('time-pos')).value) * 1000
    const ap = Number((await player.getProperty('audio-pts')).value) * 1000
    const rule = landingMs(target, frameMs)
    if (Math.abs(tp - rule) > 0.5) misses++
    const t1 = performance.now()
    await player.seek(far())
    const seekMs = performance.now() - t1
    loads.push(loadMs)
    seeks.push(seekMs)
    aps.push(ap - target * 1000)
    ap0s.push(ap0 - target * 1000)
    landed.push(tp - target * 1000)
    rows.push(
      `| ${String(i)} | ${target.toFixed(3)} | ${loadMs.toFixed(1)} | ${(tp - target * 1000).toFixed(1)} | ` +
        `${(tp - rule).toFixed(1)} | ${(ap0 - target * 1000).toFixed(1)} | ${(ap - target * 1000).toFixed(1)} | ` +
        `${seekMs.toFixed(1)} |`,
    )
  }
  const sm = (xs: number[]): string => {
    const x = summary(xs)
    return `${x.p50.toFixed(1)} / ${x.p95.toFixed(1)} / ${x.min.toFixed(1)}…${x.max.toFixed(1)}`
  }
  console.log(
    `source ${STREAM ? 'stream' : 'local'}; frame ${frameMs.toFixed(3)} ms; ${String(misses)} landings off the rule`,
  )
  console.log(
    '| trial | target s | load → restart, ms | time-pos − target | − rule | audio-pts − target at the restart | … 50 ms later | then a paused seek → restart, ms |',
  )
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
  console.log(rows.join('\n'))
  console.log(`\np50 / p95 / min…max, ms: load → restart ${sm(loads)}; paused seek → restart ${sm(seeks)};`)
  console.log(
    `landing (time-pos − target) ${sm(landed)}; audio-pts − target at the restart ${sm(ap0s)}, 50 ms later ${sm(aps)}`,
  )
} else {
  interface S {
    t: number
    v: number
  }
  const grab = async (ms: number): Promise<S[]> => {
    const out: S[] = []
    const end = performance.now() + ms
    while (performance.now() < end) {
      const s = await player.getProperty<number>('audio-pts')
      out.push({ t: (s.tSend + s.tRecv) / 2, v: s.value * 1000 })
      await sleep(10)
    }
    return out
  }
  await player.setPaused(false)
  await sleep(1500)
  let speed = 1
  console.log('| speed | rate error, ppm | step at the change, ms | old and new lines meet, ms after the command |')
  console.log('| --- | --- | --- | --- |')
  for (const next of [1.02, 1, 0.98, 1, 1.05, 1, 0.95, 1, 1.002, 1]) {
    const pre = await grab(1000)
    const tC = performance.now()
    await player.setSpeed(next)
    const post = await grab(2500)
    const old = fitLine(
      pre.map((s) => s.t),
      pre.map((s) => s.v),
    )
    const early = post.filter((s) => s.t > tC + 50 && s.t < tC + 250)
    const late = post.filter((s) => s.t > tC + 1200)
    const e = fitLine(
      early.map((s) => s.t),
      early.map((s) => s.v),
      next,
    )
    const nw = fitLine(
      late.map((s) => s.t),
      late.map((s) => s.v),
    )
    if (!old || !e || !nw) continue
    // the early samples already advance at the new rate: extrapolate them back to the command
    const step = lineAt(e, tC) - lineAt(old, tC)
    const meet = (nw.icpt - old.icpt + old.slope * old.x0 - nw.slope * nw.x0) / (old.slope - nw.slope) - tC
    console.log(
      `| ${String(speed)} → ${String(next)} | ${((nw.slope / next - 1) * 1e6).toFixed(1)} | ${step.toFixed(2)} | ${meet.toFixed(0)} |`,
    )
    speed = next
  }
}
await player.dispose()
await server?.close()
await fh?.close()
