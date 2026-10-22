import { EventEmitter } from 'node:events'
import type { Span } from '../../shared/ipc/core.js'
import type { ResolvedTheme, ThemePayload, TokenName } from '../../shared/theme-tokens.js'

// core <-> wt-osc.lua messages (plan §5.3). core -> OSC: `script-message-to wt_osc <kind> <json>`;
// OSC -> core: `script-message-to <client> wt-ready|wt-intent <json>`, seen here as client-message.

export const OSC_SCRIPT = 'wt_osc'
export const OSC_PROTOCOL = 1
export const MAX_SPANS = 512

export interface OscPerms {
  isHost: boolean
  canPlayPause: boolean
  canSeek: boolean
}

export interface OscRanges {
  dur: number
  done: Span[]
  loading: Span[]
  groupDone?: Span[]
}

export interface OscPeer {
  id: string
  name: string
  /** '#RRGGBB' (converted here) or already '&HBBGGRR&' */
  color: string
  pos: number
  state: string
}

export interface OscStatus {
  /** '' clears the status line */
  text: string
  level?: 'info' | 'warn' | 'error'
}

export interface OscToast {
  text: string
  ms?: number
}

export interface OscStrings {
  ended: string
  muted: string
  volume: string
  subDelay: string
  subsHidden: string
  subsShown: string
  noTracks: string
  locked: string
  /** the bar's button while a viewer is behind the host (Shift+R) */
  resync: string
}

export const DEFAULT_OSC_STRINGS: OscStrings = {
  ended: 'Ended',
  muted: 'Muted',
  volume: 'Volume',
  subDelay: 'Subtitle delay',
  subsHidden: 'Subtitles hidden',
  subsShown: 'Subtitles shown',
  noTracks: 'No tracks',
  locked: 'The host controls this',
  resync: 'Resync to live',
}

/** What callers pass to `send` (colours as #RRGGBB, unmerged spans). */
export interface OscMessages {
  theme: ThemePayload
  perms: OscPerms
  ranges: OscRanges
  peers: OscPeer[]
  status: OscStatus
  toast: OscToast
  ended: { ended: boolean }
  /** a viewer behind the host: the bar shows its Resync to live button */
  resync: { shown: boolean }
}
export type OscKind = keyof OscMessages

/** Colours as ASS literals ('&HBBGGRR&') so the Lua side drops them into override tags as they are. */
export interface OscWireTheme {
  mode: ResolvedTheme
  colors: Record<TokenName, string>
  peers: string[]
}

export interface OscInit {
  v: number
  client: string
  theme: OscWireTheme
  perms: OscPerms
  strings: OscStrings
  /** quit after this many seconds without `hb`; 0 disables (fd://3 already ties mpv to us) */
  watchdogS: number
  persistentStrip: boolean
}

export type OscIntentKind = 'play' | 'pause' | 'toggle' | 'seek' | 'seek-rel' | 'close' | 'show-app' | 'resync'
export interface OscIntent {
  t: OscIntentKind
  pos?: number
  delta?: number
  seq: number
}

/** Sends one script message; implemented by the controller over the IPC connection. */
export type OscSend = (kind: string, json: string) => Promise<void>

export interface OscBridgeOptions {
  theme: ThemePayload
  perms: OscPerms
  strings?: Partial<OscStrings>
  persistentStrip: boolean
  timing?: Partial<OscTiming>
}

export interface OscTiming {
  initRetryMs: number
  initTimeoutMs: number
  hbMs: number
  rangesMs: number
  peersMs: number
}

const DEFAULT_TIMING: OscTiming = { initRetryMs: 100, initTimeoutMs: 5000, hbMs: 2000, rangesMs: 250, peersMs: 500 }

/**
 * A toast sent while the OSC is not up (mpv starting or restarting) is shown once it is, if it is at most this
 * old: a spawn and the init handshake take a second or two, and a toast from minutes ago (the player was
 * closed meanwhile) would only confuse.
 */
export const TOAST_KEEP_MS = 10_000

interface OscBridgeEvents {
  ready: []
  /** the OSC never answered init within initTimeoutMs; the player still works, without our OSC */
  timeout: []
  intent: [OscIntent]
}

type Sticky = 'ranges' | 'peers' | 'status' | 'ended' | 'resync'

/**
 * One instance per player; `attach` is called for every mpv process (the OSC restarts with it).
 * Keeps the latest theme/perms/ranges/peers/status/resync so a restarted OSC is brought up to date, and the latest
 * toast sent before the OSC was up (TOAST_KEEP_MS).
 */
