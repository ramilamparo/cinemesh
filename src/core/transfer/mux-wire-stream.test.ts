import { Worker } from 'node:worker_threads'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import { describe, expect, it } from 'vitest'
import { WEBTORRENT_OPTIONS } from './client-options.js'
import { BT_PROTOCOL, MuxWireStream } from './mux-wire-stream.js'

const INFO_HASH = Buffer.alloc(20, 7)

function connectedPair(): { a: Protomux; b: Protomux; destroy(): void } {
  const sa = new SecretStream(true)
  const sb = new SecretStream(false)
  sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
  return {
    a: Protomux.from(sa),
    b: Protomux.from(sb),
    destroy() {
      sa.destroy()
      sb.destroy()
    },
  }
}

function collect(stream: MuxWireStream, bytes: number): Promise<Buffer> {
  const parts: Buffer[] = []
  let got = 0
  return new Promise((resolve) => {
    stream.on('data', (chunk: unknown) => {
      const d = chunk as Buffer
      parts.push(d)
      got += d.byteLength
      if (got >= bytes) resolve(Buffer.concat(parts))
    })
  })
}

describe('MuxWireStream', () => {
  it('opens on both sides and carries bytes both ways, splitting large writes', async () => {
    const pair = connectedPair()
    const a = MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32, 1))
    const b = MuxWireStream.open(pair.b, INFO_HASH, Buffer.alloc(32, 2))
    if (!a || !b) throw new Error('channel not created')
    expect(await a.opened).toBe(true)
    expect(await b.opened).toBe(true)
    expect(a.connected).toBe(true)
    expect(a.id).not.toBe(b.id)

    const big = Buffer.alloc(300 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    const atB = collect(b, big.length)
    a.write(big)
    expect((await atB).equals(big)).toBe(true)

    const atA = collect(a, 5)
    b.write(Buffer.from('hello'))
    expect((await atA).toString()).toBe('hello')
    pair.destroy()
  })

  it('refuses a second channel for the same torrent on one connection', async () => {
    const pair = connectedPair()
    const first = MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32))
    MuxWireStream.open(pair.b, INFO_HASH, Buffer.alloc(32))
    await first?.opened
    expect(MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32))).toBeNull()
    pair.destroy()
  })

  it('destroying one side closes the other', async () => {
    const pair = connectedPair()
    const a = MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32))
    const b = MuxWireStream.open(pair.b, INFO_HASH, Buffer.alloc(32))
    if (!a || !b) throw new Error('channel not created')
    await Promise.all([a.opened, b.opened])
    const closed = new Promise<void>((resolve) => b.once('close', () => resolve()))
    a.destroy()
    await closed
    expect(b.destroyed).toBe(true)
    pair.destroy()
  })

  // S2 Finding 1: streamx runs _destroy only once no write is active, and Protomux never drains a closed
  // channel, so without _predestroy the lane never emits 'close' and WebTorrent keeps the dead peer.
  it('closes when the remote closes the channel while a write is held for drain', async () => {
    const pair = connectedPair()
    const a = MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32, 1))
    const b = MuxWireStream.open(pair.b, INFO_HASH, Buffer.alloc(32, 2))
    if (!a || !b) throw new Error('channel not created')
    a.on('error', () => {})
    b.on('error', () => {})
    await Promise.all([a.opened, b.opened])
    const closed = new Promise<void>((resolve) => a.once('close', () => resolve()))
    for (let i = 0; i < 64; i++) a.write(Buffer.alloc(64 * 1024)) // the mux is not drained: a write is held
    b.destroy()
    await closed // times out without _predestroy
    expect(a.destroyed).toBe(true)
    pair.destroy()
  }, 3000)

  // Protomux rejects a remote's open unless this side created the channel or a pair() handler claims
  // it (protomux _requestSession). The engine registers pair() so the late side creates its end on demand.
  it('a late opener without pair() gets rejected; with pair() the channel opens', async () => {
    const unpaired = connectedPair()
    const early = MuxWireStream.open(unpaired.a, INFO_HASH, Buffer.alloc(32))
    expect(await early?.opened).toBe(false)
    unpaired.destroy()

    const paired = connectedPair()
    let late: MuxWireStream | null = null
    paired.b.pair({ protocol: BT_PROTOCOL, id: INFO_HASH }, () => {
      late = MuxWireStream.open(paired.b, INFO_HASH, Buffer.alloc(32, 9))
    })
    const first = MuxWireStream.open(paired.a, INFO_HASH, Buffer.alloc(32))
    expect(await first?.opened).toBe(true)
    expect(late).not.toBeNull()
    paired.destroy()
  })
})

