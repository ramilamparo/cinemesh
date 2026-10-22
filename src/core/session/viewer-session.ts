import { lstat, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import type { NoticeEvent, SessionPhase } from '../../shared/ipc/core.js'
import { limitBps } from '../../shared/limits.js'
import { decodeManifest } from '../../shared/media/manifest.js'
import { MediaMap, needsFullDownload } from '../../shared/media/media-map.js'
import { type ByteRange, KEYFRAME_MIN_GAP_MS, type KeyPoint, type Manifest } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import { Playhead, type PlayheadReason as MediaPlayheadReason } from '../media/playhead.js'
import { StreamServer } from '../media/stream-server.js'
import { Blobs, MemoryBlobProvider, blobHash } from '../net/blobs.js'
import type { RoomRecord } from '../net/identity.js'
import { Room, type RoomPeer, type RoomState } from '../net/room.js'
import type { SubtitleSpec } from '../player/player-controller.js'
import type { PlayheadReason } from '../sync/ports.js'
import { type SpaceCheck, checkSpace, freeBytes } from '../transfer/disk.js'
import { MANIFEST_FILE, type PeerTransferStats, TransferEngine, type TransferStats } from '../transfer/engine.js'
import { trustedBytes } from '../transfer/resume.js'
import { exportPending } from '../transfer/save-file.js'
import { SEGMENT_BYTES } from '../transfer/segment-store.js'
import { BaseSession, type SessionDeps } from './base-session.js'
import { announceName, netLog } from './common.js'
import { type SessionFileData, SessionFile, sessionFilePath } from './session-file.js'
import { reportTransferLinks } from './striping.js'
import { Ewma, MediaPortAdapter, TransferPortAdapter } from './sync-ports.js'
import { Timeline } from './timeline.js'

/**
 * Decoding is linear in the manifest's size, so this caps it before anything else. Honest manifests are
 * tens of KB (a 3 h film with a 1 s GOP is about 100 KB); a 3 h all-intra file with 8 poorly interleaved
 * audio tracks and 64 tracks is 2.4 MB, and 4 MiB decodes in under 0.2 s.
 */
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

export const AnnounceSchema = z.object({
  v: z.literal(1),
  infoHash: z.string().regex(/^[0-9a-f]{40}$/),
  torrent: z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    size: z
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024),
  }),
  manifest: z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive().max(MAX_MANIFEST_BYTES),
  }),
  name: z.string().min(1).max(512),
  fileSize: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
})
type Announce = z.infer<typeof AnnounceSchema>

const PreparingSchema = z.object({ stage: z.string().max(32), pct: z.number().min(0).max(1) })

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

/**
 * Why an announce failed AnnounceSchema. A newer host (v > 1) may have changed any of it, so its version is
 * the answer; anything else is a host sending what no honest host sends (a manifest over MAX_MANIFEST_BYTES).
 */
export function announceError(raw: unknown, issues: readonly { path: readonly PropertyKey[] }[]): CodedError {
  const v = typeof raw === 'object' && raw !== null ? (raw as { v?: unknown }).v : undefined
  if (typeof v === 'number' && v > 1) {
    return new CodedError('update-required', 'The host uses a newer version of Cinemesh. Update the app to join.')
  }
  const what = issues[0]?.path.map(String).join('.') || 'announce'
  return new CodedError(
    'bad-session',
    `The host sent video details this app cannot read (${what}). Ask the host to host it again.`,
  )
}

/**
 * The manifest a previous session of this video kept in its transfer folder (plan §4.2 "Viewer storage"), when it is
 * the one announced: a regular file of that size and BLAKE2b hash, as Blobs.fetch would check it. Else null, and the
 * manifest is fetched.
 */
export async function cachedManifest(dir: string, want: { hash: string; size: number }): Promise<Uint8Array | null> {
  const path = join(dir, MANIFEST_FILE)
  const st = await lstat(path).catch(() => null)
  if (!st?.isFile() || st.size !== want.size) return null
  const data = await readFile(path).catch(() => null)
  return data && blobHash(data) === want.hash ? data : null
}

/** What the viewer trusts about the download: taken from the torrent itself (the infoHash commits to it). */
interface TorrentInfo {
  infoHash: string
  pieceLength: number
  pieceCount: number
  /** video plus external subtitles */
  length: number
}

