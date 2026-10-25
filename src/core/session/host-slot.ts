import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { NoticeEvent, PlaylistPrepareState, PrepareEvent } from '../../shared/ipc/core.js'
import { buildManifest, encodeManifest } from '../../shared/media/manifest.js'
import { MediaMap, needsFullDownload } from '../../shared/media/media-map.js'
import type { ByteRange, Manifest, MediaIndex } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import type { CoreLog } from '../log.js'
import { buildMediaIndex } from '../media/build-index.js'
import { Playhead } from '../media/playhead.js'
import type { MemoryBlobProvider } from '../net/blobs.js'
import type { Room, RoomPeer } from '../net/room.js'
import type { SubtitleSpec } from '../player/player-controller.js'
import type { CarrySub } from '../player/track-carry.js'
import { TransferEngine, type TransferStats } from '../transfer/engine.js'
import { type PreparedTorrent, cacheKeyFor, prepareHost } from '../transfer/host-prepare.js'
import type { HostUplink } from '../transfer/uplink.js'
import { type Announce, MAX_MANIFEST_BYTES } from './announce.js'
import { HASH_FAILS_NOTICE, HashFailWatch } from './hash-fails.js'
import { subtitleFlags } from './playlist-files.js'
import type { PlaylistItemBody } from './playlist-wire.js'
import type { LinkTarget } from './striping.js'
import { Timeline } from './timeline.js'
import { criticalSpans } from './media-checks.js'

/** session.announce body (sticky, host-only): what viewers fetch with blob.get. Hashes are BLAKE2b-256 hex. */
export type AnnounceBody = Announce

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

export interface HostItemInput {
  id: string
  videoPath: string
  subtitlePaths: string[]
}

export interface PrepareCallbacks {
  /** indexing and hashing progress, bytes, from `t0` (performance.now()) */
  onProgress: (p: Pick<PrepareEvent, 'stage' | 'bytesDone' | 'bytesTotal'> & { cached: boolean }, t0: number) => void
  /** the index is known: duration, media kind */
  onIndexed: (index: MediaIndex) => void
}

export interface SeedOptions {
  room: Room
  uploadLimitKBps: number | null
  /** the room's one uplink, and this item's tier in it: 0 while it plays, 1 while viewers fetch it ahead */
  uplink: HostUplink
  tier: 0 | 1
  /** where the playhead starts: the room position (a resume's anchor), else 0 */
  startPosS: number
  log: CoreLog
  /** the source changed or moved, sharing failed, viewers report hash failures */
  notice: (n: NoticeEvent) => void
  /** the video file changed on disk: viewers are told it is gone */
  unavailable: () => void
  /** a shared stats listener (the session's feasibility line follows the current item's) */
  onStats?: (st: TransferStats) => void
}

/**
 * One playlist item on the host (ADR 0011 §2): its video and subtitles, prepared once into a torrent and a
 * manifest of its own (cached per file like a single hosted video), and seeded while it is current or while
 * viewers fetch it ahead. The session owns the order, the room, the player and sync.
 */
export class HostSlot {
  readonly id: string
  readonly videoPath: string
  readonly subtitlePaths: string[]
  readonly name: string
  size = 0
  state: PlaylistPrepareState = 'queued'
  /** of the running stage, 0..1 */
  pct = 0
  error: string | null = null
  private readonly abort = new AbortController()

  index: MediaIndex | null = null
  prepared: PreparedTorrent | null = null
  manifest: Manifest | null = null
  map: MediaMap | null = null
  announce: AnnounceBody | null = null
  timeline: Timeline | null = null
  /** every piece verified: the host has the whole file */
  allVerified = new Uint8Array(0)
  /** what the player adds for this item (local paths) */
  subtitles: SubtitleSpec[] = []

  transfer: TransferEngine | null = null
  /** the item's playhead as host-assigned striping sees it (TransferEngine.setGroupPlayhead) */
  playhead: Playhead | null = null
  lastStats: TransferStats | null = null
  /** a viewer last asked for this item while it was not playing (performance.now()): background seeding lasts */
  wantedAt = 0
  private tier: 0 | 1 = 0
  private seeding: Promise<TransferEngine> | null = null
  private offs: (() => void)[] = []
  /** the latest seed() caller's: a background seed's are replaced once the item plays */
  private handlers: Pick<SeedOptions, 'notice' | 'unavailable' | 'onStats'> | null = null
  /** viewers' hash failures (plan §4.2 "Source-change watchdog"): what the size and mtime checks cannot see */
  readonly hashFails: HashFailWatch

