import { describe, expect, it, vi } from 'vitest'
import { peerWarningText } from '../../shared/peer-warnings.js'
import { HashFailWatch, SAME_PIECE_FAILS, VIEWERS_WITH_FAILS } from './hash-fails.js'

// The host's view of its viewers' hash failures: one fluke stays quiet; the same piece failing again and again, or
// failures at several viewers, warn once and mark those viewers in the peer list.

describe('HashFailWatch', () => {
  it('stays quiet for a single failure, and warns once the same piece failed SAME_PIECE_FAILS times', () => {
    const alert = vi.fn()
    const w = new HashFailWatch(alert)
    w.update('a', { total: 1, worst: [[7, 1]] })
    w.update('a', {
      total: SAME_PIECE_FAILS,
      worst: [
        [7, SAME_PIECE_FAILS - 1],
        [9, 1],
      ],
    })
    expect(alert).not.toHaveBeenCalled()
    expect(w.alerting).toBe(false)
    expect(w.warnings().size).toBe(0)
    w.update('a', {
      total: SAME_PIECE_FAILS + 1,
      worst: [
        [7, SAME_PIECE_FAILS],
        [9, 1],
      ],
    })
    expect(alert).toHaveBeenCalledTimes(1)
    expect(w.alerting).toBe(true)
    expect(w.warnings()).toEqual(new Map([['a', [{ code: 'hash-fails', total: SAME_PIECE_FAILS + 1 }]]]))
    w.update('a', {
      total: 9,
      worst: [
        [7, 8],
        [9, 1],
      ],
    })
    expect(alert).toHaveBeenCalledTimes(1)
  })

  it('warns when VIEWERS_WITH_FAILS viewers report failures, even one each', () => {
    expect(VIEWERS_WITH_FAILS).toBe(2)
    const alert = vi.fn()
    const w = new HashFailWatch(alert)
    w.update('a', { total: 1, worst: [[3, 1]] })
    w.update('b', { total: 0, worst: [] })
    expect(alert).not.toHaveBeenCalled()
    w.update('b', { total: 1, worst: [[4, 1]] })
    expect(alert).toHaveBeenCalledTimes(1)
    expect([...w.warnings().keys()].sort()).toEqual(['a', 'b'])
  })

  it('forgets a viewer that left or reports none: it neither counts nor shows, and the alert stays given', () => {
    const alert = vi.fn()
    const w = new HashFailWatch(alert)
    w.update('a', { total: 1, worst: [[3, 1]] })
    w.remove('a')
    w.update('b', { total: 1, worst: [[3, 1]] })
    expect(alert).not.toHaveBeenCalled()
    w.update('c', { total: 2, worst: [[5, 2]] })
    expect(alert).toHaveBeenCalledTimes(1)
    w.update('b', { total: 0, worst: [] })
    w.remove('c')
    expect(w.alerting).toBe(true)
    expect(w.warnings().size).toBe(0)
  })

  it('names the failed checks and what the host should do', () => {
    const w = new HashFailWatch(() => undefined)
    w.update('a', { total: 1, worst: [[3, 1]] })
    w.update('b', { total: 4, worst: [[5, 4]] })
    const text = (id: string): string[] => (w.warnings().get(id) ?? []).map(peerWarningText)
    expect(text('a')).toEqual([expect.stringContaining('(1 failed check)')])
    expect(text('b')).toEqual([
      expect.stringMatching(/\(4 failed checks\).*changed on disk.*disk may be failing.*Host it again/),
    ])
  })
})
