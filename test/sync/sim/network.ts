import type {
  BusPort,
  BusSendOptions,
  DatagramPort,
  PresenceEvent,
  TimerHandle,
  Unsubscribe,
} from '../../../src/core/sync/ports.js'
import type { SyncBusMessage } from '../../../src/core/sync/protocol.js'
import { type EventLoop, type Rng, uniform } from './loop.js'

export interface LinkSpec {
  /** one-way base latency, ms */
  latencyMs: number
  /** extra uniform delay in [0, jitterMs] */
  jitterMs: number
  /** probability a datagram is lost, or a reliable message needs a retransmission */
  loss: number
}

interface Link extends LinkSpec {
  /** reliable delivery is in order: nothing arrives before this */
  lastReliableAt: number
  /** bytes queued ahead on the reliable stream drain until this true time (head-of-line blocking) */
  backlogUntil: number
  /** temporary partition without disconnect: datagrams dropped, reliable traffic held until then */
  blockedUntil: number
}

interface Endpoint {
  id: string
  name: string
  bus: Set<(from: string, raw: unknown) => void>
  dgram: Set<(from: string, data: Uint8Array) => void>
  presence: Set<(ev: PresenceEvent) => void>
  /** its room.hb, every heartbeatMs to everyone it is connected to; stops when the process dies */
  heartbeat: TimerHandle
}

/** How a viewer's BusPortAdapter sees the host: present while heard from within afterMs, checked every recheckMs. */
export interface SilenceSpec {
  /** net's room.hb */
  heartbeatMs: number
  afterMs: number
  recheckMs: number
}

const key = (a: string, b: string): string => `${a}>${b}`
const pair = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)

/**
 * The room as seen by sync: a reliable ordered bus per directed link (with head-of-line backlog and
 * retransmission delay), unreliable datagrams, sticky messages replayed on connect, and presence events.
 * Presence: a link opening is a join. A watched pair (a viewer watching the host, as the session's adapter
 * does) reports a leave only after `silence.afterMs` without any delivery or heartbeat from the subject, with
 * how long ago it last heard from it, and a join on its next word: a crash, a partition or a lost connection
 * all show as silence. Other pairs report a leave `presenceDetectMs` after a disconnect.
 */
export class Network {
  /** every bus message delivered, for assertions */
  readonly delivered: { t: number; from: string; to: string; msg: SyncBusMessage }[] = []
  recordDeliveries = false
  /**
   * Per-origin rates by message name, as the session's bus applies them on receipt (SYNC_BUS_POLICIES): `burst`
   * messages, then one per `everyMs` (a token bucket); the rest are dropped and recorded in `rateDropped`.
   */
  rates: Readonly<Record<string, { burst: number; everyMs: number } | undefined>> = {}
  readonly rateDropped: { t: number; from: string; to: string; msg: SyncBusMessage }[] = []
  /** `${to}|${from}|${name}` → tokens left at `at` */
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  presenceDetectMs = 1000
  readonly silence: SilenceSpec = { heartbeatMs: 5000, afterMs: 7000, recheckMs: 2000 }
  /** true time of the last delivery (message, datagram, heartbeat or link opening) from subject at observer */
  private readonly heard = new Map<string, number>()
  /** pairs whose presence is silence-based, by key(observer, subject) */
  private readonly watched = new Map<string, { absent: boolean }>()
  private readonly eps = new Map<string, Endpoint>()
  private readonly links = new Map<string, Link>()
  /** connection generation per pair; bumps on disconnect so in-flight messages die with the connection */
  private readonly conns = new Map<string, number>()
  private readonly gens = new Map<string, number>()
  private readonly sticky = new Map<string, Map<string, SyncBusMessage>>()

  constructor(
    private readonly loop: EventLoop,
    private readonly r: Rng,
    private readonly spec: (a: string, b: string) => LinkSpec,
  ) {}

  add(id: string, name: string): void {
    // net's heartbeat runs on the room's own 1 s tick, so its phase is anybody's guess
    const heartbeat = this.loop.after(uniform(this.r, 0, this.silence.heartbeatMs), () => {
      const ep = this.eps.get(id)
      if (!ep) return
      ep.heartbeat = this.loop.every(this.silence.heartbeatMs, () => this.beat(id))
      this.beat(id)
    })
    this.eps.set(id, { id, name, bus: new Set(), dgram: new Set(), presence: new Set(), heartbeat })
  }

