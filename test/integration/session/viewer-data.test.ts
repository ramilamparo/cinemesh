import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import type { ViewerSession } from '../../../src/core/session/viewer-session.js'
import { prepareHost } from '../../../src/core/transfer/host-prepare.js'
import { pieceLengthFor } from '../../../src/core/transfer/torrent-builder.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Client, type Member, member } from './harness.js'

// A viewer's data on disk against a real host: what JoinConfirm reports for a folder that already holds
// the download when the room has an external subtitle (havebytes-wrong-piececount, -piece-count,
// -piececount-mismatch), a download whose segment writes fail (transfer-error-unhandled), a second
// leave while a 'save' leave is still running (leave-not-reentrant), and a save that finds a segment gone.

const internals = (m: Member): { current: ViewerSession | null } =>
  m.manager as unknown as { current: ViewerSession | null }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function phases(c: Client, from = 0): string[] {
  return c.events
    .slice(from)
    .filter((x) => x.e === 'session')
    .map((x) => (x.d as CoreEvents['session']).phase)
}

/** The index of the first event of that kind at or after `from` matching pred, or -1. */
function indexOf<E extends CoreEventName>(c: Client, e: E, from: number, pred: (d: CoreEvents[E]) => boolean): number {
  return c.events.findIndex((x, i) => i >= from && x.e === e && pred(x.d as CoreEvents[E]))
}

/** Wakes a writer blocked opening the pipe (it then fails on it), then removes it. */
function unpipe(fifo: string): void {
  try {
    closeSync(openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK))
  } catch {
    // already gone
  }
  rmSync(fifo, { force: true })
}