  constructor(
    input: HostItemInput,
    private readonly log: CoreLog,
  ) {
    this.id = input.id
    this.videoPath = input.videoPath
    this.subtitlePaths = input.subtitlePaths
    this.name = basename(input.videoPath)
    this.hashFails = new HashFailWatch(() => {
      this.log.warn(`viewers report pieces of ${this.name} failing their hash check: the source no longer matches`)
      this.handlers?.notice(HASH_FAILS_NOTICE)
    })
  }

  get ready(): boolean {
    return this.state === 'ready'
  }

  get infoHash(): string | null {
    return this.prepared?.infoHash ?? null
  }

  get durationS(): number | null {
    return this.index ? this.index.durationMs / 1000 : null
  }

  get fullDownload(): boolean {
    return this.manifest ? needsFullDownload(this.manifest) : false
  }

  /** The player's view of the next item's external subtitles, for the track carry-over (in the player's order). */
  carrySubs(): CarrySub[] {
    return this.subtitlePaths.map((p) => {
      const f = subtitleFlags(p)
      return { lang: f.lang, forced: f.forced }
    })
  }

  linkTarget(): LinkTarget | null {
    return this.transfer ? { transfer: this.transfer, hashFails: this.hashFails } : null
  }

  /** A queued or failed item can be prepared; preparing it again is a no-op. Throws CodedError on failure. */
  async prepare(opts: {
    cacheRoot: string
    workers: number
    provider: MemoryBlobProvider
    cb: PrepareCallbacks
  }): Promise<void> {
    const signal = this.abort.signal
    const live = (): void => {
      if (signal.aborted) throw new CodedError('cancelled', 'Preparing was cancelled')
    }
    try {
      this.size = (
        await stat(this.videoPath).catch(() => {
          throw new CodedError('file-missing', 'The video file cannot be read')
        })
      ).size
      live()
      // 1. media index (cached per file next to the piece hashes)
      this.state = 'indexing'
      this.pct = 0
      const key = await cacheKeyFor(this.videoPath)
      live()
      const t0 = performance.now()
      const { index } = await buildMediaIndex(this.videoPath, {
        signal,
        cacheDir: join(opts.cacheRoot, key),
        onProgress: (done, total) => {
          this.pct = total ? done / total : 0
          opts.cb.onProgress({ stage: 'indexing', bytesDone: done, bytesTotal: total, cached: false }, t0)
        },
      })
      live()
      this.index = index
      opts.cb.onIndexed(index)

      // 2. piece hashes (cached per file; a hit costs a 3-piece spot check plus the tail)
      this.state = 'hashing'
      this.pct = 0
      const t1 = performance.now()
      const prepared = await prepareHost({
        videoPath: this.videoPath,
        subtitlePaths: this.subtitlePaths,
        cacheRoot: opts.cacheRoot,
        workers: opts.workers,
        signal,
        onProgress: (p) => {
          this.pct = p.bytesTotal ? p.bytesDone / p.bytesTotal : 0
          opts.cb.onProgress(
            { stage: 'hashing', bytesDone: p.bytesDone, bytesTotal: p.bytesTotal, cached: p.cached },
            t1,
          )
        },
      })
      live()

      // 3. manifest + blobs
      const { layout } = prepared
      const subs = layout.files.slice(1)
      const manifest = buildManifest(index, {
        infoHash: Buffer.from(prepared.infoHash, 'hex'),
        pieceLength: layout.pieceLength,
        videoFileIndex: 0,
        externalSubs: subs.map((f) => ({
          fileIndex: f.index,
          name: f.name,
          lang: subtitleFlags(f.name).lang,
          title: f.name,
        })),
      })
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
      const torrentHash = opts.provider.add(prepared.torrent)
      const manifestHash = opts.provider.add(manifestBytes)
      this.prepared = prepared
      this.manifest = manifest
      this.map = new MediaMap(manifest)
      this.timeline = new Timeline(this.map)
      this.allVerified = new Uint8Array(layout.pieceCount).fill(2)
      this.subtitles = this.subtitlePaths.map((p, i) => ({
        url: p,
        title: subs[i]?.name ?? basename(p),
        lang: subtitleFlags(p).lang || null,
      }))
      this.announce = {
        v: 1,
        infoHash: prepared.infoHash,
        torrent: { hash: torrentHash, size: prepared.torrent.byteLength },
        manifest: { hash: manifestHash, size: manifestBytes.byteLength },
        name: this.name,
        fileSize: this.size,
        durationMs: index.durationMs,
      }
      this.state = 'ready'
      this.pct = 1
      this.error = null
    } catch (e) {
      if (!signal.aborted) {
        this.state = 'error'
        this.error = e instanceof Error ? e.message : String(e)
      }
      throw e
    }
  }

  /** Stops a prepare in flight; the item is being removed or the session leaves. */
  cancel(): void {
    this.abort.abort(new CodedError('cancelled', 'Preparing was cancelled'))
  }

