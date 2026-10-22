import type { MediaPort, PlayheadReason, TransferPort, Unsubscribe } from '../../../src/core/sync/ports.js'
import type { EventLoop } from './loop.js'

export interface MediaOpts {
  durationS: number
  /** everything local (the host, or a finished download) */
  complete: boolean
  /** media seconds downloaded per second once a fetch starts (1 = exactly real time) */
  rateX: number
  /** delay before the first bytes of a fetch arrive */
  firstByteMs: number
  bitrateBps: number
  /** seconds already downloaded from 0 when the node joins */
  preloadS: number
}

export const DEFAULT_MEDIA: MediaOpts = {
  durationS: 7200,
  complete: true,
  rateX: 4,
  firstByteMs: 300,
  bitrateBps: 1_000_000,
  preloadS: 0,
}

/**
 * Downloaded spans plus one active fetch that grows from the last playhead.set at rateX. Readiness = 2 s
 * contiguous from the position (or the end of the file).
 */
export class FakeMedia implements MediaPort, TransferPort {
  readonly o: MediaOpts
  readonly playheadCalls: { t: number; posS: number; reason: PlayheadReason }[] = []
  private spans: [number, number][] = []
  private fetch: { from: number; startT: number } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly loop: EventLoop,
    opts: Partial<MediaOpts> = {},
  ) {
    this.o = { ...DEFAULT_MEDIA, ...opts }
    if (this.o.preloadS > 0) this.spans.push([0, Math.min(this.o.preloadS, this.o.durationS)])
    // Downloading starts with the member's first playhead.set (it joins and loads).
    if (!this.o.complete) {
      loop.every(500, () => {
        for (const fn of this.listeners) fn()
      })
    }
  }

  playhead = {
    set: (posS: number, reason: PlayheadReason): void => {
      this.playheadCalls.push({ t: this.loop.t, posS, reason })
      if (this.o.complete) return
      this.commit()
      const inside = this.spans.find(([s, e]) => posS >= s && posS < e)
      this.fetch = { from: inside ? inside[1] : posS, startT: this.loop.t }
    },
  }

  durationS(): number {
    return this.o.durationS
  }

  readiness(posS: number): boolean {
    if (this.o.complete) return true
    return this.contiguousEnd(posS) >= Math.min(posS + 2, this.o.durationS - 0.01)
  }

  bufferedAheadS(posS: number): number {
    if (this.o.complete) return Math.max(0, this.o.durationS - posS)
    return Math.max(0, this.contiguousEnd(posS) - posS)
  }

  needBps(): number {
    return this.o.complete ? 0 : this.o.bitrateBps
  }

  onChange(fn: () => void): Unsubscribe {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** End of the downloaded run containing posS (posS itself when it is not downloaded). */
  contiguousEnd(posS: number): number {
    if (this.o.complete) return this.o.durationS
    let end = posS
    let grew = true
    const all = this.current()
    while (grew) {
      grew = false
      for (const [s, e] of all) {
        if (s <= end + 1e-9 && e > end) {
          end = e
          grew = true
        }
      }
    }
    return end
  }

  rateBps(): number {
    return this.o.complete ? 0 : this.o.rateX * this.o.bitrateBps
  }

  etaToEofS(): number | null {
    if (this.o.complete) return 0
    const from = this.fetch ? this.fetch.from : 0
    return Math.max(0, this.o.durationS - this.contiguousEnd(from)) / this.o.rateX
  }

  coverage(): string | null {
    return null
  }

  diskFull(): boolean {
    return false
  }

  private fetched(): [number, number] | null {
    const f = this.fetch
    if (!f) return null
    const elapsed = Math.max(0, this.loop.t - f.startT - this.o.firstByteMs)
    return [f.from, Math.min(this.o.durationS, f.from + (this.o.rateX * elapsed) / 1000)]
  }

  private current(): [number, number][] {
    const f = this.fetched()
    return f ? [...this.spans, f] : this.spans
  }

  private commit(): void {
    const f = this.fetched()
    if (f && f[1] > f[0]) this.spans.push(f)
    this.spans.sort((a, b) => a[0] - b[0])
    const merged: [number, number][] = []
    for (const s of this.spans) {
      const last = merged[merged.length - 1]
      if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1])
      else merged.push([s[0], s[1]])
    }
    this.spans = merged
  }
}
