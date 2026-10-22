// Minimal typings for untyped dependencies, covering only what this codebase touches.
// WebTorrent internals we rely on (prefixed _) are pinned to webtorrent@3.0.21; see plan §4.2.

declare module 'sodium-native' {
  const sodium: {
    crypto_generichash(out: Buffer, input: Buffer, key?: Buffer): void
    crypto_generichash_BYTES: number
    crypto_sign_detached(sig: Buffer, msg: Buffer, secretKey: Buffer): void
    crypto_sign_verify_detached(sig: Buffer, msg: Buffer, publicKey: Buffer): boolean
    crypto_sign_BYTES: number
    sodium_memcmp(a: Buffer, b: Buffer): boolean
    randombytes_buf(buf: Buffer): void
  }
  export default sodium
}

declare module 'z32' {
  export function encode(buf: Uint8Array): string
  export function decode(str: string): Buffer
}

declare module 'webtorrent' {
  import { EventEmitter } from 'node:events'

  export interface WebTorrentOptions {
    connPool?: boolean
    dht?: boolean
    tracker?: boolean
    lsd?: boolean
    utPex?: boolean
    natUpnp?: boolean
    natPmp?: boolean
    webSeeds?: boolean
    utp?: boolean
    torrentPort?: number
    maxConns?: number
    downloadLimit?: number
    uploadLimit?: number
  }

  export interface Wire extends EventEmitter {
    requests: { piece: number; offset: number; length: number }[]
    peerPieces: { get(i: number): boolean }
    downloadSpeed(): number
    uploadSpeed(): number
    downloaded: number
    uploaded: number
    amChoking: boolean
    amInterested: boolean
    peerChoking: boolean
    peerInterested: boolean
    hasFast: boolean
    /** hex peer id from the remote's handshake (null until it arrives) */
    peerId: string
    destroyed: boolean
    /** sent in our BEP 10 extended handshake; set before it goes out (in the torrent's 'wire' event) */
    extendedHandshake: Record<string, unknown> & { reqq?: number }
    /** the remote's BEP 10 extended handshake ({} until it arrives) */
    peerExtendedHandshake: Record<string, unknown> & { reqq?: number }
    /**
     * Extension name -> the remote's message id, from its latest BEP 10 handshake ({} until one arrives; 0
     * disables). extended(name, ...) sends only while this is non-zero, whatever the extension object believes.
     */
    peerExtendedMapping: Record<string, number>
    /** the remote's requests to us, answered ('request') and not served yet */
    peerRequests: { piece: number; offset: number; length: number }[]
    /**
     * patches/bittorrent-protocol+5.0.9.patch: with holdRequests set, a request is not answered at once. It waits in
     * heldRequests ('request-held') until releaseRequest() answers it as upstream would ('request' with a respond
     * callback; onAnswered runs once that ran) or refuseRequest() turns it down (BEP 6 reject, or no answer without
     * the fast extension). Both return false when it is no longer held. A cancel drops a held request, a choke
     * rejects it, a close clears them.
     */
    holdRequests: boolean
    heldRequests: { piece: number; offset: number; length: number }[]
    releaseRequest(index: number, offset: number, length: number, onAnswered?: () => void): boolean
    refuseRequest(index: number, offset: number, length: number): boolean
    /** patches/: every byte pushed to the wire's readable side, i.e. towards the connection */
    pushedBytes: number
    /** BEP 54 (WebTorrent adds it to every wire): tells the remote we no longer have a piece */
    lt_donthave: { donthave(index: number): void }
    /**
     * BEP 10 message; ext 0 is a handshake. A name without a non-zero id is dropped (patches/; upstream throws
     * 'Unrecognized extension', also from ut_metadata answering a peer that never announced it).
     */
    extended(ext: number | string, obj: Uint8Array | Record<string, unknown>): void
    piece(index: number, offset: number, buffer: Uint8Array): void
    request(index: number, offset: number, length: number, cb: (err: Error | null, buf?: Uint8Array) => void): void
    have(index: number): void
    haveAll(): void
    haveNone(): void
    bitfield(bitfield: unknown): void
    destroy(): void
  }

