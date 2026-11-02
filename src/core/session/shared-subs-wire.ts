import { z } from 'zod'
import { SUBTITLE_EXTENSIONS } from '../../shared/media-files.js'
import { CodedError } from '../../shared/result.js'

/**
 * Subtitle files members share while the room plays (ADR 0013). The bytes travel as blobs (blob.get over ctrl, any
 * holder); the bus only names them.
 *
 * - session.subtitles (host-only, sticky): every shared file of the room, each tied to the playlist item (infoHash)
 *   it is for, and whether viewers may share.
 * - session.subtitle-offer (member → host): "I hold this file for that item": the host fetches it, checks it, and
 *   lists it.
 * - session.subtitle-remove (member → host): take a file off the list (its sharer or the host).
 * - session.subtitle-result (host → member): the answer to an offer or a remove.
 *
 * Their policies (host-only, sticky, rates, sizes) are in NET_POLICIES, so every member enforces them.
 */
export const SUBTITLES_NAME = 'session.subtitles'
export const SUBTITLE_OFFER_NAME = 'session.subtitle-offer'
export const SUBTITLE_REMOVE_NAME = 'session.subtitle-remove'
export const SUBTITLE_RESULT_NAME = 'session.subtitle-result'

/** A shared subtitle file is at most this big: text subtitles of a long film are a few hundred KB. */
export const MAX_SHARED_SUB_BYTES = 4 * 1024 * 1024
/** Shared files per playlist item (the torrent's own subtitles come on top). */
export const MAX_SHARED_PER_ITEM = 16
/** Shared files in the room: what one session.subtitles bus message carries. */
export const MAX_SHARED_IN_ROOM = 64
/** The encoded session.subtitles body stays under this (one bus message is at most 64 KiB, envelope included). */
export const SHARED_SUBS_MAX_BYTES = 48 * 1024
/** A shared file's name is cut to this many characters. */
export const MAX_SHARED_NAME_CHARS = 100

const SUB_EXT = new Set<string>(SUBTITLE_EXTENSIONS)

const Hash = z.string().regex(/^[0-9a-f]{64}$/)
const InfoHash = z.string().regex(/^[0-9a-f]{40}$/)
const Name = z
  .string()
  .min(1)
  .max(MAX_SHARED_NAME_CHARS)
  .refine((n) => subtitleExt(n) !== null, { message: 'not a subtitle file name' })

export const SharedSubSchema = z.object({
  hash: Hash,
  size: z.number().int().positive().max(MAX_SHARED_SUB_BYTES),
  name: Name,
  lang: z.string().max(16),
  infoHash: InfoHash,
  /** the sharer's member key (hex) */
  by: z.string().regex(/^[0-9a-f]{64}$/),
  byName: z.string().max(32),
})
export type SharedSub = z.infer<typeof SharedSubSchema>

export const SharedSubsSchema = z
  .object({
    v: z.literal(1),
    rev: z.number().int().min(0).max(0xffff_ffff),
    viewersMayShare: z.boolean(),
    items: z.array(SharedSubSchema).max(MAX_SHARED_IN_ROOM),
  })
  .refine((b) => new Set(b.items.map((i) => `${i.infoHash}|${i.hash}`)).size === b.items.length, {
    message: 'a file is listed twice for one item',
  })
export type SharedSubsBody = z.infer<typeof SharedSubsSchema>

export const SubtitleOfferSchema = z.object({
  hash: Hash,
  size: SharedSubSchema.shape.size,
  name: Name,
  infoHash: InfoHash,
})
export type SubtitleOffer = z.infer<typeof SubtitleOfferSchema>

export const SubtitleRemoveSchema = z.object({ hash: Hash, infoHash: InfoHash })

export const SubtitleResultSchema = z.object({
  hash: Hash,
  ok: z.boolean(),
  code: z.string().max(32).optional(),
  message: z.string().max(300).optional(),
})
export type SubtitleResult = z.infer<typeof SubtitleResultSchema>

/** 'srt' for "Movie.en.SRT"; null for anything that is not a text subtitle file. */
export function subtitleExt(name: string): string | null {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(name)
  const ext = m?.[1]?.toLowerCase()
  return ext !== undefined && SUB_EXT.has(ext) ? ext : null
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * A file name as the room lists it: the last path component, no control or bidi characters, at most
 * MAX_SHARED_NAME_CHARS UTF-16 units (zod's count) with its extension kept. Null when it is not a subtitle file.
 */
export function sharedSubName(path: string): string | null {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  const clean = base.replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, '').trim()
  const ext = subtitleExt(clean)
  if (ext === null) return null
  if (clean.length <= MAX_SHARED_NAME_CHARS) return clean
  // whole characters (graphemes) only, so a cut never splits one
  let stem = ''
  for (const { segment } of GRAPHEMES.segment(clean)) {
    if (stem.length + segment.length > MAX_SHARED_NAME_CHARS - ext.length - 2) break
    stem += segment
  }
  return `${stem}….${ext}`
}

export function sharedSubsBytes(body: SharedSubsBody): number {
  return Buffer.byteLength(JSON.stringify(body))
}

/** Throws subtitles-full when the body would not fit one bus message. */
export function checkSharedSubsSize(body: SharedSubsBody): void {
  if (body.items.length > MAX_SHARED_IN_ROOM || sharedSubsBytes(body) > SHARED_SUBS_MAX_BYTES) {
    throw new CodedError('subtitles-full', 'The room has too many shared subtitle files. Remove one first.')
  }
}

/**
 * Whether bytes read as a text subtitle: no NUL in the first 4 KiB unless a UTF-16 byte order mark says the text is
 * UTF-16. It keeps someone from sharing a video or an archive renamed to .srt; mpv still parses what it gets.
 */
export function looksLikeText(data: Uint8Array): boolean {
  if (data.byteLength === 0) return false
  const b0 = data[0]
  const b1 = data[1]
  if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return true
  return !data.subarray(0, 4096).includes(0)
}
