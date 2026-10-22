import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import type { FakePlayer } from '../../../src/core/session/fake-player.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Client, type Member, member } from './harness.js'

// A video that plays only once it is fully downloaded: an fMP4 without sidx, which FFmpeg reads to its end
// at open (ADR 0004). The viewer is told so, mpv gets the stream only once the download is complete (it
// would otherwise sit in that read, and each reload for a blocked reader would start it over), the room's
// plays meanwhile do not wait for the viewer, and the viewer then joins the room's playback.

interface Internals {
  current: { player: { player: FakePlayer } | null } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, label: string, ms = 30_000): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`)
    await sleep(25)
  }
}

/** The first event of that kind at or after index `from` matching pred. */
async function next<E extends CoreEventName>(
  c: Client,
  e: E,
  from: number,
  pred: (d: CoreEvents[E]) => boolean = () => true,
  ms = 30_000,
): Promise<CoreEvents[E]> {
  let hit: CoreEvents[E] | undefined
  await waitFor(
    () => {
      hit = c.events.slice(from).find((x) => x.e === e && pred(x.d as CoreEvents[E]))?.d as CoreEvents[E] | undefined
      return hit !== undefined
    },
    `${e} after #${String(from)}; last: ${JSON.stringify(c.last(e))}`,
    ms,
  )
  return hit as CoreEvents[E]
}

