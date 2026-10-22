import type HyperDHT from 'hyperdht'
import type { RelayStats } from 'blind-relay'

export declare const DEFAULT_PORT: number

export interface RelayHandle {
  publicKey: Buffer
  address: { host: string; port: number }
  dht: HyperDHT
  stats(): RelayStats & { connections: number }
  close(): Promise<void>
}

export declare function startRelay(opts: {
  seed: Buffer
  port?: number
  host?: string
  bootstrap?: (string | { host: string; port: number })[]
}): Promise<RelayHandle>
