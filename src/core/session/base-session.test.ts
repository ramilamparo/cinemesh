import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '../../shared/settings.js'
import { themePayload } from '../../shared/theme-tokens.js'
import type { RoomEvent } from '../../shared/ipc/core.js'
import type { CoreLog } from '../log.js'
import type { RoomStore } from '../net/identity.js'
import type { Room, RoomState } from '../net/room.js'
import { PlayerController, type PlayerControllerOptions } from '../player/player-controller.js'
import type { SyncEngine } from '../sync/engine.js'
import type { PeerTransferStats } from '../transfer/engine.js'
import { BaseSession, type MpvChoice, type SessionDeps } from './base-session.js'
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
  readonly role = 'host' as const
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
