// Text-level invite handling shared by main (deep links, clipboard) and the renderer (paste box).
// Decoding and verification of the binary invite live in src/core/net/invite.ts (M2).

export const INVITE_SCHEME = 'watchtogether'

// z-base-32 alphabet; a v1 invite is at least 68 bytes, i.e. 109 characters.
const Z32_CODE = /[ybndrfg8ejkmcpqxot1uwisza345h769]{100,400}/

/**
 * Pulls an invite out of free text: a watchtogether://join/<code> link or a bare code, case-insensitively.
 * Returns the canonical link, or null. `joinLines` also removes whitespace inside the code, for the paste
 * box where the user pasted only the invite (chat apps sometimes wrap it); it must not be used on
 * surrounding chat text, where trailing words would run into the code.
 */
export function extractInvite(text: string, { joinLines = false } = {}): string | null {
  const input = (joinLines ? text.replace(/\s+/g, '') : text).toLowerCase()
  const link = new RegExp(`${INVITE_SCHEME}://join/(${Z32_CODE.source})`).exec(input)
  const code = link?.[1] ?? Z32_CODE.exec(input)?.[0]
  return code ? inviteLink(code) : null
}

export function inviteLink(code: string): string {
  return `${INVITE_SCHEME}://join/${code}`
}

export function inviteCode(link: string): string | null {
  const prefix = `${INVITE_SCHEME}://join/`
  return link.startsWith(prefix) ? link.slice(prefix.length) : null
}
