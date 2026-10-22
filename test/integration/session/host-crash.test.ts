import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Bans } from '../../../src/core/net/bans.js'
import { NET_ERRORS } from '../../../src/core/net/errors.js'
import type { Room } from '../../../src/core/net/room.js'
import { DATAGRAM_SYNC } from '../../../src/core/net/wire.js'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { alive, orphanable } from '../net/helpers.js'
import { type Member, member } from './harness.js'
import { type HostChild, type HostChildOptions, killHosts, spawnHost } from './host-child.js'

// Real host crashes: the host's process is SIGKILLed while a viewer plays (no bye, no unannounce; its
// sockets just stop answering), unlike host-sync.test.ts, whose manager.shutdown() and room.close() close
// the links cleanly in the test's own process. The viewer's link to the dead process stays up until UDX
// gives up (~15 s), and the restarted host's first dial can be left half-open by hyperdht.

const roomOf = (m: Member): Room => {
  const cur = (m.manager as unknown as { current: { room: Room } | null }).current
  if (!cur) throw new Error('no session')
  return cur.room
}
const bansOf = (room: Room): Bans => (room as unknown as { bans: Bans }).bans

async function eventually(check: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** The first event matching `pred` among those from index `from` on; resolves with when it was seen. */
async function since<E extends CoreEventName>(
  m: Member,
  from: number,
  e: E,
  pred: (d: CoreEvents[E]) => boolean,
  ms: number,
): Promise<{ d: CoreEvents[E]; at: number }> {
  let hit: CoreEvents[E] | undefined
  await eventually(
    () =>
      (hit = m.client.events.slice(from).find((x) => x.e === e && pred(x.d as CoreEvents[E]))?.d as
        CoreEvents[E] | undefined) !== undefined,
    ms,
    e,
  )
  return { d: hit as CoreEvents[E], at: Date.now() }
}

/**
 * When the viewer heard from the host, as its presence adapter counts it (any room, sync or session bus message
 * from the host, direct or forwarded, or a sync datagram from it), and when the host's heartbeats came.
 */
function hostWords(viewer: Member): { words: number[]; beats: number[] } {
  const room = roomOf(viewer)
  const words: number[] = []
  const beats: number[] = []
  for (const ns of ['room', 'sync', 'session']) {
    room.onMessage(ns, (m) => {
      if (m.from !== room.hostKey || m.via === null) return
      words.push(Date.now())
      if (m.name === 'room.hb') beats.push(Date.now())
    })
  }
  room.onDatagram(DATAGRAM_SYNC, (peer) => {
    if (peer.id === room.hostKey) words.push(Date.now())
  })
  return { words, beats }
}

/** The longest silence between the words at or after `from`. */
function longestGap(words: number[], from: number): number {
  const recent = words.filter((t) => t >= from)
  return Math.max(0, ...recent.slice(1).map((t, i) => t - (recent[i] ?? t)))
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** past the viewer clock's 20 s of 1 s pings (CLOCK.FAST_FOR_MS) */
const PLAY_MS = 25_000

describe.skipIf(!HAVE_FFMPEG)('a host whose process is killed while a viewer plays', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-host-crash-'))
  const viewers: Member[] = []
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterEach(async () => {
    await killHosts()
    await Promise.all(viewers.splice(0).map((v) => v.manager.shutdown()))
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  /** A host process and an in-process viewer, both playing for `playMs`. */
  async function playing(playMs = 4000): Promise<{ host: HostChild; viewer: Member; roomId: string; dir: string }> {
    const video = await fixture('mkv-cues.mkv')
    const dir = mkdtempSync(join(root, 'Host-'))
    const host = await spawnHost({ root, dir })
    const { invite, roomId } = await host.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.until('session', (s) => s.phase === 'in-room', 60_000)
    const viewer = member('Sam', root)
    viewers.push(viewer)
    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join', 30_000)
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room', 30_000)
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect((await host.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await viewer.client.until('playback', (p) => !p.paused && p.posS > 0.5, 30_000)
    // a few seconds of play: sync traffic both ways, and the host saves its anchor (session.json)
    await sleep(playMs)
    return { host, viewer, roomId, dir }
  }

  it('comes back from its folder (core restart) and the viewer follows: same room, restored, playing, no ban', async () => {
    const { host, viewer, roomId, dir } = await playing()
    const room = roomOf(viewer)
    const hostKey = room.hostKey
    const posAtKill = viewer.client.last('playback')?.posS ?? 0
    const from = viewer.client.events.length
    const killAt = Date.now()
    await host.kill()

    // main's automatic core restart: a new process resumes the room that was active in the same folder
    const back = await spawnHost({ root, dir, resumeActive: true })
    const resumed = await back.until('session', (s) => s.phase === 'in-room', 60_000)
    expect(resumed.roomId).toBe(roomId)
    const upMs = Date.now() - killAt

    // the viewer applies the restored state: paused (cause 'restore') at the anchor the host had saved
    const restore = await since(viewer, from, 'sync', (s) => s.mode === 'paused' && s.cause?.kind === 'restore', 30_000)
    const restoredMs = restore.at - killAt
    await since(viewer, from, 'playback', (p) => p.paused, 10_000)
    const restoredPos = viewer.client.last('playback')?.posS ?? NaN
    console.log(
      `after the kill: host back in the room at ${String(upMs)} ms, viewer restored at ${String(restoredMs)} ms ` +
        `(paused at ${restoredPos.toFixed(2)} s, was at ${posAtKill.toFixed(2)} s)`,
    )
    // measured: the new process is in the room ~0.5 s after the kill and the viewer restored ~1.9 s later
    // (staleLinkMs to drop the dead process's link, then the dial back). Without that check the restarted
    // host's half-open dial times out first (authOpenTimeoutMs): ~6.3 s; with UDX alone, ~13 s.
    expect(restoredMs - upMs).toBeLessThan(4000)
    expect(restoredMs).toBeLessThan(15_000)
    // the saved anchor trails the play position by at most the 5 s position updates (+2 s debounce)
    expect(restoredPos).toBeLessThanOrEqual(posAtKill + 0.5)
    expect(restoredPos).toBeGreaterThan(posAtKill - 8)

    // the same room all along: never left, never an error
    const sessions = viewer.client.events.slice(from).filter((x) => x.e === 'session')
    for (const s of sessions) expect((s.d as CoreEvents['session']).phase).toBe('in-room')
    expect(viewer.client.last('session')).toMatchObject({ phase: 'in-room', roomId })

    // and playback goes on with the restarted host
    expect((await back.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await since(viewer, from, 'playback', (p) => !p.paused && p.posS > restoredPos + 1, 30_000)

    // nobody banned anybody: a timeout on a half-open dial is no reason to
    expect(await back.banned([room.self])).toEqual([])
    expect(back.authFailures.filter((f) => f.code !== NET_ERRORS.authTimeout)).toEqual([])
    expect(bansOf(room).has(hostKey)).toBe(false)
  })

  /**
   * Plays for PLAY_MS, kills the host process, and waits for the viewer's pause. `fresh`: right after a host
   * heartbeat reached the viewer. `stale`: just before the next one is due (by the cadence they came at), when
   * the host's last word is as old as it gets.
   */
  async function crashWhilePlaying(phase: 'fresh' | 'stale'): Promise<{
    afterS: number
    lastWordMs: number
    beatGapMs: number
    silenceMs: number
  }> {
    const { host, viewer } = await playing(0)
    const heard = hostWords(viewer)
    const playingAt = Date.now()
    await sleep(PLAY_MS)
    if (phase === 'fresh') {
      const n = heard.beats.length
      await eventually(() => heard.beats.length > n, 5000, 'a host heartbeat')
    } else {
      const gaps = heard.beats.slice(1).map((t, i) => t - (heard.beats[i] ?? t))
      const every = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 1000
      await eventually(() => Date.now() - (heard.beats.at(-1) ?? 0) >= every - 200, 10_000, 'the next beat nearly due')
    }
    const from = viewer.client.events.length
    const killAt = Date.now()
    const lastWordMs = killAt - (heard.words.at(-1) ?? NaN)
    await host.kill()
    const gone = await since(viewer, from, 'notice', (n) => n.code === 'sync.host-gone', 60_000)
    expect(gone.d.message).toMatch(/Host disconnected/)
    await since(viewer, from, 'playback', (p) => p.paused, 5000)
    expect(viewer.client.last('session')?.phase).toBe('in-room')
    return {
      afterS: (gone.at - killAt) / 1000,
      lastWordMs,
      beatGapMs: longestGap(heard.beats, playingAt),
      // once the viewer clock's 20 s of 1 s pings are over (they started before the play)
      silenceMs: longestGap(heard.words, playingAt + 20_000),
    }
  }

  it("that does not come back pauses its viewer with 'Host disconnected' 8.5-16 s after the kill, whenever it dies", async () => {
    // Two rooms side by side. Past the viewer clock's 20 s of fast pings the host's heartbeat is what keeps its
    // last word fresh, and sync pauses 10 s after that word. With room.hb every 5 s, a host killed late in that
    // interval paused its viewer 5.8-9.8 s after the kill (the reviewer's 10 runs).
    const [fresh, stale] = await Promise.all([crashWhilePlaying('fresh'), crashWhilePlaying('stale')])
    const runs = [
      ['fresh', fresh],
      ['stale', stale],
    ] as const
    for (const [phase, r] of runs) {
      console.log(
        `killed ${phase} after ${String(PLAY_MS / 1000)} s of play, its last word ${String(r.lastWordMs)} ms old ` +
          `(longest silence ${String(r.silenceMs)} ms, heartbeats at most ${String(r.beatGapMs)} ms apart): ` +
          `'Host disconnected' ${r.afterS.toFixed(1)} s after the kill`,
      )
    }
    for (const [, r] of runs) {
      // plan §4.5: viewers extrapolate for 10 s after the host's last traffic, then pause
      expect(r.afterS).toBeGreaterThan(8.5)
      expect(r.afterS).toBeLessThan(16)
      // a live host is never long silent, so wherever it dies its last word is at most ~1 s old
      expect(r.beatGapMs).toBeLessThan(1600)
      expect(r.silenceMs).toBeLessThan(1600)
    }
  })
})

describe('a host child', () => {
  it('shuts down and exits once the process that started it is gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-host-orphan-'))
    const opts: HostChildOptions = { root, dir: mkdtempSync(join(root, 'Host-')) }
    const script = fileURLToPath(new URL('./host-child.ts', import.meta.url))
    const env = { ...process.env, WT_HOST_CHILD: JSON.stringify(opts) }
    const { parent, childPid } = await orphanable(script, [], env, 'ready')
    try {
      parent.kill('SIGKILL')
      // before, it lived on (re-parented) with its SessionManager
      await eventually(() => !alive(childPid), 10_000, 'the orphaned host child exits')
    } finally {
      if (alive(childPid)) process.kill(childPid, 'SIGKILL')
      rmSync(root, { recursive: true, force: true })
    }
  })
})
