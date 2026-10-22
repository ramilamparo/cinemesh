import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { member } from './harness.js'

// M8 smoke: a host and a viewer SessionManager on a local DHT testnet with fake players. Covers the whole
// pipeline: room → prepare (index + hash) → announce → blobs → JoinConfirm → download → stream server → sync.

describe.skipIf(!HAVE_FFMPEG)('session: host + viewer end to end', () => {
  let testnet: Testnet
  const root = mkdtempSync(join(tmpdir(), 'wt-session-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it('hosts, joins, downloads, syncs play, and gates seeking by permission', async () => {
    const video = await fixture('mkv-cues.mkv')
    const host = member('Host', root)
    const viewer = member('Sam', root)

    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    expect(host.client.last('prepare')?.stage).toBe('ready')

    await viewer.client.request('session.join', { invite })
    const confirm = await viewer.client.until('session', (s) => s.phase === 'confirm-join')
    expect(confirm.joinInfo?.name).toBe('mkv-cues.mkv')
    await viewer.client.request('session.confirmJoin', { dir: join(root, 'save') })
    await viewer.client.until('session', (s) => s.phase === 'in-room')

    // the download runs and the timeline fills in
    await viewer.client.until('transfer', (t) => t.progress > 0.2)
    const tl = await viewer.client.until('timeline', (t) => t.done.length > 0)
    expect(tl.durationS).toBeGreaterThan(20)

    // host presses play → the viewer follows
    const play = await host.client.request('playback.intent', { kind: 'play' })
    expect(play.accepted).toBe(true)
    await viewer.client.until('sync', (s) => s.mode === 'playing')

    // others may not seek by default
    const denied = await viewer.client.request('playback.intent', { kind: 'seek', posS: 10 })
    expect(denied).toEqual({ accepted: false, reason: 'perm-seek' })
    await host.client.request('sync.setPerms', { othersPlayPause: true, othersSeek: true })
    await viewer.client.until('sync', (s) => s.canSeek)
    const allowed = await viewer.client.request('playback.intent', { kind: 'seek', posS: 10 })
    expect(allowed.accepted).toBe(true)
    await host.client.until('playback', (p) => Math.abs(p.posS - 10) < 2)

    // peers see each other
    const peers = await host.client.until('peers', (ps) => ps.some((p) => p.name === 'Sam'))
    expect(peers.find((p) => p.name === 'Sam')?.role).toBe('viewer')

    await viewer.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
    await host.manager.shutdown()
    await viewer.manager.shutdown()
  })
})
