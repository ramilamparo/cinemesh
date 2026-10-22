// Part B.1: does a listener on the host torrent's 'wire' event run before the host advertises pieces,
// so that per-wire overrides of haveAll / haveNone / bitfield decide what each viewer is told?
// Logs every message the host pushes on each wire, with the fast extension on (normal) and forced off.
//   npx tsx spikes/s3-scheduler/wire-hook.ts
import Wire from 'bittorrent-protocol'
import { deadman, fixture, link, makeHost, makeViewer, MiB, peerNamer, sleep, teardown } from './lib/net.js'
import { packBits } from './lib/revealer.js'

deadman(60_000)
const NAMES: Record<number, string> = {
  0: 'choke',
  1: 'unchoke',
  2: 'interested',
  3: 'uninterested',
  4: 'have',
  5: 'bitfield',
  6: 'request',
  7: 'piece',
  8: 'cancel',
  0x0e: 'have-all',
  0x0f: 'have-none',
  0x14: 'extended',
}
const trace = new Map<object, string[]>()
const log = (w: object, s: string) => {
  const l = trace.get(w) ?? []
  l.push(s)
  trace.set(w, l)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...a: any[]) => unknown

// message log for every wire in the process (installed before any wire exists)
const proto = Wire.prototype as unknown as Record<string, Fn> & { _inMessage?: boolean }
const origMessage = proto._message!
const origPush = proto._push!
const origHandshake = proto.handshake!
proto._message = function (this: { _inMessage?: boolean }, id: number, nums: number[], data: unknown) {
  log(this, NAMES[id] ? `send ${NAMES[id]}${id === 4 ? ' ' + nums[0] : ''}` : `send #${id}`)
  this._inMessage = true
  try {
    return origMessage.call(this, id, nums, data)
  } finally {
    this._inMessage = false
  }
}
proto._push = function (this: { _inMessage?: boolean }, data: Uint8Array) {
  if (!this._inMessage) {
    if (data[0] === 19) log(this, 'send handshake')
    else if (data.length >= 5) log(this, `send ${NAMES[data[4]!] ?? '#' + data[4]}`)
  }
  return origPush.call(this, data)
}
let forceNoFast = false
proto.handshake = function (this: unknown, ih: unknown, id: unknown, ext: { fast?: boolean } = {}) {
  return origHandshake.call(this, ih, id, forceNoFast ? { ...ext, fast: false } : ext)
}

async function scenario(fast: boolean): Promise<Record<string, unknown>> {
  forceNoFast = !fast
  trace.clear()
  const { torrentFile } = await fixture(256, 256 * 1024)
  const host = await makeHost(torrentFile, -1)
  const v1 = await makeViewer('v1', torrentFile)
  const name = peerNamer([host, v1])
  const N = host.torrent.pieces.length
  const revealed = new Uint8Array(N)
  revealed[0] = revealed[1] = revealed[N - 1] = 1

  // ---- the hook (same code as lib/revealer.ts) ----
  host.torrent.on('wire', (wire: Wire & Record<string, unknown>) => {
    log(wire, `'wire' event (hasFast=${String(wire.hasFast)}, peer=${name(wire as never)})`)
    const sendBitfield = (wire.bitfield as (b: Uint8Array) => void).bind(wire)
    const advertise = (which: string) => () => {
      log(wire, `override ${which}() -> bitfield of ${revealed.reduce((a, b) => a + b, 0)} revealed pieces`)
      sendBitfield(packBits(revealed))
    }
    wire.haveAll = advertise('haveAll')
    wire.haveNone = advertise('haveNone')
    wire.bitfield = advertise('bitfield')
  })

  // what the viewer is told about the host
  const seen: string[] = []
  v1.torrent.on(
    'wire',
    (wire: { on: (e: string, f: (x?: unknown) => void) => void; peerPieces: { get(i: number): boolean } }) => {
      wire.on('have-all', () => seen.push('have-all'))
      wire.on('bitfield', () => {
        let n = 0
        for (let i = 0; i < N; i++) if (wire.peerPieces.get(i)) n++
        seen.push(`bitfield with ${n} pieces`)
      })
    },
  )
  v1.torrent.critical(0, 0) // nothing selected otherwise (deselect: true); just let it request something
  v1.torrent._select(0, 1, 0, null, true)
  const links = [await link(host, v1)]
  await sleep(1500)
  const hostWire = host.torrent.wires[0]!
  const msgs = trace.get(hostWire) ?? []
  const wireIdx = msgs.findIndex((m) => m.startsWith("'wire' event"))
  const firstAdvert = msgs.findIndex((m) => /^send (bitfield|have-all|have-none|have)/.test(m))
  const out = {
    fastExtension: fast,
    hostWireMessages: msgs.slice(0, 12),
    wireEventBeforeFirstAdvert: wireIdx >= 0 && wireIdx < firstAdvert,
    advertSentByOverride: firstAdvert > 0 && msgs[firstAdvert - 1]!.startsWith('override'),
    haveAllEverSent: msgs.includes('send have-all'),
    viewerSaw: seen,
    viewerVerifiedPieces: v1.torrent.pieces.filter((p) => p === null).length,
  }
  await teardown([host, v1], links)
  return out
}

console.log(JSON.stringify([await scenario(true), await scenario(false)], null, 2))
void MiB
process.exit(0)
