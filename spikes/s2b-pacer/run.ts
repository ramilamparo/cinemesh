// S2b driver: one run. It must run as (fake) root in a fresh rootless session; run.sh does that:
//   spikes/s2b-pacer/run.sh --out DIR --label NAME [options]
// It builds the network (lib/topo.ts), starts a HyperDHT testnet on the bridge, a host and N viewers (lib/member.ts,
// one process per namespace), waits for the room's full mesh, and then:
//   idle    pings only (the idle RTT and one-way delays);
//   start   the host seeds (TransferEngine + striping), the viewers join and download at once;
//   warm    the transfer runs, the host uplink fills;
//   measure trials every --trial-every ms: group seeks (--trials seek) or one viewer reading far past the frontier
//           (--trials far, the round-4 bench of ADR 0003);
//   finish  every member writes its report; the driver writes DIR/LABEL.json (metrics) next to DIR/LABEL/ (raw).
//
// Options (defaults in brackets):
//   --rate R [none]           netem rate on the host's uplink, e.g. 20mbit; none = unshaped
//   --host-delay MS [20]      one-way delay on the host's uplink; --viewer-delay MS [10] on each viewer's
//   --viewer-delays A,B,...   per viewer instead (mixed RTTs), e.g. 2,25,75
//   --buffer-ms MS [500]      the host's netem queue, in ms of its rate (bufferbloat)
//   --viewers N [3]
//   --limit-kbps K            the app's upload limit on the host (KiB/s), as Settings would set it
//   --sched off|monitor|jit [monitor]   --urgent off|wire|global [off]   --jit-ms MS [100]   --jit-min KIB [32]
//   --jit-burst MS [20]       jit with a rate (--limit-kbps or --pacer): the release token bucket's depth
//   --preempt                 jit: a viewer's new blocked piece rejects its held (unserved) non-urgent requests
//   --jit-udx                 jit: a wire's queue also counts what its connection's UDX stream holds unsent
//                             (with --sched monitor: only reported)
//   --pacer TARGET_MS         the delay-based pacer (lib/pacer.ts), aiming at TARGET_MS of queueing delay
//   --pacer-burst S [0.05]    the paced throttle's bucket, in seconds of rate
//   --pacer-current MS [500]  --pacer-hold MS [2000]  --pacer-probe X [0.008]   the pacer's tuning (lib/pacer.ts)
//   --pacer-signal ctrl|dgram|udx [ctrl]  what the pacer reads: the ctrl / datagram pings' one-way delay, or UDX's
//                             smoothed RTT of each viewer's stream (no probe traffic; lib/pacer.ts)
//   --size-mib N [1024]  --piece-kib N [1024]  --bitrate BYTES/S [1000000]  --read-pieces N [4]
//   --trials seek|far [seek]  --trial-every MS [10000]  --idle MS [6000]  --warm MS [12000]  --measure MS [60000]
//   --seed N [1]
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { randomBytes } from 'node:crypto'
import createTestnet from 'hyperdht/testnet.js'
import { prepareHost } from '../../src/core/transfer/host-prepare.js'
import { type Command, type MemberConfig, type MemberEvent, type Trial, now, pct, round, sleep } from './lib/proto.js'
import { BRIDGE_IP, hostQdiscStats, rateBps, topoUp } from './lib/topo.js'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MEMBER = join(ROOT, 'spikes/s2b-pacer/lib/member.ts')

