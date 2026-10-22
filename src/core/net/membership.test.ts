import { describe, expect, it } from 'vitest'
import { ATTEMPT_KEYS, type JoinAttempt, Membership } from './membership.js'

const host = { key: 'h'.repeat(64), name: 'Host', role: 'host' as const }

/** A request's place: attempt `n` (its nonce and start), re-send `seq` within it. */
const att = (n: number, seq = 1): JoinAttempt => ({ nonce: String(n).padStart(32, '0'), at: 1000 * n, seq })
const N1 = att(1).nonce

describe('membership', () => {
  it('admits in open mode up to the cap, then denies with full', () => {
    const m = new Membership(host, { mode: 'open', maxMembers: 3, isBanned: () => false })
    expect(m.request('a', 'A', att(1))).toEqual({ kind: 'admitted', nonce: N1 })
    expect(m.request('b', 'B', att(1))).toEqual({ kind: 'admitted', nonce: N1 })
    expect(m.request('c', 'C', att(1))).toEqual({ kind: 'denied', reason: 'full', nonce: N1 })
    expect(m.request('a', 'A2', att(1, 2))).toEqual({ kind: 'member', renamed: true, nonce: N1 })
    expect(m.request('a', 'A2', att(1, 3))).toEqual({ kind: 'member', nonce: N1 })
    expect(m.list().map((x) => x.name)).toEqual(['Host', 'A2', 'B'])
  })

  it('renames by replacing the record, so a list handed out earlier keeps the old name', () => {
    const m = new Membership(host, { mode: 'open', maxMembers: 8, isBanned: () => false })
    m.request('a', 'Sam', att(1))
    const published = m.list()
    expect(m.request('a', 'Samuel', att(2))).toMatchObject({ kind: 'member', renamed: true })
    expect(published.map((x) => x.name)).toEqual(['Host', 'Sam'])
    expect(m.list().map((x) => x.name)).toEqual(['Host', 'Samuel'])
  })

  it('queues requests in approve mode until the host decides, and answers each about the attempt that waits', () => {
    const m = new Membership(host, { mode: 'approve', maxMembers: 8, isBanned: () => false })
    expect(m.request('a', 'A', att(1))).toEqual({ kind: 'pending', nonce: N1 })
    expect(m.request('b', 'B', att(2))).toEqual({ kind: 'pending', nonce: att(2).nonce })
    expect(m.pendingList().map((p) => [p.key, p.nonce])).toEqual([
      ['a', N1],
      ['b', att(2).nonce],
    ])
    expect(m.decide('a', true)).toEqual({ kind: 'admitted', nonce: N1 })
    expect(m.decide('b', false)).toEqual({ kind: 'denied', reason: 'rejected', nonce: att(2).nonce })
    expect(m.decide('zz', true)).toBeNull()
    expect(m.pendingList()).toEqual([])
  })

  it('tells a re-sent request from news while it waits: a new name, or another way in', () => {
    const m = new Membership(host, {
      mode: 'approve',
      maxMembers: 8,
      isBanned: () => false,
      members: [{ key: 'r', name: 'Rae', role: 'viewer' }],
    })
    expect(m.request('a', 'A', att(1))).toEqual({ kind: 'pending', nonce: N1 })
    expect(m.request('a', 'A', att(1, 2))).toEqual({ kind: 'pending', refreshed: true, nonce: N1 })
    // a new name is news for the host's list
    expect(m.request('a', 'Ann', att(1, 3))).toEqual({ kind: 'pending', nonce: N1 })
    expect(m.pendingList().map((p) => p.name)).toEqual(['Ann'])
    // a new attempt (the joiner came back) shows nothing new, but its answer carries its own nonce
    expect(m.request('a', 'Ann', att(2))).toEqual({ kind: 'pending', refreshed: true, nonce: att(2).nonce })
    expect(m.nonceOf('a')).toBe(att(2).nonce)
    // the same attempt relayed instead of direct is news too: the list shows who relayed it
    expect(m.request('a', 'Ann', att(2, 2), 'r')).toEqual({ kind: 'pending', nonce: att(2).nonce })
    expect(m.pendingList()).toMatchObject([{ key: 'a', via: { key: 'r', name: 'Rae' } }])
  })

  it('takes only a newer request from a key: a later attempt, or a later re-send of the same one', () => {
    let now = 0
    const m = new Membership(host, { mode: 'approve', maxMembers: 8, isBanned: () => false, now: () => now })
    expect(m.isFresh('a', att(2, 5))).toBe(true)
    m.request('a', 'A', att(2, 5))
    // replays: the same request, an earlier one of this attempt, any of an earlier attempt
    expect(m.isFresh('a', att(2, 5))).toBe(false)
    expect(m.isFresh('a', att(2, 4))).toBe(false)
    expect(m.isFresh('a', att(1, 99))).toBe(false)
    // another nonce claiming the same start is not this attempt
    expect(m.isFresh('a', { ...att(2, 6), nonce: 'f'.repeat(32) })).toBe(false)
    expect(m.isFresh('a', att(2, 6))).toBe(true)
    expect(m.isFresh('a', att(3, 1))).toBe(true)
    // the order of a key's attempts is kept while its requests are: a joiner whose clock went back holds up
    // its next attempt no longer than an unrepeated request is kept
    now += 20_000
    expect(m.expirePending(30_000)).toBe(false)
    expect(m.isFresh('a', att(1, 1))).toBe(false)
    now += 20_000
    expect(m.expirePending(30_000)).toBe(true)
    expect(m.isFresh('a', att(1, 1))).toBe(true)
    // each key has its own order
    m.request('b', 'B', att(5))
    expect(m.isFresh('a', att(1, 1))).toBe(true)
  })

  it('remembers the order of at most ATTEMPT_KEYS keys, forgetting the one heard from least recently', () => {
    const m = new Membership(host, { mode: 'open', maxMembers: 2, isBanned: () => false })
    for (let i = 0; i <= ATTEMPT_KEYS; i++) m.request(`k${String(i)}`, 'K', att(1))
    expect(m.isFresh('k0', att(1))).toBe(true)
    expect(m.isFresh('k1', att(1))).toBe(false)
    expect(m.isFresh(`k${String(ATTEMPT_KEYS)}`, att(1))).toBe(false)
  })

  it('records who relayed a request, and keeps the first relayer for re-sends of the same attempt', () => {
    const m = new Membership(host, {
      mode: 'approve',
      maxMembers: 8,
      isBanned: () => false,
      members: [
        { key: 'x', name: 'Xia', role: 'viewer' },
        { key: 'y', name: 'Yan', role: 'viewer' },
      ],
    })
    const via = (): unknown => m.pendingList()[0]?.via
    expect(m.request('j', 'J', att(1), 'x')).toEqual({ kind: 'pending', nonce: N1 })
    expect(via()).toEqual({ key: 'x', name: 'Xia' })
    // a joiner asks through every neighbour: the list does not flip between them
    expect(m.request('j', 'J', att(1, 2), 'y')).toEqual({ kind: 'pending', refreshed: true, nonce: N1 })
    expect(via()).toEqual({ key: 'x', name: 'Xia' })
    // unless that neighbour is gone, or it is a new attempt
    m.remove('x')
    expect(m.request('j', 'J', att(1, 3), 'y')).toEqual({ kind: 'pending', nonce: N1 })
    expect(via()).toEqual({ key: 'y', name: 'Yan' })
    // straight to the host: nobody relayed it
    expect(m.request('j', 'J', att(1, 4))).toEqual({ kind: 'pending', nonce: N1 })
    expect(via()).toBeUndefined()
    expect(m.request('j', 'J', att(2), 'y')).toEqual({ kind: 'pending', nonce: att(2).nonce })
    expect(via()).toEqual({ key: 'y', name: 'Yan' })
  })

  it('drops the requests a kicked member relayed, and only those', () => {
    const m = new Membership(host, {
      mode: 'approve',
      maxMembers: 8,
      isBanned: () => false,
      members: [
        { key: 'mal', name: 'Mal', role: 'viewer' },
        { key: 'x', name: 'Xia', role: 'viewer' },
      ],
    })
    m.request('g1', 'Ghost', att(1), 'mal')
    m.request('g2', 'Ghost', att(1), 'mal')
    m.request('j', 'J', att(1), 'x')
    m.request('d', 'D', att(1))
    expect(m.dropRelayedBy('x')).toBe(true)
    expect(m.dropRelayedBy('mal')).toBe(true)
    expect(m.dropRelayedBy('mal')).toBe(false)
    expect(m.pendingList().map((p) => p.key)).toEqual(['d'])
  })

  it('renames a member at most once per renameMs; a newer name waits its turn and the latest wins', () => {
    let now = 0
    const m = new Membership(host, {
      mode: 'open',
      maxMembers: 8,
      isBanned: () => false,
      renameMs: 30_000,
      now: () => now,
    })
    m.request('a', 'Sam', att(1))
    expect(m.request('a', 'Samuel', att(2))).toEqual({ kind: 'member', renamed: true, nonce: att(2).nonce })
    now += 1000
    expect(m.request('a', 'Sammy', att(3))).toMatchObject({ kind: 'member' })
    expect(m.request('a', 'Mallory', att(4))).not.toHaveProperty('renamed')
    expect(m.list().map((x) => x.name)).toEqual(['Host', 'Samuel'])
    now += 10_000
    expect(m.applyHeldRenames()).toBe(false)
    now += 19_000
    expect(m.applyHeldRenames()).toBe(true)
    expect(m.list().map((x) => x.name)).toEqual(['Host', 'Mallory'])
    expect(m.applyHeldRenames()).toBe(false)
    // asking again under the name it has drops one still waiting
    now += 1000
    expect(m.request('a', 'Eve', att(5))).not.toHaveProperty('renamed')
    expect(m.request('a', 'Mallory', att(6))).not.toHaveProperty('renamed')
    now += 60_000
    expect(m.applyHeldRenames()).toBe(false)
    expect(m.list().map((x) => x.name)).toEqual(['Host', 'Mallory'])
  })

  it('expires pending requests that are not repeated', () => {
    let now = 1000
    const m = new Membership(host, { mode: 'approve', maxMembers: 8, isBanned: () => false, now: () => now })
    m.request('a', 'A', att(1))
    m.request('b', 'B', att(1))
    now += 20_000
    m.request('b', 'B', att(1, 2)) // b re-sent its request, a did not
    expect(m.expirePending(30_000)).toBe(false)
    now += 20_000
    expect(m.expirePending(30_000)).toBe(true)
    expect(m.pendingList().map((p) => [p.key, p.since])).toEqual([['b', 1000]])
    expect(m.withdraw('b')).toBe(true)
    expect(m.pendingList()).toEqual([])
  })

  it('admits everyone waiting when switched to open', () => {
    const m = new Membership(host, { mode: 'approve', maxMembers: 2, isBanned: () => false })
    m.request('a', 'A', att(1))
    m.request('b', 'B', att(2))
    const outcomes = m.setMode('open')
    expect(outcomes.get('a')).toEqual({ kind: 'admitted', nonce: N1 })
    expect(outcomes.get('b')).toEqual({ kind: 'denied', reason: 'full', nonce: att(2).nonce })
  })

  it('denies banned keys and never removes the host', () => {
    const m = new Membership(host, { mode: 'open', maxMembers: 8, isBanned: (k) => k === 'x' })
    expect(m.request('x', 'X', att(1))).toEqual({ kind: 'denied', reason: 'banned', nonce: N1 })
    expect(m.remove(host.key)).toBe(false)
  })

  it('restores saved members, clamps the cap', () => {
    const m = new Membership(host, {
      mode: 'open',
      maxMembers: 50,
      members: [{ key: 'a', name: 'A', role: 'viewer' }],
      isBanned: () => false,
    })
    expect(m.has('a')).toBe(true)
    expect(m.maxMembers).toBe(12)
    // a member restored from the record has told this host nothing yet: a kick of it carries no nonce
    expect(m.nonceOf('a')).toBeUndefined()
  })
})
