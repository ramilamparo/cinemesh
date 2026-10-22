import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Bans } from './bans.js'

describe('bans', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('expires a ban and reports it so the swarm can unban the peer', () => {
    const expired: string[] = []
    const bans = new Bans({ onExpire: (k) => expired.push(k) })
    const key = Buffer.alloc(32, 7)
    bans.ban(key, 10 * 60_000, 'auth')
    expect(bans.has(key)).toBe(true)
    expect(bans.has(key.toString('hex'))).toBe(true)
    vi.advanceTimersByTime(10 * 60_000 - 1)
    expect(bans.has(key)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(expired).toEqual([key.toString('hex')])
    expect(bans.has(key)).toBe(false)
  })

  it('keeps session bans and never shortens a longer ban', () => {
    const bans = new Bans()
    bans.ban('aa', Infinity, 'kick')
    bans.ban('aa', 1000, 'auth')
    vi.advanceTimersByTime(24 * 3600_000)
    expect(bans.has('aa')).toBe(true)
    expect(bans.reason('aa')).toBe('kick')
    expect(bans.permanent()).toEqual(['aa'])
  })

  it('unban lifts immediately', () => {
    const expired: string[] = []
    const bans = new Bans({ onExpire: (k) => expired.push(k) })
    bans.ban('bb', 5000, 'manual')
    bans.unban('bb')
    expect(bans.has('bb')).toBe(false)
    expect(expired).toEqual(['bb'])
  })
})
