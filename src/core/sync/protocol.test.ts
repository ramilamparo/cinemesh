import { describe, expect, it } from 'vitest'
import {
  DGRAM_PING,
  DGRAM_PONG,
  DGRAM_STATE_FAST,
  type Datagram,
  decodeDatagram,
  encodeDatagram,
  isNewer,
  isWarningCode,
  parseBusMessage,
  type SyncState,
  type SyncStatus,
  WarningCodeSchema,
} from './protocol.js'

const state: SyncState = {
  t: 'sync.state',
  v: 1,
  syncEpoch: 7,
  seq: 3,
  mode: 'playing',
  anchor: { pos: 12.5, hostTime: 1000, rate: 1 },
  perms: { othersPlayPause: false, othersSeek: false },
  waitForAll: true,
  startMode: { kind: 'buffered', seconds: 10 },
  cause: { by: 'host', kind: 'play', at: 990 },
  members: [{ peerId: 'host', name: 'Host', phase: 'playing', exempt: false }],
  sentAt: 995,
}

const status: SyncStatus = {
  t: 'sync.status',
  syncEpoch: 7,
  seq: 3,
  phase: 'playing',
  barrierId: 2,
  pos: 12.5,
  driftMs: -4,
  bufferedAheadS: 20,
  rateBps: 775_000,
  needBps: 1_187_500,
  coverage: null,
  canNudge: true,
  lagMs: 30,
  clockErrMs: 2,
  frameDrops: 0,
  warnings: ['slow-download', 'frame-drops'],
  etaS: null,
}

describe('datagrams', () => {
  const cases: Datagram[] = [
    { type: DGRAM_PING, id: 0xffff_fffe, t0: 123.456 },
    { type: DGRAM_PONG, id: 9, t0: 1.5, t1: 3.6e6 + 0.25, t2: 3.6e6 + 0.5 },
    {
      type: DGRAM_STATE_FAST,
      syncEpoch: 0xdead_beef,
      seq: 42,
      mode: 'waiting',
      pos: 3600.04,
      hostTime: 1e9,
      sentAt: 1e9 - 5,
    },
  ]

  it.each(cases)('round-trips type $type', (d) => {
    expect(decodeDatagram(encodeDatagram(d))).toEqual(d)
  })

  it('uses [0x53][ver][type] and little-endian fields', () => {
    const buf = encodeDatagram({ type: DGRAM_PING, id: 0x01020304, t0: 0 })
    expect([...buf.subarray(0, 7)]).toEqual([0x53, 1, 1, 0x04, 0x03, 0x02, 0x01])
    expect(buf.length).toBe(15)
  })

  it('decodes from a view into a larger buffer', () => {
    const inner = encodeDatagram(cases[1] as Datagram)
    const outer = new Uint8Array(inner.length + 5)
    outer.set(inner, 5)
    expect(decodeDatagram(outer.subarray(5))).toEqual(cases[1])
  })

  it('rejects foreign, truncated, newer-version and non-finite datagrams', () => {
    const ok = encodeDatagram(cases[2] as Datagram)
    const bad = (mutate: (b: Uint8Array) => Uint8Array): Datagram | null => decodeDatagram(mutate(ok.slice()))
    expect(bad((b) => ((b[0] = 0x54), b))).toBeNull()
    expect(bad((b) => ((b[1] = 2), b))).toBeNull()
    expect(bad((b) => ((b[2] = 9), b))).toBeNull()
    expect(bad((b) => ((b[11] = 77), b))).toBeNull()
    expect(bad((b) => b.subarray(0, b.length - 1))).toBeNull()
    expect(bad((b) => (new DataView(b.buffer).setFloat64(12, NaN, true), b))).toBeNull()
    expect(bad((b) => (new DataView(b.buffer).setFloat64(12, -1, true), b))).toBeNull()
    expect(decodeDatagram(new Uint8Array([0x53]))).toBeNull()
  })
})

