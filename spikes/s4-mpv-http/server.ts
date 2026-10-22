// Logging HTTP range server that can withhold byte ranges (blocking, like a missing piece).
// Serves files from a directory at /f/<name>. Single-range 206, HEAD, 416.
import http from 'node:http'
import { open, stat, type FileHandle } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { EventEmitter, once } from 'node:events'
import type { AddressInfo, Socket } from 'node:net'

export type Range = [number, number]
const SLICE = 256 * 1024
const MIME: Record<string, string> = { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.avi': 'video/x-msvideo', '.srt': 'application/x-subrip', '.ass': 'text/x-ssa' }

export interface ReqLog {
  id: number
  conn: number
  connReq: number // n-th request on this connection (>1 = keep-alive reuse)
  file: string
  method: string
  range: string | undefined
  start: number
  end: number // exclusive, requested
  tOpen: number
  tClose: number | null
  sent: number
  slices: [number, number, number][] // [t, from, to)
  blocked: { at: number, t: number, tReleased: number | null }[]
  closedBy: 'server' | 'client' | null
}

// Availability per file: null = everything available; otherwise sorted available ranges.
class Gate {
  avail: Range[] | null = null
  withheld: Range[] = []
  ok (b: number) {
    if (this.withheld.some(([s, e]) => b >= s && b < e)) return false
    return this.avail === null || this.avail.some(([s, e]) => b >= s && b < e)
  }
  // Last byte (exclusive) from b that is contiguously available, up to max.
  okUntil (b: number, max: number) {
    if (!this.ok(b)) return b
    let end = max
    for (const [s] of this.withheld) if (s > b && s < end) end = s
    if (this.avail) {
      const r = this.avail.find(([s, e]) => b >= s && b < e)
      if (!r) return b
      end = Math.min(end, r[1])
    }
    return end
  }
}

export class LoggingServer extends EventEmitter {
  dir: string
  t0 = performance.now()
  log: ReqLog[] = []
  marks: { name: string, t: number }[] = []
  gates = new Map<string, Gate>()
  server: http.Server
  port = 0
  private nextConn = 0
  private nextReq = 0
  private sockets = new Set<Socket>()

  constructor (dir: string) {
    super()
    this.setMaxListeners(0)
    this.dir = dir
    this.server = http.createServer((req, res) => { this.handle(req, res).catch(err => { console.error('server error', err); res.destroy() }) })
    this.server.requestTimeout = 0
    this.server.keepAliveTimeout = 5000
    this.server.maxConnections = 32
    this.server.on('connection', (s: Socket & { connId?: number, reqs?: number }) => {
      s.connId = ++this.nextConn; s.reqs = 0
      this.sockets.add(s); s.on('close', () => this.sockets.delete(s))
    })
  }

  now () { return Math.round((performance.now() - this.t0) * 10) / 10 }
  mark (name: string) { this.marks.push({ name, t: this.now() }) }
  gate (file: string) { let g = this.gates.get(file); if (!g) { g = new Gate(); this.gates.set(file, g) } return g }
  setAvailable (file: string, avail: Range[] | null) { this.gate(file).avail = avail; this.emit('change') }
  withhold (file: string, r: Range) { this.gate(file).withheld.push(r); this.emit('change') }
  release (file: string) { this.gate(file).withheld = []; this.emit('change') }
  // Destroys every response of `file` currently blocked on a withheld byte.
  destroyBlocked (file: string) {
    for (const r of this.log) if (r.file === file && r.tClose === null && r.blocked.some(b => b.tReleased === null)) this.responses.get(r.id)?.destroy()
  }
  private responses = new Map<number, http.ServerResponse>()
  failStatus = new Map<string, number>() // file → status for the next GET that starts on a withheld byte

  url (file: string) { return `http://127.0.0.1:${this.port}/f/${encodeURIComponent(file)}` }
  openRequests () { return this.log.filter(r => r.tClose === null) }

  async listen () {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    this.port = (this.server.address() as AddressInfo).port
  }

  async close () {
    for (const s of this.sockets) s.destroy()
    await new Promise(resolve => this.server.close(resolve))
  }

  private async handle (req: http.IncomingMessage, res: http.ServerResponse) {
    const sock = req.socket as Socket & { connId: number, reqs: number }
    sock.reqs++
    const m = /^\/f\/([^/]+)$/.exec(req.url ?? '')
    if (!m || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404).end(); return }
    const file = decodeURIComponent(m[1])
    const path = join(this.dir, file)
    let size: number
    try { size = (await stat(path)).size } catch { res.writeHead(404).end(); return }
    const rh = req.headers.range
    let start = 0; let end = size; let status = 200
    if (rh) {
      const r = /^bytes=(\d*)-(\d*)$/.exec(rh)
      if (!r || (!r[1] && !r[2])) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return }
      if (r[1]) { start = Number(r[1]); end = r[2] ? Math.min(size, Number(r[2]) + 1) : size } else { start = Math.max(0, size - Number(r[2])) }
      if (start >= size || end <= start) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return }
      status = 206
    }
    const fail = this.failStatus.get(file)
    if (fail && req.method === 'GET' && !this.gate(file).ok(start)) {
      this.failStatus.delete(file)
      this.log.push({ id: ++this.nextReq, conn: sock.connId, connReq: sock.reqs, file, method: `GET→${fail}`, range: rh, start, end, tOpen: this.now(), tClose: this.now(), sent: 0, slices: [], blocked: [], closedBy: 'server' })
      res.writeHead(fail, { 'Content-Length': 0 }).end()
      return
    }
    const entry: ReqLog = {
      id: ++this.nextReq, conn: sock.connId, connReq: sock.reqs, file, method: req.method!, range: rh, start, end,
      tOpen: this.now(), tClose: null, sent: 0, slices: [], blocked: [], closedBy: null,
    }
    this.log.push(entry)
    this.responses.set(entry.id, res)
    res.on('close', () => this.responses.delete(entry.id))
    this.emit('request', entry)
    const headers: Record<string, string | number> = {
      'Accept-Ranges': 'bytes', 'Content-Length': end - start, 'Cache-Control': 'no-store',
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    }
    if (status === 206) headers['Content-Range'] = `bytes ${start}-${end - 1}/${size}`
    res.writeHead(status, headers)
    if (req.method === 'HEAD') { res.end(); entry.tClose = this.now(); entry.closedBy = 'server'; return }

    const ac = new AbortController()
    const onClose = () => { if (entry.tClose === null) { entry.tClose = this.now(); entry.closedBy = 'client' } ac.abort(); this.emit('change') }
    res.on('close', onClose)
    let fh: FileHandle | null = null
    try {
      fh = await open(path, 'r')
      let pos = start
      const g = this.gate(file)
      while (pos < end && !ac.signal.aborted) {
        let until = g.okUntil(pos, Math.min(end, pos + SLICE))
        if (until <= pos) {
          const b = { at: pos, t: this.now(), tReleased: null as number | null }
          entry.blocked.push(b)
          this.emit('blocked', entry, pos)
          while (!g.ok(pos) && !ac.signal.aborted) await once(this, 'change')
          if (ac.signal.aborted) break
          b.tReleased = this.now()
          until = g.okUntil(pos, Math.min(end, pos + SLICE))
        }
        const buf = Buffer.alloc(until - pos)
        await fh.read(buf, 0, buf.length, pos)
        if (ac.signal.aborted) break
        const ok = res.write(buf)
        entry.slices.push([this.now(), pos, until])
        entry.sent += buf.length
        pos = until
        if (!ok) await Promise.race([once(res, 'drain'), once(ac.signal, 'abort')])
      }
      if (!ac.signal.aborted) { res.end(); entry.tClose = this.now(); entry.closedBy = 'server' }
    } finally {
      await fh?.close()
    }
  }
}