  export interface Piece {
    length: number
    missing: number
  }

  export interface ChunkStore {
    get(
      index: number,
      opts: { offset?: number; length?: number } | null,
      cb: (err: Error | null, buf?: Buffer) => void,
    ): void
    put(index: number, buf: Buffer, cb: (err: Error | null) => void): void
    close(cb: (err: Error | null) => void): void
    destroy(cb: (err: Error | null) => void): void
  }

  export interface TorrentFile {
    name: string
    path: string
    length: number
    offset: number
  }

  export interface Torrent extends EventEmitter {
    infoHash: string
    torrentFile: Buffer
    ready: boolean
    pieces: (Piece | null)[]
    pieceLength: number
    lastPieceLength: number
    destroyed: boolean
    length: number
    files: TorrentFile[]
    wires: Wire[]
    store: ChunkStore
    downloadSpeed: number
    uploadSpeed: number
    progress: number
    numPeers: number
    addPeer(peer: unknown): boolean
    destroy(opts?: { destroyStore?: boolean }, cb?: (err: Error | null) => void): void
    critical(start: number, end: number): void
    _select(start: number, end: number, priority: number, notify: (() => void) | null, isStreamSelection: boolean): void
    _deselect(from: number, to: number, isStreamSelection: boolean): void
    _critical: boolean[]
    _selections: {
      length: number
      get(i: number): { from: number; to: number; offset: number; priority: number; isStreamSelection?: boolean }
      clear(): void
      insert(item: {
        from: number
        to: number
        offset: number
        priority: number
        notify: (() => void) | null
        isStreamSelection: boolean
      }): void
    }
    /** re-runs interest and requests on every wire (synchronously in Node) and gc's done selections */
    _updateSelections(): void
    /** re-runs requests on every wire (synchronously in Node) */
    _update(): void
    /** patches/webtorrent+3.0.21.patch: asked before every block request; the viewer's download limit, null = none */
    _requestGate: import('../core/transfer/download-gate.js').RequestGate | null
    /** verified pieces (ours) */
    bitfield: { get(i: number): boolean }
    /** peers by id (a MuxWireStream's id); `wire` is set once the peer is connected; null once destroyed */
    _peers: Map<string, { wire: Wire | null }> | null
  }

  export interface AddOptions {
    path?: string
    store?: unknown
    storeOpts?: Record<string, unknown>
    storeCacheSlots?: number
    skipVerify?: boolean
    bitfield?: Uint8Array
    deselect?: boolean
    strategy?: 'sequential' | 'rarest'
    uploads?: number
    private?: boolean
    destroyStoreOnDestroy?: boolean
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: WebTorrentOptions)
    listening: boolean
    torrents: Torrent[]
    _connPool: unknown
    /** the BitTorrent DHT client; false when created with `dht: false`, as ours always are */
    dht: unknown
    add(torrentId: Buffer | Uint8Array | string, opts?: AddOptions, onTorrent?: (t: Torrent) => void): Torrent
    seed(
      input: string | Buffer | (string | Buffer)[],
      opts?: { name?: string; pieceLength?: number; private?: boolean; announceList?: string[][] },
      onSeed?: (t: Torrent) => void,
    ): Torrent
    destroy(cb?: (err: Error | null) => void): void
    address(): { address: string; family: string; port: number } | null
    throttleUpload(rate: number): void
    throttleDownload(rate: number): void
  }
}

declare module 'ut_metadata' {
  /** BEP 9 bittorrent-protocol extension (WebTorrent adds it to every wire): wire.use(utMetadata(metadata)) */
  export default function utMetadata(metadata?: Uint8Array): unknown
}

declare module 'hyperswarm' {
  import { EventEmitter } from 'node:events'
  import type { Duplex } from 'streamx'