export class OscBridge extends EventEmitter<OscBridgeEvents> {
  private readonly timing: OscTiming
  private readonly strings: OscStrings
  private theme: OscWireTheme
  private perms: OscPerms
  private readonly sticky: Partial<Record<Sticky, string>> = {}
  /** a toast the OSC has not shown: sent before it was up */
  private pendingToast: { body: string; at: number } | null = null
  /** theme and perms in the last init posted: a change after it would be lost before wt-ready */
  private initSent: { theme: string; perms: string } | null = null
  private send: OscSend | null = null
  private client = ''
  private watchdogS = 0
  private isReady = false
  private initTimer: NodeJS.Timeout | null = null
  private initDeadline: NodeJS.Timeout | null = null
  private hbTimer: NodeJS.Timeout | null = null
  private readonly throttles = new Map<'ranges' | 'peers', { last: number; timer: NodeJS.Timeout | null }>()

  constructor(private readonly opts: OscBridgeOptions) {
    super()
    this.timing = { ...DEFAULT_TIMING, ...opts.timing }
    this.strings = { ...DEFAULT_OSC_STRINGS, ...opts.strings }
    this.theme = wireTheme(opts.theme)
    this.perms = opts.perms
  }

  get ready(): boolean {
    return this.isReady
  }

  /**
   * Start the init handshake with a freshly connected mpv. `watchdogS` > 0 makes the OSC quit mpv after
   * that long without `hb`; only needed when the IPC is a server socket/pipe, which outlives core.
   */
  attach(send: OscSend, client: string, watchdogS: number): void {
    this.detach()
    this.send = send
    this.client = client
    this.watchdogS = watchdogS
    const tryInit = (): void => {
      this.initSent = { theme: JSON.stringify(this.theme), perms: JSON.stringify(this.perms) }
      this.post('init', this.initPayload())
    }
    tryInit()
    this.initTimer = setInterval(tryInit, this.timing.initRetryMs)
    this.initDeadline = setTimeout(() => {
      this.stopInit()
      if (!this.isReady) this.emit('timeout')
    }, this.timing.initTimeoutMs)
  }

  detach(): void {
    this.stopInit()
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = null
    for (const t of this.throttles.values()) if (t.timer) clearTimeout(t.timer)
    this.throttles.clear()
    this.send = null
    this.isReady = false
  }

  /** Feed every client-message; returns true when it was one of ours. */
  handleClientMessage(args: readonly string[]): boolean {
    const [name, json] = args
    if (name === 'wt-ready') {
      if (!this.send || this.isReady) return true
      this.isReady = true
      this.stopInit()
      this.hbTimer = setInterval(() => this.post('hb', '{}'), this.timing.hbMs)
      // The OSC took theme and perms from an init; a change since the last one posted was not sent (not ready)
      const theme = JSON.stringify(this.theme)
      const perms = JSON.stringify(this.perms)
      if (theme !== this.initSent?.theme) this.post('theme', theme)
      if (perms !== this.initSent?.perms) this.post('perms', perms)
      for (const kind of ['ranges', 'peers', 'status', 'ended', 'resync'] as const) {
        const body = this.sticky[kind]
        if (body !== undefined) this.post(kind, body)
      }
      const toast = this.pendingToast
      this.pendingToast = null
      if (toast && performance.now() - toast.at <= TOAST_KEEP_MS) this.post('toast', toast.body)
      this.emit('ready')
      return true
    }
    if (name === 'wt-intent') {
      const intent = parseIntent(json)
      if (intent) this.emit('intent', intent)
      return true
    }
    return false
  }

  sendMessage<K extends OscKind>(kind: K, payload: OscMessages[K]): void {
    switch (kind) {
      case 'theme': {
        this.theme = wireTheme(payload as ThemePayload)
        this.postIfReady('theme', JSON.stringify(this.theme))
        return
      }
      case 'perms':
        this.perms = { ...(payload as OscPerms) }
        this.postIfReady('perms', JSON.stringify(this.perms))
        return
      case 'ranges':
        this.sticky.ranges = JSON.stringify(wireRanges(payload as OscRanges))
        this.throttled('ranges', this.timing.rangesMs)
        return
      case 'peers':
        this.sticky.peers = JSON.stringify((payload as OscPeer[]).slice(0, 12).map(wirePeer))
        this.throttled('peers', this.timing.peersMs)
        return
      case 'status':
        this.sticky.status = JSON.stringify(payload)
        this.postIfReady('status', this.sticky.status)
        return
      case 'ended':
        this.sticky.ended = JSON.stringify(payload)
        this.postIfReady('ended', this.sticky.ended)
        return
      case 'resync':
        this.sticky.resync = JSON.stringify(payload)
        this.postIfReady('resync', this.sticky.resync)
        return
      case 'toast': {
        const body = JSON.stringify(payload)
        // e.g. a notice right after the player was created: shown once the OSC is up (only the latest)
        if (this.isReady) this.post('toast', body)
        else this.pendingToast = { body, at: performance.now() }
        return
      }
    }
  }

  private initPayload(): string {
    const init: OscInit = {
      v: OSC_PROTOCOL,
      client: this.client,
      theme: this.theme,
      perms: this.perms,
      strings: this.strings,
      watchdogS: this.watchdogS,
      persistentStrip: this.opts.persistentStrip,
    }
    return JSON.stringify(init)
  }

