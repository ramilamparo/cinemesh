import { randomInt } from 'node:crypto'
import { inspect } from 'node:util'
import type { CorePaths } from '../../shared/ipc/control.js'
import type {
  CoreEventName,
  CoreEvents,
  NoticeEvent,
  PlaybackIntent,
  Role,
  RoomEvent,
  SessionEvent,
  Span,
  SyncEvent,
} from '../../shared/ipc/core.js'
import type { Settings } from '../../shared/settings.js'
import type { ThemePayload } from '../../shared/theme-tokens.js'
import type { CoreLog } from '../log.js'
import type { Room, RoomState } from '../net/room.js'
import type { RoomStore } from '../net/identity.js'
import type { OscPeer } from '../player/osc-bridge.js'
import { type MpvBinary, PlayerController, type SubtitleSpec } from '../player/player-controller.js'
import { type PeerSync, SyncEngine, type SyncEngineOptions } from '../sync/engine.js'
import type { MediaPort, TransferPort } from '../sync/ports.js'
import type { PeerTransferStats } from '../transfer/engine.js'
import { FakePlayer } from './fake-player.js'
import { mergePeerViews } from './peer-view.js'
import { PlayerHolder } from './player-holder.js'
import type { SessionFile } from './session-file.js'
import {
  BusPortAdapter,
  DatagramPortAdapter,
  PlayerPortAdapter,
  createClock,
  defineSyncPolicies,
  toggleKind,
} from './sync-ports.js'

export interface MpvChoice {
  binary: MpvBinary | null
  unavailable?: 'missing' | 'tooOld'
}

/** What every session needs from core (built once in src/core/index.ts). */
export interface SessionDeps {
  paths: CorePaths
  settings: () => Settings
  theme: () => ThemePayload
  mpv: () => MpvChoice
  appVersion: string
  emit: <E extends CoreEventName>(event: E, data: CoreEvents[E]) => void
  clearEvent: (event: Exclude<CoreEventName, 'notice'>) => void
  store: RoomStore
  fakePlayer: boolean
  /** appended to mpv's arguments (session tests with a real mpv: --vo=null --ao=null) */
  mpvExtraArgs?: readonly string[]
  control: {
    power(keepAwake: boolean): void
    mpvPid(pid: number | null): void
    showApp(): void
  }
  log: CoreLog
}

const PEERS_MS = 1000

/**
 * What host and viewer sessions share: the room, the player (through a swappable holder), the sync engine
 * and its port adapters, UI events (session, room, peers, sync, playback, player, tracks, notices) and leave.
 * Subclasses add the transfer, media and timeline specifics.
 */
export abstract class BaseSession {
  abstract readonly role: Role
  protected sessionEvent: SessionEvent
  protected player: PlayerHolder | null = null
  protected sync: SyncEngine | null = null
  protected readonly clock = createClock()
  protected readonly timers: ReturnType<typeof setInterval>[] = []
  protected readonly unsubs: (() => void)[] = []
  protected file: SessionFile | null = null
  protected stopped = false
  /** set synchronously when a leave starts, so async steps still running stand down */
  protected stopping = false

  /** A method, not the field: TS narrowing would otherwise keep `stopped` false across awaits. */
  protected isStopped(): boolean {
    return this.stopped || this.stopping
  }
  private lastSync: SyncEvent | null = null
  private oscPeersKey = ''

  protected constructor(
    protected readonly deps: SessionDeps,
    readonly room: Room,
  ) {
    this.sessionEvent = {
      phase: 'connecting',
      role: null,
      roomId: room.state().roomId,
      fileName: null,
      fileSize: null,
      durationS: null,
    }
    room.on('state', (s) => this.onRoomState(s))
    room.on('members', () => this.emitRoom())
    this.emitRoom()
  }

  get roomId(): string {
    return this.room.state().roomId
  }

  get phase(): SessionEvent['phase'] {
    return this.sessionEvent.phase
  }

