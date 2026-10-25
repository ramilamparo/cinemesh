import { EventEmitter } from 'node:events'
import type Hyperswarm from 'hyperswarm'
import type { Discovery } from 'hyperswarm'
import type HyperDHT from 'hyperdht'
import type { NatReport, PeerPath, Role } from '../../shared/ipc/core.js'
import { CodedError } from '../../shared/result.js'
import { log as coreLog } from '../log.js'
import { Bans } from './bans.js'
import { Bus, type BusLink, type BusMessage, type BusPolicy, type Envelope, parseEnvelope, seqOf } from './bus.js'
import { keyFromHex, randomBytes, roomAuthKey, roomTopic, toHex } from './crypto.js'
import { boundPort, hintFor, natReport, probeRelay } from './diagnostics.js'
import { NET_ERRORS, errorCode } from './errors.js'
import { type RoomRecord, type RoomStore, keyPairFromSeed, newHostRecord, roomIdFor, viewerRecord } from './identity.js'
import { type InviteText, decodeInvite, inviteText } from './invite.js'
import {
  type AdmissionMode,
  type DenyReason,
  HARD_MAX_MEMBERS,
  type JoinAttempt,
  type JoinOutcome,
  type MemberInfo,
  Membership,
} from './membership.js'
import type { Address } from './path.js'
import { type NetConnection, PeerLink, type RoomPeer } from './peer.js'
import { type NetSettings, createSwarm, resolveBootstrap } from './swarm.js'
import { type Frame, WIRE_VERSION, clampName } from './wire.js'

export type { RoomPeer } from './peer.js'

export interface RoomTiming {
  authTimeoutMs: number
  /** a link whose remote has not even opened its auth lane by then is a dial the remote never took up */
  authOpenTimeoutMs: number
  /** failed proofs and protocol errors only: a timeout is never banned */
  authBanMs: number
  /** a joiner without a host link waits this long before asking neighbours to forward its join request */
  admitWaitMs: number
  rejoinMs: number
  hostAwayMs: number
  hostRefreshMs: number
  /** a member's room.hb (via-peer liveness) */
  heartbeatMs: number
  /**
   * The host's room.hb. Viewers take any host message as its last word and pause 10 s after it (sync), so a
   * crashed host's last word must be fresh whenever it dies: 1 s, not the members' 5 s.
   */
  hostHeartbeatMs: number
  pingMs: number
  ctrlPairWaitMs: number
  ctrlRetryMs: number
  relayProbeMs: number
  relayProbeTimeoutMs: number
  kickGraceMs: number
  meshRepairMs: number
  /** a member without a link and without traffic for this long is shown as gone, not via-peer */
  memberStaleMs: number
  /** a linked member that dials us again: its old link must answer a ping this soon or is dropped */
  staleLinkMs: number
  tickMs: number
}

export const DEFAULT_TIMING: RoomTiming = {
  authTimeoutMs: 10_000,
  authOpenTimeoutMs: 4_000,
  authBanMs: 10 * 60_000,
  admitWaitMs: 3_000,
  rejoinMs: 30_000,
  hostAwayMs: 10_000,
  hostRefreshMs: 60_000,
  heartbeatMs: 5_000,
  hostHeartbeatMs: 1_000,
  pingMs: 5_000,
  ctrlPairWaitMs: 15_000,
  ctrlRetryMs: 3_000,
  relayProbeMs: 5 * 60_000,
  relayProbeTimeoutMs: 10_000,
  kickGraceMs: 1_000,
  meshRepairMs: 5_000,
  memberStaleMs: 60_000,
  staleLinkMs: 2_000,
  tickMs: 1_000,
}

/** Bus names with a fixed policy, enforced by every member whether or not the owning module is loaded. */
export const NET_POLICIES: Readonly<Record<string, BusPolicy>> = {
  'room.members': { hostOnly: true, sticky: true },
  'room.state': { hostOnly: true, sticky: true },
  'room.rekey': { hostOnly: true, sticky: true },
  'room.admission': { hostOnly: true },
  // a joiner's request (taken from the auth lane only) and a member's relaying of one; the room sets their
  // rates and sizes
  'room.join-req': {},
  'room.join-via': {},
  'room.hb': {},
  'session.announce': { hostOnly: true, sticky: true },
  // the room's playlist (ADR 0011): enforced by every member, also one that never loads it
  'session.playlist': { hostOnly: true, sticky: true },
  'sync.state': { hostOnly: true, sticky: true },
  'sync.intentResult': { hostOnly: true },
}

export interface NetLog {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
}

export interface RoomOptions {
  displayName: string
  settings: NetSettings
  /** where room.json lives; null keeps everything in memory (tests) */
  store?: RoomStore | null
  /** host: initial admission mode and cap (Settings.hostDefaults) */
  admission?: AdmissionMode
  maxMembers?: number
  appVersion?: string
  /** defaults to process.env */
  env?: { WT_BOOTSTRAP?: string | undefined }
  log?: NetLog
  testing?: {
    /** a pre-made HyperDHT for the swarm */
    dht?: unknown
    /** extra firewall: true blocks the key (simulates an unreachable peer) */
    firewall?: (remotePublicKey: Buffer) => boolean
    timing?: Partial<RoomTiming>
  }
}

export type RoomPhase = 'joining' | 'pending' | 'in-room' | 'denied' | 'kicked' | 'ended' | 'error' | 'closed'

export interface RoomState {
  roomId: string
  name: string
  role: Role
  self: string
  hostKey: string
  phase: RoomPhase
  /** viewers: a host link, or host traffic within hostAwayMs. Always true on the host. */
  hostPresent: boolean
  admission: AdmissionMode
  maxMembers: number
  inviteEpoch: number
  /** `via`: the name of the member that relayed the request, for a joiner that cannot reach the host */
  pending: { id: string; name: string; via?: string }[]
  relay: { status: 'none' | 'ok' | 'unreachable'; key: string | null }
  nat: NatReport
  denyReason?: DenyReason
  error?: { code: string; message: string }
  /** viewers without a host link: why the last attempt to reach the host failed */
  hostError?: { code: string; hint: string }
}

export interface MemberView {
  id: string
  name: string
  role: Role
  self: boolean
  isHost: boolean
  /** 'via-peer' = admitted, no link, but its traffic reaches us; 'none' = self, or not heard from */
  path: PeerPath
  rttMs: number | null
  linked: boolean
  /** why our last attempt to connect to this member failed, while it has no link (e.g. HOLEPUNCH_*) */
  lastError?: { code: string; hint: string }
}

interface RoomEvents {
  peer: [peer: RoomPeer]
  'peer-gone': [id: string]
  members: [members: MemberView[]]
  state: [state: RoomState]
  rekey: [info: { inviteEpoch: number }]
  bye: [info: { peerId: string; end: boolean }]
  'auth-failed': [info: { peerId: string; code: string }]
  /** an outgoing connection attempt failed; `code` is hyperdht's (HOLEPUNCH_*, PEER_NOT_FOUND, ...) */
  'connect-error': [info: { peerId: string; code: string }]
}

