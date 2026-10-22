/** A parsed `mpv --version` number. Git builds keep the release they descend from. */
export interface MpvVersion {
  major: number
  minor: number
  patch: number
  /** e.g. '-dev', '-482-gcd6d2b3', '-UNKNOWN'; '' for a release */
  suffix: string
}

export const MIN_MPV: MpvVersion = { major: 0, minor: 39, patch: 0, suffix: '' }

// Release builds print "mpv v0.41.0 Copyright ..."; distro builds drop the "v"; git builds append
// "-<n>-g<hash>" or "-dev"/"-UNKNOWN". Some very old git builds print "mpv git-<hash>": unusable here.
const VERSION_RE = /^mpv\s+v?(\d+)\.(\d+)(?:\.(\d+))?([-+~][^\s]*)?(?:\s|$)/m

export function parseMpvVersion(output: string): MpvVersion | null {
  const m = VERSION_RE.exec(output)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3] ?? 0), suffix: m[4] ?? '' }
}

export function compareVersion(a: Pick<MpvVersion, 'major' | 'minor' | 'patch'>, b: typeof a): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** True when `v` is at least major.minor (patch releases never change option names). */
export function atLeast(v: MpvVersion, major: number, minor: number): boolean {
  return compareVersion(v, { major, minor, patch: 0 }) >= 0
}

export function formatVersion(v: MpvVersion): string {
  return `${String(v.major)}.${String(v.minor)}.${String(v.patch)}${v.suffix}`
}

export function versionFromString(s: string): MpvVersion | null {
  return parseMpvVersion(`mpv ${s}`)
}
