import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PlayerStatus } from '../../../src/shared/ipc/core.js'
import { defaultSettings } from '../../../src/shared/settings.js'
import { themePayload } from '../../../src/shared/theme-tokens.js'
import { MpvIpc } from '../../../src/core/player/mpv-ipc.js'
import {
  type ExternalChange,
  type PlayerControllerOptions,
  type PlayerExit,
  type PlayerIntent,
  PlayerController,
} from '../../../src/core/player/player-controller.js'
import {
  type Fixture,
  HAVE_FFMPEG,
  HAVE_MPV,
  HEADLESS,
  type IpcTap,
  MPV_VERSION,
  RESOURCES,
  loadfiles,
  makeFixture,
  oscErrors,
  sleep,
  socketDir,
  tapIpc,
  until,
  waitFor,
  within,
} from './helpers.js'

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

describe.skipIf(!HAVE_MPV || !HAVE_FFMPEG)('PlayerController with real mpv', () => {
  let fx: Fixture
  let other = ''
  let player: PlayerController | null = null
  let sock: { dir: string; cleanup: () => Promise<void> } | null = null
  let runs = 0

  beforeAll(async () => {
    fx = await makeFixture()
    // another file with the same track ids, but a French second audio track
    other = join(fx.dir, 'other.mkv')
    // prettier-ignore
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx.clip, '-map', '0', '-c', 'copy', '-metadata:s:a:1', 'language=fre', other])
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await player?.dispose()
    player = null
    await sock?.cleanup()
    sock = null
  })

  function create(over: Partial<PlayerControllerOptions> = {}): PlayerController {
    if (!MPV_VERSION) throw new Error('no mpv')
    const settings = defaultSettings()
    player = new PlayerController({
      mpv: { path: 'mpv', kind: 'system', version: MPV_VERSION },
      role: 'host',
      resourcesDir: RESOURCES,
      logFile: join(fx.dir, `mpv-${String(++runs)}.log`),
      settings,
      theme: themePayload('dark', 'dark'),
      perms: { isHost: true, canPlayPause: true, canSeek: true },
      mediaTitle: 'clip.mkv',
      extraArgs: [...HEADLESS, '--script-opts=wt_osc-test-dims=1280x720'],
      log: silent,
      ...over,
    })
    return player
  }

  async function started(p: PlayerController): Promise<void> {
    const idle = waitFor(p, 'state', (s: PlayerStatus) => s === 'idle')
    p.start()
    await idle
  }

  const prop = async (p: PlayerController, name: string): Promise<unknown> => (await p.getProperty(name)).value

  it('loads paused at 3 s, seeks, reports tracks, HDR status and the OSC handshake', async () => {
    const pids: (number | null)[] = []
    const p = create({ hooks: { onPid: (pid) => pids.push(pid) } })
    const states: PlayerStatus[] = []
    p.on('state', (s) => states.push(s))
    const oscReady = waitFor(p, 'oscReady')
    await started(p)
    await oscReady
    expect(pids[0]).toBe(p.pid)

    const tracks = waitFor(p, 'tracks', (t: { audio: unknown[] }) => t.audio.length === 2)
    const loaded = waitFor(p, 'fileLoaded')
    await p.load(fx.clip, { start: 3, paused: true, subtitles: [{ url: fx.srt, title: 'English', lang: 'eng' }] })
    await loaded
    expect(p.status).toBe('ready')
    expect(states).toEqual(['spawning', 'connecting', 'idle', 'loading', 'ready'])
    expect(await prop(p, 'time-pos')).toBeCloseTo(3, 1)
    expect(await prop(p, 'pause')).toBe(true)

    await tracks
    await until(() => p.tracks().aid === 1)
    expect(p.tracks()).toMatchObject({
      audio: [
        { id: 1, lang: 'eng', codec: 'aac', default: true, external: false },
        { id: 2, lang: 'jpn', external: false },
      ],
      aid: 1,
    })
    await until(() => p.tracks().sub.length === 1)
    expect(p.tracks().sub[0]).toMatchObject({ id: 1, title: 'English', lang: 'eng', external: true })
    expect(p.playerEvent()).toMatchObject({ status: 'ready', hdr: { source: 'sdr', output: 'sdr' } })

    const restarts: unknown[] = []
    p.on('playbackRestart', (r) => restarts.push(r))
    const externals: ExternalChange[] = []
    p.on('external-change', (c) => externals.push(c))
    await p.seek(7)
    expect(restarts).toHaveLength(1)
    expect(await prop(p, 'time-pos')).toBeCloseTo(7, 1)
    const sample = await p.sample()
    expect(sample.tRecv).toBeGreaterThanOrEqual(sample.tSend)
    // switching tracks is local and must not look like an external seek
    await p.setTrack('audio', 2)
    await p.setTrack('sub', 1)
    await sleep(300)
    expect(externals).toEqual([])
    expect(p.frameDrops()).toEqual({ vo: 0, decoder: 0 })
  })

  it('reverts an external pause change and reports an external seek', async () => {
    sock = await socketDir()
    const p = create({ ipcMode: 'socket', runtimeDir: sock.dir })
    await started(p)
    await p.load(fx.clip, { start: 3, paused: true })
    const externals: ExternalChange[] = []
    p.on('external-change', (c) => externals.push(c))

    const path = p.ipcEndpoint
    if (path === null) throw new Error('no IPC endpoint')
    const other = await MpvIpc.connect(path)
    try {
      await other.command(['set', 'pause', 'no'])
      await until(() => externals.some((c) => c.kind === 'pause'))
      await until(async () => (await prop(p, 'pause')) === true, 1000)
      expect(externals[0]).toEqual({ kind: 'pause', value: false })

      await other.command(['set', 'speed', '2'])
      await until(async () => (await prop(p, 'speed')) === 1, 1000)
      expect(externals).toContainEqual({ kind: 'speed', value: 2 })

      const seek = waitFor<[ExternalChange]>(p, 'external-change', (c) => c.kind === 'seek')
      await other.command(['seek', '8', 'absolute'])
      const [change] = await seek
      expect(change).toMatchObject({ kind: 'seek' })
      if (change.kind === 'seek') expect(change.pos).toBeCloseTo(8, 0)
    } finally {
      other.close()
    }
    // our own seek is not external
    externals.length = 0
    await p.seek(2)
    await sleep(100)
    expect(externals).toEqual([])
  })

  it('restarts after kill -9 at the room position with tracks re-applied', async () => {
    const p = create({ hooks: { restartPosition: () => 6 } })
    await started(p)
    await p.load(fx.clip, { start: 1, paused: true })
    await p.setTrack('audio', 2)
    await p.setVolume(40, false)
    const pid = p.pid
    if (pid === null) throw new Error('no pid')
    // the restarted mpv has a new IPC; the controller's reload follows 'idle'
    const tap: IpcTap = { commands: [], sets: [] }
    p.on('state', (s, prev) => {
      if (s === 'idle' && prev === 'connecting') tapIpc(p, tap)
    })

    const exit = waitFor<[PlayerExit]>(p, 'exit')
    process.kill(pid, 'SIGKILL')
    const [info] = await exit
    expect(info).toMatchObject({ signal: 'SIGKILL', requested: false, restartInMs: 1000 })
    expect(p.status).toBe('crashed')

    await waitFor(p, 'state', (s: PlayerStatus) => s === 'ready', 15_000)
    expect(p.pid).not.toBe(pid)
    // the crash cleared track-list; the language still comes from the file's tracks
    expect(loadfiles(tap.commands)).toEqual(['start=6,pause=yes,aid=2,alang=jpn'])
    expect(await prop(p, 'time-pos')).toBeCloseTo(6, 1)
    expect(await prop(p, 'pause')).toBe(true)
    await until(async () => (await prop(p, 'aid')) === 2 && (await prop(p, 'volume')) === 40, 2000)
  })

  it('selfReload false: after kill -9 during playback the caller loads, and its load is the only one', async () => {
    const p = create({ selfReload: false, hooks: { restartPosition: () => 3 }, timing: { restartDelaysMs: [100] } })
    await started(p)
    await p.load(fx.clip, { start: 1, paused: true })
    await p.setTrack('audio', 2)
    await p.setVolume(40, false)
    await p.setPaused(false)
    await until(async () => ((await prop(p, 'time-pos')) as number) > 1.3, 3000)
    const pid = p.pid
    if (pid === null) throw new Error('no pid')
    const tap: IpcTap = { commands: [], sets: [] }
    const loads: Promise<string>[] = []
    p.on('state', (s, prev) => {
      if (s !== 'idle' || prev !== 'connecting') return
      tapIpc(p, tap)
      // sync's member: the player is available again, so it loads at its target, inside this event
      loads.push(
        p.load(fx.clip, { start: 6, paused: true }).then(
          () => 'loaded',
          (e: unknown) => String(e),
        ),
      )
    })
    process.kill(pid, 'SIGKILL')
    await waitFor(p, 'state', (s: PlayerStatus) => s === 'ready', 15_000)
    expect(await Promise.all(loads)).toEqual(['loaded'])
    expect(loadfiles(tap.commands)).toEqual(['start=6,pause=yes,aid=2,alang=jpn'])
    expect(await prop(p, 'time-pos')).toBeCloseTo(6, 1)
    expect(await prop(p, 'pause')).toBe(true)
    await until(async () => (await prop(p, 'aid')) === 2 && (await prop(p, 'volume')) === 40, 2000)
  })

  it('selfReload false: Reopen player waits in idle for the caller, whose load restores the tracks', async () => {
    const p = create({ selfReload: false })
    await started(p)
    await p.load(fx.clip, { start: 2, paused: true })
    await p.setTrack('audio', 2)
    await p.close()
    const tap: IpcTap = { commands: [], sets: [] }
    p.on('state', (s) => {
      if (s === 'idle') tapIpc(p, tap)
    })
    p.reopen()
    await waitFor(p, 'state', (s: PlayerStatus) => s === 'idle', 15_000)
    await sleep(300)
    expect(p.status).toBe('idle')
    expect(loadfiles(tap.commands)).toEqual([])
    await p.load(fx.clip, { start: 4, paused: true })
    expect(loadfiles(tap.commands)).toEqual(['start=4,pause=yes,aid=2,alang=jpn'])
    expect(await prop(p, 'time-pos')).toBeCloseTo(4, 1)
    await until(async () => (await prop(p, 'aid')) === 2, 2000)
  })

  for (const selfReload of [true, false]) {
    const who = selfReload ? 'reloads its file' : 'leaves the reload to the caller'
    it(`on another client's loadfile ${who} (selfReload: ${String(selfReload)})`, async () => {
      sock = await socketDir()
      const p = create({ ipcMode: 'socket', runtimeDir: sock.dir, selfReload, hooks: { restartPosition: () => 4 } })
      await started(p)
      await p.load(fx.clip, { start: 2, paused: true, subtitles: [{ url: fx.srt, title: 'English', lang: 'eng' }] })
      await p.setTrack('audio', 2)
      await until(() => p.tracks().aid === 2)
      const tap = tapIpc(p)
      const paths: (string | null)[] = []
      p.on('external-change', (c) => {
        if (c.kind === 'path') paths.push(c.path)
      })
      const states: PlayerStatus[] = []
      p.on('state', (s) => states.push(s))
      const loaded: string[] = []
      p.on('fileLoaded', (f) => loaded.push(f.path))
      const endpoint = p.ipcEndpoint
      if (endpoint === null) throw new Error('no IPC endpoint')
      const client = await MpvIpc.connect(endpoint)
      try {
        await client.command(['loadfile', other, 'replace'])
        if (selfReload) {
          await until(() => p.status === 'ready' && loadfiles(tap.commands).length === 1 && p.prop('path') === fx.clip)
          expect(loadfiles(tap.commands)).toEqual(['start=4,pause=yes,aid=2,alang=jpn'])
        } else {
          // nothing reloads behind the caller's back: the other file stays, with its own tracks
          await until(() => p.prop('path') === other && p.tracks().audio[1]?.lang === 'fre')
          await sleep(200)
          expect(loadfiles(tap.commands)).toEqual([])
          // ours is gone: not loaded, so sync's member reloads by its "available and not loaded" rule, also
          // while it holds for an absent host and ignores 'path'. The other file's start-file adds no event.
          expect(p.status).toBe('idle')
          expect(states).toEqual(['idle'])
          expect(paths).toHaveLength(1)
          // nor is that file reported as ours (a viewer's "file opened") or given our subtitles
          expect(loaded).toEqual([])
          expect(tap.commands.filter((c) => Array.isArray(c) && c[0] === 'sub-add')).toEqual([])
          await p.load(fx.clip, { start: 5, paused: true }) // sync's member, on 'idle'
          expect(paths).toHaveLength(1)
          expect(loaded).toEqual([fx.clip])
          // alang is our file's (jpn), not that of the file mpv showed meanwhile (fre)
          expect(loadfiles(tap.commands)).toEqual(['start=5,pause=yes,aid=2,alang=jpn'])
        }
      } finally {
        client.close()
      }
      expect(paths.length).toBeGreaterThan(0)
      expect(await prop(p, 'path')).toBe(fx.clip)
      expect(await prop(p, 'time-pos')).toBeCloseTo(selfReload ? 4 : 5, 1)
      await until(async () => (await prop(p, 'aid')) === 2, 2000)
    })
  }

  it("selfReload false: another client's stop leaves the controller idle with one 'path' event", async () => {
    sock = await socketDir()
    const p = create({ ipcMode: 'socket', runtimeDir: sock.dir, selfReload: false })
    await started(p)
    await p.load(fx.clip, { start: 2, paused: true })
    await p.setTrack('audio', 2)
    const tap = tapIpc(p)
    const paths: (string | null)[] = []
    p.on('external-change', (c) => {
      if (c.kind === 'path') paths.push(c.path)
    })
    const endpoint = p.ipcEndpoint
    if (endpoint === null) throw new Error('no IPC endpoint')
    const client = await MpvIpc.connect(endpoint)
    try {
      await client.command(['stop'])
      await until(() => p.status === 'idle')
      await sleep(200)
      expect(paths).toEqual([null])
      expect(loadfiles(tap.commands)).toEqual([])
    } finally {
      client.close()
    }
    await p.load(fx.clip, { start: 3, paused: true })
    expect(loadfiles(tap.commands)).toEqual(['start=3,pause=yes,aid=2,alang=jpn'])
    expect(await prop(p, 'time-pos')).toBeCloseTo(3, 1)
    await until(async () => (await prop(p, 'aid')) === 2, 2000)
  })

  it("selfReload false: a load() and another client's stop sent together end consistently, never hanging", async () => {
    // Whichever command mpv runs first: the stop, and our load plays; ours, and the stop ends our entry, or drops it
    // before it started, when mpv's 'idle' is all that follows (round-4 review: 6 of 20 such loads hung).
    sock = await socketDir()
    const p = create({ ipcMode: 'socket', runtimeDir: sock.dir, selfReload: false })
    await started(p)
    await p.load(fx.clip, { start: 0, paused: true })
    const paths: (string | null)[] = []
    p.on('external-change', (c) => {
      if (c.kind === 'path') paths.push(c.path)
    })
    const endpoint = p.ipcEndpoint
    if (endpoint === null) throw new Error('no IPC endpoint')
    const client = await MpvIpc.connect(endpoint)
    const outcomes: string[] = []
    try {
      for (let i = 0; i < 20; i++) {
        const before = paths.length
        const load = p.load(fx.clip, { start: 1, paused: true }).then(
          () => 'loaded',
          (e: unknown) => (e as { code?: string }).code ?? String(e),
        )
        const stopped = client.command(['stop'])
        const outcome = await within(load, 5000)
        outcomes.push(outcome)
        if (outcome === 'stalled') break
        expect(['loaded', 'player-superseded']).toContain(outcome)
        await stopped
        // the controller ends where mpv is: 'ready' on our file, or 'idle' on an empty mpv with one 'path' event
        await until(async () => {
          const idle = (await prop(p, 'idle-active')) === true
          return p.status === 'idle' ? idle : p.status === 'ready' && !idle && p.prop('path') === fx.clip
        }, 3000)
        expect(paths.length - before).toBe(p.status === 'idle' ? 1 : 0)
        if (p.status === 'idle') await p.load(fx.clip, { start: 0, paused: true }) // sync's member, on 'idle'
      }
    } finally {
      client.close()
    }
    expect(outcomes).not.toContain('stalled')
    expect(outcomes).toHaveLength(20)
  })

  it('completes a load only at a restart of its own file, not one that came before mpv answered the loadfile', async () => {
    const p = create({ selfReload: false })
    await started(p)
    await p.load(fx.clip, { start: 1, paused: true })
    const ipc = (p as unknown as { ipc: MpvIpc }).ipc
    const paths: (string | null)[] = []
    p.on('external-change', (c) => {
      if (c.kind === 'path') paths.push(c.path)
    })
    const loaded: string[] = []
    p.on('fileLoaded', (f) => loaded.push(f.path))
    // The loadfile is written (after the title, which the session always sets), mpv has not answered it. What
    // arrives now belongs to what mpv showed before: the end of a seek of that file, or another client's file
    // starting and restarting. Neither completes our load, and since our loadfile runs after that client's,
    // ours is not given up either.
    const load = p.load(fx.clip, { start: 6, paused: true, title: 'clip' }).then(() => 'loaded', String)
    ipc.emit('event', { event: 'playback-restart' })
    expect(p.status).toBe('loading')
    ipc.emit('event', { event: 'start-file', playlist_entry_id: 1_000_000 })
    ipc.emit('event', { event: 'file-loaded' })
    ipc.emit('event', { event: 'playback-restart' })
    expect(p.status).toBe('loading')
    expect(await load).toBe('loaded')
    expect(p.status).toBe('ready')
    expect(paths).toEqual([])
    expect(loaded).toEqual([fx.clip]) // ours only: not the other client's file-loaded
    expect(await prop(p, 'time-pos')).toBeCloseTo(6, 1)
  })

  it("selfReload false: gives our file up at another client's start-file, also with no end-file of ours first", async () => {
    // e.g. our loadfile was answered but its entry never started: another client's loadfile replaced it
    const p = create({ selfReload: false })
    await started(p)
    await p.load(fx.clip, { start: 1, paused: true })
    const paths: (string | null)[] = []
    p.on('external-change', (c) => {
      if (c.kind === 'path') paths.push(c.path)
    })
    const ipc = (p as unknown as { ipc: MpvIpc }).ipc
    ipc.emit('event', { event: 'start-file', playlist_entry_id: 1_000_000 })
    expect(p.status).toBe('idle')
    expect(paths).toEqual([null])
    await p.load(fx.clip, { start: 2, paused: true })
    expect(p.status).toBe('ready')
    expect(await prop(p, 'time-pos')).toBeCloseTo(2, 1)
  })

  it("selfReload false: gives nothing up at an mpv 'idle' before mpv answered our loadfile, or while ours is shown", async () => {
    const p = create({ selfReload: false })
    await started(p)
    await p.load(fx.clip, { start: 1, paused: true })
    const internals = p as unknown as { ipc: MpvIpc; ownEntry: number }
    const paths: (string | null)[] = []
    p.on('external-change', (c) => {
      if (c.kind === 'path') paths.push(c.path)
    })
    // Another client's stop that mpv ran before our loadfile: the end of the file it showed and its 'idle' come
    // before our reply, and our loadfile then starts our file anyway.
    const load = p.load(fx.clip, { start: 6, paused: true }).then(() => 'loaded', String)
    internals.ipc.emit('event', { event: 'end-file', reason: 'stop', playlist_entry_id: internals.ownEntry })
    internals.ipc.emit('event', { event: 'idle' })
    expect(p.status).toBe('loading')
    expect(await load).toBe('loaded')
    // mpv sends 'idle' only after an end-file: one while our entry is shown is none of ours to act on
    internals.ipc.emit('event', { event: 'idle' })
    expect(p.status).toBe('ready')
    expect(paths).toEqual([])
    expect(await prop(p, 'time-pos')).toBeCloseTo(6, 1)
  })

  it('completes a seek whose reply and playback-restart come in one chunk', async () => {
    const p = create()
    await started(p)
    await p.load(fx.clip, { start: 1, paused: true })
    const ipc = (p as unknown as { ipc: { nextRequestId: number; onData: (chunk: string, t: number) => void } }).ipc
    let done = false
    void p.seek(7).then(() => (done = true))
    // node read mpv's reply and the restart it led to at once (a seek inside the cache restarts within ms);
    // the real ones come later and find nothing pending
    const id = ipc.nextRequestId - 1
    ipc.onData(`{"request_id":${String(id)},"error":"success"}\n{"event":"playback-restart"}\n`, performance.now())
    await Promise.resolve()
    await Promise.resolve()
    expect(done).toBe(true)
  })

  it('shows a toast sent before the OSC was up once it is', async () => {
    const p = create()
    const oscReady = waitFor(p, 'oscReady')
    p.start()
    // e.g. the viewer's "downloading the whole file" notice, sent right after the player was created
    p.osc('toast', { text: 'Sent before the OSC was up', ms: 30_000 })
    await oscReady
    const ipc = (p as unknown as { ipc: MpvIpc }).ipc
    const drawn = async (): Promise<string> =>
      ipc.getProperty<string>('user-data/wt_osc/overlay').then(
        (r) => r.value,
        () => '',
      )
    await until(async () => (await drawn()).includes('Sent before the OSC was up'), 5000)
  })

  it('stops restarting after the 4th crash within 60 s', async () => {
    const p = create({ timing: { restartDelaysMs: [50, 50, 50] } })
    await started(p)
    await p.load(fx.clip, { start: 0, paused: true })
    const exits: PlayerExit[] = []
    p.on('exit', (e) => exits.push(e))
    for (let i = 0; i < 4; i++) {
      const pid = p.pid
      if (pid === null) throw new Error('no pid')
      const exited = waitFor(p, 'exit')
      process.kill(pid, 'SIGKILL')
      await exited
      if (i < 3) await waitFor(p, 'state', (s: PlayerStatus) => s === 'ready', 15_000)
    }
    expect(exits.map((e) => e.restartInMs)).toEqual([50, 50, 50, null])
    await sleep(300)
    expect(p.status).toBe('crashed')
    expect(p.pid).toBeNull()

    // Reopen starts over with a fresh budget and the same file
    p.reopen()
    await waitFor(p, 'state', (s: PlayerStatus) => s === 'ready', 15_000)
  })

  it('ends in closedByUser on close(), and via CLOSE_WIN from the OSC', async () => {
    const p = create()
    await started(p)
    await p.close()
    expect(p.status).toBe('closedByUser')
    expect(p.pid).toBeNull()

    p.reopen()
    await waitFor(p, 'oscReady')
    const intents: PlayerIntent[] = []
    p.on('intent', (i) => intents.push(i))
    const closed = waitFor(p, 'state', (s: PlayerStatus) => s === 'closedByUser')
    await p.getProperty('pid')
    await (p as unknown as { ipc: MpvIpc }).ipc.command(['keypress', 'CLOSE_WIN'])
    await closed
    expect(intents).toEqual([{ kind: 'close', src: 'osc', seq: 1 }])
  })

  it('turns OSC intents into resolved intents and never changes pause itself', async () => {
    const p = create({
      perms: { isHost: false, canPlayPause: false, canSeek: false },
      hooks: { resolveToggle: () => 'play', resolveSeekRel: (d) => 100 + d },
    })
    await started(p)
    await waitFor(p, 'oscReady')
    await p.load(fx.clip, { start: 3, paused: true })
    const intents: PlayerIntent[] = []
    p.on('intent', (i) => intents.push(i))
    const ipc = (p as unknown as { ipc: MpvIpc }).ipc
    for (const key of ['SPACE', 'RIGHT', 'r']) await ipc.command(['keypress', key])
    await until(() => intents.length === 3)
    expect(intents).toEqual([
      { kind: 'play', src: 'osc', seq: 1 },
      { kind: 'seek', pos: 105, src: 'osc', seq: 2 },
      { kind: 'show-app', src: 'osc', seq: 3 },
    ])
    expect(await prop(p, 'pause')).toBe(true)
    expect(await prop(p, 'time-pos')).toBeCloseTo(3, 1)

    p.osc('ranges', { dur: 10, done: [[0, 4]], loading: [[4, 5]] })
    p.osc('peers', [{ id: 'x', name: 'X', color: '#ff0000', pos: 2, state: 'paused' }])
    p.osc('status', { text: 'Waiting', level: 'info' })
    p.osc('toast', { text: 'Only the host can pause' })
    p.osc('theme', themePayload('light', 'light'))
    p.osc('perms', { isHost: false, canPlayPause: true, canSeek: true })
    await sleep(600)
    const log = (p as unknown as { opts: { logFile: string } }).opts.logFile
    expect(await oscErrors(log)).toEqual([])
  })

  it('reports missing and tooOld without spawning', () => {
    const missing = create({ mpv: null, unavailable: 'missing' })
    missing.start()
    expect(missing.status).toBe('missing')
    const old = new PlayerController({
      mpv: null,
      unavailable: 'tooOld',
      role: 'viewer',
      resourcesDir: RESOURCES,
      logFile: null,
      settings: defaultSettings(),
      theme: themePayload('dark', 'dark'),
      perms: { isHost: false, canPlayPause: true, canSeek: true },
      log: silent,
    })
    expect(old.playerEvent()).toMatchObject({ status: 'tooOld', version: null })
  })

  it('reports missing when the binary does not exist', async () => {
    if (!MPV_VERSION) return
    const p = create({ mpv: { path: join(fx.dir, 'no-such-mpv'), kind: 'system', version: MPV_VERSION } })
    const missing = waitFor(p, 'state', (s: PlayerStatus) => s === 'missing')
    p.start()
    await missing
  })
})