type DatagramHandler = (peer: RoomPeer, buf: Buffer) => void
type CtrlHandler = (peer: RoomPeer, frame: Frame) => void

const RESERVED_CTRL = new Set(['bus', 'ctrl', 'room'])
const BANNED_IN_MESSAGE = 32
const BYE_FLUSH_MS = 150
/** pending requests not re-sent within this many rejoin intervals are dropped */
const PENDING_EXPIRY_REJOINS = 2.5
/**
 * Join requests taken per joiner key, by the host and by each member that relays them: a burst, then one per
 * rejoinMs / 3. A joiner sends one per rejoinMs and one whenever a host link comes up, and a user may leave and
 * join again at once; more is a flood.
 */
const JOIN_BURST = 3
const JOIN_REFILL_REJOINS = 1 / 3
/**
 * Relayed requests (room.join-via) taken per relaying member, on every member and the host: twice a joiner's
 * rate, so that one joiner asking as fast as it may through a member leaves room for others' requests.
 */
const RELAY_BURST = 6
const RELAY_REFILL_REJOINS = 1 / 6
/** a join request is {name, nonce, at}: a few hundred bytes; the relayed one wraps it */
const JOIN_REQ_MAX_BYTES = 1024
const JOIN_VIA_MAX_BYTES = 2048
const NONCE = /^[0-9a-f]{32}$/
/** a module handler failing on remote input is logged at most this often */
const FAULT_LOG_MS = 1_000
/**
 * A link that has heard nothing from its remote this long after it was made is a dial the remote never took
 * up (a healthy one hears the remote's auth lane open within a round trip). Younger, it may be one side of
 * two simultaneous dials, which Hyperswarm settles itself.
 */
const HALF_OPEN_AGE_MS = 1_000

/**
 * A room: one Hyperswarm, authenticated links, the signed bus and membership (plan §4.1, §5.2, §5.3).
 * Hosts admit and kick; viewers join through the host or, when they cannot reach it, through a neighbour.
 */
export class Room extends EventEmitter<RoomEvents> {
  readonly id: string
  readonly role: Role
  readonly self: string
  readonly hostKey: string

  private record: RoomRecord
  private readonly opts: RoomOptions
  private readonly timing: RoomTiming
  private readonly log: NetLog
  private readonly keyPair: { publicKey: Buffer; secretKey: Buffer }
  private readonly swarm: Hyperswarm
  private readonly bans: Bans
  private readonly bus: Bus
  private readonly membership: Membership | null
  private readonly links = new Map<string, PeerLink>()
  private readonly busLinks = new Map<PeerLink, BusLink>()
  private readonly datagramHandlers = new Map<number, Set<DatagramHandler>>()
  private readonly ctrlHandlers = new Map<string, Set<CtrlHandler>>()
  private readonly lastSeen = new Map<string, number>()
  private readonly connectErrors = new Map<string, string>()
  /** links dropped because their remote dialed us again and they stayed silent */
  private readonly staleLinks = new WeakSet<PeerLink>()
  private readonly timers: NodeJS.Timeout[] = []
  private settings: NetSettings
  /** the port the DHT was made with: a udpPort changed in Settings applies to the next room */
  private readonly udpPort: number | null
  private topic: Buffer
  private authKey: Buffer
  private previousAuthKey: Buffer | null
  private discovery: Discovery
  private phase: RoomPhase
  private denyReason: DenyReason | null = null
  private lastError: { code: string; message: string } | null = null
  private memberView = new Map<string, MemberInfo>()
  private hostRoomState: { relayKey: string | null; admission: AdmissionMode; maxMembers: number } | null = null
  private hostLastSeen = 0
  private hostPresent: boolean
  private lastHostRefresh = 0
  private lastJoinSent = 0
  private lastNeighbourJoin = 0
  private neighbourSince = 0
  private lastMeshRepair = 0
  private meshRepairBackoff: number
  private lastHeartbeat = 0
  private relayStatus: RoomState['relay']['status'] = 'none'
  private relayAddress: Address | null = null
  private relayProbing = false
  private probedRelayKey: string | null = null
  private saving: Promise<void> = Promise.resolve()
  /** a save is queued behind the one running: it writes whatever the record is by then */
  private saveQueued = false
  private lastFaultLog = 0
  private closing: Promise<void> | null = null
  /** this join attempt: the host's answers carry its nonce, and `at` orders it after our earlier ones */
  private readonly attempt = { nonce: toHex(randomBytes(16)), at: attemptStart() }
  /** the host answered 'admitted' to this attempt: from now on its room state may come on the auth lane */
  private admitted = false

  /** Host: a new room with a fresh secret and identity. */
  static async create(opts: RoomOptions & { name: string }): Promise<Room> {
    const record = newHostRecord({ name: opts.name, relayKey: opts.settings.relayKey })
    await opts.store?.save(record)
    return new Room(record, opts)
  }

  /** Viewer: joins from an invite (link or code); reuses this machine's identity for the room if it has one. */
  static async join(invite: string, opts: RoomOptions): Promise<Room> {
    const decoded = decodeInvite(invite)
    const existing = (await opts.store?.load(roomIdFor(decoded.hostKey))) ?? null
    const record = viewerRecord(decoded, existing)
    await opts.store?.save(record)
    return new Room(record, opts)
  }

  /** Either role, from a saved record: same key, so peers (and a host's viewers) recognise us. */
  static async resume(record: RoomRecord, opts: RoomOptions): Promise<Room> {
    const next = { ...record, lastJoined: Date.now() }
    await opts.store?.save(next)
    return new Room(next, opts)
  }

