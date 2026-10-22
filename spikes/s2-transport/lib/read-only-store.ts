// Throwaway ReadOnlyFileStore (plan §4.2 "Host seeding"): serves pieces straight from the host's source
// file(s) through read-only fds. WebTorrent constructs it as `new opts.store(pieceLength, {...storeOpts,
// torrent, path, files, length, name, addUID, rootDir, max})` (webtorrent lib/torrent.js:588-600), then wraps
// it in CacheChunkStore (torrent.js:604-608, which calls get(index, cb) with no opts) and ImmediateChunkStore
// (torrent.js:610-612). Both wrappers read `.chunkLength` and require `get` and `put`.
import { closeSync, fstatSync, openSync, read } from 'node:fs'

interface StoreFile {
  offset: number
  length: number
}

export interface ReadOnlyStoreOpts {
  sourcePaths: string[]
  files: StoreFile[]
  length: number
}

type GetOpts = { offset?: number; length?: number } | null
type GetCb = (err: Error | null, buf?: Buffer) => void

export class ReadOnlyFileStore {
  readonly chunkLength: number
  private readonly length: number
  private readonly files: (StoreFile & { fd: number })[]
  private closed = false
  /** counters for the report */
  static stats = { gets: 0, bytes: 0, puts: 0 }

  constructor(chunkLength: number, opts: ReadOnlyStoreOpts) {
    this.chunkLength = Number(chunkLength)
    this.length = opts.length
    if (opts.sourcePaths.length !== opts.files.length) throw new Error('one source path per torrent file')
    this.files = opts.files.map((f, i) => {
      const fd = openSync(opts.sourcePaths[i] as string, 'r') // O_RDONLY: the source can never be written
      if (fstatSync(fd).size !== f.length) throw new Error(`size mismatch for ${opts.sourcePaths[i]}`)
      return { offset: f.offset, length: f.length, fd }
    })
  }

  put(_index: number, _buf: Buffer, cb: (err: Error | null) => void = () => {}): void {
    ReadOnlyFileStore.stats.puts++
    queueMicrotask(() => cb(new Error('ReadOnlyFileStore: put is not allowed')))
  }

  get(index: number, opts: GetOpts | GetCb, cb?: GetCb): void {
    if (typeof opts === 'function') return this.get(index, null, opts)
    const done = cb ?? (() => {})
    if (this.closed) return queueMicrotask(() => done(new Error('ReadOnlyFileStore closed')))
    const pieceStart = index * this.chunkLength
    const pieceLen = Math.min(this.chunkLength, this.length - pieceStart)
    const from = opts?.offset ?? 0
    const len = opts?.length ?? pieceLen - from
    if (pieceLen <= 0 || from < 0 || from + len > pieceLen) {
      return queueMicrotask(() => done(new Error(`bad range ${index}:${from}+${len}`)))
    }
    const buf = Buffer.allocUnsafe(len)
    const start = pieceStart + from
    // a piece may span several files: read each overlapping part
    const parts = this.files
      .filter((f) => f.offset < start + len && f.offset + f.length > start)
      .map((f) => {
        const a = Math.max(start, f.offset)
        const b = Math.min(start + len, f.offset + f.length)
        return { fd: f.fd, filePos: a - f.offset, bufPos: a - start, n: b - a }
      })
    let pending = parts.length
    let failed = false
    const readPart = (p: (typeof parts)[number], got = 0): void => {
      read(p.fd, buf, p.bufPos + got, p.n - got, p.filePos + got, (err, n) => {
        if (failed) return
        if (err || n === 0) {
          failed = true
          return done(err ?? new Error('short read'))
        }
        if (got + n < p.n) return readPart(p, got + n)
        if (--pending === 0) {
          ReadOnlyFileStore.stats.gets++
          ReadOnlyFileStore.stats.bytes += len
          done(null, buf)
        }
      })
    }
    for (const p of parts) readPart(p)
  }

  close(cb: (err: Error | null) => void = () => {}): void {
    if (!this.closed) for (const f of this.files) closeSync(f.fd)
    this.closed = true
    queueMicrotask(() => cb(null))
  }

  /** never deletes anything: the source belongs to the user */
  destroy(cb: (err: Error | null) => void = () => {}): void {
    this.close(cb)
  }
}
