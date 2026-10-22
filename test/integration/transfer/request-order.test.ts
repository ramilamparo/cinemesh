import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import WebTorrent, { type Torrent, type Wire } from 'webtorrent'
import { afterAll, describe, expect, it } from 'vitest'
import { WEBTORRENT_OPTIONS } from '../../../src/core/transfer/client-options.js'
import { prepareHost } from '../../../src/core/transfer/host-prepare.js'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'
import { ReadOnlyFileStore } from '../../../src/core/transfer/readonly-store.js'
import { Scheduler } from '../../../src/core/transfer/scheduler.js'
import { SegmentStore } from '../../../src/core/transfer/segment-store.js'
import { SourceFiles } from '../../../src/core/transfer/source-files.js'

// R6 order on a fresh wire (ADR 0003 Finding 1). A wire that has not downloaded a byte yet asks
// validateWire() for its first request, and unpatched WebTorrent walks the selections backwards from the
// end of the last one: at p = 0 the first request was the last piece. patches/webtorrent+3.0.21.patch
// makes it walk forwards, so the first request is the head of the plan.

const dir = mkdtempSync(join(tmpdir(), 'wt-order-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ready = (t: Torrent): Promise<void> =>
  new Promise((resolve) => {
    if (t.ready) resolve()
    else t.once('ready', () => resolve())
  })

describe('R6 request order on a fresh wire', () => {
  it('makes the first request for the plan head (piece 0 at p = 0), not the last piece', async () => {
    const P = 256 * 1024
    const videoPath = join(dir, 'movie.mkv')
    writeFileSync(videoPath, randomBytes(24 * P + 777))
    const prepared = await prepareHost({ videoPath, subtitlePaths: [], cacheRoot: join(dir, 'cache'), pieceLength: P })
    const source = new SourceFiles(prepared.sources)
    const hostClient = new WebTorrent(WEBTORRENT_OPTIONS)
    const viewerClient = new WebTorrent(WEBTORRENT_OPTIONS)
    const seeded = hostClient.add(prepared.torrent, {
      store: ReadOnlyFileStore,
      storeOpts: { source },
      skipVerify: true,
    })
    const down = viewerClient.add(prepared.torrent, {
      store: SegmentStore,
      storeOpts: { dir: join(dir, 'viewer') },
      bitfield: new Uint8Array(Math.ceil(prepared.layout.pieceCount / 8)),
      deselect: true,
      strategy: 'sequential',
    })
    await Promise.all([ready(seeded), ready(down)])
    const n = down.pieces.length

    // the plan at p = 0: hot [0, 0], L1 [0, 4], L2 [5, n - 1] (no L3)
    const scheduler = new Scheduler(down)
    scheduler.setPlayhead({ byte: 0, windowBytes: 4 * P, hotBytes: P, seek: true })
    expect(scheduler.plan()).toEqual([
      { from: 0, to: 0 },
      { from: 0, to: 4 },
      { from: 5, to: n - 1 },
    ])
    const requested: number[] = []
    const first = new Promise<number>((resolve) => {
      down.on('wire', (wire: Wire) => {
        const request = wire.request.bind(wire)
        wire.request = (index, offset, length, cb) => {
          requested.push(index)
          if (requested.length === 1) resolve(index)
          request(index, offset, length, cb)
        }
      })
    })

    const sa = new SecretStream(true)
    const sb = new SecretStream(false)
    sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
    const infoHash = Buffer.from(prepared.infoHash, 'hex')
    const h = MuxWireStream.open(Protomux.from(sa), infoHash, Buffer.alloc(32, 1))
    const v = MuxWireStream.open(Protomux.from(sb), infoHash, Buffer.alloc(32, 2))
    if (!h || !v) throw new Error('no channel')
    await Promise.all([h.opened, v.opened])
    seeded.addPeer(h)
    down.addPeer(v)

    expect(await first).toBe(0) // unpatched: n - 1, the top of L2
    await new Promise<void>((resolve) => down.once('done', () => resolve()))
    // the rest followed the plan too: nothing from L2 before L1 was asked for
    const firstL2 = requested.findIndex((i) => i >= 5)
    expect(requested.slice(0, firstL2).every((i) => i <= 4)).toBe(true)
    expect(new Set(requested.slice(0, firstL2))).toEqual(new Set([0, 1, 2, 3, 4]))

    scheduler.destroy()
    await Promise.all([new Promise((r) => hostClient.destroy(r)), new Promise((r) => viewerClient.destroy(r))])
    await source.close()
    sa.destroy()
    sb.destroy()
  })
})
