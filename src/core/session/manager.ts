import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { MpvInfo } from '../../shared/ipc/control.js'
import type {
  CoreDiagnostics,
  CoreEvents,
  LeaveData,
  PlayerEvent,
  RecentRoom,
  ResultOf,
  SessionEvent,
} from '../../shared/ipc/core.js'
import { StartModeSchema, type Settings } from '../../shared/settings.js'
import { CodedError } from '../../shared/result.js'
import type { ThemePayload } from '../../shared/theme-tokens.js'
import { networkTest } from '../net/diagnostics.js'
import { roomIdFor } from '../net/identity.js'
import { decodeInvite } from '../net/invite.js'
import { resolveBootstrap } from '../net/swarm.js'
import type { MpvBinary } from '../player/player-controller.js'
import { versionFromString } from '../player/mpv-version.js'
import type { RpcServer } from '../rpc-server.js'
import { freeBytes } from '../transfer/disk.js'
import { type ResumedExport, dropExport, exportPending, pendingExport, resumeExport } from '../transfer/save-file.js'
import type { MpvChoice, SessionDeps } from './base-session.js'
import { HostSession } from './host-session.js'
import { type SessionFileData, SessionFile, readSessionFile, sessionFilePath } from './session-file.js'
import { SweepKeep, isPartialDir, sweepPartialData } from './sweep.js'
import { ViewerSession } from './viewer-session.js'

type Session = HostSession | ViewerSession
/** what a leave does: a viewer's data choice, or a host's end of the room ('keep' leaves it resumable) */
type LeaveKind = LeaveData | 'end'
/** A transfer folder holding the journal of a save a quit, a crash or a missing drive cut off, and the rooms using it. */
interface PendingExport {
  dir: string
  roomIds: string[]
}

const empty = z.object({}).strict()
const id = z.string().min(1).max(128)
/** how long a session start (or Recent rooms) waits for the startup sweep; a start then tells it to stop deleting */
const SWEEP_WAIT_MS = 10_000
/** how long a quit waits for the session to stop: main kills core 5 s after asking it to shut down */
const SHUTDOWN_WAIT_MS = 3000
/** session.join, session.resume and transfer.deleteData of a room whose save is pending or running */
const SAVE_PENDING =
  "This room's video from last time is still being saved. Finish or cancel saving it in Recent rooms first."

/** MpvInfo (main's lookup) → what PlayerController takes. */
export function mpvChoiceFrom(info: MpvInfo): MpvChoice {
  const version = info.version ? versionFromString(info.version) : null
  if (info.path && version && info.kind !== 'none' && (info.status ?? 'ok') === 'ok') {
    const binary: MpvBinary = { path: info.path, kind: info.kind, version }
    return { binary }
  }
  return { binary: null, unavailable: info.status === 'tooOld' ? 'tooOld' : 'missing' }
}

/**
 * Owns the current session (at most one) and implements the renderer contract (src/shared/ipc/core.ts):
 * every request is validated here, then delegated to the host or viewer session.
 */
export class SessionManager {
  private current: Session | null = null
  private settings: Settings
  private theme: ThemePayload
  private mpv: MpvChoice
  private mpvInfo: MpvInfo
  private starting = false
  /** the startup sweep; sessions wait for it so it never races a download into the same folder */
  private readonly sweeping: Promise<void>
  private readonly stopSweep = new AbortController()
  /** rooms the sweep leaves alone: the one that was open when core died, and any the user resumes meanwhile */
  private readonly keep = new SweepKeep()
  /** marker writes run in call order, so a clear never loses to an earlier, slower write */
  private marker: Promise<void> = Promise.resolve()
  /** what each session's leave was asked to do: a different second leave is refused meanwhile */
  private readonly leaveAsked = new WeakMap<Session, LeaveKind>()
  /** the startup run of 'save' exports a quit, a crash or a missing drive cut off (see finishExports) */
  private readonly exporting: Promise<void>
  /** startup has found those exports, and registered their folders in exportingDirs */
  private readonly exportsFound: Promise<void>
  private readonly stopExports = new AbortController()
  /**
   * Transfer folders whose export is queued or running: the startup's (all registered before the first runs), a
   * transfer.finishExport's, and a 'save' leave's. Nothing else may run an export there, nor start a session of a room
   * using one; ViewerSession refuses to download into a folder holding an export journal at all.
   */
  private readonly exportingDirs = new Set<string>()
  /** viewer sessions whose save was announced (transfer.export-finished): one save asked for twice is one notice */
  private readonly announced = new WeakSet<Session>()
  /** resolves once startup (the sweep, the crash-restart resume and the cut-off exports) is done; tests await it */
  readonly started: Promise<void>

