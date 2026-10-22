import { EventEmitter } from 'node:events'
import c from 'compact-encoding'
import Protomux, { type Channel, type Message } from 'protomux'
import type { PeerPath } from '../../shared/ipc/core.js'
import { CodedError } from '../../shared/result.js'
import { authProof, toHex, verifyProof } from './crypto.js'
import { NET_ERRORS } from './errors.js'
import { type Address, classifyPath } from './path.js'
import {
  AUTH_MAX_BYTES,
  AUTH_PROTOCOL,
  CTRL_MAX_BYTES,
  CTRL_PROTOCOL,
  type Frame,
  HELLO_MAX_BYTES,
  type Hello,
  WIRE_VERSION,
  decodeAuthHandshake,
  decodeFrame,
  encodeAuthHandshake,
  encodeFrame,
  parseHello,
} from './wire.js'

/** The parts of a Hyperswarm connection (a NoiseSecretStream over UDX) that a link uses. */
export interface NetConnection {
  readonly remotePublicKey: Buffer
  readonly isInitiator: boolean
  readonly handshakeHash: Buffer | null
  readonly rawStream: {
    remoteHost: string | null
    remotePort: number
    on(event: 'remote-changed', cb: () => void): unknown
  } | null
  readonly opened: Promise<boolean>
  readonly destroyed: boolean
  send?(buf: Uint8Array): unknown
  destroy(err?: Error): void
  on(event: 'message', cb: (buf: Buffer) => void): unknown
  on(event: 'close', cb: () => void): unknown
  on(event: 'error', cb: (err: Error) => void): unknown
}

/** A member we have an admitted link to (plan §5.3). */
export interface RoomPeer {
  /** public key, hex */
  readonly id: string
  readonly publicKey: Buffer
  readonly name: string
  readonly isHost: boolean
  readonly path: PeerPath
  readonly rttMs: number | null
  /** for other lanes on the same connection, e.g. transfer's 'wtp/bt/1' */
  readonly mux: Protomux
  /** unreliable, unordered; the first byte selects the receiver (0x53 = sync). False if not sent. */
  sendDatagram(buf: Uint8Array): boolean
  /** a ctrl-lane frame {ns, t, ...} straight to this peer (not the bus) */
  sendCtrl(frame: Frame): boolean
}

/** What the room supplies to each link. */
export interface LinkContext {
  hostKey: string
  authKeys(): { current: Buffer; previous: Buffer | null }
  /** may the previous-epoch key authenticate this key? (members that missed a rekey) */
  isKnownMember(id: string): boolean
  localHello(): Hello
  /** both ends admitted, so the ctrl lane may open */
  allowCtrl(link: PeerLink): boolean
  relayAddress(): Address | null
  timing: {
    authTimeoutMs: number
    /** the remote must open its auth lane this soon: a connection it never took up carries nothing */
    authOpenTimeoutMs: number
    ctrlPairWaitMs: number
    pingMs: number
    ctrlRetryMs: number
  }
}

interface LinkEvents {
  /** auth passed and the remote Hello arrived */
  ready: []
  'auth-failed': [code: string]
  /** join / env frames on the auth lane, after ready */
  'auth-frame': [frame: Frame]
  'ctrl-open': []
  'ctrl-close': []
  ctrl: [frame: Frame]
  datagram: [buf: Buffer]
  'path-changed': []
  /** checkAlive() got nothing back in time */
  stale: []
  close: []
}

const RTT_ALPHA = 0.25
const AUTH_FAIL_LINGER_MS = 250

/**
 * One Hyperswarm connection: auth lane ('wtp/auth/1': proofs in the channel handshake, then Hello, join
 * and hand-over frames), ctrl lane ('wtp/ctrl/1', opened only while the room says both ends are admitted),
 * datagrams, RTT and path.
 */
export class PeerLink extends EventEmitter<LinkEvents> implements RoomPeer {
  readonly id: string
  readonly publicKey: Buffer
  readonly mux: Protomux
  readonly isHost: boolean
  hello: Hello | null = null
  rttMs: number | null = null
  closed = false
  /** set by the room once 'peer' was emitted for this link */
  announced = false
  /** performance.now() when this link was made */
  readonly createdAt = performance.now()

