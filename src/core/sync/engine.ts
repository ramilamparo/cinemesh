import { EventEmitter } from 'node:events'
import type {
  IntentRejection,
  NoticeEvent,
  PeerView,
  PlaybackEvent,
  PlaybackIntent,
  Perms,
  ResyncOutcome,
  Role,
  SyncEvent,
} from '../../shared/ipc/core.js'
import type { StartMode } from '../../shared/settings.js'
import { CLOCK, ClockClient, type OffsetEstimator, pong } from './clock.js'
import type { DesyncInfo } from './desync.js'
import { GroupController, type GroupNotice, type GroupSnapshot } from './group.js'
import { MemberController } from './member.js'
import { type Clock, every, type PresenceEvent, type SyncPorts, type TimerHandle, type Unsubscribe } from './ports.js'
import {
  DGRAM_PING,
  DGRAM_PONG,
  DGRAM_STATE_FAST,
  decodeDatagram,
  encodeDatagram,
  type IntentKind,
  parseBusMessage,
  type SyncBusMessage,
  type SyncState,
  type SyncStatus,
  type WarningCode,
} from './protocol.js'

// Composes clock, group (host only) and member for one role from the ports, and turns their state into the
// UI-facing sync / playback / peers / notice events of src/shared/ipc/core.ts.

export const ENGINE = {
  INTENT_TIMEOUT_MS: 5000,
  /**
   * A viewer's intents go out one at a time (the next when the last one's result is back), at most INTENT_BURST
   * in a row and then one per INTENT_EVERY_MS: inside the bus's per-origin rate for sync.intent (SYNC_BUS_POLICIES,
   * 5 then one per 250 ms), with a token to spare for jitter, so a held arrow key never trips that flood guard.
   */
  INTENT_BURST: 4,
  INTENT_EVERY_MS: 300,
  /** StateFast copies, ms after the publish */
  FAST_REPEATS_MS: [0, 30, 100],
  PEERS_MS: 1000,
  /** causes older than this (a sticky replay after a reconnect or a late join) apply silently */
  CAUSE_FRESH_MS: 3000,
  /**
   * The host answers a member's sync.hello at most this often, the last one late. Its answer is the sticky
   * sync.state, which goes to everyone (net cannot address a sticky name) and every member forwards.
   */
  HELLO_EVERY_MS: 1000,
  /** Ask host notices: at most one per member this often, the latest request shown late */
  REQUEST_EVERY_MS: 2000,
} as const

export interface SyncEngineOptions {
  role: Role
  selfId: string
  selfName: string
  hostId: string
  ports: SyncPorts
  /** the user's speed-nudge setting */
  nudge: boolean
  /** viewer: the user's desync warning setting (ms behind; 0 or absent = off); the host never warns itself */
  desyncWarnMs?: number
  /**
   * Viewer: the host's clock estimate from the engine this one replaces (a playlist's next item, ADR 0011 §4). The
   * host process is the same, so the estimate holds and playback need not wait for a fresh one.
   */
  clockEstimator?: OffsetEstimator
  /**
   * Viewer: the sync epoch whose states this engine applies, read on each state; null applies any (a host without a
   * playlist). A playlist runs one epoch per item, and the next item's first states can arrive before the
   * playlist says it changed: applied here, they would move the previous file.
   */
  acceptEpoch?: () => number | null
  /** host only */
  host?: {
    syncEpoch: number
    perms: Perms
    waitForAll: boolean
    startMode: StartMode
    resume?: GroupSnapshot | undefined
  }
}

export interface IntentOutcome {
  accepted: boolean
  reason?: IntentRejection
}

/** A viewer's intent on its way to the host: queued, then in flight (with its id) until its result or timeout. */
interface Outgoing {
  kind: IntentKind
  pos: number | undefined
  resolve: (o: IntentOutcome) => void
  timer: TimerHandle
  intentId: string | null
}

/**
 * The sync-owned fields of a PeerView; the lead merges them with net and transfer fields, and turns the member's
 * warning codes into PeerView.warnings (session/peer-view.ts).
 */
export type PeerSync = Pick<
  PeerView,
  'id' | 'name' | 'phase' | 'driftMs' | 'bufferedAheadS' | 'coverage' | 'exempt' | 'posS'