  constructor(
    private readonly rpc: RpcServer,
    private readonly deps: Omit<SessionDeps, 'settings' | 'theme' | 'mpv' | 'emit' | 'clearEvent'> & {
      settings: Settings
      theme: ThemePayload
      mpv: MpvInfo
      /** main restarted core after a crash: resume the room that was active (plan §4.5 "Host restart") */
      resumeActive?: boolean
      /** the bound on waiting for the startup sweep; SWEEP_WAIT_MS unless a test needs it short */
      sweepWaitMs?: number
      /** the bound on a quit waiting for the session to stop; SHUTDOWN_WAIT_MS unless a test needs it short */
      shutdownWaitMs?: number
    },
  ) {
    this.settings = deps.settings
    this.theme = deps.theme
    this.mpvInfo = deps.mpv
    this.mpv = mpvChoiceFrom(deps.mpv)
    this.register()
    this.emitIdle()
    const active = this.readActive()
    this.sweeping = active.then((roomId) => this.sweep(roomId))
    // alongside the sweep, which leaves their folders alone; sessions do not wait for them
    const found = this.findExports()
    this.exportsFound = found.then(() => undefined)
    this.exporting = found.then((pending) => this.finishExports(pending))
    // a resume waits for the sweep in begin(), like any session
    this.started = active.then(async (roomId) => {
      await this.afterStart(roomId)
      await this.sweeping
      await this.exporting
    })
  }

  // ---- startup: active marker, sweep, resume after a core crash ------------------------------------

  private activePath(): string {
    return join(this.deps.paths.userData, 'wt', 'active.json')
  }

  private async readActive(): Promise<string | null> {
    try {
      const raw = await readFile(this.activePath(), 'utf8')
      const parsed = z.object({ roomId: id }).safeParse(JSON.parse(raw) as unknown)
      return parsed.success ? parsed.data.roomId : null
    } catch {
      return null // none, or torn by a crash: nothing to resume (the next session overwrites it)
    }
  }

  /** The room in use, kept while it lasts: a core that dies with it set is resumed by its restart. */
  private markActive(roomId: string | null): Promise<void> {
    this.marker = this.marker.then(() => this.writeMarker(roomId))
    return this.marker
  }

  private async writeMarker(roomId: string | null): Promise<void> {
    const file = this.activePath()
    try {
      if (!roomId) {
        await rm(file, { force: true })
        return
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify({ roomId }))
      await rename(`${file}.tmp`, file)
    } catch (e) {
      this.deps.log.warn(`active-room marker: ${String(e)}`)
    }
  }

  private async sweep(active: string | null): Promise<void> {
    // resumed by a crash restart, or offered by Recent rooms after a whole-app crash
    if (active) this.keep.claim(active)
    try {
      const swept = await sweepPartialData({
        userData: this.deps.paths.userData,
        store: this.deps.store,
        folders: [this.settings.downloadDir ?? this.deps.paths.downloadDir],
        capBytes: this.settings.cacheCapGB * 1e9,
        keep: this.keep,
        now: Date.now(),
        signal: this.stopSweep.signal,
      })
      for (const s of swept) {
        this.deps.log.info(`swept ${s.why === 'age' ? 'unused' : 'over-cap'} download ${s.dir} (${String(s.bytes)} B)`)
      }
    } catch (e) {
      this.deps.log.warn(`partial-data sweep failed: ${String(e)}`)
    }
  }

  /** The startup sweep is over, or stuck so long (a dead mount) that waiting longer helps nobody. */
  private async sweepDone(): Promise<void> {
    if (this.stopSweep.signal.aborted) return
    await Promise.race([this.sweeping, delay(this.deps.sweepWaitMs ?? SWEEP_WAIT_MS, undefined, { ref: false })])
  }

  /**
   * Sessions wait for the sweep, so it never deletes a folder one is about to use. A sweep stuck on a
   * dead mount (a save folder on an unplugged network drive) stops deleting instead of blocking every room.
   */
  private async sweepSettled(): Promise<void> {
    await this.sweepDone()
    this.stopSweep.abort()
  }

  private async afterStart(active: string | null): Promise<void> {
    if (!active) return
    if (!this.deps.resumeActive) {
      // a whole-app crash or kill: Recent rooms offers the resume instead
      await this.markActive(null)
      return
    }
    this.deps.log.info(`resuming room ${active} after a core restart`)
    try {
      await this.resume(active)
    } catch (e) {
      this.deps.log.error('resuming after a core restart failed', e)
      // a room the user started meanwhile keeps its own marker
      if (!this.current && !this.starting) await this.markActive(null)
      // no window may be connected yet (a reload, a window still loading): it gets this when it is
      this.rpc.noticeUntilSeen({
        level: 'error',
        code: 'session.resume-failed',
        message: `The background process restarted and could not rejoin the room: ${e instanceof Error ? e.message : String(e)}`,
      })
    }
  }

  // ---- saves a quit, a crash or a missing drive cut off (export journals, transfer/save-file.ts) ------------------

  /**
   * Startup: our rooms' transfer folders that hold an export journal. Every one is registered in exportingDirs before
   * the first is run, so a join, a resume or a Finish saving of one queued behind another is refused meanwhile.
   */
  private async findExports(): Promise<PendingExport[]> {
    let pending: PendingExport[] = []
    try {
      pending = await this.pendingExports()
    } catch (e) {
      this.deps.log.warn(`looking for unfinished saves failed: ${String(e)}`)
    }
    // a Finish saving or a save leave that started while a slow folder held up this scan owns its folder already
    pending = pending.filter((p) => !this.exportingDirs.has(p.dir))
    for (const p of pending) this.exportingDirs.add(p.dir)
    return pending
  }