async function next<E extends CoreEventName>(
  c: Client,
  e: E,
  from: number,
  pred: (d: CoreEvents[E]) => boolean = () => true,
  ms = 30_000,
): Promise<CoreEvents[E]> {
  const t0 = Date.now()
  for (;;) {
    const hit = c.events.slice(from).find((x) => x.e === e && pred(x.d as CoreEvents[E]))
    if (hit) return hit.d as CoreEvents[E]
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${e}; last: ${JSON.stringify(c.last(e))}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!HAVE_FFMPEG)('viewer data on disk', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-viewer-data-'))
  const members: Member[] = []
  // first: a pipe still held would block the members' own leave
  const cleanups: (() => void)[] = []

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) fn()
    for (const m of members.splice(0)) await m.manager.shutdown()
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  function add(name: string): Member {
    const m = member(name, root)
    members.push(m)
    return m
  }

  it('JoinConfirm counts what a folder already holds, subtitle pieces included', async () => {
    const video = await fixture('mkv-cues.mkv')
    const videoSize = statSync(video).size
    // a subtitle that pushes the torrent one piece past the video's own piece count
    const p = pieceLengthFor(videoSize + 2 * 1024 * 1024)
    const subSize = p - (videoSize % p) + 4096
    expect(Math.ceil((videoSize + subSize) / p)).toBe(Math.ceil(videoSize / p) + 1)
    const srt = join(root, 'movie.en.srt')
    const cue = '1\n00:00:01,000 --> 00:00:03,000\nHello\n\n'
    writeFileSync(srt, cue + '\n'.repeat(subSize - cue.length))

    const host = add('Host')
    const viewer = add('Sam')
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [srt] })
    await host.client.until('session', (s) => s.phase === 'in-room')

    // first visit: download everything into the default folder, keep it
    await viewer.client.request('session.join', { invite })
    const first = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    expect(first.joinInfo?.size).toBe(videoSize + subSize)
    expect(first.joinInfo?.haveBytes).toBe(0)
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'downloads') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.until('transfer', (t) => t.progress === 1)
    await viewer.client.request('session.leave', { data: 'keep' })

    // the invite again (not Recent rooms): JoinConfirm reads that folder's journal
    const again = viewer.client.events.length
    await viewer.client.request('session.join', { invite })
    const second = await next(viewer.client, 'session', again, (s) => s.phase === 'confirm-join')
    expect(second.joinInfo?.haveBytes).toBe(videoSize + subSize)
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'downloads') })
    await next(viewer.client, 'session', again, (s) => s.phase === 'in-room')
    await next(viewer.client, 'transfer', again, (t) => t.progress === 1)

    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  })

  it('a download whose segment writes fail after some progress keeps that progress and lets the computer sleep', async () => {
    // 78 MB, so over one 64 MiB segment, with Cues at the front: every critical byte lies in segment 0
    const video = join(root, 'big.mkv')
    execFileSync('ffmpeg', [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25'],
      ...['-t', '27', '-c:v', 'rawvideo', '-pix_fmt', 'yuv420p', '-cues_to_front', '1', video],
    ])
    expect(statSync(video).size).toBeGreaterThan(64 * 1024 * 1024)
    const { infoHash } = await prepareHost({
      videoPath: video,
      subtitlePaths: [],
      cacheRoot: join(root, 'prepare-cache'),
      workers: 1,
    })
    // 20 MiB/s: segment 0 takes seconds, so the 1 Hz transfer events show the progress before the failure
    const host = member('Host', root, { settings: { uploadLimitKBps: 20 * 1024 } })
    members.push(host)
    const viewer = add('Sam')
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.request('session.join', { invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')

    // the second segment is a directory: segment 0 fills, the first write past it fails (EISDIR) and
    // WebTorrent destroys the torrent
    const saveDir = join(viewer.dir, 'save')
    mkdirSync(join(saveDir, '.wt-partial', infoHash, 'seg', '000001.part'), { recursive: true })
    const from = viewer.client.events.length
    await viewer.client.request('session.confirmJoin', { dir: saveDir })
    const notice = await next(viewer.client, 'notice', from, (n) => n.code === 'transfer.failed', 90_000)
    expect(notice.message).toMatch(/^Downloading stopped: EISDIR/)
    expect(viewer.client.last('session')?.phase).toBe('in-room')
    const failedAt = indexOf(viewer.client, 'notice', from, (n) => n.code === 'transfer.failed')
    const reached = Math.max(
      0,
      ...viewer.client.events
        .slice(from, failedAt)
        .filter((x) => x.e === 'transfer')
        .map((x) => (x.d as CoreEvents['transfer']).progress),
    )
    expect(reached).toBeGreaterThan(0)

    // the dead torrent's stats are all zeros: the progress it reached stays, with nothing moving
    await sleep(2500)
    const after = viewer.client.events
      .slice(failedAt)
      .filter((x) => x.e === 'transfer')
      .map((x) => x.d as CoreEvents['transfer'])
    expect(after.length).toBeGreaterThan(1)
    for (const t of after) {
      expect(t.progress).toBeGreaterThanOrEqual(reached)
      expect(t.downBps).toBe(0)
    }
    // keep-awake: off from the failure on, though the video is incomplete (a call at failedAt may still be
    // the 1 Hz tick from just before it)
    const power = viewer.power.filter((p) => p.at > failedAt)
    expect(power.length).toBeGreaterThan(0)
    expect(power.map((p) => p.on)).not.toContain(true)

    // the session can still be left, and Recent rooms remembers how far the download got
    await viewer.client.request('session.leave', { data: 'keep' })
    expect(viewer.client.last('session')?.phase).toBe('idle')
    const saved = JSON.parse(
      readFileSync(join(viewer.dir, 'userData', 'wt', 'rooms', confirm.roomId ?? '', 'session.json'), 'utf8'),
    ) as { progress?: number }
    expect(saved.progress).toBeGreaterThanOrEqual(reached)
    await host.client.request('session.leave', { data: 'keep', end: true })
  })

  it.skipIf(process.platform === 'win32')(
    'a second leave while a save is still running shares it: one teardown, one export, the same path',
    async () => {
      const video = await fixture('mkv-cues.mkv')
      const { infoHash } = await prepareHost({
        videoPath: video,
        subtitlePaths: [],
        cacheRoot: join(root, 'prepare-cache'),
        workers: 1,
      })
      const host = add('Host')
      const viewer = add('Sam')
      const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await host.client.until('session', (s) => s.phase === 'in-room')
      await viewer.client.request('session.join', { invite })
      await viewer.client.until('session', (s) => s.phase === 'confirm-join')

      // The export cannot be held from outside (it checks every segment first and never opens an existing
      // name), so the leave is held one step earlier, in the same transfer.leave: the journal write it waits
      // for blocks on a named pipe (a slow disk).
      const saveDir = join(viewer.dir, 'save')
      const transferDir = join(saveDir, '.wt-partial', infoHash)
      mkdirSync(transferDir, { recursive: true })
      const journalTmp = join(transferDir, 'state.json.tmp')
      execFileSync('mkfifo', [journalTmp])
      cleanups.push(() => unpipe(journalTmp))
      await viewer.client.request('session.confirmJoin', { dir: saveDir })
      await viewer.client.until('transfer', (t) => t.progress === 1)
      const session = internals(viewer).current
      expect(session).not.toBeNull()

      const dest = join(viewer.dir, 'exported')
      const leftAt = viewer.client.events.length
      const first = viewer.client.request('transfer.saveFile', { dest })
      // teardown has run once the player quit (FakePlayer: status 'absent'); the leave then waits on the pipe
      await next(viewer.client, 'player', leftAt, (p) => p.version === 'fake' && p.status === 'absent')
      await sleep(500)
      const powerAt = viewer.power.length

      const second = viewer.client.request('session.leave', { data: 'save' }) // a double click
      const third = session?.leave({ data: 'save' })
      expect(session?.leave({ data: 'keep' })).toBe(third) // the first call's options win
      await sleep(500)
      expect(viewer.power.length).toBe(powerAt) // no second teardown
      expect(phases(viewer.client, leftAt)).toEqual(['leaving']) // the first one's; the export still runs

      unpipe(journalTmp)
      const { path } = await first
      expect(await second).toBeNull()
      expect(await third).toBe(path)
      // exported once: one file, the whole video
      expect(readdirSync(dest)).toEqual([path.slice(dest.length + 1)])
      expect(statSync(path).size).toBe(statSync(video).size)
      expect(phases(viewer.client, leftAt)).toEqual(['leaving', 'idle'])
      await host.client.request('session.leave', { data: 'keep', end: true })
    },
  )

  it('a save that finds a segment gone fails as incomplete after leaving; a rejoin downloads it again and saves', async () => {
    const video = await fixture('mkv-cues.mkv')
    const { infoHash } = await prepareHost({
      videoPath: video,
      subtitlePaths: [],
      cacheRoot: join(root, 'prepare-cache'),
      workers: 1,
    })
    const host = add('Host')
    const viewer = add('Sam')
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.request('session.join', { invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    const roomId = confirm.roomId ?? ''
    const saveDir = join(viewer.dir, 'save')
    await viewer.client.request('session.confirmJoin', { dir: saveDir })
    await viewer.client.until('transfer', (t) => t.progress === 1)

    // gone since the join (an antivirus quarantined it): the export checks every segment before consuming any
    rmSync(join(saveDir, '.wt-partial', infoHash, 'seg', '000000.part'))
    const dest = join(viewer.dir, 'exported')
    const leftAt = viewer.client.events.length
    await expect(viewer.client.request('transfer.saveFile', { dest })).rejects.toThrow(
      'transfer.saveFile failed: incomplete Some downloaded data was missing. Rejoin the room to download it again, then save.',
    )
    // left all the same, with nothing exported, and the room still there to rejoin
    expect(phases(viewer.client, leftAt)).toEqual(['leaving', 'idle'])
    expect(internals(viewer).current).toBeNull()
    expect(existsSync(dest) ? readdirSync(dest) : []).toEqual([])
    const recent = await viewer.client.request('session.recent', {})
    expect(recent.map((r) => [r.roomId, r.resumable])).toEqual([[roomId, true]])

    // Recent rooms → Resume: the same folder, the lost pieces downloaded again, and the save goes through
    const back = viewer.client.events.length
    await viewer.client.request('session.resume', { roomId })
    await next(viewer.client, 'session', back, (s) => s.phase === 'in-room')
    await next(viewer.client, 'transfer', back, (t) => t.progress === 1)
    const { path } = await viewer.client.request('transfer.saveFile', { dest })
    expect(statSync(path).size).toBe(statSync(video).size)
    expect(readFileSync(path).equals(readFileSync(video))).toBe(true)
    // exported: nothing left to resume
    expect(await viewer.client.request('session.recent', {})).toEqual([])
    await host.client.request('session.leave', { data: 'keep', end: true })
  })

  it.skipIf(process.platform === 'win32')(
    'a download that dies while the join is still starting fails the join instead of entering the room',
    async () => {
      const video = await fixture('mkv-cues.mkv')
      const { infoHash } = await prepareHost({
        videoPath: video,
        subtitlePaths: [],
        cacheRoot: join(root, 'prepare-cache'),
        workers: 1,
      })
      const host = add('Host')
      const viewer = add('Sam')
      const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await host.client.until('session', (s) => s.phase === 'in-room')
      await viewer.client.request('session.join', { invite })
      const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')

      const saveDir = join(viewer.dir, 'save')
      const transferDir = join(saveDir, '.wt-partial', infoHash)
      mkdirSync(transferDir, { recursive: true })
      writeFileSync(join(transferDir, 'seg'), '')
      // the session file write is the last await before the room: hold it on a named pipe (a slow disk)
      const sessionTmp = join(viewer.dir, 'userData', 'wt', 'rooms', confirm.roomId ?? '', 'session.json.tmp')
      execFileSync('mkfifo', [sessionTmp])
      // A reader lets the blocked write through (it then fails on the pipe; the session file shrugs). The
      // pipe goes too, or the leave's own session-file write would block on it.
      const unblock = (): void => {
        try {
          closeSync(openSync(sessionTmp, constants.O_RDONLY | constants.O_NONBLOCK))
        } catch {
          // already gone
        }
        rmSync(sessionTmp, { force: true })
      }

      const from = viewer.client.events.length
      try {
        await viewer.client.request('session.confirmJoin', { dir: saveDir })
        // meanwhile the peers are attached and the first segment write fails
        await new Promise((r) => setTimeout(r, 4000))
      } finally {
        unblock()
      }
      const failed = await next(viewer.client, 'session', from, (s) => s.phase === 'error')
      expect(failed.error?.code).toBe('transfer-failed')
      expect(failed.error?.message).toMatch(/^Downloading stopped: EEXIST/)
      await new Promise((r) => setTimeout(r, 500))
      const after = viewer.client.events.slice(from)
      expect(after.filter((x) => x.e === 'session').map((x) => (x.d as CoreEvents['session']).phase)).not.toContain(
        'in-room',
      )
      // one report: the error screen, not a toast on top of it
      expect(after.filter((x) => x.e === 'notice').map((x) => (x.d as CoreEvents['notice']).code)).not.toContain(
        'transfer.failed',
      )
      await viewer.client.request('session.leave', { data: 'delete' })
      expect(viewer.client.last('session')?.phase).toBe('idle')
      await host.client.request('session.leave', { data: 'keep', end: true })
    },
  )
})
