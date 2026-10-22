// The alpha's take-back finding (takeback.test.ts, through sessions in their own processes) in the smallest setting
// it shows in: a host engine and two viewer engines in one process, joined by Protomux lanes, with the app's 1 MiB
// pieces and the alpha's host upload limit. No sessions, no DHT, no player.
//
// Viewer a is alone for 3 s, so the host shows it everything (the Revealer's open mode) and a fetches in plan order.
// Viewer b attaches: the host takes back what a neither holds nor is fetching, one BEP 54 donthave per piece
// (revealer.ts takeBack). What a does then, per lt_donthave 2.0.7 and torrent.js: a donthave for piece i clears i in
// the wire's peerPieces and fails a's requests for i, whose callbacks cancel the reservations and queue _update().
// When the next donthave comes in a later read, _update() has run in between and refilled the pipeline with the
// next piece the host still seems to have: the next retracted one, whose donthave is right behind. So each retracted
// piece costs a pipeline of requests (2 + ceil(1 s x rate / 16 KiB) blocks), and the host answers every one of
// them into a's upload queue (it serves any request: ADR 0003 Finding 7), where they wait behind each other and
// are discarded on arrival. Expected instead: a cost that does not grow with what was taken back. Once the first
// donthave reaches a, a asks the host only for the retracted pieces its pipeline was on: the pieces one pipeline
// spans and the next (3 here), at most 3 pipelines of blocks; a piece the walk gives a again (a 'have' after its
// donthave) is a's work from then on, not a refill. And the host answers nothing it does not advertise to a.
// src as of 2026-10-20 failed it (31-45 pieces, 1755-1969 blocks, 28-31 MiB answered). Fixed in round 6 (ADR 0003):
// the take-back sends its donthaves from the plan's end, and the host refuses (BEP 6 reject) a request for a piece
// it does not advertise to that wire: docs/adr/0008-m8-alpha.md §4.1. test/integration/transfer/takeback.test.ts
// guards the same in the integration suite.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import type { Torrent, Wire } from 'webtorrent'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TransferEngine } from '../../src/core/transfer/engine.js'
import { type PreparedTorrent, prepareHost } from '../../src/core/transfer/host-prepare.js'
import { Revealer } from '../../src/core/transfer/revealer.js'
import type { PlayheadPlan } from '../../src/core/transfer/scheduler.js'
import { HOST_UPLOAD_KBPS, hr, loadavg, sleep } from './harness.js'

const say = (...a: unknown[]): void => console.log('[alpha-takeback-wire]', ...a)

/** the app's piece size (pieceLengthFor's smallest, every file up to 16 GiB) */
const P = 1024 * 1024
const PIECES = 64
const BLOCK = 16 * 1024
let dir = ''
let prepared: PreparedTorrent

interface ViewGuts {
  id: string
  open: boolean
  revealed: Uint8Array
  wire: Wire
}
const views = (host: TransferEngine): Map<string, ViewGuts> =>
  (host as unknown as { revealer: { views: Map<string, ViewGuts> } }).revealer.views
const torrentOf = (e: TransferEngine): Torrent => (e as unknown as { torrent: Torrent }).torrent
const planAt0: PlayheadPlan = { byte: 0, windowBytes: 25 * P, hotBytes: 6 * P, seek: true }

/** A lane between two members: a SecretStream pair, Protomux on each end (as in the transfer integration tests). */
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

