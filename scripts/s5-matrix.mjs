#!/usr/bin/env node
// S5: the NAT and relay matrix (plan §7 S5). Method and results: docs/adr/0005-s5-nat-matrix.md.
//
// Runs inside a rootless session (no sudo needed) or as root:
//   scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out DIR [--label run1] [--rows nat,a1,...]
//                                                        [--size 20] [--netem 'delay 10ms' | --netem none]
//                                                        [--pub 192.88.99] [--repeats 8]
//
// Every row gets a fresh topology from scripts/netns-nat.sh (so no conntrack state carries over), a HyperDHT
// testnet plus a blind relay in wt-pub (scripts/testnet.mjs), and headless room members
// (src/core/net/headless.ts, run from the working tree with tsx, with scripts/s5-hyperdht-trace.mjs preloaded)
// in wt-a / wt-b / wt-c. Output:
//   DIR/<label>/<row>/<member>.jsonl   each member's JSON lines as printed (every line carries its time `t`)
//   DIR/<label>/<row>/row.json         measurements, pass/fail per criterion, the driver's own log
//   DIR/<label>/summary.json           every row, plus hashes of src/core/net before (and after) the run
// --netem: a netem qdisc on every access link, both directions. The default 'delay 10ms' gives 20 ms RTT to
// the testnet and 40 ms between members behind different routers. With no delay and a small testnet, the
// bootstrap query ends before hyperdht's quick firewall probe answers, so nothing is ever classified OPEN
// (dht-rpc index.js:389-430); see the ADR.
//
// Rows (plan §7 S5 pass criteria in brackets):
//   nat    Network test (headless nat) per namespace and router mode, a fixed UDP port before and after a
//          forward, and UDP blocked                  ['randomized'; a forwarded port turns RANDOM into OPEN/CONSISTENT]
//   a1-a2  CONSISTENT ↔ RANDOM, either side hosting, no relay        [goes direct]
//   a3-a4  the same with a relay key in the invite                    [fires remote-changed: relayed → direct]
//   a5     the same with alwaysRelay on both sides: stays relayed (hyperdht's holepunch callback refuses)
//   a6     CONSISTENT ↔ CONSISTENT, relay + alwaysRelay on both: stays relayed too
//   b1-b3  RANDOM ↔ RANDOM: no relay, relay key, alwaysRelay          [HOLEPUNCH_DOUBLE_RANDOMIZED_NATS, then relayed]
//   c1     OPEN host, two RANDOM viewers that cannot link             [a via-peer member receives state]
//   c2     RANDOM host, OPEN viewer, RANDOM viewer that cannot reach the host (admitted through the neighbour)
//   d1-d3  udpPort + forward on b's router: random (DNAT only), random + static outbound port, plain
//   m1-m2  RANDOM host with two CONSISTENT viewers, without and with a relay (hyperdht's random-punch limit)
//   p      CONSISTENT ↔ RANDOM link time without a relay, --repeats times (hosts alternate sides)
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import readline from 'node:readline'
import { setTimeout } from 'node:timers'
import { URL, fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const NETNS = join(ROOT, 'scripts/netns-nat.sh')
const HEADLESS = 'src/core/net/headless.ts'
const TRACE = './scripts/s5-hyperdht-trace.mjs'
const FWD_PORT = 49800
const STICKY = 'session.announce'
const DOUBLE_RANDOM = 'HOLEPUNCH_DOUBLE_RANDOMIZED_NATS'

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string' },
    label: { type: 'string', default: 'run' },
    rows: { type: 'string', default: 'all' },
    size: { type: 'string', default: '20' },
    netem: { type: 'string', default: 'delay 10ms' },
    pub: { type: 'string', default: '192.88.99' },
    repeats: { type: 'string', default: '8' },
    help: { type: 'boolean', short: 'h' },
  },
})
const netem = opts.netem === 'none' ? null : opts.netem
// The "public" /24 of the topology (scripts/netns-nat.sh reads WT_NETNS_PUB; it must not be a hyperdht bogon).
process.env.WT_NETNS_PUB = opts.pub
const PUB_HOST = `${opts.pub}.1`

if (opts.help || !opts.out) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .slice(1)
  const header = lines.slice(
    0,
    lines.findIndex((l) => !l.startsWith('//')),
  )
  process.stdout.write(`${header.join('\n')}\n`)
  process.exit(opts.help ? 0 : 2)
}
if (process.getuid?.() !== 0) {
  process.stderr.write('s5-matrix: needs root; run it inside scripts/netns-rootless.sh (no sudo needed)\n')
  process.exit(2)
}

const runDir = join(opts.out, opts.label)
mkdirSync(runDir, { recursive: true })

// ---- small helpers ----------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, ms, step = 100) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(step)
  }
  return check()
}

