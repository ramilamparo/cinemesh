import type { SyncDesync } from '../../shared/ipc/core.js'

// The viewer's "behind the host" warning as a pure decision: the member feeds it how far behind the room it is at
// every 4 Hz tick and shows what it returns (the Room banner, the OSC, its sync.status). Nothing here touches the
// player.

export const DESYNC = {
  /** behind by at least the threshold this long, without a break, before the warning shows */
  SHOW_AFTER_MS: 2000,
  /** a shown warning hides once the lag stays under this share of the threshold... */
  HIDE_FACTOR: 0.5,
  /** ...for this long */
  HIDE_AFTER_MS: 1000,
  /** behindS is rounded to this many seconds, so a growing stall changes it at most twice a second */
  STEP_S: 0.5,
} as const

/** 'catching-up': a skip, rendezvous or wait is on its way to the room; it carries no number. */
export type DesyncInfo = SyncDesync

export interface DesyncInput {
  /** the room plays and so does this member (not idle, settled, held, loading or gone) */
  active: boolean
  /** a skip, rendezvous or scheduled unpause is on its way to the room */
  catchingUp: boolean
  /** how far behind the room (ms, + = behind); null when unknown (no clock estimate yet) */
  lagMs: number | null
  /** the clock's error bound ε: the warning shows only for a lag beyond it */
  errMs: number
}

/**
 * Shows 'behind' after the lag less ε stayed at or above the threshold for SHOW_AFTER_MS, and hides it once the lag
 * stayed under half the threshold for HIDE_AFTER_MS. A catch-up never shows a warning of its own (normal starts,
 * late joins and the drift loop's skips are catch-ups); one that follows a warning, or the user's Resync, shows
 * 'catching-up', which ends at once when the member lands in sync and turns into 'behind' only after another
 * SHOW_AFTER_MS behind (no stale 'behind' after a catch-up that worked).
 */
export class DesyncMonitor {
  private value: DesyncInfo | null = null
  /** lag at or above the threshold since */
  private overSince: number | null = null
  /** a shown warning: lag under the hide level since */
  private underSince: number | null = null
  /** 'catching-up' with its act done: settling since */
  private settleSince: number | null = null

  constructor(private thresholdMs: number) {}

  get info(): DesyncInfo | null {
    return this.value
  }

  /**
   * A new threshold (0 = off): starts afresh. The same one changes nothing (every settings change applies it again).
   * Returns whether the info changed.
   */
  configure(thresholdMs: number): boolean {
    if (thresholdMs === this.thresholdMs) return false
    this.thresholdMs = thresholdMs
    return this.reset()
  }

  /** Clears the warning and its timers (a newly applied state, the player moved behind our back). */
  reset(): boolean {
    this.restartTimers()
    return this.set(null)
  }

  /** Restarts the timers, keeping what is shown (the clock estimate jumped). */
  restartTimers(): void {
    this.overSince = null
    this.underSince = null
    this.settleSince = null
  }

  /** The user's Resync went out: 'catching-up' until it lands. */
  markResync(): boolean {
    this.restartTimers()
    return this.set({ state: 'catching-up' })
  }

  /** One tick; returns whether the info changed. */
  step(now: number, i: DesyncInput): boolean {
    const T = this.thresholdMs
    if (T <= 0 || !i.active) return this.reset()
    const v = this.value
    if (i.catchingUp) {
      this.overSince = null
      this.underSince = null
      this.settleSince = null
      return v === null ? false : this.set({ state: 'catching-up' })
    }
    const lag = i.lagMs
    if (lag === null) {
      // nothing to measure against: what is shown stays, and the timers start over once there is
      this.restartTimers()
      return false
    }
    const over = lag - i.errMs >= T
    if (over) this.overSince ??= now
    else this.overSince = null
    const shownLong = this.overSince !== null && now - this.overSince >= DESYNC.SHOW_AFTER_MS
    const low = lag < T * DESYNC.HIDE_FACTOR
    if (v?.state === 'catching-up') {
      if (low) return this.reset()
      if (shownLong) return this.behind(lag)
      // somewhere in between: the drift loop has the rest
      this.settleSince ??= now
      return now - this.settleSince >= DESYNC.SHOW_AFTER_MS ? this.reset() : false
    }
    if (v === null) return shownLong ? this.behind(lag) : false
    if (low) {
      // on its way out: the number shown stays (the lag here rounds to 0 s, or below)
      this.underSince ??= now
      return now - this.underSince >= DESYNC.HIDE_AFTER_MS ? this.reset() : false
    }
    this.underSince = null
    return this.behind(lag)
  }

  private behind(lagMs: number): boolean {
    this.settleSince = null
    const behindS = Math.max(0, Math.round(lagMs / 1000 / DESYNC.STEP_S) * DESYNC.STEP_S)
    return this.set({ state: 'behind', behindS })
  }

  private set(next: DesyncInfo | null): boolean {
    const v = this.value
    const same =
      v === next ||
      (v !== null &&
        next !== null &&
        v.state === next.state &&
        (v.state !== 'behind' || (next.state === 'behind' && v.behindS === next.behindS)))
    if (same) return false
    this.value = next
    return true
  }
}
