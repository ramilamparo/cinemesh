import type { SourceFiles } from './source-files.js'

type Cb<T = void> = (err: Error | null, value?: T) => void
type GetOpts = { offset?: number; length?: number }

export interface ReadOnlyStoreOptions {
  source: SourceFiles
  length: number
}

/**
 * The host's chunk store (abstract-chunk-store API), built by WebTorrent as
 * `new Store(pieceLength, {...storeOpts, torrent, files, length, ...})` (torrent.js:588-600).
 * Serves pieces straight from the original files and refuses writes: with skipVerify every piece is
 * already verified, so WebTorrent never calls put() on the host, and this keeps the source untouchable.
 */
export class ReadOnlyFileStore {
  readonly chunkLength: number
  private readonly source: SourceFiles
  private readonly length: number
  private readonly lastChunkLength: number
  private readonly chunkCount: number

  constructor(chunkLength: number, opts: ReadOnlyStoreOptions) {
    this.chunkLength = chunkLength
    this.source = opts.source
    this.length = opts.length
    this.chunkCount = Math.ceil(opts.length / chunkLength)
    this.lastChunkLength = opts.length - (this.chunkCount - 1) * chunkLength
  }

  /** abstract-chunk-store: opts is optional, so WebTorrent sometimes calls get(index, cb). */
  get(index: number, optsOrCb: GetOpts | Cb<Buffer> | null | undefined, maybeCb?: Cb<Buffer>): void {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
    const opts = typeof optsOrCb === 'function' ? null : optsOrCb
    if (!cb) throw new Error('chunk store get() needs a callback')
    if (index < 0 || index >= this.chunkCount) {
      queueMicrotask(() => cb(new Error(`chunk ${String(index)} out of range`)))
      return
    }
    const size = index === this.chunkCount - 1 ? this.lastChunkLength : this.chunkLength
    const offset = opts?.offset ?? 0
    const length = opts?.length ?? size - offset
    if (offset < 0 || length < 0 || offset + length > size) {
      queueMicrotask(() => cb(new Error(`invalid range in chunk ${String(index)}`)))
      return
    }
    this.source.read(index * this.chunkLength + offset, length).then(
      (buf) => cb(null, buf),
      (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
    )
  }

  put(_index: number, _buf: Buffer, cb: Cb): void {
    queueMicrotask(() => cb(new Error('the host store is read-only')))
  }

  close(cb: Cb = () => undefined): void {
    queueMicrotask(() => cb(null)) // SourceFiles is owned by the engine, which also closes it
  }

  destroy(cb: Cb = () => undefined): void {
    this.close(cb) // never deletes anything
  }

  get totalLength(): number {
    return this.length
  }
}
