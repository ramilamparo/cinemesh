import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import bencode from 'bencode'
import parseTorrent from 'parse-torrent'
import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { Journal } from './journal.js'
import { containerExtension, defuseExecutable, safeExtension, safeFileName, savedFileName } from './safe-name.js'
import {
  EXPORT_FILE,
  IncompleteDownloadError,
  dropExport,
  exportPending,
  exportSteps,
  folderThere,
  mountPointsIn,
  pendingExport,
  resumeExport,
  saveFile,
} from './save-file.js'
import { segmentName } from './segment-store.js'

// Folders the tests treat as mount points: stat gives them another device than their parent's, as a mounted drive does.
const fakeMounts = vi.hoisted(() => new Set<string>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (async (path: string, opts?: object) => {
    const st = await fs.stat(path, opts)
    return fakeMounts.has(path) ? Object.assign(st, { dev: st.dev + 1 }) : st
  }) as typeof fs.stat
  return { ...fs, stat, default: { ...fs, stat } }
})

const root = mkdtempSync(join(tmpdir(), 'wt-save-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const S = 16 * 1024

/** A transfer dir holding `parts` back to back in segment files, as a finished download leaves it. */
function transferDir(name: string, parts: Buffer[]): string {
  const dir = join(root, name, 'transfer')
  mkdirSync(join(dir, 'seg'), { recursive: true })
  const all = Buffer.concat(parts)
  for (let k = 0; k * S < all.length; k++)
    writeFileSync(join(dir, 'seg', segmentName(k)), all.subarray(k * S, (k + 1) * S))
  return dir
}

describe('saveFile with names from an untrusted torrent', () => {
  it('writes every file inside the chosen folder, whatever the host named them', async () => {
    // the names reach saveFile the way they do in the app: through parse-torrent, which keeps the raw last
    // path element as `name` (only `path` is normalised)
    const names = ['film.mkv.exe', '../../escaped.srt', '..\\..\\AppData\\evil.srt', 'CON.srt', 'a:b.srt', '..']
    const bodies = names.map((n, i) => Buffer.alloc(100 + i, i + 1))
    const info = {
      name: 'Cinemesh',
      files: names.map((n, i) => ({ length: bodies[i]?.length ?? 0, path: [n] })),
      'piece length': S,
      pieces: Buffer.alloc(20),
      private: 1,
    }
    const t = await parseTorrent(Buffer.from(bencode.encode({ info })))
    expect(t.files[1]?.name).toBe('../../escaped.srt') // what a malicious host gets through
    const dir = transferDir('crafted', bodies)
    const destDir = join(root, 'crafted', 'a', 'b', 'dest')
    const saved = await saveFile({
      dir,
      segmentBytes: S,
      files: t.files.map((f) => ({ name: f.name, offset: f.offset, length: f.length })),
      destDir,
      consume: true,
    })
    for (const p of [saved.video, ...saved.subtitles]) expect(dirname(p)).toBe(destDir)
    expect(basename(saved.video)).toBe('film.mkv_exe.mkv') // defused, and outranked by a video extension
    expect(saved.subtitles.map((p) => basename(p))).toEqual([
      'escaped.srt',
      'evil.srt',
      'subtitles-3.srt',
      'a_b.srt',
      'subtitles-5.bin', // no extension on the list: a neutral one
    ])
    expect(readdirSync(join(root, 'crafted', 'a'))).toEqual(['b'])
    expect(readdirSync(join(root, 'crafted', 'a', 'b'))).toEqual(['dest'])
    expect(readFileSync(saved.video).equals(bodies[0] ?? Buffer.alloc(0))).toBe(true)
    expect(readFileSync(saved.subtitles[1] ?? '').equals(bodies[2] ?? Buffer.alloc(0))).toBe(true)
  })

  it('never truncates an existing .part file, nor replaces a symlink sitting on the name', async () => {
    const video = Buffer.alloc(3 * S + 7, 9)
    const sub = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhi\n')
    const dir = transferDir('existing', [video, sub])
    const destDir = join(root, 'existing', 'dest')
    mkdirSync(destDir, { recursive: true })
    writeFileSync(join(destDir, 'film.mkv.part'), 'KEEP')
    const outside = join(root, 'existing', 'outside.srt')
    symlinkSync(outside, join(destDir, 'film.srt')) // dangling: stat() says "free", lstat() does not
    const saved = await saveFile({
      dir,
      segmentBytes: S,
      files: [
        { name: 'film.mkv', offset: 0, length: video.length },
        { name: 'film.srt', offset: video.length, length: sub.length },
      ],
      destDir,
      consume: false,
    })
    expect(readFileSync(join(destDir, 'film.mkv.part'), 'utf8')).toBe('KEEP')
    expect(saved.video).toBe(join(destDir, 'film.mkv'))
    expect(readFileSync(saved.video).equals(video)).toBe(true)
    expect(lstatSync(join(destDir, 'film.srt')).isSymbolicLink()).toBe(true)
    expect(saved.subtitles).toEqual([join(destDir, 'film (2).srt')])
    expect(existsSync(outside)).toBe(false)
  })
})

describe('saveFile consuming segments', () => {
  it('checks every segment before consuming any, so a lost one costs nothing already downloaded', async () => {
    const video = Buffer.alloc(3 * S + 100, 7)
    const dir = transferDir('lost-segment', [video])
    rmSync(join(dir, 'seg', segmentName(1))) // quarantined mid-session, after the resume checks ran
    const destDir = join(root, 'lost-segment', 'dest')
    const files = [{ name: 'film.mkv', offset: 0, length: video.length }]
    const failed = await saveFile({ dir, segmentBytes: S, files, destDir, consume: true }).catch((e: unknown) => e)
    expect(failed).toBeInstanceOf(IncompleteDownloadError)
    expect((failed as IncompleteDownloadError).code).toBe('incomplete')
    expect((failed as IncompleteDownloadError).segments).toEqual([1])
    expect(readdirSync(join(dir, 'seg')).sort()).toEqual([segmentName(0), segmentName(2), segmentName(3)])
    expect(existsSync(destDir)).toBe(false) // not even a .part file
  })

  it('treats a short segment as missing, the short last one included', async () => {
    const video = Buffer.alloc(2 * S + 100, 3)
    const dir = transferDir('short-segment', [video])
    writeFileSync(join(dir, 'seg', segmentName(2)), Buffer.alloc(99, 3)) // needs 100
    const files = [{ name: 'film.mkv', offset: 0, length: video.length }]
    const destDir = join(root, 'short-segment', 'dest')
    await expect(saveFile({ dir, segmentBytes: S, files, destDir, consume: true })).rejects.toMatchObject({
      segments: [2],
    })
    expect(readdirSync(join(dir, 'seg'))).toHaveLength(3)
  })
})

// ---- an export cut off by a quit, a crash or a power loss --------------------------------------------------------

/** Stands in for the process dying right after a step. */
class Cut extends Error {}

// A video of three whole segments and 7 bytes, then two subtitles, all in the last segment; 4 pieces per segment.
const P = S / 4
const VIDEO = randomBytes(3 * S + 7)
const SRT = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nhello\n')
const ASS = Buffer.from('[Script Info]\nScriptType: v4.00+\n\n[Events]\n')
const LAYOUT = [
  { name: 'film.mkv', offset: 0, length: VIDEO.length },
  { name: 'film.srt', offset: VIDEO.length, length: SRT.length },
  { name: 'film.en.ass', offset: VIDEO.length + SRT.length, length: ASS.length },
]
const TOTAL = VIDEO.length + SRT.length + ASS.length
const PIECES = Math.ceil(TOTAL / P)
const SAVED = ['film.en.ass', 'film.mkv', 'film.srt']

/** Every step of one export of LAYOUT, in order: subtitles, then the video segment by segment. */
const STEPS = [
  'journal',
  'part:1',
  'final:1',
  'renamed:1',
  'part:2',
  'final:2',
  'renamed:2',
  'part:0',
  ...[0, 1, 2].flatMap((k) => [`copied:${String(k)}`, `consumed:${String(k)}`, `unlinked:${String(k)}`]),
  'copied:3', // shared with the subtitles: it goes with the folder
  'final:0',
  'renamed:0',
  'done',
]

let cases = 0

/** A finished download of LAYOUT as the engine leaves it: segments, its torrent and a journal claiming every piece. */
async function download(): Promise<{ dir: string; destDir: string; infoHash: string }> {
  const base = join(root, `export-${String(++cases)}`)
  const dir = join(base, '.wt-partial', 'ab'.repeat(20))
  mkdirSync(join(dir, 'seg'), { recursive: true })
  const all = Buffer.concat([VIDEO, SRT, ASS])
  for (let k = 0; k * S < all.length; k++)
    writeFileSync(join(dir, 'seg', segmentName(k)), all.subarray(k * S, (k + 1) * S))
  const info = {
    name: 'Cinemesh',
    files: LAYOUT.map((f) => ({ length: f.length, path: [f.name] })),
    'piece length': P,
    pieces: Buffer.alloc(20 * PIECES),
    private: 1,
  }
  const torrent = Buffer.from(bencode.encode({ info }))
  writeFileSync(join(dir, 'meta.torrent'), torrent)
  const { infoHash } = await parseTorrent(torrent)
  const journal = await Journal.open(join(dir, 'state.json'), infoHash, PIECES)
  for (let i = 0; i < PIECES; i++) journal.mark(i)
  await journal.save()
  return { dir, destDir: join(base, 'Videos'), infoHash }
}

const save = (d: { dir: string; destDir: string }): ReturnType<typeof saveFile> =>
  saveFile({ dir: d.dir, segmentBytes: S, files: LAYOUT, destDir: d.destDir, consume: true })

interface Journaled {
  consumedThrough: number
  destMount?: boolean
  files: { part: string | null; final: string | null; done: boolean }[]
}
const journalOf = (dir: string): Journaled => JSON.parse(readFileSync(join(dir, EXPORT_FILE), 'utf8')) as Journaled

/** saveFile, cut right after `step`; the export journal as the cut left it. */
async function cutAt(d: { dir: string; destDir: string }, step: string): Promise<Journaled> {
  exportSteps.after = (s) => {
    if (s === step) throw new Cut(step)
  }
  await expect(save(d)).rejects.toBeInstanceOf(Cut)
  exportSteps.after = null
  return journalOf(d.dir)
}

function expectSaved(destDir: string): void {
  expect(readdirSync(destDir).sort()).toEqual(SAVED) // no part left behind, nothing saved twice
  expect(readFileSync(join(destDir, 'film.mkv')).equals(VIDEO)).toBe(true)
  expect(readFileSync(join(destDir, 'film.srt')).equals(SRT)).toBe(true)
  expect(readFileSync(join(destDir, 'film.en.ass')).equals(ASS)).toBe(true)
}

/** The pieces state.json still claims. */
async function claimed(d: { dir: string; infoHash: string }): Promise<number[]> {
  const journal = await Journal.open(join(d.dir, 'state.json'), d.infoHash, PIECES)
  return Array.from({ length: PIECES }, (_, i) => i).filter((i) => journal.has(i))
}

const piecesOf = (...segments: number[]): number[] =>
  segments.flatMap((k) => Array.from({ length: S / P }, (_, i) => k * (S / P) + i)).filter((i) => i < PIECES)

describe('a consuming export, cut off at any point', () => {
  afterEach(() => {
    exportSteps.after = null
  })

  it('takes a segment only once its bytes are synced into the part and journaled', async () => {
    const d = await download()
    const steps: string[] = []
    const part = join(d.destDir, 'film.mkv.part')
    const seg = (k: number): string => join(d.dir, 'seg', segmentName(k))
    // fdatasync cannot be seen on disk: every call is noted among the steps
    const probe = await open(join(d.dir, 'meta.torrent'))
    const handle = Object.getPrototypeOf(probe) as { datasync(this: FileHandle): Promise<void> }
    await probe.close()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each handle as this
    const datasync = handle.datasync
    const synced = vi.spyOn(handle, 'datasync').mockImplementation(function (this: FileHandle) {
      steps.push('datasync')
      return datasync.call(this)
    })
    onTestFinished(() => synced.mockRestore())
    exportSteps.after = (step) => {
      steps.push(step)
      const [what, n] = step.split(':')
      const k = Number(n)
      const j = journalOf(d.dir)
      if (what === 'part' && k === 0) expect(j.files[0]?.part).toBe(part)
      if (what === 'copied') {
        expect(j.consumedThrough).toBe(k - 1)
        expect(existsSync(seg(k))).toBe(true)
        expect(lstatSync(part).size).toBe(Math.min((k + 1) * S, VIDEO.length))
      }
      if (what === 'consumed') {
        expect(j.consumedThrough).toBe(k)
        expect(existsSync(seg(k))).toBe(true)
      }
      if (what === 'unlinked') expect(existsSync(seg(k))).toBe(false)
      if (step === 'final:0') expect([j.files[0]?.final, existsSync(part)]).toEqual([join(d.destDir, 'film.mkv'), true])
      if (step === 'renamed:0') expect(existsSync(part)).toBe(false)
    }
    const saved = await save(d)
    expect(steps.filter((s) => s !== 'datasync')).toEqual(STEPS)
    // each segment's bytes are synced before the step that says they were copied
    for (const k of [0, 1, 2, 3]) expect(steps[steps.indexOf(`copied:${String(k)}`) - 1]).toBe('datasync')
    expect(saved).toEqual({
      video: join(d.destDir, 'film.mkv'),
      subtitles: [join(d.destDir, 'film.srt'), join(d.destDir, 'film.en.ass')],
    })
    expectSaved(d.destDir)
    expect(existsSync(d.dir)).toBe(false) // the transfer folder goes once every file is out
  })

  it.each(STEPS)('finishes byte for byte after a cut after %s, copying at most one segment again', async (step) => {
    const d = await download()
    const atCut = await cutAt(d, step)
    expect(await pendingExport(d.dir)).toEqual({ name: 'film.mkv', dest: d.destDir, away: false })
    const copied: number[] = []
    exportSteps.after = (s) => {
      if (s.startsWith('copied:')) copied.push(Number(s.slice(7)))
    }
    expect(await resumeExport(d.dir)).toEqual({
      outcome: 'finished',
      name: 'film.mkv',
      video: join(d.destDir, 'film.mkv'),
      subtitles: [join(d.destDir, 'film.srt'), join(d.destDir, 'film.en.ass')],
    })
    expectSaved(d.destDir)
    expect(existsSync(d.dir)).toBe(false)
    // nothing journaled as consumed is copied again: only the segment the cut caught on its way
    expect(copied.every((k) => k > atCut.consumedThrough)).toBe(true)
    // done is done: nothing is pending any more
    expect(await resumeExport(d.dir)).toBeNull()
    expect(await pendingExport(d.dir)).toBeNull()
  })

  it('still ends byte for byte when every single step is cut, the resumes included', async () => {
    const d = await download()
    await cutAt(d, 'journal')
    const cut = new Set(['journal'])
    const seen: string[] = []
    for (let runs = 0; ; runs++) {
      expect(runs).toBeLessThan(STEPS.length + 1)
      // each run dies at the first step not cut before (a step a cut undid comes again, and then goes through)
      exportSteps.after = (s) => {
        seen.push(s)
        if (cut.has(s)) return
        cut.add(s)
        throw new Cut(s)
      }
      const r = await resumeExport(d.dir).catch((e: unknown) => e)
      if (r instanceof Cut) continue
      expect(r).toMatchObject({ outcome: 'finished', video: join(d.destDir, 'film.mkv') })
      break
    }
    expectSaved(d.destDir)
    expect(existsSync(d.dir)).toBe(false)
    // at most one copy again per segment: the one cut right after its copy, before the journal said so
    for (const k of [0, 1, 2]) expect(seen.filter((s) => s === `copied:${String(k)}`)).toHaveLength(2)
  })

  it('gives up when the partly saved video is gone: the consumed pieces leave state.json for a rejoin', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:1')
    // deleted by the user from a folder that is there (a folder that is not there waits instead: see below)
    rmSync(j.files[0]?.part ?? '')
    expect(await resumeExport(d.dir)).toEqual({
      outcome: 'rejoin',
      name: 'film.mkv',
      why: 'the partly saved video is gone',
      progress: (TOTAL - 2 * S) / TOTAL,
    })
    expect(await claimed(d)).toEqual(piecesOf(2, 3))
    expect(readdirSync(join(d.dir, 'seg')).sort()).toEqual([segmentName(2), segmentName(3)])
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(false)
    expect(readdirSync(d.destDir).sort()).toEqual(['film.en.ass', 'film.srt']) // what it saved stays
    expect(await resumeExport(d.dir)).toBeNull()
  })

  it('gives up on a part shorter than its journal says, and removes it', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:1')
    const part = j.files[0]?.part ?? ''
    truncateSync(part, S) // a file system that lost what it had acknowledged
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'rejoin', why: 'the partly saved video is incomplete' })
    expect(existsSync(part)).toBe(false)
    expect(await claimed(d)).toEqual(piecesOf(2, 3))
  })

  it('gives up when a segment it still needs is gone, dropping its pieces too', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:0')
    rmSync(join(d.dir, 'seg', segmentName(2)))
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'rejoin', why: 'parts of the download are gone' })
    expect(await claimed(d)).toEqual(piecesOf(1, 3))
    expect(existsSync(j.files[0]?.part ?? '')).toBe(false)
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(false)
  })

  it('starts the video over when its part is gone before anything was consumed', async () => {
    const d = await download()
    const j = await cutAt(d, 'copied:0')
    expect(j.consumedThrough).toBe(-1)
    rmSync(j.files[0]?.part ?? '')
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished' })
    expectSaved(d.destDir)
  })

  it('never writes or deletes outside the folder its journal names, whatever the journal says', async () => {
    const unreadable = { outcome: 'rejoin', why: 'its record of the progress is unreadable', progress: null }
    // a part elsewhere: it would be written into, or removed as unfinished
    let d = await download()
    await cutAt(d, 'part:0')
    const victim = join(root, `victim-${String(cases)}.part`)
    writeFileSync(victim, 'precious')
    let j = journalOf(d.dir)
    writeFileSync(
      join(d.dir, EXPORT_FILE),
      JSON.stringify({ ...j, files: j.files.map((f) => ({ ...f, part: victim })) }),
    )
    expect(await resumeExport(d.dir)).toMatchObject(unreadable)
    expect(readFileSync(victim, 'utf8')).toBe('precious')
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(false)
    // a final name elsewhere: the video would be renamed out of its folder
    d = await download()
    j = await cutAt(d, 'final:0')
    const elsewhere = join(root, `elsewhere-${String(cases)}.mkv`)
    const files = j.files.map((f, i) => (i === 0 ? { ...f, final: elsewhere } : f))
    writeFileSync(join(d.dir, EXPORT_FILE), JSON.stringify({ ...j, files }))
    expect(await resumeExport(d.dir)).toMatchObject(unreadable)
    expect(existsSync(elsewhere)).toBe(false)
    // in its folder, but not a part: given up as unfinished, it would be removed
    d = await download()
    j = await cutAt(d, 'unlinked:1')
    const mine = join(d.destDir, 'holiday.mkv')
    writeFileSync(mine, 'precious')
    writeFileSync(join(d.dir, EXPORT_FILE), JSON.stringify({ ...j, files: j.files.map((f) => ({ ...f, part: mine })) }))
    expect(await resumeExport(d.dir)).toMatchObject(unreadable)
    expect(readFileSync(mine, 'utf8')).toBe('precious')
  })

  it('a new save over an export left pending starts over, and leaves no part behind', async () => {
    const d = await download()
    const j = await cutAt(d, 'copied:0') // every segment is still there
    const saved = await save(d)
    expect(saved.video).toBe(join(d.destDir, 'film.mkv'))
    expect(existsSync(j.files[0]?.part ?? '')).toBe(false)
    // the first run had saved the subtitles already
    expect(readdirSync(d.destDir).sort()).toEqual(['film.en (2).ass', 'film (2).srt', ...SAVED].sort())
    expect(readFileSync(saved.video).equals(VIDEO)).toBe(true)
  })

  it('stops at its next step once aborted, and stays pending', async () => {
    const d = await download()
    await cutAt(d, 'part:0')
    const stop = new AbortController()
    exportSteps.after = (s) => {
      if (s === 'consumed:0') stop.abort()
    }
    await expect(resumeExport(d.dir, { signal: stop.signal })).rejects.toThrow(/abort/i)
    expect(journalOf(d.dir).consumedThrough).toBe(0)
    exportSteps.after = null
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished' })
    expectSaved(d.destDir)
  })

  it('makes each rename durable before the journal can say it happened', async () => {
    const d = await download()
    const steps: string[] = []
    // which folder or file each fsync is for: Linux names an open descriptor's path in /proc
    const pathOf = (fh: FileHandle): string => {
      try {
        return readlinkSync(`/proc/self/fd/${String(fh.fd)}`)
      } catch {
        return '?'
      }
    }
    const probe = await open(join(d.dir, 'meta.torrent'))
    const handle = Object.getPrototypeOf(probe) as { sync(this: FileHandle): Promise<void> }
    await probe.close()
    // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called below with each handle as this
    const sync = handle.sync
    const synced = vi.spyOn(handle, 'sync').mockImplementation(function (this: FileHandle) {
      steps.push(`sync:${pathOf(this)}`)
      return sync.call(this)
    })
    onTestFinished(() => synced.mockRestore())
    exportSteps.after = (step) => {
      steps.push(step)
    }
    await save(d)
    const folder = process.platform === 'linux' ? `sync:${realpathSync(d.destDir)}` : 'sync:?'
    // the destination folder's fsync comes right after each rename, before anything else is journaled
    for (const i of [1, 2, 0]) expect(steps[steps.indexOf(`renamed:${String(i)}`) - 1]).toBe(folder)
    expectSaved(d.destDir)
  })

  it('checks that a save its journal calls done is there: a video moved away since is given up', async () => {
    let d = await download()
    await cutAt(d, 'done') // the cut came while the transfer folder was being removed
    rmSync(join(d.destDir, 'film.srt')) // a subtitle the user deleted: the save is done all the same
    expect(await resumeExport(d.dir)).toEqual({
      outcome: 'finished',
      name: 'film.mkv',
      video: join(d.destDir, 'film.mkv'),
      subtitles: [join(d.destDir, 'film.en.ass')],
    })
    expect(existsSync(d.dir)).toBe(false)

    d = await download()
    await cutAt(d, 'done')
    rmSync(join(d.destDir, 'film.mkv'))
    expect(await resumeExport(d.dir)).toEqual({
      outcome: 'rejoin',
      name: 'film.mkv',
      why: 'the saved video is gone',
      progress: (TOTAL - 3 * S) / TOTAL,
    })
    expect(await claimed(d)).toEqual(piecesOf(3))
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(false)
  })
})

