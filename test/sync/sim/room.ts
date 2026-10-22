import { SyncEngine } from '../../../src/core/sync/engine.js'
import type { GroupSnapshot } from '../../../src/core/sync/group.js'
import type { SyncState } from '../../../src/core/sync/protocol.js'
import type { NoticeEvent, PlaybackIntent, Perms } from '../../../src/shared/ipc/core.js'
import type { StartMode } from '../../../src/shared/settings.js'
import { FakeMedia, type MediaOpts } from './fake-media.js'
import { FakeMpv, type MpvOpts } from './fake-mpv.js'
import { EventLoop, NodeClock, type Rng, rng, uniform } from './loop.js'
import { type LinkSpec, Network } from './network.js'

export interface NodeSpec {
  id: string
  name?: string
  offsetMs?: number
  skewPpm?: number
  mpv?: Partial<MpvOpts>
  media?: Partial<MediaOpts>
  nudge?: boolean
  /** false: datagrams unusable (via-peer member, or relayed link without datagrams) */
  datagrams?: boolean
}

export interface RoomOpts {
  seed: number
  durationS?: number
  host?: Partial<NodeSpec>
  viewers: NodeSpec[]
  link?: (a: string, b: string, r: Rng) => LinkSpec
  waitForAll?: boolean
  perms?: Perms
  startMode?: StartMode
  resume?: GroupSnapshot
  /** the file plays only once completely downloaded (the host's mediaReady says so) */
  fullDownload?: boolean
  /** random offsets of ±1 h and skews of ±100 ppm unless a spec sets them */
  randomClocks?: boolean
}

export class SimNode {
  readonly notices: NoticeEvent[] = []
  /** every applied state, in order, with the true time */
  readonly applied: { t: number; state: SyncState }[] = []
  readonly persisted: GroupSnapshot[] = []
  engine!: SyncEngine

  constructor(
    readonly id: string,
    readonly name: string,
    readonly clock: NodeClock,
    readonly mpv: FakeMpv,
    readonly media: FakeMedia,
  ) {}

  get mode(): SyncState['mode'] | null {
    return this.engine.member.state?.mode ?? null
  }
}

export const HOST = 'host'

export class SimRoom {
  readonly loop = new EventLoop()
  readonly r: Rng
  readonly net: Network
  readonly nodes = new Map<string, SimNode>()
  /** replaced by restartHost() */
  host: SimNode
  readonly viewers: SimNode[]
  readonly durationS: number

  constructor(readonly o: RoomOpts) {
    this.r = rng(o.seed)
    this.durationS = o.durationS ?? 7200
    const link = o.link ?? (() => ({ latencyMs: 20, jitterMs: 5, loss: 0 }))
    this.net = new Network(this.loop, rng(o.seed ^ 0x5eed), (a, b) => link(a, b, this.r))
    this.host = this.makeNode({ ...o.host, id: HOST, name: o.host?.name ?? 'Host' }, true)
    this.viewers = o.viewers.map((v) => this.makeNode(v, false))
    // viewers notice a host that stops talking, as the session's presence adapter does
    for (const v of this.viewers) this.net.watchSilence(v.id, HOST)
  }

  get t(): number {
    return this.loop.t
  }

  node(id: string): SimNode {
    const n = this.nodes.get(id)
    if (!n) throw new Error(`no node ${id}`)
    return n
  }

  /**
   * Connect everyone (but `later`), start engines, index the media and load it everywhere (but `noSource`: in
   * the room without a stream yet, e.g. a download that must complete first; give it with setSource).
   */
  start(later: string[] = [], noSource: string[] = []): void {
    const now = [...this.nodes.values()].filter((n) => !later.includes(n.id))
    for (const a of now) for (const b of now) if (a.id < b.id) this.net.connect(a.id, b.id)
    for (const n of now) n.engine.start()
    this.host.engine.mediaReady(this.durationS, { fullDownload: this.o.fullDownload ?? false })
    for (const n of now) if (!noSource.includes(n.id)) n.engine.setSource(`sim://${n.id}`)
  }

  /** A late joiner: admitted, connected to everyone, then loads once its engine runs. */
  join(id: string): void {
    for (const other of this.nodes.keys()) if (other !== id) this.net.connect(id, other)
    const n = this.node(id)
    n.engine.start()
    n.engine.setSource(`sim://${id}`)
  }

  run(ms: number): void {
    this.loop.runFor(ms)
  }

  runUntil(pred: () => boolean, maxMs: number, stepMs = 10): boolean {
    const end = this.loop.t + maxMs
    while (this.loop.t < end) {
      if (pred()) return true
      this.loop.runFor(stepMs)
    }
    return pred()
  }

  intent(id: string, i: PlaybackIntent): Promise<{ accepted: boolean; reason?: string }> {
    return this.node(id).engine.intent(i)
  }

