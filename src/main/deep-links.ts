import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { app } from 'electron'
import { INVITE_SCHEME, extractInvite } from '../shared/invite-link.js'

/**
 * Collects cinemesh:// links from every OS entry point and queues them until the renderer asks.
 * macOS delivers them through 'open-url' (possibly before 'ready'); Windows and Linux through argv,
 * either at first launch or via 'second-instance'.
 */
export class DeepLinks extends EventEmitter<{ link: [string] }> {
  private pending: string | null = null

  constructor() {
    super()
    app.on('open-url', (e, url) => {
      e.preventDefault()
      this.offer(url)
    })
    this.offer(fromArgv(process.argv))
  }

  /** Data passed to requestSingleInstanceLock so the first instance sees the link exactly. */
  lockData(): { link: string | null } {
    return { link: this.pending }
  }

  handleSecondInstance(argv: readonly string[], additionalData: unknown): void {
    const data = additionalData as { link?: unknown } | null
    this.offer(typeof data?.link === 'string' ? data.link : fromArgv(argv))
  }

  take(): string | null {
    const link = this.pending
    this.pending = null
    return link
  }

  registerAsDefault(): void {
    if (process.platform !== 'win32') return // macOS: Info.plist; Linux: .desktop from the package
    if (app.isPackaged) app.setAsDefaultProtocolClient(INVITE_SCHEME)
    else if (process.argv[1])
      app.setAsDefaultProtocolClient(INVITE_SCHEME, process.execPath, [resolve(process.argv[1])])
  }

  private offer(candidate: string | null): void {
    const invite = candidate ? extractInvite(candidate) : null
    if (!invite) return
    this.pending = invite
    this.emit('link', invite)
  }
}

function fromArgv(argv: readonly string[]): string | null {
  return argv.find((a) => a.startsWith(`${INVITE_SCHEME}://`)) ?? null
}
