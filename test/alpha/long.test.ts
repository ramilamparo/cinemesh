// M8 alpha, the long run (plan §8 M6: "real mpv holds p95 drift < 100 ms over 10 min"): a host and three viewers
// in their own processes play the 10 min fixture to its end. Each minute, each viewer's p95 |drift| against the
// host must stay under 100 ms. Opt-in on top of the alpha:
//   WT_ALPHA=1 WT_ALPHA_LONG=1 npx vitest run --project alpha test/alpha/long.test.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HAVE_FFMPEG, HAVE_MPV, fixture } from '../integration/media/fixtures.js'
import { driftVsHost, driftVsRoom, round, rssMiB, summary } from './analysis.js'
import {
  ALPHA_LONG,
  ALPHA_LONG_SET,
  type AlphaRoom,
  HOST_UPLOAD_KBPS,
  Results,
  closeRoom,
  hr,
  killAll,
  loadavg,
  openRoom,
  srcFingerprint,
} from './harness.js'

const MINUTES = 10
const KEEP = process.env.WT_ALPHA_KEEP === '1'
const say = (...a: unknown[]): void => console.log('[alpha-long]', ...a)

describe.skipIf(!ALPHA_LONG || !HAVE_FFMPEG || !HAVE_MPV)('M8 alpha, long run: 10 min of real mpv in sync', () => {
  let testnet: Testnet
  let video = ''
  let room: AlphaRoom | null = null
  let root = ''
  const results = new Results('alpha-long')
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wt-alpha-long-'))
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv', ALPHA_LONG_SET)
    results.set('env', { start: new Date().toISOString(), loadavg: loadavg(), src: srcFingerprint(), video })
    say('results ->', results.file)
  })
  afterAll(async () => {
    await closeRoom(room, { results, room: 'long' })
    await killAll()
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    results.set('end', { at: new Date().toISOString(), loadavg: loadavg(), src: srcFingerprint() })
    if (!KEEP && root) rmSync(root, { recursive: true, force: true })
  })

  it('every minute, every viewer: p95 |drift| < 100 ms', async () => {
    room = await openRoom({
      root,
      video,
      viewers: ['Ann', 'Bob', 'Cid'],
      hostSettings: { uploadLimitKBps: HOST_UPLOAD_KBPS },
    })
    const r = room
    const loads: { t: number; load: number[] }[] = []
    const sampler = setInterval(() => loads.push({ t: hr(), load: loadavg() }), 10_000)
    try {
      const play = await r.host.request('playback.intent', { kind: 'play' })
      expect(play.v.accepted).toBe(true)
      const started = await r.host.until('playback', (p) => !p.paused && p.posS > 0.5, 180_000, play.tReq)
      // to the end of the file: the room ends when the host's mpv reaches it
      await r.host.until('sync', (s) => s.mode === 'ended', (MINUTES + 3) * 60_000, play.tReq)
      for (const m of r.all) await m.flush()
      const t0 = started.at
      const opts = { settleMs: 2000, maxRttMs: 20, maxGapMs: 600, prop: 'audio-pts' as const }
      const minutes: {
        minute: number
        perViewer: Record<string, { n: number; p95: number; max: number }>
        load: number
      }[] = []
      for (let k = 0; k < MINUTES; k++) {
        const from = t0 + k * 60_000
        const to = from + 60_000
        const perViewer = Object.fromEntries(
          r.viewers.map((v) => {
            const d = driftVsHost(r.host.logs, v.logs, { ...opts, from, to })
            return [v.name, { n: d.abs.n, p95: d.abs.p95, max: d.abs.max }]
          }),
        )
        const inMinute = loads.filter((l) => l.t >= from && l.t < to).map((l) => l.load[0] ?? 0)
        minutes.push({ minute: k + 1, perViewer, load: round(Math.max(0, ...inMinute), 2) })
      }
      const overall = r.viewers.map((v) => ({
        name: v.name,
        ...driftVsHost(r.host.logs, v.logs, { ...opts, from: t0 }),
      }))
      const vsRoom = r.all.map((m) => ({ name: m.name, abs: driftVsRoom(m.logs, r.host.logs.anchor, opts).abs }))
      const stalls = Object.fromEntries(
        r.all.map((m) => [
          m.name,
          m.logs.prop.filter(([t, n, v]) => t >= t0 && n === 'paused-for-cache' && v === true).length,
        ]),
      )
      const out = {
        minutes,
        overall: overall.map((x) => ({ name: x.name, abs: x.abs, signed: x.signed, dropped: x.dropped })),
        vsRoom,
        stalls,
        // each member process (the core; mpv is its own process) over the 10 minutes
        rssMiB: Object.fromEntries(r.all.map((m) => [m.name, rssMiB(m.logs.mem, t0)])),
        load: summary(loads.map((l) => l.load[0] ?? 0)),
      }
      results.set('long', out)
      say('per minute', JSON.stringify(minutes))
      say(
        'overall',
        out.overall.map((x) => ({ name: x.name, abs: x.abs })),
      )
      for (const m of minutes) {
        for (const [name, d] of Object.entries(m.perViewer)) {
          expect(d.n, `${name}, minute ${String(m.minute)}: samples`).toBeGreaterThan(120)
          expect(d.p95, `${name}, minute ${String(m.minute)}: p95 |drift|`).toBeLessThan(100)
        }
      }
    } finally {
      clearInterval(sampler)
    }
  })
})
