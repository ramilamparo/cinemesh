import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Journal, bitGet } from './journal.js'
import { ReadOnlyFileStore } from './readonly-store.js'
import { SegmentStore, segmentName } from './segment-store.js'
import { SourceFiles } from './source-files.js'

const dir = mkdtempSync(join(tmpdir(), 'wt-stores-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const get = (store: { get: ReadOnlyFileStore['get'] }, i: number, opts?: { offset?: number; length?: number }) =>
  new Promise<Buffer>((resolve, reject) => {
    store.get(i, opts ?? null, (e, b) => (e ? reject(e) : resolve(b ?? Buffer.alloc(0))))
  })
const put = (store: SegmentStore, i: number, b: Buffer) =>
  new Promise<void>((resolve, reject) => store.put(i, b, (e) => (e ? reject(e) : resolve())))

describe('ReadOnlyFileStore', () => {
  const a = randomBytes(1000)
  const b = randomBytes(300)
  writeFileSync(join(dir, 'a'), a)
  writeFileSync(join(dir, 'b'), b)
  const source = new SourceFiles([
    { path: join(dir, 'a'), offset: 0, length: 1000, mtimeMs: 0 },
    { path: join(dir, 'b'), offset: 1000, length: 300, mtimeMs: 0 },
  ])
  const store = new ReadOnlyFileStore(512, { source, length: 1300 })
  const all = Buffer.concat([a, b])

  it('serves chunks across file boundaries, including the short last chunk', async () => {
    expect((await get(store, 0)).equals(all.subarray(0, 512))).toBe(true)
    expect((await get(store, 1)).equals(all.subarray(512, 1024))).toBe(true)
    expect((await get(store, 2)).equals(all.subarray(1024))).toBe(true)
    expect((await get(store, 1, { offset: 400, length: 100 })).equals(all.subarray(912, 1012))).toBe(true)
  })

  it('refuses writes and bad ranges', async () => {
    const write = new Promise<void>((res, rej) => store.put(0, Buffer.alloc(512), (e) => (e ? rej(e) : res())))
    await expect(write).rejects.toThrow(/read-only/)
    await expect(get(store, 3)).rejects.toThrow()
    await expect(get(store, 2, { offset: 0, length: 500 })).rejects.toThrow()
  })

  it('reports content changes and moves', async () => {
    const f = join(dir, 'watched')
    writeFileSync(f, 'abc')
    const { mtimeMs } = await import('node:fs').then((fs) => fs.statSync(f))
    const watched = new SourceFiles([{ path: f, offset: 0, length: 3, mtimeMs }])
    expect(await watched.check()).toEqual({ kind: 'ok' })
    writeFileSync(f, 'abcd')
    expect((await watched.check()).kind).toBe('changed')
    await watched.close()
    await source.close()
  })

  it('reports an edited later file as changed even after an earlier file moved', async () => {
    const video = join(dir, 'moved-video')
    const subtitle = join(dir, 'edited-subtitle')
    writeFileSync(video, 'video bytes')
    writeFileSync(subtitle, 'sub one')
    const { statSync } = await import('node:fs')
    const watched = new SourceFiles([
      { path: video, offset: 0, length: 11, mtimeMs: statSync(video).mtimeMs },
      { path: subtitle, offset: 11, length: 7, mtimeMs: statSync(subtitle).mtimeMs },
    ])
    await watched.openAll()
    renameSync(video, `${video}.renamed`)
    expect(await watched.check()).toEqual({ kind: 'moved', index: 0 })
    writeFileSync(subtitle, 'sub two') // saved in place: same inode and length, new bytes
    utimesSync(subtitle, new Date(), new Date(Date.now() + 5000)) // an editor's save moves mtime on
    expect(await watched.check()).toEqual({ kind: 'changed', index: 1 })
    await watched.close()
  })
})

describe('SegmentStore', () => {
  const P = 1024
  const length = 10 * P + 100

  it('round-trips pieces across small segments and reports missing segments as errors', async () => {
    const sdir = join(dir, 'seg-a')
    const store = new SegmentStore(P, { dir: sdir, length, segmentBytes: 4 * P })
    const p3 = randomBytes(P)
    const last = randomBytes(100)
    await put(store, 3, p3)
    await put(store, 10, last)
    expect((await get(store, 3)).equals(p3)).toBe(true)
    expect((await get(store, 10)).equals(last)).toBe(true)
    expect((await get(store, 3, { offset: 10, length: 20 })).equals(p3.subarray(10, 30))).toBe(true)
    await expect(get(store, 5)).rejects.toThrow() // segment 1 never written
    await expect(put(store, 2, randomBytes(10))).rejects.toThrow() // wrong size
    expect(await store.syncDirty()).toEqual(expect.arrayContaining([0, 2]))
    await new Promise<void>((r) => store.close(() => r()))
  })

  it('treats a truncated segment as missing data', async () => {
    const sdir = join(dir, 'seg-b')
    const store = new SegmentStore(P, { dir: sdir, length, segmentBytes: 4 * P })
    await put(store, 1, randomBytes(P))
    await new Promise<void>((r) => store.close(() => r()))
    truncateSync(join(sdir, 'seg', segmentName(0)), P + 10)
    const reopened = new SegmentStore(P, { dir: sdir, length, segmentBytes: 4 * P })
    await expect(get(reopened, 1)).rejects.toThrow(/short/)
    await new Promise<void>((r) => reopened.destroy(() => r()))
    expect(existsSync(join(sdir, 'seg'))).toBe(false)
  })

  it('requires the segment size to be a multiple of the piece length', () => {
    expect(() => new SegmentStore(P, { dir, length, segmentBytes: 3000 })).toThrow()
  })
})

describe('Journal', () => {
  it('persists a bitfield in BitTorrent order and ignores journals of other torrents', async () => {
    const file = join(dir, 'state.json')
    const j = await Journal.open(file, 'aa', 20)
    j.mark(0)
    j.mark(9)
    j.mark(19)
    await j.save()
    const again = await Journal.open(file, 'aa', 20)
    expect(again.count()).toBe(3)
    const bits = again.bitfield()
    expect(bits[0]).toBe(0b1000_0000)
    expect(bits[1]).toBe(0b0100_0000)
    expect(bitGet(bits, 19)).toBe(true)
    expect((await Journal.open(file, 'bb', 20)).count()).toBe(0)
    expect((await Journal.open(file, 'aa', 21)).count()).toBe(0)
  })
})

describe('safeFileName', () => {
  it('neutralises traversal, separators, reserved and invalid names', async () => {
    const { safeFileName } = await import('./safe-name.js')
    expect(safeFileName('../../../.config/autostart/x.desktop', 'f')).toBe('x.desktop')
    expect(safeFileName('..\\..\\AppData\\evil.bat', 'f')).toBe('evil.bat')
    expect(safeFileName('..', 'fallback')).toBe('fallback')
    expect(safeFileName('', 'fallback')).toBe('fallback')
    expect(safeFileName('CON.srt', 'sub.srt')).toBe('sub.srt')
    expect(safeFileName('a:b<c>|?.mkv', 'f')).toBe('a_b_c___.mkv')
    expect(safeFileName('movie.mkv. . ', 'f')).toBe('movie.mkv')
    expect(Buffer.byteLength(safeFileName(`${'é'.repeat(300)}.mkv`, 'f'))).toBeLessThanOrEqual(200)
    expect(safeFileName(`${'é'.repeat(300)}.mkv`, 'f').endsWith('.mkv')).toBe(true)
  })
})

describe('SegmentStore durability and backpressure', () => {
  const P = 1024
  const length = 10 * P + 100
  const close = (store: SegmentStore) => new Promise<void>((r) => store.close(() => r()))
  const handleOf = async (store: SegmentStore, segment: number): Promise<FileHandle> => {
    const fd = await (store as unknown as { fds: Map<number, Promise<FileHandle>> }).fds.get(segment)
    if (!fd) throw new Error('segment not open')
    return fd
  }

  it('reports write lag above 64 MiB in flight and recovery below 16 MiB, never from inside put()', async () => {
    const big = 4 * 1024 * 1024
    const events: boolean[] = []
    let inPut = false
    const store = new SegmentStore(big, {
      dir: join(dir, 'seg-lag'),
      length: 20 * big,
      onWriteLag: (lagging) => events.push(inPut ? !lagging : lagging), // a call from inside put() shows inverted
    })
    const buf = Buffer.alloc(big)
    const puts: Promise<void>[] = []
    for (let i = 0; i < 17; i++) {
      inPut = true
      puts.push(put(store, i, buf)) // 17 x 4 MiB queued before any write completes
      inPut = false
    }
    await Promise.resolve()
    expect(events).toEqual([true])
    await Promise.all(puts)
    await Promise.resolve()
    expect(events).toEqual([true, false])
    await close(store)
  })

  it('retries creating seg/ after a failed mkdir instead of failing every later write', async () => {
    const sdir = join(dir, 'seg-mkdir')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'seg'), 'a file where the directory should be')
    const store = new SegmentStore(P, { dir: sdir, length, segmentBytes: 4 * P })
    await expect(put(store, 0, randomBytes(P))).rejects.toThrow()
    rmSync(join(sdir, 'seg'))
    await put(store, 0, randomBytes(P))
    await close(store)
  })

  it('keeps a segment whose sync failed dirty until a later sync succeeds (the journal must not claim it)', async () => {
    const store = new SegmentStore(P, { dir: join(dir, 'seg-syncfail'), length, segmentBytes: 4 * P })
    await put(store, 1, randomBytes(P)) // segment 0
    await put(store, 5, randomBytes(P)) // segment 1
    const fh = await handleOf(store, 0)
    const real = fh.datasync.bind(fh)
    fh.datasync = () => Promise.reject(new Error('EIO'))
    await expect(store.syncDirty()).rejects.toThrow('EIO')
    expect(store.syncFailed(1)).toBe(true)
    expect(store.syncFailed(5)).toBe(false)
    fh.datasync = real
    expect(await store.syncDirty()).toEqual([0])
    expect(store.syncFailed(1)).toBe(false)
    await close(store)
  })

  it('serializes syncs: a second caller never sees a segment as synced while the first still syncs it', async () => {
    const store = new SegmentStore(P, { dir: join(dir, 'seg-syncrace'), length, segmentBytes: 4 * P })
    await put(store, 1, randomBytes(P))
    const fh = await handleOf(store, 0)
    const real = fh.datasync.bind(fh)
    let release: () => void = () => undefined
    fh.datasync = () => new Promise<void>((r) => (release = r)).then(real)
    const order: string[] = []
    const a = store.syncDirty().then(() => order.push('a'))
    const b = store.syncDirty().then(() => order.push('b'))
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual([])
    release()
    await Promise.all([a, b])
    expect(order).toEqual(['a', 'b'])
    await close(store)
  })
})

