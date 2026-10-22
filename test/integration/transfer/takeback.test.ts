import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import type { Torrent, Wire } from 'webtorrent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { type PreparedTorrent, prepareHost } from '../../../src/core/transfer/host-prepare.js'
import type { PlayheadPlan } from '../../../src/core/transfer/scheduler.js'

// A lone viewer's take-back (ADR 0008 §4.1), with a host engine and two viewer engines in one process, joined by
// Protomux lanes, with the app's 1 MiB pieces and a host upload limit. Viewer a is alone for 3 s, so the host shows
// it everything (the Revealer's open mode) and a fetches in plan order; then b attaches and the host takes back what
// a neither holds nor is fetching, one BEP 54 donthave per piece. Each donthave fails a's requests for that piece
// and WebTorrent refills the pipeline with the next piece the host still seems to have. Sent in plan order, that was
// the next retracted piece, whose donthave was right behind: a pipeline of requests per retracted piece, all answered
// into a's upload queue (27-31 MiB here) and discarded on arrival; a's genuine requests waited behind it (10.6 s
// here; in whole sessions until a's 30 s request timeout dropped its host wire). What must hold instead:
// - once told, a asks the host only for the retracted pieces its pipeline was on (donthaves from the plan's end);
// - the host answers no request for a piece it does not advertise to that wire (BEP 6 reject);
// - so none of a's requests to the host waits anywhere near the timeout, and a keeps its host wire.

