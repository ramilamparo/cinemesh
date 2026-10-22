import type { PlaybackEvent } from '../../../shared/ipc/core'

// Core stamps playback samples with its own monotonic clock, which has a different origin from the
// renderer's performance.now(). The offset between the two is estimated as the smallest observed
// (receive time − at): delivery delay is never negative, so the minimum is the closest to the truth.

/** Never extrapolate further than this past the last sample; a silent core must not run the playhead away. */
const MAX_EXTRAPOLATION_S = 2
/** A larger jump means core restarted with a new clock origin. */
const OFFSET_RESET_MS = 5000

export class PlayheadClock {
  private offset: number | null = null
  private sample: PlaybackEvent | null = null

  update(sample: PlaybackEvent, localNow: number): void {
    const observed = localNow - sample.at
    if (this.offset === null || observed < this.offset || observed - this.offset > OFFSET_RESET_MS) {
      this.offset = observed
    }
    this.sample = sample
  }

  reset(): void {
    this.offset = null
    this.sample = null
  }

  get moving(): boolean {
    const s = this.sample
    return s !== null && !s.paused && !s.seeking && !s.stalled
  }

  position(localNow: number): number | null {
    const s = this.sample
    if (!s) return null
    if (!this.moving || this.offset === null) return s.posS
    const elapsed = (localNow - (s.at + this.offset)) / 1000
    const pos = s.posS + Math.min(MAX_EXTRAPOLATION_S, Math.max(0, elapsed))
    return s.durationS !== null ? Math.min(pos, s.durationS) : pos
  }
}
