import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const DEBOUNCE_MS = 2000

const SnapshotSchema = z.object({
  syncEpoch: z.number(),
  seq: z.number(),
  lastAnchor: z.object({ posS: z.number(), mode: z.enum(['idle', 'paused', 'playing', 'waiting', 'ended']) }),
  started: z.boolean(),
  perms: z.object({ othersPlayPause: z.boolean(), othersSeek: z.boolean() }),
  waitForAll: z.boolean(),
  startMode: z.union([
    z.object({ kind: z.literal('buffered'), seconds: z.number() }),
    z.object({ kind: z.literal('play-through') }),
  ]),
})

export const SessionFileSchema = z.object({
  v: z.literal(1),
  role: z.enum(['host', 'viewer']),
  roomId: z.string(),
  fileName: z.string().nullable(),
  fileSize: z.number().nullable(),
  durationS: z.number().nullable(),
  infoHash: z.string().nullable(),
  /** host: what to re-prepare from the hash cache */
  videoPath: z.string().optional(),
  subtitlePaths: z.array(z.string()).optional(),
  group: SnapshotSchema.optional(),
  /** viewer: where the partial download lives */
  saveDir: z.string().optional(),
  transferDir: z.string().optional(),
  progress: z.number().optional(),
  updatedAt: z.number(),
})
export type SessionFileData = z.infer<typeof SessionFileSchema>

export function sessionFilePath(userData: string, roomId: string): string {
  return join(userData, 'wt', 'rooms', roomId, 'session.json')
}

export async function readSessionFile(userData: string, roomId: string): Promise<SessionFileData | null> {
  const raw = await readFile(sessionFilePath(userData, roomId), 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const parsed = SessionFileSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * session.json for one room (plan §4.5 "Host restart"): written atomically, debounced to 2 s unless an update
 * asks for `now` (the host's publishes: a resume must not start below a seq viewers already hold).
 */
export class SessionFile {
  private data: SessionFileData
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()
  /** the write waiting behind the one in flight; it takes the newest data when it starts */
  private queued: Promise<void> | null = null

  constructor(
    private readonly path: string,
    initial: SessionFileData,
  ) {
    this.data = initial
  }

  get current(): SessionFileData {
    return this.data
  }

  update(patch: Partial<SessionFileData>, opts: { now?: boolean } = {}): void {
    this.data = { ...this.data, ...patch, updatedAt: Date.now() }
    if (opts.now) {
      void this.flush()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, DEBOUNCE_MS)
    this.timer.unref()
  }

  /** Resolves once the data as of this call is on disk. Writes run one at a time; a burst shares the next. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.queued ??= this.writing
      .then(() => {
        this.queued = null
        return writeAtomic(this.path, JSON.stringify(this.data))
      })
      .catch(() => undefined)
    this.writing = this.queued
    return this.queued
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  const fh = await open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, path)
}