> & {
  warnings: readonly WarningCode[]
  /** seconds behind the room while the member's own desync warning shows ('behind'), else null */
  behindS: number | null
  rateBps: number | null
  needBps: number | null
  lagMs: number | null
  clockErrMs: number | null
  /** the member's own download limit, bytes/s, from its sync.status; null = none (or an older viewer) */
  downLimitBps: number | null
}

export interface ClockInfo {
  offsetMs: number | null
  errorMs: number | null
  /** ε above 150 ms: the UI shows a "poor clock" badge */
  poor: boolean
  via: 'datagram' | 'bus' | 'loopback'
}

export interface SyncEngineEvents {
  sync: [SyncEvent]
  playback: [PlaybackEvent]
  peers: [PeerSync[]]
  notice: [NoticeEvent]
  /** host: write session.json, at once when seq changed (every publish); the 5 s position updates may be debounced */
  persist: [GroupSnapshot]
  /** every newly applied sync.state, e.g. for the OSC's perms and peer markers */
  state: [SyncState]
  clock: [ClockInfo]
}

export class SyncEngine extends EventEmitter<SyncEngineEvents> {
  readonly member: MemberController
  readonly group: GroupController | null
  private readonly clockClient: ClockClient | null
  /** viewer: intents not sent yet, in order, and the one the host has not answered yet */
  private outbox: Outgoing[] = []
  private inFlight: Outgoing | null = null
  /** viewer: the send pacing's token bucket (ENGINE.INTENT_BURST, one more per INTENT_EVERY_MS) */
  private sendTokens: number = ENGINE.INTENT_BURST
  private sendTokensAt: number
  private sendTimer: TimerHandle | null = null
  private readonly idPrefix: string
  private intentCounter = 0
  private subs: Unsubscribe[] = []
  private timers: TimerHandle[] = []
  private lastCauseKey = ''
  private seenState = false
  /** epoch and sentAt of the last applied state, and the last restore seen: a restarted host shows in them */
  private lastApplied: { syncEpoch: number; sentAt: number } | null = null
  private lastRestoreKey = ''
  /** names the last barrier waited for, for "Started without Sam" */
  private lastWaitingFor: string[] = []
  /** the member's desync warning, as last emitted (SyncEvent.desync) */
  private desync: DesyncInfo | null = null
  private readonly helloAnswers: Coalescer
  private readonly requestNotices: Coalescer
  private readonly p: SyncPorts

  constructor(private readonly o: SyncEngineOptions) {
    super()
    this.p = o.ports
    const { clock } = o.ports
    this.idPrefix = `${o.selfId.slice(0, 16)}:${Math.floor(clock.now()).toString(36)}`
    this.sendTokensAt = clock.now()
    const isHost = o.role === 'host'
    if (isHost && !o.host) throw new Error('host options are required for the host role')
    this.helloAnswers = new Coalescer(clock, ENGINE.HELLO_EVERY_MS)
    this.requestNotices = new Coalescer(clock, ENGINE.REQUEST_EVERY_MS)
    this.clockClient = isHost
      ? null
      : new ClockClient({
          clock,
          datagramUsable: () => this.p.datagram.usable(o.hostId),
          send: (via, id, t0) => {
            if (via === 'datagram') this.p.datagram.send(o.hostId, encodeDatagram({ type: DGRAM_PING, id, t0 }))
            else this.p.bus.publish({ t: 'sync.ping', id, t0 }, { to: o.hostId })
          },
          onOffset: (_theta, jumped) => {
            this.member.onOffset(jumped)
            this.emit('clock', this.clockInfo())
          },
          ...(o.clockEstimator ? { estimator: o.clockEstimator } : {}),
        })
    this.member = new MemberController({
      clock,
      player: o.ports.player,
      media: o.ports.media,
      transfer: o.ports.transfer,
      offset: () => (this.clockClient ? this.clockClient.offset : 0),
      clockErrMs: () => (this.clockClient ? this.clockClient.errorMs : 0),
      nudge: o.nudge,
      desyncWarnMs: isHost ? 0 : (o.desyncWarnMs ?? 0),
    })
    this.group =
      isHost && o.host
        ? new GroupController({
            clock,
            selfId: o.selfId,
            selfName: o.selfName,
            syncEpoch: o.host.syncEpoch,
            perms: o.host.perms,
            waitForAll: o.host.waitForAll,
            startMode: o.host.startMode,
            resume: o.host.resume,
            hooks: {
              publish: (st) => this.fanOut(st),
              persist: (snap) => this.emit('persist', snap),
              notice: (n) => this.groupNotice(n),
              hostPosition: () => this.member.localPosition(),
            },
          })
        : null
  }