  /**
   * Finishes them without the network, one after another. Each room keeps its record until its video is saved; Recent
   * rooms offers Finish saving and Cancel saving for it meanwhile (transfer.finishExport), and the sweep never touches
   * its folder. One whose folder is not there (a drive to connect) waits for that Finish saving.
   */
  private async finishExports(pending: readonly PendingExport[]): Promise<void> {
    let next = 0
    try {
      for (; next < pending.length && !this.stopExports.signal.aborted; next++) {
        const p = pending[next]
        if (!p) continue
        try {
          await this.finishAtStartup(p).catch((e: unknown) => this.deps.log.error('finishing a cut-off save failed', e))
        } finally {
          this.exportingDirs.delete(p.dir)
        }
      }
    } finally {
      // stopped by a quit: those go on at the next start
      for (const p of pending.slice(next)) this.exportingDirs.delete(p.dir)
    }
  }

  /** Our rooms' transfer folders that hold an export journal, with the rooms that use each. */
  private async pendingExports(): Promise<PendingExport[]> {
    const rooms = new Map<string, string[]>()
    for (const rec of await this.deps.store.list()) {
      if (rec.role !== 'viewer') continue
      const file = await readSessionFile(this.deps.paths.userData, rec.id)
      const dir = file ? transferDirOf(file) : null
      if (!dir || (!rooms.has(dir) && !(await exportPending(dir)))) continue
      rooms.set(dir, [...(rooms.get(dir) ?? []), rec.id])
    }
    return [...rooms].map(([dir, roomIds]) => ({ dir, roomIds }))
  }

  private async finishAtStartup(p: PendingExport): Promise<void> {
    const pending = await pendingExport(p.dir).catch(() => null)
    if (!pending) return
    const { name, dest } = pending
    // its folder is not there (or its drive unmounted): nothing to start, nor to say it is being finished
    if (dest !== null && pending.away) {
      this.exportWaiting(name, dest, p.roomIds[0])
      return
    }
    // no window may be connected yet: each gets these when it is
    this.rpc.noticeUntilSeen({ level: 'info', code: 'transfer.export-resumed', message: `Finishing saving ${name}…` })
    try {
      const r = await this.runExport(p, () => resumeExport(p.dir, { signal: this.stopExports.signal }))
      if (r?.outcome === 'rejoin') this.exportFailed(r, p.roomIds[0])
    } catch (e) {
      if (this.stopExports.signal.aborted) return // quitting: it goes on at the next start
      // it went away while the export ran
      if (dest !== null && isDestAway(e)) {
        this.exportWaiting(name, dest, p.roomIds[0])
        return
      }
      this.deps.log.error(`finishing saving ${name} failed`, e)
      this.rpc.noticeUntilSeen({
        level: 'warn',
        code: 'transfer.export-failed',
        message: `Saving ${name} stopped: ${errorText(e)}. Choose Finish saving in Recent rooms to try again, or it goes on the next time Cinemesh starts.`,
        ...(p.roomIds[0]
          ? { action: { label: 'Finish saving', request: 'transfer.finishExport', params: { roomId: p.roomIds[0] } } }
          : {}),
      })
    }
  }

  /**
   * One cut-off export, run by `run` (the caller registered its folder), and its outcome for the rooms keeping their
   * download there: 'finished' removes them (nothing is left to resume) and says where the video went; 'rejoin' lowers
   * their progress, so Recent rooms shows what a Resume downloads again. Only rooms whose session.json still names that
   * folder, and never the room in use now.
   */
  private async runExport(p: PendingExport, run: () => Promise<ResumedExport | null>): Promise<ResumedExport | null> {
    const r = await run()
    if (!r) return null
    const rooms: string[] = []
    for (const roomId of p.roomIds) {
      if (roomId === this.current?.roomId) continue
      const file = await readSessionFile(this.deps.paths.userData, roomId)
      if (file && transferDirOf(file) === p.dir) rooms.push(roomId)
    }
    if (r.outcome === 'finished') {
      this.deps.log.info(`saved ${r.video}, which a quit, a crash or a missing drive had cut off`)
      for (const roomId of rooms) await this.deps.store.remove(roomId).catch(() => undefined)
      this.announceSaved(r.video)
    } else {
      this.deps.log.warn(`could not finish saving ${r.name}: ${r.why}`)
      if (r.progress !== null) for (const roomId of rooms) await this.setProgress(roomId, r.progress)
    }
    return r
  }