// session.host accepts at most 16 subtitle files
const MAX_SUBS = 16
/** The scheduler re-selects every critical span on each replan; above this the narrowest gaps are bridged. */
export const MAX_CRITICAL_SPANS = 256
// What the host merely states, bounded before MediaMap or the scheduler is sized from it. An honest
// manifest has one audio index per audio track of a poorly interleaved MP4. Track lists are metadata the
// viewer does not use, and remuxes that keep every dub and subtitle come close to 64 tracks.
const MAX_AUDIO_INDEXES = 32
const MAX_TRACKS = 256
const MAX_KEY_POINTS = 500_000

export type ViewerInput = { invite: string } | { resume: { record: RoomRecord; file: SessionFileData | null } }

const PLAYHEAD_REASONS: Record<PlayheadReason, MediaPlayheadReason> = {
  seek: 'seek',
  catchup: 'catchup',
  rendezvous: 'join',
}

const TICK_MS = 1000
const BLOB_TIMEOUT_MS = 60_000
/** A folder where a save of this video that a quit, a crash or a missing drive cut off is still pending. */
const SAVE_PENDING_THERE =
  'This video is still being saved into that folder from last time. Choose another folder, or finish or cancel that save in Recent rooms first.'

/**
 * Joining (plan §5.2 "How a viewer's session starts"): admitted → sticky session.announce → torrent and
 * manifest by blob.get (BLAKE2b-verified) → JoinConfirm (folder, free space) → download into segments,
 * stream server, player, sync. Resuming skips the confirmation and reuses the journal.
 */
export class ViewerSession extends BaseSession {
  readonly role = 'viewer' as const
  private readonly abort = new AbortController()
  private transfer: TransferEngine | null = null
  private server: StreamServer | null = null
  private blobs: Blobs | null = null
  private announce: Announce | null = null
  private torrent: Buffer | null = null
  private manifest: Manifest | null = null
  /** the manifest as announced (hash-checked), kept in the transfer folder for a resume */
  private manifestBytes: Uint8Array | null = null
  private map: MediaMap | null = null
  private timeline: Timeline | null = null
  private playhead: Playhead | null = null
  private states: Uint8Array = new Uint8Array(0)
  private readonly mediaListeners = new Set<() => void>()
  private confirm: ((dir: string) => void) | null = null
  private fileOpened = false
  private lastStallAt: number | null = null
  private readonly rate = new Ewma(10)
  private lastStats: TransferStats | null = null
  private saveDir: string | null = null
  /** `<saveDir>/.wt-partial/<infoHash>`, resolved, once the download starts there */
  private transferFolder: string | null = null
  private info: TorrentInfo | null = null
  private confirmReject: ((e: Error) => void) | null = null
  /** the folder the user confirmed: JoinConfirm stays up while the download starts, and Join can be clicked again */
  private confirmedDir: string | null = null
  private leaving: Promise<string | null> | null = null
  /** WebTorrent destroys the torrent on any error it reports: the download is over for this session */
  private transferError: CodedError | null = null
  /** the video plays only once complete (needsFullDownload): see holdingSource */
  private fullDownload = false
  /** every piece verified (transfer 'done') */
  private downloaded = false
  /** stops the 1 Hz report of our bt lanes and blocked pieces to the host (reportTransferLinks) */
  private stopLinks: (() => void) | null = null

