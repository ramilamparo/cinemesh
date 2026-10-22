import { closeSync, copyFileSync, mkdtempSync, openSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { HASH_FAILS_NOTICE } from '../../../src/core/session/hash-fails.js'
import { peerWarningText } from '../../../src/shared/peer-warnings.js'
import type { ViewerSession } from '../../../src/core/session/viewer-session.js'
import type { TransferEngine } from '../../../src/core/transfer/engine.js'
import { pieceLengthFor } from '../../../src/core/transfer/torrent-builder.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Plan §4.2 "Source-change watchdog": the host's file rewritten in place with its size and mtime kept (or a disk
// returning other bytes) passes the watchdog, so the host serves a piece that fails its hash at every viewer. The
// viewer counts the failures and reports them; the host warns, in a notice and on that viewer's peer row.

const viewerTransfer = (m: Member): TransferEngine | null =>
  (m.manager as unknown as { current: { transfer: TransferEngine | null } | null }).current?.transfer ?? null

describe.skipIf(!HAVE_FFMPEG)('hash failures', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-hash-fails-'))
  const members: Member[] = []

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterEach(async () => {
    for (const m of members.splice(0)) await m.manager.shutdown()
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it("a piece the host's file no longer matches: the viewer counts its failures, the host warns", async () => {
    // a copy: the shared fixture must stay intact
    const video = join(root, 'film.mkv')
    copyFileSync(await fixture('mkv-cues.mkv'), video)
    const size = statSync(video).size
    const P = pieceLengthFor(size)
    expect(Math.ceil(size / P)).toBeGreaterThanOrEqual(3) // piece 1 is neither the head nor the Cues

    const host = member('Host', root)
    const viewer = member('Sam', root)
    members.push(host, viewer)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')

    const before = statSync(video)
    const fd = openSync(video, 'r+')
    writeSync(fd, randomBytes(4096), 0, 4096, P + 100)
    closeSync(fd)
    utimesSync(video, before.atime, before.mtime)

    await viewer.client.request('session.join', { invite })
    await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'downloads') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')

    const notice = await host.client.until('notice', (n) => n.code === HASH_FAILS_NOTICE.code, 60_000)
    expect(notice.message).toMatch(/changed on disk.*disk is failing.*Host the video again/)
    const peers = await host.client.until('peers', (ps) => ps.some((p) => p.warnings.length > 0))
    const row = peers.find((p) => p.name === 'Sam')
    expect(row?.warnings).toEqual([{ code: 'hash-fails', total: expect.any(Number) as unknown }])
    expect(row?.warnings.map(peerWarningText)).toEqual([
      expect.stringMatching(/does not match the video \(\d+ failed checks\)/),
    ])
    // only once, however long the failures go on
    expect(host.client.all('notice').filter((n) => n.code === HASH_FAILS_NOTICE.code)).toHaveLength(1)
    // the watchdog saw nothing: the host still shares
    expect(host.client.all('notice').map((n) => n.code)).not.toContain('transfer.source-changed')

    const fails = viewerTransfer(viewer)?.hashFailures()
    expect(fails?.worst[0]?.[0]).toBe(1)
    expect(fails?.worst[0]?.[1]).toBeGreaterThanOrEqual(3)
    expect((viewer.manager as unknown as { current: ViewerSession | null }).current).not.toBeNull()

    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  })
})