  private readonly conn: NetConnection
  private readonly ctx: LinkContext
  private authChannel: Channel | null = null
  private authMessage: Message<Uint8Array> | null = null
  private ctrlChannel: Channel | null = null
  private ctrlMessage: Message<Uint8Array> | null = null
  private ctrlIsOpen = false
  private authed = false
  private failed = false
  private ctrlWaiter: (() => void) | null = null
  private authTimer: NodeJS.Timeout | null
  private openTimer: NodeJS.Timeout | null
  private aliveTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private pingSeq = 0
  private readonly pings = new Map<number, number>()
  /** performance.now() of the remote's latest message on any lane; 0 = nothing yet */
  private lastHeard = 0

  constructor(conn: NetConnection, ctx: LinkContext) {
    super()
    this.conn = conn
    this.ctx = ctx
    this.publicKey = conn.remotePublicKey
    this.id = toHex(conn.remotePublicKey)
    this.isHost = this.id === ctx.hostKey
    this.mux = Protomux.from(conn)

    conn.on('error', () => undefined) // the reason is read from the close below
    conn.on('close', () => this.onClose())
    conn.on('message', (buf) => {
      this.heardNow()
      if (this.ctrlIsOpen) this.emit('datagram', buf)
    })
    conn.rawStream?.on('remote-changed', () => this.emit('path-changed'))

    this.mux.pair({ protocol: AUTH_PROTOCOL }, () => this.openAuth())
    this.mux.pair({ protocol: CTRL_PROTOCOL }, () => this.onRemoteCtrlOpen())
    this.authTimer = setTimeout(() => this.fail(NET_ERRORS.authTimeout), ctx.timing.authTimeoutMs)
    // hyperdht can leave a dial half-open: we think we are connected, the remote never took the connection
    // up (seen with a freshly started process on the same LAN). Its auth lane would open within a round trip.
    this.openTimer = setTimeout(() => this.fail(NET_ERRORS.authTimeout), ctx.timing.authOpenTimeoutMs)
    void conn.opened.then((opened) => {
      if (opened) this.openAuth()
    })
  }

  get name(): string {
    return this.hello?.name ?? 'Friend'
  }

  /** The remote has sent us something on this connection (its auth lane opened, at least). */
  get heard(): boolean {
    return this.lastHeard > 0
  }

  get ready(): boolean {
    return this.hello !== null && !this.closed
  }

  get ctrlOpen(): boolean {
    return this.ctrlIsOpen
  }

  get path(): PeerPath {
    const raw = this.conn.rawStream
    return classifyPath(raw ? { host: raw.remoteHost, port: raw.remotePort } : null, this.ctx.relayAddress())
  }

  /**
   * False when the lane is not up or the frame is over the lane's limit. Never throws: sends run inside
   * other links' message callbacks (the bus forwards, the room hands over), and a throw there makes Protomux
   * destroy the connection the message came in on.
   */
  sendAuth(frame: Frame): boolean {
    if (!this.authMessage || !this.authed || this.closed) return false
    try {
      this.authMessage.send(encodeFrame(frame, AUTH_MAX_BYTES))
      return true
    } catch {
      return false
    }
  }

  /** False when the ctrl lane is not open or the frame is over 64 KiB; never throws (see sendAuth). */
  sendCtrl(frame: Frame): boolean {
    if (!this.ctrlMessage || !this.ctrlIsOpen) return false
    try {
      this.ctrlMessage.send(encodeFrame(frame, CTRL_MAX_BYTES))
      return true
    } catch {
      return false
    }
  }

  sendDatagram(buf: Uint8Array): boolean {
    if (!this.ctrlIsOpen || typeof this.conn.send !== 'function') return false
    try {
      this.conn.send(buf)
      return true
    } catch {
      return false
    }
  }

