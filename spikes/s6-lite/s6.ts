// S6-lite driver (plan §7 S6, ADR 0007): how precisely can sync read and steer a real mpv 0.41, measured silently?
// mpv runs under the production PlayerController: the production argument list plus --vo=null --ao=null, JSON IPC
// over fd://3, the OSC loaded. It plays a fixtures.ts fixture from the local file (as the host does) or through the
// StreamServer (as a viewer does). One run = one mpv, one source, one CPU load level. Raw samples and events go to
// <out>/<run>/run.json; summarize.ts turns any number of runs into the ADR's tables.
//
//   npx tsx spikes/s6-lite/s6.ts --out <dir> [--source local|stream] [--load 12] [--protocols fit,pause,seek]
//     [--trials 20] [--fit-s 60] [--seed 1] [--tag r1] [--quick]

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { mkdir, open, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseArgs } from 'node:util'
import { StreamServer } from '../../src/core/media/stream-server.js'
import { FakeSource } from '../../src/core/media/testing/fake-source.js'
import { parseMpvVersion } from '../../src/core/player/mpv-version.js'
import { PlayerController } from '../../src/core/player/player-controller.js'
import { PlayerPortAdapter, createClock } from '../../src/core/session/sync-ports.js'
import { defaultSettings } from '../../src/shared/settings.js'
import { themePayload } from '../../src/shared/theme-tokens.js'
import { type FixtureName, type FixtureSet, LONG, fixture } from '../../test/integration/media/fixtures.js'
import type { EnvPoint, Ev, Prop, RunData, RunMeta, Sample } from './lib.js'

const REPO = resolve(import.meta.dirname, '../..')
/** Sources whose behaviour the numbers depend on; the run records their hashes and any change while it ran. */
const SRC_FILES = [
  'src/core/player/player-controller.ts',
  'src/core/player/mpv-ipc.ts',
  'src/core/player/mpv-args.ts',
  'src/core/media/mpv-stream-opts.ts',
  'src/core/media/stream-server.ts',
  'src/core/session/sync-ports.ts',
  'src/core/sync/drift.ts',
  'src/core/sync/member.ts',
  'resources/mpv-scripts/wt-osc.lua',
]
const PIECE = 256 * 1024
const RESTART_TIMEOUT_MS = 10_000

const { values: argv } = parseArgs({
  options: {
    out: { type: 'string' },
    source: { type: 'string', default: 'local' },
    load: { type: 'string', default: '0' },
    protocols: { type: 'string', default: 'fit,pause,seek' },
    trials: { type: 'string', default: '20' },
    'fit-s': { type: 'string', default: '60' },
    'idle-s': { type: 'string', default: '30' },
    seed: { type: 'string', default: '1' },
    tag: { type: 'string', default: 'run' },
    fixtures: { type: 'string' },
    container: { type: 'string', default: 'mkv-cues.mkv' },
    quick: { type: 'boolean', default: false },
    /** fd (fd://3, Linux and macOS) or socket (--input-ipc-server, as for Flatpak mpv) */
    ipc: { type: 'string', default: 'fd' },
  },
})
if (argv.out === undefined) throw new Error('--out <dir> is required')
const OUT = resolve(argv.out)
const SOURCE = argv.source === 'stream' ? 'stream' : 'local'
const LOAD = Number(argv.load)
const PROTOCOLS = argv.protocols.split(',')
const QUICK = argv.quick
const IPC = argv.ipc === 'socket' ? 'socket' : 'fd'
const TRIALS = QUICK ? 3 : Number(argv.trials)
const FIT_S = QUICK ? 8 : Number(argv['fit-s'])
const IDLE_S = QUICK ? 3 : Number(argv['idle-s'])
const SEED = Number(argv.seed)
/** speed, seconds: 1.02 / 0.98 as the task asks, ±5 % (MAXD), back to 1 in between */
const SPEEDS: [number, number][] = QUICK
  ? [
      [1.02, 5],
      [1, 3],
      [0.98, 5],
    ]
  : [
      [1.02, 25],
      [1, 10],
      [0.98, 25],
      [1, 10],
      [1.05, 15],
      [1, 8],
      [0.95, 15],
      [1, 8],
    ]
