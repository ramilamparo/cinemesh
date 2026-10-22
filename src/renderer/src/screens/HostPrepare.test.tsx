import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE } from '../mock/fixtures'
import { type Mounted, byRole, callsOf, click, flush, mountApp, queryByRole, text } from '../test/harness'
import { feasibilityLine } from '../components/Feasibility'

describe('feasibilityLine', () => {
  it('converts bytes/s to Mbit/s and flags a short upload', () => {
    expect(feasibilityLine({ needBps: 2_900_000, uploadBps: 2_100_000 })).toEqual({
      text: 'Group needs ~23 Mbit/s from you; your upload ~17 Mbit/s',
      short: true,
      byLimit: false,
    })
    expect(feasibilityLine({ needBps: 500_000, uploadBps: 4_400_000 })?.short).toBe(false)
  })

  it('handles an unknown upload and missing data', () => {
    expect(feasibilityLine({ needBps: 500_000, uploadBps: null })).toEqual({
      text: 'Group needs ~4.0 Mbit/s from you; your upload unknown',
      short: false,
      byLimit: false,
    })
    expect(feasibilityLine(undefined)).toBeNull()
  })

  it("names the host's upload limit when that is what the upload comes to", () => {
    const limit = 100 * 1024 // 100 KB/s in Settings: ~0.8 Mbit/s
    expect(feasibilityLine({ needBps: 2_900_000, uploadBps: 102_400 }, limit)).toEqual({
      text: 'Group needs ~23 Mbit/s from you; your upload limit ~0.8 Mbit/s',
      short: true,
      byLimit: true,
    })
    // nothing measured yet: the limit is the most it can be
    expect(feasibilityLine({ needBps: 500_000, uploadBps: null }, limit)).toMatchObject({ short: true, byLimit: true })
    // the link is slower than the limit: the measured upload is the one to show
    expect(feasibilityLine({ needBps: 2_900_000, uploadBps: 50_000 }, limit)).toEqual({
      text: 'Group needs ~23 Mbit/s from you; your upload ~0.4 Mbit/s',
      short: true,
      byLimit: false,
    })
    // a limit far above the need is not short
    expect(feasibilityLine({ needBps: 500_000, uploadBps: 4_400_000 }, 4_400_000)).toMatchObject({
      short: false,
      byLimit: true,
    })
  })
})

describe('HostPrepare', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('shows the current stage, progress, rate, ETA and the feasibility warning', async () => {
    m = await mountApp('preparing')
    expect(text(m.container.querySelector('h1') as Element)).toBe('Preparing to host')
    const current = m.container.querySelector('[aria-current="step"]')
    expect(text(current as Element)).toContain('Hashing')
    expect(byRole(m.container, 'progressbar')).toBeTruthy()
    const body = text(m.container)
    expect(body).toContain('(43 %)')
    expect(body).toMatch(/left/)
    const feasibility = m.container.querySelector('[data-testid="feasibility"]')
    expect(feasibility?.getAttribute('data-short')).toBe('true')
    expect(text(feasibility as Element)).toContain('Group needs ~23 Mbit/s from you; your upload ~17 Mbit/s')
  })

  it('shows the cached badge and hides progress once ready', async () => {
    m = await mountApp('preparing')
    const fake = m.fake
    await act(async () => {
      fake.emit('prepare', {
        stage: 'ready',
        bytesDone: FILE.size,
        bytesTotal: FILE.size,
        bytesPerSec: 0,
        cached: true,
        feasibility: { needBps: 500_000, uploadBps: 4_400_000 },
      })
      await Promise.resolve()
    })
    await flush()
    expect(text(m.container)).toContain('Cached')
    expect(queryByRole(m.container, 'progressbar')).toBeNull()
    expect(m.container.querySelector('[aria-current="step"]')).toBeNull()
    expect(m.container.querySelector('[data-testid="feasibility"]')?.getAttribute('data-short')).toBeNull()
  })

  it('Cancel stops preparing and returns Home', async () => {
    m = await mountApp('preparing')
    await click(byRole(m.container, 'button', 'Cancel'))
    expect(callsOf(m.fake, 'session.cancelPrepare')).toHaveLength(1)
    expect(byRole(m.container, 'region', 'Join a room')).toBeTruthy()
  })
})
