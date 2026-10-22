import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Role, SessionEvent, SessionPhase } from '../../shared/ipc/core'
import type { StateSlices } from './mock/fixtures'
import { type Mounted, byRole, click, flush, mountApp } from './test/harness'
import { setUi } from './store'

// Every screen must render from a bare snapshot: core sends `session` first and the other slices (peers,
// timeline, sync, playback, …) only later. A zustand selector that returns a fresh object or array (`?? []`,
// `.map` in the selector, an object literal) changes the snapshot on every render, and React gives up with
// error #185 "Maximum update depth exceeded". These tests fail on that error, logged or thrown.

const LOOP = /Maximum update depth|Minified React error #185|getSnapshot should be cached|infinite loop/i

function session(phase: SessionPhase, role: Role | null, patch: Partial<SessionEvent> = {}): SessionEvent {
  return { phase, role, roomId: null, fileName: null, fileSize: null, durationS: null, ...patch }
}

const FULL_DOWNLOAD = { media: { container: 'fmp4', seekMode: 'linear' as const, fullDownload: true } }
// no seek index and poorly interleaved: the host's notes (with the fMP4 remux) and the viewer's line
const SLOW_MEDIA = {
  media: { container: 'fmp4', seekMode: 'linear' as const, fullDownload: false, interleave: 'poor' as const },
}

const BARE: { name: string; state: StateSlices; screen: string }[] = [
  { name: 'no slices at all', state: {}, screen: 'home' },
  { name: 'idle', state: { session: session('idle', null) }, screen: 'home' },
  { name: 'preparing (host)', state: { session: session('preparing', 'host') }, screen: 'host-prepare' },
  { name: 'connecting', state: { session: session('connecting', 'viewer') }, screen: 'join' },
  { name: 'pending admission', state: { session: session('pending-admission', 'viewer') }, screen: 'join' },
  // confirm-join without joinInfo yet: falls back to the spinner
  { name: 'confirm-join without joinInfo', state: { session: session('confirm-join', 'viewer') }, screen: 'join' },
  { name: 'in room (host)', state: { session: session('in-room', 'host') }, screen: 'room' },
  { name: 'in room (viewer)', state: { session: session('in-room', 'viewer') }, screen: 'room' },
  { name: 'room closed (host)', state: { session: session('ended', 'host') }, screen: 'room' },
  { name: 'room closed (viewer)', state: { session: session('ended', 'viewer') }, screen: 'room' },
  { name: 'leaving (host)', state: { session: session('leaving', 'host') }, screen: 'room' },
  { name: 'leaving (viewer)', state: { session: session('leaving', 'viewer') }, screen: 'room' },
  { name: 'leaving without a role', state: { session: session('leaving', null) }, screen: 'room' },
  {
    name: 'preparing a full-download file',
    state: { session: session('preparing', 'host', FULL_DOWNLOAD) },
    screen: 'host-prepare',
  },
  {
    name: 'in room with a full-download file (host)',
    state: { session: session('in-room', 'host', FULL_DOWNLOAD) },
    screen: 'room',
  },
  {
    name: 'in room with a full-download file (viewer)',
    state: { session: session('in-room', 'viewer', FULL_DOWNLOAD) },
    screen: 'room',
  },
  {
    name: 'preparing a file without a seek index',
    state: { session: session('preparing', 'host', SLOW_MEDIA) },
    screen: 'host-prepare',
  },
  {
    name: 'in room with a slow-seeking file (host)',
    state: { session: session('in-room', 'host', SLOW_MEDIA) },
    screen: 'room',
  },
  {
    name: 'in room with a slow-seeking file (viewer)',
    state: { session: session('in-room', 'viewer', SLOW_MEDIA) },
    screen: 'room',
  },
  { name: 'saving (viewer)', state: { session: session('leaving', 'viewer', { leave: 'save' }) }, screen: 'room' },
  { name: 'ending the room (host)', state: { session: session('leaving', 'host', { leave: 'end' }) }, screen: 'room' },
  { name: 'error without details', state: { session: session('error', null) }, screen: 'error' },
  {
    name: 'mpv missing',
    state: { player: { status: 'missing', version: null, hdr: blankHdr() } },
    screen: 'mpv-setup',
  },
]

function blankHdr(): NonNullable<StateSlices['player']>['hdr'] {
  return { source: 'unknown', output: 'unknown', gpuContext: null, hwdec: null }
}

