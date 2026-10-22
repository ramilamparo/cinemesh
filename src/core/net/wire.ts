import { CodedError } from '../../shared/result.js'
import { NET_ERRORS } from './errors.js'

// Lane names, limits and frame codecs of the peer wire (plan §5.2). Frames are JSON carried as c.raw so the
// byte limits are enforced before parsing.

export const AUTH_PROTOCOL = 'wtp/auth/1'
export const CTRL_PROTOCOL = 'wtp/ctrl/1'
export const WIRE_VERSION = 1

export const HELLO_MAX_BYTES = 4 * 1024
/** The auth lane also hands a pending joiner the host-signed members list, which can exceed the Hello limit. */
export const AUTH_MAX_BYTES = 16 * 1024
export const CTRL_MAX_BYTES = 64 * 1024
export const NAME_MAX_BYTES = 32

/** First byte of every sync datagram ([0x53][ver][type], plan §5.2). */
export const DATAGRAM_SYNC = 0x53

export type Frame = Record<string, unknown>

export function encodeFrame(frame: Frame, maxBytes: number): Buffer {
  const buf = Buffer.from(JSON.stringify(frame))
  if (buf.byteLength > maxBytes) {
    throw new CodedError(
      NET_ERRORS.frameTooLarge,
      `frame of ${String(buf.byteLength)} bytes exceeds ${String(maxBytes)}`,
    )
  }
  return buf
}

/** Throws (CodedError frameTooLarge) above the limit; null for anything that is not a JSON object. */
export function decodeFrame(buf: Uint8Array, maxBytes: number): Frame | null {
  if (buf.byteLength > maxBytes) {
    throw new CodedError(
      NET_ERRORS.frameTooLarge,
      `frame of ${String(buf.byteLength)} bytes exceeds ${String(maxBytes)}`,
    )
  }
  try {
    const value: unknown = JSON.parse(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Frame) : null
  } catch {
    return null
  }
}

/** Auth channel handshake: [version][proof 32][previous-epoch proof 32]? */
export function encodeAuthHandshake(proof: Uint8Array, previous: Uint8Array | null): Buffer {
  return Buffer.concat([Buffer.from([WIRE_VERSION]), proof, ...(previous ? [previous] : [])])
}

export function decodeAuthHandshake(buf: unknown): { version: number; proofs: Buffer[] } | null {
  if (!(buf instanceof Uint8Array) || (buf.byteLength !== 33 && buf.byteLength !== 65)) return null
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  const proofs = [b.subarray(1, 33)]
  if (b.byteLength === 65) proofs.push(b.subarray(33, 65))
  return { version: b[0] ?? 0, proofs }
}

export interface Hello {
  proto: number
  app: string
  name: string
  caps: string[]
}

export function parseHello(frame: Frame): Hello | null {
  const { proto, app, name, caps } = frame
  if (typeof proto !== 'number' || typeof app !== 'string' || typeof name !== 'string') return null
  if (!Array.isArray(caps) || !caps.every((c): c is string => typeof c === 'string')) return null
  return { proto, app: app.slice(0, 32), name: clampName(name), caps: caps.slice(0, 32) }
}

/** Display names are at most 32 bytes of UTF-8, cut at a character boundary. */
export function clampName(name: string): string {
  return truncateUtf8(name.trim(), NAME_MAX_BYTES).toString('utf8').trim() || 'Friend'
}

/** UTF-8 bytes of `text`, cut to at most `maxBytes` without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): Buffer {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return buf
  let end = maxBytes
  // step back over continuation bytes (10xxxxxx) to the start of the cut code point
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
  return buf.subarray(0, end)
}
