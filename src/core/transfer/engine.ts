import { EventEmitter } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type Protomux from 'protomux'
import WebTorrent, { type Torrent, type Wire } from 'webtorrent'
import { WEBTORRENT_OPTIONS } from './client-options.js'
import { DISK_RESERVE_BYTES, freeBytes } from './disk.js'
import { DownloadGate } from './download-gate.js'
import { JOURNAL_FILE, Journal } from './journal.js'
import { BT_PROTOCOL, MuxWireStream } from './mux-wire-stream.js'
import { PieceSource } from './piece-source.js'
import { pieceStates } from './piece-state.js'
import type { PreparedTorrent } from './host-prepare.js'
import { ReadOnlyFileStore } from './readonly-store.js'
import { RECENT_PER_SEGMENT, checkResume } from './resume.js'
import { MAX_URGENT, Revealer } from './revealer.js'
import { IncompleteDownloadError, type SavedFiles, saveFile } from './save-file.js'
import { type ByteRange, type PieceRange, type PlayheadPlan, Scheduler } from './scheduler.js'
import { SEGMENT_BYTES, SegmentStore } from './segment-store.js'
import { limitBps } from '../../shared/limits.js'
import { CodedError } from '../../shared/result.js'
import { SourceFiles } from './source-files.js'
import { type PacedStream, type PacerState, UploadPacer } from './upload-pacer.js'
import { UploadScheduler } from './upload-scheduler.js'
import type { HostUplink, UplinkMember } from './uplink.js'

/** JoinConfirm's space check (see resume.ts): bytes a resume can skip, read-only. */
export { trustedBytes } from './resume.js'

export interface PeerTransferStats {
  id: string
  downBps: number
  upBps: number
  downloaded: number
  uploaded: number
  havePct: number
  requests: number
  peerChoking: boolean
  amChoking: boolean
  seeder: boolean
  /**
   * Lanes to this member that opened after the first one: a count that keeps climbing is a re-attach
   * ratchet (S2). Always set by the engine; optional only for rows built elsewhere.
   */
  reattaches?: number
  /** host: the member is catching up (setViewerCatchUp, ADR 0012) */
  catchUp?: boolean
}

export interface TransferStats {
  downBps: number
  upBps: number
  progress: number
  verifiedPieces: number
  pieceCount: number
  missingAheadBytes: number
  etaToEofS: number | null
  /** host: bytes served / distinct block bytes served */
  dupFactor?: number
  /** host: the upload scheduler's rate and the pacer's view of the uplink (ADR 0006) */
  uplink?: UplinkStats
  diskLow: boolean
  /** viewer: downloaded pieces that failed their hash check (plan §4.2 "Source-change watchdog") */
  hashFails?: HashFailStats
  peers: PeerTransferStats[]
}

/** A viewer's hash failures since its join: data that reached it but did not match the torrent. */
export interface HashFailStats {
  /** failed checks, all pieces together (a piece that failed twice counts twice) */
  total: number
  /** [piece, failures] of the pieces that failed most, most first (then lowest piece); MAX_HASH_FAIL_PIECES at most */
  worst: [number, number][]
}

export interface UplinkStats {
  /** what the host releases at, bytes/s: the upload limit or the paced rate, whichever is lower; null = neither */
  rateBps: number | null
  /** the pacer's estimate of the queueing delay towards the viewers, ms; null without a fresh sample */
  queueMs: number | null
  /** 'start' while the pacer ramps up (no queue found yet, or after 5 s with little to send); 'steady' once it has */
  state: PacerState
}

interface TransferEvents {
  'pieces-changed': [Uint8Array]
  /** viewer: blockedPieces() changed (coalesced per microtask), for an immediate report to the host */
  'blocked-changed': [number[]]
  verified: [number]
  stats: [TransferStats]
  'disk-low': [boolean]
  done: []
  'source-changed': [{ kind: 'changed' | 'moved'; index: number }]
  error: [Error]
}

/** What attach() needs from a room peer (net's RoomPeer satisfies it). */
export interface AttachablePeer {
  readonly id: string
  readonly publicKey: Buffer
  readonly mux: Protomux
}

interface Attachment {
  peer: AttachablePeer
  stream: MuxWireStream | null
  retries: number
  /** lanes that opened (both sides) */
  opens: number
  paired: boolean
  timer: ReturnType<typeof setTimeout> | null
}

/** What the engine reads of a connection's UDX stream (rawStream; the counters are patches/udx-native+1.21.3.patch). */
interface UdxStream {
  bytesWritten: number
  bytesAcked: number
  inflight: number
  /** smoothed RTT, ms */
  rtt: number
  bytesTransmitted: number
}

const REATTACH_BACKOFF_MS = [1000, 2000, 5000, 10_000]
const STABLE_MS = 30_000
const STATS_MS = 1000
const PIECES_MIN_MS = 250
const PIECES_IDLE_MS = 5000
const JOURNAL_MS = 2000
/** a segment synced this long before a journal save still counts as dirty on resume */
const RECENT_MS = 30_000
const DISK_CHECK_MS = 30_000
const SOURCE_CHECK_MS = 10_000
const CACHE_BYTES = 16 * 1024 * 1024
const UPLOAD_SLOTS = 16
const BLOCK = 16 * 1024
/** WebTorrent drops a wire that asks for more in one request (torrent.js MAX_BLOCK_LENGTH) */
const MAX_REQUEST_BYTES = 128 * 1024
// BEP 10 reqq: the most block requests a peer may keep outstanding to us. WebTorrent otherwise pipelines
// ~1 s of the wire's rate (torrent.js:2207-2219) and bittorrent-protocol answers all of it at once, so the
// uploader holds ~1 s of upload in RAM (S2: host RSS +207 MB at 132 MB/s; with 256: +95 MB, same rate).
export const REQQ = 256
/** how many pieces HashFailStats.worst names */
export const MAX_HASH_FAIL_PIECES = 8
/** The viewer's copy of the session manifest (plan §4.2 "Viewer storage"), beside meta.torrent; a resume reads it. */
export const MANIFEST_FILE = 'manifest.bin'
/**
 * Host, an item viewers fetch ahead (shared uplink tier 1): held requests a wire got nothing for in this long are
 * refused, well inside the viewer's 30 s request timeout (WebTorrent's PIECE_TIMEOUT drops the wire after it).
 */
