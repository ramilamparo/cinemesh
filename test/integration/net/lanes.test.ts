import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { Blobs, MemoryBlobProvider, blobHash } from '../../../src/core/net/blobs.js'
import { NET_ERRORS } from '../../../src/core/net/errors.js'
import type { Room, RoomPeer } from '../../../src/core/net/room.js'
import { DATAGRAM_SYNC } from '../../../src/core/net/wire.js'
import { Harness, waitFor } from './helpers.js'

let h: Harness | null = null
const blobs: Blobs[] = []
afterEach(async () => {
  for (const b of blobs.splice(0)) b.destroy()
  await h?.cleanup()
  h = null
})

async function trio(): Promise<[Room, Room, Room]> {
  h = await Harness.start()
  const host = await h.host('Host')
  const a = await h.viewer(host.invite().code, 'A')
  const b = await h.viewer(host.invite().code, 'B')
  await waitFor(() => [host, a, b].every((r) => r.peers().length === 2), 20_000, 'mesh')
  return [host, a, b]
}

describe('lanes', () => {
  it('demuxes datagrams by their first byte', async () => {
    const [host, a] = await trio()
    const sync: { from: RoomPeer; buf: Buffer }[] = []
    const other: Buffer[] = []
    a.onDatagram(DATAGRAM_SYNC, (from, buf) => sync.push({ from, buf }))
    a.onDatagram(0x01, (_from, buf) => other.push(buf))
    const toA = host.peer(a.self)
    if (!toA) throw new Error('no link to A')
    const stateFast = Buffer.from([DATAGRAM_SYNC, 1, 3, 9, 9, 9])
    for (let i = 0; i < 10 && sync.length === 0; i++) {
      expect(toA.sendDatagram(stateFast)).toBe(true)
      toA.sendDatagram(Buffer.from([0x01, 42]))
      await new Promise((r) => setTimeout(r, 100))
    }
    await waitFor(() => sync.length > 0 && other.length > 0, 5000, 'datagrams')
    expect(sync[0]?.buf.equals(stateFast)).toBe(true)
    expect(sync[0]?.from.isHost).toBe(true)
    expect(other.every((b) => b[0] === 0x01)).toBe(true)
  })

  it('carries direct ctrl frames and reports an RTT', async () => {
    const [host, a] = await trio()
    const got: unknown[] = []
    a.onCtrl('test', (_peer, frame) => got.push(frame))
    host.peer(a.self)?.sendCtrl({ ns: 'test', t: 'hello', n: 7 })
    await waitFor(() => got.length === 1, 5000, 'ctrl frame')
    expect(got[0]).toEqual({ ns: 'test', t: 'hello', n: 7 })
    await waitFor(() => host.peer(a.self)?.rttMs !== null, 5000, 'rtt')
    expect(host.members().find((m) => m.id === a.self)?.path).toMatch(/^(lan|direct)$/)
  })

  it('fetches blobs from any holder and verifies them', async () => {
    const [host, a, b] = await trio()
    const torrent = randomBytes(200 * 1024)
    const manifest = randomBytes(1234)
    const atHost = new MemoryBlobProvider()
    const atA = new MemoryBlobProvider()
    const torrentHash = atHost.add(torrent)
    const manifestHash = atA.add(manifest) // only viewer A has this one
    blobs.push(new Blobs(host, atHost), new Blobs(a, atA))
    const fetcher = new Blobs(b)
    blobs.push(fetcher)

    expect((await fetcher.fetch(torrentHash, { size: torrent.byteLength })).equals(torrent)).toBe(true)
    expect((await fetcher.fetch(manifestHash)).equals(manifest)).toBe(true)
    expect(blobHash(manifest)).toBe(manifestHash)
    await expect(fetcher.fetch('ab'.repeat(32))).rejects.toMatchObject({ code: NET_ERRORS.blobNotFound })
  })
})
