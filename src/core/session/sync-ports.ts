import { EventEmitter } from 'node:events'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { PlaybackIntent } from '../../shared/ipc/core.js'
import type { MediaMap } from '../../shared/media/media-map.js'
import { type ReadinessReason as MediaReason, readiness, readinessAheadS } from '../../shared/media/readiness.js'
import type { Manifest } from '../../shared/media/types.js'
import { CodedError } from '../../shared/result.js'
import type { BusPolicy } from '../net/bus.js'
import type { MemberView, Room, RoomState } from '../net/room.js'
import { DATAGRAM_SYNC } from '../net/wire.js'
import { PLAYER_ERRORS, type SubtitleSpec } from '../player/player-controller.js'
import type {
  BusPort,
  Clock,
  DatagramPort,
  MediaPort,
  PlayerEvents,
  PlayerPort,
  PlayerSnapshot,
  PlayheadReason,
  PresenceEvent,
  ReadinessReason,
  TransferPort,
  Unsubscribe,
} from '../sync/ports.js'
import type { SyncBusMessage, SyncState } from '../sync/protocol.js'
import type { PlayerLike } from './player-like.js'

// Adapters from the real modules to the sync engine's ports (src/core/sync/ports.ts, README "Port adapters").

type Log = (msg: string, e?: unknown) => void

/** The event-loop histogram's timer interval: it records whole intervals, so an idle loop reads this much. */
export const LOOP_RESOLUTION_MS = 10

export type LoopHistogram = Pick<ReturnType<typeof monitorEventLoopDelay>, 'enable' | 'disable' | 'reset' | 'max'>

/**
 * Monotonic ms on performance.now(), the same clock the player stamps IPC samples with. `hist` is for tests;
 * it must run at LOOP_RESOLUTION_MS.
 */
export function createClock(
  hist: LoopHistogram = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS }),
): Clock & { dispose(): void } {
  hist.enable()
  let recentMaxMs = 0
  const roll = setInterval(() => {
    recentMaxMs = hist.max / 1e6
    hist.reset()
  }, 1000)
  roll.unref()
  return {
    now: () => performance.now(),
    setTimer(ms, fn) {
      const t = setTimeout(fn, Math.max(0, ms))
      return { cancel: () => clearTimeout(t) }
    },
    immediate(fn) {
      const t = setImmediate(fn)
      return { cancel: () => clearImmediate(t) }
    },
    // the delay beyond the timer's own interval (ADR 0007 Finding 9): the drift gate's 20 ms means 20 ms of lag
    loopLagMs: () => Math.max(0, Math.max(recentMaxMs, hist.max / 1e6) - LOOP_RESOLUTION_MS),
    dispose() {
      clearInterval(roll)
      hist.disable()
    },
  }
}

// Only these accept commands: while spawning/connecting there is no IPC yet, and a load would be lost.
const AVAILABLE = new Set(['idle', 'loading', 'ready'])

/**
 * Runs a player call now and gives its outcome as a promise, also when it throws instead of rejecting
 * (PlayerController.seek's requireIpc throws once the IPC closed): the member calls from its timers, where a
 * throw is uncaught. Not deferred: commands must reach mpv in the member's order (a seek after its setPaused).
 */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call()
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }
}

/** No frame is longer than this as far as sync is concerned (a slideshow's container-fps can be far below 1). */
const MAX_FRAME_S = 1
/** container-fps above this is not a real frame rate (a timebase) */
const MAX_FPS = 240

/**
 * The frame length from mpv's container-fps, 1/24 s when the file has none: a seek or load lands up to a frame past
 * its target, so a fixed 1/24 took a 12 fps file's landing for someone else's load (ADR 0007 Finding 4).
 */
export function frameSeconds(containerFps: unknown): number {
  if (typeof containerFps !== 'number' || !Number.isFinite(containerFps) || containerFps <= 0) return 1 / 24
  if (containerFps > MAX_FPS) return 1 / 24
  return Math.min(MAX_FRAME_S, 1 / containerFps)
}

export class PlayerPortAdapter implements PlayerPort {
  private readonly events = new EventEmitter()
  /** load() calls so far: only the latest one's failure is reported */
  private loads = 0

