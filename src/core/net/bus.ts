import { EventEmitter } from 'node:events'
import { CodedError } from '../../shared/result.js'
import { busSigningPayload, randomBytes, sign, toHex, verify } from './crypto.js'
import { NET_ERRORS } from './errors.js'
import { CTRL_MAX_BYTES } from './wire.js'

// The signed room bus (plan §4.1, §5.2). Every member forwards what it accepts to its other admitted
// links while ttl > 0, so a member without a direct link to the host (via-peer) still gets room state.
// Signatures make forwarding safe: a neighbour can drop a message but cannot forge or alter one.

export const BUS_TTL = 2
/** an envelope travels as one ctrl frame, {ns: 'bus', t: 'msg', m: envelope}: it must fit with that wrapper */
export const BUS_MAX_BYTES = CTRL_MAX_BYTES - 64
export const BUS_DEDUPE_SIZE = 2048
/** origins whose rate-limited messages are counted; the least recent one is forgotten past this */
export const BUS_RATE_KEYS = 1024

export interface Envelope {
  /** origin public key, hex */
  o: string
  /** "<bootNonce>.<counter>", unique per origin */
  s: string
  ttl: number
  ns: string
  t: string
  /** addressee public key, hex; absent = everyone */
  to?: string
  /** sticky messages only: newer replaces older per (ns, t) */
  rev?: number
  body: unknown
  /** ed25519 over everything except ttl, base64 */
  sig: string
}

export interface BusMessage<T = unknown> {
  /** `${ns}.${t}` */
  name: string
  ns: string
  t: string
  /** origin key, hex */
  from: string
  to: string | null
  rev: number | null
  body: T
  /** link id (peer key hex) it arrived on; null when published here */
  via: string | null
}

export interface BusPolicy {
  /** accepted only when the origin is the host */
  hostOnly?: boolean
  /** newest rev per name is kept and replayed to every newly admitted link */
  sticky?: boolean
  /**
   * Per remote origin: `burst` messages under this name, then one per `everyMs` (a token bucket). The rest
   * are dropped ('rate') before their signature is checked, and never forwarded: a flood stops at one hop.
   */
  rate?: { burst: number; everyMs: number }
  /** a tighter bound than BUS_MAX_BYTES on the envelope's JSON, for small messages anyone can make us carry */
  maxBytes?: number
}

export interface BusLink {
  readonly id: string
  sendEnvelope(env: Envelope): void
}

export type DropReason =
  'malformed' | 'duplicate' | 'too-large' | 'host-only' | 'origin' | 'signature' | 'stale' | 'rate'

export interface BusOptions {
  keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }
  hostKey: string
  /** extra check on every remote envelope, e.g. "the origin is a member" */
  acceptOrigin?: (origin: string, name: string) => boolean
  /** an accepted envelope addressed to another member; the room hands these to pending joiners */
  onForeign?: (env: Envelope) => void
  /** deliver our own messages to our own handlers too (the host's sync engine listens to itself) */
  loopback?: boolean
  dedupeSize?: number
  now?: () => number
}

type Handler = (msg: BusMessage) => void

interface BusEvents {
  drop: [reason: DropReason, env: unknown]
  /** every delivered message, after the per-name handlers */
  message: [msg: BusMessage]
  /** a handler, onForeign or a link threw on a remote message; the bus carried on without it */
  fault: [name: string, err: unknown]
}

const NAME_PART = /^[a-z][a-zA-Z0-9-]{0,31}$/
const SEQ = /^[0-9a-f]{1,32}\.\d{1,15}$/
const HEX32 = /^[0-9a-f]{64}$/

export class Bus extends EventEmitter<BusEvents> {
  readonly self: string
  readonly stats = { published: 0, delivered: 0, forwarded: 0, dropped: 0 }

  private hostKey: string
  private readonly secretKey: Uint8Array
  private readonly bootNonce = toHex(randomBytes(4))
  private counter = 0
  private lastRev = 0
  private readonly seen = new Set<string>()
  private readonly dedupeSize: number
  private readonly links = new Map<string, BusLink>()
  private readonly policies = new Map<string, BusPolicy>()
  private readonly stickies = new Map<string, Envelope>()
  private readonly handlers = new Map<string, Set<Handler>>()
  /** `${name}|${origin}` → tokens left at `at`, for names with a rate policy; least recently spent first */
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  private readonly opts: BusOptions
  private readonly now: () => number

