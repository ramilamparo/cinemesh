import { join, resolve } from 'node:path'
import type { NoticeEvent } from '../../shared/ipc/core.js'
import { limitBps } from '../../shared/limits.js'
import { decodeManifest } from '../../shared/media/manifest.js'
import { MediaMap, needsFullDownload } from '../../shared/media/media-map.js'
import type { ByteRange, Manifest } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import type { CoreLog } from '../log.js'
import { Playhead } from '../media/playhead.js'
import { StreamServer } from '../media/stream-server.js'
import type { Blobs, MemoryBlobProvider } from '../net/blobs.js'
import type { Room, RoomPeer } from '../net/room.js'
import type { SubtitleSpec } from '../player/player-controller.js'
import type { CarrySub } from '../player/track-carry.js'
import type { Settings } from '../../shared/settings.js'
import { TransferEngine, type TransferStats } from '../transfer/engine.js'
import { trustedBytes } from '../transfer/resume.js'
import { type SavedFiles, exportPending } from '../transfer/save-file.js'
import type { Announce } from './announce.js'
import { PLAYHEAD_REASONS } from './common.js'
import { subtitleFlags } from './playlist-files.js'
import { reportTransferLinks } from './striping.js'
import { Ewma, MediaPortAdapter, TransferPortAdapter } from './sync-ports.js'
import { Timeline } from './timeline.js'
import { cachedManifest, criticalSpans, crossCheck } from './media-checks.js'

const BLOB_TIMEOUT_MS = 60_000

/** A folder where a save of this video that a quit, a crash or a missing drive cut off is still pending. */
export const SAVE_PENDING_THERE =
  'This video is still being saved into that folder from last time. Choose another folder, or finish or cancel that save in Recent rooms first.'

/** What the viewer trusts about the download: taken from the torrent itself (the infoHash commits to it). */
export interface TorrentInfo {
  infoHash: string
  pieceLength: number
  pieceCount: number
  /** video plus external subtitles */
  length: number
}

export interface StartOptions {
  saveDir: string
  room: Room
  settings: () => Settings
  events: SlotEvents
  live: () => void
  /** the first start's choice; setPeers changes it later */
  peers?: 'all' | 'host'
}

/** What a slot's transfer tells the session (its notices go to the user only for the current item). */
export interface SlotEvents {
  pieces: () => void
  done: () => void
  diskLow: (low: boolean) => void
  error: (e: CodedError) => void
}

/**
 * One playlist item on a viewer (ADR 0011): the video the host announced for it (torrent and manifest by
 * blob.get, cross-checked), its download into `<saveDir>/.wt-partial/<infoHash>/`, and the stream server mpv
 * reads it from. A viewer without a playlist (an older host) has one slot. The session owns the room, the player,
 * sync and the order; it starts and stops slots as items become current.
 */
export class ViewerSlot {
  torrent: Buffer | null = null
  info: TorrentInfo | null = null
  manifest: Manifest | null = null
  /** the manifest as announced (hash-checked), kept in the transfer folder for a resume */
  manifestBytes: Uint8Array | null = null
  map: MediaMap | null = null
  timeline: Timeline | null = null
  transfer: TransferEngine | null = null
  server: StreamServer | null = null
  /** `<saveDir>/.wt-partial/<infoHash>`, resolved, once the download starts there */
  transferFolder: string | null = null
  states: Uint8Array = new Uint8Array(0)
  lastStats: TransferStats | null = null
  readonly rate = new Ewma(10)
  /** every piece verified (transfer 'done') */
  downloaded = false
  /** WebTorrent destroys the torrent on any error it reports: the download is over for this item */
  transferError: CodedError | null = null
  playhead: Playhead | null = null
  fileOpened = false
  lastStallAt: number | null = null
  readonly mediaListeners = new Set<() => void>()
  private stopLinks: (() => void) | null = null
  private offs: (() => void)[] = []
  /**
   * Whom the download links to: every member, or only the host (an item fetched ahead while Share other playlist
   * videos is off: a member that is not linked never asks this viewer for it).
   */
  private peers: 'all' | 'host' = 'all'
  private room: Room | null = null
  private meta: Promise<void> | null = null
  private starting: Promise<void> | null = null

