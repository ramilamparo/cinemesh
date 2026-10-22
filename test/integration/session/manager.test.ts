import { createSocket } from 'node:dgram'
import { randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CoreEventName, CoreEvents, SessionEvent } from '../../../src/shared/ipc/core.js'
import { defaultSettings } from '../../../src/shared/settings.js'
import { themePayload } from '../../../src/shared/theme-tokens.js'
import { log } from '../../../src/core/log.js'
import { RoomStore, roomIdFor } from '../../../src/core/net/identity.js'
import type { RpcPort } from '../../../src/core/host-transport.js'
import { RpcServer } from '../../../src/core/rpc-server.js'
import { SessionManager } from '../../../src/core/session/manager.js'
import { readSessionFile, sessionFilePath } from '../../../src/core/session/session-file.js'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { exportSteps } from '../../../src/core/transfer/save-file.js'
import { segmentName } from '../../../src/core/transfer/segment-store.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { Client, type Member, member } from './harness.js'

// SessionManager across core restarts (plan §4.5 "Host restart or core crash"): the active-room marker and
// main's crash restart (init.resumeActive), the startup sweep, leaves, and mpv fixed while joining.

const DAY = 24 * 3600 * 1000
const MPV_OK = { path: '/usr/bin/mpv', kind: 'system', version: '0.40.0', status: 'ok' } as const

const markerPath = (m: Member): string => join(m.dir, 'userData', 'wt', 'active.json')

function marker(m: Member): string | null {
  try {
    return (JSON.parse(readFileSync(markerPath(m), 'utf8')) as { roomId: string }).roomId
  } catch {
    return null
  }
}

/** A core crash as main sees it: the process is gone, and its active-room marker survived. */
async function crash(m: Member, roomId: string): Promise<void> {
  await m.manager.shutdown() // stands in for the dead process: its room must go away
  writeFileSync(markerPath(m), JSON.stringify({ roomId }))
}

/** A core crash in the middle of a session: the room drops without a goodbye, nothing is flushed or cleared. */
async function kill(m: Member): Promise<void> {
  await (m.manager as unknown as { current: { room: { close(): Promise<void> } } | null }).current?.room.close()
}

/**
 * A core no window has connected to yet (by default one main restarted after a crash); connect() is the window's
 * port arriving later.
 */
function windowless(
  name: string,
  dir: string,
  opts: { resumeActive?: boolean; sweepWaitMs?: number } = { resumeActive: true },
): { manager: SessionManager; rpc: RpcServer; connect: () => Client } {
  const rpc = new RpcServer({
    app: '0.0.0-test',
    electron: null,
    node: process.versions.node,
    chrome: null,
    protocol: 1,
  })
  const manager = new SessionManager(rpc, {
    paths: {
      userData: join(dir, 'userData'),
      logsDir: join(dir, 'logs'),
      downloadDir: join(dir, 'downloads'),
      resources: 'resources',
    },
    settings: { ...defaultSettings(), displayName: name, downloadDir: join(dir, 'downloads') },
    theme: themePayload('system', 'light'),
    mpv: { path: null, kind: 'none', version: null, status: 'missing' },
    appVersion: '0.0.0-test',
    store: new RoomStore(join(dir, 'userData')),
    fakePlayer: true,
    ...opts,
    log,
    control: { power: () => undefined, mpvPid: () => undefined, showApp: () => undefined },
  })
  return { manager, rpc, connect: () => new Client(rpc) }
}

/** A window whose port goes away when it reloads (the harness's never closes). */
function closableWindow(rpc: RpcServer): { client: Client; close: () => void } {
  let closed = (): void => undefined
  const client = new Client({
    attach: (port: RpcPort) =>
      rpc.attach({
        ...port,
        onClose: (cb) => {
          closed = cb
        },
      }),
  } as unknown as RpcServer)
  return { client, close: () => closed() }
}

/** The session events after the first `from` events. */
const sessionsSince = (c: Client, from: number): SessionEvent[] =>
  c.events.slice(from).flatMap((x) => (x.e === 'session' ? [x.d as SessionEvent] : []))

