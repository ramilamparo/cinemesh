import { randomBytes } from 'node:crypto'
import type { EventEmitter } from 'node:events'
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

// The host's Revealer with real engines: viewers whose BEP 10 handshake comes late or changes, and a viewer's
// blocked reader outside the group plan (the urgent channel: blockedPieces -> setViewerUrgent).

const P = 256 * 1024
const PIECES = 160
/** the app's piece size: pieceLengthFor's smallest, for every file up to 16 GiB */
const BIG_P = 1024 * 1024
const BIG_PIECES = 40
/** 80 MiB: at 1 MB/s nobody holds the last pieces for over a minute */
const FAR_PIECES = 320
const dir = mkdtempSync(join(tmpdir(), 'wt-revealer-'))
interface Movie {
  prepared: PreparedTorrent
  P: number
}
async function prepareMovie(name: string, pieceLength: number, pieces: number): Promise<Movie> {
  const videoPath = join(dir, name)
  writeFileSync(videoPath, randomBytes(pieces * pieceLength - 77))
  const cacheRoot = join(dir, 'cache')
  return { prepared: await prepareHost({ videoPath, subtitlePaths: [], cacheRoot, pieceLength }), P: pieceLength }
}
let small: Movie
beforeAll(async () => {
  small = await prepareMovie('movie.mkv', P, PIECES)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (ok: () => boolean, ms: number, what: string): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(5)
  }
}
const planAt0 = (p: number): PlayheadPlan => ({ byte: 0, windowBytes: 8 * p, hotBytes: p, seek: true })

/** Two members' Protomux connection; `delayMs` of one-way latency, in order, like a slow or relayed link. */
function link(delayMs = 0): { a: Protomux; b: Protomux; close(): void } {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  if (delayMs === 0) {
    a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  } else {
    const relay = (from: SecretStream, to: SecretStream): void => {
      from.rawStream.on('data', (d: unknown) => {
        setTimeout(() => {
          if (!to.rawStream.destroyed) to.rawStream.write(d)
        }, delayMs)
      })
    }
    relay(a, b)
    relay(b, a)
  }
  return {
    a: Protomux.from(a),
    b: Protomux.from(b),
    close() {
      a.destroy()
      b.destroy()
    },
  }
}

interface ViewState {
  open: boolean
  revealed: Uint8Array
  wire: Wire
}
const views = (host: TransferEngine): Map<string, ViewState> =>
  (host as unknown as { revealer: { views: Map<string, ViewState> } }).revealer.views
const count = (bits: Uint8Array): number => bits.reduce((s, x) => s + x, 0)
const torrentOf = (e: TransferEngine): Torrent => (e as unknown as { torrent: Torrent }).torrent
/** e's live wire to member `id` (a lane's stream id maps to the member it was attached for) */
function wireTo(e: TransferEngine, id: string): Wire | undefined {
  const streamPeer = (e as unknown as { streamPeer: Map<string, string> }).streamPeer
  for (const [streamId, p] of torrentOf(e)._peers ?? []) {
    if (streamPeer.get(streamId) === id && p.wire && !p.wire.destroyed) return p.wire
  }
  return undefined
}

/** A host striping a room (plan known, piece 0 critical) and viewers joined, none attached yet. */
async function room(ids: string[], uploadLimitKBps: number, movie: Movie = small) {
  const { prepared, P } = movie
  const host = new TransferEngine()
  await host.startHost(prepared, { uploadLimitKBps })
  host.setGroupCriticalRanges([[0, P]])
  host.setGroupPlayhead(planAt0(P))
  const viewers = new Map<string, TransferEngine>()
  for (const id of ids) {
    const v = new TransferEngine()
    await v.joinAsViewer({
      torrent: prepared.torrent,
      dir: join(dir, `${id}-${String(Date.now())}`),
      uploadLimitKBps: null,
    })
    v.setCriticalRanges([[0, P]])
    v.setPlayhead(planAt0(P))
    viewers.set(id, v)
  }
  const closers: (() => void)[] = []
  const key = (id: string): Buffer => Buffer.alloc(32, id.charCodeAt(0))
  /** a lane between two members, as the sessions attach them on the room's 'peer' events */
  const connect = (aId: string, bId: string, delayMs = 0): void => {
    const net = link(delayMs)
    const engine = (id: string): TransferEngine => (id === 'host' ? host : (viewers.get(id) as TransferEngine))
    engine(aId).attach({ id: bId, publicKey: key(bId), mux: net.a })
    engine(bId).attach({ id: aId, publicKey: key(aId), mux: net.b })
    closers.push(() => net.close())
  }
  // what the viewer sessions report and the host session feeds the Revealer (transfer.links)
  const reporter = setInterval(() => {
    for (const [id, v] of viewers) host.setViewerLinks(id, v.linkedPeers())
  }, 200)
  const close = async (): Promise<void> => {
    clearInterval(reporter)
    await Promise.all([...viewers.values()].map((v) => v.leave({ data: 'delete' })))
    await host.destroy()
    for (const c of closers) c()
  }
  return { host, viewers, connect, close }
}

