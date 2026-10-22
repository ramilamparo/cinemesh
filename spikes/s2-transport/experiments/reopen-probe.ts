// Can a MuxWireStream lane be destroyed and re-opened on the same Protomux pair? Both sides re-open on
// 'close' (like lib/member.ts). Prints what happens to each attempt.
//   npx tsx spikes/s2-transport/experiments/reopen-probe.ts [immediate|tick|pair]
// immediate/tick: both sides re-open on close (livelocks: each open meets a peer with no channel and is
// rejected). pair: both sides also register mux.pair() for the bt protocol, so a remote open creates the
// local lane, and an attempt that returns null (a lane already exists) is simply dropped.
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'

const mode = process.argv[2] ?? 'immediate'
const sa = new SecretStream(true)
const sb = new SecretStream(false)
sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
const ma = Protomux.from(sa)
const mb = Protomux.from(sb)
const ih = Buffer.alloc(20, 7)
const t0 = performance.now()
const at = () => (performance.now() - t0).toFixed(1)
let attempts = 0

const live = new Map<string, MuxWireStream>()
const lane = (name: string, mux: Protomux): void => {
  if (++attempts > 12) return
  const s = MuxWireStream.open(mux, ih, Buffer.alloc(32, name === 'a' ? 1 : 2))
  if (s === null && mode === 'pair') {
    console.log(at(), name, 'open returned null: lane already exists, done')
    return
  }
  if (s === null) {
    console.log(at(), name, 'open returned null, retry')
    setTimeout(() => lane(name, mux), 2)
    return
  }
  live.set(name, s)
  s.on('error', () => {})
  void s.opened.then((ok) => console.log(at(), name, s.id, 'opened', ok))
  s.once('close', () => {
    console.log(at(), name, s.id, 'closed')
    if (mode === 'tick') setTimeout(() => lane(name, mux), 0)
    else lane(name, mux)
  })
  if (name === 'a' && attempts === 1) setTimeout(() => s.opened.then(() => (console.log(at(), 'destroying a'), s.destroy())), 50)
}
if (mode === 'pair') {
  ma.pair({ protocol: 'wtp/bt/1', id: ih }, () => lane('a', ma))
  mb.pair({ protocol: 'wtp/bt/1', id: ih }, () => lane('b', mb))
}
lane('a', ma)
lane('b', mb)
await new Promise((r) => setTimeout(r, 1000))
console.log('attempts', attempts)
sa.destroy()
sb.destroy()
