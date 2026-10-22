import type { Torrent } from 'webtorrent'
import { PIECE_MISSING, PIECE_PARTIAL, PIECE_VERIFIED } from '../../shared/media/media-map.js'

/**
 * R8 piece states (plan §4.2): verified when WebTorrent has dropped the Piece (null), partial when some
 * blocks arrived or a wire has a request out for it, missing otherwise. O(pieces + requests); reuses
 * `out` when it has the right length.
 */
export function pieceStates(t: Torrent, out?: Uint8Array): Uint8Array {
  const n = t.pieces.length
  const s = out?.length === n ? out : new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const p = t.pieces[i]
    s[i] = p === null ? PIECE_VERIFIED : p !== undefined && p.missing < p.length ? PIECE_PARTIAL : PIECE_MISSING
  }
  for (const w of t.wires) {
    for (const r of w.requests) if (s[r.piece] === PIECE_MISSING) s[r.piece] = PIECE_PARTIAL
  }
  return s
}

/** Cheap equality for change detection before emitting. */
export function sameStates(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
