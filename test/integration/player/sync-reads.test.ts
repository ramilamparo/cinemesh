// What sync's member reads from mpv to know where a paused player is, through the production path
// (PlayerController and the session's PlayerPortAdapter), on the installed mpv:
// - settle() pauses mpv and reads audio-pts at once (setPaused, then sample, nothing awaited between) and keeps the
//   reply whatever the observed 'pause' says by then. mpv answers in order, so the reply is the paused position.
//   Over the app's fd://3 socketpair the 'pause' change usually comes in a later read than that reply (46 of 60 in
//   ADR 0008 §4.2), which the member used to need, dropping the position (this was test/alpha/settle-mpv.test.ts).
// - At a seek's playback-restart it reads time-pos, the frame mpv landed on and where playback starts (ADR 0007
//   Finding 4): the first frame at or after target − 5 ms. The observed time-pos still shows the target then.
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultSettings } from '../../../src/shared/settings.js'
import { themePayload } from '../../../src/shared/theme-tokens.js'
import type { PlayerStatus } from '../../../src/shared/ipc/core.js'
import { PlayerController } from '../../../src/core/player/player-controller.js'
import { PlayerPortAdapter } from '../../../src/core/session/sync-ports.js'
import type { PositionSample } from '../../../src/core/sync/ports.js'
import {
  type Fixture,
  HAVE_FFMPEG,
  HAVE_MPV,
  HEADLESS,
  MPV_VERSION,
  RESOURCES,
  makeFixture,
  sleep,
  waitFor,
} from './helpers.js'

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
const FPS = 25 // makeFixture's clip
const TRIALS = 20

describe.skipIf(!HAVE_MPV || !HAVE_FFMPEG)("sync's reads of a paused mpv, real mpv", () => {
  let fx: Fixture
  let player: PlayerController
  let port: PlayerPortAdapter

  beforeAll(async () => {
    if (!MPV_VERSION) throw new Error('no mpv')
    fx = await makeFixture({ durationS: 30 })
    player = new PlayerController({
      mpv: { path: 'mpv', kind: 'system', version: MPV_VERSION },
      role: 'host',
      resourcesDir: RESOURCES,
      logFile: join(fx.dir, 'mpv.log'),
      settings: defaultSettings(),
      theme: themePayload('dark', 'dark'),
      perms: { isHost: true, canPlayPause: true, canSeek: true },
      mediaTitle: 'clip.mkv',
      extraArgs: [...HEADLESS],
      log: silent,
    })
    const idle = waitFor(player, 'state', (s: PlayerStatus) => s === 'idle')
    player.start()
    await idle
    await player.load(fx.clip, { start: 1, paused: true })
    port = new PlayerPortAdapter(player, {
      subtitles: () => [],
      title: null,
      log: () => undefined,
    })
  }, 60_000)

  afterAll(async () => {
    await player.dispose()
    await fx.cleanup()
  })

  const sample = (): Promise<PositionSample | null> => new Promise((resolve) => port.sample(resolve))
  const audioPts = async (): Promise<number> => (await player.getProperty<number>('audio-pts')).value

  it('a sample sent right after the pause reads the paused position, whenever the pause is reported', async () => {
    let flagLate = 0
    const off: number[] = []
    for (let k = 0; k < TRIALS; k++) {
      port.setPaused(false)
      await sleep(250)
      // as settle() sends them
      port.setPaused(true)
      const s = await sample()
      if (!port.snapshot().paused) flagLate++
      await sleep(150)
      const later = await audioPts()
      off.push(Math.abs((s?.posS ?? NaN) - later) * 1000)
    }
    console.log(`[sync-reads] pause reported after the reply in ${String(flagLate)} of ${String(TRIALS)}`)
    expect(Math.max(...off)).toBeLessThan(0.5)
  }, 60_000)

  it("a time-pos read at a paused seek's playback-restart is the frame it landed on", async () => {
    const landedFrame = (t: number): number => Math.ceil((t - 0.005) * FPS - 1e-6) / FPS
    for (let k = 0; k < 10; k++) {
      // a few ms past a frame: the landing rule puts it on that frame or the next
      const target = 5 + k * 1.37 + (k % 2 === 0 ? 0.003 : 0.013)
      const read = new Promise<number | null>((resolve) => {
        player.once('playbackRestart', () => port.readTimePos(resolve))
      })
      port.seek(target)
      const at = await read
      expect(at).not.toBeNull()
      expect(at ?? NaN).toBeCloseTo(landedFrame(target), 4)
      await sleep(150)
      expect((await player.getProperty<number>('time-pos')).value).toBeCloseTo(at ?? NaN, 6)
    }
  }, 60_000)
})
