import type { IntentRejection, MemberPhase, Perms } from '../../shared/ipc/core.js'
import type { StartMode } from '../../shared/settings.js'
import { type Clock, type TimerHandle, every } from './ports.js'
import {
  type Cause,
  type IntentKind,
  SYNC_V,
  type SyncMode,
  type SyncState,
  type SyncStatus,
  type Wait,
} from './protocol.js'
import { startGate } from './start-gate.js'

// The host's authoritative state machine (plan §4.5). It never touches a player: it publishes sync.state and
// every MemberController, the host's own included, acts on it.

export const GROUP = {
  TICK_MS: 250,
  SOFT_MS: 8000,
  HARD_MS: 30_000,
  BUFFER_GRACE_MS: 1000,
  SILENT_MS: 10_000,
  FLAP_N: 3,
  FLAP_WINDOW_MS: 180_000,
  EXEMPT_MS: 300_000,
  SUPERSEDE_MS: 500,
  INTENT_LRU: 256,
  LEAD_MIN_MS: 250,
  LEAD_MAX_MS: 2000,
  LEAD_PAD_MS: 50,
  /** metadata-only republishes (member phases, waitingFor) are coalesced to at most one per second */
  META_INTERVAL_MS: 1000,
  PERSIST_PLAYING_MS: 5000,
  POS_EPS_S: 0.001,
} as const

type WaitReason = Wait['reason']
type Resume = Wait['resumeAs']

export interface GroupSnapshot {
  syncEpoch: number
  seq: number
  lastAnchor: { posS: number; mode: SyncMode }
  started: boolean
  perms: Perms
  waitForAll: boolean
  startMode: StartMode
}

export type GroupNotice = { kind: 'exempt'; peerId: string; name: string; untilMs: number }

export interface GroupHooks {
  publish(state: SyncState): void
  /**
   * session.json. Write a new seq (every publish) at once: a resume must not start below a seq viewers hold.
   * Only the 5 s position updates while playing (same seq) may be debounced.
   */
  persist(snap: GroupSnapshot): void
  notice(n: GroupNotice): void
  /** The host's own mpv position, read when it pauses so the room stops where the host saw it. */
  hostPosition(): number | null
}

export interface GroupOptions {
  clock: Clock
  selfId: string
  selfName: string
  /** random u32 for a fresh room; ignored when resuming */
  syncEpoch: number
  perms: Perms
  waitForAll: boolean
  startMode: StartMode
  resume?: GroupSnapshot | undefined
  hooks: GroupHooks
}

export interface GroupMemberView {
  id: string
  name: string
  phase: MemberPhase
  exempt: boolean
  present: boolean
  status: SyncStatus | null
}

interface MemberRec {
  id: string
  name: string
  present: boolean
  lastSeen: number
  status: SyncStatus | null
  bufferingSince: number | null
  waits: number[]
  exemptUntil: number
}

interface Barrier {
  /** seq of the waiting state that opened it */
  id: number
  reason: WaitReason
  resumeAs: Resume
  pos: number
  soft: number | null
  hard: number | null
  softFired: boolean
  aheadS: number
}

type IntentIn = { intentId: string; kind: IntentKind; pos?: number | undefined; basedOnSeq: number }
export interface Outcome {
  accepted: boolean
  reason?: IntentRejection
}

export class GroupController {
  private mode: SyncMode = 'idle'
  private readonly epoch: number
  private seq: number
  private anchor = { pos: 0, hostTime: 0 }
  /** seq at which the anchor position last changed; a member is ready only if it settled at or after it */
  private posSeq = 0
  private barrier: Barrier | null = null
  private perms: Perms
  private waitForAll: boolean
  private startMode: StartMode
  private started: boolean
  private cause: Cause | null = null
  private durationS: number | null = null
  /** the file plays only once completely downloaded (needsFullDownload): see included() */
  private fullDownload = false
  private readonly members = new Map<string, MemberRec>()
  private readonly intents = new Map<string, Outcome>()
  private lastSeek: { by: string; at: number; seq: number } | null = null
  private last: SyncState | null = null
  private lastPublishAt = -Infinity
  private lastPersistAt = -Infinity
  private metaDirty = false
  private timer: TimerHandle | null = null
  private readonly clock: Clock

