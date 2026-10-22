import { lstat, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { RoomStore } from '../net/identity.js'
import { EXPORT_FILE } from '../transfer/save-file.js'
import { readSessionFile } from './session-file.js'

const MAX_AGE_MS = 7 * 24 * 3600 * 1000
const PARTIAL = '.wt-partial'

/** Only `<folder>/.wt-partial/<infoHash>` is ever deleted recursively, whatever a session file says. */
export function isPartialDir(dir: string): boolean {
  const d = resolve(dir)
  return /^[0-9a-f]{40}$/.test(basename(d)) && basename(dirname(d)) === PARTIAL
}

/**
 * The rooms the sweep leaves alone: the one that was open when core died, and any the user resumes while
 * it runs. A room can be kept until the sweep starts deleting its folder; claim() says whether it was in time.
 */
export class SweepKeep {
  private readonly kept = new Set<string>()
  private readonly deleting = new Set<string>()

  /** Keep a room's folder and record from now on; false when the sweep is deleting them already. */
  claim(roomId: string): boolean {
    if (this.deleting.has(roomId)) return false
    this.kept.add(roomId)
    return true
  }

  has(roomId: string): boolean {
    return this.kept.has(roomId)
  }

  /** Runs `remove` unless one of the rooms is kept; until it ends, they cannot be claimed. */
  async unlessKept(roomIds: readonly string[], remove: () => Promise<boolean>): Promise<boolean> {
    if (roomIds.some((id) => this.kept.has(id))) return false
    for (const id of roomIds) this.deleting.add(id)
    try {
      return await remove()
    } finally {
      for (const id of roomIds) this.deleting.delete(id)
    }
  }
}

interface Group {
  dir: string
  roomIds: string[]
  usedAt: number
  bytes: number
}

export interface SweptDir {
  dir: string
  roomIds: string[]
  bytes: number
  why: 'age' | 'cap'
}

/**
 * Startup sweep (plan §4.2 "Leaving"): kept partial downloads unused for 7 days go first, then the least
 * recently used until the rest fits in the cap. Rooms sharing a folder (same video, same save folder)
 * count as one entry, used as recently as the newest of them. The room records go with their data, so
 * Recent rooms never offers resuming a deleted download. Folders no record points to are swept by age
 * only and never count against the cap: another profile sharing the save folder may be using them.
 * A folder holding an export journal is never swept, nor counted: it is half of a video a quit or a crash
 * cut off while saving, whose other half is already in the save folder (the manager finishes it).
 */
export async function sweepPartialData(opts: {
  userData: string
  store: RoomStore
  /** save folders to look in for unreferenced downloads, besides the ones the records name */
  folders: readonly string[]
  capBytes: number
  /** rooms in use (the one being resumed, or resumed while the sweep runs): their folders are never touched */
  keep: SweepKeep
  now: number
  /** aborted: delete nothing more (a session is starting and may need one of these folders) */
  signal?: AbortSignal
}): Promise<SweptDir[]> {
  const groups = new Map<string, Group>()
  const kept = new Set<string>()
  const folders = new Set(opts.folders.map((f) => resolve(f)))
  for (const rec of await opts.store.list()) {
    if (rec.role !== 'viewer') continue
    const file = await readSessionFile(opts.userData, rec.id)
    if (!file?.transferDir) continue
    const dir = resolve(file.transferDir)
    folders.add(dirname(dirname(dir)))
    if (opts.keep.has(rec.id)) {
      kept.add(dir)
      continue
    }
    if (!isPartialDir(dir)) continue
    const g = groups.get(dir) ?? { dir, roomIds: [], usedAt: 0, bytes: 0 }
    g.roomIds.push(rec.id)
    g.usedAt = Math.max(g.usedAt, file.updatedAt)
    groups.set(dir, g)
  }
  for (const folder of folders) {
    const names = await readdir(join(folder, PARTIAL)).catch(() => [] as string[])
    for (const name of names) {
      const dir = join(folder, PARTIAL, name)
      if (isPartialDir(dir) && !groups.has(dir)) groups.set(dir, { dir, roomIds: [], usedAt: 0, bytes: 0 })
    }
  }
  const live: Group[] = []
  for (const g of groups.values()) {
    if (kept.has(g.dir)) continue
    // lstat: a symlink was not made by us, so it is neither judged nor deleted
    const st = await lstat(g.dir).catch(() => null)
    if (!st?.isDirectory() || (await exporting(g.dir))) continue
    // any write counts as use: the journal and segments while downloading, meta.torrent on every join
    const usage = await scan(g.dir)
    g.usedAt = Math.max(g.usedAt, st.mtimeMs, usage.newest)
    g.bytes = usage.bytes
    live.push(g)
  }

  const swept: SweptDir[] = []
  // the user may resume one of these rooms while the sweep runs: keep is asked again right before deleting
  const remove = (g: Group, why: SweptDir['why']): Promise<boolean> =>
    opts.keep.unlessKept(g.roomIds, async () => {
      if (opts.signal?.aborted || (await exporting(g.dir))) return false
      try {
        await rm(g.dir, { recursive: true, force: true })
      } catch {
        return false // e.g. a file held open: the records stay, so the next startup tries again
      }
      for (const id of g.roomIds) await opts.store.remove(id).catch(() => undefined)
      swept.push({ dir: g.dir, roomIds: g.roomIds, bytes: g.bytes, why })
      return true
    })
  const ours: Group[] = []
  for (const g of live) {
    if (opts.now - g.usedAt > MAX_AGE_MS && (await remove(g, 'age'))) continue
    if (g.roomIds.length > 0) ours.push(g)
  }
  const removed = new Set<Group>()
  // a room resumed meanwhile stops counting against the cap, like one kept from the start
  const counts = (g: Group): boolean => !removed.has(g) && !g.roomIds.some((id) => opts.keep.has(id))
  const total = (): number => ours.reduce((n, g) => (counts(g) ? n + g.bytes : n), 0)
  for (const g of ours.sort((a, b) => a.usedAt - b.usedAt)) {
    if (total() <= opts.capBytes) break
    if (await remove(g, 'cap')) removed.add(g)
  }
  return swept
}

/** The folder holds an export journal (transfer/save-file.ts); one that cannot be checked counts as holding one. */
function exporting(dir: string): Promise<boolean> {
  return lstat(join(dir, EXPORT_FILE)).then(
    () => true,
    (e: unknown) => (e as NodeJS.ErrnoException).code !== 'ENOENT',
  )
}

/**
 * Bytes on disk (allocated blocks where the OS reports them, since segments can be sparse, else sizes)
 * and the newest mtime of the folder's entries, seg/ included.
 */
async function scan(dir: string): Promise<{ bytes: number; newest: number }> {
  let bytes = 0
  let newest = 0
  const add = async (path: string): Promise<void> => {
    const st = await lstat(path).catch(() => null)
    if (!st) return
    newest = Math.max(newest, st.mtimeMs)
    if (st.isFile()) bytes += st.blocks ? st.blocks * 512 : st.size
  }
  for (const name of await readdir(dir).catch(() => [] as string[])) await add(join(dir, name))
  for (const name of await readdir(join(dir, 'seg')).catch(() => [] as string[])) await add(join(dir, 'seg', name))
  return { bytes, newest }
}
