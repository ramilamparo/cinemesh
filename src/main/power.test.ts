import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ powerSaveBlocker: {} }))
vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn() } }))

const { PowerKeeper, bindPower } = await import('./power.js')

function fakeBlocker() {
  const started = new Set<number>()
  let next = 1
  return {
    started,
    start: vi.fn(() => {
      const id = next++
      started.add(id)
      return id
    }),
    stop: vi.fn((id: number) => started.delete(id)),
    isStarted: (id: number) => started.has(id),
  }
}

describe('PowerKeeper', () => {
  it('holds a single prevent-app-suspension blocker while asked to', () => {
    const b = fakeBlocker()
    const k = new PowerKeeper(b)
    k.set(true)
    k.set(true)
    expect(b.start).toHaveBeenCalledTimes(1)
    expect(b.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(k.active).toBe(true)
    k.set(false)
    k.set(false)
    expect(b.stop).toHaveBeenCalledTimes(1)
    expect(k.active).toBe(false)
  })

  it('follows core power messages and releases when core crashes', () => {
    const b = fakeBlocker()
    const core = new EventEmitter()
    const k = bindPower(core, new PowerKeeper(b))
    core.emit('power', true)
    expect(k.active).toBe(true)
    core.emit('crashed', 1)
    expect(k.active).toBe(false)
    core.emit('power', true)
    k.dispose()
    expect(b.started.size).toBe(0)
  })
})
