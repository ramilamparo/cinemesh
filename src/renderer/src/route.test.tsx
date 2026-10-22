import { afterEach, describe, expect, it } from 'vitest'
import type { SessionPhase } from '../../shared/ipc/core'
import * as fx from './mock/fixtures'
import type { ScenarioName } from './mock/scenarios'
import { type Screen, selectScreen } from './route'
import { type Mounted, byRole, mountApp, text } from './test/harness'

const session = (phase: SessionPhase): NonNullable<fx.StateSlices['session']> => ({
  phase,
  role: null,
  roomId: null,
  fileName: null,
  fileSize: null,
  durationS: null,
})

describe('selectScreen', () => {
  it.each<[SessionPhase | undefined, Screen]>([
    [undefined, 'home'],
    ['idle', 'home'],
    ['preparing', 'host-prepare'],
    ['connecting', 'join'],
    ['pending-admission', 'join'],
    ['confirm-join', 'join'],
    ['in-room', 'room'],
    ['ended', 'room'],
    ['leaving', 'room'],
    ['error', 'error'],
  ])('phase %s → %s', (phase, screen) => {
    expect(selectScreen(phase ? { session: session(phase) } : {})).toBe(screen)
  })

  it.each<[SessionPhase | null, Screen]>([
    ['in-room', 'room'],
    ['ended', 'room'],
    ['preparing', 'host-prepare'],
    ['connecting', 'join'],
    ['pending-admission', 'join'],
    ['confirm-join', 'join'],
    ['error', 'error'],
    // unknown (a snapshot that was already leaving): the Room, where a long save runs
    [null, 'room'],
  ])("'leaving' from %s keeps %s up", (from, screen) => {
    expect(selectScreen({ session: session('leaving') }, from)).toBe(screen)
  })

  it('leavingFrom only matters while leaving', () => {
    expect(selectScreen({ session: session('idle') }, 'in-room')).toBe('home')
    expect(selectScreen({ session: session('in-room') }, 'confirm-join')).toBe('room')
  })

  it.each(['missing', 'tooOld'] as const)('player %s replaces every screen with MpvSetup', (status) => {
    expect(selectScreen({ session: session('in-room'), player: fx.player(status) })).toBe('mpv-setup')
    expect(selectScreen({ player: fx.player(status) })).toBe('mpv-setup')
  })

  it('other player states keep the phase screen', () => {
    expect(selectScreen({ session: session('in-room'), player: fx.player('crashed') })).toBe('room')
  })
})

describe('App routing', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it.each<[ScenarioName, string]>([
    ['home', 'Watch together'],
    ['preparing', 'Preparing to host'],
    ['connecting', 'Connecting to the room'],
    ['pending', 'Waiting for the host to let you in'],
    ['confirm-join', 'Join this room?'],
    ['room-viewer', fx.FILE.name],
    ['ended-host', 'The video has ended'],
    ['mpv-missing', 'Watch Together needs mpv'],
    ['mpv-too-old', 'Your mpv is too old'],
    ['error', 'Something went wrong'],
  ])('scenario %s shows "%s"', async (scenario, heading) => {
    m = await mountApp(scenario)
    expect(text(m.container)).toContain(heading)
  })

  it('follows session events as they arrive', async () => {
    m = await mountApp('home')
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('home')
    const { fake } = m
    const { act } = await import('react')
    await act(async () => {
      fake.set(fx.inRoom('host', performance.now()))
      await Promise.resolve()
    })
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('room')
    expect(byRole(m.container, 'region', 'Host controls')).toBeTruthy()
  })
})
