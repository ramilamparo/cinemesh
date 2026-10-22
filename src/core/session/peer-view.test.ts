import { describe, expect, it } from 'vitest'
import type { MemberView } from '../net/room.js'
import type { PeerSync } from '../sync/engine.js'
import type { PeerTransferStats } from '../transfer/engine.js'
import { mergePeerViews } from './peer-view.js'

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
  exempt: false,
  posS: 42,
  rateBps: 1,
  needBps: 1,
  lagMs: 1,
  clockErrMs: 1,
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
      warnings: ['slow-download'],
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