describe('a save whose folder is not there (a drive unplugged, a share not mounted)', () => {
  afterEach(() => {
    exportSteps.after = null
  })

  /** The folder the export saves into goes away, as its drive would; back() brings it again. */
  function unplug(destDir: string): { back: () => void } {
    renameSync(destDir, `${destDir}-away`)
    return { back: () => renameSync(`${destDir}-away`, destDir) }
  }

  const away = { code: 'dest-unavailable', message: 'the folder it saves into is not there: connect its drive' }

  it('waits for it with the video partly saved, changing nothing, and finishes once it is back', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:1')
    const drive = unplug(d.destDir)
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    // the part on that drive is the only copy of the two segments it consumed: nothing was given up
    expect(journalOf(d.dir)).toEqual(j)
    expect(await claimed(d)).toEqual(piecesOf(0, 1, 2, 3))
    expect(readdirSync(join(d.dir, 'seg')).sort()).toEqual([segmentName(2), segmentName(3)])
    expect(await pendingExport(d.dir)).toEqual({ name: 'film.mkv', dest: d.destDir, away: true })
    expect(existsSync(d.destDir)).toBe(false)
    drive.back()
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished', video: join(d.destDir, 'film.mkv') })
    expectSaved(d.destDir)
    expect(existsSync(d.dir)).toBe(false)
  })

  it('waits for it before anything was consumed, without making a folder in its place', async () => {
    const d = await download()
    await cutAt(d, 'journal')
    const drive = unplug(d.destDir)
    // a mount point with nothing mounted: the video would land on the disk underneath
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    expect(existsSync(d.destDir)).toBe(false)
    // nor is a file where the folder was taken for it
    writeFileSync(d.destDir, '')
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    rmSync(d.destDir)
    drive.back()
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished' })
    expectSaved(d.destDir)
  })

  it('waits for it when segments it needs are gone, and gives up only once it is back', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:0')
    rmSync(join(d.dir, 'seg', segmentName(2)))
    const drive = unplug(d.destDir)
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    expect(journalOf(d.dir)).toEqual(j)
    expect(await claimed(d)).toEqual(piecesOf(0, 1, 2, 3))
    drive.back()
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'rejoin', why: 'parts of the download are gone' })
    expect(existsSync(j.files[0]?.part ?? '')).toBe(false) // removed now that it can be reached
    expect(await claimed(d)).toEqual(piecesOf(1, 3))
  })

  it('waits for it when it goes away while the export runs', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:1')
    // a journal whose last subtitle is still to be saved, so the run has steps before it reaches the video's part
    rmSync(join(d.destDir, 'film.en.ass'))
    const files = j.files.map((f, i) => (i === 2 ? { ...f, part: null, final: null, done: false } : f))
    writeFileSync(join(d.dir, EXPORT_FILE), JSON.stringify({ ...journalOf(d.dir), files }))
    let back = (): void => {
      throw new Error('the folder never went away')
    }
    exportSteps.after = (s) => {
      if (s === 'renamed:2') back = unplug(d.destDir).back
    }
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    exportSteps.after = null
    expect(journalOf(d.dir).consumedThrough).toBe(1)
    expect(await claimed(d)).toEqual(piecesOf(0, 1, 2, 3))
    back()
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished' })
    expectSaved(d.destDir)
  })

  // the folder goes at any other step of the run too (a subtitle's part, a rename, a copy): no raw ENOENT
  it.each(['part:1', 'final:1', 'renamed:1', 'part:0', 'copied:0'])(
    'waits for it when it goes away right after %s of a resumed run',
    async (step) => {
      const d = await download()
      await cutAt(d, 'journal')
      let back = (): void => {
        throw new Error('the folder never went away')
      }
      exportSteps.after = (s) => {
        if (s === step) back = unplug(d.destDir).back
      }
      await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
      exportSteps.after = null
      back()
      expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished' })
      expectSaved(d.destDir)
    },
  )

  it('says so when asked about it, by the same rule (a drive unmounted from its folder counts as away)', async () => {
    const d = await download()
    mkdirSync(d.destDir, { recursive: true })
    fakeMounts.add(d.destDir)
    onTestFinished(() => {
      fakeMounts.delete(d.destDir)
    })
    await cutAt(d, 'unlinked:1')
    expect(await pendingExport(d.dir)).toEqual({ name: 'film.mkv', dest: d.destDir, away: false })
    fakeMounts.delete(d.destDir)
    expect(await pendingExport(d.dir)).toEqual({ name: 'film.mkv', dest: d.destDir, away: true })
  })

  it("finds bind mounts, which keep their parent's device, in mountinfo (with its octal escapes)", () => {
    const info = [
      '22 1 0:21 / / rw,relatime shared:1 - btrfs /dev/nvme0n1p2 rw',
      '95 22 0:21 /home/ram/Videos /media/My\\040Drive rw,relatime shared:1 - btrfs /dev/nvme0n1p2 rw',
      '96 22 0:45 / /mnt/back\\134slash rw - tmpfs tmpfs rw',
      '',
    ].join('\n')
    expect(mountPointsIn(info)).toEqual(new Set(['/', '/media/My Drive', '/mnt/back\\slash']))
  })

  it('waits for a drive mounted on the folder itself, which is an empty folder while unmounted', async () => {
    const d = await download()
    mkdirSync(d.destDir, { recursive: true })
    fakeMounts.add(d.destDir)
    onTestFinished(() => {
      fakeMounts.delete(d.destDir)
    })
    const j = await cutAt(d, 'unlinked:1')
    expect(j.destMount).toBe(true)
    // unmounted: the part went with the drive, and what is left at that path is the empty folder underneath
    fakeMounts.delete(d.destDir)
    const drive = unplug(d.destDir)
    mkdirSync(d.destDir)
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    expect(journalOf(d.dir)).toEqual(j)
    expect(await claimed(d)).toEqual(piecesOf(0, 1, 2, 3))
    expect(readdirSync(d.destDir)).toEqual([]) // nothing written onto the disk underneath
    rmSync(d.destDir, { recursive: true })
    drive.back()
    fakeMounts.add(d.destDir)
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished' })
    expectSaved(d.destDir)
  })

  it('waits for it when its journal says done, until the video can be seen there', async () => {
    const d = await download()
    await cutAt(d, 'done')
    const drive = unplug(d.destDir)
    await expect(resumeExport(d.dir)).rejects.toMatchObject(away)
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(true)
    drive.back()
    expect(await resumeExport(d.dir)).toMatchObject({ outcome: 'finished', video: join(d.destDir, 'film.mkv') })
    expect(existsSync(d.dir)).toBe(false)
  })
})

