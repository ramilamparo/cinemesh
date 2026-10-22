import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PrepareEvent } from '../../shared/ipc/core.js'
import { buildManifest, encodeManifest } from '../../shared/media/manifest.js'
import { FASTSTART_REMUX, MediaMap, needsFullDownload } from '../../shared/media/media-map.js'
import type { ByteRange, Manifest } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import { buildMediaIndex } from '../media/build-index.js'
import { Playhead } from '../media/playhead.js'
import { Blobs, MemoryBlobProvider } from '../net/blobs.js'
import type { RoomRecord } from '../net/identity.js'
import { Room, type RoomPeer, type RoomState } from '../net/room.js'
import type { SubtitleSpec } from '../player/player-controller.js'
import type { GroupSnapshot } from '../sync/group.js'
import { TransferEngine, type TransferStats, type PeerTransferStats } from '../transfer/engine.js'
import { cacheKeyFor, prepareHost } from '../transfer/host-prepare.js'
import { BaseSession, type SessionDeps } from './base-session.js'
import { PLAYHEAD_REASONS, announceName, netLog, subtitleLang } from './common.js'
import { type SessionFileData, SessionFile, sessionFilePath } from './session-file.js'
import { encodeCoverage } from './timeline.js'
import { Timeline } from './timeline.js'
import { MediaPortAdapter, TransferPortAdapter } from './sync-ports.js'
import { collectTransferLinks } from './striping.js'
import { MAX_MANIFEST_BYTES, criticalSpans } from './viewer-session.js'

export interface HostInput {
  videoPath: string
  subtitlePaths: string[]
  resume?: { record: RoomRecord; file: SessionFileData | null }
}

/**
 * A resumed group starts this far past the seq in session.json, so its restore outranks any state viewers
 * kept: the file can miss the last publishes (a crash between a publish and its write). The group publishes
 * a few states a second at most.
 */
export const RESUME_SEQ_GAP = 1000

const PLAYHEAD_TICK_MS = 1000
/** the 1 Hz ticks keep the plan within a second of a playing room: further than this, the room jumped */
const PLAN_JUMP_S = 2
/** transfer stats (1 Hz) of a steady paced rate the feasibility line needs before it goes by that rate */
export const PACED_WINDOW = 10

/** session.announce body (sticky, host-only): what viewers fetch with blob.get. Hashes are BLAKE2b-256 hex. */
export interface AnnounceBody {
  v: 1
  infoHash: string
  torrent: { hash: string; size: number }
  manifest: { hash: string; size: number }
  name: string
  fileSize: number
  durationMs: number
}

/**
 * What host-assigned striping shows every viewer at once (TransferEngine.setGroupCriticalRanges, torrent bytes)
 * instead of in the group plan's order: what mpv reads to open the file, the seek index (MKV Cues, which mpv
 * reads at the first seek: one piece or two, and that seek would otherwise wait for an urgent report to reveal
 * them) and the subtitle files. A file that plays only once complete is open-critical from end to end: shown to
 * everyone, it would leave the host once per viewer, so only its subtitles are critical and the plan's walk
 * (L1, L2, L3: the whole file) stripes the rest.
 */
export function groupCriticalRanges(
  manifest: Pick<Manifest, 'fileSize' | 'openCritical' | 'seekCritical'>,
  subs: readonly { offset: number; length: number }[],
  layout: { pieceLength: number; length: number },
): ByteRange[] {
  const media = needsFullDownload(manifest) ? [] : [...manifest.openCritical, ...manifest.seekCritical]
  const files = subs.map((f): ByteRange => [f.offset, f.offset + f.length])
  return criticalSpans([...media, ...files], layout.pieceLength, layout.length)
}

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
 */
export class HostSession extends BaseSession {
  readonly role = 'host' as const
  private readonly abort = new AbortController()
  private readonly transfer = new TransferEngine()
  private blobs: Blobs | null = null
  private manifest: Manifest | null = null
  private timeline: Timeline | null = null
  /** the room's playhead as host-assigned striping sees it (TransferEngine.setGroupPlayhead) */
  private playhead: Playhead | null = null
  private allVerified = new Uint8Array(0)
  private lastStats: TransferStats | null = null
  private peakUpBps = 0
  /** the paced rate of each stats event since the pacer last went steady (at most PACED_WINDOW of them) */
  private steadyRates: number[] = []
  private lastStallAt: number | null = null
  private ready = false
  private subtitles: SubtitleSpec[] = []
  private avgBytesPerSec = 0
  /** the final prepare event, re-sent once a second in the room with a fresh feasibility */
  private readyEvent: PrepareEvent | null = null