  constructor(
    /** the playlist item's id; null for a host without a playlist */
    readonly id: string | null,
    readonly announce: Announce,
    private readonly log: CoreLog,
  ) {}

  get infoHash(): string {
    return this.announce.infoHash
  }

  get name(): string {
    return this.announce.name
  }

  /** the video plays only once complete (needsFullDownload): see holdingSource */
  get fullDownload(): boolean {
    return this.manifest ? needsFullDownload(this.manifest) : false
  }

  get progress(): number {
    return this.downloaded ? 1 : (this.lastStats?.progress ?? 0)
  }

  /**
   * fMP4 without sidx (needsFullDownload): FFmpeg reads such a file to its end at open, so mpv would sit in
   * that read for the whole download, and every reload for a blocked reader would start it over. mpv gets the
   * stream once the download is complete; until then the member has no source and stays 'joining'.
   */
  holdingSource(): boolean {
    return this.fullDownload && !this.downloaded
  }

  /**
   * The torrent and manifest by blob.get (BLAKE2b-verified), cross-checked against the announce; once. A resume
   * knows its folder: the manifest kept there at the join, when it is still the announced one.
   */
  fetchMeta(blobs: Blobs, provider: MemoryBlobProvider, signal: AbortSignal, savedDir?: string): Promise<void> {
    this.meta ??= this.doFetchMeta(blobs, provider, signal, savedDir).catch((e: unknown) => {
      this.meta = null
      throw e
    })
    return this.meta
  }

  private async doFetchMeta(
    blobs: Blobs,
    provider: MemoryBlobProvider,
    abort: AbortSignal,
    savedDir?: string,
  ): Promise<void> {
    const a = this.announce
    const signal = AbortSignal.any([abort, AbortSignal.timeout(BLOB_TIMEOUT_MS)])
    const [torrent, manifestBytes] = await Promise.all([
      blobs.fetch(a.torrent.hash, { size: a.torrent.size, signal }),
      (savedDir ? cachedManifest(join(savedDir, '.wt-partial', a.infoHash), a.manifest) : Promise.resolve(null)).then(
        (kept) => kept ?? blobs.fetch(a.manifest.hash, { size: a.manifest.size, signal }),
      ),
    ])
    const parsedTorrent = await import('parse-torrent').then((m) => m.default(torrent))
    const manifest = decodeManifest(manifestBytes)
    if (abort.aborted) throw new CodedError('cancelled', 'left the room')
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
  }

  /** The folder this item downloads into under `saveDir`. */
  dirIn(saveDir: string): string {
    return join(saveDir, '.wt-partial', this.info?.infoHash ?? this.infoHash)
  }

  /**
   * Bytes a previous session in this folder already holds: verified in its journal and still in a segment
   * file long enough for them. state.json alone is not proof: seg/ may have been deleted or cleaned since.
   */
  async haveBytes(saveDir: string): Promise<number> {
    const t = this.info
    if (!t || t.pieceCount === 0) return 0
    return trustedBytes(this.dirIn(saveDir), t)
  }

  /** What still has to fit on the disk for the whole item. */
  async neededBytes(saveDir: string): Promise<number> {
    return Math.max(0, (this.info?.length ?? this.announce.fileSize) - (await this.haveBytes(saveDir)))
  }

  /**
   * The download into `saveDir` (the folder confirmed at the join), joined to every member, with striping reports
   * to the host, critical ranges and the playhead. `live` throws once the session stands down; whatever was
   * created by then is found and closed by leave() through the fields.
   */
  start(o: StartOptions): Promise<void> {
    // once: a switch to an item still starting ahead waits for that start instead of starting it again
    const run = (this.starting ??= this.doStart(o).catch(async (e: unknown) => {
      // a failed start leaves nothing behind: the item can be started again
      if (this.starting === run) this.starting = null
      const transfer = this.transfer
      this.transfer = null
      this.transferFolder = null
      this.stopReporting()
      for (const off of this.offs.splice(0)) off()
      await transfer?.leave({ data: 'keep' }).catch(() => undefined)
      throw e
    }))
    return run
  }

