import { describe, expect, it } from 'vitest'
import { DRIFT, DriftController, median } from './drift.js'

/** Fill the median window with D and step at `now`. */
function feed(c: DriftController, D: number, now: number) {
  for (let i = 0; i < DRIFT.MEDIAN_N; i++) c.offer(D, 1, 0, now)
  return c.step(now)
}

describe('DriftController', () => {
  it('needs a full median window of gated samples', () => {
    const c = new DriftController()
    for (let i = 0; i < 4; i++) c.offer(100, 1, 0, 0)
    expect(c.step(0)).toEqual({ kind: 'none' })
    expect(c.offer(100, DRIFT.MAX_IPC_RTT_MS, 0, 0)).toBe(false)
    expect(c.offer(100, 1, DRIFT.MAX_LOOP_LAG_MS, 0)).toBe(false)
    expect(c.offer(100, 1, 0, 0)).toBe(true)
    expect(c.driftMs).toBe(100)
  })

  it('uses the median, so one outlier does not move it', () => {
    expect(median([10, 12, 500, 11, 9])).toBe(11)
    const c = new DriftController()
    for (const d of [10, 12, 500, 11, 9]) c.offer(d, 1, 0, 0)
    expect(c.driftMs).toBe(11)
  })

  it('starts correcting above ON, keeps going down to OFF (hysteresis)', () => {
    const c = new DriftController()
    expect(feed(c, 50, 0)).toEqual({ kind: 'none' })
    // Ahead by 90 ms: slow down by 90/3000 = 3 %.
    expect(feed(c, 90, 250)).toEqual({ kind: 'speed', speed: 0.97 })
    expect(feed(c, 30, 500)).toEqual({ kind: 'speed', speed: 0.99 })
    // Tiny changes (< 0.002) are not sent.
    expect(feed(c, 33, 750)).toEqual({ kind: 'none' })
    expect(feed(c, 10, 1000)).toEqual({ kind: 'speed', speed: 1 })
    expect(feed(c, 40, 1250)).toEqual({ kind: 'none' })
  })

  it('clamps the nudge to ±5 % and speeds up when behind', () => {
    const c = new DriftController()
    expect(feed(c, -900, 0)).toEqual({ kind: 'speed', speed: 1.05 })
    expect(c.speed).toBe(1.05)
  })

  it('skips forward when more than 1 s behind, with a 5 s cooldown; waits paused when ahead', () => {
    const c = new DriftController()
    expect(feed(c, -1500, 10_000)).toEqual({ kind: 'skip' })
    expect(feed(c, -1500, 12_000)).toEqual({ kind: 'speed', speed: 1.05 })
    expect(feed(c, -1500, 15_001)).toEqual({ kind: 'skip' })
    expect(feed(new DriftController(), 1500, 0)).toEqual({ kind: 'pause-wait' })
  })

  it('forces a skip after 20 s of correcting without getting under 200 ms', () => {
    const c = new DriftController()
    let now = 0
    expect(feed(c, -400, now)).toEqual({ kind: 'speed', speed: 1.05 })
    for (now = 250; now <= 20_250; now += 250) feed(c, -400, now)
    expect(feed(c, -400, now)).toEqual({ kind: 'skip' })
  })

  it('spdif: never changes speed; waits when > 150 ms ahead, skips when < −300 ms (10 s cooldown)', () => {
    const c = new DriftController()
    c.canNudge = false
    expect(feed(c, 140, 0)).toEqual({ kind: 'none' })
    expect(feed(c, -280, 250)).toEqual({ kind: 'none' })
    expect(feed(c, 160, 500)).toEqual({ kind: 'pause-wait' })
    expect(feed(c, -310, 750)).toEqual({ kind: 'skip' })
    expect(feed(c, -310, 5000)).toEqual({ kind: 'none' })
    expect(feed(c, -310, 10_751)).toEqual({ kind: 'skip' })
  })

  it('holds: no decisions and no samples until the window passes', () => {
    const c = new DriftController()
    feed(c, 100, 0)
    c.hold(1000, DRIFT.RESTART_HOLD_MS)
    expect(c.driftMs).toBeNull()
    expect(c.holding(1500)).toBe(true)
    expect(c.offer(100, 1, 0, 1500)).toBe(false)
    expect(feed(c, 100, 1999)).toEqual({ kind: 'none' })
    expect(c.holding(2000)).toBe(false)
  })

  it('seekLat: the first timed seek replaces the prior, later ones are an EWMA clamped to 25–3000 ms', () => {
    const c = new DriftController()
    expect(c.seekLatMs).toBe(DRIFT.SEEK_LAT_INIT_MS)
    c.noteSeekDone(48)
    expect(c.seekLatMs).toBe(48)
    c.noteSeekDone(148)
    expect(c.seekLatMs).toBeCloseTo(48 + DRIFT.SEEK_LAT_ALPHA * 100)
    for (let i = 0; i < 50; i++) c.noteSeekDone(10_000)
    expect(c.seekLatMs).toBeCloseTo(3000, 3)
    for (let i = 0; i < 50; i++) c.noteSeekDone(0)
    expect(c.seekLatMs).toBeCloseTo(25, 3)
  })

  it('after trim(), the next decision corrects from OFF up, once; the hysteresis then runs as usual', () => {
    const c = new DriftController()
    c.trim()
    c.hold(0, DRIFT.RESTART_HOLD_MS) // a start's hold keeps the trim for the first window after it
    // 45 ms ahead, inside the dead band: corrected all the same
    expect(feed(c, 45, 1000)).toEqual({ kind: 'speed', speed: 0.985 })
    expect(feed(c, 20, 1250)).toEqual({ kind: 'speed', speed: 0.993 })
    expect(feed(c, 10, 1500)).toEqual({ kind: 'speed', speed: 1 })
    // no trim pending: 45 ms is left alone again
    expect(feed(c, 45, 1750)).toEqual({ kind: 'none' })
    const d = new DriftController()
    expect(feed(d, 45, 0)).toEqual({ kind: 'none' })
  })
})
