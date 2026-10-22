import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import parseTorrent from 'parse-torrent'
import { afterAll, describe, expect, it } from 'vitest'
import { prepareHost } from './host-prepare.js'

const dir = mkdtempSync(join(tmpdir(), 'wt-prepare-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const P = 256 * 1024
const video = randomBytes(3 * P + 12_345)
const subA = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n')
const subB = randomBytes(P + 7)
const videoPath = join(dir, 'movie.mkv')
const subPaths = [join(dir, 'movie.en.srt'), join(dir, 'movie.de.ass')]
writeFileSync(videoPath, video)
writeFileSync(subPaths[0] as string, subA)
writeFileSync(subPaths[1] as string, subB)

function expectedHashes(): string[] {
  const all = Buffer.concat([video, subA, subB])
  const out: string[] = []
  for (let off = 0; off < all.length; off += P) {
    out.push(
      createHash('sha1')
        .update(all.subarray(off, off + P))
        .digest('hex'),
    )
  }
  return out
}

describe('prepareHost', () => {
  it('hashes video + subtitles across file boundaries with several workers', async () => {
    const progress: number[] = []
    const r = await prepareHost({
      videoPath,
      subtitlePaths: subPaths,
      cacheRoot: join(dir, 'cache'),
      workers: 3,
      pieceLength: P,
      onProgress: (p) => progress.push(p.bytesDone),
    })
    const parsed = await parseTorrent(r.torrent)
    expect(parsed.infoHash).toBe(r.infoHash)
    expect(parsed.pieces).toEqual(expectedHashes())
    expect(r.cached).toBe(false)
    expect(r.sources.map((s) => s.offset)).toEqual([0, video.length, video.length + subA.length])
    expect(progress.at(-1)).toBe(video.length + subA.length + subB.length)
  })

  it('reuses cached whole-video hashes on the second run and hashes only the tail', async () => {
    const opts = { videoPath, subtitlePaths: subPaths, cacheRoot: join(dir, 'cache'), pieceLength: P }
    const first = await prepareHost(opts)
    let hashed = 0
    const second = await prepareHost({ ...opts, onProgress: (p) => (hashed = p.bytesTotal) })
    expect(second.cached).toBe(true)
    expect(second.infoHash).toBe(first.infoHash)
    expect(hashed).toBe(video.length + subA.length + subB.length - 3 * P) // 3 whole video pieces skipped
  })

  it('invalidates the cache when the video changes', async () => {
    const opts = { videoPath, subtitlePaths: [], cacheRoot: join(dir, 'cache2'), pieceLength: P }
    await prepareHost(opts)
    utimesSync(videoPath, new Date(), new Date(Date.now() + 5000))
    const again = await prepareHost(opts)
    expect(again.cached).toBe(false)
  })

  it('stops when aborted', async () => {
    const big = join(dir, 'big.bin')
    writeFileSync(big, randomBytes(64 * P))
    const ac = new AbortController()
    const run = prepareHost({
      videoPath: big,
      subtitlePaths: [],
      cacheRoot: join(dir, 'c3'),
      pieceLength: P,
      signal: ac.signal,
    })
    ac.abort(new Error('cancelled by test'))
    await expect(run).rejects.toThrow('cancelled by test')
  })
})
