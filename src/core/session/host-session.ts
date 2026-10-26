import { stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { PlaylistEvent, PrepareEvent, SyncMode } from '../../shared/ipc/core.js'
import { MAX_PLAYLIST_ITEMS } from '../../shared/media-files.js'
import { FASTSTART_REMUX, needsFullDownload } from '../../shared/media/media-map.js'
import type { PeerWarning } from '../../shared/peer-warnings.js'
import { CodedError } from '../../shared/result.js'
import { Blobs, MemoryBlobProvider } from '../net/blobs.js'
import type { RoomRecord } from '../net/identity.js'
import { Room, type RoomState } from '../net/room.js'
import { type CarryChoice, captureChoice, planCarry } from '../player/track-carry.js'
import type { GroupSnapshot } from '../sync/group.js'
import type { PeerTransferStats, TransferStats } from '../transfer/engine.js'
import { HostUplink } from '../transfer/uplink.js'
import type { Settings } from '../../shared/settings.js'
import { BaseSession, type SessionDeps } from './base-session.js'
import { catchUpRange, pickCatchUp } from './catch-up.js'
import { PLAYHEAD_REASONS, announceName, netLog } from './common.js'
import { HostSlot } from './host-slot.js'
import { MAX_SUBS_PER_ITEM, siblingSubtitles } from './playlist-files.js'
import { PLAYLIST_NAME, type PlaylistBody, checkPlaylistSize, newItemId } from './playlist-wire.js'
import { type PlaylistEntry, type SessionFileData, SessionFile, sessionFilePath } from './session-file.js'
import { collectTransferLinks } from './striping.js'
import { MediaPortAdapter, TransferPortAdapter } from './sync-ports.js'
import { encodeCoverage } from './timeline.js'

export { type AnnounceBody, groupCriticalRanges } from './host-slot.js'

export interface HostInput {
  videoPath: string
  subtitlePaths: string[]
  /** further videos for the playlist, in order (each takes the subtitles next to it that share its name) */
  more?: string[]
  resume?: { record: RoomRecord; file: SessionFileData | null }
}

/**
 * A resumed group starts this far past the seq in session.json, so its restore outranks any state viewers
 * kept: the file can miss the last publishes (a crash between a publish and its write). The group publishes
 * a few states a second at most. session.playlist's rev resumes the same way.
 */
export const RESUME_SEQ_GAP = 1000

const PLAYHEAD_TICK_MS = 1000
/** the 1 Hz ticks keep the plan within a second of a playing room: further than this, the room jumped */
const PLAN_JUMP_S = 2
/** transfer stats (1 Hz) of a steady paced rate the feasibility line needs before it goes by that rate */
export const PACED_WINDOW = 10
/** the countdown from an item's end to the next item (ADR 0011 §5) */
export const ADVANCE_MS = 5000
/** hash workers for items prepared while the room plays: the disk also serves the current item */
const BACKGROUND_HASH_WORKERS = 1
/** an item seeded for viewers fetching it ahead stops once none asked for it this long */
export const BACKGROUND_IDLE_MS = 60_000

/**
 * The host's upload for the feasibility line (plan §4.5 "Host uplink saturated", as ADR 0006 §6.3 amends it). Once
 * the upload pacer has held the uplink's queue down for 10 s (`uplink.state` 'steady' in every stats event: the
 * uplink, not the app's limit, is the bottleneck), the best paced rate of those 10 s: what the uplink carries without
 * queueing. Else the peak measured upload. So the line warns when the paced rate stays below what the room needs,
 * which the host can act on (fewer viewers, a lower bitrate, a better uplink); the pacer itself replaced the plan's
 * suggestion of an upload limit at 85 % of the peak.
 */
export function uploadCapacityBps(steadyRates: readonly number[], peakUpBps: number): number | null {
  if (steadyRates.length >= PACED_WINDOW) return Math.max(...steadyRates.slice(-PACED_WINDOW))
  return peakUpBps || null
}

/**
 * Hosting (plan §4.2 "Host prepare", §5.2 "How a viewer's session starts"): the room and invite exist at
 * once; indexing and hashing run in the background; then the manifest and torrent are served as blobs,
 * session.announce goes out, seeding starts, and the host's own mpv joins sync like any member.
 *
 * The room plays a playlist (ADR 0011): one item at a time, each prepared into a torrent of its own. The first item
 * (or the one a resume left off at) opens the room; the rest are prepared in the background, in order. Switching
 * items keeps the room, the player and the members, and runs a new sync epoch for the next item.
 */
export class HostSession extends BaseSession {
  readonly role = 'host' as const
  private readonly abort = new AbortController()
  private readonly provider = new MemoryBlobProvider()
  /** one pacer and bucket for every item seeded (ADR 0011 §5) */
  private readonly uplink = new HostUplink()
  private readonly blobs: Blobs
  private readonly slots: HostSlot[] = []
  private current: HostSlot | null = null
  /** the sync epoch the current item runs */
  private epoch = 0
  private rev: number
  private autoAdvance: boolean
  /** the countdown to the next item, while the current one has ended */
  private advance: { nextId: string; at: number; timer: ReturnType<typeof setTimeout> } | null = null
  /** the host stopped the countdown: no other until the room leaves 'ended' */
  private advanceHeld = false
  /** the room ended while the next item still prepares: its countdown starts once it is ready */
  private waitingNext = false
  private lastMode: SyncMode | null = null
  private switching: Promise<void> = Promise.resolve()
  /** items a switch is on its way to: not removable meanwhile */
  private readonly switchTargets = new Set<HostSlot>()
  private queueRunning = false
  /** viewers the current item's transfer feeds first (catch-up.ts, ADR 0012), and the item it told */
  private catchUp: ReadonlySet<string> = new Set()
  private catchUpSlot: HostSlot | null = null
  /** catch-up priority on (ADR 0012); integration tests turn it off for a baseline */
  catchUpEnabled = true
  private lastStallAt: number | null = null
  private peakUpBps = 0
  /** the paced rate of each stats event since the pacer last went steady (at most PACED_WINDOW of them) */
  private steadyRates: number[] = []
  private ready = false
  /** the final prepare event, re-sent once a second in the room with a fresh feasibility */
  private readyEvent: PrepareEvent | null = null
  private lastPlaylistEmit = 0

  private constructor(
    deps: SessionDeps,
    room: Room,
    private readonly input: HostInput,
    items: HostSlot[],
    file: SessionFile,
  ) {
    super(deps, room)
    this.file = file
    this.slots.push(...items)
    this.blobs = new Blobs(room, this.provider)
    const f = input.resume?.file
    this.rev = f?.playlistRev !== undefined ? f.playlistRev + RESUME_SEQ_GAP : 0
    this.autoAdvance = f?.autoAdvance ?? deps.settings().hostDefaults.autoAdvance
    this.uplink.setLimit(deps.settings().uploadLimitKBps)
  }

  /**
   * Returns once session.json is on disk: the manager marks the room active right after, and a crash with the
   * marker but no session.json could not resume the room (its invite would be dead).
   */
  static async start(deps: SessionDeps, input: HostInput): Promise<HostSession> {
    const { videoPath, subtitlePaths } = input
    const size = (
      await stat(videoPath).catch(() => {
        throw new CodedError('file-missing', 'The video file cannot be read')
      })
    ).size
    const items = await HostSession.itemsFor(deps, input)
    for (const i of items) if (i.videoPath === videoPath) i.size = size
    const s = deps.settings()
    const opts = {
      displayName: s.displayName,
      settings: s,
      store: deps.store,
      admission: s.hostDefaults.admission,
      maxMembers: s.hostDefaults.maxMembers,
      appVersion: deps.appVersion,
      log: netLog(deps.log),
    }
    const room = input.resume
      ? await Room.resume(input.resume.record, opts)
      : await Room.create({ ...opts, name: basename(videoPath).slice(0, 64) })
    try {
      room.defineMessage(announceName('preparing'), { hostOnly: true })
      room.defineMessage(announceName('unavailable'), { hostOnly: true, sticky: true })
      const roomId = room.state().roomId
      const resumed = input.resume?.file
      const file = new SessionFile(sessionFilePath(deps.paths.userData, roomId), {
        v: 1,
        role: 'host',
        roomId,
        fileName: basename(videoPath),
        fileSize: size,
        durationS: null,
        infoHash: null,
        videoPath,
        subtitlePaths,
        playlist: items.map((i) => entryOf(i)),
        ...(resumed?.currentItemId ? { currentItemId: resumed.currentItemId } : {}),
        ...(resumed?.playlistRev !== undefined ? { playlistRev: resumed.playlistRev } : {}),
        ...(resumed?.autoAdvance !== undefined ? { autoAdvance: resumed.autoAdvance } : {}),
        updatedAt: Date.now(),
        ...(resumed?.group ? { group: resumed.group } : {}),
      })
      // on disk before the marker, and before indexing or hashing (minutes for a big file) can crash
      await file.flush()
      const session = new HostSession(deps, room, input, items, file)
      session.begin()
      return session
    } catch (e) {
      await room.close().catch(() => undefined)
      throw e
    }
  }

  /** The playlist to open with: a resumed room's, else the video and the further ones asked for. */
  private static async itemsFor(deps: SessionDeps, input: HostInput): Promise<HostSlot[]> {
    const saved = input.resume?.file?.playlist?.filter((e) => e.videoPath)
    if (saved && saved.length > 0) {
      return saved
        .slice(0, MAX_PLAYLIST_ITEMS)
        .map(
          (e) =>
            new HostSlot({ id: e.id, videoPath: e.videoPath ?? '', subtitlePaths: e.subtitlePaths ?? [] }, deps.log),
        )
    }
    const ids = new Set<string>()
    const id = (): string => {
      let v = newItemId()
      while (ids.has(v)) v = newItemId()
      ids.add(v)
      return v
    }
    const items = [new HostSlot({ id: id(), videoPath: input.videoPath, subtitlePaths: input.subtitlePaths }, deps.log)]
    const seen = new Set([itemKey(input.videoPath, input.subtitlePaths)])
    for (const p of (input.more ?? []).slice(0, MAX_PLAYLIST_ITEMS - 1)) {
      const subs = await siblingSubtitles(p)
      const key = itemKey(p, subs)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(new HostSlot({ id: id(), videoPath: p, subtitlePaths: subs }, deps.log))
    }
    return items
  }

  /** The item the room opens with: the one a resume left off at, else the first. */
  private openingSlot(): HostSlot {
    const want = this.input.resume?.file?.currentItemId
    const first = this.slots[0]
    if (!first) throw new Error('no items')
    return this.slots.find((s) => s.id === want) ?? first
  }

  private begin(): void {
    const first = this.openingSlot()
    this.setSession({ phase: 'preparing', role: 'host', fileName: first.name, fileSize: first.size || null })
    void this.open(first).catch((e: unknown) => {
      if (this.abort.signal.aborted || this.isStopped()) return
      this.deps.log.error('hosting failed', e)
      const message = e instanceof Error ? e.message : String(e)
      this.setSession({ phase: 'error', error: { code: e instanceof CodedError ? e.code : 'host-failed', message } })
    })
  }

  /** After every await in open(): a leave or cancel meanwhile means stand down (begin() stays quiet). */
  private assertLive(): void {
    if (this.isStopped() || this.abort.signal.aborted) throw new CodedError('cancelled', 'Hosting was cancelled')
  }

  private cacheRoot(): string {
    return join(this.deps.paths.userData, 'wt', 'host-cache')
  }

  /** The first item: prepared in front of HostPrepare, then the room opens on it; the rest follow. */
  private async open(first: HostSlot): Promise<void> {
    const settings = this.deps.settings()
    await first.prepare({
      cacheRoot: this.cacheRoot(),
      workers: settings.hashWorkers,
      provider: this.provider,
      cb: {
        onProgress: (p, t0) => {
          const secs = (performance.now() - t0) / 1000
          const bytesPerSec = secs > 0 ? p.bytesDone / secs : 0
          // the index (avgBytesPerSec) is known once hashing runs, so HostPrepare can show the feasibility line
          this.deps.emit('prepare', {
            ...p,
            bytesPerSec,
            ...(p.stage === 'hashing' ? { feasibility: this.feasibility() } : {}),
          })
          this.publishPreparing(p.stage, p.bytesTotal ? p.bytesDone / p.bytesTotal : 0)
        },
        onIndexed: (index) => {
          const fullDownload = needsFullDownload(index)
          this.setSession({
            fileSize: first.size,
            durationS: index.durationMs / 1000,
            media: { container: index.container, seekMode: index.seekMode, fullDownload, interleave: index.interleave },
          })
          if (fullDownload) this.fullDownloadNotice()
        },
      },
    })
    this.assertLive()
    this.unsubs.push(
      collectTransferLinks({
        room: this.room,
        // a report without an infoHash (an older viewer) is about the current item
        target: (infoHash) => {
          const slot = infoHash === undefined ? this.current : this.slots.find((s) => s.infoHash === infoHash)
          if (!slot) return null
          if (slot !== this.current) this.wanted(slot)
          return slot.linkTarget()
        },
        all: () => this.slots.flatMap((s) => s.linkTarget() ?? []),
        log: this.deps.log,
      }),
    )
    const group = this.input.resume?.file?.group
    await this.activate(first, { play: false, carry: null, ...(group ? { group } : {}) })
    this.assertLive()
    // The group plan follows the room (plan §4.3 "Playhead adapter"): the host member's seeks and loads move it,
    // and L1 slides at 1 Hz while the room plays. A room further than PLAN_JUMP_S from the plan moved without
    // the host member (its mpv closed, missing or restarting): that is a seek, which also moves the hot window.
    this.every(PLAYHEAD_TICK_MS, () => {
      const engine = this.sync
      const playhead = this.current?.playhead
      const pos = engine?.roomPosition() ?? null
      const plan = playhead?.last
      if (!engine || pos === null || !plan) return
      if (Math.abs(pos - plan.posS) > PLAN_JUMP_S) playhead.set(pos, 'seek')
      else if (engine.syncEvent()?.mode === 'playing') playhead.set(pos, 'tick')
    })
    this.ready = true
    this.setSession({ phase: 'in-room' })
    const layout = first.prepared?.layout
    this.readyEvent = {
      stage: 'ready',
      bytesDone: layout?.length ?? 0,
      bytesTotal: layout?.length ?? 0,
      bytesPerSec: 0,
      cached: first.prepared?.cached ?? false,
    }
    this.deps.emit('prepare', { ...this.readyEvent, feasibility: this.feasibility() })
    this.pump()
  }

  private fullDownloadNotice(): void {
    this.notice({
      level: 'warn',
      code: 'media.full-download',
      message:
        'Viewers can only start once they have downloaded the whole file: it has no index to stream from. ' +
        `To make it stream, remux it: ${FASTSTART_REMUX}`,
    })
  }

  // ---- the prepare queue ----------------------------------------------------------------------

  /** Prepares the next queued item in playlist order, one at a time, while the room plays. */
  private pump(): void {
    if (this.queueRunning || !this.ready || this.isStopped()) return
    const next = this.slots.find((s) => s.state === 'queued')
    if (!next) return
    this.queueRunning = true
    void this.prepareInBackground(next)
      .catch((e: unknown) => {
        if (this.isStopped() || (e instanceof CodedError && e.code === 'cancelled')) return
        this.deps.log.warn(`preparing ${next.name} failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        this.queueRunning = false
        if (this.isStopped()) return
        this.publishPlaylist()
        this.emitPlaylist(true)
        this.pump()
      })
  }

  private async prepareInBackground(slot: HostSlot): Promise<void> {
    this.emitPlaylist(true)
    await slot.prepare({
      cacheRoot: this.cacheRoot(),
      workers: BACKGROUND_HASH_WORKERS,
      provider: this.provider,
      cb: { onProgress: () => this.emitPlaylist(false), onIndexed: () => this.emitPlaylist(true) },
    })
    if (this.isStopped()) return
    // the same video (and subtitles) under another path: its bt lane would collide with the other's
    const twin = this.slots.find((s) => s !== slot && s.infoHash !== null && s.infoHash === slot.infoHash)
    if (twin) {
      slot.state = 'error'
      slot.error = `The same video as “${twin.name}”`
      return
    }
    this.persistPlaylist()
    if (this.waitingNext && this.nextSlot() === slot && this.lastMode === 'ended') {
      this.waitingNext = false
      this.startCountdown(slot)
    }
  }

  // ---- switching items ------------------------------------------------------------------------

  /**
   * Makes `slot` the current item: it seeds first (the old item keeps playing meanwhile), then the old item's
   * engine stops, the room hears the playlist (with the new epoch) and the announce, and a new engine loads the
   * item with the carried tracks. `group`: a resume's snapshot of this item.
   */
  private async activate(
    slot: HostSlot,
    opts: { play: boolean; carry: CarryChoice | null; group?: GroupSnapshot },
  ): Promise<void> {
    const settings = this.deps.settings()
    const prev = this.current
    // seeding already for viewers fetching it ahead: from now on it is the one playing
    slot.setTier(0)
    await slot.seed({
      room: this.room,
      uploadLimitKBps: settings.uploadLimitKBps,
      uplink: this.uplink,
      tier: 0,
      startPosS: opts.group?.lastAnchor.posS ?? 0,
      log: this.deps.log,
      notice: (n) => {
        if (slot === this.current) this.notice(n)
        else this.deps.log.warn(n.message)
      },
      unavailable: () => this.sourceGone(slot),
      onStats: (st) => {
        if (slot === this.current) this.onUplinkStats(st)
      },
    })
    this.assertLive()
    // startHost awaits before it creates its client: a limit changed meanwhile had nothing to reach
    slot.setUploadLimit(this.deps.settings().uploadLimitKBps)

    const snap = this.sync?.snapshot() ?? null
    this.clearAdvance()
    this.advanceHeld = false
    this.waitingNext = false
    this.lastMode = null
    if (this.sync) {
      this.stopSync()
      void this.player?.setPaused(true).catch(() => undefined)
    }
    this.current = slot
    if (prev && prev !== slot) await this.retire(prev)
    this.assertLive()

    const index = slot.index
    this.setSession({
      fileName: slot.name,
      fileSize: slot.size,
      durationS: slot.durationS,
      ...(index
        ? {
            media: {
              container: index.container,
              seekMode: index.seekMode,
              fullDownload: slot.fullDownload,
              interleave: index.interleave,
            },
          }
        : {}),
    })
    if (prev && slot.fullDownload) this.fullDownloadNotice()
    this.epoch = opts.group?.syncEpoch ?? BaseSession.randomEpoch()
    this.file?.update(
      {
        fileName: slot.name,
        fileSize: slot.size,
        durationS: slot.durationS,
        infoHash: slot.infoHash,
        videoPath: slot.videoPath,
        subtitlePaths: slot.subtitlePaths,
        currentItemId: slot.id,
        playlist: this.slots.map((s) => entryOf(s)),
      },
      { now: true },
    )
    // the playlist (naming the new epoch) goes out before the announce and before the engine's first state
    this.publishPlaylist()
    if (slot.announce) this.room.publish(announceName('announce'), slot.announce)

    if (!this.player) this.createPlayer({ title: slot.name, subtitles: () => this.current?.subtitles ?? [] })
    const carry = opts.carry && slot.manifest ? planCarry(opts.carry, slot.manifest.tracks, slot.carrySubs()) : null
    const map = slot.map
    const manifest = slot.manifest
    const durationS = slot.durationS ?? 0
    if (!map || !manifest) throw new Error('prepare first')
    this.assertLive()
    const full = encodeCoverage([[0, durationS]], durationS)
    const hd = settings.hostDefaults
    const group = opts.group
    const engine = this.startSync({
      subtitles: () => slot.subtitles,
      media: new MediaPortAdapter({
        map,
        manifest,
        states: () => slot.allVerified,
        fileOpened: () => true, // the host plays its local file
        lastStallAtMs: () => this.lastStallAt,
        // nothing to download: the host member's seeks are the room's, which striping follows
        setPlayhead: (posS, reason) => slot.playhead?.set(posS, PLAYHEAD_REASONS[reason]),
        onChange: () => () => undefined,
        positionS: () => this.sync?.roomPosition() ?? 0,
      }),
      transfer: new TransferPortAdapter({
        rateBps: () => Number.MAX_SAFE_INTEGER,
        etaToEofS: () => 0,
        coverage: () => full,
        diskFull: () => false,
      }),
      host: {
        syncEpoch: this.epoch,
        perms: group?.perms ?? snap?.perms ?? { othersPlayPause: hd.othersControl, othersSeek: hd.othersControl },
        waitForAll: group?.waitForAll ?? snap?.waitForAll ?? hd.waitForAll,
        startMode: group?.startMode ?? snap?.startMode ?? hd.startMode,
        ...(group ? { resume: { ...group, seq: group.seq + RESUME_SEQ_GAP } } : {}),
      },
      carry: () => carry,
      durationS,
    })
    engine.on('persist', (s: GroupSnapshot) => this.persist(s))
    engine.on('sync', (e) => {
      if (e.wait?.reason === 'buffering') this.lastStallAt = performance.now()
      if (this.sync === engine) this.onMode(e.mode)
    })
    // a file that plays only once complete: the room's first play does not wait for whole downloads
    engine.mediaReady(durationS, { fullDownload: slot.fullDownload })
    engine.setSource(slot.videoPath)
    if (opts.play) {
      // once the host's own member holds the new item's first state: before that an intent is not-ready
      const play = (e: { mode: SyncMode }): void => {
        if (e.mode === 'idle') return
        engine.off('sync', play)
        if (this.sync === engine) void engine.intent({ kind: 'play' })
      }
      engine.on('sync', play)
    }
    this.emitPlaylist(true)
  }

  /**
   * The item that was playing: viewers still fetching it get it on tier 1 (Settings: Share other playlist videos),
   * until none asks for it for BACKGROUND_IDLE_MS; else it stops seeding.
   */
  private async retire(slot: HostSlot): Promise<void> {
    if (this.deps.settings().playlistBackgroundUpload) {
      slot.setTier(1)
      slot.wantedAt = performance.now()
      return
    }
    await slot.stopSeeding()
  }

  /**
   * A viewer reported a lane or a blocked read for an item that is not playing: it fetches it ahead. Seeded on tier 1
   * if the setting allows (the first report starts it; the next ones reach it).
   */
  private wanted(slot: HostSlot): void {
    slot.wantedAt = performance.now()
    if (slot.isSeeding || !slot.ready || this.isStopped() || !this.ready) return
    if (!this.deps.settings().playlistBackgroundUpload) return
    void slot
      .seed({
        room: this.room,
        uploadLimitKBps: this.deps.settings().uploadLimitKBps,
        uplink: this.uplink,
        tier: 1,
        startPosS: 0,
        log: this.deps.log,
        notice: (n) => this.deps.log.warn(`${slot.name}: ${n.message}`),
        unavailable: () => this.sourceGone(slot),
      })
      .then(() => {
        if (this.isStopped() || slot === this.current) return
        slot.setUploadLimit(this.deps.settings().uploadLimitKBps)
        this.deps.log.info(`seeding ${slot.name} for viewers fetching it ahead`)
      })
      .catch((e: unknown) => {
        if (!(e instanceof CodedError && e.code === 'cancelled')) {
          this.deps.log.warn(`could not seed ${slot.name} ahead: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
  }

  /** 1 Hz: items seeded ahead that nobody asked for lately stop; all of them when the setting is off. */
  private sweepBackground(): void {
    const on = this.deps.settings().playlistBackgroundUpload
    const now = performance.now()
    for (const s of this.slots) {
      if (s === this.current || !s.inBackground) continue
      if (!on || now - s.wantedAt > BACKGROUND_IDLE_MS) void s.stopSeeding()
    }
  }

  override updateSettings(s: Settings): void {
    super.updateSettings(s)
    this.sweepBackground()
  }

  /** Serialized: a second switch waits for the first. */
  private switchTo(slot: HostSlot, play: boolean): Promise<void> {
    this.switchTargets.add(slot)
    const run = this.switching.then(async () => {
      if (this.isStopped()) return
      if (!this.ready) throw new CodedError('not-ready', 'The room is still opening')
      if (slot === this.current) return
      if (!this.slots.includes(slot)) throw new CodedError('not-found', 'That item is no longer in the playlist')
      if (!slot.ready) throw new CodedError('not-ready', `${slot.name} is still being prepared`)
      const choice = this.player ? captureChoice(this.player.tracks()) : null
      await this.activate(slot, { play, carry: choice })
    })
    this.switching = run.catch(() => undefined)
    void this.switching.then(() => this.switchTargets.delete(slot))
    return run
  }

  private sourceGone(slot: HostSlot): void {
    if (slot !== this.current) {
      // a past item: not served any more, and not playable again without preparing it anew
      slot.state = 'error'
      slot.error = 'The video file changed on disk'
      void slot.stopSeeding()
      this.publishPlaylist()
      this.emitPlaylist(true)
      return
    }
    try {
      this.room.publish(announceName('unavailable'), { reason: 'source-changed', infoHash: slot.infoHash })
    } catch (e) {
      this.deps.log.warn(`could not tell viewers the file is gone: ${String(e)}`)
    }
  }

  // ---- auto-advance ---------------------------------------------------------------------------

  private onMode(mode: SyncMode): void {
    const was = this.lastMode
    this.lastMode = mode
    if (mode === was) return
    if (mode === 'ended') {
      this.onEnded()
    } else if (was === 'ended') {
      // a seek or a play moved the room off the end: no countdown, and Cancel is forgotten
      const had = this.advance !== null || this.waitingNext
      this.clearAdvance()
      this.advanceHeld = false
      this.waitingNext = false
      if (had) {
        this.publishPlaylist()
        this.emitPlaylist(true)
      }
    }
  }

  private onEnded(): void {
    if (!this.autoAdvance || this.advanceHeld) return
    const next = this.nextSlot()
    if (!next) return
    if (!next.ready) {
      this.waitingNext = true
      return
    }
    this.startCountdown(next)
  }

  private startCountdown(next: HostSlot): void {
    this.clearAdvance()
    const timer = setTimeout(() => {
      this.advance = null
      this.switchTo(next, true).catch((e: unknown) => this.switchFailed(e))
    }, ADVANCE_MS)
    timer.unref()
    this.advance = { nextId: next.id, at: Date.now() + ADVANCE_MS, timer }
    this.publishPlaylist()
    this.emitPlaylist(true)
    this.player?.osc('toast', { text: `Next: ${next.name} in ${String(ADVANCE_MS / 1000)} s` })
  }

  private clearAdvance(): void {
    if (this.advance) clearTimeout(this.advance.timer)
    this.advance = null
  }

  private switchFailed(e: unknown): void {
    if (this.isStopped()) return
    this.deps.log.error('switching playlist items failed', e)
    const message = e instanceof Error ? e.message : String(e)
    this.notice({
      level: 'error',
      code: 'playlist.switch-failed',
      message: `Could not start the next video: ${message}`,
    })
  }

  /** The playable item after the current one (failed items are skipped). */
  private nextSlot(): HostSlot | null {
    const i = this.current ? this.slots.indexOf(this.current) : -1
    return this.slots.slice(i + 1).find((s) => s.state !== 'error') ?? null
  }

  // ---- the playlist (requests) ----------------------------------------------------------------

  /** playlist.add: appends in the order given; returns how many were added (duplicates are skipped). */
  async add(videoPaths: readonly string[]): Promise<number> {
    const ids = new Set(this.slots.map((s) => s.id))
    const keys = new Set(this.slots.map((s) => itemKey(s.videoPath, s.subtitlePaths)))
    const added: HostSlot[] = []
    for (const p of videoPaths) {
      const st = await stat(p).catch(() => null)
      if (!st?.isFile()) throw new CodedError('file-missing', `${basename(p)} cannot be read`)
      const subs = (await siblingSubtitles(p)).slice(0, MAX_SUBS_PER_ITEM)
      const key = itemKey(p, subs)
      if (keys.has(key)) continue
      keys.add(key)
      let id = newItemId()
      while (ids.has(id)) id = newItemId()
      ids.add(id)
      added.push(new HostSlot({ id, videoPath: p, subtitlePaths: subs }, this.deps.log))
    }
    this.assertLive()
    if (added.length === 0) throw new CodedError('duplicate', 'Those videos are already in the playlist')
    // what the list takes once every item is prepared, so a later publish cannot fail
    checkPlaylistSize(this.body([...this.slots, ...added], { worstCase: true }))
    this.slots.push(...added)
    this.persistPlaylist()
    this.publishPlaylist()
    this.emitPlaylist(true)
    this.pump()
    return added.length
  }

  async remove(id: string): Promise<void> {
    const slot = this.slot(id)
    if (slot === this.current) throw new CodedError('current', 'The video that is playing cannot be removed')
    if (this.switchTargets.has(slot) || (!this.ready && slot === this.openingSlot())) {
      throw new CodedError('current', 'That video is about to play: it cannot be removed now')
    }
    this.slots.splice(this.slots.indexOf(slot), 1)
    if (this.advance?.nextId === id) this.clearAdvance()
    await slot.destroy()
    this.persistPlaylist()
    this.publishPlaylist()
    this.emitPlaylist(true)
    // the next item may have changed: an ended room counts down to the new one
    if (this.lastMode === 'ended' && !this.advance && !this.advanceHeld) this.onEnded()
  }

  move(id: string, toIndex: number): void {
    const slot = this.slot(id)
    const from = this.slots.indexOf(slot)
    this.slots.splice(from, 1)
    this.slots.splice(Math.max(0, Math.min(this.slots.length, toIndex)), 0, slot)
    this.persistPlaylist()
    if (this.advance && this.nextSlot()?.id !== this.advance.nextId) {
      this.clearAdvance()
      if (!this.advanceHeld) this.onEnded()
    }
    this.publishPlaylist()
    this.emitPlaylist(true)
  }

  async play(id: string): Promise<void> {
    return this.switchTo(this.slot(id), true)
  }

  /** Next and Previous go to the nearest item that can play now; one still preparing is skipped. */
  async next(): Promise<void> {
    const i = this.current ? this.slots.indexOf(this.current) : -1
    const s = this.slots.slice(i + 1).find((x) => x.ready)
    if (!s) throw new CodedError('no-item', 'No later video in the playlist can play yet')
    return this.switchTo(s, true)
  }

  async prev(): Promise<void> {
    const i = this.current ? this.slots.indexOf(this.current) : 0
    const s = this.slots
      .slice(0, Math.max(0, i))
      .reverse()
      .find((x) => x.ready)
    if (!s) throw new CodedError('no-item', 'No earlier video in the playlist can play')
    return this.switchTo(s, true)
  }

  protected override stepFromOsc(kind: 'next' | 'prev'): void {
    void (kind === 'next' ? this.next() : this.prev()).catch((e: unknown) => {
      const text = e instanceof Error ? e.message : String(e)
      this.player?.osc('toast', { text })
    })
  }

  setAutoAdvance(on: boolean): void {
    this.autoAdvance = on
    this.file?.update({ autoAdvance: on })
    if (!on) {
      this.clearAdvance()
      this.waitingNext = false
    } else if (this.lastMode === 'ended' && !this.advance) {
      this.advanceHeld = false
      this.onEnded()
    }
    this.publishPlaylist()
    this.emitPlaylist(true)
  }

  cancelAdvance(): void {
    this.clearAdvance()
    this.waitingNext = false
    this.advanceHeld = true
    this.publishPlaylist()
    this.emitPlaylist(true)
  }

  private slot(id: string): HostSlot {
    const s = this.slots.find((x) => x.id === id)
    if (!s) throw new CodedError('not-found', 'That item is no longer in the playlist')
    return s
  }

  // ---- publishing -----------------------------------------------------------------------------

  private body(slots: readonly HostSlot[], opts: { worstCase?: boolean } = {}): PlaylistBody {
    const cur = this.current
    return {
      v: 1,
      rev: this.rev,
      current: cur ? { id: cur.id, syncEpoch: this.epoch } : null,
      autoAdvance: this.autoAdvance,
      ...(this.advance
        ? { advance: { nextId: this.advance.nextId, inMs: Math.max(0, this.advance.at - Date.now()) } }
        : {}),
      items: slots.map((s) => (opts.worstCase ? worstCaseBody(s) : s.body())),
    }
  }

  /** session.playlist, once the room is open on an item. */
  private publishPlaylist(): void {
    if (!this.current || this.isStopped()) return
    this.rev = (this.rev + 1) % 0xffff_ffff
    const body = this.body(this.slots)
    try {
      checkPlaylistSize(body)
      this.room.publish(PLAYLIST_NAME, body)
    } catch (e) {
      this.deps.log.warn(`could not publish the playlist: ${e instanceof Error ? e.message : String(e)}`)
    }
    this.file?.update({ playlistRev: this.rev })
  }

  private persistPlaylist(): void {
    this.file?.update({ playlist: this.slots.map((s) => entryOf(s)) })
  }

  /** The renderer's playlist event: at once for a change, at most once a second for progress. */
  private emitPlaylist(force: boolean): void {
    const now = performance.now()
    if (!force && now - this.lastPlaylistEmit < 1000) return
    this.lastPlaylistEmit = now
    const ev: PlaylistEvent = {
      rev: this.rev,
      currentId: this.current?.id ?? null,
      autoAdvance: this.autoAdvance,
      advance: this.advance ? { nextId: this.advance.nextId, at: this.advance.at } : null,
      items: this.slots.map((s) => ({
        id: s.id,
        name: s.name,
        fileSize: s.size,
        durationS: s.durationS,
        current: s === this.current,
        host: { state: s.state, pct: s.pct, ...(s.error ? { error: s.error } : {}) },
      })),
    }
    this.deps.emit('playlist', ev)
  }

  /** A publish (a new seq) is written at once; the position updates every 5 s while playing keep the debounce. */
  private persist(snap: GroupSnapshot): void {
    const file = this.file
    if (file) file.update({ group: snap }, { now: snap.seq !== file.current.group?.seq })
  }

  private lastPreparingAt = 0
  private publishPreparing(stage: string, pct: number): void {
    const now = performance.now()
    if (now - this.lastPreparingAt < 1000) return
    this.lastPreparingAt = now
    try {
      this.room.publish(announceName('preparing'), { stage, pct })
    } catch {
      // no members yet is fine
    }
  }

  private onUplinkStats(st: TransferStats): void {
    this.peakUpBps = Math.max(this.peakUpBps, st.upBps)
    const uplink = st.uplink
    if (uplink?.state === 'steady' && uplink.rateBps !== null)
      this.steadyRates = [...this.steadyRates, uplink.rateBps].slice(-PACED_WINDOW)
    else this.steadyRates = []
  }

  protected override onPeersTick(): void {
    this.sweepBackground()
    this.updateCatchUp()
    const slot = this.current
    if (slot?.timeline) {
      const coverage = this.syncPeers()
        .filter((p) => p.id !== this.room.self)
        .map((p) => p.coverage)
      const t = slot.timeline.forHost(coverage, BaseSession.bufferedOf(this.player))
      this.deps.emit('timeline', t.event)
      this.player?.osc('ranges', t.osc)
      const st = slot.lastStats
      this.deps.emit('transfer', {
        downBps: 0,
        upBps: st?.upBps ?? 0,
        progress: 1,
        missingAheadBytes: 0,
        etaToEofS: 0,
        ...(st?.dupFactor !== undefined ? { dupFactor: st.dupFactor } : {}),
        ...(st?.uplink ? { uplink: st.uplink } : {}),
        diskLow: false,
      })
    }
    // the Room's host panel keeps the feasibility line current (live viewer count, measured upload)
    if (this.readyEvent) this.deps.emit('prepare', { ...this.readyEvent, feasibility: this.feasibility() })
    if (this.slots.some((s) => s.state === 'indexing' || s.state === 'hashing')) this.emitPlaylist(false)
  }

  /**
   * "Group needs ~X from you": the worst case, one copy of the stream per viewer (viewers that cannot reach each
   * other each take theirs from the host; striping brings linked viewers near one copy in all). Only viewers who
   * are here count (a resumed room lists everyone it ever admitted). The upload: uploadCapacityBps.
   */
  private feasibility(): { needBps: number; uploadBps: number | null } {
    const viewers = this.room.members().filter((m) => !m.self && (m.linked || m.path === 'via-peer')).length
    const slot = this.current ?? this.openingSlot()
    return {
      needBps: (slot.index?.avgBytesPerSec ?? 0) * Math.max(1, viewers),
      uploadBps: uploadCapacityBps(this.steadyRates, this.peakUpBps),
    }
  }

  protected override applyUploadLimit(kbps: number | null): void {
    this.uplink.setLimit(kbps)
    for (const s of this.slots) s.setUploadLimit(kbps)
  }

  /**
   * Catch-up priority (ADR 0012), once a second: the viewers whose buffer runs short while others have plenty are fed
   * first by the playing item's transfer, from their position over the next HORIZON_S. Another item playing ends it
   * on the old one.
   */
  private updateCatchUp(): void {
    const slot = this.current
    const old = this.catchUpSlot
    if (old && old !== slot) for (const id of this.catchUp) old.transfer?.setViewerCatchUp(id, null)
    if (old !== slot) this.catchUp = new Set()
    this.catchUpSlot = slot
    const transfer = slot?.transfer ?? null
    const map = slot?.map ?? null
    if (!slot || !transfer || !map) return
    const peers = this.syncPeers().filter((p) => p.id !== this.room.self)
    const next = this.catchUpEnabled ? pickCatchUp(peers, this.catchUp, slot.durationS) : new Set<string>()
    for (const id of this.catchUp) {
      if (next.has(id)) continue
      transfer.setViewerCatchUp(id, null)
      this.deps.log.info(`catch-up: ${id.slice(0, 8)} done`)
    }
    for (const p of peers) {
      if (!next.has(p.id) || p.posS === null || p.posS === undefined) continue
      if (!this.catchUp.has(p.id))
        this.deps.log.info(`catch-up: ${p.id.slice(0, 8)} has ${(p.bufferedAheadS ?? 0).toFixed(1)} s ahead: fed first`)
      transfer.setViewerCatchUp(p.id, catchUpRange(map, p.posS))
    }
    this.catchUp = next
  }

  protected override transferPeers(): readonly PeerTransferStats[] {
    return this.current?.lastStats?.peers ?? []
  }

  protected override peerWarnings(): ReadonlyMap<string, readonly PeerWarning[]> {
    return this.current?.hashFails.warnings() ?? new Map()
  }

  protected override keepAwake(): boolean {
    return !this.stopped
  }

  protected override onRoomClosed(s: RoomState): void {
    if (this.isStopped()) return // our own leave/end, not the room going away under us
    if (s.phase === 'ended') this.setSession({ phase: 'ended' })
  }

  protected override onPlayerReplaced(): void {
    if (this.ready && this.current) this.sync?.setSource(this.current.videoPath)
  }

  isPreparing(): boolean {
    return !this.ready
  }

  async cancelPrepare(): Promise<void> {
    this.abort.abort(new CodedError('cancelled', 'Hosting was cancelled'))
    await this.leave({ end: true })
  }

  private leaving: Promise<void> | null = null

  /** Idempotent; the first call's options win. */
  leave(opts: { end?: boolean }): Promise<void> {
    this.leaving ??= this.doLeave(opts)
    return this.leaving
  }

  private async doLeave(opts: { end?: boolean }): Promise<void> {
    this.stopping = true
    this.abort.abort(new CodedError('cancelled', 'left the room'))
    this.clearAdvance()
    for (const s of this.slots) s.cancel()
    await this.room.leave({ end: opts.end ?? false }).catch(() => undefined)
    this.blobs.destroy()
    await Promise.all(this.slots.map((s) => s.destroy().catch(() => undefined)))
    this.uplink.destroy()
    // a leave must always finish, or the manager keeps a dead session as the current one
    await this.teardown().catch((e: unknown) => this.deps.log.error('stopping the session failed', e))
    if (opts.end) await this.deps.store.remove(this.roomId).catch(() => undefined)
  }
}

/** Two items are the same video when the same files make them (the same torrent would collide on a bt lane). */
function itemKey(videoPath: string, subtitlePaths: readonly string[]): string {
  return JSON.stringify([resolve(videoPath), ...subtitlePaths.map((p) => resolve(p))])
}

function entryOf(s: HostSlot): PlaylistEntry {
  return {
    id: s.id,
    name: s.name,
    fileSize: s.size,
    videoPath: s.videoPath,
    subtitlePaths: s.subtitlePaths,
    infoHash: s.infoHash,
  }
}

/** An item as session.playlist will list it once prepared, with the longest values: the size check before an add. */
function worstCaseBody(s: HostSlot): PlaylistBody['items'][number] {
  const b = s.body()
  return {
    ...b,
    durationMs: 99_999_999_999,
    fileSize: Math.max(b.fileSize, 99_999_999_999_999),
    prepared: true,
    infoHash: 'f'.repeat(40),
    torrent: { hash: 'f'.repeat(64), size: 64 * 1024 * 1024 },
    manifest: { hash: 'f'.repeat(64), size: 4 * 1024 * 1024 },
  }
}
