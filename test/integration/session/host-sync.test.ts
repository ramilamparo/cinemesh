import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Room } from '../../../src/core/net/room.js'
import { DATAGRAM_SYNC } from '../../../src/core/net/wire.js'
import type { OscRanges } from '../../../src/core/player/osc-bridge.js'
import type { FakePlayer } from '../../../src/core/session/fake-player.js'
import { type SessionFile, sessionFilePath } from '../../../src/core/session/session-file.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Host-side sync wiring with a real viewer on a local testnet (fake players): the viewer gets the room's
// state without any host action, EOF keeps everyone in the room, and a host that goes away (or crashes, or
// comes back from a session.json that missed its last publishes) is followed.

interface Internals {
  deps: { control: { power: (on: boolean) => void } }
  current: {
    player: { player: FakePlayer } | null
    room: Room
    syncEngine(): SyncEngine | null
    file: SessionFile | null
  } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

/**
 * When a viewer last heard from the host, as its presence adapter counts it (any bus message from the host,
 * or a sync datagram), and when its sync paused for the host being gone.
 */
function watchHost(viewer: Member): { lastWord: () => number; heartbeats: () => number; goneAt: () => number | null } {
  const cur = internals(viewer).current
  const engine = cur?.syncEngine()
  if (!cur || !engine) throw new Error('no viewer session')
  const hostId = cur.room.state().hostKey
  let last = Date.now()
  let heartbeats = 0
  let gone: number | null = null
  for (const ns of ['room', 'sync', 'session']) {
    cur.room.onMessage(ns, (m) => {
      if (m.from !== hostId) return
      last = Date.now()
      if (m.name === 'room.hb') heartbeats++
    })
  }
  cur.room.onDatagram(DATAGRAM_SYNC, (peer) => {
    if (peer.id === hostId) last = Date.now()
  })
  engine.on('notice', (n) => {
    if (n.code === 'sync.host-gone') gone ??= Date.now()
  })
  return { lastWord: () => last, heartbeats: () => heartbeats, goneAt: () => gone }
}

/** Every control.power call from now on. */
function recordPower(m: Member): boolean[] {
  const calls: boolean[] = []
  internals(m).deps.control.power = (on) => calls.push(on)
  return calls
}

async function eventually(check: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Waits for an event matching `pred` among those emitted from index `from` on (Client.until also sees older ones). */
async function since<E extends CoreEventName>(
  m: Member,
  from: number,
  e: E,
  pred: (d: CoreEvents[E]) => boolean,
  ms = 15_000,
): Promise<void> {
  await eventually(() => m.client.events.slice(from).some((x) => x.e === e && pred(x.d as CoreEvents[E])), ms)
}

async function hostAndViewer(
  root: string,
  opts: { thinkMs?: number } = {},
): Promise<{ host: Member; viewer: Member; roomId: string }> {
  const video = await fixture('mkv-cues.mkv')
  const host = member('Host', root)
  const viewer = member('Sam', root)
  const { invite, roomId } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
  await host.client.until('session', (s) => s.phase === 'in-room')
  await viewer.client.request('session.join', { invite })
  await viewer.client.until('session', (s) => s.phase === 'confirm-join')
  // a user reading JoinConfirm: the host's sync.state republishes meanwhile reach no sync engine yet
  if (opts.thinkMs) await new Promise((r) => setTimeout(r, opts.thinkMs))
  await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
  await viewer.client.until('session', (s) => s.phase === 'in-room')
  return { host, viewer, roomId }
}

describe.skipIf(!HAVE_FFMPEG)('host session: sync wiring', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-host-sync-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it('a viewer joining a paused room gets its state with no host action; the host timeline has three states', async () => {
    const { host, viewer } = await hostAndViewer(root, { thinkMs: 2500 })
    const viewerPower = recordPower(viewer)

    // nobody presses anything: the hello reply (or the sticky replay) must reach the viewer's engine
    const sync = await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect(sync.canSeek).toBe(false)
    await viewer.client.until('peers', (ps) => ps.some((p) => p.self && p.phase === 'paused'), 15_000)
    await host.client.until('peers', (ps) => ps.some((p) => p.name === 'Sam' && p.phase === 'paused'), 15_000)

    // host: the OSC paints what every viewer has as downloaded, and the renderer gets the same layers
    const tl = await host.client.until('timeline', (t) => t.groupDone !== undefined)
    expect(tl.done).toEqual([[0, tl.durationS]])
    const osc = internals(host).current?.player?.player.oscLog ?? []
    const ranges = osc.filter((m) => m.kind === 'ranges').map((m) => m.payload as OscRanges)
    const withGroup = ranges.filter((r) => r.groupDone !== undefined)
    expect(withGroup.length).toBeGreaterThan(0)
    for (const r of withGroup) expect(r.done).toEqual(r.groupDone)

    // keep-awake follows the download: off once the video is complete although the viewer stays in the room
    await viewer.client.until('transfer', (t) => t.progress >= 1, 30_000)
    await eventually(() => viewerPower.at(-1) === false)
    expect(viewer.client.last('session')?.phase).toBe('in-room')

    await viewer.manager.shutdown()
    await host.manager.shutdown()
  })

  it('EOF ends the sync mode but keeps both sessions in the room, and Play again starts over', async () => {
    const { host, viewer } = await hostAndViewer(root)
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    const dur = host.client.last('session')?.durationS ?? 0
    expect(dur).toBeGreaterThan(20)

    expect((await host.client.request('playback.intent', { kind: 'seek', posS: dur - 2.5 })).accepted).toBe(true)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await host.client.until('sync', (s) => s.mode === 'ended', 30_000)
    await viewer.client.until('sync', (s) => s.mode === 'ended', 30_000)
    // the ended card is the Room's (sync mode ended); session phase 'ended' would mean the room closed
    for (const m of [host, viewer]) {
      expect(m.client.all('session').map((s) => s.phase)).not.toContain('ended')
      expect(m.client.last('session')?.phase).toBe('in-room')
    }

    // Play again: seek to 0 through a barrier, then play
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await host.client.until('sync', (s) => s.mode === 'playing', 30_000)
    await viewer.client.until('playback', (p) => !p.paused && p.posS < 5, 30_000)

    await viewer.manager.shutdown()
    await host.manager.shutdown()
  })

  it('a host that goes away pauses the viewer with "Host disconnected", and its return is announced', async () => {
    const { host, viewer, roomId } = await hostAndViewer(root)
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await viewer.client.until('playback', (p) => !p.paused && p.posS > 0.5, 30_000)

    // quit without ending the room (the host can resume it); its bye tells the viewer at once
    const quitAt = Date.now()
    await host.manager.shutdown()
    const gone = await viewer.client.until('notice', (n) => n.code === 'sync.host-gone', 45_000)
    expect(gone.message).toMatch(/Host disconnected/)
    // plan §4.5: extrapolate for 10 s, then pause (not 10 s more after net's own 10 s traffic window)
    const waitedS = (Date.now() - quitAt) / 1000
    expect(waitedS).toBeGreaterThan(9)
    expect(waitedS).toBeLessThan(16)
    await viewer.client.until('playback', (p) => p.paused, 5_000)
    expect(viewer.client.last('session')?.phase).toBe('in-room')

    const sinceQuit = viewer.client.events.length
    const back = member('Host', root, { dir: host.dir })
    await back.client.request('session.resume', { roomId })
    await viewer.client.until('notice', (n) => n.code === 'sync.host-back', 45_000)
    // the resumed host restores the room paused (same epoch, next seq) and the viewer applies it
    await back.client.until('session', (s) => s.phase === 'in-room', 30_000)
    await eventually(() => viewer.client.events.slice(sinceQuit).some((x) => x.e === 'sync'), 30_000)
    expect(viewer.client.last('sync')?.mode).toBe('paused')
    // and follows it again
    expect((await back.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await eventually(
      () =>
        viewer.client.events.slice(sinceQuit).some((x) => x.e === 'playback' && !(x.d as { paused: boolean }).paused),
      30_000,
    )

    await viewer.manager.shutdown()
    await back.manager.shutdown()
  })

  it("a host that crashes (no bye) pauses the viewer 10 s after its last word, not after net's window too", async () => {
    const { host, viewer } = await hostAndViewer(root)
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await viewer.client.until('playback', (p) => !p.paused && p.posS > 0.5, 30_000)
    const watch = watchHost(viewer)
    // the watch starts with no word heard: wait for the host's next heartbeat (every second), else the true last
    // word may lie up to a second before the watch began and the 10 s check would measure from the wrong moment
    const beats = watch.heartbeats()
    await eventually(() => watch.heartbeats() > beats, 10_000)

    // a crash: the host's sync goes silent and its room disappears without a goodbye
    const cur = internals(host).current
    if (!cur) throw new Error('no host session')
    const crashAt = Date.now()
    cur.syncEngine()?.stop()
    await cur.room.close()
    const gone = await viewer.client.until('notice', (n) => n.code === 'sync.host-gone', 45_000)
    expect(gone.message).toMatch(/Host disconnected/)
    // sync's 10 s grace counts from the host's last word (net's own 10 s traffic window must not come first)
    const goneAt = watch.goneAt() ?? NaN
    expect(watch.lastWord()).toBeLessThanOrEqual(crashAt + 50)
    expect(Math.abs((goneAt - watch.lastWord()) / 1000 - 10)).toBeLessThan(0.5)
    expect((goneAt - crashAt) / 1000).toBeLessThan(10.5)
    await viewer.client.until('playback', (p) => p.paused, 5_000)
    expect(viewer.client.last('session')?.phase).toBe('in-room')

    await viewer.manager.shutdown()
    await host.manager.shutdown()
  })

  it("the grace counts from the host's last word, not from when its link finally closes", async () => {
    const { host, viewer } = await hostAndViewer(root)
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await viewer.client.until('playback', (p) => !p.paused && p.posS > 0.5, 30_000)
    const watch = watchHost(viewer)

    // the host goes quiet (a frozen process: its sync stops, then its room's 1 Hz tick, which sends its heartbeat)
    // while its link stays open; the link closes seconds later
    const cur = internals(host).current
    if (!cur) throw new Error('no host session')
    cur.syncEngine()?.stop()
    const beats = watch.heartbeats()
    await eventually(() => watch.heartbeats() > beats, 10_000)
    ;(cur.room as unknown as { tick: () => void }).tick = () => undefined
    await new Promise((r) => setTimeout(r, 3000))
    const closedAt = Date.now()
    await cur.room.close()
    await viewer.client.until('notice', (n) => n.code === 'sync.host-gone', 45_000)
    const goneAt = watch.goneAt() ?? NaN
    expect(closedAt - watch.lastWord()).toBeGreaterThan(2500)
    expect(Math.abs((goneAt - watch.lastWord()) / 1000 - 10)).toBeLessThan(0.5)
    await viewer.client.until('playback', (p) => p.paused, 5_000)

    await viewer.manager.shutdown()
    await host.manager.shutdown()
  })

  it('a host resumed from a session.json that missed its last publishes still moves the viewer', async () => {
    const { host, viewer, roomId } = await hostAndViewer(root)
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    const seekTo = async (posS: number): Promise<void> => {
      const from = viewer.client.events.length
      expect((await host.client.request('playback.intent', { kind: 'seek', posS })).accepted).toBe(true)
      await since(viewer, from, 'playback', (p) => p.paused && Math.abs(p.posS - posS) < 0.05)
    }
    const cur = internals(host).current
    if (!cur?.file) throw new Error('no host session')
    const path = sessionFilePath(join(host.dir, 'userData'), roomId)
    await seekTo(8)
    await cur.file.flush()
    const stale = readFileSync(path, 'utf8')
    // publishes the file will turn out to have missed: the viewer holds seqs well past the one in it
    for (const pos of [3, 5, 4, 6, 5, 4, 6, 3, 5, 3]) await seekTo(pos)

    // crash: sync goes silent and the room vanishes without a bye; its last writes are lost
    cur.syncEngine()?.stop()
    await cur.room.close()
    await cur.file.flush() // writes still in flight land first
    writeFileSync(path, stale)

    const from = viewer.client.events.length
    const back = member('Host', root, { dir: host.dir })
    await back.client.request('session.resume', { roomId })
    await back.client.until('session', (s) => s.phase === 'in-room', 30_000)
    // the room comes back paused at 8, as the file says: the viewer follows it instead of keeping 3
    await since(viewer, from, 'playback', (p) => p.paused && Math.abs(p.posS - 8) < 0.05, 20_000)
    // and keeps following: a play from the resumed host reaches it
    expect((await back.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await since(viewer, from, 'playback', (p) => !p.paused && p.posS > 8, 30_000)

    await viewer.manager.shutdown()
    await back.manager.shutdown()
    await host.manager.shutdown()
  })
})
