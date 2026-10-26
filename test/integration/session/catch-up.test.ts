import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Room } from '../../../src/core/net/room.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import type { PeerView } from '../../../src/shared/ipc/core.js'
import { FIXTURE_DIR, type FixtureSet, HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Catch-up priority through whole sessions (ADR 0012). The room's upload is short: the host sends 400 KiB/s and
// each viewer 96 KiB/s, for a ~1.1 Mbit/s video. Two viewers buffer and play; a third joins mid-play with nothing.
// The pieces at its position are held by the other two, whose uplinks are already busy serving each other. The host
// sees its short buffer in its sync.status and feeds it first, from its position on, until it has caught up.
//
// WT_CATCH_UP_BASELINE=1 runs the same room with catch-up off and logs the numbers for the ADR.

/** 240 s at 1 Mbit/s: ~32 MB, about 30 pieces of 1 MiB */
const MEDIUM: FixtureSet = {
  dir: join(FIXTURE_DIR, 'catchup-240s-1M'),
  durationS: 240,
  size: '320x240',
  videoBitrate: '1M',
  audioBitrate: '64k',
}
const HOST_UP_KBPS = 400
const VIEWER_UP_KBPS = 96
const CAUGHT_UP_S = 15

interface Internals {
  current: {
    room: Room
    syncEngine(): SyncEngine | null
    catchUpEnabled?: boolean
  } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function joinRoom(v: Member, invite: string): Promise<Member> {
  await v.client.request('session.join', { invite })
  await v.client.until('session', (s) => s.phase === 'confirm-join', 60_000)
  await v.client.request('session.confirmJoin', { dir: join(v.dir, 'save') })
  await v.client.until('session', (s) => s.phase === 'in-room', 60_000)
  return v
}

interface Run {
  /** s from the late viewer's join until the host saw CAUGHT_UP_S buffered at it; null: not within the run */
  caughtUpS: number | null
  /** the least the early viewers had buffered while the late one caught up (s) */
  earlyMinS: number
  /**
   * The host's peer list marked the late viewer as catching up, and an early one before the late one caught up (one
   * of three viewers at a time: the late one keeps its place). Later an early viewer may be picked in turn, when its
   * buffer runs short while another's is long: that is the same rule.
   */
  marked: boolean
  markedEarly: boolean
  dupFactor: number | null
  /** per second after the join: the room's mode, the late viewer's buffer, the early viewers' (s) */
  trace: string[]
}

async function room(root: string, video: string, catchUp: boolean): Promise<Run> {
  const host = member('Host', root, { settings: { uploadLimitKBps: HOST_UP_KBPS } })
  const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
  await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
  const hostSession = internals(host).current
  if (hostSession) hostSession.catchUpEnabled = catchUp
  const viewer = (name: string): Member => member(name, root, { settings: { uploadLimitKBps: VIEWER_UP_KBPS } })
  const early = await Promise.all([viewer('Ann'), viewer('Bob')].map((v) => joinRoom(v, invite)))
  for (const v of early) await v.client.until('sync', (s) => s.mode === 'paused', 30_000)
  await sleep(15_000) // they buffer while the room is paused
  expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
  await host.client.until('sync', (s) => s.mode === 'playing', 30_000)
  await sleep(20_000)

  const statuses = () => internals(host).current?.syncEngine()?.group?.memberViews() ?? []
  const idOf = (m: Member): string => internals(m).current?.room.self ?? ''
  const earlyIds = early.map(idOf)
  expect(host.client.last('sync')?.mode).toBe('playing')
  const cid = viewer('Cid')
  const joinedAt = Date.now()
  await joinRoom(cid, invite)
  const cidId = idOf(cid)
  let caughtUpS: number | null = null
  let earlyMinS = Number.POSITIVE_INFINITY
  let marked = false
  let markedEarly = false
  const trace: string[] = []
  let nextTrace = joinedAt
  while (Date.now() - joinedAt < 45_000) {
    await sleep(250)
    const views = statuses()
    if (Date.now() >= nextTrace) {
      nextTrace += 1000
      const a = (id: string): string => (views.find((m) => m.id === id)?.status?.bufferedAheadS ?? -1).toFixed(0)
      const mode = host.client.last('sync')?.mode ?? '?'
      trace.push(`${mode[0] ?? '?'}:${a(cidId)}/${earlyIds.map(a).join(',')}`)
    }
    for (const id of earlyIds) {
      const ahead = views.find((m) => m.id === id)?.status?.bufferedAheadS
      if (ahead !== undefined) earlyMinS = Math.min(earlyMinS, ahead)
    }
    const peers: readonly PeerView[] = host.client.last('peers') ?? []
    if (peers.some((p) => p.id === cidId && p.catchingUp === true)) marked = true
    if (caughtUpS === null && peers.some((p) => earlyIds.includes(p.id) && p.catchingUp === true)) markedEarly = true
    const ahead = views.find((m) => m.id === cidId)?.status?.bufferedAheadS ?? 0
    if (ahead >= CAUGHT_UP_S && caughtUpS === null) caughtUpS = (Date.now() - joinedAt) / 1000
  }
  const dupFactor = host.client.last('transfer')?.dupFactor ?? null
  for (const v of [...early, cid]) await v.manager.shutdown()
  await host.manager.shutdown()
  return { caughtUpS, earlyMinS, marked, markedEarly, dupFactor, trace }
}

describe.skipIf(!HAVE_FFMPEG)('session: catch-up priority', () => {
  let testnet: Testnet
  let video: string
  const root = mkdtempSync(join(tmpdir(), 'wt-catch-up-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv', MEDIUM)
  }, 180_000)
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  it('a viewer joining mid-play is fed first until its buffer is comparable', async () => {
    const run = await room(root, video, true)
    console.log(`catch-up on: ${JSON.stringify(run)}`)
    expect(run.marked).toBe(true)
    expect(run.markedEarly).toBe(false)
    expect(run.caughtUpS).not.toBeNull()
    expect(run.caughtUpS ?? Infinity).toBeLessThan(40)
    expect(run.earlyMinS).toBeGreaterThan(3)
    // the price: what the late viewer was fed, the host had sent the others already (1.45-1.49 measured; 1.16 off)
    expect(run.dupFactor ?? 0).toBeLessThanOrEqual(1.8)
  }, 240_000)

  it.skipIf(!process.env.WT_CATCH_UP_BASELINE)(
    'baseline: the same room with catch-up off',
    async () => {
      const run = await room(root, video, false)
      console.log(`catch-up off: ${JSON.stringify(run)}`)
      expect(run.marked).toBe(false)
    },
    240_000,
  )
})
