import { describe, expect, it } from 'vitest'
import { type GateMember, startGate } from './start-gate.js'

const m = (id: string, o: Partial<GateMember> = {}): GateMember => ({
  id,
  bufferedAheadS: 0,
  etaS: null,
  rateBps: 0,
  needBps: 1e6,
  ...o,
})

describe('startGate', () => {
  it('buffered: waits for members with less than N s ahead, capped at what is left of the file', () => {
    const mode = { kind: 'buffered', seconds: 10 } as const
    const r = startGate(mode, [m('a', { bufferedAheadS: 10 }), m('b', { bufferedAheadS: 4 })], 0, 3600)
    expect(r).toEqual({ waitingFor: ['b'], etaS: null })
    expect(startGate(mode, [m('b', { bufferedAheadS: 4 })], 3596, 3600).waitingFor).toEqual([])
  })

  it('play-through: ready when the ETA to EOF is at most 0.9 × the remaining duration', () => {
    const mode = { kind: 'play-through' } as const
    // 1000 s left; needs 1 MB/s, gets 2 MB/s: ETA 500 s ≤ 900 s.
    expect(startGate(mode, [m('a', { rateBps: 2e6 })], 0, 1000)).toEqual({ waitingFor: [], etaS: null })
    // Gets 1 MB/s: ETA 1000 s, 100 s over the limit.
    expect(startGate(mode, [m('a', { rateBps: 1e6 })], 0, 1000)).toEqual({ waitingFor: ['a'], etaS: 100 })
    // A reported ETA wins over the estimate; complete members never wait.
    expect(startGate(mode, [m('a', { etaS: 10, rateBps: 1 }), m('b', { needBps: 0 })], 0, 1000).waitingFor).toEqual([])
    // No rate yet: unknown, so wait.
    expect(startGate(mode, [m('a')], 0, 1000)).toEqual({ waitingFor: ['a'], etaS: null })
  })

  it('play-through of a file that plays only once complete: ready at an ETA of 0, and that ETA is reported', () => {
    const mode = { kind: 'play-through' } as const
    const full = { fullDownload: true }
    expect(startGate(mode, [m('a', { etaS: 500 })], 0, 1000, full)).toEqual({ waitingFor: ['a'], etaS: 500 })
    expect(startGate(mode, [m('a', { etaS: 0 }), m('b', { needBps: 0 })], 0, 1000, full).waitingFor).toEqual([])
    // the buffered mode is about what is buffered, whatever the file
    const buffered = { kind: 'buffered', seconds: 10 } as const
    expect(startGate(buffered, [m('a', { bufferedAheadS: 10, etaS: 500 })], 0, 1000, full).waitingFor).toEqual([])
  })
})