  private constructor(record: RoomRecord, opts: RoomOptions) {
    super()
    this.record = record
    this.opts = opts
    this.settings = opts.settings
    this.udpPort = opts.settings.udpPort
    this.timing = { ...DEFAULT_TIMING, ...opts.testing?.timing }
    this.log = opts.log ?? coreLog
    this.id = record.id
    this.role = record.role
    this.hostKey = record.hostKey
    this.keyPair = keyPairFromSeed(record.keySeed)
    this.self = toHex(this.keyPair.publicKey)
    if (this.role === 'host' && this.self !== this.hostKey) throw new Error('host record does not match its keySeed')
    this.phase = this.role === 'host' ? 'in-room' : 'joining'
    this.hostPresent = this.role === 'host'
    this.meshRepairBackoff = this.timing.meshRepairMs

    const secret = Buffer.from(record.secret, 'hex')
    this.topic = roomTopic(secret)
    this.authKey = roomAuthKey(secret)
    this.previousAuthKey = record.previousSecret ? roomAuthKey(Buffer.from(record.previousSecret, 'hex')) : null

    this.bans = new Bans({ onExpire: (hex) => this.swarm.peers.get(hex)?.ban(false) })
    for (const key of record.banned ?? []) this.bans.ban(key, Infinity, 'kick')

    this.bus = new Bus({
      keyPair: this.keyPair,
      hostKey: this.hostKey,
      // Join requests never travel the bus: the host takes a joiner's from its own link, or out of the
      // room.join-via of the member that relays it (onAuthFrame).
      acceptOrigin: (o, name) => name !== 'room.join-req' && (o === this.hostKey || this.isMember(o)),
      onForeign: (env) => this.handOver(env),
    })
    for (const [name, policy] of Object.entries(NET_POLICIES)) this.bus.define(name, policy)
    // any holder of the invite can send these: per joiner key, wherever they are taken
    this.bus.define('room.join-req', {
      rate: { burst: JOIN_BURST, everyMs: this.timing.rejoinMs * JOIN_REFILL_REJOINS },
      maxBytes: JOIN_REQ_MAX_BYTES,
    })
    // per relaying member, on every member that forwards them to the host
    this.bus.define('room.join-via', {
      rate: { burst: RELAY_BURST, everyMs: this.timing.rejoinMs * RELAY_REFILL_REJOINS },
      maxBytes: JOIN_VIA_MAX_BYTES,
    })
    this.bus.on('fault', (name, e) => this.fault(`${name} handler`, e))
    this.bus.on('message', (msg) => this.onAnyMessage(msg))
    this.bus.subscribe('room.join-via', (msg) => this.onRelayedJoin(msg))
    this.bus.subscribe('room.members', (msg) => this.onMembers(msg))
    this.bus.subscribe('room.state', (msg) => this.onRoomState(msg))
    this.bus.subscribe('room.rekey', (msg) => this.onRekey(msg))
    this.bus.subscribe('room.admission', (msg) => this.onAdmission(msg))

    this.membership =
      this.role === 'host'
        ? new Membership(
            { key: this.self, name: clampName(opts.displayName), role: 'host' },
            {
              mode: opts.admission ?? 'open',
              maxMembers: opts.maxMembers ?? 8,
              members: record.members ?? [],
              isBanned: (key) => this.bans.has(key),
              // each rename is a members broadcast and a room.json write; a member rejoins at most this often
              renameMs: this.timing.rejoinMs,
            },
          )
        : null

    const maxMembers = this.membership?.maxMembers ?? HARD_MAX_MEMBERS
    this.swarm = createSwarm({
      keyPair: this.keyPair,
      settings: this.settings,
      // A joinPeer() target makes Hyperswarm count every connection twice against maxPeers.
      maxPeers: this.role === 'host' ? maxMembers + 4 : 2 * (HARD_MAX_MEMBERS + 4),
      bootstrap: resolveBootstrap((opts.env ?? process.env).WT_BOOTSTRAP, this.settings.bootstrapExtra),
      firewall: (pk) => this.bans.has(pk) || (opts.testing?.firewall?.(pk) ?? false),
      onDial: (pk) => this.onDial(toHex(pk)),
      relayKey: () => this.relayKey(),
      alwaysRelay: () => this.settings.alwaysRelay,
      dht: opts.testing?.dht,
    })
    this.swarm.on('connection', (conn) => this.onConnection(conn as unknown as NetConnection))
    this.watchConnectErrors()
    this.discovery = this.swarm.join(this.topic, { server: true, client: true })
    // Dial the host once the DHT has bootstrapped: relayThrough reads dht.randomized, which stays false until
    // bootstrap has sampled our NAT, so a RANDOM viewer's first dial would go without the relay and wait for a
    // birthday punch (ADR 0005 Finding 6).
    if (this.role === 'viewer') {
      void (this.swarm.dht as unknown as HyperDHT)
        .fullyBootstrapped()
        .then(() => {
          if (!this.closing) this.swarm.joinPeer(Buffer.from(this.hostKey, 'hex'))
        })
        .catch(() => undefined)
    }

    if (this.membership) {
      this.publishRoomState()
      this.publishMembers()
    }
    this.timers.push(setInterval(() => this.tick(), this.timing.tickMs))
    this.timers.push(setInterval(() => void this.probeRelay(), this.timing.relayProbeMs))
    void this.probeRelay()
    this.log.info(`room ${this.id}: ${this.role} up as ${this.self.slice(0, 8)}`)
  }

  // ---- public API ---------------------------------------------------------------------------

  get name(): string {
    return this.record.name
  }

  /** The current DHT topic (changes on rotation). */
  get currentTopic(): Buffer {
    return this.topic
  }

  /** A copy of what is persisted in room.json. */
  get roomRecord(): RoomRecord {
    return { ...this.record }
  }

  /** Resolves once our first announce on the topic finished. */
  async ready(): Promise<void> {
    await this.discovery.flushed()
  }

  invite(): InviteText {
    const relay = this.record.relayKey ? keyFromHex(this.record.relayKey) : null
    return inviteText({
      roomSecret: Buffer.from(this.record.secret, 'hex'),
      hostKey: Buffer.from(this.hostKey, 'hex'),
      relayKey: relay,
      name: this.record.name,
    })
  }

  /** Signs and sends a bus message to every member (or `to` only). Host-only names throw on viewers. */
  publish(name: string, body: unknown, opts: { to?: string } = {}): void {
    this.bus.publish(name, body, opts)
  }

  /** Full name ('sync.state') or namespace ('sync'). Our own messages are delivered too (`via` = null). */
  onMessage(nameOrNs: string, handler: (msg: BusMessage) => void): () => void {
    return this.bus.subscribe(nameOrNs, handler)
  }

  /** Declare host-only / sticky names before relying on them; NET_POLICIES covers the plan's names. */
  defineMessage(name: string, policy: BusPolicy): void {
    this.bus.define(name, policy)
  }

  /** The newest sticky message for a name, e.g. 'session.announce'. */
  latest(name: string): BusMessage | null {
    return this.bus.latest(name)
  }

  onDatagram(prefix: number, handler: DatagramHandler): () => void {
    return addHandler(this.datagramHandlers, prefix, handler)
  }

  /** Direct (not forwarded) ctrl-lane frames {ns, t, ...} for a namespace, e.g. 'blob'. */
  onCtrl(ns: string, handler: CtrlHandler): () => void {
    if (RESERVED_CTRL.has(ns)) throw new Error(`ctrl namespace ${ns} is reserved`)
    return addHandler(this.ctrlHandlers, ns, handler)
  }

  /** Members we have an admitted link to. */
  peers(): RoomPeer[] {
    return [...this.links.values()].filter((l) => l.announced)
  }

  peer(id: string): RoomPeer | null {
    const link = this.links.get(id)
    return link?.announced ? link : null
  }

  members(): MemberView[] {
    const list = this.membership ? this.membership.list() : [...this.memberView.values()]
    const now = Date.now()
    return list.map((m) => {
      const link = this.links.get(m.key)
      const linked = link?.announced === true
      const self = m.key === this.self
      const lastError = this.connectErrors.get(m.key)
      let path: PeerPath = 'none'
      if (link && linked) path = link.path
      else if (!self && now - (this.lastSeen.get(m.key) ?? 0) < this.timing.memberStaleMs) path = 'via-peer'
      return {
        id: m.key,
        name: m.name,
        role: m.role,
        self,
        isHost: m.key === this.hostKey,
        path,
        rttMs: link && linked && link.rttMs !== null ? Math.round(link.rttMs) : null,
        linked,
        ...(lastError !== undefined && !linked && !self
          ? { lastError: { code: lastError, hint: hintFor(lastError) ?? 'Could not connect.' } }
          : {}),
      }
    })
  }

