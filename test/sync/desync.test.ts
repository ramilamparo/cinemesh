import { describe, expect, it } from 'vitest'
import type { DesyncInfo } from '../../src/core/sync/desync.js'
import { GROUP } from '../../src/core/sync/group.js'
import type { SyncBusMessage } from '../../src/core/sync/protocol.js'
import { HOST, type NodeSpec, type RoomOpts, SimNode, SimRoom, wanLink } from './sim/room.js'

// The viewer's "behind the host" warning (core/sync/desync.ts) and its Resync to live, across the simulated room:
// silent in normal play, shown for a viewer the room plays on without, and a Resync that moves nobody else.

const T = 1000

/** Every desync change of each node's member, with the true time. */
function recordDesync(room: SimRoom): Map<string, { t: number; d: DesyncInfo | null }[]> {
  const seen = new Map<string, { t: number; d: DesyncInfo | null }[]>()
  for (const n of room.nodes.values()) {
    const list: { t: number; d: DesyncInfo | null }[] = []
    seen.set(n.id, list)
    n.engine.member.on('desync', (d) => list.push({ t: room.t, d }))
  }
  return seen
}

const behind = (seen: Map<string, { d: DesyncInfo | null }[]>): string[] =>
  [...seen].flatMap(([id, list]) => (list.some((e) => e.d?.state === 'behind') ? [id] : []))

/**
 * The room as it plays: mode and anchor. A member's phase changes republish the state (seq + 1, members list) without
 * moving the room, so seq is no measure of that.
 */
function actuation(room: SimRoom): string {
  const st = room.host.engine.group?.state()
  return JSON.stringify([st?.mode, st?.anchor])
}

/** What the host's bus receives from members, by message type. */
function hostInbox(room: SimRoom): SyncBusMessage['t'][] {
  const got: SyncBusMessage['t'][] = []
  room.net.busPort(HOST).onMessage((_from, raw) => got.push((raw as SyncBusMessage).t))
  return got
}

function playingRoom(opts: Partial<RoomOpts> & { viewers: NodeSpec[] }): SimRoom {
  const room = new SimRoom({ seed: 1, ...opts })
  room.start()
  room.run(3000)
  void room.intent(HOST, { kind: 'play' })
  room.run(8000)
  expect(room.host.mode).toBe('playing')
  return room
}

const warned = (id: string): NodeSpec => ({ id, desyncWarnMs: T })
const downloading = (id: string, rateX = 4): NodeSpec => ({
  ...warned(id),
  media: { complete: false, rateX, firstByteMs: 300 },
})