  start(): void {
    const { bus, datagram, player, clock } = this.p
    this.member.on('status', (s) => this.onOwnStatus(s))
    this.member.on('state', (st) => this.onApplied(st))
    this.member.on('playback', (e) => this.emit('playback', e))
    this.member.on('hostGone', (gone) => this.emit('notice', hostGoneNotice(gone)))
    // the sync event again, and nothing else: no state, no cause notice (those belong to a newly applied state)
    this.member.on('desync', (d) => {
      this.desync = d
      const st = this.member.state
      if (st) this.emit('sync', this.toSyncEvent(st))
    })
    this.subs = [
      bus.onMessage((from, raw) => this.onBus(from, raw)),
      datagram.onMessage((from, data) => this.onDatagram(from, data)),
      bus.onPresence((ev) => this.onPresence(ev)),
      player.on('intent', (i) => void this.intent(i)),
    ]
    this.timers = [every(clock, ENGINE.PEERS_MS, () => this.emit('peers', this.peers()))]
    this.member.start()
    this.group?.start()
    if (this.clockClient) {
      this.clockClient.restart({ resetEstimate: !this.o.clockEstimator })
      this.hello()
    }
  }

  /** Viewer: the host clock estimate, for the engine that takes over from this one. */
  clockEstimator(): OffsetEstimator | null {
    return this.clockClient?.estimator ?? null
  }

  private accepts(syncEpoch: number): boolean {
    const want = this.o.acceptEpoch?.() ?? null
    return want === null || syncEpoch === want
  }

  stop(): void {
    for (const u of this.subs) u()
    for (const t of this.timers) t.cancel()
    this.subs = []
    this.timers = []
    this.clockClient?.stop()
    this.helloAnswers.stop()
    this.requestNotices.stop()
    this.group?.stop()
    this.member.stop()
    this.member.removeAllListeners()
    this.sendTimer?.cancel()
    this.sendTimer = null
    const unanswered = [...(this.inFlight ? [this.inFlight] : []), ...this.outbox]
    this.inFlight = null
    this.outbox = []
    for (const e of unanswered) {
      e.timer.cancel()
      e.resolve({ accepted: false, reason: 'timeout' })
    }
  }

  // ---- facade --------------------------------------------------------------------------------

  /** The stream URL (viewer) or local path (host) is ready: load it at the room position. */
  setSource(src: string): void {
    this.member.setSource(src)
  }

  /**
   * Host: the media index is ready, so the room leaves idle (paused at 0, or at the restored anchor).
   * `fullDownload`: the file plays only once completely downloaded, so the first play does not wait for viewers
   * still downloading it (except in the play-through start mode).
   */
  mediaReady(durationS: number, opts: { fullDownload?: boolean } = {}): void {
    this.group?.mediaReady(durationS, opts)
  }

  setNudge(on: boolean): void {
    this.member.setNudge(on)
  }

  /** Viewer: the desync warning setting changed (ms, 0 = off). */
  setDesyncWarn(ms: number): void {
    if (this.group) return
    this.member.setDesyncWarn(ms)
  }

  /** Viewer: playback.resync, local only (MemberController.resync). The host has nothing to resync with. */
  resync(): ResyncOutcome {
    if (this.group) return 'not-ready'
    return this.member.resync()
  }

  roomPosition(): number | null {
    return this.member.roomPosition()
  }

