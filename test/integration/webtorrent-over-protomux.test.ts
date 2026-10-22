import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import WebTorrent, { type Torrent } from 'webtorrent'
import { afterAll, describe, expect, it } from 'vitest'
import { WEBTORRENT_OPTIONS as OPTS } from '../../src/core/transfer/client-options.js'
import { MuxWireStream } from '../../src/core/transfer/mux-wire-stream.js'

// The decision-critical claim behind D2: stock WebTorrent 3.0.21 (with the ConnPool patch) exchanges a
// file when its only peer is a MuxWireStream over a Protomux channel. Full transport measurements are S2.

const dir = mkdtempSync(join(tmpdir(), 'wt-int-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function seed(client: WebTorrent, path: string): Promise<Torrent> {
  return new Promise((resolve) => {
    client.seed(path, { pieceLength: 256 * 1024, private: true, announceList: [] }, resolve)
  })
}

describe('WebTorrent over Protomux', () => {
  it('a viewer downloads the whole file from a seeder through MuxWireStream', async () => {
    const src = join(dir, 'movie.bin')
    const data = randomBytes(5 * 1024 * 1024 + 12345)
    writeFileSync(src, data)

    const host = new WebTorrent(OPTS)
    const viewer = new WebTorrent(OPTS)
    const seeded = await seed(host, src)
    const down = viewer.add(seeded.torrentFile, { path: join(dir, 'viewer') })
    await new Promise<void>((resolve) => {
      if (down.ready) resolve()
      else down.once('ready', () => resolve())
    })

    const sa = new SecretStream(true)
    const sb = new SecretStream(false)
    sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
    const infoHash = Buffer.from(seeded.infoHash, 'hex')
    const hostSide = MuxWireStream.open(Protomux.from(sa), infoHash, Buffer.alloc(32, 1))
    const viewerSide = MuxWireStream.open(Protomux.from(sb), infoHash, Buffer.alloc(32, 2))
    if (!hostSide || !viewerSide) throw new Error('channel not created')
    expect(await hostSide.opened).toBe(true)
    expect(await viewerSide.opened).toBe(true)
    expect(seeded.addPeer(hostSide)).toBe(true)
    expect(down.addPeer(viewerSide)).toBe(true)

    await new Promise<void>((resolve) => down.once('done', () => resolve()))
    const file = down.files[0]
    if (!file) throw new Error('no file')
    expect(readFileSync(join(dir, 'viewer', file.path)).equals(data)).toBe(true)

    await Promise.all([new Promise((r) => host.destroy(r)), new Promise((r) => viewer.destroy(r))])
    sa.destroy()
    sb.destroy()
  })
})
