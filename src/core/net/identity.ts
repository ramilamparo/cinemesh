import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import HyperDHT, { type KeyPair } from 'hyperdht'
import { z } from 'zod'
import { blake2b, randomBytes, toHex } from './crypto.js'
import type { Invite } from './invite.js'

// Per-room identity and state, persisted in <userData>/wt/rooms/<id>/room.json with mode 0600 (plan §4.1, §6).
// Each room has its own keySeed, so the DHT key (and with it bans and membership) is stable across restarts
// but cannot be linked between rooms.

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/)

const MemberRecordSchema = z.object({
  key: Hex32,
  name: z.string().max(64),
  role: z.enum(['host', 'viewer']),
})
export type MemberRecord = z.infer<typeof MemberRecordSchema>

export const RoomRecordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{16}$/),
  secret: Hex32,
  hostKey: Hex32,
  relayKey: Hex32.optional(),
  name: z.string().max(64),
  keySeed: Hex32,
  role: z.enum(['host', 'viewer']),
  inviteEpoch: z.number().int().min(0),
  lastJoined: z.number(),
  /** the secret before the last rotation: members that missed the rekey still authenticate with it */
  previousSecret: Hex32.optional(),
  /** host only: who was admitted and who was kicked, so a restarted host keeps both */
  members: z.array(MemberRecordSchema).max(64).optional(),
  banned: z.array(Hex32).max(256).optional(),
})
export type RoomRecord = z.infer<typeof RoomRecordSchema>

/** Stable 16-hex id derived from the host key: the same on every member's machine, and across rotations. */
export function roomIdFor(hostKey: Uint8Array): string {
  return toHex(blake2b(hostKey, 16).subarray(0, 8))
}

export function keyPairFromSeed(keySeedHex: string): KeyPair {
  return HyperDHT.keyPair(Buffer.from(keySeedHex, 'hex'))
}

export function newHostRecord(opts: { name: string; relayKey?: string | null; now?: number }): RoomRecord {
  const keySeed = toHex(randomBytes(32))
  const hostKey = toHex(keyPairFromSeed(keySeed).publicKey)
  return {
    id: roomIdFor(Buffer.from(hostKey, 'hex')),
    secret: toHex(randomBytes(32)),
    hostKey,
    ...(opts.relayKey ? { relayKey: opts.relayKey } : {}),
    name: opts.name,
    keySeed,
    role: 'host',
    inviteEpoch: 0,
    lastJoined: opts.now ?? Date.now(),
  }
}

/** A viewer's record for an invite; keeps the keySeed (identity) of an earlier record for the same room. */
export function viewerRecord(invite: Invite, existing: RoomRecord | null, now = Date.now()): RoomRecord {
  const hostKey = toHex(invite.hostKey)
  const secret = toHex(invite.roomSecret)
  const keepEpoch = existing !== null && existing.secret === secret
  return {
    id: roomIdFor(invite.hostKey),
    secret,
    hostKey,
    ...(invite.relayKey ? { relayKey: toHex(invite.relayKey) } : {}),
    name: invite.name || existing?.name || 'Watch Together',
    keySeed: existing?.keySeed ?? toHex(randomBytes(32)),
    role: existing?.role === 'host' ? 'host' : 'viewer',
    inviteEpoch: keepEpoch ? existing.inviteEpoch : 0,
    lastJoined: now,
  }
}

/** Reads and writes room records. Writes are atomic (temp file + rename) and private (0600 in a 0700 dir). */
export class RoomStore {
  readonly dir: string

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'wt', 'rooms')
  }

  async save(record: RoomRecord): Promise<void> {
    const parsed = RoomRecordSchema.parse(record)
    const dir = join(this.dir, parsed.id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'room.json')
    const tmp = `${file}.${String(process.pid)}.tmp`
    await writeFile(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
    await chmod(tmp, 0o600) // the umask may have widened it
    await rename(tmp, file)
  }

  async load(id: string): Promise<RoomRecord | null> {
    if (!/^[0-9a-f]{16}$/.test(id)) return null
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.dir, id, 'room.json'), 'utf8'))
      const parsed = RoomRecordSchema.safeParse(raw)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  /** Recent rooms, most recently joined first. Unreadable records are skipped. */
  async list(): Promise<RoomRecord[]> {
    let ids: string[]
    try {
      ids = await readdir(this.dir)
    } catch {
      return []
    }
    const records = await Promise.all(ids.map((id) => this.load(id)))
    return records.filter((r): r is RoomRecord => r !== null).sort((a, b) => b.lastJoined - a.lastJoined)
  }

  async remove(id: string): Promise<void> {
    if (!/^[0-9a-f]{16}$/.test(id)) return
    await rm(join(this.dir, id), { recursive: true, force: true })
  }
}