export const BACKGROUND_MAX_HOLD_MS = 10_000
/**
 * WebTorrent's only sign of a downloaded piece that failed its hash check (torrent.js:2010, 3.0.21): the piece is
 * reset and fetched again, nothing else is emitted. Pinned with the version; an integration test fails if it changes.
 */
const HASH_FAIL_WARNING = /^Piece (\d+) failed verification$/

/**
 * The transfer module's facade (plan §5.3 "transfer"): one WebTorrent client per session, running only
 * over MuxWireStreams on room connections. Host: seeds the original files read-only. Viewer: downloads
 * into segment files in the R6 order, journals progress, watches disk space, serves the stream server.
 */
export class TransferEngine extends EventEmitter<TransferEvents> {
  private client: WebTorrent | null = null
  private torrent: Torrent | null = null
  private role: 'host' | 'viewer' | null = null
  private source: SourceFiles | null = null
  private segments: SegmentStore | null = null
  private journal: Journal | null = null
  private scheduler: Scheduler | null = null
  private pieceSource: PieceSource | null = null
  private dir: string | null = null
  private infoHashBuf: Buffer | null = null
  /** captured at 'ready': WebTorrent empties torrent.files on destroy, which an error can cause early */
  private files: { name: string; offset: number; length: number }[] = []
  private readonly attached = new Map<string, Attachment>()
  private readonly unattachedStreams: MuxWireStream[] = []
  private readonly streamPeer = new Map<string, string>()
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private verifiedSinceFlush: number[] = []
  /** segment → its last journaled pieces and when (saved as the journal's `recent`) */
  private readonly recent = new Map<number, { pieces: number[]; at: number }>()
  private states: Uint8Array = new Uint8Array(0)
  private lastPiecesEmit = 0
  private piecesDirty = false
  private playheadByte = 0
  private diskLow = false
  /** viewer: piece -> how often it failed its hash check (at most one entry per piece) */
  private readonly hashFails = new Map<number, number>()
  private hashFailTotal = 0
  private servedBlocks: Map<number, Uint8Array> | null = null
  private servedBytes = 0
  private distinctServedBytes = 0
  private writeLag = false
  private schedulerPaused = false
  private sourceState: 'ok' | 'moved' | 'changed' = 'ok'
  private checkingSource = false
  /** the torrent closed on its own (a store error, or the source changed): no lane may be opened again */
  private torrentClosed = false
  /** the latest limit asked for: the client is created several awaits into a start, and must start with it */
  private uploadLimitKBps: number | null = null
  /** viewer: the latest download limit asked for, kept the same way */
  private downloadLimitKBps: number | null = null
  /** viewer: the download limit, on the requests its torrent sends (ADR 0010); created with the torrent */
  private downloadGate: DownloadGate | null = null
  /** host: striping, created at 'ready'; the inputs below are kept for it (they may come before) */
  private revealer: Revealer | null = null
  /** host: requests released just in time, urgent first, at the rate below (ADR 0006); created at 'ready' */
  private uploadScheduler: UploadScheduler | null = null
  private uploadPacer: UploadPacer | null = null
  /** host, playlist: the uplink this torrent shares with the room's other items, and this torrent's tier in it */
  private uplink: HostUplink | null = null
  private uplinkTier: 0 | 1 = 0
  private uplinkLeave: (() => void) | null = null
  private readonly uplinkMember: UplinkMember = {
    scheduler: () => this.uploadScheduler,
    streams: () => this.pacedStreams(),
  }
  /** host wire -> its connection's UDX stream; null once known not to be one */
  private readonly udxOfWire = new WeakMap<Wire, UdxStream | null>()
  private groupPlan: PlayheadPlan | null = null
  private groupCritical: readonly ByteRange[] = []
  private readonly viewerLinks = new Map<string, readonly string[]>()
  private readonly viewerUrgent = new Map<string, readonly number[]>()
  private readonly viewerCatchUp = new Map<string, PieceRange>()
  /** viewer: the last blockedPieces() emitted, and whether an emit is queued */
  private blockedSent = ''
  private blockedQueued = false
  private flushing: Promise<void> = Promise.resolve()
  private flushWaiting: Promise<void> | null = null
  private starting: Promise<unknown> | null = null
  private leaving: Promise<SavedFiles | null> | null = null
  private destroying: Promise<void> | null = null
  private destroyed = false

  get infoHash(): string | null {
    return this.torrent?.infoHash ?? null
  }

  /** The stream server's source (viewers only). */
  get streamSource(): PieceSource | null {
    return this.pieceSource
  }

  /**
   * Rejects with code 'cancelled' when destroy()/leave() ran before the torrent was ready. The upload limit
   * is taken now; a setUploadLimit() during the start wins over it.
   */
  async startHost(
    prepared: PreparedTorrent,
    opts: {
      uploadLimitKBps: number | null
      /**
       * A playlist's shared uplink (ADR 0011 §5): its pacer and bucket instead of this torrent's own; `tier` 0 for the
       * item playing, 1 for one viewers fetch ahead.
       */
      uplink?: HostUplink
      tier?: 0 | 1
    },
  ): Promise<void> {
    this.begin('host')
    this.uploadLimitKBps = opts.uploadLimitKBps
    this.uplink = opts.uplink ?? null
    this.uplinkTier = opts.tier ?? 0
    const run = this.hostStart(prepared)
    this.starting = run.catch(() => undefined)
    return run
  }

