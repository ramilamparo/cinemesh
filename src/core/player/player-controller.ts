import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { copyFile, mkdir, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Duplex } from 'node:stream'
import type { PlayerEvent, PlayerStatus, Role, Span, TrackInfo, TracksEvent } from '../../shared/ipc/core.js'
import type { Settings } from '../../shared/settings.js'
import type { ThemePayload } from '../../shared/theme-tokens.js'
import { CodedError } from '../../shared/result.js'
import { log as coreLog } from '../log.js'
import { mpvChildEnv } from './child-env.js'
import { type HdrStatus, hdrStatus, sameHdr } from './hdr-status.js'
import { type IpcSpec, type MpvOs, type SessionType, buildMpvArgs } from './mpv-args.js'
import { MpvIpc, type MpvEvent, type Timed } from './mpv-ipc.js'
import { type MpvVersion, formatVersion } from './mpv-version.js'
import {
  OSC_SCRIPT,
  OscBridge,
  type OscIntent,
  type OscKind,
  type OscMessages,
  type OscPerms,
  type OscStrings,
  type OscTiming,
} from './osc-bridge.js'

export const PLAYER_ERRORS = {
  notRunning: 'player-not-running',
  loadFailed: 'player-load-failed',
  superseded: 'player-superseded',
  exited: 'player-exited',
} as const

export const OBSERVED_PROPERTIES = [
  'time-pos',
  'pause',
  'paused-for-cache',
  'seeking',
  'core-idle',
  'speed',
  'eof-reached',
  'path',
  'duration',
  'track-list',
  'aid',
  'sid',
  'volume',
  'mute',
  'audio-out-params',
  'video-params',
  'video-target-params',
  'demuxer-cache-state',
  'frame-drop-count',
  'decoder-frame-drop-count',
  'current-gpu-context',
  'hwdec-current',
  // the file's frame rate: sync's frame length (where a seek or load lands; PlayerPortAdapter.snapshot)
  'container-fps',
] as const
export type ObservedProperty = (typeof OBSERVED_PROPERTIES)[number]

export interface MpvBinary {
  /** executable; for kind 'flatpak' the flatpak binary itself */
  path: string
  kind: 'bundled' | 'system' | 'flatpak'
  version: MpvVersion
}

export interface PlayerHooks {
  /** OSC toggle -> play or pause, decided from the room state. Default: the opposite of expected.paused. */
  resolveToggle?: () => 'play' | 'pause'
  /** OSC seek-rel -> absolute seconds. Default: last time-pos + delta, clamped to [0, duration]. */
  resolveSeekRel?: (deltaS: number) => number
  /** Room position to reload at after a crash, a path change or reopen (selfReload only). Default: last time-pos. */
  restartPosition?: () => number | null
  /** mpv pid for main's orphan kill (control message `mpv-pid`). */
  onPid?: (pid: number | null) => void
  /**
   * Viewers: a stream-server response for the loaded file waits on a missing piece
   * (`StreamServer.isBlocked(0)`). mpv's seek and audio switch queue behind such a read, so the
   * controller reloads instead (ADR 0004 §5). Default: never (the host plays a local file).
   */
  readerBlocked?: () => boolean
}

export interface PlayerTiming {
  restartDelaysMs: number[]
  restartWindowMs: number
  quitGraceMs: number
  connectTimeoutMs: number
  jumpThresholdS: number
  /** A seek still waiting this long while a read is blocked is redone as a reload (plan §4.3 watchdog). */
  seekWatchdogMs: number
  osc: Partial<OscTiming>
}

const DEFAULT_TIMING: PlayerTiming = {
  restartDelaysMs: [1000, 2000, 4000],
  restartWindowMs: 60_000,
  quitGraceMs: 2000,
  connectTimeoutMs: 10_000,
  jumpThresholdS: 1.5,
  seekWatchdogMs: 3000,
  osc: {},
}

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  warn(msg: string): void
  error(msg: string, e?: unknown): void
}

export interface PlayerControllerOptions {
  /** null when mpv was not found or is too old; `unavailable` says which */
  mpv: MpvBinary | null
  unavailable?: 'missing' | 'tooOld'
  role: Role
  /** directory containing mpv-scripts/wt-osc.lua */
  resourcesDir: string
  /** mpv's --log-file; the previous run's log is kept as mpv.prev.log */
  logFile: string | null
  settings: Pick<Settings, 'hwdec' | 'alang' | 'slang' | 'macHdrExperimental' | 'oscPersistentStrip'>
  theme: ThemePayload
  perms: OscPerms
  strings?: Partial<OscStrings>
  mediaTitle?: string | null
  os?: MpvOs
  sessionType?: SessionType
  /** 'socket' forces --input-ipc-server on Linux/macOS (Flatpak always uses it) */
  ipcMode?: 'auto' | 'socket'
  /** where Unix sockets are created; default $XDG_RUNTIME_DIR or the temp dir */
  runtimeDir?: string
  /** appended after our arguments (tests: --vo=null --ao=null) */
  extraArgs?: string[]
  env?: NodeJS.ProcessEnv
  hooks?: PlayerHooks
  /**
   * Who reloads the file after mpv restarted (crash, reopen()) or another file replaced it (`external-change`
   * 'path'). true (default): the controller, paused at `hooks.restartPosition()`. false: the caller, which
   * load()s the same URL and gets the tracks back; the controller waits in 'idle' in both cases (a load, reload
   * or seek in flight rejects as superseded). Sync's member reloads in both cases itself, and two owners race:
   * the later loadfile wins, and the member then waits at a position mpv is not at.
   */
  selfReload?: boolean
  timing?: Partial<PlayerTiming>
  log?: Logger
}

export interface SubtitleSpec {
  url: string
  title: string | null
  lang: string | null
}

export interface LoadOptions {
  start?: number
  paused?: boolean
  title?: string | null
  /** external subtitles for this file (host: local paths, viewer: stream URLs); re-added after restarts */
  subtitles?: SubtitleSpec[]
}

export interface PlayerIntent {
  kind: 'play' | 'pause' | 'seek' | 'close' | 'show-app'
  pos?: number
  src: 'osc'
  seq: number
}

export type ExternalChange =
  | { kind: 'pause'; value: boolean }
  | { kind: 'speed'; value: number }
  | { kind: 'seek'; pos: number | null }
  /**
   * another client's file replaced ours, or a stop ended it or dropped it before it started; `path` is null (unknown
   * at that file's start-file)
   */
  | { kind: 'path'; path: string | null }

export interface PlayerExit {
  code: number | null
  signal: NodeJS.Signals | null
  requested: boolean
  /** ms until the automatic restart, or null when none follows */
  restartInMs: number | null
}

interface PlayerControllerEvents {
  /** (next, previous) */
  state: [PlayerStatus, PlayerStatus]
  /** the renderer's `player` event: status, version, hdr */
  status: [PlayerEvent]
  intent: [PlayerIntent]
  fileLoaded: [{ path: string }]
  playbackRestart: [{ pos: number | null }]
  audioReconfig: []
  'external-change': [ExternalChange]
  exit: [PlayerExit]
  tracks: [TracksEvent]
  /** every observed property change, after enforcement ran */
  property: [ObservedProperty, unknown]
  /** eof-reached flipped */
  eof: [boolean]
  oscReady: []
}

