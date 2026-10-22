// The run's network, built inside a rootless session (user + mount + net + pid namespaces, run.sh): one bridge in
// the session's own namespace (the testnet listens there) and one namespace per member behind a veth. Each member's
// uplink is the netem qdisc on its side of the veth: the host's has the rate under test and a deep buffer
// (bufferbloat), the viewers' only a delay. Downlinks are unshaped, so each direction's delay is the sender's.
//
//   session ns: br0 192.88.99.1/24  (testnet)
//     ├── h   eth0 192.88.99.10   netem delay H rate R limit L
//     ├── v1  eth0 192.88.99.11   netem delay V
//     └── ...
// 192.88.99.0/24 is neither a hyperdht bogon nor private (ADR 0005 §2.3), so hyperdht dials the members directly.
import { execFileSync } from 'node:child_process'

export const PREFIX = '192.88.99'
export const BRIDGE_IP = `${PREFIX}.1`

export interface TopoConfig {
  viewers: number
  /** netem rate on the host's uplink, e.g. '20mbit'; null = unshaped */
  hostRate: string | null
  hostDelayMs: number
  viewerDelayMs: number
  /** per viewer, overriding viewerDelayMs (mixed RTTs); missing entries take viewerDelayMs */
  viewerDelaysMs?: number[]
  /** the host's netem queue holds this much of its rate (plus the delay line), in ms */
  bufferMs: number
}

export interface Member {
  ns: string
  ip: string
}

/** average packet size used to size the netem queue (UDX data packets are ~1.2-1.4 kB; acks are small) */
const PACKET_BYTES = 1200

function sh(...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function rateBps(rate: string): number {
  const m = /^(\d+(?:\.\d+)?)(k|m|g)?bit$/i.exec(rate)
  if (!m) throw new Error(`rate must look like 20mbit, not ${rate}`)
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'g'] ?? 1
  return (Number(m[1]) * mult) / 8
}

/** netem limit (packets) for `bufferMs` of queue at `rate`, plus the packets in the delay line */
export function netemLimit(rate: string, bufferMs: number, delayMs: number): number {
  return Math.ceil((((bufferMs + delayMs) / 1000) * rateBps(rate)) / PACKET_BYTES)
}

export function topoUp(cfg: TopoConfig): { host: Member; viewers: Member[]; qdisc: Record<string, string> } {
  if (process.getuid?.() !== 0) throw new Error('topo: needs (fake) root; run inside run.sh')
  sh('ip', 'link', 'set', 'lo', 'up')
  sh('ip', 'link', 'add', 'br0', 'type', 'bridge')
  sh('ip', 'addr', 'add', `${BRIDGE_IP}/24`, 'dev', 'br0')
  sh('ip', 'link', 'set', 'br0', 'up')
  const make = (ns: string, k: number): Member => {
    const ip = `${PREFIX}.${String(10 + k)}`
    sh('ip', 'netns', 'add', ns)
    sh('ip', 'link', 'add', `${ns}-br`, 'type', 'veth', 'peer', 'name', 'eth0', 'netns', ns)
    sh('ip', 'link', 'set', `${ns}-br`, 'master', 'br0')
    sh('ip', 'link', 'set', `${ns}-br`, 'up')
    sh('ip', 'netns', 'exec', ns, 'ip', 'addr', 'add', `${ip}/24`, 'dev', 'eth0')
    sh('ip', 'netns', 'exec', ns, 'ip', 'link', 'set', 'eth0', 'up')
    sh('ip', 'netns', 'exec', ns, 'ip', 'link', 'set', 'lo', 'up')
    return { ns, ip }
  }
  const host = make('h', 0)
  const viewers = Array.from({ length: cfg.viewers }, (_, k) => make(`v${String(k + 1)}`, k + 1))
  const hostArgs = ['delay', `${String(cfg.hostDelayMs)}ms`]
  if (cfg.hostRate) {
    hostArgs.push('rate', cfg.hostRate, 'limit', String(netemLimit(cfg.hostRate, cfg.bufferMs, cfg.hostDelayMs)))
  } else hostArgs.push('limit', '100000')
  sh('ip', 'netns', 'exec', 'h', 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', ...hostArgs)
  for (const [k, v] of viewers.entries()) {
    const args = ['delay', `${String(cfg.viewerDelaysMs?.[k] ?? cfg.viewerDelayMs)}ms`, 'limit', '100000']
    sh('ip', 'netns', 'exec', v.ns, 'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem', ...args)
  }
  const qdisc: Record<string, string> = {}
  for (const m of [host, ...viewers])
    qdisc[m.ns] = sh('ip', 'netns', 'exec', m.ns, 'tc', 'qdisc', 'show', 'dev', 'eth0').trim()
  return { host, viewers, qdisc }
}

/** netem's own counters on the host uplink: sent bytes/packets, drops, overlimits, backlog */
export function hostQdiscStats(): string {
  return sh('ip', 'netns', 'exec', 'h', 'tc', '-s', 'qdisc', 'show', 'dev', 'eth0').trim()
}
