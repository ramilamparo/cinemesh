// What the alpha's member children (member-child.ts) and the test process (harness.ts) say to each other over the
// fork IPC channel, and the instrumentation records a child ships. Every time `t` / `at` is the child's
// process.hrtime.bigint() in ms: CLOCK_MONOTONIC on Linux, so stamps from different processes on this machine
// compare directly. Records are tuples to keep the IPC volume down (a viewer makes ~10k block requests per run).

import type { CoreEventName, CoreMethod } from '../../src/shared/ipc/core.js'
import type { Settings } from '../../src/shared/settings.js'

export interface ChildOptions {
  name: string
  /** the member's folder is created under it (harness.ts member()) */
  root: string
  settings?: Partial<Settings>
  /** false: the session's clock-driven fake player instead of the installed mpv (default true) */
  realMpv?: boolean
}

export type ToChild =
  | { t: 'req'; id: number; m: CoreMethod; p: unknown }
  | { t: 'info'; id: number }
  | { t: 'flush'; id: number }
  | { t: 'shutdown'; id: number }

export type FromChild =
  | { t: 'ready'; dir: string; pid: number; perfToHr: number }
  | { t: 'evt'; e: CoreEventName; d: unknown; at: number }
  | { t: 'res'; id: number; ok: true; v: unknown; tReq: number; tRes: number }
  | { t: 'res'; id: number; ok: false; error: string; tReq: number; tRes: number }
  | { t: 'info'; id: number; info: MemberInfo }
  | { t: 'flushed'; id: number }
  | { t: 'logs'; batch: LogBatch }
  | { t: 'down'; id: number }
  /** what src/core/index.ts reports to main as fatal (uncaught) or only logs (unhandled); the child lives on */
  | { t: 'fatal'; kind: 'uncaughtException' | 'unhandledRejection'; message: string; at: number }

export interface ManifestInfo {
  pieceLength: number
  fileSize: number
  durationMs: number
  container: string
  /** [ms, byte]: the manifest's keyframe index (MKV: Cues, so the byte is the Cluster's) */
  keyframes: [number, number][]
  openCritical: [number, number][]
  seekCritical: [number, number][]
}

export interface MemberInfo {
  name: string
  dir: string
  role: 'host' | 'viewer' | null
  /** room member id (64 hex) */
  self: string | null
  roomId: string | null
  infoHash: string | null
  /** viewer: the folder confirmJoin chose (a 'save' exports into it) */
  saveDir: string | null
  /** viewer: <saveDir>/.wt-partial/<infoHash> */
  transferDir: string | null
  manifest: ManifestInfo | null
  pieceCount: number | null
  mpvPid: number | null
}

/** A peer in records: the first 8 hex digits of its member id. */
export type PeerTag = string

/**
 * Viewer: one outgoing block request (wrapped wire.request), checked when it was made:
 * [t, piece, offset, peer, cls, planGen, viol, exempt]. cls: the piece's group in the last plan (0 urgent = blocked
 * readers, hot window, critical ranges; 1 L1; 2 L2; 3 L3; 9 not in the plan). viol: the first piece ahead of it in
 * WebTorrent's walk of the selections that this wire's peer advertised, that we lacked and that still had an
 * unreserved block, i.e. what trySelectWire would have asked for first (-1: none). exempt: such pieces skipped
 * because speedRanker may skip them (this wire is slow, a faster wire advertises them).
 */
export type ReqRec = [number, number, number, PeerTag, number, number, number, number]
/** Host: a request a viewer sent it (the engine counts these as served): [t, piece, offset, length, peer] */
export type ServedRec = [number, number, number, number, PeerTag]
/** Viewer: [t, piece] */
export type VerifiedRec = [number, number]
/** A player property change: [t, name, value] (pause, seeking, paused-for-cache, eof-reached, speed, core-idle) */
export type PropRec = [number, string, unknown]
/** playback-restart: [t, pos] */
export type RestartRec = [number, number | null]
/**
 * The 4 Hz position sampler: [t, rttMs, audioPts, timePos, pause, seeking, pausedForCache, speed] (t: the
 * midpoint of the audio-pts request; flags as 1 / 0, -1 unknown).
 */
