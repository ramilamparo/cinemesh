import { execFileSync } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CoreEventName, CoreEvents } from '../../../src/shared/ipc/core.js'
import type { Settings } from '../../../src/shared/settings.js'
import { buildManifest, encodeManifest } from '../../../src/shared/media/manifest.js'
import type { ByteRange, MediaIndex } from '../../../src/shared/media/types.js'
import { type BlobProvider, Blobs, blobHash } from '../../../src/core/net/blobs.js'
import { type NetLog, Room } from '../../../src/core/net/room.js'
import { MAX_CRITICAL_SPANS, MAX_MANIFEST_BYTES } from '../../../src/core/session/viewer-session.js'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { buildTorrent, layoutFiles } from '../../../src/core/transfer/torrent-builder.js'
import { type Client, type Member, member } from './harness.js'

// The viewer's join path against a bare host: a plain Room that admits, publishes and serves the torrent
// and manifest blobs only when the test says so. Covers leaving or the room closing at each step of the
// join (viewer-leave-flashes-error, room-closed-overwritten-in-room, viewer-startdownload-no-stop-checks,
// leave-not-reentrant), admission while the host prepares (viewer-admitted-still-pending), JoinConfirm's
// haveBytes with a subtitle piece and with segments gone (havebytes-*), a second Join click and a space
// check that fails after a leave or a close, a manifest with thousands of critical ranges, the upload limit
// changed while the download starts, the host's file-gone notice, an announce the viewer cannot read (a
// newer host, a manifest over the cap), the player's blocked-reader hook, the striping reports to the host
// (and their end), and a failed join staying failed. The slow-disk cases hold a write (or a read) on a named
// pipe.

const MIB = 1024 * 1024
const VIDEO = 3 * MIB + 12_345
// the subtitle adds a piece: the torrent has more pieces than the video alone
const SUB = MIB
const PIECES = Math.ceil((VIDEO + SUB) / MIB)
const quiet: NetLog = { debug: () => undefined, info: () => undefined, warn: () => undefined }

interface Internals {
  settings: Settings
  current: { transfer: { client: { _uploadLimit: number } | null } | null } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

function mediaIndex(fileSize: number): MediaIndex {
  return {
    fileSize,
    container: 'mkv',
    seekMode: 'index',
    interleave: 'good',
    multiSegment: false,
    durationMs: 60_000,
    startMs: 0,
    avgBytesPerSec: Math.round(fileSize / 60),
    keyframes: [
      [0, 4096],
      [30_000, Math.floor(fileSize / 2)],
    ],
    openCritical: [[0, 8192]],
    seekCritical: [],
    tracks: [],
  }
}

class BareHost {
  /** blob reads the viewer asked for (the fetch is in flight once this moves) */
  reads = 0
  private gate: Promise<void> | null = null
  private openGate: (() => void) | null = null
  private readonly blobs = new Map<string, Uint8Array>()
  readonly announce: {
    v: 1
    infoHash: string
    torrent: { hash: string; size: number }
    manifest: { hash: string; size: number }
    name: string
    fileSize: number
    durationMs: number
  }

  private constructor(
    readonly room: Room,
    readonly infoHash: string,
    torrent: Buffer,
    manifest: Uint8Array,
    video: number,
  ) {
    this.blobs.set(blobHash(torrent), torrent)
    this.blobs.set(blobHash(manifest), manifest)
    this.announce = {
      v: 1,
      infoHash,
      torrent: { hash: blobHash(torrent), size: torrent.byteLength },
      manifest: { hash: blobHash(manifest), size: manifest.byteLength },
      name: 'movie.mkv',
      fileSize: video,
      durationMs: 60_000,
    }
    const provider: BlobProvider = {
      read: async (hash, offset, len) => {
        this.reads++
        await this.gate
        const blob = this.blobs.get(hash)
        return blob ? { total: blob.byteLength, data: blob.subarray(offset, offset + len) } : null
      },
    }
    new Blobs(room, provider)
  }