describe('Revealer take-back with real wires', () => {
  it('takes back a first viewer whose BEP 10 handshake comes an RTT late (slow link), then stripes', async () => {
    const r = await room(['a', 'b'], 1000)
    try {
      r.connect('host', 'a', 400) // 400 ms each way: a's extended handshake reaches the host ~800 ms after its wire
      await until(() => views(r.host).get('a')?.open === true, 10_000, 'a opened up, alone')
      expect(count(views(r.host).get('a')?.revealed ?? new Uint8Array())).toBe(PIECES)
      r.connect('host', 'b') // while a's handshake is still on the way
      r.connect('a', 'b')
      await until(() => views(r.host).get('b') !== undefined, 5000, 'b attached')
      // a cannot be told yet; once its handshake is in, it is taken back and the room is striped
      await until(() => views(r.host).get('a')?.open === false, 5000, 'a taken back')
      await sleep(1000)
      const a = views(r.host).get('a')
      const b = views(r.host).get('b')
      const summary = JSON.stringify({
        a: count(a?.revealed ?? new Uint8Array()),
        b: count(b?.revealed ?? new Uint8Array()),
      })
      expect(count(a?.revealed ?? new Uint8Array()), summary).toBeLessThan(PIECES / 4) // what it holds or fetches
      expect(count(b?.revealed ?? new Uint8Array()), summary).toBeGreaterThan(2) // the walk gives b pieces
      // and a was told: its lane to the host no longer advertises the rest
      const toHost = wireTo(r.viewers.get('a') as TransferEngine, 'host')
      expect(toHost).toBeDefined()
      let advertised = 0
      for (let i = 0; i < PIECES; i++) if (toHost?.peerPieces.get(i)) advertised++
      expect(advertised, summary).toBeLessThan(PIECES / 4)
    } finally {
      await r.close()
    }
  })

  it('never throws out of its timer when a viewer disables lt_donthave in a later handshake; tells it once re-enabled', async () => {
    const uncaught: string[] = []
    const onUncaught = (e: Error): void => void uncaught.push(e.message)
    process.prependListener('uncaughtException', onUncaught)
    const r = await room(['m', 'b'], 500)
    try {
      r.connect('host', 'm')
      await until(() => views(r.host).get('m')?.open === true, 10_000, 'm opened up, alone')
      await until(() => views(r.host).get('m')?.wire.peerExtendedMapping.lt_donthave !== undefined, 5000, 'handshake')
      const mWire = wireTo(r.viewers.get('m') as TransferEngine, 'host')
      if (!mWire) throw new Error('no wire')
      // BEP 10: a later handshake may disable an extension (id 0); lt_donthave on the host still thinks it can
      mWire.extended(0, { m: { lt_donthave: 0 } })
      await until(() => views(r.host).get('m')?.wire.peerExtendedMapping.lt_donthave === 0, 5000, 'disabled')
      r.connect('host', 'b')
      r.connect('m', 'b')
      await sleep(1500) // several ticks with striping due
      expect(uncaught).toEqual([])
      expect(views(r.host).get('m')?.open).toBe(true) // it cannot be told, so it keeps everything
      ;(mWire as unknown as { _sendExtendedHandshake(): void })._sendExtendedHandshake() // its real one again
      await until(() => views(r.host).get('m')?.open === false, 5000, 'm taken back')
      expect(count(views(r.host).get('m')?.revealed ?? new Uint8Array())).toBeLessThan(PIECES / 4)
      expect(uncaught).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
      await r.close()
    }
  })
})