  /**
   * Where relative seeks (seekRel, the OSC's arrows) count from: the target of this member's newest seek the host
   * has not answered yet, else roomPosition(). Presses during a round trip then add up, as they would in a player
   * of one's own, instead of all landing on the same spot.
   */
  seekBase(): number | null {
    for (let i = this.outbox.length - 1; i >= 0; i--) {
      const e = this.outbox[i]
      if (e?.kind === 'seek' && e.pos !== undefined) return e.pos
    }
    if (this.inFlight?.kind === 'seek' && this.inFlight.pos !== undefined) return this.inFlight.pos
    return this.roomPosition()
  }

  snapshot(): GroupSnapshot | null {
    return this.group?.snapshot() ?? null
  }

  syncEvent(): SyncEvent | null {
    const st = this.member.state
    return st ? this.toSyncEvent(st) : null
  }

  setPerms(perms: Perms): void {
    this.group?.setPerms(perms)
  }

  setWaitForAll(on: boolean): void {
    this.group?.setWaitForAll(on)
  }

  setStartMode(mode: StartMode): void {
    this.group?.setStartMode(mode)
  }

  startAnyway(): void {
    this.group?.startAnyway()
  }

  /** Viewer's "Ask host": the host sees a one-click toast. */
  request(kind: IntentKind, posS?: number): void {
    if (this.group) return
    this.p.bus.publish({ t: 'sync.request', kind, ...(posS === undefined ? {} : { pos: posS }) }, { to: this.o.hostId })
  }

  /** playback.intent and OSC input. toggle and seekRel become explicit play/pause/seek here. */
  async intent(i: PlaybackIntent): Promise<IntentOutcome> {
    const st = this.member.state
    if (!st || st.mode === 'idle') return this.rejected({ accepted: false, reason: 'not-ready' }, null)
    const { kind, pos } = this.explicit(i, st)
    if (this.group) {
      const intentId = this.nextIntentId()
      const basedOnSeq = this.group.state()?.seq ?? st.seq
      return this.rejected(this.group.onIntent(this.o.selfId, { intentId, kind, pos, basedOnSeq }), null)
    }
    const perms = st.perms
    if (kind !== 'seek' && !perms.othersPlayPause)
      return this.rejected({ accepted: false, reason: 'perm-playpause' }, { kind, pos })
    if (kind === 'seek' && !perms.othersSeek)
      return this.rejected({ accepted: false, reason: 'perm-seek' }, { kind, pos })
    const outcome = await new Promise<IntentOutcome>((resolve) => this.enqueue(kind, pos, resolve))
    return this.rejected(outcome, { kind, pos })
  }

  // ---- a viewer's outgoing intents -----------------------------------------------------------

  /**
   * In order, one in flight at a time. A seek replaces a seek still waiting to go out (a held arrow key repeats
   * 40 times a second; one intent each would be dropped by the bus's flood guard and time out): only where the
   * viewer let go matters. The replaced one resolves accepted, quietly: the newer seek carries it, and its own
   * result reports any failure. Play and pause are never merged, nor moved past a seek.
   */
  private enqueue(kind: IntentKind, pos: number | undefined, resolve: (o: IntentOutcome) => void): void {
    const tail = this.outbox.at(-1)
    if (kind === 'seek' && tail?.kind === 'seek') {
      this.outbox.pop()
      tail.timer.cancel()
      tail.resolve({ accepted: true })
    }
    const e: Outgoing = { kind, pos, resolve, timer: { cancel: () => undefined }, intentId: null }
    // from the press, not from when it goes out: a host that does not answer is reported 5 s after the press
    e.timer = this.p.clock.setTimer(ENGINE.INTENT_TIMEOUT_MS, () =>
      this.answer(e, { accepted: false, reason: 'timeout' }),
    )
    this.outbox.push(e)
    this.pump()
  }

  /** Sends the next queued intent if none is in flight and the pacing has a token. */
  private pump(): void {
    if (this.inFlight || this.sendTimer || this.outbox.length === 0) return
    const { clock, bus } = this.p
    const now = clock.now()
    const tokens = Math.min(ENGINE.INTENT_BURST, this.sendTokens + (now - this.sendTokensAt) / ENGINE.INTENT_EVERY_MS)
    if (tokens < 1) {
      this.sendTimer = clock.setTimer((1 - tokens) * ENGINE.INTENT_EVERY_MS, () => {
        this.sendTimer = null
        this.pump()
      })
      return
    }
    this.sendTokens = tokens - 1
    this.sendTokensAt = now
    const e = this.outbox.shift()
    if (!e) return
    e.intentId = this.nextIntentId()
    this.inFlight = e
    // the room as of now: the host compares it with its last seek (a queued seek usually follows our own)
    const basedOnSeq = this.member.state?.seq ?? 0
    bus.publish(
      {
        t: 'sync.intent',
        intentId: e.intentId,
        kind: e.kind,
        basedOnSeq,
        ...(e.pos === undefined ? {} : { pos: e.pos }),
      },
      { to: this.o.hostId },
    )
  }

