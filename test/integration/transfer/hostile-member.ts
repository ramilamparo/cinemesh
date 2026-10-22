// A host TransferEngine in a process of its own, attacked on the bt lane by a member that sends malformed BEP 10
// messages by hand, while a real viewer downloads from it. A parser that loops stops that process's event loop:
// the test sees its heartbeats stop and kills it, where in its own process it could not even time out.
// This file is both the test's API (attackHost) and the child's entry (run with WT_HOSTILE_HOST set).
import { fork } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SecretStream from '@hyperswarm/secret-stream'
import bencode from 'bencode'
import Protomux from 'protomux'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { prepareHost } from '../../../src/core/transfer/host-prepare.js'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'

export type FromChild =
  | { t: 'tick' }
  | { t: 'sent'; what: string }
  /** the host's wire still parsed after the malformed messages: it answered 'interested' with 'unchoke' */
  | { t: 'answered' }
  /** the host closed the hostile member's lane */
  | { t: 'dropped' }
  | { t: 'verified'; piece: number }
  /** an exception nothing caught (the core logs it, tells main it is fatal, and runs on) */
  | { t: 'uncaught'; error: string }
  | { t: 'failed'; error: string }
  | { t: 'done' }

export interface AttackReport {
  /** what the child reported, stamped with this process's clock on arrival; heartbeats left out */
  events: (Exclude<FromChild, { t: 'tick' }> & { at: number })[]
  /** the longest gap between the child's heartbeats (one every 50 ms), seen from here */
  maxSilenceMs: number
  /** killed: its heartbeats stopped for `silenceLimitMs`, or it ran past `timeoutMs` */
  killed: 'silent' | 'timeout' | null
  exitCode: number | null
}

const HEARTBEAT_MS = 50

