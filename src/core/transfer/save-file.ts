import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { CodedError } from '../../shared/result.js'
import { JOURNAL_FILE, Journal } from './journal.js'
import { containerExtension, savedFileName } from './safe-name.js'
import { segmentName } from './segment-store.js'

export interface SaveFileInput {
  /** the transfer directory holding seg/ */
  dir: string
  segmentBytes: number
  /** torrent files in order; file 0 is the video */
  files: readonly { name: string; offset: number; length: number }[]
  destDir: string
  /**
   * consume segments while copying so peak extra space is one segment (seeding must be stopped). The export is
   * then journaled (EXPORT_FILE), so one cut off by a quit, a crash or a power loss is finished by resumeExport,
   * and the transfer directory is removed once every file is out.
   */
  consume: boolean
}

export interface SavedFiles {
  video: string
  subtitles: string[]
}

/**
 * Thrown before anything is copied or consumed when a segment the files need is missing or short (lost
 * mid-session, e.g. quarantined by an antivirus): `segments` lists them, so their pieces can be dropped
 * from the journal and downloaded again.
 */
export class IncompleteDownloadError extends CodedError {
  constructor(readonly segments: readonly number[]) {
    super('incomplete', `the download is incomplete: ${String(segments.length)} segment file(s) missing or short`)
  }
}

/** The export journal in a transfer directory: a consuming export started there and has not finished. */
export const EXPORT_FILE = 'export.json'
/** where the engine keeps the torrent in a transfer directory: it says which pieces a segment holds */
const TORRENT_FILE = 'meta.torrent'

