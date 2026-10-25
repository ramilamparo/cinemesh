import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreLog } from '../log.js'
import { Bus, type BusLink, type BusMessage } from '../net/bus.js'
import { toHex } from '../net/crypto.js'
import { keyPairFromSeed } from '../net/identity.js'
import type { MemberView, Room } from '../net/room.js'
import type { HashFailStats, TransferEngine } from '../transfer/engine.js'
import { MAX_URGENT } from '../transfer/revealer.js'
import { HashFailWatch } from './hash-fails.js'
import {
  MAX_LINKED,
  MAX_REPORTED_HASH_FAILS,
  MAX_REPORTED_URGENT,
  REPORT_MIN_GAP_MS,
  REPORT_MS,
  TRANSFER_LINKS,
  type TransferLinks,
  collectTransferLinks,
  reportTransferLinks,
} from './striping.js'

// Striping reports: viewers tell the host their bt lanes and blocked pieces; the host validates them and feeds
// its transfer. A real bus carries them, so net's addressing and signatures apply.

const hostKp = keyPairFromSeed('01'.repeat(32))
const HOST = toHex(hostKp.publicKey)

class FakeRoom extends EventEmitter<{ 'peer-gone': [string] }> {
  readonly bus: Bus
  readonly self: string
  memberIds: string[] = []
  publishFails = false

  constructor(seedByte: number) {
    super()
    const kp = seedByte === 1 ? hostKp : keyPairFromSeed(seedByte.toString(16).padStart(2, '0').repeat(32))
    this.bus = new Bus({ keyPair: kp, hostKey: HOST })
    this.self = this.bus.self
  }

  defineMessage(name: string, policy: object): void {
    this.bus.define(name, policy)
  }
  publish(name: string, body: unknown, opts: { to?: string } = {}): void {
    if (this.publishFails) throw new Error('no link to the host')
    this.bus.publish(name, body, opts)
  }
  onMessage(ns: string, handler: (msg: BusMessage) => void): () => void {
    return this.bus.subscribe(ns, handler)
  }
  members(): MemberView[] {
    return this.memberIds.map((id) => ({ id, self: id === this.self }) as MemberView)
  }
  asRoom(): Room {
    return this as unknown as Room
  }
}

function connect(a: FakeRoom, b: FakeRoom): void {
  const toB: BusLink = { id: b.self, sendEnvelope: (env) => b.bus.receive(structuredClone(env), a.self) }
  const toA: BusLink = { id: a.self, sendEnvelope: (env) => a.bus.receive(structuredClone(env), b.self) }
  a.bus.addLink(toB)
  b.bus.addLink(toA)
}

/** What the reports read from and feed into a TransferEngine. */
class FakeTransfer extends EventEmitter<{ 'blocked-changed': [number[]] }> {
  linked: string[] = []
  blocked: number[] = []
  readonly links: [string, string[]][] = []
  readonly urgent: [string, number[]][] = []
  readonly removed: string[] = []
  pieceCount = 100
  fails: HashFailStats = { total: 0, worst: [] }

  linkedPeers(): string[] {
    return [...this.linked]
  }
  blockedPieces(): number[] {
    return [...this.blocked]
  }
  hashFailures(): HashFailStats {
    return { total: this.fails.total, worst: this.fails.worst.map(([i, n]) => [i, n]) }
  }
  setViewerLinks(id: string, linked: readonly string[]): void {
    this.links.push([id, [...linked]])
  }
  setViewerUrgent(id: string, pieces: readonly number[]): void {
    this.urgent.push([id, [...pieces]])
  }
  removeViewer(id: string): void {
    this.removed.push(id)
  }
  pieceStates(): Uint8Array {
    return new Uint8Array(this.pieceCount).fill(2)
  }
  asEngine(): TransferEngine {
    return this as unknown as TransferEngine
  }
}

