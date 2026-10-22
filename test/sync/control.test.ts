import { describe, expect, it } from 'vitest'
import { SYNC_BUS_POLICIES } from '../../src/core/session/sync-ports.js'
import { HOST, SimRoom } from './sim/room.js'

// §9 sync simulator row 5 plus the permission, intent and enforcement paths of §4.5.

const flat = () => ({ latencyMs: 40, jitterMs: 0, loss: 0 })
const allowed = { othersPlayPause: true, othersSeek: true }

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

describe('control', () => {
  it('(5) two seeks 50 ms apart: one applied, one superseded', async () => {
    const room = new SimRoom({ seed: 5, perms: allowed, link: flat, viewers: [{ id: 'v1' }, { id: 'v2' }] })
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(5000)
    const a = room.intent('v1', { kind: 'seek', posS: 100 })
    room.run(50)
    const b = room.intent('v2', { kind: 'seek', posS: 200 })
    room.run(3000)
    await settle()
    expect(await a).toEqual({ accepted: true })
    expect(await b).toEqual({ accepted: false, reason: 'superseded' })
    expect(room.node('v2').notices.some((n) => n.code === 'sync.superseded')).toBe(true)
    for (const n of room.nodes.values()) {
      expect(n.mode).toBe('playing')
      expect(Math.abs(n.mpv.pos() - 100)).toBeLessThan(3)
    }
    // A later, informed seek is fine.
    const c = room.intent('v2', { kind: 'seek', posS: 300 })
    room.run(3000)
    await settle()
    expect(await c).toEqual({ accepted: true })
    expect(room.node('v1').engine.syncEvent()?.cause).toMatchObject({ by: 'v2', kind: 'seek', to: 300 })
    expect(room.node('v1').notices.some((n) => n.message === 'v2 skipped to 5:00')).toBe(true)
  })

  it('rejects viewer intents while control is off, offers Ask host, and the host gets a one-click request', async () => {
    const room = new SimRoom({ seed: 6, link: flat, viewers: [{ id: 'v1', name: 'Sam' }] })
    room.start()
    room.run(3000)
    const r = await room.intent('v1', { kind: 'play' })
    expect(r).toEqual({ accepted: false, reason: 'perm-playpause' })
    const notice = room.node('v1').notices.at(-1)
    expect(notice?.action).toEqual({ label: 'Ask host', request: 'sync.request', params: { kind: 'play' } })
    expect(await room.intent('v1', { kind: 'seek', posS: 10 })).toEqual({ accepted: false, reason: 'perm-seek' })
    room.node('v1').engine.request('seek', 75)
    room.run(200)
    expect(room.host.notices.at(-1)).toMatchObject({
      code: 'sync.request',
      message: 'Sam asks to skip to 1:15',
      action: { request: 'playback.intent', params: { kind: 'seek', posS: 75 } },
    })
    expect(room.host.mode).toBe('paused')
    // The host flips the switch; the viewer may now play, and everyone sees the change.
    room.host.engine.setPerms(allowed)
    room.run(200)
    expect(room.node('v1').engine.syncEvent()).toMatchObject({ canPlayPause: true, canSeek: true })
    expect(room.node('v1').notices.at(-1)?.message).toBe('The host let everyone pause and seek')
    const ok = room.intent('v1', { kind: 'toggle' })
    room.run(2000)
    await settle()
    expect(await ok).toEqual({ accepted: true })
    expect(room.host.mode).toBe('playing')
  })

  it('dedupes intents by intentId and answers stale or not-ready ones', () => {
    const room = new SimRoom({ seed: 7, link: flat, viewers: [{ id: 'v1' }] })
    const group = room.host.engine.group
    if (!group) throw new Error('no group')
    expect(group.onIntent('v1', { intentId: 'x', kind: 'play', basedOnSeq: 0 })).toEqual({
      accepted: false,
      reason: 'not-ready',
    })
    room.start()
    room.run(2000)
    group.setPerms(allowed)
    const seq = group.state()?.seq ?? 0
    expect(group.onIntent('v1', { intentId: 'a', kind: 'seek', pos: 50, basedOnSeq: seq })).toEqual({ accepted: true })
    const after = group.state()?.seq
    // A retransmitted intent is answered from the cache, not applied twice.
    expect(group.onIntent('v1', { intentId: 'a', kind: 'seek', pos: 50, basedOnSeq: seq })).toEqual({ accepted: true })
    expect(group.state()?.seq).toBe(after)
    expect(group.onIntent('v1', { intentId: 'b', kind: 'play', basedOnSeq: 9999 })).toEqual({
      accepted: false,
      reason: 'stale',
    })
  })

  it('toggle and seekRel become explicit intents from the room state', () => {
    const room = new SimRoom({ seed: 8, link: flat, viewers: [{ id: 'v1' }] })
    room.start()
    room.run(2000)
    void room.intent(HOST, { kind: 'toggle' })
    room.run(2000)
    expect(room.host.mode).toBe('playing')
    void room.intent(HOST, { kind: 'seekRel', deltaS: 60 })
    room.run(3000)
    expect(room.host.mpv.pos()).toBeGreaterThan(62)
    expect(room.host.mpv.pos()).toBeLessThan(66)
    void room.intent(HOST, { kind: 'toggle' })
    room.run(500)
    expect(room.host.mode).toBe('paused')
    expect(room.node('v1').mpv.isRunning).toBe(false)
  })

  it('a pause during a barrier resumes as paused', () => {
    const room = new SimRoom({
      seed: 9,
      link: flat,
      viewers: [{ id: 'v1', media: { complete: false, rateX: 4, firstByteMs: 3000, preloadS: 30 } }],
    })
    room.start()
    room.run(2000)
    void room.intent(HOST, { kind: 'play' })
    room.run(3000)
    void room.intent(HOST, { kind: 'seek', posS: 600 })
    room.run(500)
    expect(room.host.mode).toBe('waiting')
    void room.intent(HOST, { kind: 'pause' })
    room.run(200)
    expect(room.host.engine.group?.state()?.wait?.resumeAs).toBe('paused')
    room.run(6000)
    expect(room.host.mode).toBe('paused')
    expect(room.host.engine.group?.state()?.anchor.pos).toBe(600)
    for (const n of room.nodes.values()) expect(n.mpv.isRunning).toBe(false)
  })

  it('enforcement: an external pause on a viewer is undone and the viewer rejoins the room', () => {
    const room = new SimRoom({ seed: 10, link: flat, viewers: [{ id: 'v1' }] })
    room.start()
    room.run(2000)
    void room.intent(HOST, { kind: 'play' })
    room.run(5000)
    const v1 = room.node('v1')
    v1.mpv.externalPause()
    room.run(3000)
    expect(v1.mpv.isRunning).toBe(true)
    expect(Math.abs(v1.mpv.pos() - room.host.mpv.pos())).toBeLessThan(0.1)
    expect(room.host.mode).toBe('playing')
  })

  it('a late joiner rendezvous with the playing room', () => {
    const room = new SimRoom({
      seed: 11,
      link: flat,
      viewers: [{ id: 'v1' }, { id: 'late', media: { complete: false, rateX: 3, firstByteMs: 500, preloadS: 0 } }],
    })
    room.start(['late'])
    room.run(2000)
    void room.intent(HOST, { kind: 'play' })
    room.run(60_000)
    room.join('late')
    const late = room.node('late')
    room.run(1000)
    expect(late.engine.member.currentPhase).toMatch(/loading|seeking/)
    expect(room.runUntil(() => late.mpv.isRunning, 30_000)).toBe(true)
    room.run(3000)
    expect(Math.abs(late.mpv.pos() - room.host.mpv.pos())).toBeLessThan(0.1)
    // The late joiner never made the room wait.
    expect(room.host.applied.some((a) => a.t > 60_000 && a.state.mode === 'waiting')).toBe(false)
  })

  it('a member without a player is excluded from barriers, and rejoins when the player reopens', () => {
    const room = new SimRoom({ seed: 12, link: flat, viewers: [{ id: 'v1' }, { id: 'v2' }] })
    room.start()
    room.run(2000)
    void room.intent(HOST, { kind: 'play' })
    room.run(3000)
    const v2 = room.node('v2')
    v2.mpv.available = false
    v2.mpv.snapshot()
    ;(v2.mpv as unknown as { emitState(): void }).emitState()
    room.run(1500)
    expect(v2.engine.member.currentPhase).toBe('no-player')
    const t0 = room.t
    void room.intent(HOST, { kind: 'seek', posS: 300 })
    expect(room.runUntil(() => room.host.mpv.isRunning && room.host.mpv.pos() > 300, 5000)).toBe(true)
    expect(room.t - t0).toBeLessThan(2000)
    v2.mpv.available = true
    ;(v2.mpv as unknown as { emitState(): void }).emitState()
    expect(room.runUntil(() => v2.mpv.isRunning, 15_000)).toBe(true)
    room.run(3000)
    expect(Math.abs(v2.mpv.pos() - room.host.mpv.pos())).toBeLessThan(0.1)
  })

  // A held arrow key: mpv repeats it at 40/s after 200 ms (the OSC's arrows are repeatable), ~33 presses in a second.
  // sync.intent is rate-limited per member on every bus (5, then one per 250 ms): one intent per press lost most of
  // them, each of those timing out after 5 s, and the room stopped short of where the viewer let go.
  for (const path of ['seekRel', 'osc'] as const) {
    for (const latencyMs of [1, 40, 150]) {
      it(`a held arrow key (${path}, ${String(latencyMs)} ms one way) reaches the host as a few intents and lands where the viewer let go`, async () => {
        const room = new SimRoom({
          seed: 13,
          perms: allowed,
          link: () => ({ latencyMs, jitterMs: latencyMs / 4, loss: 0 }),
          viewers: [{ id: 'v1' }],
        })
        room.net.rates = Object.fromEntries(Object.entries(SYNC_BUS_POLICIES).map(([name, p]) => [name, p.rate]))
        room.net.recordDeliveries = true
        room.start()
        room.run(3000)
        void room.intent(HOST, { kind: 'play' })
        room.run(5000)
        const v1 = room.node('v1').engine
        const from = v1.roomPosition() ?? 0
        const outcomes: Promise<{ accepted: boolean; reason?: string }>[] = []
        // the renderer's seekRel resolves in the engine; the OSC's seek-rel in the session (resolveSeekRel), absolute
        const press = (): void => {
          outcomes.push(
            path === 'seekRel'
              ? v1.intent({ kind: 'seekRel', deltaS: 5 })
              : v1.intent({ kind: 'seek', posS: Math.max(0, (v1.seekBase() ?? 0) + 5) }),
          )
        }
        const t0 = room.t
        press()
        room.run(200)
        for (let i = 0; i < 32; i++) {
          press()
          room.run(25)
        }
        expect(room.t - t0).toBeLessThan(1100)
        room.run(8000)
        await settle()
        const results = await Promise.all(outcomes)
        expect(results.filter((r) => r.reason === 'timeout')).toEqual([])
        expect(results.every((r) => r.accepted)).toBe(true)
        expect(room.node('v1').notices.filter((n) => n.level === 'warn')).toEqual([])
        const intents = room.net.delivered.filter((d) => d.to === HOST && d.msg.t === 'sync.intent')
        expect(room.net.rateDropped).toEqual([])
        expect(intents.length).toBeGreaterThanOrEqual(2)
        expect(intents.length).toBeLessThanOrEqual(8)
        // every press counted: 33 × 5 s from where the room was
        const target = from + 33 * 5
        expect(room.host.engine.group?.state()?.cause).toMatchObject({ by: 'v1', kind: 'seek' })
        expect(room.host.engine.group?.state()?.cause?.to).toBeCloseTo(target, 6)
        expect(room.host.mode).toBe('playing')
        for (const n of room.nodes.values()) expect(Math.abs(n.mpv.pos() - room.host.mpv.pos())).toBeLessThan(0.1)
        expect(room.host.mpv.pos()).toBeGreaterThan(target)
        expect(room.host.mpv.pos()).toBeLessThan(target + 9)
      })
    }
  }

  it('a pause after queued seeks goes out after them, and play and pause are never merged', async () => {
    const room = new SimRoom({ seed: 14, perms: allowed, link: flat, viewers: [{ id: 'v1' }] })
    room.net.recordDeliveries = true
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    room.run(5000)
    const v1 = room.node('v1').engine
    const outcomes = [
      v1.intent({ kind: 'seek', posS: 100 }), // in flight
      v1.intent({ kind: 'seek', posS: 200 }), // replaced by the next
      v1.intent({ kind: 'seek', posS: 300 }),
      v1.intent({ kind: 'pause' }),
      v1.intent({ kind: 'seek', posS: 400 }), // after the pause: not merged across it
      v1.intent({ kind: 'play' }),
      v1.intent({ kind: 'pause' }),
    ]
    room.run(5000)
    await settle()
    expect(await Promise.all(outcomes)).toEqual(outcomes.map(() => ({ accepted: true })))
    const sent = room.net.delivered
      .filter((d) => d.to === HOST && d.msg.t === 'sync.intent')
      .map((d) =>
        d.msg.t === 'sync.intent' ? `${d.msg.kind}${d.msg.pos === undefined ? '' : ` ${String(d.msg.pos)}`}` : '',
      )
    expect(sent).toEqual(['seek 100', 'seek 300', 'pause', 'seek 400', 'play', 'pause'])
    expect(room.host.mode).toBe('paused')
    expect(room.host.engine.group?.state()?.anchor.pos).toBeGreaterThanOrEqual(400)
    expect(room.host.engine.group?.state()?.anchor.pos).toBeLessThan(401)
  })

  it('intents the host never answers time out 5 s after the press, queued ones too, and the queue moves on', async () => {
    const room = new SimRoom({ seed: 15, perms: allowed, link: flat, viewers: [{ id: 'v1' }] })
    room.start()
    room.run(3000)
    const v1 = room.node('v1').engine
    room.net.block(HOST, 'v1', 8000)
    const a = v1.intent({ kind: 'play' })
    room.run(1000)
    const b = v1.intent({ kind: 'seek', posS: 50 }) // queued behind the play
    room.run(4100)
    await settle()
    expect(await a).toEqual({ accepted: false, reason: 'timeout' })
    room.run(1000)
    await settle()
    expect(await b).toEqual({ accepted: false, reason: 'timeout' })
    room.run(3000)
    // the link is back: the next intent goes out at once
    const c = v1.intent({ kind: 'pause' })
    room.run(1000)
    await settle()
    expect(await c).toEqual({ accepted: true })
  })
})
