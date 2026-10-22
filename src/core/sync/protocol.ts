import { z } from 'zod'
import { StartModeSchema } from '../../shared/settings.js'

// Sync messages on the room bus (plan §5.2) and the binary datagrams beside them.

export const SYNC_V = 1

const MODES = ['idle', 'paused', 'playing', 'waiting', 'ended'] as const
const PHASES = [
  'joining',
  'loading',
  'ready',
  'playing',
  'paused',
  'seeking',
  'buffering',
  'ended',
  'no-player',
  'disk-full',
] as const
const WAIT_REASONS = ['seek', 'buffering', 'start', 'join'] as const
const REJECTIONS = ['perm-playpause', 'perm-seek', 'superseded', 'stale', 'not-ready', 'timeout'] as const

const u32 = z.number().int().min(0).max(0xffff_ffff)
const num = z.number()
const pos = z.number().min(0)
const peerId = z.string().min(1).max(128)

/**
 * The v1 warning codes, all a member ever sends: an older host fails a whole sync.status on a code it does not know
 * (and so stops hearing that member). A new condition is worked out on the host, not sent.
 */
export const WarningCodeSchema = z.enum(['slow-download', 'frame-drops'])
export type WarningCode = z.infer<typeof WarningCodeSchema>

export function isWarningCode(s: string): s is WarningCode {
  return (WarningCodeSchema.options as readonly string[]).includes(s)
}

export const CauseSchema = z.object({
  by: peerId,
  kind: z.enum(['play', 'pause', 'seek', 'wait', 'resume', 'ended', 'perms', 'start-anyway', 'timeout', 'restore']),
  from: pos.optional(),
  to: pos.optional(),
  /** host time it happened; tells two identical causes apart */
  at: num.optional(),
})
export type Cause = z.infer<typeof CauseSchema>

export const WaitSchema = z.object({
  reason: z.enum(WAIT_REASONS),
  /** buffering: how far the group was ahead of the member that stalled */
  aheadS: num,
  waitingFor: z.array(peerId).max(16),
  /** host time of the soft timeout; null when there is none (start gate) */
  softDeadline: num.nullable(),
  /** what the group does once everyone is ready (a pause during a barrier makes this 'paused') */
  resumeAs: z.enum(['playing', 'paused']),
  /** play-through start mode: estimated seconds until everyone is ready */
  etaS: num.nullable().optional(),
})
export type Wait = z.infer<typeof WaitSchema>

export const PermsSchema = z.object({ othersPlayPause: z.boolean(), othersSeek: z.boolean() })

export const SyncStateSchema = z.object({
  t: z.literal('sync.state'),
  v: z.literal(SYNC_V),
  syncEpoch: u32,
  seq: u32,
  mode: z.enum(MODES),
  anchor: z.object({ pos, hostTime: num, rate: z.literal(1) }),
  wait: WaitSchema.optional(),
  perms: PermsSchema,
  waitForAll: z.boolean(),
  startMode: StartModeSchema,
  cause: CauseSchema.nullable(),
  members: z.array(z.object({ peerId, name: z.string().max(64), phase: z.enum(PHASES), exempt: z.boolean() })).max(16),
  /** host time when published; members derive their state lag from it */
  sentAt: num,
})
export type SyncState = z.infer<typeof SyncStateSchema>

export const SyncStatusSchema = z.object({
  t: z.literal('sync.status'),
  syncEpoch: u32,
  seq: u32,
  phase: z.enum(PHASES),
  /** seq of the state this member last settled for (paused at its anchor with readiness passed) */
  barrierId: u32.optional(),
  pos,
  driftMs: num.nullable(),
  bufferedAheadS: num,
  rateBps: num,
  needBps: num,
  coverage: z.string().max(64).nullable(),
  canNudge: z.boolean(),
  lagMs: num,
  clockErrMs: num.nullable(),
  frameDrops: z.number().int().min(0),
  /** codes this version does not know are dropped, not the status */
  warnings: z
    .array(z.string().max(32))
    .max(8)
    .transform((ws) => ws.filter(isWarningCode)),
  /** seconds until the member has everything to EOF (play-through start mode) */
  etaS: num.nullable().optional(),
  /**
   * Added: how far behind the room the member is while its own desync warning shows (DesyncMonitor). Optional: an
   * older host strips it, an older viewer never sends it. Not a warning code, which an older host would refuse.
   */
  behindS: pos.optional(),
  /** Added: the member's own download limit, bytes/s, sent only when set. Optional, like behindS. */
  downLimitBps: pos.optional(),
})
export type SyncStatus = z.infer<typeof SyncStatusSchema>

export const IntentKindSchema = z.enum(['play', 'pause', 'seek'])
export type IntentKind = z.infer<typeof IntentKindSchema>

export const SyncIntentSchema = z.object({
  t: z.literal('sync.intent'),
  intentId: z.string().min(1).max(64),
  kind: IntentKindSchema,
  pos: pos.optional(),
  basedOnSeq: u32,
})
export type SyncIntent = z.infer<typeof SyncIntentSchema>

export const SyncIntentResultSchema = z.object({
  t: z.literal('sync.intentResult'),
  intentId: z.string().min(1).max(64),
  accepted: z.boolean(),
  reason: z.enum(REJECTIONS).optional(),
})
export type SyncIntentResult = z.infer<typeof SyncIntentResultSchema>

