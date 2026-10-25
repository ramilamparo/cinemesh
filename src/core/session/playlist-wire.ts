import { z } from 'zod'
import { MAX_PLAYLIST_ITEMS } from '../../shared/media-files.js'
import { CodedError } from '../../shared/result.js'
import { AnnounceSchema } from './announce.js'

/**
 * session.playlist (host-only, sticky; ADR 0011 §3): the room's playlist and which item plays. Each prepared item
 * names its own torrent and manifest, fetched like session.announce's. `current.syncEpoch` is the sync epoch the
 * host runs for that item: a viewer applies sync states of that epoch only, so a state for the next item never
 * moves the previous file. The host keeps publishing session.announce for the current item, which is all an
 * older viewer reads.
 */
export const PLAYLIST_NAME = 'session.playlist'

/**
 * The encoded body stays under this (the bus carries at most 64 KiB, signature and envelope included). 100 items
 * with ordinary names take about 36 KB; names of 255 multi-byte characters would not fit, so playlist.add refuses.
 */
export const PLAYLIST_MAX_BYTES = 48 * 1024

export const ItemIdSchema = z.string().regex(/^[0-9a-f]{12}$/)

const u32 = z.number().int().min(0).max(0xffff_ffff)

export const PlaylistItemSchema = z
  .object({
    id: ItemIdSchema,
    name: z.string().min(1).max(255),
    fileSize: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative().nullable(),
    prepared: z.boolean(),
    infoHash: AnnounceSchema.shape.infoHash.optional(),
    torrent: AnnounceSchema.shape.torrent.optional(),
    manifest: AnnounceSchema.shape.manifest.optional(),
  })
  .refine(
    (i) =>
      !i.prepared ||
      (i.infoHash !== undefined && i.torrent !== undefined && i.manifest !== undefined && i.durationMs !== null),
    { message: 'a prepared item names its torrent, manifest and duration' },
  )
export type PlaylistItemBody = z.infer<typeof PlaylistItemSchema>

export const PlaylistSchema = z
  .object({
    v: z.literal(1),
    rev: u32,
    current: z.object({ id: ItemIdSchema, syncEpoch: u32 }).nullable(),
    autoAdvance: z.boolean(),
    /** the countdown to the next item after the current one ended: `inMs` from when the host published this */
    advance: z.object({ nextId: ItemIdSchema, inMs: z.number().int().min(0).max(60_000) }).optional(),
    items: z.array(PlaylistItemSchema).max(MAX_PLAYLIST_ITEMS),
  })
  .refine((p) => new Set(p.items.map((i) => i.id)).size === p.items.length, { message: 'item ids repeat' })
  .refine(
    (p) =>
      new Set(p.items.flatMap((i) => (i.infoHash ? [i.infoHash] : []))).size ===
      p.items.filter((i) => i.infoHash).length,
    { message: 'a torrent is listed twice' },
  )
  .refine((p) => p.current === null || p.items.some((i) => i.id === p.current?.id && i.prepared), {
    message: 'the current item is not a prepared item of the list',
  })
  .refine((p) => p.advance === undefined || p.items.some((i) => i.id === p.advance?.nextId), {
    message: 'the next item is not in the list',
  })
export type PlaylistBody = z.infer<typeof PlaylistSchema>

export function playlistBytes(body: PlaylistBody): number {
  return Buffer.byteLength(JSON.stringify(body))
}

/** Throws playlist-full when the body would not fit one bus message. */
export function checkPlaylistSize(body: PlaylistBody): void {
  if (body.items.length > MAX_PLAYLIST_ITEMS || playlistBytes(body) > PLAYLIST_MAX_BYTES) {
    throw new CodedError('playlist-full', 'The playlist is full. Remove an item before adding more.')
  }
}

/** A fresh random item id: 48 bits, unique within one room. */
export function newItemId(random: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 12; i++) s += Math.floor(random() * 16).toString(16)
  return s
}
