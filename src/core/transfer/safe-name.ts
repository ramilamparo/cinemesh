// File names inside the torrent come from the host and are untrusted: a crafted name must never make a
// viewer write outside the folder it chose (path traversal), produce a name Windows cannot create, or
// leave something that runs, mounts or configures a shell when opened. Files the core saves carry no
// Mark-of-the-Web, so SmartScreen and protected view would not step in.

// device names, also with an extension or spaces before one ('CON .srt'); COM¹-³ and LPT¹-³ count too
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)\s*(\..*)?$/i
// control characters, Windows-invalid characters, and bidi controls that disguise an extension
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const INVALID = /[\u0000-\u001f\u007f<>:"|?*‎‏‪-‮⁦-⁩]/g
// opened by running something rather than by a player (Windows, macOS and Linux desktops)
const EXECUTABLE =
  /\.(exe|com|scr|pif|bat|cmd|msi|msp|cpl|dll|lnk|url|scf|inf|reg|hta|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|desktop|sh|command|app|appimage|run)$/i
/** What a saved video may end in; anything else gets its container's extension appended. */
const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'm4v', 'webm', 'avi', 'mov', 'ts', 'm2ts', 'mts'])
/** What a saved subtitle may end in (videos too); anything else gets '.bin' appended. */
const MEDIA_EXTENSIONS = new Set([...VIDEO_EXTENSIONS, 'srt', 'ass', 'ssa', 'vtt', 'sub', 'idx', 'sup'])
const PLAIN_EXTENSION = /\.([A-Za-z0-9]{1,10})$/
const MAX_BYTES = 200
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** One safe file name (a single path component) for `name`, else for `fallback`, else 'file'. */
export function safeFileName(name: string, fallback: string): string {
  return clean(name) ?? clean(fallback) ?? 'file'
}

/** `name`'s extension when it is a known video or subtitle type (to keep on a fallback name), else ''. */
export function safeExtension(name: string): string {
  const ext = PLAIN_EXTENSION.exec(lastComponent(name).trim())?.[0] ?? ''
  return MEDIA_EXTENSIONS.has(ext.slice(1).toLowerCase()) ? ext : ''
}

/** A host could name the "video" 'film.mkv.exe' (shown as 'film.mkv'): saved files never keep such an extension. */
export function defuseExecutable(name: string): string {
  return name.replace(EXECUTABLE, (ext) => `_${ext.slice(1)}`)
}

/**
 * The name saveFile gives a downloaded file: one safe component ending in an allowlisted extension. An
 * extension off the list is not removed but outranked, by appending the video's container extension
 * (`videoExt`, file 0) or '.bin' (subtitles): 'film.mkv.msc' becomes 'film.mkv.msc.bin', '.zshrc' becomes
 * 'zshrc.bin'. A denylist always misses something (.msc, .iso, .settingcontent-ms, .terminal, ...).
 */
export function savedFileName(name: string, kind: { video: boolean; fallback: string; videoExt: string }): string {
  const allowed = kind.video ? VIDEO_EXTENSIONS : MEDIA_EXTENSIONS
  const ok = (s: string): boolean => allowed.has(PLAIN_EXTENSION.exec(s)?.[1]?.toLowerCase() ?? '')
  const appended = kind.video ? kind.videoExt : '.bin'
  const finish = (s: string): string | null => {
    const defused = defuseExecutable(s)
    return clean(ok(defused) ? defused : `${defused}${appended}`)
  }
  const raw = lastComponent(name).trim()
  const fallbackExt = ok(raw) ? (PLAIN_EXTENSION.exec(raw)?.[0] ?? '') : ''
  const named = clean(name)
  return (
    (named === null ? null : finish(named)) ??
    finish(`${kind.fallback}${fallbackExt}`) ??
    `${kind.video ? 'video' : 'file'}${appended}`
  )
}

/**
 * The usual extension of the video's container, from its first bytes (at least 200 for MPEG-TS), for a
 * video whose name has none on the list. Players sniff the content anyway; this only picks the icon and
 * the app that opens it. Unknown content gets '.mkv'.
 */
export function containerExtension(head: Uint8Array): string {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength)
  const ascii = (from: number, to: number): string => b.toString('latin1', from, to)
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return b.subarray(0, 64).includes('webm') ? '.webm' : '.mkv'
  if (ascii(4, 8) === 'ftyp') return ascii(8, 12) === 'qt  ' ? '.mov' : '.mp4'
  if (['moov', 'mdat', 'free', 'wide', 'skip'].includes(ascii(4, 8))) return '.mp4'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'AVI ') return '.avi'
  if (b[0] === 0x47 && b[188] === 0x47) return '.ts'
  if (b[4] === 0x47 && b[196] === 0x47) return '.m2ts' // 4-byte timestamp before each 188-byte packet
  return '.mkv'
}

function lastComponent(name: string): string {
  return name.split(/[/\\]/).pop() ?? ''
}

function clean(name: string): string | null {
  // leading dots too: '.zshrc' or '.profile' saved into a home folder would configure the viewer's shell
  let s = trimEnd(
    lastComponent(name)
      .normalize('NFC')
      .replace(INVALID, '_')
      .replace(/^[.\s]+/, '')
      .trim(),
  )
  if (s === '' || RESERVED.test(s)) return null
  if (Buffer.byteLength(s) > MAX_BYTES) {
    const dot = s.lastIndexOf('.')
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : ''
    // whole graphemes: never split a surrogate pair or a letter from its accent
    const stem = Array.from(GRAPHEMES.segment(s.slice(0, s.length - ext.length)), (g) => g.segment)
    while (stem.length > 0 && Buffer.byteLength(stem.join('') + ext) > MAX_BYTES) stem.pop()
    if (stem.length === 0) return null // the extension alone would be a dotfile
    s = ext ? stem.join('') + ext : trimEnd(stem.join(''))
  }
  return s === '' || RESERVED.test(s) ? null : s
}

/** Windows drops trailing dots and spaces, so the name it creates would differ from the one checked. */
function trimEnd(s: string): string {
  return s.replace(/[. ]+$/, '')
}