  /** transfer.finishExport: a room's cut-off save, finished now (or dropped, with giveUp), with no session needed. */
  private async finishExport(roomId: string, giveUp: boolean): Promise<ResultOf<'transfer.finishExport'>> {
    await this.exportsKnown()
    const dir = await this.transferDirOfRoom(roomId)
    if (!dir || !(await exportPending(dir))) throw new CodedError('not-found', 'This room has no unfinished save')
    // the startup's run, another Finish saving, or the save leave that made it: one export at a time in a folder
    if (this.exportingDirs.has(dir)) {
      throw new CodedError('busy', 'This video is being saved right now. Try again once it is saved.')
    }
    this.exportingDirs.add(dir)
    try {
      const p = { dir, roomIds: await this.roomsUsing(dir) }
      const r = await this.runExport(p, () =>
        giveUp ? dropExport(dir) : resumeExport(dir, { signal: this.stopExports.signal }),
      )
      if (!r) throw new CodedError('not-found', 'This room has no unfinished save')
      if (r.outcome === 'finished') return { outcome: 'finished', path: r.video }
      // given up on its own: the notice says why (a Cancel saving needs none)
      if (!giveUp) this.exportFailed(r, roomId)
      return { outcome: 'rejoin' }
    } catch (e) {
      if (isDestAway(e)) return { outcome: 'waiting' }
      if (e instanceof CodedError) throw e
      this.deps.log.error('finishing a cut-off save failed', e)
      throw new CodedError('save-failed', `Saving stopped: ${errorText(e)}`)
    } finally {
      this.exportingDirs.delete(dir)
    }
  }

  /** The rooms whose session.json names that transfer folder now. */
  private async roomsUsing(dir: string): Promise<string[]> {
    const out: string[] = []
    for (const rec of await this.deps.store.list()) {
      const file = await readSessionFile(this.deps.paths.userData, rec.id)
      if (file && transferDirOf(file) === dir) out.push(rec.id)
    }
    return out
  }

  /** Startup has registered its pending exports, or has looked for them longer than a session start waits (a dead mount). */
  private async exportsKnown(): Promise<void> {
    await Promise.race([this.exportsFound, delay(this.deps.sweepWaitMs ?? SWEEP_WAIT_MS, undefined, { ref: false })])
  }

  /**
   * A room whose save is pending or running: a session of it would race the export for the segments, and point its
   * session.json, the one way to that export, at another folder. Refused until the save is finished or cancelled.
   */
  private async assertNotSaving(roomId: string): Promise<void> {
    await this.exportsKnown()
    if (await this.savingIn(await this.transferDirOfRoom(roomId))) throw new CodedError('busy', SAVE_PENDING)
  }

  /** That transfer folder's export is queued, running, or pending (its journal is there). */
  private async savingIn(dir: string | null): Promise<boolean> {
    return dir !== null && (this.exportingDirs.has(dir) || (await exportPending(dir)))
  }

  private async transferDirOfRoom(roomId: string): Promise<string | null> {
    const file = await readSessionFile(this.deps.paths.userData, roomId)
    return file ? transferDirOf(file) : null
  }

  private async setProgress(roomId: string, progress: number): Promise<void> {
    const data = await readSessionFile(this.deps.paths.userData, roomId)
    if (!data) return
    const file = new SessionFile(sessionFilePath(this.deps.paths.userData, roomId), data)
    file.update({ progress })
    await file.flush()
  }

  /** Every finished save says where the video went, also to a window that connects later (one reloaded mid-save). */
  private announceSaved(path: string): void {
    this.rpc.noticeUntilSeen({
      level: 'info',
      code: 'transfer.export-finished',
      message: `Saved ${basename(path)}`,
      path,
    })
  }

  /** A session's save, announced once: session.leave {data: 'save'} and transfer.saveFile share one. */
  private announce(s: Session, path: string): void {
    if (this.announced.has(s)) return
    this.announced.add(s)
    this.announceSaved(path)
  }

  private exportWaiting(name: string, dest: string, roomId: string | undefined): void {
    this.deps.log.info(`saving ${name} waits for ${dest}, which is not there`)
    this.rpc.noticeUntilSeen({
      level: 'warn',
      code: 'transfer.export-waiting',
      message: `Saving ${name} is waiting for ${dest}: connect it, then choose Finish saving.`,
      ...(roomId ? { action: { label: 'Finish saving', request: 'transfer.finishExport', params: { roomId } } } : {}),
    })
  }

  /** The action gives each room's notice its own toast (two at one startup do not collapse) and the next step. */
  private exportFailed(r: Extract<ResumedExport, { outcome: 'rejoin' }>, roomId: string | undefined): void {
    this.rpc.noticeUntilSeen({
      level: 'warn',
      code: 'transfer.export-failed',
      message: `Could not finish saving ${r.name}: ${r.why}. Resume the room from Recent rooms to download the missing parts again, then save it.`,
      ...(roomId ? { action: { label: 'Resume', request: 'session.resume', params: { roomId } } } : {}),
    })
  }

  // ---- control messages from main -------------------------------------------------------------

  updateSettings(s: Settings): void {
    this.settings = s
    this.current?.updateSettings(s)
  }

  updateTheme(t: ThemePayload): void {
    this.theme = t
    this.current?.updateTheme(t)
  }

  updateMpv(info: MpvInfo): void {
    this.mpvInfo = info
    this.mpv = mpvChoiceFrom(info)
    // with no player yet (preparing, joining) the renderer still needs to leave MpvSetup
    if (this.current?.playerHolder()) void this.current.mpvChanged()
    else this.rpc.emit('player', this.idlePlayerEvent())
  }

