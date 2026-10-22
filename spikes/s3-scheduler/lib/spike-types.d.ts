// Extra typings the spike needs on top of src/types/modules.d.ts (ambient declarations merge).

declare module 'webtorrent' {
  interface Torrent {
    bitfield: { get(i: number): boolean }
    downloaded: number
    uploaded: number
    _markVerified(i: number): void
  }
  interface Wire {
    peerId: string
    destroyed: boolean
  }
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  export default interface WebTorrent {
    peerId: string
  }
}

declare module 'memory-chunk-store' {
  const MemoryChunkStore: unknown
  export default MemoryChunkStore
}

declare module 'torrent-piece' {
  export default class Piece {
    static BLOCK_LENGTH: number
    constructor(length: number)
    length: number
    missing: number
  }
}

declare module 'bittorrent-protocol' {
  const Wire: { prototype: Record<string, unknown> } & (new () => Record<string, unknown>)
  type Wire = Record<string, unknown> & { hasFast: boolean; bitfield: unknown }
  export default Wire
}