  static async start(
    admission: 'open' | 'approve' = 'open',
    shape: { video?: number; pieceLength?: number; openCritical?: ByteRange[] } = {},
  ): Promise<BareHost> {
    // video + one subtitle, zero piece hashes: nothing is ever downloaded from this host
    const video = shape.video ?? VIDEO
    const pieceLength = shape.pieceLength ?? MIB
    const layout = layoutFiles(['/x/movie.mkv', '/x/movie.srt'], [video, SUB], pieceLength)
    const { torrent, infoHash } = buildTorrent(layout, new Uint8Array(layout.pieceCount * 20))
    const index = mediaIndex(video)
    const manifest = encodeManifest(
      buildManifest(shape.openCritical ? { ...index, openCritical: shape.openCritical } : index, {
        infoHash: Buffer.from(infoHash, 'hex'),
        pieceLength,
        videoFileIndex: 0,
        externalSubs: [{ fileIndex: 1, name: 'movie.srt', lang: '', title: 'movie.srt' }],
      }),
    )
    const room = await Room.create({
      displayName: 'Host',
      settings: { udpPort: null, bootstrapExtra: [], relayKey: null, alwaysRelay: false },
      store: null,
      admission,
      maxMembers: 8,
      name: 'Bare room',
      log: quiet,
    })
    room.defineMessage('session.preparing', { hostOnly: true })
    room.defineMessage('session.unavailable', { hostOnly: true, sticky: true })
    await room.ready()
    return new BareHost(room, infoHash, torrent, manifest, video)
  }

  get invite(): string {
    return this.room.invite().link
  }

  publish(body: Record<string, unknown> = this.announce): void {
    this.room.publish('session.announce', body)
  }

  /** Blob reads wait until release(). */
  hold(): void {
    this.gate = new Promise((resolve) => (this.openGate = resolve))
  }

  release(): void {
    this.openGate?.()
    this.gate = null
  }

