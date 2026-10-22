import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { indexMediaFile } from '../../../src/core/media/build-index.js'
import { needsFullDownload } from '../../../src/shared/media/media-map.js'
import { MKV_REMUX, remuxCommand, remuxFiles } from '../../../src/shared/media/remux.js'
import type { MediaIndex } from '../../../src/shared/media/types.js'
import { type FixtureName, type FixtureSet, HAVE_FFMPEG, LONG, POOR_LAG_S, SHORT, fixture } from './fixtures.js'

// Every remux src/shared/media suggests, run as the UI shows it with the installed FFmpeg on a file of the case it is
// for: the copy must index with a seek index and interleaved, keep the length and every video, audio and subtitle
// track (ADR 0004 §8.4).

const encoders = HAVE_FFMPEG ? execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }) : ''
const HAVE_WEBM_ENCODERS = /\slibvpx-vp9\s/.test(encoders) && /\slibopus\s/.test(encoders)

/** Runs `command` on `input` with its output in `dir`; returns the output's path. */
function run(command: string, input: string, dir: string): string {
  const files = remuxFiles(command)
  if (!files) throw new Error(`not a remux command: ${command}`)
  mkdirSync(dir, { recursive: true })
  const output = join(dir, files.output)
  const args = command
    .split(' ')
    .slice(1)
    .map((a) => (a === files.input ? input : a === files.output ? output : a))
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  return output
}

/** Tracks per type, other (timecode) tracks aside: MP4 writes its own from the timecode tag. */
const tracks = (index: MediaIndex): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const t of index.tracks) if (t.type !== 'other') out[t.type] = (out[t.type] ?? 0) + 1
  return out
}

describe.skipIf(!HAVE_FFMPEG)('remux commands on generated files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wt-remux-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const lag = `audio stored ${String(POOR_LAG_S)} s after its video`
  const cases: [FixtureName, FixtureSet, string][] = [
    ['mkv-nocues.mkv', SHORT, 'no Cues'],
    ['webm-nocues.webm', SHORT, 'no Cues'],
    ['mpegts.ts', SHORT, 'no index of any kind'],
    ['fmp4-nosidx.mp4', SHORT, 'an open that reads all of it'],
    ['fmp4-tracks.mp4', SHORT, 'the same, with two audio tracks, a subtitle and a timecode track'],
    ['mp4-poor.mp4', LONG, lag],
    ['mov-poor.mov', LONG, lag],
    ['mkv-poor.mkv', LONG, lag],
  ]
  for (const [name, set, what] of cases) {
    it.skipIf(name.endsWith('.webm') && !HAVE_WEBM_ENCODERS)(`${name} (${what})`, async () => {
      const input = await fixture(name, set)
      const before = await indexMediaFile(input)
      // the case the remux is for
      expect(before.seekMode === 'linear' || before.interleave === 'poor').toBe(true)
      const command = remuxCommand(before.container, before.seekMode, before.interleave)
      if (command === null) throw new Error(`no remux for ${before.container}`)
      const after = await indexMediaFile(run(command, input, join(dir, name)))
      expect({ seekMode: after.seekMode, interleave: after.interleave }).toEqual({
        seekMode: 'index',
        interleave: 'good',
      })
      expect(needsFullDownload(after)).toBe(false)
      expect(tracks(after)).toEqual(tracks(before))
      expect(Math.abs(after.durationMs - set.durationS * 1000)).toBeLessThan(300)
    })
  }

  // Why MKV_REMUX raises max_interleave_delta: the matroska demuxer reads in file order, and FFmpeg's default 10 s
  // lets the muxer write the video that far ahead of audio that lies further behind.
  it(`control: the Matroska copy with FFmpeg's default max_interleave_delta leaves ${lag} poor`, async () => {
    const plain = MKV_REMUX.replace(' -max_interleave_delta 60000000', '')
    expect(plain).not.toBe(MKV_REMUX)
    const after = await indexMediaFile(run(plain, await fixture('mkv-poor.mkv', LONG), join(dir, 'control')))
    expect(after.seekMode).toBe('index')
    expect(after.interleave).toBe('poor')
  })
})
