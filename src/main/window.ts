import { BrowserWindow, session, shell } from 'electron'
import type { ThemePayload } from '../shared/theme-tokens.js'
import { RENDERER_ENTRY } from './app-protocol.js'
import { preloadPath } from './paths.js'
import { TITLE_BAR_HEIGHT } from './theme.js'

export function rendererUrl(): string {
  return process.env.ELECTRON_RENDERER_URL ?? RENDERER_ENTRY
}

/** True for frames that belong to our UI: the app:// bundle, or the Vite dev server in development. */
export function isTrustedUrl(url: string | undefined): boolean {
  if (!url) return false
  if (url.startsWith(`${RENDERER_ENTRY.slice(0, RENDERER_ENTRY.lastIndexOf('/'))}/`)) return true
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev !== undefined && new URL(url).origin === new URL(dev).origin
}

export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

export function createMainWindow(theme: ThemePayload): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'Cinemesh',
    backgroundColor: theme.colors.bg,
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { color: theme.colors.surface, symbolColor: theme.colors.text, height: TITLE_BAR_HEIGHT },
        }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const }
        : {}),
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault()
  })
  void win.loadURL(rendererUrl())
  return win
}
