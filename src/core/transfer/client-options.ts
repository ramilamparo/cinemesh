import type { WebTorrentOptions } from 'webtorrent'

/**
 * WebTorrent runs only over our Hyperswarm connections: every discovery and transport it would open
 * by itself is off. `connPool: false` needs patches/webtorrent+3.0.21.patch (no TCP listener).
 */
// No default downloadLimit: WebTorrent throttles the read side (peer.js:135-155) and MuxWireStream cannot
// push back on Protomux, so a download limit only moves the backlog into the viewer's RAM (S2). Host memory
// is bounded by reqq (engine.ts) instead.
export const WEBTORRENT_OPTIONS = {
  connPool: false,
  dht: false,
  tracker: false,
  lsd: false, // must be explicit: torrent.js passes client.lsd to discovery without checking `private`
  utPex: false,
  natUpnp: false,
  natPmp: false,
  webSeeds: false,
  utp: false,
  // torrent-discovery throws without a port even when DHT, trackers and LSD are all off. Without the
  // ConnPool nothing listens on it, and with discovery off it is never announced.
  torrentPort: 1,
} as const satisfies WebTorrentOptions
