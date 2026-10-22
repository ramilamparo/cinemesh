// Renderer <-> core contract, carried over a MessagePort that main brokers (plan §5.1).
// Wire: renderer sends {t:'hello'} then {t:'req'}; core answers {t:'snapshot'}, {t:'res'} and pushes {t:'evt'}.

import type { StartMode } from '../settings.js'

export const CORE_PROTOCOL = 1

export type Role = 'host' | 'viewer'
export type PeerPath = 'lan' | 'direct' | 'relayed' | 'via-peer' | 'none'
export type NatClass = 'OPEN' | 'CONSISTENT' | 'RANDOM' | 'UNKNOWN'
/**
 * 'ended': the host closed the room (viewers then choose save / keep / delete). The video reaching its end
 * while the room stays open is `SyncEvent.mode === 'ended'`, with the phase still 'in-room'.
 *
 * 'leaving' (added): session.leave or transfer.saveFile is running; a 'save' export can take minutes. The next
 * session event is 'idle' (or the leave request fails). The event carries the session's role, roomId and file,
 * and `SessionEvent.leave` says what kind of leave runs; the renderer keeps the screen the leave started on (the
 * Room, or JoinConfirm / HostPrepare / the error screen for their Cancel).
 */
export type SessionPhase =
  'idle' | 'preparing' | 'connecting' | 'pending-admission' | 'confirm-join' | 'in-room' | 'ended' | 'error' | 'leaving'
export type SyncMode = 'idle' | 'paused' | 'playing' | 'waiting' | 'ended'
export type MemberPhase =
  'joining' | 'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'buffering' | 'ended' | 'no-player' | 'disk-full'
export type IntentRejection = 'perm-playpause' | 'perm-seek' | 'superseded' | 'stale' | 'not-ready' | 'timeout'
export type LeaveData = 'keep' | 'save' | 'delete'
export type PlayerStatus =
  | 'absent'
  | 'spawning'
  | 'connecting'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'closedByUser'
  | 'crashed'
  | 'missing'
  | 'tooOld'
/** [startSeconds, endSeconds] */
export type Span = [number, number]

export interface Versions {
  app: string
  electron: string | null
  node: string
  chrome: string | null
  protocol: number
}

export interface Perms {
  othersPlayPause: boolean
  othersSeek: boolean
}

export type PlaybackIntent =
  { kind: 'play' | 'pause' | 'toggle' } | { kind: 'seek'; posS: number } | { kind: 'seekRel'; deltaS: number }

export interface NatReport {
  class: NatClass
  host: string | null
  port: number | null
  bootstrapped: boolean
  hint: string | null
}

export interface CoreDiagnostics {
  versions: Versions
  uptimeS: number
  eventLoopDelayP99Ms: number | null
  rssBytes: number
  nat: NatReport | null
  peers: { id: string; path: PeerPath; rttMs: number | null }[]
  mpv: { path: string | null; version: string | null; vo: string | null; hwdec: string | null }
  logTail: string[]
}

/** A room this machine hosted or joined before; listed on Home so it can be resumed. */
export interface RecentRoom {
  roomId: string
  name: string
  role: Role
  fileName: string
  fileSize: number
  /** wall-clock ms */
  lastActiveAt: number
  /** viewer: fraction of the file on disk (0..1); host: 1 */
  progress: number
  /** false when the source file (host) or the partial data (viewer) is gone */
  resumable: boolean
  /**
   * Added (round 5), viewer: a 'save' of this room's video that a quit, a crash or a missing drive cut off. While it is
   * set, Home offers Finish saving and Cancel saving (transfer.finishExport) instead of Resume, and session.resume,
   * session.join of this room and transfer.deleteData refuse it ('busy'). `dest`: the folder it saves into; `waiting`:
   * that folder is not there now (a drive or share to connect). `running` (added): core is finishing it right now, or has
   * it queued (at startup, or another window's Finish saving): Finish and Cancel saving would only answer 'busy'.
   */
  export?: { name: string; dest: string; waiting: boolean; running?: boolean }
}

// ---- requests -------------------------------------------------------------------------------

type Empty = Record<string, never>

