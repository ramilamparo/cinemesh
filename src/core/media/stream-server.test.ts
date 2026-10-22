import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { SLICE_BYTES, StreamServer, mimeOf, parseRange } from './stream-server.js'
import { FakeSource } from './testing/fake-source.js'

const P = 1 << 20
const SIZE = 3 * P + 12345
const BYTES = Uint8Array.from({ length: SIZE }, (_, i) => (i * 31 + (i >> 11)) & 0xff)

interface Reply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

function get(
  server: StreamServer,
  opts: { path?: string; method?: string; range?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${String(server.port)}` }
    if (opts.range) headers.range = opts.range
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        method: opts.method ?? 'GET',
        path: opts.path ?? new URL(server.url(0)).pathname,
        headers,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (d: Buffer) => chunks.push(d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) resolve()
      else if (Date.now() > deadline) reject(new Error('timed out waiting'))
      else setTimeout(tick, 5)
    }
    tick()
  })
}

let server: StreamServer | null = null
afterEach(async () => {
  await server?.close()
  server = null
})

async function start(release = true): Promise<{ server: StreamServer; source: FakeSource }> {
  const source = FakeSource.fromBytes(BYTES, 'Movie Night.mkv', P)
  if (release) source.releaseAll()
  server = await StreamServer.listen(source)
  return { server, source }
}

describe('parseRange', () => {
  it('handles the forms players send', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'none' })
    expect(parseRange('bytes=0-', 100)).toEqual({ kind: 'range', start: 0, end: 99 })
    expect(parseRange('bytes=10-19', 100)).toEqual({ kind: 'range', start: 10, end: 19 })
    expect(parseRange('bytes=90-200', 100)).toEqual({ kind: 'range', start: 90, end: 99 })
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'range', start: 90, end: 99 })
    expect(parseRange('bytes=-1000', 100)).toEqual({ kind: 'range', start: 0, end: 99 })
    expect(parseRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=20-10', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=-0', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'unsatisfiable' })
    expect(parseRange('items=0-1', 100)).toEqual({ kind: 'none' })
  })

  it('maps extensions to MIME types', () => {
    expect(mimeOf('a.MKV')).toBe('video/x-matroska')
    expect(mimeOf('a.mp4')).toBe('video/mp4')
    expect(mimeOf('a.srt')).toBe('application/x-subrip')
    expect(mimeOf('a.bin')).toBe('application/octet-stream')
  })
})

describe('StreamServer', () => {
  it('serves 200 for the whole file and 206 for a range, with the required headers', async () => {
    const { server } = await start()
    expect(server.url(0)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{48}\/f\/0\/Movie%20Night\.mkv$/)
    const full = await get(server)
    expect(full.status).toBe(200)
    expect(full.headers['content-length']).toBe(String(SIZE))
    expect(full.headers['accept-ranges']).toBe('bytes')
    expect(full.headers['cache-control']).toBe('no-store')
    expect(full.headers['content-type']).toBe('video/x-matroska')
    expect(full.body.equals(Buffer.from(BYTES))).toBe(true)

    const part = await get(server, { range: `bytes=${String(P - 100)}-${String(P + 99)}` })
    expect(part.status).toBe(206)
    expect(part.headers['content-range']).toBe(`bytes ${String(P - 100)}-${String(P + 99)}/${String(SIZE)}`)
    expect(part.body.equals(Buffer.from(BYTES.subarray(P - 100, P + 100)))).toBe(true)

    const open = await get(server, { range: `bytes=${String(SIZE - 10)}-` })
    expect(open.status).toBe(206)
    expect(open.body.length).toBe(10)
  })

  it('answers 416, HEAD, 405, 404 and a Host mismatch', async () => {
    const { server, source } = await start()
    const bad = await get(server, { range: `bytes=${String(SIZE)}-` })
    expect(bad.status).toBe(416)
    expect(bad.headers['content-range']).toBe(`bytes */${String(SIZE)}`)

    const head = await get(server, { method: 'HEAD', range: 'bytes=0-99' })
    expect(head.status).toBe(206)
    expect(head.headers['content-length']).toBe('100')
    expect(head.body.length).toBe(0)

    const post = await get(server, { method: 'POST' })
    expect(post.status).toBe(405)
    expect(post.headers.allow).toBe('GET, HEAD')

    const path = new URL(server.url(0)).pathname
    expect((await get(server, { path: path.replace(server.token, 'f'.repeat(48)) })).status).toBe(404)
    expect((await get(server, { path: path.replace('/f/0/', '/f/7/') })).status).toBe(404)
    expect((await get(server, { path: '/' })).status).toBe(404)
    expect((await get(server, { host: 'evil.example' })).status).toBe(403)
    expect((await get(server, { host: `localhost:${String(server.port)}`, range: 'bytes=0-0' })).status).toBe(206)
    expect(source.readersOpened).toBe(1) // only the GET with a body; HEAD, 416 and errors open no reader
  })

  it('reads in slices of at most 256 KiB that never cross a piece', async () => {
    const { server, source } = await start()
    await get(server, { range: `bytes=1000-${String(SIZE - 1)}` })
    expect(source.reads.length).toBeGreaterThan(SIZE / SLICE_BYTES)
    for (const r of source.reads) {
      expect(r.length).toBeLessThanOrEqual(SLICE_BYTES)
      expect(r.offset + r.length).toBeLessThanOrEqual(P)
    }
    expect(source.readersOpen).toBe(0)
  })

  it('waits on a missing piece, reports it, and resumes once it is verified', async () => {
    const { server, source } = await start(false)
    source.release(0)
    const reply = get(server, { range: `bytes=${String(P - 10)}-${String(P + 9)}` })
    await until(() => source.waiting === 1)
    expect(source.blocked).toEqual([1])
    expect(server.activeRequests).toBe(1)
    await new Promise((r) => setTimeout(r, 50))
    expect(source.waiting).toBe(1) // no timeout
    source.release(1)
    const res = await reply
    expect(res.status).toBe(206)
    expect(res.body.equals(Buffer.from(BYTES.subarray(P - 10, P + 10)))).toBe(true)
    expect(server.activeRequests).toBe(0)
  })

  it('releases the waits of a request whose client goes away', async () => {
    const { server, source } = await start(false)
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      path: new URL(server.url(0)).pathname,
      headers: { host: `127.0.0.1:${String(server.port)}`, range: 'bytes=0-' },
      agent: false,
    })
    req.on('error', () => undefined)
    req.end()
    await until(() => source.waiting === 1)
    expect(source.readersOpen).toBe(1)
    req.destroy()
    await until(() => source.waiting === 0 && source.readersOpen === 0 && server.activeRequests === 0)
  })

  it('aborts blocked requests when closed', async () => {
    const { server, source } = await start(false)
    const reply = get(server, { range: 'bytes=0-' }).catch((e: unknown) => e)
    await until(() => source.waiting === 1)
    expect(server.isBlocked(0)).toBe(true)
    await server.close()
    expect(source.waiting).toBe(0)
    expect(source.readersOpen).toBe(0)
    expect(server.isBlocked(0)).toBe(false)
    expect(await reply).toBeInstanceOf(Error)
  })

  it('sends the headers before the first body byte, while the piece is still missing', async () => {
    const { server, source } = await start(false)
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      path: new URL(server.url(0)).pathname,
      headers: { host: `127.0.0.1:${String(server.port)}`, range: `bytes=${String(P)}-` },
      agent: false,
    })
    req.on('error', () => undefined)
    const headers = new Promise<{ status: number; range: string | undefined }>((resolve) =>
      req.on('response', (res) => resolve({ status: res.statusCode ?? 0, range: res.headers['content-range'] })),
    )
    req.end()
    expect(await headers).toEqual({ status: 206, range: `bytes ${String(P)}-${String(SIZE - 1)}/${String(SIZE)}` })
    expect(source.waiting).toBe(1) // no body byte has been read yet
    expect(source.reads).toEqual([])
    req.destroy()
    await until(() => source.waiting === 0 && server.activeRequests === 0)
  })

  it('reports a file as blocked while any of its responses waits on a piece', async () => {
    const { server, source } = await start(false)
    source.release(0)
    expect(server.isBlocked(0)).toBe(false)
    const a = get(server, { range: `bytes=${String(P - 10)}-${String(P + 9)}` })
    const b = get(server, { range: `bytes=${String(2 * P)}-${String(2 * P + 9)}` })
    await until(() => source.waiting === 2)
    expect(server.isBlocked(0)).toBe(true)
    expect(server.isBlocked(1)).toBe(false)
    source.release(1)
    await a
    expect(server.isBlocked(0)).toBe(true) // b still waits on piece 2
    source.release(2)
    await b
    expect(server.isBlocked(0)).toBe(false)
    // a served piece never counts
    await get(server, { range: 'bytes=0-99' })
    expect(server.isBlocked(0)).toBe(false)
  })

  it('stops counting a blocked response when its client goes away', async () => {
    const { server, source } = await start(false)
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      path: new URL(server.url(0)).pathname,
      headers: { host: `127.0.0.1:${String(server.port)}`, range: 'bytes=0-' },
      agent: false,
    })
    req.on('error', () => undefined)
    req.end()
    await until(() => server.isBlocked(0))
    req.destroy()
    await until(() => source.waiting === 0)
    expect(server.isBlocked(0)).toBe(false)
  })
})