interface PendingSeek {
  pos: number
  /** mpv acknowledged the command (seek, or the loadfile standing in for it) */
  sent: boolean
  waiters: Waiter[]
}

interface Expected {
  paused: boolean
  speed: number
  path: string | null
  pendingSeek: PendingSeek | null
}

interface Waiter {
  resolve: () => void
  reject: (e: Error) => void
}

interface Desired {
  aid: number | 'no' | null
  sid: number | 'no' | null
  volume: number | null
  muted: boolean | null
}

// fd://3 ends mpv when core dies; a socket or named pipe does not, so the OSC quits without heartbeats.
const WATCHDOG_S = 10
// A seek this close to the end of a cached range may still need bytes past it: reload instead.
const CACHE_END_MARGIN_S = 0.5
// What a per-file alang= may carry: a language tag (a comma would end the per-file option).
const LANG_RE = /^[A-Za-z0-9-]{1,16}$/

const UNKNOWN_HDR: HdrStatus = { source: 'unknown', output: 'unknown', gpuContext: null, hwdec: null }

/**
 * Owns one mpv window across restarts: spawns it, speaks JSON IPC, keeps it at the state sync asked
 * for (enforcement), restarts it after crashes and bridges the Lua OSC. Plan §4.4 and §5.3.
 */
export class PlayerController extends EventEmitter<PlayerControllerEvents> {
  private readonly timing: PlayerTiming
  private readonly log: Logger
  private readonly bridge: OscBridge
  private readonly os: MpvOs
  private state: PlayerStatus
  private proc: ChildProcess | null = null
  private ipc: MpvIpc | null = null
  /** --input-ipc-server endpoint of the current process; null with fd://3 */
  private serverPath: string | null = null
  /** Unix socket file to remove after exit */
  private socketPath: string | null = null
  private gen = 0
  private quitting: 'app' | 'user' | null = null
  private crashTimes: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private restoreOnSpawn = false
  private disposed = false

  private expected: Expected = { paused: true, speed: 1, path: null, pendingSeek: null }
  private loading: (Waiter & { path: string }) | null = null
  private loadOpts: Required<Omit<LoadOptions, 'start' | 'paused'>> = { title: null, subtitles: [] }
  private readonly desired: Desired = { aid: null, sid: null, volume: null, muted: null }
  /**
   * expected.path's track-list as mpv last reported it non-empty. mpv empties track-list from a loadfile
   * until the new demuxer opens, and a crash clears every property: a loadfile built then still knows
   * which subtitles are embedded and each audio track's language. A load() of another file resets it.
   */
  private fileTracks: unknown[] = []
  private restoreTracks = false
  /** aid and sid the last loadfile carried in its per-file options (checked at file-loaded) */
  private carried: { aid: number | 'no' | null; sid: number | 'no' | null } = { aid: null, sid: null }
  /** loadfiles sent, and those mpv has not answered yet: a file-loaded restores tracks for the newest only */
  private loadfileSeq = 0
  private unackedLoadfiles = 0
  /** playlist_entry_id mpv gave our newest loadfile in this process (from its reply) */
  private ownEntry: number | null = null
  /**
   * The playlist entry mpv opens or plays, from its start-file to its end-file. `own`: it was our newest
   * loadfile's at its start-file. A reply comes before its entry's start-file and mpv runs commands in order, so
   * an entry that is not our newest while none of ours is unanswered is another client's file (ADR 0004 §8.3).
   * Events, unlike property changes (coalesced, sent once mpv's event queue is empty), arrive in mpv's order.
   */
  private entry: { id: number | null; own: boolean } | null = null
  /**
   * A loadfile that stands in for a seek or an audio switch (reload()), until its playback-restart. The
   * state stays 'ready' meanwhile, so sync sees a seek, not a new load.
   */
  private reloading: { pos: number } | null = null
  private seekWatchdog: NodeJS.Timeout | null = null
  private externalSeek: { from: number | null } | null = null
  private pauseCheck: NodeJS.Timeout | null = null
  private readonly props = new Map<ObservedProperty, unknown>()
  private lastPos: { pos: number; at: number } | null = null
  private dropsBase = { vo: 0, decoder: 0 }
  private hdr: HdrStatus = UNKNOWN_HDR
  private lastTracks = ''

