import sodium from 'sodium-native'
import { decode as z32decode, encode as z32encode } from 'z32'

// Key derivation, auth proofs and bus signatures (plan §4.1). Every hash is BLAKE2b (crypto_generichash).

export const KEY_BYTES = 32
export const SIGNATURE_BYTES = 64

const TOPIC_CONTEXT = Buffer.from('wtp/topic/v1')
const AUTH_CONTEXT = Buffer.from('wtp/auth/v1')
const BUS_CONTEXT = Buffer.from('wtp/bus/1\n')

export function blake2b(input: Uint8Array, bytes = 32, key?: Uint8Array): Buffer {
  const out = Buffer.alloc(bytes)
  if (key) sodium.crypto_generichash(out, toBuffer(input), toBuffer(key))
  else sodium.crypto_generichash(out, toBuffer(input))
  return out
}

/** The DHT topic every member joins: H("wtp/topic/v1", key = roomSecret). */
export function roomTopic(roomSecret: Uint8Array): Buffer {
  return blake2b(TOPIC_CONTEXT, 32, roomSecret)
}

/** Key for the auth proofs: H("wtp/auth/v1", key = roomSecret). Never leaves the process. */
export function roomAuthKey(roomSecret: Uint8Array): Buffer {
  return blake2b(AUTH_CONTEXT, 32, roomSecret)
}

/**
 * proof = H(handshakeHash ‖ "wtp/auth/" + (i|r), key = authKey). The Noise handshake hash is the same on
 * both ends of a connection and unique to it, so a proof cannot be replayed on another connection.
 */
export function authProof(authKey: Uint8Array, handshakeHash: Uint8Array, isInitiator: boolean): Buffer {
  const label = Buffer.from(`wtp/auth/${isInitiator ? 'i' : 'r'}`)
  return blake2b(Buffer.concat([toBuffer(handshakeHash), label]), 32, authKey)
}

export function verifyProof(
  authKey: Uint8Array,
  handshakeHash: Uint8Array,
  remoteIsInitiator: boolean,
  proof: Uint8Array,
): boolean {
  if (proof.byteLength !== 32) return false
  return sodium.sodium_memcmp(authProof(authKey, handshakeHash, remoteIsInitiator), toBuffer(proof))
}

export function busSigningPayload(fields: string): Buffer {
  return Buffer.concat([BUS_CONTEXT, Buffer.from(fields)])
}

export function sign(message: Uint8Array, secretKey: Uint8Array): Buffer {
  const sig = Buffer.alloc(SIGNATURE_BYTES)
  sodium.crypto_sign_detached(sig, toBuffer(message), toBuffer(secretKey))
  return sig
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.byteLength !== SIGNATURE_BYTES || publicKey.byteLength !== KEY_BYTES) return false
  return sodium.crypto_sign_verify_detached(toBuffer(signature), toBuffer(message), toBuffer(publicKey))
}

export function randomBytes(n: number): Buffer {
  const buf = Buffer.alloc(n)
  sodium.randombytes_buf(buf)
  return buf
}

export function z32Encode(buf: Uint8Array): string {
  return z32encode(buf)
}

/** Returns null for characters outside the z-base-32 alphabet. */
export function z32Decode(text: string): Buffer | null {
  try {
    return z32decode(text)
  } catch {
    return null
  }
}

export function toHex(buf: Uint8Array): string {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('hex')
}

/** Parses a 32-byte key from 64 hex characters; null otherwise. */
export function keyFromHex(hex: string): Buffer | null {
  return /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
}

function toBuffer(u: Uint8Array): Buffer {
  return Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength)
}