describe('dropping a pending export (Cancel saving)', () => {
  it('counts what it consumed as missing again, removes its part and keeps what it saved', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:1')
    expect(await dropExport(d.dir)).toEqual({
      outcome: 'rejoin',
      name: 'film.mkv',
      why: 'saving it was cancelled',
      progress: (TOTAL - 2 * S) / TOTAL,
    })
    expect(await claimed(d)).toEqual(piecesOf(2, 3))
    expect(existsSync(j.files[0]?.part ?? '')).toBe(false)
    expect(readdirSync(d.destDir).sort()).toEqual(['film.en.ass', 'film.srt'])
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(false)
    expect(await dropExport(d.dir)).toBeNull()
    expect(await resumeExport(d.dir)).toBeNull()
  })

  it('drops it with its folder gone for good, touching nothing it cannot reach', async () => {
    const d = await download()
    const j = await cutAt(d, 'unlinked:1')
    renameSync(d.destDir, `${d.destDir}-gone`)
    expect(await dropExport(d.dir)).toMatchObject({ outcome: 'rejoin', progress: (TOTAL - 2 * S) / TOTAL })
    expect(await claimed(d)).toEqual(piecesOf(2, 3))
    expect(existsSync(join(d.dir, EXPORT_FILE))).toBe(false)
    expect(existsSync(join(`${d.destDir}-gone`, basename(j.files[0]?.part ?? '')))).toBe(true)
    expect(existsSync(d.destDir)).toBe(false)
  })

  it('finishes instead when the video turns out saved in full', async () => {
    for (const step of ['renamed:0', 'done']) {
      const d = await download()
      await cutAt(d, step)
      expect(await dropExport(d.dir)).toMatchObject({ outcome: 'finished', video: join(d.destDir, 'film.mkv') })
      expectSaved(d.destDir)
      expect(existsSync(d.dir)).toBe(false)
    }
  })
})

