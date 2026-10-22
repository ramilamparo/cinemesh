// Does a MuxWireStream close when the REMOTE closes the channel while one of our writes is held for
// 'drain'? Protomux calls ondrain only for channels still open (protomux index.js:601-607), so the held
// callback is never released; streamx runs _destroy only when no write is active (streamx index.js:220-224).
//   npx tsx spikes/s2-transport/experiments/held-write-probe.ts
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'
import { FixedMuxWireStream } from '../lib/mux-wire-stream-fixed.js'

async function probe(name: string, Lane: typeof MuxWireStream | typeof FixedMuxWireStream): Promise<void> {
  const sa = new SecretStream(true)
  const sb = new SecretStream(false)
  sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
  const ih = Buffer.alloc(20, 7)
  const host = Lane.open(Protomux.from(sa), ih, Buffer.alloc(32, 1))!
  const viewer = Lane.open(Protomux.from(sb), ih, Buffer.alloc(32, 2))!
  host.on('error', () => {})
  viewer.on('error', () => {})
  await Promise.all([host.opened, viewer.opened])
  let hostClosed = false
  host.once('close', () => (hostClosed = true))
  // fill the mux until a write is held (Protomux reports not drained), like a host at line rate
  const block = Buffer.alloc(64 * 1024)
  for (let i = 0; i < 64; i++) host.write(block)
  viewer.destroy() // the viewer drops its lane mid-transfer
  await new Promise((r) => setTimeout(r, 1000))
  console.log(`${name}: host lane after remote close: destroying=${host.destroying} destroyed=${host.destroyed} close event=${hostClosed}`)
  sa.destroy()
  sb.destroy()
}

await probe('src MuxWireStream     ', MuxWireStream)
await probe('with _predestroy fix  ', FixedMuxWireStream)
