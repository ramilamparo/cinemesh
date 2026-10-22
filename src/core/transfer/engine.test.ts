import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import bencode from 'bencode'
import { describe, expect, it } from 'vitest'
import { TransferEngine } from './engine.js'

// White-box tests of the engine's bookkeeping with fake torrents, wires, stores and journals; the
// end-to-end behaviour is in test/integration/transfer/engine.test.ts.

interface FakeSegments {
  syncDirty(): Promise<number[]>
  segmentOf(i: number): number | null
  syncFailed(i: number): boolean
}
interface FakeJournal {
  mark(i: number): void
  setRecent(pieces: readonly number[]): void
  save(): Promise<void>
}
interface Internals {
  whenReady(t: unknown): Promise<void>
  countServed(t: unknown, wire: EventEmitter): void
  flushJournal(): Promise<void>
  servedBlocks: Map<number, Uint8Array> | null
  servedBytes: number
  distinctServedBytes: number
  journal: FakeJournal | null
  segments: FakeSegments | null
  verifiedSinceFlush: number[]
}
const internals = (e: TransferEngine): Internals => e as unknown as Internals
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const fakeTorrent = (): EventEmitter & { ready: boolean; destroyed: boolean } =>
  Object.assign(new EventEmitter(), { ready: false, destroyed: false })