  constructor(
    private readonly player: PlayerLike,
    private readonly opts: { subtitles: () => SubtitleSpec[]; title: string | null; log: Log },
  ) {
    player.on('intent', (i) => {
      if (i.kind === 'play' || i.kind === 'pause') this.fire('intent', { kind: i.kind })
      else if (i.kind === 'seek' && typeof i.pos === 'number') this.fire('intent', { kind: 'seek', posS: i.pos })
    })
    player.on('playbackRestart', () => this.fire('playbackRestart', undefined))
    player.on('audioReconfig', () => this.fire('audioReconfig', undefined))
    player.on('external-change', (c) => this.fire('externalChange', { kind: c.kind }))
    player.on('eof', (on) => {
      if (on) this.fire('eof', undefined)
    })
    player.on('property', (name, value) => {
      if (name === 'paused-for-cache') this.fire('buffering', value === true)
      this.fire('state', this.snapshot())
    })
    player.on('state', () => this.fire('state', this.snapshot()))
  }

  load(src: string, opts: { startS: number; paused: boolean }): void {
    const seq = ++this.loads
    const o = this.opts
    attempt(() =>
      this.player.load(src, { start: opts.startS, paused: opts.paused, title: o.title, subtitles: o.subtitles() }),
    ).catch((e: unknown) => {
      this.opts.log('player load failed', e)
      // No playback-restart will come for it (another client's file replaced it, mpv could not open it, or
      // went away): the member loads again by its own rule instead of waiting for one. Only for the latest
      // load: an older one replaced by our own later load is no news, and would cancel that one's wait.
      if (seq === this.loads) {
        this.fire('loadFailed', { superseded: e instanceof CodedError && e.code === PLAYER_ERRORS.superseded })
      }
      // the IPC dropped under the load: a state event lets the member see the player is gone
      this.fire('state', this.snapshot())
    })
  }

  seek(posS: number): void {
    attempt(() => this.player.seek(posS)).catch((e: unknown) => this.opts.log('player seek failed', e))
  }

  setPaused(paused: boolean): void {
    attempt(() => this.player.setPaused(paused)).catch((e: unknown) => this.opts.log('player pause failed', e))
  }

  setSpeed(speed: number): void {
    attempt(() => this.player.setSpeed(speed)).catch((e: unknown) => this.opts.log('player speed failed', e))
  }

  sample(cb: (s: { posS: number; tSend: number; tRecv: number } | null) => void): void {
    attempt(() => this.player.sample()).then(
      (s) => cb(typeof s.value === 'number' ? { posS: s.value, tSend: s.tSend, tRecv: s.tRecv } : null),
      () => cb(null),
    )
  }

  readTimePos(cb: (posS: number | null) => void): void {
    // a get_property, not the observed value: mpv notifies time-pos only ~50 ms after a paused seek's restart
    attempt(() => this.player.getProperty('time-pos')).then(
      (r) => cb(typeof r.value === 'number' ? r.value : null),
      () => cb(null),
    )
  }

  snapshot(): PlayerSnapshot {
    const p = this.player
    const audioOut = p.prop('audio-out-params') as { format?: unknown } | null
    const drops = p.frameDrops()
    return {
      available: AVAILABLE.has(p.status),
      loaded: p.status === 'ready',
      paused: p.prop('pause') === true,
      pausedForCache: p.prop('paused-for-cache') === true,
      seeking: p.prop('seeking') === true,
      coreIdle: p.prop('core-idle') === true,
      eof: p.prop('eof-reached') === true,
      timePosS: typeof p.prop('time-pos') === 'number' ? (p.prop('time-pos') as number) : null,
      speed: typeof p.prop('speed') === 'number' ? (p.prop('speed') as number) : 1,
      spdif: typeof audioOut?.format === 'string' && audioOut.format.startsWith('spdif'),
      frameDrops: drops.vo + drops.decoder,
      frameS: frameSeconds(p.prop('container-fps')),
    }
  }

  on<E extends keyof PlayerEvents>(event: E, fn: (data: PlayerEvents[E]) => void): Unsubscribe {
    this.events.on(event, fn)
    return () => this.events.off(event, fn)
  }

  private fire<E extends keyof PlayerEvents>(event: E, data: PlayerEvents[E]): void {
    this.events.emit(event, data)
  }
}

