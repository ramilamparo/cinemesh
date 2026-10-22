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