  /** `observer` tracks `subject` by silence, as a viewer's presence adapter tracks the host. */
  watchSilence(observer: string, subject: string): void {
    const k = key(observer, subject)
    if (this.watched.has(k)) return
    this.watched.set(k, { absent: false })
    this.heard.set(k, this.loop.t)
    this.loop.after(uniform(this.r, 0, this.silence.recheckMs), () => {
      this.loop.every(this.silence.recheckMs, () => this.recheck(observer, subject))
      this.recheck(observer, subject)
    })
  }

  /** True time `observer` last heard from `subject`, or null if never. */
  lastHeard(observer: string, subject: string): number | null {
    return this.heard.get(key(observer, subject)) ?? null
  }

  link(a: string, b: string): Link {
    const k = key(a, b)
    let l = this.links.get(k)
    if (!l) {
      l = { ...this.spec(a, b), lastReliableAt: 0, backlogUntil: 0, blockedUntil: 0 }
      this.links.set(k, l)
    }
    return l
  }

  connected(a: string, b: string): boolean {
    return this.conns.has(pair(a, b))
  }

  connect(a: string, b: string): void {
    if (this.connected(a, b)) return
    const gen = (this.gens.get(pair(a, b)) ?? 0) + 1
    this.gens.set(pair(a, b), gen)
    this.conns.set(pair(a, b), gen)
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      const lat = this.link(x, y).latencyMs
      this.loop.after(lat, () => {
        if (this.conns.get(pair(a, b)) !== gen) return
        const ep = this.eps.get(y)
        const name = this.eps.get(x)?.name ?? x
        // a link opening is a join even while x counted as present (the adapter's 'peer')
        this.heard.set(key(y, x), this.loop.t)
        const w = this.watched.get(key(y, x))
        if (w) w.absent = false
        for (const fn of [...(ep?.presence ?? [])]) fn({ kind: 'join', peerId: x, name })
        for (const msg of this.sticky.get(x)?.values() ?? []) this.sendReliable(x, y, msg)
      })
    }
  }

  connectAll(): void {
    const ids = [...this.eps.keys()]
    for (const a of ids) for (const b of ids) if (a < b) this.connect(a, b)
  }

  disconnect(a: string, b: string): void {
    const p = pair(a, b)
    if (!this.conns.delete(p)) return
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      // a watched peer's leave comes from silence: nothing tells a viewer at once that the host crashed
      if (this.watched.has(key(y, x))) continue
      this.loop.after(this.presenceDetectMs, () => {
        const ep = this.eps.get(y)
        const name = this.eps.get(x)?.name ?? x
        for (const fn of [...(ep?.presence ?? [])]) fn({ kind: 'leave', peerId: x, name })
      })
    }
  }

  /** The node's process died: every connection closes, and its sticky messages die with it. */
  kill(id: string): void {
    for (const other of this.eps.keys()) if (other !== id) this.disconnect(id, other)
    this.eps.get(id)?.heartbeat.cancel()
    this.eps.delete(id)
    this.sticky.delete(id)
  }

  /** What a presence adapter reports when sync subscribes: `peer`, already connected, joined. */
  announce(to: string, peer: string): void {
    if (!this.connected(to, peer)) return
    const name = this.eps.get(peer)?.name ?? peer
    for (const fn of [...(this.eps.get(to)?.presence ?? [])]) fn({ kind: 'join', peerId: peer, name })
  }

  /** Partition a pair without closing the connection: datagrams drop, reliable traffic waits. */
  block(a: string, b: string, forMs: number): void {
    const until = this.loop.t + forMs
    this.link(a, b).blockedUntil = until
    this.link(b, a).blockedUntil = until
  }

  /** Queue bytes ahead on a reliable stream (e.g. video pieces) drained at bps. */
  backlog(from: string, to: string, bytes: number, bps: number): void {
    const l = this.link(from, to)
    l.backlogUntil = Math.max(this.loop.t, l.backlogUntil) + ((bytes * 8) / bps) * 1000
  }

  busPort(self: string): BusPort {
    return {
      publish: (msg: SyncBusMessage, opts?: BusSendOptions) => {
        if (opts?.sticky) {
          let m = this.sticky.get(self)
          if (!m) this.sticky.set(self, (m = new Map<string, SyncBusMessage>()))
          m.set(msg.t, msg)
        }
        const targets = opts?.to !== undefined ? [opts.to] : [...this.eps.keys()].filter((id) => id !== self)
        for (const to of targets) this.sendReliable(self, to, msg)
      },
      onMessage: (fn): Unsubscribe => this.sub(self, 'bus', fn),
      onPresence: (fn): Unsubscribe => this.sub(self, 'presence', fn),
    }
  }

  datagramPort(self: string, usable: (peer: string) => boolean = () => true): DatagramPort {
    return {
      send: (to, data) => this.sendDatagram(self, to, data),
      usable: (peer) => this.connected(self, peer) && usable(peer),
      onMessage: (fn): Unsubscribe => this.sub(self, 'dgram', fn),
    }
  }

  private sub<K extends 'bus' | 'dgram' | 'presence'>(self: string, kind: K, fn: Parameters<Endpoint[K]['add']>[0]) {
    const ep = this.eps.get(self)
    if (!ep) throw new Error(`unknown node ${self}`)
    const set = ep[kind] as Set<typeof fn>
    set.add(fn)
    return () => set.delete(fn)
  }

  /** A sync message, or (null) a room.hb that only says "still here": in order on the same reliable stream. */
  private sendReliable(from: string, to: string, msg: SyncBusMessage | null): void {
    const p = pair(from, to)
    const gen = this.conns.get(p)
    if (gen === undefined || !this.eps.has(to)) return
    const l = this.link(from, to)
    const now = this.loop.t
    let at = now + l.latencyMs + uniform(this.r, 0, l.jitterMs)
    if (this.r() < l.loss) at += 2 * l.latencyMs + 200
    if (l.backlogUntil > now) at = Math.max(at, l.backlogUntil + l.latencyMs)
    if (l.blockedUntil > now) at = Math.max(at, l.blockedUntil + l.latencyMs)
    at = Math.max(at, l.lastReliableAt)
    l.lastReliableAt = at
    const copy = msg === null ? null : (JSON.parse(JSON.stringify(msg)) as SyncBusMessage)
    this.loop.schedule(at, () => {
      if (this.conns.get(p) !== gen) return
      this.hear(to, from)
      if (copy === null) return
      if (!this.spendRate(from, to, copy)) {
        this.rateDropped.push({ t: this.loop.t, from, to, msg: copy })
        return
      }
      if (this.recordDeliveries) this.delivered.push({ t: this.loop.t, from, to, msg: copy })
      for (const fn of [...(this.eps.get(to)?.bus ?? [])]) fn(from, copy)
    })
  }

  private spendRate(from: string, to: string, msg: SyncBusMessage): boolean {
    const rate = this.rates[msg.t]
    if (!rate) return true
    const k = `${to}|${from}|${msg.t}`
    const b = this.buckets.get(k)
    const tokens = b ? Math.min(rate.burst, b.tokens + (this.loop.t - b.at) / rate.everyMs) : rate.burst
    if (tokens < 1) return false
    this.buckets.set(k, { tokens: tokens - 1, at: this.loop.t })
    return true
  }

  private sendDatagram(from: string, to: string, data: Uint8Array): void {
    const p = pair(from, to)
    const gen = this.conns.get(p)
    if (gen === undefined || !this.eps.has(to)) return
    const l = this.link(from, to)
    if (l.blockedUntil > this.loop.t || this.r() < l.loss) return
    const copy = data.slice()
    this.loop.after(l.latencyMs + uniform(this.r, 0, l.jitterMs), () => {
      if (this.conns.get(p) !== gen) return
      this.hear(to, from)
      for (const fn of [...(this.eps.get(to)?.dgram ?? [])]) fn(from, copy)
    })
  }

  private beat(id: string): void {
    for (const other of this.eps.keys())
      if (other !== id && this.connected(id, other)) this.sendReliable(id, other, null)
  }

  /** Any word from subject at observer: a watched subject that had gone quiet is back. */
  private hear(observer: string, subject: string): void {
    const k = key(observer, subject)
    this.heard.set(k, this.loop.t)
    const w = this.watched.get(k)
    if (!w?.absent) return
    w.absent = false
    const name = this.eps.get(subject)?.name ?? subject
    for (const fn of [...(this.eps.get(observer)?.presence ?? [])]) fn({ kind: 'join', peerId: subject, name })
  }

  private recheck(observer: string, subject: string): void {
    const k = key(observer, subject)
    const w = this.watched.get(k)
    const silentMs = this.loop.t - (this.heard.get(k) ?? 0)
    if (!w || w.absent || silentMs < this.silence.afterMs) return
    w.absent = true
    const name = this.eps.get(subject)?.name ?? subject
    for (const fn of [...(this.eps.get(observer)?.presence ?? [])])
      fn({ kind: 'leave', peerId: subject, name, sinceMs: silentMs })
  }
}