/**
 * Per-origin rates for the sync names members send. NET_POLICIES makes sync.state and sync.intentResult host-only
 * (net defines them, untouched here); nothing limited the rest, so one member could make the host toast and every
 * member forward without end. Every member's bus applies these to what it receives, before it forwards: a flood
 * gets its burst through and stops at one hop. Each allows more than sync itself sends.
 */
export const SYNC_BUS_POLICIES: Readonly<Record<string, BusPolicy>> = {
  // on start and whenever the host's presence comes back
  'sync.hello': { rate: { burst: 3, everyMs: 2000 } },
  // Ask host, a click each
  'sync.request': { rate: { burst: 3, everyMs: 3000 } },
  // play, pause, seek: a few in a row while scrubbing
  'sync.intent': { rate: { burst: 5, everyMs: 250 } },
  // 1 Hz, plus phase and barrier changes, which come a few at a time (seeking, ready, playing)
  'sync.status': { rate: { burst: 10, everyMs: 100 } },
  // bus pings (no datagrams): 5 at 100 ms, again when the host comes back, then 1 per s
  'sync.ping': { rate: { burst: 8, everyMs: 500 } },
  // only the host answers pings
  'sync.pong': { hostOnly: true },
}

/** Before sync starts, on every member: also a member that only forwards needs the rates. */
export function defineSyncPolicies(room: Pick<Room, 'defineMessage'>): void {
  for (const [name, policy] of Object.entries(SYNC_BUS_POLICIES)) room.defineMessage(name, policy)
}

const PRESENCE_RECHECK_MS = 2000
/**
 * The host publishes room.hb every second (other members every 5 s): a host this long without a word is gone,
 * even while its link looks open. A crashed process sends nothing more, and UDX gives up on its link ~15 s later.
 */
export const HOST_SILENT_MS = 7000
/** bus namespaces whose messages from the host show it is alive (room.hb among them) */
const HOST_TRAFFIC = ['room', 'sync', 'session'] as const

export class BusPortAdapter implements BusPort {
  constructor(
    private readonly room: Room,
    private readonly hostId: string,
    private readonly log: Log,
  ) {}

  publish(msg: SyncBusMessage, opts: { to?: string; sticky?: boolean } = {}): void {
    try {
      // Each message goes under its own name (msg.t); stickiness comes from the name's policy, not opts.sticky.
      // Net cannot address a sticky name, so the group's addressed sync.state (its answer to a sync.hello) goes
      // to everyone, and every member keeps and forwards it. The engine answers a member's hellos at most once a
      // second and each bus takes only a few per origin (SYNC_BUS_POLICIES), so hellos cannot make a flood of it.
      const to = msg.t === 'sync.state' ? undefined : opts.to
      this.room.publish(msg.t, msg, to ? { to } : {})
    } catch (e) {
      this.log(`sync publish ${msg.t} failed`, e)
    }
  }

  onMessage(fn: (from: string, raw: unknown) => void): Unsubscribe {
    const off = this.room.onMessage('sync', (m) => {
      if (m.via !== null) fn(m.from, m.body) // the group loops back to the host's own member itself
    })
    if (this.hostId === this.room.self) return off
    // The sticky sync.state replayed when the host link opened usually predates this subscription (viewers
    // start sync only after JoinConfirm): hand over the stored one, body unchanged so its sentAt still dates
    // it. Read when the immediate fires, so it is the newest the bus holds (room.latest() reports via null).
    const t = setImmediate(() => {
      const held = this.room.latest('sync.state')
      if (held?.from === this.hostId) fn(held.from, held.body)
    })
    return () => {
      clearImmediate(t)
      off()
    }
  }

