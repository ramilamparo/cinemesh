// The drift loop of plan §4.5, as a pure decision function. The member feeds it gated samples and executes the
// action it returns; nothing here touches the player.

export const DRIFT = {
  ON: 60,
  OFF: 15,
  GAIN: 1 / 3000,
  MAXD: 0.05,
  SKIP: 1000,
  SKIP_COOLDOWN_MS: 5000,
  FORCE_AFTER_MS: 20_000,
  FORCE_MIN_MS: 200,
  SPDIF_AHEAD_MS: 150,
  SPDIF_BEHIND_MS: -300,
  SPDIF_COOLDOWN_MS: 10_000,
  MAX_IPC_RTT_MS: 15,
  MAX_LOOP_LAG_MS: 20,
  MEDIAN_N: 5,
  /** after playback-restart, an unpause or audio-reconfig */
  RESTART_HOLD_MS: 1000,
  /** after θ̂ jumps */
  CLOCK_HOLD_MS: 3000,
  /** the prior, until the first exact seek with its data local is timed (ADR 0007 Finding 6: p50 41–52 ms) */
  SEEK_LAT_INIT_MS: 150,
  SEEK_LAT_MIN_MS: 25,
  SEEK_LAT_MAX_MS: 3000,
  SEEK_LAT_ALPHA: 0.3,
  TICK_MS: 250,
} as const

export type DriftAction =
  | { kind: 'none' }
  | { kind: 'speed'; speed: number }
  /** ahead: pause now and unpause when the room's expected position reaches ours (no decoding needed) */
  | { kind: 'pause-wait' }
  /** behind: exact seek to expected(now + seekLat) */
  | { kind: 'skip' }

const NONE: DriftAction = { kind: 'none' }

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
const round3 = (x: number): number => Math.round(x * 1000) / 1000

export class DriftController {
  /** speed last applied to mpv */
  speed = 1
  /** false when audio is spdif passthrough or the user turned nudging off */
  canNudge = true
  seekLatMs: number = DRIFT.SEEK_LAT_INIT_MS
  private seekTimed = false
  /** the next decision on a full window corrects from DRIFT.OFF up, not DRIFT.ON (see trim) */
  private trimming = false
  private correcting = false
  private since = 0
  private lastSkip = -Infinity
  private lastSpdifSkip = -Infinity
  private forceSkip = false
  private holdUntil = -Infinity
  private samples: number[] = []
  private lastD: number | null = null

  /** Median drift in ms over the last samples (+ = ahead of the room); null before the window fills. */
  get driftMs(): number | null {
    return this.lastD
  }

  /** Skip the loop until now + ms and forget samples taken before. */
  hold(now: number, ms: number): void {
    this.holdUntil = Math.max(this.holdUntil, now + ms)
    this.samples = []
    this.lastD = null
    this.correcting = false
  }

  holding(now: number): boolean {
    return now < this.holdUntil
  }

  /** Gate a raw sample (IPC RTT and loop lag) and add it to the window. Returns whether it counted. */
  offer(offsetMs: number, ipcRttMs: number, loopLagMs: number, at: number): boolean {
    if (ipcRttMs >= DRIFT.MAX_IPC_RTT_MS || loopLagMs >= DRIFT.MAX_LOOP_LAG_MS) return false
    if (at < this.holdUntil) return false
    this.samples.push(offsetMs)
    if (this.samples.length > DRIFT.MEDIAN_N) this.samples.shift()
    if (this.samples.length === DRIFT.MEDIAN_N) this.lastD = median(this.samples)
    return true
  }

  /** An exact seek reached its playback-restart after `ms`; the first one replaces the prior. */
  noteSeekDone(ms: number): void {
    const x = clamp(ms, DRIFT.SEEK_LAT_MIN_MS, DRIFT.SEEK_LAT_MAX_MS)
    const alpha = this.seekTimed ? DRIFT.SEEK_LAT_ALPHA : 1
    this.seekTimed = true
    this.seekLatMs = clamp(this.seekLatMs + alpha * (x - this.seekLatMs), DRIFT.SEEK_LAT_MIN_MS, DRIFT.SEEK_LAT_MAX_MS)
  }

  /**
   * After a start: the first decision on a full window corrects anything beyond DRIFT.OFF. Every member's start is
   * off by its unpause-latency estimate's error (and a frame landing it missed), the same for nobody; inside the
   * dead band nothing would remove it, and a member that the loop does correct later (after a stall) would land at
   * the anchor, apart from the rest (ADR 0008 §4.4). Trimmed, every member starts its play at the anchor.
   */
  trim(): void {
    this.trimming = true
  }

  /** The member calls this when it returns to 1x for reasons of its own (pause, seek). */
  noteSpeed(speed: number): void {
    this.speed = speed
  }

  step(now: number): DriftAction {
    const D = this.lastD
    if (D === null || now < this.holdUntil) return NONE
    const a = Math.abs(D)
    if ((a > DRIFT.SKIP && now - this.lastSkip > DRIFT.SKIP_COOLDOWN_MS) || this.forceSkip) {
      this.forceSkip = false
      this.correcting = false
      if (D > 0) return { kind: 'pause-wait' }
      this.lastSkip = now
      return { kind: 'skip' }
    }
    const trimming = this.trimming
    this.trimming = false
    if (!this.canNudge) return this.spdifStep(D, now)
    if (!this.correcting && a < (trimming ? DRIFT.OFF : DRIFT.ON)) return this.setSpeed(1)
    const was = this.correcting
    this.correcting = a > DRIFT.OFF
    if (this.correcting && !was) this.since = now
    const sp = this.correcting ? 1 - clamp(D * DRIFT.GAIN, -DRIFT.MAXD, DRIFT.MAXD) : 1
    const action = Math.abs(sp - this.speed) >= 0.002 || sp === 1 ? this.setSpeed(round3(sp)) : NONE
    if (this.correcting && now - this.since > DRIFT.FORCE_AFTER_MS && a > DRIFT.FORCE_MIN_MS) this.forceSkip = true
    return action
  }

  /** No speed changes at all: > +150 ms waits paused, < −300 ms skips forward (10 s cooldown). */
  private spdifStep(D: number, now: number): DriftAction {
    if (D > DRIFT.SPDIF_AHEAD_MS) return { kind: 'pause-wait' }
    if (D < DRIFT.SPDIF_BEHIND_MS && now - this.lastSpdifSkip > DRIFT.SPDIF_COOLDOWN_MS) {
      this.lastSpdifSkip = now
      this.lastSkip = now
      return { kind: 'skip' }
    }
    return NONE
  }

  private setSpeed(sp: number): DriftAction {
    if (sp === this.speed) return NONE
    this.speed = sp
    return { kind: 'speed', speed: sp }
  }
}

export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

/** Pause-wait and skip only make sense on whole samples; the loop runs again after the action settles. */
export const isCorrection = (a: DriftAction): boolean => a.kind === 'pause-wait' || a.kind === 'skip'
