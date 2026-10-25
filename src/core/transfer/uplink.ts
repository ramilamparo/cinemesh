import { type PacedStream, type PacerState, UploadPacer } from './upload-pacer.js'
import type { UploadScheduler } from './upload-scheduler.js'

/**
 * The host's one uplink, shared by the playlist items it seeds (ADR 0011 §5). Each item's torrent has its own upload
 * scheduler, but they release from one token bucket at one paced rate: two pacers would read the same queueing
 * delay (the same connections to the same viewers) and each grant its own rate, twice what the uplink carries
 * without queueing, and ADR 0006's 20 ms target would be gone.
 *
 * Tier 0 is the item playing, tier 1 the items viewers fetch ahead. A tier-1 scheduler releases only while no tier-0
 * scheduler holds a request it could release now (a wire under its queue cap): the item playing always goes first,
 * and the rest gets what it leaves. Its connection-level queue cap is the same as tier 0's (the same UDX stream to
 * a viewer counts both), so what a tier-1 release puts ahead of a later tier-0 one is at most what the cap lets
 * through: max(32 KiB, 100 ms of that connection's drain), as class 2 already is against class 0 (ADR 0006 §6.1).
 */
export interface UplinkMember {
  scheduler: () => UploadScheduler | null
  /** this engine's attached viewers' UDX streams */
  streams: () => readonly PacedStream[]
}

export interface SharedBucket {
  /** the bucket refilled to `now` (ms) */
  refill(now: number): void
  /** a rate applies (the limit or the paced rate): without one, releases are bounded by the queue caps only */
  limited(): boolean
  tokens(): number
  take(bytes: number): void
}

/** With a rate: the bucket's depth, ms of the rate (as UploadScheduler's own). */
const BURST_MS = 20
const BLOCK = 16 * 1024

export class HostUplink {
  private readonly members = new Map<UplinkMember, 0 | 1>()
  private readonly pacer: UploadPacer
  private limitBps: number | null = null
  private tokensLeft = 0
  private tokensAt: number
  /** sentBytes of members that left, so the pacer's counter never goes back */
  private retiredSent = 0
  private readonly now: () => number
  private started = false

  readonly bucket: SharedBucket = {
    refill: (now) => {
      const rate = this.rateBps()
      if (rate !== null) {
        const depth = Math.max(BLOCK, (rate * BURST_MS) / 1000)
        this.tokensLeft = Math.min(depth, this.tokensLeft + (rate * (now - this.tokensAt)) / 1000)
      }
      this.tokensAt = now
    },
    limited: () => this.rateBps() !== null,
    tokens: () => this.tokensLeft,
    take: (bytes) => {
      this.tokensLeft -= bytes
    },
  }

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => performance.now())
    this.tokensAt = this.now()
    this.pacer = new UploadPacer({
      apply: () => this.pumpAll(),
      sentBytes: () => this.sentBytes(),
      streams: () => this.streams(),
      now: this.now,
    })
  }

  /** Joins an engine's scheduler at `tier`; the pacer starts with the first. Returns the leave function. */
  register(m: UplinkMember, tier: 0 | 1): () => void {
    this.members.set(m, tier)
    if (!this.started) {
      this.started = true
      this.pacer.start()
    }
    return () => {
      if (!this.members.has(m)) return
      this.retiredSent += m.scheduler()?.sentBytes ?? 0
      this.members.delete(m)
      this.pumpAll()
    }
  }

  setTier(m: UplinkMember, tier: 0 | 1): void {
    if (!this.members.has(m)) return
    this.members.set(m, tier)
    this.pumpAll()
  }

  tierOf(m: UplinkMember): 0 | 1 | null {
    return this.members.get(m) ?? null
  }

  /** KiB/s; null or 0 = none. */
  setLimit(kbps: number | null): void {
    this.limitBps = kbps ? kbps * 1024 : null
    this.pumpAll()
  }

  get limitedBps(): number | null {
    return this.limitBps
  }

  /** The limit or the paced rate, whichever is lower, bytes/s; null = neither applies. */
  rateBps(): number | null {
    const paced = this.pacer.rateBps
    if (this.limitBps === null || paced === null) return this.limitBps ?? paced
    return Math.min(this.limitBps, paced)
  }

  get pacedBps(): number | null {
    return this.pacer.rateBps
  }

  get queueMs(): number | null {
    return this.pacer.queueMs
  }

  get state(): PacerState {
    return this.pacer.state
  }

  /** A tier-0 scheduler holds a request it would release now, rate permitting: tier 1 waits. */
  foregroundWaiting(): boolean {
    for (const [m, tier] of this.members) if (tier === 0 && m.scheduler()?.waiting()) return true
    return false
  }

  /** A tier-1 scheduler may release now. */
  mayRelease(m: UplinkMember): boolean {
    return this.members.get(m) === 0 || !this.foregroundWaiting()
  }

  pumpAll(): void {
    // tier 0 first: what it takes from the bucket is not there for tier 1
    for (const tier of [0, 1] as const) {
      for (const [m, t] of this.members) if (t === tier) m.scheduler()?.pump()
    }
  }

  destroy(): void {
    this.pacer.destroy()
    this.members.clear()
  }

  private sentBytes(): number {
    let n = this.retiredSent
    for (const m of this.members.keys()) n += m.scheduler()?.sentBytes ?? 0
    return n
  }

  /** Each viewer's connection once: two items' bt lanes to a viewer share its UDX stream. */
  private streams(): PacedStream[] {
    const seen = new Set<object>()
    const out: PacedStream[] = []
    for (const m of this.members.keys()) {
      for (const s of m.streams()) {
        if (seen.has(s.stream)) continue
        seen.add(s.stream)
        out.push(s)
      }
    }
    return out
  }
}