  constructor(opts: BusOptions) {
    super()
    this.opts = opts
    this.self = toHex(opts.keyPair.publicKey)
    this.secretKey = opts.keyPair.secretKey
    this.hostKey = opts.hostKey
    this.dedupeSize = opts.dedupeSize ?? BUS_DEDUPE_SIZE
    this.now = opts.now ?? Date.now
  }

  define(name: string, policy: BusPolicy): void {
    splitName(name)
    this.policies.set(name, policy)
  }

  policy(name: string): BusPolicy {
    return this.policies.get(name) ?? {}
  }

  /** Signs and sends a message; returns the envelope. Throws for host-only names on a non-host. */
  publish(name: string, data: unknown, opts: { to?: string | null } = {}): Envelope {
    const to = opts.to ?? null
    const env = this.sign(name, data, to)
    this.markSeen(env)
    if (this.policy(name).sticky) this.stickies.set(name, env)
    this.stats.published++
    if (this.opts.loopback !== false && (to === null || to === this.self)) this.deliver(env, null, false)
    if (to !== this.self) this.forward(env, null, BUS_TTL)
    return env
  }

  /** Signs a message without delivering or sending it: for the room to hand over on one link itself. */
  seal(name: string, data: unknown, opts: { to?: string | null } = {}): Envelope {
    const env = this.sign(name, data, opts.to ?? null)
    this.markSeen(env)
    return env
  }

  /**
   * Handles an envelope from a link (or handed over on the auth lane). Returns whether it was accepted.
   * `fromId` is excluded from forwarding. Never throws for what a remote sent: it runs inside the link's
   * message callback, where a throw makes Protomux destroy that connection (or, for a TypeError, crash).
   */
  receive(raw: unknown, fromId: string | null): boolean {
    const env = this.check(raw, true)
    if (!env) return false
    const name = `${env.ns}.${env.t}`
    const policy = this.policy(name)
    if (policy.sticky) {
      const held = this.stickies.get(name)
      if (held?.rev !== undefined && env.rev !== undefined && held.rev >= env.rev) return this.drop('stale', env, false)
      this.stickies.set(name, env)
    }
    if (env.to === undefined || env.to === this.self) this.deliver(env, fromId, true)
    else this.guarded(name, () => this.opts.onForeign?.(env))
    if (env.to !== this.self && env.ttl > 0) this.forward(env, fromId, env.ttl - 1)
    return true
  }

  /**
   * A remote envelope the room acts on itself rather than through the bus (a join request: from the joiner's
   * own link, or out of the member's message that relays it). Checked as receive() checks it (shape, dedupe,
   * size, its name's rate for its origin, signature), but not against acceptOrigin (the room knows who may
   * send it), and neither delivered nor forwarded. Null when a check fails; 'drop' says which.
   */
  take(raw: unknown): Envelope | null {
    return this.check(raw, false)
  }

  /** An admitted link: gets every sticky message now, and forwarded traffic from here on. */
  addLink(link: BusLink): void {
    this.links.set(link.id, link)
    for (const env of this.stickies.values()) link.sendEnvelope({ ...env, ttl: 0 })
  }

  /** With `link`, removes only that exact link (a replacement for the same peer may already be in). */
  removeLink(id: string, link?: BusLink): void {
    if (link && this.links.get(id) !== link) return
    this.links.delete(id)
  }

  hasLink(id: string): boolean {
    return this.links.has(id)
  }

  /**
   * Subscribe to a full name ('sync.state') or a whole namespace ('sync'). Returns the unsubscribe function.
   */
  subscribe(nameOrNs: string, handler: Handler): () => void {
    let set = this.handlers.get(nameOrNs)
    if (!set) this.handlers.set(nameOrNs, (set = new Set()))
    set.add(handler)
    return () => set.delete(handler)
  }

  /** Latest sticky message for a name, if any. */
  latest(name: string): BusMessage | null {
    const env = this.stickies.get(name)
    return env ? toMessage(env, null) : null
  }