export const SyncRequestSchema = z.object({ t: z.literal('sync.request'), kind: IntentKindSchema, pos: pos.optional() })
export type SyncRequest = z.infer<typeof SyncRequestSchema>

export const SyncHelloSchema = z.object({
  t: z.literal('sync.hello'),
  resume: z.object({ syncEpoch: u32, seq: u32 }).nullable(),
})
export type SyncHello = z.infer<typeof SyncHelloSchema>

export const SyncPingSchema = z.object({ t: z.literal('sync.ping'), id: u32, t0: num })
export const SyncPongSchema = z.object({ t: z.literal('sync.pong'), id: u32, t0: num, t1: num, t2: num })
export type SyncPing = z.infer<typeof SyncPingSchema>
export type SyncPong = z.infer<typeof SyncPongSchema>

export const SyncBusMessageSchema = z.discriminatedUnion('t', [
  SyncStateSchema,
  SyncStatusSchema,
  SyncIntentSchema,
  SyncIntentResultSchema,
  SyncRequestSchema,
  SyncHelloSchema,
  SyncPingSchema,
  SyncPongSchema,
])
export type SyncBusMessage = z.infer<typeof SyncBusMessageSchema>

/** null for anything malformed or not ours; peers are untrusted. */
export function parseBusMessage(raw: unknown): SyncBusMessage | null {
  const r = SyncBusMessageSchema.safeParse(raw)
  return r.success ? r.data : null
}

/** Is (epoch, seq) newer than what a member holds? A different epoch is a new session and always wins. */
export function isNewer(held: { syncEpoch: number; seq: number } | null, next: { syncEpoch: number; seq: number }) {
  return held === null || held.syncEpoch !== next.syncEpoch || next.seq > held.seq
}

// ---- datagrams: [0x53][ver][type] then little-endian fields -------------------------------------

export const DGRAM_MAGIC = 0x53
export const DGRAM_V = 1
export const DGRAM_PING = 1
export const DGRAM_PONG = 2
export const DGRAM_STATE_FAST = 3

export type SyncMode = (typeof MODES)[number]

export type Datagram =
  | { type: typeof DGRAM_PING; id: number; t0: number }
  | { type: typeof DGRAM_PONG; id: number; t0: number; t1: number; t2: number }
  | {
      type: typeof DGRAM_STATE_FAST
      syncEpoch: number
      seq: number
      mode: SyncMode
      pos: number
      hostTime: number
      /** host time of publication; added so members can measure lag from whichever copy arrives first */
      sentAt: number
    }

const HEADER = 3
const SIZES = { [DGRAM_PING]: HEADER + 4 + 8, [DGRAM_PONG]: HEADER + 4 + 24, [DGRAM_STATE_FAST]: HEADER + 9 + 24 }

export function encodeDatagram(d: Datagram): Uint8Array {
  const buf = new Uint8Array(SIZES[d.type])
  const v = new DataView(buf.buffer)
  buf[0] = DGRAM_MAGIC
  buf[1] = DGRAM_V
  buf[2] = d.type
  switch (d.type) {
    case DGRAM_PING:
      v.setUint32(3, d.id, true)
      v.setFloat64(7, d.t0, true)
      break
    case DGRAM_PONG:
      v.setUint32(3, d.id, true)
      v.setFloat64(7, d.t0, true)
      v.setFloat64(15, d.t1, true)
      v.setFloat64(23, d.t2, true)
      break
    case DGRAM_STATE_FAST:
      v.setUint32(3, d.syncEpoch, true)
      v.setUint32(7, d.seq, true)
      buf[11] = MODES.indexOf(d.mode)
      v.setFloat64(12, d.pos, true)
      v.setFloat64(20, d.hostTime, true)
      v.setFloat64(28, d.sentAt, true)
      break
  }
  return buf
}

/** null for foreign, truncated or newer-version datagrams. */
export function decodeDatagram(buf: Uint8Array): Datagram | null {
  if (buf.length < HEADER || buf[0] !== DGRAM_MAGIC || buf[1] !== DGRAM_V) return null
  const type = buf[2]
  if (type !== DGRAM_PING && type !== DGRAM_PONG && type !== DGRAM_STATE_FAST) return null
  if (buf.length < SIZES[type]) return null
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const finite = (...xs: number[]): boolean => xs.every(Number.isFinite)
  if (type === DGRAM_PING) {
    const d = { type: DGRAM_PING, id: v.getUint32(3, true), t0: v.getFloat64(7, true) } as const
    return finite(d.t0) ? d : null
  }
  if (type === DGRAM_PONG) {
    const d = {
      type: DGRAM_PONG,
      id: v.getUint32(3, true),
      t0: v.getFloat64(7, true),
      t1: v.getFloat64(15, true),
      t2: v.getFloat64(23, true),
    } as const
    return finite(d.t0, d.t1, d.t2) ? d : null
  }
  const mode = MODES[buf[11] ?? 255]
  if (mode === undefined) return null
  const d = {
    type: DGRAM_STATE_FAST,
    syncEpoch: v.getUint32(3, true),
    seq: v.getUint32(7, true),
    mode,
    pos: v.getFloat64(12, true),
    hostTime: v.getFloat64(20, true),
    sentAt: v.getFloat64(28, true),
  } as const
  return finite(d.pos, d.hostTime, d.sentAt) && d.pos >= 0 ? d : null
}