  constructor(private readonly o: GroupOptions) {
    this.clock = o.clock
    const r = o.resume
    this.epoch = r?.syncEpoch ?? o.syncEpoch
    // The first publish after a resume carries seq + 1.
    this.seq = r?.seq ?? 0
    this.anchor.pos = r?.lastAnchor.posS ?? 0
    this.perms = r?.perms ?? o.perms
    this.waitForAll = r?.waitForAll ?? o.waitForAll
    this.startMode = r?.startMode ?? o.startMode
    this.started = r?.started ?? false
    this.upsert(o.selfId, o.selfName)
  }

  get syncEpoch(): number {
    return this.epoch
  }

  start(): void {
    this.timer ??= every(this.clock, GROUP.TICK_MS, () => this.tick())
  }

  stop(): void {
    this.timer?.cancel()
    this.timer = null
  }

  /** Last published state (null while idle and unpublished). */
  state(): SyncState | null {
    return this.last
  }

  /**
   * Media indexed (host) and its duration known: leave idle, paused at the (restored) anchor. `fullDownload`: the
   * file plays only once completely downloaded, so a viewer cannot load it before then (see included()).
   */
  mediaReady(durationS: number, opts: { fullDownload?: boolean } = {}): void {
    this.durationS = durationS
    this.fullDownload = opts.fullDownload ?? false
    if (this.mode !== 'idle') return
    const resumed = this.o.resume !== undefined
    this.goPaused(Math.min(this.anchor.pos, durationS), resumed ? { by: this.o.selfId, kind: 'restore' } : null)
  }