  state(): RoomState {
    const dht = this.swarm.dht as unknown as HyperDHT
    const relayKey = this.relayKey()
    const hostError = this.links.get(this.hostKey)?.announced ? undefined : this.connectErrors.get(this.hostKey)
    return {
      roomId: this.id,
      name: this.record.name,
      role: this.role,
      self: this.self,
      hostKey: this.hostKey,
      phase: this.phase,
      hostPresent: this.hostPresent,
      admission: this.membership?.mode ?? this.hostRoomState?.admission ?? 'open',
      maxMembers: this.membership?.maxMembers ?? this.hostRoomState?.maxMembers ?? HARD_MAX_MEMBERS,
      inviteEpoch: this.record.inviteEpoch,
      pending: (this.membership?.pendingList() ?? []).map((p) => ({
        id: p.key,
        name: p.name,
        ...(p.via ? { via: p.via.name } : {}),
      })),
      relay: { status: relayKey ? this.relayStatus : 'none', key: relayKey ? toHex(relayKey) : null },
      nat:
        dht.bootstrapped && dht.host !== null
          ? natReport(dht, true, this.udpPort, boundPort(dht))
          : { class: 'UNKNOWN', host: null, port: null, bootstrapped: false, hint: null },
      ...(this.denyReason ? { denyReason: this.denyReason } : {}),
      ...(this.lastError ? { error: this.lastError } : {}),
      ...(hostError !== undefined && this.role === 'viewer'
        ? { hostError: { code: hostError, hint: hintFor(hostError) ?? 'Could not reach the host.' } }
        : {}),
    }
  }

  /** Relay key and alwaysRelay apply to the next connection; udpPort and bootstrap need a new room. */
  updateSettings(settings: NetSettings): void {
    this.settings = settings
    if (this.membership && (settings.relayKey ?? undefined) !== this.record.relayKey) {
      const next = { ...this.record }
      delete next.relayKey
      this.record = settings.relayKey ? { ...next, relayKey: settings.relayKey } : next
      this.publishRoomState()
      this.persist()
    }
    void this.probeRelay()
  }

  // ---- host admin ---------------------------------------------------------------------------

  admit(peerId: string, allow: boolean): void {
    const outcome = this.requireHost().decide(peerId, allow)
    if (!outcome) throw new CodedError(NET_ERRORS.notAdmitted, 'no such pending request')
    this.applyOutcome(peerId, outcome)
  }

  kick(peerId: string, opts: { rotate?: boolean } = {}): InviteText | null {
    const membership = this.requireHost()
    if (peerId === this.self) throw new Error('the host cannot kick itself')
    const nonce = membership.nonceOf(peerId)
    const wasPending = membership.pendingList().some((p) => p.key === peerId)
    membership.remove(peerId)
    // the join requests it vouched for go with it
    const dropped = membership.dropRelayedBy(peerId)
    this.bans.ban(peerId, Infinity, 'kick')
    this.swarm.peers.get(peerId)?.ban(true)
    const link = this.links.get(peerId)
    this.retire(link)
    this.publishMembers()
    this.answer(peerId, { state: 'kicked', ...(nonce !== undefined ? { nonce } : {}) })
    if (wasPending || dropped) this.emitState()
    this.later(() => link?.destroy(), this.timing.kickGraceMs)
    return opts.rotate ? this.rotateInvite() : null
  }

  setAdmission(mode: AdmissionMode): void {
    for (const [key, outcome] of this.requireHost().setMode(mode)) this.applyOutcome(key, outcome)
    this.publishRoomState()
    this.emitState()
  }

  setMaxMembers(n: number): void {
    const membership = this.requireHost()
    membership.setMaxMembers(n)
    ;(this.swarm as unknown as { maxPeers: number }).maxPeers = membership.maxMembers + 4
    this.publishRoomState()
    this.emitState()
  }

  /** New secret and topic; admitted members follow over the bus, holders of the old invite cannot join. */
  rotateInvite(): InviteText {
    this.requireHost()
    this.record.inviteEpoch++
    this.applySecret(toHex(randomBytes(32)))
    this.bus.publish('room.rekey', { secret: this.record.secret, inviteEpoch: this.record.inviteEpoch })
    this.publishRoomState()
    this.persist()
    this.emitState()
    return this.invite()
  }

  /** Says goodbye on every link (`end`: the host closes the room for everyone), then shuts down. */
  leave(opts: { end?: boolean } = {}): Promise<void> {
    const end = opts.end === true && this.role === 'host'
    this.closing ??= this.shutdown(true, end)
    return this.closing
  }

  /** Shuts down without a goodbye (app exit, crash-like). */
  close(): Promise<void> {
    this.closing ??= this.shutdown(false, false)
    return this.closing
  }

  // ---- links --------------------------------------------------------------------------------

  private onConnection(conn: NetConnection): void {
    if (this.closing) {
      conn.on('error', () => undefined)
      conn.destroy()
      return
    }
    const link = new PeerLink(conn, {
      hostKey: this.hostKey,
      authKeys: () => ({ current: this.authKey, previous: this.previousAuthKey }),
      isKnownMember: (id) => this.isMember(id),
      localHello: () => ({
        proto: WIRE_VERSION,
        app: this.opts.appVersion ?? '0',
        name: clampName(this.opts.displayName),
        caps: [],
      }),
      allowCtrl: (l) => this.allowCtrl(l),
      relayAddress: () => this.relayAddress,
      timing: this.timing,
    })
    const old = this.links.get(link.id)
    if (old) {
      this.retire(old)
      old.destroy()
    }
    this.links.set(link.id, link)
    link.on('auth-failed', (code) => this.onAuthFailed(link, code))
    link.on('ready', () => this.onLinkReady(link))
    link.on('auth-frame', (frame) => this.onAuthFrame(link, frame))
    link.on('ctrl-open', () => this.onCtrlOpen(link))
    link.on('ctrl-close', () => this.retire(link))
    link.on('ctrl', (frame) => this.onCtrlFrame(link, frame))
    link.on('datagram', (buf) => this.dispatchDatagram(link, buf))
    link.on('path-changed', () => this.emitMembers())
    link.on('stale', () => this.onLinkStale(link))
    link.on('close', () => this.onLinkClose(link))
  }

  /**
   * A remote we hold a link to is dialing us again, so it lost that link: it restarted (same key, new
   * process) or its address changed. Hyperswarm swaps the new connection in by itself once hyperdht
   * completes it, but hyperdht can leave such a dial half-open (the dialer thinks it is connected, we never
   * got the connection). Meanwhile our own dial back waits for the old link to close, which UDX notices only
   * after ~15 s. So: an admitted link must answer a ping within staleLinkMs or is dropped, and a link that
   * never heard from the remote is our own dial it never took up, which only blocks its new one.
   * Checking rather than dropping at once keeps a live link up when both sides dial at the same moment,
   * or when an old handshake is replayed at us.
   */
  private onDial(id: string): void {
    const link = this.links.get(id)
    if (!link || link.closed || this.closing) return
    if (link.announced) {
      link.checkAlive(this.timing.staleLinkMs)
    } else if (!link.heard && performance.now() - link.createdAt >= HALF_OPEN_AGE_MS) {
      this.log.info(`room ${this.id}: ${id.slice(0, 8)} is dialing us; dropping our half-open link to it`)
      link.destroy()
    }
  }