  // ---- UI events ----------------------------------------------------------------------------

  protected setSession(patch: Partial<SessionEvent>): void {
    this.sessionEvent = { ...this.sessionEvent, ...patch }
    this.deps.emit('session', this.sessionEvent)
    this.updatePower()
  }

  /** Re-evaluated on every phase change and once a second; control.power sends only changes (core/index.ts). */
  protected updatePower(): void {
    const idlePhases: SessionEvent['phase'][] = ['error', 'ended', 'confirm-join', 'pending-admission', 'idle']
    this.deps.control.power(!this.isStopped() && !idlePhases.includes(this.sessionEvent.phase) && this.keepAwake())
  }

  protected notice(n: NoticeEvent): void {
    this.deps.emit('notice', n)
    if (n.level !== 'info' || n.code.startsWith('sync.')) this.player?.osc('toast', { text: n.message })
  }

  protected emitRoom(): void {
    const s = this.room.state()
    const invite = this.room.invite()
    const event: RoomEvent = {
      roomId: s.roomId,
      name: s.name,
      invite: invite.link,
      nat: { class: s.nat.class, host: s.nat.host },
      relay: { status: s.relay.status },
      admission: s.admission,
      maxMembers: s.maxMembers,
      // via: the member that relayed the request, for a joiner that cannot reach the host (the admission list says it)
      pending: s.pending.map((p) => ({ id: p.id, name: p.name, ...(p.via !== undefined ? { via: p.via } : {}) })),
    }
    this.deps.emit('room', event)
  }

  protected onRoomState(s: RoomState): void {
    this.emitRoom()
    // our own leave closes the room too ('ended' when the host ends it): not the room going away under us
    if (this.isStopped()) return
    if (s.phase === 'kicked' || s.phase === 'ended' || s.phase === 'denied' || s.phase === 'error') {
      this.onRoomClosed(s)
    }
  }

  /** The room ended or refused us; subclasses decide what to keep. */
  protected abstract onRoomClosed(s: RoomState): void

  /** Keep the computer awake while hosting, preparing or downloading (main's powerSaveBlocker). */
  protected abstract keepAwake(): boolean

  // ---- player ---------------------------------------------------------------------------------

  protected createPlayer(opts: { title: string | null; subtitles: () => SubtitleSpec[] }): PlayerHolder {
    const holder = new PlayerHolder(this.newPlayerInstance(opts.title))
    this.player = holder
    holder.on('status', (e) => this.deps.emit('player', e))
    holder.on('tracks', (t) => this.deps.emit('tracks', t))
    holder.on('intent', (i) => {
      if (i.kind === 'show-app') this.deps.control.showApp()
    })
    holder.on('state', (next) => {
      if (next === 'closedByUser')
        this.notice({ level: 'info', code: 'player.closed', message: 'Player closed. You are still in the room.' })
    })
    holder.on('oscReady', () => this.syncOscState())
    holder.start()
    this.deps.emit('player', holder.playerEvent())
    return holder
  }

