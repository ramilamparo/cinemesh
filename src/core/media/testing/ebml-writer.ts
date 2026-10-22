// Test-only EBML writer: builds synthetic Matroska files for the parser tests and rewrites ffmpeg
// output into layouts ffmpeg does not produce (tail Tags/Attachments). Not used by the app.

export function idBytes(id: number): number[] {
  const out: number[] = []
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return out
}

/** 8-byte size vint (what ffmpeg writes for the Segment). */
export function size8(n: number): number[] {
  const out = [0x01]
  for (let i = 6; i >= 0; i--) out.push(Math.floor(n / 2 ** (8 * i)) % 256)
  return out
}

export function sizeVint(n: number): number[] {
  if (n < 0x7f) return [0x80 | n]
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff]
  return size8(n)
}

export const UNKNOWN_SIZE = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]

export function concat(parts: readonly (Uint8Array | number[])[]): Uint8Array {
  const arrs = parts.map((p) => (p instanceof Uint8Array ? p : Uint8Array.from(p)))
  const out = new Uint8Array(arrs.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of arrs) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function el(id: number, ...body: (Uint8Array | number[])[]): Uint8Array {
  const data = concat(body)
  return concat([idBytes(id), sizeVint(data.length), data])
}

/** Element with an 8-byte size field, so it can be patched in place later. */
export function el8(id: number, ...body: (Uint8Array | number[])[]): Uint8Array {
  const data = concat(body)
  return concat([idBytes(id), size8(data.length), data])
}

export function elUnknown(id: number, ...body: (Uint8Array | number[])[]): Uint8Array {
  return concat([idBytes(id), UNKNOWN_SIZE, ...body])
}

export function uint(n: number): Uint8Array {
  const out: number[] = []
  for (let v = n; v > 0 || out.length === 0; v = Math.floor(v / 256)) out.unshift(v % 256)
  return Uint8Array.from(out)
}

export function str(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function float64(v: number): Uint8Array {
  const b = new Uint8Array(8)
  new DataView(b.buffer).setFloat64(0, v)
  return b
}

export function voidOf(total: number): Uint8Array {
  const out = new Uint8Array(total)
  out[0] = 0xec
  if (total - 2 < 127) out[1] = 0x80 | (total - 2)
  else out.set(size8(total - 9), 1)
  return out
}

/** SimpleBlock body: track vint, int16 relative timestamp, flags, payload. */
export function simpleBlock(track: number, rel: number, key: boolean, payload = 16): Uint8Array {
  const b = new Uint8Array(4 + payload)
  b[0] = 0x80 | track
  new DataView(b.buffer).setInt16(1, rel)
  b[3] = key ? 0x80 : 0
  return b
}
