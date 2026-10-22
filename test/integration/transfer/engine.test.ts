import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import parseTorrent from 'parse-torrent'
import Protomux from 'protomux'
import WebTorrent, { type Wire } from 'webtorrent'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { prepareHost } from '../../../src/core/transfer/host-prepare.js'
import { Journal } from '../../../src/core/transfer/journal.js'
import { BT_PROTOCOL, MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'
import type { Scheduler } from '../../../src/core/transfer/scheduler.js'
import { segmentName } from '../../../src/core/transfer/segment-store.js'
import { SourceFiles } from '../../../src/core/transfer/source-files.js'

const dir = mkdtempSync(join(tmpdir(), 'wt-engine-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const P = 256 * 1024
const video = randomBytes(24 * P + 999)
const sub = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')
writeFileSync(join(dir, 'film.mkv'), video)
writeFileSync(join(dir, 'film.srt'), sub)

function link(): { hostMux: Protomux; viewerMux: Protomux; close(): void } {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  return {
    hostMux: Protomux.from(a),
    viewerMux: Protomux.from(b),
    close() {
      a.destroy()
      b.destroy()
    },
  }
}

const HOST_KEY = Buffer.alloc(32, 0xaa)
const VIEWER_KEY = Buffer.alloc(32, 0xbb)

async function hostWith(): Promise<{ host: TransferEngine; torrent: Buffer }> {
  const prepared = await prepareHost({
    videoPath: join(dir, 'film.mkv'),
    subtitlePaths: [join(dir, 'film.srt')],
    cacheRoot: join(dir, 'cache'),
    pieceLength: P,
  })
  const host = new TransferEngine()
  await host.startHost(prepared, { uploadLimitKBps: null })
  return { host, torrent: prepared.torrent }
}

describe('TransferEngine', () => {
  it('downloads after a seek, journals progress, resumes, and saves the file', async () => {
    const { host, torrent } = await hostWith()
    const net = link()
    const viewerDir = join(dir, 'transfer-a')

    // first viewer session: seek to 50 %, stop after a few pieces
    const v1 = new TransferEngine()
    await v1.joinAsViewer({ torrent, dir: viewerDir, uploadLimitKBps: null })
    host.attach({ id: 'viewer', publicKey: VIEWER_KEY, mux: net.hostMux })
    v1.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
    const first: number[] = []
    await new Promise<void>((resolve) => {
      v1.on('verified', (i) => {
        first.push(i)
        if (first.length === 4) resolve()
      })
      v1.setPlayhead({ byte: 12 * P, windowBytes: 4 * P, hotBytes: 2 * P, seek: true })
    })
    expect(Math.min(...first)).toBeGreaterThanOrEqual(12) // R6: from the playhead, not from 0
    await v1.leave({ data: 'keep' })
    net.close()
    expect(existsSync(join(viewerDir, 'state.json'))).toBe(true)

    // second session resumes from the journal and finishes
    const net2 = link()
    host.detach('viewer')
    host.attach({ id: 'viewer', publicKey: VIEWER_KEY, mux: net2.hostMux })
    const v2 = new TransferEngine()
    const { resumedPieces } = await v2.joinAsViewer({ torrent, dir: viewerDir, uploadLimitKBps: null })
    expect(resumedPieces).toBeGreaterThanOrEqual(1)
    v2.attach({ id: 'host', publicKey: HOST_KEY, mux: net2.viewerMux })
    const done = new Promise<void>((resolve) => v2.once('done', () => resolve()))
    v2.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
    await done
    const states = v2.pieceStates()
    expect([...states].every((s) => s === 2)).toBe(true)

    const saved = await v2.leave({ data: 'save', saveDir: join(dir, 'saved') })
    expect(saved).not.toBeNull()
    expect(readFileSync(saved?.video ?? '').equals(video)).toBe(true)
    expect(readFileSync(saved?.subtitles[0] ?? '').equals(sub)).toBe(true)
    expect(existsSync(viewerDir)).toBe(false) // consumed and removed

    await host.destroy()
    net2.close()
  })

  it('reports host stats with a dupFactor and deletes viewer data on request', async () => {
    const { host, torrent } = await hostWith()
    const net = link()
    const viewerDir = join(dir, 'transfer-b')
    const v = new TransferEngine()
    await v.joinAsViewer({ torrent, dir: viewerDir, uploadLimitKBps: null })
    host.attach({ id: 'viewer', publicKey: VIEWER_KEY, mux: net.hostMux })
    v.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
    const done = new Promise<void>((resolve) => v.once('done', () => resolve()))
    v.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
    await done
    const stats = await new Promise<import('../../../src/core/transfer/engine.js').TransferStats>((resolve) =>
      host.once('stats', resolve),
    )
    expect(stats.dupFactor).toBeCloseTo(1, 1)
    expect(stats.peers[0]?.id).toBe('viewer')
    await v.leave({ data: 'delete' })
    expect(existsSync(viewerDir)).toBe(false)
    await host.destroy()
    net.close()
  })
})

/** Flips a byte of a piece inside segment 0 (the whole test torrent fits in it): same size, wrong hash. */
function corruptPiece(viewerDir: string, piece: number): void {
  const fd = openSync(join(viewerDir, 'seg', segmentName(0)), 'r+')
  writeSync(fd, Buffer.from([(video[piece * P + 7] ?? 0) ^ 0xff]), 0, 1, piece * P + 7)
  closeSync(fd)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function downloadAll(host: TransferEngine, v: TransferEngine, net: ReturnType<typeof link>): Promise<void> {
  host.attach({ id: 'viewer', publicKey: VIEWER_KEY, mux: net.hostMux })
  v.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
  const done = new Promise<void>((resolve) => v.once('done', () => resolve()))
  v.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
  await done
}

describe('TransferEngine resume', () => {
  it('re-hashes dirty segments, keeps pieces WebTorrent found bad out of the journal, emits done on a complete resume, and saves after a torrent error', async () => {
    const { host, torrent } = await hostWith()
    const { infoHash, pieces } = await parseTorrent(torrent)
    const total = pieces.length
    const viewerDir = join(dir, 'transfer-resume')
    const journalHas = async (i: number): Promise<boolean> =>
      (await Journal.open(join(viewerDir, 'state.json'), infoHash, total)).has(i)
    const session = async (online: boolean): Promise<{ v: TransferEngine; resumed: number }> => {
      const v = new TransferEngine()
      const { resumedPieces } = await v.joinAsViewer({ torrent, dir: viewerDir, uploadLimitKBps: null })
      if (online) {
        const net = link()
        await downloadAll(host, v, net)
        await v.leave({ data: 'keep' })
        host.detach('viewer')
        net.close()
      }
      return { v, resumed: resumedPieces }
    }

    // 1: a full download; the journal lists the last pieces verified in its (only) segment
    await session(true)
    const { recent } = JSON.parse(readFileSync(join(viewerDir, 'state.json'), 'utf8')) as { recent: number[] }
    expect(recent.length).toBeGreaterThanOrEqual(1)
    expect(recent.length).toBeLessThanOrEqual(2)
    expect(recent).not.toContain(1) // downloaded in order from piece 0: piece 1 is long done

    // offline: one of those last writes was lost (acknowledged by the disk, never stored). WebTorrent alone
    // would trust it: it probes one piece per file, and the last piece here is the subtitle's probe.
    const lost = recent.find((i) => i !== total - 1) ?? -1
    expect(lost).toBeGreaterThan(1)
    corruptPiece(viewerDir, lost)
    // 2: re-hashed on resume, so it is downloaded again
    expect((await session(true)).resumed).toBe(total - 1)
    expect(await journalHas(lost)).toBe(true)

    // offline: piece 1 (WebTorrent's own probe for file 0, not recent) went bad
    corruptPiece(viewerDir, 1)
    // 3: WebTorrent finds it; the journal must stop claiming it for the next resume
    const third = await session(false)
    expect(third.resumed).toBe(total - 1)
    await third.v.leave({ data: 'keep' })
    expect(await journalHas(1)).toBe(false)
    // 4: so it is simply missing, and comes again
    expect((await session(true)).resumed).toBe(total - 1)

    // 5: a complete resume emits 'done', also to a listener added once joinAsViewer resolved
    const { v: v5, resumed } = await session(false)
    expect(resumed).toBe(total)
    let dones = 0
    v5.on('done', () => dones++)
    await sleep(50)
    expect(dones).toBe(1)

    // a torrent error (e.g. EIO from the store) reaches the listener; WebTorrent then empties torrent.files,
    // but the file list captured at ready still lets the user save
    const errors: string[] = []
    v5.on('error', (e) => errors.push(e.message))
    ;(v5 as unknown as { torrent: { _destroy(err: Error): void } }).torrent._destroy(new Error('disk gone'))
    expect(errors).toEqual(['disk gone'])
    const saved = await v5.leave({ data: 'save', saveDir: join(dir, 'saved-resume') })
    expect(readFileSync(saved?.video ?? '').equals(video)).toBe(true)
    expect(readFileSync(saved?.subtitles[0] ?? '').equals(sub)).toBe(true)
    expect(existsSync(viewerDir)).toBe(false)
    await host.destroy()
  })

  it("a segment lost after the join fails leave({ data: 'save' }) before anything is consumed, and the journal forgets its pieces", async () => {
    const { host, torrent } = await hostWith()
    const { infoHash, pieces } = await parseTorrent(torrent)
    const viewerDir = join(dir, 'transfer-lost-segment')
    const net = link()
    const v = new TransferEngine()
    await v.joinAsViewer({ torrent, dir: viewerDir, uploadLimitKBps: null })
    await downloadAll(host, v, net)
    rmSync(join(viewerDir, 'seg', segmentName(0))) // e.g. quarantined: WebTorrent still counts every piece
    await expect(v.leave({ data: 'save', saveDir: join(dir, 'saved-lost') })).rejects.toMatchObject({
      code: 'incomplete',
    })
    expect(existsSync(join(viewerDir, 'state.json'))).toBe(true) // kept for a later session
    expect((await Journal.open(join(viewerDir, 'state.json'), infoHash, pieces.length)).count()).toBe(0)
    expect(existsSync(join(dir, 'saved-lost'))).toBe(false)
    await host.destroy()
    net.close()
  })

  it("leave({ data: 'delete' }) during joinAsViewer cancels the start and still removes the folder", async () => {
    const { host, torrent } = await hostWith()
    const viewerDir = join(dir, 'transfer-early-delete')
    const v = new TransferEngine()
    const join_ = v.joinAsViewer({ torrent, dir: viewerDir, uploadLimitKBps: null })
    const left = v.leave({ data: 'delete' })
    await expect(join_).rejects.toMatchObject({ code: 'cancelled' })
    await left
    expect(existsSync(viewerDir)).toBe(false)
    expect(v.leave({ data: 'keep' })).toBe(left) // idempotent: the first call's options win
    await host.destroy()
  })

  it('destroy() during startHost cancels it before any WebTorrent client exists', async () => {
    const prepared = await prepareHost({
      videoPath: join(dir, 'film.mkv'),
      subtitlePaths: [join(dir, 'film.srt')],
      cacheRoot: join(dir, 'cache'),
      pieceLength: P,
    })
    const host = new TransferEngine()
    const start = host.startHost(prepared, { uploadLimitKBps: null })
    const stopped = host.destroy()
    await expect(start).rejects.toMatchObject({ code: 'cancelled' })
    await stopped
    expect((host as unknown as { client: unknown }).client).toBeNull()
  })

  it('pauses downloading while writes lag or the disk is low, and resumes only once both clear', async () => {
    const { host, torrent } = await hostWith()
    const v = new TransferEngine()
    await v.joinAsViewer({ torrent, dir: join(dir, 'transfer-pause'), uploadLimitKBps: null })
    const internal = v as unknown as {
      scheduler: Scheduler
      segments: { opts: { onWriteLag(lagging: boolean): void } }
      setDiskLow(low: boolean): void
    }
    v.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
    const planned = (): number => internal.scheduler.plan().length
    expect(planned()).toBeGreaterThan(0)
    internal.segments.opts.onWriteLag(true)
    expect(planned()).toBe(0)
    internal.setDiskLow(true)
    internal.segments.opts.onWriteLag(false)
    expect(planned()).toBe(0) // still out of disk space
    internal.setDiskLow(false)
    expect(planned()).toBeGreaterThan(0)
    await v.leave({ data: 'delete' })
    await host.destroy()
  })
})

describe('TransferEngine host source watchdog', () => {
  async function hostOfCopy(
    name: string,
    opts: { subtitle?: boolean } = {},
  ): Promise<{ host: TransferEngine; path: string; subPath: string }> {
    const path = join(dir, `${name}.mkv`)
    const subPath = join(dir, `${name}.srt`)
    copyFileSync(join(dir, 'film.mkv'), path)
    if (opts.subtitle) copyFileSync(join(dir, 'film.srt'), subPath)
    const prepared = await prepareHost({
      videoPath: path,
      subtitlePaths: opts.subtitle ? [subPath] : [],
      cacheRoot: join(dir, 'cache'),
      pieceLength: P,
    })
    const host = new TransferEngine()
    await host.startHost(prepared, { uploadLimitKBps: null })
    return { host, path, subPath }
  }
  const check = (host: TransferEngine): Promise<void> =>
    (host as unknown as { checkSource(): Promise<void> }).checkSource()

  it('reports a move once and a content change once, then stops seeding for good', async () => {
    const { host, path } = await hostOfCopy('watched')
    const kinds: string[] = []
    host.on('source-changed', (c) => kinds.push(c.kind))
    const moved = `${path}.moved`
    renameSync(path, moved)
    await check(host)
    await check(host)
    expect(kinds).toEqual(['moved'])
    appendFileSync(moved, 'edited')
    await check(host)
    await check(host)
    expect(kinds).toEqual(['moved', 'changed'])
    const internal = host as unknown as { torrent: { destroyed: boolean }; attached: Map<string, unknown> }
    expect(internal.torrent.destroyed).toBe(true)
    const net = link()
    host.attach({ id: 'late-joiner', publicKey: VIEWER_KEY, mux: net.hostMux })
    expect(internal.attached.size).toBe(0) // nobody is served the changed bytes
    await host.destroy()
    net.close()
  })

  it('still reports a subtitle edited in place after the video moved, and stops seeding', async () => {
    const { host, path, subPath } = await hostOfCopy('moved-then-edited', { subtitle: true })
    const kinds: string[] = []
    host.on('source-changed', (c) => kinds.push(`${c.kind}@${String(c.index)}`))
    renameSync(path, `${path}.renamed`)
    await check(host)
    expect(kinds).toEqual(['moved@0'])
    // an editor saving in place: same inode and length, new bytes (and a new mtime)
    writeFileSync(subPath, Buffer.from(sub.toString().replace('hi', 'yo')))
    utimesSync(subPath, new Date(), new Date(Date.now() + 5000))
    await check(host)
    expect(kinds).toEqual(['moved@0', 'changed@1'])
    const internal = host as unknown as { torrent: { destroyed: boolean } }
    expect(internal.torrent.destroyed).toBe(true) // the last piece no longer matches its hash: never served again
    await host.destroy()
  })

  it('reports nothing for a check that finishes after the engine was destroyed', async () => {
    const { host, path } = await hostOfCopy('leaving')
    const kinds: string[] = []
    host.on('source-changed', (c) => kinds.push(c.kind))
    appendFileSync(path, 'edited')
    const pending = check(host)
    await host.destroy()
    await pending
    expect(kinds).toEqual([])
  })
})

describe('TransferEngine wires', () => {
  type Internals = {
    torrent: { wires: { peerExtendedHandshake: { reqq?: number; m?: unknown } }[] }
    attached: Map<string, { stream: { destroy(): void } | null }>
    stats(): import('../../../src/core/transfer/engine.js').TransferStats
    client: { _uploadLimit: number } | null
    uploadScheduler: { stats(): { rateBps: number | null } } | null
  }
  const inside = (e: TransferEngine): Internals => e as unknown as Internals
  async function connected(
    name: string,
  ): Promise<{ host: TransferEngine; v: TransferEngine; net: ReturnType<typeof link> }> {
    const { host, torrent } = await hostWith()
    const net = link()
    const v = new TransferEngine()
    await v.joinAsViewer({ torrent, dir: join(dir, name), uploadLimitKBps: null })
    host.attach({ id: 'viewer', publicKey: VIEWER_KEY, mux: net.hostMux })
    v.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
    await new Promise<void>((resolve) => {
      v.once('verified', () => resolve())
      v.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
    })
    return { host, v, net }
  }
  const until = async (ok: () => boolean, ms: number): Promise<void> => {
    const end = Date.now() + ms
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out')
      await sleep(50)
    }
  }

  it('advertises reqq 256 in the extended handshake, host and viewer alike (S2: bounds the uploader’s RAM)', async () => {
    const { host, v, net } = await connected('transfer-reqq')
    const handshake = (e: TransferEngine): { reqq?: number; m?: unknown } | undefined =>
      inside(e).torrent.wires[0]?.peerExtendedHandshake
    const peerSaw = (e: TransferEngine): number | undefined => handshake(e)?.reqq
    await until(() => handshake(v)?.m !== undefined && handshake(host)?.m !== undefined, 5000) // both arrived
    expect(peerSaw(v)).toBe(256) // what the host sent the viewer
    expect(peerSaw(host)).toBe(256) // what the viewer sent the host
    await v.leave({ data: 'delete' })
    await host.destroy()
    net.close()
  })

  it('counts re-attaches per peer, so a lane that keeps dropping shows in the stats', async () => {
    const { host, v, net } = await connected('transfer-reattach')
    const row = (): { reattaches?: number } | undefined =>
      inside(host)
        .stats()
        .peers.find((p) => p.id === 'viewer')
    expect(row()?.reattaches).toBe(0)
    inside(host).attached.get('viewer')?.stream?.destroy() // the lane drops; both sides re-open after 1 s
    await until(() => row()?.reattaches === 1, 6000)
    await v.leave({ data: 'delete' })
    await host.destroy()
    net.close()
  })

  it('stripes viewers whose lanes opened while the host was still starting (hooks precede every handshake)', async () => {
    const prepared = await prepareHost({
      videoPath: join(dir, 'film.mkv'),
      subtitlePaths: [join(dir, 'film.srt')],
      cacheRoot: join(dir, 'cache'),
      pieceLength: P,
    })
    const last = Math.ceil((video.length + sub.length) / P) - 1 // the video's tail and the subtitle
    const host = new TransferEngine()
    // all that a host session may publish before startHost resolves: replayed into the Revealer at 'ready'
    host.setGroupCriticalRanges([
      [0, P],
      [last * P, last * P + 1],
    ])
    // L1 of 2 pieces: piece i is due in 12.5 i s, so no rescue can blur the assignments
    host.setGroupPlayhead({ byte: 0, windowBytes: 2 * P, hotBytes: P, seek: true })
    host.setViewerLinks('viewer-0', ['viewer-1'])
    host.setViewerLinks('viewer-1', ['viewer-0'])
    host.setViewerUrgent('viewer-1', [20])
    const viewers: TransferEngine[] = []
    const nets: ReturnType<typeof link>[] = []
    const firstBitfield: (number[] | null)[] = [null, null]
    for (const k of [0, 1]) {
      const v = new TransferEngine()
      await v.joinAsViewer({
        torrent: prepared.torrent,
        dir: join(dir, `transfer-early-${String(k)}`),
        uploadLimitKBps: null,
      })
      // the host's lane is the viewer's only one: its first message is the host's advertisement
      const t = (v as unknown as { torrent: { on(e: 'wire', fn: (w: Wire) => void): void } }).torrent
      t.on('wire', (w) =>
        w.once('bitfield', (bits: { get(i: number): boolean }) => {
          firstBitfield[k] = [...Array(last + 1).keys()].filter((i) => bits.get(i))
        }),
      )
      viewers.push(v)
    }
    const starting = host.startHost(prepared, { uploadLimitKBps: null })
    viewers.forEach((v, k) => {
      const net = link()
      nets.push(net)
      // the viewer's handshake reaches the host's lane before the host's torrent is ready
      host.attach({ id: `viewer-${String(k)}`, publicKey: Buffer.alloc(32, k + 1), mux: net.hostMux })
      v.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
    })
    await starting
    const internal = host as unknown as {
      torrent: { wires: object[] }
      revealer: { views: Map<string, { open: boolean; revealed: Uint8Array }> }
    }
    await until(() => internal.torrent.wires.length === 2, 5000)
    for (const wire of internal.torrent.wires) expect(Object.hasOwn(wire, 'haveAll')).toBe(true) // overridden
    expect([...internal.revealer.views.keys()].sort()).toEqual(['viewer-0', 'viewer-1'])
    // the critical pieces (and viewer-1's urgent one) were in the first bitfield, before any tick
    await until(() => firstBitfield.every((b) => b !== null), 5000)
    expect(firstBitfield).toEqual([
      [0, last],
      [0, 20, last],
    ])
    // striping, not plain seeding: nobody open, and the walk gives each piece to one viewer
    const walked = (id: string): number[] => {
      const bits = internal.revealer.views.get(id)?.revealed ?? new Uint8Array()
      return [...bits.keys()].filter((i) => bits[i] === 1 && i !== 0 && i !== last && i !== 20)
    }
    await until(() => walked('viewer-0').length > 0 && walked('viewer-1').length > 0, 5000)
    await sleep(600) // a couple more ticks
    const views = [...internal.revealer.views.values()]
    const summary = JSON.stringify({ open: views.map((v) => v.open), a: walked('viewer-0'), b: walked('viewer-1') })
    expect(
      views.map((v) => v.open),
      summary,
    ).toEqual([false, false])
    expect(
      walked('viewer-0').filter((i) => walked('viewer-1').includes(i)),
      summary,
    ).toEqual([])
    expect(walked('viewer-0').length + walked('viewer-1').length, summary).toBeLessThan(last / 2) // R each, no more
    await Promise.all(viewers.map((v) => v.leave({ data: 'delete' })))
    await host.destroy()
    for (const net of nets) net.close()
  })

  // The window the hooks must cover: between the torrent's 'ready' (whenReady's settle) and the rest of startHost,
  // whenReady's own .then adds the lanes that opened during the start. Today a lane's buffered handshake reaches
  // its wire a tick after that, so the race never shows by itself: here each viewer's handshake is held in the
  // host's lane and handled the moment the torrent adds the lane, which puts the wire's 'wire' event inside the
  // window. Hooks installed after `await whenReady()` (round 1) miss both wires, and the viewers get have-all.
  it('stripes wires that come up between ready and the rest of startHost (their handshake handled as the lane is added)', async () => {
    const prepared = await prepareHost({
      videoPath: join(dir, 'film.mkv'),
      subtitlePaths: [join(dir, 'film.srt')],
      cacheRoot: join(dir, 'cache'),
      pieceLength: P,
    })
    const last = Math.ceil((video.length + sub.length) / P) - 1
    const host = new TransferEngine()
    host.setGroupCriticalRanges([
      [0, P],
      [last * P, last * P + 1],
    ])
    host.setGroupPlayhead({ byte: 0, windowBytes: 2 * P, hotBytes: P, seek: true })
    host.setViewerLinks('viewer-0', ['viewer-1'])
    host.setViewerLinks('viewer-1', ['viewer-0'])
    const viewers: TransferEngine[] = []
    const nets: ReturnType<typeof link>[] = []
    const first: (number[] | 'have-all' | null)[] = [null, null]
    for (const k of [0, 1]) {
      const v = new TransferEngine()
      await v.joinAsViewer({
        torrent: prepared.torrent,
        dir: join(dir, `transfer-race-${String(k)}`),
        uploadLimitKBps: null,
      })
      // the host's lane is the viewer's only one: its first message is the host's advertisement
      const t = (v as unknown as { torrent: { on(e: 'wire', fn: (w: Wire) => void): void } }).torrent
      t.on('wire', (w) => {
        w.once('bitfield', (bits: { get(i: number): boolean }) => {
          first[k] ??= [...Array(last + 1).keys()].filter((i) => bits.get(i))
        })
        w.once('have-all', () => (first[k] ??= 'have-all'))
      })
      viewers.push(v)
    }
    // what reaches the host's lanes is held there until its torrent adds the lane (a viewer's lane to the host
    // carries the host's key in its id, and passes)
    const toHost = HOST_KEY.toString('hex').slice(0, 16)
    const held = new Map<MuxWireStream, unknown[]>()
    const released = new Set<MuxWireStream>()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each lane as this
    const push = MuxWireStream.prototype.push
    const holdInput = vi.spyOn(MuxWireStream.prototype, 'push').mockImplementation(function (
      this: MuxWireStream,
      data: unknown,
    ) {
      if (data === null || this.id.startsWith(toHost) || released.has(this)) return push.call(this, data)
      held.set(this, [...(held.get(this) ?? []), data])
      return true
    })
    // the lanes open while the host still opens its files, so they wait in its queue for 'ready'
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the files as this
    const openAll = SourceFiles.prototype.openAll
    const holdFiles = vi.spyOn(SourceFiles.prototype, 'openAll').mockImplementation(async function (this: SourceFiles) {
      await until(() => held.size === 2, 5000) // both viewers' BT handshakes are in
      return openAll.call(this)
    })
    // and the torrent handles a lane's handshake as it adds it, before startHost goes on
    const handledAtAdd: string[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the client as this
    const add = WebTorrent.prototype.add
    const addNow = vi.spyOn(WebTorrent.prototype, 'add').mockImplementation(function (
      this: WebTorrent,
      ...args: Parameters<WebTorrent['add']>
    ) {
      const t = add.apply(this, args)
      const addPeer = t.addPeer.bind(t)
      t.addPeer = (peer: unknown): boolean => {
        const lane = peer as MuxWireStream
        const ok = addPeer(peer)
        released.add(lane)
        const wire = t._peers?.get(lane.id)?.wire as (Wire & { _write(d: unknown, cb: () => void): void }) | undefined
        for (const chunk of held.get(lane) ?? []) wire?._write(chunk, () => undefined)
        if (wire && t.wires.includes(wire)) handledAtAdd.push(lane.id) // its 'wire' event fired, right here
        return ok
      }
      return t
    })
    try {
      const starting = host.startHost(prepared, { uploadLimitKBps: null })
      viewers.forEach((v, k) => {
        const net = link()
        nets.push(net)
        host.attach({ id: `viewer-${String(k)}`, publicKey: Buffer.alloc(32, k + 1), mux: net.hostMux })
        v.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
      })
      await starting
    } finally {
      addNow.mockRestore()
      holdFiles.mockRestore()
      holdInput.mockRestore()
    }
    expect(handledAtAdd).toHaveLength(2) // the race took place: both wires came up inside whenReady's .then
    await until(() => first.every((b) => b !== null), 5000)
    expect(first).toEqual([
      [0, last],
      [0, last],
    ])
    const internal = host as unknown as { revealer: { views: Map<string, unknown> } | null }
    expect([...(internal.revealer?.views.keys() ?? [])].sort()).toEqual(['viewer-0', 'viewer-1'])
    await Promise.all(viewers.map((v) => v.leave({ data: 'delete' })))
    await host.destroy()
    for (const net of nets) net.close()
  })

  it('applies the latest upload limit to a host started meanwhile, in its upload scheduler', async () => {
    const prepared = await prepareHost({
      videoPath: join(dir, 'film.mkv'),
      subtitlePaths: [join(dir, 'film.srt')],
      cacheRoot: join(dir, 'cache'),
      pieceLength: P,
    })
    const host = new TransferEngine()
    const start = host.startHost(prepared, { uploadLimitKBps: 300 })
    host.setUploadLimit(200) // before the client exists
    await start
    // no viewer, so no paced rate: the limit is the scheduler's rate. WebTorrent's throttle stays off on the host
    expect(inside(host).uploadScheduler?.stats().rateBps).toBe(200 * 1024)
    expect(inside(host).client?._uploadLimit).toBe(-1)
    host.setUploadLimit(null)
    expect(inside(host).uploadScheduler?.stats().rateBps).toBeNull()
    await host.destroy()
  })
})

describe('TransferEngine after its torrent dies', () => {
  it('drops every lane and opens none again once a store error destroyed the torrent', async () => {
    const rejections: unknown[] = []
    const onRejection = (e: unknown): void => void rejections.push(e)
    process.on('unhandledRejection', onRejection)
    try {
      const { host, torrent } = await hostWith()
      const net = link()
      const v = new TransferEngine()
      const errors: string[] = []
      v.on('error', (e) => errors.push(e.message))
      await v.joinAsViewer({ torrent, dir: join(dir, 'transfer-dead'), uploadLimitKBps: null })
      host.attach({ id: 'viewer', publicKey: VIEWER_KEY, mux: net.hostMux })
      v.attach({ id: 'host', publicKey: HOST_KEY, mux: net.viewerMux })
      await new Promise<void>((resolve) => {
        let n = 0
        v.on('verified', () => ++n === 3 && resolve())
        v.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
      })
      // what a failed put does inside WebTorrent (torrent.js put callback -> _destroy(err))
      ;(v as unknown as { torrent: { _destroy(err: Error): void } }).torrent._destroy(new Error('EIO: disk gone'))
      expect(errors).toEqual(['EIO: disk gone'])
      await sleep(1600) // past the first re-attach backoff (1 s)
      const internal = v as unknown as { attached: Map<string, unknown>; unattachedStreams: unknown[] }
      expect(internal.attached.size).toBe(0) // nothing left to re-open...
      v.attach({ id: 'late', publicKey: Buffer.alloc(32, 0xcc), mux: net.viewerMux })
      expect(internal.attached.size).toBe(0) // ...and nothing new is taken
      expect(internal.unattachedStreams).toHaveLength(0)
      expect(rejections).toEqual([]) // addPeer on the dead torrent threw inside stream.opened.then
      await v.leave({ data: 'delete' })
      await host.destroy()
      net.close()
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })
})

describe('TransferEngine re-attach', () => {
  it('backs off re-opening a lane the other side never accepts (1 s, 2 s, 5 s, ...)', async () => {
    const net = link()
    const id = Buffer.alloc(20, 7)
    const e = new TransferEngine()
    ;(e as unknown as { infoHashBuf: Buffer }).infoHashBuf = id
    let opens = 0
    net.viewerMux.pair({ protocol: BT_PROTOCOL, id }, () => {
      opens++ // claims nothing, so Protomux rejects the open
    })
    e.attach({ id: 'never-joins', publicKey: VIEWER_KEY, mux: net.hostMux })
    await sleep(3600)
    // opens at ~0 s, 1 s and 3 s; a backoff stuck at its first step would have opened at 0, 1, 2 and 3 s
    expect(opens).toBeGreaterThanOrEqual(2)
    expect(opens).toBeLessThanOrEqual(3)
    await e.destroy()
    net.close()
  })
})
