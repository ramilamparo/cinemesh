import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PEER_COLORS, THEME_TOKENS, TOKEN_NAMES, themePayload } from './theme-tokens.js'

const css = readFileSync(new URL('../renderer/src/styles/tokens.css', import.meta.url), 'utf8')

function block(source: string, dark: boolean): Record<string, string> {
  const darkStart = source.indexOf('@media (prefers-color-scheme: dark)')
  const text = dark ? source.slice(darkStart) : source.slice(0, darkStart)
  const out: Record<string, string> = {}
  for (const m of text.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)) {
    if (m[1] && m[2]) out[m[1]] = m[2].toLowerCase()
  }
  return out
}

describe('theme tokens', () => {
  it.each([
    ['light', false],
    ['dark', true],
  ] as const)('tokens.css %s block equals theme-tokens.ts', (mode, dark) => {
    expect(block(css, dark)).toEqual(THEME_TOKENS[mode])
  })

  it('defines every token in both themes', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(Object.keys(THEME_TOKENS[mode]).sort()).toEqual([...TOKEN_NAMES].sort())
      expect(PEER_COLORS[mode]).toHaveLength(8)
    }
  })

  it('builds payloads', () => {
    const p = themePayload('system', 'dark')
    expect(p.colors.bg).toBe('#121317')
    expect(p.source).toBe('system')
  })
})
