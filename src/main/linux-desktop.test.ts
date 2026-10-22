import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_FILE,
  LINUX_APP_ID,
  type LinuxDesktopDeps,
  desktopEntry,
  linuxDeepLinkStatus,
  quoteExecArg,
  registerLinuxDeepLinks,
  setMimeDefault,
} from './linux-desktop.js'

let root: string
let ran: string[][]
let deps: LinuxDesktopDeps

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wt-desktop-'))
  ran = []
  deps = {
    appImage: '/home/u/Apps/Watch Together.AppImage',
    dataHome: join(root, 'share'),
    configHome: join(root, 'config'),
    run: (cmd, args) => {
      ran.push([cmd, ...args])
      return Promise.resolve()
    },
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('linux deep-link registration', () => {
  it('quotes Exec arguments per the Desktop Entry spec', () => {
    expect(quoteExecArg('/opt/wt.AppImage')).toBe('/opt/wt.AppImage')
    expect(quoteExecArg('/a b/wt.AppImage')).toBe('"/a b/wt.AppImage"')
    expect(quoteExecArg('/a$b/x"y')).toBe('"/a\\\\$b/x\\\\"y"')
    expect(quoteExecArg('/100%/x')).toBe('/100%%/x')
  })

  it('writes a scheme handler entry', () => {
    const entry = desktopEntry('/a b/wt.AppImage')
    expect(entry).toContain('Exec="/a b/wt.AppImage" %U')
    expect(entry).toContain('MimeType=x-scheme-handler/watchtogether;')
  })

  it('registers via xdg-mime and reports the status', async () => {
    if (process.platform !== 'linux') return
    expect(await linuxDeepLinkStatus(deps)).toBe('unregistered')
    expect(await registerLinuxDeepLinks(deps, 'linux')).toEqual({ ok: true, value: null })
    const file = readFileSync(join(deps.dataHome, 'applications', DESKTOP_FILE), 'utf8')
    expect(file).toContain('Exec="/home/u/Apps/Watch Together.AppImage" %U')
    expect(ran).toEqual([
      ['update-desktop-database', join(deps.dataHome, 'applications')],
      ['xdg-mime', 'default', DESKTOP_FILE, 'x-scheme-handler/watchtogether'],
    ])
    expect(await linuxDeepLinkStatus(deps)).toBe('registered')
    expect(await linuxDeepLinkStatus({ ...deps, appImage: '/moved.AppImage' })).toBe('stale')
  })

  it('falls back to mimeapps.list without xdg-utils', async () => {
    deps.run = () => Promise.reject(new Error('ENOENT'))
    expect(await registerLinuxDeepLinks(deps, 'linux')).toEqual({ ok: true, value: null })
    const list = readFileSync(join(deps.configHome, 'mimeapps.list'), 'utf8')
    expect(list).toBe(`[Default Applications]\nx-scheme-handler/watchtogether=${DESKTOP_FILE};\n`)
  })

  it('refuses outside an AppImage or on other platforms', async () => {
    expect((await registerLinuxDeepLinks({ ...deps, appImage: undefined }, 'linux')).ok).toBe(false)
    expect((await registerLinuxDeepLinks(deps, 'win32')).ok).toBe(false)
  })

  it('edits mimeapps.list in place', () => {
    const before =
      '[Added Associations]\na=b;\n\n[Default Applications]\nx-scheme-handler/watchtogether=old.desktop;\ntext/plain=gedit.desktop;\n'
    const after = setMimeDefault(before, 'x-scheme-handler/watchtogether', 'new.desktop')
    expect(after).toContain('x-scheme-handler/watchtogether=new.desktop;')
    expect(after).not.toContain('old.desktop')
    expect(after).toContain('text/plain=gedit.desktop;')
    expect(after).toContain('[Added Associations]\na=b;')
    expect(setMimeDefault('[Default Applications]\n', 'm/x', 'd.desktop')).toBe(
      '[Default Applications]\nm/x=d.desktop;\n',
    )
  })
})

describe('Linux app identity', () => {
  it('matches electron-builder.yml, so packaged windows associate with their .desktop entry', () => {
    const yml = readFileSync(join(import.meta.dirname, '../../electron-builder.yml'), 'utf8')
    expect(yml).toContain(`\nextraMetadata:\n  desktopName: ${LINUX_APP_ID}.desktop\n`)
    expect(yml).toMatch(/^linux:\n(?: {2}.*\n)*? {2}syncDesktopName: true$/m)
  })

  it('names the AppImage entry after the app id and sets StartupWMClass to it', () => {
    expect(DESKTOP_FILE).toBe(`${LINUX_APP_ID}.desktop`)
    expect(desktopEntry('/a/b.AppImage')).toContain(`\nStartupWMClass=${LINUX_APP_ID}\n`)
  })
})