const quiet = (debug = vi.fn()): CoreLog =>
  ({ debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as CoreLog

/** A host and a viewer, linked; the viewer's reports as the host's bus delivers them. */
function pair(): { host: FakeRoom; viewer: FakeRoom; got: BusMessage[] } {
  const host = new FakeRoom(1)
  const viewer = new FakeRoom(2)
  connect(host, viewer)
  host.defineMessage(TRANSFER_LINKS, {})
  const got: BusMessage[] = []
  host.onMessage(TRANSFER_LINKS, (m) => got.push(m))
  return { host, viewer, got }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('reportTransferLinks (viewer)', () => {
  it('reports its lanes and blocked pieces to the host at once and every second, addressed to it', () => {
    vi.useFakeTimers()
    const { viewer, got } = pair()
    const t = new FakeTransfer()
    t.linked = [HOST, 'cc'.repeat(32), viewer.self]
    t.blocked = [7]
    const stop = reportTransferLinks({ room: viewer.asRoom(), hostId: HOST, transfer: t.asEngine(), log: quiet() })
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ from: viewer.self, to: HOST })
    // never itself among its lanes
    expect(got[0]?.body).toEqual({ v: 1, linked: [HOST, 'cc'.repeat(32)], urgent: [7] } satisfies TransferLinks)
    t.blocked = []
    vi.advanceTimersByTime(REPORT_MS)
    expect(got.map((m) => m.body)).toEqual([
      { v: 1, linked: [HOST, 'cc'.repeat(32)], urgent: [7] },
      { v: 1, linked: [HOST, 'cc'.repeat(32)], urgent: [] },
    ])
    vi.advanceTimersByTime(3 * REPORT_MS)
    expect(got).toHaveLength(5)
    stop()
  })

  it('reports a change of its blocked pieces at once, a burst at most every 200 ms ending with the last', () => {
    vi.useFakeTimers()
    const { viewer, got } = pair()
    const t = new FakeTransfer()
    const stop = reportTransferLinks({ room: viewer.asRoom(), hostId: HOST, transfer: t.asEngine(), log: quiet() })
    vi.advanceTimersByTime(REPORT_MIN_GAP_MS)
    t.blocked = [40]
    t.emit('blocked-changed', [40])
    expect(got.map((m) => (m.body as TransferLinks).urgent)).toEqual([[], [40]])
    // a seek reading on: 41, 42, 43 within a few ms
    for (const p of [41, 42, 43]) {
      vi.advanceTimersByTime(5)
      t.blocked = [p]
      t.emit('blocked-changed', [p])
    }
    expect(got).toHaveLength(2)
    vi.advanceTimersByTime(REPORT_MIN_GAP_MS)
    expect(got.map((m) => (m.body as TransferLinks).urgent)).toEqual([[], [40], [43]])
    stop()
  })

  it("sends no more blocked pieces than the host's transfer takes from a report", () => {
    expect(MAX_REPORTED_URGENT).toBe(MAX_URGENT)
  })

  it('caps what it sends, and stops completely when stopped', () => {
    vi.useFakeTimers()
    const { viewer, got } = pair()
    const t = new FakeTransfer()
    t.linked = Array.from({ length: 40 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32))
    t.blocked = Array.from({ length: 80 }, (_, i) => i)
    const before = vi.getTimerCount()
    const stop = reportTransferLinks({ room: viewer.asRoom(), hostId: HOST, transfer: t.asEngine(), log: quiet() })
    const body = got[0]?.body as TransferLinks
    expect(body.linked).toHaveLength(MAX_LINKED)
    expect(body.urgent).toHaveLength(MAX_REPORTED_URGENT)
    t.emit('blocked-changed', [1]) // within the gap: a trailing report is due
    stop()
    expect(vi.getTimerCount()).toBe(before)
    expect(t.listenerCount('blocked-changed')).toBe(0)
    vi.advanceTimersByTime(10 * REPORT_MS)
    expect(got).toHaveLength(1)
  })

  it('adds its hash failures once it has any, at most MAX_REPORTED_HASH_FAILS pieces', () => {
    vi.useFakeTimers()
    const { viewer, got } = pair()
    const t = new FakeTransfer()
    const stop = reportTransferLinks({ room: viewer.asRoom(), hostId: HOST, transfer: t.asEngine(), log: quiet() })
    expect(got[0]?.body).not.toHaveProperty('hashFails') // what an older host reads, unchanged
    t.fails = {
      total: 4,
      worst: [
        [7, 3],
        [2, 1],
      ],
    }
    vi.advanceTimersByTime(REPORT_MS)
    expect((got[1]?.body as TransferLinks).hashFails).toEqual({
      total: 4,
      worst: [
        [7, 3],
        [2, 1],
      ],
    })
    t.fails = { total: 40, worst: Array.from({ length: 20 }, (_, i): [number, number] => [i, 2]) }
    vi.advanceTimersByTime(REPORT_MS)
    expect((got[2]?.body as TransferLinks).hashFails?.worst).toHaveLength(MAX_REPORTED_HASH_FAILS)
    stop()
  })

  it('keeps trying while the host cannot be reached, and says so once', () => {
    vi.useFakeTimers()
    const { viewer, got } = pair()
    const debug = vi.fn()
    const log = quiet(debug)
    viewer.publishFails = true
    const stop = reportTransferLinks({
      room: viewer.asRoom(),
      hostId: HOST,
      transfer: new FakeTransfer().asEngine(),
      log,
    })
    vi.advanceTimersByTime(3 * REPORT_MS)
    expect(debug).toHaveBeenCalledTimes(1)
    viewer.publishFails = false
    vi.advanceTimersByTime(REPORT_MS)
    expect(got).toHaveLength(1)
    stop()
  })
})

describe('collectTransferLinks (host)', () => {
  const CC = 'cc'.repeat(32)
  const DD = 'dd'.repeat(32)

  function host(hashFails?: HashFailWatch): { host: FakeRoom; viewer: FakeRoom; t: FakeTransfer; stop: () => void } {
    const { host, viewer } = pair()
    host.memberIds = [HOST, viewer.self, CC]
    const t = new FakeTransfer()
    const target = { transfer: t.asEngine(), ...(hashFails ? { hashFails } : {}) }
    const stop = collectTransferLinks({
      room: host.asRoom(),
      target: (infoHash) => (infoHash === undefined || infoHash === 'a'.repeat(40) ? target : null),
      all: () => [target],
      log: quiet(),
    })
    return { host, viewer, t, stop }
  }

  it('routes a report by its infoHash, and drops one about a torrent nothing seeds', () => {
    const { viewer, t, stop } = host()
    report(viewer, { v: 1, infoHash: 'b'.repeat(40), linked: [CC], urgent: [1] })
    expect(t.links).toEqual([])
    report(viewer, { v: 1, infoHash: 'a'.repeat(40), linked: [CC], urgent: [1] })
    expect(t.links).toEqual([[viewer.self, [CC]]])
    stop()
  })

  const report = (from: FakeRoom, body: unknown): void => from.publish(TRANSFER_LINKS, body, { to: HOST })

  it("feeds a member's report to the transfer: lanes to admitted members only, pieces of the torrent only", () => {
    const { viewer, t, stop } = host()
    report(viewer, { v: 1, linked: [HOST, CC, DD, viewer.self, CC], urgent: [3, 99, 100, 5000, 3] })
    // DD is not a member; a viewer is never its own lane; 100 and 5000 are past the 100 pieces
    expect(t.links).toEqual([[viewer.self, [HOST, CC]]])
    expect(t.urgent).toEqual([[viewer.self, [3, 99]]])
    report(viewer, { v: 1, linked: [], urgent: [] }) // each report replaces the last: [] clears
    expect(t.urgent.at(-1)).toEqual([viewer.self, []])
    stop()
  })

  it('ignores non-members, malformed reports and its own', () => {
    const { host: h, viewer, t, stop } = host()
    const stranger = new FakeRoom(4)
    connect(h, stranger)
    report(stranger, { v: 1, linked: [], urgent: [1] })
    const bad: unknown[] = [
      { v: 2, linked: [], urgent: [] },
      { v: 1, linked: ['not-a-key'], urgent: [] },
      { v: 1, linked: Array.from({ length: MAX_LINKED + 1 }, () => CC), urgent: [] },
      { v: 1, linked: [], urgent: Array.from({ length: MAX_REPORTED_URGENT + 1 }, (_, i) => i) },
      { v: 1, linked: [], urgent: [1.5] },
      { v: 1, linked: [], urgent: [-1] },
      { v: 1, linked: [] },
      'links',
    ]
    for (const b of bad) report(viewer, b)
    h.publish(TRANSFER_LINKS, { v: 1, linked: [], urgent: [2] })
    expect(t.links).toEqual([])
    expect(t.urgent).toEqual([])
    // a well-formed one still goes through
    report(viewer, { v: 1, linked: [CC], urgent: [] })
    expect(t.links).toEqual([[viewer.self, [CC]]])
    stop()
  })

  it('rate-limits each sender: a flood is cut short, then it is heard again', () => {
    vi.useFakeTimers()
    const { host: h, viewer, t, stop } = host()
    const other = new FakeRoom(3)
    connect(h, other)
    h.memberIds.push(other.self)
    for (let i = 0; i < 50; i++) report(viewer, { v: 1, linked: [], urgent: [i] })
    expect(t.urgent.length).toBeLessThan(15)
    // another member is not held back by it
    report(other, { v: 1, linked: [], urgent: [9] })
    expect(t.urgent.at(-1)).toEqual([other.self, [9]])
    vi.advanceTimersByTime(1000)
    const n = t.urgent.length
    report(viewer, { v: 1, linked: [], urgent: [1] })
    expect(t.urgent).toHaveLength(n + 1)
    stop()
  })

  it("feeds a member's hash failures to the watch, pieces of the torrent only; warns on a piece failing again", () => {
    const alert = vi.fn()
    const watch = new HashFailWatch(alert)
    const update = vi.spyOn(watch, 'update')
    const { host: h, viewer, stop } = host(watch)
    report(viewer, { v: 1, linked: [], urgent: [] })
    expect(update).toHaveBeenLastCalledWith(viewer.self, { total: 0, worst: [] })
    // 100 is past the 100 pieces: a member's claim about it is dropped
    report(viewer, {
      v: 1,
      linked: [],
      urgent: [],
      hashFails: {
        total: 7,
        worst: [
          [100, 5],
          [4, 2],
        ],
      },
    })
    expect(update).toHaveBeenLastCalledWith(viewer.self, { total: 7, worst: [[4, 2]] })
    expect(alert).not.toHaveBeenCalled()
    report(viewer, { v: 1, linked: [], urgent: [], hashFails: { total: 8, worst: [[4, 3]] } })
    expect(alert).toHaveBeenCalledTimes(1)
    expect([...watch.warnings().keys()]).toEqual([viewer.self])
    h.emit('peer-gone', viewer.self)
    expect(watch.warnings().size).toBe(0)
    stop()
  })

  it('drops a report whose hash failures are malformed, links and all', () => {
    const watch = new HashFailWatch(() => undefined)
    const update = vi.spyOn(watch, 'update')
    const { viewer, t, stop } = host(watch)
    const bad: unknown[] = [
      { total: -1, worst: [] },
      { total: 1, worst: [[1, 0]] },
      { total: 1, worst: [[1.5, 1]] },
      { total: 1 },
      { total: 9, worst: Array.from({ length: MAX_REPORTED_HASH_FAILS + 1 }, (_, i) => [i, 1]) },
    ]
    for (const hashFails of bad) report(viewer, { v: 1, linked: [CC], urgent: [], hashFails })
    expect(update).not.toHaveBeenCalled()
    expect(t.links).toEqual([])
    stop()
  })

  it('forgets a viewer whose link closed, and stops listening when stopped', () => {
    const { host: h, viewer, t, stop } = host()
    h.emit('peer-gone', viewer.self)
    expect(t.removed).toEqual([viewer.self])
    stop()
    h.emit('peer-gone', CC)
    report(viewer, { v: 1, linked: [], urgent: [1] })
    expect(t.removed).toEqual([viewer.self])
    expect(t.urgent).toEqual([])
  })
})
