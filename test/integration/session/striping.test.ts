import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { StreamServer } from '../../../src/core/media/stream-server.js'
import type { Room } from '../../../src/core/net/room.js'
import type { PlayerHolder } from '../../../src/core/session/player-holder.js'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import type { ByteRange, Manifest } from '../../../src/shared/media/types.js'
import { HAVE_FFMPEG, HAVE_MPV, LONG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Host-assigned striping through whole sessions: the host's group playhead and critical ranges are set before any
// viewer attaches, viewers report their lanes and blocked reads (transfer.links), and the host feeds them to its
// transfer. Three viewers then share an upload-limited host's stream instead of each taking a copy from it.

interface Internals {
  current: {
    room: Room
    manifest: Manifest | null
    /** host: the playlist item playing (ADR 0011) */
    current?: { manifest: Manifest | null } | null
    server: StreamServer | null
    /** a viewer's piece states (2 = verified) */
    states: Uint8Array
    playerHolder(): PlayerHolder | null
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

async function joinRoom(root: string, name: string, invite: string, opts: { realMpv?: boolean } = {}): Promise<Member> {
  const v = member(name, root, opts)
  await v.client.request('session.join', { invite })
  await v.client.until('session', (s) => s.phase === 'confirm-join', 60_000)
  await v.client.request('session.confirmJoin', { dir: join(v.dir, 'save') })
  await v.client.until('session', (s) => s.phase === 'in-room', 60_000)
  return v
}

describe.skipIf(!HAVE_FFMPEG)('session: host-assigned striping', () => {
  let testnet: Testnet
  let video: string
  const root = mkdtempSync(join(tmpdir(), 'wt-striping-'))
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('three viewers playing from 0 share the upload-limited host: each piece leaves it about once', async () => {
    const links = new Map<string, string[]>()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the engine as this
    const setViewerLinks = TransferEngine.prototype.setViewerLinks
    vi.spyOn(TransferEngine.prototype, 'setViewerLinks').mockImplementation(function (this: TransferEngine, id, l) {
      links.set(id, [...l])
      setViewerLinks.call(this, id, l)
    })
    const plans: { posS: number; reason: string }[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the engine as this
    const setGroupPlayhead = TransferEngine.prototype.setGroupPlayhead
    vi.spyOn(TransferEngine.prototype, 'setGroupPlayhead').mockImplementation(function (this: TransferEngine, plan) {
      plans.push(plan as unknown as { posS: number; reason: string })
      setGroupPlayhead.call(this, plan)
    })
    const host = member('Host', root, { settings: { uploadLimitKBps: 800 } })
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    const viewers = await Promise.all(['Ann', 'Bob', 'Cid'].map((n) => joinRoom(root, n, invite)))
    for (const v of viewers) await v.client.until('sync', (s) => s.mode === 'paused', 30_000)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)

    // the whole file reaches everyone: at 800 KB/s one copy takes ~20 s, three ~60 s
    await eventually(
      () => viewers.every((v) => (v.client.last('transfer')?.progress ?? 0) >= 1),
      90_000,
      'every viewer complete',
    )
    await host.client.until('transfer', () => true)
    const dup = host.client.last('transfer')?.dupFactor
    expect(dup).toBeDefined()
    expect(dup).toBeLessThanOrEqual(1.5)
    // the group plan follows the playing room (1 Hz), not only its seeks. The room plays on after the download (60 s
    // of video), so this waits for the ticks rather than counting those before the last piece arrived: the room
    // starts once every viewer has its first pieces, and under CPU load the host's throttle starved the lane of the
    // one fetching such a piece for up to ~10 s, while the striped download itself ends ~20 s in (ADR 0003, Round 5)
    const ticks = (): number[] => plans.filter((p) => p.reason === 'tick').map((p) => p.posS)
    const ticked = (): boolean => ticks().length > 5 && (ticks().at(-1) ?? 0) > (ticks()[0] ?? 0) + 5
    await eventually(ticked, 20_000, 'plan ticks').catch(() => undefined)
    expect(ticks().length).toBeGreaterThan(5)
    expect(ticks().at(-1)).toBeGreaterThan((ticks()[0] ?? 0) + 5)
    // the host's transfer knows each viewer's lanes to the other two (what makes it give a piece to one alone)
    const ids = viewers.map((v) => internals(v).current?.room.self ?? '')
    for (const id of ids) expect(links.get(id)).toEqual(expect.arrayContaining(ids.filter((x) => x !== id)))
    for (const v of viewers) await v.manager.shutdown()
    await host.manager.shutdown()
  }, 180_000)

  it('the group playhead and critical ranges are set before the first viewer is attached', async () => {
    const calls: string[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the originals, called below with the engine as this
    const { startHost, attach, setGroupPlayhead, setGroupCriticalRanges } = TransferEngine.prototype
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(TransferEngine.prototype, 'startHost').mockImplementation(async function (this: TransferEngine, ...a) {
      await gate // a viewer is admitted while the host prepares, and is attached as soon as seeding starts
      return startHost.apply(this, a)
    })
    vi.spyOn(TransferEngine.prototype, 'attach').mockImplementation(function (this: TransferEngine, p) {
      calls.push('attach')
      attach.call(this, p)
    })
    const plans: { posS: number; reason: string }[] = []
    vi.spyOn(TransferEngine.prototype, 'setGroupPlayhead').mockImplementation(function (this: TransferEngine, plan) {
      calls.push('playhead')
      plans.push(plan as unknown as { posS: number; reason: string })
      setGroupPlayhead.call(this, plan)
    })
    vi.spyOn(TransferEngine.prototype, 'setGroupCriticalRanges').mockImplementation(function (this: TransferEngine, r) {
      calls.push('critical')
      setGroupCriticalRanges.call(this, r)
    })
    const host = member('Host', root)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    const ann = member('Ann', root)
    await ann.client.request('session.join', { invite })
    await eventually(() => (internals(host).current?.room.peers().length ?? 0) > 0, 30_000, 'Ann linked')
    release()
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    await eventually(() => calls.includes('attach'), 10_000, 'Ann attached')
    expect(calls.slice(0, 2).sort()).toEqual(['critical', 'playhead'])
    expect(calls.indexOf('attach')).toBeGreaterThan(1)
    expect(plans[0]).toMatchObject({ posS: 0, reason: 'join' })
    // a group seek moves the plan before anyone's mpv seeks (the host member's playhead)
    expect((await host.client.request('playback.intent', { kind: 'seek', posS: 40 })).accepted).toBe(true)
    await eventually(() => plans.some((p) => p.reason === 'seek' && Math.abs(p.posS - 40) < 0.01), 10_000, 'plan at 40')
    await ann.manager.shutdown()
    await host.manager.shutdown()
  })

  it('a viewer reading far outside the plan is shown that piece at once (its report makes it urgent)', async () => {
    const urgent: [string, number[]][] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the engine as this
    const setViewerUrgent = TransferEngine.prototype.setViewerUrgent
    vi.spyOn(TransferEngine.prototype, 'setViewerUrgent').mockImplementation(function (this: TransferEngine, id, p) {
      urgent.push([id, [...p]])
      setViewerUrgent.call(this, id, p)
    })
    // slow enough that the walk from 0 (two viewers: striping is on) reaches the end of the file only after ~1 min
    const host = member('Host', root, { settings: { uploadLimitKBps: 200 } })
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    const [ann, bob] = await Promise.all([joinRoom(root, 'Ann', invite), joinRoom(root, 'Bob', invite)])
    const cur = internals(ann).current
    const manifest = cur?.manifest
    const server = cur?.server
    if (!manifest || !server) throw new Error('no viewer stream')
    // a piece 70 % in that nobody needs at once: not open-critical, far past the paused room's window
    const P = manifest.pieceLength
    const pieces = Math.ceil(manifest.fileSize / P)
    const piece = Math.floor(pieces * 0.7)
    expect(manifest.openCritical.some(([a, b]) => a < (piece + 1) * P && b > piece * P)).toBe(false)

    const t0 = Date.now()
    const ac = new AbortController()
    const res = await fetch(server.url(0), { headers: { Range: `bytes=${String(piece * P)}-` }, signal: ac.signal })
    expect(res.status).toBe(206)
    const reader = res.body?.getReader()
    const first = await reader?.read() // blocks in the stream server until the piece is verified
    const tookS = (Date.now() - t0) / 1000
    ac.abort()
    expect(first?.value?.byteLength).toBeGreaterThan(0)
    const annId = cur.room.self
    expect(urgent.some(([id, p]) => id === annId && p.includes(piece))).toBe(true)
    // ~10 s with the report (one piece at 200 KB/s, behind what the throttle already queued); ~70 s without it,
    // when the walk from the paused room's position reaches it after the ~11 MB before it
    expect(tookS).toBeLessThan(30)
    await ann.manager.shutdown()
    await bob.manager.shutdown()
    await host.manager.shutdown()
  }, 180_000)

  it('a file that plays only once complete is striped too: three viewers take about one copy from the host', async () => {
    // fMP4 without sidx: open-critical from end to end, and shown to everyone at once each viewer would take its
    // own copy (dupFactor 2.9, the last one done after ~57 s)
    const full = await fixture('fmp4-nosidx.mp4', LONG)
    const host = member('Host', root, { settings: { uploadLimitKBps: 800 } })
    const { invite } = await host.client.request('session.host', { videoPath: full, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    expect(host.client.last('session')?.media?.fullDownload).toBe(true)
    const viewers = await Promise.all(['Ann', 'Bob', 'Cid'].map((n) => joinRoom(root, n, invite)))
    // nothing plays before the whole file is there; at 800 KB/s one copy takes ~20 s
    await eventually(
      () => viewers.every((v) => (v.client.last('transfer')?.progress ?? 0) >= 1),
      150_000,
      'every viewer complete',
    )
    await sleep(1500) // the host's next transfer event (1 Hz)
    const dup = host.client.last('transfer')?.dupFactor
    expect(dup).toBeDefined()
    expect(dup).toBeLessThanOrEqual(1.5)
    for (const v of viewers) await v.manager.shutdown()
    await host.manager.shutdown()
  }, 240_000)

  it("the group plan follows the room's seeks while the host's own player is closed", async () => {
    const plans: { posS: number; reason: string }[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the engine as this
    const setGroupPlayhead = TransferEngine.prototype.setGroupPlayhead
    vi.spyOn(TransferEngine.prototype, 'setGroupPlayhead').mockImplementation(function (this: TransferEngine, plan) {
      plans.push(plan as unknown as { posS: number; reason: string })
      setGroupPlayhead.call(this, plan)
    })
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    await host.client.until('player', (p) => p.status === 'ready', 30_000)
    // closed (the user shut its window): the host member no longer seeks or loads, which is what moved the plan
    await internals(host).current?.playerHolder()?.close()
    await host.client.until('peers', (ps) => ps.some((p) => p.self && p.phase === 'no-player'), 10_000)
    const planAt = (from: number, posS: number): { posS: number; reason: string } | undefined =>
      plans.slice(from).find((p) => Math.abs(p.posS - posS) < 2)

    // paused: the next 1 Hz tick sees the room away from the plan
    let from = plans.length
    expect((await host.client.request('playback.intent', { kind: 'seek', posS: 45 })).accepted).toBe(true)
    await eventually(() => planAt(from, 45) !== undefined, 3000, 'the plan at 45')
    expect(planAt(from, 45)).toMatchObject({ posS: 45, reason: 'seek' })

    // playing: L1 slides at 1 Hz, and a jump is a seek too (a tick would keep the hot window at the old place)
    expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
    await eventually(() => plans.slice(from).filter((p) => p.reason === 'tick').length >= 2, 5000, 'ticks')
    for (const target of [20, 40, 10]) {
      from = plans.length
      expect((await host.client.request('playback.intent', { kind: 'seek', posS: target })).accepted).toBe(true)
      await eventually(() => planAt(from, target) !== undefined, 3000, `the plan at ${String(target)}`)
      expect(planAt(from, target)?.reason).toBe('seek')
      await sleep(1500)
    }
    await host.manager.shutdown()
  }, 120_000)

  it.skipIf(!HAVE_MPV)(
    "the seek index goes to every viewer up front: mpv's first seek needs no urgent report for it",
    async () => {
      const critical: ByteRange[][] = []
      // eslint-disable-next-line @typescript-eslint/unbound-method -- the originals, called below with the engine as this
      const { setViewerUrgent, setGroupCriticalRanges } = TransferEngine.prototype
      vi.spyOn(TransferEngine.prototype, 'setGroupCriticalRanges').mockImplementation(function (
        this: TransferEngine,
        r,
      ) {
        critical.push([...r])
        setGroupCriticalRanges.call(this, r)
      })
      const host = member('Host', root, { settings: { uploadLimitKBps: 300 } })
      const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
      const manifest = internals(host).current?.manifest ?? internals(host).current?.current?.manifest
      if (!manifest) throw new Error('no manifest')
      const P = manifest.pieceLength
      const cues = [...new Set(manifest.seekCritical.flatMap(([a, b]) => [Math.floor(a / P), Math.floor((b - 1) / P)]))]
      // the last piece: the group plan's walk from the paused room's 0:00 reaches it last, ~50 s in at 300 KB/s
      expect(cues).toEqual([Math.ceil(manifest.fileSize / P) - 1])
      const shown = critical.at(-1) ?? []
      for (const i of cues) expect(shown.some(([a, b]) => a <= i * P && b > i * P)).toBe(true)
      // a host that never takes them from an urgent report: only being shown up front brings them early
      vi.spyOn(TransferEngine.prototype, 'setViewerUrgent').mockImplementation(function (this: TransferEngine, id, p) {
        setViewerUrgent.call(
          this,
          id,
          p.filter((i) => !cues.includes(i)),
        )
      })

      // Ann plays with the installed mpv. Sessions load at start=<the room's position>, a seek to mpv, so it reads
      // the Cues as it opens, at 0:00 too: its first playback-restart waits for that piece
      const ann = await joinRoom(root, 'Ann', invite, { realMpv: true })
      const bob = await joinRoom(root, 'Bob', invite)
      const mid = 10 // in L2, which the walk sends after L1 (the first ~25 s) and before the last piece
      const early: boolean[] = []
      await eventually(
        () =>
          [ann, bob].every((v, i) => {
            const st = internals(v).current?.states
            if (!st || !cues.every((c) => st[c] === 2)) return false
            early[i] ??= st[mid] !== 2
            return true
          }),
        45_000,
        'the Cues at every viewer',
      )
      expect(early).toEqual([true, true])
      await ann.client.until('player', (p) => p.status === 'ready', 30_000)
      await ann.client.until('playback', (p) => p.paused && p.posS < 0.5, 30_000)
      // a later seek uses what the open read; the pieces it needs come through urgent reports as usual
      expect((await host.client.request('playback.intent', { kind: 'seek', posS: 40 })).accepted).toBe(true)
      await ann.client.until('playback', (p) => Math.abs(p.posS - 40) < 0.5 && !p.seeking, 60_000)
      await ann.manager.shutdown()
      await bob.manager.shutdown()
      await host.manager.shutdown()
    },
    180_000,
  )
})