  private throttled(kind: 'ranges' | 'peers', intervalMs: number): void {
    if (!this.isReady) return
    let t = this.throttles.get(kind)
    if (!t) {
      t = { last: -Infinity, timer: null }
      this.throttles.set(kind, t)
    }
    if (t.timer) return
    const wait = t.last + intervalMs - performance.now()
    const state = t
    const flush = (): void => {
      state.timer = null
      state.last = performance.now()
      const body = this.sticky[kind]
      if (body !== undefined) this.post(kind, body)
    }
    if (wait <= 0) flush()
    else t.timer = setTimeout(flush, wait)
  }

  private postIfReady(kind: string, json: string): void {
    if (this.isReady) this.post(kind, json)
  }

  private post(kind: string, json: string): void {
    // Before the script registered its handlers mpv answers "error"; init is retried anyway.
    this.send?.(kind, json).catch(() => undefined)
  }

  private stopInit(): void {
    if (this.initTimer) clearInterval(this.initTimer)
    if (this.initDeadline) clearTimeout(this.initDeadline)
    this.initTimer = null
    this.initDeadline = null
  }
}

/** '#RRGGBB' -> '&HBBGGRR&' (ASS stores colours blue-first). Already-ASS input passes through. */
export function assColor(hex: string): string {
  if (/^&H[0-9A-F]{6}&$/.test(hex)) return hex
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return '&HFFFFFF&'
  const [, r = '', g = '', b = ''] = m
  return `&H${(b + g + r).toUpperCase()}&`
}

export function wireTheme(t: ThemePayload): OscWireTheme {
  const colors = {} as Record<TokenName, string>
  for (const [k, v] of Object.entries(t.colors) as [TokenName, string][]) colors[k] = assColor(v)
  return { mode: t.mode, colors, peers: t.peers.map(assColor) }
}

function wirePeer(p: OscPeer): OscPeer {
  return { id: p.id, name: p.name.slice(0, 32), color: assColor(p.color), pos: round3(p.pos), state: p.state }
}

function wireRanges(r: OscRanges): OscRanges {
  const done = capSpans(r.done, MAX_SPANS)
  const out: OscRanges = { dur: round3(r.dur), done, loading: capSpans(r.loading, MAX_SPANS) }
  if (r.groupDone) {
    const group = capSpans(r.groupDone, MAX_SPANS)
    // The host's done is groupDone already (core/session/timeline.ts), and the OSC draws no strip that repeats
    // done (wt-osc.lua same_spans): sending it again would only double the 4 Hz message.
    if (!sameSpans(group, done)) out.groupDone = group
  }
  return out
}

function sameSpans(a: readonly Span[], b: readonly Span[]): boolean {
  return (
    a.length === b.length &&
    a.every(([s, e], i) => {
      const other = b[i]
      return other !== undefined && s === other[0] && e === other[1]
    })
  )
}

/**
 * Sort, merge overlapping or touching spans, then close the smallest gaps until at most `max` remain.
 * Closing a gap overstates coverage by that gap, which at 512 spans is below a pixel on any bar.
 */
export function capSpans(spans: readonly Span[], max: number): Span[] {
  const sorted = spans
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .map(([s, e]): Span => [s, e])
    .sort((a, b) => a[0] - b[0])
  const merged: Span[] = []
  for (const span of sorted) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push(span)
  }
  if (merged.length > max) {
    const gaps = merged.slice(1).map((s, i) => ({ i, gap: s[0] - (merged[i]?.[1] ?? s[0]) }))
    gaps.sort((a, b) => a.gap - b.gap || a.i - b.i)
    const close = new Set(gaps.slice(0, merged.length - max).map((g) => g.i))
    const out: Span[] = []
    merged.forEach((span, idx) => {
      const last = out.at(-1)
      if (last && close.has(idx - 1)) last[1] = span[1]
      else out.push(span)
    })
    return out.map(([s, e]) => [round3(s), round3(e)])
  }
  return merged.map(([s, e]) => [round3(s), round3(e)])
}

const INTENT_KINDS = new Set<OscIntentKind>([
  'play',
  'pause',
  'toggle',
  'seek',
  'seek-rel',
  'close',
  'show-app',
  'resync',
])

export function parseIntent(json: string | undefined): OscIntent | null {
  if (json === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (typeof m.t !== 'string' || !INTENT_KINDS.has(m.t as OscIntentKind)) return null
  const intent: OscIntent = { t: m.t as OscIntentKind, seq: typeof m.seq === 'number' ? m.seq : 0 }
  if (intent.t === 'seek') {
    if (!finite(m.pos)) return null
    intent.pos = m.pos
  }
  if (intent.t === 'seek-rel') {
    if (!finite(m.delta)) return null
    intent.delta = m.delta
  }
  return intent
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
