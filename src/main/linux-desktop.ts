import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { INVITE_SCHEME } from '../shared/invite-link.js'
import { type Result, err, ok } from '../shared/result.js'

// AppImages are not installed, so nothing tells the desktop that they handle watchtogether:// links. Settings
// offers an opt-in "Register invite links" that writes a user-level .desktop entry pointing at the AppImage
// and makes it the default handler (plan §4.6). Packaged deb/rpm/pacman builds ship their own entry.

const execFileAsync = promisify(execFile)

/**
 * The app's Linux identity: Electron's desktop name (Wayland app_id, X11 WM_CLASS) and the .desktop file name, so
 * windows are associated with their launcher entry. electron-builder.yml sets the same value as desktopName.
 */
export const LINUX_APP_ID = 'app.watchtogether.p2p'
/** The AppImage's user-level entry; named like the packaged one so the desktop matches it to the app_id. */
export const DESKTOP_FILE = `${LINUX_APP_ID}.desktop`
export const SCHEME_MIME = `x-scheme-handler/${INVITE_SCHEME}`

export interface LinuxDesktopDeps {
  /** $APPIMAGE: the AppImage's own path; undefined when not running from one */
  appImage: string | undefined
  /** $XDG_DATA_HOME or ~/.local/share */
  dataHome: string
  /** $XDG_CONFIG_HOME or ~/.config */
  configHome: string
  run: (cmd: string, args: string[]) => Promise<void>
}

export function defaultLinuxDesktopDeps(): LinuxDesktopDeps {
  const home = homedir()
  return {
    appImage: process.env.APPIMAGE,
    dataHome: process.env.XDG_DATA_HOME || join(home, '.local', 'share'),
    configHome: process.env.XDG_CONFIG_HOME || join(home, '.config'),
    run: async (cmd, args) => {
      await execFileAsync(cmd, args, { timeout: 10_000 })
    },
  }
}

/**
 * Quotes one Exec argument per the Desktop Entry spec: reserved characters force double quotes, inside which
 * " ` $ \ are backslash-escaped; string-value escaping then doubles every backslash again, and % becomes %%.
 */
export function quoteExecArg(arg: string): string {
  const needsQuotes = /[\s"'\\><~|&;$*?#()`]/.test(arg)
  let out = needsQuotes ? `"${arg.replace(/(["`$\\])/g, '\\$1')}"` : arg
  out = out.replace(/\\/g, '\\\\')
  return out.replace(/%/g, '%%')
}

export function desktopEntry(appImage: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Watch Together',
    'Comment=Watch a local video in sync with friends',
    `Exec=${quoteExecArg(appImage)} %U`,
    'Terminal=false',
    'Categories=AudioVideo;Video;Network;',
    `MimeType=${SCHEME_MIME};`,
    `StartupWMClass=${LINUX_APP_ID}`,
    `X-WatchTogether-AppImage=${appImage}`,
    '',
  ].join('\n')
}

/** Sets `mime=desktop` under [Default Applications] in mimeapps.list content, keeping everything else. */
export function setMimeDefault(content: string, mime: string, desktop: string): string {
  const lines = content.split('\n')
  const header = lines.findIndex((l) => l.trim() === '[Default Applications]')
  const entry = `${mime}=${desktop};`
  if (header < 0) {
    const base = content.trimEnd()
    return `${base}${base ? '\n\n' : ''}[Default Applications]\n${entry}\n`
  }
  let end = lines.findIndex((l, i) => i > header && /^\s*\[/.test(l))
  if (end < 0) end = lines.length
  const existing = lines.findIndex((l, i) => i > header && i < end && l.startsWith(`${mime}=`))
  if (existing >= 0) lines[existing] = entry
  else lines.splice(header + 1, 0, entry)
  return lines.join('\n')
}

export type LinuxDeepLinkStatus = 'unsupported' | 'unregistered' | 'registered' | 'stale'

export async function linuxDeepLinkStatus(
  deps: LinuxDesktopDeps = defaultLinuxDesktopDeps(),
): Promise<LinuxDeepLinkStatus> {
  if (process.platform !== 'linux' || !deps.appImage) return 'unsupported'
  try {
    const text = await readFile(join(deps.dataHome, 'applications', DESKTOP_FILE), 'utf8')
    return text.includes(`X-WatchTogether-AppImage=${deps.appImage}\n`) ? 'registered' : 'stale'
  } catch {
    return 'unregistered'
  }
}

/** Handler for APP_CHANNELS.registerLinuxDeepLinks. */
export async function registerLinuxDeepLinks(
  deps: LinuxDesktopDeps = defaultLinuxDesktopDeps(),
  platform: NodeJS.Platform = process.platform,
): Promise<Result<null>> {
  if (platform !== 'linux') return err('unsupported', 'Invite-link registration is only needed on Linux.')
  if (!deps.appImage) {
    return err('unsupported', 'Not running from an AppImage; installed packages register invite links themselves.')
  }
  const appsDir = join(deps.dataHome, 'applications')
  try {
    await mkdir(appsDir, { recursive: true })
    await writeAtomic(join(appsDir, DESKTOP_FILE), desktopEntry(deps.appImage))
  } catch (e) {
    return err('io', `Could not write the desktop entry: ${e instanceof Error ? e.message : String(e)}`)
  }
  // Optional: refreshes the MIME cache where the tool exists.
  await deps.run('update-desktop-database', [appsDir]).catch(() => undefined)
  try {
    await deps.run('xdg-mime', ['default', DESKTOP_FILE, SCHEME_MIME])
  } catch {
    // xdg-utils missing (minimal systems): write the default ourselves.
    const list = join(deps.configHome, 'mimeapps.list')
    try {
      const current = await readFile(list, 'utf8').catch(() => '')
      await mkdir(dirname(list), { recursive: true })
      await writeAtomic(list, setMimeDefault(current, SCHEME_MIME, DESKTOP_FILE))
    } catch (e) {
      return err('io', `Could not set the default handler: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return ok(null)
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp-${String(process.pid)}`
  await writeFile(tmp, data, { mode: 0o644 })
  await rename(tmp, file)
}
