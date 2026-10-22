// Logs every outgoing block request of a torrent. bittorrent-protocol 5.0.9 has no 'request-sent'
// event; torrent.js _request() always calls wire.request(index, offset, length, cb) (torrent.js:1957),
// so wrapping the method from the torrent's 'wire' listener sees every request, including the very
// first one (the listener runs before _onWireWithMetadata, torrent.js:1383-1390).
import type { Torrent } from 'webtorrent'

export interface Req {
  t: number // ms since log start
  piece: number
  offset: number
  peer: string
  choked: boolean // wire.request() fails immediately with 'peer is choking'
  inReplan: boolean
}

export class RequestLog {
  readonly reqs: Req[] = []
  readonly marks: { t: number; label: string; data?: unknown }[] = []
  readonly hotswaps: { t: number; piece: number }[] = []
  readonly t0 = performance.now()

  constructor(t: Torrent, peerName: (wire: { peerId: string }) => string, inReplan: () => boolean = () => false) {
    t.on(
      'wire',
      (wire: {
        request: (index: number, offset: number, length: number, cb: unknown) => unknown
        peerChoking: boolean
        peerId: string
      }) => {
        const orig = wire.request
        wire.request = (index: number, offset: number, length: number, cb: unknown) => {
          this.reqs.push({
            t: this.now(),
            piece: index,
            offset,
            peer: peerName(wire),
            choked: wire.peerChoking,
            inReplan: inReplan(),
          })
          return orig.call(wire, index, offset, length, cb)
        }
      },
    )
    t.on('hotswap', (_from: unknown, _to: unknown, index: number) =>
      this.hotswaps.push({ t: this.now(), piece: index }),
    )
  }

  now(): number {
    return performance.now() - this.t0
  }

  mark(label: string, data?: unknown): number {
    const t = this.now()
    this.marks.push({ t, label, data })
    return t
  }
}