  private newPlayerInstance(title: string | null): PlayerController | FakePlayer {
    if (this.deps.fakePlayer) return new FakePlayer({ durationS: this.sessionEvent.durationS ?? 600 })
    const { binary, unavailable } = this.deps.mpv()
    const s = this.deps.settings()
    const extraArgs = this.deps.mpvExtraArgs ?? []
    return new PlayerController({
      mpv: binary,
      ...(unavailable ? { unavailable } : {}),
      role: this.role,
      resourcesDir: this.deps.paths.resources,
      logFile: `${this.deps.paths.logsDir}/mpv.log`,
      settings: s,
      theme: this.deps.theme(),
      perms: { isHost: this.role === 'host', canPlayPause: this.role === 'host', canSeek: this.role === 'host' },
      mediaTitle: title,
      ...(extraArgs.length > 0 ? { extraArgs: [...extraArgs] } : {}),
      // Sync's member is the one owner of loadfile: after a restart, a Reopen or another client's file it loads
      // at its own rendezvous (two owners race, and mpv ends up where the later loadfile put it).
      selfReload: false,
      hooks: {
        resolveToggle: () => toggleKind(this.sync?.member.state),
        // from our newest unanswered seek, if any: a held arrow key's repeats add up (SyncEngine.seekBase)
        resolveSeekRel: (d) =>
          Math.max(
            0,
            Math.min((this.sync?.seekBase() ?? 0) + d, this.sessionEvent.durationS ?? Number.POSITIVE_INFINITY),
          ),
        // null once sync has stopped: the controller falls back to the position it last saw, not 0
        restartPosition: () => this.sync?.roomPosition() ?? null,
        readerBlocked: () => this.readerBlocked(),
        onPid: (pid) => this.deps.control.mpvPid(pid),
      },
      log: {
        debug: (m) => this.deps.log.debug(`[mpv] ${m}`),
        info: (m) => this.deps.log.info(`[mpv] ${m}`),
        warn: (m) => this.deps.log.warn(`[mpv] ${m}`),
        error: (m, e) => this.deps.log.error(`[mpv] ${m}`, e),
      },
    })
  }

  /**
   * The mpv lookup changed (settings or recheck): replace a player that could not start. Never once a leave
   * has started (a viewer's export runs after teardown): nothing would quit an mpv started then.
   */
  async mpvChanged(): Promise<void> {
    const holder = this.player
    if (this.isStopped() || !holder || (holder.status !== 'missing' && holder.status !== 'tooOld')) return
    const next = this.newPlayerInstance(this.sessionEvent.fileName)
    await holder.swap(next)
    if (this.isStopped()) {
      await next.dispose() // the leave began while the old one was disposed
      return
    }
    next.start()
    this.onPlayerReplaced()
  }

  /** After a player swap: subclasses reload their source. */
  protected abstract onPlayerReplaced(): void

  /**
   * A stream-server read of the loaded file waits on a missing piece: the player then reloads instead of
   * seeking (ADR 0004 §5). Read lazily by the player. Never on the host, which plays its local file.
   */
  protected readerBlocked(): boolean {
    return false
  }

  // ---- sync -----------------------------------------------------------------------------------

  protected startSync(opts: {
    media: MediaPort
    transfer: TransferPort
    host?: SyncEngineOptions['host']
    subtitles: () => SubtitleSpec[]
  }): SyncEngine {
    const player = this.player
    if (!player) throw new Error('player first')
    const s = this.room.state()
    const log = (msg: string, e?: unknown): void => {
      this.deps.log.warn(e === undefined ? msg : `${msg}: ${e instanceof Error ? e.message : inspect(e)}`)
    }
    // per-origin rates for what members send, before the engine listens (and on members that only forward)
    defineSyncPolicies(this.room)
    const engine = new SyncEngine({
      role: this.role,
      selfId: s.self,
      selfName: this.deps.settings().displayName,
      hostId: s.hostKey,
      nudge: this.deps.settings().speedNudge,
      ports: {
        clock: this.clock,
        player: new PlayerPortAdapter(player, { subtitles: opts.subtitles, title: this.sessionEvent.fileName, log }),
        bus: new BusPortAdapter(this.room, s.hostKey, log),
        datagram: new DatagramPortAdapter(this.room),
        media: opts.media,
        transfer: opts.transfer,
      },
      ...(opts.host ? { host: opts.host } : {}),
    })
    this.sync = engine
    engine.on('sync', (e) => {
      this.lastSync = e
      this.deps.emit('sync', e)
      this.syncOscState()
    })
    engine.on('playback', (p) => this.deps.emit('playback', p))
    engine.on('notice', (n) => this.notice(n))
    engine.on('peers', (peers) => this.onSyncPeers(peers))
    engine.start()
    this.every(PEERS_MS, () => this.emitPeers())
    return engine
  }

