import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NoticeEvent, TransferEvent } from '../../../src/shared/ipc/core.js'
import { RoomStore } from '../../../src/core/net/identity.js'
import { readSessionFile } from '../../../src/core/session/session-file.js'
import { Journal } from '../../../src/core/transfer/journal.js'
import { EXPORT_FILE, exportSteps } from '../../../src/core/transfer/save-file.js'
import { segmentName } from '../../../src/core/transfer/segment-store.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// A viewer's 'save' cut off by a quit (M1/M4): core gives the export a few seconds and exits, and the next start
// finishes it from the export journal, with no host around, or gives it up for a rejoin when it cannot.

// 1 MiB segments (64 MiB in the app), so the 2.4 MB fixture spans three and the export consumes two of them
vi.mock('../../../src/core/transfer/segment-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/transfer/segment-store.js')>()),
  SEGMENT_BYTES: 1024 * 1024,
}))

const MIB = 1024 * 1024
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello\n'

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const exportNotices = (m: Member): NoticeEvent[] =>
  m.client.all('notice').filter((n) => n.code.startsWith('transfer.export'))

describe.skipIf(!HAVE_FFMPEG)('a save cut off by a quit finishes at the next start', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-export-resume-'))
  const members: Member[] = []
  const spawn = (...args: Parameters<typeof member>): Member => {
    const m = member(...args)
    members.push(m)
    return m
  }
  let video = ''
  let subs = ''
  let invite = ''

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv')
    subs = join(root, 'film.srt')
    writeFileSync(subs, SRT)
    const host = spawn('Host', root)
    invite = (await host.client.request('session.host', { videoPath: video, subtitlePaths: [subs] })).invite
    await host.client.until('session', (s) => s.phase === 'in-room')
  })
  afterEach(() => {
    exportSteps.after = null
  })
  afterAll(async () => {
    for (const m of members) await m.manager.shutdown().catch(() => undefined)
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  /** A viewer with the whole video downloaded into `<its folder>/save`. */
  async function downloaded(name: string): Promise<{ viewer: Member; roomId: string; saveDir: string; dir: string }> {
    const viewer = spawn(name, root)
    const { roomId } = await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    const saveDir = join(viewer.dir, 'save')
    await viewer.client.request('session.confirmJoin', { dir: saveDir })
    await viewer.client.until('transfer', (t) => t.progress === 1)
    const dir = (await readSessionFile(join(viewer.dir, 'userData'), roomId))?.transferDir ?? ''
    expect(dir).not.toBe('')
    return { viewer, roomId, saveDir, dir }
  }

  /**
   * Save, and quit once the export is past `step`, as main does (core asked to shut down, killed 5 s later); the
   * export then stops for good at that step, like the process it ran in. How long the quit took.
   */
  async function quitWhileSaving(viewer: Member, step: string): Promise<number> {
    let reached = (): void => undefined
    const atStep = new Promise<void>((r) => (reached = r))
    let exit = (_e: Error): void => undefined
    const exited = new Promise<never>((_, reject) => (exit = reject))
    exited.catch(() => undefined)
    exportSteps.after = async (s) => {
      if (s !== step) return
      reached()
      await exited
    }
    const saving = viewer.client.request('transfer.saveFile', {}).catch((e: unknown) => (e as Error).message)
    await atStep
    const t0 = performance.now()
    await viewer.manager.shutdown()
    const quitMs = performance.now() - t0
    exit(new Error('core exited'))
    exportSteps.after = null
    // (what a window still there would be told: the export carries on at the next start)
    expect(await saving).toBe(
      'transfer.saveFile failed: save-failed Saving stopped before it was done; see the log. Choose Finish saving in Recent rooms, or it goes on the next time Cinemesh starts.',
    )
    return quitMs
  }

  it('finishes the export from its journal, with no host needed: the same video, the room gone', async () => {
    const { viewer, roomId, saveDir, dir } = await downloaded('Sam')
    const quitMs = await quitWhileSaving(viewer, 'unlinked:0')
    // the quit waits a bounded while for the save, inside main's 5 s grace, and still clears the active room
    expect(quitMs).toBeGreaterThanOrEqual(2900)
    expect(quitMs).toBeLessThan(4500)
    expect(existsSync(join(viewer.dir, 'userData', 'wt', 'active.json'))).toBe(false)
    // what the quit left: the journal, the first segment only in the part, the rest still in segments
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(true)
    expect(readdirSync(join(dir, 'seg')).sort()).toEqual([segmentName(1), segmentName(2)])
    expect(statSync(join(saveDir, 'mkv-cues.mkv.part')).size).toBeGreaterThanOrEqual(MIB)

    // the next start: hold its export halfway, to see what it keeps away from the folder meanwhile
    let resume = (): void => undefined
    const held = new Promise<void>((r) => (resume = r))
    exportSteps.after = async (s) => {
      if (s === 'copied:1') await held
    }
    const back = spawn('Sam', root, { dir: viewer.dir })
    await vi.waitFor(() => expect(exportNotices(back)).toHaveLength(1), { timeout: 30_000 })
    // Recent rooms lists it as a save, not a room to resume; nothing may touch the room or its folder meanwhile
    expect(await back.client.request('session.recent', {})).toEqual([
      expect.objectContaining({
        roomId,
        export: { name: 'mkv-cues.mkv', dest: saveDir, waiting: false, running: true },
      }),
    ])
    expect(await back.client.requestError('session.resume', { roomId })).toBe('busy')
    // a rejoin by its invite too: it would point the room's record (the way to this save) at a new download (M3)
    expect(await back.client.requestError('session.join', { invite })).toBe('busy')
    expect(await back.client.requestError('transfer.deleteData', { infoHash: basename(dir) })).toBe('busy')
    expect(await back.client.requestError('transfer.finishExport', { roomId })).toBe('busy')
    resume()
    await back.manager.started

    const path = join(saveDir, 'mkv-cues.mkv')
    expect(exportNotices(back)).toEqual([
      { level: 'info', code: 'transfer.export-resumed', message: 'Finishing saving mkv-cues.mkv…' },
      { level: 'info', code: 'transfer.export-finished', message: 'Saved mkv-cues.mkv', path },
    ])
    expect(sha256(path)).toBe(sha256(video))
    expect(readFileSync(join(saveDir, 'film.srt'), 'utf8')).toBe(SRT)
    expect(readdirSync(saveDir).sort()).toEqual(['.wt-partial', 'film.srt', 'mkv-cues.mkv']) // no part left
    expect(existsSync(dir)).toBe(false)
    expect(await new RoomStore(join(viewer.dir, 'userData')).load(roomId)).toBeNull()
    expect(await back.client.request('session.recent', {})).toEqual([])
  })

  it('gives the export up when its partly saved video is gone: the room is resumable and saves again', async () => {
    const { viewer, roomId, saveDir, dir } = await downloaded('Tess')
    await quitWhileSaving(viewer, 'unlinked:1')
    rmSync(join(saveDir, 'mkv-cues.mkv.part')) // deleted meanwhile (a folder that is not there waits instead)

    const back = spawn('Tess', root, { dir: viewer.dir })
    await back.manager.started
    const [resumed, failed] = exportNotices(back)
    expect(resumed?.code).toBe('transfer.export-resumed')
    expect(failed).toEqual({
      level: 'warn',
      code: 'transfer.export-failed',
      message:
        'Could not finish saving mkv-cues.mkv: the partly saved video is gone. Resume the room from Recent rooms to download the missing parts again, then save it.',
      // the next step, and a subject that keeps two rooms' notices apart
      action: { label: 'Resume', request: 'session.resume', params: { roomId } },
    })
    // the two consumed segments' pieces (1 MiB each) left the download's journal; the third is still there
    const torrent = await import('parse-torrent').then(async (m) => m.default(readFileSync(join(dir, 'meta.torrent'))))
    const journal = await Journal.open(join(dir, 'state.json'), torrent.infoHash, torrent.pieces.length)
    expect([0, 1, 2].map((i) => journal.has(i))).toEqual([false, false, true])
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(false)
    const total = statSync(video).size + SRT.length
    const [room] = await back.client.request('session.recent', {})
    expect(room).toMatchObject({ roomId, resumable: true })
    expect(room?.progress).toBeCloseTo((total - 2 * MIB) / total, 5)

    // Recent rooms -> Resume: what went missing comes down again, and the save goes through
    const mark = back.client.events.length
    await back.client.request('session.resume', { roomId })
    await vi.waitFor(
      () => {
        const done = back.client.events
          .slice(mark)
          .some((x) => x.e === 'transfer' && (x.d as TransferEvent).progress === 1)
        expect(done).toBe(true)
      },
      { timeout: 60_000 },
    )
    const { path } = await back.client.request('transfer.saveFile', {})
    expect(sha256(path)).toBe(sha256(video))
    expect(await new RoomStore(join(viewer.dir, 'userData')).load(roomId)).toBeNull()
  })
})
