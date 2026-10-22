import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import WebTorrent, { type Torrent } from 'webtorrent'
import { afterAll, describe, expect, it } from 'vitest'
import { WEBTORRENT_OPTIONS } from '../../../src/core/transfer/client-options.js'
import { prepareHost } from '../../../src/core/transfer/host-prepare.js'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'
import { ReadOnlyFileStore } from '../../../src/core/transfer/readonly-store.js'
import { SegmentStore } from '../../../src/core/transfer/segment-store.js'
import { SourceFiles } from '../../../src/core/transfer/source-files.js'

// Our own torrent (prepareHost) seeded from the original files without re-hashing (ReadOnlyFileStore +
// skipVerify), downloaded into segment files by a viewer that verifies every piece.

const dir = mkdtempSync(join(tmpdir(), 'wt-hv-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const ready = (t: Torrent): Promise<void> =>
  new Promise((resolve) => {
    if (t.ready) resolve()
    else t.once('ready', () => resolve())
  })

describe('host seeds a prepared torrent; viewer downloads into segments', () => {
  it('transfers video + subtitles intact and never writes to the source', async () => {
    const P = 256 * 1024
    const video = randomBytes(9 * P + 4321)
    const sub = Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nHello\n')
    const videoPath = join(dir, 'movie.mkv')
    const subPath = join(dir, 'movie.srt')
    writeFileSync(videoPath, video)
    writeFileSync(subPath, sub)
    const before = statSync(videoPath).mtimeMs

    const prepared = await prepareHost({
      videoPath,
      subtitlePaths: [subPath],
      cacheRoot: join(dir, 'cache'),
      pieceLength: P,
    })
    const source = new SourceFiles(prepared.sources)

    const host = new WebTorrent(WEBTORRENT_OPTIONS)
    const viewer = new WebTorrent(WEBTORRENT_OPTIONS)
    const seeded = host.add(prepared.torrent, {
      store: ReadOnlyFileStore,
      storeOpts: { source },
      skipVerify: true,
      storeCacheSlots: 0,
    })
    const viewerDir = join(dir, 'viewer')
    const down = viewer.add(prepared.torrent, {
      store: SegmentStore,
      storeOpts: { dir: viewerDir, segmentBytes: 4 * P },
      storeCacheSlots: 0,
    })
    await Promise.all([ready(seeded), ready(down)])
    expect(seeded.progress).toBe(1)

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
    await new Promise<void>((resolve) => down.once('done', () => resolve()))

    // read everything back through the viewer's store
    const all = Buffer.concat([video, sub])
    const got: Buffer[] = []
    for (let i = 0; i < prepared.layout.pieceCount; i++) {
      got.push(
        await new Promise<Buffer>((resolve, reject) =>
          down.store.get(i, null, (e, b) => (e || !b ? reject(e ?? new Error('empty')) : resolve(b))),
        ),
      )
    }
    expect(Buffer.concat(got).equals(all)).toBe(true)
    expect(statSync(videoPath).mtimeMs).toBe(before)
    expect(readFileSync(videoPath).equals(video)).toBe(true)

    await Promise.all([new Promise((r) => host.destroy(r)), new Promise((r) => viewer.destroy(r))])
    await source.close()
    sa.destroy()
    sb.destroy()
  })
})