  get mpvDiagnostics(): MpvInfo {
    return this.mpvInfo
  }

  /**
   * App quit: leave without ending the room, so the host can resume it later. A 'save' leave already running is what
   * leave() hands back here (the first call's options win): it may fail ('incomplete'), and its export can take
   * minutes, so the quit waits for it at most SHUTDOWN_WAIT_MS; its export journal finishes it at the next start.
   */
  async shutdown(): Promise<void> {
    const s = this.current
    this.current = null
    this.stopExports.abort() // one being finished from startup stops at its next step, and goes on next time
    const leaving = s instanceof HostSession ? s.leave({ end: false }) : s?.leave({ data: 'keep' })
    const stopped = Promise.all([leaving, this.exporting]).then(
      () => true,
      (e: unknown) => {
        this.deps.log.warn(`leaving on quit failed: ${e instanceof Error ? e.message : String(e)}`)
        return true
      },
    )
    const waitMs = this.deps.shutdownWaitMs ?? SHUTDOWN_WAIT_MS
    if (!(await Promise.race([stopped, delay(waitMs, false, { ref: false })]))) {
      this.deps.log.warn(`quitting before the session stopped (${String(waitMs)} ms): a save goes on at the next start`)
    }
    await this.markActive(null) // a clean quit: nothing to resume automatically
  }

  diagnostics(): Pick<CoreDiagnostics, 'nat' | 'peers'> {
    const s = this.current
    if (!s) return { nat: null, peers: [] }
    const state = s.room.state()
    return {
      nat: state.nat,
      peers: s.room
        .members()
        .filter((m) => !m.self)
        .map((m) => ({ id: m.id.slice(0, 8), path: m.path, rttMs: m.rttMs })),
    }
  }

  // ---- sessions -------------------------------------------------------------------------------

  private sessionDeps(): SessionDeps {
    return {
      ...this.deps,
      settings: () => this.settings,
      theme: () => this.theme,
      mpv: () => this.mpv,
      emit: (e, d) => {
        this.rpc.emit(e, d)
        // the host closed the room: nothing for a crash restart to rejoin
        if (e === 'session' && (d as CoreEvents['session']).phase === 'ended') void this.markActive(null)
      },
      clearEvent: (e) => this.rpc.clear(e),
    }
  }

  private async begin(make: () => Promise<Session>): Promise<Session> {
    if (this.current || this.starting) throw new CodedError('busy', 'Leave the current room first')
    this.starting = true
    try {
      await this.sweepSettled()
      const s = await make()
      this.current = s
      await this.markActive(s.roomId)
      return s
    } finally {
      this.starting = false
    }
  }

  /** Clears the session only if it is still current (a shutdown or another leave may have won). */
  private async end(s: Session): Promise<void> {
    if (this.current !== s) return
    this.current = null
    this.emitIdle()
    await this.markActive(null)
  }

  /**
   * Every leave the user asks for. A second one while the first runs waits for it when it asks for the
   * same thing, and is refused when it does not: it would silently get the first one's outcome.
   * The first goes out as phase 'leaving' (a 'save' export can take minutes), with what it does, unless `quiet`.
   * 'idle' follows once it is over, whether it worked or not: the session is stopped either way.
   */
  private async leaving<T>(
    s: Session,
    how: LeaveKind,
    leave: () => Promise<T>,
    opts: { quiet?: boolean } = {},
  ): Promise<T> {
    const asked = this.leaveAsked.get(s)
    if (asked !== undefined && asked !== how) throw new CodedError('busy', 'Already leaving the room')
    this.leaveAsked.set(s, how)
    // a leaving session stays quiet (it stands down at once), so this holds until the idle below
    if (asked === undefined && !opts.quiet) this.rpc.emit('session', leavingEvent(s, this.rpc.snapshot().session, how))
    void this.markActive(null) // a crash from here on must not bring the room back
    // a save's export runs in that folder now: no transfer.finishExport, nor a session of a room using it, meanwhile
    const exporting = asked === undefined && how === 'save' && s instanceof ViewerSession ? s.transferDir : null
    if (exporting) this.exportingDirs.add(exporting)
    try {
      return await leave()
    } finally {
      if (exporting) this.exportingDirs.delete(exporting)
      await this.end(s)
    }
  }

  /** session.resume, and the automatic resume after a core restart. */
  private async resume(roomId: string): Promise<void> {
    // the sweep leaves this room alone from now on; one it is deleting already is gone
    if (!this.keep.claim(roomId)) {
      throw new CodedError(
        'unknown-room',
        "That room's download is being cleared (unused for a week, or over the cache limit)",
      )
    }
    await this.begin(async () => {
      // read once the sweep has settled: it may have deleted the room before the claim
      const record = await this.deps.store.load(roomId)
      if (!record) throw new CodedError('unknown-room', 'That room is not on this computer any more')
      const file = await readSessionFile(this.deps.paths.userData, roomId)
      if (record.role !== 'host') {
        await this.assertNotSaving(roomId)
        return ViewerSession.join(this.sessionDeps(), { resume: { record, file } })
      }
      if (!file?.videoPath) throw new CodedError('not-resumable', 'The room has no video to resume')
      const { videoPath } = file
      await access(videoPath).catch(() => {
        throw new CodedError('file-missing', 'The video file cannot be read')
      })
      return HostSession.start(this.sessionDeps(), {
        videoPath,
        subtitlePaths: file.subtitlePaths ?? [],
        resume: { record, file },
      })
    })
  }