const ExportedFileSchema = z.object({
  /** the host's name, as in the torrent */
  name: z.string(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative(),
  /** the safe name it is saved under, before freeName's " (2)" */
  saveAs: z.string().min(1),
  /** our `<name>.part`, journaled once created (O_EXCL): a resume writes on into it, never into someone else's file */
  part: z.string().nullable(),
  /** the name chosen right before the rename: once the part is gone and this holds a file of its size, it happened */
  final: z.string().nullable(),
  done: z.boolean(),
})

const ExportJournalSchema = z.object({
  v: z.literal(1),
  destDir: z.string(),
  segmentBytes: z.number().int().positive(),
  /** torrent order: file 0 is the video */
  files: z.array(ExportedFileSchema).min(1),
  /** the video's whole segments up to this one are synced into its part, and may be gone; -1 before the first */
  consumedThrough: z.number().int().min(-1),
  done: z.boolean(),
  /**
   * destDir was a mount point when the save began (another file system than its parent's). Unmounted, it is an empty
   * folder on the parent's disk: that must count as not there, or the export gives up or fills the parent's disk.
   */
  destMount: z.boolean().optional(),
})

type ExportJournal = z.infer<typeof ExportJournalSchema>
type ExportedFile = z.infer<typeof ExportedFileSchema>

/** What resumeExport (or dropExport) did with a pending export. */
export type ResumedExport =
  | { outcome: 'finished'; name: string; video: string; subtitles: string[] }
  /**
   * It could not be finished (`why`). The pieces no longer on disk left the download's journal, so a rejoin downloads
   * them again; `progress` is the share of the torrent's bytes still there (null when unknown).
   */
  | { outcome: 'rejoin'; name: string; why: string; progress: number | null }

/**
 * Test seam: awaited after each step of a consuming export once that step is on disk, so a test can stop the export
 * there as a crash would. In order: 'journal'; then per file, subtitles first and the video last, `part:<i>` (created
 * and journaled), for the video `copied:<k>` (segment k's bytes synced into the part), `consumed:<k>` (journaled) and
 * `unlinked:<k>`, then `final:<i>` (its name journaled) and `renamed:<i>`; then 'done', before the folder goes.
 */
export const exportSteps: { after: ((step: string) => void | Promise<void>) | null } = { after: null }

/**
 * Exports a completed download from segment files to real files (plan §4.2 "Leaving"). Every segment is
 * checked first, so a missing one fails the save before anything is consumed. Subtitles are copied first;
 * the video is then copied segment by segment into <name>.part, synced, and renamed. With `consume`, each of
 * the video's segments goes once it is in the part, in an order a cut at any point can resume from (see
 * resumeExport): copy at its offset, fdatasync the part, journal it, unlink it.
 */
export async function saveFile(input: SaveFileInput): Promise<SavedFiles> {
  const [video] = input.files
  if (!video) throw new Error('nothing to save')
  const missing = await missingSegments(input)
  if (missing.length > 0) throw new IncompleteDownloadError(missing)
  await mkdir(input.destDir, { recursive: true })
  // names come from the host's torrent (see safe-name.ts); the video always ends in a video extension
  const videoExt = await sniffContainer(input, video.offset, video.length)
  const j: ExportJournal = {
    v: 1,
    destDir: resolve(input.destDir),
    ...((await isMountPoint(resolve(input.destDir))) ? { destMount: true } : {}),
    segmentBytes: input.segmentBytes,
    files: input.files.map((f, i) => ({
      name: f.name,
      offset: f.offset,
      length: f.length,
      saveAs: savedFileName(f.name, {
        video: i === 0,
        fallback: i === 0 ? 'video' : `subtitles-${String(i)}`,
        videoExt,
      }),
      part: null,
      final: null,
      done: false,
    })),
    consumedThrough: -1,
    done: false,
  }
  const run = new Exporter(input.dir, j, { consume: input.consume })
  if (input.consume) {
    // an earlier export from here that never finished: every segment is back (checked above), so it starts over
    await discardExport(input.dir)
    await writeExportJournal(input.dir, j)
    await run.step('journal')
  }
  return run.run()
}

/**
 * Finishes a consuming export that a quit, a crash or a power loss cut off, from its journal in `dir` (the transfer
 * directory), without the network: each file goes on where it stopped (at most one segment is copied again) and is
 * renamed, and the directory is removed. When it cannot be finished (the video's part is missing or shorter than its
 * journal says, segments it still needs are gone, or the video it saved is gone), it gives up: the pieces no longer on
 * disk leave the download's journal (state.json), so a rejoin downloads them again; only the export journal and its
 * unfinished parts go. It never gives up while the folder it saves into is not there (a drive not plugged in, a share
 * not mounted: the part may hold the only copy of what it consumed): it throws CodedError 'dest-unavailable' instead,
 * having changed nothing, and stays pending. Null when no export is pending in `dir`. Anything else (a full or
 * unwritable disk) throws, and it stays pending.
 */
export async function resumeExport(dir: string, opts: { signal?: AbortSignal } = {}): Promise<ResumedExport | null> {
  opts.signal?.throwIfAborted()
  const raw = await readFile(join(dir, EXPORT_FILE), 'utf8').catch(nullIfMissing)
  if (raw === null) return null
  const j = parseExportJournal(raw)
  if (!j) return giveUp(dir, null, 'its record of the progress is unreadable')
  const [video] = j.files
  if (!video) return giveUp(dir, null, 'its record of the progress is unreadable')
  // nothing is created in its place: on a mount point that would put the video on the local disk underneath
  await assertDestThere(j)
  if (j.done) {
    // its renames were synced before the journal said done: a video not there now was moved or deleted since
    if (!(await holds(video))) return lost(dir, j, 'the saved video is gone')
    await removeTransferDir(dir)
    const subtitles: string[] = []
    for (const f of j.files.slice(1)) if (f.final !== null && (await holds(f))) subtitles.push(f.final)
    return { ...finished(j), subtitles }
  }
  // renamed right before the cut, with the journal entry that would have said so still to come
  for (const f of j.files) if (!f.done && (await renamed(f))) f.done = true
  const S = j.segmentBytes
  const still = j.files.flatMap((f, i): [number, number][] => {
    if (f.done) return []
    const from = i === 0 ? Math.max(f.offset, (j.consumedThrough + 1) * S) : f.offset
    return [[from, f.offset + f.length]]
  })
  if ((await missingIn(dir, S, torrentBytes(j), still)).length > 0) {
    return lost(dir, j, 'parts of the download are gone')
  }
  if (!video.done && j.consumedThrough >= 0) {
    const claimed = Math.min((j.consumedThrough + 1) * S, video.offset + video.length) - video.offset
    const size = video.part === null ? -1 : await sizeOf(video.part)
    if (size < 0) return lost(dir, j, 'the partly saved video is gone')
    if (size < claimed) return lost(dir, j, 'the partly saved video is incomplete')
  }
  try {
    await new Exporter(dir, j, { consume: true, ...(opts.signal ? { signal: opts.signal } : {}) }).run()
  } catch (e) {
    if (e instanceof ExportLost) return lost(dir, j, e.message)
    // its folder went away while it ran (a pulled drive): it waits for it, like one missing at the start
    await assertDestThere(j).catch((away: unknown) => {
      throw away instanceof CodedError ? away : e
    })
    throw e
  }
  return finished(j)
}

/**
 * Drops the export pending in `dir` instead of finishing it (the user's Cancel saving, also for a folder gone for
 * good): what it had moved into its part counts as missing again (those pieces leave state.json, so a rejoin downloads
 * them), its unfinished parts are deleted where they can be reached (only those `.part` files, which it created), and
 * its journal goes; what it saved stays. One whose video turns out saved in full is finished instead: dropping it would
 * only download the video again. Null when no export is pending in `dir`.
 */
export async function dropExport(dir: string): Promise<ResumedExport | null> {
  const raw = await readFile(join(dir, EXPORT_FILE), 'utf8').catch(nullIfMissing)
  if (raw === null) return null
  const j = parseExportJournal(raw)
  const [video] = j?.files ?? []
  if (!j || !video) return giveUp(dir, null, 'saving it was cancelled')
  if (await renamed(video)) {
    await removeTransferDir(dir)
    return finished(j)
  }
  return giveUp(dir, j, 'saving it was cancelled')
}

/**
 * The export pending in `dir`, if any: its video's saved name (for the UI), the folder it saves into (null when its
 * journal is unreadable), and whether that folder is away now by resumeExport's own rule (also a mount point whose
 * drive is unmounted); one that cannot be checked counts as there.
 */
export async function pendingExport(dir: string): Promise<{ name: string; dest: string | null; away: boolean } | null> {
  const raw = await readFile(join(dir, EXPORT_FILE), 'utf8').catch(nullIfMissing)
  if (raw === null) return null
  const j = parseExportJournal(raw)
  const video = j?.files[0]
  if (!j || !video) return { name: 'the video', dest: null, away: false }
  return { name: video.saveAs, dest: j.destDir, away: !(await destThere(j).catch(() => true)) }
}

/** An export journal in that transfer folder: a save is pending there. One that cannot be checked counts as pending. */
export function exportPending(dir: string): Promise<boolean> {
  return lstat(join(dir, EXPORT_FILE)).then(
    () => true,
    (e: unknown) => !isMissing(e),
  )
}

/** Whether `path` is a folder now: false when nothing is there (its drive is away) or something else is. Other errors throw. */
export async function folderThere(path: string): Promise<boolean> {
  const st = await stat(path).catch(nullIfMissing)
  return st?.isDirectory() ?? false
}

/** Segments that are missing or shorter than the bytes the files need from them. Reads nothing, writes nothing. */
export async function missingSegments(input: Pick<SaveFileInput, 'dir' | 'segmentBytes' | 'files'>): Promise<number[]> {
  const total = input.files.reduce((end, f) => Math.max(end, f.offset + f.length), 0)
  return missingIn(input.dir, input.segmentBytes, total, [[0, total]])
}

/** Segments overlapping `ranges` (torrent bytes) that are missing or shorter than a torrent of `total` bytes makes them. */
async function missingIn(dir: string, S: number, total: number, ranges: [number, number][]): Promise<number[]> {
  const wanted = new Set<number>()
  for (const [from, to] of ranges) for (let k = Math.floor(from / S); from < to && k * S < to; k++) wanted.add(k)
  const missing: number[] = []
  for (const k of [...wanted].sort((a, b) => a - b)) {
    const size = await stat(join(dir, 'seg', segmentName(k))).then(
      (s) => (s.isFile() ? s.size : -1),
      () => -1,
    )
    if (size < Math.min(S, total - k * S)) missing.push(k)
  }
  return missing
}

/** Raised inside a resumed export when it finds it cannot go on; resumeExport then gives up on it (see lost). */
class ExportLost extends Error {}

/**
 * One export run: saveFile's, or resumeExport's from the journal. Only a consuming one journals its steps and
 * consumes the video's segments; the journal is written whole, atomically, before any step that relies on it.
 */
class Exporter {
  private readonly buf: Buffer

  constructor(
    private readonly dir: string,
    private readonly j: ExportJournal,
    private readonly opts: { consume: boolean; signal?: AbortSignal },
  ) {
    this.buf = Buffer.allocUnsafe(Math.min(j.segmentBytes, 4 * 1024 * 1024))
  }

  async run(): Promise<SavedFiles> {
    for (let i = 1; i < this.j.files.length; i++) await this.export(i)
    await this.export(0)
    if (this.opts.consume) {
      this.j.done = true
      await this.save()
      await this.step('done')
      await removeTransferDir(this.dir)
    }
    const [video = '', ...subtitles] = this.j.files.map((f) => f.final ?? '')
    return { video, subtitles }
  }

  async step(name: string): Promise<void> {
    if (!this.opts.consume) return
    await exportSteps.after?.(name)
    this.opts.signal?.throwIfAborted()
  }

  private async export(i: number): Promise<void> {
    const f = this.j.files[i]
    if (!f || f.done) return
    const part = await this.part(i, f)
    if (!part) return
    try {
      await this.copy(i, part.fh)
      await part.fh.sync()
    } finally {
      await part.fh.close()
    }
    // the copy can take minutes: never replace something that appeared under the chosen name meanwhile
    const root = this.j.destDir
    const final = f.final !== null && !(await taken(f.final)) ? f.final : await freeName(join(root, f.saveAs))
    f.final = final
    await this.save()
    await this.step(`final:${String(i)}`)
    await rename(part.path, final)
    // on disk before the journal can say done and the transfer folder goes (the destination may be another disk)
    await syncDir(root)
    f.done = true // journaled with the next write; until then the part's absence says so
    await this.step(`renamed:${String(i)}`)
  }

  /** File i's part: the one its journal names, else a new one; null when the file was renamed before a cut. */
  private async part(i: number, f: ExportedFile): Promise<{ path: string; fh: FileHandle } | null> {
    if (f.part !== null) {
      const fh = await open(f.part, 'r+').catch(nullIfMissing)
      if (fh) return { path: f.part, fh }
    }
    if (await renamed(f)) {
      f.done = true
      return null
    }
    // the bytes of consumed segments were only in the part
    if (i === 0 && this.j.consumedThrough >= 0) throw new ExportLost('the partly saved video is gone')
    const root = this.j.destDir
    const dest = await freeName(join(root, f.saveAs))
    if (dirname(dest) !== root) throw new Error(`refusing to write outside ${root}`) // names are sanitised; belt and braces
    const created = await createExclusive(`${dest}.part`)
    f.part = created.path
    f.final = null
    try {
      if (this.opts.consume) await syncDir(root) // the part must outlast the segments it takes in
      await this.save()
      await this.step(`part:${String(i)}`)
    } catch (e) {
      await created.fh.close()
      throw e
    }
    return created
  }

  /** File i's bytes into its part, each at its own offset; a consuming run takes the video's segments one by one. */
  private async copy(i: number, out: FileHandle): Promise<void> {
    const f = this.j.files[i]
    if (!f) return
    const S = this.j.segmentBytes
    const end = f.offset + f.length
    const consume = this.opts.consume && i === 0
    let k = Math.floor(f.offset / S)
    if (consume) {
      // consumed before a cut that came ahead of their unlink
      for (; k <= this.j.consumedThrough; k++) await rm(segmentPath(this.dir, k), { force: true })
    }
    for (; k * S < end; k++) {
      const from = Math.max(k * S, f.offset)
      const to = Math.min((k + 1) * S, end)
      const seg = await open(segmentPath(this.dir, k), 'r')
      try {
        await copy(seg, from - k * S, out, from - f.offset, to - from, this.buf)
      } finally {
        await seg.close()
      }
      if (!consume) continue
      await out.datasync()
      await this.step(`copied:${String(k)}`)
      // a segment the video shares with a subtitle goes with the folder, once every file is out
      if (from !== k * S || to !== (k + 1) * S) continue
      this.j.consumedThrough = k
      await this.save()
      await this.step(`consumed:${String(k)}`)
      await rm(segmentPath(this.dir, k), { force: true })
      await this.step(`unlinked:${String(k)}`)
    }
  }

  private async save(): Promise<void> {
    if (this.opts.consume) await writeExportJournal(this.dir, this.j)
  }
}

/**
 * The export cannot be finished from what is on disk: it is given up (giveUp), but only while the folder it saves
 * into is there. Without it, its part could not be checked nor removed, and may hold the only copy of what it consumed.
 */
async function lost(dir: string, j: ExportJournal, why: string): Promise<ResumedExport> {
  await assertDestThere(j)
  return giveUp(dir, j, why)
}

/** CodedError 'dest-unavailable' while the folder it saves into is not there (its drive or share is away). */
async function assertDestThere(j: ExportJournal): Promise<void> {
  if (!(await destThere(j))) {
    throw new CodedError('dest-unavailable', 'the folder it saves into is not there: connect its drive')
  }
}

/** The folder it saves into is a folder now and, if it was a mount point when the save began, still is one. */
async function destThere(j: ExportJournal): Promise<boolean> {
  return (await folderThere(j.destDir)) && (j.destMount !== true || (await isMountPoint(j.destDir)))
}

/**
 * Whether `path` is the root of a mounted file system: its device differs from its parent's. Compared with the
 * parent rather than with a device number kept from before, because a network share gets a new one at every mount.
 */
async function isMountPoint(path: string): Promise<boolean> {
  const parent = dirname(path)
  if (parent === path) return false
  const [here, up] = await Promise.all([stat(path).catch(() => null), stat(parent).catch(() => null)])
  if (here === null || up === null) return false
  // a bind mount within one file system keeps its parent's device: Linux lists every mount root in mountinfo
  return here.dev !== up.dev || (await listedMountRoot(path))
}

/** Linux: whether /proc/self/mountinfo lists `path` (as its real path) as a mount point. False elsewhere. */
async function listedMountRoot(path: string): Promise<boolean> {
  const info = await readFile('/proc/self/mountinfo', 'utf8').catch(() => null)
  return info !== null && mountPointsIn(info).has(await realpath(path).catch(() => path))
}

/** The mount points of a /proc/self/mountinfo text (field 5; space, tab, newline and backslash are octal escapes). */
export function mountPointsIn(info: string): Set<string> {
  const unescape = (s: string): string =>
    s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
  return new Set(
    info.split('\n').flatMap((line) => {
      const field = line.split(' ')[4]
      return field === undefined ? [] : [unescape(field)]
    }),
  )
}

/** The export goes, and the download is left for a rejoin to complete (see resumeExport and dropExport). */
async function giveUp(dir: string, j: ExportJournal | null, why: string): Promise<ResumedExport> {
  let progress: number | null = null
  if (j) {
    const S = j.segmentBytes
    const total = torrentBytes(j)
    const lost = await missingIn(dir, S, total, [[0, total]])
    await forgetSegments(dir, S, lost)
    const lostBytes = lost.reduce((n, k) => n + Math.min(S, total - k * S), 0)
    progress = total > 0 ? (total - lostBytes) / total : null
    // its unfinished parts are of no use now (what it saved stays); one that cannot be removed is left behind
    for (const f of j.files) {
      if (!f.done && f.part !== null) await rm(f.part, { force: true }).catch(() => undefined)
    }
  }
  await rm(join(dir, EXPORT_FILE), { force: true })
  await syncDir(dir)
  return { outcome: 'rejoin', name: j?.files[0]?.saveAs ?? 'the video', why, progress }
}

/** The pieces of these segments leave the download's journal (state.json), so a rejoin downloads them again. */
async function forgetSegments(dir: string, S: number, segments: readonly number[]): Promise<void> {
  if (segments.length === 0) return
  // without a readable torrent, checkResume clears them at the next join all the same
  const t = await readFile(join(dir, TORRENT_FILE))
    .then(async (b) => (await import('parse-torrent')).default(b))
    .catch(() => null)
  if (!t || !(t.pieceLength > 0)) return
  const journal = await Journal.open(join(dir, JOURNAL_FILE), t.infoHash, t.pieces.length)
  for (const k of segments) {
    const last = Math.min(t.pieces.length, Math.ceil(((k + 1) * S) / t.pieceLength))
    for (let i = Math.floor((k * S) / t.pieceLength); i < last; i++) journal.clear(i)
  }
  await journal.save()
}

/** An export found pending where a new one starts: its unfinished parts go with its journal. */
async function discardExport(dir: string): Promise<void> {
  const raw = await readFile(join(dir, EXPORT_FILE), 'utf8').catch(nullIfMissing)
  if (raw === null) return
  const j = parseExportJournal(raw)
  if (j) {
    for (const f of j.files) if (!f.done && f.part !== null) await rm(f.part, { force: true })
  }
  await rm(join(dir, EXPORT_FILE), { force: true })
}

function finished(j: ExportJournal): Extract<ResumedExport, { outcome: 'finished' }> {
  const [video = '', ...subtitles] = j.files.map((f) => f.final ?? '')
  return { outcome: 'finished', name: basename(video), video, subtitles }
}

/** The part is gone and the name chosen for it holds a file of its size: the rename happened. */
async function renamed(f: ExportedFile): Promise<boolean> {
  if (f.final === null || (f.part !== null && (await sizeOf(f.part)) >= 0)) return false
  return holds(f)
}

/** The name chosen for the file holds a file of its size. */
async function holds(f: ExportedFile): Promise<boolean> {
  return f.final !== null && (await sizeOf(f.final)) === f.length
}

/**
 * The journal as written by this module, or null. Its paths are only ever ours: parts (`*.part`, the only files a
 * resume removes) and final names directly in its destination folder, so a planted or damaged journal cannot make a
 * resume write or delete anything else.
 */
function parseExportJournal(raw: string): ExportJournal | null {
  try {
    const j = ExportJournalSchema.parse(JSON.parse(raw))
    const inDest = (p: string | null): boolean => p === null || (isAbsolute(p) && dirname(p) === j.destDir)
    const ok =
      isAbsolute(j.destDir) &&
      resolve(j.destDir) === j.destDir &&
      j.files.every(
        (f) =>
          inDest(f.part) &&
          (f.part?.endsWith('.part') ?? true) &&
          inDest(f.final) &&
          dirname(join(j.destDir, f.saveAs)) === j.destDir,
      )
    return ok ? j : null
  } catch {
    return null
  }
}

function torrentBytes(j: ExportJournal): number {
  return j.files.reduce((end, f) => Math.max(end, f.offset + f.length), 0)
}

function segmentPath(dir: string, k: number): string {
  return join(dir, 'seg', segmentName(k))
}

/** Written whole and atomically, and durable before whatever relies on it (tmp, fsync, rename, fsync of the folder). */
async function writeExportJournal(dir: string, j: ExportJournal): Promise<void> {
  const file = join(dir, EXPORT_FILE)
  const tmp = `${file}.tmp`
  const fh = await open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(JSON.stringify(j))
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, file)
  await syncDir(dir)
}

