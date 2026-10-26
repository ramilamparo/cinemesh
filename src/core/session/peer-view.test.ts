import { describe, expect, expectTypeOf, it } from 'vitest'
import { type PeerWarningCode, peerWarningText } from '../../shared/peer-warnings.js'
import type { MemberView } from '../net/room.js'
import type { PeerSync } from '../sync/engine.js'
import type { WarningCode } from '../sync/protocol.js'
import type { PeerTransferStats } from '../transfer/engine.js'
import { bufferRunsOutInS, mergePeerViews } from './peer-view.js'

const member = (id: string, o: Partial<MemberView> = {}): MemberView => ({
  id,
  name: `net-${id}`,
  role: 'viewer',
  self: false,
  isHost: false,
  path: 'direct',
  rttMs: 20,
  linked: true,
  ...o,
})

const sync = (id: string, o: Partial<PeerSync> = {}): PeerSync => ({
  id,
  name: `sync-${id}`,
  phase: 'playing',
  driftMs: 3,
  bufferedAheadS: 12,
  coverage: 'AAAA',
  warnings: ['slow-download'],
  behindS: null,
  exempt: false,
  posS: 42,
  rateBps: 1,
  needBps: 1,
  lagMs: 1,
  clockErrMs: 1,
  downLimitBps: null,
  ...o,
})

const transfer = (id: string, havePct: number): PeerTransferStats => ({
  id,
  downBps: 100,
  upBps: 200,
  downloaded: 0,
  uploaded: 0,
  havePct,
  requests: 0,
  peerChoking: false,
  amChoking: false,
  seeder: false,
  reattaches: 0,
})

