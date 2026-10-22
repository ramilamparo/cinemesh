import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { randomBytes, toHex } from './crypto.js'
import { RoomStore, keyPairFromSeed, newHostRecord, roomIdFor, viewerRecord } from './identity.js'

const dir = mkdtempSync(join(tmpdir(), 'wt-identity-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('identity', () => {
  it('derives the same key pair from the same seed', () => {
    const seed = toHex(randomBytes(32))
    expect(keyPairFromSeed(seed).publicKey.equals(keyPairFromSeed(seed).publicKey)).toBe(true)
  })

  it('makes host records whose host key matches the seed', () => {
    const rec = newHostRecord({ name: 'Movie' })
    expect(toHex(keyPairFromSeed(rec.keySeed).publicKey)).toBe(rec.hostKey)
    expect(rec.id).toBe(roomIdFor(Buffer.from(rec.hostKey, 'hex')))
  })

  it('keeps a viewer identity across invites for the same room', () => {
    const invite = { roomSecret: randomBytes(32), hostKey: randomBytes(32), relayKey: null, name: 'R' }
    const first = viewerRecord(invite, null)
    const again = viewerRecord({ ...invite, roomSecret: randomBytes(32) }, first)
    expect(again.keySeed).toBe(first.keySeed)
    expect(again.id).toBe(first.id)
    expect(again.inviteEpoch).toBe(0)
  })

  it('stores records privately and lists the most recent first', async () => {
    const store = new RoomStore(dir)
    const older = { ...newHostRecord({ name: 'old' }), lastJoined: 1000 }
    const newer = { ...newHostRecord({ name: 'new' }), lastJoined: 2000 }
    await store.save(older)
    await store.save(newer)
    const file = join(dir, 'wt', 'rooms', newer.id, 'room.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await store.load(newer.id)).toEqual(newer)
    expect((await store.list()).map((r) => r.name)).toEqual(['new', 'old'])
    await store.remove(older.id)
    expect(await store.load(older.id)).toBeNull()
    expect(await store.load('../../etc')).toBeNull()
  })
})
