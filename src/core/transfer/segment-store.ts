import { constants } from 'node:fs'
import { type FileHandle, mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'

type Cb<T = void> = (err: Error | null, value?: T) => void
type GetOpts = { offset?: number; length?: number }

export const SEGMENT_BYTES = 64 * 1024 * 1024
const MAX_OPEN_SEGMENTS = 32
const ENOSPC_RETRY_MS = 5000

export interface SegmentStoreOptions {
  dir: string
  length: number
  segmentBytes?: number
  /** called once per out-of-space episode; writes are parked and retried, never failed */
  onDiskFull?: () => void
  onDiskOk?: () => void
  /** WebTorrent constructs the store itself; this hands the instance to the engine (journal sync) */
  onCreate?: (store: SegmentStore) => void
  /** writes in flight crossed the high (true) or low (false) water mark: the disk is slower than the network */
  onWriteLag?: (lagging: boolean) => void
}

const LAG_HIGH_BYTES = 64 * 1024 * 1024
const LAG_LOW_BYTES = 16 * 1024 * 1024

export function segmentName(k: number): string {
  return `${String(k).padStart(6, '0')}.part`
}

/**
 * Viewer chunk store: the torrent's bytes split into 64 MiB segment files (plan §4.2), so a first write
 * far into the movie never makes NTFS zero-fill gigabytes. A segment that is missing or too short
 * reports the piece as absent. When the disk is full the write is parked and retried every 5 s,
 * because a put() error would make WebTorrent destroy the whole torrent (torrent.js put callback).
 */
export class SegmentStore {
  readonly chunkLength: number
  private readonly dir: string
  private readonly length: number
  private readonly segmentBytes: number
  private readonly chunkCount: number
  private readonly lastChunkLength: number
  private readonly fds = new Map<number, Promise<FileHandle>>()
  private readonly dirty = new Set<number>()
  private readonly failedSync = new Set<number>()
  private ready: Promise<void> | null = null
  private syncing: Promise<unknown> = Promise.resolve()
  private parked = 0
  private inflightBytes = 0
  private lagging = false
  private closed = false
  private readonly opts: SegmentStoreOptions

  constructor(chunkLength: number, opts: SegmentStoreOptions) {
    const segmentBytes = opts.segmentBytes ?? SEGMENT_BYTES
    if (segmentBytes % chunkLength !== 0) throw new Error('segment size must be a multiple of the piece length')
    this.chunkLength = chunkLength
    this.dir = join(opts.dir, 'seg')
    this.length = opts.length
    this.segmentBytes = segmentBytes
    this.chunkCount = Math.ceil(opts.length / chunkLength)
    this.lastChunkLength = opts.length - (this.chunkCount - 1) * chunkLength
    this.opts = opts
    opts.onCreate?.(this)
  }

  put(index: number, buf: Buffer, cb: Cb): void {
    const where = this.locate(index)
    if (!where || buf.byteLength !== where.size) {
      queueMicrotask(() => cb(new Error(`bad put for chunk ${String(index)}`)))
      return
    }
    this.trackInflight(buf.byteLength)
    void this.write(where.segment, where.offset, buf)
      .finally(() => this.trackInflight(-buf.byteLength))
      .then(
        () => cb(null),
        (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
      )
  }

  /** abstract-chunk-store: opts is optional, so WebTorrent sometimes calls get(index, cb). */
  get(index: number, optsOrCb: GetOpts | Cb<Buffer> | null | undefined, maybeCb?: Cb<Buffer>): void {
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
    const opts = typeof optsOrCb === 'function' ? null : optsOrCb
    if (!cb) throw new Error('chunk store get() needs a callback')
    const where = this.locate(index)
    if (!where) {
      queueMicrotask(() => cb(new Error(`chunk ${String(index)} out of range`)))
      return
    }
    const offset = opts?.offset ?? 0
    const length = opts?.length ?? where.size - offset
    if (offset < 0 || length < 0 || offset + length > where.size) {
      queueMicrotask(() => cb(new Error(`invalid range in chunk ${String(index)}`)))
      return
    }
    void this.read(where.segment, where.offset + offset, length).then(
      (b) => cb(null, b),
      (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
    )
  }

  /**
   * fdatasync every segment written since the last call (the journal calls this before saving) and
   * resolve with the ones synced. Serialized: a segment another caller is still syncing is waited for,
   * never taken as clean. A segment that fails stays dirty, is reported by syncFailed() until a later
   * sync succeeds, and makes the call reject.
   */
  syncDirty(): Promise<number[]> {
    const run = this.syncing.then(() => this.syncOnce())
    this.syncing = run.catch(() => undefined)
    return run
  }

  /**
   * After a syncDirty(): true when this piece's segment failed to sync. Every other piece written
   * before that call is durable (its segment either synced then or had nothing unsynced).
   */
  syncFailed(index: number): boolean {
    const k = this.segmentOf(index)
    return k === null || this.failedSync.has(k)
  }

  /** The segment holding a piece (null when out of range). */
  segmentOf(index: number): number | null {
    return this.locate(index)?.segment ?? null
  }

  private async syncOnce(): Promise<number[]> {
    const segments = [...this.dirty]
    this.dirty.clear()
    const results = await Promise.allSettled(segments.map((k) => this.datasync(k)))
    let failure: Error | null = null
    const synced: number[] = []
    for (const [n, k] of segments.entries()) {
      const r = results[n]
      if (r?.status === 'fulfilled') {
        synced.push(k)
        this.failedSync.delete(k)
      } else {
        this.dirty.add(k)
        this.failedSync.add(k)
        const reason: unknown = r?.reason
        failure ??= reason instanceof Error ? reason : new Error(`segment ${segmentName(k)} was not synced`)
      }
    }
    if (failure) throw failure
    return synced
  }

  private async datasync(k: number): Promise<void> {
    // looked up synchronously: evict() may close it meanwhile (FileHandle.close waits for the sync)
    const fd = this.fds.get(k) ?? (this.closed ? null : this.handle(k, false))
    if (!fd) throw new Error(`segment ${segmentName(k)} was closed before it was synced`)
    await (await fd).datasync()
  }

  private trackInflight(delta: number): void {
    this.inflightBytes += delta
    let lagging = this.lagging
    if (!lagging && this.inflightBytes > LAG_HIGH_BYTES) lagging = true
    else if (lagging && this.inflightBytes < LAG_LOW_BYTES) lagging = false
    if (lagging === this.lagging) return
    this.lagging = lagging
    // not from inside put(): the engine re-plans the torrent's selections in response
    queueMicrotask(() => this.opts.onWriteLag?.(lagging))
  }

  get diskFull(): boolean {
    return this.parked > 0
  }

  close(cb: Cb = () => undefined): void {
    void this.closeAll().then(
      () => cb(null),
      (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
    )
  }

  destroy(cb: Cb = () => undefined): void {
    void this.closeAll()
      .then(() => rm(this.dir, { recursive: true, force: true }))
      .then(
        () => cb(null),
        (e: unknown) => cb(e instanceof Error ? e : new Error(String(e))),
      )
  }

  private locate(index: number): { segment: number; offset: number; size: number } | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.chunkCount) return null
    const byte = index * this.chunkLength
    const size = index === this.chunkCount - 1 ? this.lastChunkLength : this.chunkLength
    return { segment: Math.floor(byte / this.segmentBytes), offset: byte % this.segmentBytes, size }
  }

  private async write(segment: number, offset: number, buf: Buffer): Promise<void> {
    let parkedHere = false
    const unpark = (): void => {
      if (!parkedHere) return
      parkedHere = false
      if (--this.parked === 0) this.opts.onDiskOk?.()
    }
    for (;;) {
      try {
        const fd = await this.handle(segment, true)
        let done = 0
        while (done < buf.byteLength) {
          const { bytesWritten } = await fd.write(buf, done, buf.byteLength - done, offset + done)
          done += bytesWritten
        }
        this.dirty.add(segment)
        unpark()
        return
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOSPC' || this.closed) {
          unpark()
          throw e
        }
        if (!parkedHere) {
          parkedHere = true
          if (this.parked++ === 0) this.opts.onDiskFull?.()
        }
        await new Promise((r) => setTimeout(r, ENOSPC_RETRY_MS))
      }
    }
  }

  private async read(segment: number, offset: number, length: number): Promise<Buffer> {
    const fd = await this.handle(segment, false)
    const out = Buffer.allocUnsafe(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await fd.read(out, got, length - got, offset + got)
      if (bytesRead === 0) throw new Error(`segment ${segmentName(segment)} is short`)
      got += bytesRead
    }
    return out
  }

  private handle(segment: number, create: boolean): Promise<FileHandle> {
    if (this.closed) return Promise.reject(new Error('store closed'))
    const existing = this.fds.get(segment)
    if (existing) {
      this.fds.delete(segment) // re-insert: Map order doubles as LRU order
      this.fds.set(segment, existing)
      return existing
    }
    const path = join(this.dir, segmentName(segment))
    const flags = create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDWR
    const opening = (async () => {
      if (create) {
        // a failed mkdir (e.g. ENOSPC) must be retried, not cached
        this.ready ??= mkdir(this.dir, { recursive: true }).then(
          () => undefined,
          (e: unknown) => {
            this.ready = null
            throw e
          },
        )
        await this.ready
      }
      return open(path, flags, 0o600)
    })()
    // a failed open (e.g. missing segment on read) must not poison the cache
    opening.catch(() => this.fds.get(segment) === opening && this.fds.delete(segment))
    this.fds.set(segment, opening)
    this.evict()
    return opening
  }

  private evict(): void {
    while (this.fds.size > MAX_OPEN_SEGMENTS) {
      const oldest = this.fds.keys().next().value
      if (oldest === undefined || this.dirty.has(oldest)) return // keep unsynced segments open
      const fd = this.fds.get(oldest)
      this.fds.delete(oldest)
      void fd?.then((h) => h.close()).catch(() => undefined)
    }
  }

  private async closeAll(): Promise<void> {
    if (this.closed) return
    await this.syncDirty().catch(() => undefined) // what fails stays dirty: the journal will not claim it
    this.closed = true
    const fds = [...this.fds.values()]
    this.fds.clear()
    await Promise.all(fds.map((p) => p.then((h) => h.close()).catch(() => undefined)))
  }
}