const { values: a } = parseArgs({
  options: {
    out: { type: 'string' },
    label: { type: 'string', default: 'run' },
    rate: { type: 'string', default: 'none' },
    'host-delay': { type: 'string', default: '20' },
    'viewer-delay': { type: 'string', default: '10' },
    'viewer-delays': { type: 'string' },
    'buffer-ms': { type: 'string', default: '500' },
    viewers: { type: 'string', default: '3' },
    'limit-kbps': { type: 'string' },
    sched: { type: 'string', default: 'monitor' },
    urgent: { type: 'string', default: 'off' },
    'jit-ms': { type: 'string', default: '100' },
    'jit-min': { type: 'string', default: '32' },
    'jit-burst': { type: 'string', default: '20' },
    preempt: { type: 'boolean', default: false },
    'jit-udx': { type: 'boolean', default: false },
    pacer: { type: 'string' },
    'pacer-burst': { type: 'string', default: '0.05' },
    'pacer-signal': { type: 'string', default: 'ctrl' },
    'pacer-current': { type: 'string' },
    'pacer-hold': { type: 'string' },
    'pacer-probe': { type: 'string' },
    'size-mib': { type: 'string', default: '1024' },
    'piece-kib': { type: 'string', default: '1024' },
    bitrate: { type: 'string', default: '1000000' },
    'read-pieces': { type: 'string', default: '4' },
    trials: { type: 'string', default: 'seek' },
    'trial-every': { type: 'string', default: '10000' },
    idle: { type: 'string', default: '6000' },
    warm: { type: 'string', default: '12000' },
    measure: { type: 'string', default: '60000' },
    seed: { type: 'string', default: '1' },
  },
})
if (!a.out) {
  process.stderr.write('usage: run.sh --out DIR --label NAME [options] (see run.ts)\n')
  process.exit(2)
}
const out = resolve(a.out)
const label = a.label
const runDir = join(out, label)
mkdirSync(runDir, { recursive: true })
const num = (s: string | undefined): number => Number(s)
const viewersN = num(a.viewers)
const P = num(a['piece-kib']) * 1024
const sizeMiB = num(a['size-mib'])
const hostRate = a.rate === 'none' ? null : a.rate
const trialKind = a.trials === 'far' ? 'far' : 'seek'

const driverLog: string[] = []
function say(msg: string): void {
  const line = `${new Date().toISOString().slice(11, 23)} ${label}: ${msg}`
  driverLog.push(line)
  process.stderr.write(`${line}\n`)
}
const loadavg = (): number[] => readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number)

/** sha256 prefixes of the src files a run exercises: round-5 agents edit src/ meanwhile */
function srcHashes(): Record<string, string> {
  const outH: Record<string, string> = {}
  const dirs = ['src/core/transfer', 'src/core/net', 'src/core/session', 'patches']
  for (const d of dirs) {
    for (const f of readdirSync(join(ROOT, d)).sort()) {
      if (f.endsWith('.test.ts') || !(f.endsWith('.ts') || f.endsWith('.patch'))) continue
      outH[`${d}/${f}`] = createHash('sha256')
        .update(readFileSync(join(ROOT, d, f)))
        .digest('hex')
        .slice(0, 12)
    }
  }
  return outH
}

// ---- data ---------------------------------------------------------------------------------------------------------

const dataDir = join(out, 'data')
mkdirSync(dataDir, { recursive: true })
const sourcePath = join(dataDir, `src-${String(sizeMiB)}m.bin`)
const torrentPath = join(dataDir, `src-${String(sizeMiB)}m-p${String(P / 1024)}k.torrent`)
const cacheRoot = join(dataDir, 'cache')
if (!existsSync(sourcePath)) {
  say(`writing ${String(sizeMiB)} MiB of random data`)
  const fd = openSync(`${sourcePath}.tmp`, 'w')
  for (let k = 0; k < sizeMiB; k++) writeSync(fd, randomBytes(2 ** 20))
  closeSync(fd)
  execFileSync('mv', [`${sourcePath}.tmp`, sourcePath])
}
if (!existsSync(torrentPath)) {
  say('hashing')
  const prepared = await prepareHost({ videoPath: sourcePath, subtitlePaths: [], cacheRoot, pieceLength: P })
  writeFileSync(torrentPath, prepared.torrent)
}

// ---- network and members ------------------------------------------------------------------------------------------