  /** Ends an outgoing intent (its result, or its timeout), and sends the next one. */
  private answer(e: Outgoing, out: IntentOutcome): void {
    e.timer.cancel()
    if (this.inFlight === e) this.inFlight = null
    else this.outbox = this.outbox.filter((x) => x !== e)
    e.resolve(out)
    this.pump()
  }

  private nextIntentId(): string {
    return `${this.idPrefix}:${String(++this.intentCounter)}`
  }

  // ---- wiring --------------------------------------------------------------------------------

  private explicit(i: PlaybackIntent, st: SyncState): { kind: IntentKind; pos?: number } {
    if (i.kind === 'seek') return { kind: 'seek', pos: Math.max(0, i.posS) }
    if (i.kind === 'seekRel') return { kind: 'seek', pos: Math.max(0, (this.seekBase() ?? 0) + i.deltaS) }
    if (i.kind !== 'toggle') return { kind: i.kind }
    const running = st.mode === 'playing' || (st.mode === 'waiting' && st.wait?.resumeAs === 'playing')
    return { kind: running ? 'pause' : 'play' }
  }

  private rejected(out: IntentOutcome, ask: { kind: IntentKind; pos?: number | undefined } | null): IntentOutcome {
    if (!out.accepted && out.reason) this.emit('notice', rejectionNotice(out.reason, ask))
    return out
  }

  private fanOut(st: SyncState): void {
    const { bus, datagram, clock } = this.p
    bus.publish(st, { sticky: true })
    const fast = encodeDatagram({
      type: DGRAM_STATE_FAST,
      syncEpoch: st.syncEpoch,
      seq: st.seq,
      mode: st.mode,
      pos: st.anchor.pos,
      hostTime: st.anchor.hostTime,
      sentAt: st.sentAt,
    })
    for (const m of st.members) {
      if (m.peerId === this.o.selfId || !datagram.usable(m.peerId)) continue
      for (const delay of ENGINE.FAST_REPEATS_MS) {
        if (delay === 0) datagram.send(m.peerId, fast)
        else clock.setTimer(delay, () => datagram.send(m.peerId, fast))
      }
    }
    // Loopback to the host's own member; deferred so group and member never re-enter each other.
    clock.immediate(() => this.member.applyState(st))
  }

  private onOwnStatus(s: SyncStatus): void {
    const group = this.group
    if (group) this.p.clock.immediate(() => group.onStatus(this.o.selfId, s))
    else this.p.bus.publish(s, { to: this.o.hostId })
  }

  private onBus(from: string, raw: unknown): void {
    const msg = parseBusMessage(raw)
    if (!msg) return
    if (this.group) this.onBusAsHost(this.group, from, msg)
    else if (from === this.o.hostId) this.onBusAsViewer(msg)
  }

  private onBusAsHost(group: GroupController, from: string, msg: SyncBusMessage): void {
    const { bus, clock } = this.p
    switch (msg.t) {
      case 'sync.status':
        group.onStatus(from, msg)
        break
      case 'sync.intent': {
        const r = group.onIntent(from, msg)
        bus.publish({ t: 'sync.intentResult', intentId: msg.intentId, ...r }, { to: from })
        break
      }
      case 'sync.request':
        // one toast per member at a time: a member asking again and again replaces its own request
        this.requestNotices.run(from, () => this.emit('notice', requestNotice(this.nameOf(from), msg.kind, msg.pos)))
        break
      case 'sync.hello':
        group.onHello(from)
        // the current state when it goes out: an answer held back is never older than the room
        this.helloAnswers.run(from, () => {
          const st = group.state()
          if (st) bus.publish(st, { to: from })
        })
        break
      case 'sync.ping':
        bus.publish({ t: 'sync.pong', ...pong(clock, msg) }, { to: from })
        break
      default:
        break
    }
  }

