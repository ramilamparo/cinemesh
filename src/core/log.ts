import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'

const MAX_BYTES = 5 * 1024 * 1024
type Level = 'debug' | 'info' | 'warn' | 'error'

/**
 * core.log writer: one line per entry, rotated once at 5 MB (core.log -> core.old.log).
 * Lines before init (when the logs directory is known) are buffered. Never throws.
 */
export class CoreLog {
  private file: string | null = null
  private buffer: string[] = []
  private chain: Promise<void> = Promise.resolve()
  private readonly recent: string[] = []

  async open(logsDir: string): Promise<void> {
    await mkdir(logsDir, { recursive: true })
    this.file = join(logsDir, 'core.log')
    const pending = this.buffer
    this.buffer = []
    for (const line of pending) this.write(line)
  }

  debug(msg: string): void {
    this.log('debug', msg)
  }
  info(msg: string): void {
    this.log('info', msg)
  }
  warn(msg: string): void {
    this.log('warn', msg)
  }
  error(msg: string, e?: unknown): void {
    const detail = e instanceof Error ? ` ${e.stack ?? e.message}` : e === undefined ? '' : ` ${inspect(e)}`
    this.log('error', msg + detail)
  }

  /** Last lines for diagnostics. */
  tail(n = 200): string[] {
    return this.recent.slice(-n)
  }

  flush(): Promise<void> {
    return this.chain
  }

  private log(level: Level, msg: string): void {
    const line = `${new Date().toISOString()} [${level}] ${msg}`
    this.recent.push(line)
    if (this.recent.length > 500) this.recent.splice(0, this.recent.length - 500)
    if (this.file === null) this.buffer.push(line)
    else this.write(line)
  }

  private write(line: string): void {
    const file = this.file
    if (file === null) return
    this.chain = this.chain
      .then(async () => {
        const size = await stat(file).then(
          (s) => s.size,
          () => 0,
        )
        if (size > MAX_BYTES) await rename(file, join(file, '..', 'core.old.log'))
        await appendFile(file, `${line}\n`)
      })
      .catch(() => undefined)
  }
}

export const log = new CoreLog()
