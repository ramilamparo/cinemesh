import { describe, expect, it } from 'vitest'
import { type CatchUpPeer, EXIT_S, HORIZON_S, catchUpRange, pickCatchUp } from './catch-up.js'

const peer = (id: string, ahead: number, o: Partial<CatchUpPeer> = {}): CatchUpPeer => ({
  id,
  phase: 'playing',
  bufferedAheadS: ahead,
  posS: 100,
  needBps: 250_000,
  downLimitBps: null,
  ...o,
})
const pick = (peers: CatchUpPeer[], prev: string[] = [], durationS: number | null = 3600): string[] =>
  [...pickCatchUp(peers, new Set(prev), durationS)].sort()

describe('pickCatchUp', () => {
  it('picks a viewer under 15 s when another has 10 s more, not when the room is short overall', () => {
    expect(pick([peer('a', 5), peer('b', 60)])).toEqual(['a'])
    expect(pick([peer('a', 14), peer('b', 24)])).toEqual(['a'])
    expect(pick([peer('a', 14), peer('b', 23)])).toEqual([]) // nobody far enough ahead
    expect(pick([peer('a', 5), peer('b', 6), peer('c', 8)])).toEqual([]) // everyone short: nothing to rebalance
    expect(pick([peer('a', 16), peer('b', 60)])).toEqual([])
  })

  it('picks a buffering viewer whatever its buffer, when another is well ahead', () => {
    expect(pick([peer('a', 20, { phase: 'buffering' }), peer('b', 60)])).toEqual(['a'])
  })

  it('keeps a picked viewer until 30 s, or until nobody is more than 5 s ahead (no flapping at the edges)', () => {
    expect(pick([peer('a', 20), peer('b', 60)], ['a'])).toEqual(['a'])
    expect(pick([peer('a', EXIT_S), peer('b', 60)], ['a'])).toEqual([])
    expect(pick([peer('a', 20), peer('b', 26)], ['a'])).toEqual(['a'])
    expect(pick([peer('a', 20), peer('b', 25)], ['a'])).toEqual([])
  })

  it('takes at most a third of the viewers (at least one), keeping those picked before newcomers', () => {
    const six = [peer('a', 2), peer('b', 3), peer('c', 4), peer('d', 60), peer('e', 60), peer('f', 60)]
    expect(pick(six)).toEqual(['a', 'b'])
    expect(pick(six, ['c'])).toEqual(['a', 'c'])
    expect(pick([peer('a', 2), peer('b', 3), peer('c', 60)])).toEqual(['a'])
  })

  it('leaves out a viewer limited below its bitrate, one with nothing to feed, and one with everything to the end', () => {
    expect(pick([peer('a', 2, { downLimitBps: 300_000 }), peer('b', 60)])).toEqual([])
    expect(pick([peer('a', 2, { downLimitBps: 400_000 }), peer('b', 60)])).toEqual(['a'])
    for (const phase of ['joining', 'no-player', 'disk-full', 'ended'] as const)
      expect(pick([peer('a', 2, { phase }), peer('b', 60)])).toEqual([])
    expect(pick([peer('a', 2, { bufferedAheadS: null }), peer('b', 60)])).toEqual([])
    expect(pick([peer('a', 2, { posS: null }), peer('b', 60)])).toEqual([])
    // 8 s from the end with those 8 s on disk: short only because the video is
    expect(pick([peer('a', 8, { posS: 92 }), peer('b', 60)], [], 100)).toEqual([])
    expect(pick([peer('a', 8, { posS: 50 }), peer('b', 60)], [], 100)).toEqual(['a'])
  })

  it('does not count a viewer with nothing to feed as the one ahead', () => {
    expect(pick([peer('a', 2), peer('b', 60, { phase: 'disk-full' })])).toEqual([])
  })
})

describe('catchUpRange', () => {
  // 1 s of media = 100 kB, 1 MB pieces; the player starts reading 50 kB before the position
  const map = {
    seekByte: (ms: number) => Math.max(0, ms * 100 - 50_000),
    timeToByte: (ms: number) => ms * 100,
    pieceOf: (b: number) => Math.floor(b / 1_000_000),
  }
  it('covers the next HORIZON_S from the first byte the player reads at that position', () => {
    expect(HORIZON_S).toBe(30)
    expect(catchUpRange(map, 10)).toEqual([0, 3]) // 950 kB .. 4 MB
    expect(catchUpRange(map, 40)).toEqual([3, 6])
    expect(catchUpRange(map, 0)).toEqual([0, 2])
  })
})