describe('the desync warning across the room', () => {
  it('never fires in 10 min of normal play: WAN links, downloads, seeks and pauses', () => {
    const room = new SimRoom({
      seed: 91,
      link: wanLink(0.01),
      randomClocks: true,
      viewers: [downloading('v1'), downloading('v2', 2), warned('v3'), downloading('v4', 6)],
    })
    const seen = recordDesync(room)
    room.start()
    room.run(3000)
    void room.intent(HOST, { kind: 'play' })
    for (let minute = 1; minute <= 10; minute++) {
      room.run(30_000)
      if (minute % 3 === 0) {
        void room.intent(HOST, { kind: 'pause' })
        room.run(5000)
        void room.intent(HOST, { kind: 'play' })
        room.run(25_000)
      } else if (minute % 4 === 0) {
        // a quick run of seeks, as someone scrubbing
        for (const to of [1000, 1010, 1300]) {
          void room.intent(HOST, { kind: 'seek', posS: to + minute * 60 })
          room.run(400)
        }
        room.run(30_000 - 1200)
      } else {
        void room.intent(HOST, { kind: 'seek', posS: minute * 200 })
        room.run(30_000)
      }
    }
    expect(room.host.mode).toBe('playing')
    expect(behind(seen)).toEqual([])
  }, 60_000)

  it('stays silent for a member that cannot nudge (spdif): its loop only skips past 300 ms', () => {
    const room = playingRoom({ seed: 92, viewers: [{ ...warned('v1'), mpv: { spdif: true } }] })
    const seen = recordDesync(room)
    room.run(3 * 60_000)
    expect(seen.get('v1')).toEqual([])
  })

  it('shows for a viewer the room plays on without (waitForAll off), and the host sees it on its row', () => {
    const room = playingRoom({ seed: 93, waitForAll: false, viewers: [warned('v1'), warned('v2')] })
    const seen = recordDesync(room)
    let rows: { id: string; behindS: number | null }[] = []
    room.host.engine.on('peers', (p) => (rows = p))
    const t0 = room.t
    room.node('v1').mpv.stall(true)
    expect(room.runUntil(() => behind(seen).length > 0, 10_000)).toBe(true)
    // 1 s to reach the threshold, then 2 s of it
    expect(room.t - t0).toBeGreaterThanOrEqual(3000)
    expect(room.t - t0).toBeLessThan(3600)
    expect(behind(seen)).toEqual(['v1'])
    expect(room.node('v1').engine.syncEvent()?.desync).toEqual({
      state: 'behind',
      behindS: expect.any(Number) as unknown,
    })
    // its next status, then the host's next peers tick
    expect(room.runUntil(() => rows.some((r) => r.id === 'v1' && (r.behindS ?? 0) >= 3), 2500)).toBe(true)
    expect(rows.find((r) => r.id === 'v2')?.behindS).toBeNull()
  })

  it('Resync of a stalled viewer: meets the room, clears the warning, and moves nobody else', () => {
    // viewers may seek here: an intent would go out, and must not
    const perms = { othersPlayPause: true, othersSeek: true }
    const room = playingRoom({ seed: 94, waitForAll: false, perms, viewers: [warned('v1'), warned('v2')] })
    const seen = recordDesync(room)
    const inbox = hostInbox(room)
    const v1 = room.node('v1')
    v1.mpv.stall(true)
    expect(room.runUntil(() => v1.engine.member.desyncState?.state === 'behind', 5000)).toBe(true)
    const before = actuation(room)
    const v2Seeks = room.node('v2').mpv.seekCount
    expect(v1.engine.resync()).toBe('skip') // its data is all here
    expect(room.runUntil(() => v1.mpv.isRunning && Math.abs(v1.mpv.pos() - room.host.mpv.pos()) < 0.1, 3000)).toBe(true)
    room.run(2000)
    expect(v1.engine.member.desyncState).toBeNull()
    expect(seen.get('v1')?.at(-1)?.d).toBeNull()
    // local only: the room never moved, no intent or request went out, and neither did v2
    expect(actuation(room)).toBe(before)
    expect(inbox.filter((t) => t === 'sync.intent' || t === 'sync.request')).toEqual([])
    expect(room.node('v2').mpv.seekCount).toBe(v2Seeks)
  })

  it('Resync in the host’s buffering grace (waitForAll on): a rendezvous that never makes the room wait', () => {
    const room = playingRoom({ seed: 95, viewers: [warned('v1'), warned('v2')] })
    const inbox = hostInbox(room)
    const modes: string[] = []
    room.host.engine.on('state', (st) => modes.push(st.mode))
    const v1 = room.node('v1')
    const v2 = room.node('v2')
    const v2Pauses = v2.mpv.pauseCalls.length
    const v2Seeks = v2.mpv.seekCount
    const before = actuation(room)
    v1.mpv.stall(true)
    room.run(GROUP.BUFFER_GRACE_MS / 2)
    expect(v1.engine.member.currentPhase).toBe('buffering')
    // the data at the room's position is not here: it meets the room further ahead
    const buffered = v1.media.bufferedAheadS.bind(v1.media)
    v1.media.bufferedAheadS = () => 0
    expect(v1.engine.resync()).toBe('rendezvous')
    v1.media.bufferedAheadS = buffered
    room.run(15_000)
    expect(modes).not.toContain('waiting')
    expect(actuation(room)).toBe(before)
    expect(inbox.filter((t) => t === 'sync.intent' || t === 'sync.request')).toEqual([])
    expect(v2.mpv.pauseCalls.length).toBe(v2Pauses)
    expect(v2.mpv.seekCount).toBe(v2Seeks)
    expect(v1.mpv.isRunning).toBe(true)
    expect(Math.abs(v1.mpv.pos() - room.host.mpv.pos())).toBeLessThan(0.1)
  })

  it('is silent while the host is gone, through the 10 s grace and the hold', () => {
    const room = playingRoom({ seed: 96, waitForAll: false, viewers: [warned('v1')] })
    const seen = recordDesync(room)
    const v1 = room.node('v1')
    // the host quits with a bye, which gives the whole 10 s of grace (a crash is noticed by its silence, later)
    room.net.kill(HOST)
    v1.engine.member.hostLeft(0)
    v1.mpv.stall(true)
    room.run(30_000)
    expect(v1.notices.some((n) => n.code === 'sync.host-gone')).toBe(true)
    expect(seen.get('v1')).toEqual([])
  })

  it('the host never warns itself, whatever its setting', () => {
    const room = playingRoom({ seed: 97, waitForAll: false, host: { desyncWarnMs: T }, viewers: [warned('v1')] })
    const seen = recordDesync(room)
    room.host.mpv.stall(true)
    room.run(10_000)
    expect(seen.get(HOST)).toEqual([])
    expect(room.host.engine.syncEvent()).not.toHaveProperty('desync')
  })

  it('shows for a member the room stopped waiting for (exempt after 3 waits)', () => {
    const room = playingRoom({ seed: 98, viewers: [warned('v1'), warned('v2')] })
    const v1: SimNode = room.node('v1')
    for (let i = 0; i < 3; i++) {
      v1.mpv.stall(true)
      room.run(3000)
      v1.mpv.stall(false)
      room.run(10_000)
    }
    expect(room.host.engine.group?.memberViews().find((m) => m.id === 'v1')?.exempt).toBe(true)
    const seen = recordDesync(room)
    v1.mpv.stall(true)
    room.run(6000)
    expect(behind(seen)).toEqual(['v1'])
  })
})
