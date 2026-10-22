import { describe, expect, it } from 'vitest'
import { CodedError } from '../../shared/result.js'
import { classifyPath, isPrivateAddress } from './path.js'
import { clampName, decodeAuthHandshake, decodeFrame, encodeAuthHandshake, encodeFrame, truncateUtf8 } from './wire.js'

describe('frames', () => {
  it('round-trips JSON objects and ignores anything else', () => {
    expect(decodeFrame(encodeFrame({ ns: 'a', t: 'b', n: 1 }, 100), 100)).toEqual({ ns: 'a', t: 'b', n: 1 })
    expect(decodeFrame(Buffer.from('[1]'), 100)).toBeNull()
    expect(decodeFrame(Buffer.from('{oops'), 100)).toBeNull()
  })

  it('refuses frames over the limit in both directions', () => {
    expect(() => encodeFrame({ x: 'y'.repeat(100) }, 50)).toThrow(CodedError)
    expect(() => decodeFrame(Buffer.alloc(51), 50)).toThrow(CodedError)
  })

  it('codes the auth handshake with one or two proofs', () => {
    const a = Buffer.alloc(32, 1)
    const b = Buffer.alloc(32, 2)
    expect(decodeAuthHandshake(encodeAuthHandshake(a, null))).toEqual({ version: 1, proofs: [a] })
    expect(decodeAuthHandshake(encodeAuthHandshake(a, b))).toEqual({ version: 1, proofs: [a, b] })
    expect(decodeAuthHandshake(Buffer.alloc(10))).toBeNull()
    expect(decodeAuthHandshake('nope')).toBeNull()
  })

  it('clamps names to 32 bytes without splitting characters', () => {
    expect(clampName('  Ann  ')).toBe('Ann')
    expect(clampName('')).toBe('Friend')
    expect(Buffer.byteLength(clampName('😀'.repeat(20)))).toBe(32)
    expect(truncateUtf8('aé', 2).toString()).toBe('a')
  })
})

describe('path', () => {
  const relay = { host: '203.0.113.5', port: 49737 }
  it('classifies relay, private and public addresses', () => {
    expect(classifyPath({ host: '203.0.113.5', port: 49737 }, relay)).toBe('relayed')
    expect(classifyPath({ host: '203.0.113.5', port: 50000 }, relay)).toBe('direct')
    expect(classifyPath({ host: '192.168.1.4', port: 1 }, relay)).toBe('lan')
    expect(classifyPath({ host: '127.0.0.1', port: 49737 }, { host: '127.0.0.1', port: 49737 })).toBe('relayed')
    expect(classifyPath({ host: '::ffff:10.0.0.2', port: 1 }, null)).toBe('lan')
    expect(classifyPath({ host: '8.8.8.8', port: 1 }, null)).toBe('direct')
    expect(classifyPath(null, null)).toBe('none')
  })

  it('knows the private ranges', () => {
    for (const h of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.1',
      '192.168.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '::1',
      'fd00::1',
    ])
      expect(isPrivateAddress(h)).toBe(true)
    for (const h of ['172.32.0.1', '100.64.0.1', '1.1.1.1', '2001:db8::1']) expect(isPrivateAddress(h)).toBe(false)
  })
})
