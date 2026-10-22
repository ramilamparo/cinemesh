import type { PeerView } from '../../shared/ipc/core.js'
import { type PeerWarning, sortPeerWarnings } from '../../shared/peer-warnings.js'
import { hintFor } from '../net/diagnostics.js'
import type { MemberView } from '../net/room.js'
import type { PeerSync } from '../sync/engine.js'
import type { PeerTransferStats } from '../transfer/engine.js'

/**
 * One row per member: net (who, path, RTT) + sync (phase, drift, coverage) + transfer (speeds, have %). `warnings`
 * adds the session's own entries to a member's sync warnings (the host's hash-failure warning).
 */
export function mergePeerViews(
  members: readonly MemberView[],
  sync: readonly PeerSync[],
  transfer: readonly PeerTransferStats[],
  warnings: ReadonlyMap<string, readonly PeerWarning[]> = new Map(),
): PeerView[] {
  const bySync = new Map(sync.map((s) => [s.id, s]))
  const byTransfer = new Map(transfer.map((t) => [t.id, t]))
  return members.map((m): PeerView => {
    const s = bySync.get(m.id)
    const t = byTransfer.get(m.id)
    const lastError = m.lastError
      ? { code: m.lastError.code, hint: m.lastError.hint || hintFor(m.lastError.code) || 'Could not connect.' }
      : null
    return {
      id: m.id,
      name: s?.name ?? m.name,
      role: m.isHost ? 'host' : 'viewer',
      self: m.self,
      path: m.self ? 'none' : m.path,
      rttMs: m.rttMs,
      phase: s?.phase ?? 'joining',
      driftMs: s?.driftMs ?? null,
      bufferedAheadS: s?.bufferedAheadS ?? null,
      downBps: t?.downBps ?? 0,
      upBps: t?.upBps ?? 0,
      // PeerView.havePct is a percentage (0-100); transfer reports a fraction
      havePct: m.isHost ? 100 : Math.round((t?.havePct ?? 0) * 1000) / 10,
      coverage: s?.coverage ?? null,
      warnings: rowWarnings(s, warnings.get(m.id) ?? []),
      exempt: s?.exempt ?? false,
      posS: s?.posS ?? null,
      ...(lastError ? { lastError } : {}),
    }
  })
}

/**
 * The member's sync codes with their numbers (a slow download also with the member's own download limit), its own
 * desync warning ('behind', from its sync.status), then the session's entries: one per code, most severe first.
 */
function rowWarnings(s: PeerSync | undefined, extra: readonly PeerWarning[]): PeerWarning[] {
  if (!s) return sortPeerWarnings(extra)
  const own = s.warnings.map((code): PeerWarning => {
    switch (code) {
      case 'slow-download':
        return {
          code,
          rateBps: s.rateBps,
          needBps: s.needBps,
          bufferInS: bufferRunsOutInS(s),
          limitBps: s.downLimitBps,
        }
      case 'frame-drops':
        return { code }
    }
  })
  if (s.behindS !== null && s.behindS > 0) own.push({ code: 'behind', behindS: s.behindS })
  return sortPeerWarnings([...own, ...extra])
}

/**
 * Seconds until a playing member's buffer runs out at these rates: it drains at need − rate. null when it does not
 * drain (paused, seeking, buffering: the phase says so), when something is unknown, or an hour or more away.
 */
export function bufferRunsOutInS(s: Pick<PeerSync, 'phase' | 'bufferedAheadS' | 'rateBps' | 'needBps'>): number | null {
  const { bufferedAheadS: buf, rateBps: rate, needBps: need } = s
  if (s.phase !== 'playing' || buf === null || rate === null || need === null) return null
  if (![buf, rate, need].every(Number.isFinite) || need <= 0 || rate >= need) return null
  const inS = buf / (1 - rate / need)
  return inS < 3600 ? inS : null
}