  /** The signed envelope behind a sticky name, to hand to a joiner on the auth lane. */
  stickyEnvelope(name: string): Envelope | null {
    return this.stickies.get(name) ?? null
  }

  setHostKey(hostKey: string): void {
    this.hostKey = hostKey
  }

  /** `remote`: a handler failing on it is reported ('fault') and the rest still run; our own fail the publish. */
  private deliver(env: Envelope, via: string | null, remote: boolean): void {
    const msg = toMessage(env, via)
    this.stats.delivered++
    const run = remote ? (fn: () => void) => this.guarded(msg.name, fn) : (fn: () => void) => fn()
    for (const key of [msg.name, msg.ns]) {
      const set = this.handlers.get(key)
      if (!set) continue
      for (const handler of [...set]) run(() => handler(msg))
    }
    run(() => this.emit('message', msg))
  }

  private forward(env: Envelope, fromId: string | null, ttl: number): void {
    const out = { ...env, ttl }
    const direct = env.to !== undefined ? this.links.get(env.to) : undefined
    const targets = direct ? [direct] : this.links.values()
    for (const link of targets) {
      if (link.id === fromId || link.id === env.o) continue
      this.stats.forwarded++
      // one link failing must not keep the message from the others
      this.guarded(`${env.ns}.${env.t}`, () => link.sendEnvelope(out))
    }
  }

  private guarded(name: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      this.emit('fault', name, e)
    }
  }

  /** What every remote envelope goes through; the accepted one is marked seen and has spent its rate token. */
  private check(raw: unknown, withOrigin: boolean): Envelope | null {
    const fail = (reason: DropReason, env: unknown, count = true): null => {
      this.drop(reason, env, count)
      return null
    }
    const env = parseEnvelope(raw)
    if (!env) return fail('malformed', raw)
    if (this.seen.has(`${env.o}|${env.s}`)) return fail('duplicate', env, false)
    const name = `${env.ns}.${env.t}`
    const policy = this.policy(name)
    if (envelopeBytes(env) > maxBytes(policy)) return fail('too-large', env)
    if (policy.hostOnly && env.o !== this.hostKey) return fail('host-only', env)
    if (policy.sticky && (env.rev === undefined || env.to !== undefined)) return fail('malformed', env)
    if (withOrigin && this.opts.acceptOrigin && !this.opts.acceptOrigin(env.o, name)) return fail('origin', env)
    // checked before the signature (cheap), spent after it (a forgery cannot use up the origin's tokens)
    const bucketKey = `${name}|${env.o}`
    const tokens = policy.rate ? this.tokens(bucketKey, policy.rate) : Infinity
    if (tokens < 1) return fail('rate', env)
    const { sig, ...unsigned } = env
    if (!verify(Buffer.from(sig, 'base64'), signingPayload(unsigned), Buffer.from(env.o, 'hex'))) {
      return fail('signature', env)
    }
    this.markSeen(env)
    if (policy.rate) this.spend(bucketKey, tokens)
    return env
  }

  private sign(name: string, data: unknown, to: string | null): Envelope {
    const [ns, t] = splitName(name)
    // Sign and keep a copy: a sticky envelope is handed out long after this call, and a caller that later
    // changes its own object (a members list holding live records) must not change what was signed.
    const body: unknown = data === undefined ? data : JSON.parse(JSON.stringify(data))
    const policy = this.policy(name)
    if (policy.hostOnly && this.self !== this.hostKey) {
      throw new CodedError(NET_ERRORS.notHost, `${name} can only be sent by the host`)
    }
    if (policy.sticky && to !== null) throw new Error(`sticky message ${name} cannot be addressed`)
    const unsigned: Omit<Envelope, 'sig'> = {
      o: this.self,
      s: `${this.bootNonce}.${String(++this.counter)}`,
      ttl: BUS_TTL,
      ns,
      t,
      ...(to !== null ? { to } : {}),
      // wall-clock based so a restarted host's state still replaces what members kept from before
      ...(policy.sticky ? { rev: (this.lastRev = Math.max(this.now(), this.lastRev + 1)) } : {}),
      body,
    }
    const env: Envelope = { ...unsigned, sig: sign(signingPayload(unsigned), this.secretKey).toString('base64') }
    if (envelopeBytes(env) > maxBytes(policy)) {
      throw new CodedError(NET_ERRORS.frameTooLarge, `${name} is larger than ${String(maxBytes(policy))} bytes`)
    }
    return env
  }

  /** The tokens `key` has now (refilled since it last spent one); a key never seen has a full bucket. */
  private tokens(key: string, rate: { burst: number; everyMs: number }): number {
    const b = this.buckets.get(key)
    if (!b) return rate.burst
    return Math.min(rate.burst, b.tokens + (this.now() - b.at) / Math.max(1, rate.everyMs))
  }

  private spend(key: string, tokens: number): void {
    this.buckets.delete(key) // and back in last: the map's first key is the least recently active one
    this.buckets.set(key, { tokens: tokens - 1, at: this.now() })
    if (this.buckets.size > BUS_RATE_KEYS) {
      const oldest = this.buckets.keys().next()
      if (!oldest.done) this.buckets.delete(oldest.value)
    }
  }

  private markSeen(env: Envelope): void {
    const key = `${env.o}|${env.s}`
    this.seen.add(key)
    if (this.seen.size > this.dedupeSize) {
      const oldest = this.seen.values().next()
      if (!oldest.done) this.seen.delete(oldest.value)
    }
  }

  private drop(reason: DropReason, env: unknown, count = true): false {
    if (count) this.stats.dropped++
    this.emit('drop', reason, env)
    return false
  }
}

