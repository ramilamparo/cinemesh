import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PlayerController } from '../../../src/core/player/player-controller.js'
import type { PlayerHolder } from '../../../src/core/session/player-holder.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import { HAVE_FFMPEG, HAVE_MPV, LONG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Sessions with the installed mpv (headless): when a member's mpv dies in a playing room, the player leaves the
// reload to sync's member (selfReload: false), so exactly one loadfile brings it back, at the member's own
// rendezvous just ahead of the room, and it is in step with the room within 3 s of that load's playback-restart.

interface Internals {
  current: {
    playerHolder(): PlayerHolder | null
    syncEngine(): SyncEngine | null
  } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function eventually(check: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`${what}: not in ${String(ms)} ms`)
    await sleep(25)
  }
}

describe.skipIf(!HAVE_FFMPEG || !HAVE_MPV)('session with a real mpv: a crashed mpv rejoins the playing room', () => {
  let testnet: Testnet
  let video: string
  const root = mkdtempSync(join(tmpdir(), 'wt-player-real-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv', LONG) // 60 s: the room plays well past the restart
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  for (const who of ['viewer', 'host'] as const) {
    it(`kill -9 of the ${who}'s mpv: one loadfile, and in step within 3 s of its playback-restart`, async () => {
      // every loadfile any controller sends, with the controller that sent it
      const loads: { player: unknown; at: number }[] = []
      const proto = PlayerController.prototype as unknown as { sendLoadfile: (...a: unknown[]) => Promise<unknown> }
      const send = proto.sendLoadfile
      vi.spyOn(proto, 'sendLoadfile').mockImplementation(function (this: unknown, ...a: unknown[]) {
        loads.push({ player: this, at: Date.now() })
        return send.apply(this, a)
      })

      const host = member('Host', root, { realMpv: true })
      const viewer = member('Sam', root, { realMpv: true })
      const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
      await viewer.client.request('session.join', { invite })
      await viewer.client.until('session', (s) => s.phase === 'confirm-join', 60_000)
      await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
      await viewer.client.until('session', (s) => s.phase === 'in-room', 60_000)
      // the whole file on the viewer first: this is about the reload, not the download
      await viewer.client.until('transfer', (t) => t.progress >= 1, 60_000)
      for (const m of [host, viewer]) await m.client.until('player', (p) => p.status === 'ready', 30_000)
      expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
      for (const m of [host, viewer]) await m.client.until('playback', (p) => !p.paused && p.posS > 1, 30_000)
      await sleep(2000)

      const target = who === 'viewer' ? viewer : host
      const holder = internals(target).current?.playerHolder()
      const engine = internals(target).current?.syncEngine()
      if (!holder || !engine) throw new Error('no player')
      const pid = holder.pid
      if (pid === null) throw new Error('no mpv pid')
      // the same controller spawns the new mpv: its first playback-restart from now on is the reload's
      const killedAt = Date.now()
      const restart = { at: null as number | null }
      holder.on('playbackRestart', () => (restart.at ??= Date.now()))
      process.kill(pid, 'SIGKILL')

      // the controller restarts mpv after 1 s; the member loads once it is up
      await eventually(() => restart.at !== null, 20_000, 'playback-restart after the restart')
      const back = restart.at ?? NaN
      const reloads = loads.filter((l) => l.at > killedAt && l.player === holder.player)
      expect(reloads).toHaveLength(1)
      await sleep(Math.max(0, back + 3000 - Date.now()))
      const timePos = holder.prop('time-pos')
      const roomPos = engine.roomPosition()
      expect(typeof timePos).toBe('number')
      expect(holder.prop('pause')).toBe(false)
      expect(Math.abs((timePos as number) - (roomPos ?? NaN))).toBeLessThan(0.5)
      // still the only load: nothing reloaded it behind the member's back
      expect(loads.filter((l) => l.at > killedAt && l.player === holder.player)).toHaveLength(1)

      await viewer.manager.shutdown()
      await host.manager.shutdown()
    }, 180_000)
  }
})