  /**
   * Viewers track the host. It is present while RoomState.hostPresent holds (a direct link, or host traffic
   * within net's 10 s, so via-peer viewers keep it) and it was heard from within HOST_SILENT_MS: any of its
   * bus messages (its room.hb every second), direct or forwarded, or a sync datagram. Silence is how a crash, a
   * sleeping laptop or a lost network shows: the link stays open until UDX gives up on it ~15 s later. A
   * leave carries how long ago the host was last heard from, so sync's 10 s grace counts from its last word.
   * Sharper signals: a host link opening is a join even while the host still counted as present (a quick
   * restart: the engine says hello again and restarts its clock pings). The host's bye (it quit, the room
   * stays; the bye is its last word) and its link closing while we are in the room are a leave at once; both
   * last until the host shows up again through a new link or its traffic forwarded by a neighbour (frames
   * still arriving on the old link do not count). The host tracks everyone else from the members list,
   * re-read every 2 s because a via-peer entry going stale emits no event.
   */
  onPresence(fn: (ev: PresenceEvent) => void): Unsubscribe {
    const isHost = this.hostId === this.room.self
    const now = (): number => performance.now()
    let present = new Map<string, string>()
    // the engine says hello and starts pinging on start; only an absent host needs an event now
    let hostHere = isHost || this.room.state().hostPresent
    let heardAt = now()
    // after a bye or the host link closing, hostPresent is only the host's traffic window running out: ignore
    // it until the host shows up again (a link, or its traffic through a neighbour)
    let away = false
    const hostName = (): string => this.room.members().find((m) => m.id === this.hostId)?.name ?? 'Host'
    const report = (here: boolean): void => {
      hostHere = here
      const ev: PresenceEvent = { kind: here ? 'join' : 'leave', peerId: this.hostId, name: hostName() }
      if (!here) ev.sinceMs = Math.max(0, Math.round(now() - heardAt))
      fn(ev)
    }
    const updateHost = (hostPresent: boolean): void => {
      const here = hostPresent && !away && now() - heardAt < HOST_SILENT_MS
      if (!isHost && here !== hostHere) report(here)
    }
    const goneAway = (): void => {
      away = true
      updateHost(false)
    }
    const updateMembers = (members: MemberView[]): void => {
      const next = new Map(
        members
          .filter((m) => !m.self && m.id !== this.hostId && (m.linked || m.path === 'via-peer'))
          .map((m) => [m.id, m.name]),
      )
      for (const [id, name] of next) if (!present.has(id)) fn({ kind: 'join', peerId: id, name })
      for (const [id, name] of present) if (!next.has(id)) fn({ kind: 'leave', peerId: id, name })
      present = next
    }
    const onState = (s: RoomState): void => updateHost(s.hostPresent)
    const onPeer = (p: { id: string }): void => {
      if (isHost || p.id !== this.hostId) return
      away = false
      heardAt = now()
      report(true)
    }
    // Our own leave, a kick or an ended room set the phase before net retires the links: not the host leaving.
    const onGone = (id: string): void => {
      if (!isHost && id === this.hostId && this.room.state().phase === 'in-room') goneAway()
    }
    // end: true closes the room (the session shows that); end: false is the host leaving a room that lives on
    const onBye = (b: { peerId: string; end: boolean }): void => {
      if (isHost || b.peerId !== this.hostId || b.end) return
      heardAt = now()
      goneAway()
    }
    // our own messages (via null) are never the host's: we are a viewer here
    const onTraffic = (m: { from: string; via: string | null }): void => {
      if (m.from !== this.hostId) return
      heardAt = now()
      // forwarded by a neighbour: the host is up, whatever became of our link to it
      if (m.via !== this.hostId) away = false
      // net refreshes hostPresent only after this handler: the host just spoke, so it is present
      updateHost(true)
    }
    const onDatagram = (peer: { id: string }): void => {
      if (peer.id !== this.hostId) return
      heardAt = now()
      updateHost(this.room.state().hostPresent)
    }
    const offTraffic = isHost
      ? []
      : [
          ...HOST_TRAFFIC.map((ns) => this.room.onMessage(ns, onTraffic)),
          this.room.onDatagram(DATAGRAM_SYNC, onDatagram),
        ]
    if (!hostHere) report(false)
    updateMembers(this.room.members())
    this.room.on('state', onState)
    this.room.on('members', updateMembers)
    this.room.on('peer', onPeer)
    this.room.on('peer-gone', onGone)
    this.room.on('bye', onBye)
    // also how silence is noticed: nothing else happens when a host stops talking
    const timer = setInterval(() => {
      updateMembers(this.room.members())
      updateHost(this.room.state().hostPresent)
    }, PRESENCE_RECHECK_MS)
    timer.unref()
    return () => {
      clearInterval(timer)
      for (const off of offTraffic) off()
      this.room.off('state', onState)
      this.room.off('members', updateMembers)
      this.room.off('peer', onPeer)
      this.room.off('peer-gone', onGone)
      this.room.off('bye', onBye)
    }
  }
}

