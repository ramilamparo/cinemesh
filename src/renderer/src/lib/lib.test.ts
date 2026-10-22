import { describe, expect, it } from 'vitest'
import { COVERAGE_BUCKETS, coverageRuns, decodeCoverage, encodeCoverage } from './coverage'
import { formatBytes, formatDrift, formatEta, formatMbit, formatPercent, formatTime } from './format'
import { consumesKey, shortcutFor } from './keyboard'
import { PlayheadClock } from './playhead'
import { decodeZ32, encodeZ32, normalizeRelayKey } from './relay-key'

describe('format', () => {
  it('formats sizes, rates and times', () => {
    expect(formatBytes(58_200_000_000)).toBe('58.2 GB')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(120_000_000_000)).toBe('120 GB')
    expect(formatMbit(2_900_000)).toBe('23')
    expect(formatMbit(100_000)).toBe('0.8')
    expect(formatTime(7)).toBe('0:07')
    expect(formatTime(3723)).toBe('1:02:03')
    expect(formatTime(null)).toBe('–:––')
    expect(formatEta(30)).toBe('30 s')
    expect(formatEta(4800)).toBe('1 h 20 min')
    expect(formatPercent(0.996)).toBe('99 %')
    expect(formatPercent(1)).toBe('100 %')
    expect(formatDrift(-380)).toBe('−380 ms')
    expect(formatDrift(1500)).toBe('+1.5 s')
  })
})

describe('coverage', () => {
  it('round-trips and merges runs', () => {
    const bits = Array.from({ length: COVERAGE_BUCKETS }, (_, i) => i < 64 || (i >= 128 && i < 130))
    const decoded = decodeCoverage(encodeCoverage(bits))
    expect(decoded).toEqual(bits)
    expect(coverageRuns(bits)).toEqual([
      [0, 0.25],
      [0.5, 130 / 256],
    ])
  })

  it('treats missing or bad data as unknown', () => {
    expect(decodeCoverage(null)).toBeNull()
    expect(decodeCoverage('%%%')).toBeNull()
  })
})

describe('relay key', () => {
  const hex = 'a1'.repeat(32)
  it('accepts hex in any case and normalises to lowercase', () => {
    expect(normalizeRelayKey(` ${hex.toUpperCase()} `)).toEqual({ ok: true, hex })
  })

  it('accepts z-base-32 and converts it to hex', () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7)
    const z = encodeZ32(bytes)
    expect(z).toHaveLength(52)
    expect(decodeZ32(z)).toEqual(bytes)
    const r = normalizeRelayKey(z)
    expect(r).toEqual({ ok: true, hex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') })
  })

  it('treats empty as none and rejects anything else', () => {
    expect(normalizeRelayKey('  ')).toEqual({ ok: true, hex: null })
    expect(normalizeRelayKey('abc').ok).toBe(false)
    expect(normalizeRelayKey('l'.repeat(52)).ok).toBe(false)
  })
})

describe('PlayheadClock', () => {
  const sample = { posS: 100, durationS: 200, paused: false, seeking: false, stalled: false, at: 5000 }

  it('extrapolates from core time using the smallest observed offset', () => {
    const c = new PlayheadClock()
    c.update(sample, 1300) // delivered 300 ms late: offset -3700
    c.update({ ...sample, at: 6000, posS: 101 }, 2000) // offset -4000 (smaller, closer to truth)
    expect(c.position(2500)).toBeCloseTo(101.5)
  })

  it('holds still while paused, seeking or stalled', () => {
    const c = new PlayheadClock()
    c.update({ ...sample, paused: true }, 1000)
    expect(c.position(9000)).toBe(100)
    c.update({ ...sample, stalled: true }, 1000)
    expect(c.moving).toBe(false)
  })

  it('never runs more than 2 s ahead of a silent core, nor past the end', () => {
    const c = new PlayheadClock()
    c.update(sample, 1000)
    expect(c.position(60_000)).toBe(102)
    c.update({ ...sample, posS: 199.5 }, 1000)
    expect(c.position(3000)).toBe(200)
  })

  it('re-bases after core restarts with a new clock', () => {
    const c = new PlayheadClock()
    c.update(sample, 1000)
    c.update({ ...sample, at: 10 }, 20_000) // offset jumped by far more than any delivery delay
    expect(c.position(20_500)).toBeCloseTo(100.5)
  })
})

describe('keyboard', () => {
  const el = (html: string): Element => {
    const div = document.createElement('div')
    div.innerHTML = html
    return div.firstElementChild as Element
  }

  it('maps shortcuts', () => {
    const body = document.body
    const ev = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
      key: k,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: body,
      ...mods,
    })
    expect(shortcutFor(ev(' '))).toEqual({ kind: 'toggle' })
    expect(shortcutFor(ev('ArrowRight'))).toEqual({ kind: 'seekRel', deltaS: 5 })
    expect(shortcutFor(ev('ArrowLeft', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(ev('x'))).toBeNull()
  })

  it('leaves keys to controls that use them', () => {
    expect(consumesKey(el('<input type="text">'), ' ')).toBe(true)
    expect(consumesKey(el('<textarea></textarea>'), 'ArrowLeft')).toBe(true)
    expect(consumesKey(el('<input type="range">'), 'ArrowLeft')).toBe(true)
    expect(consumesKey(el('<input type="checkbox">'), ' ')).toBe(true)
    expect(consumesKey(el('<input type="checkbox">'), 'ArrowLeft')).toBe(false)
    expect(consumesKey(el('<button>x</button>'), ' ')).toBe(true)
    expect(consumesKey(el('<button>x</button>'), 'ArrowRight')).toBe(false)
    expect(consumesKey(el('<div role="slider"></div>'), 'ArrowRight')).toBe(true)
    expect(consumesKey(el('<div role="slider"></div>'), ' ')).toBe(false)
    expect(consumesKey(el('<div></div>'), ' ')).toBe(false)
  })
})