  /**
   * The host's process restarted: a new clock (performance.now starts over at `offsetMs`), a new engine that
   * resumes `resume`, the same identity. Its links come back at once; its engine starts `engineAfterMs` later
   * (the session re-prepares first), as the old process's sticky state is gone.
   */
  restartHost(o: { offsetMs: number; resume: GroupSnapshot; engineAfterMs: number }): SimNode {
    const old = this.host
    old.engine.stop()
    this.net.kill(HOST)
    const node = this.makeNode({ ...this.o.host, id: HOST, name: old.name, offsetMs: o.offsetMs }, true, o.resume)
    this.host = node
    for (const v of this.viewers) this.net.connect(HOST, v.id)
    this.loop.after(o.engineAfterMs, () => {
      node.engine.start()
      for (const v of this.viewers) this.net.announce(HOST, v.id)
      node.engine.mediaReady(this.durationS, { fullDownload: this.o.fullDownload ?? false })
      node.engine.setSource(`sim://${HOST}`)
    })
    return node
  }

  /** True time at which the host's anchor hostTime falls. */
  anchorTrueTime(): number | null {
    const st = this.host.engine.group?.state()
    return st ? this.host.clock.toTrue(st.anchor.hostTime) : null
  }

  /** Sample viewer − host audio position (ms) every stepMs while both run and the room plays. */
  recordDrift(stepMs = 100): DriftRecorder {
    const rec = new DriftRecorder()
    this.loop.every(stepMs, () => {
      if (this.host.mode !== 'playing' || !this.host.mpv.isRunning) return
      const h = this.host.mpv.pos()
      for (const v of this.viewers) {
        if (!v.mpv.isRunning || v.mode !== 'playing') continue
        rec.add(v.id, this.loop.t, (v.mpv.pos() - h) * 1000)
      }
    })
    return rec
  }

  private makeNode(spec: NodeSpec, isHost: boolean, resume = this.o.resume): SimNode {
    const random = this.o.randomClocks ?? true
    const offsetMs = spec.offsetMs ?? (random ? 1e7 + uniform(this.r, -3.6e6, 3.6e6) : 1e7)
    const skewPpm = spec.skewPpm ?? (random ? uniform(this.r, -100, 100) : 0)
    const nodeRng = rng(Math.floor(this.r() * 2 ** 32))
    const clock = new NodeClock(this.loop, nodeRng, { offsetMs, skewPpm, timerLateMs: 1.5 })
    const media = new FakeMedia(this.loop, {
      durationS: this.durationS,
      ...(isHost ? { complete: true } : {}),
      ...spec.media,
    })
    const mpv = new FakeMpv(this.loop, nodeRng, clock, media, spec.mpv)
    const name = spec.name ?? spec.id
    const node = new SimNode(spec.id, name, clock, mpv, media)
    this.net.add(spec.id, name)
    const dgOk = spec.datagrams ?? true
    node.engine = new SyncEngine({
      role: isHost ? 'host' : 'viewer',
      selfId: spec.id,
      selfName: name,
      hostId: HOST,
      nudge: spec.nudge ?? true,
      ports: {
        clock,
        player: mpv,
        bus: this.net.busPort(spec.id),
        datagram: this.net.datagramPort(spec.id, (peer) => dgOk && (this.nodeSpecDatagrams(peer) ?? true)),
        media,
        transfer: media,
      },
      ...(isHost
        ? {
            host: {
              syncEpoch: 0x1234,
              perms: this.o.perms ?? { othersPlayPause: false, othersSeek: false },
              waitForAll: this.o.waitForAll ?? true,
              startMode: this.o.startMode ?? { kind: 'buffered', seconds: 0 },
              resume,
            },
          }
        : {}),
    })
    node.engine.on('notice', (n) => node.notices.push(n))
    node.engine.on('state', (st) => node.applied.push({ t: this.loop.t, state: st }))
    node.engine.on('persist', (s) => node.persisted.push(s))
    this.nodes.set(spec.id, node)
    return node
  }

  private nodeSpecDatagrams(id: string): boolean | undefined {
    return this.o.viewers.find((v) => v.id === id)?.datagrams
  }
}

export class DriftRecorder {
  readonly samples: { id: string; t: number; ms: number }[] = []

  add(id: string, t: number, ms: number): void {
    this.samples.push({ id, t, ms })
  }

  abs(fromT = 0, toT = Infinity): number[] {
    return this.samples.filter((s) => s.t >= fromT && s.t <= toT).map((s) => Math.abs(s.ms))
  }
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN
}

/** Typical internet link for the scenarios: RTT 20–300 ms, 20 ms jitter, asymmetric by up to ±20 %. */
export function wanLink(loss: number): (a: string, b: string, r: Rng) => LinkSpec {
  const base = new Map<string, number>()
  return (a, b, r) => {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`
    let rtt = base.get(k)
    if (rtt === undefined) base.set(k, (rtt = uniform(r, 20, 300)))
    const share = 0.5 * uniform(r, 0.8, 1.2)
    return { latencyMs: rtt * share, jitterMs: 20, loss }
  }
}
