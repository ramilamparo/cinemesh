import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { SUBTITLE_EXTENSIONS } from '../../shared/media-files.js'

/** session.host and playlist.add take at most this many subtitle files per video. */
export const MAX_SUBS_PER_ITEM = 16

const SUB_EXT = new Set<string>(SUBTITLE_EXTENSIONS)
const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,4})?$/i
/** Name parts that describe a subtitle rather than name its language. */
const FLAG_WORDS = new Set(['forced', 'sdh', 'cc', 'hi', 'default', 'full', 'signs'])

/**
 * The language and forced flag a subtitle file name states: "Ep01.en.srt" → en, "Ep01.en.forced.srt" and
 * "Ep01.forced.en.srt" → en and forced, "Ep01.pt-BR.sdh.ass" → pt-BR. Only the last three name parts count, so
 * the title's own words do not.
 */
export function subtitleFlags(path: string): { lang: string; forced: boolean } {
  const parts = basename(path, extname(path)).split('.').slice(1).slice(-3)
  let lang = ''
  let forced = false
  for (const part of parts.reverse()) {
    const p = part.toLowerCase()
    if (FLAG_WORDS.has(p)) {
      if (p === 'forced') forced = true
    } else if (!lang && LANG_RE.test(part)) {
      lang = part
    } else {
      break
    }
  }
  return { lang, forced }
}

/**
 * Subtitle files next to a video that belong to it: the same name up to a dot ("Ep01.mkv" takes "Ep01.srt" and
 * "Ep01.en.forced.ass", not "Ep010.srt"), case-insensitively, in name order, at most MAX_SUBS_PER_ITEM. A folder
 * that cannot be read yields none: the video still plays.
 */
export async function siblingSubtitles(videoPath: string): Promise<string[]> {
  const dir = dirname(videoPath)
  const stem = basename(videoPath, extname(videoPath)).toLowerCase()
  const names = await readdir(dir).catch(() => [] as string[])
  return names
    .filter((n) => {
      const ext = extname(n)
      if (!SUB_EXT.has(ext.slice(1).toLowerCase())) return false
      const s = basename(n, ext).toLowerCase()
      return s === stem || s.startsWith(`${stem}.`)
    })
    .sort()
    .slice(0, MAX_SUBS_PER_ITEM)
    .map((n) => join(dir, n))
}