  constructor(private readonly opts: PlayerControllerOptions) {
    super()
    this.timing = { ...DEFAULT_TIMING, ...opts.timing }
    this.log = opts.log ?? coreLog
    this.os = opts.os ?? platformOs()
    this.state = opts.mpv ? 'absent' : (opts.unavailable ?? 'missing')
    this.bridge = new OscBridge({
      theme: opts.theme,
      perms: opts.perms,
      ...(opts.strings ? { strings: opts.strings } : {}),
      persistentStrip: opts.settings.oscPersistentStrip,
      timing: this.timing.osc,
    })
    this.bridge.on('intent', (i) => this.onOscIntent(i))
    this.bridge.on('ready', () => this.emit('oscReady'))
    this.bridge.on('timeout', () => this.log.warn('player: wt-osc did not answer init within 5 s'))
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  get status(): PlayerStatus {
    return this.state
  }

  get pid(): number | null {
    return this.proc?.pid ?? null
  }

  /** The socket path or named pipe mpv serves IPC on (Flatpak, Windows, ipcMode 'socket'); null with fd://3. */
  get ipcEndpoint(): string | null {
    return this.proc ? this.serverPath : null
  }

  get oscReady(): boolean {
    return this.bridge.ready
  }

  /** opts.selfReload: this controller reloads after a restart or an external path change. */
  private get selfReload(): boolean {
    return this.opts.selfReload !== false
  }

  /** The renderer's `player` event payload. */
  playerEvent(): PlayerEvent {
    return { status: this.state, version: this.opts.mpv ? formatVersion(this.opts.mpv.version) : null, hdr: this.hdr }
  }

  /** Spawn mpv (idle, no file). No-op unless absent, closed or crashed. */
  start(): void {
    if (this.disposed || !this.opts.mpv) return
    if (!['absent', 'closedByUser', 'crashed'].includes(this.state)) return
    void this.spawnProcess()
  }

  /**
   * "Reopen player": a fresh process with a fresh crash budget. It reloads the last file at the room position,
   * or with selfReload false waits in 'idle' for the caller's load().
   */
  reopen(): void {
    if (this.proc) return
    this.crashTimes = []
    this.cancelRestart()
    this.restoreOnSpawn = this.expected.path !== null
    this.start()
  }

  /** Ask mpv to quit; kill it after the grace period. Final state 'absent'. */
  quit(): Promise<void> {
    return this.stopProcess('app')
  }

  /** The user closed the window (CLOSE_WIN): final state 'closedByUser'. */
  close(): Promise<void> {
    return this.stopProcess('user')
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cancelRestart()
    await this.stopProcess('app')
    this.bridge.detach()
    this.removeAllListeners()
  }

  // ---- playback API (plan §5.3) ---------------------------------------------------------------

  /** loadfile paused (by default) at `start`; resolves at the first playback-restart. */
  async load(url: string, opts: LoadOptions = {}): Promise<void> {
    const start = opts.start ?? 0
    const paused = opts.paused ?? true
    const sameFile = url === this.expected.path
    this.loadOpts = {
      title: opts.title ?? null,
      subtitles: opts.subtitles ?? (sameFile ? this.loadOpts.subtitles : []),
    }
    if (!sameFile) {
      this.desired.aid = null
      this.desired.sid = null
      this.fileTracks = []
    }
    this.expected.path = url
    this.expected.paused = paused
    this.restoreTracks = sameFile
    await this.loadInternal(url, start, paused)
  }

  /**
   * Exact absolute seek; resolves at the playback-restart that completes it. While a stream read waits on
   * a missing piece, a target outside the demuxer cache is reached with loadfile instead: a seek would
   * queue behind that read until the piece arrives, loadfile interrupts it (~0.2 s; ADR 0004, finding 1).
   */
  seek(pos: number): Promise<void> {
    const ipc = this.requireIpc()
    const prev = this.expected.pendingSeek
    const pending: PendingSeek = { pos, sent: false, waiters: prev?.waiters ?? [] }
    this.expected.pendingSeek = pending
    this.externalSeek = null
    this.clearSeekWatchdog()
    const done = new Promise<void>((resolve, reject) => pending.waiters.push({ resolve, reject }))
    // A seek sent while a reload is in flight would land on the file being replaced.
    if (this.canReload() && (this.reloading !== null || (this.readerBlocked() && !this.inDemuxerCache(pos)))) {
      this.reload(pos, pending).catch(() => undefined) // a failure rejects `pending`
      return done
    }
    ipc
      .command(['seek', pos, 'absolute+exact'], {
        // in line order: a seek inside the cache may restart in the same chunk as this reply
        onReply: () => {
          pending.sent = true
        },
      })
      .catch((e: unknown) => this.failSeek(pending, e))
    this.armSeekWatchdog(pending)
    return done
  }

  async setPaused(paused: boolean): Promise<void> {
    this.expected.paused = paused
    await this.requireIpc().setProperty('pause', paused)
  }

  async setSpeed(speed: number): Promise<void> {
    this.expected.speed = speed
    await this.requireIpc().setProperty('speed', speed)
  }

  getProperty<T = unknown>(name: string): Promise<Timed<T>> {
    return this.requireIpc().getProperty<T>(name)
  }

  /** Sync's clock sample: audio-pts, or time-pos when there is no audio. */
  async sample(): Promise<Timed<number | null> & { prop: 'audio-pts' | 'time-pos' }> {
    const ipc = this.requireIpc()
    try {
      return { ...(await ipc.getProperty<number>('audio-pts')), prop: 'audio-pts' }
    } catch {
      const t = await ipc.getProperty<number | null>('time-pos')
      return { ...t, prop: 'time-pos' }
    }
  }

  async setTrack(kind: 'audio' | 'sub', id: number | 'no'): Promise<void> {
    if (kind === 'audio') this.desired.aid = id
    else this.desired.sid = id
    if (this.switchNeedsReload(kind, id)) {
      await this.reload(this.positionNow(), this.expected.pendingSeek)
      return
    }
    await this.requireIpc().setProperty(kind === 'audio' ? 'aid' : 'sid', id)
  }

  async setVolume(volume: number, muted: boolean): Promise<void> {
    this.desired.volume = volume
    this.desired.muted = muted
    const ipc = this.requireIpc()
    await Promise.all([ipc.setProperty('volume', volume), ipc.setProperty('mute', muted)])
  }

  /** Add an external subtitle to the current file (kept for restarts of the same file). */
  async addSubtitle(sub: SubtitleSpec, select = false): Promise<void> {
    this.loadOpts.subtitles = [...this.loadOpts.subtitles, sub]
    if (this.state === 'ready' || this.state === 'loading') await this.subAdd(sub, select)
  }

  /** Send a message to wt-osc.lua (theme/perms are also remembered for the next init). */
  osc<K extends OscKind>(kind: K, payload: OscMessages[K]): void {
    this.bridge.sendMessage(kind, payload)
  }

  prop(name: ObservedProperty): unknown {
    return this.props.get(name)
  }

  /** Dropped frames since this controller was created, summed over mpv restarts. */
  frameDrops(): { vo: number; decoder: number } {
    return {
      vo: this.dropsBase.vo + num(this.props.get('frame-drop-count')),
      decoder: this.dropsBase.decoder + num(this.props.get('decoder-frame-drop-count')),
    }
  }

  /** demuxer-cache-state/seekable-ranges as spans, for the timeline's buffered layer. */
  buffered(): Span[] {
    const cache = this.props.get('demuxer-cache-state')
    if (typeof cache !== 'object' || cache === null) return []
    const ranges = (cache as { 'seekable-ranges'?: unknown })['seekable-ranges']
    if (!Array.isArray(ranges)) return []
    const out: Span[] = []
    for (const r of ranges as { start?: unknown; end?: unknown }[]) {
      if (typeof r.start === 'number' && typeof r.end === 'number') out.push([r.start, r.end])
    }
    return out
  }

  tracks(): TracksEvent {
    const list = this.trackList()
    return {
      audio: tracksOf(list, 'audio'),
      sub: tracksOf(list, 'sub'),
      aid: trackId(this.props.get('aid')),
      sid: trackId(this.props.get('sid')),
      volume: num(this.props.get('volume'), 100),
      muted: this.props.get('mute') === true,
    }
  }

  // ---- process management ---------------------------------------------------------------------

  private async spawnProcess(): Promise<void> {
    const mpv = this.opts.mpv
    if (!mpv) return
    const gen = ++this.gen
    this.quitting = null
    this.setState('spawning')
    let child: ChildProcess
    try {
      const { command, args, stdio } = await this.prepareSpawn(mpv)
      if (gen !== this.gen || this.disposed) return
      this.log.info(`player: spawning ${command} ${args.join(' ')}`)
      child = spawn(command, args, { stdio, env: mpvChildEnv(this.opts.env ?? process.env), windowsHide: false })
    } catch (e) {
      this.log.error('player: spawn failed', e)
      this.setState('crashed')
      return
    }
    this.proc = child
    let exited = false
    const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (exited) return
      exited = true
      this.onExit(gen, code, signal)
    }
    child.once('error', (e: NodeJS.ErrnoException) => {
      this.log.error('player: mpv process error', e)
      if (e.code === 'ENOENT' && gen === this.gen) {
        exited = true
        this.cleanupProcess()
        this.setState('missing')
        return
      }
      onGone(null, null)
    })
    child.once('exit', onGone)
    child.once('spawn', () => {
      if (gen !== this.gen) return
      this.opts.hooks?.onPid?.(child.pid ?? null)
      void this.connect(gen, child)
    })
  }

