import { randomBytes, timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname } from 'node:path'
import { log } from '../log.js'

// Loopback HTTP range server that feeds a viewer's mpv (plan §4.3). Reads block on missing pieces
// for as long as the swarm needs (no timeout: mpv runs with network-timeout=0); a closed socket
// aborts the request and releases its waits.

/** One file of the torrent, as the transfer module lays it out. */
export interface StreamFile {
  index: number
  name: string
  /** Byte offset of the file inside the torrent. */
  offset: number
  length: number
}

/** Tracks where one HTTP reader is, so the scheduler can put its pieces first. */
export interface PieceReader {
  /** The reader moved to this file byte. */
  update(fileByte: number): void
  /** The reader waits for this piece: request it before anything else. */
  blockedOn(piece: number): void
  close(): void
}

/** What the stream server needs from the transfer module (its PieceSource implements this). */
export interface StreamSource {
  readonly pieceLength: number
  readonly files: readonly StreamFile[]
  has(piece: number): boolean
  /** Resolves once the piece is verified; rejects when `signal` aborts. Never times out. */
  waitVerified(piece: number, signal: AbortSignal): Promise<void>
  /** `length` bytes at `offset` inside a verified piece. */
  read(piece: number, offset: number, length: number): Promise<Uint8Array>
  openReader(fileIndex: number, byte: number): PieceReader
}

export const SLICE_BYTES = 256 * 1024
export const MAX_CONNECTIONS = 32
const TOKEN_BYTES = 24

const MIME: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mk3d': 'video/x-matroska',
  '.mka': 'audio/x-matroska',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
  '.ogv': 'video/ogg',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.srt': 'application/x-subrip',
  '.ass': 'text/x-ssa',
  '.ssa': 'text/x-ssa',
  '.vtt': 'text/vtt',
  '.sub': 'text/plain',
}

export function mimeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export type ParsedRange = { kind: 'none' } | { kind: 'range'; start: number; end: number } | { kind: 'unsatisfiable' }

/**
 * One `bytes=` range, end inclusive. Several ranges are refused (416) rather than served whole: a 200
 * from byte 0 would move this reader's playhead to the start of the file.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (header === undefined) return { kind: 'none' }
  const m = /^\s*bytes\s*=\s*(.+)$/i.exec(header)
  if (!m?.[1]) return { kind: 'none' }
  if (m[1].includes(',')) return { kind: 'unsatisfiable' }
  const r = /^\s*(\d*)\s*-\s*(\d*)\s*$/.exec(m[1])
  if (!r) return { kind: 'none' }
  const [, a = '', b = ''] = r
  if (a === '' && b === '') return { kind: 'none' }
  if (a === '') {
    const n = Number(b)
    if (n === 0 || size === 0) return { kind: 'unsatisfiable' }
    return { kind: 'range', start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(a)
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  if (start >= size || (b !== '' && Number(b) < start)) return { kind: 'unsatisfiable' }
  return { kind: 'range', start, end }
}

export interface StreamServerOptions {
  /** Hex token for the URL path; random 24 bytes by default. */
  token?: string
}

export class StreamServer {
  readonly token: string
  private readonly server: Server
  private readonly active = new Set<AbortController>()
  /** Responses per file index that wait on a missing piece right now. */
  private readonly blocked = new Map<number, number>()
  private boundPort = 0

  private constructor(
    private readonly source: StreamSource,
    opts: StreamServerOptions,
  ) {
    this.token = opts.token ?? randomBytes(TOKEN_BYTES).toString('hex')
    this.server = createServer({ requestTimeout: 0, keepAliveTimeout: 5000 }, (req, res) => {
      void this.handle(req, res)
    })
    this.server.maxConnections = MAX_CONNECTIONS
  }

  static async listen(source: StreamSource, opts: StreamServerOptions = {}): Promise<StreamServer> {
    const s = new StreamServer(source, opts)
    s.server.listen(0, '127.0.0.1')
    await once(s.server, 'listening')
    s.boundPort = (s.server.address() as AddressInfo).port
    return s
  }

  get port(): number {
    return this.boundPort
  }

  /** Requests whose body loop is running (including those blocked on a piece). */
  get activeRequests(): number {
    return this.active.size
  }

  /**
   * A response for this file waits on a piece. mpv's seek then queues behind that read, so the player
   * reloads instead of seeking (ADR 0004, finding 1).
   */
  isBlocked(fileIndex: number): boolean {
    return (this.blocked.get(fileIndex) ?? 0) > 0
  }