  /**
   * Rejects with code 'cancelled' when destroy()/leave() ran before the torrent was ready. The limits are
   * taken now; a setUploadLimit() or setDownloadLimit() during the start wins over them.
   */
  async joinAsViewer(opts: {
    torrent: Buffer
    /** the session manifest, verified: kept as MANIFEST_FILE beside meta.torrent */
    manifest?: Uint8Array
    dir: string
    uploadLimitKBps: number | null
    /** KiB/s; absent, null or 0 = unlimited */
    downloadLimitKBps?: number | null
  }): Promise<{ resumedPieces: number }> {
    this.begin('viewer')
    this.dir = opts.dir // known at once: a leave({ data: 'delete' }) during the start still finds it
    this.uploadLimitKBps = opts.uploadLimitKBps
    this.downloadLimitKBps = opts.downloadLimitKBps ?? null
    const run = this.viewerStart(opts)
    this.starting = run.catch(() => undefined)
    return run
  }

  /**
   * Open the bt lane to a room member; re-opened with backoff while the member stays attached.
   * Protomux rejects a remote's channel open unless this side created the channel or a pair() handler
   * claims it, so whichever member opens first, the other creates its side on demand.
   * Refused once the torrent is gone (closed by an error, or the host's source changed).
   */
  attach(peer: AttachablePeer): void {
    if (this.destroyed || this.torrentClosed || this.sourceState === 'changed' || this.attached.has(peer.id)) return
    const a: Attachment = { peer, stream: null, retries: 0, opens: 0, paired: false, timer: null }
    this.attached.set(peer.id, a)
    this.open(a)
  }

  detach(peerId: string): void {
    const a = this.attached.get(peerId)
    if (!a) return
    this.attached.delete(peerId)
    if (a.timer) clearTimeout(a.timer)
    if (this.infoHashBuf) a.peer.mux.unpair({ protocol: BT_PROTOCOL, id: this.infoHashBuf })
    a.stream?.destroy()
  }

  setPlayhead(plan: PlayheadPlan): void {
    this.playheadByte = plan.byte
    this.scheduler?.setPlayhead(plan)
  }

  setCriticalRanges(ranges: readonly ByteRange[]): void {
    this.scheduler?.setCriticalRanges(ranges)
  }

  /**
   * Host: the room's playhead, the same plan viewers pass to setPlayhead (before every group seek and at
   * 1 Hz while playing). Host-assigned striping reveals pieces in that order; a seek reassigns.
   */
  setGroupPlayhead(plan: PlayheadPlan): void {
    this.groupPlan = plan
    this.revealer?.setPlan(plan)
  }

  /** Host: open-critical ranges and the subtitle files, in torrent bytes: revealed to every viewer at once. */
  setGroupCriticalRanges(ranges: readonly ByteRange[]): void {
    this.groupCritical = [...ranges]
    this.revealer?.setCriticalRanges(ranges)
  }

  /**
   * Host: the members viewer `memberId` has an open bt lane to (its linkedPeers(), as it reports them). A
   * lane counts once both ends report it; only viewers linked to every other linked viewer are given pieces
   * alone, and a viewer with no lane reported gets what it lacks from the host, at its own pace, once its lane to
   * the host is 2 s old (until then its lanes may just not be reported yet: reports come at 1 Hz).
   */
  setViewerLinks(memberId: string, linked: readonly string[]): void {
    this.viewerLinks.set(memberId, [...linked])
    this.revealer?.setLinks(memberId, linked)
  }

  /**
   * Host: the pieces viewer `memberId` has an HTTP reader blocked on (its blockedPieces(), as it reports them).
   * With striping a viewer can fetch only what the host revealed to it, and the walk may not reach these for a
   * while: they are revealed to it at once, outside its budget, and kept while reported (also for a lane that
   * re-attaches), unless a viewer it has a lane to holds one or is fetching it (then it comes from there, and
   * readers waiting on the same piece after a group seek do not each get it from the host). That wait lasts at most
   * 3 s plus two pieces at one lane's share of the host upload (~9 s for 1 MiB at 1 MB/s and 3 viewers) from the
   * first report of the piece. Each report replaces the last (a piece still in it keeps its first time); an empty
   * list clears it. At most 16 are taken.
   */
  setViewerUrgent(memberId: string, pieces: readonly number[]): void {
    const before = this.viewerUrgent.get(memberId) ?? []
    const kept = pieces.slice(0, MAX_URGENT)
    if (kept.length > 0) this.viewerUrgent.set(memberId, kept)
    else this.viewerUrgent.delete(memberId)
    this.revealer?.setUrgent(memberId, kept)
    // a reader blocked on a new piece: the viewer's held filler requests are rejected behind the 'have' just sent,
    // so its WebTorrent refills those slots at once with the blocked piece (ADR 0006 §3.4: request out at 52 ms, not
    // 248). They were never served: nothing leaves the host twice
    if (kept.some((i) => !before.includes(i))) this.uploadScheduler?.preempt(memberId)
  }

  /**
   * Host: viewer `memberId` is catching up (ADR 0012; the session decides who, from the members' sync statuses), and
   * `range` is the media just ahead of its playhead, in pieces; null ends it. Its upload requests go first within a
   * class, it is shown the pieces of that range it lacks (held by other viewers or not), a few at a time, and it
   * gets no other striping work meanwhile. On the start, its held filler requests outside the range are rejected, so
   * its WebTorrent refills those slots with the range.
   */
  setViewerCatchUp(memberId: string, range: PieceRange | null): void {
    const starting = range !== null && !this.viewerCatchUp.has(memberId)
    if (range) this.viewerCatchUp.set(memberId, range)
    else this.viewerCatchUp.delete(memberId)
    this.revealer?.setCatchUp(memberId, range)
    if (starting) this.uploadScheduler?.preempt(memberId, (i) => i >= range[0] && i <= range[1])
  }

