import type { AppApi, AppCommand, AppInfo, CoreClient, SessionReport, WtBridge } from '../../../shared/ipc/app'
import {
  CORE_ERRORS,
  type CoreEventName,
  type CoreEvents,
  type CoreMethod,
  type CoreSnapshot,
  type ParamsOf,
  type RecentRoom,
  type ResultOf,
  type SessionEvent,
} from '../../../shared/ipc/core'
import { extractInvite } from '../../../shared/invite-link'
import { CodedError, type Result, err, ok } from '../../../shared/result'
import { type Settings, defaultSettings, mergeSettings } from '../../../shared/settings'
import { type ThemePayload, themePayload } from '../../../shared/theme-tokens'
import * as fx from './fixtures'

// A scriptable stand-in for window.wt: the renderer can be developed in a plain browser and tested
// without Electron or a real core. Default handlers walk through realistic flows (host → prepare → room,
// join → confirm → room); tests override any of them with handle() and drive events with emit().

type Handler<M extends CoreMethod> = (params: ParamsOf<M>) => ResultOf<M> | Promise<ResultOf<M>>
type AnyHandler = (params: unknown) => unknown

export interface FakeOptions {
  settings?: Partial<Settings>
  info?: Partial<AppInfo>
  state?: fx.StateSlices
  /** multiplies every simulated delay; 0 runs flows on the next macrotask */
  timeScale?: number
  /** OS colour preference used when settings.theme is 'system' */
  systemDark?: boolean
  clipboard?: string
  pendingDeepLink?: string | null
  recheckMpv?: boolean
  /** requests answered with not-implemented, like today's core */
  unsupported?: CoreMethod[]
  /** session.recent's rooms (default fx.recentRooms()); resume and transfer.finishExport work on them */
  recent?: RecentRoom[]
  /** rooms whose cut-off save finds data it needs gone: Finish saving gives 'rejoin' */
  exportLost?: string[]
  /** what the videos dialog (pickVideos) answers; default the one fixture video */
  pickedVideos?: string[]
}

export interface RecordedCall {
  method: string
  params: unknown
}

export class FakeCore {
  readonly calls: RecordedCall[] = []
  readonly appCalls: RecordedCall[] = []
  readonly reports: SessionReport[] = []
  state: fx.StateSlices
  settings: Settings
  clipboard: string
  pendingDeepLink: string | null
  /** what session.recent answers; finishing or giving up a cut-off save changes it like core */
  recent: RecentRoom[]
  readonly exportLost: Set<string>
  /** what the next pickVideos answers (tests may change it) */
  pickedVideos: string[]
  readonly bridge: WtBridge

  private readonly handlers = new Map<CoreMethod, AnyHandler>()
  private readonly listeners = new Map<string, Set<(d: unknown) => void>>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** rooms whose transfer.finishExport runs */
  private readonly finishing = new Set<string>()
  private readonly info: AppInfo
  private readonly timeScale: number
  private systemDark: boolean

  constructor(opts: FakeOptions = {}) {
    this.state = opts.state ?? { session: idleSession(), player: fx.player('ready') }
    this.settings = mergeSettings(defaultSettings(), { displayName: 'Alex', ...opts.settings })
    this.clipboard = opts.clipboard ?? ''
    this.pendingDeepLink = opts.pendingDeepLink ?? null
    this.recent = opts.recent ?? fx.recentRooms()
    this.exportLost = new Set(opts.exportLost)
    this.pickedVideos = opts.pickedVideos ?? ['/home/alex/Videos/' + fx.FILE.name]
    this.timeScale = opts.timeScale ?? 1
    this.systemDark = opts.systemDark ?? false
    this.info = {
      version: '0.1.0-mock',
      platform: 'linux',
      arch: 'x64',
      electron: 'mock',
      sessionType: 'wayland',
      isPackaged: false,
      isAppImage: false,
      distro: 'arch',
      ...opts.info,
    }
    this.installDefaults()
    for (const m of opts.unsupported ?? []) this.handlers.delete(m)
    this.bridge = { core: this.coreClient(), app: this.appApi(opts.recheckMpv ?? true) }
  }

