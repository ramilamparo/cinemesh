import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { NoticeEvent, PlaylistEvent, PlaylistItemView, SessionPhase } from '../../shared/ipc/core.js'
import { CodedError } from '../../shared/result.js'
import { Blobs, MemoryBlobProvider } from '../net/blobs.js'
import type { RoomRecord } from '../net/identity.js'
import { Room, type RoomState } from '../net/room.js'
import { type CarryChoice, captureChoice, planCarry } from '../player/track-carry.js'
import type { OffsetEstimator } from '../sync/clock.js'
import { type SpaceCheck, checkSpace, freeBytes } from '../transfer/disk.js'
import { exportPending } from '../transfer/save-file.js'
import { type Announce, AnnounceSchema, MAX_MANIFEST_BYTES, announceError } from './announce.js'
import { BaseSession, type SessionDeps } from './base-session.js'
import { announceName, netLog } from './common.js'
import { MAX_CRITICAL_SPANS, cachedManifest, criticalSpans, crossCheck } from './media-checks.js'
import { PLAYLIST_NAME, type PlaylistBody, type PlaylistItemBody, PlaylistSchema } from './playlist-wire.js'
import { type PlaylistEntry, type SessionFileData, SessionFile, sessionFilePath } from './session-file.js'
import { isPartialDir } from './sweep.js'
import { SAVE_PENDING_THERE, type SlotEvents, ViewerSlot } from './viewer-slot.js'
import type { Settings } from '../../shared/settings.js'
import type { PeerTransferStats } from '../transfer/engine.js'

export {
  AnnounceSchema,
  MAX_CRITICAL_SPANS,
  MAX_MANIFEST_BYTES,
  announceError,
  cachedManifest,
  criticalSpans,
  crossCheck,
}

const PreparingSchema = z.object({ stage: z.string().max(32), pct: z.number().min(0).max(1) })
/** `infoHash` (added): the item whose file changed; absent from an older host, whose only video it was */
const UnavailableSchema = z.object({ infoHash: z.string().nullable().optional() }).loose()

const VIDEO_CHANGED: NoticeEvent = {
  level: 'warn',
  code: 'session.changed',
  message: 'The host started a different video. Leave and join again to watch it.',
}

/** Info: the renderer shows it as a toast (and SessionEvent.media for good); the OSC gets it on oscReady. */
const FULL_DOWNLOAD: NoticeEvent = {
  level: 'info',
  code: 'session.full-download',
  message: 'This video plays once it is fully downloaded: its format cannot be streamed.',
}

export type ViewerInput = { invite: string } | { resume: { record: RoomRecord; file: SessionFileData | null } }

const TICK_MS = 1000
/** a switch whose item could not be fetched tries again after this */
const SWITCH_RETRY_MS = 5000
/** items played earlier that stay open to share with others (Settings: Share other playlist videos) */
const MAX_KEPT_OPEN = 2
/** an item shared besides the one playing gets at least this much of an upload limit, KiB/s */
const MIN_SHARE_KBPS = 16

/** What a viewer follows: the host's current playlist item, or (an older host) its one announced video. */
interface Target {
  id: string | null
  announce: Announce
}

/**
 * Joining (plan §5.2 "How a viewer's session starts"): admitted → sticky session.announce → torrent and
 * manifest by blob.get (BLAKE2b-verified) → JoinConfirm (folder, free space) → download into segments,
 * stream server, player, sync. Resuming skips the confirmation and reuses the journal.
 *
 * With a playlist (ADR 0011) the viewer follows session.playlist's current item instead: the first one goes
 * through JoinConfirm, later ones download into the same folder (if there is space) as the host moves on, each
 * with a sync engine of its own that applies only that item's epoch.
 */
export class ViewerSession extends BaseSession {
  readonly role = 'viewer' as const
  private readonly abort = new AbortController()
  private readonly provider = new MemoryBlobProvider()
  private readonly blobs: Blobs
  /** items by infoHash: the one playing, and any still open */
  private readonly slots = new Map<string, ViewerSlot>()
  private current: ViewerSlot | null = null
  /** the item a join in flight is about (it follows the host until the download starts) */
  private joinSlot: ViewerSlot | null = null
  private playlist: PlaylistBody | null = null
  /** the newest readable announce (all an older host sends) */
  private announced: Announce | null = null
  private joinStarted = false
  private joined = false
  private switching: Promise<void> = Promise.resolve()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** the current item could not start: its save folder lacks the space */
  private noSpace = false
  /** downloads started in this room, by infoHash: the session file lists them for a resume, the sweep and a leave */
  private readonly entries = new Map<string, PlaylistEntry>()
  /** the item downloading ahead of the one playing (Settings: Download upcoming playlist videos) */
  private prefetch: ViewerSlot | null = null
  private prefetchStarting = false
  /** items that did not fit in the save folder ahead of time, or failed to start: not tried again in this room */
  private readonly noSpaceFor = new Set<string>()
  /** transfers being closed, by infoHash: a new start in the same folder waits for them */
  private readonly closing = new Map<string, Promise<void>>()
  /** the countdown to the next item, as wall-clock ms: fixed when the playlist arrives */
  private advanceAt: { nextId: string; at: number } | null = null
  /** items played earlier still open to share, oldest first */
  private readonly keptOpen: ViewerSlot[] = []
  private confirm: ((dir: string) => void) | null = null
  private confirmReject: ((e: Error) => void) | null = null
  /** the folder the user confirmed: JoinConfirm stays up while the download starts, and Join can be clicked again */
  private confirmedDir: string | null = null
  private saveDir: string | null = null
  private leaving: Promise<string | null> | null = null

  private constructor(
    deps: SessionDeps,
    room: Room,
    private readonly resumeFile: SessionFileData | null,
  ) {
    super(deps, room)
    this.blobs = new Blobs(room, this.provider)
    for (const e of resumeFile?.playlist ?? []) if (e.infoHash) this.entries.set(e.infoHash, e)
  }

