import type { Torrent, Wire } from 'webtorrent'
import {
  type ByteRange,
  type PieceRange,
  type PlayheadPieces,
  type PlayheadPlan,
  applyPlayhead,
  orderRanges,
  toPieceSpans,
} from './scheduler.js'

export interface RevealerDeps {
  /** member id behind a host wire (the engine's stream -> peer map); null leaves the wire unstriped */
  memberOf(wire: Wire): string | null
  /** the upload limit in bytes/s, null when there is none */
  uploadLimitBps(): number | null
  /** the upload pacer's rate in bytes/s, null when it has none (ADR 0006) */
  pacedBps?(): number | null
  /** the host's measured upload rate in bytes/s */
  uploadBps(): number
  /** ms clock; tests inject one */
  now?: () => number
}

export const REVEAL_TICK_MS = 250
/** R covers this much host upload per viewer (by rate share): the reveal -> request latency, not more (S3 F11). */
const BUDGET_S = 1.5
const MIN_BUDGET = 2
/** Rescue: a piece due within this many seconds that nobody holds... */
const RESCUE_DEADLINE_S = 8
/** ...and that saw no reveal and no request for this long goes to one more viewer (S3 F9). */
const RESCUE_IDLE_MS = 3000
/**
 * A reader's piece on its way through another viewer waits for it at most RESCUE_IDLE_MS plus this many pieces at
 * one lane's share of the host upload: that viewer's own fetch of it after a group seek took 0.55-2.55 of them, median
 * 1.3 (1 MiB pieces, 500-700 KB/s, 3 viewers, 24 runs), and 4 of those fetches outlasted a wait of one (ADR 0003,
 * Round 5)
 */
const WAIT_PIECES = 2
/**
 * A viewer reports its lanes at 1 Hz, so the host learns them up to a second after they open: until a report
 * lists one, for this long after its wire attached, the walk does not take it for isolated.
 */
const LINK_WAIT_MS = 2000
/** EWMA weight per tick of each viewer's host -> viewer rate */
const RATE_ALPHA = 0.3
/** Without a limit, the host's upload is estimated from its measured peak, forgotten over ~1 min. */
const PEAK_ALPHA = 0.004
const MIN_HOST_BPS = 1_000_000
/** A PlayheadPlan's windowBytes is L1, ~25 s of bytes (media Playhead WINDOW_S): its playback rate. */
const L1_SECONDS = 25
/** Pieces taken from one urgent report: a viewer has a few HTTP readers, each blocked on one piece at most. */
export const MAX_URGENT = 16

interface View {
  id: string
  wire: Wire
  /** 1 = advertised to this viewer */
  revealed: Uint8Array
  /** sent the advertisement (bitfield): from then on a reveal is a 'have' */
  advertised: boolean
  /** shown everything (nothing to stripe yet); taken back when striping starts and the viewer can be told */
  open: boolean
  /** pieces the host revealed to this viewer alone, or to fetch from the host, that it does not hold yet */
  exclusive: Set<number>
  /** EWMA of the host -> viewer rate, bytes/s */
  rate: number
  /** when its wire attached (ms) */
  since: number
}