  export interface SwarmConnection extends Duplex {
    remotePublicKey: Buffer
    publicKey: Buffer
    handshakeHash: Buffer
    isInitiator: boolean
    rawStream: { remoteHost: string; remotePort: number; on(e: 'remote-changed', cb: () => void): void }
    opened: Promise<boolean>
    send(buf: Buffer): void
    trySend(buf: Buffer): void
  }

  export interface PeerInfo {
    publicKey: Buffer
    topics: Buffer[]
    prioritized: boolean
    ban(banned?: boolean): void
  }

  export interface Discovery {
    flushed(): Promise<void>
    refresh(opts?: { client?: boolean; server?: boolean }): Promise<void>
    destroy(): Promise<void>
  }

  export interface HyperswarmOptions {
    keyPair?: { publicKey: Buffer; secretKey: Buffer }
    seed?: Buffer
    maxPeers?: number
    firewall?: (remotePublicKey: Buffer, payload?: unknown) => boolean
    dht?: unknown
    bootstrap?: { host: string; port: number }[] | string[]
    port?: number
    relayThrough?: Buffer | null | ((force: boolean, swarm: Hyperswarm) => Buffer | null)
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions)
    dht: {
      ready(): Promise<void>
      port: number
      host: string | null
      firewalled: boolean
      randomized: boolean
      destroy(): Promise<void>
    }
    keyPair: { publicKey: Buffer; secretKey: Buffer }
    connections: Set<SwarmConnection>
    peers: Map<string, PeerInfo>
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): Discovery
    leave(topic: Buffer): Promise<void>
    joinPeer(publicKey: Buffer): void
    leavePeer(publicKey: Buffer): void
    flush(): Promise<void>
    destroy(): Promise<void>
    on(event: 'connection', cb: (conn: SwarmConnection, info: PeerInfo) => void): this
    on(event: 'update', cb: () => void): this
  }
}

declare module 'protomux' {
  import type { Encoder } from 'compact-encoding'

  export interface Message<T> {
    send(value: T): boolean
  }

  export interface Channel {
    readonly opened: boolean
    readonly closed: boolean
    readonly drained: boolean
    userData: unknown
    open(handshake?: unknown): void
    close(): void
    fullyOpened(): Promise<boolean>
    fullyClosed(): Promise<void>
    addMessage<T>(opts: { encoding?: Encoder<T>; onmessage?: (value: T, channel: Channel) => unknown }): Message<T>
    cork(): void
    uncork(): void
  }

  export interface ChannelOptions {
    protocol: string
    id?: Uint8Array | null
    unique?: boolean
    userData?: unknown
    handshake?: Encoder
    onopen?: (handshake: unknown, channel: Channel) => unknown
    onclose?: (isRemote: boolean, channel: Channel) => unknown
    ondestroy?: (channel: Channel) => unknown
    ondrain?: (channel: Channel) => unknown
  }

  export default class Protomux {
    static from(stream: unknown, opts?: unknown): Protomux
    readonly stream: unknown
    readonly drained: boolean
    createChannel(opts: ChannelOptions): Channel | null
    pair(opts: { protocol: string; id?: Uint8Array | null }, notify: (id: Uint8Array | null) => unknown): void
    unpair(opts: { protocol: string; id?: Uint8Array | null }): void
    opened(opts: { protocol: string; id?: Uint8Array | null }): boolean
    cork(): void
    uncork(): void
    destroy(err?: Error): void
  }
}

declare module '@hyperswarm/secret-stream' {
  import { Duplex } from 'streamx'

  export default class NoiseSecretStream extends Duplex {
    constructor(isInitiator: boolean, rawStream?: unknown, opts?: unknown)
    readonly rawStream: Duplex
    readonly isInitiator: boolean
    readonly publicKey: Buffer | null
    readonly remotePublicKey: Buffer | null
    readonly handshakeHash: Buffer | null
    readonly opened: Promise<boolean>
    send(buf: Uint8Array): boolean
    trySend(buf: Uint8Array): void
    static keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer }
  }
}
