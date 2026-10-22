import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Room } from '../../../src/core/net/room.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import type { Settings } from '../../../src/shared/settings.js'
import { HAVE_FFMPEG, LONG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// A viewer's download limit through whole sessions (ADR 0010): Settings reach the viewer's request gate at the
// join and live, its sync.status tells the host the limit (which names it in a slow-download warning), and with
// the host striping three viewers' downloads, a limited one neither stalls the others nor costs extra copies.

interface Internals {
  settings: Settings
  current: {
    room: Room
    syncEngine(): SyncEngine | null
    transfer?: { torrent: { downloaded: number; _requestGate: { rateBps: number | null } | null } | null } | null
  } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function eventually(check: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`${what}: not in ${String(ms)} ms`)
    await sleep(100)
  }
}

async function joinRoom(v: Member, invite: string): Promise<Member> {
  await v.client.request('session.join', { invite })
  await v.client.until('session', (s) => s.phase === 'confirm-join', 60_000)
  await v.client.request('session.confirmJoin', { dir: join(v.dir, 'save') })
  await v.client.until('session', (s) => s.phase === 'in-room', 60_000)
  return v
}

describe.skipIf(!HAVE_FFMPEG)('session: a viewer download limit', () => {
  let testnet: Testnet
  let video: string
  const root = mkdtempSync(join(tmpdir(), 'wt-download-limit-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv', LONG) // 60 s at 2 Mbit/s: ~15 pieces of 1 MiB
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it('holds a viewer to its limit, tells the host, lifts live, and every viewer completes', async () => {
    const LIMIT_KBPS = 128
    const rate = LIMIT_KBPS * 1024
    const host = member('Host', root, { settings: { uploadLimitKBps: 800 } })
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    const ann = member('Ann', root, { settings: { downloadLimitKBps: LIMIT_KBPS } })
    const viewers = await Promise.all([ann, member('Bob', root), member('Cid', root)].map((v) => joinRoom(v, invite)))

    const torrent = (m: Member) => internals(m).current?.transfer?.torrent
    expect(torrent(ann)?._requestGate?.rateBps).toBe(rate)
    expect(torrent(viewers[1] as Member)?._requestGate?.rateBps).toBeNull()

    // what Ann receives over 8 s stays within the gate's bound: the rate, plus a full bucket at the start and the
    // critical pieces' debt at the end, plus one block
    const from = torrent(ann)?.downloaded ?? 0
    await sleep(8000)
    const got = (torrent(ann)?.downloaded ?? 0) - from
    expect(got).toBeLessThanOrEqual(rate * 8 + 64 * 1024 + rate + 16 * 1024)
    expect(got).toBeGreaterThanOrEqual(rate * 8 * 0.5)

    // the host hears it in Ann's sync.status
    const annId = internals(ann).current?.room.self ?? ''
    const statusAtHost = () =>
      internals(host)
        .current?.syncEngine()
        ?.group?.memberViews()
        .find((m) => m.id === annId)?.status
    await eventually(() => statusAtHost()?.downLimitBps === rate, 5000, "the limit in Ann's status")

    // lifted from her Room (or Settings): the gate opens, and her next status no longer carries it
    ann.manager.updateSettings({ ...internals(ann).settings, downloadLimitKBps: null })
    expect(torrent(ann)?._requestGate?.rateBps).toBeNull()
    await eventually(() => statusAtHost()?.downLimitBps === undefined, 5000, "no limit in Ann's status")

    await eventually(
      () => viewers.every((v) => (v.client.last('transfer')?.progress ?? 0) >= 1),
      90_000,
      'every viewer complete',
    )
    await host.client.until('transfer', () => true)
    expect(host.client.last('transfer')?.dupFactor).toBeLessThanOrEqual(1.5)
    for (const v of viewers) await v.manager.shutdown()
    await host.manager.shutdown()
  }, 180_000)
})
