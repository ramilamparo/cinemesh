// What the peer list says about a member, and the host's OSC toast for it. Core works out the numbers (rates, when
// the buffer runs out) into a PeerWarning; these functions only format, so the renderer and core say the same words.

import { SLOW_RATE_FACTOR } from './limits.js'

export type PeerWarning =
  /** the host's hash-failure watch (core/session/hash-fails.ts): the viewer's failed checks so far */
  | { code: 'hash-fails'; total: number }
  /** the member is this far behind the host's position */
  | { code: 'behind'; behindS: number }
  /**
   * bufferInS: while playing, when the buffer runs out at these rates; null when unknown or not draining. limitBps:
   * the member's own download limit (sync.status.downLimitBps), null = none
   */
  | {
      code: 'slow-download'
      rateBps: number | null
      needBps: number | null
      bufferInS: number | null
      limitBps: number | null
    }
  | { code: 'frame-drops' }

export type PeerWarningCode = PeerWarning['code']

/** Order on a row, most severe first; also which toast wins when several warnings start at once. */
export const PEER_WARNING_ORDER = ['hash-fails', 'behind', 'slow-download', 'frame-drops'] as const

export function peerWarningText(w: PeerWarning): string {
  switch (w.code) {
    case 'hash-fails': {
      const checks = w.total === 1 ? '1 failed check' : `${String(w.total)} failed checks`
      return (
        `Received data that does not match the video (${checks}): the video file may have changed on disk, ` +
        'or the disk may be failing. Host it again.'
      )
    }
    case 'behind':
      return `${formatBehindS(w.behindS)} behind the host`
    case 'slow-download':
      return slowDownloadText(w)
    case 'frame-drops':
      return 'Dropping frames; playback may stutter'
  }
}

/** The OSC toast: "Sam: download too slow (…)". */
export function peerWarningLine(name: string, w: PeerWarning): string {
  const text = peerWarningText(w)
  return `${name}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`
}

export function peerWarningTone(w: PeerWarning): 'warn' | 'danger' {
  return w.code === 'hash-fails' ? 'danger' : 'warn'
}

/** One warning per code (the first one wins), in PEER_WARNING_ORDER. */
export function sortPeerWarnings(ws: readonly PeerWarning[]): PeerWarning[] {
  const byCode = new Map<PeerWarningCode, PeerWarning>()
  for (const w of ws) if (!byCode.has(w.code)) byCode.set(w.code, w)
  return PEER_WARNING_ORDER.flatMap((code) => byCode.get(code) ?? [])
}

/** Network speeds are quoted in bits, the unit ISPs and speed tests use. */
export function formatMbit(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '?'
  const mbit = (bytesPerSec * 8) / 1e6
  return mbit >= 10 ? mbit.toFixed(0) : mbit.toFixed(1)
}

/** How far behind: "1.4 s" (a trailing .0 dropped), "13 s", "2 min". */
export function formatBehindS(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  if (s < 9.95) return `${s.toFixed(1).replace(/\.0$/, '')} s`
  if (Math.round(s) < 60) return `${String(Math.round(s))} s`
  return `${String(Math.round(s / 60))} min`
}

function slowDownloadText(w: Extract<PeerWarning, { code: 'slow-download' }>): string {
  const known = (x: number | null): x is number => x !== null && Number.isFinite(x)
  // the member's own limit, named when it may be the cause: at SLOW_RATE_FACTOR × need or above, it cannot be
  const ownLimit =
    known(w.limitBps) && !(known(w.needBps) && w.limitBps >= SLOW_RATE_FACTOR * w.needBps)
      ? `limit ${formatMbit(w.limitBps)} Mbit/s`
      : null
  if (!known(w.rateBps) || !known(w.needBps) || w.needBps <= 0) {
    return ownLimit === null ? 'Download too slow' : `Download too slow (${ownLimit})`
  }
  const rate = formatMbit(w.rateBps)
  const need = formatMbit(w.needBps)
  const rates = `${rate} of ${need} Mbit/s${ownLimit === null ? '' : `, ${ownLimit}`}`
  // the warning starts below 1.1 × need: "too slow (9.8 of 9.5)" would contradict itself
  if (w.rateBps >= w.needBps || rate === need) return `Download barely keeps up (${rates})`
  const runsOut = known(w.bufferInS) ? bufferIn(w.bufferInS) : null
  return `Download too slow (${rates})${runsOut === null ? '' : `; may buffer ${runsOut}`}`
}

/** "soon", "in ~40 s" (5 s steps), "in ~3 min"; null from an hour on, which is not worth a warning's words. */
function bufferIn(seconds: number): string | null {
  if (seconds < 5) return 'soon'
  if (seconds >= 3600) return null
  const fives = Math.round(seconds / 5) * 5
  return fives < 60 ? `in ~${String(fives)} s` : `in ~${String(Math.round(seconds / 60))} min`
}