  /** Host: a viewer left: forget its reports; what it was given alone and did not fetch is assigned again. */
  removeViewer(memberId: string): void {
    this.viewerLinks.delete(memberId)
    this.viewerUrgent.delete(memberId)
    this.viewerCatchUp.delete(memberId)
    this.revealer?.removeViewer(memberId)
  }

  /** Viewer: the members this engine has an open, handshaken bt wire to (the host's setViewerLinks input). */
  linkedPeers(): string[] {
    const ids = new Set<string>()
    for (const [streamId, p] of this.torrent?._peers ?? []) {
      const id = this.streamPeer.get(streamId)
      if (id && p.wire && !p.wire.destroyed && p.wire.peerId) ids.add(id)
    }
    return [...ids].sort()
  }

  /**
   * Viewer: the pieces an HTTP reader is blocked on, ascending (the host's setViewerUrgent input). Report them
   * on 'blocked-changed' as well as periodically: a striping host reveals a piece outside its plan only then.
   */
  blockedPieces(): number[] {
    return this.scheduler?.blockedPieces() ?? []
  }

  /**
   * Viewer: the downloaded pieces that failed their hash check, reported to the host (striping.ts): the same piece
   * failing again and again means the host serves bytes that no longer match what it prepared.
   */
  hashFailures(): HashFailStats {
    const worst = [...this.hashFails].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_HASH_FAIL_PIECES)
    return { total: this.hashFailTotal, worst }
  }

  /**
   * KiB/s; null or 0 = unlimited. Kept for a client that does not exist yet. A host enforces it in its upload
   * scheduler (with the pacer's rate, whichever is lower); a viewer in WebTorrent's upload throttle.
   */
  /** Host with a shared uplink: whether this torrent is the item playing (0) or one fetched ahead (1). */
  setTier(tier: 0 | 1): void {
    this.uplinkTier = tier
    this.uplink?.setTier(this.uplinkMember, tier)
  }

  setUploadLimit(kbps: number | null): void {
    this.uploadLimitKBps = kbps
    if (this.role === 'host') this.uploadScheduler?.setRate(this.uploadRateBps())
    else this.client?.throttleUpload(kbps ? kbps * 1024 : -1)
  }

  /**
   * Viewer: KiB/s; null or 0 = unlimited. Kept for a torrent that does not exist yet. It limits the block requests the
   * viewer sends (download-gate.ts, ADR 0010), never WebTorrent's read throttle. A host downloads nothing: no effect.
   */
  setDownloadLimit(kbps: number | null): void {
    this.downloadLimitKBps = kbps
    this.downloadGate?.setRate(limitBps(kbps))
  }

  pieceStates(): Uint8Array {
    const t = this.torrent
    if (t && !t.destroyed) this.states = pieceStates(t, this.states)
    return this.states
  }

  /**
   * Stops the session. 'keep' leaves the download resumable, 'save' exports the completed file (consuming
   * the segments), 'delete' removes it, also when the torrent never got ready. Idempotent: the first
   * call's options win.
   */
  leave(opts: { data: 'keep' | 'save' | 'delete'; saveDir?: string }): Promise<SavedFiles | null> {
    this.leaving ??= this.stop(opts)
    return this.leaving
  }

  /** Idempotent: every caller gets the same shutdown. */
  destroy(): Promise<void> {
    this.destroying ??= this.shutdown()
    return this.destroying
  }

  // ---- internals ------------------------------------------------------------------------------

  private begin(role: 'host' | 'viewer'): void {
    if (this.destroyed) throw new CodedError('cancelled', 'the transfer was stopped')
    if (this.role) throw new Error('a transfer session is already running')
    this.role = role
  }

  /** After every await in a start: a leave may have destroyed the engine meanwhile. */
  private assertLive(): void {
    if (this.destroyed) throw new CodedError('cancelled', 'the transfer was stopped')
  }

  private async hostStart(prepared: PreparedTorrent): Promise<void> {
    this.infoHashBuf = Buffer.from(prepared.infoHash, 'hex')
    this.source = new SourceFiles(prepared.sources)
    await this.source.openAll() // held from now on: a later rename is a move, served on from these fds
    this.assertLive()
    const client = this.newClient()
    const t = client.add(prepared.torrent, {
      store: ReadOnlyFileStore,
      storeOpts: { source: this.source },
      skipVerify: true,
      uploads: UPLOAD_SLOTS,
      storeCacheSlots: Math.max(1, Math.floor(CACHE_BYTES / prepared.layout.pieceLength)),
    })
    await this.whenReady(t)
    this.assertLive()
    this.every(SOURCE_CHECK_MS, () => void this.checkSource())
    this.startLoops()
  }

  private async viewerStart(opts: {
    torrent: Buffer
    manifest?: Uint8Array
    dir: string
    uploadLimitKBps: number | null
    downloadLimitKBps?: number | null
  }): Promise<{ resumedPieces: number }> {
    await mkdir(opts.dir, { recursive: true })
    this.assertLive()
    await writeFile(join(opts.dir, 'meta.torrent'), opts.torrent)
    // written in the start, so a 'delete' leave (which awaits the start) never races it; a torn copy fails its hash
    if (opts.manifest) await writeFile(join(opts.dir, MANIFEST_FILE), opts.manifest)
    this.assertLive()
    const peek = await import('parse-torrent').then((m) => m.default(opts.torrent))
    this.assertLive()
    this.infoHashBuf = Buffer.from(peek.infoHash, 'hex')
    for (const a of this.attached.values()) this.open(a) // peers attached before the torrent was known
    const journal = await Journal.open(join(opts.dir, JOURNAL_FILE), peek.infoHash, peek.pieces.length)
    this.assertLive()
    await checkResume(journal, opts.dir, {
      pieceLength: peek.pieceLength,
      length: peek.length,
      pieces: peek.pieces,
      segmentBytes: SEGMENT_BYTES,
    })
    this.assertLive()
    this.journal = journal
    const client = this.newClient()
    // Always pass the journal's bitfield (all zeros on a fresh download): without a startup bitfield
    // WebTorrent reads every piece to check for existing data (torrent.js _verifyPieces).
    const t = client.add(opts.torrent, {
      store: SegmentStore,
      storeOpts: {
        dir: opts.dir,
        segmentBytes: SEGMENT_BYTES,
        onCreate: (s: SegmentStore) => (this.segments = s),
        onDiskFull: () => this.setDiskLow(true),
        onDiskOk: () => void this.checkDisk(),
        onWriteLag: (lagging: boolean) => {
          this.writeLag = lagging
          this.applyPause()
        },
      },
      bitfield: journal.bitfield(),
      deselect: true,
      strategy: 'sequential',
      uploads: UPLOAD_SLOTS,
      storeCacheSlots: Math.max(1, Math.floor(CACHE_BYTES / peek.pieceLength)),
    })
    // before any wire: no request goes out unchecked. The kick re-runs the requests once the gate lets them go
    const gate = new DownloadGate({
      kick: () => {
        if (!t.destroyed) t._update()
      },
    })
    gate.setRate(limitBps(this.downloadLimitKBps))
    t._requestGate = gate
    this.downloadGate = gate
    await this.whenReady(t)
    this.assertLive()
    this.files = t.files.map((f) => ({ name: f.name, offset: f.offset, length: f.length }))
    // pieces WebTorrent's own probe found bad must not be trusted on the next resume
    for (let i = 0; i < t.pieces.length; i++) if (t.pieces[i] !== null) journal.clear(i)
    void this.flushJournal() // saves those clears, in turn with the periodic flushes
    this.scheduler = new Scheduler(t, { onBlocked: () => this.blockedChanged() })
    this.applyPause() // a disk-low or write-lag signal may have come before the scheduler existed
    this.pieceSource = new PieceSource(t, this.scheduler)
    t.on('verified', (i: number) => {
      this.verifiedSinceFlush.push(i)
      this.piecesDirty = true
      this.emit('verified', i)
    })
    t.on('done', () => this.emit('done'))
    t.on('warning', (e: unknown) => {
      const m = e instanceof Error ? HASH_FAIL_WARNING.exec(e.message) : null
      if (!m) return
      const i = Number(m[1])
      this.hashFails.set(i, (this.hashFails.get(i) ?? 0) + 1)
      this.hashFailTotal++
    })
    // a resumed download may already be complete: WebTorrent emitted 'done' with 'ready', before any of
    // our listeners; deferred so the caller can subscribe once this resolves
    if (t.pieces.every((p) => p === null)) {
      setImmediate(() => {
        if (!this.destroyed) this.emit('done')
      })
    }
    this.every(JOURNAL_MS, () => void this.flushJournal())
    this.every(DISK_CHECK_MS, () => void this.checkDisk())
    void this.checkDisk()
    this.startLoops()
    return { resumedPieces: t.pieces.filter((p) => p === null).length }
  }

  private async stop(opts: { data: 'keep' | 'save' | 'delete'; saveDir?: string }): Promise<SavedFiles | null> {
    const t = this.torrent
    const done = !!t?.ready && t.pieces.every((p) => p === null) // pieces is [] until the metadata is in
    await this.flushJournal()
    await this.destroy()
    const dir = this.dir
    if (this.role !== 'viewer' || !dir) return null
    if (opts.data === 'delete') {
      // a start still running stops at its next step; only after that can nothing write into the folder
      await this.starting
      await rm(dir, { recursive: true, force: true })
      return null
    }
    await this.flushJournal() // pieces verified while the store was closing (closing synced them)
    if (opts.data === 'keep') return null
    if (!done) throw new Error('the download is not complete yet')
    if (!opts.saveDir) throw new Error('no folder to save into')
    const saved = await saveFile({
      dir,
      segmentBytes: SEGMENT_BYTES,
      files: this.files,
      destDir: opts.saveDir,
      consume: true,
    }).catch(async (e: unknown) => {
      // segments lost after the join (resume checks only run then): nothing was consumed, and a later
      // session must download those pieces again rather than trust the journal
      if (e instanceof IncompleteDownloadError) await this.forgetSegments(e.segments)
      throw e
    })
    await rm(dir, { recursive: true, force: true })
    return saved
  }

  private async forgetSegments(segments: readonly number[]): Promise<void> {
    const journal = this.journal
    const t = this.torrent
    if (!journal || !t) return
    const P = t.pieceLength
    const n = t.pieces.length
    for (const k of segments) {
      const last = Math.min(n, Math.ceil(((k + 1) * SEGMENT_BYTES) / P))
      for (let i = Math.floor((k * SEGMENT_BYTES) / P); i < last; i++) journal.clear(i)
    }
    await journal.save().catch(() => undefined) // checkResume also clears them at the next join
  }

  private async shutdown(): Promise<void> {
    this.destroyed = true
    for (const t of this.timers) clearInterval(t)
    for (const id of [...this.attached.keys()]) this.detach(id)
    this.scheduler?.destroy()
    this.revealer?.destroy()
    this.uploadPacer?.destroy()
    this.uplinkLeave?.()
    this.uploadScheduler?.destroy()
    this.downloadGate?.destroy()
    this.pieceSource?.destroy()
    const client = this.client
    if (client) await new Promise<void>((resolve) => client.destroy(() => resolve()))
    await this.source?.close()
  }

  /** Torrent and client errors go to the session; with no listener they must not throw from WebTorrent's callbacks. */
  private readonly forwardError = (e: Error): void => {
    if (this.listenerCount('error') > 0) this.emit('error', e)
  }

  private newClient(): WebTorrent {
    const client = new WebTorrent({ ...WEBTORRENT_OPTIONS, maxConns: 32 })
    client.on('error', this.forwardError)
    // the host's limit is its upload scheduler's (WebTorrent's throttle holds a second of data, unfair between wires)
    if (this.uploadLimitKBps && this.role === 'viewer') client.throttleUpload(this.uploadLimitKBps * 1024)
    this.client = client
    return client
  }

  /**
   * Resolves on 'ready'. Until then a torrent error rejects (the start fails, nothing is forwarded) and
   * so does a close (destroy() during the start); from then on errors are forwarded to the session.
   * The per-wire hooks are installed synchronously on 'ready', before any peer can be added.
   */
  private whenReady(t: Torrent): Promise<void> {
    this.torrent = t
    // for good, before and after ready: a dead torrent takes no more lanes (WebTorrent never resets `ready`)
    t.once('close', () => this.onTorrentClosed())
    return new Promise<void>((resolve, reject) => {
      const settle = (err: Error | null): void => {
        t.removeListener('error', onError)
        t.removeListener('close', onClose)
        t.removeListener('ready', onReady)
        if (err) {
          reject(err)
        } else {
          t.on('error', this.forwardError)
          this.installWireHooks(t)
          resolve()
        }
      }
      const onError = (e: unknown): void => settle(e instanceof Error ? e : new Error(String(e)))
      const onClose = (): void => settle(new CodedError('cancelled', 'the transfer was stopped'))
      const onReady = (): void => settle(null)
      t.on('error', onError)
      t.on('close', onClose)
      t.on('ready', onReady)
      if (t.ready) settle(null)
    }).then(() => {
      if (t.destroyed) return
      for (const s of this.unattachedStreams.splice(0)) if (!s.destroyed) t.addPeer(s)
      for (const a of this.attached.values()) if (!a.stream) this.open(a)
    })
  }

  /**
   * 'wire' is emitted inside the wire's handshake handler, before our extended handshake and our piece
   * advertisement go out (bittorrent-protocol index.js:633-642, torrent.js:1383-1390), so whatever is set
   * here is what the peer sees first.
   */
  private installWireHooks(t: Torrent): void {
    t.on('wire', (wire: Wire) => {
      wire.extendedHandshake.reqq = REQQ // host and viewers alike: viewers upload to each other
    })
    if (this.role === 'host') {
      this.servedBlocks = new Map()
      t.on('wire', (wire: Wire) => this.countServed(t, wire))
      const revealer = new Revealer(t, {
        memberOf: (wire) => this.memberOf(t, wire),
        // its budget R and its urgent wait follow what the host really sends at: the limit or the paced rate
        uploadLimitBps: () => (this.uploadLimitKBps ? this.uploadLimitKBps * 1024 : null),
        pacedBps: () => (this.uplink ? this.uplink.pacedBps : (this.uploadPacer?.rateBps ?? null)),
        uploadBps: () => t.uploadSpeed,
      })
      if (this.groupPlan) revealer.setPlan(this.groupPlan)
      revealer.setCriticalRanges(this.groupCritical)
      for (const [id, linked] of this.viewerLinks) revealer.setLinks(id, linked)
      for (const [id, pieces] of this.viewerUrgent) revealer.setUrgent(id, pieces)
      for (const [id, range] of this.viewerCatchUp) revealer.setCatchUp(id, range)
      revealer.start()
      this.revealer = revealer
      // after the Revealer's 'wire' listener: a request is offered to its onArrival before it is held
      const uplink = this.uplink
      const uploads = new UploadScheduler(t, {
        memberOf: (wire) => this.memberOf(t, wire),
        classOf: (piece) => revealer.classOf(piece),
        boosted: (member) => revealer.catchingUp(member),
        transport: (wire) => this.transportOf(t, wire),
        onArrival: (wire, piece) => revealer.onArrival(wire, piece),
        ...(uplink
          ? {
              bucket: uplink.bucket,
              mayRelease: () => uplink.mayRelease(this.uplinkMember),
              maxHoldMs: () => (this.uplinkTier === 1 ? BACKGROUND_MAX_HOLD_MS : null),
            }
          : {}),
      })
      this.uploadScheduler = uploads
      if (uplink) {
        this.uplinkLeave = uplink.register(this.uplinkMember, this.uplinkTier)
        uploads.setRate(this.uploadRateBps())
        uploads.start()
        return
      }
      this.uploadPacer = new UploadPacer({
        apply: () => uploads.setRate(this.uploadRateBps()),
        sentBytes: () => uploads.sentBytes,
        streams: () => this.pacedStreams(),
      })
      uploads.setRate(this.uploadRateBps())
      uploads.start()
      this.uploadPacer.start()
    }
  }

  /** Host: the upload limit or the paced rate, whichever is lower, bytes/s; null = neither applies. */
  private uploadRateBps(): number | null {
    if (this.uplink) return this.uplink.rateBps()
    const limit = this.uploadLimitKBps ? this.uploadLimitKBps * 1024 : null
    const paced = this.uploadPacer?.rateBps ?? null
    if (limit === null || paced === null) return limit ?? paced
    return Math.min(limit, paced)
  }

  /** Host: the UDX stream under a wire's lane, as the upload scheduler reads it (unsent = written − acked − inflight). */
  private transportOf(t: Torrent, wire: Wire): { unsentBytes: number; ackedBytes: number } | null {
    let raw = this.udxOfWire.get(wire)
    if (raw === undefined) {
      const id = this.memberOf(t, wire)
      const a = id === null ? undefined : this.attached.get(id)
      if (!a) return null // not mapped yet
      raw = udxOf(a.peer)
      this.udxOfWire.set(wire, raw)
    }
    if (!raw) return null
    return { unsentBytes: raw.bytesWritten - raw.bytesAcked - raw.inflight, ackedBytes: raw.bytesAcked }
  }

  /** Host: every attached viewer's UDX stream, for the pacer. */
  private pacedStreams(): PacedStream[] {
    const out: PacedStream[] = []
    for (const a of this.attached.values()) {
      const raw = udxOf(a.peer)
      if (raw) out.push({ id: a.peer.id, rttMs: raw.rtt, bytesSent: raw.bytesTransmitted, stream: raw })
    }
    return out
  }

  /** The member behind a wire: its peer's id is the MuxWireStream's id (attach() maps it to the member). */
  private memberOf(t: Torrent, wire: Wire): string | null {
    for (const [streamId, p] of t._peers ?? []) if (p.wire === wire) return this.streamPeer.get(streamId) ?? null
    return null
  }

  /** The torrent closed on its own: drop every lane, and open none again (attach() refuses too). */
  private onTorrentClosed(): void {
    if (this.destroyed) return
    this.torrentClosed = true
    this.revealer?.destroy()
    this.uploadPacer?.destroy()
    this.uplinkLeave?.()
    this.uploadScheduler?.destroy()
    this.downloadGate?.destroy()
    for (const s of this.unattachedStreams.splice(0)) s.destroy()
    for (const id of [...this.attached.keys()]) this.detach(id)
  }

  private current(a: Attachment): boolean {
    return !this.destroyed && !this.torrentClosed && this.attached.get(a.peer.id) === a
  }

  private open(a: Attachment): void {
    const id = this.infoHashBuf
    if (!id || !this.current(a) || a.stream) return // re-run once the torrent is known
    if (!a.paired) {
      a.paired = true
      a.peer.mux.pair({ protocol: BT_PROTOCOL, id }, () => {
        if (this.current(a) && !a.stream) this.open(a)
      })
    }
    const stream = MuxWireStream.open(a.peer.mux, id, a.peer.publicKey)
    if (!stream) {
      this.retry(a) // the previous channel is still closing
      return
    }
    a.stream = stream
    this.streamPeer.set(stream.id, a.peer.id)
    let openedAt = 0
    stream.once('close', () => {
      this.streamPeer.delete(stream.id)
      if (a.stream !== stream) return
      a.stream = null
      // only a channel that was up for a while resets the backoff (never-opened ones keep growing it)
      if (openedAt && Date.now() - openedAt > STABLE_MS) a.retries = 0
      this.retry(a)
    })
    void stream.opened.then((ok) => {
      if (!ok || stream.destroyed || !this.current(a)) return
      openedAt = Date.now()
      a.opens++
      const t = this.torrent
      // a torrent that died meanwhile: addPeer would throw ('torrent is destroyed')
      if (t?.destroyed) stream.destroy()
      else if (t?.ready) t.addPeer(stream)
      else this.unattachedStreams.push(stream)
    })
  }

  private retry(a: Attachment): void {
    if (!this.current(a) || a.timer) return
    const delay = REATTACH_BACKOFF_MS[Math.min(a.retries, REATTACH_BACKOFF_MS.length - 1)] ?? 10_000
    a.retries++
    a.timer = setTimeout(() => {
      a.timer = null
      this.open(a)
    }, delay)
    a.timer.unref()
  }

  private startLoops(): void {
    this.every(STATS_MS, () => this.emit('stats', this.stats()))
    this.every(PIECES_MIN_MS, () => {
      const now = Date.now()
      if (!this.piecesDirty && now - this.lastPiecesEmit < PIECES_IDLE_MS) return
      this.piecesDirty = false
      this.lastPiecesEmit = now
      this.emit('pieces-changed', this.pieceStates())
    })
  }

  private every(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms))
  }

  /** A reader blocked or unblocked: one 'blocked-changed' per burst, and only when the list really changed. */
  private blockedChanged(): void {
    if (this.blockedQueued) return
    this.blockedQueued = true
    queueMicrotask(() => {
      this.blockedQueued = false
      const pieces = this.blockedPieces()
      const key = pieces.join(',')
      if (this.destroyed || key === this.blockedSent) return
      this.blockedSent = key
      this.emit('blocked-changed', pieces)
    })
  }

  private stats(): TransferStats {
    const t = this.torrent
    if (!t || t.destroyed) {
      return {
        downBps: 0,
        upBps: 0,
        progress: 0,
        verifiedPieces: 0,
        pieceCount: 0,
        missingAheadBytes: 0,
        etaToEofS: null,
        diskLow: this.diskLow,
        peers: [],
      }
    }
    const n = t.pieces.length
    let verified = 0
    let missingAhead = 0
    const from = Math.floor(this.playheadByte / t.pieceLength)
    for (let i = 0; i < n; i++) {
      if (t.pieces[i] === null) verified++
      else if (i >= from) missingAhead += i === n - 1 ? t.lastPieceLength : t.pieceLength
    }
    const peers: PeerTransferStats[] = []
    for (const [streamId, p] of t._peers ?? []) {
      const w = p.wire
      const peerId = this.streamPeer.get(streamId)
      if (!w || !peerId) continue
      let have = 0
      for (let i = 0; i < n; i++) if (w.peerPieces.get(i)) have++
      peers.push({
        id: peerId,
        downBps: w.downloadSpeed(),
        upBps: w.uploadSpeed(),
        downloaded: w.downloaded,
        uploaded: w.uploaded,
        havePct: n ? have / n : 0,
        requests: w.requests.length,
        peerChoking: w.peerChoking,
        amChoking: w.amChoking,
        seeder: have === n,
        reattaches: Math.max(0, (this.attached.get(peerId)?.opens ?? 1) - 1),
        ...(this.viewerCatchUp.has(peerId) ? { catchUp: true } : {}),
      })
    }
    const down = t.downloadSpeed
    return {
      downBps: down,
      upBps: t.uploadSpeed,
      progress: n ? verified / n : 0,
      verifiedPieces: verified,
      pieceCount: n,
      missingAheadBytes: missingAhead,
      etaToEofS: missingAhead === 0 ? 0 : down > 0 ? missingAhead / down : null,
      ...(this.role === 'host' && this.distinctServedBytes > 0
        ? { dupFactor: this.servedBytes / this.distinctServedBytes }
        : {}),
      ...(this.uploadPacer || (this.uplink && this.uploadScheduler)
        ? {
            uplink: {
              rateBps: this.uploadRateBps(),
              queueMs: this.uplink ? this.uplink.queueMs : (this.uploadPacer?.queueMs ?? null),
              state: this.uplink ? this.uplink.state : (this.uploadPacer?.state ?? 'start'),
            },
          }
        : {}),
      diskLow: this.diskLow,
      ...(this.role === 'viewer' ? { hashFails: this.hashFailures() } : {}),
      peers,
    }
  }

  /**
   * Host: bytes served vs distinct 16 KiB blocks served, i.e. how often the same data left the host.
   * Only requests WebTorrent can serve count: a member may send any numbers, and each new piece index
   * would otherwise grow the map.
   */
  private countServed(t: Torrent, wire: Wire): void {
    const n = t.pieces.length
    const blocksPerPiece = Math.ceil(t.pieceLength / BLOCK)
    wire.on('request', (index: number, offset: number, length: number) => {
      const map = this.servedBlocks
      if (!map || !Number.isInteger(index) || index < 0 || index >= n) return
      const size = index === n - 1 ? t.lastPieceLength : t.pieceLength
      if (length <= 0 || length > MAX_REQUEST_BYTES || offset < 0 || offset + length > size) return
      this.servedBytes += length
      let blocks = map.get(index)
      if (!blocks) {
        blocks = new Uint8Array(blocksPerPiece)
        map.set(index, blocks)
      }
      const b = Math.floor(offset / BLOCK)
      if (blocks[b] === 0) {
        blocks[b] = 1
        this.distinctServedBytes += length
      }
    })
  }

  /**
   * Serialized: one flush runs and at most one waits (picking up everything verified meanwhile), so a slow
   * fdatasync never stacks flushes up or lets two share state.json.tmp. Never rejects; what fails is
   * retried by the next flush.
   */
  private flushJournal(): Promise<void> {
    if (this.flushWaiting) return this.flushWaiting
    const next = this.flushing
      .then(() => {
        this.flushWaiting = null
        return this.flushOnce()
      })
      .catch(() => undefined)
    this.flushWaiting = next
    this.flushing = next
    return next
  }

  private async flushOnce(): Promise<void> {
    const journal = this.journal
    if (!journal) return
    const segments = this.segments
    const pending = this.verifiedSinceFlush
    this.verifiedSinceFlush = []
    // durable before the journal claims them (plan §4.2 "Journal")
    let synced = pending.length === 0
    if (!synced && segments) {
      try {
        await segments.syncDirty()
        synced = true
      } catch {
        // syncFailed() names the segments that failed; pieces elsewhere are durable all the same
      }
    }
    const now = Date.now()
    for (const i of pending) {
      const k = segments?.segmentOf(i)
      if (k === undefined || k === null || (!synced && segments?.syncFailed(i))) {
        this.verifiedSinceFlush.push(i) // its segment did not sync: the next flush tries again
        continue
      }
      journal.mark(i)
      const last = [...(this.recent.get(k)?.pieces ?? []), i].slice(-RECENT_PER_SEGMENT)
      this.recent.delete(k) // Map order doubles as recency order
      this.recent.set(k, { pieces: last, at: now })
    }
    for (const [k, e] of this.recent) if (now - e.at > RECENT_MS) this.recent.delete(k)
    journal.setRecent([...this.recent.values()].flatMap((e) => e.pieces))
    await journal.save() // also retries a save that failed and persists the startup clears
  }

  private async checkDisk(): Promise<void> {
    if (!this.dir) return
    const free = await freeBytes(this.dir).catch(() => Number.POSITIVE_INFINITY)
    if (this.destroyed) return
    if (free < DISK_RESERVE_BYTES) this.setDiskLow(true)
    else if (this.diskLow && free >= DISK_RESERVE_BYTES + SEGMENT_BYTES && !this.segments?.diskFull)
      this.setDiskLow(false)
  }

  private setDiskLow(low: boolean): void {
    if (this.diskLow === low) return
    this.diskLow = low
    this.applyPause()
    this.emit('disk-low', low)
  }

  /** The scheduler stops asking for data while the disk is full or writes lag behind the network (R7). */
  private applyPause(): void {
    const pause = this.diskLow || this.writeLag
    if (pause === this.schedulerPaused || !this.scheduler) return
    this.schedulerPaused = pause
    if (pause) this.scheduler.pause()
    else this.scheduler.resume()
  }

  /** Latched: 'moved' is reported once; 'changed' stops seeding for good (bytes no longer match the hashes). */
  private async checkSource(): Promise<void> {
    if (this.sourceState === 'changed' || this.checkingSource) return
    this.checkingSource = true
    try {
      const change = await this.source?.check().catch(() => ({ kind: 'changed' as const, index: 0 }))
      if (this.destroyed || !change || change.kind === 'ok' || change.kind === this.sourceState) return
      this.sourceState = change.kind
      if (change.kind === 'changed') {
        for (const id of [...this.attached.keys()]) this.detach(id)
        this.torrent?.destroy({ destroyStore: false })
      }
      this.emit('source-changed', change)
    } finally {
      this.checkingSource = false
    }
  }
}

/** The UDX stream under a lane's connection (Protomux → NoiseSecretStream → rawStream); null on anything else. */
function udxOf(peer: AttachablePeer): UdxStream | null {
  const raw = (peer.mux.stream as { rawStream?: Partial<UdxStream> | null } | null)?.rawStream
  if (typeof raw?.bytesWritten !== 'number' || typeof raw.bytesAcked !== 'number') return null
  return raw as UdxStream
}
