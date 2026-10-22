import { describe, expect, it } from 'vitest'
import { DESYNC, type DesyncInfo, type DesyncInput, DesyncMonitor } from './desync.js'

const T = 1000
const TICK = 250
/** At 4 Hz, from the first tick that sees the lag: the timers count from that tick. */
const SHOWN = DESYNC.SHOW_AFTER_MS + TICK
const HIDDEN = DESYNC.HIDE_AFTER_MS + TICK

/** Steps a monitor at 4 Hz from t = 0, recording every info it changes to. */
function run(m = new DesyncMonitor(T)) {
  let t = 0
  const seen: (DesyncInfo | null)[] = []
  const at = (ms: number, i: Partial<DesyncInput>): void => {
    const end = t + ms
    while (t < end) {
      t += TICK
      if (m.step(t, { active: true, catchingUp: false, lagMs: 0, errMs: 0, ...i })) seen.push(m.info)
    }
  }
  return { m, at, seen, now: () => t }
}

const behind = (behindS: number): DesyncInfo => ({ state: 'behind', behindS })
const CATCHING: DesyncInfo = { state: 'catching-up' }

describe('DesyncMonitor', () => {
  it('shows after the lag stayed at the threshold for 2 s, not before', () => {
    const r = run()
    r.at(SHOWN - TICK, { lagMs: T })
    expect(r.m.info).toBeNull()
    r.at(TICK, { lagMs: T })
    expect(r.m.info).toEqual(behind(1))
  })

  it('starts over after a single tick under the threshold', () => {
    const r = run()
    r.at(1750, { lagMs: 1200 })
    r.at(TICK, { lagMs: 900 })
    r.at(SHOWN - TICK, { lagMs: 1200 })
    expect(r.m.info).toBeNull()
    r.at(TICK, { lagMs: 1200 })
    expect(r.m.info).toEqual(behind(1))
  })

  it('once shown, stays between half the threshold and it; hides after 1 s under half', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 1500 })
    expect(r.m.info).toEqual(behind(1.5))
    r.at(5000, { lagMs: 700 })
    expect(r.m.info).toEqual(behind(0.5))
    // on its way out it keeps the number it showed: never "0 s behind", also for a lag below 0
    r.at(HIDDEN - TICK - TICK, { lagMs: 100 })
    r.at(TICK, { lagMs: -300 })
    expect(r.m.info).toEqual(behind(0.5))
    r.at(TICK, { lagMs: 100 })
    expect(r.m.info).toBeNull()
    expect(r.seen).toEqual([behind(1.5), behind(0.5), null])
  })

  it('clears at once when it no longer applies (room paused, member settled), timers and all', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 3000 })
    expect(r.m.info).toEqual(behind(3))
    r.at(TICK, { active: false, lagMs: 3000 })
    expect(r.m.info).toBeNull()
    // the show timer started over too
    r.at(SHOWN - TICK, { lagMs: 3000 })
    expect(r.m.info).toBeNull()
  })

  it('a catch-up shows only after a warning: then as catching-up with no number', () => {
    const r = run()
    // a start or the drift loop's skip: nothing, and no show time piles up meanwhile
    r.at(5000, { catchingUp: true, lagMs: 5000 })
    expect(r.seen).toEqual([])
    r.at(SHOWN - TICK, { lagMs: 5000 })
    expect(r.m.info).toBeNull()
    r.at(TICK, { lagMs: 5000 })
    expect(r.m.info).toEqual(behind(5))
    r.at(TICK, { catchingUp: true, lagMs: 5000 })
    expect(r.m.info).toEqual(CATCHING)
  })

  it("the user's Resync shows catching-up even with no warning shown", () => {
    const r = run()
    expect(r.m.markResync()).toBe(true)
    r.at(1000, { catchingUp: true, lagMs: 800 })
    expect(r.m.info).toEqual(CATCHING)
  })

  it('a catch-up that lands in sync clears at once: never behind again with the old number', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 4000 })
    r.at(750, { catchingUp: true, lagMs: 4200 })
    r.at(TICK, { lagMs: 20 })
    expect(r.m.info).toBeNull()
    expect(r.seen).toEqual([behind(4), CATCHING, null])
    // and the Resync path, where the catch-up may be over before the next tick sees it
    const q = run()
    q.at(SHOWN, { lagMs: 3000 })
    q.m.markResync()
    q.at(3000, { lagMs: 10 })
    expect(q.seen).toEqual([behind(3), null])
    expect(q.m.info).toBeNull()
  })

  it('a catch-up that falls short stays catching-up, and shows behind only after another 2 s behind', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 3000 })
    r.at(500, { catchingUp: true })
    r.at(SHOWN - TICK, { lagMs: 2000 })
    expect(r.m.info).toEqual(CATCHING)
    r.at(TICK, { lagMs: 2000 })
    expect(r.m.info).toEqual(behind(2))
    // between half the threshold and it, after a catch-up: the drift loop has it; nothing after 2 s
    const q = run()
    q.at(SHOWN, { lagMs: 3000 })
    q.at(500, { catchingUp: true })
    q.at(SHOWN - TICK, { lagMs: 700 })
    expect(q.m.info).toEqual(CATCHING)
    q.at(TICK, { lagMs: 700 })
    expect(q.m.info).toBeNull()
  })

  it('counts only the lag beyond the clock error', () => {
    const poor = run()
    poor.at(10_000, { lagMs: 1100, errMs: 200 })
    expect(poor.m.info).toBeNull()
    const good = run()
    good.at(SHOWN, { lagMs: 1100, errMs: 50 })
    // the number is the lag itself
    expect(good.m.info).toEqual(behind(1))
  })

  it('is off at 0; a new threshold starts afresh', () => {
    const off = run(new DesyncMonitor(0))
    off.at(10_000, { lagMs: 60_000 })
    expect(off.seen).toEqual([])
    const r = run()
    r.at(SHOWN, { lagMs: 2000 })
    expect(r.m.configure(5000)).toBe(true)
    expect(r.m.info).toBeNull()
    r.at(10_000, { lagMs: 2000 })
    expect(r.m.info).toBeNull()
    r.m.configure(T)
    r.at(SHOWN, { lagMs: 2000 })
    expect(r.m.info).toEqual(behind(2))
  })

  it('the same threshold again changes nothing: what is shown and its timers stay', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 3000 })
    expect(r.m.configure(T)).toBe(false)
    expect(r.m.info).toEqual(behind(3))
    r.at(TICK, { lagMs: 3000 })
    expect(r.m.info).toEqual(behind(3))
    // nor does it end a Resync's catching-up
    r.m.markResync()
    expect(r.m.configure(T)).toBe(false)
    r.at(TICK, { catchingUp: true, lagMs: 3000 })
    expect(r.m.info).toEqual(CATCHING)
    expect(r.seen).toEqual([behind(3)])
  })

  it('steps behindS by 0.5 s and reports a change only when the state or that number changes', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 1100 })
    for (const lag of [1200, 1260, 1700, 1760, 2400, 2600]) r.at(TICK, { lagMs: lag })
    expect(r.seen).toEqual([behind(1), behind(1.5), behind(2), behind(2.5)])
  })

  it('keeps what it shows without a measurement, and restarts its timers', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 3000 })
    r.at(5000, { lagMs: null })
    expect(r.m.info).toEqual(behind(3))
    const q = run()
    q.at(1750, { lagMs: 3000 })
    q.at(TICK, { lagMs: null })
    q.at(SHOWN - TICK, { lagMs: 3000 })
    expect(q.m.info).toBeNull()
    q.at(TICK, { lagMs: 3000 })
    expect(q.m.info).toEqual(behind(3))
  })

  it('restartTimers keeps a shown warning', () => {
    const r = run()
    r.at(SHOWN, { lagMs: 3000 })
    r.m.restartTimers()
    expect(r.m.info).toEqual(behind(3))
    const q = run()
    q.at(1750, { lagMs: 3000 })
    q.m.restartTimers()
    q.at(1750, { lagMs: 3000 })
    expect(q.m.info).toBeNull()
  })
})