  private onBusAsViewer(msg: SyncBusMessage): void {
    switch (msg.t) {
      case 'sync.state':
        if (this.accepts(msg.syncEpoch)) this.member.applyState(msg)
        break
      case 'sync.intentResult': {
        const e = this.inFlight
        if (e?.intentId !== msg.intentId) break
        this.answer(e, msg.reason ? { accepted: msg.accepted, reason: msg.reason } : { accepted: msg.accepted })
        break
      }
      case 'sync.pong':
        this.clockClient?.onPong(msg)
        break
      default:
        break
    }
  }

  private onDatagram(from: string, data: Uint8Array): void {
    const d = decodeDatagram(data)
    if (!d) return
    if (this.group) {
      if (d.type === DGRAM_PING)
        this.p.datagram.send(from, encodeDatagram({ type: DGRAM_PONG, ...pong(this.p.clock, d) }))
      return
    }
    if (from !== this.o.hostId) return
    if (d.type === DGRAM_PONG) this.clockClient?.onPong(d)
    else if (d.type === DGRAM_STATE_FAST && this.accepts(d.syncEpoch)) this.member.applyFast(d)
  }

  private onPresence({ kind, peerId, name, sinceMs }: PresenceEvent): void {
    if (this.group) {
      if (kind === 'join') this.group.addMember(peerId, name)
      else {
        this.group.removeMember(peerId)
        this.helloAnswers.forget(peerId)
        this.requestNotices.forget(peerId)
      }
      return
    }
    if (peerId !== this.o.hostId) return
    if (kind === 'leave') {
      // the grace counts from the host's last word, which for a crash was seconds before anyone could tell
      this.member.hostLeft(sinceMs ?? 0)
      this.clockClient?.stop()
      return
    }
    this.member.hostBack()
    this.clockClient?.restart()
    this.hello()
  }

  private hello(): void {
    const st = this.member.state
    this.p.bus.publish(
      { t: 'sync.hello', resume: st ? { syncEpoch: st.syncEpoch, seq: st.seq } : null },
      { to: this.o.hostId },
    )
  }

  /**
   * A restarted host process has a new clock (performance.now starts over), so θ̂ against the old one is off by
   * about the old uptime and would only wash out of the estimator's window after 12 new samples. A state from a
   * restored group, from another epoch, or sent "before" the previous one says the host restarted: estimate
   * afresh. Runs before the member acts on the state; a null offset makes it wait as a joiner does.
   */
  private checkHostClock(st: SyncState): void {
    const prev = this.lastApplied
    this.lastApplied = { syncEpoch: st.syncEpoch, sentAt: st.sentAt }
    const restoreKey = st.cause?.kind === 'restore' ? JSON.stringify(st.cause) : ''
    const restored = restoreKey !== '' && restoreKey !== this.lastRestoreKey
    if (restored) this.lastRestoreKey = restoreKey
    const restarted = prev !== null && (st.syncEpoch !== prev.syncEpoch || st.sentAt < prev.sentAt)
    if (restored || restarted) this.clockClient?.restart({ resetEstimate: true })
  }

  private onApplied(st: SyncState): void {
    this.checkHostClock(st)
    this.emit('state', st)
    this.emit('sync', this.toSyncEvent(st))
    const c = st.cause
    const waited = st.wait?.waitingFor.map((id) => this.nameOf(id)) ?? []
    if (waited.length > 0) this.lastWaitingFor = waited
    if (!c) return
    const key = JSON.stringify(c)
    if (key === this.lastCauseKey) return
    this.lastCauseKey = key
    const first = !this.seenState
    this.seenState = true
    if (this.causeIsStale(c, first)) return
    const text = causeText(c, this.nameOf(c.by), st, this.lastWaitingFor)
    const own =
      c.by === this.o.selfId && (c.kind === 'play' || c.kind === 'pause' || c.kind === 'seek' || c.kind === 'perms')
    // One code for every cause toast: the UI replaces the previous one, which merges bursts (plan: within 1 s).
    if (text && !own) this.emit('notice', { level: 'info', code: 'sync.cause', message: text })
  }