  private async prepareSpawn(mpv: MpvBinary): Promise<{
    command: string
    args: string[]
    stdio: ('ignore' | 'pipe')[]
  }> {
    const flatpak = mpv.kind === 'flatpak'
    let script = join(this.opts.resourcesDir, 'mpv-scripts', 'wt-osc.lua')
    let ipc: IpcSpec = { mode: 'fd' }
    if (this.os === 'win32') {
      ipc = { mode: 'server', path: `\\\\.\\pipe\\wt-mpv-${String(process.pid)}-${randomBytes(8).toString('hex')}` }
    } else if (flatpak || this.opts.ipcMode === 'socket') {
      const dir = this.socketDir(flatpak)
      await mkdir(dir, { recursive: true })
      ipc = { mode: 'server', path: join(dir, `wt-mpv-${randomBytes(6).toString('hex')}.sock`) }
      // The sandbox cannot see an AppImage mount under /tmp; its per-app runtime dir is shared with us.
      if (flatpak) {
        const copy = join(dir, 'wt-osc.lua')
        await copyFile(script, copy)
        script = copy
      }
    }
    this.serverPath = ipc.mode === 'server' ? ipc.path : null
    this.socketPath = ipc.mode === 'server' && this.os !== 'win32' ? ipc.path : null
    if (this.opts.logFile !== null) {
      await mkdir(dirname(this.opts.logFile), { recursive: true })
      const prev = join(dirname(this.opts.logFile), `${basename(this.opts.logFile, '.log')}.prev.log`)
      await rename(this.opts.logFile, prev).catch(() => undefined)
    }
    const mpvArgs = buildMpvArgs({
      version: mpv.version,
      os: this.os,
      sessionType: this.opts.sessionType ?? sessionTypeFromEnv(this.opts.env ?? process.env),
      role: this.opts.role,
      ipc,
      script,
      logFile: this.opts.logFile,
      settings: this.opts.settings,
      mediaTitle: this.opts.mediaTitle ?? null,
    })
    const args = [...mpvArgs, ...(this.opts.extraArgs ?? [])]
    const stdio: ('ignore' | 'pipe')[] =
      ipc.mode === 'fd' ? ['ignore', 'ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'ignore']
    if (!flatpak) return { command: mpv.path, args, stdio }
    const fsArgs = ['--filesystem=host:ro']
    if (this.opts.logFile !== null) fsArgs.push(`--filesystem=${dirname(this.opts.logFile)}`)
    return { command: mpv.path, args: ['run', ...fsArgs, 'io.mpv.Mpv', ...args], stdio }
  }

  private socketDir(flatpak: boolean): string {
    if (this.opts.runtimeDir !== undefined) return this.opts.runtimeDir
    const xdg = (this.opts.env ?? process.env).XDG_RUNTIME_DIR
    if (flatpak && xdg) return join(xdg, 'app', 'io.mpv.Mpv')
    return xdg ?? tmpdir()
  }

  private async connect(gen: number, child: ChildProcess): Promise<void> {
    this.setState('connecting')
    try {
      const server = this.serverPath
      const ipc =
        server === null
          ? new MpvIpc(child.stdio[3] as Duplex)
          : await MpvIpc.connect(server, { timeoutMs: this.timing.connectTimeoutMs })
      if (gen !== this.gen) {
        ipc.close()
        return
      }
      this.ipc = ipc
      ipc.on('event', (e) => this.onEvent(gen, e))
      ipc.on('property-change', (p) => this.onProperty(gen, p.name as ObservedProperty, p.value))
      ipc.on('client-message', (args) => this.bridge.handleClientMessage(args))
      ipc.on('close', () => {
        // fd://3 closing means mpv is gone or going; a server socket closing leaves mpv orphaned.
        if (gen === this.gen && this.proc && server !== null) this.killProcess()
      })
      const client = await ipc.clientName()
      await Promise.all(OBSERVED_PROPERTIES.map((name) => ipc.observe(name)))
      if (gen !== this.gen) return
      const send = (kind: string, json: string): Promise<void> =>
        ipc.command(['script-message-to', OSC_SCRIPT, kind, json]).then(() => undefined)
      this.bridge.attach(send, client, server === null ? 0 : WATCHDOG_S)
      this.setState('idle')
      if (this.restoreOnSpawn && this.expected.path !== null) {
        this.restoreOnSpawn = false
        // selfReload false: the caller reloads once the player is available again ('idle')
        if (!this.selfReload) return
        this.restoreTracks = true
        const pos = this.opts.hooks?.restartPosition?.() ?? this.lastPos?.pos ?? 0
        this.expected.paused = true
        this.loadInternal(this.expected.path, pos, true).catch((e: unknown) => {
          this.log.warn(`player: reload after restart failed: ${asError(e).message}`)
        })
      }
    } catch (e) {
      if (gen !== this.gen) return
      this.log.error('player: IPC setup failed', e)
      this.killProcess()
    }
  }

  private stopProcess(reason: 'app' | 'user'): Promise<void> {
    this.cancelRestart()
    const proc = this.proc
    if (!proc) {
      if (reason === 'user' && !['missing', 'tooOld'].includes(this.state)) this.setState('closedByUser')
      return Promise.resolve()
    }
    this.quitting = reason
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
    this.ipc?.command(['quit']).catch(() => undefined)
    const timer = setTimeout(() => this.killProcess(), this.timing.quitGraceMs)
    return exited.finally(() => clearTimeout(timer))
  }

  private killProcess(): void {
    const proc = this.proc
    if (!proc || proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return
    if (this.os === 'win32') {
      spawn('taskkill', ['/T', '/F', '/PID', String(proc.pid)], { stdio: 'ignore', windowsHide: true }).on(
        'error',
        () => undefined,
      )
    } else proc.kill('SIGKILL')
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (gen !== this.gen) return
    const requested = this.quitting
    this.cleanupProcess()
    this.rejectWaiters(new CodedError(PLAYER_ERRORS.exited, 'the player exited'))
    let restartInMs: number | null = null
    let next: PlayerStatus
    if (requested === 'app') next = 'absent'
    else if (requested === 'user' || code === 0) next = 'closedByUser'
    else {
      next = 'crashed'
      restartInMs = this.scheduleRestart()
    }
    this.log.info(
      `player: mpv exited code=${String(code)} signal=${String(signal)} requested=${String(requested)} restart=${String(restartInMs)}`,
    )
    this.setState(next)
    this.emit('exit', { code, signal, requested: requested !== null, restartInMs })
  }

  private scheduleRestart(): number | null {
    const now = performance.now()
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.timing.restartWindowMs)
    this.crashTimes.push(now)
    const delay = this.timing.restartDelaysMs[this.crashTimes.length - 1]
    if (delay === undefined || this.disposed) return null
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.restoreOnSpawn = this.expected.path !== null
      this.start()
    }, delay)
    return delay
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }

  private cleanupProcess(): void {
    this.gen++
    this.ipc?.close()
    this.ipc = null
    this.proc = null
    this.bridge.detach()
    if (this.pauseCheck) clearTimeout(this.pauseCheck)
    this.pauseCheck = null
    this.clearSeekWatchdog()
    this.reloading = null
    // entry ids count per process
    this.entry = null
    this.ownEntry = null
    this.opts.hooks?.onPid?.(null)
    this.dropsBase.vo += num(this.props.get('frame-drop-count'))
    this.dropsBase.decoder += num(this.props.get('decoder-frame-drop-count'))
    this.props.clear()
    this.externalSeek = null
    if (this.socketPath !== null) void rm(this.socketPath, { force: true })
    this.socketPath = null
  }

  private rejectWaiters(e: Error): void {
    const loading = this.loading
    this.loading = null
    loading?.reject(e)
    const seek = this.expected.pendingSeek
    this.expected.pendingSeek = null
    for (const w of seek?.waiters ?? []) w.reject(e)
  }

  // ---- loading --------------------------------------------------------------------------------

  private async loadInternal(url: string, start: number, paused: boolean): Promise<void> {
    const ipc = this.requireIpc()
    const prev = this.loading
    this.loading = null
    prev?.reject(new CodedError(PLAYER_ERRORS.superseded, 'a newer load replaced this one'))
    const pendingSeek = this.expected.pendingSeek
    this.expected.pendingSeek = null
    this.clearSeekWatchdog()
    for (const w of pendingSeek?.waiters ?? []) w.reject(new CodedError(PLAYER_ERRORS.superseded, 'file reloaded'))
    this.externalSeek = null
    this.lastPos = null
    this.reloading = null
    this.setState('loading')
    const { promise, resolve, reject } = Promise.withResolvers<undefined>()
    // Rejections that land while we still await loadfile below are observed through `promise` later.
    promise.catch(() => undefined)
    const waiter = { resolve: () => resolve(undefined), reject, path: url }
    this.loading = waiter
    if (this.loadOpts.title !== null) {
      // Not awaited: mpv runs it before the loadfile written after it, and an await would leave a window in which
      // another client's start-file finds none of our loadfiles unanswered and gives this load up.
      ipc.setProperty('force-media-title', this.loadOpts.title).catch(() => undefined)
    }
    try {
      await this.sendLoadfile(ipc, url, this.fileOptions(start, paused))
    } catch (e) {
      if (this.loading === waiter) {
        this.loading = null
        this.setState('idle')
      }
      throw e
    }
    return promise
  }

  private async onFileLoaded(gen: number, entry: NonNullable<PlayerController['entry']>): Promise<void> {
    // Let what this event (and the rest of its chunk) set off run first: a reload sent in reaction to it
    // makes this restore moot.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const ipc = this.ipc
    // A newer loadfile replaces this file: that one restores the tracks (and until then, the churn of
    // track properties is not the user's).
    if (!ipc || gen !== this.gen || this.entry !== entry || !this.newestEntryShown()) return
    const seq = this.loadfileSeq
    const current = (): boolean => gen === this.gen && seq === this.loadfileSeq
    for (const sub of this.loadOpts.subtitles) {
      await this.subAdd(sub, false)
      if (!current()) return
    }
    if (!this.restoreTracks) return
    const d = this.desired
    // aid and an embedded sid rode in the loadfile: setting them here races the read-ahead and stalls
    // behind a blocked read (aid: 1 in 6 in S4). Only a track mpv did not take is set after all.
    const setAid = await this.mustSet(ipc, 'aid', d.aid, this.carried.aid)
    if (!current()) return
    const setSid = await this.mustSet(ipc, 'sid', d.sid, this.carried.sid)
    if (!current()) return
    this.restoreTracks = false
    const sets: Promise<void>[] = []
    if (setAid && d.aid !== null) sets.push(ipc.setProperty('aid', d.aid))
    if (setSid && d.sid !== null) sets.push(ipc.setProperty('sid', d.sid))
    if (d.volume !== null) sets.push(ipc.setProperty('volume', d.volume))
    if (d.muted !== null) sets.push(ipc.setProperty('mute', d.muted))
    const results = await Promise.allSettled(sets)
    for (const r of results) if (r.status === 'rejected') this.log.warn(`player: re-apply track: ${String(r.reason)}`)
  }

  /** A track to set at file-loaded: not carried in the loadfile (an external sid), or carried and not taken. */
  private async mustSet(
    ipc: MpvIpc,
    name: 'aid' | 'sid',
    want: number | 'no' | null,
    carried: number | 'no' | null,
  ): Promise<boolean> {
    if (want === null) return false
    if (want !== carried) return true
    const now = await ipc.getProperty(name).then(
      (r) => trackId(r.value),
      () => want,
    )
    if (now !== want) this.log.warn(`player: mpv ignored ${name}=${String(want)} in loadfile (got ${String(now)})`)
    return now !== want
  }

  private async subAdd(sub: SubtitleSpec, select: boolean): Promise<void> {
    const ipc = this.ipc
    if (!ipc) return
    try {
      await ipc.command(['sub-add', sub.url, select ? 'select' : 'auto', sub.title ?? '', sub.lang ?? ''])
    } catch (e) {
      this.log.warn(`player: sub-add ${sub.url}: ${asError(e).message}`)
    }
  }

  // ---- mpv events & enforcement ---------------------------------------------------------------

  private onEvent(gen: number, e: MpvEvent): void {
    if (gen !== this.gen) return
    switch (e.event) {
      case 'start-file': {
        const id = entryId(e)
        // without an id (no mpv we support: 0.39 has them) every file counts as ours
        const own = id === null || id === this.ownEntry
        this.entry = { id, own }
        // not ours, and no loadfile of ours that would replace it is on its way: another client's file
        if (!own && this.unackedLoadfiles === 0) this.onFileGone()
        break
      }
      case 'file-loaded': {
        // a file another client loaded is not ours to report or to give our subtitles
        const entry = this.entry
        if (!entry?.own) break
        const path = this.loading?.path ?? this.expected.path
        if (path !== null) this.emit('fileLoaded', { path })
        void this.onFileLoaded(gen, entry)
        break
      }
      case 'end-file': {
        const id = entryId(e)
        if (this.entry?.id === id) this.entry = null
        // only the end of our newest entry, with no newer loadfile of ours on its way, ends our file
        if (id !== this.ownEntry || this.unackedLoadfiles > 0) break
        if (e.reason === 'error' && (this.loading || this.reloading)) {
          const why = typeof e.file_error === 'string' ? e.file_error : 'unknown error'
          const err = new CodedError(PLAYER_ERRORS.loadFailed, `mpv could not open the file: ${why}`)
          const loading = this.loading
          this.loading = null
          this.reloading = null
          this.setState('idle')
          loading?.reject(err)
          const seek = this.expected.pendingSeek
          if (seek) this.failSeek(seek, err)
        } else if (id !== null && e.reason !== 'quit') {
          // another client's stop or loadfile (its start-file follows)
          this.onFileGone()
        }
        break
      }
      case 'seek':
        // only on our file: what another client's file does is not a seek of ours
        if (
          this.state === 'ready' &&
          this.newestEntryShown() &&
          !this.reloading &&
          !this.expected.pendingSeek &&
          !this.externalSeek
        ) {
          this.externalSeek = { from: this.lastPos?.pos ?? null }
        }
        break
      case 'playback-restart':
        this.onPlaybackRestart()
        break
      case 'idle':
        // mpv went idle (idle_loop, after the last end-file) with our newest loadfile answered and none of ours on
        // its way: a stop or a playlist removal dropped that entry before it started, so neither its start-file nor
        // its end-file comes (ADR 0004 §8.4). After its end-file or a load error onFileGone has nothing left to do.
        if (this.ownEntry !== null && this.unackedLoadfiles === 0 && this.entry === null) this.onFileGone()
        break
      case 'audio-reconfig':
        this.emit('audioReconfig')
        break
    }
  }

  private onPlaybackRestart(): void {
    const pos = numOrNull(this.props.get('time-pos'))
    if (pos !== null) this.lastPos = { pos, at: performance.now() }
    // A restart completes our load, reload or seek only on our newest loadfile's entry: not on another client's
    // file, nor on a file shown before mpv took our newest loadfile.
    const ours = this.newestEntryShown()
    if (ours && this.loading) {
      const loading = this.loading
      this.loading = null
      this.setState('ready')
      loading.resolve()
    }
    const seek = this.expected.pendingSeek
    if (ours && seek?.sent) {
      this.expected.pendingSeek = null
      this.clearSeekWatchdog()
      for (const w of seek.waiters) w.resolve()
    }
    if (ours && this.reloading) {
      // what reload() kept quiet: tracks and HDR as they are now
      this.reloading = null
      this.emitTracks()
      this.updateHdr()
      // the reload's per-file pause= wins over a setPaused() that came while it was in flight
      const paused = this.props.get('pause')
      if (typeof paused === 'boolean' && paused !== this.expected.paused) {
        this.ipc?.setProperty('pause', this.expected.paused).catch(() => undefined)
      }
    }
    const ext = this.externalSeek
    if (ext) {
      this.externalSeek = null
      if (ext.from === null || pos === null || Math.abs(pos - ext.from) > 0.5) {
        this.emit('external-change', { kind: 'seek', pos })
      }
    }
    this.emit('playbackRestart', { pos })
  }

  private onProperty(gen: number, name: ObservedProperty, value: unknown): void {
    if (gen !== this.gen) return
    const prev = this.props.get(name)
    this.props.set(name, value)
    const active = this.state === 'ready' || this.state === 'loading'
    switch (name) {
      case 'time-pos':
        this.checkJump(value)
        break
      case 'pause':
        if (active && typeof value === 'boolean' && value !== this.expected.paused) this.schedulePauseCheck()
        break
      case 'speed':
        if (active && typeof value === 'number' && Math.abs(value - this.expected.speed) > 1e-6) {
          this.emit('external-change', { kind: 'speed', value })
          this.ipc?.setProperty('speed', this.expected.speed).catch(() => undefined)
        }
        break
      case 'eof-reached':
        this.emit('eof', value === true)
        break
      case 'aid':
      case 'sid':
      case 'volume':
      case 'mute':
        // aid and sid are per file: between files ("auto") or on a file another client loaded they are not
        // the user's choice for ours (with selfReload false that file stays until the caller reloads). Nor is
        // the track mpv picks at a (re)load: it replaces "auto" (nothing after a restart), and the change may
        // come in after the reload completed (seen under load: a default aid=1 then rode in every reload).
        if (
          this.state === 'ready' &&
          !this.restoreTracks &&
          value !== prev &&
          (name === 'volume' || name === 'mute' || (this.ownFile() && isSelection(prev) && isSelection(value)))
        ) {
          const kind = name === 'aid' ? 'audio' : name === 'sid' ? 'sub' : null
          // A switch moves away from a known choice: ours, else the track mpv had. The default track
          // showing up late after a (re)load is none (that cost a second reload).
          const choice = name === 'aid' ? this.desired.aid : name === 'sid' ? this.desired.sid : null
          const before = choice ?? (typeof prev === 'number' ? prev : null)
          const switched = kind !== null && typeof value === 'number' && before !== null && value !== before
          this.rememberUserTrack(name, value)
          // the OSC's select-aid/select-sid switched mpv itself; that waits behind a blocked read like ours
          if (kind !== null && switched && this.switchNeedsReload(kind, value, true)) {
            this.reload(this.positionNow(), this.expected.pendingSeek).catch((e: unknown) => {
              this.log.warn(`player: reload for the ${kind} switch failed: ${asError(e).message}`)
            })
          }
        }
        if (!this.reloading) this.emitTracks()
        break
      case 'track-list':
        // path changes at start-file, before the new file's tracks arrive: those of a file another client
        // loaded (external-change 'path') are not ours
        if (Array.isArray(value) && value.length > 0 && this.ownFile()) this.fileTracks = value as unknown[]
        if (!this.reloading) this.emitTracks()
        break
      case 'video-params':
      case 'video-target-params':
      case 'current-gpu-context':
      case 'hwdec-current':
        if (!this.reloading) this.updateHdr()
        break
      default:
        break
    }
    this.emit('property', name, value)
  }

  private schedulePauseCheck(): void {
    // At EOF with keep-open mpv pauses itself and eof-reached may arrive a moment later.
    if (this.pauseCheck) return
    this.pauseCheck = setTimeout(() => {
      this.pauseCheck = null
      const paused = this.props.get('pause')
      if (typeof paused !== 'boolean' || paused === this.expected.paused) return
      if (this.props.get('eof-reached') === true || this.nearEnd()) return
      if (this.state !== 'ready' && this.state !== 'loading') return
      // a reload passes through mpv's per-file pause; onPlaybackRestart re-applies expected after it
      if (this.reloading) return
      this.emit('external-change', { kind: 'pause', value: paused })
      this.ipc?.setProperty('pause', this.expected.paused).catch(() => undefined)
    }, 30)
  }

  private nearEnd(): boolean {
    const pos = numOrNull(this.props.get('time-pos'))
    const dur = numOrNull(this.props.get('duration'))
    return pos !== null && dur !== null && this.props.get('pause') === true && dur - pos < 0.25
  }

  private checkJump(value: unknown): void {
    const pos = numOrNull(value)
    const now = performance.now()
    const prev = this.lastPos
    if (pos === null) return
    this.lastPos = { pos, at: now }
    if (!prev || this.state !== 'ready' || this.expected.pendingSeek || this.externalSeek) return
    if (this.reloading) return
    if (this.props.get('seeking') === true) return
    const speed = num(this.props.get('speed'), 1)
    const diff = pos - prev.pos
    const allowance = ((now - prev.at) / 1000) * speed
    const t = this.timing.jumpThresholdS
    if (diff < -t || diff > allowance + t) this.emit('external-change', { kind: 'seek', pos })
  }

  /**
   * mpv shows a file our loadfile opened: not between two files, and not one another client loaded. Property
   * changes delivered after an entry's start-file hold values from that entry on (mpv re-reads them all at
   * start-file and end-file), so they belong to `entry`.
   */
  private ownFile(): boolean {
    return this.entry?.own === true
  }

  /** mpv shows our newest loadfile's entry, and none of ours is unanswered: its restarts complete our requests. */
  private newestEntryShown(): boolean {
    const e = this.entry
    return e !== null && e.own && e.id === this.ownEntry && this.unackedLoadfiles === 0
  }

  /**
   * Our file is gone, and no loadfile of ours that would bring it back is on its way: another client's loadfile
   * replaced it (that entry's start-file, or the end-file of ours before it), or a stop ended it (our entry's
   * end-file) or dropped it before it started (mpv's 'idle'). Also while our load or reload is in flight, which
   * then never completes: another file's playback-restart must not stand in for it. With selfReload false: 'idle'
   * (not loaded) lets the caller's "available and not loaded" rule reload ours, also where it ignores 'path'
   * (sync's member while it holds for an absent host); a load, reload or seek in flight rejects as superseded.
   * The next start-file of that client, or mpv's 'idle' after it, then finds us idle: one 'path' event.
   */
  private onFileGone(): void {
    if (this.expected.path === null || this.quitting !== null) return
    if (this.loading === null && this.reloading === null && this.state !== 'ready') return
    // where mpv is now is unknown at a start-file (path follows as a property change): null
    if (!this.selfReload) {
      const err = new CodedError(PLAYER_ERRORS.superseded, 'another file replaced ours')
      const loading = this.loading
      this.loading = null
      this.reloading = null
      const seek = this.expected.pendingSeek
      this.expected.pendingSeek = null
      this.clearSeekWatchdog()
      this.externalSeek = null
      this.setState('idle')
      loading?.reject(err)
      for (const w of seek?.waiters ?? []) w.reject(err)
      this.emit('external-change', { kind: 'path', path: null })
      return
    }
    this.emit('external-change', { kind: 'path', path: null })
    const pos = this.opts.hooks?.restartPosition?.() ?? this.lastPos?.pos ?? 0
    this.restoreTracks = true
    this.expected.paused = true
    this.loadInternal(this.expected.path, pos, true).catch((e: unknown) => {
      this.log.warn(`player: reload after another file replaced ours failed: ${asError(e).message}`)
    })
  }

  private rememberUserTrack(name: 'aid' | 'sid' | 'volume' | 'mute', value: unknown): void {
    if (name === 'aid') this.desired.aid = trackId(value)
    else if (name === 'sid') this.desired.sid = trackId(value)
    else if (name === 'volume' && typeof value === 'number') this.desired.volume = value
    else if (name === 'mute' && typeof value === 'boolean') this.desired.muted = value
  }

  private emitTracks(): void {
    const t = this.tracks()
    const key = JSON.stringify(t)
    if (key === this.lastTracks) return
    this.lastTracks = key
    this.emit('tracks', t)
  }

  private updateHdr(): void {
    const next = hdrStatus({
      'video-params': this.props.get('video-params'),
      'video-target-params': this.props.get('video-target-params'),
      'current-gpu-context': this.props.get('current-gpu-context'),
      'hwdec-current': this.props.get('hwdec-current'),
    })
    if (sameHdr(next, this.hdr)) return
    this.hdr = next
    this.emit('status', this.playerEvent())
  }

  // ---- OSC ------------------------------------------------------------------------------------

  private onOscIntent(i: OscIntent): void {
    const hooks = this.opts.hooks
    switch (i.t) {
      case 'toggle': {
        const kind = hooks?.resolveToggle?.() ?? (this.expected.paused ? 'play' : 'pause')
        this.emit('intent', { kind, src: 'osc', seq: i.seq })
        return
      }
      case 'seek-rel': {
        const delta = i.delta ?? 0
        const pos = hooks?.resolveSeekRel?.(delta) ?? this.relativeTarget(delta)
        this.emit('intent', { kind: 'seek', pos, src: 'osc', seq: i.seq })
        return
      }
      case 'seek':
        this.emit('intent', { kind: 'seek', pos: Math.max(0, i.pos ?? 0), src: 'osc', seq: i.seq })
        return
      case 'close':
        this.emit('intent', { kind: 'close', src: 'osc', seq: i.seq })
        void this.close()
        return
      case 'play':
      case 'pause':
      case 'show-app':
        this.emit('intent', { kind: i.t, src: 'osc', seq: i.seq })
        return
    }
  }

  private relativeTarget(delta: number): number {
    const pos = (this.lastPos?.pos ?? 0) + delta
    const dur = numOrNull(this.props.get('duration'))
    return Math.max(0, dur === null ? pos : Math.min(dur, pos))
  }

  // ---- reload instead of seek (ADR 0004 §5) ---------------------------------------------------

  private readerBlocked(): boolean {
    return this.opts.hooks?.readerBlocked?.() ?? false
  }

  /** A loaded file and no load in flight: the only state a reload may stand in for a seek. */
  private canReload(): boolean {
    return this.state === 'ready' && this.loading === null && this.expected.path !== null && this.ipc !== null
  }

  /**
   * Selecting an audio or an embedded subtitle track makes mpv refresh-seek, which waits behind a
   * blocked read (ADR 0004, finding 2; the same for sid, "Applied"). An external subtitle has its own
   * demuxer. `already`: mpv switched itself (OSC), so the current track tells nothing.
   */
  private switchNeedsReload(kind: 'audio' | 'sub', id: number | 'no', already = false): boolean {
    if (typeof id !== 'number' || !this.canReload()) return false
    if (kind === 'sub' && !this.isEmbeddedSub(id)) return false
    if (!already && trackId(this.props.get(kind === 'audio' ? 'aid' : 'sid')) === id) return false
    return this.reloading !== null || this.readerBlocked()
  }

  private isEmbeddedSub(id: number): boolean {
    return tracksOf(this.fileTrackList(), 'sub').find((t) => t.id === id)?.external === false
  }

  /** pos lies in demuxer-cache-state/seekable-ranges, short of the end: a seek there reads no stream. */
  private inDemuxerCache(pos: number): boolean {
    return this.buffered().some(([s, e]) => pos >= s && pos <= e - CACHE_END_MARGIN_S)
  }

  /** Where playback is now: a pending target, else the last time-pos, advanced while playing. */
  private positionNow(): number {
    if (this.expected.pendingSeek) return this.expected.pendingSeek.pos
    if (this.reloading) return this.reloading.pos
    const last = this.lastPos
    if (!last) return numOrNull(this.props.get('time-pos')) ?? 0
    const playing = this.props.get('pause') === false && this.props.get('paused-for-cache') !== true
    const speed = num(this.props.get('speed'), 1)
    return playing ? last.pos + ((performance.now() - last.at) / 1000) * speed : last.pos
  }

  /**
   * loadfile at `pos` in place of a seek or an audio switch. It interrupts a read that waits on a piece
   * and reaches playback-restart in ~0.2 s; `pending` completes there. The state stays 'ready' and the
   * reload's own track, path, pause and seek churn is kept from the enforcement and the events.
   */
  private reload(pos: number, pending: PendingSeek | null): Promise<void> {
    const ipc = this.requireIpc()
    const url = this.expected.path
    if (url === null) {
      const e = new CodedError(PLAYER_ERRORS.notRunning, 'no file is loaded')
      if (pending) this.failSeek(pending, e)
      return Promise.reject(e)
    }
    this.clearSeekWatchdog()
    if (pending) pending.sent = false // a restart of the seek this replaces is not ours
    const reloading = { pos }
    this.reloading = reloading
    this.restoreTracks = true
    this.externalSeek = null
    this.lastPos = null
    this.log.debug(`player: loadfile at ${String(pos)} in place of a seek or an audio switch`)
    const acked = (): void => {
      if (this.reloading === reloading && pending && this.expected.pendingSeek === pending) pending.sent = true
    }
    return this.sendLoadfile(ipc, url, this.fileOptions(pos, this.expected.paused), acked).then(
      () => undefined,
      (e: unknown) => {
        if (this.reloading === reloading) this.reloading = null
        if (pending) this.failSeek(pending, e)
        throw asError(e)
      },
    )
  }

  // Backstop for a seek sent while nothing looked blocked (plan §4.3: 3 s, then loadfile).
  private armSeekWatchdog(pending: PendingSeek): void {
    this.seekWatchdog = setTimeout(() => {
      this.seekWatchdog = null
      if (this.expected.pendingSeek !== pending || !this.canReload() || !this.readerBlocked()) return
      this.log.info(`player: seek to ${String(pending.pos)} waits behind a blocked read; reloading`)
      this.reload(pending.pos, pending).catch(() => undefined)
    }, this.timing.seekWatchdogMs)
  }

  private clearSeekWatchdog(): void {
    if (this.seekWatchdog) clearTimeout(this.seekWatchdog)
    this.seekWatchdog = null
  }

  private failSeek(pending: PendingSeek, e: unknown): void {
    if (this.expected.pendingSeek !== pending) return
    this.expected.pendingSeek = null
    this.clearSeekWatchdog()
    for (const w of pending.waiters) w.reject(asError(e))
  }

  /**
   * loadfile's per-file options. A reload of the same file carries the track choice: setting aid on
   * file-loaded races the read-ahead (S4: 1 stall in 6), and an embedded sid waits behind a blocked read
   * the same way. alang backs aid up: S4 saw mpv ignore a per-file aid after a runtime switch (finding 2).
   * An external sid only exists once sub-add ran after file-loaded; it is set there (no refresh seek).
   */
  private fileOptions(start: number, paused: boolean): string {
    let opts = `start=${String(Math.max(0, start))},pause=${paused ? 'yes' : 'no'}`
    const aid = this.restoreTracks ? this.desired.aid : null
    const want = this.restoreTracks ? this.desired.sid : null
    const sid = want === 'no' || (typeof want === 'number' && this.isEmbeddedSub(want)) ? want : null
    this.carried = { aid, sid }
    if (aid !== null) {
      opts += `,aid=${String(aid)}`
      const lang =
        typeof aid === 'number' ? tracksOf(this.fileTrackList(), 'audio').find((t) => t.id === aid)?.lang : null
      if (lang && LANG_RE.test(lang)) opts += `,alang=${lang}`
    }
    if (sid !== null) opts += `,sid=${String(sid)}`
    return opts
  }

  /**
   * Every loadfile goes through here, so onFileLoaded can tell whether a newer one is on its way. Its reply
   * carries the new entry's playlist_entry_id; it is taken in line order (onReply), since that entry's
   * start-file, file-loaded and even playback-restart may come in the same chunk. `onAck` runs there too.
   */
  private sendLoadfile(ipc: MpvIpc, url: string, fileOpts: string, onAck?: () => void): Promise<unknown> {
    this.loadfileSeq++
    this.unackedLoadfiles++
    let unanswered = true
    const answered = (): void => {
      if (!unanswered) return
      unanswered = false
      this.unackedLoadfiles--
    }
    return ipc
      .command(['loadfile', url, 'replace', -1, fileOpts], {
        async: true,
        onReply: (data) => {
          answered()
          this.ownEntry = entryId(data)
          onAck?.()
        },
      })
      .finally(answered)
  }

  private trackList(): unknown[] {
    const list = this.props.get('track-list')
    return Array.isArray(list) ? (list as unknown[]) : []
  }

  /**
   * The loaded file's tracks for decisions that outlive the live list: whether a sid is embedded, an aid's
   * language. tracks() and the UI keep the live list.
   */
  private fileTrackList(): unknown[] {
    return this.fileTracks.length > 0 ? this.fileTracks : this.trackList()
  }

  // ---- helpers --------------------------------------------------------------------------------

  private requireIpc(): MpvIpc {
    if (!this.ipc || this.ipc.isClosed) throw new CodedError(PLAYER_ERRORS.notRunning, 'the player is not running')
    return this.ipc
  }

  private setState(next: PlayerStatus): void {
    if (next === this.state) return
    const prev = this.state
    this.state = next
    if (next === 'absent' || next === 'closedByUser' || next === 'crashed') this.hdr = UNKNOWN_HDR
    this.emit('state', next, prev)
    this.emit('status', this.playerEvent())
  }
}

