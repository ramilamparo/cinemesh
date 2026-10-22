import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings.js'
import { themePayload } from '../../shared/theme-tokens.js'
import type { RoomEvent } from '../../shared/ipc/core.js'
import type { CoreLog } from '../log.js'
import type { RoomStore } from '../net/identity.js'
import type { MemberView, Room, RoomState } from '../net/room.js'
import { PlayerController, type PlayerControllerOptions } from '../player/player-controller.js'
import type { SyncEngine } from '../sync/engine.js'
import type { PeerWarning } from '../../shared/peer-warnings.js'
import type { ResyncOutcome } from '../../shared/ipc/core.js'
import type { PeerTransferStats } from '../transfer/engine.js'
import { BaseSession, type MpvChoice, type SessionDeps } from './base-session.js'
import type { FakePlayer } from './fake-player.js'
import type { PlayerHolder } from './player-holder.js'
import { SYNC_BUS_POLICIES } from './sync-ports.js'

// BaseSession.mpvChanged: an mpv fixed mid-session replaces the player, but never once a leave started.
// BaseSession's player options: sync's member is the only one to reload, and the hooks read the session lazily.

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

const fakeRoom = {
  state: () =>
    ({
      roomId: 'r1',
      name: 'Room',
      nat: { class: 'open', host: null },
      relay: { status: 'none', key: null },
      admission: 'open',
      maxMembers: 8,
      pending: [],
      self: 'me',
      hostKey: 'me',
    }) as unknown as RoomState,
  invite: () => ({ link: 'wt://invite' }),
  on: () => undefined,
  members: () => [],
} as unknown as Room

class TestSession extends BaseSession {
  readonly role: 'host' | 'viewer' = 'host'
  replaced = 0
  blocked = false

  constructor(deps: SessionDeps, room: Room = fakeRoom) {
    super(deps, room)
  }

  openPlayer(): PlayerHolder {
    return this.createPlayer({ title: 'clip.mkv', subtitles: () => [] })
  }

  /** the host's sync on stub media */
  startHostSync(): SyncEngine {
    return this.startSync({
      media: {
        durationS: () => 600,
        readiness: () => true,
        bufferedAheadS: () => 600,
        needBps: () => 0,
        playhead: { set: () => undefined },
        onChange: () => () => undefined,
      },
      transfer: { rateBps: () => 0, etaToEofS: () => 0, coverage: () => null, diskFull: () => false },
      host: {
        syncEpoch: 7,
        perms: { othersPlayPause: false, othersSeek: false },
        waitForAll: true,
        startMode: { kind: 'buffered', seconds: 0 },
      },
      subtitles: () => [],
    })
  }

  /** what startSync sets; null again once a leave stopped it */
  setSync(engine: Pick<SyncEngine, 'roomPosition'> | null): void {
    this.sync = engine as SyncEngine | null
  }

  protected override readerBlocked(): boolean {
    return this.blocked
  }

  /** what a leave does first, synchronously */
  beginLeave(): void {
    this.stopping = true
  }

  async finishLeave(): Promise<void> {
    await this.teardown()
  }

  protected override onRoomClosed(): void {}
  protected override keepAwake(): boolean {
    return true
  }
  protected override onPlayerReplaced(): void {
    this.replaced++
  }
  protected override transferPeers(): readonly PeerTransferStats[] {
    return []
  }
  protected override onPeersTick(): void {}
  protected override applyUploadLimit(): void {}
}

const MISSING: MpvChoice = { binary: null, unavailable: 'missing' }
const FOUND: MpvChoice = {
  binary: { path: '/opt/mpv/mpv', kind: 'system', version: { major: 0, minor: 40, patch: 0, suffix: '' } },
}

function deps(extra: Partial<SessionDeps> = {}): SessionDeps {
  return {
    paths: { userData: '/tmp/wt-none', logsDir: '/tmp/wt-none', downloadDir: '/tmp/wt-none', resources: 'resources' },
    settings: () => defaultSettings(),
    theme: () => themePayload('system', 'light'),
    mpv: () => MISSING,
    appVersion: '0.0.0-test',
    emit: () => undefined,
    clearEvent: () => undefined,
    store: {} as RoomStore,
    fakePlayer: false,
    control: { power: () => undefined, mpvPid: () => undefined, showApp: () => undefined },
    log: quiet as unknown as CoreLog,
    ...extra,
  }
}