/**
 * Host-assigned striping (plan §4.2, ADR 0003). The host advertises to each viewer only the pieces it
 * revealed to it, so each upcoming piece leaves the host about once and spreads between viewers through
 * their own 'have's. Viewers need nothing: they request what their peers advertise.
 *
 * THE HOOK: a torrent's 'wire' event fires synchronously in _onWire (torrent.js:1383), before its
 * advertisement (haveAll / haveNone / bitfield, torrent.js:1492-1494) runs from _onWireWithMetadata, so
 * own-property overrides of those three on the wire decide what the viewer first sees. A seeder never sends
 * 'have' by itself, so nothing else leaks unrevealed pieces.
 *
 * Until the room's playhead is known (setPlan), or while a single viewer is attached, there is nothing to
 * stripe: every viewer is shown everything, as plain seeding would. When striping starts, each viewer is told
 * (lt_donthave, BEP 54) that the host no longer has what it neither holds nor is fetching: given everything,
 * a first viewer would otherwise be the only way to every later viewer, through its own uplink. Telling needs
 * lt_donthave in the viewer's BEP 10 handshake, which arrives up to an RTT after its wire: until then the view
 * stays open and every tick asks again (a client without lt_donthave keeps everything). The donthaves go from the
 * plan's end, so the pieces the viewer is fetching go last (ADR 0008 §4.1). The host answers a request only for a
 * piece it advertises to that wire, and rejects the rest (BEP 6; onArrival, which the upload scheduler asks before it
 * holds a request), so nothing a viewer asks for after a take-back, or at will, reaches the upload queue.
 *
 * A viewer's urgent pieces (setUrgent: what its HTTP readers are blocked on, which the group plan may not reach
 * for a while) are revealed to it at once, outside its budget, and never taken back while it reports them;
 * unless already on their way to it through a viewer it has a lane to, re-checked every tick, and for at most
 * 3 s plus two pieces at one lane's share of the host upload from its first report of the piece. An open view is
 * assigned nothing: what it was shown is not its work.
 *
 * Striping: every 250 ms the group plan is walked in the viewers' own order (orderRanges: hot window,
 * critical ranges, L1, L2, L3). For each piece some viewer lacks:
 * - a piece somebody holds spreads by itself; only a lacking viewer with no lane to any holder gets it from
 *   the host;
 * - a piece revealed but held by nobody waits, unless it is due within 8 s and saw no reveal or request for
 *   3 s: then the fastest other lacking viewer gets it too (rescue);
 * - otherwise it goes to one eligible viewer, the one with the lowest (exclusive + 1) / rate below its budget
 *   R = max(2, ceil(1.5 s x host upload x rate share / P)). When every eligible viewer is at R the walk stops,
 *   so reveals never run ahead of the plan. Eligible ('full'): linked to every other viewer that has a lane
 *   to any viewer at all. With none eligible, every lacking viewer gets it, within its own R.
 * Unlike the S3 spike, viewers report their links asynchronously (setLinks), so everything the host reveals
 * beyond the critical pieces counts against R: a viewer whose report is late is fed at its own pace, never
 * the whole file at once. A viewer that has reported no lane is not fed that way for its first 2 s, though: its
 * lanes come in its next report, and viewers that join together would each be given the same pieces from the
 * host meanwhile. A group seek clears every exclusive set and takes back what was revealed outside the new window
 * (and its urgent audio ranges) and not fetched (ADR 0008 §4.3); a viewer that leaves drops its view, so what it was given and did not fetch is
 * assigned again.
 */
export class Revealer {
  private readonly views = new Map<string, View>()
  private readonly links = new Map<string, ReadonlySet<string>>()
  /**
   * member -> the pieces its readers are blocked on, as it last reported them (kept across re-attaches), each
   * with the time (ms) it first appeared in its reports: how long that reader has waited
   */
  private readonly urgent = new Map<string, ReadonlyMap<number, number>>()
  /** piece -> how many members report a reader blocked on it (classOf) */
  private readonly urgentCount: Uint16Array
  /** piece -> last reveal or request (ms), for the rescue rule */
  private readonly lastActivity = new Map<number, number>()
  private readonly viewOf = new WeakMap<Wire, View>()
  private readonly n: number
  private readonly pieceLength: number
  private plan: PlayheadPlan | null = null
  private playhead: PlayheadPieces | null = null
  private critical: PieceRange[] = []
  private readonly isCritical: Uint8Array
  private peakUpBps = 0
  /** hostUploadBps() of the last tick: it moves an EWMA, so it runs once per tick */
  private hostBps: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(
    private readonly t: Torrent,
    private readonly d: RevealerDeps,
  ) {
    this.n = t.pieces.length
    this.pieceLength = t.pieceLength
    this.isCritical = new Uint8Array(this.n)
    this.urgentCount = new Uint16Array(this.n)
    this.now = d.now ?? (() => performance.now())
    t.on('wire', this.onWire)
  }

  start(): void {
    this.timer ??= setInterval(() => this.tick(), REVEAL_TICK_MS)
  }

  destroy(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.t.removeListener('wire', this.onWire)
    this.views.clear()
  }

  /**
   * The room's playhead (the plan viewers pass to their scheduler). A seek clears every exclusive set, and takes back
   * what was revealed for the old position, outside the new window and its urgent ranges, that the viewer neither
   * holds nor is fetching.
   */
  setPlan(plan: PlayheadPlan): void {
    this.plan = plan
    this.playhead = applyPlayhead(this.playhead, plan, this.pieceLength, this.n) ?? this.playhead
    if (!plan.seek) return
    for (const v of this.views.values()) {
      // assigned for the old position, they are no longer what anybody needs first
      v.exclusive.clear()
      // until the new window's reveals reach it, a viewer's host wire offers only those, so it would fetch them
      // first, and the window's data would wait behind them in the host's queue (ADR 0008 §4.3)
      if (!v.open && !v.wire.destroyed) this.retract(v, this.playhead)
    }
  }

