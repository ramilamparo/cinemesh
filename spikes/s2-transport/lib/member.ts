// One room member (host or viewer) as the real core would run it: its own Hyperswarm, one Protomux per
// connection with a 'wtp/ctrl/1' lane (c.json) and a 'wtp/bt/1' MuxWireStream lane, WebTorrent on top.
// The host pings every viewer every 100 ms on ctrl and with datagrams; everything is recorded and returned
// in one report when the orchestrator says 'finish'.
import { readFileSync } from 'node:fs'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import c from 'compact-encoding'
import Protomux from 'protomux'
import WebTorrent from 'webtorrent'
import { WEBTORRENT_OPTIONS } from '../../../src/core/transfer/client-options.js'
import { MuxWireStream } from '../../../src/core/transfer/mux-wire-stream.js'
import { FixedMuxWireStream } from './mux-wire-stream-fixed.js'
import { SoftMuxWireStream } from './mux-wire-stream-soft.js'
import { ReadOnlyFileStore } from './read-only-store.js'
import { makeSwarm } from './swarm.js'

export interface MemberConfig {
  name: string
  role: 'host' | 'viewer'
  seedHex: string
  hostKeyHex: string
  /** every member's key (known from the members bus message in the real app) */
  memberKeysHex: string[]
  /**
   * topic  : plan §4.1 as written: everyone join(topic, {server, client}); viewers also joinPeer(host).
   * members: topic as above + joinPeer() every other member (keys known from the `members` bus message).
   * ordered: exactly one dialer per pair: join(topic, {server: true, client: false}) and joinPeer() only
   *          the members whose key sorts below ours (the host is always dialed by the viewer).
   */
  mesh: 'topic' | 'members' | 'ordered'
  bootstrap: { host: string; port: number }[]
  topicHex: string
  relayKeyHex: string | null
  relayPorts: number[]
  torrentPath: string
  sourcePath?: string
  dataDir?: string
  /** strict = src MuxWireStream as is; fixed = strict + the _predestroy fix; soft = 256 KiB soft limit (+ fix) */
  backpressure: 'strict' | 'soft' | 'fixed'
  /** viewer only: destroy and re-open the bt lane to the host this long after 'go' */
  reattachAtMs?: number
  /** viewer only: with reattachAtMs, repeat the destroy every this many ms */
  reattachEveryMs?: number
  /** advertise reqq (BEP 10) on every wire: caps the remote's outstanding requests to us */
  reqq?: number
  uploadLimitKBps?: number
  downloadLimitKBps?: number
}

export type Command = { t: 'go' } | { t: 'finish' }
export type Report = (msg: Record<string, unknown>) => void

const PING_MS = 100
const DGRAM_MAGIC = 0x53
const wall = (): number => performance.timeOrigin + performance.now() // ms, comparable across processes

interface Attach {
  reason: 'go' | 'late' | 'reattach'
  tAttach: number
  tChOpened?: number
  tWire?: number
  tFirstData?: number
  tDestroy?: number
}

interface Link {
  key: string
  remoteName: string
  isHost: boolean
  conn: any
  mux: Protomux
  ctrlSend: ((m: unknown) => void) | null
  path: string
  pathChanges: { at: number; host: string; port: number }[]
  bt: MuxWireStream | SoftMuxWireStream | FixedMuxWireStream | null
  destroyAt: number | null
  attaches: Attach[]
  down: number
  up: number
  closed: boolean
}