  private causeIsStale(c: NonNullable<SyncState['cause']>, first: boolean): boolean {
    const theta = this.clockClient ? this.clockClient.offset : 0
    // Without a clock yet only the very first state can be old news, and it usually is (the sticky replay).
    if (c.at === undefined || theta === null) return first
    return this.p.clock.now() + theta - c.at > ENGINE.CAUSE_FRESH_MS
  }

  private groupNotice(n: GroupNotice): void {
    this.emit('notice', {
      level: 'info',
      code: 'sync.exempt',
      message: `${n.name} keeps buffering; the room no longer waits for them for 5 min`,
    })
  }

  private toSyncEvent(st: SyncState): SyncEvent {
    const host = this.group !== null
    const theta = this.clockClient ? (this.clockClient.offset ?? 0) : 0
    const ev: SyncEvent = {
      mode: st.mode,
      perms: { ...st.perms },
      canPlayPause: host || st.perms.othersPlayPause,
      canSeek: host || st.perms.othersSeek,
      waitForAll: st.waitForAll,
      startMode: st.startMode,
    }
    if (st.wait) {
      ev.wait = {
        reason: st.wait.reason,
        waitingFor: st.wait.waitingFor.map((id) => this.nameOf(id)),
        softDeadline: st.wait.softDeadline === null ? null : st.wait.softDeadline - theta,
      }
    }
    if (st.cause) {
      const c = st.cause
      ev.cause = { by: this.nameOf(c.by), kind: c.kind }
      if (c.from !== undefined) ev.cause.from = c.from
      if (c.to !== undefined) ev.cause.to = c.to
    }
    if (this.desync) ev.desync = { ...this.desync }
    return ev
  }

  private peers(): PeerSync[] {
    if (this.group) {
      return this.group
        .memberViews()
        .filter((m) => m.present)
        .map((m) => ({
          id: m.id,
          name: m.name,
          phase: m.phase,
          exempt: m.exempt,
          driftMs: m.status?.driftMs ?? null,
          bufferedAheadS: m.status?.bufferedAheadS ?? null,
          coverage: m.status?.coverage ?? null,
          warnings: m.status?.warnings ?? [],
          behindS: m.status?.behindS ?? null,
          posS: m.status?.pos ?? null,
          rateBps: m.status?.rateBps ?? null,
          needBps: m.status?.needBps ?? null,
          lagMs: m.status?.lagMs ?? null,
          clockErrMs: m.status?.clockErrMs ?? null,
          downLimitBps: m.status?.downLimitBps ?? null,
        }))
    }
    const st = this.member.state
    // a viewer hears no one's status but its own: other rows have no warnings, rates or buffer
    const own = this.member.lastStatus
    return (st?.members ?? []).map((m) => {
      const self = m.peerId === this.o.selfId
      return {
        id: m.peerId,
        name: m.name,
        phase: self ? this.member.currentPhase : m.phase,
        exempt: m.exempt,
        driftMs: self ? this.member.drift.driftMs : null,
        bufferedAheadS: self ? (own?.bufferedAheadS ?? null) : null,
        coverage: null,
        warnings: self ? (own?.warnings ?? []) : [],
        behindS: self && this.desync?.state === 'behind' ? this.desync.behindS : null,
        posS: null,
        rateBps: self ? (own?.rateBps ?? null) : null,
        needBps: self ? (own?.needBps ?? null) : null,
        lagMs: self ? this.member.lagP95Ms : null,
        clockErrMs: self ? (this.clockClient?.errorMs ?? null) : null,
        downLimitBps: self ? (own?.downLimitBps ?? null) : null,
      }
    })
  }

  private clockInfo(): ClockInfo {
    const c = this.clockClient
    if (!c) return { offsetMs: 0, errorMs: 0, poor: false, via: 'loopback' }
    const err = c.errorMs
    return {
      offsetMs: c.offset,
      errorMs: err,
      poor: err !== null && err > CLOCK.POOR_MS,
      via: c.usingBus ? 'bus' : 'datagram',
    }
  }