  /** Open-critical ranges and subtitle files: revealed to every viewer at once. */
  setCriticalRanges(ranges: readonly ByteRange[]): void {
    this.critical = toPieceSpans(ranges, this.pieceLength, this.n)
    this.isCritical.fill(0)
    for (const [a, b] of this.critical) this.isCritical.fill(1, a, b + 1)
    for (const v of this.views.values())
      for (const [a, b] of this.critical) for (let i = a; i <= b; i++) this.show(v, i)
  }

  /** The members `id` reports an open bt lane to; a link counts once both ends report it. */
  setLinks(id: string, linked: readonly string[]): void {
    this.links.set(id, new Set(linked))
  }

  /**
   * The pieces viewer `id` reports its HTTP readers blocked on: revealed to it at once, outside its budget R
   * (nothing else would show it a piece the walk has not reached), and in the first bitfield of a re-attached
   * wire, unless already on their way to it (onItsWay) and first reported less than waitLimitMs() ago. Each report
   * replaces the last (a piece still in it keeps the time it was first reported); an empty one clears it. Pieces
   * out of range are dropped, duplicates sent once, and at most MAX_URGENT taken.
   */
  setUrgent(id: string, pieces: readonly number[]): void {
    const now = this.now()
    const before = this.urgent.get(id)
    const since = new Map<number, number>()
    for (const i of pieces) {
      if (since.size === MAX_URGENT) break
      if (Number.isInteger(i) && i >= 0 && i < this.n && !since.has(i)) since.set(i, before?.get(i) ?? now)
    }
    this.countUrgent(before, -1)
    this.countUrgent(since, 1)
    if (since.size > 0) this.urgent.set(id, since)
    else this.urgent.delete(id)
    const v = this.views.get(id)
    if (v && !v.wire.destroyed) this.revealUrgent(v, now)
  }

  removeViewer(id: string): void {
    this.links.delete(id)
    this.countUrgent(this.urgent.get(id), -1)
    this.urgent.delete(id)
    this.views.delete(id)
  }

  /**
   * The upload scheduler's release class of piece i: 0 = some viewer's reader is blocked on it (its urgent reports),
   * 1 = in the group's hot window or a critical range, 2 = the rest.
   */
  classOf(i: number): 0 | 1 | 2 {
    if ((this.urgentCount[i] ?? 0) > 0) return 0
    const hot = this.playhead?.hot
    if ((hot && i >= hot[0] && i <= hot[1]) || this.isCritical[i]) return 1
    return 2
  }

  /**
   * A request for piece i came in on a host wire (the upload scheduler holds it; 'request' fires only when it is
   * answered). False refuses it: a piece we do not advertise to that wire. It is rejected (BEP 6) before WebTorrent
   * reads the store, so it never reaches the upload queue (or 'request' listeners: dupFactor). BEP 6 rejects when
   * both ends set the fast bit (WebTorrent always does): the viewer's request fails at once, not after its 30 s
   * timeout; without it a seeder cannot refuse, so it is dropped unanswered. The requests a take-back's donthaves
   * cross on the way were failed by those donthaves already, which the viewer reads first: the rejects just confirm.
   * However many a viewer sends, the host queues no data for them (ADR 0008 §4.1). An admitted request is activity
   * on the piece for the rescue rule, from its arrival.
   */
  onArrival(wire: Wire, i: number): boolean {
    const v = this.viewOf.get(wire)
    if (v && v.revealed[i] !== 1) return false
    if (Number.isInteger(i) && i >= 0 && i < this.n) this.lastActivity.set(i, this.now())
    return true
  }

