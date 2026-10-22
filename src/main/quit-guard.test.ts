import { describe, expect, it, vi } from 'vitest'
import { QuitGuard, type QuitGuardDeps } from './quit-guard.js'

function setup(opts: { inRoom: boolean; answer?: Promise<boolean> }) {
  let inRoom = opts.inRoom
  const deps = {
    inRoom: () => inRoom,
    confirm: vi.fn(() => opts.answer ?? Promise.resolve(true)),
    cancelled: vi.fn(),
    shutdown: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  } satisfies QuitGuardDeps
  const guard = new QuitGuard(deps)
  // app.quit() emits before-quit again, like Electron does
  deps.quit.mockImplementation(() => guard.onBeforeQuit(event()))
  return { guard, deps, leaveRoom: () => (inRoom = false) }
}

const event = () => ({ preventDefault: vi.fn() })
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('QuitGuard', () => {
  it('outside a room: shuts down once, then lets the quit through', async () => {
    const { guard, deps } = setup({ inRoom: false })
    const e = event()
    guard.onBeforeQuit(e)
    expect(e.preventDefault).toHaveBeenCalled()
    guard.onBeforeQuit(event()) // a second Quit while shutting down
    await flush()
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.shutdown).toHaveBeenCalledTimes(1)
    expect(deps.quit).toHaveBeenCalledTimes(1)
    const last = event()
    guard.onBeforeQuit(last)
    expect(last.preventDefault).not.toHaveBeenCalled()
  })

  it('in a room: asks first and quits on yes', async () => {
    const { guard, deps } = setup({ inRoom: true })
    guard.onBeforeQuit(event())
    await flush()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.shutdown).toHaveBeenCalledTimes(1)
    expect(deps.cancelled).not.toHaveBeenCalled()
  })

  it('in a room: no keeps the app running and cancels the tray quit', async () => {
    const { guard, deps } = setup({ inRoom: true, answer: Promise.resolve(false) })
    guard.onBeforeQuit(event())
    await flush()
    expect(deps.cancelled).toHaveBeenCalledTimes(1)
    expect(deps.shutdown).not.toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('asks only once while the question is open, and again after a no', async () => {
    let answer: (v: boolean) => void = () => undefined
    const { guard, deps } = setup({ inRoom: true, answer: new Promise((r) => (answer = r)) })
    guard.onBeforeQuit(event())
    guard.onBeforeQuit(event())
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    answer(false)
    await flush()
    deps.confirm.mockImplementation(() => Promise.resolve(false))
    guard.onBeforeQuit(event())
    await flush()
    expect(deps.confirm).toHaveBeenCalledTimes(2)
  })

  it('a failed prompt counts as no', async () => {
    const { guard, deps } = setup({ inRoom: true, answer: Promise.reject(new Error('no dialog')) })
    guard.onBeforeQuit(event())
    await flush()
    expect(deps.cancelled).toHaveBeenCalled()
    expect(deps.quit).not.toHaveBeenCalled()
  })

  it('quits without asking once the room was left', async () => {
    const { guard, deps, leaveRoom } = setup({ inRoom: true, answer: Promise.resolve(false) })
    guard.onBeforeQuit(event())
    await flush()
    leaveRoom()
    guard.onBeforeQuit(event())
    await flush()
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.shutdown).toHaveBeenCalledTimes(1)
  })

  it('still quits when shutdown fails', async () => {
    const { guard, deps } = setup({ inRoom: false })
    deps.shutdown.mockImplementation(() => Promise.reject(new Error('core stuck')))
    guard.onBeforeQuit(event())
    await flush()
    expect(deps.quit).toHaveBeenCalledTimes(1)
  })
})