export interface CoreRequests {
  'app.ping': { params: Empty; result: { pong: true; versions: Versions } }
  'session.host': { params: { videoPath: string; subtitlePaths: string[] }; result: { roomId: string; invite: string } }
  'session.join': { params: { invite: string }; result: { roomId: string } }
  'session.confirmJoin': { params: { dir: string }; result: null }
  'session.resume': { params: { roomId: string }; result: { roomId: string } }
  'session.leave': { params: { data: LeaveData; end?: boolean }; result: null }
  'session.cancelPrepare': { params: Empty; result: null }
  /** Recent rooms, newest first (added for Home → Resume). */
  'session.recent': { params: Empty; result: RecentRoom[] }
  /** Free space and writability of a candidate save folder (added for JoinConfirm → Change). */
  'session.checkDir': { params: { dir: string }; result: { freeBytes: number; writable: boolean } }
  'room.invite': { params: Empty; result: { invite: string; link: string; text: string } }
  'room.rotateInvite': { params: Empty; result: { invite: string; link: string; text: string } }
  'room.admit': { params: { peerId: string; allow: boolean }; result: null }
  'room.kick': { params: { peerId: string; rotate: boolean }; result: null }
  'room.setAdmission': { params: { mode: 'open' | 'approve' }; result: null }
  'room.setMaxMembers': { params: { n: number }; result: null }
  'sync.setPerms': { params: Perms; result: null }
  'sync.setWaitForAll': { params: { on: boolean }; result: null }
  'sync.setStartMode': { params: StartMode; result: null }
  'sync.startAnyway': { params: Empty; result: null }
  'sync.request': { params: { kind: 'play' | 'pause' | 'seek'; posS?: number }; result: null }
  'playback.intent': { params: PlaybackIntent; result: { accepted: boolean; reason?: IntentRejection } }
  'player.setTrack': { params: { kind: 'audio' | 'sub'; id: number | 'no' }; result: null }
  'player.setVolume': { params: { volume: number; muted: boolean }; result: null }
  'player.reopen': { params: Empty; result: null }
  /**
   * Viewer, whole video downloaded: exports it (into `dest`, else the folder chosen when joining), which leaves the
   * room like session.leave {data: 'save'} but answers with the saved file's path, so the UI can show it. Refused
   * with 'incomplete' while the download is not complete; 'incomplete' after the export started (missing parts)
   * means the room was left with its download kept, so rejoining fetches what is missing.
   */
  'transfer.saveFile': { params: { dest?: string }; result: { path: string } }
  'transfer.deleteData': { params: { infoHash: string }; result: null }
  /**
   * Added (round 5): finishes a room's cut-off save (RecentRoom.export) without the network. 'finished' gives the saved
   * file's path (and core posts transfer.export-finished); 'waiting': its folder is not there (connect the drive, then
   * try again; nothing changed); 'rejoin': data it needed is gone, so the room is resumable again and Resume downloads
   * the missing parts (core posts transfer.export-failed with the reason). `giveUp: true` drops the save instead (also
   * when its folder is gone for good): what it had moved into the saved file counts as missing again, its partly saved
   * file is deleted when reachable, and the result is 'rejoin' with no notice; but a video found saved in full (renamed
   * before the cut, or journaled done) finishes instead: 'finished' with its path. Refused with 'busy' while that save
   * runs, 'not-found' when the room has no cut-off save.
   */
  'transfer.finishExport': {
    params: { roomId: string; giveUp?: boolean }
    result: { outcome: 'finished' | 'waiting' | 'rejoin'; path?: string }
  }
  'net.test': { params: Empty; result: NatReport }
  'diagnostics.get': { params: Empty; result: CoreDiagnostics }
}

export type CoreMethod = keyof CoreRequests
export type ParamsOf<M extends CoreMethod> = CoreRequests[M]['params']
export type ResultOf<M extends CoreMethod> = CoreRequests[M]['result']

// ---- events ---------------------------------------------------------------------------------

export interface SessionEvent {
  phase: SessionPhase
  role: Role | null
  roomId: string | null
  fileName: string | null
  fileSize: number | null
  durationS: number | null
  /** haveBytes (added): bytes already on disk from an earlier session, so they need no new space */
  joinInfo?: { name: string; size: number; dir: string; freeBytes: number; haveBytes?: number }
  error?: { code: string; message: string }
  /**
   * Added: what the index found, once known (host after indexing; viewer after the manifest arrives).
   * fullDownload: the file can only play once completely downloaded (fMP4 without sidx, or with a sidx per
   * fragment: FFmpeg reads it to the end at open, ADR 0004 §8.2); viewers wait for the whole file, and the host
   * is told how to remux it. interleave (added in round 4, optional for older emitters): 'poor' when audio and video
   * sit far apart in the file, so streaming needs more data before it can start or seek (plan §4.3).
   */
  media?: {
    container: string
    seekMode: 'index' | 'linear'
    fullDownload: boolean
    interleave?: 'good' | 'poor' | 'unknown'
  }
  /**
   * Added, only with phase 'leaving': what the running leave does, so a renderer reloaded mid-leave can still say
   * "Saving the video…" and main can word its quit prompt. 'save' is session.leave {data: 'save'} or
   * transfer.saveFile; a host's leave is 'end' with {end: true}, else 'keep' (the room stays resumable).
   */
  leave?: LeaveData | 'end'
}

/**
 * The host's own preparation progress. Also sent:
 * - to a viewer in 'connecting' / 'pending-admission' while the host is still preparing (core forwards the
 *   host's session.preparing as prepare events, bytesDone / bytesTotal = pct × 1000);
 * - on the host about once a second while in the room, to keep `feasibility` current.
 */
