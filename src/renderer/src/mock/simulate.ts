import type { FakeCore } from './fake-core'

// Live mode for the browser mock: advances playback, grows the download and jitters peer stats so the
// Timeline and peer list can be watched moving. Returns a stop function.

export function simulate(fake: FakeCore): () => void {
  let tick = 0
  const timer = setInterval(() => {
    tick++
    const s = fake.state
    const pb = s.playback
    const phase = s.session?.phase
    if (phase !== 'in-room' || !pb) return
    if (!pb.paused) {
      const posS = Math.min(pb.posS + 0.25, pb.durationS ?? Infinity)
      fake.emit('playback', { ...pb, posS, at: performance.now() })
      if (s.timeline) {
        const buffered: [number, number][] = [[posS, Math.min(posS + 40, s.timeline.durationS)]]
        fake.emit('timeline', { ...s.timeline, buffered })
      }
      if (s.sync && pb.durationS !== null && posS >= pb.durationS) {
        fake.emit('playback', { ...pb, posS, paused: true, at: performance.now() })
        fake.emit('sync', { ...s.sync, mode: 'ended' })
      }
    }
    if (tick % 4 === 0 && s.timeline && s.session?.role === 'viewer') {
      const d = s.timeline.durationS
      const loading = s.timeline.loading.map(([a, b]): [number, number] => [a, Math.min(d, b + d * 0.002)])
      const done = [...s.timeline.done, ...loading.map(([a, b]): [number, number] => [a, Math.max(a, b - d * 0.01)])]
      fake.emit('timeline', { ...s.timeline, loading, done })
    }
    if (tick % 4 === 0 && s.peers) {
      fake.emit(
        'peers',
        s.peers.map((p) => ({
          ...p,
          rttMs: p.rttMs === null ? null : Math.max(1, Math.round(p.rttMs + (Math.random() - 0.5) * 6)),
          driftMs: p.driftMs === null ? null : Math.round(p.driftMs * 0.8 + (Math.random() - 0.5) * 20),
          havePct: Math.min(100, p.havePct + (p.role === 'viewer' ? 0.3 : 0)),
          posS: pb.posS + (p.driftMs ?? 0) / 1000,
        })),
      )
    }
  }, 250)
  return () => clearInterval(timer)
}
