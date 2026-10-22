import type { StartMode } from '../../shared/settings.js'

// Start modes for the first play (plan §4.5): "everyone has N s buffered" or "everyone can play through".

export const PLAY_THROUGH_FACTOR = 0.9

export interface GateMember {
  id: string
  bufferedAheadS: number
  etaS: number | null
  rateBps: number
  needBps: number
}

export interface GateResult {
  waitingFor: string[]
  /** play-through: seconds until the slowest member passes the ETA rule; null when unknown or not applicable */
  etaS: number | null
}

/**
 * `fullDownload`: the file plays only once completely downloaded, so a member can play it through only once it
 * has all of it: play-through waits for an ETA of 0 (and reports how long that is), not 0.9 x what is left.
 */
export function startGate(
  mode: StartMode,
  members: GateMember[],
  posS: number,
  durationS: number | null,
  opts: { fullDownload?: boolean } = {},
): GateResult {
  const remaining = durationS === null ? Infinity : Math.max(0, durationS - posS)
  const waitingFor: string[] = []
  let worst: number | null = null
  for (const m of members) {
    if (mode.kind === 'buffered') {
      // Near the end there is less than N s left to buffer.
      if (m.bufferedAheadS + 0.25 < Math.min(mode.seconds, remaining)) waitingFor.push(m.id)
      continue
    }
    const eta = etaToEof(m, remaining)
    if (eta === null) {
      waitingFor.push(m.id)
      continue
    }
    const limit = opts.fullDownload ? 0 : PLAY_THROUGH_FACTOR * remaining
    if (eta > limit) {
      waitingFor.push(m.id)
      // While the room waits paused the ETA falls by about a second per second and the limit stays put.
      worst = Math.max(worst ?? 0, eta - limit)
    }
  }
  return { waitingFor, etaS: mode.kind === 'play-through' && waitingFor.length > 0 ? worst : null }
}

function etaToEof(m: GateMember, remaining: number): number | null {
  if (m.etaS !== null) return m.etaS
  if (m.needBps <= 0) return 0
  if (m.rateBps <= 0 || !Number.isFinite(remaining)) return null
  const missingS = Math.max(0, remaining - m.bufferedAheadS)
  return (missingS * m.needBps) / m.rateBps
}