function netns(...args) {
  return execFileSync(NETNS, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function treeHashes() {
  const dir = join(ROOT, 'src/core/net')
  const out = {}
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue
    out[f] = createHash('sha256')
      .update(readFileSync(join(dir, f)))
      .digest('hex')
      .slice(0, 16)
  }
  return out
}

class InfraError extends Error {}

/** One process in a namespace, its stdout JSON lines parsed as they arrive. */
class Proc {
  constructor(row, name, ns, argv, env = {}) {
    this.row = row
    this.name = name
    this.ns = ns
    this.argv = argv
    this.events = []
    this.lines = []
    this.exit = null
    this.spawnedAt = Date.now()
    this.stderr = ''
    const file = createWriteStream(join(row.dir, `${name}.jsonl`))
    this.child = spawn(NETNS, ['exec', ns, ...argv], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      file.write(`${line}\n`)
      this.lines.push(line)
      try {
        const e = JSON.parse(line)
        if (e && typeof e === 'object') this.events.push(e)
      } catch {
        // not JSON (testnet output); kept in lines
      }
    })
    this.child.stderr.on('data', (d) => {
      this.stderr += String(d)
      if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000)
    })
    this.closed = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exit = { code, signal, at: Date.now() }
        file.end()
        if (this.stderr) writeFileSync(join(row.dir, `${name}.stderr`), this.stderr)
        resolve()
      })
    })
    row.log('spawn', { name, ns, argv: argv.join(' ') })
  }

  /** Events before the row started stopping members: teardown (links dropping) is not a result. */
  view() {
    const cut = this.row.stoppingAt
    return cut === null ? this.events : this.events.filter((e) => e.t < cut)
  }

  first(event, pred = () => true) {
    return this.view().find((e) => e.event === event && pred(e)) ?? null
  }

  all(event, pred = () => true) {
    return this.view().filter((e) => e.event === event && pred(e))
  }

  /** ms since this process was spawned */
  rel(e) {
    return e ? e.t - this.spawnedAt : null
  }

  get self() {
    return this.events.find((e) => e.event === 'up')?.self ?? null
  }

  async stop(ms = 5000) {
    if (this.exit) return
    this.child.kill('SIGTERM')
    await Promise.race([this.closed, sleep(ms)])
    if (!this.exit) {
      this.child.kill('SIGKILL')
      await this.closed
    }
  }
}

// ---- one row ----------------------------------------------------------------------------------------------

class Row {
  constructor(spec) {
    this.spec = spec
    this.dir = join(runDir, spec.id)
    mkdirSync(this.dir, { recursive: true })
    this.members = new Map()
    this.procs = []
    this.journal = []
    this.boot = null
    this.relayKey = null
    this.startedAt = Date.now()
    this.stoppingAt = null
  }

  log(what, fields = {}) {
    this.journal.push({ t: Date.now(), what, ...fields })
  }

  netns(...args) {
    this.log('netns', { args: args.join(' ') })
    return netns(...args)
  }

  async up() {
    const [modeA, modeB] = this.spec.modes
    try {
      netns('down')
    } catch {
      // nothing to tear down
    }
    this.netns('up', modeA, modeB)
    for (const step of this.spec.setup ?? []) this.netns(...step)
    if (netem) applyNetem(this, netem)
    writeFileSync(join(this.dir, 'topology.txt'), netns('status'))
    const testnet = new Proc(this, 'testnet', 'pub', [
      'node',
      'scripts/testnet.mjs',
      '--host',
      PUB_HOST,
      '--relay',
      '--quiet',
      '--size',
      opts.size,
    ])
    this.procs.push(testnet)
    if (!(await until(() => testnet.lines.length >= 2 || testnet.exit !== null, 60_000))) {
      throw new InfraError(`testnet did not start: ${testnet.stderr.slice(-500)}`)
    }
    if (testnet.lines.length < 2) throw new InfraError(`testnet exited: ${testnet.stderr.slice(-500)}`)
    this.boot = testnet.lines[0].trim()
    this.relayKey = testnet.lines[1].trim()
    this.log('testnet', { boot: this.boot, relayKey: this.relayKey })
  }

  args(list) {
    return list.map((a) => (a === '{relay}' ? this.relayKey : a))
  }

  spawnMember(name, ns, argv) {
    const node = ['node', '--import', 'tsx', '--import', TRACE, HEADLESS]
    const p = new Proc(this, name, ns, [...node, ...argv], { WT_BOOTSTRAP: this.boot })
    this.procs.push(p)
    this.members.set(name, p)
    return p
  }

  async host(ns, name, extra = []) {
    const p = this.spawnMember(name, ns, ['host', '--name', name, '--sticky', ...this.args(extra)])
    await this.waitUp(p, 'invite')
    return p
  }

  async join(ns, name, host, extra = []) {
    const invite = host.events.find((e) => e.event === 'invite')?.code
    if (!invite) throw new InfraError(`no invite from ${host.name}`)
    const p = this.spawnMember(name, ns, ['join', invite, '--name', name, ...this.args(extra)])
    await this.waitUp(p, 'up')
    return p
  }

  async waitUp(p, event) {
    const ok = await until(() => p.first(event) !== null || p.exit !== null, 40_000)
    if (!ok || p.exit !== null) {
      throw new InfraError(`${p.name} did not come up (exit ${JSON.stringify(p.exit)}): ${p.stderr.slice(-800)}`)
    }
  }

  /** The Network test in a namespace: a fresh DHT, its NAT class, and the hint the UI would show. */
  async nat(ns, label, extra = []) {
    const p = new Proc(this, `nat-${label}`, ns, ['node', '--import', 'tsx', HEADLESS, 'nat', ...extra], {
      WT_BOOTSTRAP: this.boot,
    })
    this.procs.push(p)
    await Promise.race([p.closed, sleep(40_000)])
    await p.stop()
    const e = p.events.find((x) => x.event === 'nat')
    if (!e && p.stderr) throw new InfraError(`nat ${label} failed: ${p.stderr.slice(-800)}`)
    return e ? { label, ns, ms: e.t - p.spawnedAt, ...withoutMeta(e) } : { label, ns, error: 'no result' }
  }

  async stopAll() {
    this.stoppingAt = Date.now()
    await Promise.all(this.procs.filter((p) => p.name !== 'testnet').map((p) => p.stop()))
    await Promise.all(this.procs.map((p) => p.stop()))
  }
}

