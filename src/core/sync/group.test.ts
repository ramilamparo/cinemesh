import { describe, expect, it } from 'vitest'
import { EventLoop, NodeClock, rng } from '../../../test/sync/sim/loop.js'
import type { StartMode } from '../../shared/settings.js'
import { GROUP, GroupController, type GroupNotice, type GroupSnapshot } from './group.js'
import type { SyncState, SyncStatus } from './protocol.js'

function setup(o: { waitForAll?: boolean; resume?: GroupSnapshot; startMode?: StartMode } = {}) {
  const loop = new EventLoop()
  const clock = new NodeClock(loop, rng(1), { offsetMs: 5e6, skewPpm: 0, timerLateMs: 0 })
  const published: SyncState[] = []
  const notices: GroupNotice[] = []
  const g = new GroupController({
    clock,
    selfId: 'host',
    selfName: 'Host',
    syncEpoch: 99,
    perms: { othersPlayPause: true, othersSeek: true },
    waitForAll: o.waitForAll ?? true,
    startMode: o.startMode ?? { kind: 'buffered', seconds: 0 },
    resume: o.resume,
    hooks: {
      publish: (s) => published.push(s),
      persist: () => undefined,
      notice: (n) => notices.push(n),
      hostPosition: () => null,
    },
  })
  g.start()
  const status = (id: string, s: Partial<SyncStatus> = {}): void => {
    const st = g.state()
    g.onStatus(id, {
      t: 'sync.status',
      syncEpoch: st?.syncEpoch ?? 99,
      seq: st?.seq ?? 0,
      phase: 'paused',
      pos: st?.anchor.pos ?? 0,
      driftMs: null,
      bufferedAheadS: 100,
      rateBps: 0,
      needBps: 0,
      coverage: null,
      canNudge: true,
      lagMs: 0,
      clockErrMs: 0,
      frameDrops: 0,
      warnings: [],
      ...s,
    })
  }
  /** Members settled where the current state wants them. */
  const ready = (...ids: string[]): void => {
    for (const id of ids) status(id, { phase: 'ready', barrierId: g.state()?.seq ?? 0 })
  }
  return { loop, g, published, notices, status, ready }
}

const intent = (id: string, kind: 'play' | 'pause' | 'seek', basedOnSeq: number, pos?: number) => ({
  intentId: id,
  kind,
  basedOnSeq,
  ...(pos === undefined ? {} : { pos }),
})

