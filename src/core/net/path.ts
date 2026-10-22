import { isIPv4 } from 'node:net'
import type { PeerPath } from '../../shared/ipc/core.js'

// Per-link path (plan §4.1): the relay's address → relayed; a private or loopback address → lan; else direct.

export interface Address {
  host: string
  port: number
}

export function classifyPath(remote: { host: string | null; port: number } | null, relay: Address | null): PeerPath {
  if (!remote?.host) return 'none'
  const host = unmap(remote.host)
  if (relay && unmap(relay.host) === host && relay.port === remote.port) return 'relayed'
  return isPrivateAddress(host) ? 'lan' : 'direct'
}

export function isPrivateAddress(host: string): boolean {
  const h = unmap(host).toLowerCase()
  if (isIPv4(h)) {
    const [a = 0, b = 0] = h.split('.').map(Number)
    return (
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
    )
  }
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:')
}

function unmap(host: string): string {
  return host.startsWith('::ffff:') ? host.slice(7) : host
}
