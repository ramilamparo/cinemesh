import { describe, expect, it } from 'vitest'
import type { Span } from '../../shared/ipc/core.js'
import type { MediaMap } from '../../shared/media/media-map.js'
import {
  COVERAGE_BUCKETS,
  Timeline,
  encodeCoverage,
  intersectCoverage,
  subtractSpans,
  unionCoverage,
} from './timeline.js'

const D = 256 // one second per coverage bucket keeps the expected spans readable
const timeline = new Timeline({ durationMs: D * 1000 } as unknown as MediaMap)
const cov = (...done: Span[]): string => encodeCoverage(done, D)

describe('coverage helpers', () => {
  it('encodes whole buckets only and decodes them back as merged spans', () => {
    expect(COVERAGE_BUCKETS).toBe(256)
    // [10.5, 20] covers buckets 11..19 fully; bucket 10 is only half there
    expect(intersectCoverage([cov([10.5, 20], [100, 120])], D)).toEqual([
      [11, 20],
      [100, 120],
    ])
  })

  it('intersects (everyone has it) and unites (someone has it); a member without coverage has nothing', () => {
    const a = cov([0, 50], [100, 150])
    const b = cov([25, 125])
    expect(intersectCoverage([a, b], D)).toEqual([
      [25, 50],
      [100, 125],
    ])
    expect(unionCoverage([a, b], D)).toEqual([[0, 150]])
    expect(intersectCoverage([a, null], D)).toEqual([])
    expect(unionCoverage([a, null], D)).toEqual([
      [0, 50],
      [100, 150],
    ])
    expect(unionCoverage([], D)).toEqual([])
    expect(intersectCoverage([a], 0)).toEqual([])
  })

  it('subtracts sorted span lists', () => {
    expect(subtractSpans([[0, 150]], [])).toEqual([[0, 150]])
    expect(subtractSpans([], [[0, 10]])).toEqual([])
    expect(
      subtractSpans(
        [[0, 150]],
        [
          [25, 50],
          [100, 125],
        ],
      ),
    ).toEqual([
      [0, 25],
      [50, 100],
      [125, 150],
    ])
    // a b-span reaching across two a-spans, and b-spans touching the edges
    expect(
      subtractSpans(
        [
          [0, 10],
          [20, 30],
          [40, 50],
        ],
        [
          [5, 25],
          [40, 45],
          [50, 60],
        ],
      ),
    ).toEqual([
      [0, 5],
      [25, 30],
      [45, 50],
    ])
    expect(subtractSpans([[0, 10]], [[0, 10]])).toEqual([])
  })
})

describe('Timeline.forHost', () => {
  it('shows everyone-has-it as done and someone-has-it as loading, in the renderer event and the OSC', () => {
    const a = cov([0, 50], [100, 150])
    const b = cov([25, 125])
    const { event, osc } = timeline.forHost([a, b], [[30, 40]])
    const groupDone: Span[] = [
      [25, 50],
      [100, 125],
    ]
    const sending: Span[] = [
      [0, 25],
      [50, 100],
      [125, 150],
    ]
    expect(event).toEqual({ durationS: D, done: [[0, D]], loading: sending, buffered: [[30, 40]], groupDone })
    // the OSC paints done in the downloaded colour: on the host that must be what every viewer has
    expect(osc).toEqual({ dur: D, done: groupDone, loading: sending, groupDone })
  })

  it('a viewer without coverage yet leaves nothing done for the group', () => {
    const { event, osc } = timeline.forHost([cov([0, D]), null], [])
    expect(event.groupDone).toEqual([])
    expect(osc.done).toEqual([])
    expect(osc.loading).toEqual([[0, D]])
  })

  it('everyone complete: the whole bar is done and nothing is in flight', () => {
    const { osc } = timeline.forHost([cov([0, D]), cov([0, D])], [])
    expect(osc).toEqual({ dur: D, done: [[0, D]], loading: [], groupDone: [[0, D]] })
  })

  it('without viewers the host shows its own copy and no groupDone', () => {
    const { event, osc } = timeline.forHost([], [])
    expect(event).toEqual({ durationS: D, done: [[0, D]], loading: [], buffered: [] })
    expect(osc).toEqual({ dur: D, done: [[0, D]], loading: [] })
  })
})