describe.skipIf(!HAVE_FFMPEG)('viewer of a video that plays only once fully downloaded', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-viewer-full-'))
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

  it('fMP4 without sidx: told at JoinConfirm, no stream for mpv until complete, the room plays on meanwhile', async () => {
    const video = await fixture('fmp4-nosidx.mp4')
    // 2.5 MB at 300 KiB/s: the download takes about 8 s
    const host = member('Host', root, { settings: { uploadLimitKBps: 300 } })
    const viewer = member('Sam', root)
    members.push(host, viewer)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    // the first play happens before Sam joins: later plays are what Sam's download must not hold up
    const firstPlay = host.client.events.length
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await next(host.client, 'sync', firstPlay, (s) => s.mode === 'playing')
    expect((await host.client.request('playback.intent', { kind: 'pause' })).accepted).toBe(true)
    await next(host.client, 'sync', firstPlay, (s) => s.mode === 'paused' && s.cause?.kind === 'pause')

    await viewer.client.request('session.join', { invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    // known from the manifest, before the user picks a folder
    expect(confirm.media).toEqual({ container: 'fmp4', seekMode: 'linear', fullDownload: true, interleave: 'unknown' })
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    const notice = await viewer.client.until('notice', (n) => n.code === 'session.full-download')
    const message = FULL_DOWNLOAD_TEXT
    expect(notice).toEqual({ level: 'info', code: 'session.full-download', message })

    // following the room (its state arrived, which is when a member loads), but with nothing to load yet
    await viewer.client.until('sync', (s) => s.mode === 'paused')
    await sleep(1000)
    const player = internals(viewer).current?.player?.player
    expect(player).toBeDefined()
    expect(player?.prop('path')).toBeNull()
    expect(player?.status).toBe('idle')
    expect(viewer.client.last('transfer')?.progress ?? 0).toBeLessThan(1) // the download is still running
    // the empty mpv window says why once its OSC is up (it drops toasts before that)
    const why = (): number => toastsOf(player, message)
    expect(why()).toBe(0)
    player?.emit('oscReady')
    expect(why()).toBe(1)

    // the host plays: the room does not wait for a member that cannot load yet
    const play = host.client.events.length
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    const playing = await next(host.client, 'sync', play, (s) => s.mode === 'playing' || s.mode === 'waiting', 5000)
    expect(playing.mode).toBe('playing')
    const sam = host.client.last('peers')?.find((p) => p.name === 'Sam')
    expect(sam?.phase).toBe('joining')
    expect(player?.prop('path')).toBeNull()
    expect(viewer.client.last('transfer')?.progress ?? 0).toBeLessThan(1)

    // complete: mpv gets the stream and meets the room where it is by then
    await waitFor(() => typeof player?.prop('path') === 'string', 'the stream to load', 60_000)
    expect(String(player?.prop('path'))).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    const done = await viewer.client.until('notice', (n) => n.code === 'transfer.done')
    expect(done.message).toBe('The whole video is downloaded: it plays now.')
    // mpv itself plays along (until it loaded, the playback events showed the room, which was playing)
    await waitFor(() => player?.prop('pause') === false && Number(player.prop('time-pos')) > 1, 'mpv playing', 30_000)
    const hostPos = host.client.last('playback')?.posS ?? 0
    expect(Math.abs(Number(player?.prop('time-pos')) - hostPos)).toBeLessThan(3)
    const along = await viewer.client.until('playback', (p) => !p.paused && p.posS > 1, 30_000)
    expect(Math.abs(along.posS - hostPos)).toBeLessThan(3)
    expect(viewer.client.all('notice').filter((n) => n.code === 'session.full-download')).toHaveLength(1)
    player?.emit('oscReady') // a restarted mpv: nothing to explain any more
    expect(why()).toBe(1)
    // the 1 Hz transfer event after the download completed
    await viewer.client.until('transfer', (t) => t.progress === 1, 3000)
    expect(viewer.client.last('transfer')?.progress).toBe(1)

    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  })

  it("the room's first play does not wait for a viewer still downloading; it meets the room once complete", async () => {
    const video = await fixture('fmp4-nosidx.mp4')
    // 2.5 MB at 200 KiB/s: the download takes about 12 s, a 30 s room plays on meanwhile
    const host = member('Host', root, { settings: { uploadLimitKBps: 200 } })
    const viewer = member('Sam', root)
    members.push(host, viewer)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    // Sam joins a room that never played: the first play is the untimed start barrier
    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.until('sync', (s) => s.mode === 'paused')
    await host.client.until('peers', (ps) => ps.some((p) => p.name === 'Sam' && p.phase === 'joining'))
    expect(viewer.client.last('transfer')?.progress ?? 0).toBeLessThan(1)

    const play = host.client.events.length
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    const started = await next(host.client, 'sync', play, (s) => s.mode === 'playing' || s.mode === 'waiting', 5000)
    expect(started.mode).toBe('playing')
    expect(viewer.client.last('transfer')?.progress ?? 0).toBeLessThan(1)
    const player = internals(viewer).current?.player?.player
    expect(player?.prop('path')).toBeNull()
    // meanwhile Sam's transport shows the room playing on, not his empty mpv
    const shown = await viewer.client.until('playback', (p) => !p.paused && p.posS > 1, 10_000)
    expect(Math.abs(shown.posS - (host.client.last('playback')?.posS ?? 0))).toBeLessThan(1)
    expect(player?.prop('path')).toBeNull()

    // complete: Sam loads where the room is by then, ahead of 0:00, and plays along
    await waitFor(() => typeof player?.prop('path') === 'string', 'the stream to load', 60_000)
    const loadedAt = Number(player?.prop('time-pos'))
    const roomAt = host.client.last('playback')?.posS ?? 0
    expect(roomAt).toBeGreaterThan(3)
    expect(Math.abs(loadedAt - roomAt)).toBeLessThan(3)
    // mpv itself (the playback events showed the room until it loaded)
    const playing = (): boolean => player?.prop('pause') === false && Number(player.prop('time-pos')) > roomAt
    await waitFor(playing, 'mpv playing along', 30_000)
    expect(Math.abs(Number(player?.prop('time-pos')) - (host.client.last('playback')?.posS ?? 0))).toBeLessThan(1)
    // the room never waited for Sam
    expect(host.client.all('sync').filter((s) => s.wait?.waitingFor.includes('Sam'))).toEqual([])
    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  })

  it('the host ending the room while it downloads: stopped where the room was, and no more promise to play', async () => {
    const video = await fixture('fmp4-nosidx.mp4')
    // slow enough that the download is far from done when the room ends
    const host = member('Host', root, { settings: { uploadLimitKBps: 100 } })
    const viewer = member('Sam', root)
    members.push(host, viewer)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    const firstPlay = host.client.events.length
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await next(host.client, 'sync', firstPlay, (s) => s.mode === 'playing')

    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.until('sync', (s) => s.mode === 'playing')
    await sleep(3000) // the room well past 0:00
    const player = internals(viewer).current?.player?.player
    expect(player?.prop('path')).toBeNull()

    const endedAt = viewer.client.events.length
    await host.client.request('session.leave', { data: 'keep', end: true })
    await next(viewer.client, 'session', endedAt, (s) => s.phase === 'ended')
    // nothing loaded, so the last report stops where the room was when it ended, not at 0:00
    const last = viewer.client.last('playback')
    const roomAtEnd = host.client.all('playback').at(-1)?.posS ?? 0
    expect(roomAtEnd).toBeGreaterThan(2)
    expect(last?.paused).toBe(true)
    expect(Math.abs((last?.posS ?? 0) - roomAtEnd)).toBeLessThan(1)
    // a restarted mpv no longer says the video will play: there is no room to play it with
    player?.emit('oscReady')
    expect(toastsOf(player, FULL_DOWNLOAD_TEXT)).toBe(0)
    expect(viewer.client.last('transfer')?.progress ?? 0).toBeLessThan(1)
    await viewer.client.request('session.leave', { data: 'keep' })
    expect(viewer.client.last('session')?.phase).toBe('idle')
  })
})

const FULL_DOWNLOAD_TEXT = 'This video plays once it is fully downloaded: its format cannot be streamed.'

/** OSC toasts with that text (sync's cause toasts go there too). */
function toastsOf(player: FakePlayer | undefined, text: string): number {
  return player?.oscLog.filter((m) => m.kind === 'toast' && (m.payload as { text: string }).text === text).length ?? 0
}