/**
 * OSC Space: pause when the room is playing or about to resume playing (a seek or buffering barrier with
 * resumeAs 'playing'), else play; the same rule as SyncEngine's own toggle.
 */
export function toggleKind(st: SyncState | null | undefined): 'play' | 'pause' {
  const running = st?.mode === 'playing' || (st?.mode === 'waiting' && st.wait?.resumeAs === 'playing')
  return running ? 'pause' : 'play'
}

export class DatagramPortAdapter implements DatagramPort {
  constructor(private readonly room: Room) {}

  send(peerId: string, data: Uint8Array): void {
    this.room.peer(peerId)?.sendDatagram(data)
  }

  /** Direct, LAN and relayed links carry datagrams (net's relay test checks it); via-peer members do not. */
  usable(peerId: string): boolean {
    return this.room.peer(peerId) !== null
  }

  onMessage(fn: (from: string, data: Uint8Array) => void): Unsubscribe {
    return this.room.onDatagram(DATAGRAM_SYNC, (peer, buf) => fn(peer.id, buf))
  }
}

const REASONS: Record<ReadinessReason, MediaReason> = {
  open: 'join',
  seek: 'seek',
  start: 'start',
  rendezvous: 'catchup',
}

export interface MediaPortDeps {
  map: MediaMap
  manifest: Manifest
  /** piece states (host: all verified) */
  states: () => ArrayLike<number>
  /** the player has the file open: from then on open-critical ranges are no longer required */
  fileOpened: () => boolean
  lastStallAtMs: () => number | null
  setPlayhead: (posS: number, reason: PlayheadReason) => void
  onChange: (fn: () => void) => Unsubscribe
  positionS: () => number
}

export class MediaPortAdapter implements MediaPort {
  readonly playhead: { set(posS: number, reason: PlayheadReason): void }

  constructor(private readonly d: MediaPortDeps) {
    this.playhead = { set: (posS, reason) => d.setPlayhead(posS, reason) }
  }

  durationS(): number | null {
    return this.d.map.durationMs > 0 ? this.d.map.durationMs / 1000 : null
  }

  readiness(posS: number, reason: ReadinessReason): boolean {
    const aheadS = readinessAheadS({
      avgBytesPerSec: this.d.manifest.avgBytesPerSec,
      nowMs: performance.now(),
      lastStallAtMs: this.d.lastStallAtMs(),
    })
    return readiness(this.d.map, posS, REASONS[reason], this.d.states(), {
      aheadS,
      playbackRestarted: true, // sync waits for playback-restart itself
      ...(this.d.fileOpened() ? {} : { openCritical: this.d.manifest.openCritical }),
    }).ready
  }

  bufferedAheadS(posS: number): number {
    return this.d.map.bufferedAheadS(posS, this.d.states())
  }

  needBps(): number {
    return this.d.map.needBps(this.d.positionS() * 1000)
  }

  onChange(fn: () => void): Unsubscribe {
    return this.d.onChange(fn)
  }
}

export interface TransferPortDeps {
  rateBps: () => number
  etaToEofS: () => number | null
  coverage: () => string | null
  diskFull: () => boolean
}

export class TransferPortAdapter implements TransferPort {
  constructor(private readonly d: TransferPortDeps) {}
  rateBps(): number {
    return this.d.rateBps()
  }
  etaToEofS(): number | null {
    return this.d.etaToEofS()
  }
  coverage(): string | null {
    return this.d.coverage()
  }
  diskFull(): boolean {
    return this.d.diskFull()
  }
}

/** 10 s EWMA of a rate sampled at 1 Hz (plan §4.5 rate warning). */
export class Ewma {
  private value: number | null = null
  private readonly alpha: number

  constructor(windowS = 10) {
    this.alpha = 1 - Math.exp(-1 / windowS)
  }

  push(sample: number): number {
    this.value = this.value === null ? sample : this.value + this.alpha * (sample - this.value)
    return this.value
  }

  get(): number {
    return this.value ?? 0
  }
}

export function intentFromOsc(kind: string, pos?: number): PlaybackIntent | null {
  if (kind === 'play' || kind === 'pause') return { kind }
  if (kind === 'seek' && typeof pos === 'number') return { kind: 'seek', posS: pos }
  return null
}
