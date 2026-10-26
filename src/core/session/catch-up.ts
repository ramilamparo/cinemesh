import type { MediaMap } from '../../shared/media/media-map.js'
import type { PeerSync } from '../sync/engine.js'
import type { PieceRange } from '../transfer/scheduler.js'

// Catch-up priority (ADR 0012). With the room's upload short, every viewer got the same share of it, so one with a
// few seconds of buffer (a late joiner, a weaker link, an exempt member catching up alone) stalled while others had
// minutes, and with "wait for everyone" the whole room paused for it. The host picks such viewers from their sync
// statuses; its transfer feeds them first (TransferEngine.setViewerCatchUp) until their buffer is comparable.

/** A viewer starts catching up under this much buffer ahead of its own position (or while buffering)... */
export const ENTER_S = 15
/** ...when another viewer has at least this much more: an imbalance to fix, not a room that is short overall */
export const MARGIN_S = 10
/** It stops at this much buffer, or once nobody is more than MARGIN_S / 2 ahead of it. */
export const EXIT_S = 30
/** The media after its position that it is fed first. */
export const HORIZON_S = 30
/** A viewer whose own download limit is under this many times its bitrate lags by its own choice. */
const SELF_LIMIT_FACTOR = 1.5
/**
 * Phases with nothing to feed: no player to play it, no disk to put it on, played to the end; and joining, whose
 * position is 0 until the room's state reaches it (it reports where it settles from 'loading' on).
 */
const IDLE_PHASES: ReadonlySet<string> = new Set(['joining', 'no-player', 'disk-full', 'ended'])

export type CatchUpPeer = Pick<PeerSync, 'id' | 'phase' | 'bufferedAheadS' | 'posS' | 'needBps' | 'downLimitBps'>

/**
 * The viewers to feed first, from their sync statuses (the host excluded by the caller). `prev` is the last pick:
 * a viewer in it stays while it qualifies (EXIT_S, MARGIN_S / 2), so the set does not flap at the edges. At most
 * max(1, ⌊viewers / 3⌋) at once, the least buffered first, those already picked before newcomers. `durationS` lets a
 * viewer with everything up to the end (its buffer is short only because the video is) go unpicked.
 */
export function pickCatchUp(
  peers: readonly CatchUpPeer[],
  prev: ReadonlySet<string>,
  durationS: number | null,
): Set<string> {
  const cands = peers.filter(
    (p): p is CatchUpPeer & { bufferedAheadS: number; posS: number } =>
      p.bufferedAheadS !== null &&
      Number.isFinite(p.bufferedAheadS) &&
      typeof p.posS === 'number' &&
      !IDLE_PHASES.has(p.phase) &&
      !limitedBelowNeed(p),
  )
  const qualifies = (p: (typeof cands)[number]): boolean => {
    const ahead = p.bufferedAheadS
    if (durationS !== null && p.posS + ahead >= durationS - 1) return false
    let best = Number.NEGATIVE_INFINITY
    for (const q of cands) if (q !== p) best = Math.max(best, q.bufferedAheadS)
    if (prev.has(p.id)) return ahead < EXIT_S && best - ahead > MARGIN_S / 2
    return (ahead < ENTER_S || p.phase === 'buffering') && best - ahead >= MARGIN_S
  }
  const cap = Math.max(1, Math.floor(cands.length / 3))
  const byAhead = (a: (typeof cands)[number], b: (typeof cands)[number]): number => a.bufferedAheadS - b.bufferedAheadS
  const staying = cands.filter((p) => prev.has(p.id) && qualifies(p)).sort(byAhead)
  const entering = cands.filter((p) => !prev.has(p.id) && qualifies(p)).sort(byAhead)
  return new Set([...staying, ...entering].slice(0, cap).map((p) => p.id))
}

/** Its own download limit is set below what it plays: boosting it would only cost copies the gate turns away. */
function limitedBelowNeed(p: CatchUpPeer): boolean {
  const limit = p.downLimitBps
  const need = p.needBps
  return limit !== null && need !== null && need > 0 && limit < SELF_LIMIT_FACTOR * need
}

/**
 * The pieces a viewer at `posS` plays in the next HORIZON_S: from the first byte its player reads there (the start
 * a seek or a resume needs, as the media Playhead does) to the byte at posS + HORIZON_S.
 */
export function catchUpRange(map: Pick<MediaMap, 'seekByte' | 'timeToByte' | 'pieceOf'>, posS: number): PieceRange {
  const pos = Math.max(0, posS * 1000)
  const from = map.pieceOf(Math.min(map.seekByte(pos), map.timeToByte(pos)))
  const to = map.pieceOf(Math.max(0, map.timeToByte(pos + HORIZON_S * 1000) - 1))
  return [from, Math.max(from, to)]
}
