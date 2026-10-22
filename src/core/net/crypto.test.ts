import { describe, expect, it } from 'vitest'
import {
  authProof,
  blake2b,
  randomBytes,
  roomAuthKey,
  roomTopic,
  sign,
  verify,
  verifyProof,
  z32Decode,
  z32Encode,
} from './crypto.js'
import { keyPairFromSeed } from './identity.js'

describe('room keys', () => {
  it('derives a stable topic and auth key that differ from each other and per secret', () => {
    const secret = Buffer.alloc(32, 1)
    expect(roomTopic(secret).equals(roomTopic(Buffer.alloc(32, 1)))).toBe(true)
    expect(roomTopic(secret).equals(roomAuthKey(secret))).toBe(false)
    expect(roomTopic(secret).equals(roomTopic(Buffer.alloc(32, 2)))).toBe(false)
    expect(roomTopic(secret)).toHaveLength(32)
  })

  it('is keyed BLAKE2b over the context string', () => {
    const secret = randomBytes(32)
    expect(roomTopic(secret).equals(blake2b(Buffer.from('wtp/topic/v1'), 32, secret))).toBe(true)
  })
})

describe('auth proofs', () => {
  const authKey = roomAuthKey(randomBytes(32))
  const hh = randomBytes(64)

  it('verifies a proof made with the same key, handshake hash and direction', () => {
    expect(verifyProof(authKey, hh, true, authProof(authKey, hh, true))).toBe(true)
  })

  it('rejects the other direction, another handshake, another key or a short proof', () => {
    const proof = authProof(authKey, hh, true)
    expect(verifyProof(authKey, hh, false, proof)).toBe(false)
    expect(verifyProof(authKey, randomBytes(64), true, proof)).toBe(false)
    expect(verifyProof(roomAuthKey(randomBytes(32)), hh, true, proof)).toBe(false)
    expect(verifyProof(authKey, hh, true, proof.subarray(0, 31))).toBe(false)
  })
})

describe('signatures', () => {
  const kp = keyPairFromSeed('11'.repeat(32))

  it('verifies ed25519 signatures and rejects tampering', () => {
    const msg = Buffer.from('hello')
    const sig = sign(msg, kp.secretKey)
    expect(verify(sig, msg, kp.publicKey)).toBe(true)
    expect(verify(sig, Buffer.from('hellO'), kp.publicKey)).toBe(false)
    expect(verify(sig, msg, keyPairFromSeed('22'.repeat(32)).publicKey)).toBe(false)
    expect(verify(sig.subarray(1), msg, kp.publicKey)).toBe(false)
  })
})

describe('z32', () => {
  it('round-trips and rejects foreign characters', () => {
    const buf = randomBytes(68)
    const text = z32Encode(buf)
    expect(text).toHaveLength(109)
    expect(z32Decode(text)?.equals(buf)).toBe(true)
    expect(z32Decode('0lv2')).toBeNull()
  })
})