  url(fileIndex: number): string {
    const file = this.source.files.find((f) => f.index === fileIndex)
    if (!file) throw new Error(`no file ${String(fileIndex)}`)
    return `http://127.0.0.1:${String(this.port)}/${this.token}/f/${String(fileIndex)}/${encodeURIComponent(file.name)}`
  }

  async close(): Promise<void> {
    for (const ac of this.active) ac.abort(new Error('stream server closed'))
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.server.closeAllConnections()
    await closed
  }

  private file(url: string | undefined): StreamFile | null {
    const parts = (url ?? '').split('?')[0]?.split('/') ?? []
    const [, token, f, idx, name] = parts
    if (f !== 'f' || !token || !idx || name === undefined || parts.length !== 5) return null
    const a = Buffer.from(token)
    const b = Buffer.from(this.token)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    if (!/^\d+$/.test(idx)) return null
    return this.source.files.find((x) => x.index === Number(idx)) ?? null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 would send its own Host.
    const host = req.headers.host
    if (host !== `127.0.0.1:${String(this.port)}` && host !== `localhost:${String(this.port)}`) {
      res.writeHead(403, { 'Content-Length': 0 }).end()
      return
    }
    const file = this.file(req.url)
    if (!file) {
      res.writeHead(404, { 'Content-Length': 0 }).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 }).end()
      return
    }
    const size = file.length
    const range = parseRange(req.headers.range, size)
    const common = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': mimeOf(file.name),
    }
    if (range.kind === 'unsatisfiable') {
      res.writeHead(416, { ...common, 'Content-Range': `bytes */${String(size)}`, 'Content-Length': 0 }).end()
      return
    }
    const start = range.kind === 'range' ? range.start : 0
    const end = range.kind === 'range' ? range.end : size - 1
    const length = Math.max(0, end - start + 1)
    if (range.kind === 'range') {
      res.writeHead(206, {
        ...common,
        'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
        'Content-Length': length,
      })
    } else res.writeHead(200, { ...common, 'Content-Length': length })
    // Send the headers now, not with the first body byte: FFmpeg closes its previous connection only once
    // the new one answers, and a header read that never completes is what network-timeout would kill
    // (ADR 0004, finding 4).
    res.flushHeaders()
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    await this.body(res, file, start, end)
  }

  private async body(res: ServerResponse, file: StreamFile, start: number, end: number): Promise<void> {
    const ac = new AbortController()
    const { signal } = ac
    const onClose = () => ac.abort(new Error('client closed'))
    const aborted = () => signal.aborted
    res.on('close', onClose)
    this.active.add(ac)
    const reader = this.source.openReader(file.index, start)
    const P = this.source.pieceLength
    try {
      let pos = start
      while (pos <= end) {
        const abs = file.offset + pos
        const piece = Math.floor(abs / P)
        const inPiece = abs - piece * P
        const len = Math.min(SLICE_BYTES, P - inPiece, end + 1 - pos)
        reader.update(pos)
        if (!this.source.has(piece)) {
          reader.blockedOn(piece)
          this.blocked.set(file.index, (this.blocked.get(file.index) ?? 0) + 1)
          try {
            await this.source.waitVerified(piece, signal)
          } finally {
            // also when the wait is aborted (client gone, server closed)
            const n = (this.blocked.get(file.index) ?? 1) - 1
            if (n > 0) this.blocked.set(file.index, n)
            else this.blocked.delete(file.index)
          }
        }
        if (aborted()) return
        const buf = await this.source.read(piece, inPiece, len)
        if (buf.length !== len) throw new Error(`short read of piece ${String(piece)}`)
        if (aborted()) return
        pos += len
        if (!res.write(buf)) await once(res, 'drain', { signal })
      }
      res.end()
    } catch (e) {
      if (!aborted()) {
        log.warn(`stream: file ${String(file.index)} failed at a read: ${e instanceof Error ? e.message : String(e)}`)
        // FFmpeg reconnects at the same offset after this. Never answer an in-range request for an existing
        // file with 4xx/5xx instead: mpv treats that as EOF and jumps to the end (ADR 0004, finding 3).
        res.destroy()
      }
    } finally {
      reader.close()
      res.off('close', onClose)
      this.active.delete(ac)
    }
  }
}