  private constructor(
    deps: SessionDeps,
    room: Room,
    private readonly input: HostInput,
    private readonly size: number,
    file: SessionFile,
  ) {
    super(deps, room)
    this.file = file
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
        updatedAt: Date.now(),
        ...(input.resume?.file?.group ? { group: input.resume.file.group } : {}),
      })
      // on disk before the marker, and before indexing or hashing (minutes for a big file) can crash
      await file.flush()
      const session = new HostSession(deps, room, input, size, file)
      session.begin()
      return session
    } catch (e) {
      await room.close().catch(() => undefined)
      throw e
    }
  }

  private begin(): void {
    this.setSession({ phase: 'preparing', role: 'host', fileName: basename(this.input.videoPath), fileSize: this.size })
    void this.prepare().catch((e: unknown) => {
      if (this.abort.signal.aborted || this.isStopped()) return
      this.deps.log.error('hosting failed', e)
      const message = e instanceof Error ? e.message : String(e)
      this.setSession({ phase: 'error', error: { code: e instanceof CodedError ? e.code : 'host-failed', message } })
    })
  }

  /** After every await in prepare(): a leave or cancel meanwhile means stand down (begin() stays quiet). */
  private assertLive(): void {
    if (this.isStopped() || this.abort.signal.aborted) throw new CodedError('cancelled', 'Hosting was cancelled')
  }

  private async prepare(): Promise<void> {
    const { videoPath, subtitlePaths } = this.input
    const signal = this.abort.signal
    const settings = this.deps.settings()

    // 1. media index (cached per file next to the piece hashes)
    const cacheRoot = join(this.deps.paths.userData, 'wt', 'host-cache')
    const key = await cacheKeyFor(videoPath)
    this.assertLive()
    const t0 = performance.now()
    const { index } = await buildMediaIndex(videoPath, {
      signal,
      cacheDir: join(cacheRoot, key),
      onProgress: (done, total) => this.progress({ stage: 'indexing', bytesDone: done, bytesTotal: total }, t0, false),
    })
    this.assertLive()
    const fullDownload = needsFullDownload(index)
    this.setSession({
      durationS: index.durationMs / 1000,
      media: { container: index.container, seekMode: index.seekMode, fullDownload, interleave: index.interleave },
    })
    this.avgBytesPerSec = index.avgBytesPerSec
    if (fullDownload) {
      this.notice({
        level: 'warn',
        code: 'media.full-download',
        message:
          'Viewers can only start once they have downloaded the whole file: it has no index to stream from. ' +
          `To make it stream, remux it: ${FASTSTART_REMUX}`,
      })
    }

    // 2. piece hashes (cached per file; a hit costs a 3-piece spot check plus the tail)
    const prepared = await prepareHost({
      videoPath,
      subtitlePaths,
      cacheRoot,
      workers: settings.hashWorkers,
      signal,
      onProgress: (p) => {
        // the index (avgBytesPerSec) is known from here on, so HostPrepare can show the feasibility line
        this.deps.emit('prepare', { stage: 'hashing', ...p, feasibility: this.feasibility() })
        this.publishPreparing('hashing', p.bytesTotal ? p.bytesDone / p.bytesTotal : 0)
      },
    })
    this.assertLive()

    // 3. manifest + blobs
    const { layout } = prepared
    const subs = layout.files.slice(1)
    const manifest = buildManifest(index, {
      infoHash: Buffer.from(prepared.infoHash, 'hex'),
      pieceLength: layout.pieceLength,
      videoFileIndex: 0,
      externalSubs: subs.map((f) => ({ fileIndex: f.index, name: f.name, lang: subtitleLang(f.name), title: f.name })),
    })
    this.manifest = manifest
    const map = new MediaMap(manifest)
    const manifestBytes = encodeManifest(manifest)
    // viewers refuse a larger one (AnnounceSchema): fail here, where the reason can be shown
    if (manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
      const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1)
      throw new CodedError(
        'manifest-too-large',
        `This video cannot be shared: its seek index (${mb(manifestBytes.byteLength)} MB) is larger than viewers ` +
          `accept (${mb(MAX_MANIFEST_BYTES)} MB). Very long or all-keyframe files do this; re-encode it with a ` +
          'normal keyframe interval.',
      )
    }
    const provider = new MemoryBlobProvider()
    const torrentHash = provider.add(prepared.torrent)
    const manifestHash = provider.add(manifestBytes)
    this.blobs = new Blobs(this.room, provider)

    // 4. seed to every admitted member, at the limit set now (a change while preparing had no client to reach)
    await this.transfer.startHost(prepared, { uploadLimitKBps: this.deps.settings().uploadLimitKBps })
    this.assertLive()
    // and again: startHost awaits before it creates its client, so a change made meanwhile was dropped too
    this.applyUploadLimit(this.deps.settings().uploadLimitKBps)
    // striping (ADR 0003) before any viewer attaches: with no group playhead the first viewer would be shown
    // everything. Critical pieces go to everyone at once; the rest follows the room's playhead (the host member's
    // seeks, the 1 Hz tick) and the viewers' own reports.
    this.transfer.setGroupCriticalRanges(groupCriticalRanges(manifest, subs, layout))
    const transfer = this.transfer
    this.playhead = new Playhead(map, { setPlayhead: (plan) => transfer.setGroupPlayhead(plan) })
    this.playhead.set(this.input.resume?.file?.group?.lastAnchor.posS ?? 0, 'join')
    this.unsubs.push(collectTransferLinks({ room: this.room, transfer, log: this.deps.log }))
    this.transfer.on('stats', (st) => {
      this.lastStats = st
      this.peakUpBps = Math.max(this.peakUpBps, st.upBps)
      const uplink = st.uplink
      if (uplink?.state === 'steady' && uplink.rateBps !== null)
        this.steadyRates = [...this.steadyRates, uplink.rateBps].slice(-PACED_WINDOW)
      else this.steadyRates = []
    })
    this.transfer.on('source-changed', (c) => {
      if (c.kind === 'changed') {
        this.notice({
          level: 'error',
          code: 'transfer.source-changed',
          message: 'The video file changed on disk, so sharing stopped. Host it again to keep sharing.',
        })
        try {
          this.room.publish(announceName('unavailable'), { reason: 'source-changed' })
        } catch (e) {
          this.deps.log.warn(`could not tell viewers the file is gone: ${String(e)}`)
        }
      } else {
        this.notice({
          level: 'warn',
          code: 'transfer.source-moved',
          message: 'The video file was moved; it keeps being shared from the open file.',
        })
      }
    })
    this.transfer.on('error', (e) => {
      this.deps.log.error('sharing failed', e)
      this.notice({ level: 'error', code: 'transfer.failed', message: `Sharing stopped: ${e.message}` })
    })
    const onPeer = (p: RoomPeer): void => this.transfer.attach(p)
    const onGone = (id: string): void => this.transfer.detach(id)
    this.room.on('peer', onPeer)
    this.room.on('peer-gone', onGone)
    this.unsubs.push(
      () => this.room.off('peer', onPeer),
      () => this.room.off('peer-gone', onGone),
    )
    for (const p of this.room.peers()) this.transfer.attach(p)

    // 5. tell the room
    const announce: AnnounceBody = {
      v: 1,
      infoHash: prepared.infoHash,
      torrent: { hash: torrentHash, size: prepared.torrent.byteLength },
      manifest: { hash: manifestHash, size: manifestBytes.byteLength },
      name: basename(videoPath),
      fileSize: this.size,
      durationMs: index.durationMs,
    }
    this.room.publish(announceName('announce'), announce)

    // 6. timeline, player and sync
    this.timeline = new Timeline(map)
    this.allVerified = new Uint8Array(layout.pieceCount).fill(2)
    this.subtitles = subtitlePaths.map((p, i) => ({
      url: p,
      title: subs[i]?.name ?? basename(p),
      lang: subtitleLang(p),
    }))
    this.createPlayer({ title: basename(videoPath), subtitles: () => this.subtitles })
    const full = encodeCoverage([[0, index.durationMs / 1000]], index.durationMs / 1000)
    const group = this.input.resume?.file?.group
    const hd = settings.hostDefaults
    const engine = this.startSync({
      subtitles: () => this.subtitles,
      media: new MediaPortAdapter({
        map,
        manifest,
        states: () => this.allVerified,
        fileOpened: () => true, // the host plays its local file
        lastStallAtMs: () => this.lastStallAt,
        // nothing to download: the host member's seeks are the room's, which striping follows
        setPlayhead: (posS, reason) => this.playhead?.set(posS, PLAYHEAD_REASONS[reason]),
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
        syncEpoch: group?.syncEpoch ?? BaseSession.randomEpoch(),
        perms: group?.perms ?? { othersPlayPause: hd.othersControl, othersSeek: hd.othersControl },
        waitForAll: group?.waitForAll ?? hd.waitForAll,
        startMode: group?.startMode ?? hd.startMode,
        ...(group ? { resume: { ...group, seq: group.seq + RESUME_SEQ_GAP } } : {}),
      },
    })
    engine.on('persist', (snap: GroupSnapshot) => this.persist(snap))
    engine.on('sync', (e) => {
      if (e.wait?.reason === 'buffering') this.lastStallAt = performance.now()
    })
    // a file that plays only once complete: the room's first play does not wait for whole downloads
    engine.mediaReady(index.durationMs / 1000, { fullDownload })
    engine.setSource(videoPath)
    // The group plan follows the room (plan §4.3 "Playhead adapter"): the host member's seeks and loads move it,
    // and L1 slides at 1 Hz while the room plays. A room further than PLAN_JUMP_S from the plan moved without
    // the host member (its mpv closed, missing or restarting): that is a seek, which also moves the hot window.
    this.every(PLAYHEAD_TICK_MS, () => {
      const pos = engine.roomPosition()
      const plan = this.playhead?.last
      if (pos === null || !plan) return
      if (Math.abs(pos - plan.posS) > PLAN_JUMP_S) this.playhead?.set(pos, 'seek')
      else if (engine.syncEvent()?.mode === 'playing') this.playhead?.set(pos, 'tick')
    })
    this.file?.update({ infoHash: prepared.infoHash, durationS: index.durationMs / 1000 })
    this.ready = true
    this.setSession({ phase: 'in-room' })
    this.readyEvent = {
      stage: 'ready',
      bytesDone: prepared.layout.length,
      bytesTotal: prepared.layout.length,
      bytesPerSec: 0,
      cached: prepared.cached,
    }
    this.deps.emit('prepare', { ...this.readyEvent, feasibility: this.feasibility() })
  }

  /** A publish (a new seq) is written at once; the position updates every 5 s while playing keep the debounce. */
  private persist(snap: GroupSnapshot): void {
    const file = this.file
    if (file) file.update({ group: snap }, { now: snap.seq !== file.current.group?.seq })
  }

  private progress(p: Pick<PrepareEvent, 'stage' | 'bytesDone' | 'bytesTotal'>, t0: number, cached: boolean): void {
    const secs = (performance.now() - t0) / 1000
    this.deps.emit('prepare', { ...p, bytesPerSec: secs > 0 ? p.bytesDone / secs : 0, cached })
    this.publishPreparing(p.stage, p.bytesTotal ? p.bytesDone / p.bytesTotal : 0)
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

  protected override onPeersTick(): void {
    if (!this.timeline || !this.manifest) return
    const coverage = this.syncPeers()
      .filter((p) => p.id !== this.room.self)
      .map((p) => p.coverage)
    const t = this.timeline.forHost(coverage, BaseSession.bufferedOf(this.player))
    this.deps.emit('timeline', t.event)
    this.player?.osc('ranges', t.osc)
    const st = this.lastStats
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
    // the Room's host panel keeps the feasibility line current (live viewer count, measured upload)
    if (this.readyEvent) this.deps.emit('prepare', { ...this.readyEvent, feasibility: this.feasibility() })
  }

  /**
   * "Group needs ~X from you": the worst case, one copy of the stream per viewer (viewers that cannot reach each
   * other each take theirs from the host; striping brings linked viewers near one copy in all). Only viewers who
   * are here count (a resumed room lists everyone it ever admitted). The upload: uploadCapacityBps.
   */
  private feasibility(): { needBps: number; uploadBps: number | null } {
    const viewers = this.room.members().filter((m) => !m.self && (m.linked || m.path === 'via-peer')).length
    return {
      needBps: this.avgBytesPerSec * Math.max(1, viewers),
      uploadBps: uploadCapacityBps(this.steadyRates, this.peakUpBps),
    }
  }

  protected override applyUploadLimit(kbps: number | null): void {
    this.transfer.setUploadLimit(kbps)
  }

  protected override transferPeers(): readonly PeerTransferStats[] {
    return this.lastStats?.peers ?? []
  }

  protected override keepAwake(): boolean {
    return !this.stopped
  }

  protected override onRoomClosed(s: RoomState): void {
    if (this.isStopped()) return // our own leave/end, not the room going away under us
    if (s.phase === 'ended') this.setSession({ phase: 'ended' })
  }

  protected override onPlayerReplaced(): void {
    if (this.ready) this.sync?.setSource(this.input.videoPath)
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
    await this.room.leave({ end: opts.end ?? false }).catch(() => undefined)
    this.blobs?.destroy()
    await this.transfer.destroy().catch(() => undefined)
    // a leave must always finish, or the manager keeps a dead session as the current one
    await this.teardown().catch((e: unknown) => this.deps.log.error('stopping the session failed', e))
    if (opts.end) await this.deps.store.remove(this.roomId).catch(() => undefined)
  }
}