  // ---- scripting ------------------------------------------------------------------------------

  handle<M extends CoreMethod>(method: M, handler: Handler<M>): void {
    this.handlers.set(method, handler as AnyHandler)
  }

  emit<E extends CoreEventName>(event: E, data: CoreEvents[E]): void {
    if (event !== 'notice') (this.state as Record<string, unknown>)[event] = data
    for (const cb of this.listeners.get(event) ?? []) cb(data)
  }

  /** Emit several slices at once (each as its own event, like core would). */
  set(slices: fx.StateSlices): void {
    for (const [k, v] of Object.entries(slices) as [CoreEventName, CoreEvents[CoreEventName]][]) this.emit(k, v)
  }

  /** Replace the state and resend the snapshot, as after a core restart. */
  reset(slices: fx.StateSlices): void {
    this.state = slices
    for (const cb of this.listeners.get('$snapshot') ?? []) cb(this.snapshot())
  }

  deepLink(link: string): void {
    for (const cb of this.listeners.get('$deeplink') ?? []) cb(link)
  }

  command(cmd: AppCommand): void {
    for (const cb of this.listeners.get('$command') ?? []) cb(cmd)
  }

  setSystemDark(dark: boolean): void {
    this.systemDark = dark
    this.pushApp('$theme', this.theme())
  }

  snapshot(): CoreSnapshot {
    return { versions: fx.versions, ...structuredClone(this.state) }
  }

