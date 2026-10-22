// One S2 measurement run: testnet + (relay) + host + 3 viewers, idle phase, then full-speed transfer.
// Use ./run.sh, which wraps this in its own user+net namespace (and netem when asked). Flags:
//   --label <name>     results/<name>.json (required)
//   --bp strict|soft|fixed  MuxWireStream variant (default strict = src as is; fixed = + _predestroy fix)
//   --relay            run a blind relay, force relayThrough, and drop direct member<->member UDP (nft)
//   --one-process      host + 3 viewers in one Node process
//   --reattach <ms>    viewer v1 destroys and re-opens its bt lane to the host <ms> after 'go'
//   --reattach-every <ms>  with --reattach: repeat that every <ms>
//   --max-ms <ms>      transfer window cap (default 90000)
//   --netem "<args>"   e.g. "delay 25ms rate 50mbit": applied to lo once the mesh is up (before the idle phase)
//   --netem-early      apply --netem before anything starts (to measure mesh formation under netem)
//   --viewers <n>      number of viewers (default 3)
//   --mesh topic|members|ordered  how the mesh is dialed (default ordered; see lib/member.ts)
//   --reqq <n>         every member advertises reqq = n (max outstanding block requests per wire)
import { fork, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { analyze } from './lib/analyze.js'
import { blockMemberToMember, droppedPackets } from './lib/nft.js'
import type { MemberConfig } from './lib/member.js'

const { values: args } = parseArgs({
  options: {
    label: { type: 'string' },
    bp: { type: 'string', default: 'strict' },
    relay: { type: 'boolean', default: false },
    'one-process': { type: 'boolean', default: false },
    reattach: { type: 'string' },
    'reattach-every': { type: 'string' },
    'max-ms': { type: 'string', default: '90000' },
    'idle-ms': { type: 'string', default: '6000' },
    viewers: { type: 'string', default: '3' },
    reqq: { type: 'string' },
    netem: { type: 'string' },
    'netem-early': { type: 'boolean', default: false },
    'up-limit': { type: 'string' },
    'down-limit': { type: 'string' },
    mesh: { type: 'string', default: 'ordered' },
  },
})
if (!args.label) throw new Error('--label is required')
const here = import.meta.dirname
const dataDir = join(here, 'data')
const runDir = join(dataDir, `run-${args.label}`)
const source = join(dataDir, 'source.bin')
const torrentPath = join(dataDir, 'source.torrent')
const sourceMeta = JSON.parse(readFileSync(join(dataDir, 'source.json'), 'utf8'))
const idleMs = Number(args['idle-ms'])
const maxMs = Number(args['max-ms'])
const children: ChildProcess[] = []
const log = (...a: unknown[]): void => console.error(`[${args.label}]`, ...a)

const killAll = (): void => {
  for (const ch of children) if (ch.exitCode === null) ch.kill('SIGKILL')
}
process.on('exit', killAll)
const hardStop = setTimeout(() => {
  log('hard timeout: killing everything')
  killAll()
  process.exit(2)
}, maxMs + idleMs + 120_000)
hardStop.unref()

const applyNetem = (): void => {
  if (args.netem) execFileSync('tc', ['qdisc', 'add', 'dev', 'lo', 'root', 'netem', ...args.netem.split(/\s+/)])
}
const showQdisc = (): string => {
  try {
    return execFileSync('tc', ['qdisc', 'show', 'dev', 'lo']).toString().trim()
  } catch {
    return 'unknown'
  }
}
if (args['netem-early']) applyNetem()
const before = statSync(source)
const load0 = loadavg()

rmSync(runDir, { recursive: true, force: true })
mkdirSync(runDir, { recursive: true })

const testnet = await createTestnet(3)
const bootstrap = testnet.bootstrap
const tnPorts = testnet.nodes.flatMap((n: any) => [n.io.serverSocket.address().port, n.io.clientSocket.address().port])

let relayKeyHex: string | null = null
let relayPorts: number[] = []
let relayProc: ChildProcess | null = null
if (args.relay) {
  relayProc = fork(join(here, 'lib/relay-main.ts'), { execArgv: ['--import', 'tsx'], stdio: 'inherit' })
  children.push(relayProc)
  relayProc.send({ bootstrap })
  const m: any = await new Promise((resolve) => relayProc!.once('message', resolve))
  relayKeyHex = m.publicKey
  relayPorts = m.ports
  blockMemberToMember([...tnPorts, ...relayPorts])
  log('relay', relayKeyHex!.slice(0, 8), 'ports', relayPorts, '; direct member<->member UDP dropped')
}

const seed = (i: number): Buffer => Buffer.alloc(32, i + 1)
const nViewers = Number(args.viewers)
const names = ['host', ...Array.from({ length: nViewers }, (_, i) => `v${i + 1}`)]
const memberKeysHex = names.map((_, i) => HyperDHT.keyPair(seed(i)).publicKey.toString('hex'))
const hostKeyHex = memberKeysHex[0] as string
const configs: MemberConfig[] = names.map((name, i) => ({
  name,
  role: i === 0 ? 'host' : 'viewer',
  seedHex: seed(i).toString('hex'),
  hostKeyHex,
  memberKeysHex,
  mesh: args.mesh as 'topic' | 'members' | 'ordered',
  bootstrap,
  topicHex: Buffer.alloc(32, 0x5a).toString('hex'),
  relayKeyHex: i === 0 ? null : relayKeyHex, // relayThrough forced on the viewers only
  relayPorts,
  torrentPath,
  sourcePath: i === 0 ? source : undefined,
  dataDir: i === 0 ? undefined : join(runDir, name),
  backpressure: args.bp as 'strict' | 'soft' | 'fixed',
  reattachAtMs: name === 'v1' && args.reattach ? Number(args.reattach) : undefined,
  reattachEveryMs: name === 'v1' && args['reattach-every'] ? Number(args['reattach-every']) : undefined,
  reqq: args.reqq ? Number(args.reqq) : undefined,
  // KB/s; "host,viewer"
  uploadLimitKBps: args['up-limit'] ? Number(args['up-limit'].split(',')[i === 0 ? 0 : 1]) : undefined,
  downloadLimitKBps: args['down-limit'] ? Number(args['down-limit'].split(',')[i === 0 ? 0 : 1]) : undefined,
}))

// ---- spawn members ---------------------------------------------------------------------------------
const reports: any[] = []
const ready = new Set<string>()
const done = new Set<string>()
const links = new Map<string, number>()
const linkEvents: string[] = []
const t0 = Date.now()
let byes = 0
const groups = args['one-process'] ? [configs] : configs.map((c) => [c])
const procs = groups.map((group) => {
  const ch = fork(join(here, 'lib/member-main.ts'), { execArgv: ['--import', 'tsx'], stdio: 'inherit' })
  children.push(ch)
  ch.on('message', (m: any) => {
    if (m.t === 'ready') ready.add(m.name)
    else if (m.t === 'links') {
      links.set(m.name, m.live)
      linkEvents.push(`${((Date.now() - t0) / 1000).toFixed(2)}s ${m.name}: ${m.ev} live=${m.live} swarmConns=${m.swarmConns}`)
    }
    else if (m.t === 'done') done.add(m.name)
    else if (m.t === 'report') reports.push(m)
    else if (m.t === 'bye') byes++
    else if (m.t === 'error') log('error from', m.name, m.where, m.message)
  })
  ch.send({ configs: group })
  return ch
})
const until = async (cond: () => boolean, ms: number, what: string): Promise<void> => {
  const t = Date.now()
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const sendAll = (cmd: object): void => {
  for (const p of procs) p.send(cmd)
}

let failure: string | null = null
let netem = showQdisc()
let meshMs: number | null = null
try {
  await until(() => ready.size === names.length, 30_000, 'members ready')
  const tReady = Date.now()
  await until(() => names.every((n) => links.get(n) === names.length - 1), 60_000, 'full mesh of ctrl lanes')
  meshMs = Date.now() - tReady
  if (!args['netem-early']) applyNetem()
  netem = showQdisc()
  log(`mesh up; idle phase ${idleMs} ms`)
  await new Promise((r) => setTimeout(r, idleMs))
  const goAt = Date.now()
  sendAll({ t: 'go' })
  relayProc?.send({ t: 'go' })
  await until(() => done.size === nViewers || Date.now() - goAt > maxMs, maxMs + 5000, 'transfer')
  log(`transfer phase ended after ${Date.now() - goAt} ms (${done.size}/${nViewers} viewers done)`)
} catch (err) {
  failure = (err as Error).message
  log('FAILED:', (err as Error).message, { ready: [...ready], links: Object.fromEntries(links) })
  log(linkEvents.join('\n'))
}
sendAll({ t: 'finish' })
await until(() => byes === procs.length, 20_000, 'reports').catch((e) => log(e.message))
let relayStats: unknown = null
if (relayProc) {
  relayProc.send({ t: 'stop' })
  relayStats = await Promise.race([
    new Promise((resolve) => relayProc!.once('message', (m: any) => resolve(m.stats))),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ])
}
const dropped = args.relay ? droppedPackets() : null
await testnet.destroy()

const after = statSync(source)
const result = {
  label: args.label,
  failure,
  mesh: { ms: meshMs, events: linkEvents },
  config: { upLimit: args['up-limit'] ?? null, downLimit: args['down-limit'] ?? null, mesh: args.mesh, viewers: nViewers, reqq: args.reqq ?? null, bp: args.bp, relay: args.relay, oneProcess: args['one-process'], reattach: args.reattach ?? null, maxMs, idleMs, netem },
  env: { cpus: cpus().length, loadavgBefore: load0, loadavgAfter: loadavg(), node: process.version },
  source: {
    sizeBefore: before.size,
    sizeAfter: after.size,
    mtimeBefore: before.mtimeMs,
    mtimeAfter: after.mtimeMs,
    unchanged: before.size === after.size && before.mtimeMs === after.mtimeMs && after.mtimeMs === sourceMeta.mtimeMs,
  },
  relay: args.relay ? { stats: relayStats, droppedDirectPackets: dropped } : null,
  reportsReceived: reports.map((r) => r.name),
  ...(reports.length === names.length && !failure ? analyze(reports, { idleMs, fileLength: sourceMeta.size }) : { error: 'missing reports' }),
}
mkdirSync(join(here, 'results'), { recursive: true })
mkdirSync(join(dataDir, 'raw'), { recursive: true })
writeFileSync(join(here, 'results', `${args.label}.json`), JSON.stringify(result, null, 2))
writeFileSync(join(dataDir, 'raw', `${args.label}.json`), JSON.stringify(reports))
rmSync(runDir, { recursive: true, force: true }) // 3 x 2 GB of viewer data
for (const p of procs) if (p.exitCode === null) p.kill('SIGKILL')
if (relayProc && relayProc.exitCode === null) relayProc.kill('SIGKILL')
const t = result as any
log(
  'summary',
  JSON.stringify({ throughput: t.throughput && { v: t.throughput.viewerMedianMBps, host: t.throughput.hostUploadMBps }, ctrl: t.latency?.ctrl, dIdle: t.latency?.dgramIdle, dSat: t.latency?.dgramSat, procs: t.perProcess, hs: t.handshake, re: t.reattach }),
)
process.exit(0)