  private onLinkStale(link: PeerLink): void {
    if (this.links.get(link.id) !== link) return
    this.log.info(`room ${this.id}: ${link.id.slice(0, 8)} dialed us again and its old link is silent: dropping it`)
    this.staleLinks.add(link)
    link.destroy()
  }

  // Hyperswarm keeps client connection errors to itself (it only uses them to force relaying), so wrap
  // dht.connect to learn why a member is unreachable and show the matching hint.
  private watchConnectErrors(): void {
    const dht = this.swarm.dht as unknown as Pick<HyperDHT, 'connect'>
    const connect = dht.connect.bind(dht)
    dht.connect = (remotePublicKey, connectOpts) => {
      const socket = connect(remotePublicKey, connectOpts)
      socket.on('error', (err: unknown) => this.onConnectError(toHex(remotePublicKey), errorCode(err)))
      return socket
    }
  }

  private onConnectError(peerId: string, code: string | null): void {
    if (!code || this.isClosed() || this.links.get(peerId)?.announced) return
    const changed = this.connectErrors.get(peerId) !== code
    this.connectErrors.set(peerId, code)
    this.log.debug(`room ${this.id}: connect to ${peerId.slice(0, 8)} failed: ${code}`)
    this.emit('connect-error', { peerId, code })
    if (!changed) return
    this.emitMembers()
    if (peerId === this.hostKey) this.emitState()
  }

  private allowCtrl(link: PeerLink): boolean {
    if (this.closing || this.bans.has(link.id)) return false
    return this.isMember(this.self) && this.isMember(link.id)
  }

  private onAuthFailed(link: PeerLink, code: string): void {
    this.log.warn(`room ${this.id}: ${code} with ${link.id.slice(0, 8)}`)
    // A wrong proof or a protocol error is the remote's doing: keep it out for a while. A timeout proves
    // nothing: hyperdht can leave one side holding a dial the other never took up (a restarted host's first
    // dial on a LAN does), and banning that would lock a member, or the host, out for authBanMs.
    const timedOut = code === NET_ERRORS.authTimeout
    if (!timedOut) {
      this.bans.ban(link.id, this.timing.authBanMs, 'auth')
      this.swarm.peers.get(link.id)?.ban(true)
    }
    this.emit('auth-failed', { peerId: link.id, code })
    // nor about the invite: 'error' ends the join in the session, and the next dial may well get through
    if (!timedOut && this.role === 'viewer' && link.isHost && !this.isMember(this.self)) {
      this.lastError = { code: NET_ERRORS.authFailed, message: 'The invite is out of date or wrong.' }
      this.setPhase('error')
    }
  }

  private onLinkReady(link: PeerLink): void {
    if (link.isHost) this.hostLastSeen = Date.now()
    // Always (re)introduce ourselves to the host: a restarted host may not know us yet.
    if (this.role === 'viewer' && link.isHost && this.wantsAdmission()) this.sendJoin([link])
    link.refreshCtrl()
  }

  // Any holder of the invite can write on this lane, admitted or not.
  private onAuthFrame(link: PeerLink, frame: Frame): void {
    const env = parseEnvelope(frame.env)
    if (!env) return
    if (frame.t === 'join') {
      // its own request, to no one in particular
      if (env.o !== link.id || env.ns !== 'room' || env.t !== 'join-req' || env.to !== undefined) return
      // guarded: admitting runs the room's 'members' and 'state' listeners, which must not throw into Protomux
      if (this.membership) this.guarded('join request', () => this.onJoinRequest(env, null))
      // A neighbour relays join requests only once it is in the room itself.
      else if (this.isMember(this.self)) this.relayJoin(env)
    } else if (frame.t === 'env' && env.o === this.hostKey && this.takesHandOver(env)) {
      // Hand-overs (the host's answer and room state, for a joiner without a ctrl lane) are the host's and end
      // here: anything else would be a way around admission, or a flood the bus forwards to every member.
      this.bus.receive({ ...env, ttl: 0 }, link.id)
    }
  }

  /**
   * What a hand-over may be: the host's messages to us (its answer to our request), and its room.state and
   * room.members once it has admitted this attempt. A member can hand us any host message it once saw: an old
   * members list that still names us would have a joiner back after a restart think it is in.
   */
  private takesHandOver(env: Envelope): boolean {
    if (this.role === 'host') return false
    if (env.to !== undefined) return env.to === this.self
    if (env.ns !== 'room' || (env.t !== 'state' && env.t !== 'members')) return false
    return this.admitted || this.isMember(this.self)
  }

  private onCtrlOpen(link: PeerLink): void {
    if (this.links.get(link.id) !== link) return
    const busLink: BusLink = {
      id: link.id,
      sendEnvelope: (env) => link.sendCtrl({ ns: 'bus', t: 'msg', m: env }),
    }
    this.busLinks.set(link, busLink)
    this.bus.addLink(busLink)
    if (link.isHost) this.hostLastSeen = Date.now()
    this.connectErrors.delete(link.id)
    link.announced = true
    this.emit('peer', link)
    this.emitMembers()
    this.updateHostPresence()
  }

  /** The link stopped being an admitted peer (ctrl closed, replaced, kicked or gone). Idempotent. */
  private retire(link: PeerLink | undefined): void {
    if (!link) return
    const busLink = this.busLinks.get(link)
    if (busLink) this.bus.removeLink(link.id, busLink)
    this.busLinks.delete(link)
    if (!link.announced) return
    link.announced = false
    this.emit('peer-gone', link.id)
    this.emitMembers()
  }

  private onLinkClose(link: PeerLink): void {
    this.retire(link)
    if (this.links.get(link.id) !== link) return
    this.links.delete(link.id)
    // A pending joiner has no ctrl lane to say bye on; its link closing is how it cancels.
    if (this.membership?.withdraw(link.id)) this.emitState()
    this.updateHostPresence()
    // The host just dialed us from a new process: dial back now instead of after Hyperswarm's retry backoff
    // (by this close Hyperswarm has let go of the old connection, so joinPeer queues a dial at once).
    if (this.role === 'viewer' && link.isHost && this.staleLinks.has(link) && !this.closing) {
      this.swarm.joinPeer(Buffer.from(this.hostKey, 'hex'))
    }
  }

  private onCtrlFrame(link: PeerLink, frame: Frame): void {
    if (frame.ns === 'bus' && frame.t === 'msg') {
      this.bus.receive(frame.m, link.id)
      return
    }
    if (frame.ns === 'room' && frame.t === 'bye') {
      this.onBye(link, frame.end === true)
      return
    }
    if (typeof frame.ns !== 'string') return
    for (const handler of this.ctrlHandlers.get(frame.ns) ?? [])
      this.guarded(`${frame.ns} frame`, () => handler(link, frame))
  }