describe('export state on disk', () => {
  it('a journal counts as pending unless it is plainly not there', async () => {
    const d = await download()
    expect(await exportPending(d.dir)).toBe(false)
    expect(await exportPending(join(d.dir, 'nowhere'))).toBe(false)
    expect(await exportPending(join(d.dir, 'meta.torrent'))).toBe(false) // ENOTDIR
    await cutAt(d, 'part:0')
    expect(await exportPending(d.dir)).toBe(true)
    if (process.getuid?.() !== 0) {
      // a folder it cannot look into: whatever is there may be half of a video
      chmodSync(d.dir, 0o000)
      onTestFinished(() => chmodSync(d.dir, 0o755))
      expect(await exportPending(d.dir)).toBe(true)
    }
  })

  it('a folder is there only as a folder', async () => {
    const d = await download()
    expect(await folderThere(d.dir)).toBe(true)
    expect(await folderThere(join(d.dir, 'nowhere'))).toBe(false)
    expect(await folderThere(join(d.dir, 'meta.torrent'))).toBe(false)
    expect(await folderThere(join(d.dir, 'meta.torrent', 'x'))).toBe(false)
  })
})

describe('safe names', () => {
  it('sanitises the fallback too, and keeps only a plain extension on it', () => {
    // 'CON.srt:evil' is a device name; a raw fallback built from it would create an NTFS stream ('…srt:evi')
    expect(safeFileName('CON.srt:evil', 'subtitles-1.srt:evi')).toBe('subtitles-1.srt_evi')
    expect(safeExtension('CON.srt:evil')).toBe('')
    expect(safeExtension('dir\\CON.srt')).toBe('.srt')
    expect(safeExtension('x.exe')).toBe('')
    expect(safeFileName('', '')).toBe('file')
  })

  it('treats device names with spaces before the extension, and COM0/LPT¹, as reserved', () => {
    expect(safeFileName('con .srt', 'f')).toBe('f')
    expect(safeFileName('COM0.mkv', 'f')).toBe('f')
    expect(safeFileName('lpt¹', 'f')).toBe('f')
    expect(safeFileName('console.srt', 'f')).toBe('console.srt')
  })

  it('removes bidi controls that would disguise an extension, and defuses executables', () => {
    const rlo = String.fromCodePoint(0x202e)
    expect(safeFileName(`film${rlo}vkm.exe`, 'f')).toBe('film_vkm.exe')
    expect(defuseExecutable('film.mkv.exe')).toBe('film.mkv_exe')
    expect(defuseExecutable('Film.MKV.LNK')).toBe('Film.MKV_LNK')
    expect(defuseExecutable('film.mkv')).toBe('film.mkv')
  })

  it('keeps only allowlisted extensions: anything else is outranked by .bin, or the container for the video', () => {
    const sub = (n: string): string => savedFileName(n, { video: false, fallback: 'subtitles-1', videoExt: '.mp4' })
    const vid = (n: string): string => savedFileName(n, { video: true, fallback: 'video', videoExt: '.mp4' })
    // run, mount or configure something when opened, yet missed by any denylist
    for (const ext of ['msc', 'chm', 'xll', 'appref-ms', 'settingcontent-ms', 'iso', 'vhdx', 'terminal', 'docm']) {
      expect(sub(`film.mkv.${ext}`)).toBe(`film.mkv.${ext}.bin`)
      expect(vid(`film.mkv.${ext}`)).toBe(`film.mkv.${ext}.mp4`)
    }
    expect(sub('film.exe​')).toBe('film.exe​.bin')
    expect(sub('film.mkv.exe')).toBe('film.mkv_exe.bin')
    // kept as they are
    expect(sub('Film.en.SRT')).toBe('Film.en.SRT')
    for (const ext of ['ass', 'ssa', 'vtt', 'sub', 'idx', 'sup', 'mkv']) expect(sub(`s.${ext}`)).toBe(`s.${ext}`)
    for (const ext of ['mkv', 'MP4', 'm4v', 'webm', 'avi', 'mov', 'ts', 'm2ts', 'mts']) {
      expect(vid(`v.${ext}`)).toBe(`v.${ext}`)
    }
    // the video always ends in a video extension
    expect(vid('film.srt')).toBe('film.srt.mp4')
    expect(vid('film')).toBe('film.mp4')
    // fallbacks keep an allowlisted extension, or get the neutral one
    expect(vid('CON.mkv')).toBe('video.mkv')
    expect(vid('CON.exe')).toBe('video.mp4')
    expect(sub('NUL.ass')).toBe('subtitles-1.ass')
    expect(sub('..')).toBe('subtitles-1.bin')
    // appending never pushes a name past the length limit
    const long = sub(`${'x'.repeat(199)}.msc`)
    expect(long.endsWith('.bin')).toBe(true)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200)
  })

  it('never produces a dotfile: leading dots are stripped', () => {
    const sub = (n: string): string => savedFileName(n, { video: false, fallback: 'subtitles-1', videoExt: '.mkv' })
    expect(sub('.zshrc')).toBe('zshrc.bin')
    expect(sub('.bash_profile')).toBe('bash_profile.bin')
    expect(sub('. .profile')).toBe('profile.bin')
    expect(sub('...film.srt')).toBe('film.srt')
    expect(savedFileName('.mkv', { video: true, fallback: 'video', videoExt: '.mkv' })).toBe('mkv.mkv')
    expect(safeFileName('.hidden.srt', 'f')).toBe('hidden.srt')
    const huge = String.fromCodePoint(0x61, ...Array.from({ length: 150 }, () => 0x301)) // one 301-byte grapheme
    expect(safeFileName(`${huge}.srt`, 'f')).toBe('f') // not '.srt'
  })

  it("names the video's container from its first bytes", () => {
    const at = (offset: number, ascii: string, size = 512): Buffer => {
      const b = Buffer.alloc(size)
      b.write(ascii, offset, 'latin1')
      return b
    }
    const ebml = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(60)])
    expect(containerExtension(ebml)).toBe('.mkv')
    expect(containerExtension(Buffer.concat([ebml.subarray(0, 20), Buffer.from('webm')]))).toBe('.webm')
    expect(containerExtension(at(4, 'ftypisom'))).toBe('.mp4')
    expect(containerExtension(at(4, 'ftypqt  '))).toBe('.mov')
    expect(containerExtension(at(4, 'moov'))).toBe('.mp4')
    const avi = at(0, 'RIFF')
    avi.write('AVI ', 8, 'latin1')
    expect(containerExtension(avi)).toBe('.avi')
    const ts = Buffer.alloc(400)
    ts[0] = ts[188] = 0x47
    expect(containerExtension(ts)).toBe('.ts')
    const m2ts = Buffer.alloc(400)
    m2ts[4] = m2ts[196] = 0x47
    expect(containerExtension(m2ts)).toBe('.m2ts')
    expect(containerExtension(Buffer.from('unknown'))).toBe('.mkv')
    expect(containerExtension(Buffer.alloc(0))).toBe('.mkv')
  })

  it('truncates long names on whole graphemes, keeping the extension', () => {
    const family = String.fromCodePoint(0x1f469, 0x200d, 0x1f469, 0x200d, 0x1f467) // one grapheme, 18 bytes
    const name = safeFileName(`${family.repeat(40)}.mkv`, 'f')
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
    expect(name.endsWith('.mkv')).toBe(true)
    expect(name.slice(0, -4).length % family.length).toBe(0)
  })
})
