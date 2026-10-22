import { describe, expect, it } from 'vitest'
import { extractInvite, inviteCode, inviteLink } from './invite-link.js'

const CODE = 'ybndrfg8ejkmcpqxot1uwisza345h769'.repeat(4).slice(0, 109)

describe('invite links', () => {
  it('finds a link inside chat text, case-insensitively, without swallowing the next word', () => {
    expect(extractInvite(`Join us! CineMesh://join/${CODE.toUpperCase()} see you`)).toBe(inviteLink(CODE))
  })

  it('joins a code wrapped across lines only when asked (paste box)', () => {
    const wrapped = `${CODE.slice(0, 50)}\n${CODE.slice(50)}`
    expect(extractInvite(wrapped, { joinLines: true })).toBe(inviteLink(CODE))
    expect(extractInvite(wrapped)).toBeNull()
  })

  it('accepts a bare code', () => {
    expect(extractInvite(`  ${CODE}  `)).toBe(inviteLink(CODE))
  })

  it('ignores text without an invite', () => {
    expect(extractInvite('hello there')).toBeNull()
    expect(extractInvite('cinemesh://join/short')).toBeNull()
  })

  it('round-trips link and code', () => {
    expect(inviteCode(inviteLink(CODE))).toBe(CODE)
    expect(inviteCode('https://example.com')).toBeNull()
  })
})
