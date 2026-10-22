import { open } from 'node:fs/promises'
import { basename } from 'node:path'
import { describe, expect, it } from 'vitest'
import { indexMediaFile } from '../../../src/core/media/build-index.js'
import { MPV_STREAM_OPTS } from '../../../src/core/media/mpv-stream-opts.js'
import { StreamServer } from '../../../src/core/media/stream-server.js'
import { FakeSource } from '../../../src/core/media/testing/fake-source.js'
import { buildManifest } from '../../../src/shared/media/manifest.js'
import { MediaMap, STREAM_SKIP_BYTES } from '../../../src/shared/media/media-map.js'
import { mergeRanges } from '../../../src/shared/media/ranges.js'
import type { ByteRange, Manifest, MediaIndex } from '../../../src/shared/media/types.js'
import { spawnMpv } from '../player/helpers.js'
import { FIXTURES, type FixtureName, type FixtureSet, HAVE_FFMPEG, HAVE_MPV, LONG, SHORT, fixture } from './fixtures.js'
import { topBoxes } from './s4-rules.js'

// S4's gating, on our own index (ADR 0004 §5): only open-critical ∪ seek-critical ∪ readyRange(p, 6 s)
// is served, in 16 KiB pieces so the ranges are tested nearly exactly; any other byte blocks forever.
// mpv must still reach playback-restart when it loads the file at p, which is both a late join and the
// reload that replaces a seek while a read is blocked.
//
// On the 30 s, 600 kbit/s fixtures the open-critical head holds about 13 s of media, and a start at most
// STREAM_SKIP_BYTES past it is read on to from the head: there readyRange starts at the head's end, and
// the cases check hi and the read-on rule (13.5 s). readyRange's lo from the keyframe rule, which S4
// amended for MP4 and fMP4 (250 ms preroll, 64 KiB slack, the previous fragment), is checked 40 s and
// 45.5 s into 60 s at 2 Mbit/s, ~10 MB in, for every layout with a seek index. fmp4-dash-global's sidx boxes
// behind its first fragment are in none of these ranges (ADR 0004 §8.2).

const PIECE = 16 * 1024
const AHEAD_MS = 6000
const RESTART_TIMEOUT_MS = 20_000
/** Layouts with a seek index; the others are linear, where readyRange starts at 0. */
const INDEX_MODE: FixtureName[] = [
  'mkv-cues.mkv',
  'mkv-tail.mkv',
  'mp4-faststart.mp4',
  'mp4-tailmoov.mp4',
  'fmp4-sidx.mp4',
  'fmp4-dash-global.mp4',
  'avi.avi',
]

interface Prepared {
  path: string
  index: MediaIndex
  manifest: Manifest
  map: MediaMap
}

const prepared = new Map<string, Promise<Prepared>>()
function prepare(name: FixtureName, set: FixtureSet): Promise<Prepared> {
  const key = `${set.dir}/${name}`
  let p = prepared.get(key)
  if (!p) {
    p = (async () => {
      const path = await fixture(name, set)
      const index = await indexMediaFile(path)
      const manifest = buildManifest(index, { infoHash: new Uint8Array(20), pieceLength: PIECE })
      return { path, index, manifest, map: new MediaMap(manifest) }
    })()
    prepared.set(key, p)
  }
  return p
}

interface GatedRun {
  restarted: boolean
  /** time-pos at playback-restart */
  pos: number | null
  /** first byte of each withheld piece a read waited on */
  waitedOn: number[]
  readersOpen: number
}

/**
 * mpv loads the file at posS through a StreamServer that has only the pieces of `allowed`. Ends at
 * playback-restart, after RESTART_TIMEOUT_MS, or once `stuck(waitedOn)` holds (and still no restart 1 s later).
 */
async function gatedLoad(
  f: Prepared,
  allowed: readonly ByteRange[],
  posS: number,
  stuck: (waitedOn: number[]) => boolean = () => false,
): Promise<GatedRun> {
  const size = f.index.fileSize
  const fh = await open(f.path, 'r')
  const source = new FakeSource(
    [{ index: 0, name: basename(f.path), offset: 0, length: size }],
    PIECE,
    async (abs, len) => {
      const buf = new Uint8Array(len)
      const { bytesRead } = await fh.read(buf, 0, len, abs)
      return buf.subarray(0, bytesRead)
    },
  )
  for (const r of mergeRanges(allowed, size)) {
    const span = f.map.piecesOf(r)
    if (span) for (let i = span[0]; i <= span[1]; i++) source.release(i)
  }
  const waitedOn = (): number[] => [...new Set(source.blocked)].filter((i) => !source.has(i)).map((i) => i * PIECE)
  const server = await StreamServer.listen(source)
  const mpv = spawnMpv([...MPV_STREAM_OPTS, '--hr-seek=yes'])
  let run: Omit<GatedRun, 'readersOpen'>
  try {
    const restarted = await new Promise<boolean>((resolve) => {
      let stuckSince: number | null = null
      const poll = setInterval(() => {
        if (!stuck(waitedOn())) stuckSince = null
        else if (stuckSince === null) stuckSince = Date.now()
        else if (Date.now() - stuckSince >= 1000) done(false)
      }, 100)
      const timer = setTimeout(() => done(false), RESTART_TIMEOUT_MS)
      const done = (ok: boolean): void => {
        clearInterval(poll)
        clearTimeout(timer)
        resolve(ok)
      }
      mpv.ipc.on('event', (e) => {
        if (e.event === 'playback-restart') done(true)
      })
      mpv.ipc
        .command(['loadfile', server.url(0), 'replace', -1, `start=${String(posS)},pause=yes`], { async: true })
        .catch(() => done(false))
    })
    const pos = restarted ? (await mpv.ipc.getProperty<number>('time-pos')).value : null
    run = { restarted, pos, waitedOn: waitedOn() }
  } finally {
    await mpv.stop()
    await server.close()
    await fh.close()
  }
  return { ...run, readersOpen: source.readersOpen }
}