  private constructor(
    deps: SessionDeps,
    room: Room,
    private readonly resumeFile: SessionFileData | null,
  ) {
    super(deps, room)
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

  private begin(): void {
    this.setSession({ phase: 'connecting', role: 'viewer' })
    this.unsubs.push(
      this.room.onMessage(announceName('preparing'), (m) => {
        const p = PreparingSchema.safeParse(m.body)
        if (p.success && !this.announce && !this.unreadableAnnounce) {
          this.deps.emit('prepare', {
            stage: 'hashing',
            bytesDone: Math.round(p.data.pct * 1000),
            bytesTotal: 1000,
            bytesPerSec: 0,
            cached: false,
          })
        }
      }),
      this.room.onMessage(announceName('announce'), (m) => void this.onAnnounce(m.body)),
      this.room.onMessage(announceName('unavailable'), () => this.onHostFileGone()),
    )
    const latest = this.room.latest(announceName('announce'))
    if (latest) void this.onAnnounce(latest.body)
    if (this.room.latest(announceName('unavailable'))) this.onHostFileGone()
  }

  private hostFileGone = false
  /** the first announce failed AnnounceSchema: the join failed on it */
  private unreadableAnnounce = false

  private onHostFileGone(): void {
    if (this.hostFileGone || this.isStopped()) return
    this.hostFileGone = true
    this.notice({
      level: 'warn',
      code: 'session.host-file-gone',
      // a video that plays only once complete has nothing that plays yet
      message: this.holdingSource()
        ? "The host's video file changed, so the host stopped sharing it. This video plays only once fully downloaded, and only other viewers can send the rest now."
        : "The host's video file changed, so the host stopped sharing it. What you already have still plays.",
    })
  }

  protected override onRoomState(s: RoomState): void {
    super.onRoomState(s)
    // Only the waiting screens follow the room. The room re-emits its state all the time (host presence,
    // relay, room.state), and confirm-join, in-room or an error (a failed join too) must survive that.
    if (this.isStopped() || this.transfer) return
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

  private async onAnnounce(raw: unknown): Promise<void> {
    // leaving, or the room closed: whoever stopped us has set the phase
    if (this.joinCancelled()) return
    const parsed = AnnounceSchema.safeParse(raw)
    // the join is about the first announce, readable or not: a later one can only be another video
    if (this.unreadableAnnounce) {
      if (parsed.success) this.notice(VIDEO_CHANGED)
      return
    }
    if (!parsed.success) {
      if (this.announce) return // a re-announce we cannot read changes nothing we have
      // without this the join would wait on 'Connecting…' forever
      this.unreadableAnnounce = true
      const err = announceError(raw, parsed.error.issues)
      this.deps.log.warn(`unreadable announce: ${err.message}`)
      this.setSession({ phase: 'error', error: { code: err.code, message: err.message } })
      return
    }
    const a = parsed.data
    if (this.announce) {
      if (this.announce.infoHash !== a.infoHash) this.notice(VIDEO_CHANGED)
      return
    }
    this.announce = a
    this.setSession({ fileName: a.name, fileSize: a.fileSize, durationS: a.durationMs / 1000 })
    try {
      const provider = new MemoryBlobProvider()
      this.blobs = new Blobs(this.room, provider)
      const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(BLOB_TIMEOUT_MS)])
      // a resume knows its folder: the manifest kept there at the join, when it is still the announced one
      const saved = this.resumeFile?.saveDir
      const blobs = this.blobs
      const [torrent, manifestBytes] = await Promise.all([
        blobs.fetch(a.torrent.hash, { size: a.torrent.size, signal }),
        (saved ? cachedManifest(join(saved, '.wt-partial', a.infoHash), a.manifest) : Promise.resolve(null)).then(
          (kept) => kept ?? blobs.fetch(a.manifest.hash, { size: a.manifest.size, signal }),
        ),
      ])
      const parsedTorrent = await import('parse-torrent').then((m) => m.default(torrent))
      const manifest = decodeManifest(manifestBytes)
      this.assertLive()
      crossCheck(a, parsedTorrent, manifest)
      provider.add(torrent) // re-serve to other viewers
      provider.add(manifestBytes)
      this.torrent = torrent
      this.info = {
        infoHash: parsedTorrent.infoHash,
        pieceLength: parsedTorrent.pieceLength,
        pieceCount: parsedTorrent.pieces.length,
        length: parsedTorrent.length,
      }
      this.manifest = manifest
      this.manifestBytes = manifestBytes
      this.map = new MediaMap(manifest)
      this.timeline = new Timeline(this.map)
      this.fullDownload = needsFullDownload(manifest)
      this.setSession({
        media: {
          container: manifest.container,
          seekMode: manifest.seekMode,
          fullDownload: this.fullDownload,
          interleave: manifest.interleave,
        },
      })
      const dir = await this.chooseDir(a)
      this.assertLive()
      await this.startDownload(dir)
    } catch (e) {
      // leaving, or the room closed under us: whoever stopped us has set the phase
      if (this.joinCancelled()) return
      // a torrent that died while joining is the cause, whatever the await it broke reported
      const err = this.transferError ?? e
      this.deps.log.error('joining failed', err)
      const message = err instanceof Error ? err.message : String(err)
      this.setSession({
        phase: 'error',
        error: { code: err instanceof CodedError ? err.code : 'join-failed', message },
      })
    }
  }