  later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms * this.timeScale)
    this.timers.add(t)
  }

  clearTimers(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  dispose(): void {
    this.clearTimers()
    this.listeners.clear()
  }

  // ---- bridge ---------------------------------------------------------------------------------

  private coreClient(): CoreClient {
    return {
      request: async <M extends CoreMethod>(method: M, params: ParamsOf<M>): Promise<Result<ResultOf<M>>> => {
        this.calls.push({ method, params })
        await Promise.resolve()
        const h = this.handlers.get(method)
        if (!h) return err(CORE_ERRORS.notImplemented, `${method} is not available yet`)
        try {
          return ok((await h(params)) as ResultOf<M>)
        } catch (e) {
          return err(
            e instanceof CodedError ? e.code : CORE_ERRORS.internal,
            e instanceof Error ? e.message : String(e),
          )
        }
      },
      on: (event, cb) => this.listen(event, cb as (d: unknown) => void),
      onSnapshot: (cb) => {
        const off = this.listen('$snapshot', cb as (d: unknown) => void)
        queueMicrotask(() => cb(this.snapshot()))
        return off
      },
    }
  }

  private appApi(withRecheck: boolean): AppApi {
    const rec = (name: string, ...args: unknown[]): void => void this.appCalls.push({ method: name, params: args })
    const api: AppApi = {
      info: () => Promise.resolve(this.info),
      getSettings: () => Promise.resolve(this.settings),
      setSettings: (patch) => {
        rec('setSettings', patch)
        try {
          const before = this.settings.theme
          this.settings = mergeSettings(this.settings, patch)
          this.pushApp('$settings', this.settings)
          if (before !== this.settings.theme) this.pushApp('$theme', this.theme())
          return Promise.resolve(ok(this.settings))
        } catch (e) {
          return Promise.resolve(err('bad-request', e instanceof Error ? e.message : String(e)))
        }
      },
      onSettings: (cb) => this.listen('$settings', cb as (d: unknown) => void),
      getTheme: () => Promise.resolve(this.theme()),
      onTheme: (cb) => this.listen('$theme', cb as (d: unknown) => void),
      pickVideo: () => (rec('pickVideo'), Promise.resolve('/home/alex/Videos/' + fx.FILE.name)),
      pickVideos: () => (rec('pickVideos'), Promise.resolve([...this.pickedVideos])),
      pickSubtitles: () => (rec('pickSubtitles'), Promise.resolve(['/home/alex/Videos/friends.srt'])),
      pickFolder: (defaultPath) => (rec('pickFolder', defaultPath), Promise.resolve('/media/alex/External')),
      pickMpv: () => (rec('pickMpv'), Promise.resolve('/opt/mpv/bin/mpv')),
      openExternal: (url) => (rec('openExternal', url), Promise.resolve(ok(null))),
      showItemInFolder: (path) => (rec('showItemInFolder', path), Promise.resolve()),
      writeClipboard: (text) => {
        rec('writeClipboard', text)
        this.clipboard = text
        return Promise.resolve()
      },
      readClipboardInvite: () => Promise.resolve(extractInvite(this.clipboard.slice(0, 10_000))),
      copyDiagnostics: (core) => (rec('copyDiagnostics', core), Promise.resolve(ok(null))),
      openLogsFolder: () => (rec('openLogsFolder'), Promise.resolve()),
      onDeepLink: (cb) => this.listen('$deeplink', cb as (d: unknown) => void),
      takePendingDeepLink: () => {
        const link = this.pendingDeepLink
        this.pendingDeepLink = null
        return Promise.resolve(link)
      },
      registerLinuxDeepLinks: () => (rec('registerLinuxDeepLinks'), Promise.resolve(ok(null))),
      reportSession: (report) => void this.reports.push(report),
      onAppCommand: (cb) => this.listen('$command', cb as (d: unknown) => void),
    }
    if (withRecheck) {
      api.recheckMpv = () => {
        rec('recheckMpv')
        const path = this.settings.mpvPath
        if (path === null) return Promise.resolve(err('mpv-missing', 'mpv was not found'))
        // a path containing "broken" stands for a file that is not a working mpv
        if (path.includes('broken')) {
          return Promise.resolve(
            ok({
              path: null,
              kind: 'none' as const,
              version: null,
              status: 'missing' as const,
              tried: [
                {
                  source: 'settings' as const,
                  path,
                  status: 'unusable' as const,
                  version: null,
                  detail: 'not executable',
                },
              ],
            }),
          )
        }
        this.emit('player', fx.player('idle'))
        return Promise.resolve(
          ok({
            path,
            kind: 'system' as const,
            version: '0.41.0',
            status: 'ok' as const,
            tried: [{ source: 'settings' as const, path, status: 'ok' as const, version: '0.41.0' }],
          }),
        )
      }
    }
    return api
  }

  private theme(): ThemePayload {
    const source = this.settings.theme
    const mode = source === 'system' ? (this.systemDark ? 'dark' : 'light') : source
    return themePayload(source, mode)
  }

  private pushApp(channel: string, data: unknown): void {
    for (const cb of this.listeners.get(channel) ?? []) cb(data)
  }

  private listen(channel: string, cb: (d: unknown) => void): () => void {
    const set = this.listeners.get(channel) ?? new Set()
    this.listeners.set(channel, set)
    set.add(cb)
    return () => set.delete(cb)
  }

  // ---- default flows --------------------------------------------------------------------------

  private installDefaults(): void {
    this.handle('app.ping', () => ({ pong: true, versions: fx.versions }))
    this.handle('session.recent', () => structuredClone(this.recent))
    this.handle('session.checkDir', ({ dir }) => ({
      freeBytes: dir.startsWith('/media') ? 2_000_000_000_000 : 40_000_000_000,
      writable: true,
    }))
    this.handle('net.test', async () => {
      await this.wait(900)
      return {
        class: 'RANDOM',
        host: '198.51.100.23',
        port: null,
        bootstrapped: true,
        hint: 'Your router changes ports for every connection. Friends behind similar routers need a relay.',
      }
    })
    this.handle('diagnostics.get', () => ({
      versions: fx.versions,
      uptimeS: 42,
      eventLoopDelayP99Ms: 3.2,
      rssBytes: 180_000_000,
      nat: null,
      peers: [],
      mpv: { path: '/usr/bin/mpv', version: '0.41.0', vo: 'gpu-next', hwdec: 'vaapi' },
      logTail: [],
    }))
    this.handle('session.host', ({ videoPath }) => {
      this.startPrepare(videoPath)
      return { roomId: fx.ROOM_ID, invite: fx.INVITE }
    })
    this.handle('session.cancelPrepare', () => {
      this.clearTimers()
      this.goIdle()
      return null
    })
    this.handle('session.join', ({ invite }) => {
      if (!extractInvite(invite)) throw new CodedError('bad-invite', 'That invite is not valid.')
      this.emit('session', { ...idleSession(), phase: 'connecting', role: 'viewer' })
      this.later(800, () => this.emit('session', { ...idleSession(), phase: 'pending-admission', role: 'viewer' }))
      this.later(2000, () =>
        this.emit('session', {
          ...idleSession(),
          phase: 'confirm-join',
          role: 'viewer',
          roomId: fx.ROOM_ID,
          fileName: fx.FILE.name,
          fileSize: fx.FILE.size,
          durationS: fx.FILE.durationS,
          joinInfo: {
            name: fx.FILE.name,
            size: fx.FILE.size,
            dir: fx.JOIN_DIR,
            freeBytes: 40_000_000_000,
          },
          // the manifest arrived before confirm-join
          media: fx.media(),
        }),
      )
      return { roomId: fx.ROOM_ID }
    })
    this.handle('session.confirmJoin', () => {
      this.set(fx.inRoom('viewer', performance.now()))
      return null
    })
    this.handle('session.resume', ({ roomId }) => {
      const recent = this.recent.find((r) => r.roomId === roomId)
      if (!recent) throw new CodedError('unknown-room', 'That room is no longer saved.')
      // like core: a cut-off save is finished or given up first
      if (recent.export) {
        throw new CodedError(
          'busy',
          "This room's video from last time is still being saved. Finish or cancel saving it in Recent rooms first.",
        )
      }
      this.emit('session', { ...idleSession(), phase: 'connecting', role: recent.role })
      this.later(1200, () => this.set(fx.inRoom(recent.role, performance.now())))
      return { roomId }
    })
    this.handle('session.leave', async ({ data, end }) => {
      // like the manager: a host's leave is 'end' or 'keep', a viewer's says what happens to the download
      const leave = this.state.session?.role === 'host' ? (end ? 'end' : 'keep') : data
      await this.leaveFlow(data === 'save' ? SAVE_MS : LEAVE_MS, leave)
      return null
    })
    this.handle('room.invite', () => inviteResult())
    this.handle('room.rotateInvite', () => inviteResult())
    this.handle('room.admit', ({ peerId, allow }) => {
      const room = this.state.room
      if (room) this.emit('room', { ...room, pending: room.pending.filter((p) => p.id !== peerId) })
      const pending = room?.pending.find((p) => p.id === peerId)
      if (allow && pending) {
        this.emit('peers', [...(this.state.peers ?? []), fx.newcomer(pending.id, pending.name)])
      }
      return null
    })
    this.handle('room.kick', ({ peerId }) => {
      this.emit(
        'peers',
        (this.state.peers ?? []).filter((p) => p.id !== peerId),
      )
      return null
    })
    this.handle('room.setAdmission', ({ mode }) => {
      if (this.state.room) this.emit('room', { ...this.state.room, admission: mode })
      return null
    })
    this.handle('room.setMaxMembers', ({ n }) => {
      if (this.state.room) this.emit('room', { ...this.state.room, maxMembers: n })
      return null
    })
    this.installPlaylist()
    this.handle('sync.setPerms', (perms) => this.patchSync({ perms }))
    this.handle('sync.setWaitForAll', ({ on }) => this.patchSync({ waitForAll: on }))
    this.handle('sync.setStartMode', (startMode) => this.patchSync({ startMode }))
    this.handle('sync.startAnyway', () => {
      const rest = { ...(this.state.sync ?? fx.sync('host')) }
      delete rest.wait
      this.emit('sync', { ...rest, mode: 'playing' })
      this.setPaused(false)
      return null
    })
    this.handle('sync.request', () => null)
    this.handle('playback.resync', () => {
      const s = this.state.sync
      if (s?.mode !== 'playing') return { outcome: 'not-playing' }
      if (!s.desync) return { outcome: 'in-sync' }
      // like core: catching up, then in sync
      this.emit('sync', { ...s, desync: { state: 'catching-up' } })
      this.later(800, () => {
        const rest = { ...(this.state.sync ?? s) }
        delete rest.desync
        this.emit('sync', rest)
      })
      return { outcome: 'skip' }
    })
    this.handle('playback.intent', (intent) => {
      const s = this.state.sync
      const pb = this.state.playback
      if (!s || !pb) return { accepted: false, reason: 'not-ready' }
      if (intent.kind === 'seek' || intent.kind === 'seekRel') {
        if (!s.canSeek) return { accepted: false, reason: 'perm-seek' }
        const pos = intent.kind === 'seek' ? intent.posS : pb.posS + intent.deltaS
        const posS = Math.min(Math.max(0, pos), pb.durationS ?? pos)
        this.emit('playback', { ...pb, posS, at: performance.now() })
        return { accepted: true }
      }
      if (!s.canPlayPause) return { accepted: false, reason: 'perm-playpause' }
      const paused = intent.kind === 'toggle' ? !pb.paused : intent.kind === 'pause'
      this.setPaused(paused)
      return { accepted: true }
    })
    this.handle('player.setTrack', ({ kind, id }) => {
      if (this.state.tracks) this.emit('tracks', { ...this.state.tracks, [kind === 'audio' ? 'aid' : 'sid']: id })
      return null
    })
    this.handle('player.setVolume', ({ volume, muted }) => {
      if (this.state.tracks) this.emit('tracks', { ...this.state.tracks, volume, muted })
      return null
    })
    this.handle('player.reopen', () => null)
    this.handle('transfer.saveFile', async ({ dest }) => {
      // like core: refused (still in the room) while the download is incomplete
      if ((this.state.transfer?.progress ?? 0) < 1) {
        throw new CodedError('incomplete', 'The video is not fully downloaded yet')
      }
      const path = this.savePath(dest)
      await this.leaveFlow(SAVE_MS, 'save', dest)
      return { path }
    })
    this.handle('transfer.deleteData', () => null)
    this.handle('transfer.finishExport', async ({ roomId, giveUp }) => {
      const room = this.recent.find((r) => r.roomId === roomId)
      const save = room?.export
      if (!save) throw new CodedError('not-found', 'This room has no unfinished save')
      if (this.finishing.has(roomId)) {
        throw new CodedError('busy', 'This video is being saved right now. Try again once it is saved.')
      }
      // like core: what the save had moved into the saved file is missing again, so Resume downloads it
      if (giveUp) return this.dropExport(roomId)
      // its folder is not there: nothing changed
      if (save.waiting) return { outcome: 'waiting' }
      this.finishing.add(roomId)
      try {
        await this.wait(SAVE_MS)
      } finally {
        this.finishing.delete(roomId)
      }
      if (this.exportLost.has(roomId)) {
        // given up on its own: core's notice says why (a Cancel saving needs none)
        this.emit('notice', fx.exportNotices(`${save.dest}/${save.name}`).failed)
        return this.dropExport(roomId)
      }
      // the room's download became the saved file: nothing left to resume
      const path = `${save.dest}/${save.name}`
      this.recent = this.recent.filter((r) => r.roomId !== roomId)
      this.emit('notice', fx.savedNotice(path))
      return { outcome: 'finished', path }
    })
  }

  private dropExport(roomId: string): { outcome: 'rejoin' } {
    this.recent = this.recent.map((r) => {
      if (r.roomId !== roomId) return r
      const { export: _dropped, ...rest } = r
      return { ...rest, progress: Math.min(r.progress, 0.62), resumable: true }
    })
    return { outcome: 'rejoin' }
  }

  /** Where a save without a picked folder goes: the folder chosen when joining. */
  private savePath(dest?: string): string {
    return `${dest ?? fx.JOIN_DIR}/${this.state.session?.fileName ?? fx.FILE.name}`
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => this.later(ms, resolve))
  }

  /**
   * Like core's session.leave / transfer.saveFile: phase 'leaving' (with the session's role, room and file, and
   * `leave`: what runs, when given) while the leave runs, then idle. A 'save' then posts transfer.export-finished with
   * where the video went (`dest`, else the join folder), as core does for every finished save. Tests use it in their
   * own handlers, e.g. a save that fails after leaving; without `leave` it is a core that does not say.
   */
  async leaveFlow(ms = LEAVE_MS, leave?: SessionEvent['leave'], dest?: string): Promise<void> {
    this.clearTimers()
    const saved = leave === 'save' ? this.savePath(dest) : null
    const s = this.state.session
    if (s && s.phase !== 'idle') {
      const { role, roomId, fileName, fileSize, durationS, media } = s
      this.emit('session', {
        phase: 'leaving',
        role,
        roomId,
        fileName,
        fileSize,
        durationS,
        ...(media ? { media } : {}),
        ...(leave ? { leave } : {}),
      })
    }
    await this.wait(ms)
    this.goIdle()
    if (saved !== null) this.emit('notice', fx.savedNotice(saved))
  }

  /** The playlist requests, on state.playlist as core would change it (prepared at once, no real switch). */
  private installPlaylist(): void {
    const list = (): NonNullable<fx.StateSlices['playlist']> => {
      const p = this.state.playlist
      if (!p) throw new CodedError('not-host', 'Only the host can do this')
      return p
    }
    const put = (patch: Partial<NonNullable<fx.StateSlices['playlist']>>): null => {
      const p = list()
      this.emit('playlist', { ...p, ...patch, rev: p.rev + 1 })
      return null
    }
    const play = (id: string): null => {
      const p = list()
      const item = p.items.find((i) => i.id === id)
      if (!item) throw new CodedError('not-found', 'That item is no longer in the playlist')
      if (item.host && item.host.state !== 'ready')
        throw new CodedError('not-ready', `${item.name} is still being prepared`)
      if (this.state.session) {
        this.emit('session', {
          ...this.state.session,
          fileName: item.name,
          fileSize: item.fileSize,
          durationS: item.durationS,
        })
      }
      if (this.state.sync) this.emit('sync', { ...this.state.sync, mode: 'playing' })
      return put({ currentId: id, advance: null, items: p.items.map((i) => ({ ...i, current: i.id === id })) })
    }
    const step = (by: 1 | -1): null => {
      const p = list()
      const at = p.items.findIndex((i) => i.current)
      const next = p.items[at + by]
      if (!next) throw new CodedError('no-item', by > 0 ? 'This is the last video' : 'This is the first video')
      return play(next.id)
    }
    this.handle('playlist.add', ({ videoPaths }) => {
      const p = list()
      const added = videoPaths.map((path, k) => ({
        id: `b${String(p.items.length + k).padStart(11, '0')}`,
        name: path.split(/[\\/]/).pop() ?? path,
        fileSize: 2_000_000_000,
        durationS: null,
        current: false,
        host: { state: 'queued' as const, pct: 0 },
      }))
      put({ items: [...p.items, ...added] })
      return { added: added.length }
    })
    this.handle('playlist.remove', ({ id }) => {
      const p = list()
      if (p.items.find((i) => i.id === id)?.current) {
        throw new CodedError('current', 'The video that is playing cannot be removed')
      }
      return put({ items: p.items.filter((i) => i.id !== id) })
    })
    this.handle('playlist.move', ({ id, toIndex }) => {
      const items = [...list().items]
      const from = items.findIndex((i) => i.id === id)
      const [item] = items.splice(from, 1)
      if (item) items.splice(Math.min(toIndex, items.length), 0, item)
      return put({ items })
    })
    this.handle('playlist.play', ({ id }) => play(id))
    this.handle('playlist.next', () => step(1))
    this.handle('playlist.prev', () => step(-1))
    this.handle('playlist.setAutoAdvance', ({ on }) => put({ autoAdvance: on, ...(on ? {} : { advance: null }) }))
    this.handle('playlist.cancelAdvance', () => put({ advance: null }))
  }

  private goIdle(): void {
    this.reset({ session: idleSession(), ...(this.state.player ? { player: this.state.player } : {}) })
  }

  private patchSync(patch: Partial<NonNullable<fx.StateSlices['sync']>>): null {
    const s = this.state.sync ?? fx.sync('host')
    const next = { ...s, ...patch }
    if (patch.perms && this.state.session?.role !== 'host') {
      next.canPlayPause = patch.perms.othersPlayPause
      next.canSeek = patch.perms.othersSeek
    }
    this.emit('sync', next)
    return null
  }

  private setPaused(paused: boolean): void {
    const pb = this.state.playback
    if (!pb) return
    this.emit('playback', { ...pb, paused, at: performance.now() })
    if (this.state.sync) this.emit('sync', { ...this.state.sync, mode: paused ? 'paused' : 'playing' })
  }

  private startPrepare(videoPath: string): void {
    const fileName = videoPath.split(/[\\/]/).pop() ?? videoPath
    const total = fx.FILE.size
    this.emit('session', {
      ...idleSession(),
      phase: 'preparing',
      role: 'host',
      roomId: fx.ROOM_ID,
      fileName,
      fileSize: total,
      durationS: fx.FILE.durationS,
    })
    const feasibility = { needBps: 2_900_000, uploadBps: 4_400_000 }
    // the index is known once hashing starts
    this.later(400, () => {
      const s = this.state.session
      if (s?.phase === 'preparing') this.emit('session', { ...s, media: fx.media() })
    })
    this.emit('prepare', {
      stage: 'indexing',
      bytesDone: 0,
      bytesTotal: total,
      bytesPerSec: 0,
      cached: false,
      feasibility,
    })
    const steps = 20
    for (let i = 1; i <= steps; i++) {
      this.later(400 + i * 300, () =>
        this.emit('prepare', {
          stage: i === steps ? 'ready' : 'hashing',
          bytesDone: Math.round((total * i) / steps),
          bytesTotal: total,
          bytesPerSec: 1_450_000_000,
          cached: false,
          feasibility,
        }),
      )
    }
    this.later(400 + steps * 300 + 600, () => this.set(fx.inRoom('host', performance.now())))
  }
}

/** Simulated length of a leave, and of a 'save' export (which takes minutes for real). */
const LEAVE_MS = 400
const SAVE_MS = 3000

function idleSession(): NonNullable<fx.StateSlices['session']> {
  return { phase: 'idle', role: null, roomId: null, fileName: null, fileSize: null, durationS: null }
}

function inviteResult(): { invite: string; link: string; text: string } {
  return {
    invite: fx.INVITE,
    link: fx.INVITE,
    text: `Join me on Cinemesh to watch ${fx.FILE.name}:\n${fx.INVITE}\n\nNo app yet? https://example.invalid/download`,
  }
}