/** LONG's encode (640x360 25 fps x264 2 Mbit/s, 1 s GOP, AAC 128k 440 Hz) at 5 min, from fixtures.ts's generator */
const SET: FixtureSet = { ...LONG, dir: resolve(argv.fixtures ?? join(OUT, 'fixtures')), durationS: 300 }

// ---- helpers --------------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(SEED * 7919 + (SOURCE === 'stream' ? 1 : 0))

/** member.ts schedulePlayFrom: setTimeout to 15 ms before T, then spin on setImmediate until T. */
function runAt(T: number, fn: () => void): Promise<void> {
  return new Promise((resolve) => {
    const fire = (): void => {
      if (performance.now() >= T) {
        fn()
        resolve()
      } else setImmediate(fire)
    }
    setTimeout(fire, Math.max(0, T - 15 - performance.now()))
  })
}

/** Self-ending busy loops (bash builtins only): no orphan outlives maxS even if this process is SIGKILLed. */
function busyLoops(n: number, maxS: number): ChildProcess[] {
  return Array.from({ length: n }, () =>
    spawn('bash', ['-c', `while (( SECONDS < ${String(maxS)} )); do :; done`], { stdio: 'ignore' }),
  )
}

function hashes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of SRC_FILES) {
    out[f] = createHash('sha256')
      .update(readFileSync(join(REPO, f)))
      .digest('hex')
      .slice(0, 16)
  }
  return out
}
const mtimes = (): number[] => SRC_FILES.map((f) => statSync(join(REPO, f)).mtimeMs)

class Recorder {
  readonly samples: Sample[] = []
  readonly events: Ev[] = []
  readonly loadavg: RunMeta['loadavg'] = []
  /** 1 Hz: 1-min load average, runnable tasks, CPU pressure (PSI some avg10, %) */
  readonly env: EnvPoint[] = []
  private readonly inflight = new Set<Promise<void>>()
  private flip = false

  constructor(
    private readonly player: PlayerController,
    private readonly lag: () => number,
  ) {}

  ev(k: string, extra: Record<string, unknown> = {}): number {
    const t = performance.now()
    this.events.push({ t, k, ...extra })
    return t
  }

  mark(at: string): void {
    this.loadavg.push({ at, t: performance.now(), text: readFileSync('/proc/loadavg', 'utf8').trim() })
  }

  /** The machine is shared: sample its load every second, so stalls can be matched with contention. */
  watchEnv(): () => void {
    const read = (): void => {
      const la = readFileSync('/proc/loadavg', 'utf8').split(' ')
      const psi = /avg10=([\d.]+)/.exec(readFileSync('/proc/pressure/cpu', 'utf8'))
      this.env.push({
        t: performance.now(),
        la1: Number(la[0]),
        running: Number((la[3] ?? '0/').split('/')[0]),
        psi10: Number(psi?.[1] ?? NaN),
      })
    }
    read()
    const timer = setInterval(read, 1000)
    return () => clearInterval(timer)
  }

  /** audio-pts is the production sample (PlayerController.sample(), what PlayerPortAdapter.sample calls). */
  async one(ph: string, prop: Prop): Promise<void> {
    const t0 = performance.now()
    try {
      if (prop === 'audio-pts') {
        const s = await this.player.sample()
        const v = typeof s.value === 'number' ? s.value : null
        const rec: Sample = { ph, prop: s.prop, tS: s.tSend, tR: s.tRecv, v, lag: this.lag() }
        if (s.prop !== 'audio-pts') rec.fb = true
        this.samples.push(rec)
      } else {
        const s = await this.player.getProperty<number | null>('time-pos')
        const v = typeof s.value === 'number' ? s.value : null
        this.samples.push({ ph, prop, tS: s.tSend, tR: s.tRecv, v, lag: this.lag() })
      }
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      this.samples.push({ ph, prop, tS: t0, tR: performance.now(), v: null, err, lag: this.lag() })
    }
  }