  static async join(deps: SessionDeps, input: ViewerInput): Promise<ViewerSession> {
    const s = deps.settings()
    const opts = {
      displayName: s.displayName,
      settings: s,
      store: deps.store,
      appVersion: deps.appVersion,
      log: netLog(deps.log),
    }
    const room = 'invite' in input ? await Room.join(input.invite, opts) : await Room.resume(input.resume.record, opts)
    room.defineMessage(announceName('preparing'), { hostOnly: true })
    room.defineMessage(announceName('unavailable'), { hostOnly: true, sticky: true })
    const session = new ViewerSession(deps, room, 'resume' in input ? input.resume.file : null)
    session.begin()
    return session
  }

  // ---- what the host says ---------------------------------------------------------------------

  private begin(): void {
    this.setSession({ phase: 'connecting', role: 'viewer' })
    this.unsubs.push(
      this.room.onMessage(announceName('preparing'), (m) => {
        const p = PreparingSchema.safeParse(m.body)
        if (p.success && !this.target() && !this.unreadableAnnounce) {
          this.deps.emit('prepare', {
            stage: 'hashing',
            bytesDone: Math.round(p.data.pct * 1000),
            bytesTotal: 1000,
            bytesPerSec: 0,
            cached: false,
          })
        }
      }),
      this.room.onMessage(PLAYLIST_NAME, (m) => this.onPlaylist(m.body)),
      this.room.onMessage(announceName('announce'), (m) => this.onAnnounce(m.body)),
      this.room.onMessage(announceName('unavailable'), (m) => this.onHostFileGone(m.body)),
    )
    // the playlist first: it names the epoch of the item the announce is about
    const list = this.room.latest(PLAYLIST_NAME)
    if (list) this.onPlaylist(list.body)
    const latest = this.room.latest(announceName('announce'))
    if (latest) this.onAnnounce(latest.body)
    this.checkHostFile()
  }

  private hostFileGone = false
  /** the first announce failed AnnounceSchema: the join failed on it */
  private unreadableAnnounce = false

  private checkHostFile(): void {
    const gone = this.room.latest(announceName('unavailable'))
    if (gone) this.onHostFileGone(gone.body)
  }

  private onHostFileGone(raw: unknown): void {
    if (this.hostFileGone || this.isStopped()) return
    // about another item than the one playing: nothing this viewer streams changed
    const about = UnavailableSchema.safeParse(raw).data?.infoHash
    if (about && about !== (this.current ?? this.joinSlot)?.infoHash) return
    this.hostFileGone = true
    this.notice({
      level: 'warn',
      code: 'session.host-file-gone',
      // a video that plays only once complete has nothing that plays yet
      message: this.current?.holdingSource()
        ? "The host's video file changed, so the host stopped sharing it. This video plays only once fully downloaded, and only other viewers can send the rest now."
        : "The host's video file changed, so the host stopped sharing it. What you already have still plays.",
    })
  }

  protected override onRoomState(s: RoomState): void {
    super.onRoomState(s)
    // Only the waiting screens follow the room. The room re-emits its state all the time (host presence,
    // relay, room.state), and confirm-join, in-room or an error (a failed join too) must survive that.
    if (this.isStopped() || this.joined || this.joinSlot?.started) return
    if (this.phase !== 'connecting' && this.phase !== 'pending-admission') return
    // Admitted but nothing to confirm yet (the host may still be preparing): back to 'connecting', where
    // the join screen shows the host's prepare progress.
    const map: Partial<Record<RoomState['phase'], SessionPhase>> = {
      joining: 'connecting',
      pending: 'pending-admission',
      'in-room': 'connecting',
    }
    const next = map[s.phase]
    if (next && this.phase !== next) this.setSession({ phase: next })
  }

  private onPlaylist(raw: unknown): void {
    if (this.joinCancelled()) return
    const parsed = PlaylistSchema.safeParse(raw)
    if (!parsed.success) {
      // a newer host's playlist: its announce still names the item playing
      this.deps.log.debug(`unreadable playlist: ${parsed.error.issues[0]?.message ?? '?'}`)
      return
    }
    const p = parsed.data
    if (this.playlist && p.rev === this.playlist.rev && p.current?.id === this.playlist.current?.id) return
    this.playlist = p
    this.advanceAt = p.advance ? { nextId: p.advance.nextId, at: Date.now() + p.advance.inMs } : null
    this.dropRemoved(p)
    this.emitPlaylist()
    this.onTargetChanged()
    this.pumpPrefetch()
  }

  /** Items the host took off the playlist: their transfers stop, and a partial download goes with them. */
  private dropRemoved(p: PlaylistBody): void {
    const listed = new Set(p.items.flatMap((i) => (i.infoHash ? [i.infoHash] : [])))
    for (const slot of [...this.slots.values()]) {
      if (slot === this.current || slot === this.joinSlot || listed.has(slot.infoHash)) continue
      if (this.prefetch === slot) this.prefetch = null
      void this.close(slot, slot.downloaded ? 'keep' : 'delete')
    }
  }

  private onAnnounce(raw: unknown): void {
    // leaving, or the room closed: whoever stopped us has set the phase
    if (this.joinCancelled()) return
    const parsed = AnnounceSchema.safeParse(raw)
    // the join is about the first announce, readable or not: a later one can only be another video
    if (this.unreadableAnnounce) {
      if (parsed.success) this.notice(VIDEO_CHANGED)
      return
    }
    if (!parsed.success) {
      if (this.announced || this.playlist) return // a re-announce we cannot read changes nothing we have
      // without this the join would wait on 'Connecting…' forever
      this.unreadableAnnounce = true
      const err = announceError(raw, parsed.error.issues)
      this.deps.log.warn(`unreadable announce: ${err.message}`)
      this.setSession({ phase: 'error', error: { code: err.code, message: err.message } })
      return
    }
    const a = parsed.data
    const before = this.announced
    this.announced = a
    // a host with a playlist says which item plays in session.playlist (with its epoch); the announce follows it
    if (this.playlist) return
    if (before && before.infoHash !== a.infoHash) {
      this.notice(VIDEO_CHANGED)
      return
    }
    this.onTargetChanged()
  }

