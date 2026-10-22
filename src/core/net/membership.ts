import type { Role } from '../../shared/ipc/core.js'

// The host's admission book (plan §4.1): who is in, who waits for approval, and the member cap.
// Pure state; the room publishes the result as the host-signed sticky `room.members` message.

export const HARD_MAX_MEMBERS = 12
/** keys whose latest join attempt is remembered; the one heard from least recently is forgotten past this */
export const ATTEMPT_KEYS = 1024
export type AdmissionMode = 'open' | 'approve'
export type DenyReason = 'full' | 'banned' | 'rejected'

export interface MemberInfo {
  /** public key, hex */
  key: string
  name: string
  role: Role
}

/**
 * Where a join request stands among its sender's. `nonce` names the attempt (a Room, from join until it closes)
 * and every answer about it echoes the nonce; `at` (when the attempt began, by the joiner's own clock) orders
 * attempts, and `seq` (its envelope's counter) orders the requests of one attempt.
 */
export interface JoinAttempt {
  nonce: string
  at: number
  seq: number
}

export interface PendingInfo {
  key: string
  name: string
  since: number
  /** the latest (re-sent) request; joiners repeat theirs every rejoinMs */
  lastRequest: number
  /** the attempt that waits: answers about it carry this */
  nonce: string
  /** the member that relayed it, for a joiner that cannot reach the host; absent when it came to the host itself */
  via?: { key: string; name: string }
}

/** `nonce`: the attempt it is about, which the host's answer carries */
export type JoinOutcome = (
  | { kind: 'admitted' }
  /** already a member; `renamed`: it asked under a new name, so the members list must be published again */
  | { kind: 'member'; renamed?: true }
  /** `refreshed`: it was waiting already, under the same name, through the same member (a re-sent request) */
  | { kind: 'pending'; refreshed?: true }
  | { kind: 'denied'; reason: DenyReason }
) & { nonce: string }

export interface MembershipOptions {
  mode: AdmissionMode
  maxMembers: number
  members?: MemberInfo[]
  isBanned: (key: string) => boolean
  /**
   * A member's name changes at most once per this long (each change is a members broadcast and a room.json
   * write); a newer name waits, and applyHeldRenames() takes it up once its time has come. 0: no limit.
   */
  renameMs?: number
  now?: () => number
}

export class Membership {
  mode: AdmissionMode
  private max: number
  private readonly members = new Map<string, MemberInfo>()
  private readonly pending = new Map<string, PendingInfo>()
  private readonly isBanned: (key: string) => boolean
  private readonly now: () => number
  private readonly renameMs: number
  private readonly renamedAt = new Map<string, number>()
  /** the newest name a member asked for while its last rename was too recent */
  private readonly heldNames = new Map<string, string>()
  /** the newest request taken from each key, until expirePending() finds it as old as an expired request */
  private readonly attempts = new Map<string, JoinAttempt & { takenAt: number }>()

  constructor(host: MemberInfo, opts: MembershipOptions) {
    this.mode = opts.mode
    this.max = clampMax(opts.maxMembers)
    this.isBanned = opts.isBanned
    this.now = opts.now ?? Date.now
    this.renameMs = opts.renameMs ?? 0
    this.members.set(host.key, { ...host, role: 'host' })
    for (const m of opts.members ?? []) {
      if (m.key !== host.key && !this.isBanned(m.key)) this.members.set(m.key, { ...m, role: 'viewer' })
    }
  }

  get maxMembers(): number {
    return this.max
  }

  has(key: string): boolean {
    return this.members.has(key)
  }

  list(): MemberInfo[] {
    return [...this.members.values()]
  }

  pendingList(): PendingInfo[] {
    return [...this.pending.values()]
  }

  /**
   * Whether to take a request: one newer than the last taken from its key (a later attempt, or a later re-send
   * of the same one). Whoever saw a request can replay it, and an old one must neither move the host back to
   * an attempt the joiner has left (its answers would go unheard) nor use up the joiner's allowance.
   */
  isFresh(key: string, attempt: JoinAttempt): boolean {
    const last = this.attempts.get(key)
    if (!last) return true
    if (attempt.at !== last.at) return attempt.at > last.at
    return attempt.nonce === last.nonce && attempt.seq > last.seq
  }

  /** A join request (see isFresh), straight from the joiner or relayed by the member `via`. */
  request(key: string, name: string, attempt: JoinAttempt, via?: string): JoinOutcome {
    this.attempts.delete(key) // and back in last: the first key is the one heard from least recently
    this.attempts.set(key, { ...attempt, takenAt: this.now() })
    if (this.attempts.size > ATTEMPT_KEYS) this.attempts.delete(this.attempts.keys().next().value ?? key)
    const { nonce } = attempt
    if (this.isBanned(key)) return this.deny(key, 'banned', nonce)
    const member = this.members.get(key)
    if (member) return { ...this.rename(member, name), nonce }
    if (this.members.size >= this.max) return this.deny(key, 'full', nonce)
    if (this.mode === 'approve') return this.wait(key, name, nonce, via)
    return this.admit(key, name, nonce)
  }

