import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readSessionFile } from '../../../src/core/session/session-file.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Playlists (ADR 0011): the host prepares every item, plays one at a time, and moves on by request or a few
// seconds after an item ends; a viewer follows each switch in the folder it confirmed at the join, with a sync engine
// that applies only the new item's epoch.

interface Internals {
  current: { syncEngine(): SyncEngine | null } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals
const epochOf = (m: Member): number | undefined => internals(m).current?.syncEngine()?.member.state?.syncEpoch

async function eventually(check: () => boolean, ms = 30_000, what = 'condition'): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`${what} not met in time`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** An event matching `pred` among those emitted from index `from` on. */
async function since<E extends CoreEventName>(
  m: Member,
  from: number,
  e: E,
  pred: (d: CoreEvents[E]) => boolean,
  ms = 30_000,
): Promise<CoreEvents[E]> {
  let hit: CoreEvents[E] | undefined
  await eventually(
    () => {
      const x = m.client.events.slice(from).findLast((y) => y.e === e && pred(y.d as CoreEvents[E]))
      hit = x?.d as CoreEvents[E] | undefined
      return x !== undefined
    },
    ms,
    `a ${e} event`,
  )
  if (hit === undefined) throw new Error('unreachable')
  return hit
}

describe.skipIf(!HAVE_FFMPEG)('session: playlists', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-playlist-'))
  let first = ''
  let second = ''
  let third = ''
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    first = await fixture('mkv-cues.mkv')
    second = await fixture('mp4-faststart.mp4')
    third = await fixture('mkv-nocues.mkv')
  }, 120_000)
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  async function room(): Promise<{ host: Member; viewer: Member; roomId: string }> {
    const host = member('Host', root)
    const viewer = member('Sam', root)
    const { invite, roomId } = await host.client.request('session.host', {
      videoPath: first,
      subtitlePaths: [],
      more: [second],
    })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    // the second item prepares in the background
    await host.client.until(
      'playlist',
      (p) => p.items.length === 2 && p.items.every((i) => i.host?.state === 'ready'),
      60_000,
    )
    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    return { host, viewer, roomId }
  }

  it('plays the items in order: the viewer follows a switch into the same folder, on the new epoch', async () => {
    const { host, viewer, roomId } = await room()
    const list = await viewer.client.until('playlist', (p) => p.items.length === 2)
    expect(list.items.map((i) => i.name)).toEqual(['mkv-cues.mkv', 'mp4-faststart.mp4'])
    expect(list.currentId).toBe(list.items[0]?.id)
    await viewer.client.until('transfer', (t) => t.progress >= 1)
    await eventually(() => epochOf(viewer) !== undefined && epochOf(viewer) === epochOf(host), 15_000, 'same epoch')
    const firstEpoch = epochOf(host)
    const firstDir = (await readSessionFile(join(viewer.dir, 'userData'), roomId))?.transferDir ?? ''

    // the item playing cannot be removed
    expect(await host.client.requestError('playlist.remove', { id: list.items[0]?.id ?? '' })).toBe('current')

    const mark = viewer.client.events.length
    await host.client.request('playlist.next', {})
    await since(viewer, mark, 'session', (s) => s.fileName === 'mp4-faststart.mp4' && s.phase === 'in-room')
    await since(viewer, mark, 'playlist', (p) => p.currentId === list.items[1]?.id)
    // a switch starts playing (through the start barrier)
    await since(viewer, mark, 'sync', (s) => s.mode === 'playing', 45_000)
    await eventually(() => epochOf(viewer) === epochOf(host), 15_000, 'the new epoch')
    expect(epochOf(host)).not.toBe(firstEpoch)
    await since(viewer, mark, 'transfer', (t) => t.progress >= 1, 45_000)

    // both downloads live in the folder confirmed at the join, and the session file lists them
    const file = await readSessionFile(join(viewer.dir, 'userData'), roomId)
    expect(file?.transferDir).not.toBe(firstDir)
    expect(dirname(file?.transferDir ?? '')).toBe(dirname(firstDir))
    expect(file?.playlist?.map((e) => e.name).sort()).toEqual(['mkv-cues.mkv', 'mp4-faststart.mp4'])
    const view = viewer.client.last('playlist')
    expect(view?.items.map((i) => i.local?.state)).toEqual(['complete', 'complete'])

    // and back: the first item's kept download resumes, nothing to fetch again
    const back = viewer.client.events.length
    await host.client.request('playlist.prev', {})
    await since(viewer, back, 'session', (s) => s.fileName === 'mkv-cues.mkv')
    await since(viewer, back, 'transfer', (t) => t.progress >= 1, 15_000)

    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 240_000)

  it('moves on by itself a few seconds after an item ends, and a cancel holds it', async () => {
    const { host, viewer } = await room()
    const list = await host.client.until('playlist', (p) => p.items.length === 2)
    const dur = host.client.last('session')?.durationS ?? 0
    expect(dur).toBeGreaterThan(5)
    await host.client.request('playback.intent', { kind: 'seek', posS: dur - 1 })
    await host.client.request('playback.intent', { kind: 'play' })
    await host.client.until('sync', (s) => s.mode === 'ended', 45_000)
    const counting = await host.client.until('playlist', (p) => p.advance !== null, 10_000)
    expect(counting.advance?.nextId).toBe(list.items[1]?.id)
    // the viewer sees the countdown too, to the same moment however often it re-emits the list
    const seen = await viewer.client.until('playlist', (p) => p.advance?.nextId === list.items[1]?.id, 10_000)
    await new Promise((r) => setTimeout(r, 1500))
    const later = viewer.client
      .all('playlist')
      .filter((p) => p.advance !== null)
      .map((p) => p.advance?.at)
    expect(new Set(later).size).toBe(1)
    expect(Math.abs((seen.advance?.at ?? 0) - (counting.advance?.at ?? 0))).toBeLessThan(1000)
    const mark = host.client.events.length
    await since(host, mark, 'session', (s) => s.fileName === 'mp4-faststart.mp4', 15_000)
    await since(viewer, 0, 'session', (s) => s.fileName === 'mp4-faststart.mp4', 15_000)
    await since(host, mark, 'sync', (s) => s.mode === 'playing', 45_000)

    // at the last item's end there is nothing to count down to
    const dur2 = host.client.last('session')?.durationS ?? 0
    await host.client.request('playback.intent', { kind: 'seek', posS: dur2 - 1 })
    const end = host.client.events.length
    await since(host, end, 'sync', (s) => s.mode === 'ended', 45_000)
    await new Promise((r) => setTimeout(r, 1000))
    expect(host.client.last('playlist')?.advance).toBeNull()

    // back on the first one, the end counts down; Cancel stops it until the room next ends
    await host.client.request('playlist.play', { id: list.items[0]?.id ?? '' })
    await host.client.until('session', (s) => s.fileName === 'mkv-cues.mkv', 15_000)
    await host.client.until('sync', (s) => s.mode === 'playing', 45_000)
    await host.client.request('playback.intent', { kind: 'seek', posS: dur - 1 })
    await host.client.until('playlist', (p) => p.advance !== null, 45_000)
    await host.client.request('playlist.cancelAdvance', {})
    expect(host.client.last('playlist')?.advance).toBeNull()
    await new Promise((r) => setTimeout(r, 6000))
    expect(host.client.last('session')?.fileName).toBe('mkv-cues.mkv')

    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 240_000)

  it('adds videos while the room plays, refusing ones already listed', async () => {
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: first, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    expect(await host.client.requestError('playlist.add', { videoPaths: [first] })).toBe('duplicate')
    expect(await host.client.request('playlist.add', { videoPaths: [second, first] })).toEqual({ added: 1 })
    const list = await host.client.until('playlist', (p) => p.items[1]?.host?.state === 'ready', 60_000)
    expect(list.items.map((i) => i.name)).toEqual(['mkv-cues.mkv', 'mp4-faststart.mp4'])
    await host.client.request('playlist.move', { id: list.items[1]?.id ?? '', toIndex: 0 })
    expect(host.client.last('playlist')?.items.map((i) => i.name)).toEqual(['mp4-faststart.mp4', 'mkv-cues.mkv'])
    await host.client.request('playlist.remove', { id: list.items[1]?.id ?? '' })
    expect(host.client.last('playlist')?.items.map((i) => i.name)).toEqual(['mkv-cues.mkv'])
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 120_000)

  it('downloads the next items ahead in playlist order, and the next item then plays without downloading', async () => {
    const host = member('Host', root)
    const viewer = member('Sam', root)
    const { invite } = await host.client.request('session.host', {
      videoPath: first,
      subtitlePaths: [],
      more: [second, third],
    })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    await host.client.until('playlist', (p) => p.items.every((i) => i.host?.state === 'ready'), 60_000)
    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    const states = (): string[] => viewer.client.last('playlist')?.items.map((i) => i.local?.state ?? '?') ?? []
    // the item playing first, then each next one in order
    let order: string[][] = []
    await eventually(
      () => {
        const st = states()
        if (order.at(-1)?.join() !== st.join()) order = [...order, st]
        return st.every((x) => x === 'complete')
      },
      90_000,
      'every item downloaded',
    )
    // never a later item before an earlier one
    for (const st of order) {
      const firstIncomplete = st.findIndex((x) => x !== 'complete')
      if (firstIncomplete >= 0) expect(st.slice(firstIncomplete + 1).every((x) => x === 'none')).toBe(true)
    }
    const mark = viewer.client.events.length
    await host.client.request('playlist.next', {})
    await since(viewer, mark, 'session', (s) => s.fileName === 'mp4-faststart.mp4')
    // complete from its first transfer event: it was downloaded ahead
    const t = await since(viewer, mark, 'transfer', () => true, 15_000)
    expect(t.progress).toBe(1)
    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 240_000)

  it('downloads nothing ahead with the setting off, and a host not sharing ahead serves only the item playing', async () => {
    const host = member('Host', root, { settings: { playlistBackgroundUpload: false } })
    const off = member('Off', root, { settings: { playlistBackgroundDownload: false } })
    const on = member('On', root)
    const { invite } = await host.client.request('session.host', {
      videoPath: first,
      subtitlePaths: [],
      more: [second],
    })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    await host.client.until('playlist', (p) => p.items.every((i) => i.host?.state === 'ready'), 60_000)
    for (const v of [off, on]) {
      await v.client.request('session.join', { invite })
      await v.client.until('session', (s) => s.phase === 'confirm-join')
      await v.client.request('session.confirmJoin', { dir: join(v.dir, 'save') })
      await v.client.until('session', (s) => s.phase === 'in-room')
      await v.client.until('transfer', (t) => t.progress >= 1, 60_000)
    }
    await new Promise((r) => setTimeout(r, 4000))
    // Off fetches nothing ahead; On tries, but only the host has it and the host shares only the item playing
    expect(off.client.last('playlist')?.items[1]?.local).toMatchObject({ state: 'none', progress: 0 })
    expect(on.client.last('playlist')?.items[1]?.local).toMatchObject({ state: 'downloading', progress: 0 })
    // once it plays, the host serves it
    await host.client.request('playlist.next', {})
    for (const v of [off, on]) {
      await v.client.until('session', (s) => s.fileName === 'mp4-faststart.mp4', 15_000)
      await v.client.until('playlist', (p) => p.items[1]?.local?.state === 'complete', 60_000)
    }
    for (const v of [off, on]) await v.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 240_000)

  it('a host resumes its playlist at the item it was on', async () => {
    const host = member('Host', root)
    const { roomId } = await host.client.request('session.host', {
      videoPath: first,
      subtitlePaths: [],
      more: [second],
    })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    const list = await host.client.until('playlist', (p) => p.items.every((i) => i.host?.state === 'ready'), 60_000)
    await host.client.request('playlist.next', {})
    await host.client.until('session', (s) => s.fileName === 'mp4-faststart.mp4')
    await host.client.request('playlist.setAutoAdvance', { on: false })
    const before = host.client.last('playlist')?.rev ?? 0
    await host.client.request('session.leave', { data: 'keep' })

    const mark = host.client.events.length
    await host.client.request('session.resume', { roomId })
    const back = await since(host, mark, 'session', (s) => s.phase === 'in-room', 60_000)
    expect(back.fileName).toBe('mp4-faststart.mp4')
    const again = await since(host, mark, 'playlist', (p) => p.items.length === 2 && p.currentId !== null)
    expect(again.items.map((i) => i.id)).toEqual(list.items.map((i) => i.id))
    expect(again.currentId).toBe(list.items[1]?.id)
    expect(again.autoAdvance).toBe(false)
    expect(again.rev).toBeGreaterThan(before)
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 180_000)

  it('a viewer resumes into the item the host plays, with what it downloaded of every item', async () => {
    const { host, viewer, roomId } = await room()
    await viewer.client.until('transfer', (t) => t.progress >= 1)
    const list = await viewer.client.until('playlist', (p) => p.items.length === 2)
    await host.client.request('playlist.next', {})
    await viewer.client.until('session', (s) => s.fileName === 'mp4-faststart.mp4')
    await viewer.client.until('playlist', (p) => p.items.every((i) => i.local?.state === 'complete'), 60_000)
    await viewer.client.request('session.leave', { data: 'keep' })
    const kept = await readSessionFile(join(viewer.dir, 'userData'), roomId)
    expect(kept?.playlist?.map((e) => e.progress)).toEqual([1, 1])

    const mark = viewer.client.events.length
    await viewer.client.request('session.resume', { roomId })
    // no JoinConfirm: the folder is the one from the join
    const back = await since(viewer, mark, 'session', (s) => s.phase === 'in-room', 60_000)
    expect(back.fileName).toBe('mp4-faststart.mp4')
    expect(
      viewer.client.events
        .slice(mark)
        .some((e) => e.e === 'session' && (e.d as { phase: string }).phase === 'confirm-join'),
    ).toBe(false)
    const view = await since(viewer, mark, 'playlist', (p) => p.items.length === 2)
    expect(view.currentId).toBe(list.items[1]?.id)
    // the first item's download is still on disk: complete without fetching again
    await since(viewer, mark, 'playlist', (p) => p.items[0]?.local?.state === 'complete', 15_000)
    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 180_000)
})