describe('bus messages', () => {
  it('accepts a well-formed state and rejects malformed ones', () => {
    expect(parseBusMessage(state)).toEqual(state)
    expect(parseBusMessage({ ...state, v: 2 })).toBeNull()
    expect(parseBusMessage({ ...state, mode: 'rewinding' })).toBeNull()
    expect(parseBusMessage({ ...state, anchor: { pos: -1, hostTime: 0, rate: 1 } })).toBeNull()
    expect(parseBusMessage({ ...state, anchor: { pos: 1, hostTime: 0, rate: 2 } })).toBeNull()
    expect(parseBusMessage({ ...state, seq: 1.5 })).toBeNull()
    expect(parseBusMessage(null)).toBeNull()
    expect(parseBusMessage({ t: 'room.kick' })).toBeNull()
  })

  it('validates intents, results, requests, hello and pings', () => {
    expect(parseBusMessage({ t: 'sync.intent', intentId: 'a:1', kind: 'seek', pos: 30, basedOnSeq: 4 })).not.toBeNull()
    expect(parseBusMessage({ t: 'sync.intent', intentId: '', kind: 'seek', basedOnSeq: 4 })).toBeNull()
    expect(parseBusMessage({ t: 'sync.intent', intentId: 'x', kind: 'toggle', basedOnSeq: 4 })).toBeNull()
    expect(
      parseBusMessage({ t: 'sync.intentResult', intentId: 'x', accepted: false, reason: 'superseded' }),
    ).not.toBeNull()
    expect(parseBusMessage({ t: 'sync.request', kind: 'pause' })).not.toBeNull()
    expect(parseBusMessage({ t: 'sync.hello', resume: null })).not.toBeNull()
    expect(parseBusMessage({ t: 'sync.hello', resume: { syncEpoch: 1, seq: 2 } })).not.toBeNull()
    expect(parseBusMessage({ t: 'sync.ping', id: 1, t0: 5 })).not.toBeNull()
    expect(parseBusMessage({ t: 'sync.pong', id: 1, t0: 5, t1: 6 })).toBeNull()
  })

  it('keeps a status with warning codes it does not know, without them', () => {
    expect(parseBusMessage(status)).toEqual(status)
    expect(parseBusMessage({ ...status, warnings: ['slow-download', 'some-future-code'] })).toEqual({
      ...status,
      warnings: ['slow-download'],
    })
    // still bounded: count, type and length
    expect(parseBusMessage({ ...status, warnings: Array<string>(9).fill('frame-drops') })).toBeNull()
    expect(parseBusMessage({ ...status, warnings: [3] })).toBeNull()
    expect(parseBusMessage({ ...status, warnings: ['x'.repeat(33)] })).toBeNull()
    for (const code of WarningCodeSchema.options) expect(isWarningCode(code)).toBe(true)
    expect(isWarningCode('behind')).toBe(false)
  })

  it('carries how far behind a member is, optionally: older peers neither send nor keep it', () => {
    expect(parseBusMessage({ ...status, behindS: 2.5 })).toEqual({ ...status, behindS: 2.5 })
    // an older viewer: no behindS
    expect(parseBusMessage(status)).not.toHaveProperty('behindS')
    expect(parseBusMessage({ ...status, behindS: -1 })).toBeNull()
    expect(parseBusMessage({ ...status, behindS: 'far' })).toBeNull()
    // what an older host does with it: a field it does not know is dropped, not the status
    expect(parseBusMessage({ ...status, someFutureField: 1 })).toEqual(status)
  })

  it("carries the member's own download limit, optionally, like behindS", () => {
    expect(parseBusMessage({ ...status, downLimitBps: 512_000 })).toEqual({ ...status, downLimitBps: 512_000 })
    expect(parseBusMessage(status)).not.toHaveProperty('downLimitBps')
    expect(parseBusMessage({ ...status, downLimitBps: -1 })).toBeNull()
    expect(parseBusMessage({ ...status, downLimitBps: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseBusMessage({ ...status, behindS: 2, downLimitBps: 1024 })).toEqual({
      ...status,
      behindS: 2,
      downLimitBps: 1024,
    })
  })

  it('isNewer: higher seq in the same epoch, or any other epoch', () => {
    expect(isNewer(null, { syncEpoch: 1, seq: 0 })).toBe(true)
    expect(isNewer({ syncEpoch: 1, seq: 5 }, { syncEpoch: 1, seq: 6 })).toBe(true)
    expect(isNewer({ syncEpoch: 1, seq: 5 }, { syncEpoch: 1, seq: 5 })).toBe(false)
    expect(isNewer({ syncEpoch: 1, seq: 5 }, { syncEpoch: 1, seq: 4 })).toBe(false)
    expect(isNewer({ syncEpoch: 1, seq: 5 }, { syncEpoch: 2, seq: 1 })).toBe(true)
  })
})
