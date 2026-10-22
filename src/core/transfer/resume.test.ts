import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Journal } from './journal.js'
import { checkResume, trustedBytes } from './resume.js'
import { SEGMENT_BYTES, segmentName } from './segment-store.js'

const root = mkdtempSync(join(tmpdir(), 'wt-resume-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

// 11 pieces in 3 segments of 4 pieces; the last piece is short
const P = 1024
const S = 4 * P
const LENGTH = 10 * P + 100
const COUNT = 11
const data = randomBytes(LENGTH)
const pieces = Array.from({ length: COUNT }, (_, i) =>
  createHash('sha1')
    .update(data.subarray(i * P, Math.min((i + 1) * P, LENGTH)))
    .digest('hex'),
)
const layout = { pieceLength: P, length: LENGTH, pieces, segmentBytes: S }

/** A complete download on disk whose journal claims every piece and lists `recent`. */
async function complete(name: string, recent: number[]): Promise<{ dir: string; journal: Journal }> {
  const dir = join(root, name)
  mkdirSync(join(dir, 'seg'), { recursive: true })
  for (let k = 0; k * S < LENGTH; k++) {
    writeFileSync(join(dir, 'seg', segmentName(k)), data.subarray(k * S, Math.min((k + 1) * S, LENGTH)))
  }
  const j = await Journal.open(join(dir, 'state.json'), 'ab', COUNT)
  for (let i = 0; i < COUNT; i++) j.mark(i)
  j.setRecent(recent)
  await j.save()
  return { dir, journal: await Journal.open(join(dir, 'state.json'), 'ab', COUNT) }
}

/** Flips one byte inside a piece: same size, wrong hash (a write the disk acknowledged but lost). */
function corrupt(dir: string, piece: number): void {
  const k = Math.floor((piece * P) / S)
  const fd = openSync(join(dir, 'seg', segmentName(k)), 'r+')
  writeSync(fd, Buffer.from([(data[piece * P + 5] ?? 0) ^ 0xff]), 0, 1, piece * P - k * S + 5)
  closeSync(fd)
}

const claimed = (j: Journal): number[] => Array.from({ length: COUNT }, (_, i) => i).filter((i) => j.has(i))

describe('checkResume', () => {
  it('trusts an intact download and changes nothing', async () => {
    const { dir, journal } = await complete('intact', [2, 3, 6, 7, 10])
    expect(await checkResume(journal, dir, layout)).toBe(0)
    expect(claimed(journal)).toHaveLength(COUNT)
  })

  it('clears pieces whose segment is missing or too short, and saves that', async () => {
    const { dir, journal } = await complete('missing', [])
    rmSync(join(dir, 'seg', segmentName(1))) // pieces 4-7
    truncateSync(join(dir, 'seg', segmentName(2)), P + 10) // piece 8 still fits; 9 and 10 do not
    expect(await checkResume(journal, dir, layout)).toBe(6)
    expect(claimed(journal)).toEqual([0, 1, 2, 3, 8])
    expect(claimed(await Journal.open(join(dir, 'state.json'), 'ab', COUNT))).toEqual([0, 1, 2, 3, 8])
  })

  it("re-hashes a dirty segment's last 2 pieces, and every piece of it once one fails", async () => {
    // segment 0 last verified 1 then 3 (0 earlier); segment 1 last verified 6; segment 2 not dirty
    const { dir, journal } = await complete('rehash', [0, 1, 3, 6])
    corrupt(dir, 3) // recent: caught
    corrupt(dir, 2) // not recent, same segment: caught by the full check
    corrupt(dir, 5) // segment 1's recent piece is fine, so it is not searched (bounded work)
    corrupt(dir, 9) // segment 2 was not written lately: left to WebTorrent's own probe
    expect(await checkResume(journal, dir, layout)).toBe(2)
    expect(claimed(journal)).toEqual([0, 1, 4, 5, 6, 7, 8, 9, 10])
    expect(claimed(await Journal.open(join(dir, 'state.json'), 'ab', COUNT))).toEqual([0, 1, 4, 5, 6, 7, 8, 9, 10])
  })

  it('checks the short last piece by its real length', async () => {
    const { dir, journal } = await complete('last', [10])
    expect(await checkResume(journal, dir, layout)).toBe(0)
    corrupt(dir, 10)
    expect(await checkResume(journal, dir, layout)).toBe(1)
    expect(journal.has(10)).toBe(false)
  })
})

describe('trustedBytes (JoinConfirm)', () => {
  // the real 64 MiB segments, as sparse files: 4 pieces of 16 MiB each, the last piece 100 bytes
  const BIG = SEGMENT_BYTES / 4
  const torrent = { infoHash: 'cd', pieceLength: BIG, pieceCount: 10, length: 9 * BIG + 100 }
  const sparse = (dir: string, k: number, size: number): void => {
    writeFileSync(join(dir, 'seg', segmentName(k)), '')
    truncateSync(join(dir, 'seg', segmentName(k)), size)
  }

  it('counts claimed pieces whose segment holds all their bytes, and nothing else', async () => {
    const dir = join(root, 'trusted')
    mkdirSync(join(dir, 'seg'), { recursive: true })
    const j = await Journal.open(join(dir, 'state.json'), 'cd', 10)
    for (let i = 0; i < 10; i++) if (i !== 2) j.mark(i) // piece 2 was never journaled
    await j.save()
    sparse(dir, 0, SEGMENT_BYTES) // pieces 0-3
    // segment 1 (pieces 4-7) is missing
    sparse(dir, 2, BIG + 99) // piece 8 fits; the short last piece 9 needs BIG + 100
    const before = readFileSync(join(dir, 'state.json'))
    const mtime = statSync(join(dir, 'state.json')).mtimeMs
    expect(await trustedBytes(dir, torrent)).toBe(4 * BIG) // pieces 0, 1, 3 and 8
    sparse(dir, 2, BIG + 100)
    expect(await trustedBytes(dir, torrent)).toBe(4 * BIG + 100)
    // read-only: the journal is untouched (checkResume would have cleared 4-7 and saved)
    expect(readFileSync(join(dir, 'state.json')).equals(before)).toBe(true)
    expect(statSync(join(dir, 'state.json')).mtimeMs).toBe(mtime)
    expect(readdirSync(dir).sort()).toEqual(['seg', 'state.json'])
  })

  it('trusts nothing in a missing folder, another torrent, or an inconsistent layout, and creates nothing', async () => {
    const missing = join(root, 'never-joined')
    expect(await trustedBytes(missing, torrent)).toBe(0)
    expect(existsSync(missing)).toBe(false)
    const dir = join(root, 'trusted')
    expect(await trustedBytes(dir, { ...torrent, infoHash: 'ef' })).toBe(0)
    expect(await trustedBytes(dir, { ...torrent, pieceCount: 11 })).toBe(0)
    expect(await trustedBytes(dir, { ...torrent, pieceLength: 0 })).toBe(0)
  })
})