/** Runs the attack in a child process (tsx); resolves once it exits. `dir` is an empty folder for it to use. */
export function attackHost(dir: string, opts: { silenceLimitMs: number; timeoutMs: number }): Promise<AttackReport> {
  const proc = fork(fileURLToPath(import.meta.url), [], {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, WT_HOSTILE_HOST: dir },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const events: AttackReport['events'] = []
  let last: number | null = null // the first heartbeat comes once tsx has loaded everything
  let maxSilenceMs = 0
  let killed: AttackReport['killed'] = null
  const kill = (why: 'silent' | 'timeout'): void => {
    killed ??= why
    proc.kill('SIGKILL')
  }
  const watchdog = setInterval(() => {
    if (last !== null && Date.now() - last > opts.silenceLimitMs) kill('silent')
  }, HEARTBEAT_MS)
  const deadline = setTimeout(() => kill('timeout'), opts.timeoutMs)
  proc.on('message', (m: FromChild) => {
    const at = Date.now()
    if (m.t !== 'tick') {
      events.push({ ...m, at })
      return
    }
    if (last !== null) maxSilenceMs = Math.max(maxSilenceMs, at - last)
    last = at
  })
  return new Promise((resolve) => {
    proc.once('exit', (code) => {
      clearInterval(watchdog)
      clearTimeout(deadline)
      if (last !== null && killed === 'silent') maxSilenceMs = Math.max(maxSilenceMs, Date.now() - last)
      resolve({ events, maxSilenceMs, killed, exitCode: code })
    })
  })
}

// ---- the child --------------------------------------------------------------------------------

const P = 256 * 1024
const KEY = { host: Buffer.alloc(32, 0xaa), viewer: Buffer.alloc(32, 0xbb), mallory: Buffer.alloc(32, 0xcc) }

function link(): { a: Protomux; b: Protomux; close(): void } {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  return {
    a: Protomux.from(a),
    b: Protomux.from(b),
    close() {
      a.destroy()
      b.destroy()
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(10)
  }
}

/** A BitTorrent message: length prefix, id, payload. */
function frame(id: number, payload: Uint8Array = new Uint8Array()): Buffer {
  const b = Buffer.alloc(5 + payload.length)
  b.writeUInt32BE(1 + payload.length)
  b[4] = id
  b.set(payload, 5)
  return b
}

/** A BEP 10 message for the receiver's extension `id` (0 = the extended handshake). */
function extended(id: number, payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload
  return frame(20, Buffer.concat([Buffer.from([id]), body]))
}

/** What the host sends on the lane: its 68-byte BT handshake, then length-prefixed messages. */
class FromHost {
  readonly messages: Buffer[] = []
  private buf = Buffer.alloc(0)
  private handshaken = false

  constructor(lane: MuxWireStream) {
    lane.on('data', (d: unknown) => {
      this.buf = Buffer.concat([this.buf, d as Uint8Array])
      this.parse()
    })
  }

  /** The first message from index `from` on that `match` accepts, as it arrives. */
  async first(match: (m: Buffer) => boolean, ms: number, what: string, from = 0): Promise<Buffer> {
    let found: Buffer | undefined
    await until(() => (found = this.messages.slice(from).find(match)) !== undefined, ms, what)
    return found as Buffer
  }

  private parse(): void {
    if (!this.handshaken) {
      if (this.buf.length < 68) return
      this.buf = this.buf.subarray(68)
      this.handshaken = true
    }
    while (this.buf.length >= 4) {
      const length = this.buf.readUInt32BE(0)
      if (this.buf.length < 4 + length) return
      if (length > 0) this.messages.push(this.buf.subarray(4, 4 + length))
      this.buf = this.buf.subarray(4 + length)
    }
  }
}

async function attack(dir: string, send: (m: FromChild) => void): Promise<void> {
  const videoPath = join(dir, 'movie.mkv')
  writeFileSync(videoPath, randomBytes(64 * P - 77))
  const prepared = await prepareHost({ videoPath, subtitlePaths: [], cacheRoot: join(dir, 'cache'), pieceLength: P })
  const infoHash = Buffer.from(prepared.infoHash, 'hex')
  const host = new TransferEngine()
  await host.startHost(prepared, { uploadLimitKBps: 1000 }) // ~4 pieces a second: still serving after the attack
  const viewer = new TransferEngine()
  await viewer.joinAsViewer({ torrent: prepared.torrent, dir: join(dir, 'viewer'), uploadLimitKBps: null })
  let verified = 0
  viewer.on('verified', (piece) => {
    verified++
    send({ t: 'verified', piece })
  })
  const toViewer = link()
  host.attach({ id: 'viewer', publicKey: KEY.viewer, mux: toViewer.a })
  viewer.attach({ id: 'host', publicKey: KEY.host, mux: toViewer.b })
  viewer.setPlayhead({ byte: 0, windowBytes: 8 * P, hotBytes: P, seek: true })
  await until(() => verified >= 2, 20_000, 'the viewer to start downloading')

  // the hostile member: an admitted peer that opens the bt lane and speaks the protocol by hand
  const toMallory = link()
  host.attach({ id: 'mallory', publicKey: KEY.mallory, mux: toMallory.a })
  const lane = MuxWireStream.open(toMallory.b, infoHash, KEY.host)
  if (!lane || !(await lane.opened)) throw new Error('the lane to the host did not open')
  let dropped = false
  lane.once('close', () => (dropped = true))
  const fromHost = new FromHost(lane)
  const reserved = Buffer.alloc(8)
  reserved[5] = 0x10 // BEP 10
  reserved[7] = 0x04 // BEP 6
  lane.write(
    Buffer.concat([Buffer.from([19]), Buffer.from('BitTorrent protocol'), reserved, infoHash, randomBytes(20)]),
  )
  // the host's extended handshake names the id its ut_metadata listens on
  const handshake = await fromHost.first((m) => m[0] === 20 && m[1] === 0, 5000, "the host's BEP 10 handshake")
  const theirs = bencode.decode(handshake.subarray(2)) as { m: Record<string, number> }
  const utMetadata = theirs.m.ut_metadata ?? 0
  const say = (what: string, id: number, payload: string | Uint8Array): void => {
    lane.write(extended(id, payload))
    send({ t: 'sent', what })
  }
  say('handshake, negative string length', 0, 'd1:a-3:e')
  say('handshake, nested 100 000 deep', 0, 'l'.repeat(100_000) + 'e'.repeat(100_000))
  say('handshake, string past the end', 0, 'd1:m99999999:xe')
  say('handshake, valid', 0, bencode.encode({ m: { ut_metadata: 3, lt_donthave: 4 } }))
  say('ut_metadata, negative string length', utMetadata, 'd1:a-3:ee')
  say('ut_metadata, nested 100 000 deep', utMetadata, 'l'.repeat(100_000) + 'ee')
  const sofar = fromHost.messages.length
  lane.write(frame(2)) // interested: WebTorrent unchokes an interested peer, if its wire still parses
  await fromHost.first((m) => m.length === 1 && m[0] === 1, 5000, 'unchoke', sofar)
  send({ t: 'answered' })
  say('ut_metadata, empty', utMetadata, '')
  await until(() => dropped, 5000, 'the host to drop the lane')
  send({ t: 'dropped' })

  // and the room goes on: the viewer keeps downloading from the host
  const before = verified
  await until(() => verified >= before + 4, 20_000, 'the viewer to verify 4 more pieces')
  await viewer.leave({ data: 'delete' })
  await host.destroy()
  toViewer.close()
  toMallory.close()
}

function childMain(dir: string): void {
  const send = (m: FromChild): void => void process.send?.(m)
  process.on('uncaughtException', (e) => send({ t: 'uncaught', error: e.stack ?? e.message }))
  setInterval(() => send({ t: 'tick' }), HEARTBEAT_MS)
  attack(dir, send).then(
    () => process.send?.({ t: 'done' }, () => process.exit(0)),
    (e: unknown) =>
      process.send?.({ t: 'failed', error: e instanceof Error ? e.message : String(e) }, () => process.exit(0)),
  )
}

const childDir = process.env.WT_HOSTILE_HOST
if (childDir) childMain(childDir)
