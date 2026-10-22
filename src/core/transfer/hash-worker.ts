import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

// worker_threads entry: SHA-1 of a contiguous range of pieces (plan §4.2 "Host prepare").
// Hashes go straight into a SharedArrayBuffer; a shared Int32 flag cancels between pieces.

export interface HashWorkerInput {
  files: { path: string; offset: number; length: number }[]
  pieceLength: number
  totalLength: number
  /** pieces [from, to) */
  from: number
  to: number
  /** 20 bytes per piece of the whole torrent */
  hashes: SharedArrayBuffer
  /** Int32Array[0] !== 0 means stop */
  cancel: SharedArrayBuffer
}

export type HashWorkerReply =
  { type: 'progress'; bytes: number } | { type: 'done' } | { type: 'error'; message: string }

const PROGRESS_MS = 250

function run(input: HashWorkerInput): void {
  const fds = input.files.map((f) => openSync(f.path, 'r'))
  const hashes = new Uint8Array(input.hashes)
  const cancel = new Int32Array(input.cancel)
  const buf = Buffer.allocUnsafe(input.pieceLength)
  let reported = 0
  let bytes = 0
  let last = performance.now()
  try {
    for (let i = input.from; i < input.to; i++) {
      if (Atomics.load(cancel, 0) !== 0) return
      const start = i * input.pieceLength
      const size = Math.min(input.pieceLength, input.totalLength - start)
      readPiece(input, fds, buf, start, size)
      const digest = createHash('sha1').update(buf.subarray(0, size)).digest()
      hashes.set(digest, i * 20)
      bytes += size
      const now = performance.now()
      if (now - last >= PROGRESS_MS) {
        post({ type: 'progress', bytes: bytes - reported })
        reported = bytes
        last = now
      }
    }
    post({ type: 'progress', bytes: bytes - reported })
    post({ type: 'done' })
  } finally {
    for (const fd of fds) closeSync(fd)
  }
}

function readPiece(input: HashWorkerInput, fds: number[], buf: Buffer, start: number, size: number): void {
  let done = 0
  for (let f = 0; f < input.files.length && done < size; f++) {
    const file = input.files[f]
    const fd = fds[f]
    if (!file || fd === undefined) break
    const pos = start + done - file.offset
    if (pos < 0 || pos >= file.length) continue
    const want = Math.min(size - done, file.length - pos)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, done + got, want - got, pos + got)
      if (n === 0) throw new Error(`${file.path} is shorter than expected`)
      got += n
    }
    done += want
  }
  if (done < size) throw new Error('piece extends past the last file')
}

function post(m: HashWorkerReply): void {
  parentPort?.postMessage(m)
}

if (parentPort) {
  try {
    run(workerData as HashWorkerInput)
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
