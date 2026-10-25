import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PlayerStatus } from '../../../src/shared/ipc/core.js'
import { defaultSettings } from '../../../src/shared/settings.js'
import { themePayload } from '../../../src/shared/theme-tokens.js'
import { buildMediaIndex } from '../../../src/core/media/build-index.js'
import { PlayerController } from '../../../src/core/player/player-controller.js'
import { captureChoice, planCarry } from '../../../src/core/player/track-carry.js'
import { HAVE_FFMPEG, HAVE_MPV, HEADLESS, MPV_VERSION, RESOURCES, until, waitFor } from './helpers.js'

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

/**
 * Two "episodes" with titled tracks in different orders: the carried choice must land on the same-titled track,
 * not the same id (ADR 0011 §7).
 */
describe.skipIf(!HAVE_MPV || !HAVE_FFMPEG)('track carry-over with real mpv', () => {
  let dir = ''
  let ep1 = ''
  let ep2 = ''
  let srt2 = ''
  let player: PlayerController | null = null

  function episode(path: string, audio: [string, string][], subs: [string, string][]): void {
    const srt = join(dir, 'sub.srt')
    const inputs = ['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=25:duration=6']
    for (const [i] of audio.entries())
      inputs.push('-f', 'lavfi', '-i', `sine=frequency=${String(300 + i * 200)}:duration=6`)
    for (const _ of subs) inputs.push('-i', srt)
    const maps = ['-map', '0', ...audio.flatMap((_, i) => ['-map', String(i + 1)])]
    maps.push(...subs.flatMap((_, i) => ['-map', String(audio.length + 1 + i)]))
    const meta = [
      ...audio.flatMap(([title, lang], i) => [
        `-metadata:s:a:${String(i)}`,
        `title=${title}`,
        `-metadata:s:a:${String(i)}`,
        `language=${lang}`,
      ]),
      ...subs.flatMap(([title, lang], i) => [
        `-metadata:s:s:${String(i)}`,
        `title=${title}`,
        `-metadata:s:s:${String(i)}`,
        `language=${lang}`,
      ]),
    ]
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', ...inputs, ...maps,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-c:s', 'srt', ...meta, path,
    ], { timeout: 60_000 })
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-carry-'))
    await writeFile(join(dir, 'sub.srt'), '1\n00:00:01,000 --> 00:00:05,000\nHello\n')
    ep1 = join(dir, 'Show.E01.mkv')
    ep2 = join(dir, 'Show.E02.mkv')
    episode(
      ep1,
      [
        ['English', 'eng'],
        ['Japanese', 'jpn'],
      ],
      [
        ['Full', 'eng'],
        ['Signs', 'eng'],
      ],
    )
    episode(
      ep2,
      [
        ['Japanese', 'jpn'],
        ['Commentary', 'eng'],
        ['English', 'eng'],
      ],
      [
        ['Signs', 'eng'],
        ['Full', 'eng'],
      ],
    )
    srt2 = join(dir, 'Show.E02.es.srt')
    await writeFile(srt2, '1\n00:00:01,000 --> 00:00:05,000\nHola\n')
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  afterEach(async () => {
    await player?.dispose()
    player = null
  })

  async function create(): Promise<PlayerController> {
    if (!MPV_VERSION) throw new Error('no mpv')
    const p = new PlayerController({
      mpv: { path: 'mpv', kind: 'system', version: MPV_VERSION },
      role: 'host',
      resourcesDir: RESOURCES,
      logFile: join(dir, 'mpv.log'),
      settings: defaultSettings(),
      theme: themePayload('dark', 'dark'),
      perms: { isHost: true, canPlayPause: true, canSeek: true },
      mediaTitle: 'Show',
      extraArgs: [...HEADLESS],
      log: silent,
    })
    player = p
    const idle = waitFor(p, 'state', (s: PlayerStatus) => s === 'idle')
    p.start()
    await idle
    return p
  }

  async function next(p: PlayerController, path: string, subtitles: { url: string; title: string; lang: string }[]) {
    const { index } = await buildMediaIndex(path)
    const carry = planCarry(
      captureChoice(p.tracks()),
      index.tracks,
      subtitles.map((s) => ({ lang: s.lang, forced: false })),
    )
    await p.load(path, { start: 0, paused: true, subtitles, carry })
    return carry
  }

  it('starts the next file on the same-titled audio and subtitle tracks', async () => {
    const p = await create()
    await p.load(ep1, { start: 0, paused: true })
    await until(() => p.tracks().audio.length === 2 && p.tracks().sub.length === 2)
    await p.setTrack('audio', 2) // Japanese
    await p.setTrack('sub', 2) // Signs
    await until(() => p.tracks().aid === 2 && p.tracks().sid === 2)

    const carry = await next(p, ep2, [])
    expect(carry).toMatchObject({ aid: 1, sid: 1 })
    await until(() => p.tracks().audio.length === 3)
    await until(() => p.tracks().aid === 1 && p.tracks().sid === 1)
    const t = p.tracks()
    expect(t.audio.find((x) => x.id === t.aid)?.title).toBe('Japanese')
    expect(t.sub.find((x) => x.id === t.sid)?.title).toBe('Signs')
  })

  it('keeps subtitles off, and selects an external subtitle by language', async () => {
    const p = await create()
    await p.load(ep1, { start: 0, paused: true })
    await until(() => p.tracks().sub.length === 2)
    await p.setTrack('sub', 'no')
    await until(() => p.tracks().sid === 'no')
    await next(p, ep2, [])
    await until(() => p.tracks().audio.length === 3)
    // mpv's default would be a subtitle track; the carried choice keeps them off
    await new Promise((r) => setTimeout(r, 300))
    expect(p.tracks().sid).toBe('no')

    // an external Spanish subtitle chosen on one episode is picked by language on the next
    const srt1 = join(dir, 'Show.E01.es.srt')
    await writeFile(srt1, '1\n00:00:01,000 --> 00:00:05,000\nHola\n')
    await p.load(ep1, { start: 0, paused: true, subtitles: [{ url: srt1, title: 'Show.E01.es.srt', lang: 'es' }] })
    await until(() => p.tracks().sub.length === 3)
    const ext = p.tracks().sub.find((s) => s.external)
    if (!ext) throw new Error('no external subtitle')
    await p.setTrack('sub', ext.id)
    await until(() => p.tracks().sid === ext.id)
    const carry = await next(p, ep2, [{ url: srt2, title: 'Show.E02.es.srt', lang: 'es' }])
    expect(carry.externalSub).toBe(0)
    await until(() => {
      const t = p.tracks()
      return t.sub.find((s) => s.id === t.sid)?.title === 'Show.E02.es.srt'
    })
  })
})