  /** Re-evaluates whether the ctrl lane should be open, and opens or closes it. */
  refreshCtrl(): void {
    if (this.closed || !this.ready) return
    if (this.ctx.allowCtrl(this)) {
      this.openCtrl()
      this.ctrlWaiter?.()
    } else if (this.ctrlChannel) {
      this.ctrlChannel.close()
    }
  }

  ping(): void {
    const id = ++this.pingSeq
    this.pings.set(id, performance.now())
    if (this.pings.size > 8) this.pings.delete(this.pings.keys().next().value ?? id)
    this.sendCtrl({ ns: 'ctrl', t: 'ping', id })
  }

  /**
   * Pings now and emits 'stale' unless the remote sends anything within `ms` (a dead peer's link stays up
   * until UDX gives up, ~15 s). Needs the ctrl lane; one check at a time.
   */
  checkAlive(ms: number): void {
    if (this.closed || !this.ctrlIsOpen || this.aliveTimer) return
    const since = performance.now()
    this.ping()
    this.aliveTimer = setTimeout(() => {
      this.aliveTimer = null
      if (!this.closed && this.lastHeard <= since) this.emit('stale')
    }, ms)
  }

  destroy(err?: Error): void {
    this.conn.destroy(err)
  }

  private openAuth(): void {
    if (this.authChannel || this.closed) return
    const hh = this.conn.handshakeHash
    if (!hh) return // not open yet; the opened promise calls again
    const keys = this.ctx.authKeys()
    const proof = authProof(keys.current, hh, this.conn.isInitiator)
    const previous = keys.previous ? authProof(keys.previous, hh, this.conn.isInitiator) : null
    const channel = this.mux.createChannel({
      protocol: AUTH_PROTOCOL,
      unique: true,
      handshake: c.raw,
      onopen: (handshake) => this.onAuthOpen(handshake),
    })
    if (!channel) return
    this.authChannel = channel
    this.authMessage = channel.addMessage({ encoding: c.raw, onmessage: (buf) => this.onAuthMessage(buf) })
    channel.open(encodeAuthHandshake(proof, previous))
  }

  private onAuthOpen(handshake: unknown): void {
    this.heardNow()
    if (this.failed) return
    const hs = decodeAuthHandshake(handshake)
    const hh = this.conn.handshakeHash
    if (!hs || !hh || hs.version !== WIRE_VERSION) {
      this.fail(NET_ERRORS.protocol)
      return
    }
    const keys = this.ctx.authKeys()
    const remoteInitiator = !this.conn.isInitiator
    const matches = (key: Buffer): boolean => hs.proofs.some((p) => verifyProof(key, hh, remoteInitiator, p))
    const ok =
      matches(keys.current) || (keys.previous !== null && this.ctx.isKnownMember(this.id) && matches(keys.previous))
    if (!ok) {
      this.fail(NET_ERRORS.authFailed)
      return
    }
    this.authed = true
    this.sendAuth({ t: 'hello', ...this.ctx.localHello() })
  }

  private onAuthMessage(buf: Uint8Array): void {
    this.heardNow()
    const frame = this.decode(buf, AUTH_MAX_BYTES)
    if (!frame || !this.authed || this.failed) return
    if (frame.t === 'hello') {
      if (this.hello) return
      const hello = buf.byteLength <= HELLO_MAX_BYTES ? parseHello(frame) : null
      if (hello?.proto !== WIRE_VERSION) {
        this.fail(NET_ERRORS.protocol)
        return
      }
      this.hello = hello
      if (this.authTimer) clearTimeout(this.authTimer)
      this.authTimer = null
      this.emit('ready')
      return
    }
    if (this.hello) this.emit('auth-frame', frame)
  }

  private openCtrl(): void {
    if (this.ctrlChannel || this.closed) return
    const holder: { channel: Channel | null } = { channel: null }
    const channel = this.mux.createChannel({
      protocol: CTRL_PROTOCOL,
      unique: true,
      onopen: () => this.onCtrlOpen(),
      onclose: () => this.onCtrlClose(holder.channel),
    })
    holder.channel = channel
    if (!channel) return
    this.ctrlChannel = channel
    this.ctrlMessage = channel.addMessage({ encoding: c.raw, onmessage: (buf) => this.onCtrlMessage(buf) })
    channel.open()
  }