export interface PrepareEvent {
  stage: 'indexing' | 'hashing' | 'ready'
  bytesDone: number
  bytesTotal: number
  bytesPerSec: number
  cached: boolean
  /**
   * Added for the HostPrepare feasibility line, in bytes per second: the upload the group needs from the
   * host (≈ media bitrate × expected duplication) and the host's upload capacity, when known: the peak measured
   * upload, or once the upload pacer found the uplink to be the bottleneck, its best rate of the last 10 s.
   */
  feasibility?: { needBps: number; uploadBps: number | null }
}

export interface RoomEvent {
  roomId: string
  name: string
  invite?: string
  nat: { class: NatClass; host: string | null }
  relay: { status: 'none' | 'ok' | 'unreachable' }
  admission: 'open' | 'approve'
  maxMembers: number
  /** `via` (added, round 5): the name of the member that relayed this request, for a joiner that cannot reach the host. */
  pending: { id: string; name: string; via?: string }[]
}

export interface PeerView {
  id: string
  name: string
  role: Role
  self: boolean
  path: PeerPath
  rttMs: number | null
  phase: MemberPhase
  driftMs: number | null
  bufferedAheadS: number | null
  downBps: number
  upBps: number
  /** 0-100 */
  havePct: number
  /** 256 buckets over the duration, base64; bit set = downloaded. Shown on the host. */
  coverage: string | null
  /** Added: the member's last reported playback position, for the timeline peer markers. */
  posS?: number | null
  warnings: string[]
  exempt: boolean
  lastError?: { code: string; hint: string }
}

export interface PlaybackEvent {
  posS: number
  durationS: number | null
  paused: boolean
  seeking: boolean
  stalled: boolean
  /** core monotonic ms when posS was sampled; the UI extrapolates while playing */
  at: number
}

export interface SyncEvent {
  mode: SyncMode
  perms: Perms
  canPlayPause: boolean
  canSeek: boolean
  waitForAll: boolean
  startMode: StartMode
  wait?: {
    reason: 'seek' | 'buffering' | 'start' | 'join'
    /** Display names (not peer ids) of the members the room is waiting for; the UI shows them as they are. */
    waitingFor: string[]
    softDeadline: number | null
  }
  cause?: { by: string; kind: string; from?: number; to?: number }
}

export interface TimelineEvent {
  durationS: number
  done: Span[]
  loading: Span[]
  buffered: Span[]
  /** host only: spans every viewer has */
  groupDone?: Span[]
}

export interface TransferEvent {
  downBps: number
  upBps: number
  progress: number
  missingAheadBytes: number
  etaToEofS: number | null
  dupFactor?: number
  /**
   * Host: what its upload scheduler releases at (bytes/s: the upload limit or the paced rate, whichever is lower;
   * null = neither), the pacer's queueing-delay estimate towards the viewers (ms) and its state (ADR 0006).
   */
  uplink?: { rateBps: number | null; queueMs: number | null; state: 'start' | 'steady' }
  diskLow: boolean
}

export interface TrackInfo {
  id: number
  title: string | null
  lang: string | null
  codec: string | null
  default: boolean
  forced: boolean
  external: boolean
}

export interface TracksEvent {
  audio: TrackInfo[]
  sub: TrackInfo[]
  aid: number | 'no'
  sid: number | 'no'
  volume: number
  muted: boolean
}

export interface PlayerEvent {
  status: PlayerStatus
  version: string | null
  hdr: {
    source: 'sdr' | 'hdr' | 'unknown'
    output: 'passthrough' | 'tonemapped' | 'sdr' | 'unknown'
    maxCll?: number
    targetPeak?: number
    gpuContext: string | null
    hwdec: string | null
  }
}

export interface NoticeEvent {
  level: 'info' | 'warn' | 'error'
  code: string
  message: string
  action?: { label: string; request: CoreMethod; params: unknown }
  /** Added: a file the notice is about (e.g. the video an interrupted export finished saving); the UI offers Show in folder. */
  path?: string
}

export interface CoreEvents {
  session: SessionEvent
  prepare: PrepareEvent
  room: RoomEvent
  peers: PeerView[]
  playback: PlaybackEvent
  sync: SyncEvent
  timeline: TimelineEvent
  transfer: TransferEvent
  tracks: TracksEvent
  player: PlayerEvent
  notice: NoticeEvent
}

export type CoreEventName = keyof CoreEvents

/** Latest value of every state-like event; `notice` is transient and never part of it. */
export type CoreSnapshot = { versions: Versions } & Partial<Omit<CoreEvents, 'notice'>>

// ---- wire -----------------------------------------------------------------------------------

export type RendererToCore = { t: 'hello'; v: number } | { t: 'req'; id: number; m: CoreMethod; p: unknown }

export type CoreToRenderer =
  | { t: 'snapshot'; d: CoreSnapshot }
  | { t: 'res'; id: number; ok: true; v: unknown }
  | { t: 'res'; id: number; ok: false; code: string; msg: string }
  | { t: 'evt'; e: CoreEventName; d: unknown }

export const CORE_ERRORS = {
  notImplemented: 'not-implemented',
  badRequest: 'bad-request',
  internal: 'internal',
  coreRestarted: 'core-restarted',
  protocol: 'protocol-mismatch',
} as const
