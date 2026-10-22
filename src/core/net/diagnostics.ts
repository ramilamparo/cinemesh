import HyperDHT, { type DhtSocket } from 'hyperdht'
import type { NatClass, NatReport } from '../../shared/ipc/core.js'
import { NET_ERRORS } from './errors.js'
import type { Address } from './path.js'

// NAT class, the Network test, error hints and the relay probe (plan §4.1 Diagnostics).

export const NETWORK_TEST_TIMEOUT_MS = 15_000
export const RELAY_PROBE_TIMEOUT_MS = 10_000

export interface NatState {
  host: string | null
  port: number
  firewalled: boolean
}

/** !firewalled → OPEN; port 0 (a new port per destination) → RANDOM; otherwise CONSISTENT. */
export function natClass(dht: NatState): NatClass {
  if (dht.host === null) return 'UNKNOWN'
  if (!dht.firewalled) return 'OPEN'
  if (dht.port === 0) return 'RANDOM'
  return 'CONSISTENT'
}

/**
 * `udpPort`: the port the DHT was asked for; `bound`: the one it bound. dht-rpc takes the next free port, then any,
 * when the one asked for is busy (another program, or a room holding it while the Network test runs), and a hint
 * about the forward would blame the router for a port nobody listens on.
 */
export function natReport(
  dht: NatState,
  bootstrapped: boolean,
  udpPort: number | null = null,
  bound: number | null = null,
): NatReport {
  const cls = bootstrapped ? natClass(dht) : 'UNKNOWN'
  return {
    class: cls,
    host: dht.host,
    port: dht.host === null ? null : dht.port,
    bootstrapped,
    hint: bootstrapped ? natHint(cls, udpPort, bound) : (hintFor('NO_BOOTSTRAP') ?? null),
  }
}

function natHint(cls: NatClass, udpPort: number | null, bound: number | null): string | null {
  // S5 (ADR 0005 Finding 8): a forwarded port does not change RANDOM (hyperdht never tests it while its other
  // traffic leaves from random ports), so only a relay helps there; with CONSISTENT the forward shows as OPEN
  // once it works.
  if (cls === 'RANDOM') {
    return 'Your router gives each connection a new port, so friends whose routers do the same cannot reach you directly. Add a relay.'
  }
  if (cls === 'CONSISTENT' && udpPort) {
    if (bound !== udpPort) {
      return `UDP ${String(udpPort)} was already in use, so another port was used and the port forward does not apply. Close what uses it, or choose another port.`
    }
    return `UDP ${String(udpPort)} does not answer from the internet yet. Check the port forward on your router.`
  }
  if (cls === 'UNKNOWN') return 'Your network type is not known yet.'
  return null
}

/** The UDP port the DHT node's server socket is bound to, or null before it is bound. */
export function boundPort(dht: Pick<HyperDHT, 'io'>): number | null {
  try {
    const socket = dht.io.serverSocket as HyperDHT['io']['serverSocket'] | null
    return socket?.address().port ?? null
  } catch {
    return null
  }
}

const HINTS: Record<string, string> = {
  // hyperdht 6.34.1 reports a double-randomized pair as HOLEPUNCH_ABORTED (ADR 0005 Finding 3); kept for later versions
  HOLEPUNCH_DOUBLE_RANDOMIZED_NATS: 'Both of you have strict NATs, so you cannot connect directly: add a relay.',
  HOLEPUNCH_ABORTED:
    'A direct connection could not be made yet; it is retried. If both of you have strict NATs, only a relay helps.',
  HOLEPUNCH_PROBE_TIMEOUT:
    'The other side did not answer the connection attempt. A relay or a forwarded UDP port helps.',
  HOLEPUNCH_INVALID: 'The connection attempt was garbled; it is retried automatically.',
  CANNOT_HOLEPUNCH: 'A direct connection is not possible on this network: add a relay.',
  REMOTE_NOT_HOLEPUNCHABLE: 'The other side cannot accept direct connections: add a relay.',
  PEER_NOT_FOUND: 'The host is not online right now.',
  PEER_CONNECTION_FAILED: 'Could not connect; it is retried automatically.',
  CONNECTION_TIMEOUT: 'The connection timed out; it is retried automatically.',
  RELAY_ABORTED: 'The relay did not connect you. Check that it is running.',
  SERVER_ERROR: 'The other side refused the connection.',
  // no bootstrap ends the Network test early (after ~6 s in S5), not only at its 15 s timeout
  NO_BOOTSTRAP: 'No answer from the network. Is UDP blocked by a firewall?',
  [NET_ERRORS.authFailed]: 'The invite is out of date or wrong. Ask the host for a new one.',
  [NET_ERRORS.authTimeout]: 'The other side did not finish connecting in time.',
  [NET_ERRORS.relayUnreachable]: 'The relay is unreachable. Check its key and that it is running.',
  [NET_ERRORS.kicked]: 'The host removed you from the room.',
  [NET_ERRORS.denied]: 'The host did not let you in.',
}

export function hintFor(code: string | null | undefined): string | null {
  return code ? (HINTS[code] ?? null) : null
}

export interface NetworkTestOptions {
  bootstrap?: (string | Address)[] | undefined
  port?: number | null
  timeoutMs?: number
}

/**
 * The Settings "Network test": a temporary DHT node, so it works outside a room too. No bootstrap within
 * the timeout reports UNKNOWN with the "UDP blocked?" hint.
 */
export async function networkTest(opts: NetworkTestOptions = {}): Promise<NatReport> {
  const dht = new HyperDHT({
    ...(opts.bootstrap ? { bootstrap: opts.bootstrap } : {}),
    ...(opts.port ? { port: opts.port } : {}),
  })
  try {
    const done = await withTimeout(
      dht.fullyBootstrapped().then(() => true),
      opts.timeoutMs ?? NETWORK_TEST_TIMEOUT_MS,
      false,
    )
    const bootstrapped = done && dht.toArray().length > 0
    return natReport(dht, bootstrapped, opts.port ?? null, boundPort(dht))
  } finally {
    await dht.destroy().catch(() => undefined)
  }
}

export type RelayProbe = { ok: true; address: Address; rttMs: number } | { ok: false; code: string }

/**
 * Opens (and closes) a connection to the relay's key. On success also returns the relay's address, which
 * is how a relayed link is told apart from a direct one.
 */
export async function probeRelay(
  dht: Pick<HyperDHT, 'connect'>,
  relayKey: Buffer,
  timeoutMs = RELAY_PROBE_TIMEOUT_MS,
): Promise<RelayProbe> {
  const started = performance.now()
  const socket: DhtSocket = dht.connect(relayKey)
  socket.on('error', () => undefined)
  try {
    const opened = await withTimeout(socket.opened, timeoutMs, false)
    const raw = socket.rawStream
    if (!opened || !raw?.remoteHost) return { ok: false, code: NET_ERRORS.relayUnreachable }
    return {
      ok: true,
      address: { host: raw.remoteHost, port: raw.remotePort },
      rttMs: Math.round(performance.now() - started),
    }
  } finally {
    socket.destroy()
  }
}

/** `promise`, or `fallback` after `ms`; the timer never outlives the race. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}