  /** One pass over the group plan (every 250 ms once started). */
  tick(): void {
    const views = [...this.views.values()].filter((v) => !v.wire.destroyed)
    if (views.length === 0) return
    const now = this.now()
    const has = (v: View, i: number): boolean => v.wire.peerPieces.get(i)
    for (const v of views) {
      for (const i of v.exclusive) if (has(v, i)) v.exclusive.delete(i)
      v.rate = (1 - RATE_ALPHA) * v.rate + RATE_ALPHA * v.wire.uploadSpeed()
    }
    const hostBps = this.hostUploadBps()
    this.hostBps = hostBps
    if (this.plan === null || views.length === 1) {
      // nothing to stripe: everyone is shown everything, as plain seeding would
      for (const v of views) if (!v.open) this.openUp(v, now)
      return
    }
    for (const v of views) if (v.open) this.takeBack(v)
    for (const v of views) this.revealUrgent(v, now) // what was on its way may be stuck by now
    const totalRate = views.reduce((s, v) => s + Math.max(v.rate, 1), 0)
    const budget = (v: View): number =>
      Math.max(MIN_BUDGET, Math.ceil((BUDGET_S * hostBps * Math.max(v.rate, 1)) / totalRate / this.pieceLength))
    const free = (v: View): boolean => v.exclusive.size < budget(v)
    const connected = views.filter((v) => views.some((u) => u !== v && this.linked(v.id, u.id)))
    const eligible = connected.filter((v) => connected.every((u) => u === v || this.linked(v.id, u.id)))
    // its lanes are on their way in its next report: fed from the host now, it would take what they bring, and
    // so would every viewer that joined with it
    const waiting = (v: View): boolean => now - v.since < LINK_WAIT_MS && !connected.includes(v)
    const score = (v: View): number => (v.exclusive.size + 1) / Math.max(v.rate, 1)

    for (const i of this.planOrder()) {
      let held = 0
      for (const v of views) if (has(v, i)) held++
      if (held === views.length) continue
      const lacking = views.filter((v) => !has(v, i))
      const holders = held > 0 ? views.filter((v) => has(v, i)) : []
      if (holders.length > 0) {
        // it spreads through the viewers' own 'have's; the host sends it only where no holder can
        for (const v of lacking) {
          if (!holders.some((h) => this.linked(h.id, v.id)) && free(v) && !waiting(v)) this.give(v, i, now)
        }
        continue
      }
      if (lacking.some((v) => v.revealed[i])) {
        // assigned, nobody holds it yet: near its deadline and idle for 3 s, one more viewer gets it
        if (this.deadlineS(i) < RESCUE_DEADLINE_S && now - (this.lastActivity.get(i) ?? 0) > RESCUE_IDLE_MS) {
          const next = lacking.filter((v) => !v.revealed[i]).sort((x, y) => y.rate - x.rate)[0]
          if (next) this.give(next, i, now)
        }
        continue
      }
      if (eligible.length === 0) {
        // nobody can pass it on: each viewer gets it from the host, at its own pace
        const takers = lacking.filter((v) => free(v) && !waiting(v))
        if (takers.length === 0) return // all at R (or waiting): stop, so reveals stay in plan order
        for (const v of takers) this.give(v, i, now)
        continue
      }
      let best: View | null = null
      for (const v of eligible) if (free(v) && (!best || score(v) < score(best))) best = v
      if (!best) return // every eligible viewer is at R: stop, so reveals stay in plan order
      this.give(best, i, now)
    }
  }

  private readonly onWire = (wire: Wire): void => {
    const id = this.d.memberOf(wire)
    if (id === null) return
    const now = this.now()
    const view: View = {
      id,
      wire,
      revealed: new Uint8Array(this.n),
      advertised: false,
      open: false,
      exclusive: new Set(),
      rate: 0,
      since: now,
    }
    for (const [a, b] of this.critical) view.revealed.fill(1, a, b + 1)
    for (const i of this.urgent.get(id)?.keys() ?? []) if (!this.onItsWay(view, i, now)) view.revealed[i] = 1
    this.views.set(id, view) // a re-attached member's new wire replaces the old one
    this.viewOf.set(wire, view)
    wire.once('close', () => {
      if (this.views.get(id) === view) this.views.delete(id)
    })
    const sendBitfield = wire.bitfield.bind(wire) // bittorrent-protocol's own method
    const advertise = (): void => {
      view.advertised = true
      sendBitfield(packBits(view.revealed))
    }
    // a seeder sends haveAll (fast extension) or a bitfield; a bitfield is a valid first message either way
    wire.haveAll = advertise
    wire.haveNone = advertise
    wire.bitfield = advertise
  }

  private openUp(v: View, now: number): void {
    v.open = true
    v.exclusive.clear()
    for (let i = 0; i < this.n; i++) this.show(v, i, now)
  }

