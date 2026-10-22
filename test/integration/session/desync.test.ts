import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { OscStatus } from '../../../src/core/player/osc-bridge.js'
import type { FakePlayer } from '../../../src/core/session/fake-player.js'
import { MEMBER } from '../../../src/core/sync/member.js'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import { type Settings, defaultSettings } from '../../../src/shared/settings.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// The viewer's "behind the host" warning and Resync to live through the whole session (fake players): a viewer the
// room plays on without (the host does not wait for everyone) stalls, sees the warning in the app and in mpv, the
// host sees it on that viewer's row, and Resync to live brings it back without permission and without moving the
// room.

interface Internals {
  current: { player: { player: FakePlayer } | null } | null
}
const player = (m: Member): FakePlayer => {
  const p = (m.manager as unknown as Internals).current?.player?.player
  if (!p) throw new Error('no player')
  return p
}

/** The next event matching `pred` from now on (Client.until also finds older ones). */
async function since<E extends CoreEventName>(
  m: Member,
  e: E,
  pred: (d: CoreEvents[E]) => boolean,
  ms: number,
): Promise<CoreEvents[E]> {
  const from = m.client.events.length
  const t0 = Date.now()
  for (;;) {
    const hit = m.client.events.slice(from).find((x) => x.e === e && pred(x.d as CoreEvents[E]))
    if (hit) return hit.d as CoreEvents[E]
    if (Date.now() - t0 > ms) throw new Error(`no matching ${e} in time`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

const behindRow = (peers: CoreEvents['peers'], name: string): boolean =>
  peers.some((p) => p.name === name && p.warnings.some((w) => w.code === 'behind'))

describe.skipIf(!HAVE_FFMPEG)('the desync warning and Resync to live', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-desync-'))
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

  /** Host (not waiting for everyone, nobody else may play or seek) and viewer in a room whose video plays. */
  async function playing(): Promise<{ host: Member; viewer: Member; settings: Settings }> {
    const video = await fixture('mkv-cues.mkv')
    const host = member('Host', root, {
      settings: { hostDefaults: { ...defaultSettings().hostDefaults, waitForAll: false } },
    })
    const viewer = member('Sam', root)
    members.push(host, viewer)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('sync', (s) => s.mode === 'paused', 15_000)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await viewer.client.until('playback', (p) => !p.paused && p.posS > 0.5, 30_000)
    const settings = { ...defaultSettings(), displayName: 'Sam', downloadDir: join(viewer.dir, 'downloads') }
    return { host, viewer, settings }
  }

  /** The viewer's player stops for data it does not have; the warning shows 1 + 2 s later. */
  async function stallUntilBehind(viewer: Member): Promise<void> {
    player(viewer).stall(true)
    await since(viewer, 'sync', (s) => s.desync?.state === 'behind', 8000)
  }

  const oscSince = (viewer: Member, from: number) => player(viewer).oscLog.slice(from)
  const toastsSince = (m: Member, from: number): unknown[] =>
    oscSince(m, from)
      .filter((o) => o.kind === 'toast')
      .map((o) => o.payload)

  /** How long a Resync may stay catching-up: a rendezvous waits paused for the estimated start time first. */
  const catchUpMs = (outcome: string): number => (outcome === 'rendezvous' ? MEMBER.EST_READY_INIT_MS : 0) + 5000

  it('warns in the app, in mpv and on the host’s row; Resync to live needs no permission and moves no one else', async () => {
    const { host, viewer } = await playing()
    const osc0 = player(viewer).oscLog.length
    await stallUntilBehind(viewer)
    const ev = viewer.client.last('sync')
    expect(ev?.desync).toEqual({ state: 'behind', behindS: expect.any(Number) as unknown })
    // its own row, and the host's row for it after its next status
    await since(viewer, 'peers', (ps) => behindRow(ps, 'Sam'), 3000)
    await since(host, 'peers', (ps) => behindRow(ps, 'Sam'), 5000)
    const osc = oscSince(viewer, osc0)
    const statuses = osc.filter((o) => o.kind === 'status').map((o) => o.payload as OscStatus)
    expect(statuses).toContainEqual({
      text: expect.stringMatching(/s behind the host · Shift\+R to resync$/) as unknown,
      level: 'warn',
    })
    expect(osc.filter((o) => o.kind === 'resync').at(-1)?.payload).toEqual({ shown: true })

    // only the viewer has something to resync with
    expect(await host.client.requestError('playback.resync', {})).toBe('not-viewer')

    const hostSyncs = host.client.all('sync').length
    const { outcome } = await viewer.client.request('playback.resync', {})
    expect(['skip', 'rendezvous']).toContain(outcome)
    // a rendezvous (less than 2 s here at the room's position) meets the room its estimated start time ahead
    await since(viewer, 'sync', (s) => s.desync === undefined, catchUpMs(outcome))
    await since(viewer, 'playback', (p) => !p.paused && !p.stalled, 10_000)
    expect(
      player(viewer)
        .oscLog.filter((o) => o.kind === 'resync')
        .at(-1)?.payload,
    ).toEqual({ shown: false })
    // the room did not move: no new cause on the host's side (only member phases may have been republished)
    const after = host.client.all('sync').slice(hostSyncs)
    expect(after.every((s) => s.mode === 'playing' && s.cause?.by !== 'Sam')).toBe(true)
    await since(host, 'peers', (ps) => !behindRow(ps, 'Sam'), 5000)
  })

  it('Shift+R or the bar button in mpv resyncs the viewer, and says when there is nothing to do; not on the host', async () => {
    const { host, viewer } = await playing()
    const press = (m: Member): void => void player(m).emit('intent', { kind: 'resync', src: 'osc', seq: 1 })
    // in sync: says so (the member may still be settling into play: 'busy' says nothing, so ask until it answers)
    const osc0 = player(viewer).oscLog.length
    const t0 = Date.now()
    while (!toastsSince(viewer, osc0).length) {
      if (Date.now() - t0 > 10_000) throw new Error('no answer to Shift+R')
      press(viewer)
      await new Promise((r) => setTimeout(r, 300))
    }
    expect(toastsSince(viewer, osc0)).toEqual([{ text: 'Already in sync' }])

    // the host has nothing to resync with: nothing happens
    const hostOsc0 = player(host).oscLog.length
    press(host)
    await new Promise((r) => setTimeout(r, 500))
    expect(toastsSince(host, hostOsc0)).toEqual([])

    // behind: the catch-up shows itself in the status line, with no toast, and clears where it lands
    await stallUntilBehind(viewer)
    const osc1 = player(viewer).oscLog.length
    const catching = since(viewer, 'sync', (s) => s.desync?.state === 'catching-up', 3000)
    press(viewer)
    await catching
    await since(viewer, 'sync', (s) => s.desync === undefined, catchUpMs('rendezvous'))
    expect(toastsSince(viewer, osc1)).toEqual([])
    expect(
      oscSince(viewer, osc1)
        .filter((o) => o.kind === 'status')
        .map((o) => (o.payload as OscStatus).text),
    ).toContain('Resyncing with the host…')
  })

  it('clears at once when the room pauses, and when the viewer turns the warning off', async () => {
    const { host, viewer, settings } = await playing()
    await stallUntilBehind(viewer)
    expect((await host.client.request('playback.intent', { kind: 'pause' })).accepted).toBe(true)
    const paused = await since(viewer, 'sync', (s) => s.mode === 'paused', 5000)
    expect(paused.desync).toBeUndefined()
    expect(viewer.client.last('sync')?.desync).toBeUndefined()

    player(viewer).stall(false)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await since(viewer, 'playback', (p) => !p.paused && !p.stalled, 10_000)
    await stallUntilBehind(viewer)
    // any other setting changed (here the theme) keeps the warning: only a new threshold measures afresh
    const syncs = viewer.client.all('sync').length
    viewer.manager.updateSettings({ ...settings, theme: 'dark' })
    await new Promise((r) => setTimeout(r, 1500))
    expect(
      viewer.client
        .all('sync')
        .slice(syncs)
        .every((s) => s.desync?.state === 'behind'),
    ).toBe(true)
    expect(viewer.client.last('sync')?.desync?.state).toBe('behind')
    viewer.manager.updateSettings({ ...settings, desyncWarnMs: 0 })
    expect(viewer.client.last('sync')?.desync).toBeUndefined()
    await new Promise((r) => setTimeout(r, 4000))
    expect(viewer.client.last('sync')?.desync).toBeUndefined()
  })
})