  memberViews(): GroupMemberView[] {
    return [...this.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      phase: m.status?.phase ?? 'joining',
      exempt: this.isExempt(m),
      present: m.present,
      status: m.status,
    }))
  }

  addMember(id: string, name: string): void {
    this.upsert(id, name)
    this.metaDirty = true
  }

  removeMember(id: string): void {
    const m = this.members.get(id)
    if (!m || id === this.o.selfId) return
    m.present = false
    m.bufferingSince = null
    this.metaDirty = true
    this.checkBarrier()
  }

  onHello(from: string): SyncState | null {
    const m = this.members.get(from)
    if (m) m.lastSeen = this.clock.now()
    return this.last
  }

  onStatus(from: string, s: SyncStatus): void {
    const m = this.members.get(from) ?? this.upsert(from, from)
    m.present = true
    m.lastSeen = this.clock.now()
    if (s.syncEpoch !== this.epoch) return
    const prevPhase = m.status?.phase
    m.status = s
    if (s.phase === 'buffering' && this.mode === 'playing') m.bufferingSince ??= this.clock.now()
    else m.bufferingSince = null
    if (prevPhase !== s.phase) this.metaDirty = true
    if (from === this.o.selfId && s.phase === 'ended' && this.mode === 'playing') {
      this.end()
      return
    }
    this.checkBarrier()
  }

  onIntent(from: string, intent: IntentIn): Outcome {
    const cached = this.intents.get(intent.intentId)
    if (cached) return cached
    const out = this.decide(from, intent)
    this.intents.set(intent.intentId, out)
    if (this.intents.size > GROUP.INTENT_LRU) {
      const oldest = this.intents.keys().next().value
      if (oldest !== undefined) this.intents.delete(oldest)
    }
    return out
  }

  setPerms(perms: Perms): void {
    if (perms.othersPlayPause === this.perms.othersPlayPause && perms.othersSeek === this.perms.othersSeek) return
    this.perms = { ...perms }
    this.cause = this.stamp({ by: this.o.selfId, kind: 'perms' })
    if (this.mode !== 'idle') this.publish()
  }

  setWaitForAll(on: boolean): void {
    if (on === this.waitForAll) return
    this.waitForAll = on
    if (this.mode === 'idle') return
    this.publish()
    this.checkBarrier()
  }

  setStartMode(mode: StartMode): void {
    this.startMode = mode
    if (this.mode === 'idle') return
    this.publish()
    this.checkBarrier()
  }

  startAnyway(): void {
    if (this.barrier) this.completeBarrier({ by: this.o.selfId, kind: 'start-anyway' })
  }

  snapshot(): GroupSnapshot {
    return {
      syncEpoch: this.epoch,
      seq: this.seq,
      lastAnchor: { posS: this.currentPos(), mode: this.mode },
      started: this.started,
      perms: { ...this.perms },
      waitForAll: this.waitForAll,
      startMode: this.startMode,
    }
  }

  // ---- intents -------------------------------------------------------------------------------

  private decide(from: string, intent: IntentIn): Outcome {
    if (this.mode === 'idle') return { accepted: false, reason: 'not-ready' }
    const self = from === this.o.selfId
    if (!self && intent.kind !== 'seek' && !this.perms.othersPlayPause)
      return { accepted: false, reason: 'perm-playpause' }
    if (!self && intent.kind === 'seek' && !this.perms.othersSeek) return { accepted: false, reason: 'perm-seek' }
    if (intent.basedOnSeq > this.seq) return { accepted: false, reason: 'stale' }
    if (intent.kind === 'play') this.play(from)
    else if (intent.kind === 'pause') this.pause(from)
    else {
      if (intent.pos === undefined) return { accepted: false, reason: 'stale' }
      const ls = this.lastSeek
      // Two people dragging the timeline at once: the one who had not seen the other's seek loses.
      if (ls && ls.by !== from && this.clock.now() - ls.at < GROUP.SUPERSEDE_MS && intent.basedOnSeq < ls.seq) {
        return { accepted: false, reason: 'superseded' }
      }
      this.seek(from, intent.pos)
    }
    return { accepted: true }
  }

  private play(by: string): void {
    const cause: Cause = { by, kind: 'play' }
    if (this.mode === 'playing') return
    if (this.mode === 'waiting' && this.barrier) {
      this.barrier.resumeAs = 'playing'
      this.cause = this.stamp(cause)
      this.publish()
      this.checkBarrier()
      return
    }
    if (this.mode === 'ended') {
      this.openBarrier('seek', 0, 'playing', { by, kind: 'seek', from: this.anchor.pos, to: 0 }, 0)
      return
    }
    const reason: WaitReason = this.started ? 'seek' : 'start'
    if (this.evaluate(reason, this.anchor.pos).waitingFor.length === 0) this.goPlaying(this.anchor.pos, cause)
    else this.openBarrier(reason, this.anchor.pos, 'playing', cause, 0)
  }

  private pause(by: string): void {
    const cause: Cause = { by, kind: 'pause' }
    if (this.mode === 'playing') {
      this.goPaused(this.currentPos(), cause)
    } else if (this.mode === 'waiting' && this.barrier && this.barrier.resumeAs !== 'paused') {
      this.barrier.resumeAs = 'paused'
      this.cause = this.stamp(cause)
      this.publish()
      this.checkBarrier()
    }
  }

  private seek(by: string, target: number): void {
    const pos = Math.max(0, Math.min(target, this.durationS ?? Infinity))
    const resumePlaying = this.mode === 'playing' || (this.mode === 'waiting' && this.barrier?.resumeAs === 'playing')
    const cause: Cause = { by, kind: 'seek', from: this.currentPos(), to: pos }
    if (resumePlaying) this.openBarrier(this.started ? 'seek' : 'start', pos, 'playing', cause, 0)
    else this.goPaused(pos, cause)
    this.lastSeek = { by, at: this.clock.now(), seq: this.seq }
  }

  // ---- transitions ---------------------------------------------------------------------------

  private goPlaying(pos: number, cause: Cause | null): void {
    this.mode = 'playing'
    this.barrier = null
    this.started = true
    this.anchor = { pos, hostTime: this.clock.now() + this.leadMs() }
    if (cause) this.cause = this.stamp(cause)
    this.publish()
  }

  private goPaused(pos: number, cause: Cause | null): void {
    const moved = this.mode === 'playing' || this.mode === 'ended' || Math.abs(pos - this.anchor.pos) > GROUP.POS_EPS_S
    this.mode = 'paused'
    this.barrier = null
    this.anchor = { pos, hostTime: this.clock.now() }
    if (moved || this.posSeq === 0) this.posSeq = this.seq + 1
    if (cause) this.cause = this.stamp(cause)
    this.publish()
  }

  private end(): void {
    this.mode = 'ended'
    this.barrier = null
    this.anchor = { pos: this.durationS ?? this.currentPos(), hostTime: this.clock.now() }
    this.posSeq = this.seq + 1
    this.cause = this.stamp({ by: this.o.selfId, kind: 'ended' })
    this.publish()
  }

  private openBarrier(reason: WaitReason, pos: number, resumeAs: Resume, cause: Cause, aheadS: number): void {
    const now = this.clock.now()
    const moved = this.mode === 'playing' || Math.abs(pos - this.anchor.pos) > GROUP.POS_EPS_S
    const timed = reason !== 'start'
    this.mode = 'waiting'
    this.anchor = { pos, hostTime: now }
    if (moved || this.posSeq === 0) this.posSeq = this.seq + 1
    this.barrier = {
      id: this.seq + 1,
      reason,
      resumeAs,
      pos,
      soft: timed ? now + GROUP.SOFT_MS : null,
      hard: timed ? now + GROUP.HARD_MS : null,
      softFired: false,
      aheadS,
    }
    this.cause = this.stamp(cause)
    this.publish()
  }

  private completeBarrier(cause: Cause | null): void {
    const b = this.barrier
    if (!b) return
    if (b.resumeAs === 'playing') {
      this.goPlaying(b.pos, cause)
      return
    }
    this.barrier = null
    this.mode = 'paused'
    this.anchor = { pos: b.pos, hostTime: this.clock.now() }
    if (cause) this.cause = this.stamp(cause)
    this.publish()
  }

  private checkBarrier(): void {
    const b = this.barrier
    if (!b) return
    const now = this.clock.now()
    let { waitingFor } = this.evaluate(b.reason, b.pos)
    if (waitingFor.length > 0 && b.soft !== null && !b.softFired && now >= b.soft) {
      b.softFired = true
      for (const id of waitingFor) if (id !== this.o.selfId) this.noteWait(id)
      waitingFor = this.evaluate(b.reason, b.pos).waitingFor
      if (waitingFor.length > 0 && !this.waitForAll) {
        this.completeBarrier({ by: this.o.selfId, kind: 'timeout' })
        return
      }
      this.metaDirty = true
    }
    if (waitingFor.length === 0) {
      this.completeBarrier(null)
      return
    }
    if (b.hard !== null && now >= b.hard) {
      this.completeBarrier({ by: this.o.selfId, kind: 'timeout' })
      return
    }
    const prev = this.last?.wait
    if (prev && waitingFor.join('\n') !== prev.waitingFor.join('\n')) this.metaDirty = true
  }

  // ---- membership and readiness --------------------------------------------------------------

  private upsert(id: string, name: string): MemberRec {
    const m = this.members.get(id)
    if (m) {
      m.name = name
      m.present = true
      m.lastSeen = this.clock.now()
      return m
    }
    const rec: MemberRec = {
      id,
      name,
      present: true,
      lastSeen: this.clock.now(),
      status: null,
      bufferingSince: null,
      waits: [],
      exemptUntil: -Infinity,
    }
    this.members.set(id, rec)
    return rec
  }

  private isExempt(m: MemberRec): boolean {
    return this.clock.now() < m.exemptUntil
  }

  private included(m: MemberRec, reason: WaitReason): boolean {
    if (!m.present || this.isExempt(m)) return false
    if (m.id !== this.o.selfId && this.clock.now() - m.lastSeen > GROUP.SILENT_MS) return false
    const phase = m.status?.phase ?? 'joining'
    if (phase === 'no-player' || phase === 'disk-full') return false
    if (phase === 'joining' || phase === 'loading') {
      // Late joiners rendezvous; only the first play waits for members who are still loading.
      if (reason !== 'start') return false
      // Unless the file plays only once complete: a viewer still downloading it has nothing to load (its member
      // reports joining), and waiting would hold the first play for whole downloads. It meets the room later,
      // as a late joiner. Play-through still waits: everyone watching from the start is what it asks for.
      if (this.fullDownload && this.startMode.kind !== 'play-through') return false
    }
    return true
  }

  private readyAt(m: MemberRec, pos: number): boolean {
    const s = m.status
    return (
      s !== null &&
      (s.phase === 'ready' || s.phase === 'paused') &&
      s.barrierId !== undefined &&
      s.barrierId >= this.posSeq &&
      Math.abs(s.pos - pos) <= GROUP.POS_EPS_S
    )
  }

  private evaluate(reason: WaitReason, pos: number): { waitingFor: string[]; etaS: number | null } {
    const included = [...this.members.values()].filter((m) => this.included(m, reason))
    const waiting = new Set(included.filter((m) => !this.readyAt(m, pos)).map((m) => m.id))
    let etaS: number | null = null
    if (reason === 'start') {
      const gate = startGate(
        this.startMode,
        included.map((m) => ({
          id: m.id,
          bufferedAheadS: m.status?.bufferedAheadS ?? 0,
          etaS: m.status?.etaS ?? null,
          rateBps: m.status?.rateBps ?? 0,
          needBps: m.status?.needBps ?? 0,
        })),
        pos,
        this.durationS,
        { fullDownload: this.fullDownload },
      )
      for (const id of gate.waitingFor) waiting.add(id)
      etaS = gate.etaS
    }
    return { waitingFor: [...waiting].sort(), etaS }
  }

  /** Flap guard: the third wait a member causes within 3 min exempts it for 5 min. Returns true if it did. */
  private noteWait(id: string): boolean {
    const m = this.members.get(id)
    if (!m) return false
    const now = this.clock.now()
    m.waits = m.waits.filter((t) => now - t < GROUP.FLAP_WINDOW_MS)
    m.waits.push(now)
    if (m.waits.length < GROUP.FLAP_N) return false
    m.waits = []
    m.exemptUntil = now + GROUP.EXEMPT_MS
    m.bufferingSince = null
    this.metaDirty = true
    this.o.hooks.notice({ kind: 'exempt', peerId: id, name: m.name, untilMs: m.exemptUntil })
    return true
  }

  private leadMs(): number {
    let lag = 0
    let eps = 0
    for (const m of this.members.values()) {
      if (!this.included(m, 'seek') || !m.status) continue
      lag = Math.max(lag, m.status.lagMs)
      eps = Math.max(eps, m.status.clockErrMs ?? 0)
    }
    return Math.min(GROUP.LEAD_MAX_MS, Math.max(GROUP.LEAD_MIN_MS, lag + 2 * eps + GROUP.LEAD_PAD_MS))
  }

  /** Causes carry the host time they happened, so two identical ones (Sam buffers twice) stay distinct. */
  private stamp(c: Cause): Cause {
    return { ...c, at: this.clock.now() }
  }

  private expected(now: number): number {
    if (this.mode !== 'playing') return this.anchor.pos
    return this.anchor.pos + Math.max(0, now - this.anchor.hostTime) / 1000
  }

  private currentPos(): number {
    if (this.mode !== 'playing') return this.anchor.pos
    const p = this.o.hooks.hostPosition()
    const pos = p ?? this.expected(this.clock.now())
    return Math.max(0, Math.min(pos, this.durationS ?? Infinity))
  }

  // ---- housekeeping --------------------------------------------------------------------------

  private tick(): void {
    if (this.mode === 'idle') return
    const now = this.clock.now()
    for (const m of this.members.values()) {
      if (m.exemptUntil !== -Infinity && now >= m.exemptUntil) {
        m.exemptUntil = -Infinity
        this.metaDirty = true
      }
    }
    if (this.mode === 'playing') {
      if (this.durationS !== null && this.expected(now) >= this.durationS) {
        this.end()
        return
      }
      if (this.waitForAll) this.checkBuffering(now)
    }
    this.checkBarrier()
    if (this.metaDirty && now - this.lastPublishAt >= GROUP.META_INTERVAL_MS) this.publish()
    if (this.mode === 'playing' && now - this.lastPersistAt >= GROUP.PERSIST_PLAYING_MS) {
      this.lastPersistAt = now
      this.o.hooks.persist(this.snapshot())
    }
  }

  private checkBuffering(now: number): void {
    for (const m of this.members.values()) {
      if (m.bufferingSince === null || now - m.bufferingSince < GROUP.BUFFER_GRACE_MS) continue
      m.bufferingSince = null
      if (!this.included(m, 'buffering')) continue
      if (this.noteWait(m.id)) continue
      const pos = this.currentPos()
      this.openBarrier('buffering', pos, 'playing', { by: m.id, kind: 'wait' }, pos - (m.status?.pos ?? pos))
      return
    }
  }

  private publish(): void {
    const now = this.clock.now()
    this.seq++
    const b = this.barrier
    let wait: Wait | undefined
    if (b) {
      const ev = this.evaluate(b.reason, b.pos)
      wait = {
        reason: b.reason,
        aheadS: b.aheadS,
        waitingFor: ev.waitingFor.slice(0, 16),
        softDeadline: b.soft,
        resumeAs: b.resumeAs,
        etaS: ev.etaS,
      }
    }
    const state: SyncState = {
      t: 'sync.state',
      v: SYNC_V,
      syncEpoch: this.epoch,
      seq: this.seq,
      mode: this.mode,
      anchor: { pos: this.anchor.pos, hostTime: this.anchor.hostTime, rate: 1 },
      perms: { ...this.perms },
      waitForAll: this.waitForAll,
      startMode: this.startMode,
      cause: this.cause,
      members: [...this.members.values()]
        .filter((m) => m.present)
        .slice(0, 16)
        .map((m) => ({
          peerId: m.id,
          name: m.name.slice(0, 64),
          phase: m.status?.phase ?? 'joining',
          exempt: this.isExempt(m),
        })),
      sentAt: now,
      ...(wait ? { wait } : {}),
    }
    this.last = state
    this.lastPublishAt = now
    this.lastPersistAt = now
    this.metaDirty = false
    this.o.hooks.publish(state)
    this.o.hooks.persist(this.snapshot())
  }
}
