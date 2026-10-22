// Minimal typings for the networking dependencies used by src/core/net (plan §4.1), covering only what
// that module and its tests touch. Hyperswarm itself is declared in modules.d.ts.

declare module 'hyperdht' {
  import type { Duplex } from 'streamx'

  export interface KeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }

  export interface DhtNodeAddress {
    host: string
    port: number
  }

  export interface DhtOptions {
    bootstrap?: (string | DhtNodeAddress)[]
    port?: number
    host?: string
    keyPair?: KeyPair
    ephemeral?: boolean
    firewalled?: boolean
    quickFirewall?: boolean
  }

  export interface DhtRawStream {
    remoteHost: string | null
    remotePort: number
    on(event: 'remote-changed', cb: () => void): unknown
  }

  export interface DhtSocket extends Duplex {
    remotePublicKey: Buffer
    publicKey: Buffer
    rawStream: DhtRawStream | null
    opened: Promise<boolean>
  }

  export interface DhtServer {
    publicKey: Buffer
    listen(keyPair?: KeyPair): Promise<void>
    close(): Promise<void>
    on(event: 'connection', cb: (socket: DhtSocket) => void): this
  }

  export interface ConnectOptions {
    keyPair?: KeyPair
    relayThrough?: Buffer | null
    localConnection?: boolean
    holepunch?: boolean | (() => boolean)
  }

  export interface ServerOptions {
    firewall?: (remotePublicKey: Buffer) => boolean
    holepunch?: boolean | (() => boolean)
    shareLocalAddress?: boolean
  }

  export default class HyperDHT {
    constructor(opts?: DhtOptions)
    static keyPair(seed?: Buffer): KeyPair
    static BOOTSTRAP: string[]
    readonly host: string | null
    readonly port: number
    readonly firewalled: boolean
    readonly randomized: boolean
    readonly bootstrapped: boolean
    readonly destroyed: boolean
    io: { serverSocket: { address(): DhtNodeAddress }; clientSocket: { address(): DhtNodeAddress } }
    ready(): Promise<void>
    fullyBootstrapped(): Promise<void>
    toArray(opts?: { limit?: number }): DhtNodeAddress[]
    address(): DhtNodeAddress & { family: number }
    connect(remotePublicKey: Buffer, opts?: ConnectOptions): DhtSocket
    createServer(opts: ServerOptions, onconnection?: (socket: DhtSocket) => void): DhtServer
    createServer(onconnection: (socket: DhtSocket) => void): DhtServer
    createRawStream(opts?: Record<string, unknown>): unknown
    destroy(opts?: { force?: boolean }): Promise<void>
    on(event: 'network-change' | 'network-update' | 'nat-update' | 'ready', cb: () => void): this
  }
}

declare module 'hyperdht/testnet.js' {
  import type HyperDHT from 'hyperdht'
  import type { DhtNodeAddress, DhtOptions } from 'hyperdht'

  export interface Testnet {
    nodes: HyperDHT[]
    bootstrap: DhtNodeAddress[]
    createNode(opts?: DhtOptions): HyperDHT
    destroy(): Promise<void>
  }

  export default function createTestnet(
    size?: number,
    opts?: { host?: string; port?: number; bootstrap?: DhtNodeAddress[] },
  ): Promise<Testnet>
}

declare module 'blind-relay' {
  import { EventEmitter } from 'node:events'

  export interface RelayStats {
    sessions: { accepted: number; opened: number; closed: number; active: number }
    pairings: { requested: number; matched: number; cancelled: number; pending: number; active: number }
    streams: { opened: number; closed: number; errors: number; active: number }
  }

  export class Server extends EventEmitter {
    constructor(opts: { createStream: (opts: Record<string, unknown>) => unknown })
    readonly stats: RelayStats
    accept(stream: unknown, opts?: { id?: Buffer }): EventEmitter
    close(): Promise<void>
  }
}