/** the app's piece size (pieceLengthFor's smallest, every file up to 16 GiB) */
const P = 1024 * 1024
const PIECES = 64
const BLOCK = 16 * 1024
/** the alpha's host upload limit (test/alpha/harness.ts) */
const HOST_UPLOAD_KBPS = 1250
const dir = mkdtempSync(join(tmpdir(), 'wt-takeback-'))
let prepared: PreparedTorrent
beforeAll(async () => {
  const videoPath = join(dir, 'movie.mkv')
  writeFileSync(videoPath, randomBytes(PIECES * P - 77))
  prepared = await prepareHost({ videoPath, subtitlePaths: [], cacheRoot: join(dir, 'cache'), pieceLength: P })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const now = (): number => performance.now()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (ok: () => boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(10)
  }
}

interface ViewState {
  open: boolean
  revealed: Uint8Array
  wire: Wire
}
const views = (host: TransferEngine): Map<string, ViewState> =>
  (host as unknown as { revealer: { views: Map<string, ViewState> } }).revealer.views
const torrentOf = (e: TransferEngine): Torrent => (e as unknown as { torrent: Torrent }).torrent
const planAt0: PlayheadPlan = { byte: 0, windowBytes: 25 * P, hotBytes: 6 * P, seek: true }

/** A lane between two members: a SecretStream pair, Protomux on each end. */
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

describe('striping take-back of a lone viewer', () => {
  it('costs a pipeline or so, not one per retracted piece, and the host answers nothing it no longer advertises', async () => {
    const host = new TransferEngine()
    await host.startHost(prepared, { uploadLimitKBps: HOST_UPLOAD_KBPS })
    host.setGroupCriticalRanges([[0, P]])
    host.setGroupPlayhead(planAt0)
    const viewer = async (id: string): Promise<TransferEngine> => {
      const v = new TransferEngine()
      await v.joinAsViewer({ torrent: prepared.torrent, dir: join(dir, id), uploadLimitKBps: null })
      v.setCriticalRanges([[0, P]])
      v.setPlayhead(planAt0)
      return v
    }
    const a = await viewer('a')
    const b = await viewer('b')
    const key = (id: string): Buffer => Buffer.alloc(32, id.charCodeAt(0))
    const engines = new Map([
      ['host', host],
      ['a', a],
      ['b', b],
    ])
    const closers: (() => void)[] = []
    const connect = (x: string, y: string): void => {
      const net = link()
      engines.get(x)?.attach({ id: y, publicKey: key(y), mux: net.a })
      engines.get(y)?.attach({ id: x, publicKey: key(x), mux: net.b })
      closers.push(() => net.close())
    }
    // what the viewer sessions report and the host session feeds the Revealer (transfer.links)
    const reporter = setInterval(() => {
      host.setViewerLinks('a', a.linkedPeers())
      host.setViewerLinks('b', b.linkedPeers())
    }, 200)

    // a's side: each block request (when sent, when it ended and how), the donthaves and haves it is told
    interface Req {
      t: number
      piece: number
      wire: Wire
      end: number | null
      err: string | null
    }
    const reqs: Req[] = []
    const donthaveAt = new Map<number, number>()
    const haveAt = new Map<Wire, { t: number; piece: number }[]>()
    torrentOf(a).on('wire', (wire: Wire) => {
      const request = wire.request.bind(wire)
      wire.request = (index, offset, length, cb) => {
        const q: Req = { t: now(), piece: index, wire, end: null, err: null }
        reqs.push(q)
        request(index, offset, length, (err, buf) => {
          q.end = now()
          q.err = err ? err.message : null
          cb(err, buf)
        })
      }
      const haves: { t: number; piece: number }[] = []
      haveAt.set(wire, haves)
      wire.on('have', (i: number) => haves.push({ t: now(), piece: i }))
      const ext = (wire as unknown as { lt_donthave?: { on(e: 'donthave', fn: (i: number) => void): void } })
        .lt_donthave
      ext?.on('donthave', (i) => {
        if (!donthaveAt.has(i)) donthaveAt.set(i, now())
      })
    })
    // the host's side, on its wire to a: answers to pieces it does not advertise to a at that moment, rejects, and
    // how much it has queued for a
    let hostWireOfA: Wire | null = null
    let answeredUnadvertised = 0
    let rejected = 0
    torrentOf(host).on('wire', (wire: Wire) => {
      const piece = wire.piece.bind(wire)
      wire.piece = (index, offset, buf) => {
        const view = [...views(host).values()].find((v) => v.wire === wire)
        if (wire === hostWireOfA && view && !view.revealed[index]) answeredUnadvertised++
        piece(index, offset, buf)
      }
      const w = wire as unknown as { reject?: (index: number, offset: number, length: number) => void }
      const reject = w.reject?.bind(wire)
      if (reject)
        w.reject = (index, offset, length) => {
          if (wire === hostWireOfA) rejected++
          reject(index, offset, length)
        }
    })
    let maxQueued = 0
    const queued = (): number =>
      (hostWireOfA as unknown as { _readableState?: { buffered?: number } } | null)?._readableState?.buffered ?? 0
    const sampler = setInterval(() => (maxQueued = Math.max(maxQueued, queued())), 50)

    try {
      connect('host', 'a')
      await until(() => views(host).get('a')?.open === true, 10_000, 'a alone, shown everything')
      hostWireOfA = views(host).get('a')?.wire ?? null
      await sleep(3000) // a fetches in plan order at the host's limit
      const aWire = [...torrentOf(a).wires].find((w) => w.peerPieces.get(PIECES - 1)) ?? null
      if (!aWire) throw new Error('a has no wire to the host')
      const rateAtJoin = aWire.downloadSpeed()
      const pipeline = Math.min(256, 2 + Math.ceil(rateAtJoin / BLOCK)) // torrent.js getBlockPipelineLength(wire, 1)
      const tb = now()
      connect('host', 'b')
      connect('a', 'b')
      await until(() => views(host).get('a')?.open === false, 10_000, 'a taken back')
      await sleep(8000)

      const told = [...donthaveAt.values()]
      const firstTold = Math.min(...told)
      // retracted and not shown to a again (the walk gives some of them back with a 'have'): a request for one after
      // its 'have' came is a's work, not a refill
      const reshownAt = new Map<number, number>()
      for (const h of haveAt.get(aWire) ?? []) {
        const toldAt = donthaveAt.get(h.piece)
        if (toldAt !== undefined && h.t > toldAt && !reshownAt.has(h.piece)) reshownAt.set(h.piece, h.t)
      }
      const refills = reqs.filter(
        (q) =>
          q.wire === aWire &&
          q.t >= firstTold &&
          donthaveAt.has(q.piece) &&
          q.t < (reshownAt.get(q.piece) ?? Number.POSITIVE_INFINITY),
      )
      // a request that crosses its piece's donthave (or a hostile one) is refused at once, with no data
      const notShown = [...Array(PIECES).keys()].filter(
        (i) => !views(host).get('a')?.revealed[i] && !aWire.peerPieces.get(i) && torrentOf(a).pieces[i] !== null,
      )
      const probe = notShown.at(-1) ?? -1
      const probeAnswer = await new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve('no answer in 5 s'), 5000)
        aWire.request(probe, 0, BLOCK, (err) => {
          clearTimeout(timer)
          resolve(err ? err.message : 'data')
        })
      })
      const end = now()
      const waits = reqs.filter((q) => q.wire === aWire && q.t >= tb).map((q) => (q.end ?? end) - q.t)
      const out = {
        retracted: donthaveAt.size,
        firstToldAfterMs: Math.round(firstTold - tb),
        aRateAtJoinKBps: Math.round(rateAtJoin / 1024),
        bounds: { pieces: Math.ceil(pipeline / (P / BLOCK)) + 1, blocks: 3 * pipeline },
        refills: { blocks: refills.length, pieces: new Set(refills.map((q) => q.piece)).size },
        answeredUnadvertised,
        rejected,
        failedByReject: reqs.filter((q) => q.wire === aWire && q.err === 'request was rejected').length,
        hostQueueToAMaxMiB: Math.round((maxQueued / 1048576) * 10) / 10,
        aMaxRequestWaitS: Math.round(Math.max(0, ...waits) / 100) / 10,
        probe: { piece: probe, answer: probeAnswer },
        aVerified: torrentOf(a).pieces.filter((x) => x === null).length,
      }
      console.log('[takeback]', out)
      expect(donthaveAt.size, 'a was taken back').toBeGreaterThan(40)
      // once told, a asks the host only for the retracted pieces its pipeline was on
      expect(out.refills.pieces, JSON.stringify(out)).toBeLessThanOrEqual(out.bounds.pieces)
      expect(out.refills.blocks, JSON.stringify(out)).toBeLessThanOrEqual(out.bounds.blocks)
      // the host never answers a piece it no longer advertises to a: nothing queued for a to discard
      expect(answeredUnadvertised, JSON.stringify(out)).toBe(0)
      expect(probe, JSON.stringify(out)).toBeGreaterThan(0)
      expect(probeAnswer, JSON.stringify(out)).toBe('request was rejected')
      // so a's requests wait for the host's upload, not for WebTorrent's 30 s timeout, and a keeps its host wire
      expect(out.aMaxRequestWaitS, JSON.stringify(out)).toBeLessThan(10)
      expect(aWire.destroyed).toBe(false)
      expect(views(host).get('a')?.wire).toBe(hostWireOfA)
    } finally {
      clearInterval(sampler)
      clearInterval(reporter)
      await Promise.all([a.leave({ data: 'delete' }), b.leave({ data: 'delete' })])
      await host.destroy()
      for (const c of closers) c()
    }
  })
})