  /** A leave or a closed room. A method, not the fields: TS would keep their narrowing across awaits. */
  private joinCancelled(): boolean {
    return this.isStopped() || this.abort.signal.aborted
  }

  /** Why a join in flight must stop: a leave, a closed room or a dead torrent; null to carry on. */
  private standDown(): Error | null {
    if (this.joinCancelled()) return new CodedError('cancelled', 'left the room')
    return this.transferError
  }

  /** After every await on the join path. */
  private assertLive(): void {
    const e = this.standDown()
    if (e) throw e
  }

  /** JoinConfirm: wait for the user's folder (or reuse the one a resumed session saved into). */
  private async chooseDir(a: Announce): Promise<string> {
    if (this.resumeFile?.saveDir) return this.resumeFile.saveDir
    const dir = this.deps.settings().downloadDir ?? this.deps.paths.downloadDir
    const free = await freeBytes(dir).catch(() => 0)
    const have = await this.haveBytes(dir)
    this.assertLive()
    this.setSession({
      phase: 'confirm-join',
      joinInfo: { name: a.name, size: this.info?.length ?? a.fileSize, dir, freeBytes: free, haveBytes: have },
    })
    return new Promise((resolve, reject) => {
      this.confirm = resolve
      this.confirmReject = reject
    })
  }

  /** A method, not the field: TS would keep the narrowing from before the awaits in confirmJoin. */
  private pendingConfirm(): ((dir: string) => void) | null {
    return this.confirm
  }

  /**
   * Bytes a previous session in this folder already holds: verified in its journal and still in a segment
   * file long enough for them. state.json alone is not proof: seg/ may have been deleted or cleaned since.
   */
  private async haveBytes(dir: string): Promise<number> {
    const t = this.info
    if (!t || t.pieceCount === 0) return 0
    return trustedBytes(join(dir, '.wt-partial', t.infoHash), t)
  }

