// Piece states for R8 (plan §4.2): 0 missing, 1 partial or requested, 2 verified.
import type { Torrent } from 'webtorrent'

export const MISSING = 0
export const PARTIAL = 1
export const VERIFIED = 2

/**
 * One pass over t.pieces plus one over every wire's outgoing requests. `out` is reused between calls.
 * - pieces[i] === null       -> verified (torrent.js _markVerified sets it to null)
 * - Piece.missing < length   -> some blocks received (or all received, hashing / store.put pending)
 * - in wire.requests         -> at least one block requested and not answered yet
 */
export function pieceStates(t: Torrent, out?: Uint8Array): Uint8Array {
  const pieces = t.pieces
  const s = out && out.length === pieces.length ? out : new Uint8Array(pieces.length)
  for (let i = 0; i < pieces.length; i++) {
    const pc = pieces[i]
    s[i] = pc === null ? VERIFIED : pc.missing < pc.length ? PARTIAL : MISSING
  }
  for (const wire of t.wires) {
    for (const r of wire.requests) if (s[r.piece] === MISSING) s[r.piece] = PARTIAL
  }
  return s
}