function withoutMeta(e) {
  const { t: _t, event: _event, ...rest } = e
  return rest
}

function applyNetem(row, spec) {
  const args = spec.split(/\s+/).filter(Boolean)
  const links = [
    ['ra', 'wan'],
    ['rb', 'wan'],
    ['c', 'eth0'],
    ['pub', 'wt-ra-w'],
    ['pub', 'wt-rb-w'],
    ['pub', 'wt-c-w'],
  ]
  // netem, not exec: exec drops back to $SUDO_USER under sudo, and tc needs root
  for (const [ns, dev] of links) row.netns('netem', ns, dev, ...args)
}

// ---- measurements -------------------------------------------------------------------------------------------

/** What member `m` saw of member `o`: link time and path, path changes, remote changes, connect errors. */
function pair(m, o) {
  const id = o.self
  if (!id) return { error: `${o.name} never came up`, linkedMs: null, errors: {}, remoteChanged: [], views: [] }
  const peer = m.first('peer', (e) => e.id === id)
  const link = m.first('link', (e) => e.id === id)
  const views = m.all('member', (e) => e.id === id)
  const relayed = views.find((e) => e.path === 'relayed') ?? (peer?.path === 'relayed' ? peer : null)
  const errors = {}
  for (const e of m.all('connect-error', (x) => x.id === id)) {
    errors[e.code] ??= { count: 0, firstMs: m.rel(e), hint: e.hint }
    errors[e.code].count++
  }
  const last = views.at(-1)
  return {
    linkedMs: m.rel(peer),
    firstPath: peer?.path ?? null,
    firstRemote: link ? `${link.host}:${link.port}` : null,
    relayedMs: m.rel(relayed),
    remoteChanged: m
      .all('remote-changed', (e) => e.id === id)
      .map((e) => ({ ms: m.rel(e), remote: `${e.host}:${e.port}`, path: e.path })),
    finalPath: last?.path ?? peer?.path ?? 'none',
    finalLinked: last?.linked ?? peer !== null,
    errors,
    views: views.map((e) => ({
      ms: m.rel(e),
      path: e.path,
      linked: e.linked,
      ...(e.lastError ? { lastError: e.lastError } : {}),
    })),
  }
}

/** Errors hyperdht constructed (scripts/s5-hyperdht-trace.mjs): code → {count, firstMs}. */
function decided(m) {
  const out = {}
  for (const e of m.all('hyperdht-error')) {
    out[e.code] ??= { count: 0, firstMs: m.rel(e) }
    out[e.code].count++
  }
  return out
}

/** A member on its own: NAT class, relay, phases, host error, the host's sticky message, hyperdht counters. */
function member(m) {
  const states = m.all('state')
  // NAT class over time, from state changes and the 5 s summaries (a host may never change state after bootstrap)
  const natSeen = m.view().map((e) => (e.event === 'state' ? e.nat : e.event === 'members' ? e.nat?.class : null))
  const classes = [...new Set(natSeen.filter((c) => c && c !== 'UNKNOWN'))]
  const phases = []
  for (const e of states) if (phases.at(-1)?.phase !== e.phase) phases.push({ ms: m.rel(e), phase: e.phase })
  const hostErrors = [...new Set(states.filter((e) => e.hostError).map((e) => `${e.hostError}: ${e.hint}`))]
  const sticky = m.first('bus', (e) => e.name === STICKY)
  const summary = m.all('members').at(-1)
  return {
    ns: m.ns,
    upMs: m.rel(m.first('up')),
    nat: classes,
    natReport: summary?.nat ?? null,
    relay: states.at(-1)?.relay ?? null,
    phases,
    hostErrors,
    sticky: sticky ? { ms: m.rel(sticky), from: sticky.from, via: sticky.via } : null,
    hyperdhtDecided: decided(m),
    relayDecisions: m.all('relay-decision').map((e) => ({
      ms: m.rel(e),
      relay: e.relay,
      force: e.force,
      randomized: e.randomized,
      natKnown: e.natKnown,
    })),
    dht: m.events.find((e) => e.event === 'stop')?.dht ?? summary?.dht ?? null,
    exit: m.exit,
  }
}

const verdict = (criterion, pass, evidence) => ({ criterion, result: pass ? 'pass' : 'fail', evidence })
const codesOf = (...pairs) => [...new Set(pairs.flatMap((p) => Object.keys(p.errors ?? {})))]

// ---- rows ---------------------------------------------------------------------------------------------------

/**
 * CONSISTENT ↔ RANDOM pair (or `modes` for others): link, path, and with a relay the upgrade to direct, or with
 * alwaysRelay that the link stays relayed.
 */