  private dispatchDatagram(link: PeerLink, buf: Buffer): void {
    const prefix = buf[0]
    if (prefix === undefined) return
    for (const handler of this.datagramHandlers.get(prefix) ?? []) this.guarded('datagram', () => handler(link, buf))
  }

  private onBye(link: PeerLink, end: boolean): void {
    this.emit('bye', { peerId: link.id, end })
    if (this.membership && !link.isHost && this.membership.remove(link.id)) this.publishMembers()
    if (this.role === 'viewer' && link.isHost && end) {
      this.setPhase('ended')
      void this.close()
    }
  }

  // ---- membership ---------------------------------------------------------------------------

  private isMember(key: string): boolean {
    return this.membership ? this.membership.has(key) : this.memberView.has(key)
  }

  private wantsAdmission(): boolean {
    return this.phase === 'joining' || this.phase === 'pending' || this.phase === 'in-room' || this.phase === 'error'
  }

  private sendJoin(targets: PeerLink[]): void {
    if (targets.length === 0) return
    // signed, not published: a join request travels the auth lane only, to the host or to a member that relays it
    const env = this.bus.seal('room.join-req', { name: clampName(this.opts.displayName), ...this.attempt })
    for (const link of targets) link.sendAuth({ t: 'join', env })
    this.lastJoinSent = Date.now()
  }

  /**
   * A joiner that cannot reach the host gave us its request: we pass it on under our own key. The host takes a
   * request from the bus only inside a member's room.join-via, limited per member, and shows who relayed it.
   * The joiner's own rate applies here as well, so that one joiner cannot use up our relaying.
   */
  private relayJoin(env: Envelope): void {
    if (!parseJoinBody(env.body) || !this.bus.take(env)) return
    this.guarded('join relay', () => this.bus.publish('room.join-via', { req: env }, { to: this.hostKey }))
  }

  /** Host: a member's room.join-via, carrying a joiner's own request (never the member's own). */
  private onRelayedJoin(msg: BusMessage): void {
    if (!this.membership || msg.to !== this.self) return
    const req = parseEnvelope(asRecord(msg.body)?.req)
    if (!req || req.ns !== 'room' || req.t !== 'join-req' || req.to !== undefined || req.o === msg.from) return
    this.onJoinRequest(req, msg.from)
  }

  /** Host: a joiner's own request, from its link (`via` null) or relayed by the member `via`. */
  private onJoinRequest(env: Envelope, via: string | null): void {
    const membership = this.membership
    if (!membership || env.o === this.self || this.isClosed()) return
    const body = parseJoinBody(env.body)
    if (!body) return
    const attempt: JoinAttempt = { nonce: body.nonce, at: body.at, seq: seqOf(env) }
    // An older request (anyone who saw it can replay it) changes nothing and spends nothing. A newer one must
    // pass the joiner's rate and signature.
    if (!membership.isFresh(env.o, attempt) || !this.bus.take(env)) return
    if (membership.list().length >= membership.maxMembers && !membership.has(env.o)) this.pruneStaleMembers()
    this.applyOutcome(env.o, membership.request(env.o, body.name, attempt, via ?? undefined), via)
  }

  /**
   * `path`: how the request it answers came (null: on the joiner's own link; a key: relayed by that member).
   * Absent for the host's own decisions (admit, admission mode).
   */
  private applyOutcome(key: string, outcome: JoinOutcome, path?: string | null): void {
    const { nonce } = outcome
    switch (outcome.kind) {
      case 'admitted':
        // in open mode this line is what shows who vouched for a key it relayed (approve mode lists it as pending)
        this.log.info(
          `room ${this.id}: admitted ${key.slice(0, 8)}${typeof path === 'string' ? ` (relayed by ${path.slice(0, 8)})` : ''}`,
        )
        this.publishMembers()
        this.answer(key, { state: 'admitted', nonce })
        break
      case 'member':
        // before the answer: the members list handed over with it carries the new name
        if (outcome.renamed) this.publishMembers()
        this.answer(key, { state: 'admitted', nonce })
        break
      case 'pending':
        // A request already waiting, asked again (re-sent, or a new attempt), changes nothing the host shows: no
        // state event, and its answer goes back the way the request came (the joiner's own link, or the member
        // that relayed it, for a joiner without a host link) instead of to every member.
        if (outcome.refreshed && path !== undefined) {
          this.answerBack(key, { state: 'pending', nonce }, path)
          return
        }
        this.answer(key, { state: 'pending', nonce })
        break
      case 'denied':
        this.log.info(`room ${this.id}: denied ${key.slice(0, 8)} (${outcome.reason})`)
        this.answer(key, { state: 'denied', reason: outcome.reason, nonce })
        break
    }
    this.links.get(key)?.refreshCtrl()
    // the pending list is what state() says about admission; a member asking again leaves it as it was
    if (outcome.kind !== 'member') this.emitState()
  }

  // Members we have not heard from for a while give their seat to a newcomer instead of blocking the cap.
  private pruneStaleMembers(): void {
    const now = Date.now()
    let changed = false
    for (const m of this.membership?.list() ?? []) {
      if (m.role === 'host' || this.links.get(m.key)?.announced) continue
      if (now - (this.lastSeen.get(m.key) ?? 0) <= this.timing.memberStaleMs) continue
      if (this.membership?.remove(m.key)) changed = true
    }
    if (changed) this.publishMembers()
  }

  /** Host → one joiner. Travels the bus, and the auth lane for the last hop (the joiner is not admitted). */
  private answer(key: string, body: Admission): void {
    const env = this.bus.publish('room.admission', body, { to: key })
    this.handOver(env)
  }

  /**
   * One answer, the way its request came: on the joiner's own link (`via` null), or to the member that relayed
   * it, which hands it over and forwards it no further (ttl 0). To everyone only when that member has no link.
   */
  private answerBack(key: string, body: Admission, via: string | null): void {
    const env = this.bus.seal('room.admission', body, { to: key })
    if (via === null) {
      this.handOver(env)
      return
    }
    const relayer = this.links.get(via)
    const back = { ns: 'bus', t: 'msg', m: { ...env, ttl: 0 } }
    if (!relayer || !this.busLinks.has(relayer) || !relayer.sendCtrl(back)) this.answer(key, body)
  }

  /**
   * A host envelope for someone we may hold a non-admitted link to (a joiner, and the host's answer to it):
   * give it to them on the auth lane. Only the host's: the lane finishes a join, it is no way around
   * admission for anyone else's messages. One over the lane's 16 KiB is not sent (sendAuth says false).
   */
  private handOver(env: Envelope): void {
    if (env.to === undefined || env.o !== this.hostKey) return
    const link = this.links.get(env.to)
    if (!link?.ready || this.busLinks.has(link)) return
    if (!link.sendAuth({ t: 'env', env: { ...env, ttl: 0 } })) return
    const body = asRecord(env.body)
    if (env.ns === 'room' && env.t === 'admission' && body?.state === 'admitted') this.handOverRoomState(link)
  }

  private handOverRoomState(link: PeerLink): void {
    for (const name of ['room.state', 'room.members']) {
      const sticky = this.bus.stickyEnvelope(name)
      if (sticky) link.sendAuth({ t: 'env', env: { ...sticky, ttl: 0 } })
    }
  }

