import type { PieceReader, StreamFile, StreamSource } from '../stream-server.js'

// Test-only StreamSource: torrent bytes come from a callback, pieces become verified when the test
// releases them, and every interaction is recorded.

export type ReadAt = (absolute: number, length: number) => Promise<Uint8Array>

export class FakeSource implements StreamSource {
  readonly verified = new Set<number>()
  readonly reads: { piece: number; offset: number; length: number }[] = []
  readonly blocked: number[] = []
  readonly updates: number[] = []
  readersOpen = 0
  readersOpened = 0
  private readonly waiters = new Map<number, Set<() => void>>()

  constructor(
    readonly files: StreamFile[],
    readonly pieceLength: number,
    private readonly readAt: ReadAt,
  ) {}

  static fromBytes(bytes: Uint8Array, name: string, pieceLength: number): FakeSource {
    return new FakeSource([{ index: 0, name, offset: 0, length: bytes.length }], pieceLength, (abs, len) =>
      Promise.resolve(bytes.subarray(abs, abs + len)),
    )
  }

  get pieceCount(): number {
    const last = this.files.at(-1)
    return last ? Math.ceil((last.offset + last.length) / this.pieceLength) : 0
  }

  /** Pending waitVerified() calls. */
  get waiting(): number {
    let n = 0
    for (const s of this.waiters.values()) n += s.size
    return n
  }

  release(...pieces: number[]): void {
    for (const i of pieces) {
      this.verified.add(i)
      const set = this.waiters.get(i)
      this.waiters.delete(i)
      for (const w of set ?? []) w()
    }
  }

  releaseAll(): void {
    this.release(...Array.from({ length: this.pieceCount }, (_, i) => i))
  }

  has(piece: number): boolean {
    return this.verified.has(piece)
  }

  waitVerified(piece: number, signal: AbortSignal): Promise<void> {
    if (this.verified.has(piece)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const set = this.waiters.get(piece) ?? new Set()
      this.waiters.set(piece, set)
      const onAbort = () => {
        set.delete(done)
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      const done = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      set.add(done)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async read(piece: number, offset: number, length: number): Promise<Uint8Array> {
    if (!this.verified.has(piece)) throw new Error(`piece ${String(piece)} is not verified`)
    this.reads.push({ piece, offset, length })
    return this.readAt(piece * this.pieceLength + offset, length)
  }

  openReader(_fileIndex: number, byte: number): PieceReader {
    this.readersOpen++
    this.readersOpened++
    this.updates.push(byte)
    let open = true
    return {
      update: (b) => this.updates.push(b),
      blockedOn: (i) => {
        this.blocked.push(i)
        this.onBlocked?.(i)
      },
      close: () => {
        if (open) this.readersOpen--
        open = false
      },
    }
  }

  /** Hook for tests that release a piece when a reader blocks on it. */
  onBlocked: ((piece: number) => void) | null = null
}
