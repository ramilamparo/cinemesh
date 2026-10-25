// File kinds the app offers to open, and the order playlists list files in. Shared by main (the open dialogs),
// core (playlist.add, sibling subtitles) and the renderer (the host card's list).

export const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'ts', 'm2ts'] as const
export const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt'] as const

/** A playlist holds at most this many items: what one session.playlist bus message carries (ADR 0011 §3). */
export const MAX_PLAYLIST_ITEMS = 100

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The file name of a path with either separator, as the renderer has no node:path. */
export function fileNameOf(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
}

/** "Ep2" before "Ep10", case-insensitive, by file name and then by the whole path. */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(fileNameOf(a), fileNameOf(b)) || collator.compare(a, b)
}

export function naturalSort(paths: readonly string[]): string[] {
  return [...paths].sort(naturalCompare)
}