// the take-backs, as the Revealer makes them (its private takeBack, wrapped for this file's worker only)
type TakeBack = (this: unknown, v: ViewGuts) => void
const proto = Revealer.prototype as unknown as { takeBack: TakeBack }
const originalTakeBack = proto.takeBack
const takebacks: { t: number; id: string; pieces: number[] }[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wt-alpha-takeback-wire-'))
  const videoPath = join(dir, 'movie.mkv')
  writeFileSync(videoPath, randomBytes(PIECES * P - 77))
  prepared = await prepareHost({ videoPath, subtitlePaths: [], cacheRoot: join(dir, 'cache'), pieceLength: P })
  proto.takeBack = function (v) {
    const before = v.revealed.slice()
    originalTakeBack.call(this, v)
    const gone: number[] = []
    for (let i = 0; i < before.length; i++) if (before[i] && !v.revealed[i]) gone.push(i)
    if (gone.length > 0) takebacks.push({ t: hr(), id: v.id, pieces: gone })
  }
})
afterAll(() => {
  proto.takeBack = originalTakeBack
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('take-back with engines in one process (alpha, minimal)', () => {
  it('once told, a viewer asks the host only for the retracted pieces its pipeline was on, not a pipeline per piece', async () => {
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

    // a's block requests on each of its wires, and the donthaves it is told (only the host takes pieces back)
    const reqs: { t: number; piece: number; wire: Wire }[] = []
    const donthaveAt = new Map<number, number>()
    let hostWireOfA: Wire | null = null
    torrentOf(a).on('wire', (wire: Wire) => {
      const request = wire.request.bind(wire)
      wire.request = (index, offset, length, cb) => {
        reqs.push({ t: hr(), piece: index, wire })
        request(index, offset, length, cb)
      }
      const ext = (wire as unknown as { lt_donthave?: { on(e: 'donthave', fn: (i: number) => void): void } })
        .lt_donthave
      ext?.on('donthave', (i) => {
        if (!donthaveAt.has(i)) donthaveAt.set(i, hr())
      })
    })
    // the pieces the host shows a again after their donthave ('have's on a's side)
    const haves: { t: number; piece: number; wire: Wire }[] = []
    torrentOf(a).on('wire', (wire: Wire) => wire.on('have', (i: number) => haves.push({ t: hr(), piece: i, wire })))
    // what the host answered to a (wire.piece: the data goes into a's upload queue), whether it still advertised
    // the piece to a at that moment, its rejects, and how much it queued
    const answered: { t: number; piece: number; bytes: number; advertised: boolean }[] = []
    let rejects = 0
    torrentOf(host).on('wire', (wire: Wire) => {
      const piece = wire.piece.bind(wire)
      wire.piece = (index, offset, buf) => {
        if (wire === hostWireOfA) {
          const advertised = views(host).get('a')?.revealed[index] === 1
          answered.push({ t: hr(), piece: index, bytes: buf.length, advertised })
        }
        piece(index, offset, buf)
      }
      const w = wire as unknown as { reject: (index: number, offset: number, length: number) => void }
      const reject = w.reject.bind(wire)
      w.reject = (index, offset, length) => {
        if (wire === hostWireOfA) rejects++
        reject(index, offset, length)
      }
    })
    let maxQueued = 0
    const queued = (): number =>
      (hostWireOfA as unknown as { _readableState?: { buffered?: number } } | null)?._readableState?.buffered ?? 0
    const sampler = setInterval(() => (maxQueued = Math.max(maxQueued, queued())), 50)

    try {
      connect('host', 'a')
      const until = async (ok: () => boolean, ms: number, what: string): Promise<void> => {
        const end = Date.now() + ms
        while (!ok()) {
          if (Date.now() > end) throw new Error(`timed out: ${what}`)
          await sleep(10)
        }
      }
      await until(() => views(host).get('a')?.open === true, 10_000, 'a alone, shown everything')
      hostWireOfA = views(host).get('a')?.wire ?? null
      await sleep(3000) // a fetches in plan order at the host's limit
      const aWire = [...torrentOf(a).wires].find((w) => w.peerPieces.get(PIECES - 1)) ?? null
      const rateAtJoin = aWire?.downloadSpeed() ?? 0
      const pipeline = Math.min(256, 2 + Math.ceil(rateAtJoin / BLOCK)) // torrent.js getBlockPipelineLength(wire, 1)
      connect('host', 'b')
      connect('a', 'b')
      await until(() => takebacks.some((x) => x.id === 'a'), 10_000, 'a taken back')
      await sleep(6000)

      const tb = takebacks.find((x) => x.id === 'a')
      if (!tb) throw new Error('no take-back')
      const retracted = new Set(tb.pieces)
      const told = [...retracted].map((i) => donthaveAt.get(i)).filter((x): x is number => x !== undefined)
      const firstTold = told.length ? Math.min(...told) : Number.POSITIVE_INFINITY
      // to the host, for what it took back: before the first donthave reached a (the take-back on its way, a
      // fetching in plan order as usual), and after (each donthave failing requests that a refills with the next
      // retracted piece)
      // given back to a by the walk: a 'have' after its donthave
      const reshownAt = new Map<number, number>()
      for (const h of haves) {
        const at = donthaveAt.get(h.piece)
        if (h.wire === aWire && at !== undefined && h.t > at && !reshownAt.has(h.piece)) reshownAt.set(h.piece, h.t)
      }
      const toHost = reqs.filter((q) => q.wire === aWire && q.t >= tb.t && retracted.has(q.piece))
      const beforeTold = toHost.filter((q) => q.t < firstTold)
      const afterTold = toHost.filter(
        (q) => q.t >= firstTold && q.t < (reshownAt.get(q.piece) ?? Number.POSITIVE_INFINITY),
      )
      const wasted = answered.filter((x) => x.t >= tb.t && !x.advertised)
      const out = {
        retracted: retracted.size,
        told: told.length,
        firstToldAfterMs: Number.isFinite(firstTold) ? Math.round(firstTold - tb.t) : null,
        toldSpreadMs: told.length ? Math.round(Math.max(...told) - firstTold) : null,
        aRateAtJoinKBps: Math.round(rateAtJoin / 1024),
        bounds: { pieces: Math.ceil(pipeline / (P / BLOCK)) + 1, blocks: 3 * pipeline },
        hostRequestsForRetracted: {
          beforeFirstDonthave: beforeTold.length,
          afterFirstDonthave: afterTold.length,
          piecesAfterFirstDonthave: new Set(afterTold.map((q) => q.piece)).size,
          givenBackByTheWalk: reshownAt.size,
        },
        hostRejects: rejects,
        hostAnsweredUnadvertised: {
          blocks: wasted.length,
          mib: Math.round(wasted.reduce((s, x) => s + x.bytes, 0) / 1048576),
        },
        hostQueueToAMaxMiB: Math.round((maxQueued / 1048576) * 10) / 10,
        aVerified: torrentOf(a).pieces.filter((x) => x === null).length,
        bVerified: torrentOf(b).pieces.filter((x) => x === null).length,
        loadavg: loadavg(),
      }
      say(out)
      expect(told.length, 'every retracted piece reached a as a donthave').toBe(retracted.size)
      // once told, a asks the host only for the retracted pieces its pipeline was on
      expect(new Set(afterTold.map((q) => q.piece)).size, JSON.stringify(out)).toBeLessThanOrEqual(
        Math.ceil(pipeline / (P / BLOCK)) + 1,
      )
      expect(afterTold.length, JSON.stringify(out)).toBeLessThanOrEqual(3 * pipeline)
      // and the host answers nothing it does not advertise to a
      expect(wasted.length, JSON.stringify(out)).toBe(0)
    } finally {
      clearInterval(sampler)
      clearInterval(reporter)
      await Promise.all([a.leave({ data: 'delete' }), b.leave({ data: 'delete' })])
      await host.destroy()
      for (const c of closers) c()
    }
  }, 120_000)
})
