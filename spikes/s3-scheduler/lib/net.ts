// In-process WebTorrent nodes joined by SecretStream pairs + Protomux + MuxWireStream (no DHT).
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, writeSync, closeSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import SecretStream from '@hyperswarm/secret-stream'
import Protomux from 'protomux'
import { Transform } from 'streamx'
import type { Torrent } from 'webtorrent'
import type WebTorrentClass from 'webtorrent'
import MemoryChunkStore from 'memory-chunk-store'
import { WEBTORRENT_OPTIONS } from '../../../src/core/transfer/client-options.js'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'

/** S3_PATCHED_WT=1 loads patched/webtorrent (validateWire walks the plan forwards; see the report) */
export const PATCHED_WT = !!process.env.S3_PATCHED_WT
const WebTorrent: typeof WebTorrentClass = (await import(PATCHED_WT ? '../patched/webtorrent/index.js' : 'webtorrent'))
  .default
type WebTorrent = WebTorrentClass

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data')
export const MiB = 1024 * 1024

export interface Node {
  name: string
  client: WebTorrent
  torrent: Torrent
  key: Buffer
}

/** A random file of `sizeMiB` MiB plus its torrent (hashed once, cached in data/). */
export async function fixture(sizeMiB: number, pieceLength: number): Promise<{ path: string; torrentFile: Buffer }> {
  mkdirSync(DATA_DIR, { recursive: true })
  const path = join(DATA_DIR, `movie-${sizeMiB}.bin`)
  if (!existsSync(path)) {
    const fd = openSync(path, 'w')
    for (let i = 0; i < sizeMiB; i++) writeSync(fd, randomBytes(MiB))
    closeSync(fd)
  }
  const tpath = join(DATA_DIR, `movie-${sizeMiB}-${pieceLength}.torrent`)
  if (existsSync(tpath)) return { path, torrentFile: readFileSync(tpath) }
  const c = new WebTorrent(WEBTORRENT_OPTIONS)
  const t = await new Promise<Torrent>((resolve) => {
    c.seed(path, { pieceLength, private: true, announceList: [] }, resolve)
  })
  const torrentFile = Buffer.from(t.torrentFile)
  writeFileSync(tpath, torrentFile)
  await new Promise((r) => c.destroy(r))
  return { path, torrentFile }
}

function ready(t: Torrent): Promise<void> {
  return new Promise((resolve) => (t.ready ? resolve() : t.once('ready', () => resolve())))
}

/** The host seeds the fixture from disk without re-hashing it (skipVerify, like plan §4.2). */
export async function makeHost(torrentFile: Buffer, uploadLimit: number): Promise<Node> {
  const client = new WebTorrent({ ...WEBTORRENT_OPTIONS, uploadLimit })
  const torrent = client.add(torrentFile, { path: DATA_DIR, skipVerify: true, uploads: 16 } as never)
  await ready(torrent)
  return { name: 'host', client, torrent, key: createHash('sha256').update('host').digest() }
}

/** A viewer: in-memory store, nothing selected until the scheduler plans (deselect: true). */
export async function makeViewer(
  name: string,
  torrentFile: Buffer,
  onTorrent?: (t: Torrent) => void,
  uploadLimit = -1,
): Promise<Node> {
  const client = new WebTorrent({ ...WEBTORRENT_OPTIONS, uploadLimit })
  const torrent = client.add(torrentFile, {
    store: MemoryChunkStore,
    deselect: true,
    strategy: 'sequential',
    uploads: 16,
  } as never)
  onTorrent?.(torrent)
  await ready(torrent)
  return { name, client, torrent, key: createHash('sha256').update(name).digest() }
}

/** Constant one-way delay (FIFO: equal-delay Node timers fire in insertion order). */
class Delay extends Transform {
  constructor(private readonly ms: number) {
    super()
  }

  override _transform(data: Buffer, cb: (err: Error | null, data?: Buffer) => void): void {
    setTimeout(() => {
      if (!this.destroying) this.push(data)
    }, this.ms)
    cb(null)
  }
}

export interface Link {
  a: string
  b: string
  close(): void
}

/** One SecretStream pair = one Hyperswarm connection; the bt wire is a 'wtp/bt/1' channel on it. */
export async function link(a: Node, b: Node, oneWayDelayMs = 0): Promise<Link> {
  const sa = new SecretStream(true)
  const sb = new SecretStream(false)
  if (oneWayDelayMs > 0) {
    sa.rawStream.pipe(new Delay(oneWayDelayMs)).pipe(sb.rawStream)
    sb.rawStream.pipe(new Delay(oneWayDelayMs)).pipe(sa.rawStream)
  } else {
    sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
  }
  const ih = Buffer.from(a.torrent.infoHash, 'hex')
  const wa = MuxWireStream.open(Protomux.from(sa), ih, b.key)
  const wb = MuxWireStream.open(Protomux.from(sb), ih, a.key)
  if (!wa || !wb) throw new Error('channel not created')
  if (!(await wa.opened) || !(await wb.opened)) throw new Error('channel closed before open')
  a.torrent.addPeer(wa)
  b.torrent.addPeer(wb)
  return {
    a: a.name,
    b: b.name,
    close: () => {
      sa.destroy()
      sb.destroy()
    },
  }
}

/** Name of the node at the other end of a wire (wire.peerId is the remote client's peerId). */
export function peerNamer(nodes: Node[]): (wire: { peerId: string }) => string {
  const byId = new Map(nodes.map((n) => [n.client.peerId as string, n.name]))
  return (wire) => byId.get(wire.peerId) ?? '?'
}

export async function teardown(nodes: Node[], links: Link[]): Promise<void> {
  await Promise.all(nodes.map((n) => new Promise((r) => n.client.destroy(r))))
  for (const l of links) l.close()
}

/** Hard stop so a hung run never outlives its budget. */
export function deadman(ms: number): void {
  setTimeout(() => {
    console.error(`deadman: run exceeded ${ms} ms, exiting`)
    process.exit(3)
  }, ms).unref()
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