  private publishMembers(): void {
    const membership = this.membership
    if (!membership) return
    const banned = this.bans.permanent()
    this.bus.publish('room.members', { members: membership.list(), banned: banned.slice(-BANNED_IN_MESSAGE) })
    this.record = { ...this.record, members: membership.list(), banned: banned.slice(-256) }
    this.persist()
    this.afterMembershipChange()
  }

  private publishRoomState(): void {
    const membership = this.membership
    if (!membership) return
    this.bus.publish('room.state', {
      name: this.record.name,
      relayKey: this.record.relayKey ?? null,
      admission: membership.mode,
      maxMembers: membership.maxMembers,
      inviteEpoch: this.record.inviteEpoch,
    })
  }

  private onMembers(msg: BusMessage): void {
    if (this.role === 'host' || this.isClosed()) return
    const parsed = parseMembers(msg.body)
    if (!parsed) return
    this.memberView = new Map(parsed.members.map((m) => [m.key, m]))
    for (const key of parsed.banned) {
      this.bans.ban(key, Infinity, 'kick')
      const link = this.links.get(key)
      if (link && key !== this.self) {
        this.retire(link)
        this.later(() => link.destroy(), this.timing.kickGraceMs)
      }
    }
    if (parsed.banned.includes(this.self)) {
      this.onKicked()
      return
    }
    if (this.memberView.has(this.self)) {
      if (this.phase === 'joining' || this.phase === 'pending' || this.phase === 'error') {
        this.lastError = null
        this.setPhase('in-room')
      }
    } else if (this.phase === 'in-room') {
      // Dropped from the list (e.g. the host restarted without its records): ask again right away.
      this.lastJoinSent = 0
      this.setPhase('joining')
    }
    this.afterMembershipChange()
  }

  private afterMembershipChange(): void {
    const selfIn = this.isMember(this.self)
    for (const link of this.links.values()) {
      link.refreshCtrl()
      // A joiner admitted through us learns it from the host-signed list we hand it.
      if (selfIn && link.ready && !this.busLinks.has(link) && this.isMember(link.id)) this.handOverRoomState(link)
    }
    this.emitMembers()
  }

  private onRoomState(msg: BusMessage): void {
    if (this.role === 'host') return
    const body = asRecord(msg.body)
    if (!body) return
    const relayKey = typeof body.relayKey === 'string' && keyFromHex(body.relayKey) ? body.relayKey : null
    const admission = body.admission === 'approve' ? 'approve' : 'open'
    const maxMembers = typeof body.maxMembers === 'number' ? body.maxMembers : HARD_MAX_MEMBERS
    this.hostRoomState = { relayKey, admission, maxMembers }
    if (typeof body.name === 'string' && body.name && body.name !== this.record.name) {
      this.record = { ...this.record, name: body.name.slice(0, 64) }
      this.persist()
    }
    void this.probeRelay()
    this.emitState()
  }

  private onRekey(msg: BusMessage): void {
    if (this.role === 'host') return
    const body = asRecord(msg.body)
    if (!body || typeof body.secret !== 'string' || !keyFromHex(body.secret)) return
    if (typeof body.inviteEpoch !== 'number' || body.inviteEpoch <= this.record.inviteEpoch) return
    this.record = { ...this.record, inviteEpoch: body.inviteEpoch }
    if (body.secret !== this.record.secret) this.applySecret(body.secret)
    this.persist()
    this.log.info(`room ${this.id}: moved to invite epoch ${String(body.inviteEpoch)}`)
    this.emit('rekey', { inviteEpoch: body.inviteEpoch })
    this.emitState()
  }

  private onAdmission(msg: BusMessage): void {
    if (this.role === 'host' || msg.to !== this.self) return
    const body = asRecord(msg.body)
    if (!body) return
    // Answers are bound to the attempt they answer. One without our nonce is about another attempt, or none (a
    // 'denied' a member saw once and hands us after a restart, say), and is ignored.
    const ours = body.nonce === this.attempt.nonce
    if (body.state === 'kicked') {
      // Not an answer but the host's ban, for good, so it is taken whatever its nonce: the host names the attempt
      // it last heard of, which is a restarted member's previous one for 2.5 x rejoinMs (or none at all). A replay
      // can only tell a banned key it is banned.
      this.onKicked()
      return
    }
    if (!ours) return
    if (body.state === 'admitted') this.admitted = true
    if (this.isMember(this.self)) return
    // Within an attempt the host's answers only move a join forward. Once it is over (denied), an earlier answer
    // that a relayer held back, or that came the slower way, must not have us wait and ask again.
    if (!this.wantsAdmission()) return
    if (body.state === 'pending') this.setPhase('pending')
    else if (body.state === 'denied') {
      this.denyReason = isDenyReason(body.reason) ? body.reason : 'rejected'
      this.setPhase('denied')
    }
  }

  private onKicked(): void {
    if (this.phase === 'kicked') return
    this.setPhase('kicked')
    this.lastError = { code: NET_ERRORS.kicked, message: 'The host removed you from the room.' }
    void this.close()
  }

  private applySecret(secretHex: string): void {
    const oldTopic = this.topic
    this.record = { ...this.record, previousSecret: this.record.secret, secret: secretHex }
    const secret = Buffer.from(secretHex, 'hex')
    this.previousAuthKey = this.authKey
    this.authKey = roomAuthKey(secret)
    this.topic = roomTopic(secret)
    this.discovery = this.swarm.join(this.topic, { server: true, client: true })
    void this.swarm.leave(oldTopic).catch(() => undefined)
  }

  // ---- timers -------------------------------------------------------------------------------

  private tick(): void {
    if (this.closing) return
    const now = Date.now()
    if (this.role === 'viewer') {
      this.joinTick(now)
      this.updateHostPresence()
      if (!this.hostPresent && now - this.lastHostRefresh >= this.timing.hostRefreshMs) {
        this.lastHostRefresh = now
        void this.discovery.refresh().catch(() => undefined)
      }
    }
    if (this.membership?.expirePending(this.timing.rejoinMs * PENDING_EXPIRY_REJOINS)) this.emitState()
    if (this.membership?.applyHeldRenames()) this.publishMembers()
    const beat = this.role === 'host' ? this.timing.hostHeartbeatMs : this.timing.heartbeatMs
    // Ticks are not exact: half a tick early is on time (a 1 s beat on a 1 s tick would skip a tick otherwise).
    if (now - this.lastHeartbeat >= beat - this.timing.tickMs / 2 && this.isMember(this.self)) {
      this.lastHeartbeat = now
      this.bus.publish('room.hb', { at: now })
    }
    this.repairMesh(now)
  }

  private joinTick(now: number): void {
    if (this.isMember(this.self) || (this.phase !== 'joining' && this.phase !== 'pending')) {
      this.neighbourSince = 0
      return
    }
    const host = this.links.get(this.hostKey)
    if (host?.ready) {
      if (now - this.lastJoinSent >= this.timing.rejoinMs) this.sendJoin([host])
      return
    }
    const neighbours = [...this.links.values()].filter((l) => l.ready && !l.isHost)
    if (neighbours.length === 0) {
      this.neighbourSince = 0
      return
    }
    if (this.neighbourSince === 0) this.neighbourSince = now
    if (now - this.neighbourSince < this.timing.admitWaitMs) return
    if (now - this.lastNeighbourJoin < this.timing.rejoinMs) return
    this.lastNeighbourJoin = now
    this.sendJoin(neighbours)
  }

