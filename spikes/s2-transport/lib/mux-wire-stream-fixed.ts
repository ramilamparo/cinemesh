// Local copy of src/core/transfer/mux-wire-stream.ts (strict backpressure) with ONE change: _predestroy()
// releases a write held for 'drain'. Without it a lane whose channel the remote closes while a write is
// held never runs _destroy (streamx index.js:220-224), never emits 'close', and WebTorrent keeps the peer,
// its wire and all its buffered piece data alive (S2 finding; see the ADR).
import c from 'compact-encoding'
import type Protomux from 'protomux'
import type { Channel, Message } from 'protomux'
import { Duplex } from 'streamx'

export const BT_PROTOCOL = 'wtp/bt/1'
const MAX_MESSAGE_BYTES = 64 * 1024

let seq = 0

/**
 * One BitTorrent wire between two members, carried on a Protomux channel ('wtp/bt/1', id = infoHash)
 * of their Hyperswarm connection. WebTorrent takes any non-string peer through Peer.createWebRTCPeer:
 * it needs a unique `id`, `connected === true` (else it waits for 'connect' and drops the peer after
 * 25 s, peer.js:280-305) and normal close events. Both members call torrent.addPeer() once `opened`
 * resolves; the 'webrtc' peer type makes both send the handshake.
 *
 * Writes are split into <= 64 KiB messages. Backpressure is strict: when Protomux reports the
 * connection is not drained, the write callback is held until its 'drain', so a backlog of video
 * bytes never builds up in front of the control channel's messages.
 */
export class FixedMuxWireStream extends Duplex {
  readonly id: string
  readonly connected = true
  readonly remoteAddress: undefined = undefined
  readonly remotePort = 0
  /** true once both sides opened the channel; false if it closed first */
  readonly opened: Promise<boolean>

  private readonly channel: Channel
  private readonly message: Message<Uint8Array>
  private heldWrite: ((err: Error | null) => void) | null = null

  /** Returns null when this connection already has an open channel for the torrent. */
  static open(mux: Protomux, infoHash: Uint8Array, remoteKey: Uint8Array): FixedMuxWireStream | null {
    const holder: { stream: FixedMuxWireStream | null } = { stream: null }
    const channel = mux.createChannel({
      protocol: BT_PROTOCOL,
      id: infoHash,
      unique: true,
      onclose: () => holder.stream?.destroy(),
      ondrain: () => holder.stream?.release(null),
    })
    if (channel === null) return null
    holder.stream = new FixedMuxWireStream(channel, remoteKey)
    channel.open()
    return holder.stream
  }

  private constructor(channel: Channel, remoteKey: Uint8Array) {
    super()
    this.id = `${Buffer.from(remoteKey).toString('hex').slice(0, 16)}#${String(++seq)}`
    this.channel = channel
    this.message = channel.addMessage({
      encoding: c.raw,
      onmessage: (data) => {
        if (!this.destroying) this.push(data)
      },
    })
    this.opened = channel.fullyOpened()
  }

  override _write(data: Uint8Array, cb: (err: Error | null) => void): void {
    let drained = true
    for (let off = 0; off < data.byteLength; off += MAX_MESSAGE_BYTES) {
      drained = this.message.send(data.subarray(off, off + MAX_MESSAGE_BYTES))
    }
    if (this.channel.closed) cb(new Error('bt channel closed'))
    else if (drained) cb(null)
    else this.heldWrite = cb
  }

  override _read(cb: (err: Error | null) => void): void {
    cb(null) // data is pushed as channel messages arrive
  }

  override _predestroy(): void {
    this.release(new Error('bt channel destroyed'))
  }

  override _destroy(cb: (err: Error | null) => void): void {
    this.release(new Error('bt channel destroyed'))
    this.channel.close()
    cb(null)
  }

  private release(err: Error | null): void {
    const cb = this.heldWrite
    this.heldWrite = null
    cb?.(err)
  }
}