/** open-critical ∪ seek-critical ∪ readyRange(p, 6 s): what a viewer has before it starts at p. */
function startSet(f: Prepared, posS: number): ByteRange[] {
  return [...f.manifest.openCritical, ...f.manifest.seekCritical, ...f.map.readyRange(posS * 1000, AHEAD_MS)]
}

async function expectStart(f: Prepared, posS: number): Promise<void> {
  const run = await gatedLoad(f, startSet(f, posS), posS)
  expect(run.restarted, `no playback-restart; mpv waited on bytes ${run.waitedOn.join(', ')}`).toBe(true)
  expect(Math.abs((run.pos ?? -1) - posS)).toBeLessThan(0.1)
  expect(run.readersOpen).toBe(0)
}

describe.skipIf(!HAVE_FFMPEG || !HAVE_MPV)('mpv starts from the critical and ready ranges alone', () => {
  for (const name of FIXTURES) {
    // 10 s is a keyframe (lavf then reads the previous GOP); 13.5 s lies inside a GOP and, for AVI, within
    // the read-on distance of the head (mpv reads on from movi)
    for (const posS of [0, 10, 13.5]) {
      it(`${name} at ${String(posS)} s`, async () => {
        await expectStart(await prepare(name, SHORT), posS)
      })
    }
  }

  for (const name of INDEX_MODE) {
    // 40 s is a keyframe, 45.5 s lies inside a GOP
    for (const posS of [40, 45.5]) {
      it(`${name} at ${String(posS)} s of 60 s at 2 Mbit/s: lo from the keyframe rule`, async () => {
        const f = await prepare(name, LONG)
        expect(f.index.seekMode).toBe('index')
        // the case must not degrade into releasing [0, hi), where mpv reads on from the head
        const lo = f.map.readyRange(posS * 1000, AHEAD_MS)[0]?.[0]
        expect(lo).toBeGreaterThan((f.map.headEnd ?? 0) + STREAM_SKIP_BYTES)
        await expectStart(f, posS)
      })
    }
  }

  it('fmp4-dash: the open walks every fragment, reading on through each mdat, so it needs the whole file', async () => {
    const f = await prepare('fmp4-dash.mp4', SHORT)
    expect(f.manifest.openCritical).toEqual([[0, f.index.fileSize]])
    const boxes = topBoxes(f.path)
    const first = boxes.findIndex((b) => b.type === 'mdat')
    const later = boxes.slice(first + 1).filter((b) => b.type === 'mdat')
    const inLater = (byte: number): boolean => later.some((b) => byte >= b.pos + 16 && byte < b.end)
    // every box but the later mdat bodies: more than the sidx boxes, the first fragment and the tail
    const allowed: ByteRange[] = [
      [0, boxes[first]?.end ?? 0],
      ...boxes.filter((b) => b.type !== 'mdat').map((b): ByteRange => [b.pos, b.end]),
      ...later.map((b): ByteRange => [b.pos, b.pos + 16]),
    ]
    const run = await gatedLoad(f, allowed, 0, (waited) => waited.some(inLater))
    // FFmpeg reads on through each ~80 KB mdat body to the next sidx instead of seeking past it, and waits there
    expect(run.restarted).toBe(false)
    expect(run.waitedOn.filter(inLater)).not.toEqual([])
  })

  it('fails the plan’s lo (keyframe at or before p, no preroll or slack): mp4-faststart at 40 s', async () => {
    const f = await prepare('mp4-faststart.mp4', LONG)
    const posS = 40
    const [ready, ...rest] = f.map.readyRange(posS * 1000, AHEAD_MS)
    if (!ready) throw new Error('no readyRange')
    const planLo = Math.min(f.map.timeToByte(posS * 1000, 'keyframe'), f.map.timeToByte(posS * 1000))
    expect(planLo).toBeGreaterThan(ready[0])
    const gap = (b: number): boolean => b >= ready[0] && b < planLo
    const allowed: ByteRange[] = [...f.manifest.openCritical, ...f.manifest.seekCritical, [planLo, ready[1]], ...rest]
    const run = await gatedLoad(f, allowed, posS, (waited) => waited.some(gap))
    // lavf's backward seek lands on the GOP before 40 s and the audio stored in front of its keyframe: bytes
    // only S4's lo releases. mpv waits there for good, so a regression to this lo fails the cases above.
    expect(run.restarted).toBe(false)
    expect(run.waitedOn.filter(gap)).not.toEqual([])
  })
})