function consistentRandom(id, title, { hostSide, relay = false, alwaysRelay = false, modes = ['plain', 'random'] }) {
  const viewerSide = hostSide === 'a' ? 'b' : 'a'
  const viewerRandom = modes[viewerSide === 'a' ? 0 : 1] === 'random'
  const hostExtra = [...(relay ? ['--relay', '{relay}'] : []), ...(alwaysRelay ? ['--always-relay'] : [])]
  const viewerExtra = alwaysRelay ? ['--always-relay'] : []
  return {
    id,
    title,
    modes,
    async run(x) {
      const h = await x.host(hostSide, 'H', hostExtra)
      const v = await x.join(viewerSide, 'V', h, viewerExtra)
      const linked = () => pair(v, h).linkedMs !== null && pair(h, v).linkedMs !== null
      if (alwaysRelay) {
        // Does it stay relayed? Without the holepunch callback hyperdht upgraded it after 2-10 s (birthday punch:
        // occasionally over 15 s).
        await until(linked, 60_000)
        await sleep(30_000)
        return
      }
      if (!relay) {
        await until(linked, 60_000)
        await sleep(5000)
        return
      }
      // With a relay: wait for the upgrade to direct on both sides (a delayed random punch retries in 10-20 s).
      const direct = () => pair(v, h).remoteChanged.length > 0 && pair(h, v).remoteChanged.length > 0
      await until(() => linked() && direct(), 90_000)
      await sleep(5000)
    },
    judge(x) {
      const h = x.members.get('H')
      const v = x.members.get('V')
      const vh = pair(v, h)
      const hv = pair(h, v)
      const nat = `${hostSide}=${member(h).nat.join('/')} ${viewerSide}=${member(v).nat.join('/')}`
      const criteria = [
        verdict(
          'CONSISTENT↔RANDOM links',
          vh.linkedMs !== null && hv.linkedMs !== null,
          `viewer linked after ${vh.linkedMs} ms (host side ${hv.linkedMs} ms after its start); NAT ${nat}`,
        ),
        verdict(
          'path ends direct',
          vh.finalPath === 'direct' && hv.finalPath === 'direct',
          `viewer ${vh.firstPath}→${vh.finalPath}, host ${hv.firstPath}→${hv.finalPath}; codes ${codesOf(vh, hv).join(', ') || 'none'}`,
        ),
      ]
      const firstDial = member(v).relayDecisions[0]
      if (relay && viewerRandom) {
        // ADR 0005 §6.1: the viewer dials once bootstrap has sampled its NAT, so its RANDOM NAT asks for the relay
        criteria.push(
          verdict(
            "the viewer's first relay decision sees its RANDOM NAT and relays",
            firstDial?.natKnown === true && firstDial.randomized === true && firstDial.relay === true,
            JSON.stringify(firstDial ?? null),
          ),
        )
      }
      if (alwaysRelay) {
        criteria.splice(
          1,
          1,
          verdict(
            'starts relayed',
            vh.relayedMs !== null && hv.relayedMs !== null,
            `viewer relayed at ${vh.relayedMs} ms (first path ${vh.firstPath}), host at ${hv.relayedMs} ms (first ${hv.firstPath}); viewer's first relayThrough ${JSON.stringify(firstDial)}`,
          ),
          verdict(
            'stays relayed (alwaysRelay refuses the punch)',
            vh.finalPath === 'relayed' &&
              hv.finalPath === 'relayed' &&
              vh.remoteChanged.length === 0 &&
              hv.remoteChanged.length === 0,
            `viewer ${vh.firstPath}→${vh.finalPath}, host ${hv.firstPath}→${hv.finalPath}; remote-changed viewer ${JSON.stringify(vh.remoteChanged)}, host ${JSON.stringify(hv.remoteChanged)}; codes ${codesOf(vh, hv).join(', ') || 'none'}`,
          ),
        )
      } else if (relay) {
        criteria.push(
          verdict(
            'starts relayed',
            vh.relayedMs !== null && hv.relayedMs !== null,
            `viewer relayed at ${vh.relayedMs} ms (first path ${vh.firstPath}), host at ${hv.relayedMs} ms (first ${hv.firstPath}); viewer's first relayThrough ${JSON.stringify(firstDial)}`,
          ),
          verdict(
            'remote-changed fires (relayed → direct)',
            vh.remoteChanged.length > 0 && hv.remoteChanged.length > 0,
            `viewer ${JSON.stringify(vh.remoteChanged)}; host ${JSON.stringify(hv.remoteChanged)}`,
          ),
        )
      } else {
        criteria.push(
          verdict(
            'direct from the start (no remote-changed without a relay)',
            vh.firstPath === 'direct' && vh.remoteChanged.length === 0 && hv.remoteChanged.length === 0,
            `viewer first ${vh.firstPath} via ${vh.firstRemote}; remote-changed viewer ${vh.remoteChanged.length}, host ${hv.remoteChanged.length}`,
          ),
        )
      }
      return {
        measured: { host: { ...member(h), toViewer: hv }, viewer: { ...member(v), toHost: vh } },
        criteria,
      }
    },
  }
}

