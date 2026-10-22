// End-to-end start alignment: the production SyncEngine (host role, no viewers, so θ̂ = 0) drives a real mpv
// through PlayerController and PlayerPortAdapter. After every start it measures D = audio-pts − expected, where
// expected(t) = anchor.pos + (t − anchor.hostTime), in the window before the drift loop may act (it holds for 1 s
// after an unpause, then needs 5 samples). Silent: --vo=null --ao=null.
//   npx tsx spikes/s6-lite/member-e2e.ts --out <dir> [--reps 8] [--seed 1] [--fixtures <dir>]
//
// The ways a start happens (each rep runs them all, seek targets random to the ms):
//   resume          playing → pause → play: the member reads the paused audio-pts and starts from it
//   paused-seek     paused → seek X → play: the member seeks, then starts from X
//   barrier-paused  playing → seek X and pause in the same turn: the seek barrier completes `paused`, then play
//   playing-seek    playing → seek X: the barrier completes `playing` once the member is ready at X
//   wait-after-seek paused → seek X → play while a member is not ready at X (a viewer still fetching it; here this
//                   member, by its media port): the room waits at X, then plays once it is ready
//   reload-paused   playing → pause → the same source loaded again while paused (a reopen) → play

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { parseMpvVersion } from '../../src/core/player/mpv-version.js'
import { PlayerController } from '../../src/core/player/player-controller.js'
import { PlayerPortAdapter, createClock } from '../../src/core/session/sync-ports.js'
import { SyncEngine } from '../../src/core/sync/engine.js'
import type { SyncState } from '../../src/core/sync/protocol.js'
import { defaultSettings } from '../../src/shared/settings.js'
import { themePayload } from '../../src/shared/theme-tokens.js'
import { type FixtureSet, LONG, fixture } from '../../test/integration/media/fixtures.js'
import { landingMs, median, summary } from './lib.js'

const REPO = resolve(import.meta.dirname, '../..')
const { values: argv } = parseArgs({
  options: {
    out: { type: 'string' },
    reps: { type: 'string', default: '8' },
    seed: { type: 'string', default: '1' },
    fixtures: { type: 'string' },
  },
})
if (argv.out === undefined) throw new Error('--out <dir> is required')
const OUT = resolve(argv.out)
const REPS = Number(argv.reps)
const SET: FixtureSet = { ...LONG, dir: resolve(argv.fixtures ?? join(OUT, 'fixtures')), durationS: 300 }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
let seed = Number(argv.seed) * 7919 + 17
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}

