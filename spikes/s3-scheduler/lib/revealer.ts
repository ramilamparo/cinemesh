// Host-assigned striping (plan §4.2 "Revealer"): the host advertises to each viewer only the pieces it
// has revealed to that viewer, so every upcoming piece leaves the host once and spreads viewer-to-viewer.
import type { Torrent, Wire } from 'webtorrent'

export type Range = [number, number]

export interface RevealerOpts {
  /** off = plain seeding (haveAll); measures the no-striping baseline with the same accounting */
  striping: boolean
  pieceLength: number
  bitrate: number // bytes/s of the shared playhead
  deadlineS: number // plan: 8 s
  /**
   * 'everyone' (plan): below deadlineS, reveal to every viewer lacking the piece.
   * 'rescue': below deadlineS, only if no viewer holds the piece and the host has not served any block of
   * it for rescueAfterMs since its last reveal, reveal it to one more viewer (the fastest lacking one).
   */
  deadlineMode: 'everyone' | 'rescue' | 'none'
  rescueAfterMs: number
  tickMs: number // plan: 250 ms
  /** max exclusive reveals a viewer may hold without having them; 'auto' = 4 s of host upload by weight */
  R: number | 'auto'
  hostRate: number // bytes/s, for R = 'auto'
  openCritical: Range[]
  /** group plan in request order (urgent -> L1 -> L2 -> L3), as the viewers' schedulers build it */
  plan: () => number[]
  /** first piece not yet played; pieces before it are behind the playhead (no deadline) */
  playheadPiece: () => number
  /** seconds until piece i is played (Infinity behind the playhead) */
  deadline: (i: number) => number
  viewerOf: (wire: Wire) => string
  linked: (a: string, b: string) => boolean
  /**
   * 'full' (plan): only a viewer with a bt link to every other viewer may be an exclusive assignee.
   * 'connected': any viewer may be, as long as the viewer graph is connected (pieces then travel
   * two hops to a viewer that has no direct link to the assignee).
   */
  eligibility: 'full' | 'connected'
  clock?: () => number
}

interface View {
  name: string
  wire: Wire
  revealed: Uint8Array // 1 = advertised to this viewer
  exclusive: Set<number> // pieces assigned to this viewer alone that it does not have yet
  rate: number // smoothed host -> viewer bytes/s
}

export interface ServeRecord {
  t: number
  viewer: string
  piece: number
  offset: number
  length: number
  revealed: boolean
}