function tracksOf(list: unknown[], type: 'audio' | 'sub'): TrackInfo[] {
  const out: TrackInfo[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue
    const t = raw as Record<string, unknown>
    if (t.type !== type || typeof t.id !== 'number') continue
    out.push({
      id: t.id,
      title: typeof t.title === 'string' ? t.title : null,
      lang: typeof t.lang === 'string' ? t.lang : null,
      codec: typeof t.codec === 'string' ? t.codec : null,
      default: t.default === true,
      forced: t.forced === true,
      external: t.external === true,
    })
  }
  return out
}

function trackId(v: unknown): number | 'no' {
  return typeof v === 'number' ? v : 'no'
}

/** An aid or sid that is a choice: a track, or none (false). Not "auto" (no file) or nothing (after a restart). */
function isSelection(v: unknown): boolean {
  return typeof v === 'number' || v === false
}

/** playlist_entry_id of a loadfile reply or a start-file/end-file event (all three carry it in mpv 0.39) */
function entryId(v: unknown): number | null {
  if (typeof v !== 'object' || v === null) return null
  const id = (v as { playlist_entry_id?: unknown }).playlist_entry_id
  return typeof id === 'number' ? id : null
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

function platformOs(): MpvOs {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
}

function sessionTypeFromEnv(env: NodeJS.ProcessEnv): SessionType {
  if (env.XDG_SESSION_TYPE === 'wayland' || env.WAYLAND_DISPLAY) return 'wayland'
  if (env.XDG_SESSION_TYPE === 'x11' || env.DISPLAY) return 'x11'
  return null
}