/** Every file is out: the transfer directory goes, its export journal last, so a cut part-way leaves one that says so. */
async function removeTransferDir(dir: string): Promise<void> {
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name !== EXPORT_FILE) await rm(join(dir, name), { recursive: true, force: true })
  }
  await rm(dir, { recursive: true, force: true })
}

/** fsync of a folder, so a create, rename or unlink in it is durable; Windows cannot open one for that. */
async function syncDir(dir: string): Promise<void> {
  const fh = await open(dir, 'r').catch(() => null)
  if (!fh) return
  try {
    await fh.sync()
  } catch {
    // not supported on this platform or file system
  } finally {
    await fh.close()
  }
}

/** A file's size; -1 when there is none (nothing at the path, or not a regular file). Other errors throw. */
async function sizeOf(path: string): Promise<number> {
  const st = await lstat(path).catch(nullIfMissing)
  return st?.isFile() ? st.size : -1
}

function nullIfMissing(e: unknown): null {
  if (isMissing(e)) return null
  throw e
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The video's container extension, from its first bytes (segment files hold torrent bytes). */
async function sniffContainer(input: SaveFileInput, offset: number, length: number): Promise<string> {
  const k = Math.floor(offset / input.segmentBytes)
  const head = Buffer.alloc(Math.min(512, length, input.segmentBytes - (offset - k * input.segmentBytes)))
  const fh = await open(join(input.dir, 'seg', segmentName(k)), 'r').catch(() => null)
  if (!fh) return containerExtension(Buffer.alloc(0))
  try {
    const { bytesRead } = await fh.read(head, 0, head.byteLength, offset - k * input.segmentBytes)
    return containerExtension(head.subarray(0, bytesRead))
  } catch {
    return containerExtension(Buffer.alloc(0))
  } finally {
    await fh.close()
  }
}

/** O_EXCL never follows or truncates an existing file or symlink; a name lost to a race moves on to the next. */
async function createExclusive(path: string): Promise<{ path: string; fh: FileHandle }> {
  for (let attempt = 0; ; attempt++) {
    const candidate = await freeName(path)
    try {
      return {
        path: candidate,
        fh: await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o644),
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 8) throw e
    }
  }
}

/** lstat: a dangling symlink is taken too (rename would replace it). */
function taken(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  )
}

async function copy(
  src: FileHandle,
  from: number,
  dst: FileHandle,
  to: number,
  length: number,
  buf: Buffer,
): Promise<void> {
  let done = 0
  while (done < length) {
    const { bytesRead } = await src.read(buf, 0, Math.min(buf.byteLength, length - done), from + done)
    if (bytesRead === 0) throw new Error('segment ended early: the download is incomplete')
    let off = 0
    while (off < bytesRead) {
      const { bytesWritten } = await dst.write(buf, off, bytesRead - off, to + done + off)
      off += bytesWritten
    }
    done += bytesRead
  }
}

async function freeName(path: string): Promise<string> {
  const ext = extname(path)
  const stem = path.slice(0, path.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : `${stem} (${String(n)})${ext}`
    if (!(await taken(candidate))) return candidate
  }
}
