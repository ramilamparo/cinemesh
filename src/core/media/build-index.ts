import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { decodeMediaIndex, encodeMediaIndex, normalizeIndex } from '../../shared/media/manifest.js'
import type { MediaIndex } from '../../shared/media/types.js'
import { type ByteSource, FileSource, type ProgressFn, checkAborted } from './byte-source.js'
import { indexMkv } from './ebml.js'
import { findFfprobe, indexGeneric, sniffTransportStream } from './fallback.js'
import { indexMp4 } from './mp4.js'

export const MEDIA_CACHE_FILE = 'media-v1.bin'

export type Sniffed = 'mkv' | 'mp4' | 'avi' | 'mpegts' | 'generic'

const MP4_TOP = new Set(['ftyp', 'moov', 'free', 'mdat', 'skip', 'wide', 'pnot'])

export async function sniff(src: ByteSource): Promise<Sniffed> {
  const h = await src.read(0, 512)
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return 'mkv'
  const at4 = String.fromCharCode(...h.subarray(4, 8))
  if (MP4_TOP.has(at4)) return 'mp4'
  const riff = String.fromCharCode(...h.subarray(0, 4))
  if (riff === 'RIFF' && String.fromCharCode(...h.subarray(8, 12)) === 'AVI ') return 'avi'
  if (sniffTransportStream(h)) return 'mpegts'
  return 'generic'
}

export interface IndexOptions {
  signal?: AbortSignal
  onProgress?: ProgressFn
  /** Duration to assume for a linear map when nothing in the file (or ffprobe) gives one. */
  durationHintMs?: number
  /** undefined: look on PATH; null: never use ffprobe. */
  ffprobePath?: string | null
}

/**
 * Indexes a file on the calling thread. buildMediaIndex runs this in a worker; it is exported for
 * the worker and for tests. A container parser that fails falls back to the generic index.
 */
export async function indexMediaFile(path: string, opts: IndexOptions = {}): Promise<MediaIndex> {
  const src = await FileSource.open(path)
  try {
    const kind = await sniff(src)
    const common = {
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    }
    let index: MediaIndex | null = null
    try {
      if (kind === 'mkv') {
        index = await indexMkv(src, {
          ...common,
          ...(opts.durationHintMs !== undefined ? { durationHintMs: opts.durationHintMs } : {}),
        })
      } else if (kind === 'mp4') index = await indexMp4(src, common)
    } catch (e) {
      checkAborted(opts.signal)
      if (kind !== 'mkv' && kind !== 'mp4') throw e
    }
    if (!index) {
      const ffprobePath = opts.ffprobePath === undefined ? await findFfprobe() : opts.ffprobePath
      index = await indexGeneric(src, {
        path,
        container: kind === 'avi' || kind === 'mpegts' ? kind : 'generic',
        ffprobePath,
        ...common,
        ...(opts.durationHintMs !== undefined ? { durationHintMs: opts.durationHintMs } : {}),
      })
    }
    opts.onProgress?.(src.size, src.size)
    return normalizeIndex(index)
  } finally {
    await src.close()
  }
}

export interface BuildOptions extends IndexOptions {
  /** Directory of the per-file host cache (<userData>/wt/host-cache/<key>); the caller owns the key. */
  cacheDir?: string
  /** Worker entry; defaults to index-worker.{js,ts} next to this module. */
  workerUrl?: URL | string
}

export interface BuiltIndex {
  index: MediaIndex
  cached: boolean
}

export type WorkerRequest = { type: 'cancel' }
export type WorkerReply =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; index: MediaIndex }
  | { type: 'error'; message: string }

export interface WorkerInput {
  path: string
  durationHintMs?: number
  ffprobePath?: string | null
}

const CANCEL_GRACE_MS = 2000

/** Builds (or loads from the cache) the index of `path` in a worker thread. */
export async function buildMediaIndex(path: string, opts: BuildOptions = {}): Promise<BuiltIndex> {
  checkAborted(opts.signal)
  const size = (await stat(path)).size
  if (opts.cacheDir) {
    const hit = await readCache(opts.cacheDir, size)
    if (hit) return { index: hit, cached: true }
  }
  checkAborted(opts.signal)
  const index = await runWorker(path, opts)
  if (opts.cacheDir) await writeCache(opts.cacheDir, index)
  return { index, cached: false }
}

async function readCache(dir: string, size: number): Promise<MediaIndex | null> {
  try {
    const index = decodeMediaIndex(await readFile(join(dir, MEDIA_CACHE_FILE)))
    return index.fileSize === size ? index : null
  } catch {
    return null
  }
}

async function writeCache(dir: string, index: MediaIndex): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, MEDIA_CACHE_FILE)
  const tmp = `${file}.${String(process.pid)}.tmp`
  await writeFile(tmp, encodeMediaIndex(index))
  await rename(tmp, file)
}

function defaultWorker(): { url: URL; execArgv: string[] } {
  // Under tsx/vitest this module is TypeScript, so the worker needs the tsx loader too.
  const ts = import.meta.url.endsWith('.ts')
  return {
    url: new URL(ts ? './index-worker.ts' : './index-worker.js', import.meta.url),
    execArgv: ts ? ['--import', 'tsx'] : [],
  }
}

function runWorker(path: string, opts: BuildOptions): Promise<MediaIndex> {
  const def = defaultWorker()
  const input: WorkerInput = { path }
  if (opts.durationHintMs !== undefined) input.durationHintMs = opts.durationHintMs
  if (opts.ffprobePath !== undefined) input.ffprobePath = opts.ffprobePath
  const worker = new Worker(opts.workerUrl ?? def.url, {
    workerData: input,
    execArgv: opts.workerUrl ? [] : def.execArgv,
  })
  return new Promise<MediaIndex>((resolve, reject) => {
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => {
      worker.postMessage({ type: 'cancel' } satisfies WorkerRequest)
      killTimer = setTimeout(() => void worker.terminate(), CANCEL_GRACE_MS)
      finish(() => reject(abortReason(opts.signal)))
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('message', (m: WorkerReply) => {
      if (m.type === 'progress') opts.onProgress?.(m.done, m.total)
      else if (m.type === 'done') finish(() => resolve(m.index))
      else finish(() => reject(new Error(m.message)))
    })
    worker.on('error', (e: Error) => finish(() => reject(e)))
    worker.on('exit', (code) => {
      if (killTimer) clearTimeout(killTimer)
      finish(() => reject(new Error(`index worker exited with code ${String(code)}`)))
    })
  })
}

function abortReason(signal: AbortSignal | undefined): Error {
  const r: unknown = signal?.reason
  return r instanceof Error ? r : new Error('aborted')
}
