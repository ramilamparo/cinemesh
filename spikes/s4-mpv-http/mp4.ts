// Minimal ISO-BMFF top-level box walker (handles largesize and size 0) + sidx reader.
import { Reader } from './ebml.js'

export interface Box { type: string, pos: number, end: number, headerLen: number }

export function topBoxes (path: string): Box[] {
  const r = new Reader(path)
  try {
    const out: Box[] = []
    let p = 0
    while (p + 8 <= r.size) {
      const h = r.read(p, 16)
      let size = h.readUInt32BE(0)
      const type = h.toString('latin1', 4, 8)
      let headerLen = 8
      if (size === 1) { size = Number(h.readBigUInt64BE(8)); headerLen = 16 } else if (size === 0) size = r.size - p
      out.push({ type, pos: p, end: p + size, headerLen })
      if (size < 8) break
      p += size
    }
    return out
  } finally { r.close() }
}

// sidx (v0/v1): returns the absolute byte ranges of each referenced subsegment.
export function readSidx (path: string, box: Box) {
  const r = new Reader(path)
  try {
    const b = r.read(box.pos, box.end - box.pos)
    let o = box.headerLen
    const version = b[o]; o += 4
    o += 4 // reference_ID
    const timescale = b.readUInt32BE(o); o += 4
    let ept: number; let first: number
    if (version === 0) { ept = b.readUInt32BE(o); first = b.readUInt32BE(o + 4); o += 8 } else { ept = Number(b.readBigUInt64BE(o)); first = Number(b.readBigUInt64BE(o + 8)); o += 16 }
    o += 2
    const count = b.readUInt16BE(o); o += 2
    let pos = box.end + first
    let t = ept
    const refs: { tMs: number, pos: number, end: number }[] = []
    for (let i = 0; i < count; i++) {
      const size = b.readUInt32BE(o) & 0x7fffffff
      const dur = b.readUInt32BE(o + 4)
      refs.push({ tMs: t / timescale * 1000, pos, end: pos + size })
      pos += size; t += dur; o += 12
    }
    return refs
  } finally { r.close() }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const boxes = topBoxes(process.argv[2])
  const counts: Record<string, number> = {}
  for (const b of boxes) counts[b.type] = (counts[b.type] ?? 0) + 1
  console.log(JSON.stringify({ counts, first: boxes.slice(0, 8), last: boxes.slice(-3) }))
}