type Scenario = 'resume' | 'paused-seek' | 'barrier-paused' | 'playing-seek' | 'wait-after-seek' | 'reload-paused'
const SCENARIOS: Scenario[] = [
  'resume',
  'paused-seek',
  'barrier-paused',
  'playing-seek',
  'wait-after-seek',
  'reload-paused',
]
interface Start {
  scenario: Scenario
  rep: number
  target: number | null
  anchorPos: number
  /** D over [hostTime + 300, hostTime + 1000] ms, median and spread of the 50 ms samples */
  dMs: number
  dMinMs: number
  dMaxMs: number
  n: number
  /** where the exact seek lands (the first frame ≥ target − 5 ms), minus the target */
  frameUpMs: number | null
  unpauseLatMs: number
  seekLatMs: number
  /** barrier-paused, wait-after-seek: the state that made the member settle again came this long after the seek's restart */
  resettleAfterRestartMs: number | null
  loadavg: string
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })
  const versionText = execFileSync('mpv', ['--version'], { encoding: 'utf8' })
  const version = parseMpvVersion(versionText)
  if (!version) throw new Error('mpv --version: unparsable')
  const path = await fixture('mkv-cues.mkv', SET)
  const runDir = join(OUT, `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  await mkdir(runDir, { recursive: true })

  const clock = createClock()
  const logLines: string[] = []
  const log = (msg: string, e?: unknown): void => {
    logLines.push(`${performance.now().toFixed(1)} ${msg}${e === undefined ? '' : ` ${String(e)}`}`)
  }
  const player = new PlayerController({
    mpv: { path: 'mpv', kind: 'system', version },
    role: 'host',
    resourcesDir: join(REPO, 'resources'),
    logFile: join(runDir, 'mpv.log'),
    settings: defaultSettings(),
    theme: themePayload('dark', 'dark'),
    perms: { isHost: true, canPlayPause: true, canSeek: true },
    mediaTitle: basename(path),
    extraArgs: ['--vo=null', '--ao=null', '--script-opts=wt_osc-test-dims=1280x720'],
    selfReload: false,
    log: { debug: () => undefined, info: log, warn: log, error: log },
  })
  const port = new PlayerPortAdapter(player, { subtitles: () => [], title: null, log })
  const durationS = SET.durationS
  // the media port's readiness, switched off to play a member that is not ready yet (wait-after-seek)
  let ready = true
  const mediaListeners = new Set<() => void>()
  const setReady = (r: boolean): void => {
    ready = r
    for (const fn of mediaListeners) fn()
  }
  const engine = new SyncEngine({
    role: 'host',
    selfId: 'host',
    selfName: 'Host',
    hostId: 'host',
    nudge: true,
    host: {
      syncEpoch: 1,
      perms: { othersPlayPause: false, othersSeek: false },
      waitForAll: true,
      startMode: { kind: 'buffered', seconds: 0 },
    },
    ports: {
      clock,
      player: port,
      bus: { publish: () => undefined, onMessage: () => () => undefined, onPresence: () => () => undefined },
      datagram: { send: () => undefined, usable: () => false, onMessage: () => () => undefined },
      media: {
        durationS: () => durationS,
        readiness: () => ready,
        bufferedAheadS: () => 3600,
        needBps: () => 0,
        playhead: { set: () => undefined },
        onChange: (fn) => {
          mediaListeners.add(fn)
          return () => mediaListeners.delete(fn)
        },
      },
      transfer: { rateBps: () => 0, etaToEofS: () => 0, coverage: () => null, diskFull: () => false },
    },
  })
  const states: { t: number; st: SyncState }[] = []
  engine.on('state', (st) => states.push({ t: performance.now(), st }))
  const nextState = (pred: (st: SyncState) => boolean, ms = 15_000): Promise<SyncState> =>
    new Promise((res, rej) => {
      const timer = setTimeout(() => {
        engine.off('state', on)
        rej(new Error('no such state in time'))
      }, ms)
      const on = (st: SyncState): void => {
        if (!pred(st)) return
        clearTimeout(timer)
        engine.off('state', on)
        res(st)
      }
      engine.on('state', on)
    })

  const starts: Start[] = []
  const restarts: number[] = []
  player.on('playbackRestart', () => restarts.push(performance.now()))
  /** ms from the last playback-restart before `t` to `t` */
  const sinceRestart = (t: number): number | null => {
    const r = restarts.filter((x) => x <= t).at(-1)
    return r === undefined ? null : t - r
  }
  let frameMs = 40
  /** Samples audio-pts every 50 ms around the start of a playing state and records D. */
  const measure = async (
    st: SyncState,
    scenario: Scenario,
    rep: number,
    target: number | null,
    resettleAfterRestartMs: number | null = null,
  ): Promise<void> => {
    const { pos, hostTime } = st.anchor
    const ds: number[] = []
    await sleep(Math.max(0, hostTime + 300 - performance.now()))
    while (performance.now() < hostTime + 1000) {
      const s = await player.sample()
      const ts = (s.tSend + s.tRecv) / 2
      if (s.prop === 'audio-pts' && typeof s.value === 'number' && s.tRecv - s.tSend < 15) {
        ds.push((s.value - pos) * 1000 - (ts - hostTime))
      }
      await sleep(50)
    }
    const sm = summary(ds)
    starts.push({
      scenario,
      rep,
      target,
      anchorPos: pos,
      dMs: median(ds),
      dMinMs: sm.min,
      dMaxMs: sm.max,
      n: ds.length,
      frameUpMs: target === null ? null : landingMs(target, frameMs) - target * 1000,
      unpauseLatMs: engine.member.unpauseLatencyMs,
      seekLatMs: engine.member.drift.seekLatMs,
      resettleAfterRestartMs,
      loadavg: readFileSync('/proc/loadavg', 'utf8').trim(),
    })
    const last = starts[starts.length - 1]
    console.log(
      `${scenario.padEnd(15)} rep ${String(rep)} target ${String(target)} D ${last.dMs.toFixed(1)} ms ` +
        `(${last.dMinMs.toFixed(1)}…${last.dMaxMs.toFixed(1)}, n ${String(last.n)}) frame-up ${String(last.frameUpMs?.toFixed(1))} ` +
        `unpauseLat ${last.unpauseLatMs.toFixed(1)} seekLat ${last.seekLatMs.toFixed(0)}` +
        (resettleAfterRestartMs === null ? '' : ` resettle ${resettleAfterRestartMs.toFixed(1)} ms after restart`),
    )
  }
  const far = (): number => Math.round((20 + rnd() * (durationS - 60)) * 1000) / 1000
  const isPlaying = (st: SyncState): boolean => st.mode === 'playing'
  const isPaused = (st: SyncState): boolean => st.mode === 'paused'

  try {
    const idle = new Promise<void>((res) => player.on('state', (s) => s === 'idle' && res()))
    player.start()
    await idle
    engine.start()
    engine.mediaReady(durationS)
    engine.setSource(path)
    await nextState(isPaused)
    await sleep(1500)
    frameMs = 1000 / Number((await player.getProperty('container-fps')).value)
    for (let rep = 0; rep < REPS; rep++) {
      // resume: playing → pause → play
      let p: Promise<SyncState>
      if (engine.member.state?.mode !== 'playing') {
        p = nextState(isPlaying)
        await engine.intent({ kind: 'play' })
        await p
      }
      await sleep(2500)
      const paused = nextState(isPaused)
      await engine.intent({ kind: 'pause' })
      await paused
      await sleep(1000)
      p = nextState(isPlaying)
      await engine.intent({ kind: 'play' })
      await measure(await p, 'resume', rep, null)
      await sleep(1500)

      // paused-seek: paused → seek X → play
      const x1 = far()
      const pp = nextState(isPaused)
      await engine.intent({ kind: 'pause' })
      await pp
      await sleep(500)
      const seeked = nextState((st) => isPaused(st) && Math.abs(st.anchor.pos - x1) < 1e-6)
      await engine.intent({ kind: 'seek', posS: x1 })
      await seeked
      await sleep(1500)
      p = nextState(isPlaying)
      await engine.intent({ kind: 'play' })
      await measure(await p, 'paused-seek', rep, x1)
      await sleep(1500)

      // barrier-paused: playing → seek X + pause in one turn → paused at X → play
      const x2 = far()
      const done = nextState((st) => isPaused(st) && Math.abs(st.anchor.pos - x2) < 1e-6)
      void engine.intent({ kind: 'seek', posS: x2 })
      void engine.intent({ kind: 'pause' })
      await done
      const resettle2 = sinceRestart(performance.now())
      await sleep(1500)
      p = nextState(isPlaying)
      await engine.intent({ kind: 'play' })
      await measure(await p, 'barrier-paused', rep, x2, resettle2)
      await sleep(1500)

      // playing-seek: playing → seek X → the barrier completes playing
      const x3 = far()
      p = nextState((st) => isPlaying(st) && Math.abs(st.anchor.pos - x3) < 1e-6)
      await engine.intent({ kind: 'seek', posS: x3 })
      await measure(await p, 'playing-seek', rep, x3)
      await sleep(1500)

      // wait-after-seek: paused → seek X → not ready → play: the room waits at X → ready a second later → playing
      const x4 = far()
      const pp4 = nextState(isPaused)
      await engine.intent({ kind: 'pause' })
      await pp4
      await sleep(500)
      const seeked4 = nextState((st) => isPaused(st) && Math.abs(st.anchor.pos - x4) < 1e-6)
      await engine.intent({ kind: 'seek', posS: x4 })
      await seeked4
      await sleep(1500)
      setReady(false)
      await sleep(300)
      const waiting = nextState((st) => st.mode === 'waiting')
      p = nextState(isPlaying)
      await engine.intent({ kind: 'play' })
      await waiting
      const resettle4 = sinceRestart(performance.now())
      await sleep(1000)
      setReady(true)
      await measure(await p, 'wait-after-seek', rep, x4, resettle4)
      await sleep(1500)

      // reload-paused: playing → pause → the same source again while paused → play
      const pp5 = nextState(isPaused)
      await engine.intent({ kind: 'pause' })
      const x5 = (await pp5).anchor.pos // where the reload loads
      await sleep(1000)
      engine.setSource(path)
      await sleep(2000)
      p = nextState(isPlaying)
      await engine.intent({ kind: 'play' })
      await measure(await p, 'reload-paused', rep, x5)
      await sleep(1500)
    }
  } finally {
    engine.stop()
    clock.dispose()
    await player.dispose()
    await writeFile(join(runDir, 'starts.json'), JSON.stringify({ mpv: versionText.split('\n')[0], starts }, null, 1))
    await writeFile(join(runDir, 'log.txt'), logLines.join('\n') + '\n')
  }
  console.log('\n| scenario | starts | D median of medians, ms | D min…max, ms | first frame ≥ target − target, ms |')
  console.log('| --- | --- | --- | --- | --- |')
  for (const sc of SCENARIOS) {
    const s = starts.filter((x) => x.scenario === sc)
    const d = summary(s.map((x) => x.dMs))
    const fu = s.filter((x) => x.frameUpMs !== null).map((x) => (x.frameUpMs ?? 0).toFixed(0))
    console.log(
      `| ${sc} | ${String(d.n)} | ${d.p50.toFixed(1)} | ${d.min.toFixed(1)}…${d.max.toFixed(1)} | ${fu.join(', ')} |`,
    )
  }
  console.log(`\n${runDir}`)
}

await main()
