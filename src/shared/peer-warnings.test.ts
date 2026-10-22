import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  PEER_WARNING_ORDER,
  type PeerWarning,
  type PeerWarningCode,
  formatBehindS,
  formatMbit,
  peerWarningLine,
  peerWarningText,
  peerWarningTone,
  sortPeerWarnings,
} from './peer-warnings.js'
import { SLOW_RATE_FACTOR } from './limits.js'

const slow = (o: Partial<Extract<PeerWarning, { code: 'slow-download' }>> = {}): PeerWarning => ({
  code: 'slow-download',
  rateBps: 775_000,
  needBps: 1_187_500,
  bufferInS: 40,
  limitBps: null,
  ...o,
})

describe('peerWarningText', () => {
  it('slow-download: both rates in Mbit/s and when the buffer runs out', () => {
    expect(peerWarningText(slow())).toBe('Download too slow (6.2 of 9.5 Mbit/s); may buffer in ~40 s')
    expect(peerWarningText(slow({ bufferInS: null }))).toBe('Download too slow (6.2 of 9.5 Mbit/s)')
    expect(peerWarningText(slow({ bufferInS: 3 }))).toBe('Download too slow (6.2 of 9.5 Mbit/s); may buffer soon')
    expect(peerWarningText(slow({ bufferInS: 42 }))).toMatch(/; may buffer in ~40 s$/)
    expect(peerWarningText(slow({ bufferInS: 58 }))).toMatch(/; may buffer in ~1 min$/)
    expect(peerWarningText(slow({ bufferInS: 150 }))).toMatch(/; may buffer in ~3 min$/)
    expect(peerWarningText(slow({ bufferInS: 4000 }))).toBe('Download too slow (6.2 of 9.5 Mbit/s)')
    expect(peerWarningText(slow({ rateBps: 0, bufferInS: 12 }))).toBe(
      'Download too slow (0.0 of 9.5 Mbit/s); may buffer in ~10 s',
    )
  })

  it('slow-download at or above the need, or showing the same number: barely keeps up, no estimate', () => {
    expect(peerWarningText(slow({ rateBps: 1_225_000 }))).toBe('Download barely keeps up (9.8 of 9.5 Mbit/s)')
    expect(peerWarningText(slow({ rateBps: 1_180_000, bufferInS: 3 }))).toBe(
      'Download too slow (9.4 of 9.5 Mbit/s); may buffer soon',
    )
    expect(peerWarningText(slow({ rateBps: 1_185_000, bufferInS: 3 }))).toBe(
      'Download barely keeps up (9.5 of 9.5 Mbit/s)',
    )
  })

  it("slow-download names the member's own download limit when it may be why", () => {
    expect(peerWarningText(slow({ rateBps: 487_500, bufferInS: 34, limitBps: 500_000 }))).toBe(
      'Download too slow (3.9 of 9.5 Mbit/s, limit 4.0 Mbit/s); may buffer in ~35 s',
    )
    expect(peerWarningLine('Sam', slow({ rateBps: 487_500, bufferInS: null, limitBps: 500_000 }))).toBe(
      'Sam: download too slow (3.9 of 9.5 Mbit/s, limit 4.0 Mbit/s)',
    )
    // just under SLOW_RATE_FACTOR × need it can still keep the warning on; at it or above, it cannot
    const need = 1_187_500
    expect(peerWarningText(slow({ limitBps: SLOW_RATE_FACTOR * need - 1 }))).toContain(', limit 10 Mbit/s)')
    expect(peerWarningText(slow({ limitBps: SLOW_RATE_FACTOR * need }))).toBe(
      'Download too slow (6.2 of 9.5 Mbit/s); may buffer in ~40 s',
    )
    expect(peerWarningText(slow({ rateBps: 1_225_000, limitBps: 1_250_000 }))).toBe(
      'Download barely keeps up (9.8 of 9.5 Mbit/s, limit 10 Mbit/s)',
    )
    // without the rates the limit is still worth saying
    expect(peerWarningText(slow({ rateBps: null, limitBps: 500_000 }))).toBe('Download too slow (limit 4.0 Mbit/s)')
    expect(peerWarningText(slow({ needBps: null, rateBps: null, limitBps: 500_000 }))).toBe(
      'Download too slow (limit 4.0 Mbit/s)',
    )
  })

  it('slow-download without both rates: no numbers', () => {
    expect(peerWarningText(slow({ rateBps: null }))).toBe('Download too slow')
    expect(peerWarningText(slow({ rateBps: Number.NaN }))).toBe('Download too slow')
    expect(peerWarningText(slow({ needBps: null }))).toBe('Download too slow')
    expect(peerWarningText(slow({ needBps: 0 }))).toBe('Download too slow')
  })

  it('frame drops, hash failures and behind', () => {
    expect(peerWarningText({ code: 'frame-drops' })).toBe('Dropping frames; playback may stutter')
    expect(peerWarningText({ code: 'hash-fails', total: 1 })).toBe(
      'Received data that does not match the video (1 failed check): the video file may have changed on disk, ' +
        'or the disk may be failing. Host it again.',
    )
    expect(peerWarningText({ code: 'hash-fails', total: 5 })).toBe(
      'Received data that does not match the video (5 failed checks): the video file may have changed on disk, ' +
        'or the disk may be failing. Host it again.',
    )
    expect(peerWarningText({ code: 'behind', behindS: 1.44 })).toBe('1.4 s behind the host')
    expect(peerWarningText({ code: 'behind', behindS: 9.97 })).toBe('10 s behind the host')
    expect(peerWarningText({ code: 'behind', behindS: 12.6 })).toBe('13 s behind the host')
    expect(peerWarningText({ code: 'behind', behindS: 95 })).toBe('2 min behind the host')
  })

  it('never shows a raw code', () => {
    // 'behind' is a plain word, and the text uses it
    const all: PeerWarning[] = [slow(), { code: 'frame-drops' }, { code: 'hash-fails', total: 2 }]
    for (const w of all) expect(peerWarningText(w)).not.toContain(w.code)
  })
})

