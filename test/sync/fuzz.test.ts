import { describe, expect, it } from 'vitest'
import type { PlaybackIntent } from '../../src/shared/ipc/core.js'
import { type Rng, rng, uniform } from './sim/loop.js'
import { HOST, type SimNode, SimRoom, wanLink } from './sim/room.js'

// §9 sync simulator row 10: random intents, partitions, reconnects, backlogs and external changes. Whatever
// happens, (epoch, seq) never goes backwards on any node and the drift loop does not oscillate.

const MINUTES = 10
/** WT_FUZZ_SEEDS=500 for a longer hunt */
const SEEDS = Number(process.env.WT_FUZZ_SEEDS ?? 16)

const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T

function randomIntent(r: Rng, durationS: number): PlaybackIntent {
  const k = r()
  if (k < 0.25) return { kind: 'play' }
  if (k < 0.4) return { kind: 'pause' }
  if (k < 0.55) return { kind: 'toggle' }
  if (k < 0.75) return { kind: 'seekRel', deltaS: uniform(r, -30, 60) }
  return { kind: 'seek', posS: uniform(r, 0, durationS) }
}

/** Largest number of sign changes of (speed − 1) inside any 60 s window. */
function maxSignFlipsPerMinute(node: SimNode): number {
  const signs = node.mpv.speedCalls.filter((c) => c.speed !== 1).map((c) => ({ t: c.t, s: Math.sign(c.speed - 1) }))
  const flips: number[] = []
  for (let i = 1; i < signs.length; i++) {
    const a = signs[i - 1]
    const b = signs[i]
    if (a && b && a.s !== b.s) flips.push(b.t)
  }
  let worst = 0
  for (let i = 0, j = 0; j < flips.length; j++) {
    while ((flips[j] ?? 0) - (flips[i] ?? 0) >= 60_000) i++
    worst = Math.max(worst, j - i + 1)
  }
  return worst
}

function fuzz(seed: number): SimRoom {
  const r = rng(seed * 7919)
  const room = new SimRoom({
    seed,
    durationS: 1800,
    perms: { othersPlayPause: true, othersSeek: true },
    waitForAll: r() < 0.7,
    link: wanLink(0.02),
    viewers: [
      { id: 'v1', mpv: { audioSkewPpm: uniform(r, -100, 100) } },
      { id: 'v2', media: { complete: false, rateX: uniform(r, 1.2, 6), preloadS: 20 } },
      { id: 'v3', datagrams: r() < 0.5, mpv: { spdif: r() < 0.3 } },
    ],
  })
  room.start()
  room.run(3000)
  const ids = [HOST, 'v1', 'v2', 'v3']
  const down = new Set<string>()
  const end = room.t + MINUTES * 60_000
  while (room.t < end) {
    const k = r()
    const who = pick(r, ids)
    if (k < 0.55) {
      if (!down.has(who)) void room.intent(who, randomIntent(r, room.durationS))
    } else if (k < 0.62 && who !== HOST) {
      room.net.block(HOST, who, uniform(r, 1000, 15_000))
    } else if (k < 0.68 && who !== HOST && !down.has(who)) {
      down.add(who)
      room.net.disconnect(HOST, who)
      const back = uniform(r, 2000, 25_000)
      room.loop.after(back, () => {
        down.delete(who)
        room.net.connect(HOST, who)
      })
    } else if (k < 0.74 && who !== HOST) {
      room.net.backlog(HOST, who, uniform(r, 0.5, 4) * 1024 * 1024, 30e6)
    } else if (k < 0.8 && !down.has(who)) {
      room.node(who).mpv.externalPause()
    } else if (k < 0.83) {
      room.host.engine.setWaitForAll(r() < 0.5)
    } else if (k < 0.86) {
      room.host.engine.startAnyway()
    }
    room.run(uniform(r, 300, 12_000))
  }
  // Let the dust settle so a final reconnect is covered too.
  for (const id of ids) if (id !== HOST) room.net.connect(HOST, id)
  room.run(30_000)
  // a publish just before the end (e.g. the phases of a room that reached EOF) may still be on a slow link
  const latest = (): number | undefined => room.host.engine.group?.state()?.seq
  room.runUntil(() => room.viewers.every((v) => v.engine.member.state?.seq === latest()), 2000)
  return room
}

describe('fuzz', () => {
  it('(10) (epoch, seq) never goes backwards; speed changes sign < 6 times per minute', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const room = fuzz(seed)
      for (const n of room.nodes.values()) {
        const applied = n.applied.map((a) => a.state)
        expect(applied.length).toBeGreaterThan(5)
        for (let i = 1; i < applied.length; i++) {
          const a = applied[i - 1]
          const b = applied[i]
          if (!a || !b) continue
          expect(b.syncEpoch, `seed ${String(seed)} ${n.id}`).toBe(a.syncEpoch)
          // Equal only when the reliable copy of a state first applied from StateFast fills in the details.
          expect(b.seq, `seed ${String(seed)} ${n.id}`).toBeGreaterThanOrEqual(a.seq)
          if (b.seq === a.seq) expect(applied[i - 2]?.seq).not.toBe(a.seq)
        }
        expect(maxSignFlipsPerMinute(n), `seed ${String(seed)} ${n.id}`).toBeLessThan(6)
      }
      // Once the chaos stops everyone follows the latest state, at the host's position.
      const last = room.host.engine.group?.state()
      for (const v of room.viewers) {
        const tag = `seed ${String(seed)} ${v.id}`
        expect(v.engine.member.state?.seq, tag).toBe(last?.seq)
        expect(v.mpv.isRunning, tag).toBe(room.host.mpv.isRunning)
        expect(Math.abs(v.mpv.pos() - room.host.mpv.pos()) * 1000, tag).toBeLessThan(150)
      }
    }
  }, 120_000)
})
