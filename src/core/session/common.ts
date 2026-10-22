import { basename, extname } from 'node:path'
import type { CoreLog } from '../log.js'
import type { PlayheadReason as MediaPlayheadReason } from '../media/playhead.js'
import type { NetLog } from '../net/room.js'
import type { PlayheadReason } from '../sync/ports.js'

/** Bus names owned by the session (session.announce is host-only + sticky in NET_POLICIES). */
export function announceName(t: 'announce' | 'preparing' | 'unavailable'): string {
  return `session.${t}`
}

export function netLog(log: CoreLog): NetLog {
  return {
    debug: (m) => log.debug(`[net] ${m}`),
    info: (m) => log.info(`[net] ${m}`),
    warn: (m) => log.warn(`[net] ${m}`),
  }
}

/** "Movie.en.srt" -> "en", "Movie.pt-BR.ass" -> "pt-BR"; '' when the name has no language part. */
export function subtitleLang(path: string): string {
  const stem = basename(path, extname(path))
  const m = /\.([a-z]{2,3}(?:-[A-Za-z]{2,4})?)$/i.exec(stem)
  return m?.[1] ?? ''
}

/** Sync's reasons to move the playhead, as the media Playhead names them (a rendezvous is a join). */
export const PLAYHEAD_REASONS: Record<PlayheadReason, MediaPlayheadReason> = {
  seek: 'seek',
  catchup: 'catchup',
  rendezvous: 'join',
}
