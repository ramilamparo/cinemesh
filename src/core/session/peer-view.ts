import type { PeerView } from '../../shared/ipc/core.js'
import { hintFor } from '../net/diagnostics.js'
import type { MemberView } from '../net/room.js'
import type { PeerSync } from '../sync/engine.js'
import type { PeerTransferStats } from '../transfer/engine.js'

/** One row per member: net (who, path, RTT) + sync (phase, drift, coverage) + transfer (speeds, have %). */
export function mergePeerViews(
  members: readonly MemberView[],
  sync: readonly PeerSync[],
  transfer: readonly PeerTransferStats[],
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
      warnings: s?.warnings ?? [],
      exempt: s?.exempt ?? false,
      posS: s?.posS ?? null,
      ...(lastError ? { lastError } : {}),
    }
  })
}
