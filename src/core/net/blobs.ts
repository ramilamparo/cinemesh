import { open } from 'node:fs/promises'
import { CodedError } from '../../shared/result.js'
import { blake2b, toHex } from './crypto.js'
import { NET_ERRORS } from './errors.js'
import type { RoomPeer } from './peer.js'
import type { Frame } from './wire.js'

// Small content-addressed files (the .torrent and the media manifest) fetched from any member that holds
// them, over the ctrl lane (plan §5.2): blob.get {hash, offset, len ≤ 45 KiB} → blob.data {hash, offset,
// total, b64}. 45 KiB of base64 plus JSON stays under the 64 KiB ctrl frame limit. Hash = BLAKE2b-256, hex.

export const BLOB_CHUNK_MAX = 45 * 1024
export const BLOB_MAX_BYTES = 64 * 1024 * 1024
export const BLOB_REQUEST_TIMEOUT_MS = 10_000
const PARALLEL_CHUNKS = 4

export function blobHash(data: Uint8Array): string {
  return toHex(blake2b(data, 32))
}

export interface BlobProvider {
  /** null when this blob is not held here */
  read(hash: string, offset: number, len: number): Promise<{ total: number; data: Uint8Array } | null>
}

export class MemoryBlobProvider implements BlobProvider {
  private readonly blobs = new Map<string, Uint8Array>()

  /** Returns the blob's hash. */
  add(data: Uint8Array): string {
    const hash = blobHash(data)
    this.blobs.set(hash, data)
    return hash
  }

  delete(hash: string): void {
    this.blobs.delete(hash)
  }

  read(hash: string, offset: number, len: number): Promise<{ total: number; data: Uint8Array } | null> {
    const blob = this.blobs.get(hash)
    if (!blob) return Promise.resolve(null)
    return Promise.resolve({ total: blob.byteLength, data: blob.subarray(offset, offset + len) })
  }
}

/** Serves files already on disk (e.g. the host's cached .torrent); the hash is trusted, not re-checked. */
export class FileBlobProvider implements BlobProvider {
  private readonly files = new Map<string, string>()

  add(hash: string, path: string): void {
    this.files.set(hash, path)
  }

  delete(hash: string): void {
    this.files.delete(hash)
  }

  async read(hash: string, offset: number, len: number): Promise<{ total: number; data: Uint8Array } | null> {
    const path = this.files.get(hash)
    if (!path) return null
    const fh = await open(path, 'r').catch(() => null)
    if (!fh) return null
    try {
      const total = (await fh.stat()).size
      const n = Math.max(0, Math.min(len, total - offset))
      const data = Buffer.alloc(n)
      if (n > 0) await fh.read(data, 0, n, offset)
      return { total, data }
    } finally {
      await fh.close()
    }
  }
}

/** The part of Room that blobs need. */
export interface BlobRoom {
  peers(): RoomPeer[]
  onCtrl(ns: string, handler: (peer: RoomPeer, frame: Frame) => void): () => void
}

interface Waiter {
  resolve: (chunk: { total: number; data: Buffer } | null) => void
  timer: NodeJS.Timeout
}

export interface FetchOptions {
  /** expected size, when known (session.announce carries it) */
  size?: number
  signal?: AbortSignal
}

export class Blobs {
  private provider: BlobProvider | null
  private readonly waiters = new Map<string, Waiter>()
  private readonly unsubscribe: () => void
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(
    private readonly room: BlobRoom,
    provider: BlobProvider | null = null,
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ) {
    this.provider = provider
    this.timeoutMs = opts.timeoutMs ?? BLOB_REQUEST_TIMEOUT_MS
    this.maxBytes = opts.maxBytes ?? BLOB_MAX_BYTES
    this.unsubscribe = room.onCtrl('blob', (peer, frame) => {
      if (frame.t === 'get') void this.serve(peer, frame)
      else if (frame.t === 'data') this.onData(peer, frame)
    })
  }

  setProvider(provider: BlobProvider | null): void {
    this.provider = provider
  }