  /**
   * Striping starts: what v neither holds nor is fetching from us (its requests waiting to be served), nor
   * reported as urgent, is no longer advertised, so the walk can give it to one viewer. Once advertised, that
   * takes lt_donthave with a non-zero id in v's latest BEP 10 handshake (what wire.extended() requires). The
   * handshake arrives up to an RTT after the wire, and a later one may disable the extension: until v can be
   * told, it stays open and the next tick asks again.
   */
  private takeBack(v: View): void {
    if (!canTell(v)) return
    v.open = false
    this.retract(v, null)
  }

  /**
   * Stop advertising to v what it neither holds nor is fetching from us (its requests waiting to be served: held by
   * the upload scheduler, or being read), nor reported as urgent, and is not critical; with `keep`, nor in that
   * playhead's window [p, p + w] or its urgent ranges. Fetching ones count against its budget. Nothing when v cannot
   * be told.
   */
  private retract(v: View, keep: PlayheadPieces | null): void {
    if (!canTell(v)) return
    const urgent = this.urgent.get(v.id)
    const fetching = new Set([...v.wire.heldRequests, ...v.wire.peerRequests].map((r) => r.piece))
    const kept = new Uint8Array(this.n)
    if (keep) {
      kept.fill(1, keep.p, keep.p + keep.w + 1)
      // the audio intervals of a poorly interleaved file, which the walk takes first and may lie outside L1
      for (const [a, b] of keep.urgent) kept.fill(1, a, b + 1)
    }
    // the plan's end first: v's WebTorrent refills its pipeline with the next piece we still seem to have whenever
    // a donthave fails its requests, and the donthaves come in several reads. In plan order each refill took the
    // next retracted piece, whose donthave was right behind: a pipeline of requests per piece (ADR 0008 §4.1).
    // Backwards, the pieces it is fetching go last, and by then nothing retracted is left to refill with.
    for (const i of this.planOrder().reverse()) {
      if (!v.revealed[i] || this.isCritical[i] || urgent?.has(i) || v.wire.peerPieces.get(i)) continue
      if (kept[i]) continue
      if (fetching.has(i)) {
        v.exclusive.add(i) // host work in progress: counts against its budget
        continue
      }
      // a wire that fails here (or throws) is told nothing more: the rest stays revealed, never a timer throw
      if (v.advertised && !tellDonthave(v.wire, i)) return
      v.revealed[i] = 0
      v.exclusive.delete(i) // no longer advertised: nothing v could fetch from us, so not against its R
    }
  }

  /**
   * Every piece once, in the viewers' own order (orderRanges: hot window, critical ranges, L1, L2, L3), the order
   * the walk reveals in and a viewer fetches in.
   */
  private planOrder(): number[] {
    const { ranges } = orderRanges(this.n, { blocked: [], playhead: this.playhead, critical: this.critical })
    const seen = new Uint8Array(this.n)
    const order: number[] = []
    for (const [a, b] of ranges) {
      for (let i = a; i <= b; i++) {
        if (seen[i]) continue
        seen[i] = 1
        order.push(i)
      }
    }
    return order
  }

  /** v's urgent pieces that nothing brings it soon: revealed now (on a report, and again every tick). */
  private revealUrgent(v: View, now: number): void {
    for (const i of this.urgent.get(v.id)?.keys() ?? []) {
      if (!v.revealed[i] && !v.wire.peerPieces.get(i) && !this.onItsWay(v, i, now)) this.show(v, i, now)
    }
  }

  /**
   * Piece i reaches v through a viewer it has a lane to: one holds it, or was shown it and it saw a reveal or
   * a request within the rescue's idle time. Showing it to v as well would send it twice: after a group seek
   * every reader waits on the same pieces, and each would get them from the host (ADR 0003 Finding 9). Only
   * for waitLimitMs() from v's first report of it, though: a holder with a slow or limited uplink, or one that
   * does not serve it (or claims pieces it lacks), would keep v's reader blocked.
   */
  private onItsWay(v: View, i: number, now: number): boolean {
    const reported = this.urgent.get(v.id)?.get(i) ?? now
    if (now - reported > this.waitLimitMs()) return false
    const active = now - (this.lastActivity.get(i) ?? Number.NEGATIVE_INFINITY) <= RESCUE_IDLE_MS
    for (const u of this.views.values()) {
      if (u.id === v.id || u.wire.destroyed || !this.linked(u.id, v.id)) continue
      if (u.wire.peerPieces.get(i) || (active && !u.open && u.revealed[i])) return true
    }
    return false
  }

