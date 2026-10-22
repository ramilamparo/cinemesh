import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type SessionFileData, SessionFile, readSessionFile, sessionFilePath } from './session-file.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function setup(): { userData: string; file: SessionFile } {
  const userData = mkdtempSync(join(tmpdir(), 'wt-session-file-'))
  dirs.push(userData)
  const initial: SessionFileData = {
    v: 1,
    role: 'host',
    roomId: 'r1',
    fileName: 'clip.mkv',
    fileSize: 1000,
    durationS: null,
    infoHash: null,
    videoPath: '/videos/clip.mkv',
    subtitlePaths: [],
    updatedAt: 0,
  }
  return { userData, file: new SessionFile(sessionFilePath(userData, 'r1'), initial) }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const t0 = Date.now()
  for (;;) {
    const v = await read()
    if (ok(v) || Date.now() - t0 > ms) return v
    await sleep(20)
  }
}

describe('SessionFile', () => {
  it('debounces plain updates by 2 s, and writes at once when asked to', async () => {
    const { userData, file } = setup()
    file.update({ progress: 0.1 })
    await sleep(300)
    expect(await readSessionFile(userData, 'r1')).toBeNull()

    // the host's publishes: on disk well inside the debounce, with everything updated so far
    file.update({ progress: 0.2 }, { now: true })
    const got = await waitFor(
      () => readSessionFile(userData, 'r1'),
      (d) => d?.progress === 0.2,
      1000,
    )
    expect(got?.progress).toBe(0.2)
    expect(got?.videoPath).toBe('/videos/clip.mkv')
  })

  it('flush resolves with the data as of the call on disk; a burst of writes ends with the newest data', async () => {
    const { userData, file } = setup()
    await file.flush()
    expect((await readSessionFile(userData, 'r1'))?.roomId).toBe('r1') // created at once, e.g. at hosting start

    for (let i = 1; i <= 20; i++) file.update({ progress: i / 20 }, { now: true })
    const p = file.flush()
    file.update({ durationS: 42 }) // after the flush call: may ride along, never lost by the burst
    await p
    expect((await readSessionFile(userData, 'r1'))?.progress).toBe(1)
    await file.flush()
    expect(await readSessionFile(userData, 'r1')).toMatchObject({ progress: 1, durationS: 42 })
  })
})