  /** The playlist's current item, else the announced video (an older host). */
  private target(): Target | null {
    const p = this.playlist
    if (p?.current) {
      const item = p.items.find((i) => i.id === p.current?.id)
      const a = item ? announceOf(item) : null
      if (item && a) return { id: item.id, announce: a }
    }
    return this.announced ? { id: null, announce: this.announced } : null
  }

  /**
   * The epoch the engine of `slot` applies: the playlist's, while that is still the item playing; none once the
   * host moved on (that engine is about to stop); any without a playlist.
   */
  private epochFor(slot: ViewerSlot): number | null {
    const p = this.playlist
    if (!p) return null
    const item = p.current ? p.items.find((i) => i.id === p.current?.id) : undefined
    return p.current && item?.infoHash === slot.infoHash ? p.current.syncEpoch : -1
  }

  private onTargetChanged(): void {
    if (this.joinCancelled()) return
    const t = this.target()
    if (!t) return
    if (!this.joinStarted) {
      this.joinStarted = true
      void this.join()
      return
    }
    if (!this.joined) {
      // still joining: JoinConfirm follows the host to its new item
      if (this.joinSlot?.infoHash !== t.announce.infoHash && this.phase === 'confirm-join') void this.retarget()
      return
    }
    if (this.current?.infoHash !== t.announce.infoHash) this.queueSwitch()
  }

  private slotFor(t: Target): ViewerSlot {
    const have = this.slots.get(t.announce.infoHash)
    if (have) return have
    const slot = new ViewerSlot(t.id, t.announce, this.deps.log)
    this.slots.set(t.announce.infoHash, slot)
    return slot
  }

  // ---- joining (the first item) ---------------------------------------------------------------

  private async join(): Promise<void> {
    try {
      let slot = await this.loadTarget()
      const dir = await this.chooseDir(slot)
      this.assertLive()
      // the host may have moved on while we confirmed: the download is for the item playing now
      slot = await this.loadTarget()
      this.saveDir = dir
      await this.startItem(slot, { carry: null, first: true })
      this.joined = true
      this.setSession({ phase: 'in-room' })
      this.emitTimeline()
      if (slot.holdingSource()) this.notice(FULL_DOWNLOAD)
      // the playhead slides while playing: L1 follows the room position (plan §4.3 "Playhead adapter")
      this.every(TICK_MS, () => {
        const engine = this.sync
        const pos = engine?.roomPosition() ?? null
        if (engine?.syncEvent()?.mode === 'playing' && pos !== null) this.current?.playhead?.set(pos, 'tick')
      })
      // a switch asked for while the download started
      this.onTargetChanged()
    } catch (e) {
      // leaving, or the room closed under us: whoever stopped us has set the phase
      if (this.joinCancelled()) return
      // a torrent that died while joining is the cause, whatever the await it broke reported
      const err = this.joinSlot?.transferError ?? e
      this.deps.log.error('joining failed', err)
      const message = err instanceof Error ? err.message : String(err)
      this.setSession({
        phase: 'error',
        error: { code: err instanceof CodedError ? err.code : 'join-failed', message },
      })
    }
  }

  /** The current target's torrent and manifest, fetched and checked; again while the host moves on meanwhile. */
  private async loadTarget(): Promise<ViewerSlot> {
    for (;;) {
      const t = this.target()
      if (!t) throw new CodedError('join-failed', 'The host is not sharing a video')
      const slot = this.slotFor(t)
      this.joinSlot = slot
      const a = slot.announce
      this.setSession({ fileName: a.name, fileSize: a.fileSize, durationS: a.durationMs / 1000 })
      await slot.fetchMeta(this.blobs, this.provider, this.abort.signal, this.resumeFile?.saveDir)
      this.assertLive()
      if (this.target()?.announce.infoHash !== slot.infoHash) continue
      this.setMedia(slot)
      return slot
    }
  }

  private setMedia(slot: ViewerSlot): void {
    const m = slot.manifest
    if (!m) return
    this.setSession({
      media: {
        container: m.container,
        seekMode: m.seekMode,
        fullDownload: slot.fullDownload,
        interleave: m.interleave,
      },
    })
  }

  /** In JoinConfirm, the host switched items: the confirmation is for the new one. */
  private async retarget(): Promise<void> {
    try {
      const slot = await this.loadTarget()
      if (this.phase !== 'confirm-join') return
      await this.showConfirm(slot)
    } catch (e) {
      if (!this.joinCancelled()) this.deps.log.warn(`following the host's playlist while joining failed: ${String(e)}`)
    }
  }

  /** A leave or a closed room. A method, not the fields: TS would keep their narrowing across awaits. */
  private joinCancelled(): boolean {
    return this.isStopped() || this.abort.signal.aborted
  }

  /** Why a join in flight must stop: a leave, a closed room or a dead torrent; null to carry on. */
  private standDown(): Error | null {
    if (this.joinCancelled()) return new CodedError('cancelled', 'left the room')
    return this.joinSlot?.transferError ?? null
  }

  /** After every await on the join path. */
  private assertLive(): void {
    const e = this.standDown()
    if (e) throw e
  }

