import { open, readFile, rename } from 'node:fs/promises'

/** BitTorrent bitfield layout (MSB first), as WebTorrent's `bitfield` add option expects. */
export function bitfieldBytes(pieceCount: number): Uint8Array {
  return new Uint8Array(Math.ceil(pieceCount / 8))
}

export function bitGet(bits: Uint8Array, i: number): boolean {
  return ((bits[i >> 3] ?? 0) & (128 >> (i & 7))) !== 0
}

export function bitSet(bits: Uint8Array, i: number, on = true): void {
  const byte = bits[i >> 3] ?? 0
  bits[i >> 3] = on ? byte | (128 >> (i & 7)) : byte & ~(128 >> (i & 7))
}

/** Upper bound on the recent pieces kept (and re-hashed on resume). */
export const MAX_RECENT_PIECES = 128

/** The journal's name inside a transfer folder. */
export const JOURNAL_FILE = 'state.json'

interface JournalFile {
  v: 1
  infoHash: string
  pieceCount: number
  bitfield: string
  savedAt: number
  /** the last pieces verified in each segment synced shortly before this save; resume re-hashes them */
  recent?: number[]
}

/**
 * Remembers which pieces are on disk so a later session resumes without re-checking the whole file.
 * Order matters: the segments are fdatasync'd before a bitfield that includes their pieces is saved
 * (plan §4.2 "Journal"), so a crash can only lose recent pieces, never claim missing ones.
 */
export class Journal {
  private readonly bits: Uint8Array
  private changed = false
  private recentPieces: number[]
  private saving: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly file: string,
    private readonly infoHash: string,
    private readonly pieceCount: number,
    bits: Uint8Array | null,
    recent: number[],
  ) {
    this.bits = bits ?? bitfieldBytes(pieceCount)
    this.recentPieces = bits ? recent : []
  }

  static async open(file: string, infoHash: string, pieceCount: number): Promise<Journal> {
    const saved = await readFile(file, 'utf8')
      .then((t) => JSON.parse(t) as Partial<JournalFile>)
      .catch(() => null)
    const valid =
      saved?.v === 1 &&
      saved.infoHash === infoHash &&
      saved.pieceCount === pieceCount &&
      typeof saved.bitfield === 'string'
    const decoded = valid ? new Uint8Array(Buffer.from(saved.bitfield as string, 'base64')) : null
    const bits = decoded?.byteLength === Math.ceil(pieceCount / 8) ? decoded : null
    const recent = (Array.isArray(saved?.recent) ? (saved.recent as unknown[]) : [])
      .filter((i): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < pieceCount)
      .slice(-MAX_RECENT_PIECES)
    return new Journal(file, infoHash, pieceCount, bits, recent)
  }

  /** The bitfield to hand to WebTorrent on resume (a copy). */
  bitfield(): Uint8Array {
    return this.bits.slice()
  }

  has(i: number): boolean {
    return bitGet(this.bits, i)
  }

  count(): number {
    let n = 0
    for (let i = 0; i < this.pieceCount; i++) if (bitGet(this.bits, i)) n++
    return n
  }

  /** Call only after the piece's segment has been synced (see SegmentStore.syncDirty). */
  mark(i: number): void {
    if (bitGet(this.bits, i)) return
    bitSet(this.bits, i)
    this.changed = true
  }

  clear(i: number): void {
    if (!bitGet(this.bits, i)) return
    bitSet(this.bits, i, false)
    this.changed = true
  }

  /** The pieces verified last before the saved journal was written (what resume re-hashes). */
  recent(): readonly number[] {
    return this.recentPieces
  }

  /** Written with the next save; on its own it does not make one necessary. */
  setRecent(pieces: readonly number[]): void {
    this.recentPieces = pieces.slice(-MAX_RECENT_PIECES)
  }

  /** Serialized (every save goes through the same tmp file); a failed save is retried by the next one. */
  save(): Promise<void> {
    const run = this.saving.then(() => this.saveOnce())
    this.saving = run.catch(() => undefined)
    return run
  }

  private async saveOnce(): Promise<void> {
    if (!this.changed) return
    this.changed = false
    try {
      await this.write()
    } catch (e) {
      this.changed = true
      throw e
    }
  }

  private async write(): Promise<void> {
    const body: JournalFile = {
      v: 1,
      infoHash: this.infoHash,
      pieceCount: this.pieceCount,
      bitfield: Buffer.from(this.bits).toString('base64'),
      savedAt: Date.now(),
      recent: this.recentPieces.filter((i) => bitGet(this.bits, i)),
    }
    const tmp = `${this.file}.tmp`
    const fh = await open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(JSON.stringify(body))
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, this.file)
  }
}
