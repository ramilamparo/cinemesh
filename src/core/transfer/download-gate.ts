/**
 * What patches/webtorrent+3.0.21.patch asks of `torrent._requestGate`. `_request` checks `allows` before it reserves a
 * block, `take`s the block's length once the request goes out, and `refund`s it when the request fails (a reject, a
 * choke, a closed wire): those bytes never come. The request walks in `_updateWire` stop at the first piece refused.
 */
export interface RequestGate {
  /** may a block of a piece be requested now? `critical`: a piece the Scheduler flagged (scheduler.ts), which may borrow */
  allows(critical: boolean): boolean
  take(bytes: number): void
  refund(bytes: number): void
}

/** how much may be asked for at once after a quiet spell, in seconds of the rate (GATE_MIN_BYTES at least) */
export const GATE_DEPTH_S = 0.25
export const GATE_MIN_BYTES = 64 * 1024
/** how far critical pieces may borrow below empty, in seconds of the rate (GATE_MIN_BYTES at least) */
export const GATE_DEBT_S = 1
const KICK_MIN_MS = 10
const KICK_MAX_MS = 1000

/**
 * The viewer's download limit (ADR 0010): a token bucket over the bytes it requests, shared by all its wires. A
 * sender that gets no request sends nothing, so nothing queues on the way or in our RAM, and a `have` or an urgent
 * block never waits behind throttled data, as it would behind WebTorrent's read throttle (ADR 0002 Finding 3).
 * Critical pieces (a blocked reader, the hot window, critical ranges) borrow up to GATE_DEBT_S of the rate, so a read
 * mpv waits on arrives at link speed while the average stays at the limit. Once every request is answered nothing
 * in WebTorrent asks again, so a refusal sets one timer that calls `kick` (the torrent's `_update()`) when the
 * refused request could go.
 */
export class DownloadGate implements RequestGate {
  private rate: number | null = null
  /** at `at`; below 0 while critical pieces borrow. Never above the depth once refilled, which every use does first */
  private tokens = 0
  private at: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerDue = 0
  private destroyed = false
  private readonly kick: () => void
  private readonly now: () => number

  constructor(deps: { kick: () => void; now?: () => number }) {
    this.kick = deps.kick
    this.now = deps.now ?? (() => performance.now())
    this.at = this.now()
  }

  /** bytes/s; null = no limit */
  get rateBps(): number | null {
    return this.rate
  }

  /**
   * bytes/s; null or 0 = no limit. A new limit starts full; a higher one keeps what is left; a lower one keeps at most
   * its own depth and owes at most its own debt (what was borrowed at the old rate would take that much longer to pay
   * back at the new one, and every request, a read mpv waits on too, would wait for it). Opening or raising it kicks
   * at once: the pipelines refill without waiting for an answer or a timer.
   */
  setRate(bps: number | null): void {
    const rate = bps !== null && bps > 0 ? bps : null
    if (rate === this.rate) return
    const before = this.rate
    this.refill()
    this.rate = rate
    if (rate !== null && before === null) this.tokens = this.depth()
    else if (rate !== null && before !== null && rate < before) {
      this.tokens = Math.min(this.depth(), Math.max(-this.debt(), this.tokens))
    }
    if (rate === null || before === null || rate > before) {
      this.clearTimer()
      if (!this.destroyed) this.kick()
    }
  }

  allows(critical: boolean): boolean {
    if (this.rate === null) return true
    this.refill()
    const floor = critical ? -this.debt() : 0
    if (this.tokens > floor) return true
    this.wakeAt(this.at + ((floor - this.tokens) / this.rate) * 1000)
    return false
  }

  take(bytes: number): void {
    if (this.rate === null) return
    this.refill()
    this.tokens -= bytes
  }

  refund(bytes: number): void {
    if (this.rate === null) return
    this.refill()
    this.tokens += bytes
  }

  destroy(): void {
    this.destroyed = true
    this.clearTimer()
  }

  private depth(): number {
    return Math.max(GATE_MIN_BYTES, GATE_DEPTH_S * (this.rate ?? 0))
  }

  private debt(): number {
    return Math.max(GATE_MIN_BYTES, GATE_DEBT_S * (this.rate ?? 0))
  }

  private refill(): void {
    const now = this.now()
    if (this.rate !== null) this.tokens = Math.min(this.depth(), this.tokens + (this.rate * (now - this.at)) / 1000)
    this.at = now
  }

  /** One timer: an earlier refusal's wins unless this one can go sooner. */
  private wakeAt(due: number): void {
    if (this.destroyed) return
    const ms = Math.min(KICK_MAX_MS, Math.max(KICK_MIN_MS, Math.ceil(due - this.now()) + 1))
    const at = this.now() + ms
    if (this.timer && this.timerDue <= at) return
    this.clearTimer()
    this.timerDue = at
    this.timer = setTimeout(() => {
      this.timer = null
      this.kick()
    }, ms)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