  /** Both properties back to back, the order alternating from call to call. */
  pair(ph: string): Promise<void> {
    this.flip = !this.flip
    const order: Prop[] = this.flip ? ['audio-pts', 'time-pos'] : ['time-pos', 'audio-pts']
    const p = (async () => {
      for (const prop of order) await this.one(ph, prop)
    })()
    this.inflight.add(p)
    void p.finally(() => this.inflight.delete(p))
    return p
  }

  /** A pair every periodMs for ms, on a setTimeout chain like sync's every() (fire and forget). */
  async sampleFor(ph: string, ms: number, periodMs: number): Promise<void> {
    const end = performance.now() + ms
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (performance.now() >= end) {
          resolve()
          return
        }
        setTimeout(tick, periodMs)
        void this.pair(ph)
      }
      tick()
    })
    await Promise.all([...this.inflight])
  }
}

function waitRestart(player: PlayerController): Promise<boolean> {
  return new Promise((resolve) => {
    const on = (): void => {
      clearTimeout(timer)
      player.off('playbackRestart', on)
      resolve(true)
    }
    const timer = setTimeout(() => {
      player.off('playbackRestart', on)
      resolve(false)
    }, RESTART_TIMEOUT_MS)
    player.on('playbackRestart', on)
  })
}

// ---- protocols ------------------------------------------------------------------------------

interface Ctx {
  player: PlayerController
  port: PlayerPortAdapter
  rec: Recorder
  durationS: number
}

async function seekPaused(c: Ctx, pos: number, kind: string): Promise<boolean> {
  c.port.setPaused(true)
  c.rec.ev('seek', { kind, target: pos })
  c.port.seek(pos)
  return waitRestart(c.player)
}

/** Idle RTT (paused), then 1x for FIT_S + 2 s at 4 Hz (the fit), then the speed segments. */
async function protoFit(c: Ctx): Promise<void> {
  const { rec, port } = c
  rec.mark('fit:idle')
  await rec.sampleFor('idle', IDLE_S * 1000, 250)
  rec.mark('fit:play')
  rec.ev('unpause', { kind: 'fit' })
  port.setPaused(false)
  await rec.sampleFor('play', (FIT_S + 2) * 1000, 250)
  let seg = 0
  for (const [speed, s] of SPEEDS) {
    rec.mark(`fit:speed ${String(speed)}`)
    rec.ev('speed', { speed, seg })
    port.setSpeed(speed)
    await rec.sampleFor(`speed:${String(speed)}:${String(seg++)}`, s * 1000, 250)
  }
  rec.ev('pause', { kind: 'fit' })
  port.setPaused(true)
  port.setSpeed(1)
  await sleep(300)
}

/** A: pause while playing, read the paused position, unpause at a scheduled instant (member.ts timing). */
async function protoPause(c: Ctx): Promise<void> {
  const { rec, port } = c
  rec.mark('pause')
  if (!(await seekPaused(c, 20, 'setup'))) throw new Error('no playback-restart for the pause protocol')
  port.setPaused(false)
  await sleep(1000)
  for (let i = 0; i < TRIALS; i++) {
    await rec.sampleFor(`A${String(i)}:pre`, 1000, 50)
    rec.ev('pause', { kind: 'A', i })
    port.setPaused(true)
    await sleep(50)
    await rec.pair(`A${String(i)}:p50`)
    await sleep(250)
    await rec.pair(`A${String(i)}:p300`)
    const T = performance.now() + 300 + rnd() * 500
    await runAt(T, () => {
      rec.ev('unpause', { kind: 'A', i, T })
      port.setPaused(false)
    })
    await rec.sampleFor(`A${String(i)}:post`, 3000, 50)
  }
  rec.ev('pause', { kind: 'A-end' })
  port.setPaused(true)
  await sleep(300)
}