const loadStart = loadavg()
const hashesStart = srcHashes()
const topo = topoUp({
  viewers: viewersN,
  hostRate,
  hostDelayMs: num(a['host-delay']),
  viewerDelayMs: num(a['viewer-delay']),
  ...(a['viewer-delays'] ? { viewerDelaysMs: a['viewer-delays'].split(',').map(Number) } : {}),
  bufferMs: num(a['buffer-ms']),
})
const testnet = await createTestnet(10, { host: BRIDGE_IP })
const bootstrap = testnet.bootstrap.map((n: { host: string; port: number }) => `${n.host}:${String(n.port)}`).join(',')
say(`topology up, testnet ${bootstrap}, load ${loadStart.join(' ')}`)

const base: Omit<MemberConfig, 'role' | 'name'> = {
  dir: runDir,
  bootstrap,
  sourcePath,
  torrentPath,
  cacheRoot,
  pieceLength: P,
  uploadLimitKBps: a['limit-kbps'] ? num(a['limit-kbps']) : null,
  sched: a.sched as MemberConfig['sched'],
  urgent: a.urgent as MemberConfig['urgent'],
  jitTargetMs: num(a['jit-ms']),
  jitMinBytes: num(a['jit-min']) * 1024,
  jitBurstMs: num(a['jit-burst']),
  preempt: a.preempt,
  jitUdx: a['jit-udx'],
  pacer: a.pacer
    ? {
        targetMs: num(a.pacer),
        minBps: 250_000,
        burstS: num(a['pacer-burst']),
        signal: (['dgram', 'udx'].includes(a['pacer-signal']) ? a['pacer-signal'] : 'ctrl') as 'ctrl' | 'dgram' | 'udx',
        ...(a['pacer-current'] ? { currentMs: num(a['pacer-current']) } : {}),
        ...(a['pacer-hold'] ? { holdMs: num(a['pacer-hold']) } : {}),
        ...(a['pacer-probe'] ? { probe: num(a['pacer-probe']) } : {}),
      }
    : null,
  bitrate: num(a.bitrate),
  readPieces: num(a['read-pieces']),
  pingMs: 100,
  viewers: viewersN,
  seed: num(a.seed),
}

class Proc {
  readonly events: MemberEvent[] = []
  readonly child: ChildProcess
  exited: number | null = null
  private waiters: (() => void)[] = []
  constructor(
    readonly name: string,
    ns: string,
    cfg: MemberConfig,
  ) {
    const err = createWriteStream(join(runDir, `${name}.err`))
    this.child = spawn('ip', ['netns', 'exec', ns, process.execPath, '--import', 'tsx', MEMBER, JSON.stringify(cfg)], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child.stderr?.pipe(err)
    readline.createInterface({ input: this.child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
      let e: MemberEvent
      try {
        e = JSON.parse(line) as MemberEvent
      } catch {
        return
      }
      this.events.push(e)
      if (e.ev === 'error' || e.ev === 'log') say(`${name} ${e.ev}: ${e.msg}`)
      for (const w of this.waiters.splice(0)) w()
    })
    this.child.on('exit', (code) => {
      this.exited = code ?? -1
      for (const w of this.waiters.splice(0)) w()
    })
  }
  send(cmd: Command): void {
    this.child.stdin?.write(`${JSON.stringify(cmd)}\n`)
  }
  last<K extends MemberEvent['ev']>(ev: K): Extract<MemberEvent, { ev: K }> | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i] as MemberEvent
      if (e.ev === ev) return e as Extract<MemberEvent, { ev: K }>
    }
    return null
  }
  async until(ok: () => boolean, ms: number, what: string): Promise<void> {
    const end = Date.now() + ms
    while (!ok()) {
      if (this.exited !== null) throw new Error(`${this.name} exited (${String(this.exited)}) waiting for ${what}`)
      if (Date.now() > end) throw new Error(`${this.name}: timed out waiting for ${what}`)
      await new Promise<void>((r) => {
        this.waiters.push(r)
        setTimeout(r, 200)
      })
    }
  }
}