  private latestSyncPeers: PeerSync[] = []

  private onSyncPeers(peers: PeerSync[]): void {
    this.latestSyncPeers = peers
  }

  protected syncPeers(): readonly PeerSync[] {
    return this.latestSyncPeers
  }

  protected abstract transferPeers(): readonly PeerTransferStats[]

  protected emitPeers(): void {
    const views = mergePeerViews(this.room.members(), this.latestSyncPeers, this.transferPeers())
    this.deps.emit('peers', views)
    const colors = this.deps.theme().peers
    const osc: OscPeer[] = views
      .filter((v) => !v.self && typeof v.posS === 'number')
      .map((v, i) => ({
        id: v.id,
        name: v.name,
        color: colors[i % colors.length] ?? '#888888',
        pos: v.posS ?? 0,
        state: v.phase,
      }))
    const key = JSON.stringify(osc)
    if (key !== this.oscPeersKey) {
      this.oscPeersKey = key
      this.player?.osc('peers', osc)
    }
    this.onPeersTick()
    this.updatePower()
  }

  /** 1 Hz, after peers were emitted: subclasses refresh timeline/transfer events. */
  protected abstract onPeersTick(): void

  private syncOscState(): void {
    const e = this.lastSync
    const player = this.player
    if (!player) return
    player.osc('perms', {
      isHost: this.role === 'host',
      canPlayPause: e?.canPlayPause ?? this.role === 'host',
      canSeek: e?.canSeek ?? this.role === 'host',
    })
    player.osc('ended', { ended: e?.mode === 'ended' })
    const waiting = e?.wait ? `Waiting for ${e.wait.waitingFor.join(', ') || 'everyone'}…` : ''
    player.osc('status', { text: waiting, level: 'info' })
  }

  // ---- requests -------------------------------------------------------------------------------

  async intent(
    i: PlaybackIntent,
  ): Promise<{ accepted: boolean; reason?: NonNullable<Awaited<ReturnType<SyncEngine['intent']>>['reason']> }> {
    if (!this.sync) return { accepted: false, reason: 'not-ready' }
    return this.sync.intent(i)
  }

  syncEngine(): SyncEngine | null {
    return this.sync
  }

  playerHolder(): PlayerHolder | null {
    return this.player
  }

  updateSettings(s: Settings): void {
    this.room.updateSettings({
      udpPort: s.udpPort,
      bootstrapExtra: s.bootstrapExtra,
      relayKey: s.relayKey,
      alwaysRelay: s.alwaysRelay,
    })
    this.sync?.setNudge(s.speedNudge)
    this.applyUploadLimit(s.uploadLimitKBps)
  }

  /** Live upload-limit changes (Settings or the host panel). */
  protected abstract applyUploadLimit(kbps: number | null): void

  updateTheme(t: ThemePayload): void {
    this.player?.osc('theme', t)
  }

  protected every(ms: number, fn: () => void): void {
    const t = setInterval(fn, ms)
    t.unref()
    this.timers.push(t)
  }

  /** Stops everything this session started. The room is left (or ended) by the caller first. */
  protected async teardown(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    try {
      for (const u of this.unsubs) u()
      this.sync?.stop()
      await this.player?.quit().catch(() => undefined)
      await this.player?.dispose().catch(() => undefined)
      this.clock.dispose()
      await this.file?.flush()
    } finally {
      // whatever failed above, the UI must not keep a dead room's state and the computer may sleep again
      for (const e of ['peers', 'playback', 'sync', 'timeline', 'transfer', 'tracks', 'prepare'] as const) {
        this.deps.clearEvent(e)
      }
      this.deps.control.power(false)
    }
  }

  static randomEpoch(): number {
    return randomInt(1, 2 ** 32 - 1)
  }

  static bufferedOf(player: PlayerHolder | null): Span[] {
    return player ? player.buffered() : []
  }
}
