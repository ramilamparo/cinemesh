import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FILE } from '../mock/fixtures'
import { type Mounted, byRole, callsOf, click, flush, mountApp, queryByRole, text } from '../test/harness'
import { SPACE_RESERVE_BYTES, spaceCheck } from './JoinConfirm'

describe('spaceCheck', () => {
  it('needs the file size plus a reserve', () => {
    expect(spaceCheck({ size: 10e9 }, 10e9 + SPACE_RESERVE_BYTES).ok).toBe(true)
    const short = spaceCheck({ size: 10e9 }, 10e9 + SPACE_RESERVE_BYTES - 1)
    expect(short.ok).toBe(false)
    expect(short.message).toContain('Not enough space')
  })

  it('counts bytes already downloaded', () => {
    expect(spaceCheck({ size: 10e9, haveBytes: 6e9 }, 5e9).ok).toBe(true)
    expect(spaceCheck({ size: 10e9, haveBytes: 6e9 }, 5e9).needBytes).toBe(4e9)
  })

  it('does not block when free space is unknown, but blocks unwritable folders', () => {
    expect(spaceCheck({ size: 10e9 }, null).ok).toBe(true)
    expect(spaceCheck({ size: 1 }, 1e12, false).message).toContain('cannot be written')
  })
})

describe('JoinConfirm', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('shows the file and joins into the chosen folder', async () => {
    m = await mountApp('confirm-join')
    expect(text(m.container)).toContain(FILE.name)
    expect(text(m.container)).toContain('58.2 GB')
    expect(text(m.container)).toContain('120 GB')
    expect(queryByRole(m.container, 'alert')).toBeNull()
    await click(byRole(m.container, 'button', /^Join$/))
    expect(callsOf(m.fake, 'session.confirmJoin')).toEqual([{ dir: '/home/alex/Downloads/Cinemesh' }])
  })

  it('blocks joining when the drive is too small, until another folder is picked', async () => {
    m = await mountApp('confirm-join-low-space')
    const join = byRole(m.container, 'button', /^Join$/)
    expect(join.hasAttribute('disabled')).toBe(true)
    expect(byRole(m.container, 'alert').textContent).toContain('Not enough space')

    // the fake's pickFolder returns /media/alex/External, which has 2 TB free
    await click(byRole(m.container, 'button', 'Change…'))
    expect(callsOf(m.fake, 'session.checkDir')).toEqual([{ dir: '/media/alex/External' }])
    expect(queryByRole(m.container, 'alert')).toBeNull()
    expect(join.hasAttribute('disabled')).toBe(false)
    await click(join)
    expect(callsOf(m.fake, 'session.confirmJoin')).toEqual([{ dir: '/media/alex/External' }])
  })

  it('shows pending admission with Cancel', async () => {
    m = await mountApp('pending')
    expect(text(m.container)).toContain('Waiting for the host to let you in')
    await click(byRole(m.container, 'button', 'Cancel'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep' }])
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('home')
  })

  it('shows the host preparation progress while connecting', async () => {
    m = await mountApp('connecting-host-preparing')
    expect(text(m.container)).toContain('Connecting to the room')
    expect(text(m.container.querySelector('[data-testid="host-preparing"]') as Element)).toBe(
      'The host is preparing the video: 43 %',
    )
    const prepare = { stage: 'hashing' as const, bytesDone: 87_000, bytesTotal: 100_000, bytesPerSec: 0, cached: false }
    const pending = { phase: 'pending-admission' as const, role: 'viewer' as const, roomId: null, fileName: null }
    act(() => m?.fake.set({ session: { ...pending, fileSize: null, durationS: null }, prepare }))
    await flush()
    expect(text(m.container)).toContain('Waiting for the host to let you in')
    expect(text(m.container)).toContain('The host is preparing the video: 87 %')
  })

  it('shows no preparation line without prepare events, and drops a stale one after leaving', async () => {
    m = await mountApp('connecting')
    expect(m.container.querySelector('[data-testid="host-preparing"]')).toBeNull()
    const prepare = { stage: 'hashing' as const, bytesDone: 10, bytesTotal: 100, bytesPerSec: 0, cached: false }
    act(() => m?.fake.emit('prepare', prepare))
    await flush()
    expect(m.container.querySelector('[data-testid="host-preparing"]')).not.toBeNull()
    // back to idle (cancel), then a new join: the old prepare must not come back
    const idle = { phase: 'idle' as const, role: null, roomId: null, fileName: null, fileSize: null, durationS: null }
    act(() => m?.fake.emit('session', idle))
    await flush()
    act(() => m?.fake.emit('session', { ...idle, phase: 'connecting', role: 'viewer' }))
    await flush()
    expect(text(m.container)).toContain('Connecting to the room')
    expect(m.container.querySelector('[data-testid="host-preparing"]')).toBeNull()
  })
})
