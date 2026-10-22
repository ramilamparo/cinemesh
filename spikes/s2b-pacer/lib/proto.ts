// Shared by the driver (run.ts) and the members (member.ts): configuration, commands, the clock, stats helpers.

/** ms on CLOCK_MONOTONIC: every process on the machine shares it (no time namespace), so one-way delays are exact */
export const now = (): number => Number(process.hrtime.bigint()) / 1e6

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** How the host answers requests (lib/upload-sched.ts). */
export type SchedMode = 'off' | 'monitor' | 'jit'
/** 'off': FIFO; 'wire': lowest class first within each wire; 'global': also hold other wires' less urgent releases */
export type UrgentMode = 'off' | 'wire' | 'global'

export interface PacerConfig {
  /** queueing delay the pacer aims for, ms */
  targetMs: number
  /** lower bound of the paced rate, bytes/s */
  minBps: number
  /** token bucket depth of the paced throttle, seconds of rate (WebTorrent's own is 1 s) */
  burstS: number
  /** what drives it (lib/pacer.ts): the ctrl or datagram pings' one-way delay, or UDX's own smoothed RTT */
  signal: 'ctrl' | 'dgram' | 'udx'
  /** tuning (lib/pacer.ts; the defaults are the matrix's): the current-delay filter, ms */
  currentMs?: number
  /** no second cut this soon after one unless the queue grew by half, ms */
  holdMs?: number
  /** growth per tick above the rate of the last cut, x (target - queue) / target */
  probe?: number
}

export interface MemberConfig {
  role: 'host' | 'viewer'
  name: string
  /** run directory: reports and the viewers' download folders */
  dir: string
  /** testnet bootstrap, host:port */
  bootstrap: string
  /** viewers */
  invite?: string
  sourcePath: string
  torrentPath: string
  cacheRoot: string
  pieceLength: number
  /** host: the app's upload limit (KiB/s), null = none */
  uploadLimitKBps: number | null
  sched: SchedMode
  urgent: UrgentMode
  /** jit: each wire keeps this much of its drain rate queued */
  jitTargetMs: number
  /** jit: floor of a wire's queue, bytes */
  jitMinBytes: number
  /** jit with a rate: depth of the release token bucket, ms of the rate */
  jitBurstMs: number
  /** jit: reject a viewer's held class-2 requests when its reader blocks on a new piece */
  preempt: boolean
  /** jit: a wire's queue reaches down into UDX's send queue (lib/upload-sched.ts) */
  jitUdx: boolean
  pacer: PacerConfig | null
  /** bytes per second of the simulated video (the room's playhead) */
  bitrate: number
  /** read-through after a seek, pieces */
  readPieces: number
  pingMs: number
  viewers: number
  /** seek targets (the host's PRNG) */
  seed: number
}

/** driver -> member, one JSON line on stdin */
export type Command =
  | { t: 'start' }
  | { t: 'mark'; name: string; at: number }
  | { t: 'seek' }
  | { t: 'far'; viewer: number }
  | { t: 'finish' }

/** member -> driver, one JSON line on stdout */
export type MemberEvent =
  | { ev: 'up'; id: string }
  | { ev: 'invite'; code: string }
  | { ev: 'mesh'; peers: number; phase: string }
  | { ev: 'started' }
  | { ev: 'seek'; seq: number; S: number; at: number }
  | { ev: 'far'; seq: number; K: number; viewer: string; at: number }
  | { ev: 'trial'; trial: Trial }
  | { ev: 'report'; path: string }
  | { ev: 'log'; msg: string }
  | { ev: 'error'; msg: string }

export interface PieceRead {
  piece: number
  /** the reader blocked on it (null: it was there already) */
  blockedAt: number | null
  verifiedAt: number | null
}

export interface Trial {
  kind: 'seek' | 'far'
  seq: number
  viewer: string
  /** host: when it decided (seek: setGroupPlayhead + the ctrl frames) */
  hostAt: number
  /** viewer: when the ctrl frame arrived */
  recvAt: number
  reads: PieceRead[]
  aborted: boolean
}

export const DGRAM_PREFIX = 0x7e
export const CTRL_NS = 's2b'

export function pct(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const k = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))
  return s[k]
}

export function median(values: readonly number[]): number | null {
  return pct(values, 50)
}

export const round = (x: number | null | undefined, digits = 1): number | null =>
  x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(digits))