/** B: exact seeks while paused, each followed by a scheduled unpause; C: exact seeks while playing. */
async function protoSeek(c: Ctx): Promise<void> {
  const { rec, port, player } = c
  const far = (): number => Math.round((20 + rnd() * (c.durationS - 60)) * 1000) / 1000
  rec.mark('seek:paused')
  for (let i = 0; i < TRIALS; i++) {
    port.setPaused(true)
    await sleep(200)
    const target = far()
    rec.ev('seek', { kind: 'B', i, target })
    port.seek(target)
    if (!(await waitRestart(player))) {
      rec.ev('timeout', { kind: 'B', i })
      continue
    }
    await sleep(50)
    await rec.pair(`B${String(i)}:p50`)
    await sleep(250)
    await rec.pair(`B${String(i)}:p300`)
    const T = performance.now() + 300 + rnd() * 400
    await runAt(T, () => {
      rec.ev('unpause', { kind: 'B', i, T })
      port.setPaused(false)
    })
    await rec.sampleFor(`B${String(i)}:post`, 2500, 50)
    rec.ev('pause', { kind: 'B', i })
  }
  port.setPaused(true)
  rec.mark('seek:playing')
  if (!(await seekPaused(c, 20, 'setup'))) throw new Error('no playback-restart before the playing seeks')
  port.setPaused(false)
  await sleep(1000)
  for (let i = 0; i < TRIALS; i++) {
    // even trials: a drift-loop skip (+1.5 s from where we are); odd: anywhere in the file
    const short = i % 2 === 0
    let target = far()
    if (short) {
      const now = await player.sample()
      if (typeof now.value === 'number' && now.value < c.durationS - 20) {
        target = Math.round((now.value + 1.5 + rnd() * 0.04) * 1000) / 1000
      }
    }
    rec.ev('seek', { kind: 'C', i, target, short })
    port.seek(target)
    if (!(await waitRestart(player))) {
      rec.ev('timeout', { kind: 'C', i })
      continue
    }
    await rec.sampleFor(`C${String(i)}:post`, 2500, 50)
    await sleep(300)
  }
  rec.ev('pause', { kind: 'C-end' })
  port.setPaused(true)
  await sleep(300)
}

// ---- main -----------------------------------------------------------------------------------