const procs: Proc[] = []
const marks: { name: string; at: number }[] = []
const mark = (name: string): void => {
  const at = now()
  marks.push({ name, at })
  for (const p of procs) p.send({ t: 'mark', name, at })
}
const qdiscSamples: { at: number; backlogB: number; backlogP: number; dropped: number; sentB: number }[] = []
let qdiscTimer: ReturnType<typeof setInterval> | null = null
const loadSamples: { at: number; load: number[] }[] = []
const loadTimer = setInterval(() => loadSamples.push({ at: now(), load: loadavg() }), 5000)

let failure: string | null = null
try {
  const host = new Proc('host', topo.host.ns, { ...base, role: 'host', name: 'host' })
  procs.push(host)
  await host.until(() => host.last('invite') !== null, 30_000, 'invite')
  const invite = host.last('invite')?.code ?? ''
  topo.viewers.forEach((v, k) => {
    const name = `v${String(k + 1)}`
    procs.push(new Proc(name, v.ns, { ...base, role: 'viewer', name, invite }))
  })
  const meshT0 = Date.now()
  for (const p of procs) await p.until(() => (p.last('mesh')?.peers ?? 0) >= viewersN, 90_000, 'full mesh')
  say(`mesh formed in ${String(Date.now() - meshT0)} ms`)
  qdiscTimer = setInterval(() => {
    const s = hostQdiscStats()
    const sent = /Sent (\d+) bytes/.exec(s)
    const backlog = /backlog (\d+)b (\d+)p/.exec(s)
    const dropped = /dropped (\d+)/.exec(s)
    qdiscSamples.push({
      at: now(),
      sentB: Number(sent?.[1] ?? 0),
      backlogB: Number(backlog?.[1] ?? 0),
      backlogP: Number(backlog?.[2] ?? 0),
      dropped: Number(dropped?.[1] ?? 0),
    })
  }, 250)

  mark('idle')
  await sleep(num(a.idle))
  mark('start')
  host.send({ t: 'start' })
  await host.until(() => host.last('started') !== null, 60_000, 'host started')
  for (const p of procs.slice(1)) p.send({ t: 'start' })
  for (const p of procs.slice(1)) await p.until(() => p.last('started') !== null, 60_000, 'viewer started')
  mark('warm')
  await sleep(num(a.warm))
  mark('measure')
  const every = num(a['trial-every'])
  const end = now() + num(a.measure)
  let k = 0
  // jittered (0.75-1.25 x every), so trials do not lock to a phase of the members' 1 Hz timers
  let next = now() + every * (0.5 + Math.random() / 2)
  while (next <= end - every / 4) {
    await sleep(Math.max(0, next - now()))
    if (trialKind === 'seek') host.send({ t: 'seek' })
    else host.send({ t: 'far', viewer: k })
    k++
    next += every * (0.75 + Math.random() / 2)
  }
  await sleep(Math.max(0, end - now()))
  mark('finish')
} catch (e) {
  failure = e instanceof Error ? e.message : String(e)
  say(`FAILED: ${failure}`)
}

if (qdiscTimer) clearInterval(qdiscTimer)
clearInterval(loadTimer)
const qdiscFinal = (() => {
  try {
    return hostQdiscStats()
  } catch {
    return ''
  }
})()
for (const p of procs) p.send({ t: 'finish' })
for (const p of procs) {
  await p
    .until(() => p.exited !== null, 30_000, 'exit')
    .catch(() => {
      say(`${p.name} did not exit; killing`)
      p.child.kill('SIGKILL')
    })
}
await testnet.destroy().catch(() => undefined)

// ---- analysis -----------------------------------------------------------------------------------------------------