export function splitName(name: string): [string, string] {
  const dot = name.indexOf('.')
  const ns = name.slice(0, dot)
  const t = name.slice(dot + 1)
  if (dot < 0 || !NAME_PART.test(ns) || !/^[a-z][a-zA-Z0-9.-]{0,31}$/.test(t)) {
    throw new Error(`bad bus message name '${name}' (expected ns.type)`)
  }
  return [ns, t]
}

function signingPayload(env: Omit<Envelope, 'sig'>): Buffer {
  return busSigningPayload(JSON.stringify([env.o, env.s, env.ns, env.t, env.to ?? null, env.rev ?? null, env.body]))
}

function envelopeBytes(env: Envelope): number {
  return Buffer.byteLength(JSON.stringify(env))
}

function maxBytes(policy: BusPolicy): number {
  return Math.min(BUS_MAX_BYTES, policy.maxBytes ?? BUS_MAX_BYTES)
}

/** An envelope's counter: its origin's messages count up within one bus (one process, one join attempt). */
export function seqOf(env: Envelope): number {
  return Number(env.s.slice(env.s.indexOf('.') + 1))
}

function toMessage(env: Envelope, via: string | null): BusMessage {
  return {
    name: `${env.ns}.${env.t}`,
    ns: env.ns,
    t: env.t,
    from: env.o,
    to: env.to ?? null,
    rev: env.rev ?? null,
    body: env.body,
    via,
  }
}

export function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as Record<string, unknown>
  if (typeof e.o !== 'string' || !HEX32.test(e.o)) return null
  if (typeof e.s !== 'string' || !SEQ.test(e.s)) return null
  if (typeof e.ttl !== 'number' || !Number.isInteger(e.ttl) || e.ttl < 0 || e.ttl > BUS_TTL) return null
  if (typeof e.ns !== 'string' || !NAME_PART.test(e.ns)) return null
  if (typeof e.t !== 'string' || !/^[a-z][a-zA-Z0-9.-]{0,31}$/.test(e.t)) return null
  if (e.to !== undefined && (typeof e.to !== 'string' || !HEX32.test(e.to))) return null
  if (e.rev !== undefined && (typeof e.rev !== 'number' || !Number.isSafeInteger(e.rev) || e.rev < 0)) return null
  if (typeof e.sig !== 'string' || e.sig.length !== 88) return null
  if (!('body' in e)) return null
  return {
    o: e.o,
    s: e.s,
    ttl: e.ttl,
    ns: e.ns,
    t: e.t,
    ...(e.to !== undefined ? { to: e.to } : {}),
    ...(e.rev !== undefined ? { rev: e.rev } : {}),
    body: e.body,
    sig: e.sig,
  }
}