describe('bittorrent-protocol message cap (patches/bittorrent-protocol+5.0.9.patch)', () => {
  it('destroys a wire announcing a message over 1 MiB instead of buffering it', async () => {
    const { default: Wire } = await import('bittorrent-protocol')
    const wire = new Wire()
    const closed = new Promise<void>((resolve) => wire.once('close', () => resolve()))
    wire.handshake(Buffer.alloc(20, 1), Buffer.alloc(20, 2))
    const handshake = Buffer.concat([
      Buffer.from([19]),
      Buffer.from('BitTorrent protocol'),
      Buffer.alloc(8),
      Buffer.alloc(20, 1),
      Buffer.alloc(20, 3),
    ])
    wire.write(handshake)
    const huge = Buffer.alloc(4)
    huge.writeUInt32BE(0x7fffffff)
    wire.write(huge)
    await closed
    expect(wire.destroyed).toBe(true)
  })
})

describe('bittorrent-protocol receive buffering (patches/bittorrent-protocol+5.0.9.patch)', () => {
  type RawWire = {
    _write(data: Uint8Array, cb: () => void): void
    _buffer: Uint8Array[]
    on(event: string, fn: (...args: unknown[]) => void): void
  }
  const handshake = Buffer.concat([
    Buffer.from([19]),
    Buffer.from('BitTorrent protocol'),
    Buffer.alloc(8),
    Buffer.alloc(20, 1),
    Buffer.alloc(20, 3),
  ])
  const message = (id: number, body: Buffer): Buffer => {
    const b = Buffer.alloc(5 + body.length)
    b.writeUInt32BE(1 + body.length)
    b[4] = id
    body.copy(b, 5)
    return b
  }

  it('assembles a message trickled in 1-byte and empty writes once, not on every write', async () => {
    const { default: Wire } = await import('bittorrent-protocol')
    const wire = new Wire() as unknown as RawWire & InstanceType<typeof Wire>
    const got: Buffer[] = []
    wire.on('unknownmessage', (b) => got.push(Buffer.from(b as Uint8Array)))
    wire.handshake(Buffer.alloc(20, 1), Buffer.alloc(20, 2))
    wire._write(handshake, () => undefined)
    const body = Buffer.alloc(512 * 1024)
    for (let i = 0; i < body.length; i++) body[i] = i % 251
    const bytes = message(0x63, body)
    let maxChunks = 0
    const started = performance.now()
    for (let i = 0; i < bytes.length; i++) {
      wire._write(bytes.subarray(i, i + 1), () => undefined)
      if (i % 3 === 0) wire._write(Buffer.alloc(0), () => undefined)
      maxChunks = Math.max(maxChunks, wire._buffer.length)
    }
    const ms = performance.now() - started
    expect(got).toHaveLength(1)
    expect(got[0]?.subarray(1).equals(body)).toBe(true)
    // unpatched, every write re-joins the whole buffer: ~25 s of CPU for these 512 KiB, one chunk at a time
    expect(maxChunks).toBeGreaterThan(1)
    expect(maxChunks).toBeLessThanOrEqual(16 + 512 + 2)
    expect(ms).toBeLessThan(5000)
  })

  it('stops parsing what follows an oversized length instead of reading it as more messages', async () => {
    const { default: Wire } = await import('bittorrent-protocol')
    const wire = new Wire() as unknown as RawWire & InstanceType<typeof Wire>
    const seen: unknown[] = []
    wire.on('have', (i) => seen.push(i))
    wire.handshake(Buffer.alloc(20, 1), Buffer.alloc(20, 2))
    wire._write(handshake, () => undefined)
    const huge = Buffer.alloc(4)
    huge.writeUInt32BE(0x7fffffff)
    const have = Buffer.alloc(4)
    have.writeUInt32BE(7)
    wire._write(Buffer.concat([huge, message(4, have)]), () => undefined)
    expect(seen).toEqual([])
    expect(wire._buffer).toHaveLength(0)
  })
})