interface Report {
  name: string
  role: string
  id: string
  eldAll: Record<string, number> | null
  eldMeasure: Record<string, number> | null
  samples: Record<string, unknown>[]
  ctrlRtts: { peer: string; id: number; t0: number; rtt: number; fwd: number }[]
  dgramRtts: { peer: string; id: number; t0: number; rtt: number; fwd: number }[]
  pingsSent: { peer: string; id: number; t0: number }[]
  ctrlOwd: { id: number; t0: number; owd: number }[]
  dgramOwd: { id: number; t0: number; owd: number }[]
  trials: Trial[]
  seeks: { seq: number; S: number; at: number; kind: string; viewer?: string }[]
  trace: { seq: number; piece: number; ev: string; at: number; member: string | null }[]
  sched: {
    capWaits: number
    rateWaits: number
    preempted: number
    unhooked: number
    wires: Record<string, unknown>[]
  } | null
  pacer: { at: number; rate: number; queueMs: number | null; upBps: number; state: string }[] | null
}
const reports = new Map<string, Report>()
for (const p of procs) {
  const path = join(runDir, `${p.name}.json`)
  if (existsSync(path)) reports.set(p.name, JSON.parse(readFileSync(path, 'utf8')) as Report)
}
const markAt = (name: string): number => marks.find((m) => m.name === name)?.at ?? Number.NaN
const idle = [markAt('idle'), markAt('start')] as const
const measure = [markAt('measure'), markAt('finish')] as const
const inWin = (t: number, w: readonly [number, number]): boolean => t >= w[0] && t <= w[1]
const stats = (xs: number[]): Record<string, number | null> => ({
  n: xs.length,
  p50: round(pct(xs, 50)),
  p95: round(pct(xs, 95)),
  p99: round(pct(xs, 99)),
  max: round(xs.length ? Math.max(...xs) : null),
})

