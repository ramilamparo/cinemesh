import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CoreEventName, CoreEvents, NoticeEvent } from '../../../src/shared/ipc/core.js'
import { RoomStore } from '../../../src/core/net/identity.js'
import { readSessionFile, sessionFilePath } from '../../../src/core/session/session-file.js'
import { Journal } from '../../../src/core/transfer/journal.js'
import { EXPORT_FILE, exportSteps } from '../../../src/core/transfer/save-file.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// A save a quit cut off, when finishing it at the next start is not the whole story: its drive is away (it waits, and
// Recent rooms' Finish saving ends it), it is cancelled (Cancel saving: the room is resumable again), and the rules that
// keep a pending save reachable and untouched (no session of its room, no download into its folder, one export at a
// time per folder, records removed only while they still name its folder).

// 1 MiB segments (64 MiB in the app), so the 2.4 MB fixture spans three and an export consumes two of them
vi.mock('../../../src/core/transfer/segment-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/transfer/segment-store.js')>()),
  SEGMENT_BYTES: 1024 * 1024,
}))

const MIB = 1024 * 1024
const SRT = '1\n00:00:01,000 --> 00:00:03,000\nHello\n'

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

/** The transfer.export-* notices after the first `from` events. */
const exportNotices = (m: Member, from = 0): NoticeEvent[] =>
  m.client.events
    .slice(from)
    .flatMap((x) =>
      x.e === 'notice' && (x.d as NoticeEvent).code.startsWith('transfer.export') ? [x.d as NoticeEvent] : [],
    )

