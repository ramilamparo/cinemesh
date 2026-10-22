import { PEER_COLORS, THEME_TOKENS, TOKEN_NAMES, type Palette, type ThemePayload } from '../../../shared/theme-tokens'

export interface ResolvedPalette {
  colors: Palette
  peers: readonly string[]
}

/** The payload from main, or (before it arrives, and in the browser mock) the OS preference. */
export function resolvePalette(theme: ThemePayload | null): ResolvedPalette {
  if (theme) return { colors: theme.colors, peers: theme.peers }
  const dark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
  const mode = dark ? 'dark' : 'light'
  return { colors: THEME_TOKENS[mode], peers: PEER_COLORS[mode] }
}

export function peerColor(peers: readonly string[], index: number): string {
  return peers[index % peers.length] ?? '#888888'
}

/**
 * Mirrors the payload onto :root. tokens.css already follows prefers-color-scheme (which nativeTheme drives);
 * this adds the --peer-N colours, which have no CSS counterpart, and keeps the browser mock themable.
 */
export function applyThemeToDocument(theme: ThemePayload, root: HTMLElement = document.documentElement): void {
  for (const name of TOKEN_NAMES) root.style.setProperty(`--${name}`, theme.colors[name])
  theme.peers.forEach((c, i) => root.style.setProperty(`--peer-${i}`, c))
  root.style.colorScheme = theme.mode
  root.dataset.theme = theme.mode
}
