import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CoreEvents } from '../../../src/shared/ipc/core.js'
import type { FakePlayer } from '../../../src/core/session/fake-player.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// A viewer whose room goes away while the video plays (lead note on onRoomClosed): the host ends it, or
// removes the viewer. The room is over for the viewer, so its sync stops and its player pauses where it
// is, instead of sync extrapolating the last anchor (and reporting the host gone 10 s later, on top of
// the closed card or the error screen).

interface Internals {
  current: { player: { player: FakePlayer } | null; syncEngine(): unknown } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!HAVE_FFMPEG)('viewer whose room goes away', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-viewer-room-'))
  const members: Member[] = []

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterEach(async () => {
    for (const m of members.splice(0)) await m.manager.shutdown()
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  /** Host and viewer in a room whose video is playing. */
  async function playing(): Promise<{ host: Member; viewer: Member }> {
    const video = await fixture('mkv-cues.mkv')
    const host = member('Host', root)
    const viewer = member('Sam', root)
    members.push(host, viewer)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.request('session.join', { invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    // what the manifest says, for the renderer: this one streams
    expect(confirm.media).toEqual({ container: 'mkv', seekMode: 'index', fullDownload: false, interleave: 'good' })
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await viewer.client.until('playback', (p) => !p.paused && p.posS > 0.5, 30_000)
    return { host, viewer }
  }

  /** The viewer no longer follows the room: paused where it was, no sync, nothing moving. */
  async function expectStopped(viewer: Member): Promise<void> {
    const player = internals(viewer).current?.player?.player
    expect(player).toBeDefined()
    await sleep(300) // a sync tick already queued may still land
    expect(player?.prop('pause')).toBe(true)
    expect(internals(viewer).current?.syncEngine()).toBeNull()
    const quietFrom = viewer.client.events.length
    const pos = player?.prop('time-pos')
    // the renderer (and the RPC snapshot) sees it paused where it stopped, not still playing
    const last = viewer.client.last('playback')
    expect(last?.paused).toBe(true)
    expect(last?.posS).toBeCloseTo(typeof pos === 'number' ? pos : -1, 3)
    await sleep(1500)
    expect(player?.prop('time-pos')).toBe(pos)
    const kinds = viewer.client.events.slice(quietFrom).map((x) => x.e)
    expect(kinds).not.toContain('playback')
    expect(kinds).not.toContain('sync')
    // and play requests are refused quietly
    expect(await viewer.client.request('playback.intent', { kind: 'play' })).toEqual({
      accepted: false,
      reason: 'not-ready',
    })
  }

  const phasesFrom = (m: Member, from: number): string[] =>
    m.client.events
      .slice(from)
      .filter((x) => x.e === 'session')
      .map((x) => (x.d as CoreEvents['session']).phase)

  it('the host ending the room stops the viewer following it and pauses the player; the data stays', async () => {
    const { host, viewer } = await playing()
    const endedAt = viewer.client.events.length
    await host.client.request('session.leave', { data: 'keep', end: true })
    await viewer.client.until('session', (s) => s.phase === 'ended', 15_000)
    await expectStopped(viewer)
    // the closed card stays up
    expect(phasesFrom(viewer, endedAt).at(-1)).toBe('ended')
    expect(phasesFrom(viewer, endedAt)).not.toContain('error')
    await viewer.client.request('session.leave', { data: 'keep' })
    expect(viewer.client.last('session')?.phase).toBe('idle')
  })

  it('a kick while it plays does the same under the error screen', async () => {
    const { host, viewer } = await playing()
    const peers = await host.client.until('peers', (ps) => ps.some((p) => p.name === 'Sam'))
    const peerId = peers.find((p) => p.name === 'Sam')?.id ?? ''
    await host.client.request('room.kick', { peerId, rotate: false })
    const kicked = await viewer.client.until('session', (s) => s.phase === 'error', 15_000)
    expect(kicked.error?.code).toBe('kicked')
    await expectStopped(viewer)
    expect(viewer.client.last('session')?.error?.code).toBe('kicked')
    await viewer.client.request('session.leave', { data: 'delete' })
    expect(viewer.client.last('session')?.phase).toBe('idle')
    await host.client.request('session.leave', { data: 'keep', end: true })
  })
})