async function main(): Promise<void> {
  const started = new Date()
  const stamp = started.toISOString().replace(/[:.]/g, '-')
  const ipcTag = IPC === 'socket' ? '-sock' : ''
  const runDir = join(OUT, `${argv.tag}-${SOURCE}${ipcTag}-load${String(LOAD)}-${stamp}`)
  await mkdir(runDir, { recursive: true })
  const hash0 = hashes()
  const mt0 = mtimes()

  const versionText = execFileSync('mpv', ['--version'], { encoding: 'utf8' })
  const version = parseMpvVersion(versionText)
  if (!version) throw new Error('mpv --version: unparsable')
  const path = await fixture(argv.container as FixtureName, SET)

  let server: StreamServer | null = null
  const fh = SOURCE === 'stream' ? await open(path, 'r') : null
  let url = path
  if (fh) {
    const size = (await fh.stat()).size
    const source = new FakeSource(
      [{ index: 0, name: basename(path), offset: 0, length: size }],
      PIECE,
      async (a, n) => {
        const buf = new Uint8Array(n)
        const { bytesRead } = await fh.read(buf, 0, n, a)
        return buf.subarray(0, bytesRead)
      },
    )
    source.releaseAll() // a viewer whose download is complete (or far ahead): sync's numbers, not buffering
    server = await StreamServer.listen(source)
    url = server.url(0)
  }

  const logLines: string[] = []
  const log = (level: string) => (msg: string, e?: unknown) => {
    logLines.push(`${performance.now().toFixed(1)} [${level}] ${msg}${e === undefined ? '' : ` ${String(e)}`}`)
  }
  const srv = server
  const player = new PlayerController({
    mpv: { path: 'mpv', kind: 'system', version },
    role: SOURCE === 'local' ? 'host' : 'viewer',
    resourcesDir: join(REPO, 'resources'),
    logFile: join(runDir, 'mpv.log'),
    settings: defaultSettings(),
    theme: themePayload('dark', 'dark'),
    perms: { isHost: true, canPlayPause: true, canSeek: true },
    mediaTitle: basename(path),
    // headless and silent; the OSC draws as if into a 1280x720 window
    extraArgs: ['--vo=null', '--ao=null', '--script-opts=wt_osc-test-dims=1280x720'],
    selfReload: false, // as the sessions run it (base-session.ts)
    ...(IPC === 'socket' ? { ipcMode: 'socket' as const } : {}),
    hooks: srv ? { readerBlocked: () => srv.isBlocked(0) } : {},
    log: { debug: () => undefined, info: log('info'), warn: log('warn'), error: log('error') },
  })
  const clock = createClock()
  const rec = new Recorder(player, () => clock.loopLagMs())
  const port = new PlayerPortAdapter(player, { subtitles: () => [], title: null, log: log('port') })
  player.on('playbackRestart', (r) => rec.ev('restart', { pos: r.pos }))
  player.on('audioReconfig', () => rec.ev('audio-reconfig'))
  player.on('external-change', (x) => rec.ev('external-change', { ...x }))
  player.on('state', (s) => rec.ev('state', { s }))

  let busy: ChildProcess[] = []
  const cleanup = (): void => {
    for (const b of busy) b.kill('SIGKILL')
    busy = []
  }
  process.once('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })

  const stopEnv = rec.watchEnv()
  try {
    const idle = new Promise<void>((res) => player.on('state', (s) => s === 'idle' && res()))
    player.start()
    await idle
    rec.ev('load', { url })
    await player.load(url, { start: 10, paused: true })
    const fps = Number((await player.getProperty('container-fps')).value)
    const durationS = Number((await player.getProperty('duration')).value)
    if (LOAD > 0) {
      busy = busyLoops(LOAD, 900)
      rec.ev('load-start', { n: LOAD })
      await sleep(3000)
    }
    const c: Ctx = { player, port, rec, durationS }
    if (PROTOCOLS.includes('fit')) await protoFit(c)
    if (PROTOCOLS.includes('pause')) await protoPause(c)
    if (PROTOCOLS.includes('seek')) await protoSeek(c)
    rec.mark('end')
    cleanup()
    rec.ev('load-stop')

    const mt1 = mtimes()
    const meta: RunMeta = {
      tag: argv.tag,
      ipc: IPC,
      source: SOURCE,
      load: LOAD,
      seed: SEED,
      fixture: path,
      durationS,
      fps,
      mpv: versionText.split('\n')[0] ?? '',
      node: process.version,
      argv: logLines.find((l) => l.includes('player: spawning')) ?? '',
      started: started.toISOString(),
      finished: new Date().toISOString(),
      loadavg: rec.loadavg,
      src: { hash: hash0, changed: SRC_FILES.filter((_, i) => mt1[i] !== mt0[i]) },
      protocols: PROTOCOLS,
      trials: TRIALS,
      fitS: FIT_S,
    }
    const data: RunData = { meta, samples: rec.samples, events: rec.events, env: rec.env }
    await writeFile(join(runDir, 'run.json'), JSON.stringify(data))
    await writeFile(join(runDir, 'log.txt'), logLines.join('\n') + '\n')
    const la = rec.loadavg.map((l) => `${l.at}: ${l.text.split(' ').slice(0, 3).join(' ')}`).join('; ')
    console.log(`${runDir}: ${String(rec.samples.length)} samples; loadavg ${la}`)
    if (meta.src.changed.length > 0) console.log(`WARNING: changed during the run: ${meta.src.changed.join(', ')}`)
  } finally {
    stopEnv()
    cleanup()
    clock.dispose()
    await player.dispose()
    await server?.close()
    await fh?.close()
  }
}

await main()