  /** JoinConfirm: wait for the user's folder (or reuse the one a resumed session saved into). */
  private async chooseDir(slot: ViewerSlot): Promise<string> {
    if (this.resumeFile?.saveDir) return this.resumeFile.saveDir
    await this.showConfirm(slot)
    return new Promise((resolve, reject) => {
      this.confirm = resolve
      this.confirmReject = reject
    })
  }

  private async showConfirm(slot: ViewerSlot): Promise<void> {
    const dir = this.deps.settings().downloadDir ?? this.deps.paths.downloadDir
    const free = await freeBytes(dir).catch(() => 0)
    const have = await slot.haveBytes(dir)
    this.assertLive()
    this.setSession({
      phase: 'confirm-join',
      joinInfo: {
        name: slot.name,
        size: slot.info?.length ?? slot.announce.fileSize,
        dir,
        freeBytes: free,
        haveBytes: have,
      },
    })
  }

  /** A method, not the field: TS would keep the narrowing from before the awaits in confirmJoin. */
  private pendingConfirm(): ((dir: string) => void) | null {
    return this.confirm
  }

  /** session.confirmJoin */
  async confirmJoin(dir: string): Promise<void> {
    if (this.alreadyConfirmed(dir)) return
    const slot = this.joinSlot
    const t = slot?.info
    if (!this.confirm || !slot || !t) throw new CodedError('not-confirming', 'nothing to confirm')
    let space: SpaceCheck
    let saving: boolean
    try {
      // said here, where another folder can still be chosen; startDownload refuses it for every way in
      saving = await exportPending(slot.dirIn(dir))
      space = await checkSpace(dir, await slot.neededBytes(dir))
    } catch (e) {
      if (this.confirmWithdrawn()) return
      throw e
    }
    // a leave or a closed room took the confirmation away meanwhile, or a second click confirmed first
    if (this.confirmWithdrawn() || this.alreadyConfirmed(dir)) return
    if (saving) throw new CodedError('busy', SAVE_PENDING_THERE)
    if (!space.ok) {
      throw new CodedError(
        'disk-space',
        `Needs ${gb(space.neededBytes)} GB; ${gb(space.freeBytes)} GB free there. Choose another folder.`,
      )
    }
    const accept = this.pendingConfirm()
    if (!accept) throw new CodedError('not-confirming', 'nothing to confirm')
    this.confirm = null
    this.confirmReject = null
    this.confirmedDir = dir
    accept(dir)
  }

  /**
   * JoinConfirm stays up while the download starts (seconds on a slow disk) and Join can be clicked again:
   * the same folder is the same join; another one is refused.
   */
  private alreadyConfirmed(dir: string): boolean {
    if (this.confirmedDir === null) return false
    if (resolve(dir) === resolve(this.confirmedDir)) return true
    throw new CodedError('busy', 'Already joining')
  }

  /** A leave or a closed room took the confirmation away; those tell the user themselves, so no error here. */
  private confirmWithdrawn(): boolean {
    return !this.pendingConfirm() && this.joinCancelled()
  }

  // ---- an item: download, player, sync --------------------------------------------------------

  /**
   * Makes `slot` the item playing: its download (the first one's space was checked at the confirmation; a later
   * one's is checked here, and an item that does not fit stays out, its member reporting disk-full), the stream
   * server, the session file, the player (once) and a sync engine for the item's epoch.
   */
  private async startItem(
    slot: ViewerSlot,
    opts: { carry: CarryChoice | null; first?: boolean; clockEstimator?: OffsetEstimator },
  ): Promise<void> {
    const saveDir = this.saveDir
    if (!saveDir) throw new Error('confirm first')
    this.current = slot
    this.joinSlot = slot
    this.noSpace = false
    const a = slot.announce
    this.setSession({ fileName: a.name, fileSize: a.fileSize, durationS: a.durationMs / 1000 })
    this.setMedia(slot)
    if (!slot.startRequested) {
      await this.closed(slot.infoHash)
      const space = opts.first ? null : await checkSpace(saveDir, await slot.neededBytes(saveDir))
      this.assertLive()
      if (space && !space.ok) {
        this.noSpace = true
        this.notice({
          level: 'error',
          code: 'playlist.no-space',
          message: `${a.name} needs ${gb(space.neededBytes)} GB; ${gb(space.freeBytes)} GB free in your save folder. Free some space, then the host can play it again.`,
        })
      } else {
        await slot.start({
          saveDir,
          room: this.room,
          settings: () => this.deps.settings(),
          events: this.slotEvents(slot),
          live: () => this.assertLive(),
        })
      }
    } else {
      // started ahead and maybe still starting: that start, not a second one
      await slot.start({
        saveDir,
        room: this.room,
        settings: () => this.deps.settings(),
        events: this.slotEvents(slot),
        live: () => this.assertLive(),
      })
      this.assertLive()
    }
    slot.setPeers('all')
    if (slot.started) {
      await slot.listen(() => this.assertLive())
      slot.report()
    }
    this.writeFile(slot, saveDir)
    if (opts.first) await this.file?.flush()
    this.assertLive()
    this.hostFileGone = false
    this.checkHostFile()

    if (!this.player) {
      const player = this.createPlayer({ title: a.name, subtitles: () => this.current?.subtitles() ?? [] })
      player.on('fileLoaded', () => {
        if (this.current) this.current.fileOpened = true
      })
      // mpv sits empty while the source is held, and its OSC drops toasts until it is up: say why once it
      // is (again after a restart or a Reopen)
      player.on('oscReady', () => {
        if (this.current?.holdingSource() && this.sync) player.osc('toast', { text: FULL_DOWNLOAD.message })
      })
    }
    const carry = opts.carry && slot.manifest ? planCarry(opts.carry, slot.manifest.tracks, slot.carrySubs()) : null
    const engine = this.startSync({
      subtitles: () => slot.subtitles(),
      media: slot.mediaPort({ positionS: () => this.sync?.roomPosition() ?? 0 }),
      transfer: slot.transferPort({
        settings: () => this.deps.settings(),
        noSpace: () => this.noSpace && this.current === slot,
      }),
      carry: () => carry,
      acceptEpoch: () => this.epochFor(slot),
      ...(opts.clockEstimator ? { clockEstimator: opts.clockEstimator } : {}),
      durationS: a.durationMs / 1000,
    })
    engine.on('sync', (e) => {
      if (e.wait?.reason === 'buffering') slot.lastStallAt = performance.now()
    })
    this.giveSource()
    this.emitPlaylist()
  }

