// A relay key is a 32-byte public key. People paste it as 64 hex characters or as z-base-32 (52 characters,
// what Holepunch tools print). Settings stores lowercase hex.

const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769'

export type RelayKeyResult = { ok: true; hex: string | null } | { ok: false; message: string }

export function normalizeRelayKey(input: string): RelayKeyResult {
  const text = input.trim()
  if (text === '') return { ok: true, hex: null }
  if (/^[0-9a-fA-F]{64}$/.test(text)) return { ok: true, hex: text.toLowerCase() }
  const bytes = decodeZ32(text.toLowerCase())
  if (bytes?.length === 32) return { ok: true, hex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') }
  return { ok: false, message: 'Paste the relay key as 64 hex characters or 52 z-base-32 characters.' }
}

export function decodeZ32(text: string): Uint8Array | null {
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of text) {
    const v = Z32_ALPHABET.indexOf(ch)
    if (v < 0) return null
    buffer = (buffer << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
    buffer &= (1 << bits) - 1
  }
  return Uint8Array.from(out)
}

export function encodeZ32(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const b of bytes) {
    buffer = (buffer << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += Z32_ALPHABET.charAt((buffer >> bits) & 31)
    }
    buffer &= (1 << bits) - 1
  }
  if (bits > 0) out += Z32_ALPHABET.charAt((buffer << (5 - bits)) & 31)
  return out
}