export type SampleRec = [number, number, number | null, number | null, number, number, number, number]
/**
 * Host: a piece newly revealed to a viewer: [t, viewer, piece, ctx, path, tick]. ctx: what revealed it (give: the
 * walk's assignment; urgent: the viewer's blocked-reader report; critical; open: shown everything). path for
 * give: walk (nobody holds or was shown it), rescue (shown to another viewer that has not fetched it), holders
 * (somebody holds it, but no lane from them).
 */
export type RevealRec = [number, PeerTag, number, string, string, number]

export interface PlanRec {
  t: number
  gen: number
  p: number | null
  w: number | null
  hot: [number, number] | null
  blocked: number[]
  critical: [number, number][]
  live: [number, number][]
  paused: boolean
}

export interface PlayheadRec {
  t: number
  posS: number | null
  reason: string | null
  seek: boolean
  byte: number
  windowBytes: number
  hotBytes: number
}

export interface BlockedRec {
  t: number
  op: 'add' | 'drop'
  key: string
  piece: number | null
}

export interface GroupPlanRec {
  t: number
  posS: number | null
  reason: string | null
  seek: boolean
  p: number | null
  w: number | null
  hot: [number, number] | null
}

export interface UrgentRec {
  t: number
  viewer: PeerTag
  pieces: number[]
}

export interface TakebackRec {
  t: number
  viewer: PeerTag
  pieces: number[]
  /** the host wire's lt_donthave would send: its _peerSupports, and the id the viewer's handshake gave it */
  peerSupports: boolean | null
  mappingId: number | null
}

/** Viewer: a BEP 54 donthave a peer sent it, as its wire processed it: [t, peer, piece] */
export type DonthaveRec = [number, PeerTag, number]

/**
 * Host, 4 Hz per viewer wire: [t, viewer, queued, unanswered]. queued: bytes the wire has pushed and its upload
 * throttle has not taken yet (the answered blocks waiting in RAM); unanswered: the viewer's requests not answered yet.
 */
export type QueueRec = [number, PeerTag, number, number]

/** Every member, 1 Hz: [t, rss, heapUsed] in bytes (the member's process: the core, not its mpv). */
export type MemRec = [number, number, number]

/** Host: what a viewer's wire was first advertised (the Revealer's bitfield) */
export interface BitfieldRec {
  t: number
  viewer: PeerTag
  pieces: number[]
}

/** Host: a published sync.state (the room's anchor), hostTime converted to the host child's hrtime ms */
export interface AnchorRec {
  t: number
  seq: number
  mode: string
  pos: number
  hostTimeHr: number
}

/**
 * A member's sync decisions around an unpause (MemberController): `beginPlay` (what it plans from: the activity,
 * its target and the exact paused position it sampled, if any), `schedule` (the local unpause instant, as hrtime),
 * `unpause` (when it unpaused) and `lat` (its unpause-latency estimate moved after a probe).
 */
export interface SyncRec {
  t: number
  ev: 'beginPlay' | 'schedule' | 'unpause' | 'lat'
  [k: string]: unknown
}

export interface LogBatch {
  req: ReqRec[]
  served: ServedRec[]
  verified: VerifiedRec[]
  prop: PropRec[]
  restart: RestartRec[]
  sample: SampleRec[]
  reveal: RevealRec[]
  plan: PlanRec[]
  playhead: PlayheadRec[]
  blocked: BlockedRec[]
  gplan: GroupPlanRec[]
  urgent: UrgentRec[]
  takeback: TakebackRec[]
  bitfield: BitfieldRec[]
  anchor: AnchorRec[]
  sync: SyncRec[]
  donthave: DonthaveRec[]
  queue: QueueRec[]
  mem: MemRec[]
}

export function emptyBatch(): LogBatch {
  return {
    req: [],
    served: [],
    verified: [],
    prop: [],
    restart: [],
    sample: [],
    reveal: [],
    plan: [],
    playhead: [],
    blocked: [],
    gplan: [],
    urgent: [],
    takeback: [],
    bitfield: [],
    anchor: [],
    sync: [],
    donthave: [],
    queue: [],
    mem: [],
  }
}

export const LOG_KEYS = Object.keys(emptyBatch()) as (keyof LogBatch)[]

/** Plan classes in ReqRec.cls */
export const CLS = { urgent: 0, l1: 1, l2: 2, l3: 3, none: 9 } as const

export const tag = (id: string | null | undefined): PeerTag => (id ? id.slice(0, 8) : '?')
