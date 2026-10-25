import { describe, expect, it } from 'vitest'
import { MAX_PLAYLIST_ITEMS } from '../../shared/media-files.js'
import {
  PLAYLIST_MAX_BYTES,
  type PlaylistBody,
  type PlaylistItemBody,
  PlaylistSchema,
  checkPlaylistSize,
  newItemId,
  playlistBytes,
} from './playlist-wire.js'

const hex = (n: number, c: string): string => c.repeat(n)

function item(
  i: number,
  prepared = true,
  name = `Show.S01E${String(i).padStart(2, '0')}.1080p.WEB.mkv`,
): PlaylistItemBody {
  const id = i.toString(16).padStart(12, '0')
  return prepared
    ? {
        id,
        name,
        fileSize: 1_400_000_000,
        durationMs: 2_640_000,
        prepared,
        infoHash: i.toString(16).padStart(40, '0'),
        torrent: { hash: hex(64, 'a'), size: 300_000 },
        manifest: { hash: hex(64, 'b'), size: 120_000 },
      }
    : { id, name, fileSize: 1_400_000_000, durationMs: null, prepared }
}

function body(items: PlaylistItemBody[], extra: Partial<PlaylistBody> = {}): PlaylistBody {
  const first = items[0]
  return { v: 1, rev: 3, current: first ? { id: first.id, syncEpoch: 77 } : null, autoAdvance: true, items, ...extra }
}

describe('PlaylistSchema', () => {
  it('takes a list of prepared and queued items', () => {
    const b = body([item(1), item(2), item(3, false)], { advance: { nextId: item(2).id, inMs: 5000 } })
    expect(PlaylistSchema.parse(b)).toEqual(b)
  })

  it('refuses a prepared item without its torrent', () => {
    const { torrent: _t, ...bare } = item(1)
    expect(PlaylistSchema.safeParse(body([bare as PlaylistItemBody])).success).toBe(false)
  })

  it('refuses a current item that is not prepared or not listed', () => {
    expect(PlaylistSchema.safeParse(body([item(1, false)])).success).toBe(false)
    expect(PlaylistSchema.safeParse(body([item(1)], { current: { id: 'ffffffffffff', syncEpoch: 1 } })).success).toBe(
      false,
    )
    expect(PlaylistSchema.safeParse(body([item(1)], { current: null })).success).toBe(true)
  })

  it('refuses repeated ids and torrents', () => {
    expect(PlaylistSchema.safeParse(body([item(1), item(1)])).success).toBe(false)
    const twin = { ...item(2), infoHash: item(1).infoHash }
    expect(PlaylistSchema.safeParse(body([item(1), twin])).success).toBe(false)
  })

  it('refuses a newer version and more than the cap', () => {
    expect(PlaylistSchema.safeParse({ ...body([item(1)]), v: 2 }).success).toBe(false)
    const many = Array.from({ length: MAX_PLAYLIST_ITEMS + 1 }, (_, i) => item(i + 1))
    expect(PlaylistSchema.safeParse(body(many)).success).toBe(false)
  })
})

describe('the size guard', () => {
  it('fits a full list of ordinary names', () => {
    const full = body(Array.from({ length: MAX_PLAYLIST_ITEMS }, (_, i) => item(i + 1)))
    expect(playlistBytes(full)).toBeLessThan(PLAYLIST_MAX_BYTES)
    expect(() => checkPlaylistSize(full)).not.toThrow()
  })

  it('refuses a list that would not fit one bus message', () => {
    const long = body(Array.from({ length: 80 }, (_, i) => item(i + 1, true, 'é'.repeat(255))))
    expect(() => checkPlaylistSize(long)).toThrow(/playlist is full/)
  })
})

describe('newItemId', () => {
  it('makes 12 hex digits', () => {
    expect(newItemId()).toMatch(/^[0-9a-f]{12}$/)
  })
})
