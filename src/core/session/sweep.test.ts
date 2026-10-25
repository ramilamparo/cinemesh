import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { RoomStore } from '../net/identity.js'
import { sessionFilePath } from './session-file.js'
import { SweepKeep, isPartialDir, sweepPartialData } from './sweep.js'

const DAY = 24 * 3600 * 1000
const MIB = 1024 * 1024
const root = mkdtempSync(join(tmpdir(), 'wt-sweep-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
let userData = ''
let store = new RoomStore(root)
let downloads = ''
let now = 0

beforeEach(() => {
  const base = join(root, `case-${String(++seq)}`)
  userData = join(base, 'userData')
  downloads = join(base, 'downloads')
  store = new RoomStore(userData)
  now = Date.now()
})

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0')

/** A `.wt-partial/<infoHash>` folder laid out like TransferEngine's, every entry last changed `ageMs` ago. */
function partial(folder: string, infoHash: string, bytes: number, ageMs: number): string {
  const dir = join(folder, '.wt-partial', infoHash)
  mkdirSync(join(dir, 'seg'), { recursive: true })
  const files = [join(dir, 'meta.torrent'), join(dir, 'state.json'), join(dir, 'seg', '000000.part')]
  writeFileSync(files[0] as string, 'torrent')
  writeFileSync(files[1] as string, '{}')
  writeFileSync(files[2] as string, randomBytes(bytes))
  age([...files, join(dir, 'seg'), dir], ageMs)
  return dir
}

function age(paths: string[], ageMs: number): void {
  const t = (now - ageMs) / 1000
  for (const p of paths) utimesSync(p, t, t)
}

/** A viewer room record plus its session.json pointing at `transferDir`, last used `ageMs` ago. */
async function viewerRoom(
  transferDir: string,
  ageMs: number,
  joinedAgoMs = ageMs,
  /** other playlist items' folders (ADR 0011) */
  items: string[] = [],
): Promise<string> {
  const id = hex(++seq, 16)
  await store.save({
    id,
    secret: hex(1, 64),
    hostKey: hex(2, 64),
    name: 'room',
    keySeed: hex(3, 64),
    role: 'viewer',
    inviteEpoch: 0,
    lastJoined: now - joinedAgoMs,
  })
  const file = sessionFilePath(userData, id)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      role: 'viewer',
      roomId: id,
      fileName: 'movie.mkv',
      fileSize: 1,
      durationS: null,
      infoHash: transferDir.slice(-40),
      saveDir: join(transferDir, '..', '..'),
      transferDir,
      ...(items.length > 0
        ? {
            playlist: [transferDir, ...items].map((d, i) => ({
              id: hex(i, 12),
              name: `ep${String(i)}.mkv`,
              fileSize: 1,
              infoHash: d.slice(-40),
              transferDir: d,
              progress: 1,
            })),
          }
        : {}),
      updatedAt: now - ageMs,
    }),
  )
  return id
}

