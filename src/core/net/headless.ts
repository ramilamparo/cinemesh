// A headless room member for manual network tests (S5, scripts/netns-nat.sh, scripts/s5-matrix.mjs). Not part
// of the app bundle. Prints JSON lines {t, event, ...}:
//   invite, up, state (phase, NAT class, relay), peer / peer-gone (admitted links and their path),
//   member (a member's path, link or last connect error changed: what the UI's peer list would show),
//   link / remote-changed (the UDX remote of a link, and hyperdht moving it, e.g. a relayed link going direct),
//   connect-error (hyperdht code + hint), bus (messages from others; room.hb once per origin and route),
//   relay-decision (each relayThrough evaluation: Hyperswarm's dials and server handshakes, with what the DHT
//   knew of its NAT at that moment), members every 5 s (with hyperdht's punch and relay counters).
//
//   node --import tsx src/core/net/headless.ts host [--name A] [--room NAME] [--cap 8] [--approve] [--sticky] [opts]
//   node --import tsx src/core/net/headless.ts join INVITE [--name B] [opts]
//   node --import tsx src/core/net/headless.ts nat [--port P]
//   opts: --relay KEY  --always-relay  --port UDP_PORT   (WT_BOOTSTRAP selects the DHT, e.g. a testnet)
//   --sticky: the host publishes a sticky host-only message (session.announce {s5}) once it is up, so viewers
//             can show it reached them, and through whom.
import { parseArgs } from 'node:util'
import Hyperswarm from 'hyperswarm'
import { hintFor, networkTest } from './diagnostics.js'
import { type MemberView, type NetLog, type RoomPeer, Room, type RoomOptions } from './room.js'
import { resolveBootstrap } from './swarm.js'

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    room: { type: 'string', default: 'Headless room' },
    cap: { type: 'string', default: '8' },
    approve: { type: 'boolean', default: false },
    sticky: { type: 'boolean', default: false },
    relay: { type: 'string' },
    'always-relay': { type: 'boolean', default: false },
    port: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
})

