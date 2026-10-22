import type { Torrent } from 'webtorrent'
import type { PieceReader, StreamFile, StreamSource } from '../media/stream-server.js'
import type { Scheduler } from './scheduler.js'

let readerSeq = 0

/**
 * The stream server's view of the viewer's torrent (plan §4.2 "PieceSource"). Reads go straight to the
 * chunk store; a reader blocked on a missing piece puts that piece first in the scheduler's order.
 * Never uses file.createReadStream(): its FileIterator would add a priority-1 selection to EOF.
 */
export class PieceSource implements StreamSource {
  readonly pieceLength: number
  readonly files: readonly StreamFile[]
  private readonly waiters = new Map<number, Set<() => void>>()
  private readonly onVerified = (i: number): void => {
    const set = this.waiters.get(i)
    if (!set) return
    this.waiters.delete(i)
    for (const resolve of set) resolve()
  }

  constructor(
    private readonly t: Torrent,
    private readonly scheduler: Scheduler,
  ) {
    this.pieceLength = t.pieceLength
    this.files = t.files.map((f, index) => ({ index, name: f.name, offset: f.offset, length: f.length }))
    t.on('verified', this.onVerified)
  }

  has(piece: number): boolean {
    return this.t.pieces[piece] === null
  }

  waitVerified(piece: number, signal: AbortSignal): Promise<void> {
    if (this.has(piece)) return Promise.resolve()
    if (signal.aborted) return Promise.reject(signal.reason as Error)
    return new Promise<void>((resolve, reject) => {
      const set = this.waiters.get(piece) ?? new Set()
      this.waiters.set(piece, set)
      const done = (): void => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        set.delete(done)
        if (set.size === 0) this.waiters.delete(piece)
        reject(signal.reason as Error)
      }
      set.add(done)
      signal.addEventListener('abort', abort, { once: true })
    })
  }

  read(piece: number, offset: number, length: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.t.store.get(piece, { offset, length }, (err, buf) => {
        if (err || !buf) reject(err ?? new Error(`piece ${String(piece)} unreadable`))
        else resolve(buf)
      })
    })
  }

  openReader(fileIndex: number, _byte: number): PieceReader {
    const key = `reader-${String(fileIndex)}-${String(++readerSeq)}`
    let waitingOn: number | null = null
    return {
      update: () => {
        // position alone does not change the order: the room playhead drives L1-L3
      },
      blockedOn: (piece) => {
        waitingOn = piece
        this.scheduler.addBlocked(key, piece)
        void this.waitVerified(piece, new AbortController().signal).then(() => {
          if (waitingOn === piece) {
            waitingOn = null
            this.scheduler.dropBlocked(key)
          }
        })
      },
      close: () => {
        waitingOn = null
        this.scheduler.dropBlocked(key)
      },
    }
  }

  destroy(): void {
    this.t.removeListener('verified', this.onVerified)
    this.waiters.clear()
  }
}
