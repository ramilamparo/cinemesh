import type { NoticeEvent } from '../../shared/ipc/core.js'
import type { PeerWarning } from '../../shared/peer-warnings.js'

// Viewers count the pieces that fail their hash check (TransferEngine.hashFailures) and report them with their
// striping report (striping.ts). The host's source watchdog compares size and mtime only, so a file rewritten in place
// with both kept, or a disk returning bad data, slips past it: the host keeps serving bytes that no longer match the
// torrent, and its viewers fetch the same pieces again and again. One failure can be a fluke; these are not.

/** the same piece failing this often at one viewer: the host keeps serving it wrong */
export const SAME_PIECE_FAILS = 3
/** or this many viewers with failures at all */
export const VIEWERS_WITH_FAILS = 2

export interface HashFailReport {
  total: number
  /** [piece, failures] */
  worst: readonly (readonly [number, number])[]
}

export const HASH_FAILS_NOTICE: NoticeEvent = {
  level: 'warn',
  code: 'transfer.hash-fails',
  message:
    'Viewers keep receiving parts of the video that fail their check: the video file probably changed on disk, ' +
    'or the disk is failing. Host the video again to re-prepare it.',
}

/**
 * Host: the viewers' latest reports, and whether they add up to a warning (SAME_PIECE_FAILS, VIEWERS_WITH_FAILS).
 * `onAlert` runs once, the first time they do; from then on warnings() names every viewer still reporting failures.
 */
export class HashFailWatch {
  private readonly byViewer = new Map<string, HashFailReport>()
  private alerted = false

  constructor(private readonly onAlert: () => void) {}

  /** Each report replaces that viewer's last; a total of 0 clears it. */
  update(memberId: string, r: HashFailReport): void {
    if (r.total > 0) this.byViewer.set(memberId, r)
    else this.byViewer.delete(memberId)
    if (this.alerted || !this.alarming()) return
    this.alerted = true
    this.onAlert()
  }

  /** The viewer left: its failures stop counting (a warning already given stays given). */
  remove(memberId: string): void {
    this.byViewer.delete(memberId)
  }

  get alerting(): boolean {
    return this.alerted
  }

  /**
   * Peer list entries by member id: none until the alert, then one for each viewer with failures (its text is in
   * shared/peer-warnings.ts).
   */
  warnings(): Map<string, PeerWarning[]> {
    const out = new Map<string, PeerWarning[]>()
    if (!this.alerted) return out
    for (const [id, r] of this.byViewer) out.set(id, [{ code: 'hash-fails', total: r.total }])
    return out
  }

  private alarming(): boolean {
    if (this.byViewer.size >= VIEWERS_WITH_FAILS) return true
    for (const r of this.byViewer.values()) if (r.worst.some(([, n]) => n >= SAME_PIECE_FAILS)) return true
    return false
  }
}
