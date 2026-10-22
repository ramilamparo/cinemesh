// Moves Tags, Attachments and Chapters after the last Cluster (mkvmerge-style tail layout):
// each is replaced in place by a Void of the same size (so no Cluster/Cues offset changes), appended
// at the end of the Segment, and the SeekHead is rebuilt inside its old span (SeekHead + adjacent Void).
import { readFileSync, writeFileSync } from 'node:fs'
import { readMkv, ID, element, encodeId, uintData, voidOf, encodeSize } from './ebml.js'

const [src, dst] = process.argv.slice(2)
const buf = readFileSync(src)
const l = readMkv(src)
const MOVE = ['Tags', 'Attachments', 'Chapters']
const moved: Buffer[] = []
const newPos: Record<string, number> = {}
let tail = buf.length
for (const e of l.level1) {
  if (!MOVE.includes(e.name)) continue
  if (e.pos > l.firstCluster) continue
  const bytes = Buffer.from(buf.subarray(e.pos, e.end))
  voidOf(e.end - e.pos).copy(buf, e.pos)
  newPos[e.name] = tail - l.segmentDataPos
  tail += bytes.length
  moved.push(bytes)
}
// Rebuild SeekHead with 8-byte positions.
const sh = l.level1.find(e => e.name === 'SeekHead')!
const shIdx = l.level1.indexOf(sh)
const after = l.level1[shIdx + 1]
const span = (after?.name === 'Void' ? after.end : sh.end) - sh.pos
const nameToId: Record<string, number> = { Info: ID.Info, Tracks: ID.Tracks, Cues: ID.Cues, Tags: ID.Tags, Attachments: ID.Attachments, Chapters: ID.Chapters }
const entries = l.seekHead.filter(s => nameToId[s.id] !== undefined).map(s => ({ id: s.id, rel: newPos[s.id] ?? (s.pos - l.segmentDataPos) }))
for (const n of Object.keys(newPos)) if (!entries.find(e => e.id === n)) entries.push({ id: n, rel: newPos[n] })
const seeks = entries.map(e => element(ID.Seek, Buffer.concat([element(ID.SeekID, encodeId(nameToId[e.id]), 1), element(ID.SeekPosition, uintData(e.rel), 1)]), 1))
const shBytes = element(ID.SeekHead, Buffer.concat(seeks))
if (shBytes.length + 2 > span) throw new Error(`SeekHead ${shBytes.length} does not fit in ${span}`)
Buffer.concat([shBytes, voidOf(span - shBytes.length)]).copy(buf, sh.pos)
// Segment size (ffmpeg writes an 8-byte size).
const segSizePos = l.segmentDataPos - 8
if (buf[segSizePos] !== 0x01) throw new Error("expected an 8-byte Segment size")
encodeSize(tail - l.segmentDataPos, 8).copy(buf, segSizePos)
writeFileSync(dst, Buffer.concat([buf, ...moved]))
console.log('moved', Object.keys(newPos), 'seekhead', entries)