  private slotEvents(slot: ViewerSlot): SlotEvents {
    return {
      pieces: () => {
        if (this.isStopped()) return // teardown already cleared 'timeline'
        if (slot === this.current) this.emitTimeline()
      },
      diskLow: (low) => {
        if (this.isStopped()) return
        this.notice(
          low
            ? { level: 'error', code: 'transfer.disk-low', message: 'The disk is almost full: downloading paused.' }
            : {
                level: 'info',
                code: 'transfer.disk-ok',
                message: 'Disk space is available again: downloading resumed.',
              },
        )
      },
      done: () => {
        if (this.isStopped()) return
        this.updateEntry(slot)
        this.persistEntries()
        this.emitPlaylist()
        // the next item in order may download now; a complete item ahead needs no striping reports
        queueMicrotask(() => this.pumpPrefetch())
        if (slot !== this.current) {
          slot.stopReporting()
          return
        }
        // a held stream goes to the player now, unless the room is over for us (nothing to follow)
        const release = slot.fullDownload && this.sync !== null
        this.notice({
          level: 'info',
          code: 'transfer.done',
          message: release ? 'The whole video is downloaded: it plays now.' : 'The whole video is downloaded.',
        })
        this.updatePower()
        if (release) this.giveSource()
      },
      error: (e) => {
        if (this.isStopped()) return
        this.updatePower()
        // in the room: tell the user; while joining, the join fails with it instead (assertLive)
        if (this.sync && slot === this.current) {
          this.notice({ level: 'error', code: 'transfer.failed', message: e.message })
        }
      },
    }
  }

  // ---- switching items ------------------------------------------------------------------------

  private queueSwitch(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.switching = this.switching.then(() => this.doSwitch()).catch((e: unknown) => this.switchFailed(e))
  }

