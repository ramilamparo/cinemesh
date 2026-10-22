import { describe, expect, it } from 'vitest'
import { extractInvite } from '../../shared/invite-link.js'
import { CodedError } from '../../shared/result.js'
import { randomBytes, z32Decode, z32Encode } from './crypto.js'
import { NET_ERRORS } from './errors.js'
import { DOWNLOAD_URL, INVITE_NAME_MAX_BYTES, type Invite, decodeInvite, encodeInvite, inviteText } from './invite.js'

const base: Invite = { roomSecret: randomBytes(32), hostKey: randomBytes(32), relayKey: null, name: '' }

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
    return null
  } catch (e) {
    return e instanceof CodedError ? e.code : 'not-coded'
  }
}

describe('invite v1', () => {
  it('round-trips the minimal invite in 109 characters', () => {
    const code = encodeInvite(base)
    expect(code).toHaveLength(109)
    expect(decodeInvite(code)).toEqual(base)
  })

  it('round-trips a relay key and a name', () => {
    const invite = { ...base, relayKey: randomBytes(32), name: 'Movie night 🍿' }
    expect(decodeInvite(encodeInvite(invite))).toEqual(invite)
  })

  it('truncates long names at a character boundary', () => {
    const decoded = decodeInvite(encodeInvite({ ...base, name: 'é'.repeat(40) }))
    expect(Buffer.byteLength(decoded.name)).toBeLessThanOrEqual(INVITE_NAME_MAX_BYTES)
    expect(decoded.name).toBe('é'.repeat(24))
  })

  it('accepts the link, upper case and surrounding whitespace', () => {
    const code = encodeInvite(base)
    expect(decodeInvite(`  watchtogether://join/${code}\n`)).toEqual(base)
    expect(decodeInvite(code.toUpperCase())).toEqual(base)
    expect(decodeInvite(`${code.slice(0, 50)}\n${code.slice(50)}`)).toEqual(base)
  })

  it('stays within what the shared invite-link extractor recognises', () => {
    const longest = encodeInvite({ ...base, relayKey: randomBytes(32), name: 'x'.repeat(48) })
    expect(extractInvite(`join us: watchtogether://join/${longest} !`)).toBe(`watchtogether://join/${longest}`)
  })

  it('detects every single-character corruption', () => {
    const code = encodeInvite({ ...base, name: 'Room' })
    const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769'
    for (let i = 0; i < code.length; i++) {
      const replacement = alphabet[(alphabet.indexOf(code[i] ?? 'y') + 7) % 32] ?? 'y'
      const bad = code.slice(0, i) + replacement + code.slice(i + 1)
      expect(codeOf(() => decodeInvite(bad))).not.toBeNull()
    }
  })

  it('reports bad encoding, length, version and checksum', () => {
    const code = encodeInvite(base)
    expect(codeOf(() => decodeInvite('not an invite!'))).toBe(NET_ERRORS.inviteEncoding)
    expect(codeOf(() => decodeInvite(code.slice(0, 60)))).toBe(NET_ERRORS.inviteLength)

    const bytes = z32Decode(code) ?? Buffer.alloc(0)
    const v2 = Buffer.from(bytes)
    v2[0] = 2
    expect(codeOf(() => decodeInvite(z32Encode(v2)))).toBe(NET_ERRORS.inviteVersion)

    const flipped = Buffer.from(bytes)
    flipped[10] = (flipped[10] ?? 0) ^ 1
    expect(codeOf(() => decodeInvite(z32Encode(flipped)))).toBe(NET_ERRORS.inviteChecksum)
  })
})

describe('invite text block', () => {
  it('has the room name, the link, the bare code, the download URL and per-OS steps', () => {
    const { code, link, text } = inviteText({ ...base, name: 'Friday' })
    expect(link).toBe(`watchtogether://join/${code}`)
    expect(text).toContain('Join "Friday" on Watch Together')
    expect(text).toContain(`Link: ${link}`)
    expect(text).toContain(`Code: ${code}`)
    expect(text).toContain(DOWNLOAD_URL)
    for (const os of ['Windows:', 'macOS:', 'Linux:']) expect(text).toContain(os)
    expect(extractInvite(text)).toBe(link)
  })
})
