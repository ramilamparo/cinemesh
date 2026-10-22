import { createHash, randomInt } from 'node:crypto'
import { mkdir, open, readFile, realpath, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { HashWorkerInput, HashWorkerReply } from './hash-worker.js'
import type { SourceFile } from './source-files.js'
import {
  type TorrentLayout,
  buildTorrent,
  layoutFiles,
  pieceLengthFor,
  pieceSize,
  wholeVideoPieces,
} from './torrent-builder.js'

export interface PrepareProgress {
  bytesDone: number
  bytesTotal: number
  bytesPerSec: number
  cached: boolean
}

export interface PrepareOptions {
  videoPath: string
  subtitlePaths: readonly string[]
  /** <userData>/wt/host-cache */
  cacheRoot: string
  workers?: number
  /** tests only; production derives it from the size */
  pieceLength?: number
  signal?: AbortSignal
  onProgress?: (p: PrepareProgress) => void
  /** bundled worker entry; defaults to hash-worker.{js,ts} next to this module */
  workerUrl?: URL
}

export interface PreparedTorrent {
  torrent: Buffer
  infoHash: string
  layout: TorrentLayout
  sources: SourceFile[]
  /** sha1(size | mtimeMs | sha1(head 64 KiB + tail 64 KiB)) of the video: also keys the media index cache */
  cacheKey: string
  cacheDir: string
  /** whole-video hashes came from the cache (after a 3-piece spot check) */
  cached: boolean
}

const EDGE_BYTES = 64 * 1024
const PROGRESS_MS = 250
const TERMINATE_AFTER_CANCEL_MS = 1000

/**
 * Hashes the host's files into the session torrent (plan §4.2 "Host prepare"). Whole-video piece hashes
 * are cached per file, so hosting the same file again costs a spot check of 3 pieces plus the tail.
 */
export async function prepareHost(opts: PrepareOptions): Promise<PreparedTorrent> {
  const paths = [opts.videoPath, ...opts.subtitlePaths]
  const real = await Promise.all(paths.map((p) => realpath(p)))
  const stats = await Promise.all(real.map((p) => stat(p)))
  for (const [i, s] of stats.entries()) {
    if (!s.isFile()) throw new Error(`${real[i] ?? '?'} is not a regular file`)
  }
  const total = stats.reduce((n, s) => n + s.size, 0)
  if (total === 0) throw new Error('the video is empty')
  const layout = layoutFiles(
    real,
    stats.map((s) => s.size),
    opts.pieceLength ?? pieceLengthFor(total),
  )
  const sources: SourceFile[] = layout.files.map((f, i) => ({
    path: real[i] ?? '',
    offset: f.offset,
    length: f.length,
    mtimeMs: stats[i]?.mtimeMs ?? 0,
  }))
  const video = sources[0]
  if (!video) throw new Error('no video')
  const cacheKey = await videoCacheKey(video)
  const cacheDir = join(opts.cacheRoot, cacheKey)
  const cacheFile = join(cacheDir, `pieces-${String(layout.pieceLength)}.bin`)
  const whole = wholeVideoPieces(layout)

  const hashes = new SharedArrayBuffer(layout.pieceCount * 20)
  const view = new Uint8Array(hashes)
  let cached = false
  const fromCache = await readFile(cacheFile).catch(() => null)
  if (fromCache?.byteLength === whole * 20) {
    view.set(fromCache, 0)
    cached = await spotCheck(sources, layout, view, whole)
  }
  const firstToHash = cached ? whole : 0
  const bytesTotal = layout.length - firstToHash * layout.pieceLength
  await hashPieces(sources, layout, hashes, firstToHash, bytesTotal, cached, opts)

  if (!cached && whole > 0) await writeAtomic(cacheDir, cacheFile, view.subarray(0, whole * 20))
  const { torrent, infoHash } = buildTorrent(layout, view)
  return { torrent, infoHash, layout, sources, cacheKey, cacheDir, cached }
}

/** The host-cache key of a video, so the media index can share the same <cacheRoot>/<key>/ directory. */
export async function cacheKeyFor(videoPath: string): Promise<string> {
  const real = await realpath(videoPath)
  const s = await stat(real)
  return videoCacheKey({ path: real, offset: 0, length: s.size, mtimeMs: s.mtimeMs })
}

async function videoCacheKey(video: SourceFile): Promise<string> {
  const fh = await open(video.path, 'r')
  try {
    const head = Buffer.alloc(Math.min(EDGE_BYTES, video.length))
    const tail = Buffer.alloc(Math.min(EDGE_BYTES, video.length))
    await fh.read(head, 0, head.byteLength, 0)
    await fh.read(tail, 0, tail.byteLength, video.length - tail.byteLength)
    const edges = createHash('sha1').update(head).update(tail).digest('hex')
    return createHash('sha1')
      .update(`${String(video.length)}|${String(video.mtimeMs)}|${edges}`)
      .digest('hex')
  } finally {
    await fh.close()
  }
}

/** Re-hashes the first, last and one random cached piece; any mismatch discards the cache. */
async function spotCheck(
  sources: SourceFile[],
  layout: TorrentLayout,
  view: Uint8Array,
  whole: number,
): Promise<boolean> {
  const picks = [...new Set([0, whole - 1, randomInt(whole)])]
  const video = sources[0]
  if (!video) return false
  const fh = await open(video.path, 'r')
  try {
    for (const i of picks) {
      const buf = Buffer.alloc(pieceSize(layout, i))
      await fh.read(buf, 0, buf.byteLength, i * layout.pieceLength)
      const digest = createHash('sha1').update(buf).digest()
      if (!digest.equals(view.subarray(i * 20, i * 20 + 20))) return false
    }
    return true
  } finally {
    await fh.close()
  }
}

async function hashPieces(
  sources: SourceFile[],
  layout: TorrentLayout,
  hashes: SharedArrayBuffer,
  from: number,
  bytesTotal: number,
  cached: boolean,
  opts: PrepareOptions,
): Promise<void> {
  const count = layout.pieceCount - from
  if (count <= 0) {
    opts.onProgress?.({ bytesDone: 0, bytesTotal: 0, bytesPerSec: 0, cached })
    return
  }
  const workers = Math.max(1, Math.min(opts.workers ?? 2, 4, Math.ceil(count / 8)))
  const cancel = new SharedArrayBuffer(4)
  const started = performance.now()
  let bytesDone = 0
  let lastReport = 0
  const report = (force: boolean): void => {
    const now = performance.now()
    if (!force && now - lastReport < PROGRESS_MS) return
    lastReport = now
    const secs = (now - started) / 1000
    opts.onProgress?.({ bytesDone, bytesTotal, bytesPerSec: secs > 0 ? bytesDone / secs : 0, cached })
  }
  const def = defaultWorker()
  const per = Math.ceil(count / workers)
  const ranges = Array.from({ length: workers }, (_, w) => [
    from + w * per,
    Math.min(from + (w + 1) * per, layout.pieceCount),
  ])

  const spawned: Worker[] = []
  const running = ranges
    .filter(([a, b]) => (a ?? 0) < (b ?? 0))
    .map(([a, b]) => {
      const input: HashWorkerInput = {
        files: sources.map((s) => ({ path: s.path, offset: s.offset, length: s.length })),
        pieceLength: layout.pieceLength,
        totalLength: layout.length,
        from: a ?? 0,
        to: b ?? 0,
        hashes,
        cancel,
      }
      const worker = new Worker(opts.workerUrl ?? def.url, {
        workerData: input,
        execArgv: opts.workerUrl ? [] : def.execArgv,
      })
      spawned.push(worker)
      return new Promise<void>((resolve, reject) => {
        worker.on('message', (m: HashWorkerReply) => {
          if (m.type === 'progress') {
            bytesDone += m.bytes
            report(false)
          } else if (m.type === 'error') reject(new Error(m.message))
        })
        worker.once('error', reject)
        // a cancelled worker returns early (exit 0) or is terminated after the grace period
        worker.once('exit', (code) => {
          if (code === 0 || opts.signal?.aborted) resolve()
          else reject(new Error(`hash worker exited with ${String(code)}`))
        })
      })
    })

  const onAbort = (): void => {
    Atomics.store(new Int32Array(cancel), 0, 1)
    setTimeout(() => {
      for (const w of spawned) void w.terminate()
    }, TERMINATE_AFTER_CANCEL_MS).unref()
  }
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.all(running)
  } catch (e) {
    for (const w of spawned) void w.terminate()
    throw e
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
  if (opts.signal?.aborted) throw opts.signal.reason as Error
  report(true)
}

function defaultWorker(): { url: URL; execArgv: string[] } {
  // Under tsx/vitest this module is TypeScript, so the worker needs the tsx loader too.
  const ts = import.meta.url.endsWith('.ts')
  return {
    url: new URL(ts ? './hash-worker.ts' : './hash-worker.js', import.meta.url),
    execArgv: ts ? ['--import', 'tsx'] : [],
  }
}

async function writeAtomic(dir: string, file: string, data: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp`
  const fh = await open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, file)
}