function out(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ t: Date.now(), event, ...fields })}\n`)
}

const short = (id: string): string => id.slice(0, 8)

const log: NetLog = {
  debug: (msg) => (args.verbose ? out('log', { level: 'debug', msg }) : undefined),
  info: (msg) => out('log', { level: 'info', msg }),
  warn: (msg) => out('log', { level: 'warn', msg }),
}

// Test-only: every relayThrough evaluation (Hyperswarm calls it for each dial and each server handshake). Patched
// on the prototype before the room's swarm exists, because the first dial happens inside the Room constructor.
interface SwarmInternals {
  dht: { randomized: boolean; host: string | null; bootstrapped: boolean }
  _maybeRelayConnection: (this: SwarmInternals, force?: boolean) => Buffer | null
}
const swarmProto = Hyperswarm.prototype as unknown as SwarmInternals
const decideRelay = swarmProto._maybeRelayConnection
swarmProto._maybeRelayConnection = function (this: SwarmInternals, force?: boolean): Buffer | null {
  const key = decideRelay.call(this, force)
  const { randomized, host, bootstrapped } = this.dht
  out('relay-decision', {
    force: force === true,
    relay: key !== null,
    randomized,
    natKnown: host !== null,
    bootstrapped,
  })
  return key
}

const [command, invite] = positionals
const udpPort = args.port !== undefined ? Number(args.port) : null

if (command === 'nat') {
  const bootstrap = resolveBootstrap(process.env.WT_BOOTSTRAP, [])
  out('nat', { ...(await networkTest({ bootstrap, port: udpPort })) })
  process.exit(0)
}

if (command !== 'host' && !(command === 'join' && invite)) {
  process.stderr.write('usage: headless.ts host [--name A] | join INVITE [--name B] | nat  (see the file header)\n')
  process.exit(2)
}

const options: RoomOptions = {
  displayName: args.name ?? (command === 'host' ? 'Host' : 'Viewer'),
  settings: {
    udpPort,
    bootstrapExtra: [],
    relayKey: args.relay ?? null,
    alwaysRelay: args['always-relay'],
  },
  store: null,
  admission: args.approve ? 'approve' : 'open',
  maxMembers: Number(args.cap),
  log,
}

const room =
  command === 'host' ? await Room.create({ ...options, name: args.room }) : await Room.join(invite ?? '', options)

room.on('state', (s) =>
  out('state', {
    phase: s.phase,
    hostPresent: s.hostPresent,
    nat: s.nat.class,
    relay: s.relay.status,
    ...(s.denyReason ? { denyReason: s.denyReason } : {}),
    ...(s.error ? { error: s.error.code } : {}),
    ...(s.hostError ? { hostError: s.hostError.code, hint: s.hostError.hint } : {}),
  }),
)
room.on('peer', (p) => {
  out('peer', { id: short(p.id), name: p.name, isHost: p.isHost, path: p.path })
  watchRemote(p)
})
room.on('peer-gone', (id) => out('peer-gone', { id: short(id) }))
room.on('connect-error', (e) => out('connect-error', { id: short(e.peerId), code: e.code, hint: hintFor(e.code) }))
room.on('auth-failed', (e) => out('auth-failed', { id: short(e.peerId), code: e.code }))
room.on('rekey', (e) => out('rekey', e))

// One line per change of a member's path, link or last connect error, as the peer list would show it. Checked on
// every 'members' event and once a second, like the session's 1 Hz peers event: via-peer depends on when the
// member's traffic last arrived, which emits no event of its own.
const memberViews = new Map<string, string>()
function diffMembers(list: readonly MemberView[]): void {
  for (const m of list) {
    if (m.self) continue
    const view = {
      path: m.path,
      linked: m.linked,
      ...(m.lastError ? { lastError: m.lastError.code, hint: m.lastError.hint } : {}),
    }
    const key = JSON.stringify(view)
    if (memberViews.get(m.id) === key) continue
    memberViews.set(m.id, key)
    out('member', { id: short(m.id), name: m.name, isHost: m.isHost, ...view })
  }
}
room.on('members', diffMembers)
const memberPoll = setInterval(() => diffMembers(room.members()), 1000)

// The link's UDX stream (Protomux → NoiseSecretStream → rawStream): its remote, and 'remote-changed', which
// hyperdht fires when it moves a connected stream to a new remote (a relayed link upgraded to direct).
interface RawStream {
  remoteHost: string | null
  remotePort: number
  on(event: 'remote-changed', cb: () => void): unknown
}
const watched = new WeakSet<RawStream>()
function watchRemote(p: RoomPeer): void {
  const stream = p.mux.stream as { rawStream?: RawStream | null } | null
  const raw = stream?.rawStream
  if (!raw || watched.has(raw)) return
  watched.add(raw)
  out('link', { id: short(p.id), host: raw.remoteHost, port: raw.remotePort, path: p.path })
  raw.on('remote-changed', () =>
    out('remote-changed', { id: short(p.id), host: raw.remoteHost, port: raw.remotePort, path: p.path }),
  )
}

// Bus traffic from others: what reached us, from whom and through which link (`via` = the forwarding link).
const hbRoutes = new Set<string>()
for (const ns of ['room', 'session']) {
  room.onMessage(ns, (msg) => {
    if (msg.via === null) return
    if (msg.name === 'room.hb') {
      const route = `${msg.from}>${msg.via}`
      if (hbRoutes.has(route)) return
      hbRoutes.add(route)
    }
    const body = msg.body as { members?: { name?: unknown }[] } | null
    out('bus', {
      name: msg.name,
      from: short(msg.from),
      via: short(msg.via),
      ...(msg.rev !== null ? { rev: msg.rev } : {}),
      ...(msg.ns === 'session' ? { body: msg.body } : {}),
      ...(msg.name === 'room.members' && Array.isArray(body?.members)
        ? { members: body.members.map((m) => m.name) }
        : {}),
    })
  })
}

await room.ready()
if (command === 'host') out('invite', { code: room.invite().code })
out('up', { self: short(room.self), role: room.role })
if (command === 'host' && args.sticky) room.publish('session.announce', { s5: 'sticky', at: Date.now() })

// hyperdht's own counters (test-only peek at the room's private swarm): punches by kind, relaying attempts.
interface DhtStats {
  punches?: Record<string, number>
  relaying?: Record<string, number>
}
function dhtStats(): DhtStats {
  const swarm = (room as unknown as { swarm?: { dht?: { stats?: DhtStats } } }).swarm
  const stats = swarm?.dht?.stats
  return {
    ...(stats?.punches ? { punches: stats.punches } : {}),
    ...(stats?.relaying ? { relaying: stats.relaying } : {}),
  }
}

const summary = setInterval(() => {
  const s = room.state()
  out('members', {
    nat: s.nat,
    relay: s.relay.status,
    dht: dhtStats(),
    members: room.members().map((m) => ({
      id: short(m.id),
      name: m.name,
      self: m.self,
      path: m.path,
      rttMs: m.rttMs,
      ...(m.lastError ? { lastError: m.lastError.code } : {}),
    })),
  })
}, 5000)

async function stop(): Promise<void> {
  clearInterval(summary)
  clearInterval(memberPoll)
  out('stop', { dht: dhtStats() })
  await room.leave()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