function randomRandom(id, title, { relay = false, alwaysRelay = false }) {
  return {
    id,
    title,
    modes: ['random', 'random'],
    async run(x) {
      const hostExtra = [...(relay ? ['--relay', '{relay}'] : []), ...(alwaysRelay ? ['--always-relay'] : [])]
      const h = await x.host('a', 'H', hostExtra)
      const v = await x.join('b', 'V', h, alwaysRelay ? ['--always-relay'] : [])
      if (relay) {
        await until(() => pair(v, h).linkedMs !== null && pair(h, v).linkedMs !== null, 60_000)
        await sleep(15_000) // does it stay relayed? (no upgrade is possible between two RANDOM NATs)
      } else {
        await until(() => Object.keys(pair(v, h).errors).length > 0, 40_000)
        await sleep(20_000) // retries, and the viewer's phase while it cannot reach the host
      }
    },
    judge(x) {
      const h = x.members.get('H')
      const v = x.members.get('V')
      const vh = pair(v, h)
      const hv = pair(h, v)
      const mh = member(h)
      const mv = member(v)
      const nat = `a=${mh.nat.join('/')} b=${mv.nat.join('/')}`
      const codes = codesOf(vh, hv)
      const criteria = []
      if (!relay) {
        const seen = mv.hyperdhtDecided[DOUBLE_RANDOM] ?? mh.hyperdhtDecided[DOUBLE_RANDOM]
        criteria.push(
          verdict(
            `${DOUBLE_RANDOM} reaches the app (connect-error)`,
            codes.includes(DOUBLE_RANDOM),
            `connect-error codes: ${codes.join(', ') || 'none'}; NAT ${nat}`,
          ),
          verdict(
            `hyperdht decides ${DOUBLE_RANDOM} (trace)`,
            seen !== undefined,
            `viewer ${JSON.stringify(mv.hyperdhtDecided)}; host ${JSON.stringify(mh.hyperdhtDecided)}`,
          ),
          verdict(
            'a hint is shown',
            mv.hostErrors.length > 0,
            mv.hostErrors.join(' | ') || 'no hostError in the viewer state',
          ),
          verdict(
            'no link; the viewer keeps trying',
            vh.linkedMs === null && hv.linkedMs === null,
            `viewer phases ${mv.phases.map((p) => p.phase).join('→')}; ${JSON.stringify(vh.errors)}`,
          ),
        )
      } else {
        criteria.push(
          verdict(
            'relayed',
            vh.finalPath === 'relayed' && hv.finalPath === 'relayed',
            `viewer linked ${vh.linkedMs} ms, first path ${vh.firstPath}, relayed at ${vh.relayedMs} ms; host relayed at ${hv.relayedMs} ms; remote-changed ${vh.remoteChanged.length}/${hv.remoteChanged.length}; codes ${codes.join(', ') || 'none'}`,
          ),
          verdict('relay probe ok', mv.relay === 'ok' && mh.relay === 'ok', `viewer ${mv.relay}, host ${mh.relay}`),
          verdict('host sticky reached the viewer', mv.sticky !== null, JSON.stringify(mv.sticky)),
        )
      }
      return {
        measured: { host: { ...mh, toViewer: hv }, viewer: { ...mv, toHost: vh } },
        criteria,
      }
    },
  }
}

function forwardRow(id, title, modeB, fwdExtra) {
  return {
    id,
    title,
    modes: ['random', modeB],
    setup: [['forward', 'b', String(FWD_PORT), ...fwdExtra]],
    async run(x) {
      x.natBefore = await x.nat('b', 'b', ['--port', String(FWD_PORT)])
      const h = await x.host('b', 'H', ['--port', String(FWD_PORT)])
      const v = await x.join('a', 'V', h)
      const linked = () => pair(v, h).linkedMs !== null && pair(h, v).linkedMs !== null
      await until(() => linked() || Object.keys(pair(v, h).errors).length > 0, 45_000)
      await sleep(linked() ? 5000 : 15_000)
    },
    judge(x) {
      const h = x.members.get('H')
      const v = x.members.get('V')
      const mh = member(h)
      const vh = pair(v, h)
      const cls = mh.nat.at(-1) ?? x.natBefore?.class
      return {
        measured: {
          networkTest: x.natBefore,
          host: { ...mh, toViewer: pair(h, v) },
          viewer: { ...member(v), toHost: vh },
        },
        criteria: [
          verdict(
            'the forwarded host is OPEN or CONSISTENT',
            ['OPEN', 'CONSISTENT'].includes(cls),
            `network test ${x.natBefore?.class} (${x.natBefore?.host}:${x.natBefore?.port}); room NAT ${mh.nat.join('/')} (${mh.natReport?.host}:${mh.natReport?.port})`,
          ),
          verdict(
            'a RANDOM viewer links to it',
            vh.linkedMs !== null,
            `linked ${vh.linkedMs} ms, path ${vh.finalPath}, remote ${vh.firstRemote}; codes ${Object.keys(vh.errors).join(', ') || 'none'}; viewer decided ${JSON.stringify(member(v).hyperdhtDecided)}`,
          ),
        ],
      }
    },
  }
}

/** RANDOM host, two CONSISTENT viewers behind the same router: one random punch per 20 s per node. */
function twoViewers(id, title, { relay }) {
  return {
    id,
    title,
    modes: ['plain', 'random'],
    async run(x) {
      const h = await x.host('b', 'H', relay ? ['--relay', '{relay}'] : [])
      const v1 = await x.join('a', 'V1', h)
      await sleep(1000)
      const v2 = await x.join('a', 'V2', h)
      const linked = (v) => pair(v, h).linkedMs !== null
      const direct = (v) => pair(v, h).views.at(-1)?.path === 'direct'
      await until(() => linked(v1) && linked(v2) && (!relay || (direct(v1) && direct(v2))), 100_000)
      await sleep(5000)
    },
    judge(x) {
      const h = x.members.get('H')
      const [v1, v2] = ['V1', 'V2'].map((n) => x.members.get(n))
      const p1 = pair(v1, h)
      const p2 = pair(v2, h)
      const at = (v, p) => (p.linkedMs === null ? null : p.linkedMs + (v.spawnedAt - h.spawnedAt))
      const evidence = `V1 linked ${p1.linkedMs} ms after its start (path ${p1.firstPath}→${p1.finalPath}), V2 ${p2.linkedMs} ms (${p2.firstPath}→${p2.finalPath}); V2 started ${v2.spawnedAt - v1.spawnedAt} ms after V1; host punches ${JSON.stringify(member(h).dht?.punches)}; V2 codes ${Object.keys(p2.errors).join(', ') || 'none'}`
      const criteria = [
        verdict('both viewers link to the RANDOM host', p1.linkedMs !== null && p2.linkedMs !== null, evidence),
      ]
      if (relay) {
        criteria.push(
          verdict(
            'both end direct (relayed first, then upgraded)',
            p1.finalPath === 'direct' && p2.finalPath === 'direct',
            `V1 remote-changed ${JSON.stringify(p1.remoteChanged)}; V2 ${JSON.stringify(p2.remoteChanged)}`,
          ),
        )
      }
      return {
        measured: {
          host: { ...member(h), toV1: pair(h, v1), toV2: pair(h, v2) },
          v1: { ...member(v1), toHost: p1, linkedSinceHostMs: at(v1, p1) },
          v2: { ...member(v2), toHost: p2, linkedSinceHostMs: at(v2, p2) },
        },
        criteria,
      }
    },
  }
}