describe('TransferEngine startup', () => {
  it('rejects the start as cancelled when the torrent closes before ready (a leave during the start)', async () => {
    const e = new TransferEngine()
    const t = fakeTorrent()
    const ready = internals(e).whenReady(t)
    t.emit('close')
    await expect(ready).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('a startup error only rejects the start; later errors go to listeners, and never throw without one', async () => {
    const e = new TransferEngine()
    const seen: string[] = []
    e.on('error', (err) => seen.push(err.message))
    const failing = fakeTorrent()
    const start = internals(e).whenReady(failing)
    failing.emit('error', new Error('bad store'))
    await expect(start).rejects.toThrow('bad store')
    expect(seen).toEqual([]) // the caller handles the failed start; no second report

    const t = fakeTorrent()
    const ready = internals(e).whenReady(t)
    t.ready = true
    t.emit('ready')
    await ready
    t.emit('error', new Error('disk gone'))
    expect(seen).toEqual(['disk gone'])
    e.removeAllListeners('error')
    expect(() => t.emit('error', new Error('nobody listens'))).not.toThrow()
  })

  it('refuses to start after destroy, or twice', async () => {
    const stopped = new TransferEngine()
    await stopped.destroy()
    const dir = mkdtempSync(join(tmpdir(), 'wt-engine-unit-'))
    try {
      await expect(
        stopped.joinAsViewer({ torrent: Buffer.alloc(0), dir, uploadLimitKBps: null }),
      ).rejects.toMatchObject({
        code: 'cancelled',
      })
      const e = new TransferEngine()
      const first = e.joinAsViewer({ torrent: Buffer.from('not a torrent'), dir, uploadLimitKBps: null })
      await expect(e.joinAsViewer({ torrent: Buffer.alloc(0), dir, uploadLimitKBps: null })).rejects.toThrow(
        /already running/,
      )
      await expect(first).rejects.toThrow()
      await e.destroy()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TransferEngine dupFactor accounting', () => {
  const torrent = { pieces: { length: 4 }, pieceLength: 64 * 1024, lastPieceLength: 1000 }

  it('counts distinct 16 KiB blocks, so a piece the host served only half of is not undercounted', () => {
    const e = internals(new TransferEngine())
    e.servedBlocks = new Map()
    const wire = new EventEmitter()
    e.countServed(torrent, wire)
    wire.emit('request', 0, 0, 16384)
    wire.emit('request', 0, 16384, 16384) // the other half of piece 0 came from another viewer
    expect([e.servedBytes, e.distinctServedBytes]).toEqual([32768, 32768])
    wire.emit('request', 0, 0, 16384) // the same block again is duplication
    expect([e.servedBytes, e.distinctServedBytes]).toEqual([49152, 32768])
  })

  it('ignores requests WebTorrent cannot serve, instead of growing its map per bogus piece index', () => {
    const e = internals(new TransferEngine())
    e.servedBlocks = new Map()
    const wire = new EventEmitter()
    e.countServed(torrent, wire)
    wire.emit('request', 4, 0, 16384) // no such piece
    wire.emit('request', 2 ** 31, 0, 16384)
    wire.emit('request', -1, 0, 16384)
    wire.emit('request', 3, 0, 16384) // past the short last piece
    wire.emit('request', 1, 60_000, 16384) // past the end of the piece
    wire.emit('request', 1, 0, 256 * 1024) // more than WebTorrent serves in one block
    expect(e.servedBytes).toBe(0)
    expect(e.servedBlocks.size).toBe(0)
    wire.emit('request', 3, 0, 1000)
    expect([e.servedBytes, e.servedBlocks.size]).toEqual([1000, 1])
  })
})

describe('TransferEngine journal flushes', () => {
  it('never overlaps flushes, and coalesces the ones requested meanwhile into one', async () => {
    const e = internals(new TransferEngine())
    let running = 0
    let maxRunning = 0
    let syncs = 0
    let release: () => void = () => undefined
    e.segments = {
      syncDirty: () => {
        syncs++
        maxRunning = Math.max(maxRunning, ++running)
        return new Promise<number[]>((r) => {
          release = () => {
            running--
            r([0])
          }
        })
      },
      segmentOf: () => 0,
      syncFailed: () => false,
    }
    const marked: number[] = []
    e.journal = { mark: (i) => marked.push(i), setRecent: () => undefined, save: () => Promise.resolve() }
    e.verifiedSinceFlush.push(1)
    const first = e.flushJournal()
    await tick() // the first flush is now inside its (slow) sync
    e.verifiedSinceFlush.push(2)
    const waiting = [e.flushJournal(), e.flushJournal(), e.flushJournal()]
    expect(waiting[0]).not.toBe(first)
    expect(new Set(waiting).size).toBe(1)
    release()
    await first
    await tick()
    release()
    await Promise.all(waiting)
    expect([syncs, maxRunning]).toEqual([2, 1])
    expect(marked).toEqual([1, 2])
  })

  it('journals pieces of segments that synced, keeps the rest for the next flush, and records recent ones', async () => {
    const e = internals(new TransferEngine())
    e.segments = {
      syncDirty: () => Promise.reject(new Error('EIO')),
      segmentOf: (i) => Math.floor(i / 10),
      syncFailed: (i) => i >= 20, // segment 2 failed to sync
    }
    const marked: number[] = []
    const recent: (readonly number[])[] = []
    let saves = 0
    e.journal = {
      mark: (i) => marked.push(i),
      setRecent: (p) => recent.push(p),
      save: () => {
        saves++
        return Promise.resolve()
      },
    }
    e.verifiedSinceFlush.push(1, 21, 2, 3, 11)
    await e.flushJournal()
    expect(marked).toEqual([1, 2, 3, 11])
    expect(e.verifiedSinceFlush).toEqual([21])
    expect(recent.at(-1)).toEqual([2, 3, 11]) // the last 2 per segment, most recent segment last
    expect(saves).toBe(1)
  })

  it('saves on every flush, so a failed save or startup clears are written without new pieces', async () => {
    const e = internals(new TransferEngine())
    let saves = 0
    e.journal = {
      mark: () => undefined,
      setRecent: () => undefined,
      save: () => (++saves === 1 ? Promise.reject(new Error('EIO')) : Promise.resolve()),
    }
    await e.flushJournal() // never rejects
    await e.flushJournal()
    expect(saves).toBe(2)
  })
})

describe('TransferEngine upload limit', () => {
  it('starts the client with a limit set while the start was still running, and keeps later changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-engine-limit-'))
    const info = { name: 'x.mkv', 'piece length': 16384, length: 4 * 16384, pieces: Buffer.alloc(80, 1), private: 1 }
    const torrent = Buffer.from(bencode.encode({ info }))
    const e = new TransferEngine()
    const limitOf = (): number | undefined =>
      (e as unknown as { client: { _uploadLimit: number } | null }).client?._uploadLimit
    try {
      const start = e.joinAsViewer({ torrent, dir, uploadLimitKBps: null })
      expect(limitOf()).toBeUndefined() // the client comes several awaits later
      e.setUploadLimit(500)
      await start
      expect(limitOf()).toBe(500 * 1024)
      e.setUploadLimit(null)
      expect(limitOf()).toBe(-1)
    } finally {
      await e.destroy()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TransferEngine download limit', () => {
  const PL = 32 * 1024 // two blocks a piece
  const info = { name: 'x.mkv', 'piece length': PL, length: 4 * PL, pieces: Buffer.alloc(80, 1), private: 1 }
  const torrent = Buffer.from(bencode.encode({ info }))
  interface Gate {
    allows(critical: boolean): boolean
    take(bytes: number): void
    refund(bytes: number): void
    rateBps?: number | null
  }
  interface Sent {
    index: number
    offset: number
    cb: (err: Error | null, buf?: Uint8Array) => void
  }
  interface ViewerTorrent {
    _requestGate: Gate | null
    _critical: boolean[]
    pieces: unknown[]
    _request(wire: unknown, index: number, hotswap: boolean): boolean
    _updateWire(wire: unknown): void
  }
  const torrentOf = (e: TransferEngine): ViewerTorrent => (e as unknown as { torrent: ViewerTorrent }).torrent
  async function viewer(
    run: (e: TransferEngine, t: ViewerTorrent) => void | Promise<void>,
    downloadLimitKBps?: number | null,
  ): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'wt-engine-gate-'))
    const e = new TransferEngine()
    try {
      await e.joinAsViewer({
        torrent,
        dir,
        uploadLimitKBps: null,
        ...(downloadLimitKBps === undefined ? {} : { downloadLimitKBps }),
      })
      await run(e, torrentOf(e))
    } finally {
      await e.destroy()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  /** A peer with every piece that unchoked us; `downloadSpeed` sets WebTorrent's pipeline (2 + ⌈1 s of it / 16 KiB⌉). */
  function peer(downloadSpeed = 0): { wire: Record<string, unknown>; sent: Sent[] } {
    const sent: Sent[] = []
    const requests: { piece: number; offset: number; length: number }[] = []
    const wire = {
      type: 'tcpOutgoing',
      requests,
      downloaded: 0,
      destroyed: false,
      peerChoking: false,
      peerPieces: { get: () => true },
      peerExtendedHandshake: {},
      downloadSpeed: () => downloadSpeed,
      request(index: number, offset: number, length: number, cb: Sent['cb']) {
        requests.push({ piece: index, offset, length })
        sent.push({ index, offset, cb })
      },
    }
    return { wire, sent }
  }
  /** A gate that says `verdict(critical)` and logs every call. */
  function spyGate(verdict: (critical: boolean) => boolean): { gate: Gate; calls: string[] } {
    const calls: string[] = []
    const gate: Gate = {
      allows: (critical) => {
        calls.push(`allows ${String(critical)}`)
        return verdict(critical)
      },
      take: (bytes) => calls.push(`take ${String(bytes)}`),
      refund: (bytes) => calls.push(`refund ${String(bytes)}`),
    }
    return { gate, calls }
  }

  it('gives the viewer torrent a gate at the limit taken at the join, or set while the start was still running', async () => {
    await viewer((_e, t) => {
      expect(t._requestGate?.rateBps).toBe(100 * 1024)
    }, 100)
    const dir = mkdtempSync(join(tmpdir(), 'wt-engine-gate-'))
    const e = new TransferEngine()
    try {
      const start = e.joinAsViewer({ torrent, dir, uploadLimitKBps: null })
      e.setDownloadLimit(500) // the torrent comes several awaits later
      await start
      expect(torrentOf(e)._requestGate?.rateBps).toBe(500 * 1024)
      e.setDownloadLimit(null)
      expect(torrentOf(e)._requestGate?.rateBps).toBeNull()
      e.setDownloadLimit(64)
      expect(torrentOf(e)._requestGate?.rateBps).toBe(64 * 1024)
      e.setDownloadLimit(0)
      expect(torrentOf(e)._requestGate?.rateBps).toBeNull()
    } finally {
      await e.destroy()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('_request asks the gate before it reserves a block, with the piece’s critical flag, and takes what it sends', async () => {
    await viewer((_e, t) => {
      const { wire, sent } = peer()
      let open = false
      const { gate, calls } = spyGate(() => open)
      t._requestGate = gate
      expect(t._request(wire, 0, false)).toBe(false)
      t._critical[1] = true
      expect(t._request(wire, 1, false)).toBe(false)
      expect(sent).toEqual([])
      expect(calls).toEqual(['allows false', 'allows true'])
      open = true
      expect(t._request(wire, 0, false)).toBe(true)
      expect(sent.map((s) => s.offset)).toEqual([0]) // the refusal reserved nothing
      expect(calls.slice(2)).toEqual(['allows false', `take ${String(16 * 1024)}`])
    })
  })

  it('refunds a failed block once, also when its piece was replaced meanwhile; never an answered one', async () => {
    await viewer(async (_e, t) => {
      const { wire, sent } = peer(64 * 1024)
      const { gate, calls } = spyGate(() => true)
      t._requestGate = gate
      const refunds = (): number => calls.filter((c) => c.startsWith('refund')).length
      t._request(wire, 0, false)
      t._request(wire, 1, false)
      t._request(wire, 2, false)
      sent[0]?.cb(new Error('request was rejected')) // a BEP 6 reject: a host's preempt, a take-back
      await tick()
      expect(refunds()).toBe(1)
      sent[1]?.cb(null, Buffer.alloc(16 * 1024)) // answered: those bytes came
      await tick()
      expect(refunds()).toBe(1)
      t.pieces[2] = null // verified through another wire (or reset by a failed hash check) before this one failed
      sent[2]?.cb(new Error('wire was closed'))
      await tick()
      expect(refunds()).toBe(2)
      expect(calls.filter((c) => c.startsWith('refund'))).toEqual([
        `refund ${String(16 * 1024)}`,
        `refund ${String(16 * 1024)}`,
      ])
    })
  })

  it('the request walks stop at the first piece the gate refuses: critical ones first, then nothing', async () => {
    await viewer((e, t) => {
      // order: 2 (the hot window, critical), then 2, 3 (L1), then 0, 1 (L3)
      e.setPlayhead({ byte: 2 * PL, windowBytes: PL, hotBytes: 1, seek: true })
      expect([0, 1, 2, 3].map((i) => t._critical[i] === true)).toEqual([false, false, true, false])
      // a wire that delivered before (trySelectWire), pipeline 6: piece 2 borrows, the walk ends at piece 3
      const busy = peer(64 * 1024)
      busy.wire.downloaded = 1
      const s1 = spyGate((critical) => critical)
      t._requestGate = s1.gate
      t._updateWire(busy.wire)
      expect(busy.sent.map((s) => s.index)).toEqual([2, 2])
      expect(s1.calls.filter((c) => c === 'allows false')).toEqual(['allows false']) // not every piece, not twice
      expect(s1.calls.at(-1)).toBe('allows false')
      // a fresh wire (validateWire): refused at its first piece, it asks nothing more
      const fresh = peer()
      const s2 = spyGate(() => false)
      t._requestGate = s2.gate
      t._updateWire(fresh.wire)
      expect(fresh.sent).toEqual([])
      expect(s2.calls).toEqual(['allows true'])
    })
  })
})