export async function startMember(cfg: MemberConfig, report: Report): Promise<(cmd: Command) => Promise<void>> {
  const isHost = cfg.role === 'host'
  const torrentBuf = readFileSync(cfg.torrentPath)
  const client = new WebTorrent({
    ...WEBTORRENT_OPTIONS,
    maxConns: 32,
    uploadLimit: cfg.uploadLimitKBps ? cfg.uploadLimitKBps * 1024 : -1,
    downloadLimit: cfg.downloadLimitKBps ? cfg.downloadLimitKBps * 1024 : -1,
  })
  client.on('error', (err: Error) => report({ t: 'error', where: 'client', message: err.message }))

  const torrent: any = isHost
    ? client.add(torrentBuf, {
        store: ReadOnlyFileStore,
        storeOpts: { sourcePaths: [cfg.sourcePath] },
        skipVerify: true,
        uploads: 16,
        storeCacheSlots: 16, // floor(16 MiB / P), plan §4.2 RAM
        destroyStoreOnDestroy: false,
      })
    : client.add(torrentBuf, { path: cfg.dataDir, deselect: false, strategy: 'sequential', uploads: 16, storeCacheSlots: 16 })
  torrent.on('error', (err: Error) => report({ t: 'error', where: 'torrent', message: err.message }))
  await new Promise<void>((resolve) => (torrent.ready ? resolve() : torrent.once('ready', () => resolve())))
  const infoHash = Buffer.from(torrent.infoHash, 'hex')

  const links = new Set<Link>() // every connection ever seen; Hyperswarm may briefly hold duplicates
  const liveLinks = (): number => [...links].filter((l) => !l.closed && l.ctrlSend).length
  let goAt = 0
  let finishing = false
  let doneAt = 0
  torrent.on('done', () => {
    doneAt = wall()
    report({ t: 'done', at: doneAt })
  })

  // ---- bt lane -------------------------------------------------------------------------------------
  const Lane = cfg.backpressure === 'soft' ? SoftMuxWireStream : cfg.backpressure === 'fixed' ? FixedMuxWireStream : MuxWireStream
  // Both sides open the lane, and both re-open it when it closes. Without mux.pair() that livelocks: each
  // side's re-open reaches a peer that has no bt channel at that instant, Protomux rejects it, the reject
  // closes the new lane, which triggers the next re-open (experiments/reopen-probe.ts). With pair(), a
  // remote open creates the local lane, and a local open that returns null means the lane already exists.
  const attach = (link: Link, reason: Attach['reason']): void => {
    if (finishing || link.closed) return
    const s = Lane.open(link.mux, infoHash, link.conn.remotePublicKey)
    if (s === null) {
      if (link.bt && !link.bt.destroyed) return // paired by the remote's open already
      setTimeout(() => attach(link, reason), 2) // the previous channel is still closing
      return
    }
    const rec: Attach = { reason, tAttach: performance.now() }
    if (link.destroyAt !== null) {
      rec.reason = 'reattach'
      rec.tDestroy = link.destroyAt
      link.destroyAt = null
    }
    link.bt = s
    link.attaches.push(rec)
    s.on('error', () => {})
    s.once('close', () => {
      if (link.bt === s) link.bt = null
      if (link.attaches.length >= (cfg.reattachEveryMs ? 100 : 10)) return // give up: something is wrong, the report will show it
      attach(link, 'reattach')
    })
    void s.opened.then((ok) => {
      if (!ok) return
      rec.tChOpened = performance.now()
      if (!torrent.addPeer(s)) report({ t: 'error', where: 'addPeer', message: `rejected ${s.id}` })
    })
  }
  torrent.on('wire', (wire: any) => {
    // 'wire' fires inside the wire's 'handshake' event, before its extended handshake goes out
    // (bittorrent-protocol index.js:633-642), so reqq set here is advertised
    if (cfg.reqq) wire.extendedHandshake.reqq = cfg.reqq
    for (const link of links) {
      if (!link.bt || torrent._peers.get(link.bt.id)?.wire !== wire) continue
      const rec = link.attaches[link.attaches.length - 1] as Attach
      rec.tWire = performance.now()
      wire.once(isHost ? 'upload' : 'download', () => (rec.tFirstData = performance.now()))
      wire.on('download', (n: number) => (link.down += n))
      wire.on('upload', (n: number) => (link.up += n))
    }
  })

  // ---- pings: ctrl lane and datagrams (host side measures) -------------------------------------------
  const ctrlRtts: { link: string; at: number; rtt: number }[] = []
  const dgramSent: { link: string; seq: number; at: number }[] = []
  const dgramRtts = new Map<string, { at: number; rtt: number }>() // `${link}:${seq}`
  let pingId = 0
  const pingTimer = isHost
    ? setInterval(() => {
        const id = ++pingId
        for (const link of links) {
          if (link.closed) continue
          const t0 = performance.now()
          link.ctrlSend?.({ t: 'ping', id, t0, at: wall() })
          const d = Buffer.alloc(15)
          d[0] = DGRAM_MAGIC
          d[1] = 1 // version
          d[2] = 1 // Ping
          d.writeUInt32LE(id, 3)
          d.writeDoubleLE(t0, 7)
          link.conn.trySend(d)
          dgramSent.push({ link: link.remoteName, seq: id, at: wall() })
        }
      }, PING_MS)
    : null

  const onCtrl = (link: Link, m: any): void => {
    if (m.t === 'hello') link.remoteName = m.name
    else if (m.t === 'ping') link.ctrlSend?.({ t: 'pong', id: m.id, t0: m.t0, at: m.at })
    else if (m.t === 'pong') ctrlRtts.push({ link: link.remoteName, at: m.at, rtt: performance.now() - m.t0 })
  }
  const onDatagram = (link: Link, d: Buffer): void => {
    if (d.length < 15 || d[0] !== DGRAM_MAGIC) return
    if (d[2] === 1) {
      d[2] = 2 // Pong: echo as is
      link.conn.trySend(d)
    } else if (d[2] === 2) {
      const seq = d.readUInt32LE(3)
      dgramRtts.set(`${link.remoteName}:${seq}`, { at: wall(), rtt: performance.now() - d.readDoubleLE(7) })
    }
  }

  // ---- swarm -------------------------------------------------------------------------------------
  const swarm = makeSwarm({
    bootstrap: cfg.bootstrap,
    relayKey: cfg.relayKeyHex ? Buffer.from(cfg.relayKeyHex, 'hex') : null,
    seed: Buffer.from(cfg.seedHex, 'hex'),
  })
  const connEvents: { remote: string; tConnection: number; openedMs: number; path: string }[] = []
  swarm.on('connection', (conn: any) => {
    const tConnection = performance.now()
    conn.on('error', () => {})
    const key = conn.remotePublicKey.toString('hex')
    const mux = Protomux.from(conn)
    const link: Link = {
      key,
      remoteName: key.slice(0, 8),
      isHost: key === cfg.hostKeyHex,
      conn,
      mux,
      ctrlSend: null,
      path: 'unknown',
      pathChanges: [],
      bt: null,
      destroyAt: null,
      attaches: [],
      down: 0,
      up: 0,
      closed: false,
    }
    links.add(link)
    mux.pair({ protocol: 'wtp/bt/1', id: infoHash }, () => attach(link, goAt ? 'late' : 'go'))
    const classify = (): void => {
      const { remoteHost, remotePort } = conn.rawStream
      link.path = cfg.relayPorts.includes(remotePort) ? 'relayed' : 'direct'
      link.pathChanges.push({ at: wall(), host: remoteHost, port: remotePort })
    }
    conn.rawStream.on('remote-changed', classify)
    conn.on('message', (d: Buffer) => onDatagram(link, d))
    conn.on('close', () => {
      link.closed = true
      report({ t: 'links', live: liveLinks(), ev: `close ${link.remoteName}`, swarmConns: swarm.connections.size })
    })

    const ctrl = mux.createChannel({
      protocol: 'wtp/ctrl/1',
      onopen: () => {
        link.ctrlSend = (m) => msg.send(m)
        link.ctrlSend({ t: 'hello', name: cfg.name })
      },
      onclose: () => (link.ctrlSend = null),
    })
    if (!ctrl) return
    const msg = ctrl.addMessage({ encoding: c.json, onmessage: (m: unknown) => onCtrl(link, m) })
    ctrl.open()

    void conn.opened.then((ok: boolean) => {
      if (!ok) return
      classify()
      connEvents.push({ remote: key.slice(0, 8), tConnection, openedMs: performance.now() - tConnection, path: link.path })
      void ctrl.fullyOpened().then((chOk: boolean) => {
        if (!chOk) return // resolves false when the connection closed first
        setTimeout(() => report({ t: 'links', live: liveLinks(), ev: `ctrl-open ${link.remoteName}`, swarmConns: swarm.connections.size }), 50)
        if (goAt) attach(link, 'late')
      })
    })
  })
  const myKey = swarm.keyPair.publicKey.toString('hex')
  if (cfg.mesh === 'topic') {
    swarm.join(Buffer.from(cfg.topicHex, 'hex'), { server: true, client: true })
    if (!isHost) swarm.joinPeer(Buffer.from(cfg.hostKeyHex, 'hex'))
  } else if (cfg.mesh === 'members') {
    swarm.join(Buffer.from(cfg.topicHex, 'hex'), { server: true, client: true })
    for (const k of cfg.memberKeysHex) if (k !== myKey) swarm.joinPeer(Buffer.from(k, 'hex'))
  } else {
    swarm.join(Buffer.from(cfg.topicHex, 'hex'), { server: true, client: false })
    for (const k of cfg.memberKeysHex) {
      const dial = !isHost && (k === cfg.hostKeyHex || (k !== myKey && k < myKey && k !== cfg.hostKeyHex))
      if (dial) swarm.joinPeer(Buffer.from(k, 'hex'))
    }
  }

  // ---- resource sampling -------------------------------------------------------------------------
  const samples: Record<string, number>[] = []
  const sample = (): void => {
    const m = process.memoryUsage()
    samples.push({
      at: wall(),
      rss: m.rss,
      heapUsed: m.heapUsed,
      external: m.external,
      arrayBuffers: m.arrayBuffers,
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
    })
    // host: UDX congestion state of each viewer link (the stream that carries both ctrl and bt bytes)
    if (isHost && goAt) {
      for (const l of links) {
        const u = l.conn.rawStream
        if (l.closed || !u || typeof u.inflight !== 'number') continue
        udxSamples.push({ at: wall(), link: l.remoteName, rtt: u.rtt, cwnd: u.cwnd, inflight: u.inflight, rtoCount: u.rtoCount, retransmits: u.retransmits, fastRecoveries: u.fastRecoveries, bytesTx: u.bytesTransmitted })
      }
    }
  }
  const udxSamples: Record<string, number | string>[] = []
  const sampleTimer = setInterval(sample, 250)
  const eldIdle = monitorEventLoopDelay({ resolution: 5 })
  const eldBusy = monitorEventLoopDelay({ resolution: 5 })
  eldIdle.enable()
  let cpuAtGo = process.cpuUsage()
  let eluAtGo = performance.eventLoopUtilization()
  let reattachTimer: NodeJS.Timeout | null = null

  report({ t: 'ready', key: swarm.keyPair.publicKey.toString('hex') })

  return async (cmd: Command) => {
    if (cmd.t === 'go') {
      goAt = wall()
      eldIdle.disable()
      eldBusy.enable()
      cpuAtGo = process.cpuUsage()
      eluAtGo = performance.eventLoopUtilization()
      for (const link of links) if (!link.closed && link.ctrlSend) attach(link, 'go')
      if (cfg.reattachAtMs !== undefined) {
        const destroyLane = (): void => {
          const link = [...links].find((l) => l.isHost && !l.closed)
          if (!link?.bt) return report({ t: 'error', where: 'reattach', message: 'no bt lane to host' })
          link.destroyAt = performance.now()
          link.bt.destroy()
          if (cfg.reattachEveryMs) reattachTimer = setTimeout(destroyLane, cfg.reattachEveryMs)
        }
        reattachTimer = setTimeout(destroyLane, cfg.reattachAtMs)
      }
      return
    }

    // finish: report everything, then tear down
    finishing = true
    const endAt = wall()
    eldBusy.disable()
    const cpu = process.cpuUsage(cpuAtGo)
    const elu = performance.eventLoopUtilization(eluAtGo).utilization
    sample()
    clearInterval(sampleTimer)
    if (pingTimer) clearInterval(pingTimer)
    if (reattachTimer) clearTimeout(reattachTimer)
    const ms = (h: ReturnType<typeof monitorEventLoopDelay>, p: number): number => h.percentile(p) / 1e6
    const eld = (h: ReturnType<typeof monitorEventLoopDelay>) =>
      h.count ? { p50: ms(h, 50), p99: ms(h, 99), max: h.max / 1e6, count: h.count } : null
    report({
      t: 'report',
      name: cfg.name,
      role: cfg.role,
      pid: process.pid,
      goAt,
      endAt,
      doneAt,
      eluPct: elu * 100,
      cpuPct: ((cpu.user + cpu.system) / 1000 / (endAt - goAt)) * 100,
      eldIdle: eld(eldIdle),
      eldBusy: eld(eldBusy),
      samples,
      connEvents,
      links: [...links].filter((l) => l.attaches.length || !l.closed).map((l) => ({
        remote: l.remoteName,
        isHost: l.isHost,
        path: l.path,
        pathChanges: l.pathChanges,
        down: l.down,
        up: l.up,
        attaches: l.attaches.map((a) => ({
          reason: a.reason,
          chOpenedMs: a.tChOpened !== undefined ? a.tChOpened - a.tAttach : null,
          wireMs: a.tWire !== undefined ? a.tWire - a.tAttach : null,
          firstDataMs: a.tFirstData !== undefined ? a.tFirstData - a.tAttach : null,
          sinceDestroy:
            a.tDestroy !== undefined
              ? {
                  chOpened: a.tChOpened !== undefined ? a.tChOpened - a.tDestroy : null,
                  wire: a.tWire !== undefined ? a.tWire - a.tDestroy : null,
                  firstData: a.tFirstData !== undefined ? a.tFirstData - a.tDestroy : null,
                }
              : null,
        })),
      })),
      ctrlRtts,
      dgramSent,
      dgramRtts: [...dgramRtts.entries()].map(([k, v]) => ({ k, ...v })),
      udxSamples,
      store: isHost ? ReadOnlyFileStore.stats : null,
      // objects still alive at the end: a destroyed wire should leave none behind
      live: {
        wires: torrent.wires.length,
        peers: torrent._peers.size,
        upThrottles: (client as any).throttleGroups?.up?.throttles?.length ?? null,
        downThrottles: (client as any).throttleGroups?.down?.throttles?.length ?? null,
        btLanesOpened: [...links].reduce((a, l) => a + l.attaches.length, 0),
      },
      downloaded: torrent.downloaded,
      uploaded: torrent.uploaded,
    })
    await new Promise<void>((resolve) => client.destroy(() => resolve()))
    await swarm.destroy()
  }
}
