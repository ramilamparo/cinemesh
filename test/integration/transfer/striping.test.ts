import { randomBytes } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TransferEngine } from '../../../src/core/transfer/engine.js'
import { type PreparedTorrent, prepareHost } from '../../../src/core/transfer/host-prepare.js'
import type { ByteRange, PlayheadPlan } from '../../../src/core/transfer/scheduler.js'

// Host-assigned striping end to end (ADR 0003 Part B, M3's "dupFactor <= 1.3 with 4 viewers at a shared
// playhead"): a host and 4 viewers, each pair on its own Protomux connection as Hyperswarm would give them,
// all following one simulated room playhead. The host's upload (2.5 MB/s) is too small for 4 separate copies
// of a 1 MB/s stream, so without striping the viewers fall behind; with it each piece leaves the host about
// once and the viewers pass it on. Viewers report their lanes as the sessions would (linkedPeers ->
// setViewerLinks). The baseline is plain seeding: what the host does until it knows the room's playhead.

const P = 256 * 1024
const PIECES = 512 // 128 MiB: more than 34 s at the host's rate, so nobody finishes early
const LENGTH = PIECES * P - 4321
const HOST_KBPS = 2441 // 2.5 MB/s
const BITRATE = 1_000_000 // bytes of video per second of playback
const VIEWERS = 4
const PREROLL_MS = 4000

const dir = mkdtempSync(join(tmpdir(), 'wt-stripe-'))
let prepared: PreparedTorrent
beforeAll(async () => {
  const videoPath = join(dir, 'movie.mkv')
  const fd = openSync(videoPath, 'w')
  for (let done = 0; done < LENGTH; done += 1 << 20) writeSync(fd, randomBytes(Math.min(1 << 20, LENGTH - done)))
  closeSync(fd)
  prepared = await prepareHost({ videoPath, subtitlePaths: [], cacheRoot: join(dir, 'cache'), pieceLength: P })
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const keyOf = (id: string): Buffer => Buffer.alloc(32, id.charCodeAt(id.length - 1))

interface Room {
  dupFactor: number
  stalls: string[]
  verified: number[]
  servedMB: number
}

async function room(opts: { name: string; striping: boolean; playS: number }): Promise<Room> {
  const host = new TransferEngine()
  await host.startHost(prepared, { uploadLimitKBps: HOST_KBPS })
  const open: ByteRange[] = [
    [0, 2 * P],
    [(PIECES - 1) * P, LENGTH],
  ]
  const t0 = performance.now() + PREROLL_MS
  const posS = (): number => Math.max(0, (performance.now() - t0) / 1000)
  const plan = (seek: boolean): PlayheadPlan => ({
    byte: Math.floor(posS() * BITRATE),
    windowBytes: Math.max(2 * P, 25 * BITRATE),
    hotBytes: 8 * BITRATE,
    seek,
  })
  // the room's playhead is known before anyone attaches, as the host session publishes it at start
  host.setGroupCriticalRanges(open)
  if (opts.striping) host.setGroupPlayhead(plan(true))

  const ids = Array.from({ length: VIEWERS }, (_, k) => `v${String(k + 1)}`)
  const viewers: TransferEngine[] = []
  for (const id of ids) {
    const v = new TransferEngine()
    await v.joinAsViewer({ torrent: prepared.torrent, dir: join(dir, `${opts.name}-${id}`), uploadLimitKBps: null })
    v.setCriticalRanges(open)
    v.setPlayhead(plan(true))
    viewers.push(v)
  }
  const verified = viewers.map(() => new Set<number>())
  viewers.forEach((v, k) => v.on('verified', (i) => verified[k]?.add(i)))

  const closers: (() => void)[] = []
  const connect = (a: TransferEngine, aId: string, b: TransferEngine, bId: string): void => {
    const sa = new SecretStream(true)
    const sb = new SecretStream(false)
    sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
    a.attach({ id: bId, publicKey: keyOf(bId), mux: Protomux.from(sa) })
    b.attach({ id: aId, publicKey: keyOf(aId), mux: Protomux.from(sb) })
    closers.push(() => {
      sa.destroy()
      sb.destroy()
    })
  }
  viewers.forEach((v, k) => connect(host, 'host', v, ids[k] ?? ''))
  for (let a = 0; a < VIEWERS; a++) {
    for (let b = a + 1; b < VIEWERS; b++)
      connect(viewers[a] as TransferEngine, ids[a] ?? '', viewers[b] as TransferEngine, ids[b] ?? '')
  }

  const report = (): void => {
    if (opts.striping) viewers.forEach((v, k) => host.setViewerLinks(ids[k] ?? '', v.linkedPeers()))
  }
  const reporter = setInterval(report, 500) // a sync.status-like report
  const ticker = setInterval(() => {
    const p = plan(false) // sync's 1 Hz playhead.set while playing
    if (opts.striping) host.setGroupPlayhead(p)
    for (const v of viewers) v.setPlayhead(p)
  }, 1000)
  // a stall: a piece not verified when the playhead reaches its first byte
  const next = viewers.map(() => 0)
  const stalls: string[] = []
  const watcher = setInterval(() => {
    if (performance.now() < t0) return
    const at = posS() * BITRATE
    viewers.forEach((_, k) => {
      while ((next[k] ?? 0) < PIECES && (next[k] ?? 0) * P <= at) {
        const i = next[k] ?? 0
        if (!verified[k]?.has(i)) stalls.push(`${ids[k] ?? ''}:${String(i)}@${posS().toFixed(1)}s`)
        next[k] = i + 1
      }
    })
  }, 20)

  await sleep(PREROLL_MS + opts.playS * 1000)
  clearInterval(reporter)
  clearInterval(ticker)
  clearInterval(watcher)
  const served = host as unknown as { servedBytes: number; distinctServedBytes: number }
  const result: Room = {
    dupFactor: served.servedBytes / served.distinctServedBytes,
    stalls,
    verified: verified.map((s) => s.size),
    servedMB: served.servedBytes / 1e6,
  }
  await Promise.all(viewers.map((v) => v.leave({ data: 'delete' })))
  await host.destroy()
  for (const close of closers) close()
  return result
}

const describeRoom = (r: Room): string =>
  JSON.stringify({ ...r, stalls: r.stalls.length, firstStalls: r.stalls.slice(0, 8) })

describe('host-assigned striping', () => {
  it('sends each piece about once (dupFactor <= 1.3) with 4 viewers at a shared playhead, and nobody stalls', async () => {
    const striped = await room({ name: 'striped', striping: true, playS: 30 })
    const summary = describeRoom(striped)
    expect(striped.dupFactor, summary).toBeLessThanOrEqual(1.3)
    expect(striped.stalls, summary).toEqual([])
    // they really played 30 s: about 115 pieces each at least, and the host was busy
    for (const n of striped.verified) expect(n, summary).toBeGreaterThan(30 * (BITRATE / P))
    expect(striped.servedMB, summary).toBeGreaterThan(30 * BITRATE * 1e-6)

    // sanity check: seeding plainly, the host sends most pieces to every viewer
    const baseline = await room({ name: 'baseline', striping: false, playS: 10 })
    expect(baseline.dupFactor, describeRoom(baseline)).toBeGreaterThan(2)
  }, 90_000)
})
