import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Room } from '../../../src/core/net/room.js'
import { HostSession } from '../../../src/core/session/host-session.js'
import { SessionFile, sessionFilePath } from '../../../src/core/session/session-file.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import type { NoticeEvent, PlayerEvent, SessionEvent, SessionPhase } from '../../../src/shared/ipc/core.js'
import { FASTSTART_REMUX } from '../../../src/shared/media/media-map.js'
import type { Settings } from '../../../src/shared/settings.js'
import { HAVE_FFMPEG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// The host's own lifecycle, no viewer needed: leaving and cancelling never pass through other screens,
// the feasibility line is there while hashing and in the room, the upload limit applies live, power follows,
// and session.json keeps the room resumable from the start.

interface Internals {
  deps: { control: { power: (on: boolean) => void } }
  settings: Settings
  current: {
    isPreparing(): boolean
    transfer: {
      client: { _uploadLimit: number } | null
      uploadScheduler: { stats(): { rateBps: number | null } } | null
    }
    room: Room
    syncEngine(): SyncEngine | null
  } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

function recordPower(m: Member): boolean[] {
  const calls: boolean[] = []
  internals(m).deps.control.power = (on) => calls.push(on)
  return calls
}

const phasesFrom = (m: Member, from: number): SessionPhase[] =>
  m.client.events
    .slice(from)
    .filter((e) => e.e === 'session')
    .map((e) => (e.d as { phase: SessionPhase }).phase)

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function eventually(check: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time')
    await sleep(25)
  }
}

/** TransferEngine.startHost (prepare step 4) never returns until `release`; `entered` once it was called. */
function holdSeeding(): { entered: () => boolean; release: () => void } {
  let entered = false
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  vi.spyOn(TransferEngine.prototype, 'startHost').mockImplementation(async () => {
    entered = true
    await gate
  })
  return { entered: () => entered, release: () => release() }
}

describe.skipIf(!HAVE_FFMPEG)('host session: lifecycle', () => {
  let testnet: Testnet
  let video: string
  const root = mkdtempSync(join(tmpdir(), 'wt-host-life-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv')
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ending the room goes straight back to idle (no ended card on the host); power is on only while hosting', async () => {
    const host = member('Host', root)
    const power = recordPower(host)
    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    expect(power.at(-1)).toBe(true)

    const from = host.client.events.length
    await host.client.request('session.leave', { data: 'keep', end: true })
    // 'ended' routes to the Room's ended card: the room's own shutdown must not surface as one ('leaving' is the
    // manager's while the leave runs)
    expect(phasesFrom(host, from)).toEqual(['leaving', 'idle'])
    expect(power.at(-1)).toBe(false)
    await host.manager.shutdown()
  })

  it('cancelling while preparing goes straight back to idle, and nothing starts behind it', async () => {
    let cancelled = false
    // hashing a fresh file takes long enough to cancel in practice; retry in the rare case it already finished
    for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
      const host = member('Host', root)
      const power = recordPower(host)
      await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      const from = host.client.events.length
      const code = await host.client
        .request('session.cancelPrepare', {})
        .then(() => null)
        .catch((e: unknown) => String(e))
      if (code === null) {
        cancelled = true
        await sleep(1500) // a prepare step still in flight must stand down, not open the room late
        expect(phasesFrom(host, from)).toEqual(['idle'])
        expect(host.client.all('session').map((s) => s.phase)).not.toContain('in-room')
        expect(power.at(-1)).toBe(false)
      } else {
        expect(code).toMatch(/not-preparing/)
        await host.client.request('session.leave', { data: 'keep', end: true })
      }
      await host.manager.shutdown()
    }
    expect(cancelled).toBe(true)
  })

  it('reports the feasibility line while hashing and keeps it current in the room', async () => {
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    const hashing = host.client.all('prepare').filter((p) => p.stage === 'hashing')
    expect(hashing.length).toBeGreaterThan(0)
    // HostPrepare is only on screen while preparing: the line has to be there already
    for (const p of hashing) expect(p.feasibility?.needBps).toBeGreaterThan(0)

    const n = host.client.all('prepare').length
    await host.client.until('prepare', () => host.client.all('prepare').length > n + 1)
    const inRoom = host.client.last('prepare')
    expect(inRoom?.stage).toBe('ready')
    expect(inRoom?.feasibility?.needBps).toBe(hashing[0]?.feasibility?.needBps)
    // the same final event as when preparing finished, not a zeroed one
    expect(inRoom?.bytesTotal).toBeGreaterThan(0)
    expect(inRoom?.bytesDone).toBe(inRoom?.bytesTotal)
    await host.manager.shutdown()
  })

  it('applies the upload limit live, including a change made while preparing', async () => {
    const host = member('Host', root)
    const set = (uploadLimitKBps: number | null): void =>
      host.manager.updateSettings({ ...internals(host).settings, uploadLimitKBps })
    // the host's limit is its upload scheduler's rate (no viewer here, so no paced rate); WebTorrent's throttle is off
    const limit = (): number | null | undefined => internals(host).current?.transfer.uploadScheduler?.stats().rateBps
    const throttle = (): number | undefined => internals(host).current?.transfer.client?._uploadLimit

    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    // indexing and hashing still lie ahead, so there is no seeding client yet to take the change
    expect(internals(host).current?.isPreparing()).toBe(true)
    expect(internals(host).current?.transfer.client).toBeNull()
    set(300)
    await host.client.until('session', (s) => s.phase === 'in-room')
    // seeding started after the change: it must start at the new limit
    expect(limit()).toBe(300 * 1024)
    expect(throttle()).toBe(-1)

    set(2000)
    expect(limit()).toBe(2000 * 1024)
    set(null)
    expect(limit()).toBeNull() // unlimited
    expect(throttle()).toBe(-1)
    await host.manager.shutdown()
  })

  it('tells the host what the index found, and how to remux a file viewers could only play once complete', async () => {
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    const ready = await host.client.until('session', (s) => s.phase === 'in-room')
    expect(ready.media).toEqual({ container: 'mkv', seekMode: 'index', fullDownload: false, interleave: 'good' })
    // known once indexed, before hashing ends: HostPrepare can show it
    const first = host.client.all('session').find((s) => s.media !== undefined)
    expect(first?.phase).toBe('preparing')
    expect(host.client.all('notice').map((n) => n.code)).not.toContain('media.full-download')
    await host.client.request('session.leave', { data: 'keep', end: true })

    // a fragmented MP4 without sidx: FFmpeg reads it to the end at open
    const from = host.client.events.length
    await host.client.request('session.host', { videoPath: await fixture('fmp4-nosidx.mp4'), subtitlePaths: [] })
    await eventually(() => phasesFrom(host, from).includes('in-room'), 60_000)
    const later = host.client.events.slice(from)
    const notice = later.find((e) => e.e === 'notice' && (e.d as NoticeEvent).code === 'media.full-download')
    expect(notice?.d).toMatchObject({ level: 'warn', message: expect.stringContaining(FASTSTART_REMUX) as string })
    const inRoom = later.filter((e) => e.e === 'session').at(-1)?.d as SessionEvent | undefined
    expect(inRoom?.media).toEqual({ container: 'fmp4', seekMode: 'linear', fullDownload: true, interleave: 'unknown' })
    await host.manager.shutdown()
  })

  it('a host that fails to prepare does not keep the computer awake', async () => {
    const host = member('Host', root)
    const power = recordPower(host)
    const junk = join(host.dir, 'not-a-video.mkv')
    writeFileSync(junk, Buffer.alloc(256 * 1024, 7))
    await host.client.request('session.host', { videoPath: junk, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'error')
    expect(power[0]).toBe(true) // preparing
    expect(power.at(-1)).toBe(false)
    await host.manager.shutdown()
  })

  it('a cancel while seeding starts stands down when seeding is ready: nothing opens behind the leave', async () => {
    // Seeding becomes ready only once the leave is under way, before it destroys the transfer (a real
    // startHost that loses that race stands down on its own, which would hide the session's check).
    const seeding = holdSeeding()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with the session as this
    const leave = HostSession.prototype.leave
    vi.spyOn(HostSession.prototype, 'leave').mockImplementation(function (this: HostSession, opts) {
      const left = leave.call(this, opts)
      seeding.release()
      return left
    })
    const host = member('Host', root)
    const power = recordPower(host)
    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await eventually(seeding.entered, 30_000) // indexed and hashed, step 4 in flight
    const from = host.client.events.length
    await host.client.request('session.cancelPrepare', {})
    await sleep(300)
    const after = host.client.events.slice(from)
    expect(phasesFrom(host, from)).toEqual(['idle'])
    expect(after.filter((e) => e.e === 'sync' || e.e === 'timeline')).toEqual([])
    // only the manager's idle player event: no player was made
    const players = after.filter((e) => e.e === 'player').map((e) => e.d as PlayerEvent)
    expect(players.map((p) => p.version)).not.toContain('fake')
    expect(power.at(-1)).toBe(false)
    await host.manager.shutdown()
  })

  it('session.json is on disk from the start: a core crash while preparing still resumes the room', async () => {
    const seeding = holdSeeding()
    const host = member('Host', root)
    const { roomId } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await eventually(seeding.entered, 30_000)
    // the core dies here: no bye, nothing more written, the active-room marker stays
    await internals(host).current?.room.close()
    vi.restoreAllMocks()

    // main restarts core with init.resumeActive
    const back = member('Host', root, { dir: host.dir, resumeActive: true })
    await back.manager.started
    expect(back.client.all('notice').map((n) => n.code)).not.toContain('session.resume-failed')
    await back.client.until('session', (s) => s.phase === 'in-room' && s.roomId === roomId, 30_000)

    await back.manager.shutdown()
    await host.manager.shutdown()
    seeding.release()
  })

  it('session.json is on disk before the active-room marker: a crash in between can always resume', async () => {
    // the first write of session.json takes as long as we like (an fsync on a slow disk)
    let entered = false
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each file as this
    const flush = SessionFile.prototype.flush
    vi.spyOn(SessionFile.prototype, 'flush').mockImplementation(async function (this: SessionFile) {
      if (!entered) {
        entered = true
        await gate
      }
      return flush.call(this)
    })
    const host = member('Host', root)
    const active = join(host.dir, 'userData', 'wt', 'active.json')
    let answered = false
    const hosting = host.client.request('session.host', { videoPath: video, subtitlePaths: [] }).then((r) => {
      answered = true
      return r
    })
    await eventually(() => entered, 30_000)
    await sleep(500) // the manager marks the room active as soon as the session is started
    expect(existsSync(active)).toBe(false)
    expect(answered).toBe(false)
    release()
    const { roomId } = await hosting
    expect(existsSync(sessionFilePath(join(host.dir, 'userData'), roomId))).toBe(true)
    await eventually(() => existsSync(active))
    await host.manager.shutdown()
  })

  it('writes session.json at every publish, without the 2 s debounce', async () => {
    const flushed: (number | undefined)[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each file as this
    const flush = SessionFile.prototype.flush
    vi.spyOn(SessionFile.prototype, 'flush').mockImplementation(function (this: SessionFile) {
      flushed.push(this.current.group?.seq)
      return flush.call(this)
    })
    const host = member('Host', root)
    await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room')
    const seq = (): number | undefined => internals(host).current?.syncEngine()?.group?.state()?.seq
    for (const i of [{ kind: 'seek', posS: 5 }, { kind: 'play' }, { kind: 'pause' }] as const) {
      expect((await host.client.request('playback.intent', i)).accepted).toBe(true)
      // the publish wrote it itself: a resume must never start below a seq viewers already hold
      expect(flushed.at(-1)).toBe(seq())
    }
    await host.manager.shutdown()
  })
})