const ROWS = [
  {
    id: 'nat',
    title: 'Network test: NAT class per namespace and router mode, fixed UDP port and forward, UDP blocked',
    modes: ['plain', 'random'],
    async run(x) {
      const r = (x.natResults = [])
      const tag = (res, router) => r.push({ router, ...res })
      // Every forward variant gets its own port: a forward's conntrack entries outlive `unforward` (UDP: 30-120 s)
      // and would answer the next variant's firewall probe on the same port.
      const port = (i) => String(FWD_PORT + 10 + i)
      const base = await Promise.all([x.nat('a', 'a-plain'), x.nat('b', 'b-random'), x.nat('c', 'c-open')])
      tag(base[0], 'plain')
      tag(base[1], 'random')
      tag(base[2], 'none')
      x.netns('mode', 'a', 'random')
      x.netns('mode', 'b', 'plain')
      const swapped = await Promise.all([x.nat('a', 'a-random'), x.nat('b', 'b-plain')])
      tag(swapped[0], 'random')
      tag(swapped[1], 'plain')
      x.netns('mode', 'b', 'random')
      tag(await x.nat('b', 'b-random-port', ['--port', port(1)]), `random, udpPort ${port(1)}`)
      x.netns('forward', 'b', port(2))
      tag(await x.nat('b', 'b-random-fwd', ['--port', port(2)]), `random + forward ${port(2)}`)
      x.netns('forward', 'b', port(3), 'static')
      tag(await x.nat('b', 'b-random-fwd-static', ['--port', port(3)]), `random + forward ${port(3)} + static`)
      x.netns('unforward', 'b')
      x.netns('mode', 'b', 'plain')
      tag(await x.nat('b', 'b-plain-port', ['--port', port(4)]), `plain, udpPort ${port(4)}`)
      x.netns('forward', 'b', port(5))
      tag(await x.nat('b', 'b-plain-fwd', ['--port', port(5)]), `plain + forward ${port(5)}`)
      x.netns('unforward', 'b')
      x.netns('block-udp', 'b')
      tag(await x.nat('b', 'b-udp-blocked'), 'plain, UDP blocked')
      x.netns('unblock-udp', 'b')
    },
    judge(x) {
      const r = x.natResults ?? []
      const by = (label) => r.find((e) => e.label === label) ?? {}
      const show = (label) => {
        const e = by(label)
        return `${label}: ${e.class} (${e.host}:${e.port}, ${e.ms} ms)`
      }
      return {
        measured: { results: r },
        criteria: [
          verdict(
            "'randomized' in the RANDOM namespace",
            by('b-random').class === 'RANDOM' && by('a-random').class === 'RANDOM',
            `${show('b-random')}; ${show('a-random')}`,
          ),
          verdict(
            'plain router → CONSISTENT, no NAT → OPEN',
            by('a-plain').class === 'CONSISTENT' &&
              by('b-plain').class === 'CONSISTENT' &&
              by('c-open').class === 'OPEN',
            `${show('a-plain')}; ${show('b-plain')}; ${show('c-open')}`,
          ),
          verdict(
            'a forwarded port turns RANDOM into OPEN or CONSISTENT',
            ['OPEN', 'CONSISTENT'].includes(by('b-random-fwd').class),
            `${show('b-random-port')}; ${show('b-random-fwd')}; ${show('b-random-fwd-static')}`,
          ),
          verdict(
            'a forwarded port turns CONSISTENT into OPEN',
            by('b-plain-fwd').class === 'OPEN',
            `${show('b-plain-port')}; ${show('b-plain-fwd')}`,
          ),
          verdict(
            "UDP blocked → UNKNOWN with the 'UDP blocked?' hint",
            by('b-udp-blocked').class === 'UNKNOWN' && /UDP blocked/.test(by('b-udp-blocked').hint ?? ''),
            `${show('b-udp-blocked')}: ${by('b-udp-blocked').hint}`,
          ),
        ],
      }
    },
  },
  consistentRandom('a1', 'CONSISTENT host (a) ↔ RANDOM viewer (b), no relay', { hostSide: 'a' }),
  consistentRandom('a2', 'RANDOM host (b) ↔ CONSISTENT viewer (a), no relay', { hostSide: 'b' }),
  consistentRandom('a3', 'CONSISTENT host (a) ↔ RANDOM viewer (b), relay key in the invite', {
    hostSide: 'a',
    relay: true,
  }),
  consistentRandom('a4', 'RANDOM host (b) ↔ CONSISTENT viewer (a), relay key in the invite', {
    hostSide: 'b',
    relay: true,
  }),
  consistentRandom('a5', 'CONSISTENT host (a) ↔ RANDOM viewer (b), relay + alwaysRelay on both', {
    hostSide: 'a',
    relay: true,
    alwaysRelay: true,
  }),
  consistentRandom('a6', 'CONSISTENT host (a) ↔ CONSISTENT viewer (b), relay + alwaysRelay on both', {
    hostSide: 'a',
    relay: true,
    alwaysRelay: true,
    modes: ['plain', 'plain'],
  }),
  randomRandom('b1', 'RANDOM host (a) ↔ RANDOM viewer (b), no relay', {}),
  randomRandom('b2', 'RANDOM host (a) ↔ RANDOM viewer (b), relay key in the invite', { relay: true }),
  randomRandom('b3', 'RANDOM host (a) ↔ RANDOM viewer (b), relay + alwaysRelay on both', {
    relay: true,
    alwaysRelay: true,
  }),
  {
    id: 'c1',
    title: 'OPEN host (c), RANDOM viewers a and b (no relay): a↔b cannot link, state still flows',
    modes: ['random', 'random'],
    async run(x) {
      const h = await x.host('c', 'H')
      const a = await x.join('a', 'A', h)
      const b = await x.join('b', 'B', h)
      const ready = () =>
        pair(a, b).views.some((v) => v.path === 'via-peer') &&
        pair(b, a).views.some((v) => v.path === 'via-peer') &&
        member(a).sticky !== null &&
        member(b).sticky !== null
      await until(ready, 60_000)
      await sleep(12_000) // heartbeats keep via-peer alive; more connect attempts between a and b
    },
    judge(x) {
      const [h, a, b] = ['H', 'A', 'B'].map((n) => x.members.get(n))
      const ab = pair(a, b)
      const ba = pair(b, a)
      const ma = member(a)
      const mb = member(b)
      const heardB = a.first('bus', (e) => e.from === b.self)
      const heardA = b.first('bus', (e) => e.from === a.self)
      return {
        measured: {
          host: { ...member(h), toA: pair(h, a), toB: pair(h, b) },
          a: { ...ma, toHost: pair(a, h), toB: ab },
          b: { ...mb, toHost: pair(b, h), toA: ba },
        },
        criteria: [
          verdict(
            'both viewers link to the OPEN host directly',
            pair(a, h).finalPath === 'direct' && pair(b, h).finalPath === 'direct',
            `a ${pair(a, h).linkedMs} ms, b ${pair(b, h).linkedMs} ms; NAT a=${ma.nat} b=${mb.nat} host=${member(h).nat}; host punches ${JSON.stringify(member(h).dht?.punches)}`,
          ),
          verdict(
            'a↔b cannot link',
            ab.linkedMs === null && ba.linkedMs === null,
            `codes ${codesOf(ab, ba).join(', ') || 'none'}; a decided ${JSON.stringify(ma.hyperdhtDecided)}`,
          ),
          verdict(
            'a↔b shown as via-peer',
            ab.finalPath === 'via-peer' && ba.finalPath === 'via-peer',
            `a sees b: ${ab.finalPath} (lastError ${ab.views.at(-1)?.lastError ?? '-'}); b sees a: ${ba.finalPath}`,
          ),
          verdict(
            "via-peer members receive state (host sticky, and each other's traffic through the host)",
            ma.sticky !== null && mb.sticky !== null && heardB?.via === h.self && heardA?.via === h.self,
            `a: sticky ${JSON.stringify(ma.sticky)}, B's ${heardB?.name} via ${heardB?.via}; b: sticky ${JSON.stringify(mb.sticky)}, A's ${heardA?.name} via ${heardA?.via}`,
          ),
        ],
      }
    },
  },
  {
    id: 'c2',
    title: 'RANDOM host (b), OPEN viewer (c), RANDOM viewer (a) that cannot reach the host (no relay)',
    modes: ['random', 'random'],
    async run(x) {
      const h = await x.host('b', 'H')
      const c = await x.join('c', 'C', h)
      await until(() => pair(c, h).linkedMs !== null, 30_000)
      const a = await x.join('a', 'A', h)
      await until(() => member(a).phases.some((p) => p.phase === 'in-room') && member(a).sticky !== null, 75_000)
      await sleep(10_000)
    },
    judge(x) {
      const [h, c, a] = ['H', 'C', 'A'].map((n) => x.members.get(n))
      const ma = member(a)
      const ah = pair(a, h)
      const inRoom = ma.phases.find((p) => p.phase === 'in-room')
      const admission = a.first('bus', (e) => e.name === 'room.admission')
      return {
        measured: {
          host: { ...member(h), toA: pair(h, a), toC: pair(h, c) },
          c: { ...member(c), toHost: pair(c, h), toA: pair(c, a) },
          a: { ...ma, toHost: ah, toC: pair(a, c) },
        },
        criteria: [
          verdict(
            'a cannot link to the RANDOM host',
            ah.linkedMs === null,
            `codes ${Object.keys(ah.errors).join(', ') || 'none'}; hostErrors ${ma.hostErrors.join(' | ')}`,
          ),
          verdict(
            'a is admitted through the OPEN neighbour',
            inRoom !== undefined && pair(a, c).linkedMs !== null,
            `in-room at ${inRoom?.ms} ms; admission ${admission ? `via ${admission.via}` : 'not seen'}; a↔c linked ${pair(a, c).linkedMs} ms`,
          ),
          verdict(
            'a receives the host sticky through c; host shown via-peer',
            ma.sticky?.via === c.self && ah.finalPath === 'via-peer',
            `sticky ${JSON.stringify(ma.sticky)} (c is ${c.self}); host path ${ah.finalPath}`,
          ),
        ],
      }
    },
  },
  forwardRow('d1', 'udpPort + DNAT forward on a RANDOM router (b hosts on the port), RANDOM viewer (a)', 'random', []),
  forwardRow(
    'd2',
    'udpPort + DNAT forward + static outbound port on a RANDOM router (b hosts), RANDOM viewer (a)',
    'random',
    ['static'],
  ),
  forwardRow('d3', 'udpPort + DNAT forward on a plain router (b hosts on the port), RANDOM viewer (a)', 'plain', []),
  twoViewers('m1', 'RANDOM host (b), two CONSISTENT viewers (a), no relay', { relay: false }),
  twoViewers('m2', 'RANDOM host (b), two CONSISTENT viewers (a), relay key in the invite', { relay: true }),
]

