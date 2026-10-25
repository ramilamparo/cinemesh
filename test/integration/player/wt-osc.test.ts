import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { themePayload } from '../../../src/shared/theme-tokens.js'
import { OSC_SCRIPT, assColor, wireTheme } from '../../../src/core/player/osc-bridge.js'
import {
  type Fixture,
  HAVE_FFMPEG,
  HAVE_MPV,
  OSC_SCRIPT_PATH,
  type RawMpv,
  makeFixture,
  oscErrors,
  sleep,
  spawnMpv,
  until,
  waitFor,
} from './helpers.js'

interface Intent {
  t: string
  pos?: number
  delta?: number
  seq: number
}

describe.skipIf(!HAVE_MPV || !HAVE_FFMPEG)('wt-osc.lua in mpv', () => {
  let fx: Fixture
  let mpv: RawMpv
  let logFile: string
  let client: string
  const intents: Intent[] = []
  const ready: unknown[] = []

  const toOsc = (kind: string, payload: unknown): Promise<unknown> =>
    mpv.ipc.command(['script-message-to', OSC_SCRIPT, kind, JSON.stringify(payload)])

  beforeAll(async () => {
    fx = await makeFixture()
    logFile = join(fx.dir, 'mpv.log')
    // test-dims gives the headless OSD a size so the drawing code runs; the bindings need no window
    mpv = spawnMpv([
      `--script=${OSC_SCRIPT_PATH}`,
      '--script-opts=wt_osc-test-dims=1280x720',
      '--input-default-bindings=no',
      '--input-builtin-bindings=no',
      '--keep-open=always',
      `--log-file=${logFile}`,
    ])
    mpv.ipc.on('client-message', (args) => {
      if (args[0] === 'wt-intent' && args[1]) intents.push(JSON.parse(args[1]) as Intent)
      if (args[0] === 'wt-ready') ready.push(args[1] && JSON.parse(args[1]))
    })
    client = await mpv.ipc.clientName()
    await mpv.ipc.command(['loadfile', fx.clip, 'replace', -1, 'start=3,pause=yes'], { async: true })
    await waitFor(mpv.ipc, 'event', (e: { event: string }) => e.event === 'playback-restart')
  })

  afterAll(async () => {
    await mpv.stop()
    await fx.cleanup()
  })

  it('answers init with wt-ready', async () => {
    const init = {
      v: 1,
      client,
      theme: wireTheme(themePayload('dark', 'dark')),
      perms: { isHost: false, canPlayPause: false, canSeek: false },
      strings: { ended: 'Fin' },
      watchdogS: 0,
      persistentStrip: true,
    }
    // the script registers its handlers at startup; retry like the bridge does
    await until(async () => {
      await toOsc('init', init).catch(() => undefined)
      return ready.length > 0
    })
    expect(ready[0]).toEqual({ v: 1 })
  })

  it('turns SPACE into a toggle intent without touching pause', async () => {
    intents.length = 0
    await mpv.ipc.command(['keypress', 'SPACE'])
    await until(() => intents.length === 1)
    expect(intents[0]).toMatchObject({ t: 'toggle' })
    await sleep(100)
    expect((await mpv.ipc.getProperty('pause')).value).toBe(true)
  })

  it('sends seek-rel for arrow keys and close for CLOSE_WIN', async () => {
    intents.length = 0
    for (const key of ['RIGHT', 'LEFT', 'UP', 'DOWN', 'CLOSE_WIN', 'r', 'p']) {
      await mpv.ipc.command(['keypress', key])
    }
    await until(() => intents.length === 7)
    expect(intents.map((i) => [i.t, i.delta])).toEqual([
      ['seek-rel', 5],
      ['seek-rel', -5],
      ['seek-rel', 60],
      ['seek-rel', -60],
      ['close', undefined],
      ['show-app', undefined],
      ['toggle', undefined],
    ])
    const seqs = intents.map((i) => i.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    expect((await mpv.ipc.getProperty('time-pos')).value).toBeCloseTo(3, 1)
    expect((await mpv.ipc.getProperty('pause')).value).toBe(true)
  })

  it('sends one seek intent when a timeline drag is released', async () => {
    intents.length = 0
    // the bar is 56 px tall at the bottom of 1280x720; the timeline sits 13 px below its top
    await mpv.ipc.command(['mouse', 640, 720 - 56 + 13])
    await sleep(50)
    await mpv.ipc.command(['keydown', 'MBTN_LEFT'])
    await mpv.ipc.command(['mouse', 960, 720 - 56 + 13])
    await sleep(50)
    await mpv.ipc.command(['keyup', 'MBTN_LEFT'])
    await until(() => intents.length === 1)
    expect(intents[0]?.t).toBe('seek')
    // x = 960 of a 14..1266 track over a 10 s file
    expect(intents[0]?.pos).toBeCloseTo(((960 - 14) / (1266 - 14)) * 10, 1)
    expect((await mpv.ipc.getProperty('time-pos')).value).toBeCloseTo(3, 1)
  })

  it('handles local keys: volume, mute, subtitle delay and visibility', async () => {
    // key handlers run on the script's thread, after keypress returned
    const prop = async (name: string): Promise<unknown> => (await mpv.ipc.getProperty(name)).value
    await mpv.ipc.command(['keypress', '0'])
    await until(async () => (await prop('volume')) === 102)
    await mpv.ipc.command(['keypress', 'm'])
    await until(async () => (await prop('mute')) === true)
    await mpv.ipc.command(['keypress', 'x'])
    await until(async () => Math.abs(Number(await prop('sub-delay')) - 0.1) < 1e-6)
    await mpv.ipc.command(['keypress', 'v'])
    await until(async () => (await prop('sub-visibility')) === false)
  })

  it('accepts every core message without Lua errors', async () => {
    const theme = wireTheme(themePayload('light', 'light'))
    await toOsc('theme', theme)
    await toOsc('perms', { isHost: true, canPlayPause: true, canSeek: true })
    await toOsc('ranges', {
      dur: 10,
      done: [
        [0, 2.5],
        [4, 6],
      ],
      loading: [[2.5, 3]],
      groupDone: [[0, 1]],
    })
    await toOsc('peers', [
      { id: 'a', name: 'Alice {\\b1}', color: assColor('#ff8a4c'), pos: 4.2, state: 'playing' },
      { id: 'b', name: 'Bob', color: 'bogus', pos: 99, state: 'buffering' },
    ])
    await toOsc('status', { text: 'Waiting for Bob…', level: 'warn' })
    await toOsc('toast', { text: 'Only the host can pause', ms: 500 })
    await toOsc('ended', { ended: true })
    await toOsc('resync', { shown: true })
    await toOsc('hb', {})
    // malformed input is ignored with a warning
    await toOsc('ranges', 'not json')
    await toOsc('peers', '[')
    // hover the timeline and the buttons so every drawing path runs
    for (const [x, y] of [
      [640, 720 - 56 + 13],
      [30, 720 - 20],
      [1250, 720 - 20],
      [100, 100],
    ] as const) {
      await mpv.ipc.command(['mouse', x, y])
      await sleep(60)
    }
    await toOsc('ended', { ended: false })
    await toOsc('resync', { shown: false })
    await toOsc('resync', 'not json')
    await toOsc('status', { text: '' })
    await mpv.ipc.command(['keypress', 'SPACE'])
    await sleep(200)
    expect(await oscErrors(logFile)).toEqual([])
  })

  it('draws the groupDone strip only when done shows other spans (the host bar already shows groupDone)', async () => {
    // only that strip uses 'ok': a colour nothing else draws finds it in the overlay (test-dims publishes it)
    const marker = '&H010203&'
    const theme = wireTheme(themePayload('dark', 'dark'))
    await toOsc('theme', { ...theme, colors: { ...theme.colors, ok: marker } })
    const strip = async (): Promise<boolean> => {
      const drawn = await mpv.ipc.getProperty<string>('user-data/wt_osc/overlay').then(
        (r) => r.value,
        () => '',
      )
      return drawn.includes(`\\1c${marker}`)
    }
    // the file is paused, so the bar stays up
    await toOsc('ranges', { dur: 10, done: [[0, 6]], loading: [], groupDone: [[0, 2]] })
    await until(strip)
    // the host's OSC gets done = groupDone (core/session/timeline.ts)
    const group = [
      [0, 2],
      [4, 6],
    ]
    await toOsc('ranges', { dur: 10, done: group, loading: [[2, 4]], groupDone: group })
    await until(async () => !(await strip()))
    await toOsc('ranges', { dur: 10, done: group, loading: [], groupDone: [[0, 2]] })
    await until(strip)
    expect(await oscErrors(logFile)).toEqual([])
  })

  it('a viewer behind the host: Shift+R and the bar button send resync; the host has neither', async () => {
    const drawn = async (): Promise<string> =>
      mpv.ipc.getProperty<string>('user-data/wt_osc/overlay').then(
        (r) => r.value,
        () => '',
      )
    intents.length = 0
    await toOsc('perms', { isHost: false, canPlayPause: false, canSeek: false })
    await mpv.ipc.command(['keypress', 'R'])
    await until(() => intents.length === 1)
    expect(intents[0]?.t).toBe('resync')

    // the file is paused, so the bar stays up
    await toOsc('resync', { shown: true })
    await until(async () => (await drawn()).includes('Resync to live'))
    // right of the time: fullscreen, volume, subs, audio, then this one (112 px) at the bar's 1280 x 720
    await mpv.ipc.command(['mouse', 990, 720 - 20])
    await sleep(50)
    await mpv.ipc.command(['keydown', 'MBTN_LEFT'])
    await mpv.ipc.command(['keyup', 'MBTN_LEFT'])
    await until(() => intents.length === 2)
    expect(intents[1]?.t).toBe('resync')
    await toOsc('resync', { shown: false })
    await until(async () => !(await drawn()).includes('Resync to live'))

    await toOsc('perms', { isHost: true, canPlayPause: true, canSeek: true })
    await toOsc('resync', { shown: true })
    await mpv.ipc.command(['keypress', 'R'])
    await sleep(300)
    expect(intents).toHaveLength(2)
    expect(await drawn()).not.toContain('Resync to live')
    expect((await mpv.ipc.getProperty('pause')).value).toBe(true)
    expect(await oscErrors(logFile)).toEqual([])
  })

  it("the host's > and < ask for a playlist's next and previous video; a viewer's do nothing", async () => {
    intents.length = 0
    await toOsc('perms', { isHost: false, canPlayPause: true, canSeek: true })
    await mpv.ipc.command(['keypress', '>'])
    await mpv.ipc.command(['keypress', '<'])
    await sleep(300)
    expect(intents).toHaveLength(0)
    await toOsc('perms', { isHost: true, canPlayPause: true, canSeek: true })
    await mpv.ipc.command(['keypress', '>'])
    await until(() => intents.length === 1)
    await mpv.ipc.command(['keypress', '<'])
    await until(() => intents.length === 2)
    expect(intents.map((i) => i.t)).toEqual(['next', 'prev'])
    expect(await oscErrors(logFile)).toEqual([])
  })
})