export class Revealer {
  readonly views = new Map<string, View>()
  readonly served: ServeRecord[] = []
  readonly stats = {
    exclusive: 0,
    everyone: { open: 0, deadline: 0, single: 0, unlinked: 0 },
    rescues: 0,
    budgetStops: 0,
    ticks: 0,
  }
  /** last reveal time and last served-block time per piece (any viewer) */
  private readonly lastReveal = new Map<number, number>()
  private readonly lastServed = new Map<number, number>()
  /** reveal time per viewer:piece, to measure have -> request latency */
  readonly revealedAt = new Map<string, number>()
  readonly firstRequestAt = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly t: Torrent,
    private readonly o: RevealerOpts,
  ) {
    t.on('wire', (wire: Wire) => this.onWire(wire))
  }

  start(): void {
    if (this.o.striping) this.timer = setInterval(() => this.tick(), this.o.tickMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  private now(): number {
    return this.o.clock ? this.o.clock() : performance.now()
  }

  /**
   * THE HOOK. The torrent's 'wire' event is emitted synchronously in _onWire (torrent.js:1383); the
   * advertisement happens later, in _onWireWithMetadata, queued as a microtask (torrent.js:1385-1390)
   * or, for a torrent that is not ready yet, from _onStore (torrent.js:943). It calls exactly one of
   * wire.haveAll() / wire.haveNone() / wire.bitfield(this.bitfield) (torrent.js:1492-1494), looked up
   * on the wire object, so own properties set here shadow the bittorrent-protocol prototype methods.
   */
  private onWire(wire: Wire): void {
    const name = this.o.viewerOf(wire)
    const n = this.t.pieces.length
    const view: View = { name, wire, revealed: new Uint8Array(n), exclusive: new Set(), rate: 0 }
    this.views.set(name, view)
    wire.once('close', () => {
      if (this.views.get(name) === view) this.views.delete(name)
    })

    // accounting (both modes): every block the host serves, and whether that piece was advertised
    const w = wire as Wire & { piece: (i: number, o: number, b: Uint8Array) => void; on: Wire['on'] }
    const piece = w.piece
    w.piece = (index: number, offset: number, buffer: Uint8Array) => {
      this.served.push({
        t: this.now(),
        viewer: name,
        piece: index,
        offset,
        length: buffer.length,
        revealed: !this.o.striping || view.revealed[index] === 1,
      })
      this.lastServed.set(index, this.now())
      return piece.call(wire, index, offset, buffer)
    }
    w.on('request', (index: number) => {
      const k = `${name}:${index}`
      if (!this.firstRequestAt.has(k)) this.firstRequestAt.set(k, this.now())
    })

    if (!this.o.striping) return
    for (const [a, b] of this.o.openCritical) for (let i = a; i <= Math.min(b, n - 1); i++) view.revealed[i] = 1
    const sendBitfield = wire.bitfield.bind(wire) // bittorrent-protocol's own method
    const advertise = (): void => sendBitfield(packBits(view.revealed))
    wire.haveAll = advertise
    wire.haveNone = advertise
    wire.bitfield = advertise
    for (const [a, b] of this.o.openCritical)
      for (let i = a; i <= b; i++) this.revealedAt.set(`${name}:${i}`, this.now())
  }

  private reveal(v: View, i: number): void {
    if (v.revealed[i]) return
    v.revealed[i] = 1
    this.revealedAt.set(`${v.name}:${i}`, this.now())
    this.lastReveal.set(i, this.now())
    v.wire.have(i)
  }

  /** One pass over the group plan; see the report for the rules. */
  tick(): void {
    this.stats.ticks++
    const views = [...this.views.values()].filter((v) => !(v.wire as Wire & { destroyed: boolean }).destroyed)
    if (views.length === 0) return
    const has = (v: View, i: number) => v.wire.peerPieces.get(i)
    for (const v of views) {
      for (const i of v.exclusive) if (has(v, i)) v.exclusive.delete(i)
      v.rate = 0.7 * v.rate + 0.3 * v.wire.uploadSpeed()
    }
    const totalRate = views.reduce((s, v) => s + Math.max(v.rate, 1), 0)
    const budget = (v: View): number => {
      if (this.o.R !== 'auto') return this.o.R
      const share = Math.max(v.rate, 1) / totalRate
      return Math.max(2, Math.ceil((4 * this.o.hostRate * share) / this.o.pieceLength))
    }
    const fullyLinked = (v: View) => views.every((u) => u === v || this.o.linked(v.name, u.name))
    const inOpen = (i: number) => this.o.openCritical.some(([a, b]) => i >= a && i <= b)

    for (const i of this.o.plan()) {
      const lacking = views.filter((v) => !has(v, i))
      if (lacking.length === 0) continue
      let reason: keyof typeof this.stats.everyone | null = null
      if (inOpen(i)) reason = 'open'
      else if (views.length === 1) reason = 'single'
      else if (this.o.deadlineMode === 'everyone' && this.o.deadline(i) < this.o.deadlineS) reason = 'deadline'
      if (reason) {
        let any = false
        for (const v of lacking) {
          if (!v.revealed[i]) {
            this.reveal(v, i)
            any = true
          }
        }
        if (any) this.stats.everyone[reason]++
        continue
      }
      const holders = views.filter((v) => has(v, i))
      if (holders.length) {
        // it spreads by normal 'have's; only a viewer linked to no holder needs it from the host
        if (this.o.eligibility === 'full') {
          for (const v of lacking)
            if (!v.revealed[i] && !holders.some((h) => this.o.linked(h.name, v.name))) this.reveal(v, i)
        }
        continue
      }
      if (views.some((v) => v.revealed[i])) {
        // striped but nobody holds it yet: rescue a stuck piece close to its deadline
        if (this.o.deadlineMode === 'rescue' && this.o.deadline(i) < this.o.deadlineS) {
          const since = Math.max(this.lastReveal.get(i) ?? 0, this.lastServed.get(i) ?? 0)
          if (this.now() - since > this.o.rescueAfterMs) {
            const next = lacking.filter((v) => !v.revealed[i]).sort((a, b) => b.rate - a.rate)[0]
            if (next) {
              this.reveal(next, i)
              this.stats.rescues++
            }
          }
        }
        continue
      }
      const eligible = this.o.eligibility === 'full' ? lacking.filter(fullyLinked) : lacking
      if (eligible.length === 0) {
        for (const v of lacking) this.reveal(v, i)
        this.stats.everyone.unlinked++
        continue
      }
      // weighted round robin: the viewer with the most free budget relative to its rate
      let best: View | null = null
      let bestScore = Infinity
      for (const v of eligible) {
        if (v.exclusive.size >= budget(v)) continue
        const score = (v.exclusive.size + 1) / Math.max(v.rate, 1)
        if (score < bestScore) {
          bestScore = score
          best = v
        }
      }
      if (!best) {
        this.stats.budgetStops++
        break // every eligible viewer is at R: stop here so reveals stay in plan order
      }
      best.exclusive.add(i)
      this.reveal(best, i)
      this.stats.exclusive++
    }
  }

  /** host bytes served / distinct piece bytes served */
  dupFactor(since = 0): { total: number; distinct: number; dupFactor: number; unrevealed: number } {
    let total = 0
    let distinct = 0
    let unrevealed = 0
    const seen = new Set<string>()
    for (const r of this.served) {
      if (r.t < since) continue
      total += r.length
      if (!r.revealed) unrevealed++
      const k = `${r.piece}:${r.offset}`
      if (!seen.has(k)) {
        seen.add(k)
        distinct += r.length
      }
    }
    return { total, distinct, dupFactor: distinct ? total / distinct : 0, unrevealed }
  }

  /** time from wire.have(i) to that viewer's first request for i (exclusive and everyone reveals) */
  revealToRequestMs(): number[] {
    const out: number[] = []
    for (const [k, t] of this.revealedAt) {
      const r = this.firstRequestAt.get(k)
      if (r !== undefined && r >= t) out.push(r - t)
    }
    return out
  }
}

/** BitTorrent bitfield: piece 0 is the high bit of byte 0 (same layout as the 'bitfield' package). */
export function packBits(flags: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(flags.length / 8))
  for (let i = 0; i < flags.length; i++) if (flags[i]) out[i >> 3]! |= 128 >> (i & 7)
  return out
}
