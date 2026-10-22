import { describe, expect, it } from 'vitest'
import { STREAM_SKIP_BYTES } from '../../shared/media/media-map.js'
import { MPV_STREAM_OPTS } from './mpv-stream-opts.js'

const UNITS: Record<string, number> = { '': 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }

describe('MPV_STREAM_OPTS', () => {
  it('keeps MediaMap read-on distance above mpv stream-buffer-size', () => {
    const opt = MPV_STREAM_OPTS.find((a) => a.startsWith('--stream-buffer-size='))
    const m = /^--stream-buffer-size=(\d+)(KiB|MiB|GiB)?$/.exec(opt ?? '')
    if (!m?.[1]) throw new Error(`unexpected ${String(opt)}`)
    const bytes = Number(m[1]) * (UNITS[m[2] ?? ''] ?? NaN)
    // mpv reads on through a forward seek up to this size; the rest of the margin is FFmpeg's TCP window
    expect(bytes).toBeLessThanOrEqual(STREAM_SKIP_BYTES / 2)
  })
})