  /** session.confirmJoin */
  async confirmJoin(dir: string): Promise<void> {
    if (this.alreadyConfirmed(dir)) return
    const t = this.info
    if (!this.confirm || !t) throw new CodedError('not-confirming', 'nothing to confirm')
    let space: SpaceCheck
    let saving: boolean
    try {
      // said here, where another folder can still be chosen; startDownload refuses it for every way in
      saving = await exportPending(join(dir, '.wt-partial', t.infoHash))
      const have = await this.haveBytes(dir)
      space = await checkSpace(dir, Math.max(0, t.length - have))
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

  /**
   * Every await below is followed by assertLive(): a leave or a closed room may have run meanwhile, and
   * whatever was created by then (transfer, server) is found and closed by leave() through the fields.
   */
  private async startDownload(saveDir: string): Promise<void> {
    const a = this.announce
    const info = this.info
    const torrent = this.torrent
    const manifest = this.manifest
    const map = this.map
    if (!a || !info || !torrent || !manifest || !map || !this.timeline) throw new Error('announce first')
    // the infoHash parsed from the torrent, not the announce's claim (crossCheck made them equal anyway)
    const transferDir = join(saveDir, '.wt-partial', info.infoHash)
    // a save there that a quit cut off (this video, from any room) takes these segments: a download would race it,
    // and a 'delete' leave would take away half of that video
    if (await exportPending(transferDir)) throw new CodedError('busy', SAVE_PENDING_THERE)
    this.assertLive()
    this.saveDir = saveDir
    this.transferFolder = resolve(transferDir)
    const transfer = new TransferEngine()
    this.transfer = transfer
    // Listeners first: a complete resume emits 'done' right after joinAsViewer resolves. The transfer
    // outlives teardown during a leave (the export runs last), so its events stand down once stopping.
    transfer.on('pieces-changed', (st) => {
      if (this.isStopped()) return // teardown already cleared 'timeline'
      this.states = st
      for (const fn of this.mediaListeners) fn()
      this.emitTimeline()
    })
    transfer.on('stats', (st) => {
      // a dead torrent reports all zeros: keep the progress it reached, with nothing moving
      if (this.transferError) {
        this.rate.push(0)
        return
      }
      this.lastStats = st
      this.rate.push(st.downBps)
    })
    transfer.on('disk-low', (low) => {
      if (this.isStopped()) return
      this.notice(
        low
          ? { level: 'error', code: 'transfer.disk-low', message: 'The disk is almost full: downloading paused.' }
          : { level: 'info', code: 'transfer.disk-ok', message: 'Disk space is available again: downloading resumed.' },
      )
    })
    transfer.on('done', () => {
      if (this.isStopped()) return
      // a held stream goes to the player now, unless the room is over for us (nothing to follow)
      const release = this.holdingSource() && this.sync !== null
      this.downloaded = true
      this.notice({
        level: 'info',
        code: 'transfer.done',
        message: release ? 'The whole video is downloaded: it plays now.' : 'The whole video is downloaded.',
      })
      this.updatePower()
      if (release) this.giveSource()
    })
    transfer.on('error', (e) => {
      this.deps.log.error('downloading failed', e)
      if (this.isStopped() || this.transferError) return
      this.transferError = new CodedError('transfer-failed', `Downloading stopped: ${e.message}`)
      if (this.lastStats) this.lastStats = { ...this.lastStats, downBps: 0, upBps: 0, etaToEofS: null, peers: [] }
      this.updatePower()
      // in the room: tell the user; while joining, the join fails with it instead (assertLive)
      if (this.sync) this.notice({ level: 'error', code: 'transfer.failed', message: this.transferError.message })
    })
    const s = this.deps.settings()
    await transfer.joinAsViewer({
      torrent,
      ...(this.manifestBytes ? { manifest: this.manifestBytes } : {}),
      dir: transferDir,
      uploadLimitKBps: s.uploadLimitKBps,
      downloadLimitKBps: s.downloadLimitKBps,
    })
    this.assertLive()
    // a limit changed during the start reached an engine that may not have had a client to apply it to
    transfer.setUploadLimit(this.deps.settings().uploadLimitKBps)
    transfer.setDownloadLimit(this.deps.settings().downloadLimitKBps)
    const source = transfer.streamSource
    if (!source) throw new Error('no stream source')

    const onPeer = (p: RoomPeer): void => transfer.attach(p)
    const onGone = (id: string): void => transfer.detach(id)
    this.room.on('peer', onPeer)
    this.room.on('peer-gone', onGone)
    this.unsubs.push(
      () => this.room.off('peer', onPeer),
      () => this.room.off('peer-gone', onGone),
    )
    for (const p of this.room.peers()) transfer.attach(p)
    // host-assigned striping: the host learns our bt lanes and blocked reads (striping.ts); stops on a leave
    // (teardown) and when the room closes (onRoomClosed)
    this.stopLinks = reportTransferLinks({
      room: this.room,
      hostId: this.room.state().hostKey,
      transfer,
      log: this.deps.log,
    })
    this.unsubs.push(() => this.stopReporting())

    // R6: open-critical, seek-critical (video bytes; the video sits at torrent offset 0) and the subtitle files
    const subFiles = source.files.slice(1)
    const critical: ByteRange[] = [
      ...manifest.openCritical,
      ...manifest.seekCritical,
      ...subFiles.map((f): ByteRange => [f.offset, f.offset + f.length]),
    ]
    transfer.setCriticalRanges(criticalSpans(critical, info.pieceLength, info.length))
    this.playhead = new Playhead(map, { setPlayhead: (plan) => transfer.setPlayhead(plan) })
    this.states = transfer.pieceStates()

    const server = await StreamServer.listen(source)
    const stop = this.standDown()
    if (stop) {
      // a leave may already be past closing this.server
      await server.close().catch(() => undefined)
      throw stop
    }
    this.server = server
    const subtitles = (): SubtitleSpec[] =>
      manifest.externalSubs.map((sub) => ({ url: server.url(sub.fileIndex), title: sub.title, lang: sub.lang || null }))

    this.file = new SessionFile(sessionFilePath(this.deps.paths.userData, this.roomId), {
      v: 1,
      role: 'viewer',
      roomId: this.roomId,
      fileName: a.name,
      fileSize: a.fileSize,
      durationS: a.durationMs / 1000,
      infoHash: info.infoHash,
      saveDir,
      transferDir,
      updatedAt: Date.now(),
    })
    await this.file.flush()
    this.assertLive()

    const player = this.createPlayer({ title: a.name, subtitles })
    player.on('fileLoaded', () => (this.fileOpened = true))
    // mpv sits empty while the source is held, and its OSC drops toasts until it is up: say why once it
    // is (again after a restart or a Reopen)
    player.on('oscReady', () => {
      if (this.holdingSource() && this.sync) player.osc('toast', { text: FULL_DOWNLOAD.message })
    })
    const engine = this.startSync({
      subtitles,
      media: new MediaPortAdapter({
        map,
        manifest,
        states: () => this.states,
        fileOpened: () => this.fileOpened,
        lastStallAtMs: () => this.lastStallAt,
        setPlayhead: (posS, reason) => this.playhead?.set(posS, PLAYHEAD_REASONS[reason]),
        onChange: (fn) => {
          this.mediaListeners.add(fn)
          return () => this.mediaListeners.delete(fn)
        },
        positionS: () => this.sync?.roomPosition() ?? 0,
      }),
      transfer: new TransferPortAdapter({
        rateBps: () => this.rate.get(),
        etaToEofS: () => this.lastStats?.etaToEofS ?? null,
        coverage: () => this.timeline?.coverage(this.states) ?? null,
        diskFull: () => this.lastStats?.diskLow ?? false,
        // the host names it in our slow-download warning
        downLimitBps: () => limitBps(this.deps.settings().downloadLimitKBps),
      }),
    })
    engine.on('sync', (e) => {
      if (e.wait?.reason === 'buffering') this.lastStallAt = performance.now()
    })
    this.giveSource()
    // the playhead slides while playing: L1 follows the room position (plan §4.3 "Playhead adapter")
    this.every(TICK_MS, () => {
      if (this.sync !== engine) return // the room closed: nothing to follow (onRoomClosed)
      const pos = engine.roomPosition()
      if (engine.syncEvent()?.mode === 'playing' && pos !== null) this.playhead?.set(pos, 'tick')
    })
    this.setSession({ phase: 'in-room' })
    this.emitTimeline()
    if (this.holdingSource()) this.notice(FULL_DOWNLOAD)
  }

  private emitTimeline(): void {
    if (!this.timeline) return
    const t = this.timeline.forViewer(this.states, BaseSession.bufferedOf(this.player))
    this.deps.emit('timeline', t.event)
    this.player?.osc('ranges', t.osc)
  }

  protected override onPeersTick(): void {
    const st = this.lastStats
    if (!st) return
    this.deps.emit('transfer', {
      downBps: st.downBps,
      upBps: st.upBps,
      progress: st.progress,
      missingAheadBytes: st.missingAheadBytes,
      etaToEofS: st.etaToEofS,
      diskLow: st.diskLow,
    })
    this.file?.update({ progress: st.progress })
  }

  protected override transferPeers(): readonly PeerTransferStats[] {
    return this.lastStats?.peers ?? []
  }

  protected override keepAwake(): boolean {
    return !this.isStopped() && !this.transferError && (this.lastStats?.progress ?? 0) < 1
  }

  protected override applyUploadLimit(kbps: number | null): void {
    this.transfer?.setUploadLimit(kbps)
  }

  protected override applyDownloadLimit(kbps: number | null): void {
    this.transfer?.setDownloadLimit(kbps)
  }

  /** mpv's demuxer waits in a read of the video (file 0) for a piece: the player reloads instead of seeking. */
  protected override readerBlocked(): boolean {
    return this.server?.isBlocked(0) ?? false
  }

  protected override onRoomClosed(s: RoomState): void {
    if (this.isStopped()) return // our own leave
    // a join still in flight (blob fetch, confirm, startDownload) stands down instead of reaching in-room
    this.abort.abort(new CodedError('cancelled', 'the room closed'))
    this.confirmReject?.(new CodedError('cancelled', 'the room closed'))
    this.confirm = null
    this.confirmReject = null
    this.stopFollowing()
    this.stopReporting()
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
    const sync = this.sync
    if (!sync) return
    this.sync = null
    const roomPos = sync.roomPosition()
    sync.stop()
    const player = this.player
    void player?.setPaused(true).catch(() => undefined)
    // The member reported playback at 4 Hz and stopped with sync: its last report still says playing, and the
    // renderer would show Pause and run the cursor on. A player with nothing loaded stops where the room was.
    const pos = player?.prop('time-pos')
    this.deps.emit('playback', {
      posS: Math.max(0, typeof pos === 'number' ? pos : (roomPos ?? 0)),
      durationS: this.map && this.map.durationMs > 0 ? this.map.durationMs / 1000 : null,
      paused: true,
      seeking: false,
      stalled: false,
      at: this.clock.now(),
    })
  }

  protected override onPlayerReplaced(): void {
    this.giveSource()
  }

  /** No more link reports to the host: a closed room has no route to it, and a leave tells it by leaving. */
  private stopReporting(): void {
    this.stopLinks?.()
    this.stopLinks = null
  }

  /**
   * fMP4 without sidx (needsFullDownload): FFmpeg reads such a file to its end at open, so mpv would sit in
   * that read for the whole download, and every reload for a blocked reader would start it over. mpv gets the
   * stream once the download is complete; until then the member has no source and stays 'joining'.
   */
  private holdingSource(): boolean {
    return this.fullDownload && !this.downloaded
  }

  /** The stream to the player through sync, which loads it at the room position (also after a player swap). */
  private giveSource(): void {
    if (!this.server || !this.sync || this.holdingSource()) return
    this.sync.setSource(this.server.url(0))
  }

  get progress(): number {
    return this.lastStats?.progress ?? 0
  }

  /** True once leave() has been called (the manager refuses a second, different leave meanwhile). */
  get isLeaving(): boolean {
    return this.leaving !== null
  }

  /** The transfer folder the download went into (resolved), once it started; a 'save' leave exports from it. */
  get transferDir(): string | null {
    return this.transferFolder
  }

  /**
   * session.leave / transfer.saveFile: 'save' exports a complete download (consuming the segments).
   * Idempotent; the first call's options win. Resolves once everything is stopped, with the exported video
   * (null when there was none or the export failed), or rejects with CodedError 'incomplete' when segments
   * turned out missing: the session is stopped all the same, and the room stays resumable so a rejoin
   * downloads them again.
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
    await this.room.leave().catch(() => undefined)
    this.blobs?.destroy()
    // player, sync and timers stop before the (possibly long) export, and a failed step never keeps the
    // rest from stopping
    await this.teardown().catch((e: unknown) => this.deps.log.error('stopping the session failed', e))
    await this.server?.close().catch(() => undefined)
    let video: string | null = null
    try {
      const saveDir = opts.saveDir ?? this.saveDir
      video = (await this.transfer?.leave({ data: opts.data, ...(saveDir ? { saveDir } : {}) }))?.video ?? null
    } catch (e) {
      this.deps.log.error('leaving the transfer failed', e)
      // segments lost since the join (transfer's IncompleteDownloadError): nothing was consumed and their
      // pieces left the journal, so the room record stays for a rejoin to download them again
      if (e instanceof CodedError && e.code === 'incomplete') {
        throw new CodedError(
          'incomplete',
          'Some downloaded data was missing. Rejoin the room to download it again, then save.',
        )
      }
    }
    // nothing left to resume once the data is gone or exported
    if (opts.data === 'delete' || video) await this.deps.store.remove(this.roomId).catch(() => undefined)
    return video
  }
}

/**
 * The announce, torrent and manifest arrive separately: they must describe the same video before any of
 * them sizes a buffer, a journal or a folder. Sizes are bounded by the torrent's own piece hashes (the
 * torrent blob is at most 64 MiB), never by a number the host merely states.
 */
export function crossCheck(
  a: { infoHash: string; fileSize: number },
  t: {
    infoHash: string
    pieceLength: number
    length: number
    pieces: readonly unknown[]
    files: readonly { length: number }[]
  },
  m: Manifest,
): void {
  const bad = (what: string): never => {
    throw new CodedError(
      'bad-session',
      `The host sent inconsistent video details (${what}). Ask the host to host it again.`,
    )
  }
  if (t.infoHash !== a.infoHash) bad('torrent')
  if (Buffer.from(m.infoHash).toString('hex') !== a.infoHash) bad('manifest')
  const p = t.pieceLength
  if (p !== m.pieceLength || p < 16 * 1024 || p > 4 * 1024 * 1024 || (p & (p - 1)) !== 0 || SEGMENT_BYTES % p !== 0) {
    bad('piece length')
  }
  if (t.files.length < 1 || t.files.length > 1 + MAX_SUBS) bad('file count')
  // one hash per piece of the whole length: MediaMap and the journal size themselves from these
  if (
    t.files.some((f) => !Number.isSafeInteger(f.length) || f.length < 0) ||
    !Number.isSafeInteger(t.length) ||
    t.pieces.length !== Math.ceil(t.length / p)
  ) {
    bad('pieces')
  }
  if (m.videoFileIndex !== 0 || t.files[0]?.length !== m.fileSize || m.fileSize !== a.fileSize) bad('file size')
  if (
    m.externalSubs.length > t.files.length - 1 ||
    m.externalSubs.some((s) => s.fileIndex < 1 || s.fileIndex >= t.files.length)
  ) {
    bad('subtitles')
  }
  // any number of them: an fMP4 lists one sidx per fragment; startDownload merges them into piece spans
  if ([...m.openCritical, ...m.seekCritical].some(([s, e]) => s < 0 || e < s || e > m.fileSize)) bad('ranges')
  // counts the host merely states: each audio index is an urgent range on every replan, and seek points
  // size MediaMap's arrays
  if (m.tracks.length > MAX_TRACKS) bad('tracks')
  const audio = m.audioIndexes ?? []
  if (audio.length > MAX_AUDIO_INDEXES || audio.some((x) => x.points.length > maxKeyPoints(x.points, m.durationMs))) {
    bad('audio')
  }
  if (m.keyframes.length > maxKeyPoints(m.keyframes, m.durationMs)) bad('keyframes')
}

/**
 * The host thins seek points to KEYFRAME_MIN_GAP_MS apart (thinKeyPoints), so an honest list holds about
 * one per gap over the duration, or over its own span when the container understates the duration.
 */
function maxKeyPoints(points: readonly KeyPoint[], durationMs: number): number {
  const span = (points.at(-1)?.[0] ?? 0) - (points[0]?.[0] ?? 0)
  return Math.min(MAX_KEY_POINTS, Math.ceil(Math.max(durationMs, span) / KEYFRAME_MIN_GAP_MS) + 2)
}

/**
 * Critical byte ranges (torrent bytes) as whole-piece spans for the scheduler: overlapping or adjacent
 * pieces merged, then the narrowest gaps bridged until at most `max` spans remain. Every span is a
 * selection re-added on each replan, and a manifest may hold thousands of ranges in a few pieces (one
 * sidx per fragment). A bridged gap only makes a few more pieces critical.
 */
export function criticalSpans(
  ranges: readonly ByteRange[],
  pieceLength: number,
  length: number,
  max = MAX_CRITICAL_SPANS,
): ByteRange[] {
  const P = pieceLength
  const pieces = ranges
    .filter(([s, e]) => e > s)
    .map(([s, e]): [number, number] => [Math.floor(s / P), Math.floor((e - 1) / P)])
    .sort((x, y) => x[0] - y[0])
  let spans: [number, number][] = []
  for (const [a, b] of pieces) {
    const last = spans.at(-1)
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b)
    else spans.push([a, b])
  }
  if (spans.length > max) {
    // gap i lies between spans i and i + 1: bridge all but the widest max - 1
    const gaps = spans.slice(1).map((s, i) => ({ i, width: s[0] - (spans[i]?.[1] ?? 0) }))
    gaps.sort((x, y) => x.width - y.width)
    const bridged = new Set(gaps.slice(0, spans.length - max).map((g) => g.i))
    const merged: [number, number][] = []
    for (const [i, s] of spans.entries()) {
      const last = merged.at(-1)
      if (last && bridged.has(i - 1)) last[1] = s[1]
      else merged.push([s[0], s[1]])
    }
    spans = merged
  }
  return spans.map(([a, b]): ByteRange => [a * P, Math.min((b + 1) * P, length)]).filter(([s, e]) => e > s)
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}