describe('screens render from empty core slices without an update loop', () => {
  let m: Mounted | null = null
  let errors: string[] = []
  const onWindowError = (e: ErrorEvent): void => void errors.push(String(e.error ?? e.message))

  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    })
    window.addEventListener('error', onWindowError)
  })
  afterEach(async () => {
    await m?.cleanup()
    m = null
    window.removeEventListener('error', onWindowError)
    vi.restoreAllMocks()
  })

  const expectNoLoop = (): void => {
    expect(errors.filter((e) => LOOP.test(e))).toEqual([])
  }

  for (const c of BARE) {
    it(`${c.name} → ${c.screen}`, async () => {
      m = await mountApp('home', { state: c.state })
      await flush(5)
      expectNoLoop()
      const app = m.container.querySelector('[data-screen]')
      expect(app?.getAttribute('data-screen')).toBe(c.screen)
      // a crashed tree unmounts; the screen must still have content
      expect(m.container.querySelector('main')?.childElementCount).toBeGreaterThan(0)
    })
  }

  it('the room keeps rendering while the slices arrive one by one', async () => {
    m = await mountApp('home', { state: { session: session('in-room', 'host') } })
    const fake = m.fake
    const full = (await import('./mock/fixtures')).inRoom('host', performance.now())
    for (const key of ['room', 'sync', 'playback', 'timeline', 'transfer', 'tracks', 'player', 'peers'] as const) {
      act(() => fake.set({ [key]: full[key] }))
      await flush()
      expectNoLoop()
    }
    // and back to empty lists
    act(() => fake.set({ peers: [] }))
    await flush()
    expectNoLoop()
    expect(byRole(m.container, 'region', 'Host controls')).toBeTruthy()
  })

  it('the room keeps rendering through leaving and back to Home, slices dropping out', async () => {
    m = await mountApp('home', { state: { session: session('in-room', 'viewer', FULL_DOWNLOAD) } })
    const fake = m.fake
    const full = (await import('./mock/fixtures')).inRoom('viewer', performance.now())
    act(() => fake.set({ ...full, session: session('in-room', 'viewer', FULL_DOWNLOAD) }))
    await flush()
    act(() => fake.emit('session', session('leaving', 'viewer')))
    await flush()
    expectNoLoop()
    expect(byRole(m.container, 'status', 'Leaving the room')).toBeTruthy()
    act(() => fake.reset({ session: session('idle', null) }))
    await flush()
    expectNoLoop()
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('home')
  })

  it('overlays render from empty slices too (Settings, leave prompt, join dialog)', async () => {
    m = await mountApp('home', { state: { session: session('in-room', 'viewer') } })
    await click(byRole(m.container, 'button', 'Settings'))
    expect(byRole(m.container, 'dialog', 'Settings')).toBeTruthy()
    act(() => setUi({ settingsOpen: false, leaveOpen: true }))
    await flush()
    expect(byRole(m.container, 'dialog', 'Leave the room?')).toBeTruthy()
    act(() => setUi({ leaveOpen: false, incomingLink: 'watchtogether://join/abc' }))
    await flush()
    expect(byRole(m.container, 'dialog', 'Join another room?')).toBeTruthy()
    expectNoLoop()
  })

  it('Home with a cut-off save, its Finish saving running and the Cancel saving prompt, renders without a loop', async () => {
    m = await mountApp('recent-export-waiting')
    // a finishExport that never answers: the entry stays busy
    m.fake.handle('transfer.finishExport', () => new Promise(() => undefined))
    expect(byRole(m.container, 'region', 'Recent rooms')).toBeTruthy()
    await click(byRole(m.container, 'button', 'Cancel saving'))
    expect(byRole(m.container, 'dialog', 'Cancel saving?')).toBeTruthy()
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'Go back'))
    const finish = byRole(m.container, 'button', 'Finish saving')
    await click(finish)
    expect(finish.textContent).toMatch(/^Saving… /)
    expectNoLoop()
  })

  it("HostPrepare's Stop hosting prompt renders from a bare preparing session", async () => {
    m = await mountApp('home', { state: { session: session('preparing', 'host') } })
    act(() => m?.fake.command('leave'))
    await flush()
    expect(byRole(m.container, 'dialog', 'Stop hosting?')).toBeTruthy()
    expectNoLoop()
  })
})
