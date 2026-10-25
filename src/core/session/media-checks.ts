import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { KEYFRAME_MIN_GAP_MS, type ByteRange, type KeyPoint, type Manifest } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import { blobHash } from '../net/blobs.js'
import { MANIFEST_FILE } from '../transfer/engine.js'
import { SEGMENT_BYTES } from '../transfer/segment-store.js'

// What a viewer checks in what the host sent before it sizes anything from it, and the critical spans it asks
// for first. Shared by the viewer's items (viewer-slot.ts) and the host's (host-slot.ts).

/**
 * The manifest a previous session of this video kept in its transfer folder (plan §4.2 "Viewer storage"), when it is
 * the one announced: a regular file of that size and BLAKE2b hash, as Blobs.fetch would check it. Else null, and the
 * manifest is fetched.
 */
export async function cachedManifest(dir: string, want: { hash: string; size: number }): Promise<Uint8Array | null> {
  const path = join(dir, MANIFEST_FILE)
  const st = await lstat(path).catch(() => null)
  if (!st?.isFile() || st.size !== want.size) return null
  const data = await readFile(path).catch(() => null)
  return data && blobHash(data) === want.hash ? data : null
}

// session.host accepts at most 16 subtitle files
export const MAX_SUBS = 16
/** The scheduler re-selects every critical span on each replan; above this the narrowest gaps are bridged. */
export const MAX_CRITICAL_SPANS = 256
// What the host merely states, bounded before MediaMap or the scheduler is sized from it. An honest
// manifest has one audio index per audio track of a poorly interleaved MP4. Track lists are metadata the
// viewer does not use, and remuxes that keep every dub and subtitle come close to 64 tracks.
const MAX_AUDIO_INDEXES = 32
const MAX_TRACKS = 256
const MAX_KEY_POINTS = 500_000

/**
 * The announce, torrent and manifest arrive separately: they must describe the same video before any of
 * them sizes a buffer, a journal or a folder. Sizes are bounded by the torrent's own piece hashes (the
 * torrent blob is at most 64 MiB), never by a number the host merely states.
 */
export function crossCheck(
  a: { infoHash: string; fileSize: number },
  t: {
    infoHash: string
    pieceLength: number
    length: number
    pieces: readonly unknown[]
    files: readonly { length: number }[]
  },
  m: Manifest,
): void {
  const bad = (what: string): never => {
    throw new CodedError(
      'bad-session',
      `The host sent inconsistent video details (${what}). Ask the host to host it again.`,
    )
  }
  if (t.infoHash !== a.infoHash) bad('torrent')
  if (Buffer.from(m.infoHash).toString('hex') !== a.infoHash) bad('manifest')
  const p = t.pieceLength
  if (p !== m.pieceLength || p < 16 * 1024 || p > 4 * 1024 * 1024 || (p & (p - 1)) !== 0 || SEGMENT_BYTES % p !== 0) {
    bad('piece length')
  }
  if (t.files.length < 1 || t.files.length > 1 + MAX_SUBS) bad('file count')
  // one hash per piece of the whole length: MediaMap and the journal size themselves from these
  if (
    t.files.some((f) => !Number.isSafeInteger(f.length) || f.length < 0) ||
    !Number.isSafeInteger(t.length) ||
    t.pieces.length !== Math.ceil(t.length / p)
  ) {
    bad('pieces')
  }
  if (m.videoFileIndex !== 0 || t.files[0]?.length !== m.fileSize || m.fileSize !== a.fileSize) bad('file size')
  if (
    m.externalSubs.length > t.files.length - 1 ||
    m.externalSubs.some((s) => s.fileIndex < 1 || s.fileIndex >= t.files.length)
  ) {
    bad('subtitles')
  }
  // any number of them: an fMP4 lists one sidx per fragment; startDownload merges them into piece spans
  if ([...m.openCritical, ...m.seekCritical].some(([s, e]) => s < 0 || e < s || e > m.fileSize)) bad('ranges')
  // counts the host merely states: each audio index is an urgent range on every replan, and seek points
  // size MediaMap's arrays
  if (m.tracks.length > MAX_TRACKS) bad('tracks')
  const audio = m.audioIndexes ?? []
  if (audio.length > MAX_AUDIO_INDEXES || audio.some((x) => x.points.length > maxKeyPoints(x.points, m.durationMs))) {
    bad('audio')
  }
  if (m.keyframes.length > maxKeyPoints(m.keyframes, m.durationMs)) bad('keyframes')
}

/**
 * The host thins seek points to KEYFRAME_MIN_GAP_MS apart (thinKeyPoints), so an honest list holds about
 * one per gap over the duration, or over its own span when the container understates the duration.
 */
function maxKeyPoints(points: readonly KeyPoint[], durationMs: number): number {
  const span = (points.at(-1)?.[0] ?? 0) - (points[0]?.[0] ?? 0)
  return Math.min(MAX_KEY_POINTS, Math.ceil(Math.max(durationMs, span) / KEYFRAME_MIN_GAP_MS) + 2)
}

/**
 * Critical byte ranges (torrent bytes) as whole-piece spans for the scheduler: overlapping or adjacent
 * pieces merged, then the narrowest gaps bridged until at most `max` spans remain. Every span is a
 * selection re-added on each replan, and a manifest may hold thousands of ranges in a few pieces (one
 * sidx per fragment). A bridged gap only makes a few more pieces critical.
 */
export function criticalSpans(
  ranges: readonly ByteRange[],
  pieceLength: number,
  length: number,
  max = MAX_CRITICAL_SPANS,
): ByteRange[] {
  const P = pieceLength
  const pieces = ranges
    .filter(([s, e]) => e > s)
    .map(([s, e]): [number, number] => [Math.floor(s / P), Math.floor((e - 1) / P)])
    .sort((x, y) => x[0] - y[0])
  let spans: [number, number][] = []
  for (const [a, b] of pieces) {
    const last = spans.at(-1)
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else spans.push([a, b])
  }
  if (spans.length > max) {
    // gap i lies between spans i and i + 1: bridge all but the widest max - 1
    const gaps = spans.slice(1).map((s, i) => ({ i, width: s[0] - (spans[i]?.[1] ?? 0) }))
    gaps.sort((x, y) => x.width - y.width)
    const bridged = new Set(gaps.slice(0, spans.length - max).map((g) => g.i))
    const merged: [number, number][] = []
    for (const [i, s] of spans.entries()) {
      const last = merged.at(-1)
      if (last && bridged.has(i - 1)) last[1] = s[1]
      else merged.push([s[0], s[1]])
    }
    spans = merged
  }
  return spans.map(([a, b]): ByteRange => [a * P, Math.min((b + 1) * P, length)]).filter(([s, e]) => e > s)
}
