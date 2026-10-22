import { type FileHandle, open, stat } from 'node:fs/promises'

export interface SourceFile {
  /** realpath at prepare time */
  path: string
  /** byte offset inside the torrent */
  offset: number
  length: number
  /** stat at prepare time; the watchdog compares against it */
  mtimeMs: number
}

export type SourceChange = { kind: 'ok' } | { kind: 'moved'; index: number } | { kind: 'changed'; index: number }

/**
 * The host's files, opened read-only once and kept open: the store reads through these handles, so a
 * file that is renamed or moved mid-session keeps being served, and nothing can write to it.
 */
export class SourceFiles {
  private handles: Promise<FileHandle[]> | null = null
  private closed = false

  constructor(readonly files: readonly SourceFile[]) {}

  get length(): number {
    const last = this.files[this.files.length - 1]
    return last ? last.offset + last.length : 0
  }

  /** Opens every file now: one renamed before the first read would otherwise be lost, not just moved. */
  async openAll(): Promise<void> {
    await this.open()
  }

  /** Reads `length` torrent bytes starting at `start`, across file boundaries. */
  async read(start: number, length: number): Promise<Buffer> {
    const handles = await this.open()
    const out = Buffer.allocUnsafe(length)
    let done = 0
    for (let i = 0; i < this.files.length && done < length; i++) {
      const f = this.files[i]
      const h = handles[i]
      if (!f || !h) break
      const pos = start + done - f.offset
      if (pos >= f.length || pos < 0) continue
      const want = Math.min(length - done, f.length - pos)
      let got = 0
      while (got < want) {
        const { bytesRead } = await h.read(out, done + got, want - got, pos + got)
        if (bytesRead === 0) throw new Error(`source file ${f.path} is shorter than at prepare time`)
        got += bytesRead
      }
      done += want
    }
    if (done < length) throw new Error(`read past the end of the torrent (${String(start + done)})`)
    return out
  }

  /**
   * Detects content changes (size or mtime through the open handle) and moves (path no longer the same file).
   * A change anywhere wins over a move: every file's content is checked, so a moved video cannot hide an
   * edited subtitle (whose bytes would then be served against the old hashes for good).
   */
  async check(): Promise<SourceChange> {
    const handles = await this.open()
    let moved: SourceChange | null = null
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i]
      const h = handles[i]
      if (!f || !h) continue
      const now = await h.stat()
      if (now.size !== f.length || Math.abs(now.mtimeMs - f.mtimeMs) > 1) return { kind: 'changed', index: i }
      if (moved) continue
      const byPath = await stat(f.path).catch(() => null)
      if (!byPath || byPath.ino !== now.ino || byPath.dev !== now.dev) moved = { kind: 'moved', index: i }
    }
    return moved ?? { kind: 'ok' }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (!this.handles) return
    const handles = await this.handles.catch(() => [])
    await Promise.all(handles.map((h) => h.close().catch(() => undefined)))
  }

  private open(): Promise<FileHandle[]> {
    if (this.closed) return Promise.reject(new Error('source files closed'))
    this.handles ??= Promise.all(this.files.map((f) => open(f.path, 'r')))
    return this.handles
  }
}