  private emitIdle(): void {
    this.rpc.emit('session', {
      phase: 'idle',
      role: null,
      roomId: null,
      fileName: null,
      fileSize: null,
      durationS: null,
    })
    this.rpc.emit('player', this.idlePlayerEvent())
  }

  /** Before any session the player is not running; 'missing'/'tooOld' let the UI show MpvSetup. */
  private idlePlayerEvent(): PlayerEvent {
    const status = this.mpv.binary ? 'absent' : (this.mpv.unavailable ?? 'missing')
    return {
      status,
      version: this.mpvInfo.version,
      hdr: { source: 'unknown', output: 'unknown', gpuContext: null, hwdec: null },
    }
  }

  private host(): HostSession {
    if (!(this.current instanceof HostSession)) throw new CodedError('not-host', 'Only the host can do this')
    return this.current
  }

  private viewer(): ViewerSession {
    if (!(this.current instanceof ViewerSession)) throw new CodedError('not-viewer', 'Only a viewer can do this')
    return this.current
  }

  private session(): Session {
    if (!this.current) throw new CodedError('no-session', 'You are not in a room')
    return this.current
  }

  private register(): void {
    const r = this.rpc

    r.handle(
      'session.host',
      async (p) => {
        await access(p.videoPath).catch(() => {
          throw new CodedError('file-missing', 'The video file cannot be read')
        })
        const s = await this.begin(() => HostSession.start(this.sessionDeps(), p))
        return { roomId: s.roomId, invite: s.room.invite().link }
      },
      (raw) => z.object({ videoPath: z.string().min(1), subtitlePaths: z.array(z.string().min(1)).max(16) }).parse(raw),
    )

    r.handle(
      'session.join',
      async (p) => {
        // the invite names the room: one whose save is pending gets no new session, nor its record repointed
        await this.assertNotSaving(roomIdFor(decodeInvite(p.invite).hostKey))
        const s = await this.begin(() => ViewerSession.join(this.sessionDeps(), { invite: p.invite }))
        return { roomId: s.roomId }
      },
      (raw) => z.object({ invite: z.string().min(1).max(2000) }).parse(raw),
    )

    r.handle(
      'session.confirmJoin',
      async (p) => {
        // it refuses a folder where a save of this video is pending (from any room)
        await this.viewer().confirmJoin(p.dir)
        return null
      },
      (raw) => z.object({ dir: z.string().min(1) }).parse(raw),
    )

    r.handle(
      'session.resume',
      async (p) => {
        await this.resume(p.roomId)
        return { roomId: p.roomId }
      },
      (raw) => z.object({ roomId: id }).parse(raw),
    )

    r.handle(
      'session.leave',
      async (p) => {
        const s = this.session()
        if (s instanceof HostSession) {
          const end = p.end ?? false
          await this.leaving(s, end ? 'end' : 'keep', () => s.leave({ end }))
        } else {
          const saved = await this.leaving(s, p.data, () => s.leave({ data: p.data }))
          if (p.data === 'save') {
            if (!saved) throw await this.saveFailed(s.roomId)
            this.announce(s, saved)
          }
        }
        return null
      },
      (raw) => z.object({ data: z.enum(['keep', 'save', 'delete']), end: z.boolean().optional() }).parse(raw),
    )

    r.handle(
      'session.cancelPrepare',
      async () => {
        const h = this.host()
        if (!h.isPreparing()) throw new CodedError('not-preparing', 'The room is already open')
        // HostPrepare stays up until idle: 'leaving' is for session.leave and transfer.saveFile
        await this.leaving(h, 'end', () => h.cancelPrepare(), { quiet: true })
        return null
      },
      (raw) => empty.parse(raw),
    )

    r.handle(
      'session.recent',
      () => this.recent(),
      (raw) => empty.parse(raw),
    )

    r.handle(
      'session.checkDir',
      async (p) => ({ freeBytes: await freeBytes(p.dir).catch(() => 0), writable: await writable(p.dir) }),
      (raw) => z.object({ dir: z.string().min(1) }).parse(raw),
    )

    // ---- room (host admin) ----
    const inviteOut = (): { invite: string; link: string; text: string } => {
      const i = this.session().room.invite()
      return { invite: i.code, link: i.link, text: i.text }
    }
    r.handle('room.invite', inviteOut, (raw) => empty.parse(raw))
    r.handle(
      'room.rotateInvite',
      () => {
        const i = this.host().room.rotateInvite()
        return { invite: i.code, link: i.link, text: i.text }
      },
      (raw) => empty.parse(raw),
    )
    r.handle(
      'room.admit',
      (p) => {
        this.host().room.admit(p.peerId, p.allow)
        return null
      },
      (raw) => z.object({ peerId: id, allow: z.boolean() }).parse(raw),
    )
    r.handle(
      'room.kick',
      (p) => {
        this.host().room.kick(p.peerId, { rotate: p.rotate })
        return null
      },
      (raw) => z.object({ peerId: id, rotate: z.boolean() }).parse(raw),
    )
    r.handle(
      'room.setAdmission',
      (p) => {
        this.host().room.setAdmission(p.mode)
        return null
      },
      (raw) => z.object({ mode: z.enum(['open', 'approve']) }).parse(raw),
    )
    r.handle(
      'room.setMaxMembers',
      (p) => {
        this.host().room.setMaxMembers(p.n)
        return null
      },
      (raw) => z.object({ n: z.number().int().min(2).max(12) }).parse(raw),
    )

    // ---- sync ----
    const engine = () => {
      const e = this.session().syncEngine()
      if (!e) throw new CodedError('not-ready', 'Playback is not ready yet')
      return e
    }
    r.handle(
      'sync.setPerms',
      (p) => {
        engine().setPerms(p)
        return null
      },
      (raw) => z.object({ othersPlayPause: z.boolean(), othersSeek: z.boolean() }).parse(raw),
    )
    r.handle(
      'sync.setWaitForAll',
      (p) => {
        engine().setWaitForAll(p.on)
        return null
      },
      (raw) => z.object({ on: z.boolean() }).parse(raw),
    )
    r.handle(
      'sync.setStartMode',
      (p) => {
        engine().setStartMode(p)
        return null
      },
      (raw) => StartModeSchema.parse(raw),
    )
    r.handle(
      'sync.startAnyway',
      () => {
        engine().startAnyway()
        return null
      },
      (raw) => empty.parse(raw),
    )
    r.handle(
      'sync.request',
      (p) => {
        engine().request(p.kind, p.posS)
        return null
      },
      (raw) =>
        z.object({ kind: z.enum(['play', 'pause', 'seek']), posS: z.number().nonnegative().optional() }).parse(raw),
    )
    r.handle(
      'playback.intent',
      async (p) => this.session().intent(p),
      (raw) =>
        z
          .discriminatedUnion('kind', [
            z.object({ kind: z.enum(['play', 'pause', 'toggle']) }),
            z.object({ kind: z.literal('seek'), posS: z.number().nonnegative() }),
            z.object({ kind: z.literal('seekRel'), deltaS: z.number() }),
          ])
          .parse(raw),
    )
    // local to this viewer: no permission, nothing published (MemberController.resync)
    r.handle(
      'playback.resync',
      () => ({ outcome: this.viewer().resync() }),
      (raw) => empty.parse(raw),
    )

    // ---- player (local only) ----
    const player = () => {
      const p = this.session().playerHolder()
      if (!p) throw new CodedError('no-player', 'The player is not running')
      return p
    }
    r.handle(
      'player.setTrack',
      async (p) => {
        await player().setTrack(p.kind, p.id)
        return null
      },
      (raw) =>
        z
          .object({ kind: z.enum(['audio', 'sub']), id: z.union([z.number().int().nonnegative(), z.literal('no')]) })
          .parse(raw),
    )
    r.handle(
      'player.setVolume',
      async (p) => {
        await player().setVolume(p.volume, p.muted)
        return null
      },
      (raw) => z.object({ volume: z.number().min(0).max(130), muted: z.boolean() }).parse(raw),
    )
    r.handle(
      'player.reopen',
      () => {
        player().reopen()
        return null
      },
      (raw) => empty.parse(raw),
    )

    // ---- data ----
    r.handle(
      'transfer.saveFile',
      async (p) => {
        const v = this.viewer()
        if (v.isLeaving) throw new CodedError('busy', 'Already leaving the room')
        if (v.progress < 1) throw new CodedError('incomplete', 'The video is not fully downloaded yet')
        const path = await this.leaving(v, 'save', () =>
          v.leave({ data: 'save', ...(p.dest ? { saveDir: p.dest } : {}) }),
        )
        if (!path) throw await this.saveFailed(v.roomId)
        // the window learns where it went from this notice: one reloaded meanwhile never gets this answer
        this.announce(v, path)
        return { path }
      },
      (raw) => z.object({ dest: z.string().min(1).optional() }).parse(raw),
    )
    r.handle(
      'transfer.deleteData',
      async (p) => {
        await this.deleteData(p.infoHash)
        return null
      },
      (raw) => z.object({ infoHash: z.string().regex(/^[0-9a-f]{40}$/) }).parse(raw),
    )
    r.handle(
      'transfer.finishExport',
      (p) => this.finishExport(p.roomId, p.giveUp ?? false),
      (raw) => z.object({ roomId: id, giveUp: z.boolean().optional() }).parse(raw),
    )

    r.handle(
      'net.test',
      () => {
        // An open room's DHT holds udpPort: a second node would bind another port and test that one instead
        const nat = this.current?.room.state().nat
        if (nat?.bootstrapped) return nat
        return networkTest({
          ...(resolveBootstrap(process.env.WT_BOOTSTRAP, this.settings.bootstrapExtra)
            ? { bootstrap: resolveBootstrap(process.env.WT_BOOTSTRAP, this.settings.bootstrapExtra) }
            : {}),
          ...(this.settings.udpPort ? { port: this.settings.udpPort } : {}),
        })
      },
      (raw) => empty.parse(raw),
    )
  }

