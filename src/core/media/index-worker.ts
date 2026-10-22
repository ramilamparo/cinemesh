import { parentPort, workerData } from 'node:worker_threads'
import { type WorkerInput, type WorkerReply, indexMediaFile } from './build-index.js'

// worker_threads entry for buildMediaIndex(): indexes one file, reports progress at most every
// 250 ms and stops at the next checkpoint when it receives 'cancel'.

const PROGRESS_MS = 250

function post(m: WorkerReply): void {
  parentPort?.postMessage(m)
}

async function main(): Promise<void> {
  const input = workerData as WorkerInput
  const ac = new AbortController()
  // WorkerRequest has one kind: 'cancel'
  parentPort?.on('message', () => ac.abort(new Error('indexing cancelled')))
  let last = 0
  try {
    const index = await indexMediaFile(input.path, {
      signal: ac.signal,
      ...(input.durationHintMs !== undefined ? { durationHintMs: input.durationHintMs } : {}),
      ...(input.ffprobePath !== undefined ? { ffprobePath: input.ffprobePath } : {}),
      onProgress: (done, total) => {
        const now = Date.now()
        if (now - last < PROGRESS_MS && done < total) return
        last = now
        post({ type: 'progress', done, total })
      },
    })
    post({ type: 'done', index })
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  } finally {
    parentPort?.removeAllListeners('message')
  }
}

void main()