  private nameOf(id: string): string {
    if (id === this.o.selfId) return this.o.selfName
    const fromGroup = this.group?.memberViews().find((m) => m.id === id)?.name
    return fromGroup ?? this.member.state?.members.find((m) => m.peerId === id)?.name ?? 'Someone'
  }
}

/**
 * Per key: the first call runs at once, then at most one per `everyMs`; calls in between are held, and the last
 * of them runs when the interval is up.
 */
class Coalescer {
  private readonly keys = new Map<string, { at: number; held: (() => void) | null; timer: TimerHandle | null }>()

  constructor(
    private readonly clock: Clock,
    private readonly everyMs: number,
  ) {}

  run(key: string, fn: () => void): void {
    const now = this.clock.now()
    const k = this.keys.get(key)
    if (!k || (k.timer === null && now - k.at >= this.everyMs)) {
      this.keys.set(key, { at: now, held: null, timer: null })
      fn()
      return
    }
    k.held = fn
    k.timer ??= this.clock.setTimer(k.at + this.everyMs - now, () => {
      const held = k.held
      k.held = null
      k.timer = null
      k.at = this.clock.now()
      held?.()
    })
  }

  forget(key: string): void {
    this.keys.get(key)?.timer?.cancel()
    this.keys.delete(key)
  }

  stop(): void {
    for (const k of this.keys.values()) k.timer?.cancel()
    this.keys.clear()
  }
}

// ---- notices ---------------------------------------------------------------------------------

export function formatTime(s: number): string {
  const t = Math.max(0, Math.floor(s))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${sec}` : `${String(m)}:${sec}`
}

function causeText(c: NonNullable<SyncState['cause']>, who: string, st: SyncState, waitedFor: string[]): string | null {
  switch (c.kind) {
    case 'play':
      return `${who} resumed`
    case 'pause':
      return `${who} paused`
    case 'seek':
      return c.to === undefined ? `${who} skipped` : `${who} skipped to ${formatTime(c.to)}`
    case 'wait':
      return `Waiting for ${who} to buffer`
    case 'perms':
      return st.perms.othersPlayPause || st.perms.othersSeek
        ? 'The host let everyone pause and seek'
        : 'Only the host can pause and seek now'
    case 'start-anyway':
      return 'The host started without waiting'
    case 'timeout': {
      return waitedFor.length > 0 ? `Started without ${waitedFor.join(', ')}` : 'Started without waiting any longer'
    }
    case 'ended':
      return 'The video ended'
    case 'restore':
    case 'resume':
      return null
  }
}

function rejectionNotice(
  reason: IntentRejection,
  ask: { kind: IntentKind; pos?: number | undefined } | null,
): NoticeEvent {
  const messages: Record<IntentRejection, string> = {
    'perm-playpause': 'Host has disabled pausing',
    'perm-seek': 'Host has disabled seeking',
    superseded: 'Someone else seeked at the same moment',
    stale: 'The room changed; try again',
    'not-ready': 'The room is not ready yet',
    timeout: 'The host did not answer',
  }
  const n: NoticeEvent = { level: 'warn', code: `sync.${reason}`, message: messages[reason] }
  if (ask && (reason === 'perm-playpause' || reason === 'perm-seek')) {
    n.action = {
      label: 'Ask host',
      request: 'sync.request',
      params: ask.pos === undefined ? { kind: ask.kind } : { kind: ask.kind, posS: ask.pos },
    }
  }
  return n
}

function requestNotice(name: string, kind: IntentKind, pos: number | undefined): NoticeEvent {
  const verb = kind === 'seek' ? `skip to ${formatTime(pos ?? 0)}` : kind
  const label = kind === 'seek' ? 'Skip' : kind === 'play' ? 'Play' : 'Pause'
  const params = kind === 'seek' ? { kind, posS: pos ?? 0 } : { kind }
  return {
    level: 'info',
    code: 'sync.request',
    message: `${name} asks to ${verb}`,
    action: { label, request: 'playback.intent', params },
  }
}

function hostGoneNotice(gone: boolean): NoticeEvent {
  return gone
    ? { level: 'warn', code: 'sync.host-gone', message: 'Host disconnected — waiting' }
    : { level: 'info', code: 'sync.host-back', message: 'Host is back' }
}