describe('Revealer group seek with real wires', () => {
  it('takes back from every viewer what it was shown outside the new window and neither holds nor fetches', async () => {
    const r = await room(['a', 'b', 'c'], 1000)
    try {
      // 150 ms each way: a piece the host shows a viewer goes some 300 ms unasked for, as on a real link
      for (const id of ['a', 'b', 'c']) r.connect('host', id, 150)
      r.connect('a', 'b')
      r.connect('a', 'c')
      r.connect('b', 'c')
      await until(() => [...r.viewers.values()].every((v) => v.linkedPeers().length === 3), 10_000, 'full mesh')
      // striping from the start (the plan came first), and every viewer can be told: its BEP 10 handshake is in
      await until(
        () =>
          [...views(r.host).values()].filter((v) => !v.open && (v.wire.peerExtendedMapping.lt_donthave ?? 0) > 0)
            .length === 3,
        10_000,
        'striping, lt_donthave known',
      )
      const told = new Map<string, Set<number>>() // viewer -> the pieces its host wire got a donthave for
      for (const [id, v] of r.viewers) {
        const wire = wireTo(v, 'host') as unknown as { lt_donthave: EventEmitter } | undefined
        if (!wire) throw new Error(`no host wire at ${id}`)
        const got = new Set<number>()
        told.set(id, got)
        wire.lt_donthave.on('donthave', (i: number) => got.add(i))
      }
      const S = 2
      const seek: PlayheadPlan = { byte: S * P, windowBytes: 2 * P, hotBytes: P, seek: true } // window [2, 4]
      // shown to v outside the new window, not critical (piece 0), and neither held by v nor asked for (on v's wire:
      // held by the upload scheduler, or being read)
      const due = (): Map<string, number[]> => {
        const out = new Map<string, number[]>()
        for (const [id, view] of views(r.host)) {
          const fetching = new Set([...view.wire.heldRequests, ...view.wire.peerRequests].map((q) => q.piece))
          const pieces: number[] = []
          for (let i = 1; i < PIECES; i++) {
            if (i >= S && i <= S + 2) continue
            if (view.revealed[i] && !view.wire.peerPieces.get(i) && !fetching.has(i)) pieces.push(i)
          }
          out.set(id, pieces)
        }
        return out
      }
      // the walk runs past the new window; the group seek comes while some viewer has such a piece to take back
      let taken = new Map<string, number[]>()
      await until(
        () => {
          taken = due()
          if (![...taken.values()].some((xs) => xs.some((i) => i > S + 2))) return false
          r.host.setGroupPlayhead(seek) // in the same turn, so nothing moved in between
          return true
        },
        15_000,
        'a piece past the new window shown and not fetched',
      )
      for (const v of r.viewers.values()) v.setPlayhead(seek)
      const summary = JSON.stringify(Object.fromEntries(taken))
      for (const [id, pieces] of taken) {
        const view = views(r.host).get(id)
        for (const i of pieces) expect(view?.revealed[i], `${id} ${String(i)} ${summary}`).toBe(0)
      }
      await until(
        () => [...taken].every(([id, pieces]) => pieces.every((i) => told.get(id)?.has(i))),
        5000,
        `every viewer told: ${summary}`,
      )
    } finally {
      await r.close()
    }
  })
})

/** A player reading [from, to] of the video: its reader waits on the first piece missing, then the next. */
function readThrough(v: TransferEngine, from: number, to: number, pieceLength = P): Promise<void> {
  const src = v.streamSource
  if (!src) throw new Error('no stream source')
  const reader = src.openReader(0, from * pieceLength)
  return new Promise((resolve) => {
    const step = (): void => {
      let i = from
      while (i <= to && src.has(i)) i++
      if (i > to) {
        reader.close()
        resolve()
        return
      }
      reader.blockedOn(i) // what the stream server does when mpv reads into a piece it lacks
      void src.waitVerified(i, new AbortController().signal).then(step)
    }
    step()
  })
}