const hostR = reports.get('host')
const viewerRs = [...reports.values()].filter((r) => r.role === 'viewer')
const metrics: Record<string, unknown> = {}
if (hostR && !failure) {
  const ctrlIdle = hostR.ctrlRtts.filter((r) => inWin(r.t0, idle))
  const ctrlMeas = hostR.ctrlRtts.filter((r) => inWin(r.t0, measure))
  const dgIdle = hostR.dgramRtts.filter((r) => inWin(r.t0, idle))
  const dgMeas = hostR.dgramRtts.filter((r) => inWin(r.t0, measure))
  const sentMeas = hostR.pingsSent.filter((r) => inWin(r.t0, measure)).length
  const idleCtrlP50 = pct(
    ctrlIdle.map((r) => r.rtt),
    50,
  )
  const idleDgFwdP50 = pct(
    dgIdle.map((r) => r.fwd),
    50,
  )
  metrics.ctrlRtt = { idle: stats(ctrlIdle.map((r) => r.rtt)), measure: stats(ctrlMeas.map((r) => r.rtt)) }
  metrics.ctrlExtraP95 = round(
    (pct(
      ctrlMeas.map((r) => r.rtt),
      95,
    ) ?? Number.NaN) - (idleCtrlP50 ?? Number.NaN),
  )
  metrics.ctrlFwd = { idle: stats(ctrlIdle.map((r) => r.fwd)), measure: stats(ctrlMeas.map((r) => r.fwd)) }
  metrics.dgramRtt = { idle: stats(dgIdle.map((r) => r.rtt)), measure: stats(dgMeas.map((r) => r.rtt)) }
  metrics.dgramFwd = { idle: stats(dgIdle.map((r) => r.fwd)), measure: stats(dgMeas.map((r) => r.fwd)) }
  metrics.dgramFwdP95OverIdle = round(
    (pct(
      dgMeas.map((r) => r.fwd),
      95,
    ) ?? Number.NaN) / (idleDgFwdP50 ?? Number.NaN),
    2,
  )
  metrics.dgramRoundTripLossPct = round(sentMeas ? 100 * (1 - dgMeas.length / sentMeas) : null, 2)
  // goodput: what the viewers got from the host in the window (bt piece bytes), and what crossed the throttle
  const hs = hostR.samples as { at: number; passed: number; served: number; distinct: number; uploaded: number }[]
  const inMeas = hs.filter((s) => inWin(s.at, measure))
  const first = inMeas[0]
  const last = inMeas[inMeas.length - 1]
  if (first && last && last.at > first.at) {
    const secs = (last.at - first.at) / 1000
    metrics.hostPassedBps = Math.round((last.passed - first.passed) / secs)
    metrics.hostUploadedBps = Math.round((last.uploaded - first.uploaded) / secs)
    metrics.dupFactorWindow = round((last.served - first.served) / Math.max(1, last.distinct - first.distinct), 3)
    // per-second rates, for saturation and the peak
    const perSec: number[] = []
    for (let i = 1; i < hs.length; i++) {
      const s0 = hs[i - 1] as (typeof hs)[number]
      const s1 = hs[i] as (typeof hs)[number]
      if (inWin(s1.at, measure)) perSec.push(((s1.passed - s0.passed) * 1000) / (s1.at - s0.at))
    }
    metrics.hostPassedPerSec = stats(perSec.map((x) => x / 1e3)) // kB/s
    const peak5 = []
    for (let i = 5; i < hs.length; i++) {
      const s0 = hs[i - 5] as (typeof hs)[number]
      const s1 = hs[i] as (typeof hs)[number]
      peak5.push(((s1.passed - s0.passed) * 1000) / (s1.at - s0.at))
    }
    metrics.hostPeak5sBps = Math.round(peak5.length ? Math.max(...peak5) : 0)
    if (hostRate) {
      const link = rateBps(hostRate)
      metrics.linkBps = link
      metrics.passedOverLink = round((last.passed - first.passed) / secs / link, 3)
      metrics.secondsAbove80pct = round(perSec.filter((x) => x >= 0.8 * link).length / Math.max(1, perSec.length), 2)
    } else if (base.uploadLimitKBps) {
      metrics.passedOverLimit = round((last.passed - first.passed) / secs / (base.uploadLimitKBps * 1024), 3)
    }
  }
  const lastSample = hs[hs.length - 1]
  metrics.dupFactorTotal = lastSample ? round(lastSample.served / Math.max(1, lastSample.distinct), 3) : null
  // viewer side: what came from the host
  const fromHost: number[] = []
  for (const v of viewerRs) {
    const vs = (v.samples as { at: number; fromPeers: Record<string, { down: number }> }[]).filter((s) =>
      inWin(s.at, measure),
    )
    const hk = hostR.id.slice(0, 8)
    const f = vs[0]?.fromPeers[hk]?.down
    const l = vs[vs.length - 1]?.fromPeers[hk]?.down
    const secs = vs.length > 1 ? ((vs[vs.length - 1]?.at ?? 0) - (vs[0]?.at ?? 0)) / 1000 : 0
    if (f !== undefined && l !== undefined && secs > 0) fromHost.push((l - f) / secs)
  }
  metrics.goodputFromHostBps = Math.round(fromHost.reduce((x, y) => x + y, 0))
  // the app's own upload queue per wire (bytes pushed into the wire not past the throttle yet)
  const queued: number[] = []
  for (const s of inMeas as unknown as { wires: { queued: number }[] }[]) for (const w of s.wires) queued.push(w.queued)
  metrics.appQueueKiB = stats(queued.map((x) => x / 1024))
  // UDX: retransmits in the window, srtt samples
  const udx = inMeas as unknown as {
    udx: Record<string, { rtt: number; retransmits: number; inflight: number } | null>
  }[]
  const srtt: number[] = []
  const inflight: number[] = []
  for (const s of udx) {
    for (const u of Object.values(s.udx)) {
      if (!u) continue
      srtt.push(u.rtt)
      inflight.push(u.inflight / 1024)
    }
  }
  metrics.udxSrttMs = stats(srtt)
  metrics.udxInflightKiB = stats(inflight)
  const rtx = (s: (typeof udx)[number] | undefined): number =>
    Object.values(s?.udx ?? {}).reduce((x, u) => x + (u?.retransmits ?? 0), 0)
  metrics.udxRetransmits = rtx(udx[udx.length - 1]) - rtx(udx[0])
  // the room's own ctrl RTT (PeerLink pings every 5 s, EWMA): what a "Host uplink saturated" warning would read
  const roomRtt: number[] = []
  for (const s of inMeas as unknown as { roomRtt: Record<string, number | null> }[])
    for (const v of Object.values(s.roomRtt)) if (v !== null) roomRtt.push(v)
  metrics.roomRttMs = stats(roomRtt)
  // netem queue on the host uplink, sampled at 4 Hz
  const q = qdiscSamples.filter((s) => inWin(s.at, measure))
  const linkBps = hostRate ? rateBps(hostRate) : null
  metrics.qdiscBacklogKiB = stats(q.map((s) => s.backlogB / 1024))
  if (linkBps) metrics.qdiscDelayMs = stats(q.map((s) => (s.backlogB / linkBps) * 1000))
  const q0 = q[0]
  const q1 = q[q.length - 1]
  if (q0 && q1) {
    metrics.qdiscDropped = q1.dropped - q0.dropped
    if (linkBps) metrics.qdiscSentOverLink = round(((q1.sentB - q0.sentB) * 1000) / (q1.at - q0.at) / linkBps, 3)
  }
  metrics.eld = Object.fromEntries([...reports.values()].map((r) => [r.name, r.eldMeasure]))
  if (hostR.pacer) {
    const pt = hostR.pacer.filter((t) => inWin(t.at, measure))
    metrics.pacerRateKBps = stats(pt.map((t) => t.rate / 1e3))
    metrics.pacerQueueMs = stats(pt.filter((t) => t.queueMs !== null).map((t) => t.queueMs as number))
  }
  metrics.sched = hostR.sched
  // ---- blocked reads ----
  const trials: (Trial & { viewerName: string })[] = []
  for (const v of viewerRs)
    for (const t of v.trials) if (inWin(t.hostAt, measure)) trials.push({ ...t, viewerName: v.name })
  const firstMs: number[] = []
  const blocked: number[] = []
  const ready: number[] = []
  const recv: number[] = []
  const anyBlocked: number[] = []
  let aborted = 0
  for (const t of trials) {
    recv.push(t.recvAt - t.hostAt)
    const r0 = t.reads[0]
    if (r0?.verifiedAt !== null && r0?.verifiedAt !== undefined) {
      firstMs.push(r0.verifiedAt - t.hostAt)
      if (r0.blockedAt !== null) blocked.push(r0.verifiedAt - r0.blockedAt)
    }
    for (const r of t.reads)
      if (r.blockedAt !== null && r.verifiedAt !== null) anyBlocked.push(r.verifiedAt - r.blockedAt)
    const lastRead = t.reads[t.reads.length - 1]
    if (!t.aborted && lastRead?.verifiedAt !== null && lastRead?.verifiedAt !== undefined)
      ready.push(lastRead.verifiedAt - t.hostAt)
    if (t.aborted) aborted++
  }
  // where the first piece's time went (medians over trials, ms after the host's seek; ADR 0003 round 4 style)
  const hostShort = hostR.id.slice(0, 8)
  const firstAt = (r: Report, seq: number, piece: number, ev: string, member?: string | null): number | null => {
    let best: number | null = null
    for (const e of r.trace) {
      if (e.seq !== seq || e.piece !== piece || e.ev !== ev) continue
      if (member !== undefined && e.member !== member) continue
      if (best === null || e.at < best) best = e.at
    }
    return best
  }
  const decomp: Record<string, number | string | null>[] = []
  for (const v of viewerRs) {
    const self = v.id.slice(0, 8)
    for (const t of v.trials) {
      if (!inWin(t.hostAt, measure)) continue
      const S = t.reads[0]?.piece
      if (S === undefined || t.reads[0]?.blockedAt === null) continue
      const rel = (x: number | null): number | null => (x === null ? null : Math.round(x - t.hostAt))
      const blk = v.trace
        .filter((e) => e.seq === t.seq && e.piece === S && e.ev === 'blk')
        .sort((x, y) => x.at - y.at)[0]
      const source = blk ? (blk.member === hostShort ? 'host' : 'viewer') : null
      decomp.push({
        source,
        have: rel(firstAt(v, t.seq, S, 'have')),
        haveHost: rel(firstAt(v, t.seq, S, 'have', hostShort)),
        req: rel(firstAt(v, t.seq, S, 'req')),
        blk: rel(blk?.at ?? null),
        blkAll: rel(firstAt(v, t.seq, S, 'blkAll')),
        ver: rel(firstAt(v, t.seq, S, 'ver')),
        hostReveal: rel(firstAt(hostR, t.seq, S, 'reveal', self)),
        hostReq: rel(firstAt(hostR, t.seq, S, 'req', self)),
        hostRel: rel(firstAt(hostR, t.seq, S, 'rel', self)),
        hostPush: rel(firstAt(hostR, t.seq, S, 'push', self)),
        hostSent: rel(firstAt(hostR, t.seq, S, 'sent', self)),
        hostSentAll: rel(firstAt(hostR, t.seq, S, 'sentAll', self)),
      })
    }
  }
  const med = (rows: typeof decomp, k: string): number | null =>
    round(
      pct(
        rows.map((r) => r[k]).filter((x): x is number => typeof x === 'number'),
        50,
      ),
      0,
    )
  const summarize = (rows: typeof decomp): Record<string, number | null> =>
    Object.fromEntries(
      [
        'have',
        'haveHost',
        'req',
        'blk',
        'blkAll',
        'ver',
        'hostReveal',
        'hostReq',
        'hostRel',
        'hostPush',
        'hostSent',
        'hostSentAll',
      ].map((k) => [k, med(rows, k)]),
    )
  metrics.decomp = {
    fromHost: {
      n: decomp.filter((r) => r.source === 'host').length,
      ...summarize(decomp.filter((r) => r.source === 'host')),
    },
    fromViewer: {
      n: decomp.filter((r) => r.source === 'viewer').length,
      ...summarize(decomp.filter((r) => r.source === 'viewer')),
    },
  }
  metrics.trials = {
    kind: trialKind,
    n: trials.length,
    aborted,
    recvMs: stats(recv),
    firstMs: stats(firstMs),
    blockedFirstMs: stats(blocked),
    blockedAnyMs: stats(anyBlocked),
    readyMs: stats(ready),
  }
}