describe('formatBehindS', () => {
  it('one decimal under 10 s without a trailing .0, whole seconds under a minute, then minutes', () => {
    expect([0.5, 1.44, 3, 9.94, 9.97, 12.6, 59.4, 59.6, 95].map(formatBehindS)).toEqual([
      '0.5 s',
      '1.4 s',
      '3 s',
      '9.9 s',
      '10 s',
      '13 s',
      '59 s',
      '1 min',
      '2 min',
    ])
  })
})

describe('peerWarningLine, tone, order', () => {
  it("puts the member's name before the text, lower-cased", () => {
    expect(peerWarningLine('Sam', slow())).toBe('Sam: download too slow (6.2 of 9.5 Mbit/s); may buffer in ~40 s')
    expect(peerWarningLine('Sam', { code: 'behind', behindS: 1.4 })).toBe('Sam: 1.4 s behind the host')
  })

  it('only hash failures are danger', () => {
    expect(peerWarningTone({ code: 'hash-fails', total: 1 })).toBe('danger')
    expect(peerWarningTone(slow())).toBe('warn')
    expect(peerWarningTone({ code: 'frame-drops' })).toBe('warn')
    expect(peerWarningTone({ code: 'behind', behindS: 2 })).toBe('warn')
  })

  it('sorts by severity and keeps the first of each code', () => {
    const sorted = sortPeerWarnings([
      { code: 'frame-drops' },
      slow({ bufferInS: 10 }),
      { code: 'behind', behindS: 2 },
      { code: 'hash-fails', total: 3 },
      slow({ bufferInS: 99 }),
      { code: 'hash-fails', total: 9 },
    ])
    expect(sorted).toEqual([
      { code: 'hash-fails', total: 3 },
      { code: 'behind', behindS: 2 },
      slow({ bufferInS: 10 }),
      { code: 'frame-drops' },
    ])
  })

  it('orders every code', () => {
    expectTypeOf<(typeof PEER_WARNING_ORDER)[number]>().toEqualTypeOf<PeerWarningCode>()
    expect(new Set(PEER_WARNING_ORDER).size).toBe(PEER_WARNING_ORDER.length)
  })
})

describe('formatMbit', () => {
  it('no decimal from 10 Mbit/s, one below, ? when unknown', () => {
    expect(formatMbit(2_900_000)).toBe('23')
    expect(formatMbit(775_000)).toBe('6.2')
    expect(formatMbit(null)).toBe('?')
    expect(formatMbit(Number.POSITIVE_INFINITY)).toBe('?')
  })
})
