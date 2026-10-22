// Bans with expiry (plan §4.1). Hyperswarm's own ban is permanent per PeerInfo and is set whenever our
// firewall rejects a key, so lifting a ban here must also call peerInfo.ban(false); `onExpire` is where
// the room does that. `has()` is synchronous because Hyperswarm's firewall callback is.

export type BanReason = 'auth' | 'kick' | 'manual'

interface BanEntry {
  until: number
  reason: BanReason
}

export interface BansOptions {
  now?: () => number
  /** called with the hex key whenever a ban ends (expiry or unban) */
  onExpire?: (keyHex: string) => void
}

export class Bans {
  private readonly entries = new Map<string, BanEntry>()
  private readonly now: () => number
  private readonly onExpire: (keyHex: string) => void
  private timer: NodeJS.Timeout | null = null

  constructor(opts: BansOptions = {}) {
    this.now = opts.now ?? Date.now
    this.onExpire = opts.onExpire ?? noop
  }

  /** `ms` = Infinity bans for the rest of the session. A longer ban is never shortened. */
  ban(key: Uint8Array | string, ms: number, reason: BanReason): void {
    const hex = toKeyHex(key)
    const until = this.now() + ms
    const existing = this.entries.get(hex)
    if (existing && existing.until >= until) return
    this.entries.set(hex, { until, reason })
    this.schedule()
  }

  has(key: Uint8Array | string): boolean {
    const hex = toKeyHex(key)
    const entry = this.entries.get(hex)
    if (!entry) return false
    if (entry.until > this.now()) return true
    this.lift(hex)
    return false
  }

  reason(key: Uint8Array | string): BanReason | null {
    return this.has(key) ? (this.entries.get(toKeyHex(key))?.reason ?? null) : null
  }

  unban(key: Uint8Array | string): void {
    const hex = toKeyHex(key)
    if (this.entries.has(hex)) this.lift(hex)
    this.schedule()
  }

  /** Keys banned for the rest of the session (kicks), for the members message. */
  permanent(): string[] {
    return [...this.entries].filter(([, e]) => e.until === Infinity).map(([k]) => k)
  }

  /** Drops expired entries now; the timer does the same on its own. */
  sweep(): void {
    const now = this.now()
    for (const [hex, entry] of this.entries) if (entry.until <= now) this.lift(hex)
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.entries.clear()
  }

  private lift(hex: string): void {
    this.entries.delete(hex)
    this.onExpire(hex)
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    let next = Infinity
    for (const e of this.entries.values()) next = Math.min(next, e.until)
    if (next === Infinity) return
    // setTimeout overflows above 2^31-1 ms; re-arm in steps instead
    const delay = Math.min(Math.max(0, next - this.now()), 2 ** 31 - 1)
    this.timer = setTimeout(() => {
      this.sweep()
      this.schedule()
    }, delay)
    this.timer.unref()
  }
}

function toKeyHex(key: Uint8Array | string): string {
  return typeof key === 'string' ? key : Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString('hex')
}

function noop(): void {}