  /** A start was asked for (it may still run). */
  get startRequested(): boolean {
    return this.starting !== null
  }

  private async doStart(o: StartOptions): Promise<void> {
    this.peers = o.peers ?? 'all'
    this.room = o.room
    const info = this.info
    const torrent = this.torrent
    const manifest = this.manifest
    const map = this.map
    if (!info || !torrent || !manifest || !map) throw new Error('fetch the item first')
    // the infoHash parsed from the torrent, not the announce's claim (crossCheck made them equal anyway)
    const transferDir = this.dirIn(o.saveDir)
    // a save there that a quit cut off (this video, from any room) takes these segments: a download would race it,
    // and a 'delete' leave would take away half of that video
    if (await exportPending(transferDir)) throw new CodedError('busy', SAVE_PENDING_THERE)
    o.live()
    this.transferFolder = resolve(transferDir)
    const transfer = new TransferEngine()
    this.transfer = transfer
    // Listeners first: a complete resume emits 'done' right after joinAsViewer resolves.
    transfer.on('pieces-changed', (st) => {
      this.states = st
      for (const fn of this.mediaListeners) fn()
      o.events.pieces()
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
    transfer.on('disk-low', (low) => o.events.diskLow(low))
    transfer.on('done', () => {
      this.downloaded = true
      o.events.done()
    })
    transfer.on('error', (e) => {
      this.log.error(`downloading ${this.name} failed`, e)
      if (this.transferError) return
      this.transferError = new CodedError('transfer-failed', `Downloading stopped: ${e.message}`)
      if (this.lastStats) this.lastStats = { ...this.lastStats, downBps: 0, upBps: 0, etaToEofS: null, peers: [] }
      o.events.error(this.transferError)
    })
    const s = o.settings()
    await transfer.joinAsViewer({
      torrent,
      ...(this.manifestBytes ? { manifest: this.manifestBytes } : {}),
      dir: transferDir,
      uploadLimitKBps: s.uploadLimitKBps,
      downloadLimitKBps: s.downloadLimitKBps,
    })
    o.live()
    // a limit changed during the start reached an engine that may not have had a client to apply it to
    transfer.setUploadLimit(o.settings().uploadLimitKBps)
    transfer.setDownloadLimit(o.settings().downloadLimitKBps)
    const source = transfer.streamSource
    if (!source) throw new Error('no stream source')

    const onPeer = (p: RoomPeer): void => {
      if (this.linksTo(p.id)) transfer.attach(p)
    }
    const onGone = (id: string): void => transfer.detach(id)
    o.room.on('peer', onPeer)
    o.room.on('peer-gone', onGone)
    this.offs.push(
      () => o.room.off('peer', onPeer),
      () => o.room.off('peer-gone', onGone),
    )
    for (const p of o.room.peers()) onPeer(p)
    // host-assigned striping: the host learns our bt lanes and blocked reads (striping.ts)
    this.report()

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
  }

  get started(): boolean {
    return this.transfer !== null
  }

  private linksTo(peerId: string): boolean {
    return this.peers === 'all' || peerId === this.room?.state().hostKey
  }

  /** Links the download to every member, or to the host only (see `peers`). */
  setPeers(mode: 'all' | 'host'): void {
    if (mode === this.peers) return
    this.peers = mode
    const room = this.room
    const transfer = this.transfer
    if (!room || !transfer) return
    for (const p of room.peers()) {
      if (this.linksTo(p.id)) transfer.attach(p)
      else transfer.detach(p.id)
    }
  }

  /** The stream server for mpv (once the download started). */
  async listen(live: () => void): Promise<StreamServer> {
    if (this.server) return this.server
    const source = this.transfer?.streamSource
    if (!source) throw new Error('start the download first')
    const server = await StreamServer.listen(source)
    try {
      live()
    } catch (e) {
      // a leave may already be past closing this.server
      await server.close().catch(() => undefined)
      throw e
    }
    this.server = server
    return server
  }

  sourceUrl(): string | null {
    return this.server?.url(0) ?? null
  }

  subtitles(): SubtitleSpec[] {
    const server = this.server
    const manifest = this.manifest
    if (!server || !manifest) return []
    return manifest.externalSubs.map((sub) => ({
      url: server.url(sub.fileIndex),
      title: sub.title,
      lang: sub.lang || null,
    }))
  }

  /** The external subtitles as the track carry-over sees them, in the player's order. */
  carrySubs(): CarrySub[] {
    return (this.manifest?.externalSubs ?? []).map((sub) => ({
      lang: sub.lang || subtitleFlags(sub.name).lang,
      forced: subtitleFlags(sub.name).forced,
    }))
  }

  /** mpv's demuxer waits in a read of the video (file 0) for a piece: the player reloads instead of seeking. */
  readerBlocked(): boolean {
    return this.server?.isBlocked(0) ?? false
  }

  mediaPort(o: { positionS: () => number }): MediaPortAdapter {
    const map = this.map
    const manifest = this.manifest
    if (!map || !manifest) throw new Error('fetch the item first')
    return new MediaPortAdapter({
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
      positionS: o.positionS,
    })
  }

  /** `noSpace`: the save folder cannot take this item, so it never starts and the member reports disk-full. */
  transferPort(o: { settings: () => Settings; noSpace: () => boolean }): TransferPortAdapter {
    return new TransferPortAdapter({
      rateBps: () => this.rate.get(),
      etaToEofS: () => this.lastStats?.etaToEofS ?? null,
      coverage: () => this.timeline?.coverage(this.states) ?? null,
      diskFull: () => o.noSpace() || (this.lastStats?.diskLow ?? false),
      // the host names it in our slow-download warning
      downLimitBps: () => limitBps(o.settings().downloadLimitKBps),
    })
  }

  setUploadLimit(kbps: number | null): void {
    this.transfer?.setUploadLimit(kbps)
  }

  setDownloadLimit(kbps: number | null): void {
    this.transfer?.setDownloadLimit(kbps)
  }

  /** Reports our bt lanes and blocked reads to the host for striping (again, once stopped). */
  report(): void {
    const room = this.room
    const transfer = this.transfer
    if (this.stopLinks || !room || !transfer) return
    this.stopLinks = reportTransferLinks({ room, hostId: room.state().hostKey, transfer, log: this.log })
  }

  /** No more link reports to the host: a closed room has no route to it, and a leave tells it by leaving. */
  stopReporting(): void {
    this.stopLinks?.()
    this.stopLinks = null
  }

  /**
   * Not the item playing any more: mpv's stream server closes and the host hears no more reports about it. Its
   * lanes stay, so others still fetching it are served.
   */
  async stopServing(): Promise<void> {
    this.stopReporting()
    this.mediaListeners.clear()
    this.fileOpened = false
    await this.server?.close().catch(() => undefined)
    this.server = null
  }

  /** Stops serving mpv and the room's lanes; the transfer itself ends with leave(). */
  async close(): Promise<void> {
    await this.stopServing()
    for (const off of this.offs.splice(0)) off()
  }

  /**
   * Ends this item's transfer: 'keep' leaves it resumable, 'save' exports a complete download (consuming the
   * segments), 'delete' removes it. Rejects with CodedError 'incomplete' when segments turned out missing.
   */
  async leave(opts: { data: 'keep' | 'save' | 'delete'; saveDir?: string }): Promise<SavedFiles | null> {
    await this.close()
    const transfer = this.transfer
    if (!transfer) return null
    return transfer.leave(opts)
  }

  /** A notice for this item's download: said with its name when it is not the one playing. */
  static named(n: NoticeEvent, name: string, current: boolean): NoticeEvent {
    return current ? n : { ...n, message: `${name}: ${n.message}` }
  }
}
