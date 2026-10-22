import { type FileHandle, open } from 'node:fs/promises'

/** Positioned reads over a file. Returns fewer bytes than asked only at the end of the file. */
export interface ByteSource {
  readonly size: number
  read(pos: number, len: number): Promise<Uint8Array>
  /** Bytes read from the underlying storage so far (for progress and tests). */
  readonly bytesRead: number
}

const READ_AHEAD = 64 * 1024

/**
 * File reader with a 64 KiB read-ahead window: header parsing reads many tiny fields close together,
 * and never the whole file. Larger reads bypass the window.
 */
export class FileSource implements ByteSource {
  bytesRead = 0
  private winPos = 0
  private win: Uint8Array = new Uint8Array(0)

  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<FileSource> {
    const fh = await open(path, 'r')
    try {
      const st = await fh.stat()
      return new FileSource(fh, st.size)
    } catch (e) {
      await fh.close()
      throw e
    }
  }

  async read(pos: number, len: number): Promise<Uint8Array> {
    const end = Math.min(this.size, pos + Math.max(0, len))
    if (pos >= end) return new Uint8Array(0)
    if (pos >= this.winPos && end <= this.winPos + this.win.length) {
      return this.win.subarray(pos - this.winPos, end - this.winPos)
    }
    if (end - pos > READ_AHEAD) return this.readRaw(pos, end - pos)
    this.win = await this.readRaw(pos, Math.min(READ_AHEAD, this.size - pos))
    this.winPos = pos
    return this.win.subarray(0, end - pos)
  }

  async close(): Promise<void> {
    await this.fh.close()
  }

  private async readRaw(pos: number, len: number): Promise<Uint8Array> {
    const buf = new Uint8Array(len)
    let off = 0
    while (off < len) {
      const { bytesRead } = await this.fh.read(buf, off, len - off, pos + off)
      if (bytesRead === 0) break
      off += bytesRead
    }
    this.bytesRead += off
    return off === len ? buf : buf.subarray(0, off)
  }
}

export class BufferSource implements ByteSource {
  bytesRead = 0
  readonly size: number

  constructor(private readonly buf: Uint8Array) {
    this.size = buf.length
  }

  read(pos: number, len: number): Promise<Uint8Array> {
    const out = this.buf.subarray(Math.min(pos, this.size), Math.min(this.size, pos + len))
    this.bytesRead += out.length
    return Promise.resolve(out)
  }
}

export function readU32BE(b: Uint8Array, at: number): number {
  return (((b[at] ?? 0) << 24) >>> 0) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0))
}

export function readU64BE(b: Uint8Array, at: number): number {
  return readU32BE(b, at) * 2 ** 32 + readU32BE(b, at + 4)
}

export function readU32LE(b: Uint8Array, at: number): number {
  return readU32BE(Uint8Array.of(b[at + 3] ?? 0, b[at + 2] ?? 0, b[at + 1] ?? 0, b[at] ?? 0), 0)
}

export function fourcc(b: Uint8Array, at: number): string {
  return String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0)
}

export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('aborted')
}

export type ProgressFn = (done: number, total: number) => void
