import { EventEmitter } from 'node:events'
import type { MpvInfo } from '../shared/ipc/control.js'
import { type LocateOptions, type MpvLocateResult, locateMpv, toMpvInfo } from './mpv-locate.js'

type Locate = (opts: LocateOptions) => Promise<MpvLocateResult>

interface Logger {
  info(msg: string): void
  warn(msg: string): void
}

interface Lookup {
  mpvPath: string | null
  promise: Promise<MpvInfo>
}

export const NO_MPV: MpvInfo = { path: null, kind: 'none', version: null, status: 'missing', tried: [] }

/**
 * Main's view of mpv (plan §4.4/§4.6). The lookup runs at startup, again when settings.mpvPath changes, and when
 * the renderer asks for a recheck. Each finished lookup becomes `info` (diagnostics read it) and is emitted as
 * 'change' (index.ts forwards it to core as `{type: 'mpv'}`).
 *
 * Lookups run one after another, so results apply in request order and the latest request wins. A request for the
 * same mpvPath as a lookup that has not finished yet joins it: saving Settings triggers one lookup from the settings
 * change and the renderer's recheck right after, and core should hear about it once.
 */
export class MpvService extends EventEmitter<{ change: [MpvInfo] }> {
  private current: MpvInfo = NO_MPV
  /** mpvPath of the latest finished lookup; undefined before the first */
  private lastPath: string | null | undefined = undefined
  private tail: Lookup | null = null
  private settled: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly resourcesPath: string | null,
    private readonly log: Logger,
    private readonly locate: Locate = locateMpv,
  ) {
    super()
  }

  get info(): MpvInfo {
    return this.current
  }

  /** Look for mpv now (joins a pending lookup for the same mpvPath). */
  lookup(mpvPath: string | null): Promise<MpvInfo> {
    if (this.tail?.mpvPath === mpvPath) return this.tail.promise
    const entry: Lookup = { mpvPath, promise: Promise.resolve(NO_MPV) }
    entry.promise = this.settled.then(() => this.run(entry))
    this.tail = entry
    this.settled = entry.promise.catch(() => undefined)
    return entry.promise
  }

  /** For settings changes: looks again only when mpvPath differs from the one last looked up (or queued). */
  settingsChanged(mpvPath: string | null): Promise<MpvInfo> | null {
    const latest = this.tail ? this.tail.mpvPath : this.lastPath
    if (latest !== undefined && latest === mpvPath) return null
    return this.lookup(mpvPath)
  }

  private async run(entry: Lookup): Promise<MpvInfo> {
    let info: MpvInfo
    try {
      info = toMpvInfo(await this.locate({ mpvPath: entry.mpvPath, resourcesPath: this.resourcesPath }))
    } catch (e) {
      this.log.warn(`mpv lookup failed: ${e instanceof Error ? e.message : String(e)}`)
      info = NO_MPV
    }
    if (this.tail === entry) this.tail = null
    this.current = info
    this.lastPath = entry.mpvPath
    this.log.info(
      `mpv ${info.status ?? '?'}: ${info.kind}${info.path ? ` ${info.path}` : ''}${info.version ? ` ${info.version}` : ''}`,
    )
    this.emit('change', info)
    return info
  }
}
