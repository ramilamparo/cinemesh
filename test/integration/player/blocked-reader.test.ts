import { execFileSync } from 'node:child_process'
import { type FileHandle, open } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { indexMediaFile } from '../../../src/core/media/build-index.js'
import { StreamServer } from '../../../src/core/media/stream-server.js'
import { FakeSource } from '../../../src/core/media/testing/fake-source.js'
import { type MpvCommand, MpvIpc } from '../../../src/core/player/mpv-ipc.js'
import {
  type ExternalChange,
  type PlayerControllerOptions,
  PlayerController,
} from '../../../src/core/player/player-controller.js'
import type { PlayerStatus } from '../../../src/shared/ipc/core.js'
import { buildManifest } from '../../../src/shared/media/manifest.js'
import { MediaMap } from '../../../src/shared/media/media-map.js'
import { mergeRanges } from '../../../src/shared/media/ranges.js'
import type { ByteRange } from '../../../src/shared/media/types.js'
import { defaultSettings } from '../../../src/shared/settings.js'
import { themePayload } from '../../../src/shared/theme-tokens.js'
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
  sleep,
  socketDir,
  tapIpc,
  until,
  waitFor,
  within,
} from './helpers.js'

// ADR 0004 §5 on a viewer: mpv streams a clip from StreamServer while only some pieces exist, so its
// read-ahead blocks on a missing piece. A seek outside the demuxer cache and an audio switch must then
// reload (loadfile … start=) instead of queueing behind that read, which S4 saw never complete; a seek
// inside the cache still seeks. 30 s at 2 Mbit/s: the open-critical head ends near 5 s, and readyRange(20 s)
// lies far past it.

const PIECE = 16 * 1024
const TARGET_S = 20

interface Streamed {
  map: MediaMap
  server: StreamServer
  url: string
  release: (ranges: readonly ByteRange[]) => void
  close: () => Promise<void>
}

async function stream(path: string): Promise<Streamed> {
  const index = await indexMediaFile(path)
  const manifest = buildManifest(index, { infoHash: new Uint8Array(20), pieceLength: PIECE })
  const map = new MediaMap(manifest)
  const fh: FileHandle = await open(path, 'r')
  const source = new FakeSource(
    [{ index: 0, name: basename(path), offset: 0, length: index.fileSize }],
    PIECE,
    async (abs, len) => {
      const buf = new Uint8Array(len)
      const { bytesRead } = await fh.read(buf, 0, len, abs)
      return buf.subarray(0, bytesRead)
    },
  )
  const release = (ranges: readonly ByteRange[]): void => {
    for (const r of mergeRanges(ranges, index.fileSize)) {
      const span = map.piecesOf(r)
      if (span) for (let i = span[0]; i <= span[1]; i++) source.release(i)
    }
  }
  release([...manifest.openCritical, ...manifest.seekCritical])
  const server = await StreamServer.listen(source)
  return {
    map,
    server,
    url: server.url(0),
    release,
    close: async () => {
      await server.close()
      await fh.close()
    },
  }
}

