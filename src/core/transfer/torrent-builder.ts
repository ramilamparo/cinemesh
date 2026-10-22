import { createHash } from 'node:crypto'
import { basename, extname } from 'node:path'
import bencode from 'bencode'

// The session torrent (plan §4.2): always multi-file [video, ...externalSubs], private, no announce.
// The video is file 0 at offset 0, so its whole-piece hashes do not depend on which subtitles exist.

export const TORRENT_NAME = 'WatchTogether'
const MIN_PIECE = 1 << 20
const MAX_PIECE = 4 << 20
const TARGET_PIECES = 16_384

/** Smallest power of two >= 1 MiB giving at most 16,384 pieces, capped at 4 MiB. */
export function pieceLengthFor(totalBytes: number): number {
  let p = MIN_PIECE
  while (p < MAX_PIECE && Math.ceil(totalBytes / p) > TARGET_PIECES) p *= 2
  return p
}

export interface LayoutFile {
  index: number
  name: string
  offset: number
  length: number
}

export interface TorrentLayout {
  files: LayoutFile[]
  length: number
  pieceLength: number
  pieceCount: number
}

/** Places files back to back; names are basenames made unique (subtitles often share a stem). */
export function layoutFiles(paths: readonly string[], lengths: readonly number[], pieceLength: number): TorrentLayout {
  const used = new Set<string>()
  let offset = 0
  const files = paths.map((path, index) => {
    const name = uniqueName(basename(path), used)
    const length = lengths[index] ?? 0
    const file = { index, name, offset, length }
    offset += length
    return file
  })
  return { files, length: offset, pieceLength, pieceCount: Math.ceil(offset / pieceLength) }
}

function uniqueName(name: string, used: Set<string>): string {
  const clean = name.replace(/[/\\]/g, '_') || 'file'
  let candidate = clean
  for (let n = 2; used.has(candidate); n++) {
    const ext = extname(clean)
    candidate = `${clean.slice(0, clean.length - ext.length)} (${String(n)})${ext}`
  }
  used.add(candidate)
  return candidate
}

export function pieceSize(layout: TorrentLayout, index: number): number {
  const start = index * layout.pieceLength
  return Math.max(0, Math.min(layout.pieceLength, layout.length - start))
}

/** Number of pieces that lie entirely inside file 0 (the video): their hashes are cacheable. */
export function wholeVideoPieces(layout: TorrentLayout): number {
  const video = layout.files[0]
  return video ? Math.floor(video.length / layout.pieceLength) : 0
}

export interface BuiltTorrent {
  torrent: Buffer
  infoHash: string
}

/** `pieces` holds the 20-byte SHA-1 of every piece, in order. */
export function buildTorrent(layout: TorrentLayout, pieces: Uint8Array): BuiltTorrent {
  if (pieces.byteLength !== layout.pieceCount * 20) {
    throw new Error(`expected ${String(layout.pieceCount * 20)} hash bytes, got ${String(pieces.byteLength)}`)
  }
  const info = {
    name: TORRENT_NAME,
    files: layout.files.map((f) => ({ length: f.length, path: [f.name] })),
    'piece length': layout.pieceLength,
    pieces,
    private: 1,
  }
  const infoBytes = bencode.encode(info)
  const infoHash = createHash('sha1').update(infoBytes).digest('hex')
  return { torrent: Buffer.from(bencode.encode({ info })), infoHash }
}