describe('MuxWireStream input', () => {
  it('drops empty channel messages and passes the rest through', async () => {
    const pair = connectedPair()
    const a = MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32, 1))
    const b = MuxWireStream.open(pair.b, INFO_HASH, Buffer.alloc(32, 2))
    if (!a || !b) throw new Error('channel not created')
    await Promise.all([a.opened, b.opened])
    const chunks: number[] = []
    b.on('data', (d: unknown) => chunks.push((d as Buffer).byteLength))
    const raw = (a as unknown as { message: { send(data: Uint8Array): boolean } }).message
    raw.send(Buffer.alloc(0))
    raw.send(Buffer.alloc(0))
    raw.send(Buffer.from('hi'))
    await new Promise((r) => setTimeout(r, 50))
    expect(chunks).toEqual([2])
    pair.destroy()
  })
})

describe('bittorrent-protocol extension messages (patches/bittorrent-protocol+5.0.9.patch)', () => {
  // Any room member can open the lane and send these: neither may throw out of the wire's parser, which is
  // an uncaught exception in the core.
  type ExtWire = {
    _write(data: Uint8Array, cb: () => void): void
    handshake(infoHash: Uint8Array, peerId: Uint8Array, extensions?: unknown): void
    use(extension: unknown): void
    extended(ext: number | string, obj: unknown): void
    extendedMapping: Record<number, string>
    peerExtendedMapping: Record<string, number>
    on(event: string, fn: (...args: unknown[]) => void): void
  }
  const reserved = Buffer.alloc(8)
  reserved[5] = 0x10 // BEP 10
  const peerHandshake = Buffer.concat([
    Buffer.from([19]),
    Buffer.from('BitTorrent protocol'),
    reserved,
    Buffer.alloc(20, 1),
    Buffer.alloc(20, 3),
  ])
  const extendedMessage = (id: number, body: Uint8Array): Buffer => {
    const b = Buffer.alloc(6 + body.length)
    b.writeUInt32BE(2 + body.length)
    b[4] = 20
    b[5] = id
    Buffer.from(body).copy(b, 6)
    return b
  }
  const opened = async (): Promise<ExtWire & { sent: Buffer[] }> => {
    const { default: Wire } = await import('bittorrent-protocol')
    const wire = new Wire() as unknown as ExtWire & { sent: Buffer[] }
    wire.sent = []
    wire.on('data', (d) => wire.sent.push(Buffer.from(d as Uint8Array)))
    wire.handshake(Buffer.alloc(20, 1), Buffer.alloc(20, 2))
    wire._write(peerHandshake, () => undefined)
    return wire
  }

  it('keeps an extension id only when it is an integer 0-255, instead of throwing on odd values', async () => {
    const { default: bencode } = await import('bencode')
    const wire = await opened()
    // unpatched, Number(value.toString()) throws for a dict carrying its own 'toString' key
    const m = { evil: { toString: 1 }, lt_donthave: 3, big: 300, neg: -1, list: [5], text: 'x', off: 0 }
    expect(() => wire._write(extendedMessage(0, bencode.encode({ m })), () => undefined)).not.toThrow()
    expect(wire.peerExtendedMapping).toEqual({ evil: 0, lt_donthave: 3, big: 0, neg: 0, list: 0, text: 0, off: 0 })
  })

  it('drops a message for an extension the peer did not announce, such as a ut_metadata answer, instead of throwing', async () => {
    const [{ default: bencode }, { default: utMetadata }] = await Promise.all([
      import('bencode'),
      import('ut_metadata'),
    ])
    const wire = await opened()
    wire.use(
      utMetadata(bencode.encode({ info: { name: 'x', 'piece length': 16384, length: 1, pieces: Buffer.alloc(20) } })),
    )
    wire._write(extendedMessage(0, bencode.encode({ m: {} })), () => undefined) // it announces nothing...
    const ours = Number(
      Object.keys(wire.extendedMapping).find((k) => wire.extendedMapping[Number(k)] === 'ut_metadata'),
    )
    const before = wire.sent.length
    // ...then asks for metadata anyway: ut_metadata answers with wire.extended('ut_metadata', ...)
    const request = extendedMessage(ours, bencode.encode({ msg_type: 0, piece: 0 }))
    expect(() => wire._write(request, () => undefined)).not.toThrow()
    expect(() => wire.extended('lt_donthave', Buffer.alloc(4))).not.toThrow()
    await new Promise((r) => setImmediate(r))
    expect(wire.sent.length).toBe(before) // nothing it could not read went out
  })
})