describe('mergePeerViews', () => {
  it('joins net, sync and transfer rows by id, with transfer fractions shown as percentages', () => {
    const [row] = mergePeerViews([member('a')], [sync('a')], [transfer('a', 0.4567)])
    expect(row).toEqual({
      id: 'a',
      name: 'sync-a',
      role: 'viewer',
      self: false,
      path: 'direct',
      rttMs: 20,
      phase: 'playing',
      driftMs: 3,
      bufferedAheadS: 12,
      downBps: 100,
      upBps: 200,
      havePct: 45.7,
      coverage: 'AAAA',
      warnings: [{ code: 'slow-download', rateBps: 1, needBps: 1, bufferInS: null, limitBps: null }],
      exempt: false,
      posS: 42,
    })
  })

  it('fills the gaps: no sync row yet is joining, the host has everything, self has no path', () => {
    const rows = mergePeerViews(
      [member('h', { isHost: true, role: 'host', self: true, path: 'via-peer' }), member('b', { linked: false })],
      [],
      [],
    )
    expect(rows.map((r) => [r.name, r.role, r.path, r.phase, r.havePct, r.posS])).toEqual([
      ['net-h', 'host', 'none', 'joining', 100, null],
      ['net-b', 'viewer', 'direct', 'joining', 0, null],
    ])
  })

  it('marks a viewer the host feeds first (catch-up, ADR 0012) from its transfer row, and only then', () => {
    const rows = mergePeerViews(
      [member('a'), member('b')],
      [sync('a'), sync('b')],
      [{ ...transfer('a', 0.1), catchUp: true }, transfer('b', 0.9)],
    )
    expect(rows.map((r) => r.catchingUp)).toEqual([true, undefined])
  })

  it("merges the session's own entries with the member's sync warnings: one per code, most severe first", () => {
    const rows = mergePeerViews(
      [member('a'), member('b'), member('c')],
      [sync('a', { warnings: ['frame-drops', 'slow-download', 'frame-drops'] }), sync('b', { warnings: [] })],
      [],
      new Map([
        ['a', [{ code: 'hash-fails', total: 5 }]],
        ['b', [{ code: 'hash-fails', total: 1 }]],
        ['c', [{ code: 'hash-fails', total: 2 }]],
      ]),
    )
    expect(rows.map((r) => r.warnings.map((w) => w.code))).toEqual([
      ['hash-fails', 'slow-download', 'frame-drops'],
      ['hash-fails'],
      ['hash-fails'],
    ])
    expect(rows[0]?.warnings[0]).toEqual({ code: 'hash-fails', total: 5 })
  })

  it('gives a slow download its rates and, while playing, when the buffer runs out', () => {
    const slow = { warnings: ['slow-download'], bufferedAheadS: 20, rateBps: 775_000, needBps: 1_187_500 } as const
    const row = (o: Partial<PeerSync>) => mergePeerViews([member('a')], [sync('a', { ...slow, ...o })], [])[0]?.warnings
    const [w] = row({}) ?? []
    expect(w).toEqual({
      code: 'slow-download',
      rateBps: 775_000,
      needBps: 1_187_500,
      bufferInS: expect.any(Number) as unknown,
      limitBps: null,
    })
    // it drains at need − rate: 20 s of buffer last 20 / (1 − 6.2/9.5) s
    expect(w?.code === 'slow-download' && w.bufferInS).toBeCloseTo(57.58, 1)
    expect(row({ phase: 'paused' })?.[0]).toMatchObject({ bufferInS: null })
    expect(row({ rateBps: 1_300_000 })?.[0]).toMatchObject({ bufferInS: null })
    expect(row({ rateBps: null })?.[0]).toMatchObject({ rateBps: null, bufferInS: null })
  })

  it("names the member's own download limit in its slow-download warning", () => {
    const slow = { warnings: ['slow-download'], bufferedAheadS: 20, rateBps: 487_500, needBps: 1_187_500 } as const
    const [w] = mergePeerViews([member('a')], [sync('a', { ...slow, downLimitBps: 500_000 })], [])[0]?.warnings ?? []
    expect(w).toMatchObject({ code: 'slow-download', limitBps: 500_000 })
    expect(w && peerWarningText(w)).toBe('Download too slow (3.9 of 9.5 Mbit/s, limit 4.0 Mbit/s); may buffer in ~35 s')
    // a member without a limit (or an older viewer, which never reports one)
    const [plain] = mergePeerViews([member('a')], [sync('a', slow)], [])[0]?.warnings ?? []
    expect(plain && peerWarningText(plain)).toBe('Download too slow (3.9 of 9.5 Mbit/s); may buffer in ~35 s')
  })

  it("shows a member's own desync warning as how far behind the host it is, after hash failures", () => {
    const rows = mergePeerViews(
      [member('a'), member('b'), member('c')],
      [sync('a', { behindS: 3.5 }), sync('b', { warnings: [], behindS: 0 }), sync('c', { warnings: [] })],
      [],
      new Map([['a', [{ code: 'hash-fails', total: 2 }]]]),
    )
    expect(rows.map((r) => r.warnings.map((w) => w.code))).toEqual([['hash-fails', 'behind', 'slow-download'], [], []])
    expect(rows[0]?.warnings[1]).toEqual({ code: 'behind', behindS: 3.5 })
    // no sync row (yet): nothing behind
    expect(mergePeerViews([member('d')], [], [])[0]?.warnings).toEqual([])
  })

  it('bufferRunsOutInS: only for a playing member with everything known, under an hour', () => {
    const at = { phase: 'playing', bufferedAheadS: 20, rateBps: 775_000, needBps: 1_187_500 } as const
    expect(bufferRunsOutInS(at)).toBeCloseTo(57.58, 1)
    expect(bufferRunsOutInS({ ...at, rateBps: 0 })).toBe(20)
    expect(bufferRunsOutInS({ ...at, phase: 'buffering' })).toBeNull()
    expect(bufferRunsOutInS({ ...at, bufferedAheadS: null })).toBeNull()
    expect(bufferRunsOutInS({ ...at, needBps: 0 })).toBeNull()
    expect(bufferRunsOutInS({ ...at, rateBps: Number.NaN })).toBeNull()
    expect(bufferRunsOutInS({ ...at, rateBps: 1_187_500 })).toBeNull()
    // 0.1 % short of the need: 20 s of buffer last 20 000 s
    expect(bufferRunsOutInS({ ...at, rateBps: 1_186_312.5 })).toBeNull()
  })

  it('has a peer-list warning for every sync warning code', () => {
    expectTypeOf<WarningCode>().toExtend<PeerWarningCode>()
  })

  it('explains a failed connection with net hint, or a generic one', () => {
    const [known, unknown] = mergePeerViews(
      [
        member('a', { linked: false, lastError: { code: 'HOLEPUNCH_ABORTED', hint: '' } }),
        member('b', { linked: false, lastError: { code: 'X', hint: 'custom' } }),
      ],
      [],
      [],
    )
    expect(known?.lastError?.code).toBe('HOLEPUNCH_ABORTED')
    expect(known?.lastError?.hint.length).toBeGreaterThan(0)
    expect(unknown?.lastError).toEqual({ code: 'X', hint: 'custom' })
  })
})