const punchRow = {
  id: 'p',
  title: 'CONSISTENT ↔ RANDOM direct-link time without a relay, repeated (hosts alternate sides)',
  modes: ['plain', 'random'],
  async run(x) {
    x.punches = []
    for (let i = 1; i <= Number(opts.repeats); i++) {
      const hostSide = i % 2 === 1 ? 'a' : 'b'
      const h = await x.host(hostSide, `H${i}`)
      const v = await x.join(hostSide === 'a' ? 'b' : 'a', `V${i}`, h)
      await until(() => pair(v, h).linkedMs !== null && pair(h, v).linkedMs !== null, 45_000)
      const vh = pair(v, h)
      await Promise.all([h.stop(), v.stop()])
      const punches = (m) => m.events.find((e) => e.event === 'stop')?.dht?.punches ?? null
      x.punches.push({
        i,
        host: hostSide === 'a' ? 'CONSISTENT' : 'RANDOM',
        linkedMs: vh.linkedMs,
        path: vh.finalPath,
        codes: Object.keys(vh.errors),
        viewerDecided: decided(v),
        hostPunches: punches(h),
        viewerPunches: punches(v),
      })
    }
  },
  judge(x) {
    const r = x.punches ?? []
    const ms = r.map((e) => e.linkedMs).filter((v) => v !== null)
    const sorted = [...ms].sort((a, b) => a - b)
    const q = (f) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))] : null)
    return {
      measured: {
        iterations: r,
        linkedMs: { n: ms.length, min: sorted[0], median: q(0.5), p90: q(0.9), max: sorted.at(-1) },
      },
      criteria: [
        verdict(
          'every CONSISTENT↔RANDOM pair links direct',
          r.length > 0 && r.every((e) => e.linkedMs !== null && e.path === 'direct'),
          `link ms ${r.map((e) => `${e.host[0]}:${e.linkedMs}`).join(', ')} (C: CONSISTENT host, R: RANDOM host); median ${q(0.5)}, max ${sorted.at(-1)}`,
        ),
      ],
    }
  },
}
ROWS.push(punchRow)