// ---- what any member can send on the lane, decoded by the dependencies (patches/bencode+4.0.1.patch and
// patches/bittorrent-protocol+5.0.9.patch). Each case runs in a worker: some inputs used to loop forever, and a
// loop in the test's own thread could not be timed out. 'hung' means the worker missed its deadline.

/** An installed (patched) package's entry, for a worker, which loads it outside Vite. */
const pkg = (path: string): string => new URL(`../../../node_modules/${path}`, import.meta.url).href
const DEADLINE_MS = 5000
/** longer than a worker's deadline, so a loop fails with what it did ('hung'), not a test timeout */
const WORKER_TEST_MS = 20_000

/** Runs `body` (CommonJS in an async function, with the data as `d`) in a worker: what it returns, or 'hung'. */
function inWorker<T>(body: string, data: unknown): Promise<T | 'hung'> {
  const worker = new Worker(
    `const { parentPort, workerData: d } = require('node:worker_threads')
    ;(async () => { ${body} })().then(
      (r) => parentPort.postMessage({ r }),
      (e) => parentPort.postMessage({ e: String((e && e.stack) || e) }),
    )`,
    { eval: true, workerData: data },
  )
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      resolve('hung')
    }, DEADLINE_MS)
    worker.once('message', (m: { r?: T; e?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (m.e === undefined) resolve(m.r as T)
      else reject(new Error(m.e))
    })
    worker.once('error', (e: Error) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

describe('bencode decode (patches/bencode+4.0.1.patch)', () => {
  // BEP 10 handshakes and ut_metadata messages are decoded with it, from any member's bytes.
  type Decoded = { value: string } | { error: string }
  const decode = (input: string): Promise<Decoded | 'hung'> =>
    inWorker(
      `const { default: bencode } = await import(d.url)
      try {
        const v = bencode.decode(Buffer.from(d.input, 'latin1'))
        return { value: JSON.stringify(v, (_, x) => (x instanceof Uint8Array ? Buffer.from(x).toString('latin1') : x)) }
      } catch (e) {
        return { error: e.constructor.name + ': ' + e.message }
      }`,
      { url: pkg('bencode/index.js'), input },
    )
  const badLength = { error: expect.stringMatching(/^Error: Invalid data: string length /) as unknown }
  const tooDeep = { error: 'Error: Invalid data: nested deeper than 64' }

  it(
    'throws on a string length that is negative, past the end or not a whole number, instead of looping or cutting short',
    async () => {
      const inputs = [
        'd1:a-3:e', // a negative length moved the position back: the dict never ended (the event loop stopped)
        'l-3:e', // the same in a list
        '-5:abc',
        '5:abc', // returned 'abc'
        'd1:m99999999999:xe', // returned 'x'
        `${'9'.repeat(400)}:x`, // Infinity
      ]
      const results = await Promise.all(inputs.map(decode))
      expect(Object.fromEntries(inputs.map((s, k) => [s.slice(0, 24), results[k]]))).toEqual(
        Object.fromEntries(inputs.map((s) => [s.slice(0, 24), badLength])),
      )
    },
    WORKER_TEST_MS,
  )

  it(
    'refuses nesting deeper than 64 levels with its own error, where it used to run out of stack',
    async () => {
      const results = await Promise.all([
        decode('l'.repeat(64) + 'e'.repeat(64)),
        decode('l'.repeat(65) + 'e'.repeat(65)),
        decode('d1:a'.repeat(100_000) + 'i1e' + 'e'.repeat(100_000)),
      ])
      expect(results).toEqual([{ value: '['.repeat(64) + ']'.repeat(64) }, tooDeep, tooDeep])
      // the decoder is one module-wide object: a decode that failed deep inside must not count against the next
      const next = await inWorker<string>(
        `const { default: bencode } = await import(d.url)
      try {
        bencode.decode(Buffer.from('l'.repeat(1000)))
      } catch {}
      return JSON.stringify(bencode.decode(Buffer.from('ld1:ai1eee')))`,
        { url: pkg('bencode/index.js') },
      )
      expect(next).toBe('[{"a":1}]')
    },
    WORKER_TEST_MS,
  )

  it(
    'still decodes what peers and torrents really send; an empty input is null, which callers must handle',
    async () => {
      const results = await Promise.all([
        decode('d1:md11:lt_donthavei2e11:ut_metadatai1ee4:reqqi256e1:v12:WebTorrent/3e'),
        decode('d8:msg_typei0e5:piecei0ee'),
        decode('l0:i-7e4:spame'),
        decode(`l${'d4:pathl5:a.mkvee'.repeat(100)}e`), // a torrent's file list: many dicts side by side, not deep
        decode(''),
      ])
      expect(results).toEqual([
        { value: JSON.stringify({ m: { lt_donthave: 2, ut_metadata: 1 }, reqq: 256, v: 'WebTorrent/3' }) },
        { value: JSON.stringify({ msg_type: 0, piece: 0 }) },
        { value: JSON.stringify(['', -7, 'spam']) },
        { value: JSON.stringify(Array.from({ length: 100 }, () => ({ path: ['a.mkv'] }))) },
        { value: 'null' },
      ])
    },
    WORKER_TEST_MS,
  )

  it(
    'ends on any input: 20 000 random strings of bencode tokens each decode or throw',
    async () => {
      const result = await inWorker<number>(
        `const { default: bencode } = await import(d.url)
      let seed = 7
      const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
      const tokens = ['l', 'd', 'e', 'i1e', 'i-2e', '0:', '1:a', '3:abc', '-3:', '-1:', '-5:', '9:', '2', ':', '-', 'x']
      let ended = 0
      for (let k = 0; k < 20000; k++) {
        let s = ''
        for (let j = 1 + rnd(12); j > 0; j--) s += tokens[rnd(tokens.length)]
        try {
          bencode.decode(Buffer.from(s, 'latin1'))
        } catch {}
        ended++
      }
      return ended`,
        { url: pkg('bencode/index.js') },
      )
      expect(result).toBe(20_000) // unpatched, the 4th ('lllll-3:lll') never returned
    },
    WORKER_TEST_MS,
  )

  it('leaves the BitTorrent DHT’s own bencode (2.0.3, unpatched, same flaw) unreachable: the client has no DHT', async () => {
    expect(WEBTORRENT_OPTIONS.dht).toBe(false)
    const { default: WebTorrent } = await import('webtorrent')
    const client = new WebTorrent({ ...WEBTORRENT_OPTIONS })
    try {
      expect(client.dht).toBe(false) // no k-rpc socket is ever created, so nothing feeds k-rpc-socket's decoder
    } finally {
      await new Promise<void>((resolve) => client.destroy(() => resolve()))
    }
  })
})

describe('bittorrent-protocol with hostile BEP 10 messages (both patches)', () => {
  type Sent = { to: 'handshake' | 'ut_metadata'; payload: string }
  type Outcome = { threw: string | null; closed: boolean; haves: number[] }
  /**
   * A host wire as WebTorrent sets it up (ut_metadata with our metadata, then lt_donthave), after the peer's BT
   * handshake and a valid BEP 10 one, fed `messages` and then a 'have'. Reports what threw out of the parser,
   * whether the wire closed, and the haves parsed after the messages.
   */
  const feed = (messages: Sent[], opts: { throwingExtension?: boolean } = {}): Promise<Outcome | 'hung'> =>
    inWorker(
      `const [{ default: Wire }, { default: bencode }, { default: utMetadata }, { default: ltDontHave }] =
        await Promise.all(d.urls.map((u) => import(u)))
      const frame = (id, body) => {
        const b = Buffer.alloc(5 + body.length)
        b.writeUInt32BE(1 + body.length)
        b[4] = id
        body.copy(b, 5)
        return b
      }
      const extended = (id, body) => frame(20, Buffer.concat([Buffer.from([id]), body]))
      const wire = new Wire()
      wire.use(utMetadata(bencode.encode({ info: { name: 'x', 'piece length': 16384, length: 1, pieces: Buffer.alloc(20) } })))
      wire.use(ltDontHave())
      if (d.throwingExtension) {
        class Throws {
          onHandshake() {}
          onExtendedHandshake() { throw new Error('a later extension that fails on what the peer sent') }
          onMessage() {}
        }
        Throws.prototype.name = 'throws'
        wire.use(Throws)
      }
      let closed = false
      wire.once('close', () => (closed = true))
      const haves = []
      wire.on('have', (i) => haves.push(i))
      let threw = null
      const write = (bytes) => {
        try {
          wire._write(bytes, () => {})
        } catch (e) {
          threw = threw ?? String(e && e.message)
        }
      }
      wire.handshake(Buffer.alloc(20, 1), Buffer.alloc(20, 2))
      const reserved = Buffer.alloc(8)
      reserved[5] = 0x10 // BEP 10
      write(Buffer.concat([Buffer.from([19]), Buffer.from('BitTorrent protocol'), reserved, Buffer.alloc(20, 1), Buffer.alloc(20, 3)]))
      write(extended(0, Buffer.from(bencode.encode({ m: { ut_metadata: 3, lt_donthave: 4, throws: 5 } }))))
      const ours = (name) => Number(Object.keys(wire.extendedMapping).find((k) => wire.extendedMapping[k] === name))
      for (const m of d.messages) write(extended(m.to === 'handshake' ? 0 : ours(m.to), Buffer.from(m.payload, 'latin1')))
      write(frame(4, Buffer.alloc(4))) // have 0: does the wire still parse?
      await new Promise((r) => setTimeout(r, 100))
      return { threw, closed: closed || wire.destroyed, haves }`,
      {
        urls: ['bittorrent-protocol/index.js', 'bencode/index.js', 'ut_metadata/index.js', 'lt_donthave/index.js'].map(
          pkg,
        ),
        messages,
        throwingExtension: opts.throwingExtension ?? false,
      },
    )

  it(
    'ignores malformed BEP 10 handshakes and ut_metadata messages: nothing throws or hangs, and the wire parses on',
    async () => {
      const cases: [string, Sent][] = [
        ['handshake, negative length (used to loop)', { to: 'handshake', payload: 'd1:a-3:e' }],
        ['handshake, nested 20 000 deep', { to: 'handshake', payload: 'l'.repeat(20_000) + 'e'.repeat(20_000) }],
        ['handshake, string past the end', { to: 'handshake', payload: 'd1:md11:ut_metadatai1ee5:abe' }],
        ['handshake, huge length', { to: 'handshake', payload: 'd1:m99999999999:xe' }],
        ['ut_metadata, negative length (used to loop)', { to: 'ut_metadata', payload: 'd1:a-3:ee' }],
        ['ut_metadata, nested 20 000 deep', { to: 'ut_metadata', payload: 'l'.repeat(20_000) + 'ee' }],
        ['ut_metadata, huge length', { to: 'ut_metadata', payload: 'd8:msg_typei0e5:piece99999999999:xee' }],
      ]
      const outcomes = await Promise.all(cases.map(([, sent]) => feed([sent])))
      const ok: Outcome = { threw: null, closed: false, haves: [0] }
      expect(Object.fromEntries(cases.map(([name], k) => [name, outcomes[k]]))).toEqual(
        Object.fromEntries(cases.map(([name]) => [name, ok])),
      )
    },
    WORKER_TEST_MS,
  )

  it(
    'drops the wire when an extension throws on a message (ut_metadata on an empty one), instead of throwing out of the parser',
    async () => {
      const outcomes = await Promise.all([
        feed([{ to: 'ut_metadata', payload: '' }]), // bencode gives null; ut_metadata read msg_type from it
        feed([], { throwingExtension: true }), // any later extension's handshake handler
      ])
      const dropped: Outcome = { threw: null, closed: true, haves: [] } // and nothing after it is parsed
      expect(outcomes).toEqual([dropped, dropped])
    },
    WORKER_TEST_MS,
  )
})
