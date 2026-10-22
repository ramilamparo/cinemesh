import type { PeerView } from '../../shared/ipc/core.js'
import {
  PEER_WARNING_ORDER,
  type PeerWarning,
  type PeerWarningCode,
  peerWarningLine,
} from '../../shared/peer-warnings.js'

// Host: an OSC toast when a warning first shows on another member's row, so the host hears of it while watching
// full screen. Only what the host can act on: a slow download (an upload limit to raise, a viewer to ask). Hash
// failures toast through their own notice; 'behind' and frame drops are each member's own to fix.

export const TOAST_CODES: readonly PeerWarningCode[] = ['slow-download']
/** a warning that comes and goes toasts again only after this */
export const PEER_TOAST_COOLDOWN_MS = 120_000

export class PeerWarningToasts {
  /** member id → codes on its row at the last tick */
  private shown = new Map<string, Set<PeerWarningCode>>()
  /** member id → code → when it last toasted */
  private readonly toasted = new Map<string, Map<PeerWarningCode, number>>()

  /**
   * Once per peers tick: the toast for the most severe warning that just appeared, if any. The others that
   * appeared with it are not queued: a burst of toasts would cover the video.
   */
  next(views: readonly PeerView[], now: number): string | null {
    const shown = new Map<string, Set<PeerWarningCode>>()
    let best: { id: string; name: string; w: PeerWarning; rank: number } | null = null
    for (const v of views) {
      if (v.self) continue
      const codes = new Set<PeerWarningCode>()
      for (const w of v.warnings) {
        if (!TOAST_CODES.includes(w.code)) continue
        codes.add(w.code)
        if (this.shown.get(v.id)?.has(w.code)) continue
        const last = this.toasted.get(v.id)?.get(w.code)
        if (last !== undefined && now - last < PEER_TOAST_COOLDOWN_MS) continue
        const rank = PEER_WARNING_ORDER.indexOf(w.code)
        if (!best || rank < best.rank) best = { id: v.id, name: v.name, w, rank }
      }
      shown.set(v.id, codes)
    }
    this.shown = shown
    for (const id of this.toasted.keys()) if (!shown.has(id)) this.toasted.delete(id)
    if (!best) return null
    const times = this.toasted.get(best.id) ?? new Map<PeerWarningCode, number>()
    times.set(best.w.code, now)
    this.toasted.set(best.id, times)
    return peerWarningLine(best.name, best.w)
  }
}