  private switchFailed(e: unknown): void {
    if (this.joinCancelled()) return
    this.deps.log.error('switching to the next video failed', e)
    const message = e instanceof Error ? e.message : String(e)
    this.notice({
      level: 'error',
      code: 'playlist.switch-failed',
      message: `Could not start the next video: ${message}`,
    })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.current?.infoHash !== this.target()?.announce.infoHash) this.queueSwitch()
    }, SWITCH_RETRY_MS)
    this.retryTimer.unref()
  }

  private async doSwitch(): Promise<void> {
    if (this.joinCancelled() || !this.joined) return
    const t = this.target()
    if (!t || t.announce.infoHash === this.current?.infoHash) return
    const slot = this.slotFor(t)
    // fetched while the old item still plays (the host's next item starts with a start barrier anyway)
    await slot.fetchMeta(this.blobs, this.provider, this.abort.signal, this.saveDir ?? undefined)
    this.assertLive()
    if (this.target()?.announce.infoHash !== slot.infoHash) return // moved on again: the next switch handles it
    const choice = this.player ? captureChoice(this.player.tracks()) : null
    const clockEstimator = this.sync?.clockEstimator() ?? undefined
    this.stopSync()
    void this.player?.setPaused(true).catch(() => undefined)
    const old = this.current
    if (old && old !== slot) await this.retire(old)
    // an item fetched ahead (or kept open since) plays from what it has: nothing to download again
    if (this.prefetch === slot) this.prefetch = null
    const kept = this.keptOpen.indexOf(slot)
    if (kept >= 0) this.keptOpen.splice(kept, 1)
    try {
      await this.startItem(slot, { carry: choice, ...(clockEstimator ? { clockEstimator } : {}) })
    } catch (e) {
      // nothing plays: the retry (switchFailed) starts the item afresh
      this.current = null
      this.stopSync()
      if (!this.joinCancelled()) await this.close(slot, 'keep')
      throw e
    }
    this.emitTimeline()
    if (slot.holdingSource()) this.notice(FULL_DOWNLOAD)
    this.pumpPrefetch()
  }

  /**
   * The item that was playing. With Share other playlist videos on, it stays open for others still fetching it (the
   * last MAX_KEPT_OPEN of them); else its transfer stops. Its data stays either way (going back resumes it).
   */
  private async retire(slot: ViewerSlot): Promise<void> {
    this.updateEntry(slot)
    await slot.stopServing()
    if (this.deps.settings().playlistBackgroundUpload && slot.started && !slot.transferError) {
      this.keptOpen.push(slot)
      while (this.keptOpen.length > MAX_KEPT_OPEN) {
        const oldest = this.keptOpen.shift()
        if (oldest) await this.close(oldest, 'keep')
      }
      return
    }
    await this.close(slot, 'keep')
  }

  /** Ends an item's transfer that is not playing; its record stays in the session file. */
  private async close(slot: ViewerSlot, data: 'keep' | 'delete'): Promise<void> {
    this.updateEntry(slot)
    this.slots.delete(slot.infoHash)
    const k = this.keptOpen.indexOf(slot)
    if (k >= 0) this.keptOpen.splice(k, 1)
    if (data === 'delete') this.entries.delete(slot.infoHash)
    const done = slot
      .leave({ data })
      .then(
        () => undefined,
        (e: unknown) => this.deps.log.warn(`stopping ${slot.name}: ${String(e)}`),
      )
      .finally(() => {
        if (this.closing.get(slot.infoHash) === done) this.closing.delete(slot.infoHash)
      })
    this.closing.set(slot.infoHash, done)
    await done
    this.file?.update({ playlist: [...this.entries.values()] })
  }

  /** Once a transfer of this item being closed is done (a new one opens the same folder and journal). */
  private async closed(infoHash: string): Promise<void> {
    await this.closing.get(infoHash)
  }

  // ---- downloading ahead ----------------------------------------------------------------------

  /**
   * Strict playlist order (ADR 0011 §6): once the item playing is complete, the next item after it that is not, one
   * at a time; an item not prepared yet, or one that does not fit, stops the walk there. Settings: Download upcoming
   * playlist videos.
   */
  private nextToFetch(): Target | null {
    const p = this.playlist
    const cur = this.current
    if (!p || !cur?.downloaded || this.noSpace || !this.deps.settings().playlistBackgroundDownload) return null
    const at = p.items.findIndex((i) => i.infoHash === cur.infoHash)
    if (at < 0) return null
    for (const item of p.items.slice(at + 1)) {
      const a = announceOf(item)
      if (!a || this.noSpaceFor.has(a.infoHash)) return null
      if (this.isComplete(a.infoHash)) continue
      return { id: item.id, announce: a }
    }
    return null
  }

  private isComplete(infoHash: string): boolean {
    const slot = this.slots.get(infoHash)
    if (slot?.started) return slot.downloaded
    return (this.entries.get(infoHash)?.progress ?? 0) >= 1
  }

  private pumpPrefetch(): void {
    if (!this.joined || this.isStopped() || this.prefetchStarting) return
    const want = this.nextToFetch()
    const had = this.prefetch
    if (had && had.infoHash !== want?.announce.infoHash) {
      this.prefetch = null
      // not wanted ahead any more (the setting went off, or the host reordered): it stops, its data stays
      if (had !== this.current && !this.keptOpen.includes(had)) void this.close(had, 'keep')
    }
    if (!want || this.prefetch) return
    this.prefetchStarting = true
    void this.startPrefetch(want)
      .catch((e: unknown) => {
        if (this.joinCancelled()) return
        this.deps.log.warn(`downloading ${want.announce.name} ahead failed: ${String(e)}`)
        // not tried again ahead (it downloads when it plays); the walk stops there, as for one that does not fit
        this.noSpaceFor.add(want.announce.infoHash)
        const slot = this.slots.get(want.announce.infoHash)
        if (this.prefetch === slot) this.prefetch = null
        if (slot && slot !== this.current) void this.close(slot, 'keep')
      })
      .finally(() => {
        this.prefetchStarting = false
        this.emitPlaylist()
        this.pumpPrefetch()
      })
  }

  private async startPrefetch(t: Target): Promise<void> {
    const saveDir = this.saveDir
    if (!saveDir) return
    const live = (): void => {
      if (this.joinCancelled()) throw new CodedError('cancelled', 'left the room')
    }
    const slot = this.slotFor(t)
    await slot.fetchMeta(this.blobs, this.provider, this.abort.signal, saveDir)
    live()
    if (this.nextToFetch()?.announce.infoHash !== slot.infoHash) {
      if (!slot.started && slot !== this.current) this.slots.delete(slot.infoHash)
      return
    }
    const space = await checkSpace(saveDir, await slot.neededBytes(saveDir))
    live()
    if (!space.ok) {
      this.noSpaceFor.add(slot.infoHash)
      if (!slot.started) this.slots.delete(slot.infoHash)
      this.notice({
        level: 'info',
        code: 'playlist.no-space-ahead',
        message: `${slot.name} is not downloaded ahead: it needs ${gb(space.neededBytes)} GB and ${gb(space.freeBytes)} GB are free. It downloads when it plays, if there is space then.`,
      })
      return
    }
    this.prefetch = slot
    if (!slot.startRequested) {
      await this.closed(slot.infoHash)
      live()
      await slot.start({
        saveDir,
        room: this.room,
        settings: () => this.deps.settings(),
        events: this.slotEvents(slot),
        live,
        peers: this.deps.settings().playlistBackgroundUpload ? 'all' : 'host',
      })
      // from the start, in order: the next item's first minutes are what it needs first
      slot.playhead?.set(0, 'join')
    }
    this.updateEntry(slot)
    this.file?.update({ playlist: [...this.entries.values()] })
  }

  override updateSettings(s: Settings): void {
    super.updateSettings(s)
    const share = s.playlistBackgroundUpload
    this.prefetch?.setPeers(share ? 'all' : 'host')
    if (!share) for (const slot of [...this.keptOpen]) void this.close(slot, 'keep')
    this.pumpPrefetch()
  }

  /**
   * The upload limit holds for all of this viewer's uploads: the item playing gets it whole, the others share what
   * it leaves (each WebTorrent client throttles only itself). Every second.
   */
  private shareUpload(): void {
    const limit = this.deps.settings().uploadLimitKBps
    const cur = this.current
    const others = [...this.slots.values()].filter((s) => s !== cur && s.started)
    cur?.setUploadLimit(limit)
    if (others.length === 0) return
    if (limit === null) {
      for (const s of others) s.setUploadLimit(null)
      return
    }
    const used = (cur?.lastStats?.upBps ?? 0) / 1024
    const each = Math.max(MIN_SHARE_KBPS, Math.floor((limit - used) / others.length))
    for (const s of others) s.setUploadLimit(each)
  }

  // ---- the session file and the playlist view -------------------------------------------------

  private updateEntry(slot: ViewerSlot): void {
    const prev = this.entries.get(slot.infoHash)
    this.entries.set(slot.infoHash, {
      id: slot.id ?? prev?.id ?? slot.infoHash.slice(0, 12),
      name: slot.name,
      fileSize: slot.announce.fileSize,
      infoHash: slot.infoHash,
      ...(slot.transferFolder
        ? { transferDir: slot.transferFolder }
        : prev?.transferDir
          ? { transferDir: prev.transferDir }
          : {}),
      progress: slot.started ? slot.progress : (prev?.progress ?? 0),
    })
  }

  /** Every item's download as of now into session.json (a resume, the sweep and Recent rooms read it). */
  private persistEntries(): void {
    for (const slot of this.slots.values()) if (slot.started) this.updateEntry(slot)
    this.file?.update({ playlist: [...this.entries.values()] })
  }

  private writeFile(slot: ViewerSlot, saveDir: string): void {
    this.updateEntry(slot)
    const a = slot.announce
    const data: Partial<SessionFileData> = {
      fileName: a.name,
      fileSize: a.fileSize,
      durationS: a.durationMs / 1000,
      infoHash: slot.infoHash,
      saveDir,
      ...(slot.transferFolder ? { transferDir: slot.transferFolder } : {}),
      playlist: [...this.entries.values()],
      ...(slot.id ? { currentItemId: slot.id } : {}),
    }
    if (this.file) {
      this.file.update(data, { now: true })
      return
    }
    this.file = new SessionFile(sessionFilePath(this.deps.paths.userData, this.roomId), {
      v: 1,
      role: 'viewer',
      roomId: this.roomId,
      fileName: a.name,
      fileSize: a.fileSize,
      durationS: a.durationMs / 1000,
      infoHash: slot.infoHash,
      updatedAt: Date.now(),
      ...data,
    })
  }

  private emitPlaylist(): void {
    const p = this.playlist
    if (!p || this.isStopped()) return
    const ev: PlaylistEvent = {
      rev: p.rev,
      currentId: p.current?.id ?? null,
      autoAdvance: p.autoAdvance,
      advance: this.advanceAt,
      items: p.items.map((i) => this.itemView(i, i.id === p.current?.id)),
    }
    this.deps.emit('playlist', ev)
  }

  private itemView(i: PlaylistItemBody, current: boolean): PlaylistItemView {
    const slot = i.infoHash ? this.slots.get(i.infoHash) : undefined
    const kept = i.infoHash ? this.entries.get(i.infoHash) : undefined
    const progress = slot?.started ? slot.progress : (kept?.progress ?? 0)
    let state: NonNullable<PlaylistItemView['local']>['state'] = progress >= 1 ? 'complete' : 'none'
    if (slot?.transferError) state = 'error'
    else if (current && this.noSpace) state = 'no-space'
    else if (slot?.started && progress < 1 && (current || slot === this.prefetch)) state = 'downloading'
    else if (progress > 0 && progress < 1) state = 'waiting'
    return {
      id: i.id,
      name: i.name,
      fileSize: i.fileSize,
      durationS: i.durationMs === null ? null : i.durationMs / 1000,
      current,
      local: { state, progress, downBps: slot?.started ? (slot.lastStats?.downBps ?? 0) : 0 },
    }
  }

  private emitTimeline(): void {
    const slot = this.current
    if (!slot?.timeline) return
    const t = slot.timeline.forViewer(slot.states, BaseSession.bufferedOf(this.player))
    this.deps.emit('timeline', t.event)
    this.player?.osc('ranges', t.osc)
  }

  protected override onPeersTick(): void {
    this.emitPlaylist()
    this.shareUpload()
    const slot = this.current
    const st = slot?.lastStats
    if (!slot || !st) return
    this.deps.emit('transfer', {
      downBps: st.downBps,
      upBps: st.upBps,
      progress: st.progress,
      missingAheadBytes: st.missingAheadBytes,
      etaToEofS: st.etaToEofS,
      diskLow: st.diskLow,
    })
    this.updateEntry(slot)
    this.file?.update({ progress: st.progress, playlist: [...this.entries.values()] })
  }

  protected override transferPeers(): readonly PeerTransferStats[] {
    return this.current?.lastStats?.peers ?? []
  }

  protected override keepAwake(): boolean {
    const slot = this.current
    return !this.isStopped() && !!slot && !slot.transferError && slot.progress < 1
  }

  protected override applyUploadLimit(kbps: number | null): void {
    for (const s of this.slots.values()) s.setUploadLimit(kbps)
  }

  protected override applyDownloadLimit(kbps: number | null): void {
    for (const s of this.slots.values()) s.setDownloadLimit(kbps)
  }

  /** mpv's demuxer waits in a read of the video (file 0) for a piece: the player reloads instead of seeking. */
  protected override readerBlocked(): boolean {
    return this.current?.readerBlocked() ?? false
  }

  protected override onRoomClosed(s: RoomState): void {
    if (this.isStopped()) return // our own leave
    // a join still in flight (blob fetch, confirm, startDownload) stands down instead of reaching in-room
    this.abort.abort(new CodedError('cancelled', 'the room closed'))
    this.confirmReject?.(new CodedError('cancelled', 'the room closed'))
    this.confirm = null
    this.confirmReject = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.stopFollowing()
    for (const slot of this.slots.values()) slot.stopReporting()
    const reason =
      s.phase === 'ended'
        ? null
        : s.phase === 'kicked'
          ? { code: 'kicked', message: 'The host removed you from the room.' }
          : s.phase === 'denied'
            ? {
                code: s.denyReason ?? 'denied',
                message: s.denyReason === 'full' ? 'The room is full.' : 'The host did not let you in.',
              }
            : { code: s.error?.code ?? 'room-error', message: s.error?.message ?? 'Could not join the room.' }
    this.setSession({ phase: reason ? 'error' : 'ended', ...(reason ? { error: reason } : {}) })
  }

  /**
   * In the room, once it is over for us (ended, or we were removed): nobody sets the pace any more. Sync
   * would extrapolate the last anchor and later report the host gone on top of the closed card, so it
   * stops (play requests then say not-ready) and the player pauses where it is. The download stays.
   */
  private stopFollowing(): void {
    if (!this.sync) return
    const roomPos = this.sync.roomPosition()
    this.stopSync()
    const player = this.player
    void player?.setPaused(true).catch(() => undefined)
    // The member reported playback at 4 Hz and stopped with sync: its last report still says playing, and the
    // renderer would show Pause and run the cursor on. A player with nothing loaded stops where the room was.
    const pos = player?.prop('time-pos')
    const map = this.current?.map
    this.deps.emit('playback', {
      posS: Math.max(0, typeof pos === 'number' ? pos : (roomPos ?? 0)),
      durationS: map && map.durationMs > 0 ? map.durationMs / 1000 : null,
      paused: true,
      seeking: false,
      stalled: false,
      at: this.clock.now(),
    })
  }

  protected override onPlayerReplaced(): void {
    this.giveSource()
  }

  /** The stream to the player through sync, which loads it at the room position (also after a player swap). */
  private giveSource(): void {
    const slot = this.current
    const url = slot?.sourceUrl()
    if (!slot || !url || !this.sync || slot.holdingSource() || this.noSpace) return
    this.sync.setSource(url)
  }

  // what the tests look into: the item playing
  private get transfer(): ViewerSlot['transfer'] {
    return this.current?.transfer ?? this.joinSlot?.transfer ?? null
  }
  private get server(): ViewerSlot['server'] {
    return this.current?.server ?? null
  }
  private get manifest(): ViewerSlot['manifest'] {
    return (this.current ?? this.joinSlot)?.manifest ?? null
  }
  private get states(): Uint8Array {
    return this.current?.states ?? new Uint8Array(0)
  }

  get progress(): number {
    return this.current?.progress ?? 0
  }

  /** True once leave() has been called (the manager refuses a second, different leave meanwhile). */
  get isLeaving(): boolean {
    return this.leaving !== null
  }

  /** The transfer folder the download went into (resolved), once it started; a 'save' leave exports from it. */
  get transferDir(): string | null {
    return this.current?.transferFolder ?? null
  }

  /**
   * session.leave / transfer.saveFile: 'save' exports a complete download (consuming the segments).
   * Idempotent; the first call's options win. Resolves once everything is stopped, with the exported video
   * (null when there was none or the export failed), or rejects with CodedError 'incomplete' when segments
   * turned out missing: the session is stopped all the same, and the room stays resumable so a rejoin
   * downloads them again.
   *
   * With a playlist, the item playing gets the leave asked for. Other items still open are exported when complete
   * and kept otherwise ('save'), or treated alike ('keep', 'delete'); 'delete' also removes the folders of items
   * played earlier in the room.
   */
  leave(opts: { data: 'keep' | 'save' | 'delete'; saveDir?: string }): Promise<string | null> {
    this.leaving ??= this.doLeave(opts)
    return this.leaving
  }

  private async doLeave(opts: { data: 'keep' | 'save' | 'delete'; saveDir?: string }): Promise<string | null> {
    this.stopping = true
    this.abort.abort(new CodedError('cancelled', 'left the room'))
    this.confirmReject?.(new CodedError('cancelled', 'left the room'))
    this.confirm = null
    this.confirmReject = null
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.persistEntries()
    await this.room.leave().catch(() => undefined)
    this.blobs.destroy()
    // player, sync and timers stop before the (possibly long) export, and a failed step never keeps the
    // rest from stopping
    await this.teardown().catch((e: unknown) => this.deps.log.error('stopping the session failed', e))
    const saveDir = opts.saveDir ?? this.saveDir
    const current = this.current ?? this.joinSlot
    let video: string | null = null
    let incomplete = false
    const open = [...this.slots.values()]
    for (const slot of current && open.includes(current) ? [current, ...open.filter((s) => s !== current)] : open) {
      const mine = slot === current
      const data = opts.data === 'save' && !mine && !slot.downloaded ? 'keep' : opts.data
      try {
        const saved = await slot.leave({ data, ...(saveDir ? { saveDir } : {}) })
        if (mine) video = saved?.video ?? null
      } catch (e) {
        this.deps.log.error(`leaving the transfer of ${slot.name} failed`, e)
        // segments lost since the join (transfer's IncompleteDownloadError): nothing was consumed and their
        // pieces left the journal, so the room record stays for a rejoin to download them again
        if (mine && e instanceof CodedError && e.code === 'incomplete') incomplete = true
      }
    }
    if (opts.data === 'delete') await this.deleteEarlierItems()
    if (incomplete) {
      throw new CodedError(
        'incomplete',
        'Some downloaded data was missing. Rejoin the room to download it again, then save.',
      )
    }
    // nothing left to resume once the data is gone or exported
    if (opts.data === 'delete' || video) await this.deps.store.remove(this.roomId).catch(() => undefined)
    return video
  }

  /** Items played earlier in this room (or a resumed one) whose transfer was already closed: their folders. */
  private async deleteEarlierItems(): Promise<void> {
    const open = new Set([...this.slots.values()].map((s) => s.transferFolder).filter((d) => d !== null))
    for (const e of this.entries.values()) {
      const dir = e.transferDir
      if (!dir || open.has(resolve(dir)) || !isPartialDir(dir)) continue
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
        this.deps.log.warn(`could not delete ${dir}: ${String(err)}`),
      )
    }
  }
}

/** A prepared playlist item as the announce that names the same torrent and manifest. */
function announceOf(i: PlaylistItemBody): Announce | null {
  if (!i.prepared || !i.infoHash || !i.torrent || !i.manifest || i.durationMs === null) return null
  return {
    v: 1,
    infoHash: i.infoHash,
    torrent: i.torrent,
    manifest: i.manifest,
    name: i.name,
    fileSize: i.fileSize,
    durationMs: i.durationMs,
  }
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}
