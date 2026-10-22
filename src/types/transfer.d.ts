declare module 'bencode' {
  const bencode: {
    encode(value: unknown): Uint8Array
    decode(data: Uint8Array, encoding?: string): unknown
  }
  export default bencode
}

declare module 'parse-torrent' {
  interface ParsedTorrent {
    infoHash: string
    name: string
    length: number
    pieceLength: number
    lastPieceLength: number
    pieces: string[]
    files: { name: string; path: string; length: number; offset: number }[]
    private?: boolean
  }
  export default function parseTorrent(torrent: Uint8Array | string): Promise<ParsedTorrent>
}

declare module 'bittorrent-protocol' {
  import { Duplex } from 'streamx'
  export default class Wire extends Duplex {
    constructor(type?: string | null, retries?: number, peEnabled?: boolean)
    handshake(infoHash: Uint8Array | string, peerId: Uint8Array | string, extensions?: unknown): void
  }
}