  /** Fetches a blob from the first member that has it (host first) and checks its hash. */
  async fetch(hash: string, opts: FetchOptions = {}): Promise<Buffer> {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('blob hash must be 64 hex characters')
    const local = await this.provider?.read(hash, 0, this.maxBytes)
    if (local && local.data.byteLength === local.total && blobHash(local.data) === hash) return Buffer.from(local.data)
    let lastError: CodedError = new CodedError(NET_ERRORS.blobNotFound, 'no member has this file')
    const peers = [...this.room.peers()].sort((a, b) => Number(b.isHost) - Number(a.isHost))
    for (const peer of peers) {
      opts.signal?.throwIfAborted()
      try {
        const data = await this.fetchFrom(peer, hash, opts)
        if (data) return data
      } catch (e) {
        if (opts.signal?.aborted) throw e
        if (e instanceof CodedError) lastError = e
      }
    }
    throw lastError
  }

  destroy(): void {
    this.unsubscribe()
    for (const w of this.waiters.values()) {
      clearTimeout(w.timer)
      w.resolve(null)
    }
    this.waiters.clear()
  }

  private async fetchFrom(peer: RoomPeer, hash: string, opts: FetchOptions): Promise<Buffer | null> {
    const first = await this.request(peer, hash, 0, BLOB_CHUNK_MAX)
    if (!first) return null
    const { total } = first
    if (total > this.maxBytes || (opts.size !== undefined && total !== opts.size)) {
      throw new CodedError(NET_ERRORS.blobHash, 'the file has an unexpected size')
    }
    const out = Buffer.alloc(total)
    first.data.copy(out, 0)
    let next = first.data.byteLength
    const worker = async (): Promise<boolean> => {
      while (next < total) {
        opts.signal?.throwIfAborted()
        const offset = next
        next += BLOB_CHUNK_MAX
        const chunk = await this.request(peer, hash, offset, Math.min(BLOB_CHUNK_MAX, total - offset))
        if (chunk?.total !== total || chunk.data.byteLength === 0) return false
        chunk.data.copy(out, offset)
      }
      return true
    }
    const results = await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, worker))
    if (results.includes(false)) return null
    if (blobHash(out) !== hash) throw new CodedError(NET_ERRORS.blobHash, 'the file did not match its hash')
    return out
  }

  private request(
    peer: RoomPeer,
    hash: string,
    offset: number,
    len: number,
  ): Promise<{ total: number; data: Buffer } | null> {
    const key = `${peer.id}|${hash}|${String(offset)}`
    this.waiters.get(key)?.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key)
        resolve(null)
      }, this.timeoutMs)
      this.waiters.set(key, {
        resolve: (v) => {
          clearTimeout(timer)
          this.waiters.delete(key)
          resolve(v)
        },
        timer,
      })
      if (!peer.sendCtrl({ ns: 'blob', t: 'get', hash, offset, len })) this.waiters.get(key)?.resolve(null)
    })
  }

  private onData(peer: RoomPeer, frame: Frame): void {
    const { hash, offset } = frame
    if (typeof hash !== 'string' || typeof offset !== 'number') return
    const waiter = this.waiters.get(`${peer.id}|${hash}|${String(offset)}`)
    if (!waiter) return
    if (frame.missing === true || typeof frame.total !== 'number' || typeof frame.b64 !== 'string') {
      waiter.resolve(null)
      return
    }
    const data = Buffer.from(frame.b64, 'base64')
    waiter.resolve(data.byteLength <= BLOB_CHUNK_MAX ? { total: frame.total, data } : null)
  }

  private async serve(peer: RoomPeer, frame: Frame): Promise<void> {
    const { hash, offset, len } = frame
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(len)) return
    const off = offset as number
    const length = Math.min(len as number, BLOB_CHUNK_MAX)
    if (off < 0 || length <= 0) return
    const chunk = await this.provider?.read(hash, off, length).catch(() => null)
    if (!chunk || (off >= chunk.total && chunk.total > 0)) {
      peer.sendCtrl({ ns: 'blob', t: 'data', hash, offset: off, missing: true })
      return
    }
    const data = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
    peer.sendCtrl({ ns: 'blob', t: 'data', hash, offset: off, total: chunk.total, b64: data.toString('base64') })
  }
}