function setup(extra: Partial<SessionDeps> = {}): {
  session: TestSession
  holder: PlayerHolder
  mpv: { choice: MpvChoice }
  started: unknown[]
} {
  const mpv = { choice: MISSING }
  const session = new TestSession(deps({ mpv: () => mpv.choice, ...extra }))
  const holder = session.openPlayer()
  expect(holder.status).toBe('missing')
  // record starts instead of spawning an mpv
  const started: unknown[] = []
  vi.spyOn(PlayerController.prototype, 'start').mockImplementation(function (this: PlayerController) {
    started.push(this)
  })
  return { session, holder, mpv, started }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('BaseSession.mpvChanged', () => {
  it('replaces a player that could not start, and starts the new one', async () => {
    const { session, holder, mpv, started } = setup()
    const old = holder.player
    mpv.choice = FOUND
    await session.mpvChanged()
    expect(holder.player).not.toBe(old)
    expect(started).toEqual([holder.player])
    expect(session.replaced).toBe(1)
    await session.finishLeave()
  })

  it('does nothing once a leave started (a viewer exporting after teardown): no mpv nobody would quit', async () => {
    const { session, holder, mpv, started } = setup()
    const old = holder.player
    session.beginLeave()
    await session.finishLeave()
    mpv.choice = FOUND
    await session.mpvChanged()
    expect(holder.player).toBe(old)
    expect(started).toEqual([])
    expect(session.replaced).toBe(0)
  })

  it('disposes the new player instead of starting it when the leave begins during the swap', async () => {
    const { session, holder, mpv, started } = setup()
    const old = holder.player
    const disposed: unknown[] = []
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each player as this
    const dispose = PlayerController.prototype.dispose
    vi.spyOn(PlayerController.prototype, 'dispose').mockImplementation(function (this: PlayerController) {
      disposed.push(this)
      if (this === old) session.beginLeave() // the swap disposes the old player: the leave starts meanwhile
      return dispose.call(this)
    })
    mpv.choice = FOUND
    await session.mpvChanged()
    const next = holder.player
    expect(next).not.toBe(old)
    expect(started).toEqual([])
    expect(disposed).toEqual([old, next])
    expect(session.replaced).toBe(0)
    await session.finishLeave()
  })
})

/** The options the session built its PlayerController with. */
const optionsOf = (holder: PlayerHolder): PlayerControllerOptions =>
  (holder.player as unknown as { opts: PlayerControllerOptions }).opts

describe('BaseSession player options', () => {
  it("leaves every reload to sync's member: no second loadfile racing the member's own", async () => {
    const { session, holder } = setup()
    expect(holder.player).toBeInstanceOf(PlayerController)
    expect(optionsOf(holder).selfReload).toBe(false)
    await session.finishLeave()
  })

  it('asks the session whether a stream read is blocked, each time (the viewer overrides it)', async () => {
    const { session, holder } = setup()
    const blocked = optionsOf(holder).hooks?.readerBlocked
    expect(blocked?.()).toBe(false)
    session.blocked = true
    expect(blocked?.()).toBe(true)
    await session.finishLeave()
  })

  it("restarts at the room position, or (sync stopped) at the player's own last position rather than 0", async () => {
    const { session, holder } = setup()
    const restartAt = optionsOf(holder).hooks?.restartPosition
    session.setSync({ roomPosition: () => 42.5 })
    expect(restartAt?.()).toBe(42.5)
    session.setSync({ roomPosition: () => null })
    expect(restartAt?.()).toBeNull()
    session.setSync(null)
    expect(restartAt?.()).toBeNull()
    await session.finishLeave()
  })

  it("passes the deps' extra mpv arguments (real-mpv session tests run it headless)", async () => {
    const plain = setup()
    expect(optionsOf(plain.holder).extraArgs).toBeUndefined()
    await plain.session.finishLeave()
    vi.restoreAllMocks()
    const headless = setup({ mpvExtraArgs: ['--vo=null', '--ao=null'] })
    expect(optionsOf(headless.holder).extraArgs).toEqual(['--vo=null', '--ao=null'])
    await headless.session.finishLeave()
  })
})

describe('BaseSession.startSync', () => {
  it("defines sync's bus rates before the engine subscribes to the bus", async () => {
    const calls: string[] = []
    const room = {
      state: () => fakeRoom.state(),
      invite: () => fakeRoom.invite(),
      on: () => undefined,
      members: () => [],
      off: () => undefined,
      defineMessage: (name: string) => calls.push(`define ${name}`),
      onMessage: (ns: string) => {
        calls.push(`subscribe ${ns}`)
        return () => undefined
      },
      onDatagram: () => () => undefined,
    } as unknown as Room
    const session = new TestSession(deps(), room)
    session.openPlayer()
    session.startHostSync()
    const firstSubscribe = calls.findIndex((c) => c.startsWith('subscribe'))
    const defined = calls.slice(0, firstSubscribe)
    expect(firstSubscribe).toBeGreaterThan(0)
    for (const name of Object.keys(SYNC_BUS_POLICIES)) expect(defined).toContain(`define ${name}`)
    await session.finishLeave()
  })
})

describe('BaseSession.updateSettings', () => {
  // the fake room, plus the room settings updateSettings passes on first
  const room = Object.assign(Object.create(fakeRoom) as Room, { updateSettings: () => undefined })

  class ViewerLike extends TestSession {
    readonly limits: (number | null)[] = []
    protected override applyDownloadLimit(kbps: number | null): void {
      this.limits.push(kbps)
    }
  }

  it('applies the download limit live; a host-shaped session ignores it', () => {
    const viewer = new ViewerLike(deps(), room)
    viewer.updateSettings({ ...defaultSettings(), uploadLimitKBps: 200, downloadLimitKBps: 300 })
    viewer.updateSettings({ ...defaultSettings(), downloadLimitKBps: null })
    expect(viewer.limits).toEqual([300, null])
    expect(() =>
      new TestSession(deps(), room).updateSettings({ ...defaultSettings(), downloadLimitKBps: 300 }),
    ).not.toThrow()
  })
})

describe('BaseSession room event', () => {
  it('names the member who relayed a pending join request, and no one for a request that came straight', () => {
    const rooms: RoomEvent[] = []
    const pending = [
      { id: 'a1', name: 'Ann' },
      { id: 'b2', name: 'Bo', via: 'Kim' },
    ]
    const room = {
      state: () => ({ ...fakeRoom.state(), pending }),
      invite: () => ({ link: 'wt://invite' }),
      on: () => undefined,
      members: () => [],
    } as unknown as Room
    const emit = ((event: string, data: unknown) => {
      if (event === 'room') rooms.push(data as RoomEvent)
    }) as SessionDeps['emit']
    new TestSession(deps({ emit }), room)
    expect(rooms.at(-1)?.pending).toEqual([
      { id: 'a1', name: 'Ann' },
      { id: 'b2', name: 'Bo', via: 'Kim' },
    ])
  })
})

describe('BaseSession in mpv', () => {
  const member = (id: string, name: string, self = false): MemberView => ({
    id,
    name,
    role: self ? 'host' : 'viewer',
    self,
    isHost: self,
    path: self ? 'none' : 'direct',
    rttMs: 20,
    linked: true,
  })
  const room = Object.assign(Object.create(fakeRoom) as Room, {
    members: () => [member('me', 'Host', true), member('v1', 'Sam')],
  })

  /** A session on a FakePlayer, as host or viewer, with the session's warnings and sync's resync stubbed. */
  class InMpv extends TestSession {
    override readonly role: 'host' | 'viewer'
    warnings = new Map<string, readonly PeerWarning[]>()
    resyncs: ResyncOutcome[] = []
    outcome: ResyncOutcome = 'skip'

    constructor(role: 'host' | 'viewer') {
      super(deps({ fakePlayer: true }), room)
      this.role = role
      // sync's resync, recorded; stop for the leave
      const sync: Pick<SyncEngine, 'roomPosition' | 'resync' | 'stop'> = {
        roomPosition: () => null,
        resync: () => {
          this.resyncs.push(this.outcome)
          return this.outcome
        },
        stop: () => undefined,
      }
      this.setSync(sync)
    }
    get fake(): FakePlayer {
      return this.playerHolder()?.player as FakePlayer
    }
    toasts(): unknown[] {
      return this.fake.oscLog.filter((o) => o.kind === 'toast').map((o) => o.payload)
    }
    tick(): void {
      this.emitPeers()
    }
    protected override peerWarnings(): ReadonlyMap<string, readonly PeerWarning[]> {
      return this.warnings
    }
  }
  const slow: PeerWarning = { code: 'slow-download', rateBps: null, needBps: null, bufferInS: null, limitBps: null }

  it("the host toasts a member's slow download once as it appears; not 'behind' or frame drops", async () => {
    const host = new InMpv('host')
    host.openPlayer()
    host.warnings.set('v1', [{ code: 'behind', behindS: 3 }, { code: 'frame-drops' }])
    host.tick()
    expect(host.toasts()).toEqual([])
    host.warnings.set('v1', [{ code: 'behind', behindS: 3 }, slow, { code: 'frame-drops' }])
    host.tick()
    host.tick()
    expect(host.toasts()).toEqual([{ text: 'Sam: download too slow' }])
    await host.finishLeave()
  })

  it('a viewer never toasts other rows', async () => {
    const viewer = new InMpv('viewer')
    viewer.openPlayer()
    viewer.warnings.set('v1', [slow])
    viewer.tick()
    expect(viewer.toasts()).toEqual([])
    await viewer.finishLeave()
  })

  it('Shift+R or the bar button resyncs a viewer, toasting only what changed nothing; the host has no resync', async () => {
    const viewer = new InMpv('viewer')
    viewer.openPlayer()
    const press = (s: InMpv): void => void s.fake.emit('intent', { kind: 'resync', src: 'osc', seq: 1 })
    // a catch-up shows itself in the status line: no toast
    press(viewer)
    expect(viewer.resyncs).toEqual(['skip'])
    expect(viewer.toasts()).toEqual([])
    for (const outcome of ['in-sync', 'not-playing', 'not-ready', 'busy'] as const) {
      viewer.outcome = outcome
      press(viewer)
    }
    expect(viewer.toasts()).toEqual([
      { text: 'Already in sync' },
      { text: "The room isn't playing" },
      { text: 'Playback is not ready yet' },
    ])
    await viewer.finishLeave()

    const host = new InMpv('host')
    host.openPlayer()
    host.outcome = 'in-sync'
    press(host)
    expect(host.resyncs).toEqual([])
    expect(host.toasts()).toEqual([])
    await host.finishLeave()
  })
})