/** What 'leaving' must say: the session's room and file, as its last event had them, and what the leave does. */
function leavingAfter(last: SessionEvent | undefined, leave: NonNullable<SessionEvent['leave']>): SessionEvent {
  if (!last?.role || !last.roomId) throw new Error(`not in a room: ${JSON.stringify(last)}`)
  return {
    phase: 'leaving',
    role: last.role,
    roomId: last.roomId,
    fileName: last.fileName,
    fileSize: last.fileSize,
    durationS: last.durationS,
    ...(last.media ? { media: last.media } : {}),
    leave,
  }
}

/** `p`, or a failure once `ms` have passed (instead of waiting for the test's own timeout). */
async function within<T>(ms: number, what: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took over ${String(ms)} ms`)), ms)
  })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

/** A viewer room left with "Keep for later" `ageMs` ago (its host is not around): record, session.json, data. */
async function keptDownload(dir: string, ageMs: number): Promise<{ roomId: string; transferDir: string }> {
  const userData = join(dir, 'userData')
  const hex = (n: number): string => randomBytes(n).toString('hex')
  const hostKey = hex(32)
  const roomId = roomIdFor(Buffer.from(hostKey, 'hex'))
  const at = Date.now() - ageMs
  await new RoomStore(userData).save({
    id: roomId,
    secret: hex(32),
    hostKey,
    name: 'Old room',
    keySeed: hex(32),
    role: 'viewer',
    inviteEpoch: 0,
    lastJoined: at,
  })
  const infoHash = hex(20)
  const transferDir = join(dir, 'downloads', '.wt-partial', infoHash)
  const segment = join(transferDir, 'seg', segmentName(0))
  mkdirSync(dirname(segment), { recursive: true })
  writeFileSync(segment, randomBytes(64 * 1024))
  writeFileSync(join(transferDir, 'state.json'), '{}')
  writeFileSync(join(transferDir, 'meta.torrent'), 'torrent')
  const file = sessionFilePath(userData, roomId)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      role: 'viewer',
      roomId,
      fileName: 'old.mkv',
      fileSize: 1e6,
      durationS: 60,
      infoHash,
      saveDir: join(dir, 'downloads'),
      transferDir,
      progress: 0.4,
      updatedAt: at,
    }),
  )
  for (const p of [segment, dirname(segment), join(transferDir, 'state.json'), join(transferDir, 'meta.torrent')]) {
    utimesSync(p, at / 1000, at / 1000)
  }
  utimesSync(transferDir, at / 1000, at / 1000)
  return { roomId, transferDir }
}

/** The first matching event after the first `from` events (until() would find an older one). */
async function after<E extends CoreEventName>(
  c: Client,
  from: number,
  e: E,
  pred: (d: CoreEvents[E]) => boolean,
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

describe.skipIf(!HAVE_FFMPEG)('session manager: core restarts, startup sweep, leaving', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-manager-'))
  const members: Member[] = []
  const spawn = (...args: Parameters<typeof member>): Member => {
    const m = member(...args)
    members.push(m)
    return m
  }
  let video = ''
  let host: Member
  let sam: Member
  let roomId = ''
  let invite = ''

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv')
  })
  afterAll(async () => {
    for (const m of members) await m.manager.shutdown().catch(() => undefined)
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it("the Network test with a room open reports that room's node, which holds the UDP port", async () => {
    // a free UDP port for the room's node to bind; a second node beside it would get another one
    const port = await new Promise<number>((resolve) => {
      const probe = createSocket('udp4')
      probe.bind(0, '127.0.0.1', () => {
        const { port: free } = probe.address()
        probe.close(() => resolve(free))
      })
    })
    const nat = spawn('Nat', root, { settings: { udpPort: port } })
    await nat.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await nat.client.until('session', (s) => s.phase === 'in-room')
    await vi.waitFor(async () => expect((await nat.client.request('net.test', {})).bootstrapped).toBe(true), {
      timeout: 30_000,
    })
    // the room's node bound the port, so its report gives the forward hint for it (a second node, on another port,
    // would say the port was in use); `port` is the address peers see, not the bound one
    const report = await nat.client.request('net.test', {})
    expect(report.class).toBe('CONSISTENT')
    expect(report.hint).toBe(
      `UDP ${String(port)} does not answer from the internet yet. Check the port forward on your router.`,
    )
    await nat.manager.shutdown()
  })

  it('a core restart rejoins the hosted room with the same invite, and its viewer comes back', async () => {
    host = spawn('Host', root)
    sam = spawn('Sam', root)
    const hosted = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    roomId = hosted.roomId
    invite = hosted.invite
    await host.client.until('session', (s) => s.phase === 'in-room')
    expect(marker(host)).toBe(roomId)

    await sam.client.request('session.join', { invite })
    await sam.client.until('session', (s) => s.phase === 'confirm-join')
    await sam.client.request('session.confirmJoin', { dir: join(sam.dir, 'save') })
    await sam.client.until('transfer', (t) => t.progress === 1)
    expect(marker(sam)).toBe(roomId)

    await crash(host, roomId)
    const restarted = spawn('Host', root, { dir: host.dir, resumeActive: true })
    host = restarted
    await restarted.manager.started
    const s = await restarted.client.until('session', (e) => e.phase === 'in-room')
    expect(s.roomId).toBe(roomId)
    expect((await restarted.client.request('room.invite', {})).link).toBe(invite)
    expect(marker(restarted)).toBe(roomId)
    // the viewer stayed in the room and finds its host again
    await restarted.client.until('peers', (ps) => ps.some((p) => p.name === 'Sam' && p.path !== 'none'), 60_000)
  })

  it('a core restart resumes the viewer from its journal without asking for a folder again', async () => {
    const file = JSON.parse(readFileSync(join(sam.dir, 'userData', 'wt', 'rooms', roomId, 'session.json'), 'utf8')) as {
      transferDir: string
    }
    await crash(sam, roomId)
    const segment = join(file.transferDir, 'seg', segmentName(0))
    const written = statSync(segment).mtimeMs

    const restarted = spawn('Sam', root, { dir: sam.dir, resumeActive: true })
    sam = restarted
    await restarted.manager.started
    await restarted.client.until('session', (e) => e.phase === 'in-room')
    await restarted.client.until('transfer', () => true)
    expect(restarted.client.all('transfer')[0]?.progress).toBe(1)
    expect(restarted.client.all('session').some((e) => e.phase === 'confirm-join')).toBe(false)
    expect(statSync(segment).mtimeMs).toBe(written)
    expect(marker(restarted)).toBe(roomId)

    // saving while a leave runs is refused, not started a second time
    const leaving = restarted.client.request('session.leave', { data: 'keep' })
    expect(await restarted.client.requestError('transfer.saveFile', {})).toBe('busy')
    await leaving
    expect(marker(restarted)).toBeNull()
    expect(existsSync(segment)).toBe(true)
  })

  it('after a whole-app crash (no resumeActive) the marker is dropped and Recent rooms offers the room', async () => {
    await crash(sam, roomId)
    const started = spawn('Sam', root, { dir: sam.dir })
    sam = started
    await started.manager.started
    expect(marker(started)).toBeNull()
    expect(started.client.all('session').every((e) => e.phase === 'idle')).toBe(true)
    const recent = await started.client.request('session.recent', {})
    expect(recent.find((r) => r.roomId === roomId)).toMatchObject({ role: 'viewer', resumable: true })
  })

  let cleo: Member

  it('fixing mpv while joining (no player yet) reaches the renderer at once', async () => {
    // a viewer that was never in the room joins the restarted host with the old invite
    cleo = spawn('Cleo', root)
    await cleo.client.request('session.join', { invite })
    await cleo.client.until('session', (s) => s.phase === 'confirm-join')
    const players = cleo.client.all('player').length
    cleo.manager.updateMpv(MPV_OK)
    expect(cleo.client.all('player').length).toBe(players + 1)
    expect(cleo.client.last('player')?.status).toBe('absent')
    expect(cleo.client.last('session')?.phase).toBe('confirm-join')
  })

  it('a second leave asking for something else is refused; one asking for the same waits for it', async () => {
    const first = cleo.client.request('session.leave', { data: 'keep' })
    expect(await cleo.client.requestError('session.leave', { data: 'delete' })).toBe('busy')
    // asking for the same thing again just waits for it
    await Promise.all([first, cleo.client.request('session.leave', { data: 'keep' })])
    expect(cleo.client.last('session')?.phase).toBe('idle')
    expect(marker(cleo)).toBeNull()

    // 'save' with nothing to save says so (the session still ends)
    const mark = cleo.client.events.length
    await cleo.client.request('session.join', { invite })
    const confirm = await after(cleo.client, mark, 'session', (s) => s.phase === 'confirm-join')
    expect(await cleo.client.requestError('session.leave', { data: 'save' })).toBe('save-failed')
    expect(sessionsSince(cleo.client, mark).filter((s) => s.phase === 'leaving')).toEqual([
      leavingAfter(confirm, 'save'),
    ])
    expect(cleo.client.last('session')?.phase).toBe('idle')
  })

  it('resuming after a restart when the hosted video is gone: an error notice, no room and no marker', async () => {
    const hana = spawn('Hana', root)
    const copy = join(hana.dir, 'movie.mkv')
    copyFileSync(video, copy)
    const hosted = await hana.client.request('session.host', { videoPath: copy, subtitlePaths: [] })
    await hana.client.until('session', (s) => s.phase === 'in-room')
    await crash(hana, hosted.roomId)
    rmSync(copy)

    const restarted = spawn('Hana', root, { dir: hana.dir, resumeActive: true })
    await restarted.manager.started
    const notice = await restarted.client.until('notice', (n) => n.code === 'session.resume-failed')
    expect(notice.message).toMatch(/cannot be read/)
    expect(marker(restarted)).toBeNull()
    expect(restarted.client.all('session').every((e) => e.phase === 'idle')).toBe(true)
  })

  it('a room the host has ended is not rejoined by a crash restart', async () => {
    const nia = spawn('Nia', root)
    const otto = spawn('Otto', root)
    const hosted = await nia.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await nia.client.until('session', (s) => s.phase === 'in-room')
    await otto.client.request('session.join', { invite: hosted.invite })
    await otto.client.until('session', (s) => s.phase === 'confirm-join')
    expect(marker(otto)).toBe(hosted.roomId)
    await nia.client.request('session.leave', { data: 'keep', end: true })
    await otto.client.until('session', (s) => s.phase === 'ended')
    // Otto still has to choose what to do with the data, but the room is over
    await expect.poll(() => marker(otto)).toBeNull()
  })

  it('a torn marker keeps nobody from hosting', async () => {
    const dir = mkdtempSync(join(root, 'Gus-'))
    mkdirSync(join(dir, 'userData', 'wt'), { recursive: true })
    writeFileSync(join(dir, 'userData', 'wt', 'active.json'), '{"roomId":')
    const gus = spawn('Gus', root, { dir, resumeActive: true })
    await gus.manager.started
    const hosted = await gus.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    expect(marker(gus)).toBe(hosted.roomId)
    await gus.client.request('session.leave', { data: 'keep', end: true })
    expect(marker(gus)).toBeNull()
  })

  it('the startup sweep clears week-old partial downloads from the save folder', async () => {
    const dir = mkdtempSync(join(root, 'Ivy-'))
    const old = join(dir, 'downloads', '.wt-partial', 'ab'.repeat(20))
    const fresh = join(dir, 'downloads', '.wt-partial', 'cd'.repeat(20))
    for (const d of [old, fresh]) {
      mkdirSync(join(d, 'seg'), { recursive: true })
      writeFileSync(join(d, 'state.json'), '{}')
    }
    const t = (Date.now() - 8 * DAY) / 1000
    for (const p of [join(old, 'state.json'), join(old, 'seg'), old]) utimesSync(p, t, t)
    const ivy = spawn('Ivy', root, { dir })
    await ivy.manager.started
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('Recent rooms waits for the startup sweep: it never offers a download the sweep is deleting', async () => {
    const dir = mkdtempSync(join(root, 'Uma-'))
    const old = await keptDownload(dir, 8 * DAY)
    const fresh = await keptDownload(dir, DAY)
    const uma = spawn('Uma', root, { dir })
    // Home asks as soon as the window is up, while the sweep still runs
    const recent = await uma.client.request('session.recent', {})
    expect(recent.map((r) => [r.roomId, r.resumable])).toEqual([[fresh.roomId, true]])
    await uma.manager.started
    expect(existsSync(old.transferDir)).toBe(false)
    expect(existsSync(fresh.transferDir)).toBe(true)
  })

  it('after a whole-app crash the sweep keeps the room that was open, for Recent rooms to offer', async () => {
    const dir = mkdtempSync(join(root, 'Xan-'))
    // in the room for a week with the download long finished: nothing was written meanwhile
    const open = await keptDownload(dir, 8 * DAY)
    writeFileSync(join(dir, 'userData', 'wt', 'active.json'), JSON.stringify({ roomId: open.roomId }))
    const xan = spawn('Xan', root, { dir })
    await xan.manager.started
    expect(existsSync(join(open.transferDir, 'seg', segmentName(0)))).toBe(true)
    const recent = await xan.client.request('session.recent', {})
    expect(recent.map((r) => [r.roomId, r.resumable])).toEqual([[open.roomId, true]])
  })

  it('a Resume clicked while the startup sweep runs keeps that download from the sweep', async () => {
    const dir = mkdtempSync(join(root, 'Vic-'))
    const old = await keptDownload(dir, 8 * DAY)
    const segment = join(old.transferDir, 'seg', segmentName(0))
    const written = statSync(segment).mtimeMs
    const store = new RoomStore(join(dir, 'userData'))
    const keySeed = (await store.load(old.roomId))?.keySeed

    const vic = spawn('Vic', root, { dir })
    await vic.client.request('session.resume', { roomId: old.roomId })
    await vic.manager.started
    // the session resumes the week-old download in place: same data, same journal, same identity
    expect(statSync(segment).mtimeMs).toBe(written)
    expect(existsSync(join(old.transferDir, 'state.json'))).toBe(true)
    expect((await readSessionFile(join(dir, 'userData'), old.roomId))?.transferDir).toBe(old.transferDir)
    expect((await store.load(old.roomId))?.keySeed).toBe(keySeed)
    await vic.client.request('session.leave', { data: 'keep' })
  })

  it('a Resume clicked while the sweep is deleting that download fails cleanly and brings nothing back', async () => {
    const dir = mkdtempSync(join(root, 'Wes-'))
    const old = await keptDownload(dir, 8 * DAY)
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each store as this
    const remove = RoomStore.prototype.remove
    // the sweep has deleted the data and is about to drop the room's record
    const held = vi.spyOn(RoomStore.prototype, 'remove').mockImplementation(async function (this: RoomStore, id) {
      if (id === old.roomId) await gate
      return remove.call(this, id)
    })
    try {
      const wes = spawn('Wes', root, { dir })
      await vi.waitFor(() => expect(held).toHaveBeenCalledWith(old.roomId), { timeout: 30_000 })
      expect(await wes.client.requestError('session.resume', { roomId: old.roomId })).toBe('unknown-room')
      release()
      await wes.manager.started
      expect(existsSync(join(dir, 'userData', 'wt', 'rooms', old.roomId))).toBe(false)
      expect(wes.client.all('session').every((e) => e.phase === 'idle')).toBe(true)
    } finally {
      release()
      held.mockRestore()
    }
  })

  it('a resume that fails after a core restart reaches a window that connects later, once', async () => {
    const yan = spawn('Yan', root)
    const copy = join(yan.dir, 'movie.mkv')
    copyFileSync(video, copy)
    const hosted = await yan.client.request('session.host', { videoPath: copy, subtitlePaths: [] })
    await yan.client.until('session', (s) => s.phase === 'in-room')
    await crash(yan, hosted.roomId)
    rmSync(copy)

    // the restarted core fails to resume before any window is back (a reload, a window still loading)
    const core = windowless('Yan', yan.dir)
    try {
      await core.manager.started
      const late = core.connect()
      const notice = await late.until('notice', (n) => n.code === 'session.resume-failed')
      expect(notice.message).toMatch(/cannot be read/)
      expect(await late.requestError('room.invite', {})).toBe('no-session')
      // shown once: a window that connects after that one does not get it again
      const later = core.connect()
      expect(later.all('notice')).toEqual([])
    } finally {
      await core.manager.shutdown()
    }
  })

  it("a leave goes out once as 'leaving', with the room and file, and then idle", async () => {
    const lea = spawn('Lea', root)
    const max = spawn('Max', root)
    const hosted = await lea.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await lea.client.until('session', (s) => s.phase === 'in-room')
    await max.client.request('session.join', { invite: hosted.invite })
    await max.client.until('session', (s) => s.phase === 'confirm-join')
    await max.client.request('session.confirmJoin', { dir: join(max.dir, 'save') })
    await max.client.until('transfer', (t) => t.progress === 1)

    const room = max.client.last('session')
    expect(room).toMatchObject({ phase: 'in-room', fileName: 'mkv-cues.mkv' })
    expect(room?.durationS).toBeGreaterThan(0)
    let mark = max.client.events.length
    const saving = max.client.request('transfer.saveFile', {})
    // a leave asking for something else meanwhile is refused; one asking for the same waits for the export
    expect(await max.client.requestError('session.leave', { data: 'delete' })).toBe('busy')
    const same = max.client.request('session.leave', { data: 'save' })
    const { path } = await saving
    await same
    expect(existsSync(path)).toBe(true)
    expect(sessionsSince(max.client, mark)).toEqual([
      leavingAfter(room, 'save'),
      expect.objectContaining({ phase: 'idle' }),
    ])
    // the window shows where it went from the notice: one save asked for twice is one notice
    expect(max.client.all('notice').filter((n) => n.code === 'transfer.export-finished')).toEqual([
      { level: 'info', code: 'transfer.export-finished', message: 'Saved mkv-cues.mkv', path },
    ])

    const hostRoom = lea.client.last('session')
    expect(hostRoom).toMatchObject({ phase: 'in-room', role: 'host', fileSize: statSync(video).size })
    mark = lea.client.events.length
    await Promise.all([
      lea.client.request('session.leave', { data: 'keep', end: true }),
      lea.client.request('session.leave', { data: 'keep', end: true }),
    ])
    expect(sessionsSince(lea.client, mark)).toEqual([
      leavingAfter(hostRoom, 'end'),
      expect.objectContaining({ phase: 'idle' }),
    ])
  })

  it("'leaving' says what the leave does: a host's leave without ending is 'keep', a viewer's is its choice", async () => {
    const kai = spawn('Kai', root)
    const ola = spawn('Ola', root)
    const hosted = await kai.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await kai.client.until('session', (s) => s.phase === 'in-room')
    const leaves: SessionEvent['leave'][] = []
    for (const data of ['delete', 'keep'] as const) {
      const mark = ola.client.events.length
      await ola.client.request('session.join', { invite: hosted.invite })
      const confirm = await after(ola.client, mark, 'session', (s) => s.phase === 'confirm-join')
      await ola.client.request('session.leave', { data })
      const [leaving] = sessionsSince(ola.client, mark).filter((s) => s.phase === 'leaving')
      expect(leaving).toEqual(leavingAfter(confirm, data))
      leaves.push(leaving?.leave)
    }
    expect(leaves).toEqual(['delete', 'keep'])
    const room = kai.client.last('session')
    const mark = kai.client.events.length
    await kai.client.request('session.leave', { data: 'save' }) // a host's data choice means nothing
    expect(sessionsSince(kai.client, mark)).toEqual([
      leavingAfter(room, 'keep'),
      expect.objectContaining({ phase: 'idle' }),
    ])
  })

  it("a quit while a save fails as 'incomplete' ends cleanly all the same, and clears the active room", async () => {
    const ren = spawn('Ren', root)
    const una = spawn('Una', root)
    const hosted = await ren.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await ren.client.until('session', (s) => s.phase === 'in-room')
    await una.client.request('session.join', { invite: hosted.invite })
    await una.client.until('session', (s) => s.phase === 'confirm-join')
    await una.client.request('session.confirmJoin', { dir: join(una.dir, 'save') })
    await una.client.until('transfer', (t) => t.progress === 1)
    const transferDir = (await readSessionFile(join(una.dir, 'userData'), hosted.roomId))?.transferDir ?? ''
    rmSync(join(transferDir, 'seg', segmentName(0))) // the save finds it missing: its leave rejects
    // the save is held at its transfer step, so the quit finds it running
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each engine as this
    const leave = TransferEngine.prototype.leave
    const held = vi.spyOn(TransferEngine.prototype, 'leave').mockImplementation(async function (
      this: TransferEngine,
      opts,
    ) {
      await gate
      return leave.call(this, opts)
    })
    try {
      const saving = una.client.requestError('transfer.saveFile', {})
      await vi.waitFor(() => expect(held).toHaveBeenCalled(), { timeout: 30_000 })
      await vi.waitFor(() => expect(marker(una)).toBeNull()) // cleared as the leave started
      writeFileSync(markerPath(una), JSON.stringify({ roomId: hosted.roomId })) // as if that clear had been lost
      const quit = una.manager.shutdown()
      release()
      await expect(quit).resolves.toBeUndefined()
      expect(marker(una)).toBeNull()
      expect(await saving).toBe('incomplete')
    } finally {
      release()
      held.mockRestore()
    }
    await ren.client.request('session.leave', { data: 'keep', end: true })
  })

  it('a save says where the video went to a window that reloaded meanwhile, and keeps other exports out', async () => {
    const hal = spawn('Hal', root)
    const hosted = await hal.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await hal.client.until('session', (s) => s.phase === 'in-room')
    const dir = mkdtempSync(join(root, 'Ivo-'))
    const core = windowless('Ivo', dir, {})
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    try {
      const first = closableWindow(core.rpc)
      await first.client.request('session.join', { invite: hosted.invite })
      await first.client.until('session', (s) => s.phase === 'confirm-join')
      const saveDir = join(dir, 'save')
      await first.client.request('session.confirmJoin', { dir: saveDir })
      await first.client.until('transfer', (t) => t.progress === 1)
      // the save is held halfway (its journal written), so the window can go away meanwhile
      let reached = (): void => undefined
      const atStep = new Promise<void>((r) => (reached = r))
      exportSteps.after = async (s) => {
        if (s !== 'copied:0') return
        reached()
        await gate
      }
      const saving = first.client.request('session.leave', { data: 'save' })
      await atStep
      // its folder is the save's while the leave runs: no Finish saving may export from it meanwhile
      expect(
        await within(
          10_000,
          'finishExport',
          first.client.requestError('transfer.finishExport', { roomId: hosted.roomId }),
        ),
      ).toBe('busy')
      first.close() // a reload
      release()
      await saving
      const second = core.connect()
      const path = join(saveDir, 'mkv-cues.mkv')
      expect(second.all('notice').filter((n) => n.code === 'transfer.export-finished')).toEqual([
        { level: 'info', code: 'transfer.export-finished', message: 'Saved mkv-cues.mkv', path },
      ])
      expect(first.client.all('notice').filter((n) => n.code === 'transfer.export-finished')).toEqual([])
      expect(existsSync(path)).toBe(true)
    } finally {
      exportSteps.after = null
      release()
      await core.manager.shutdown()
    }
    await hal.client.request('session.leave', { data: 'keep', end: true })
  })

  it("cancelling a prepare goes straight back to idle, without 'leaving'", async () => {
    const ada = spawn('Ada', root)
    // hold the prepare at its last step, so the cancel finds it running
    const seeding = vi
      .spyOn(TransferEngine.prototype, 'startHost')
      .mockImplementationOnce(() => new Promise(() => undefined))
    try {
      await ada.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await vi.waitFor(() => expect(seeding).toHaveBeenCalledTimes(1), { timeout: 30_000 })
      const mark = ada.client.events.length
      // HostPrepare's Cancel, and a leave asking for the same (ending the room) on top of it
      await Promise.all([
        ada.client.request('session.cancelPrepare', {}),
        ada.client.request('session.leave', { data: 'keep', end: true }),
      ])
      expect(sessionsSince(ada.client, mark).map((e) => e.phase)).toEqual(['idle'])
    } finally {
      seeding.mockRestore()
    }
  })

  it("a save that finds downloaded data missing fails as 'incomplete', and the room stays resumable", async () => {
    const rex = spawn('Rex', root)
    const tess = spawn('Tess', root)
    const hosted = await rex.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await rex.client.until('session', (s) => s.phase === 'in-room')
    await tess.client.request('session.join', { invite: hosted.invite })
    await tess.client.until('session', (s) => s.phase === 'confirm-join')
    await tess.client.request('session.confirmJoin', { dir: join(tess.dir, 'save') })
    await tess.client.until('transfer', (t) => t.progress === 1)
    const userData = join(tess.dir, 'userData')
    const transferDir = (await readSessionFile(userData, hosted.roomId))?.transferDir ?? ''
    const segment = join(transferDir, 'seg', segmentName(0))

    // e.g. quarantined by an antivirus while the room was open
    rmSync(segment)
    let mark = tess.client.events.length
    expect(await tess.client.requestError('transfer.saveFile', {})).toBe('incomplete')
    expect(sessionsSince(tess.client, mark).map((e) => e.phase)).toEqual(['leaving', 'idle'])
    expect(await new RoomStore(userData).load(hosted.roomId)).not.toBeNull()
    const recent = await tess.client.request('session.recent', {})
    expect(recent.find((r) => r.roomId === hosted.roomId)).toMatchObject({ resumable: true })

    // the rejoin downloads it again; session.leave passes the same failure on
    mark = tess.client.events.length
    await tess.client.request('session.resume', { roomId: hosted.roomId })
    await after(tess.client, mark, 'transfer', (t) => t.progress === 1)
    expect(existsSync(segment)).toBe(true)
    rmSync(segment)
    mark = tess.client.events.length
    expect(await tess.client.requestError('session.leave', { data: 'save' })).toBe('incomplete')
    expect(sessionsSince(tess.client, mark).map((e) => e.phase)).toEqual(['leaving', 'idle'])
    await rex.client.request('session.leave', { data: 'keep', end: true })
  })

  it('a sweep stuck on a dead mount holds Recent rooms and the next room back only for the bound', async () => {
    const dir = mkdtempSync(join(root, 'Kit-'))
    const old = await keptDownload(dir, 8 * DAY)
    let release = (): void => undefined
    const gate = new Promise<void>((r) => (release = r))
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each store as this
    const remove = RoomStore.prototype.remove
    // the sweep deleted the data and hangs on dropping the room's record, as on a mount that went away
    const held = vi.spyOn(RoomStore.prototype, 'remove').mockImplementation(async function (this: RoomStore, id) {
      if (id === old.roomId) await gate
      return remove.call(this, id)
    })
    const bound = 500
    const kit = windowless('Kit', dir, { sweepWaitMs: bound })
    try {
      const client = kit.connect()
      await vi.waitFor(() => expect(held).toHaveBeenCalledWith(old.roomId), { timeout: 30_000 })
      let t0 = performance.now()
      const recent = await within(10 * bound, 'session.recent', client.request('session.recent', {}))
      expect(performance.now() - t0).toBeGreaterThanOrEqual(bound - 50)
      // its data went first: listed, but not offered for resuming
      expect(recent.map((r) => [r.roomId, r.resumable])).toEqual([[old.roomId, false]])

      t0 = performance.now()
      await within(10 * bound, 'session.host', client.request('session.host', { videoPath: video, subtitlePaths: [] }))
      expect(performance.now() - t0).toBeGreaterThanOrEqual(bound - 50)
      await client.until('session', (s) => s.phase === 'in-room')
      await client.request('session.leave', { data: 'keep', end: true })
    } finally {
      release()
      held.mockRestore()
      await kit.manager.shutdown()
    }
  })

  it('a core crash while the host is still preparing resumes the room after the restart', async () => {
    const zoe = spawn('Zoe', root)
    // hold the first prepare at its last step, seeding, long after session.json was first written
    const seeding = vi
      .spyOn(TransferEngine.prototype, 'startHost')
      .mockImplementationOnce(() => new Promise(() => undefined))
    try {
      const hosted = await zoe.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await vi.waitFor(() => expect(seeding).toHaveBeenCalledTimes(1), { timeout: 30_000 })
      expect(zoe.client.last('session')?.phase).toBe('preparing')
      expect(marker(zoe)).toBe(hosted.roomId)
      // the crash: no shutdown, nothing flushed or cleared by a leave
      await kill(zoe)

      const restarted = spawn('Zoe', root, { dir: zoe.dir, resumeActive: true })
      await restarted.manager.started
      expect(restarted.client.all('notice').filter((n) => n.code === 'session.resume-failed')).toEqual([])
      const s = await restarted.client.until('session', (e) => e.phase === 'in-room')
      expect(s.roomId).toBe(hosted.roomId)
      expect(restarted.client.all('session').map((e) => e.phase)).toContain('preparing')
      expect((await restarted.client.request('room.invite', {})).link).toBe(hosted.invite)
      expect(marker(restarted)).toBe(hosted.roomId)
      await restarted.client.request('session.leave', { data: 'keep', end: true })
    } finally {
      seeding.mockRestore()
    }
  })
})