  /** The playlist entry for session.playlist. */
  body(): PlaylistItemBody {
    const a = this.announce
    if (!this.ready || !a) {
      return {
        id: this.id,
        name: this.name.slice(0, 255) || 'video',
        fileSize: this.size,
        durationMs: null,
        prepared: false,
      }
    }
    return {
      id: this.id,
      name: this.name.slice(0, 255) || 'video',
      fileSize: this.size,
      durationMs: a.durationMs,
      prepared: true,
      infoHash: a.infoHash,
      torrent: a.torrent,
      manifest: a.manifest,
    }
  }

  /**
   * Seeds this item to every admitted member (idempotent): striping's critical ranges and playhead before any
   * viewer attaches (with no group playhead the first viewer would be shown everything).
   */
  seed(o: SeedOptions): Promise<TransferEngine> {
    // the callbacks are the latest caller's, also for a seed already running (started in the background)
    this.handlers = { notice: o.notice, unavailable: o.unavailable, ...(o.onStats ? { onStats: o.onStats } : {}) }
    if (this.seeding) return this.seeding
    const run: Promise<TransferEngine> = this.startSeeding(o).catch((e: unknown) => {
      if (this.seeding === run) this.seeding = null
      throw e
    })
    this.seeding = run
    return run
  }

  private async startSeeding(o: SeedOptions): Promise<TransferEngine> {
    const prepared = this.prepared
    const manifest = this.manifest
    const map = this.map
    if (!prepared || !manifest || !map) throw new Error('prepare first')
    const transfer = new TransferEngine()
    this.transfer = transfer
    this.tier = o.tier
    try {
      await transfer.startHost(prepared, { uploadLimitKBps: o.uploadLimitKBps, uplink: o.uplink, tier: o.tier })
    } catch (e) {
      // a failed start leaves no engine behind: seeding can be tried again
      if (this.transfer === transfer) this.transfer = null
      await transfer.destroy().catch(() => undefined)
      throw e
    }
    // stopped meanwhile (a leave, a cancel): that destroyed this transfer
    if (this.transfer !== transfer) throw new CodedError('cancelled', 'Seeding was stopped')
    const { layout } = prepared
    transfer.setGroupCriticalRanges(groupCriticalRanges(manifest, layout.files.slice(1), layout))
    this.playhead = new Playhead(map, { setPlayhead: (plan) => transfer.setGroupPlayhead(plan) })
    this.playhead.set(o.startPosS, 'join')
    transfer.on('stats', (st) => {
      this.lastStats = st
      this.handlers?.onStats?.(st)
    })
    transfer.on('source-changed', (c) => {
      if (c.kind === 'changed') {
        this.handlers?.notice({
          level: 'error',
          code: 'transfer.source-changed',
          message: `${this.name} changed on disk, so sharing it stopped. Add it to the playlist again to share it.`,
        })
        this.handlers?.unavailable()
      } else {
        this.handlers?.notice({
          level: 'warn',
          code: 'transfer.source-moved',
          message: `${this.name} was moved; it keeps being shared from the open file.`,
        })
      }
    })
    transfer.on('error', (e) => {
      o.log.error(`sharing ${this.name} failed`, e)
      this.handlers?.notice({ level: 'error', code: 'transfer.failed', message: `Sharing stopped: ${e.message}` })
    })
    const onPeer = (p: RoomPeer): void => transfer.attach(p)
    const onGone = (id: string): void => transfer.detach(id)
    o.room.on('peer', onPeer)
    o.room.on('peer-gone', onGone)
    this.offs.push(
      () => o.room.off('peer', onPeer),
      () => o.room.off('peer-gone', onGone),
    )
    for (const p of o.room.peers()) transfer.attach(p)
    return transfer
  }

  get isSeeding(): boolean {
    return this.transfer !== null
  }

  /** Seeding as an item fetched ahead (tier 1), not the one playing. */
  get inBackground(): boolean {
    return this.transfer !== null && this.tier === 1
  }

  setTier(tier: 0 | 1): void {
    this.tier = tier
    this.transfer?.setTier(tier)
  }

  setUploadLimit(kbps: number | null): void {
    this.transfer?.setUploadLimit(kbps)
  }

  /** Stops seeding; the prepared torrent stays, so seeding again is quick. */
  async stopSeeding(): Promise<void> {
    const transfer = this.transfer
    this.transfer = null
    this.seeding = null
    this.playhead = null
    this.lastStats = null
    for (const off of this.offs.splice(0)) off()
    // not waiting for a start in flight: destroying the engine ends it (startSeeding stands down)
    await transfer?.destroy().catch(() => undefined)
  }

  async destroy(): Promise<void> {
    this.cancel()
    await this.stopSeeding()
  }
}