describe('Journal saves', () => {
  it('serializes overlapping saves through the one tmp file, and both land', async () => {
    const file = join(dir, 'state-race.json')
    const j = await Journal.open(file, 'ab', 100)
    j.mark(1)
    const first = j.save()
    j.mark(2)
    const second = j.save()
    await expect(Promise.all([first, second])).resolves.toBeDefined()
    const again = await Journal.open(file, 'ab', 100)
    expect([again.has(1), again.has(2)]).toEqual([true, true])
  })

  it('retries a failed save with the next one', async () => {
    const sub = join(dir, 'not-yet')
    const file = join(sub, 'state.json')
    const j = await Journal.open(file, 'ab', 10)
    j.mark(3)
    await expect(j.save()).rejects.toThrow()
    mkdirSync(sub)
    await j.save()
    expect((await Journal.open(file, 'ab', 10)).has(3)).toBe(true)
  })

  it('persists the recent pieces still claimed, and reads back only valid ones', async () => {
    const file = join(dir, 'state-recent.json')
    const j = await Journal.open(file, 'ab', 10)
    j.mark(2)
    j.mark(7)
    j.setRecent([2, 5, 7])
    await j.save()
    expect((await Journal.open(file, 'ab', 10)).recent()).toEqual([2, 7])
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...saved, recent: [1, -1, 10, 2.5, 'x'] }))
    expect((await Journal.open(file, 'ab', 10)).recent()).toEqual([1])
  })
})