function sweep(
  opts: { capBytes?: number; keep?: string[] | SweepKeep; signal?: AbortSignal } = {},
): ReturnType<typeof sweepPartialData> {
  let keep = opts.keep
  if (!(keep instanceof SweepKeep)) {
    const ids = keep ?? []
    keep = new SweepKeep()
    for (const id of ids) keep.claim(id)
  }
  return sweepPartialData({
    userData,
    store,
    folders: [downloads],
    capBytes: opts.capBytes ?? 100e9,
    keep,
    now,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}

/** Holds the sweep inside its deletion of room `id` (folder gone, record not yet) until release(). */
function holdRemoval(id: string): { reached: Promise<void>; release: () => void } {
  let reach = (): void => undefined
  let release = (): void => undefined
  const reached = new Promise<void>((r) => (reach = r))
  const gate = new Promise<void>((r) => (release = r))
  const remove = store.remove.bind(store)
  store.remove = async (roomId) => {
    if (roomId === id) {
      reach()
      await gate
    }
    return remove(roomId)
  }
  return { reached, release }
}

describe('isPartialDir', () => {
  it('accepts only <folder>/.wt-partial/<40 lowercase hex>', () => {
    const h = 'a'.repeat(40)
    expect(isPartialDir(`/x/.wt-partial/${h}`)).toBe(true)
    expect(isPartialDir(`/x/.wt-partial/${h}/`)).toBe(true)
    expect(isPartialDir(`/x/other/${h}`)).toBe(false)
    expect(isPartialDir(`/x/.wt-partial/${'a'.repeat(39)}`)).toBe(false)
    expect(isPartialDir(`/x/.wt-partial/${'A'.repeat(40)}`)).toBe(false)
    expect(isPartialDir(`/x/.wt-partial/${h}/..`)).toBe(false)
    expect(isPartialDir(`/x/.wt-partial/${h}/../../home`)).toBe(false)
  })
})

describe('sweepPartialData', () => {
  it('deletes downloads unused for 7 days together with their room records, and keeps the rest', async () => {
    const old = partial(downloads, hex(1, 40), MIB, 8 * DAY)
    const fresh = partial(downloads, hex(2, 40), MIB, DAY)
    const oldRoom = await viewerRoom(old, 8 * DAY)
    const freshRoom = await viewerRoom(fresh, DAY)

    const swept = await sweep()
    expect(swept.map((s) => [s.dir, s.roomIds, s.why])).toEqual([[old, [oldRoom], 'age']])
    expect(existsSync(old)).toBe(false)
    expect(await store.load(oldRoom)).toBeNull()
    expect(existsSync(fresh)).toBe(true)
    expect(await store.load(freshRoom)).not.toBeNull()
  })

  it('counts a download as used when its session or any of its files changed recently', async () => {
    // an old session file, but the journal was just rewritten (still downloading)
    const journal = partial(downloads, hex(1, 40), MIB, 8 * DAY)
    await viewerRoom(journal, 8 * DAY)
    age([join(journal, 'state.json')], 60_000)
    // nobody's record: a segment was just written, or the torrent rewritten by a join (another profile)
    const segment = partial(downloads, hex(2, 40), MIB, 8 * DAY)
    age([join(segment, 'seg', '000000.part')], 60_000)
    const joined = partial(downloads, hex(3, 40), MIB, 8 * DAY)
    age([join(joined, 'meta.torrent')], 60_000)

    expect(await sweep()).toEqual([])
    for (const d of [journal, segment, joined]) expect(existsSync(d)).toBe(true)
  })

  it('over the cap, removes the least recently used first; rooms sharing a folder count once', async () => {
    const a = partial(downloads, hex(1, 40), MIB, 5 * DAY)
    const b = partial(downloads, hex(2, 40), MIB, 4 * DAY)
    const c = partial(downloads, hex(3, 40), MIB, 3 * DAY)
    const roomA = await viewerRoom(a, 5 * DAY)
    // two rooms with the same video and save folder: used as recently as the newer one
    const roomB1 = await viewerRoom(b, 6 * DAY)
    const roomB2 = await viewerRoom(b, 2 * DAY)
    const roomC = await viewerRoom(c, 3 * DAY)

    const swept = await sweep({ capBytes: 1.5 * MIB })
    expect(swept.map((s) => [s.dir, s.why])).toEqual([
      [a, 'cap'],
      [c, 'cap'],
    ])
    expect(existsSync(b)).toBe(true)
    expect(await store.load(roomA)).toBeNull()
    expect(await store.load(roomC)).toBeNull()
    expect(await store.load(roomB1)).not.toBeNull()
    expect(await store.load(roomB2)).not.toBeNull()
    expect(swept[0]?.bytes).toBeGreaterThanOrEqual(MIB)
  })

  it('never touches the room being resumed, nor counts it against the cap', async () => {
    const resumed = partial(downloads, hex(1, 40), 3 * MIB, 30 * DAY)
    const other = partial(downloads, hex(2, 40), MIB, DAY)
    const resumedRoom = await viewerRoom(resumed, 30 * DAY)
    await viewerRoom(other, DAY)

    expect(await sweep({ capBytes: 2 * MIB, keep: [resumedRoom] })).toEqual([])
    expect(existsSync(resumed)).toBe(true)
    expect(await store.load(resumedRoom)).not.toBeNull()
  })

  it('keeps a room the user resumes while it runs, but not one whose folder it is already deleting', async () => {
    const deleting = partial(downloads, hex(1, 40), MIB, 8 * DAY)
    const resumed = partial(downloads, hex(2, 40), MIB, 9 * DAY)
    const deletingRoom = await viewerRoom(deleting, 8 * DAY, 0) // listed, and so swept, first
    const resumedRoom = await viewerRoom(resumed, 9 * DAY)
    const held = holdRemoval(deletingRoom)
    const keep = new SweepKeep()

    const sweeping = sweep({ keep })
    await held.reached
    // too late for the first (its data is gone already), in time for the second
    expect(keep.claim(deletingRoom)).toBe(false)
    expect(keep.claim(resumedRoom)).toBe(true)
    held.release()
    expect((await sweeping).map((s) => s.roomIds)).toEqual([[deletingRoom]])
    expect(await store.load(deletingRoom)).toBeNull()
    expect(existsSync(join(resumed, 'seg', '000000.part'))).toBe(true)
    expect(await store.load(resumedRoom)).not.toBeNull()
  })

  it('stops counting a room resumed while it runs against the cap', async () => {
    const old = partial(downloads, hex(1, 40), MIB, 8 * DAY)
    const a = partial(downloads, hex(2, 40), MIB, 5 * DAY)
    const b = partial(downloads, hex(3, 40), MIB, 4 * DAY)
    const c = partial(downloads, hex(4, 40), MIB, 3 * DAY)
    const oldRoom = await viewerRoom(old, 8 * DAY)
    const roomA = await viewerRoom(a, 5 * DAY)
    await viewerRoom(b, 4 * DAY)
    await viewerRoom(c, 3 * DAY)
    // the age pass comes first: resume the least recently used room while it runs
    const held = holdRemoval(oldRoom)
    const keep = new SweepKeep()
    const sweeping = sweep({ keep, capBytes: 1.5 * MIB })
    await held.reached
    expect(keep.claim(roomA)).toBe(true)
    held.release()

    // without `a`, removing `b` brings the rest (`c`) under the cap
    expect((await sweeping).map((s) => [s.dir, s.why])).toEqual([
      [old, 'age'],
      [b, 'cap'],
    ])
    expect(existsSync(a)).toBe(true)
    expect(existsSync(c)).toBe(true)
  })

  it('sweeps folders no record points to by age only: they may belong to another profile', async () => {
    const orphan = partial(downloads, hex(1, 40), MIB, 8 * DAY)
    // another profile's download in the same folder, bigger than our whole cap
    const theirs = partial(downloads, hex(2, 40), 3 * MIB, 0)
    const ours = partial(downloads, hex(3, 40), MIB, DAY)
    const ourRoom = await viewerRoom(ours, DAY)

    const swept = await sweep({ capBytes: 2 * MIB })
    expect(swept.map((s) => [s.dir, s.roomIds, s.why])).toEqual([[orphan, [], 'age']])
    expect(existsSync(theirs)).toBe(true)
    expect(existsSync(ours)).toBe(true)
    expect(await store.load(ourRoom)).not.toBeNull()
  })

  it('looks in every save folder a record names, besides the configured one', async () => {
    const elsewhere = join(root, `elsewhere-${String(seq)}`)
    const referenced = partial(elsewhere, hex(1, 40), MIB, DAY)
    await viewerRoom(referenced, DAY)
    const orphan = partial(elsewhere, hex(2, 40), MIB, 9 * DAY)

    const swept = await sweep()
    expect(swept.map((s) => s.dir)).toEqual([orphan])
  })

  it('deletes nothing but <folder>/.wt-partial/<infoHash> directories', async () => {
    // a session file pointing outside .wt-partial (corrupt or tampered)
    const videos = join(root, `videos-${String(seq)}`)
    mkdirSync(videos, { recursive: true })
    writeFileSync(join(videos, 'keep.mkv'), 'x')
    age([join(videos, 'keep.mkv'), videos], 30 * DAY)
    const strayRoom = await viewerRoom(videos, 30 * DAY)
    // not an infoHash, and a symlink to a folder elsewhere
    const notes = join(downloads, '.wt-partial', 'notes')
    mkdirSync(notes, { recursive: true })
    age([notes], 30 * DAY)
    const target = join(root, `target-${String(seq)}`)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'precious'), 'x')
    age([join(target, 'precious'), target], 30 * DAY)
    symlinkSync(target, join(downloads, '.wt-partial', hex(7, 40)))

    expect(await sweep({ capBytes: 1 })).toEqual([])
    expect(existsSync(join(videos, 'keep.mkv'))).toBe(true)
    expect(await store.load(strayRoom)).not.toBeNull()
    expect(existsSync(notes)).toBe(true)
    expect(existsSync(join(target, 'precious'))).toBe(true)
  })

  it('keeps the records of a folder it could not delete, and goes on with the others', async () => {
    const stuck = partial(downloads, hex(1, 40), MIB, 9 * DAY)
    const gone = partial(downloads, hex(2, 40), MIB, 8 * DAY)
    // listed first (most recently joined), so a failure that stopped the sweep would spare `gone`
    const stuckRoom = await viewerRoom(stuck, 9 * DAY, 0)
    const goneRoom = await viewerRoom(gone, 8 * DAY)
    chmodSync(join(stuck, 'seg'), 0o555)
    chmodSync(stuck, 0o555)
    try {
      const swept = await sweep()
      expect(swept.map((s) => s.dir)).toEqual([gone])
      expect(await store.load(stuckRoom)).not.toBeNull()
      expect(await store.load(goneRoom)).toBeNull()
      expect(existsSync(join(stuck, 'seg', '000000.part'))).toBe(true)
    } finally {
      chmodSync(stuck, 0o755)
      chmodSync(join(stuck, 'seg'), 0o755)
    }
  })

  it('never sweeps a download whose save a quit cut off, nor counts it against the cap', async () => {
    // half of each video is in the save folder already: the manager finishes them from these
    const saving = partial(downloads, hex(1, 40), 3 * MIB, 30 * DAY)
    const savingRoom = await viewerRoom(saving, 30 * DAY)
    const orphan = partial(downloads, hex(2, 40), MIB, 30 * DAY)
    for (const d of [saving, orphan]) writeFileSync(join(d, 'export.json'), '{}')
    const other = partial(downloads, hex(3, 40), MIB, DAY)
    const otherRoom = await viewerRoom(other, DAY)

    expect(await sweep({ capBytes: 2 * MIB })).toEqual([])
    for (const d of [saving, orphan, other]) expect(existsSync(join(d, 'seg', '000000.part'))).toBe(true)
    expect(await store.load(savingRoom)).not.toBeNull()
    expect(await store.load(otherRoom)).not.toBeNull()
  })

  it('leaves a folder that gains an export journal while it runs', async () => {
    const first = partial(downloads, hex(1, 40), MIB, 9 * DAY)
    const saving = partial(downloads, hex(2, 40), MIB, 8 * DAY)
    const firstRoom = await viewerRoom(first, 9 * DAY, 0) // listed, and so swept, first
    const savingRoom = await viewerRoom(saving, 8 * DAY)
    const held = holdRemoval(firstRoom)

    const sweeping = sweep()
    await held.reached
    writeFileSync(join(saving, 'export.json'), '{}')
    held.release()
    expect((await sweeping).map((s) => s.roomIds)).toEqual([[firstRoom]])
    expect(existsSync(join(saving, 'seg', '000000.part'))).toBe(true)
    expect(await store.load(savingRoom)).not.toBeNull()
  })

  it('deletes nothing once told to stop (a session is starting and may need a folder)', async () => {
    const old = partial(downloads, hex(1, 40), MIB, 8 * DAY)
    const room = await viewerRoom(old, 8 * DAY)
    expect(await sweep({ capBytes: 1, signal: AbortSignal.abort() })).toEqual([])
    expect(existsSync(old)).toBe(true)
    expect(await store.load(room)).not.toBeNull()
  })
})

