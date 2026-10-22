// Emulates "no direct path between members" inside the spike's own user+net namespace: UDP is allowed
// only to or from the testnet's DHT nodes and the relay, so members can reach each other only via the relay.
import { execFileSync } from 'node:child_process'

export function blockMemberToMember(allowedPorts: number[]): void {
  const set = `{ ${[...new Set(allowedPorts)].join(', ')} }`
  const script = [
    'add table inet s2',
    'add chain inet s2 out { type filter hook output priority 0; policy accept; }',
    `add rule inet s2 out udp sport ${set} accept`,
    `add rule inet s2 out udp dport ${set} accept`,
    'add rule inet s2 out meta l4proto udp counter drop',
  ].join('\n')
  execFileSync('nft', ['-f', '-'], { input: script })
}

export function droppedPackets(): number {
  try {
    const out = execFileSync('nft', ['list', 'chain', 'inet', 's2', 'out']).toString()
    const m = /counter packets (\d+)/.exec(out)
    return m ? Number(m[1]) : 0
  } catch {
    return -1
  }
}