// ---- main ---------------------------------------------------------------------------------------------------

async function runRow(spec) {
  for (let attempt = 1; ; attempt++) {
    const row = new Row(spec)
    let infra = null
    try {
      await row.up()
      await spec.run(row)
    } catch (e) {
      if (!(e instanceof InfraError)) throw e
      infra = e.message
      row.log('infra-error', { message: infra })
    } finally {
      await row.stopAll()
      try {
        netns('down')
      } catch {
        // already down
      }
    }
    if (infra && attempt < 3) {
      process.stderr.write(`s5: ${spec.id}: ${infra.split('\n')[0]}; retrying in 60 s\n`)
      await sleep(60_000)
      continue
    }
    let judged
    try {
      judged = infra ? { measured: null, criteria: [] } : spec.judge(row)
    } catch (e) {
      judged = { measured: null, criteria: [], judgeError: String(e?.stack ?? e) }
    }
    const result = {
      id: spec.id,
      title: spec.title,
      modes: spec.modes,
      setup: spec.setup ?? [],
      netem,
      attempt,
      startedAt: row.startedAt,
      durationMs: Date.now() - row.startedAt,
      ...(infra ? { infraError: infra } : {}),
      ...judged,
      members: Object.fromEntries(
        [...row.members].map(([n, p]) => [n, { ns: p.ns, self: p.self, argv: p.argv.join(' ') }]),
      ),
      journal: row.journal,
    }
    writeFileSync(join(row.dir, 'row.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }
}

const wanted = opts.rows === 'all' ? ROWS.map((r) => r.id) : opts.rows.split(',')
const unknown = wanted.filter((id) => !ROWS.some((r) => r.id === id))
if (unknown.length) {
  process.stderr.write(`s5-matrix: unknown rows ${unknown.join(', ')}\n`)
  process.exit(2)
}

const before = treeHashes()
const startedAt = Date.now()
const results = []
for (const spec of ROWS.filter((r) => wanted.includes(r.id))) {
  process.stderr.write(`s5: ${spec.id}: ${spec.title}\n`)
  const res = await runRow(spec)
  results.push(res)
  for (const c of res.criteria ?? []) process.stderr.write(`    ${c.result.padEnd(4)}  ${c.criterion}: ${c.evidence}\n`)
  if (res.infraError) process.stderr.write(`    infra error: ${res.infraError}\n`)
  if (res.judgeError) process.stderr.write(`    judge error: ${res.judgeError}\n`)
}
const after = treeHashes()
const changed = Object.keys({ ...before, ...after }).filter((f) => before[f] !== after[f])
const summary = {
  label: opts.label,
  startedAt,
  durationMs: Date.now() - startedAt,
  netem,
  pub: opts.pub,
  testnetSize: Number(opts.size),
  node: process.version,
  tree: { before, ...(changed.length ? { changedDuringRun: changed, after } : {}) },
  rows: results.map((r) => ({
    id: r.id,
    title: r.title,
    criteria: r.criteria,
    ...(r.infraError ? { infraError: r.infraError } : {}),
    ...(r.judgeError ? { judgeError: r.judgeError } : {}),
  })),
}
writeFileSync(join(runDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
process.stderr.write(`s5: done in ${Math.round((Date.now() - startedAt) / 1000)} s; ${join(runDir, 'summary.json')}\n`)
