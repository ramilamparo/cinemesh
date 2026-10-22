import { createHash } from 'node:crypto'
import parseTorrent from 'parse-torrent'
import { describe, expect, it } from 'vitest'
import { buildTorrent, layoutFiles, pieceLengthFor, pieceSize, wholeVideoPieces } from './torrent-builder.js'

const GB = 1e9

describe('torrent builder', () => {
  it('picks the piece length from the plan table', () => {
    expect(pieceLengthFor(2 * GB)).toBe(1 << 20)
    expect(pieceLengthFor(15 * GB)).toBe(1 << 20)
    expect(pieceLengthFor(60 * GB)).toBe(4 << 20)
    expect(Math.ceil((60 * GB) / pieceLengthFor(60 * GB))).toBe(14_306)
    expect(pieceLengthFor(500 * GB)).toBe(4 << 20) // capped
  })

  it('lays files out back to back with unique names', () => {
    const l = layoutFiles(['/a/Movie.mkv', '/b/Movie.en.srt', '/c/Movie.en.srt'], [1000, 10, 20], 256)
    expect(l.files.map((f) => [f.name, f.offset, f.length])).toEqual([
      ['Movie.mkv', 0, 1000],
      ['Movie.en.srt', 1000, 10],
      ['Movie.en (2).srt', 1010, 20],
    ])
    expect(l.length).toBe(1030)
    expect(l.pieceCount).toBe(5)
    expect(pieceSize(l, 4)).toBe(1030 - 4 * 256)
    expect(wholeVideoPieces(l)).toBe(3) // pieces 0..2 lie inside the 1000-byte video
  })

  it('produces a private torrent whose infoHash parse-torrent agrees with', async () => {
    const l = layoutFiles(['/v/movie.mp4', '/v/movie.srt'], [700_000, 1234], 256 * 1024)
    const pieces = new Uint8Array(l.pieceCount * 20)
    for (let i = 0; i < l.pieceCount; i++)
      pieces.set(
        createHash('sha1')
          .update(`p${String(i)}`)
          .digest(),
        i * 20,
      )
    const { torrent, infoHash } = buildTorrent(l, pieces)
    const parsed = await parseTorrent(torrent)
    expect(parsed.infoHash).toBe(infoHash)
    expect(parsed.private).toBe(true)
    expect(parsed.pieceLength).toBe(256 * 1024)
    expect(parsed.files.map((f) => [f.name, f.offset, f.length])).toEqual([
      ['movie.mp4', 0, 700_000],
      ['movie.srt', 700_000, 1234],
    ])
    expect(parsed.pieces).toHaveLength(l.pieceCount)
  })

  it('rejects a hash buffer of the wrong size', () => {
    const l = layoutFiles(['/v/x'], [10], 4)
    expect(() => buildTorrent(l, new Uint8Array(20))).toThrow()
  })
})