/** The first matching event after the first `from` events (until() would find an older one). */
async function after<E extends CoreEventName>(
  m: Member,
  from: number,
  e: E,
  pred: (d: CoreEvents[E]) => boolean,
  ms = 30_000,
): Promise<CoreEvents[E]> {
  const t0 = Date.now()
  for (;;) {
    const hit = m.client.events.slice(from).find((x) => x.e === e && pred(x.d as CoreEvents[E]))
    if (hit) return hit.d as CoreEvents[E]
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${e}; last: ${JSON.stringify(m.client.last(e))}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** `p`, or a failure once `ms` have passed (a request that hangs instead of being refused). */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${String(ms)} ms`)), ms)
  })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

/** Holds every export that reaches `step` there, until released. */
function holdAt(step: string): { reached: Promise<void>; release: () => void } {
  let reach = (): void => undefined
  const reached = new Promise<void>((r) => (reach = r))
  let release = (): void => undefined
  const gate = new Promise<void>((r) => (release = r))
  exportSteps.after = async (s) => {
    if (s !== step) return
    reach()
    await gate
  }
  return { reached, release }
}

/** Unplugs the drive at `drive` (its folder goes away); the returned function plugs it in again. */
function unplug(drive: string): () => void {
  renameSync(drive, `${drive}-away`)
  return () => renameSync(`${drive}-away`, drive)
}

describe.skipIf(!HAVE_FFMPEG)('a save a quit cut off: its drive away, Finish saving and Cancel saving', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-export-finish-'))
  const members: Member[] = []
  const spawn = (...args: Parameters<typeof member>): Member => {
    const m = member(...args)
    members.push(m)
    return m
  }
  let video = ''
  let subs = ''
  let invite = ''
  /** another room with the same video and subtitles: the same torrent, so the same transfer folder name */
  let otherInvite: Promise<string> | null = null

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

  function secondRoom(): Promise<string> {
    otherInvite ??= (async () => {
      const host = spawn('Host2', root)
      const hosted = await host.client.request('session.host', { videoPath: video, subtitlePaths: [subs] })
      await host.client.until('session', (s) => s.phase === 'in-room')
      return hosted.invite
    })()
    return otherInvite
  }

  /** `viewer` (else a new one) with the whole video of a room downloaded into `<its folder>/<folder>`. */
  async function downloaded(
    name: string,
    opts: { viewer?: Member; invite?: string; folder?: string } = {},
  ): Promise<{ viewer: Member; roomId: string; saveDir: string; dir: string }> {
    const viewer = opts.viewer ?? spawn(name, root)
    const mark = viewer.client.events.length
    const { roomId } = await viewer.client.request('session.join', { invite: opts.invite ?? invite })
    await after(viewer, mark, 'session', (s) => s.phase === 'confirm-join')
    const saveDir = join(viewer.dir, opts.folder ?? 'save')
    await viewer.client.request('session.confirmJoin', { dir: saveDir })
    await after(viewer, mark, 'transfer', (t) => t.progress === 1, 60_000)
    const dir = (await readSessionFile(join(viewer.dir, 'userData'), roomId))?.transferDir ?? ''
    expect(dir).not.toBe('')
    return { viewer, roomId, saveDir, dir }
  }

  /** Save (into `dest`, else the join folder) and quit once the export is past `step`: it stops there for good. */
  async function quitWhileSaving(viewer: Member, step: string, dest?: string): Promise<void> {
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
    const saving = viewer.client.requestError('transfer.saveFile', dest ? { dest } : {})
    await atStep
    await viewer.manager.shutdown()
    exit(new Error('core exited'))
    exportSteps.after = null
    expect(await saving).toBe('save-failed')
  }

  /** A save into `<its folder>/usb/Videos` cut off after `step`, as if the drive were plugged in then. */
  async function savedToDrive(viewer: Member, step: string): Promise<{ drive: string; dest: string }> {
    const drive = join(viewer.dir, 'usb')
    const dest = join(drive, 'Videos')
    mkdirSync(dest, { recursive: true })
    await quitWhileSaving(viewer, step, dest)
    return { drive, dest }
  }

  it('waits for its drive, changing nothing, and Finish saving ends it once the drive is back', async () => {
    const { viewer, roomId, dir } = await downloaded('Ann')
    const { drive, dest } = await savedToDrive(viewer, 'unlinked:0')
    const plugIn = unplug(drive) // before the next start

    const back = spawn('Ann', root, { dir: viewer.dir })
    await back.manager.started
    // said once, with the way to finish it; nothing given up, and nothing made where the drive goes
    expect(exportNotices(back)).toEqual([
      {
        level: 'warn',
        code: 'transfer.export-waiting',
        message: `Saving mkv-cues.mkv is waiting for ${dest}: connect it, then choose Finish saving.`,
        action: { label: 'Finish saving', request: 'transfer.finishExport', params: { roomId } },
      },
    ])
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(true)
    expect(existsSync(drive)).toBe(false)
    expect(await back.client.request('session.recent', {})).toEqual([
      expect.objectContaining({ roomId, export: { name: 'mkv-cues.mkv', dest, waiting: true } }),
    ])
    // the room stays the save's until it is finished or cancelled
    expect(await back.client.requestError('session.resume', { roomId })).toBe('busy')
    expect(await back.client.requestError('session.join', { invite })).toBe('busy')
    expect(await back.client.requestError('transfer.deleteData', { infoHash: basename(dir) })).toBe('busy')
    expect(await back.client.request('transfer.finishExport', { roomId })).toEqual({ outcome: 'waiting' })
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(true)
    expect(existsSync(drive)).toBe(false)

    plugIn()
    expect((await back.client.request('session.recent', {}))[0]?.export).toEqual({
      name: 'mkv-cues.mkv',
      dest,
      waiting: false,
    })
    // one export at a time in a folder: a second Finish saving, or a Cancel saving, is refused while it runs
    const held = holdAt('copied:1')
    const mark = back.client.events.length
    const finishing = back.client.request('transfer.finishExport', { roomId })
    await held.reached
    expect(await within(10_000, back.client.requestError('transfer.finishExport', { roomId }))).toBe('busy')
    expect(await within(10_000, back.client.requestError('transfer.finishExport', { roomId, giveUp: true }))).toBe(
      'busy',
    )
    held.release()
    const path = join(dest, 'mkv-cues.mkv')
    expect(await finishing).toEqual({ outcome: 'finished', path })
    expect(sha256(path)).toBe(sha256(video))
    expect(readFileSync(join(dest, 'film.srt'), 'utf8')).toBe(SRT)
    expect(readdirSync(dest).sort()).toEqual(['film.srt', 'mkv-cues.mkv'])
    // the window learns where it went from the notice, as for every finished save
    expect(exportNotices(back, mark)).toEqual([
      { level: 'info', code: 'transfer.export-finished', message: 'Saved mkv-cues.mkv', path },
    ])
    expect(existsSync(dir)).toBe(false)
    expect(await back.client.request('session.recent', {})).toEqual([])
    expect(await back.client.requestError('transfer.finishExport', { roomId })).toBe('not-found')
  })

  it("a Finish saving that starts while startup's search is slow stays the folder's only export", async () => {
    const { viewer, roomId, dir } = await downloaded('Dee')
    await quitWhileSaving(viewer, 'unlinked:0')

    // startup's search for cut-off saves lists the rooms slowly (a recent room's folder on a sleeping disk)
    let searched = (): void => undefined
    const slow = new Promise<void>((r) => (searched = r))
    // the original, called with each store as `this` below
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const list = RoomStore.prototype.list
    const spy = vi.spyOn(RoomStore.prototype, 'list').mockImplementation(async function (this: RoomStore) {
      if (new Error().stack?.includes('pendingExports')) await slow
      return list.call(this)
    })
    const runs: string[] = []
    let reached = (): void => undefined
    const atCopy = new Promise<void>((r) => (reached = r))
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    exportSteps.after = async (s) => {
      runs.push(s)
      if (s === 'copied:1' && runs.filter((x) => x === s).length === 1) {
        reached()
        await gate
      }
    }
    try {
      const back = spawn('Dee', root, { dir: viewer.dir, sweepWaitMs: 200 })
      const mark = back.client.events.length
      // the request stops waiting for the search, and runs the export itself
      const finishing = back.client.request('transfer.finishExport', { roomId })
      await atCopy
      // the search ends while that export runs and finds its journal: the folder is taken
      searched()
      await new Promise((r) => setTimeout(r, 500))
      release()
      expect(await finishing).toMatchObject({ outcome: 'finished' })
      await back.manager.started
      expect(runs.filter((s) => s === 'copied:1')).toEqual(['copied:1'])
      expect(exportNotices(back, mark).map((n) => n.code)).toEqual(['transfer.export-finished'])
      expect(existsSync(dir)).toBe(false)
    } finally {
      spy.mockRestore()
      release()
    }
  })

  it('Cancel saving with the drive gone for good: the room is resumable, and Resume downloads what it took', async () => {
    const { viewer, roomId, dir } = await downloaded('Bea')
    const { drive } = await savedToDrive(viewer, 'unlinked:1')
    rmSync(drive, { recursive: true }) // gone for good

    const back = spawn('Bea', root, { dir: viewer.dir })
    await back.manager.started
    expect(exportNotices(back).map((n) => n.code)).toEqual(['transfer.export-waiting'])
    const mark = back.client.events.length
    expect(await back.client.request('transfer.finishExport', { roomId, giveUp: true })).toEqual({ outcome: 'rejoin' })
    expect(exportNotices(back, mark)).toEqual([]) // asked for: nothing to tell
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(false)
    expect(existsSync(drive)).toBe(false)
    // the two segments it had moved into the part (1 MiB each) count as missing again; the third is still there
    const torrent = await import('parse-torrent').then(async (m) => m.default(readFileSync(join(dir, 'meta.torrent'))))
    const journal = await Journal.open(join(dir, 'state.json'), torrent.infoHash, torrent.pieces.length)
    expect([0, 1, 2].map((i) => journal.has(i))).toEqual([false, false, true])
    const total = statSync(video).size + SRT.length
    const [room] = await back.client.request('session.recent', {})
    expect(room).toMatchObject({ roomId, resumable: true })
    expect(room?.export).toBeUndefined()
    expect(room?.progress).toBeCloseTo((total - 2 * MIB) / total, 5)

    // Recent rooms -> Resume: what went missing comes down again, and the save goes through
    const resumed = back.client.events.length
    await back.client.request('session.resume', { roomId })
    await after(back, resumed, 'transfer', (t) => t.progress === 1, 60_000)
    const saving = back.client.events.length
    const { path } = await back.client.request('transfer.saveFile', {})
    expect(sha256(path)).toBe(sha256(video))
    // said by a notice too (the window shows that one), before the answer
    expect(exportNotices(back, saving)).toEqual([
      { level: 'info', code: 'transfer.export-finished', message: 'Saved mkv-cues.mkv', path },
    ])
  })

  it('registers every save it finds before running the first: one queued behind another is busy too', async () => {
    const first = await downloaded('Cy')
    const { drive, dest } = await savedToDrive(first.viewer, 'unlinked:0')
    const plugIn = unplug(drive)
    // the next start: that save waits for its drive, and one of the same video from another room is cut off too
    const again = spawn('Cy', root, { dir: first.viewer.dir })
    await again.manager.started
    const second = await downloaded('Cy', { viewer: again, invite: await secondRoom(), folder: 'other' })
    await quitWhileSaving(again, 'unlinked:0')
    plugIn()

    // the start after: two saves, the newer one first, held halfway
    const held = holdAt('copied:1')
    const third = spawn('Cy', root, { dir: first.viewer.dir })
    await held.reached
    expect(await within(10_000, third.client.requestError('transfer.finishExport', { roomId: second.roomId }))).toBe(
      'busy',
    )
    expect(await within(10_000, third.client.requestError('transfer.finishExport', { roomId: first.roomId }))).toBe(
      'busy',
    )
    held.release()
    await third.manager.started
    const saved = [join(second.saveDir, 'mkv-cues.mkv'), join(dest, 'mkv-cues.mkv')]
    expect(exportNotices(third).map((n) => [n.code, n.path])).toEqual([
      ['transfer.export-resumed', undefined],
      ['transfer.export-finished', saved[0]],
      ['transfer.export-resumed', undefined],
      ['transfer.export-finished', saved[1]],
    ])
    for (const path of saved) expect(sha256(path)).toBe(sha256(video))
  })

  it('a rejoin while its save finishes is refused, and its end removes only rooms still using its folder', async () => {
    const { viewer, roomId, dir } = await downloaded('Dee')
    await quitWhileSaving(viewer, 'unlinked:0')
    const held = holdAt('copied:1')
    const back = spawn('Dee', root, { dir: viewer.dir })
    await held.reached
    // joining the room again by its invite (into another folder) used to point the room's record away from the save
    expect(await back.client.requestError('session.join', { invite })).toBe('busy')
    // whatever points it elsewhere meanwhile, the save's end leaves that room alone
    const userData = join(viewer.dir, 'userData')
    const file = sessionFilePath(userData, roomId)
    const elsewhere = join(viewer.dir, 'other', '.wt-partial', basename(dir))
    writeFileSync(
      file,
      JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), transferDir: elsewhere }),
    )
    held.release()
    await back.manager.started
    expect(exportNotices(back).map((n) => n.code)).toEqual(['transfer.export-resumed', 'transfer.export-finished'])
    expect(existsSync(dir)).toBe(false)
    expect(await new RoomStore(userData).load(roomId)).not.toBeNull()
    expect((await readSessionFile(userData, roomId))?.transferDir).toBe(elsewhere)
  })

  it('a save that finishes while its room is in use leaves that room alone', async () => {
    const { viewer, roomId, dir } = await downloaded('Gil')
    await quitWhileSaving(viewer, 'unlinked:0')
    const held = holdAt('copied:1')
    const back = spawn('Gil', root, { dir: viewer.dir })
    await held.reached
    // no request starts a session of that room meanwhile (see above); one stands in for a way that might
    const internals = back.manager as unknown as { current: { roomId: string } | null }
    internals.current = { roomId }
    try {
      held.release()
      await back.manager.started
    } finally {
      internals.current = null
    }
    expect(exportNotices(back).map((n) => n.code)).toEqual(['transfer.export-resumed', 'transfer.export-finished'])
    expect(existsSync(dir)).toBe(false)
    expect(await new RoomStore(join(viewer.dir, 'userData')).load(roomId)).not.toBeNull()
  })

  it('a save a quit stops again stays reachable through its room: the start after finishes it', async () => {
    const { viewer, roomId, dir } = await downloaded('Eve')
    await quitWhileSaving(viewer, 'unlinked:0')
    const held = holdAt('copied:1')
    const back = spawn('Eve', root, { dir: viewer.dir })
    await held.reached
    expect(await back.client.requestError('session.join', { invite })).toBe('busy')
    await back.manager.shutdown() // a quit again: it stops at its next step, still pending
    held.release()
    await back.manager.started
    exportSteps.after = null
    const userData = join(viewer.dir, 'userData')
    expect((await readSessionFile(userData, roomId))?.transferDir).toBe(dir)
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(true)

    const third = spawn('Eve', root, { dir: viewer.dir })
    await third.manager.started
    expect(exportNotices(third).map((n) => n.code)).toEqual(['transfer.export-resumed', 'transfer.export-finished'])
    expect(sha256(join(viewer.dir, 'save', 'mkv-cues.mkv'))).toBe(sha256(video))
    expect(existsSync(dir)).toBe(false)
    expect(await new RoomStore(userData).load(roomId)).toBeNull()
  })

  it('no room downloads this video into a folder where a save of it is pending', async () => {
    const otherRoom = await secondRoom()
    const { viewer, roomId, saveDir, dir } = await downloaded('Fay')
    const { drive } = await savedToDrive(viewer, 'unlinked:0')
    const plugIn = unplug(drive) // it stays pending at the next start, waiting for its drive
    const back = spawn('Fay', root, { dir: viewer.dir })
    await back.manager.started
    const segments = readdirSync(join(dir, 'seg')).sort()

    // the same video from another room: JoinConfirm refuses that folder, and another one can still be chosen
    const mark = back.client.events.length
    const { roomId: other } = await back.client.request('session.join', { invite: otherRoom })
    await after(back, mark, 'session', (s) => s.phase === 'confirm-join')
    expect(await back.client.requestError('session.confirmJoin', { dir: saveDir })).toBe('busy')
    expect(back.client.last('session')?.phase).toBe('confirm-join')
    await back.client.request('session.confirmJoin', { dir: join(viewer.dir, 'other') })
    await after(back, mark, 'session', (s) => s.phase === 'in-room')
    await back.client.request('session.leave', { data: 'keep' })

    // a resume whose record would download there (its save folder is that one) stops before it does
    const userData = join(viewer.dir, 'userData')
    const file = sessionFilePath(userData, other)
    writeFileSync(file, JSON.stringify({ ...(JSON.parse(readFileSync(file, 'utf8')) as object), saveDir }))
    const resumed = back.client.events.length
    await back.client.request('session.resume', { roomId: other })
    const failed = await after(back, resumed, 'session', (s) => s.phase === 'error')
    expect(failed.error?.code).toBe('busy')
    await back.client.request('session.leave', { data: 'keep' })
    expect(readdirSync(join(dir, 'seg')).sort()).toEqual(segments)
    expect(existsSync(join(dir, EXPORT_FILE))).toBe(true)

    plugIn()
    expect(await back.client.request('transfer.finishExport', { roomId })).toMatchObject({ outcome: 'finished' })
  })
})