  private updateHostPresence(): void {
    if (this.role === 'host') return
    const link = this.links.get(this.hostKey)
    const present = link?.announced === true || Date.now() - this.hostLastSeen < this.timing.hostAwayMs
    if (present === this.hostPresent) return
    this.hostPresent = present
    this.log.info(`room ${this.id}: host ${present ? 'back' : 'away'}`)
    this.emitState()
  }

  // Simultaneous joiners can miss each other's announcements; look again while a member has no link.
  private repairMesh(now: number): void {
    if (!this.isMember(this.self)) return
    const missing = this.members().some((m) => !m.self && !m.linked)
    if (!missing) {
      this.meshRepairBackoff = this.timing.meshRepairMs
      return
    }
    if (now - this.lastMeshRepair < this.meshRepairBackoff) return
    this.lastMeshRepair = now
    this.meshRepairBackoff = Math.min(this.meshRepairBackoff * 2, this.timing.hostRefreshMs)
    void this.discovery.refresh().catch(() => undefined)
  }

  private onAnyMessage(msg: BusMessage): void {
    if (msg.via === null) return
    const now = Date.now()
    this.lastSeen.set(msg.from, now)
    if (msg.from === this.hostKey) {
      this.hostLastSeen = now
      this.updateHostPresence()
    }
  }

  // ---- relay --------------------------------------------------------------------------------

  /** One key for every member: invite → host's room message → own setting (plan §4.1). */
  private relayKey(): Buffer | null {
    const hex = this.record.relayKey ?? this.hostRoomState?.relayKey ?? this.settings.relayKey
    return hex ? keyFromHex(hex) : null
  }

  private async probeRelay(): Promise<void> {
    const key = this.relayKey()
    if (!key || this.isClosed() || this.relayProbing) {
      if (!key) this.relayStatus = 'none'
      return
    }
    this.relayProbing = true
    try {
      const keyHex = toHex(key)
      const result = await probeRelay(
        this.swarm.dht as unknown as Pick<HyperDHT, 'connect'>,
        key,
        this.timing.relayProbeTimeoutMs,
      )
      if (this.isClosed()) return
      const status = result.ok ? 'ok' : 'unreachable'
      if (result.ok) this.relayAddress = result.address
      const changed = status !== this.relayStatus || keyHex !== this.probedRelayKey
      this.relayStatus = status
      this.probedRelayKey = keyHex
      if (changed) {
        this.log.info(`room ${this.id}: relay ${status}`)
        this.emitState()
        this.emitMembers()
      }
    } finally {
      this.relayProbing = false
    }
  }

  // ---- plumbing -----------------------------------------------------------------------------

  private isClosed(): boolean {
    return this.closing !== null
  }

  private requireHost(): Membership {
    if (!this.membership) throw new CodedError(NET_ERRORS.notHost, 'only the host can do that')
    return this.membership
  }

  private setPhase(phase: RoomPhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.emitState()
  }

  private emitState(): void {
    this.emit('state', this.state())
  }

  private emitMembers(): void {
    this.emit('members', this.members())
  }

  /** Saves the record after the save in progress; calls meanwhile share one save, of the record as it is then. */
  private persist(): void {
    const store = this.opts.store
    if (!store || this.saveQueued) return
    this.saveQueued = true
    this.saving = this.saving
      .then(() => {
        this.saveQueued = false
        return store.save(this.record)
      })
      .catch((e: unknown) => this.log.warn(`room ${this.id}: saving room.json failed: ${String(e)}`))
  }

  /** Runs a module's handler for remote input: its failure must not reach the link (Protomux destroys it). */
  private guarded(what: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      this.fault(`${what} handler`, e)
    }
  }

  private fault(what: string, e: unknown): void {
    const now = Date.now()
    if (now - this.lastFaultLog < FAULT_LOG_MS) return
    this.lastFaultLog = now
    this.log.warn(`room ${this.id}: ${what} failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(fn, ms)
    t.unref()
  }

  private async shutdown(bye: boolean, end: boolean): Promise<void> {
    for (const t of this.timers) clearInterval(t)
    if (bye) {
      for (const link of this.links.values()) if (link.ctrlOpen) link.sendCtrl({ ns: 'room', t: 'bye', end })
      await new Promise((resolve) => setTimeout(resolve, BYE_FLUSH_MS))
    }
    if (end) this.phase = 'ended'
    if (this.phase !== 'ended' && this.phase !== 'kicked' && this.phase !== 'denied') this.phase = 'closed'
    for (const link of this.links.values()) this.retire(link)
    this.bans.clear()
    await this.swarm.destroy().catch(() => undefined)
    await this.saving
    this.log.info(`room ${this.id}: closed (${this.phase})`)
    this.emitState()
  }
}

/** room.admission: the host's answer to one join attempt (`nonce`), or its kick */
interface Admission {
  state: 'admitted' | 'pending' | 'denied' | 'kicked'
  reason?: DenyReason
  nonce?: string
}

let lastAttemptAt = 0

/** When a join attempt begins: wall-clock ms, and never twice the same in this process. */
function attemptStart(): number {
  lastAttemptAt = Math.max(Date.now(), lastAttemptAt + 1)
  return lastAttemptAt
}

/** A join request's body {name, nonce, at}: the name to show, and the attempt it belongs to (JoinAttempt). */
function parseJoinBody(body: unknown): { name: string; nonce: string; at: number } | null {
  const b = asRecord(body)
  if (!b || typeof b.name !== 'string' || typeof b.nonce !== 'string' || !NONCE.test(b.nonce)) return null
  if (typeof b.at !== 'number' || !Number.isSafeInteger(b.at) || b.at < 0) return null
  return { name: clampName(b.name), nonce: b.nonce, at: b.at }
}

function addHandler<K, H>(map: Map<K, Set<H>>, key: K, handler: H): () => void {
  let set = map.get(key)
  if (!set) map.set(key, (set = new Set()))
  set.add(handler)
  return () => set.delete(handler)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function isDenyReason(v: unknown): v is DenyReason {
  return v === 'full' || v === 'banned' || v === 'rejected'
}

function parseMembers(body: unknown): { members: MemberInfo[]; banned: string[] } | null {
  const b = asRecord(body)
  if (!b || !Array.isArray(b.members) || !Array.isArray(b.banned)) return null
  const members: MemberInfo[] = []
  for (const raw of b.members) {
    const m = asRecord(raw)
    if (!m || typeof m.key !== 'string' || !keyFromHex(m.key) || typeof m.name !== 'string') return null
    members.push({ key: m.key, name: clampName(m.name), role: m.role === 'host' ? 'host' : 'viewer' })
  }
  const banned = b.banned.filter((k): k is string => typeof k === 'string' && keyFromHex(k) !== null)
  return { members, banned }
}
