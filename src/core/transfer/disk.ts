import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Free space kept in reserve; below it the viewer stops adding downloads (plan §4.2 "Disk space"). */
export const DISK_RESERVE_BYTES = 512 * 1024 * 1024

/** Bytes available to this user on the volume holding `path` (or its nearest existing parent). */
export async function freeBytes(path: string): Promise<number> {
  let dir = path
  for (;;) {
    try {
      const s = await statfs(dir)
      return s.bavail * s.bsize
    } catch (e) {
      const parent = dirname(dir)
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === dir) throw e
      dir = parent
    }
  }
}

export interface SpaceCheck {
  ok: boolean
  freeBytes: number
  neededBytes: number
}

/** A join needs the bytes still missing plus the reserve (saving consumes segments, so no 2x). */
export async function checkSpace(dir: string, missingBytes: number): Promise<SpaceCheck> {
  const free = await freeBytes(dir)
  const needed = missingBytes + DISK_RESERVE_BYTES
  return { ok: free >= needed, freeBytes: free, neededBytes: needed }
}
