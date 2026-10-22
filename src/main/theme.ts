import { EventEmitter } from 'node:events'
import { BrowserWindow, nativeTheme } from 'electron'
import { type ThemeMode, type ThemePayload, themePayload } from '../shared/theme-tokens.js'

export const TITLE_BAR_HEIGHT = 40

/** nativeTheme.themeSource drives prefers-color-scheme in every renderer; mpv gets colours via core. */
export class ThemeController extends EventEmitter<{ change: [ThemePayload] }> {
  constructor(private source: ThemeMode) {
    super()
    nativeTheme.themeSource = source
    nativeTheme.on('updated', () => this.apply())
  }

  setSource(source: ThemeMode): void {
    if (source === this.source) return
    this.source = source
    nativeTheme.themeSource = source // fires 'updated' when the resolved theme changes
    this.apply()
  }

  payload(): ThemePayload {
    return themePayload(this.source, nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
  }

  private apply(): void {
    const theme = this.payload()
    for (const win of BrowserWindow.getAllWindows()) styleWindow(win, theme)
    this.emit('change', theme)
  }
}

export function styleWindow(win: BrowserWindow, theme: ThemePayload): void {
  win.setBackgroundColor(theme.colors.bg)
  if (process.platform === 'win32') {
    win.setTitleBarOverlay({ color: theme.colors.surface, symbolColor: theme.colors.text, height: TITLE_BAR_HEIGHT })
  }
}