  // The remote opened its ctrl lane. Protomux rejects it unless we open ours before this returns, so wait
  // a little for our view of the members list to catch up with theirs.
  private onRemoteCtrlOpen(): Promise<void> | undefined {
    this.heardNow()
    if (this.closed) return undefined
    if (this.ready && this.ctx.allowCtrl(this)) {
      this.openCtrl()
      return undefined
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        if (this.ctrlWaiter === done) this.ctrlWaiter = null
        resolve()
      }
      const timer = setTimeout(done, this.ctx.timing.ctrlPairWaitMs)
      this.ctrlWaiter?.()
      this.ctrlWaiter = done
    })
  }

  private onCtrlOpen(): void {
    this.ctrlIsOpen = true
    this.pingTimer = setInterval(() => this.ping(), this.ctx.timing.pingMs)
    this.ping()
    this.emit('ctrl-open')
  }

  private onCtrlClose(channel: Channel | null): void {
    if (channel === null || this.ctrlChannel !== channel) return
    const wasOpen = this.ctrlIsOpen
    this.ctrlChannel = null
    this.ctrlMessage = null
    this.ctrlIsOpen = false
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (wasOpen) this.emit('ctrl-close')
    if (this.closed) return
    // Rejected or closed by the remote while we still want it: try again once views have converged.
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.refreshCtrl()
    }, this.ctx.timing.ctrlRetryMs)
  }

  private onCtrlMessage(buf: Uint8Array): void {
    this.heardNow()
    const frame = this.decode(buf, CTRL_MAX_BYTES)
    if (!frame || !this.ctrlIsOpen) return
    if (frame.ns === 'ctrl') {
      if (frame.t === 'ping' && typeof frame.id === 'number') this.sendCtrl({ ns: 'ctrl', t: 'pong', id: frame.id })
      else if (frame.t === 'pong' && typeof frame.id === 'number') this.onPong(frame.id)
      return
    }
    this.emit('ctrl', frame)
  }

  private onPong(id: number): void {
    const sentAt = this.pings.get(id)
    if (sentAt === undefined) return
    this.pings.delete(id)
    const sample = performance.now() - sentAt
    this.rttMs = this.rttMs === null ? sample : this.rttMs + RTT_ALPHA * (sample - this.rttMs)
  }

  /** Oversized frames destroy the connection (plan §5.2); malformed ones are ignored. */
  private decode(buf: Uint8Array, max: number): Frame | null {
    try {
      return decodeFrame(buf, max)
    } catch (e) {
      this.destroy(e instanceof Error ? e : new Error(String(e)))
      return null
    }
  }

  // The connection lingers briefly so our own open (and proof) still reaches the other side, which then
  // reaches the same verdict instead of seeing a bare disconnect.
  private fail(code: string): void {
    if (this.closed || this.hello || this.failed) return
    this.failed = true
    for (const t of [this.authTimer, this.openTimer]) if (t) clearTimeout(t)
    this.openTimer = null
    this.emit('auth-failed', code)
    const err = new CodedError(code, code === NET_ERRORS.authTimeout ? 'auth timed out' : 'auth failed')
    this.authTimer = setTimeout(() => this.destroy(err), AUTH_FAIL_LINGER_MS)
  }

  private heardNow(): void {
    this.lastHeard = performance.now()
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
  }

  private onClose(): void {
    if (this.closed) return
    this.closed = true
    for (const t of [this.authTimer, this.openTimer, this.aliveTimer, this.retryTimer]) if (t) clearTimeout(t)
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.authTimer = this.openTimer = this.aliveTimer = this.retryTimer = this.pingTimer = null
    this.ctrlWaiter?.()
    const wasOpen = this.ctrlIsOpen
    this.ctrlIsOpen = false
    if (wasOpen) this.emit('ctrl-close')
    this.emit('close')
  }
}