const result = {
  label,
  args: a,
  ok: failure === null,
  failure,
  env: {
    loadStart,
    loadEnd: loadavg(),
    loadSamples,
    node: process.version,
    srcChanged: JSON.stringify(hashesStart) !== JSON.stringify(srcHashes()),
    srcHashes: hashesStart,
  },
  topo: topo.qdisc,
  qdiscFinal,
  marks,
  metrics,
  driverLog,
}
writeFileSync(join(out, `${label}.json`), JSON.stringify(result, null, 1))
const m = metrics as Record<string, Record<string, Record<string, unknown>> | number | null>
const tr = m.trials as Record<string, Record<string, unknown>> | undefined
say(
  `done: ok=${String(failure === null)} load ${loadStart.join(' ')} -> ${loadavg().join(' ')}; ` +
    `ctrl rtt p50/p95 ${JSON.stringify([(m.ctrlRtt as Record<string, Record<string, unknown>> | undefined)?.measure?.p50, (m.ctrlRtt as Record<string, Record<string, unknown>> | undefined)?.measure?.p95])} ` +
    `dgram fwd p50/p95 ${JSON.stringify([(m.dgramFwd as Record<string, Record<string, unknown>> | undefined)?.measure?.p50, (m.dgramFwd as Record<string, Record<string, unknown>> | undefined)?.measure?.p95])} ` +
    `passed ${String(m.hostPassedBps)} B/s dup ${String(m.dupFactorWindow)} ` +
    `first ${JSON.stringify([tr?.firstMs?.p50, tr?.firstMs?.p95])} blocked ${JSON.stringify([tr?.blockedFirstMs?.p50, tr?.blockedFirstMs?.p95])}`,
)
process.exit(failure === null ? 0 : 3)
