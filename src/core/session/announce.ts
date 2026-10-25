import { z } from 'zod'
import { CodedError } from '../../shared/result.js'

// session.announce: the video viewers fetch and play (host-only, sticky). With a playlist it names the current item.

/**
 * Decoding is linear in the manifest's size, so this caps it before anything else. Honest manifests are
 * tens of KB (a 3 h film with a 1 s GOP is about 100 KB); a 3 h all-intra file with 8 poorly interleaved
 * audio tracks and 64 tracks is 2.4 MB, and 4 MiB decodes in under 0.2 s.
 */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export const AnnounceSchema = z.object({
  v: z.literal(1),
  infoHash: z.string().regex(/^[0-9a-f]{40}$/),
  torrent: z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
  }),
  manifest: z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive().max(MAX_MANIFEST_BYTES),
  }),
  name: z.string().min(1).max(512),
  fileSize: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
})
export type Announce = z.infer<typeof AnnounceSchema>

/**
 * Why an announce failed AnnounceSchema. A newer host (v > 1) may have changed any of it, so its version is
 * the answer; anything else is a host sending what no honest host sends (a manifest over MAX_MANIFEST_BYTES).
 */
export function announceError(raw: unknown, issues: readonly { path: readonly PropertyKey[] }[]): CodedError {
  const v = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined
  if (typeof v === 'number' && v > 1) {
    return new CodedError('update-required', 'The host uses a newer version of Cinemesh. Update the app to join.')
  }
  const what = issues[0]?.path.map(String).join('.') || 'announce'
  return new CodedError(
    'bad-session',
    `The host sent video details this app cannot read (${what}). Ask the host to host it again.`,
  )
}