  /**
   * How long a reader waits for a piece on its way through another viewer: that viewer's own fetch of it from the
   * host, WAIT_PIECES pieces at one lane's share of the host upload (every lane busy, as after a group seek), plus
   * the rescue's idle time. A flat 3 s fell short of a 1 MiB piece at ~1 MB/s, and every reader got it.
   */
  private waitLimitMs(): number {
    let lanes = 0
    for (const u of this.views.values()) if (!u.wire.destroyed) lanes++
    const hostBps = this.hostBps ?? this.d.uploadLimitBps() ?? MIN_HOST_BPS
    return RESCUE_IDLE_MS + (WAIT_PIECES * 1000 * this.pieceLength * Math.max(1, lanes)) / hostBps
  }

  /** Reveal piece i to v as host work it must fetch: counted in its exclusive set (its budget). */
  private give(v: View, i: number, now: number): void {
    // an open view is shown everything and assigned nothing; counting a piece here would leave it in v's budget
    // after the take-back retracts it, which starves v of the walk until the next group seek
    if (v.open) return
    v.exclusive.add(i)
    this.show(v, i, now)
  }

  /** Reveal piece i to v (a 'have' once the advertisement is out; before that the bitfield carries it). */
  private show(v: View, i: number, now = this.now()): void {
    if (v.revealed[i]) return
    v.revealed[i] = 1
    this.lastActivity.set(i, now)
    if (v.advertised) v.wire.have(i)
  }

  private countUrgent(pieces: ReadonlyMap<number, number> | undefined, by: 1 | -1): void {
    for (const i of pieces?.keys() ?? []) this.urgentCount[i] = (this.urgentCount[i] ?? 0) + by
  }

  private linked(a: string, b: string): boolean {
    return (this.links.get(a)?.has(b) ?? false) && (this.links.get(b)?.has(a) ?? false)
  }

  /** Seconds until the group playhead reaches piece i: Infinity without a plan, or behind the playhead. */
  private deadlineS(i: number): number {
    const plan = this.plan
    if (!plan) return Number.POSITIVE_INFINITY
    const start = i * this.pieceLength
    if (start + this.pieceLength <= plan.byte) return Number.POSITIVE_INFINITY
    return Math.max(0, start - plan.byte) / Math.max(1, plan.windowBytes / L1_SECONDS)
  }

  /**
   * What the host sends at: the upload limit or the paced rate, whichever is lower, else an EWMA of the measured peak
   * upload. The last two are taken as at least 1 MB/s (the pacer sits at its 250 KB/s floor after a quiet spell, and a
   * budget of 2 pieces and a 28 s urgent wait would follow); a limit the user set is taken as it is.
   */
  private hostUploadBps(): number {
    const up = this.d.uploadBps()
    this.peakUpBps = Math.max(up, this.peakUpBps + (up - this.peakUpBps) * PEAK_ALPHA)
    const limit = this.d.uploadLimitBps()
    const paced = this.d.pacedBps?.() ?? null
    const host = paced === null ? null : Math.max(MIN_HOST_BPS, paced)
    if (limit === null) return host ?? Math.max(MIN_HOST_BPS, this.peakUpBps)
    return host === null ? limit : Math.min(limit, host)
  }
}

/**
 * v can be told it lost a piece: not advertised yet (the bitfield will say it), or lt_donthave has a non-zero id in
 * its latest BEP 10 handshake (what wire.extended() requires).
 */
function canTell(v: View): boolean {
  return !v.advertised || (v.wire.peerExtendedMapping.lt_donthave ?? 0) > 0
}

/** BEP 54 'donthave' for piece i; false when the wire threw (it runs in the Revealer's timer). */
function tellDonthave(wire: Wire, i: number): boolean {
  try {
    wire.lt_donthave.donthave(i)
    return true
  } catch {
    return false
  }
}

/** BitTorrent bitfield: piece 0 is the high bit of byte 0. */
export function packBits(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(flags.length / 8))
  for (let i = 0; i < flags.length; i++) if (flags[i]) out[i >> 3] = (out[i >> 3] ?? 0) | (128 >> (i & 7))
  return out
}