describe('GroupController', () => {
  it('starts idle, rejects intents as not-ready, then publishes paused at 0', () => {
    const { g, published } = setup()
    expect(g.onIntent('v1', intent('a', 'play', 0))).toEqual({ accepted: false, reason: 'not-ready' })
    g.mediaReady(600)
    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({ syncEpoch: 99, seq: 1, mode: 'paused', anchor: { pos: 0 } })
  })

  it('seek barrier: waits for included members, resumes playing with a fresh anchor', () => {
    const { loop, g, ready, status } = setup()
    g.addMember('v1', 'Ann')
    g.addMember('v2', 'Bob')
    g.mediaReady(600)
    ready('host', 'v1', 'v2')
    g.onIntent('host', intent('a', 'play', g.state()?.seq ?? 0))
    expect(g.state()?.mode).toBe('playing')
    loop.runFor(2000)
    g.onIntent('v1', intent('b', 'seek', g.state()?.seq ?? 0, 300))
    expect(g.state()).toMatchObject({ mode: 'waiting', wait: { reason: 'seek', resumeAs: 'playing' } })
    expect(g.state()?.wait?.waitingFor).toEqual(['host', 'v1', 'v2'])
    ready('host', 'v1')
    // Bob closed his player: he no longer holds the room up.
    status('v2', { phase: 'no-player' })
    expect(g.state()).toMatchObject({ mode: 'playing', anchor: { pos: 300 } })
    const st = g.state()
    expect((st?.anchor.hostTime ?? 0) - (st?.sentAt ?? 0)).toBe(GROUP.LEAD_MIN_MS)
  })

  it('superseded: a seek based on an older seq within 500 ms of another user’s seek loses', () => {
    const { loop, g } = setup()
    g.mediaReady(600)
    const seq = g.state()?.seq ?? 0
    expect(g.onIntent('v1', intent('a', 'seek', seq, 100))).toEqual({ accepted: true })
    loop.runFor(50)
    expect(g.onIntent('v2', intent('b', 'seek', seq, 200))).toEqual({ accepted: false, reason: 'superseded' })
    // The same user may refine their own seek, and an informed seek is fine.
    expect(g.onIntent('v1', intent('c', 'seek', seq, 110))).toEqual({ accepted: true })
    expect(g.onIntent('v2', intent('d', 'seek', g.state()?.seq ?? 0, 200))).toEqual({ accepted: true })
    loop.runFor(600)
    expect(g.onIntent('v1', intent('e', 'seek', seq, 50))).toEqual({ accepted: true })
  })

  it('dedupes intents in an LRU of 256', () => {
    const { g } = setup()
    g.mediaReady(600)
    expect(g.onIntent('v1', intent('first', 'seek', g.state()?.seq ?? 0, 10))).toEqual({ accepted: true })
    const seq = g.state()?.seq
    expect(g.onIntent('v1', intent('first', 'seek', 0, 10))).toEqual({ accepted: true })
    expect(g.state()?.seq).toBe(seq)
    for (let i = 0; i < GROUP.INTENT_LRU; i++) g.onIntent('host', intent(`x${String(i)}`, 'pause', 0))
    // Evicted, so it is decided afresh: a cached answer would have been accepted.
    expect(g.onIntent('v1', intent('first', 'seek', 99_999, 10))).toEqual({ accepted: false, reason: 'stale' })
  })

  it('a pause during a barrier sets resumeAs = paused', () => {
    const { g, ready } = setup()
    g.addMember('v1', 'Ann')
    g.mediaReady(600)
    ready('host', 'v1')
    g.onIntent('host', intent('a', 'play', g.state()?.seq ?? 0))
    g.onIntent('host', intent('b', 'seek', g.state()?.seq ?? 0, 100))
    g.onIntent('v1', intent('c', 'pause', g.state()?.seq ?? 0))
    expect(g.state()?.wait?.resumeAs).toBe('paused')
    ready('host', 'v1')
    expect(g.state()).toMatchObject({ mode: 'paused', anchor: { pos: 100 } })
  })

  it('soft timeout starts without stragglers when waitForAll is off; the 3rd wait exempts them', () => {
    const { loop, g, ready, status, notices } = setup({ waitForAll: false })
    g.addMember('v1', 'Sam')
    g.mediaReady(600)
    ready('host', 'v1')
    g.onIntent('host', intent('p', 'play', g.state()?.seq ?? 0))
    for (let i = 0; i < 3; i++) {
      g.onIntent('host', intent(`s${String(i)}`, 'seek', g.state()?.seq ?? 0, 100 * (i + 1)))
      ready('host')
      // Sam is still seeking, so he stays in waitingFor.
      status('v1', { phase: 'seeking' })
      loop.runFor(GROUP.SOFT_MS - 300)
      expect(g.state()?.mode).toBe('waiting')
      loop.runFor(600)
      expect(g.state()?.mode).toBe('playing')
      // The third time Sam becomes exempt instead, so the barrier simply completes.
      expect(g.state()?.cause?.kind).toBe(i < 2 ? 'timeout' : 'seek')
    }
    expect(notices).toEqual([expect.objectContaining({ kind: 'exempt', peerId: 'v1', name: 'Sam' })])
    g.onIntent('host', intent('s9', 'seek', g.state()?.seq ?? 0, 500))
    ready('host')
    expect(g.state()?.mode).toBe('playing')
    loop.runFor(GROUP.EXEMPT_MS + 1000)
    expect(g.memberViews().find((m) => m.id === 'v1')?.exempt).toBe(false)
  })

  it('hard timeout at 30 s with waitForAll on, and silent members drop out after 10 s', () => {
    const { loop, g, ready, status } = setup()
    g.addMember('v1', 'Ann')
    g.addMember('v2', 'Bob')
    g.mediaReady(600)
    ready('host', 'v1', 'v2')
    g.onIntent('host', intent('p', 'play', g.state()?.seq ?? 0))
    g.onIntent('host', intent('s', 'seek', g.state()?.seq ?? 0, 100))
    ready('host')
    // Ann keeps talking (from the wrong place); Bob goes silent.
    for (let t = 0; t < 29; t++) {
      status('v1', { phase: 'seeking', pos: 0 })
      loop.runFor(1000)
      if (t === 12) expect(g.state()?.wait?.waitingFor).toEqual(['v1'])
    }
    expect(g.state()?.mode).toBe('waiting')
    loop.runFor(1200)
    expect(g.state()).toMatchObject({ mode: 'playing', cause: { kind: 'timeout' } })
  })

  it('ends on the host’s EOF or when the anchor reaches the duration', () => {
    const a = setup()
    a.g.mediaReady(10)
    a.ready('host')
    a.g.onIntent('host', intent('p', 'play', a.g.state()?.seq ?? 0))
    a.loop.runFor(11_000)
    expect(a.g.state()).toMatchObject({ mode: 'ended', anchor: { pos: 10 }, cause: { kind: 'ended' } })
    // Play again: seek to 0 through a barrier.
    a.g.onIntent('host', intent('again', 'play', a.g.state()?.seq ?? 0))
    expect(a.g.state()).toMatchObject({ mode: 'waiting', anchor: { pos: 0 } })

    const b = setup()
    b.g.mediaReady(600)
    b.ready('host')
    b.g.onIntent('host', intent('p', 'play', b.g.state()?.seq ?? 0))
    b.status('host', { phase: 'ended' })
    expect(b.g.state()?.mode).toBe('ended')
  })

  it('a file that plays only once complete: the first play waits for members who loaded it, not for downloads', () => {
    for (const fullDownload of [false, true]) {
      const { g, ready, status } = setup()
      g.addMember('v1', 'Ann')
      g.addMember('v2', 'Sam')
      g.addMember('v3', 'Bob')
      g.mediaReady(600, { fullDownload })
      ready('host')
      status('v1', { phase: 'seeking' })
      // Sam is still downloading (no source: joining), Bob is opening the file he just completed
      status('v2', { phase: 'joining' })
      status('v3', { phase: 'loading' })
      g.onIntent('host', intent('p', 'play', g.state()?.seq ?? 0))
      expect(g.state()).toMatchObject({ mode: 'waiting', wait: { reason: 'start' } })
      // a streamable file waits for everyone at the first play; this one cannot wait for whole downloads
      expect(g.state()?.wait?.waitingFor).toEqual(fullDownload ? ['v1'] : ['v1', 'v2', 'v3'])
      ready('v1')
      expect(g.state()?.mode).toBe(fullDownload ? 'playing' : 'waiting')
    }
  })

  it('a file that plays only once complete: play-through still waits for whole downloads, with their ETA', () => {
    for (const fullDownload of [false, true]) {
      const { g, ready, status } = setup({ startMode: { kind: 'play-through' } })
      g.addMember('v1', 'Sam')
      g.mediaReady(600, { fullDownload })
      ready('host')
      // 2 min left to download 10 min of video: a stream could start now (0.9 x 600 s), this file cannot
      status('v1', { phase: 'joining', etaS: 120, rateBps: 5e6, needBps: 1e6 })
      g.onIntent('host', intent('p', 'play', g.state()?.seq ?? 0))
      expect(g.state()).toMatchObject({ mode: 'waiting', wait: { reason: 'start', waitingFor: ['v1'] } })
      expect(g.state()?.wait?.etaS).toBe(fullDownload ? 120 : null)
    }
  })

  it('resume: same syncEpoch, first publish seq + 1, paused at the saved anchor', () => {
    const { g, published } = setup({
      resume: {
        syncEpoch: 4242,
        seq: 17,
        lastAnchor: { posS: 321.5, mode: 'playing' },
        started: true,
        perms: { othersPlayPause: false, othersSeek: true },
        waitForAll: false,
        startMode: { kind: 'play-through' },
      },
    })
    g.mediaReady(600)
    expect(published[0]).toMatchObject({
      syncEpoch: 4242,
      seq: 18,
      mode: 'paused',
      anchor: { pos: 321.5 },
      perms: { othersPlayPause: false, othersSeek: true },
      waitForAll: false,
      startMode: { kind: 'play-through' },
      cause: { kind: 'restore' },
    })
    expect(g.snapshot()).toMatchObject({ syncEpoch: 4242, seq: 18, lastAnchor: { posS: 321.5, mode: 'paused' } })
  })
})