describe('sweepPartialData with playlists (ADR 0011 §8)', () => {
  it("keeps a room's other items as long as the room, and sweeps them with it", async () => {
    const ep1 = partial(downloads, hex(11, 40), MIB, 9 * DAY)
    const ep2 = partial(downloads, hex(12, 40), MIB, DAY)
    const room = await viewerRoom(ep2, DAY, DAY, [ep1])
    // the room was used yesterday: its first episode stays, however old its files are
    expect(await sweep()).toEqual([])
    expect(existsSync(ep1)).toBe(true)

    const old1 = partial(downloads, hex(13, 40), MIB, 9 * DAY)
    const old2 = partial(downloads, hex(14, 40), MIB, 9 * DAY)
    const oldRoom = await viewerRoom(old2, 9 * DAY, 9 * DAY, [old1])
    const swept = await sweep()
    expect(swept.map((s) => s.dir).sort()).toEqual([old1, old2].sort())
    expect(existsSync(old1) || existsSync(old2)).toBe(false)
    expect(await store.load(oldRoom)).toBeNull()
    expect(await store.load(room)).not.toBeNull()
  })

  it("never touches a kept room's other items", async () => {
    const ep1 = partial(downloads, hex(21, 40), MIB, 9 * DAY)
    const ep2 = partial(downloads, hex(22, 40), MIB, 9 * DAY)
    const room = await viewerRoom(ep2, 9 * DAY, 9 * DAY, [ep1])
    expect(await sweep({ keep: [room] })).toEqual([])
    expect(existsSync(ep1) && existsSync(ep2)).toBe(true)
  })

  it("an earlier item's folder swept for the cap leaves the room's record", async () => {
    const ep1 = partial(downloads, hex(31, 40), 2 * MIB, 3 * DAY)
    const ep2 = partial(downloads, hex(32, 40), MIB, DAY)
    const room = await viewerRoom(ep2, DAY, DAY, [ep1])
    // both count as used when the room was: the earlier item goes first, and the room stays resumable
    const swept = await sweep({ capBytes: 2.5 * MIB })
    expect(swept.map((s) => [s.dir, s.roomIds])).toEqual([[ep1, []]])
    expect(existsSync(ep2)).toBe(true)
    expect(await store.load(room)).not.toBeNull()
  })
})