describe('Revealer urgent pieces (blockedPieces -> setViewerUrgent)', () => {
  it('reveals a piece outside the group plan to the viewer blocked on it, which fetches it at once', async () => {
    const r = await room(['a', 'b'], 1000)
    try {
      r.connect('host', 'a')
      r.connect('host', 'b')
      r.connect('a', 'b')
      const a = r.viewers.get('a') as TransferEngine
      // what the viewer session does: report on change (and at 1 Hz) -> the host session's setViewerUrgent
      const reports: number[][] = []
      a.on('blocked-changed', (pieces) => {
        reports.push(pieces)
        r.host.setViewerUrgent('a', pieces)
      })
      await until(() => [...views(r.host).values()].filter((v) => !v.open).length === 2, 10_000, 'striping')
      await sleep(1000)
      const K = PIECES - 10 // in L2, far past the frontier: the walk would reach it in ~35 s at 1 MB/s
      for (const v of views(r.host).values()) expect(v.revealed[K]).toBe(0)
      const verified = new Promise<number>((resolve) =>
        a.on('verified', (i) => {
          if (i === K) resolve(performance.now())
        }),
      )
      const started = performance.now()
      const reader = a.streamSource?.openReader(0, K * P)
      reader?.blockedOn(K) // what the stream server does when mpv reads into a missing piece
      expect(a.blockedPieces()).toEqual([K])
      const ms = (await Promise.race([verified, sleep(8000).then(() => Number.NaN)])) - started
      const summary = JSON.stringify({ ms: Math.round(ms), reports })
      // the host sends the have ~1 ms after the report, rejects a's held filler requests so that its request for K
      // comes at once, and releases K's blocks first (ADR 0006). Before the upload scheduler the have waited behind
      // the throttled blocks queued to a (0.3-1 s, ADR 0003 Finding 8), the request for a free pipeline slot
      // (Finding 4), and the data behind the blocks queued meanwhile: 1.0-2.6 s. The walk would reach K in ~35 s.
      expect(ms, summary).toBeLessThan(5000)
      expect(views(r.host).get('b')?.revealed[K], summary).toBe(0) // nobody else was shown it
      await until(() => a.blockedPieces().length === 0, 1000, 'unblocked')
      await sleep(10)
      expect(reports, summary).toEqual([[K], []]) // reported when blocked, and cleared once verified
      reader?.close()
    } finally {
      await r.close()
    }
  })

  it('verifies a piece a reader blocks on far past the frontier in under 0.6 s (median) with 3 viewers at 1 MB/s', async () => {
    // ADR 0006 Part A: the viewers download all the time (the host's upload is the bottleneck); every 1.5 s one of
    // them, in turn, reads a piece nobody holds or was shown. As shipped the median was 1.9 s (p95 3.8): the have, the
    // request and the blocks waited behind a second of data in WebTorrent's upload throttle. Just in time, urgent
    // first, with preempt: 0.31 s (p95 0.47), in the spike, on a 31 ms RTT
    const movie = await prepareMovie('far.mkv', P, FAR_PIECES)
    const r = await room(['a', 'b', 'c'], 1000, movie)
    try {
      for (const id of ['a', 'b', 'c']) r.connect('host', id)
      r.connect('a', 'b')
      r.connect('a', 'c')
      r.connect('b', 'c')
      for (const [id, v] of r.viewers) v.on('blocked-changed', (pieces) => r.host.setViewerUrgent(id, pieces))
      await until(() => [...r.viewers.values()].every((v) => v.linkedPeers().length === 3), 10_000, 'full mesh')
      await until(() => [...views(r.host).values()].filter((v) => !v.open).length === 3, 10_000, 'striping')
      await sleep(3000) // every viewer busy: the host uploads at its limit
      const viewers = [...r.viewers.values()]
      const untouched = (i: number): boolean =>
        [...views(r.host).values()].every((v) => !v.revealed[i]) && viewers.every((v) => !v.streamSource?.has(i))
      const times: number[] = []
      let K = FAR_PIECES
      for (let trial = 0; trial < 9; trial++) {
        const v = viewers[trial % viewers.length] as TransferEngine
        K--
        while (K > FAR_PIECES / 2 && !untouched(K)) K--
        const piece = K
        const verified = new Promise<number>((resolve) => {
          const onVerified = (i: number): void => {
            if (i !== piece) return
            v.off('verified', onVerified)
            resolve(performance.now())
          }
          v.on('verified', onVerified)
        })
        const started = performance.now()
        const reader = v.streamSource?.openReader(0, piece * P)
        reader?.blockedOn(piece)
        times.push((await Promise.race([verified, sleep(8000).then(() => Number.NaN)])) - started)
        reader?.close()
        await sleep(1500)
      }
      const sorted = [...times].sort((x, y) => x - y)
      const summary = JSON.stringify(times.map((ms) => Math.round(ms)))
      expect(
        times.filter((ms) => !Number.isFinite(ms)),
        summary,
      ).toEqual([]) // none timed out
      // 0.24-0.26 s measured: the piece's 256 KiB at the full 1 MB/s. Without urgent-first 0.72-0.77 s; without the
      // upload scheduler (WebTorrent's throttle on the host) 1.4-2.3 s
      expect(sorted[Math.floor(sorted.length / 2)], summary).toBeLessThan(600)
      // each new blocked piece rejected the viewer's held filler requests (its request for the piece goes out at once)
      const uploads = (r.host as unknown as { uploadScheduler: { stats(): { preempted: number } } }).uploadScheduler
      expect(uploads.stats().preempted, summary).toBeGreaterThan(0)
    } finally {
      await r.close()
    }
  })

  /**
   * Three viewers in a full mesh: a group seek to S, as the sessions make it (the plan to the host and every viewer,
   * then mpv reads S..S+8). Returns how many bytes of S, and of all 9, the viewers asked the host for, in pieces.
   */
  async function groupSeek(movie: Movie, uploadLimitKBps: number, S: number) {
    const { P } = movie
    const r = await room(['a', 'b', 'c'], uploadLimitKBps, movie)
    try {
      for (const id of ['a', 'b', 'c']) r.connect('host', id)
      r.connect('a', 'b')
      r.connect('a', 'c')
      r.connect('b', 'c')
      for (const [id, v] of r.viewers) v.on('blocked-changed', (pieces) => r.host.setViewerUrgent(id, pieces))
      await until(() => [...r.viewers.values()].every((v) => v.linkedPeers().length === 3), 10_000, 'full mesh')
      await sleep(500) // links reported, striping on
      const requested = new Map<number, number>() // piece -> bytes the viewers asked the host for
      for (const view of views(r.host).values()) {
        view.wire.on('request', (i: number, _offset: number, length: number) => {
          if (i >= S && i <= S + 8) requested.set(i, (requested.get(i) ?? 0) + length)
        })
      }
      const seek: PlayheadPlan = { byte: S * P, windowBytes: 8 * P, hotBytes: 4 * P, seek: true }
      r.host.setGroupPlayhead(seek)
      for (const v of r.viewers.values()) v.setPlayhead(seek)
      const started = performance.now()
      await Promise.all([...r.viewers.values()].map((v) => readThrough(v, S, S + 8, P)))
      const total = [...requested.values()].reduce((x, y) => x + y, 0)
      const summary = JSON.stringify({
        s: ((performance.now() - started) / 1000).toFixed(1),
        requested: [...requested].map(([i, bytes]) => [i, (bytes / P).toFixed(2)]),
      })
      return { first: (requested.get(S) ?? 0) / P, all: total / (9 * P), summary }
    } finally {
      await r.close()
    }
  }

  it('sends each piece about once when every reader waits on the same ones after a group seek', async () => {
    const { first, all, summary } = await groupSeek(small, 1000, 80) // S far from what the walk revealed so far
    // all three readers wait on S at once, before the walk assigned it: the first report reveals it, the other
    // two find it on its way through that viewer (without that check S left the host 2.6-3 times: 2.6-3 P)
    expect(first, summary).toBeLessThan(1.5)
    expect(all, summary).toBeLessThan(1.3) // measured 1.00: every piece once
  })

  it('sends a group seek’s first piece once at the app’s piece size, 1 MiB, which takes the first viewer seconds to fetch', async () => {
    // At 500 KB/s the first viewer fetches S at a third of the host upload, behind what it had already asked for:
    // 5.9-13.1 s measured. A flat 3 s wait (round 4) sent S to the other readers too in 6 of 6 runs (2.0-2.6 P), and
    // in 3 of 4 at 600 KB/s; at 700 KB/s, where that fetch is quicker, in 13 of 21 (1 of 4 on an idle machine)
    const { first, all, summary } = await groupSeek(await prepareMovie('big.mkv', BIG_P, BIG_PIECES), 500, 24)
    expect(first, summary).toBeLessThan(1.5)
    // all 9: 1.00-1.38 measured, up to 1.55 under CPU load (round 4: 1.59-2.02). At a third of 500 KB/s a viewer's
    // later pieces wait 6 s each behind its first ones, so the 3 s idle of the rescue (S+1 and S+2 are due within its
    // 8 s) and of the on-its-way check takes some of them for stuck, and another viewer fetches them too (ADR 0003,
    // Round 5)
    expect(all, summary).toBeLessThan(1.75)
  })
})
