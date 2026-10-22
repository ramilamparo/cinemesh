// Local variant of src/core/transfer/mux-wire-stream.ts with a soft backpressure limit: the write callback
// is released at once while fewer than SOFT_LIMIT bytes were sent since Protomux last reported "drained";
// only past that is it held until 'drain'. Everything else is identical to the src version, plus the
// _predestroy fix of lib/mux-wire-stream-fixed.ts (added after the lo-soft/ne-soft runs; those runs did not
// re-attach, so it did not affect them).
import c from 'compact-encoding'
import type Protomux from 'protomux'
import type { Channel, Message } from 'protomux'
import { Duplex } from 'streamx'

export const BT_PROTOCOL = 'wtp/bt/1'
const MAX_MESSAGE_BYTES = 64 * 1024
export const SOFT_LIMIT = 256 * 1024

let seq = 0

export class SoftMuxWireStream extends Duplex {
  readonly id: string
  readonly connected = true
  readonly remoteAddress: undefined = undefined
  readonly remotePort = 0
  readonly opened: Promise<boolean>

  private readonly channel: Channel
  private readonly message: Message<Uint8Array>
  private heldWrite: ((err: Error | null) => void) | null = null
  private undrained = 0 // bytes sent since the mux last reported drained

  static open(mux: Protomux, infoHash: Uint8Array, remoteKey: Uint8Array): SoftMuxWireStream | null {
    const holder: { stream: SoftMuxWireStream | null } = { stream: null }
    const channel = mux.createChannel({
      protocol: BT_PROTOCOL,
      id: infoHash,
      unique: true,
      onclose: () => holder.stream?.destroy(),
      ondrain: () => holder.stream?.release(null),
    })
    if (channel === null) return null
    holder.stream = new SoftMuxWireStream(channel, remoteKey)
    channel.open()
    return holder.stream
  }

  private constructor(channel: Channel, remoteKey: Uint8Array) {
    super()
    this.id = `${Buffer.from(remoteKey).toString('hex').slice(0, 16)}~${String(++seq)}`
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
    if (this.channel.closed) return cb(new Error('bt channel closed'))
    if (drained) {
      this.undrained = 0
      return cb(null)
    }
    this.undrained += data.byteLength
    if (this.undrained < SOFT_LIMIT) cb(null)
    else this.heldWrite = cb
  }

  override _read(cb: (err: Error | null) => void): void {
    cb(null)
  }

  // same fix as lib/mux-wire-stream-fixed.ts: without it a held write blocks _destroy forever
  override _predestroy(): void {
    this.release(new Error('bt channel destroyed'))
  }

  override _destroy(cb: (err: Error | null) => void): void {
    this.release(new Error('bt channel destroyed'))
    this.channel.close()
    cb(null)
  }

  private release(err: Error | null): void {
    if (err === null) this.undrained = 0
    const cb = this.heldWrite
    this.heldWrite = null
    cb?.(err)
  }
}