  /** The nonce of the latest attempt known from this key, for an answer nobody asked for (a kick). */
  nonceOf(key: string): string | undefined {
    return this.pending.get(key)?.nonce ?? this.attempts.get(key)?.nonce
  }

  /** Renames held back by renameMs whose time has come; true when a name changed (publish the list). */
  applyHeldRenames(): boolean {
    let changed = false
    for (const [key, name] of this.heldNames) {
      const member = this.members.get(key)
      if (!member) this.heldNames.delete(key)
      else if (this.rename(member, name).renamed) changed = true
    }
    return changed
  }

  /** The host's answer to a pending request; null when the key is not pending. */
  decide(key: string, allow: boolean): JoinOutcome | null {
    const p = this.pending.get(key)
    if (!p) return null
    if (!allow) return this.deny(key, 'rejected', p.nonce)
    if (this.isBanned(key)) return this.deny(key, 'banned', p.nonce)
    if (this.members.size >= this.max) return this.deny(key, 'full', p.nonce)
    return this.admit(key, p.name, p.nonce)
  }

  /** Cancels a pending request (the joiner gave up). */
  withdraw(key: string): boolean {
    return this.pending.delete(key)
  }

  /**
   * Drops requests not repeated within `maxAgeMs` (a joiner that left without a link to tell us), and the order
   * of attempts not heard from in that long (a joiner's clock set back between two attempts holds the later
   * one up no longer than that).
   */
  expirePending(maxAgeMs: number): boolean {
    const cutoff = this.now() - maxAgeMs
    for (const [key, a] of this.attempts) if (a.takenAt < cutoff) this.attempts.delete(key)
    let changed = false
    for (const p of this.pending.values()) if (p.lastRequest < cutoff) changed = this.pending.delete(p.key) || changed
    return changed
  }

  /** Drops the requests a member relayed (it was kicked: what it vouched for goes with it); true when any. */
  dropRelayedBy(key: string): boolean {
    let changed = false
    for (const p of this.pending.values()) if (p.via?.key === key) changed = this.pending.delete(p.key) || changed
    return changed
  }

  remove(key: string): boolean {
    this.pending.delete(key)
    this.heldNames.delete(key)
    this.renamedAt.delete(key)
    const m = this.members.get(key)
    if (!m || m.role === 'host') return false
    return this.members.delete(key)
  }

  /** Switching to open admits everyone waiting, while there is room. */
  setMode(mode: AdmissionMode): Map<string, JoinOutcome> {
    this.mode = mode
    const outcomes = new Map<string, JoinOutcome>()
    if (mode === 'open') {
      for (const p of this.pendingList()) {
        outcomes.set(p.key, this.decide(p.key, true) ?? { kind: 'member', nonce: p.nonce })
      }
    }
    return outcomes
  }

  /** Lowering the cap never removes anyone; it only stops new admissions. */
  setMaxMembers(n: number): void {
    this.max = clampMax(n)
  }

  private wait(key: string, name: string, nonce: string, via: string | undefined): JoinOutcome {
    const existing = this.pending.get(key)
    const now = this.now()
    const relayer = via !== undefined ? this.members.get(via) : undefined
    // A re-send of the same attempt keeps the member it first came through while that one is in: a joiner asks
    // through every neighbour it has, and the host's list should not flip between them.
    const kept =
      relayer && existing?.nonce === nonce && existing.via && this.members.has(existing.via.key) ? existing.via : null
    const through = kept ?? (relayer ? { key: relayer.key, name: relayer.name } : null)
    this.pending.set(key, {
      key,
      name,
      since: existing?.since ?? now,
      lastRequest: now,
      nonce,
      ...(through ? { via: through } : {}),
    })
    // nothing the host shows changed (a new attempt alone is no news: its answer carries its own nonce)
    const same = existing !== undefined && existing.name === name && existing.via?.key === through?.key
    return same ? { kind: 'pending', refreshed: true, nonce } : { kind: 'pending', nonce }
  }

  private rename(member: MemberInfo, name: string): { kind: 'member'; renamed?: true } {
    if (member.name === name) {
      this.heldNames.delete(member.key)
      return { kind: 'member' }
    }
    const now = this.now()
    if (now - (this.renamedAt.get(member.key) ?? -Infinity) < this.renameMs) {
      this.heldNames.set(member.key, name)
      return { kind: 'member' }
    }
    this.heldNames.delete(member.key)
    this.renamedAt.set(member.key, now)
    // a new record, never an edit: published lists hold these objects
    this.members.set(member.key, { ...member, name })
    return { kind: 'member', renamed: true }
  }

  private admit(key: string, name: string, nonce: string): JoinOutcome {
    this.pending.delete(key)
    this.members.set(key, { key, name, role: 'viewer' })
    return { kind: 'admitted', nonce }
  }

  private deny(key: string, reason: DenyReason, nonce: string): JoinOutcome {
    this.pending.delete(key)
    return { kind: 'denied', reason, nonce }
  }
}

function clampMax(n: number): number {
  return Math.max(2, Math.min(HARD_MAX_MEMBERS, Math.floor(n)))
}