  private async recent(): Promise<RecentRoom[]> {
    // Home asks right at startup: never offer a download the sweep is about to delete
    await this.sweepDone()
    const records = await this.deps.store.list()
    const out: RecentRoom[] = []
    for (const rec of records) {
      const file = await readSessionFile(this.deps.paths.userData, rec.id)
      if (!file) continue
      // a save a quit, a crash or a missing drive cut off: Home offers Finish saving and Cancel saving instead
      const dir = transferDirOf(file)
      const saving = dir && (await exportPending(dir)) ? await exportEntry(dir) : null
      const resumable =
        file.role === 'host'
          ? Boolean(file.videoPath && (await stat(file.videoPath).catch(() => null)))
          : Boolean(file.transferDir && (await stat(file.transferDir).catch(() => null)))
      out.push({
        roomId: rec.id,
        name: rec.name,
        role: rec.role,
        fileName: file.fileName ?? rec.name,
        fileSize: file.fileSize ?? 0,
        lastActiveAt: file.updatedAt,
        progress: file.role === 'host' ? 1 : (file.progress ?? 0),
        resumable,
        // being finished (the startup run, or a Finish saving): the window says so instead of offering buttons
        ...(saving ? { export: dir && this.exportingDirs.has(dir) ? { ...saving, running: true } : saving } : {}),
      })
    }
    return out.sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  }

