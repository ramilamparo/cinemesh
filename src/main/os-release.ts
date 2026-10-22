import { readFile } from 'node:fs/promises'

// AppInfo.distro: the os-release ID ('arch', 'ubuntu', ...), so MpvSetup can highlight the install command for it.

export const OS_RELEASE_FILES = ['/etc/os-release', '/usr/lib/os-release']

/** The ID= value of an os-release file (quotes removed, lower case), or null. */
export function parseOsReleaseId(text: string): string | null {
  for (const line of text.split('\n')) {
    const m = /^\s*ID\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const value = (m[1] ?? '')
      .replace(/^(["'])(.*)\1$/, '$2')
      .trim()
      .toLowerCase()
    return /^[a-z0-9._-]+$/.test(value) ? value : null
  }
  return null
}

export async function readDistro(
  platform: NodeJS.Platform = process.platform,
  files: string[] = OS_RELEASE_FILES,
): Promise<string | null> {
  if (platform !== 'linux') return null
  for (const file of files) {
    try {
      return parseOsReleaseId(await readFile(file, 'utf8'))
    } catch {
      // try the next location
    }
  }
  return null
}
