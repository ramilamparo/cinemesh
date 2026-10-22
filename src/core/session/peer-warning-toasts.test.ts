import { describe, expect, it } from 'vitest'
import type { PeerView } from '../../shared/ipc/core.js'
import type { PeerWarning } from '../../shared/peer-warnings.js'
import { PEER_TOAST_COOLDOWN_MS, PeerWarningToasts } from './peer-warning-toasts.js'

const SLOW: PeerWarning = {
  code: 'slow-download',
  rateBps: 775_000,
  needBps: 1_187_500,
  bufferInS: 40,
  limitBps: null,
}
const SAM_SLOW = 'Sam: download too slow (6.2 of 9.5 Mbit/s); may buffer in ~40 s'

const view = (id: string, name: string, warnings: PeerWarning[], self = false): PeerView => ({
  id,
  name,
  role: 'viewer',
  self,
  path: 'direct',
  rttMs: 20,
  phase: 'playing',
  driftMs: 0,
  bufferedAheadS: 20,
  downBps: 0,
  upBps: 0,
  havePct: 50,
  coverage: null,
  warnings,
  exempt: false,
})

describe('PeerWarningToasts', () => {
  it('toasts a slow download when it appears, once, and again only after the cooldown', () => {
    const t = new PeerWarningToasts()
    expect(t.next([view('s', 'Sam', [])], 0)).toBeNull()
    expect(t.next([view('s', 'Sam', [SLOW])], 1000)).toBe(SAM_SLOW)
    expect(t.next([view('s', 'Sam', [SLOW])], 2000)).toBeNull()
    // gone and back within the cooldown: quiet
    expect(t.next([view('s', 'Sam', [])], 3000)).toBeNull()
    expect(t.next([view('s', 'Sam', [SLOW])], 4000)).toBeNull()
    // gone and back after it
    expect(t.next([view('s', 'Sam', [])], 1000 + PEER_TOAST_COOLDOWN_MS)).toBeNull()
    expect(t.next([view('s', 'Sam', [SLOW])], 1000 + PEER_TOAST_COOLDOWN_MS)).toBe(SAM_SLOW)
  })

  it('never toasts frame drops, hash failures, behind or our own row', () => {
    const t = new PeerWarningToasts()
    const others: PeerWarning[] = [{ code: 'frame-drops' }, { code: 'hash-fails', total: 4 }]
    others.push({ code: 'behind', behindS: 3 })
    expect(t.next([view('s', 'Sam', others), view('me', 'Me', [SLOW], true)], 0)).toBeNull()
    expect(t.next([view('s', 'Sam', others), view('me', 'Me', [SLOW], true)], 1000)).toBeNull()
  })

  it('toasts one of several onsets in a tick and does not queue the rest', () => {
    const t = new PeerWarningToasts()
    expect(t.next([view('s', 'Sam', [SLOW]), view('o', 'Ola', [SLOW])], 0)).toBe(SAM_SLOW)
    expect(t.next([view('s', 'Sam', [SLOW]), view('o', 'Ola', [SLOW])], 1000)).toBeNull()
  })

  it('forgets a member that left: back within the cooldown, it toasts again', () => {
    const t = new PeerWarningToasts()
    expect(t.next([view('s', 'Sam', [SLOW])], 0)).toBe(SAM_SLOW)
    expect(t.next([], 1000)).toBeNull()
    expect(t.next([view('s', 'Sam', [SLOW])], 2000)).toBe(SAM_SLOW)
  })
})