  private async deleteData(infoHash: string): Promise<void> {
    if (this.current instanceof ViewerSession) throw new CodedError('busy', 'Leave the room first')
    for (const rec of await this.deps.store.list()) {
      const file = await readSessionFile(this.deps.paths.userData, rec.id)
      if (file?.infoHash !== infoHash || !file.transferDir || !isPartialDir(file.transferDir)) continue
      // the segments of a save a quit cut off are half of that video: Finish saving needs them (Cancel saving first)
      if (await this.savingIn(transferDirOf(file))) throw new CodedError('busy', SAVE_PENDING)
      await rm(file.transferDir, { recursive: true, force: true })
      await this.deps.store.remove(rec.id)
    }
  }

  /**
   * A 'save' leave that ended without a file: one stopped part-way stays pending in its journal, for Finish saving in
   * Recent rooms or the next start.
   */
  private async saveFailed(roomId: string): Promise<CodedError> {
    const dir = await this.transferDirOfRoom(roomId)
    const saving = dir && (await exportPending(dir)) ? await exportEntry(dir) : null
    if (!saving) return new CodedError('save-failed', 'Saving the file failed; see the log')
    return new CodedError(
      'save-failed',
      saving.waiting
        ? `Saving stopped: ${saving.dest} is not there any more. Connect it, then choose Finish saving in Recent rooms.`
        : 'Saving stopped before it was done; see the log. Choose Finish saving in Recent rooms, or it goes on the next time Cinemesh starts.',
    )
  }
}

/**
 * 'leaving' keeps the room and file the window shows (`shown`); whatever it was joining or failing at is over. `leave`
 * says what runs, so a window reloaded meanwhile (and main's quit prompt) can tell a long save from the rest.
 */
function leavingEvent(s: Session, shown: SessionEvent | undefined, leave: LeaveKind): SessionEvent {
  return {
    phase: 'leaving',
    role: s.role,
    roomId: s.roomId,
    fileName: shown?.fileName ?? null,
    fileSize: shown?.fileSize ?? null,
    durationS: shown?.durationS ?? null,
    ...(shown?.media ? { media: shown.media } : {}),
    leave,
  }
}

/** A viewer room's transfer folder, resolved: only `<folder>/.wt-partial/<infoHash>` ever holds an export of ours. */
function transferDirOf(file: SessionFileData): string | null {
  return file.role === 'viewer' && file.transferDir && isPartialDir(file.transferDir) ? resolve(file.transferDir) : null
}

/**
 * RecentRoom.export for a transfer folder holding an export journal. One that cannot be read still counts (its
 * Finish saving gives it up); `waiting`: the folder it saves into is not there now.
 */
async function exportEntry(dir: string): Promise<NonNullable<RecentRoom['export']>> {
  const p = await pendingExport(dir).catch(() => null)
  const dest = p?.dest ?? null
  return { name: p?.name ?? 'the video', dest: dest ?? '', waiting: dest !== null && p?.away === true }
}

/** resumeExport found the folder it saves into not there (save-file.ts): nothing changed, it stays pending. */
function isDestAway(e: unknown): boolean {
  return e instanceof CodedError && e.code === 'dest-unavailable'
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function writable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true })
    const probe = join(dir, `.wt-write-test-${randomBytes(4).toString('hex')}`)
    await writeFile(probe, '')
    await unlink(probe)
    return true
  } catch {
    return false
  }
}
