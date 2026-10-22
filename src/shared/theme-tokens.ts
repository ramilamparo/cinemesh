// Single source of truth for colours. src/renderer/src/styles/tokens.css mirrors these values
// (a unit test keeps them equal) and the mpv OSC receives them through the `theme` message.

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]
export type ResolvedTheme = 'light' | 'dark'

export const TOKEN_NAMES = [
  'bg',
  'surface',
  'surface2',
  'text',
  'muted',
  'border',
  'accent',
  'tl-missing',
  'tl-downloading',
  'tl-downloaded',
  'tl-buffered',
  'playhead',
  'danger',
  'ok',
] as const
export type TokenName = (typeof TOKEN_NAMES)[number]
export type Palette = Record<TokenName, string>

export const THEME_TOKENS: Record<ResolvedTheme, Palette> = {
  light: {
    bg: '#ffffff',
    surface: '#f4f5f7',
    surface2: '#e9ebef',
    text: '#16181d',
    muted: '#5b6270',
    border: '#d6d9df',
    accent: '#3b6cf6',
    'tl-missing': '#d9dce2',
    'tl-downloading': '#e0a21b',
    'tl-downloaded': '#3b6cf6',
    'tl-buffered': '#8fa8f8',
    playhead: '#16181d',
    danger: '#d93036',
    ok: '#2b9a66',
  },
  dark: {
    bg: '#121317',
    surface: '#1b1d23',
    surface2: '#252832',
    text: '#e8eaf0',
    muted: '#9aa1ae',
    border: '#2f333d',
    accent: '#6c8cff',
    'tl-missing': '#2a2e38',
    'tl-downloading': '#d99a1e',
    'tl-downloaded': '#6c8cff',
    'tl-buffered': '#3d4f99',
    playhead: '#ffffff',
    danger: '#e5484d',
    ok: '#30a46c',
  },
}

// Peer marker colours on the timelines, chosen per theme for contrast against tl-* layers.
export const PEER_COLORS: Record<ResolvedTheme, readonly string[]> = {
  light: ['#d9480f', '#2b8a3e', '#1971c2', '#ae3ec9', '#e67700', '#0c8599', '#c2255c', '#5f3dc4'],
  dark: ['#ff8a4c', '#51cf66', '#4dabf7', '#da77f2', '#ffc078', '#3bc9db', '#f783ac', '#9775fa'],
}

export interface ThemePayload {
  source: ThemeMode
  mode: ResolvedTheme
  colors: Palette
  peers: readonly string[]
}

export function themePayload(source: ThemeMode, mode: ResolvedTheme): ThemePayload {
  return { source, mode, colors: THEME_TOKENS[mode], peers: PEER_COLORS[mode] }
}
