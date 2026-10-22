import { createHash } from 'node:crypto'
import { type FileHandle, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { JOURNAL_FILE, Journal } from './journal.js'
import { SEGMENT_BYTES, segmentName } from './segment-store.js'

export interface ResumeLayout {
  pieceLength: number
  /** torrent bytes */
  length: number
  /** SHA-1 of every piece, hex (parse-torrent's `pieces`) */
  pieces: readonly string[]
  segmentBytes: number
}

/** How many of a dirty segment's last verified pieces are re-hashed (plan §4.2 "Resume"). */
export const RECENT_PER_SEGMENT = 2

/**
 * Resume sanity before the journal's bitfield goes to WebTorrent, which trusts every claimed piece and
 * probes just one per file (torrent.js _verifyPiecesUsingBitfield):
 * - a claimed piece whose segment file is missing or too short is cleared;
 * - the last 2 pieces verified in each segment synced shortly before the journal was saved (the dirty
 *   segments, `journal.recent()`) are re-hashed, and when one fails, every piece that segment claims.
 * Clears what fails and saves the journal if it changed. Returns the number of pieces cleared.
 * Hashing runs on this thread; the work is bounded by the journal's MAX_RECENT_PIECES (plus one segment
 * per failure).
 */
export async function checkResume(journal: Journal, dir: string, layout: ResumeLayout): Promise<number> {
  const { pieceLength: P, segmentBytes: S } = layout
  const count = layout.pieces.length
  const segmentOf = (i: number): number => Math.floor((i * P) / S)
  const segPath = (k: number): string => join(dir, 'seg', segmentName(k))
  // [offset inside its segment, length]
  const where = (i: number): [number, number] => [i * P - segmentOf(i) * S, Math.min(P, layout.length - i * P)]
  let cleared = 0
  const clear = (i: number): void => {
    if (!journal.has(i)) return
    journal.clear(i)
    cleared++
  }

  for (const i of await claimedOnDisk(journal, dir, { ...layout, pieceCount: count }, false)) clear(i)

  const lastBySegment = new Map<number, number[]>()
  for (const i of journal.recent()) {
    if (!journal.has(i)) continue
    const k = segmentOf(i)
    const list = (lastBySegment.get(k) ?? []).filter((x) => x !== i)
    lastBySegment.set(k, [...list, i].slice(-RECENT_PER_SEGMENT))
  }
  const buf = Buffer.allocUnsafe(P)
  const ok = (fh: FileHandle, i: number): Promise<boolean> =>
    readHash(fh, buf, ...where(i)).then(
      (h) => h === layout.pieces[i],
      () => false, // unreadable counts as bad
    )
  for (const [k, last] of lastBySegment) {
    const fh = await open(segPath(k), 'r').catch(() => null)
    if (!fh) continue // its pieces were cleared above
    try {
      const bad: number[] = []
      for (const i of last) if (!(await ok(fh, i))) bad.push(i)
      if (bad.length > 0) {
        // a lost write rarely comes alone: check everything this segment claims
        for (let i = (k * S) / P; i < Math.min(count, ((k + 1) * S) / P); i++) {
          if (journal.has(i) && !last.includes(i) && !(await ok(fh, i))) bad.push(i)
        }
      }
      for (const i of bad) clear(i)
    } finally {
      await fh.close()
    }
  }
  if (cleared > 0) await journal.save().catch(() => undefined) // the engine's next flush retries it
  return cleared
}

/**
 * Bytes a resumed download can skip, for JoinConfirm's space check: pieces the journal in `dir` (the
 * transfer folder, `<save>/.wt-partial/<infoHash>`) claims whose segment file exists and holds all their
 * bytes. Reads state.json and stats segments only: no hashing (the join re-checks), never writes or creates
 * anything. 0 for a missing folder or a journal of another torrent.
 */
export async function trustedBytes(
  dir: string,
  torrent: { infoHash: string; pieceLength: number; pieceCount: number; length: number },
): Promise<number> {
  const { pieceLength: P, pieceCount, length } = torrent
  if (!(P > 0) || !Number.isSafeInteger(pieceCount) || pieceCount !== Math.ceil(length / P)) return 0
  const journal = await Journal.open(join(dir, JOURNAL_FILE), torrent.infoHash, pieceCount)
  const layout = { pieceLength: P, length, pieceCount, segmentBytes: SEGMENT_BYTES }
  let bytes = 0
  for (const i of await claimedOnDisk(journal, dir, layout, true)) bytes += Math.min(P, length - i * P)
  return bytes
}

/** Claimed pieces whose segment file holds all their bytes (`intact`), or the ones it does not. Stats only. */
async function claimedOnDisk(
  journal: Journal,
  dir: string,
  layout: { pieceLength: number; length: number; pieceCount: number; segmentBytes: number },
  intact: boolean,
): Promise<number[]> {
  const { pieceLength: P, segmentBytes: S } = layout
  const sizes = new Map<number, number>()
  const out: number[] = []
  for (let i = 0; i < layout.pieceCount; i++) {
    if (!journal.has(i)) continue
    const k = Math.floor((i * P) / S)
    let size = sizes.get(k)
    if (size === undefined) {
      size = await stat(join(dir, 'seg', segmentName(k))).then(
        (s) => (s.isFile() ? s.size : -1),
        () => -1,
      )
      sizes.set(k, size)
    }
    const fits = size >= i * P - k * S + Math.min(P, layout.length - i * P)
    if (fits === intact) out.push(i)
  }
  return out
}

/** SHA-1 (hex) of `length` bytes at `at`; null when the file is shorter. */
async function readHash(fh: FileHandle, buf: Buffer, at: number, length: number): Promise<string | null> {
  let got = 0
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, at + got)
    if (bytesRead === 0) return null
    got += bytesRead
  }
  return createHash('sha1').update(buf.subarray(0, length)).digest('hex')
}