describe.skipIf(!HAVE_MPV || !HAVE_FFMPEG)('PlayerController with a blocked stream reader', () => {
  let fx: Fixture
  let mp4 = ''
  let subs = ''
  let player: PlayerController | null = null
  let streamed: Streamed | null = null
  let runs = 0
  const warnings: string[] = []

  beforeAll(async () => {
    fx = await makeFixture({ durationS: 30, videoBitrate: '2M' })
    mp4 = join(fx.dir, 'clip.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fx.clip, '-map', '0:v', '-map', '0:a', '-c', 'copy', mp4])
    subs = join(fx.dir, 'clip-subs.mkv')
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-i', fx.clip, '-i', fx.srt, '-map', '0:v', '-map', '0:a', '-map', '1:s', '-c', 'copy',
      '-metadata:s:s:0', 'language=eng', subs,
    ])
  })
  afterAll(async () => {
    await fx.cleanup()
  })
  afterEach(async () => {
    await player?.dispose()
    player = null
    await streamed?.close()
    streamed = null
    warnings.length = 0
  })

  /** Loads the clip at 0 through the server and waits until mpv's read-ahead blocks past the head. */
  async function blockedViewer(
    path: string,
    report: () => boolean = () => true,
    over: Partial<PlayerControllerOptions> = {},
  ): Promise<{ p: PlayerController; s: Streamed } & IpcTap> {
    if (!MPV_VERSION) throw new Error('no mpv')
    const s = await stream(path)
    streamed = s
    const p = new PlayerController({
      mpv: { path: 'mpv', kind: 'system', version: MPV_VERSION },
      role: 'viewer',
      resourcesDir: RESOURCES,
      logFile: join(fx.dir, `mpv-blocked-${String(++runs)}.log`),
      settings: defaultSettings(),
      theme: themePayload('dark', 'dark'),
      perms: { isHost: false, canPlayPause: true, canSeek: true },
      mediaTitle: basename(path),
      extraArgs: [...HEADLESS, '--script-opts=wt_osc-test-dims=1280x720'],
      hooks: { readerBlocked: () => report() && s.server.isBlocked(0) },
      // a seek behind a blocked read never completes (S4), so the backstop would only hide a missed reload
      timing: { seekWatchdogMs: 60_000 },
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: (m) => warnings.push(m),
        error: (m) => warnings.push(m),
      },
      ...over,
    })
    player = p
    const idle = waitFor(p, 'state', (st: PlayerStatus) => st === 'idle')
    p.start()
    await idle
    const { commands, sets } = tapIpc(p)
    await p.load(s.url, { start: 0, paused: true })
    await until(() => s.server.isBlocked(0), 10_000)
    commands.length = 0
    return { p, s, commands, sets }
  }

  /** Embedded sid 1 and aid 2 (jpn), each chosen while blocked and so each by reload. */
  async function chooseSubAndAudio(p: PlayerController, s: Streamed): Promise<void> {
    for (const [kind, id] of [
      ['sub', 1],
      ['audio', 2],
    ] as const) {
      const restarted = waitFor(p, 'playbackRestart')
      await p.setTrack(kind, id)
      await restarted
      await until(() => s.server.isBlocked(0), 10_000)
    }
  }

  const timePos = async (p: PlayerController): Promise<number> => (await p.getProperty<number>('time-pos')).value

  const outcome = (e: unknown): string => (e as { code?: string }).code ?? String(e)

  /** Another client on our mpv: a console `loadfile` or `stop`, macOS File > Open, a second IPC client. */
  async function otherClient(p: PlayerController, command: MpvCommand): Promise<void> {
    const endpoint = p.ipcEndpoint
    if (endpoint === null) throw new Error('no IPC endpoint')
    const client = await MpvIpc.connect(endpoint)
    try {
      await client.command(command)
    } finally {
      client.close()
    }
  }

  /** A viewer whose IPC another client can reach, reporting states and external changes from here on. */
  async function sharedViewer(sockDir: string): Promise<{
    p: PlayerController
    s: Streamed
    states: PlayerStatus[]
    paths: (string | null)[]
    externals: ExternalChange[]
  }> {
    const { p, s } = await blockedViewer(fx.clip, () => true, {
      selfReload: false,
      ipcMode: 'socket',
      runtimeDir: sockDir,
    })
    const states: PlayerStatus[] = []
    const paths: (string | null)[] = []
    const externals: ExternalChange[] = []
    p.on('state', (st) => states.push(st))
    p.on('external-change', (c) => {
      externals.push(c)
      if (c.kind === 'path') paths.push(c.path)
    })
    return { p, s, states, paths, externals }
  }

  /**
   * Has `client` send `command` as soon as we handled mpv's reply to our next loadfile. The entry that loadfile
   * replaces waits on a missing piece, and mpv runs commands while it waits for that demuxer to close (~0.2 s,
   * kill_demuxers_reentrant), so `command` runs before our new entry can start. Resolves once mpv answered it.
   * `started` collects the playlist entry ids of the start-file events from then on.
   */
  function afterNextLoadfileReply(
    p: PlayerController,
    client: MpvIpc,
    command: MpvCommand,
  ): { answered: Promise<unknown>; ours: () => number | null; started: number[] } {
    const internals = p as unknown as { ipc: MpvIpc; ownEntry: number | null }
    const ipc = internals.ipc
    const send = ipc.command.bind(ipc)
    const answered = Promise.withResolvers<unknown>()
    const started: number[] = []
    ipc.on('event', (e) => {
      if (e.event === 'start-file' && typeof e.playlist_entry_id === 'number') started.push(e.playlist_entry_id)
    })
    let armed = true
    ipc.command = (args, opts) => {
      const onReply = opts?.onReply
      if (!armed || !Array.isArray(args) || args[0] !== 'loadfile' || !onReply) return send(args, opts)
      armed = false
      return send(args, {
        ...opts,
        onReply: (data) => {
          onReply(data)
          answered.resolve(client.command(command).catch(String))
        },
      })
    }
    return { answered: answered.promise, ours: () => internals.ownEntry, started }
  }

  it('reloads for a seek outside the demuxer cache, and seeks inside it', async () => {
    const { p, s, commands } = await blockedViewer(fx.clip)
    const states: PlayerStatus[] = []
    const externals: ExternalChange[] = []
    p.on('state', (st) => states.push(st))
    p.on('external-change', (c) => externals.push(c))

    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    await p.seek(TARGET_S)
    expect(loadfiles(commands)).toEqual([`start=${String(TARGET_S)},pause=yes`])
    expect(await timePos(p)).toBeCloseTo(TARGET_S, 1)
    expect(states).toEqual([]) // the reload stands in for a seek: still 'ready'

    // the reloaded reader blocks again where the released range ends; 21 s is in mpv's cache
    await until(() => s.server.isBlocked(0) && p.buffered().some(([a, b]) => a <= 21 && b >= 22), 10_000)
    commands.length = 0
    await p.seek(21)
    expect(commands).toEqual([['seek', 21, 'absolute+exact']])
    expect(await timePos(p)).toBeCloseTo(21, 1)
    expect(externals).toEqual([])
  })

  for (const ext of ['mkv', 'mp4'] as const) {
    it(`${ext}: switches audio by reload, carrying aid and alang, and keeps playing`, async () => {
      const { p, commands, sets } = await blockedViewer(ext === 'mkv' ? fx.clip : mp4)
      const restarted = waitFor(p, 'playbackRestart')
      await p.setTrack('audio', 2)
      await restarted
      expect(loadfiles(commands)).toEqual(['start=0,pause=yes,aid=2,alang=jpn'])
      expect(sets).toEqual([]) // never set_property aid: its refresh seek waits behind the read (S4)
      expect((await p.getProperty('aid')).value).toBe(2)
      expect(p.tracks().aid).toBe(2)

      // a plain switch here froze playback in S4 (0 s in 3 s); after the reload it plays from the cache
      await p.setPaused(false)
      await until(async () => (await timePos(p)) > 0.8, 5000)
      await p.setPaused(true)
      expect(warnings).toEqual([])
    })
  }

  it('brings back an aid set at runtime: the reload carries alang, which mpv honours', async () => {
    let report = true
    const { p, s, commands, sets } = await blockedViewer(fx.clip, () => report)
    // a switch while nothing looked blocked is a runtime set_property (S4: mpv then ignores a later
    // per-file aid=2 of the same value and comes back with aid 1, finding 2)
    report = false
    await p.setTrack('audio', 2)
    expect(sets).toEqual([['aid', 2]])
    report = true

    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    await p.seek(TARGET_S)
    expect(loadfiles(commands)).toEqual([`start=${String(TARGET_S)},pause=yes,aid=2,alang=jpn`])
    await until(async () => (await p.getProperty('aid')).value === 2, 2000)
    expect(sets).toEqual([['aid', 2]]) // no fallback set_property after file-loaded
    expect(warnings).toEqual([])
  })

  it('reloads when mpv switched audio itself (OSC select-aid) while blocked', async () => {
    const { p, commands } = await blockedViewer(fx.clip)
    const ipc = (p as unknown as { ipc: MpvIpc }).ipc
    const restarted = waitFor(p, 'playbackRestart')
    await ipc.setProperty('aid', 2)
    await restarted
    expect(loadfiles(commands)).toEqual(['start=0,pause=yes,aid=2,alang=jpn'])
    expect(p.tracks().aid).toBe(2)
    await p.setPaused(false)
    await until(async () => (await timePos(p)) > 0.8, 5000)
  })

  it('selects an embedded subtitle by reload while blocked, an external one by set_property', async () => {
    const { p, s, commands, sets } = await blockedViewer(subs)
    const restarted = waitFor(p, 'playbackRestart')
    await p.setTrack('sub', 1)
    await restarted
    // an embedded sid refresh-seeks like aid: 0 s played in 2 s behind a blocked read (ADR 0004, "Applied")
    expect(loadfiles(commands)).toEqual(['start=0,pause=yes,sid=1'])
    expect((await p.getProperty('sid')).value).toBe(1)
    await p.setPaused(false)
    await until(async () => (await timePos(p)) > 0.8, 5000)
    await p.setPaused(true)

    // a seek reload carries it too, so nothing is set after file-loaded
    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    commands.length = 0
    await p.seek(TARGET_S)
    expect(loadfiles(commands)).toEqual([`start=${String(TARGET_S)},pause=yes,sid=1`])
    expect((await p.getProperty('sid')).value).toBe(1)

    // an external subtitle has its own demuxer: no refresh seek of the stream, so no reload
    await p.addSubtitle({ url: fx.srt, title: 'ext', lang: 'eng' })
    await until(() => p.tracks().sub.length === 2, 5000)
    commands.length = 0
    await p.setTrack('sub', 2)
    expect(loadfiles(commands)).toEqual([])
    expect(sets).toEqual([['sid', 2]])
    expect(warnings).toEqual([])
  })

  it('keeps the embedded sid and alang in a reload sent while another is in flight', async () => {
    const { p, s, commands, sets } = await blockedViewer(subs)
    await chooseSubAndAudio(p, s)
    const second = TARGET_S + 2
    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    s.release(s.map.readyRange(second * 1000, 3000))
    commands.length = 0
    // Sync seeks again while a seek is in flight (member.settle). mpv empties track-list from the first
    // reload's loadfile until the new demuxer opens, and the second reload's options are built in that gap.
    const reseek: { outcome: Promise<'restarted' | 'stalled'> | null } = { outcome: null }
    p.on('property', (name, value) => {
      if (name !== 'track-list' || !Array.isArray(value) || value.length > 0) return
      reseek.outcome ??= Promise.race([
        p.seek(second).then(() => 'restarted' as const),
        sleep(5000).then(() => 'stalled' as const),
      ])
    })
    void p.seek(TARGET_S).catch(() => undefined)
    await until(() => reseek.outcome !== null, 5000)
    const outcome = await reseek.outcome
    expect(loadfiles(commands)).toEqual([
      `start=${String(TARGET_S)},pause=yes,aid=2,alang=jpn,sid=1`,
      `start=${String(second)},pause=yes,aid=2,alang=jpn,sid=1`,
    ])
    // a set_property sid after file-loaded refresh-seeks, which waits behind the blocked read
    expect(sets).toEqual([])
    expect(outcome).toBe('restarted')
    expect(await timePos(p)).toBeCloseTo(second, 1)
    expect((await p.getProperty('sid')).value).toBe(1)
    expect(warnings).toEqual([])
  })

  for (const selfReload of [true, false]) {
    const who = selfReload ? 'its own reload' : "the caller's load"
    it(`carries the embedded sid and alang across a crash restart in ${who} (selfReload: ${String(selfReload)})`, async () => {
      const { p, s, commands, sets } = await blockedViewer(subs, () => true, {
        selfReload,
        timing: { seekWatchdogMs: 60_000, restartDelaysMs: [100] },
      })
      await chooseSubAndAudio(p, s)
      const pid = p.pid
      if (pid === null) throw new Error('no pid')
      commands.length = 0
      // a crash clears every property the controller observed, track-list too
      const idle = new Promise<void>((resolve) => {
        const on = (st: PlayerStatus): void => {
          if (st !== 'idle') return
          p.off('state', on)
          tapIpc(p, { commands, sets })
          resolve()
        }
        p.on('state', on)
      })
      process.kill(pid, 'SIGKILL')
      await idle
      const outcome = await Promise.race([
        selfReload
          ? waitFor(p, 'state', (st: PlayerStatus) => st === 'ready', 10_000)
          : p.load(s.url, { start: 0, paused: true }), // what sync's member does once the player is back
        sleep(10_000).then(() => Promise.reject(new Error('stalled'))),
      ]).then(
        () => 'restarted',
        (e: unknown) => String(e),
      )
      expect(loadfiles(commands)).toEqual(['start=0,pause=yes,aid=2,alang=jpn,sid=1'])
      // set after file-loaded instead, sid refresh-seeks and the restart waits behind the blocked read
      expect(sets).toEqual([])
      expect(outcome).toBe('restarted')
      await until(async () => (await p.getProperty('sid')).value === 1 && (await p.getProperty('aid')).value === 2)
      expect(warnings).toEqual([])
    })
  }

  it("selfReload false: another client's loadfile supersedes a seek waiting behind a blocked read", async () => {
    const sock = await socketDir()
    try {
      // never reported blocked, so the seek is a plain one that waits behind the read (S4: until the piece)
      const { p } = await blockedViewer(fx.clip, () => false, {
        selfReload: false,
        ipcMode: 'socket',
        runtimeDir: sock.dir,
      })
      const paths: (string | null)[] = []
      p.on('external-change', (c) => {
        if (c.kind === 'path') paths.push(c.path)
      })
      const seek = p.seek(TARGET_S).then(
        () => 'resolved',
        (e: unknown) => (e as { code?: string }).code ?? String(e),
      )
      await sleep(300)
      const endpoint = p.ipcEndpoint
      if (endpoint === null) throw new Error('no IPC endpoint')
      const client = await MpvIpc.connect(endpoint)
      try {
        // a console `loadfile` or another IPC client: mpv drops the blocked read and opens the other file
        await client.command(['loadfile', mp4, 'replace'])
        await until(() => p.prop('path') === mp4 && p.tracks().audio.length === 2, 10_000)
        await sleep(300)
      } finally {
        client.close()
      }
      // not resolved by the other file's playback-restart; idle, so the caller reloads ours
      expect(await seek).toBe('player-superseded')
      expect(p.status).toBe('idle')
      expect(paths).toHaveLength(1)
    } finally {
      await sock.cleanup()
    }
  })

  // Our load() waits on missing data (sync's member at a late joiner's rendezvous target, or reloading after a
  // crash or a Reopen) while another client acts. Our load never completes then: neither the other file's
  // playback-restart nor a stop may leave the controller 'ready' (sync would settle and play that file).
  const others: [string, (s: Streamed) => readonly unknown[]][] = [
    ['loads another file', () => ['loadfile', mp4, 'replace']],
    // the same path: no path change at all, only the playlist entry id tells
    ['loads our own URL', (s) => ['loadfile', s.url, 'replace']],
    ['stops', () => ['stop']],
  ]
  for (const [what, command] of others) {
    it(`selfReload false: another client ${what} while our load() waits on missing data`, async () => {
      const sock = await socketDir()
      try {
        const { p, s, states, paths, externals } = await sharedViewer(sock.dir)
        // the target's pieces are missing: mpv opens the file and its start seek waits on them
        const opened = waitFor(p, 'fileLoaded')
        const load = p.load(s.url, { start: TARGET_S, paused: true }).then(() => 'loaded', outcome)
        await opened
        await until(() => s.server.isBlocked(0), 10_000)
        const restarted = waitFor(p, 'playbackRestart').then(() => true)
        await otherClient(p, command(s))
        expect(await within(load)).toBe('player-superseded')
        expect(p.status).toBe('idle')
        // the other file plays on (a stop leaves mpv empty) and changes nothing more, a seek of it included
        if (command(s)[0] === 'loadfile') {
          expect(await within(restarted)).toBe(true)
          const seeked = waitFor(p, 'playbackRestart')
          await otherClient(p, ['seek', 2, 'absolute'])
          await seeked
        } else await until(() => p.prop('path') === undefined, 5000)
        expect(p.status).toBe('idle')
        expect(states).toEqual(['loading', 'idle'])
        expect(paths).toEqual([null])
        expect(externals).toEqual([{ kind: 'path', path: null }])
        // sync's member reloads ours on 'idle'
        await p.load(s.url, { start: 0, paused: true })
        expect(p.status).toBe('ready')
        expect(paths).toHaveLength(1)
      } finally {
        await sock.cleanup()
      }
    })
  }

  it("selfReload false: another client's loadfile while a reload standing in for a seek waits on missing data", async () => {
    const sock = await socketDir()
    try {
      const { p, s, states, paths } = await sharedViewer(sock.dir)
      // blocked, and the target is outside the cache: a reload, whose start seek waits on the target's pieces
      const opened = waitFor(p, 'fileLoaded')
      const seek = p.seek(TARGET_S).then(() => 'resolved', outcome)
      await opened
      await until(() => s.server.isBlocked(0), 10_000)
      const restarted = waitFor(p, 'playbackRestart')
      await otherClient(p, ['loadfile', mp4, 'replace'])
      expect(await within(seek)).toBe('player-superseded')
      await restarted
      expect(p.status).toBe('idle')
      expect(states).toEqual(['idle'])
      expect(paths).toEqual([null])
      await p.load(s.url, { start: 0, paused: true })
      expect(p.status).toBe('ready')
      expect(paths).toHaveLength(1)
    } finally {
      await sock.cleanup()
    }
  })

  // A stop or a playlist removal that mpv runs after it answered our loadfile, while the entry that loadfile
  // replaces still closes: our entry never starts, so neither its start-file nor its end-file comes, only mpv's
  // 'idle'. Round-4 review: a load() then stayed 'loading' for good (sync's member never reloads), and a seek's
  // reload left the controller 'ready' on an empty mpv. A playlist-clear keeps the current entry, which is ours.
  const drops: [string, MpvCommand][] = [
    ['stops', ['stop']],
    ['removes our entry', ['playlist-remove', 'current']],
  ]
  for (const [what, command] of drops) {
    for (const request of ['load', 'seek'] as const) {
      const ours = request === 'load' ? 'our load()' : "a seek's reload"
      it(`selfReload false: another client ${what} after mpv answered ${ours}'s loadfile, before it started`, async () => {
        const sock = await socketDir()
        try {
          const { p, s, states, paths, externals } = await sharedViewer(sock.dir)
          const endpoint = p.ipcEndpoint
          if (endpoint === null) throw new Error('no IPC endpoint')
          const client = await MpvIpc.connect(endpoint)
          try {
            const other = afterNextLoadfileReply(p, client, command)
            const pending =
              request === 'load'
                ? p.load(s.url, { start: TARGET_S, paused: true }).then(() => 'loaded', outcome)
                : p.seek(TARGET_S).then(() => 'resolved', outcome) // blocked, outside the cache: a reload
            expect(await within(other.answered)).not.toBe('stalled')
            expect(await within(pending)).toBe('player-superseded')
            expect(p.status).toBe('idle')
            expect(states).toEqual(request === 'load' ? ['loading', 'idle'] : ['idle'])
            expect(paths).toEqual([null])
            expect(externals).toEqual([{ kind: 'path', path: null }])
            expect((await p.getProperty('idle-active')).value).toBe(true)
            // the case under test: mpv never started the entry it gave our loadfile
            expect(other.ours()).not.toBeNull()
            expect(other.started).not.toContain(other.ours())
          } finally {
            client.close()
          }
          // sync's member reloads ours on 'idle'
          await p.load(s.url, { start: 0, paused: true })
          expect(p.status).toBe('ready')
          expect(paths).toHaveLength(1)
        } finally {
          await sock.cleanup()
        }
      })
    }
  }

  it("another client's playlist-clear after mpv answered our load()'s loadfile keeps our entry, which loads", async () => {
    const sock = await socketDir()
    try {
      const { p, s, states, paths } = await sharedViewer(sock.dir)
      const endpoint = p.ipcEndpoint
      if (endpoint === null) throw new Error('no IPC endpoint')
      const client = await MpvIpc.connect(endpoint)
      try {
        const other = afterNextLoadfileReply(p, client, ['playlist-clear'])
        // at 0: the head is there, so our entry can complete once it starts
        const load = p.load(s.url, { start: 0, paused: true }).then(() => 'loaded', outcome)
        expect(await within(other.answered)).not.toBe('stalled')
        expect(await within(load)).toBe('loaded')
        expect(other.started).toContain(other.ours())
      } finally {
        client.close()
      }
      expect(p.status).toBe('ready')
      expect(states).toEqual(['loading', 'ready'])
      expect(paths).toEqual([])
    } finally {
      await sock.cleanup()
    }
  })

  it("does not take mpv's own pick of a track, reported after a reload completed, as the user's choice", async () => {
    const { p, s, commands } = await blockedViewer(subs)
    const restarted = waitFor(p, 'playbackRestart')
    await p.setTrack('sub', 1)
    await restarted
    const internals = p as unknown as { ipc: MpvIpc; restoreTracks: boolean }
    await until(() => !internals.restoreTracks)
    // mpv reports aid "auto" between the two files and the track it picked once the new one is loaded. Under
    // load that pick came in after the reload completed and was taken as a user's choice: aid=1 then rode in
    // every later reload (the flaky "selects an embedded subtitle" run). mpv may also send a value again that
    // it read something else in between for.
    internals.ipc.emit('property-change', { id: 0, name: 'aid', value: 'auto' })
    internals.ipc.emit('property-change', { id: 0, name: 'aid', value: 1 })
    internals.ipc.emit('property-change', { id: 0, name: 'aid', value: 1 })
    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    await until(() => s.server.isBlocked(0), 10_000)
    commands.length = 0
    await p.seek(TARGET_S)
    expect(loadfiles(commands)).toEqual([`start=${String(TARGET_S)},pause=yes,sid=1`])

    // a real switch still is the user's choice: subtitles off (as from the OSC) ride in the next reload
    await internals.ipc.setProperty('sid', 'no')
    await until(() => p.tracks().sid === 'no')
    // back to where the reloaded demuxer has nothing (readyRange(20 s) reaches the end of this short clip)
    const next = 10
    s.release(s.map.readyRange(next * 1000, 3000))
    await until(() => s.server.isBlocked(0), 10_000)
    commands.length = 0
    await p.seek(next)
    expect(loadfiles(commands)).toEqual([`start=${String(next)},pause=yes,sid=no`])
    expect(warnings).toEqual([])
  })

  it('completes a reload only at a restart of its own file', async () => {
    const { p, s, commands } = await blockedViewer(fx.clip)
    const internals = p as unknown as { ipc: MpvIpc; reloading: unknown }
    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    let resolved = false
    const seek = p.seek(TARGET_S).then(() => (resolved = true))
    expect(loadfiles(commands)).toHaveLength(1)
    // mpv has not answered the reload's loadfile: a restart now is the old file's
    internals.ipc.emit('event', { event: 'playback-restart' })
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(false)
    expect(internals.reloading).not.toBeNull()
    await seek
    expect(internals.reloading).toBeNull()
    expect(await timePos(p)).toBeCloseTo(TARGET_S, 1)
  })

  it('completes a reload whose loadfile reply, start-file and playback-restart come in one chunk', async () => {
    const { p, s } = await blockedViewer(fx.clip)
    const internals = p as unknown as {
      ipc: { nextRequestId: number; onData: (chunk: string, t: number) => void }
      ownEntry: number
    }
    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    let resolved = false
    void p.seek(TARGET_S).then(() => (resolved = true))
    // What node may read at once: the reply carries the new entry's id (mpv counts them up by one), then that
    // entry's events. mpv's own lines come later and find nothing pending.
    const id = internals.ipc.nextRequestId - 1
    const entry = internals.ownEntry + 1
    internals.ipc.onData(
      `{"request_id":${String(id)},"error":"success","data":{"playlist_entry_id":${String(entry)}}}\n` +
        `{"event":"start-file","playlist_entry_id":${String(entry)}}\n{"event":"file-loaded"}\n` +
        '{"event":"playback-restart"}\n',
      performance.now(),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
    expect(p.status).toBe('ready')
  })

  it('reloads a seek that still waits behind a blocked read when the watchdog fires', async () => {
    let report = false
    const { p, s, commands } = await blockedViewer(fx.clip, () => report, { timing: { seekWatchdogMs: 600 } })
    s.release(s.map.readyRange(TARGET_S * 1000, 3000))
    // nothing looks blocked yet: a plain seek, which queues behind the read
    const done = p.seek(TARGET_S)
    await sleep(300)
    expect(commands).toEqual([['seek', TARGET_S, 'absolute+exact']])
    report = true
    await done
    expect(loadfiles(commands)).toEqual([`start=${String(TARGET_S)},pause=yes`])
    expect(await timePos(p)).toBeCloseTo(TARGET_S, 1)
  })
})