  viewerId(): string | undefined {
    return this.room.members().find((m) => !m.self)?.id
  }
}

async function waitFor(check: () => boolean, label: string, ms = 20_000): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** The first event of that kind at or after index `from` matching pred. */
async function next<E extends CoreEventName>(
  c: Client,
  e: E,
  from: number,
  pred: (d: CoreEvents[E]) => boolean = () => true,
  ms = 20_000,
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

function phases(c: Client, from = 0): string[] {
  return c.events
    .slice(from)
    .filter((x) => x.e === 'session')
    .map((x) => (x.d as CoreEvents['session']).phase)
}

/** Player events from a session's player (the manager's idle ones carry mpv's version, null here). */
function sessionPlayers(c: Client, from = 0): CoreEvents['player'][] {
  return c.events
    .slice(from)
    .filter((x) => x.e === 'player' && (x.d as CoreEvents['player']).version === 'fake')
    .map((x) => x.d as CoreEvents['player'])
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wakes whoever is blocked opening the pipe (a writer or a reader), then removes it. */
function unpipe(fifo: string): void {
  for (const flags of [constants.O_RDONLY, constants.O_WRONLY]) {
    try {
      closeSync(openSync(fifo, flags | constants.O_NONBLOCK))
    } catch {
      // no one on the other side, or already gone
    }
  }
  rmSync(fifo, { force: true })
}

/**
 * Reads a named pipe to its end without waiting forever for a writer: opened non-blocking (a writer blocked in
 * its open goes on then), it is read until a writer wrote and closed it, or for `graceMs` while none has it open.
 */
async function drainPipe(fifo: string, graceMs: number): Promise<void> {
  const fd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
  const buf = Buffer.alloc(64 * 1024)
  const t0 = Date.now()
  let wrote = false
  try {
    for (;;) {
      let n = -1
      try {
        n = readSync(fd, buf)
      } catch (e) {
        // a writer has it open and has not written (all) yet
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e
      }
      if (n > 0) {
        wrote = true
        continue
      }
      // 0: nobody has it open for writing: the writer is done, or none came (yet)
      if (n === 0 && (wrote || Date.now() - t0 > graceMs)) return
      await sleep(10)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * meta.torrent as a named pipe: joinAsViewer's writeFile blocks on it until drain(), like a sleeping
 * network drive, so a test can act while the download is starting.
 */
function blockDownloadStart(
  saveDir: string,
  infoHash: string,
): { drain: () => Promise<void>; drainIfWritten: () => Promise<void>; unblock: () => void } {
  const dir = join(saveDir, '.wt-partial', infoHash)
  mkdirSync(dir, { recursive: true })
  const fifo = join(dir, 'meta.torrent')
  execFileSync('mkfifo', [fifo])
  return {
    // reading it all lets the write finish normally
    drain: async () => {
      await readFile(fifo)
    },
    // the same after a leave or a kick, which can stop the join before it writes: then no writer ever comes, and a
    // blocking read would wait for one forever
    drainIfWritten: () => drainPipe(fifo, 5000),
    unblock: () => unpipe(fifo),
  }
}

/** The download start is under way (startDownload's checks passed), so its meta.torrent write is what blocks. */
async function downloadStarting(viewer: Member): Promise<void> {
  const t0 = Date.now()
  while (!internals(viewer).current?.transfer) {
    if (Date.now() - t0 > 10_000) throw new Error('the download did not start')
    await sleep(10)
  }
  await sleep(200) // joinAsViewer's mkdir, then the write
}

describe('viewer join path', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-viewer-join-'))
  const cleanups: (() => Promise<void> | void)[] = []

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn()
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  async function setup(
    admission: 'open' | 'approve' = 'open',
    shape: Parameters<typeof BareHost.start>[1] = {},
  ): Promise<{ host: BareHost; viewer: Member }> {
    const host = await BareHost.start(admission, shape)
    const viewer = member('Sam', root)
    cleanups.push(
      () => host.room.close(),
      () => viewer.manager.shutdown(),
    )
    return { host, viewer }
  }

  async function atConfirm(): Promise<{ host: BareHost; viewer: Member }> {
    const s = await setup()
    s.host.publish()
    await s.viewer.client.request('session.join', { invite: s.host.invite })
    await s.viewer.client.until('session', (e) => e.phase === 'confirm-join')
    return s
  }

  it('an admitted viewer shows connecting with the host prepare progress, not pending-admission', async () => {
    const { host, viewer } = await setup('approve')
    await viewer.client.request('session.join', { invite: host.invite })
    await viewer.client.until('session', (s) => s.phase === 'pending-admission')
    await waitFor(() => host.room.state().pending.length > 0, 'the join request')
    const admittedAt = viewer.client.events.length
    host.room.admit(host.room.state().pending[0]?.id ?? '', true)
    await next(viewer.client, 'session', admittedAt, (s) => s.phase === 'connecting')

    // session.preparing is not sticky: repeat it until the viewer's ctrl lane is up
    const tick = setInterval(() => host.room.publish('session.preparing', { stage: 'hashing', pct: 0.42 }), 200)
    try {
      const p = await next(viewer.client, 'prepare', admittedAt)
      expect(p.bytesDone / p.bytesTotal).toBeCloseTo(0.42)
    } finally {
      clearInterval(tick)
    }
    expect(phases(viewer.client, admittedAt)).not.toContain('pending-admission')
    expect(viewer.client.last('session')?.phase).toBe('connecting')

    // and the join goes on once the host announces
    host.publish()
    await next(viewer.client, 'session', admittedAt, (s) => s.phase === 'confirm-join')
  })

  it('leaving while the torrent and manifest are fetched shows no error and no confirm screen', async () => {
    const { host, viewer } = await setup()
    host.hold()
    host.publish()
    await viewer.client.request('session.join', { invite: host.invite })
    await waitFor(() => host.reads > 0, 'the blob fetch')
    const leftAt = viewer.client.events.length
    // the blobs arrive while the leave says goodbye (it waits ~150 ms before closing the links)
    host.release()
    await viewer.client.request('session.leave', { data: 'keep' })
    await sleep(300)
    const after = phases(viewer.client, leftAt)
    expect(after).not.toContain('error')
    expect(after).not.toContain('confirm-join')
    expect(after.at(-1)).toBe('idle')
  })

  it('leaving at confirm-join shows no error, and two leaves at once both succeed', async () => {
    const { viewer } = await atConfirm()
    const info = viewer.client.last('session')?.joinInfo
    expect(info?.size).toBe(VIDEO + SUB) // the subtitle downloads too
    expect(info?.haveBytes).toBe(0)
    const leftAt = viewer.client.events.length
    // a double click: the manager lets the identical second leave share the first (ViewerSession.leave's own
    // memoization matters once there is something to tear down: viewer-data.test.ts, a second leave while a save)
    await Promise.all([
      viewer.client.request('session.leave', { data: 'keep' }),
      viewer.client.request('session.leave', { data: 'keep' }),
    ])
    expect(phases(viewer.client)).not.toContain('error')
    // one 'leaving' (the second, identical leave shares the first), then idle
    expect(phases(viewer.client, leftAt)).toEqual(['leaving', 'idle'])
    // the session is gone, not half-left
    expect(await viewer.client.requestError('session.confirmJoin', { dir: join(viewer.dir, 'downloads') })).toBe(
      'not-viewer',
    )
  })

  it('the host ending the room at confirm-join ends the session; it never reaches in-room', async () => {
    const { host, viewer } = await atConfirm()
    await host.room.leave({ end: true })
    await viewer.client.until('session', (s) => s.phase === 'ended')
    expect(await viewer.client.requestError('session.confirmJoin', { dir: join(viewer.dir, 'downloads') })).toBe(
      'not-confirming',
    )
    await sleep(500)
    expect(phases(viewer.client)).not.toContain('in-room')
    expect(viewer.client.last('session')?.phase).toBe('ended')
    expect(sessionPlayers(viewer.client)).toEqual([])
    await viewer.client.request('session.leave', { data: 'keep' })
    expect(viewer.client.last('session')?.phase).toBe('idle')
  })

  it.skipIf(process.platform === 'win32')(
    'a kick while the download starts (slow disk) keeps the kick: no player, never in-room',
    async () => {
      const { host, viewer } = await atConfirm()
      const saveDir = join(viewer.dir, 'save')
      const slow = blockDownloadStart(saveDir, host.infoHash)
      cleanups.push(slow.unblock)
      await viewer.client.request('session.confirmJoin', { dir: saveDir })
      await downloadStarting(viewer)
      const id = host.viewerId()
      expect(id).toBeDefined()
      host.room.kick(id ?? '')
      const kicked = await viewer.client.until('session', (s) => s.phase === 'error')
      expect(kicked.error?.code).toBe('kicked')

      await slow.drainIfWritten() // the download start carries on now, under a closed room
      await sleep(1500)
      expect(phases(viewer.client)).not.toContain('in-room')
      expect(viewer.client.last('session')?.error?.code).toBe('kicked')
      expect(sessionPlayers(viewer.client)).toEqual([])
      await viewer.client.request('session.leave', { data: 'delete' })
      expect(viewer.client.last('session')?.phase).toBe('idle')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'leaving while the download starts (slow disk) stops it: nothing happens after idle',
    async () => {
      const { host, viewer } = await atConfirm()
      const saveDir = join(viewer.dir, 'save')
      const slow = blockDownloadStart(saveDir, host.infoHash)
      cleanups.push(slow.unblock)
      await viewer.client.request('session.confirmJoin', { dir: saveDir })
      await downloadStarting(viewer)
      await viewer.client.request('session.leave', { data: 'keep' })
      const idleAt = viewer.client.events.length
      expect(viewer.client.last('session')?.phase).toBe('idle')

      await slow.drainIfWritten()
      await sleep(1500)
      expect(phases(viewer.client, idleAt)).toEqual([])
      expect(sessionPlayers(viewer.client)).toEqual([])
      expect(viewer.client.events.slice(idleAt).map((x) => x.e)).not.toContain('timeline')
      // the manager is free for the next room
      await viewer.client.request('session.join', { invite: host.invite })
      await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'leaving while the session file is written (slow disk) stops the join before the player',
    async () => {
      const { viewer } = await atConfirm()
      // the session file write is the last await before the player and sync start: hold it
      const roomId = viewer.client.last('session')?.roomId ?? ''
      const sessionTmp = join(viewer.dir, 'userData', 'wt', 'rooms', roomId, 'session.json.tmp')
      execFileSync('mkfifo', [sessionTmp])
      cleanups.push(() => unpipe(sessionTmp))
      await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
      await sleep(1000) // joinAsViewer and the stream server are done by now
      const leftAt = viewer.client.events.length
      const leaving = viewer.client.request('session.leave', { data: 'keep' })
      await sleep(500) // past the goodbye; the leave's own session-file write queues behind the held one
      unpipe(sessionTmp)
      await leaving
      await sleep(500)
      expect(phases(viewer.client, leftAt)).toEqual(['leaving', 'idle'])
      expect(phases(viewer.client)).not.toContain('in-room')
      expect(sessionPlayers(viewer.client)).toEqual([])
    },
  )

  /** A journal from an earlier visit to the default folder claiming `pieces`, with seg/000000.part `segBytes` long. */
  function earlierVisit(viewer: Member, host: BareHost, pieces: number[], segBytes: number): void {
    const bits = new Uint8Array(Math.ceil(PIECES / 8))
    for (const i of pieces) bits[i >> 3] = (bits[i >> 3] ?? 0) | (0x80 >> (i & 7))
    const dir = join(viewer.dir, 'downloads', '.wt-partial', host.infoHash)
    mkdirSync(join(dir, 'seg'), { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        v: 1,
        infoHash: host.infoHash,
        pieceCount: PIECES,
        bitfield: Buffer.from(bits).toString('base64'),
        savedAt: Date.now(),
      }),
    )
    writeFileSync(join(dir, 'seg', '000000.part'), '')
    truncateSync(join(dir, 'seg', '000000.part'), segBytes) // sparse: only the length matters
  }

  it('JoinConfirm counts exactly what the folder already holds, the subtitle piece included', async () => {
    const { host, viewer } = await setup()
    expect(PIECES).toBeGreaterThan(Math.ceil(VIDEO / MIB))
    // the first piece and the short last one, all of whose bytes are in the segment file
    const last = PIECES - 1
    earlierVisit(viewer, host, [0, last], VIDEO + SUB)
    host.publish()
    await viewer.client.request('session.join', { invite: host.invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    expect(confirm.joinInfo?.size).toBe(VIDEO + SUB)
    expect(confirm.joinInfo?.haveBytes).toBe(MIB + (VIDEO + SUB - last * MIB))
  })

  it('JoinConfirm does not count what the journal claims but the segment files no longer hold', async () => {
    const { host, viewer } = await setup()
    // every piece claimed, but the segment was cut short after two pieces (a cleaner, a full disk)
    earlierVisit(
      viewer,
      host,
      Array.from({ length: PIECES }, (_, i) => i),
      2 * MIB + 100,
    )
    host.publish()
    await viewer.client.request('session.join', { invite: host.invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    expect(confirm.joinInfo?.haveBytes).toBe(2 * MIB)
    await viewer.client.request('session.leave', { data: 'keep' })

    // seg/ deleted: state.json alone counts for nothing
    rmSync(join(viewer.dir, 'downloads', '.wt-partial', host.infoHash, 'seg'), { recursive: true })
    const again = viewer.client.events.length
    await viewer.client.request('session.join', { invite: host.invite })
    const second = await next(viewer.client, 'session', again, (s) => s.phase === 'confirm-join')
    expect(second.joinInfo?.haveBytes).toBe(0)
  })

  it('accepts a manifest with thousands of critical ranges; the scheduler gets a few piece spans', async () => {
    // 1,500 sidx-like ranges, one in every other 16 KiB piece of a 64 MiB video: the round-1 cap refused it
    const P = 16 * 1024
    const ranges = Array.from({ length: 1500 }, (_, i): ByteRange => [2 * i * P + 100, 2 * i * P + 200])
    const spy = vi.spyOn(TransferEngine.prototype, 'setCriticalRanges')
    cleanups.push(() => spy.mockRestore())
    const { host, viewer } = await setup('open', { video: 4096 * P, pieceLength: P, openCritical: ranges })
    host.publish()
    await viewer.client.request('session.join', { invite: host.invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    expect(phases(viewer.client)).not.toContain('error')

    const spans = spy.mock.calls.at(-1)?.[0] ?? []
    expect(spans.length).toBeGreaterThan(0)
    expect(spans.length).toBeLessThanOrEqual(MAX_CRITICAL_SPANS)
    // whole pieces, and every range (the subtitle file too) inside one of them
    for (const [s, e] of spans) expect(s % P === 0 && (e % P === 0 || e === 4096 * P + SUB)).toBe(true)
    const covered = (s: number, e: number): boolean => spans.some(([a, b]) => a <= s && e <= b)
    expect(ranges.filter(([s, e]) => !covered(s, e))).toEqual([])
    expect(covered(4096 * P, 4096 * P + SUB)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'a second Join click while the download starts is the same join; another folder is busy',
    async () => {
      const { host, viewer } = await atConfirm()
      const saveDir = join(viewer.dir, 'save')
      const slow = blockDownloadStart(saveDir, host.infoHash)
      cleanups.push(slow.unblock)
      await viewer.client.request('session.confirmJoin', { dir: saveDir })
      // JoinConfirm is still up (the download start is held), and Join is enabled again
      expect(viewer.client.last('session')?.phase).toBe('confirm-join')
      await viewer.client.request('session.confirmJoin', { dir: saveDir })
      expect(await viewer.client.requestError('session.confirmJoin', { dir: join(viewer.dir, 'other') })).toBe('busy')

      await slow.drain()
      await viewer.client.until('session', (s) => s.phase === 'in-room')
      expect(phases(viewer.client)).not.toContain('error')
      await viewer.client.request('session.leave', { data: 'delete' })
    },
  )

  /**
   * confirmJoin held on its journal read (state.json is a named pipe in the folder it checks), then the
   * folder made unusable so the space check throws (ENOTDIR) once the read is let go.
   */
  function holdSpaceCheck(host: BareHost, base: string): { dir: string; failAndRelease: () => void } {
    const dir = join(base, 'x', 'y')
    const transferDir = join(dir, '.wt-partial', host.infoHash)
    mkdirSync(transferDir, { recursive: true })
    execFileSync('mkfifo', [join(transferDir, 'state.json')])
    const moved = join(base, 'x-moved')
    cleanups.push(() => unpipe(join(moved, 'y', '.wt-partial', host.infoHash, 'state.json')))
    return {
      dir,
      failAndRelease: () => {
        renameSync(join(base, 'x'), moved)
        writeFileSync(join(base, 'x'), '') // statfs(<base>/x/y): ENOTDIR
        unpipe(join(moved, 'y', '.wt-partial', host.infoHash, 'state.json'))
      },
    }
  }

  it.skipIf(process.platform === 'win32')(
    'a space check that fails after a leave took the confirmation away shows no error',
    async () => {
      const { host, viewer } = await atConfirm()
      const held = holdSpaceCheck(host, join(viewer.dir, 'pick'))
      const confirming = viewer.client.request('session.confirmJoin', { dir: held.dir })
      await sleep(300) // blocked reading the journal
      await viewer.client.request('session.leave', { data: 'keep' })
      expect(viewer.client.last('session')?.phase).toBe('idle')
      held.failAndRelease()
      await confirming // resolves: the leave said everything there was to say
      expect(phases(viewer.client)).not.toContain('error')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'a space check that fails after the host ended the room shows no error over the ended screen',
    async () => {
      const { host, viewer } = await atConfirm()
      const held = holdSpaceCheck(host, join(viewer.dir, 'pick'))
      const confirming = viewer.client.request('session.confirmJoin', { dir: held.dir })
      await sleep(300)
      await host.room.leave({ end: true })
      await viewer.client.until('session', (s) => s.phase === 'ended')
      held.failAndRelease()
      await confirming
      expect(viewer.client.last('session')?.phase).toBe('ended')
      await viewer.client.request('session.leave', { data: 'keep' })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'an upload limit changed while the download starts applies to the download',
    async () => {
      // an engine that drops a limit set before its client exists, as it did in round 1: the session must
      // not rely on the engine keeping it
      const spy = vi.spyOn(TransferEngine.prototype, 'setUploadLimit').mockImplementation(function (
        this: TransferEngine,
        kbps: number | null,
      ) {
        const client = (this as unknown as { client: { throttleUpload(rate: number): void } | null }).client
        client?.throttleUpload(kbps ? kbps * 1024 : -1)
      })
      cleanups.push(() => spy.mockRestore())
      const { host, viewer } = await atConfirm()
      const saveDir = join(viewer.dir, 'save')
      const slow = blockDownloadStart(saveDir, host.infoHash)
      cleanups.push(slow.unblock)
      await viewer.client.request('session.confirmJoin', { dir: saveDir })
      // Settings, while joinAsViewer is held before it creates the WebTorrent client
      viewer.manager.updateSettings({ ...internals(viewer).settings, uploadLimitKBps: 123 })
      await slow.drain()
      await viewer.client.until('session', (s) => s.phase === 'in-room')
      expect(internals(viewer).current?.transfer?.client?._uploadLimit).toBe(123 * 1024)
      await viewer.client.request('session.leave', { data: 'delete' })
    },
  )

  it("the host's file-gone message is one notice, also for a viewer who joins after it", async () => {
    const { host, viewer } = await setup()
    host.publish()
    host.room.publish('session.unavailable', { reason: 'source-changed' }) // sticky: replayed on admission
    await viewer.client.request('session.join', { invite: host.invite })
    await viewer.client.until('notice', (n) => n.code === 'session.host-file-gone')
    host.room.publish('session.unavailable', { reason: 'source-changed' })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join') // the join itself goes on
    await sleep(300)
    expect(viewer.client.all('notice').filter((n) => n.code === 'session.host-file-gone')).toHaveLength(1)
  })

  it('an announce from a newer host fails the join with update-required instead of Connecting… forever', async () => {
    const { host, viewer } = await setup()
    host.publish({ ...host.announce, v: 2, newField: true })
    await viewer.client.request('session.join', { invite: host.invite })
    const failed = await viewer.client.until('session', (s) => s.phase === 'error')
    expect(failed.error).toEqual({
      code: 'update-required',
      message: 'The host uses a newer version of Watch Together. Update the app to join.',
    })
    expect(phases(viewer.client)).not.toContain('confirm-join')
    expect(host.reads).toBe(0) // nothing was fetched for it

    // the join was about that announce: a readable one later is another video, not a second join
    const failedAt = viewer.client.events.length
    host.publish()
    await next(viewer.client, 'notice', failedAt, (n) => n.code === 'session.changed')
    await sleep(500)
    expect(phases(viewer.client, failedAt)).toEqual([])
    expect(viewer.client.last('session')?.error?.code).toBe('update-required')
    expect(host.reads).toBe(0)
    await viewer.client.request('session.leave', { data: 'keep' })
    expect(viewer.client.last('session')?.phase).toBe('idle')
  })

  it('an announce with a manifest over the cap fails the join as bad-session, once', async () => {
    const { host, viewer } = await setup()
    const huge = { ...host.announce, manifest: { ...host.announce.manifest, size: MAX_MANIFEST_BYTES + 1 } }
    host.publish(huge)
    await viewer.client.request('session.join', { invite: host.invite })
    const failed = await viewer.client.until('session', (s) => s.phase === 'error')
    expect(failed.error?.code).toBe('bad-session')
    expect(failed.error?.message).toMatch(/\(manifest\.size\)/)
    // the sticky announce sent again (the host's link reconnecting replays it the same way)
    const failedAt = viewer.client.events.length
    host.publish({ ...huge, name: 'other.mkv' })
    await sleep(800)
    expect(phases(viewer.client, failedAt)).toEqual([])
    expect(viewer.client.all('notice').map((n) => n.code)).not.toContain('session.changed')
    expect(host.reads).toBe(0)
  })

  it('tells the player when its reader waits on a piece (readerBlocked), and when it stops waiting', async () => {
    const { viewer } = await atConfirm()
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    const session = internals(viewer).current as unknown as {
      readerBlocked(): boolean
      server: { url(fileIndex: number): string }
    }
    expect(session.readerBlocked()).toBe(false)
    // the bare host serves no pieces: a read of the video waits on piece 0, as mpv's demuxer would
    const reading = new AbortController()
    const read = fetch(session.server.url(0), { signal: reading.signal })
      .then((r) => r.arrayBuffer())
      .catch(() => null)
    await waitFor(() => session.readerBlocked(), 'a blocked reader')
    reading.abort()
    expect(await read).toBeNull()
    await waitFor(() => !session.readerBlocked(), 'the reader to go')
    await viewer.client.request('session.leave', { data: 'delete' })
  })

  it("the host's file-gone notice promises nothing to a viewer waiting for a full download", async () => {
    // open-critical is the whole video, as for an fMP4 without sidx: it plays only once complete
    const { host, viewer } = await setup('open', { openCritical: [[0, VIDEO]] })
    host.publish()
    await viewer.client.request('session.join', { invite: host.invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    expect(confirm.media).toEqual({ container: 'mkv', seekMode: 'index', fullDownload: true, interleave: 'good' })
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    await viewer.client.until('notice', (n) => n.code === 'session.full-download')
    host.room.publish('session.unavailable', { reason: 'source-changed' })
    const gone = await viewer.client.until('notice', (n) => n.code === 'session.host-file-gone')
    expect(gone.message).toBe(
      "The host's video file changed, so the host stopped sharing it. This video plays only once fully downloaded, and only other viewers can send the rest now.",
    )
    await viewer.client.request('session.leave', { data: 'delete' })
  })

  /** The viewer's transfer.links reports (room.publish calls from its own room), from here on. */
  function linkReports(viewer: Member): () => [name: string, body: unknown, opts: unknown][] {
    const publish = vi.spyOn(Room.prototype, 'publish')
    cleanups.push(() => publish.mockRestore())
    const room = (internals(viewer).current as unknown as { room: Room }).room
    return () =>
      publish.mock.calls.filter((c, i) => publish.mock.contexts[i] === room && c[0] === 'transfer.links') as [
        string,
        unknown,
        unknown,
      ][]
  }

  it('reports its bt lanes and blocked reads to the host for striping, and stops once kicked', async () => {
    const { host, viewer } = await atConfirm()
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    const reports = linkReports(viewer)
    await waitFor(() => reports().length >= 2, 'two reports (1 Hz)', 5000)
    expect(reports().at(-1)?.[1]).toEqual({ v: 1, linked: [], urgent: [] })
    expect(reports().at(-1)?.[2]).toEqual({ to: host.room.self })
    // a read waiting on piece 0 (the bare host serves none) goes out at once, not at the next tick
    const server = (internals(viewer).current as unknown as { server: { url(i: number): string } }).server
    const reading = new AbortController()
    const read = fetch(server.url(0), { signal: reading.signal })
      .then((r) => r.arrayBuffer())
      .catch(() => null)
    await waitFor(() => reports().some(([, body]) => (body as { urgent: number[] }).urgent.includes(0)), 'urgent 0')
    reading.abort()
    await read

    host.room.kick(host.viewerId() ?? '')
    await viewer.client.until('session', (s) => s.phase === 'error')
    const kickedAt = reports().length
    await sleep(2500)
    expect(reports().length).toBe(kickedAt)
    await viewer.client.request('session.leave', { data: 'delete' })
  })

  it('stops reporting its bt lanes to the host when it leaves', async () => {
    const { viewer } = await atConfirm()
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')
    const reports = linkReports(viewer)
    await waitFor(() => reports().length >= 1, 'a report', 5000)
    await viewer.client.request('session.leave', { data: 'keep' })
    const leftAt = reports().length
    await sleep(2500)
    expect(reports().length).toBe(leftAt)
  })

  it('a failed join stays failed while the room keeps sending state', async () => {
    const { host, viewer } = await setup()
    host.publish({ ...host.announce, fileSize: VIDEO + 1 }) // disagrees with the torrent and the manifest
    await viewer.client.request('session.join', { invite: host.invite })
    const failed = await viewer.client.until('session', (s) => s.phase === 'error')
    expect(failed.error?.code).toBe('bad-session')
    const failedAt = viewer.client.events.length
    // a room.state re-send makes the viewer's room emit 'state' (phase in-room) again; its 'room' event shows it
    host.room.setMaxMembers(6)
    await next(viewer.client, 'room', failedAt, (r) => r.maxMembers === 6)
    await sleep(300)
    expect(phases(viewer.client, failedAt)).toEqual([])
    expect(viewer.client.last('session')?.error?.code).toBe('bad-session')
  })
})
