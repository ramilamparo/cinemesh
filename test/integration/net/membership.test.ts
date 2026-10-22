import Hyperswarm from 'hyperswarm'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bans } from '../../../src/core/net/bans.js'
import { randomBytes, toHex } from '../../../src/core/net/crypto.js'
import { NET_ERRORS } from '../../../src/core/net/errors.js'
import { keyPairFromSeed, newHostRecord, viewerRecord } from '../../../src/core/net/identity.js'
import { decodeInvite, encodeInvite, inviteText } from '../../../src/core/net/invite.js'
import type { Membership } from '../../../src/core/net/membership.js'
import type { PeerLink } from '../../../src/core/net/peer.js'
import { Room } from '../../../src/core/net/room.js'
import { Harness, memberIds, waitFor } from './helpers.js'

let h: Harness | null = null
const swarms: Hyperswarm[] = []
afterEach(async () => {
  await Promise.all(swarms.splice(0).map((s) => s.destroy()))
  await h?.cleanup()
  h = null
})

/** A bare swarm under `seed`'s key that takes connections and never says a word on them. */
function silentPeer(harness: Harness, seed: string): Hyperswarm {
  const swarm = new Hyperswarm({ keyPair: keyPairFromSeed(seed), bootstrap: harness.bootstrap.split(',') })
  swarm.on('connection', (conn: { on(e: 'error', f: () => void): void }) => conn.on('error', () => undefined))
  swarms.push(swarm)
  return swarm
}

const bansOf = (room: Room): Bans => (room as unknown as { bans: Bans }).bans
const linksOf = (room: Room): Map<string, PeerLink> => (room as unknown as { links: Map<string, PeerLink> }).links
const swarmOf = (room: Room): Hyperswarm => (room as unknown as { swarm: Hyperswarm }).swarm
/** a quick give-up on a silent remote, so these tests do not wait out the 10 s auth timeout */
const QUICK = { testing: { timing: { authOpenTimeoutMs: 1000 } } }

async function roomWith(n: number): Promise<{ host: Room; viewers: Room[]; harness: Harness }> {
  const harness = await Harness.start()
  h = harness
  const host = await harness.host('Host')
  const viewers: Room[] = []
  for (let i = 1; i <= n; i++) viewers.push(await harness.viewer(host.invite().code, `V${String(i)}`))
  await waitFor(() => viewers.every((v) => v.state().phase === 'in-room'), 20_000, 'admitted')
  await waitFor(() => [host, ...viewers].every((r) => r.peers().length === n), 20_000, 'mesh')
  return { host, viewers, harness }
}

describe('membership', () => {
  it('a wrong secret fails auth within 10 s and gets banned', async () => {
    h = await Harness.start()
    const host = await h.host('Host')
    const real = decodeInvite(host.invite().code)
    const wrong = encodeInvite({ ...real, roomSecret: randomBytes(32) })
    const failures: string[] = []
    host.on('auth-failed', (f) => failures.push(f.code))
    const intruder = await h.viewer(wrong, 'Eve')
    const ms = await waitFor(() => intruder.state().phase === 'error', 10_000, 'intruder sees auth failure')
    expect(ms).toBeLessThan(10_000)
    expect(intruder.state().error?.code).toBe(NET_ERRORS.authFailed)
    await waitFor(() => failures.length > 0, 5000, 'host sees auth failure')
    expect(failures[0]).toBe(NET_ERRORS.authFailed)
    expect(host.members()).toHaveLength(1)
    // the host now firewalls the key: the intruder never reaches it again
    const bans = (host as unknown as { bans: { has(k: string): boolean } }).bans
    expect(bans.has(intruder.self)).toBe(true)
  })

  it('a peer that connects and never authenticates times out without a ban, and its key can join later', async () => {
    h = await Harness.start()
    const host = await h.host('Host', QUICK)
    const seed = toHex(randomBytes(32))
    const key = toHex(keyPairFromSeed(seed).publicKey)
    const failures: string[] = []
    host.on('auth-failed', (f) => failures.push(f.code))
    // e.g. our own half-open dial from before a restart: it proves nothing about the key
    silentPeer(h, seed).joinPeer(Buffer.from(host.self, 'hex'))
    await waitFor(() => failures.length > 0, 10_000, 'host gives up on the silent peer')
    expect(failures[0]).toBe(NET_ERRORS.authTimeout)
    expect(bansOf(host).has(key)).toBe(false)
    // Hyperswarm's own ban (permanent per PeerInfo) is not set either
    expect((swarmOf(host).peers.get(key) as { banned?: boolean } | undefined)?.banned ?? false).toBe(false)
    await Promise.all(swarms.splice(0).map((s) => s.destroy()))

    // the same key as a real viewer gets in
    const record = { ...viewerRecord(decodeInvite(host.invite().code), null), keySeed: seed }
    const viewer = h.track(await Room.resume(record, h.options('Sam')))
    expect(viewer.self).toBe(key)
    await waitFor(() => viewer.state().phase === 'in-room', 20_000, 'the same key is admitted')
    expect(memberIds(host)).toContain(key)
  })

  it('a joiner whose host does not answer keeps joining (no error, no ban) and gets in once it does', async () => {
    h = await Harness.start()
    const hostRecord = newHostRecord({ name: 'Late host' })
    const invite = inviteText({
      roomSecret: Buffer.from(hostRecord.secret, 'hex'),
      hostKey: Buffer.from(hostRecord.hostKey, 'hex'),
      relayKey: null,
      name: hostRecord.name,
    })
    // reachable under the host key, but never speaks: a half-open dial looks the same from the joiner's end
    await (silentPeer(h, hostRecord.keySeed) as unknown as { listen(): Promise<void> }).listen()
    const viewer = await h.viewer(invite.code, 'Sam', QUICK)
    const failures: string[] = []
    viewer.on('auth-failed', (f) => failures.push(f.code))
    await waitFor(() => failures.length > 0, 10_000, 'joiner gives up on the silent host')
    expect(failures[0]).toBe(NET_ERRORS.authTimeout)
    // 'error' would end the join in the session ("The invite is out of date or wrong")
    expect(viewer.state().phase).toBe('joining')
    expect(viewer.state().error).toBeUndefined()
    expect(bansOf(viewer).has(hostRecord.hostKey)).toBe(false)
    await Promise.all(swarms.splice(0).map((s) => s.destroy()))

    const host = h.track(await Room.resume(hostRecord, h.options('Host')))
    await waitFor(() => viewer.state().phase === 'in-room', 20_000, 'admitted once the host is up')
    expect(memberIds(host)).toContain(viewer.self)
  })

  it('kick reaches every viewer and the kicked peer cannot reconnect', async () => {
    const { host, viewers, harness } = await roomWith(3)
    const [victim, ...others] = viewers as [Room, Room, Room]
    host.kick(victim.self)
    await waitFor(() => victim.state().phase === 'kicked', 10_000, 'victim told')
    await waitFor(
      () => others.every((v) => !memberIds(v).includes(victim.self) && !v.peer(victim.self)),
      10_000,
      'everyone dropped the victim',
    )
    expect(memberIds(host)).not.toContain(victim.self)

    // same identity, fresh process: still refused everywhere
    const again = harness.track(await Room.resume(victim.roomRecord, harness.options('V1')))
    await new Promise((r) => setTimeout(r, 4000))
    expect(again.state().phase).not.toBe('in-room')
    expect(again.peers()).toHaveLength(0)
    expect(memberIds(host)).not.toContain(victim.self)
  })

  it('a member whose last join request the host has forgotten is still told it was kicked', async () => {
    h = await Harness.start()
    // the host keeps a key's attempt for 2.5 x rejoinMs after its last request: 2.5 s here
    const host = await h.host('Host', { testing: { timing: { rejoinMs: 1000 } } })
    const sam = await h.viewer(host.invite().code, 'Sam')
    await waitFor(() => sam.state().phase === 'in-room', 20_000, 'Sam in')
    const book = (host as unknown as { membership: Membership }).membership
    await waitFor(() => book.nonceOf(sam.self) === undefined, 10_000, 'the host forgot Sam asked')
    // so the kick carries no nonce: the usual case, a member asks only when its host link comes up
    host.kick(sam.self)
    await waitFor(() => sam.state().phase === 'kicked', 10_000, 'Sam told')
  })

  it('a member that restarted and is kicked before its new request reached the host is told it was kicked', async () => {
    h = await Harness.start()
    // the host keeps a key's last attempt for 2.5 x rejoinMs: the kick names Sam's attempt from before the restart
    const host = await h.host('Host', { testing: { timing: { rejoinMs: 30_000 } } })
    const m = await h.viewer(host.invite().code, 'M')
    const record = viewerRecord(decodeInvite(host.invite().code), null)
    const sam = h.track(await Room.resume(record, h.options('Sam')))
    await waitFor(() => [m, sam].every((r) => r.state().phase === 'in-room'), 20_000, 'in')
    await waitFor(() => [host, m, sam].every((r) => r.peers().length === 2), 20_000, 'mesh')
    const book = (host as unknown as { membership: Membership }).membership
    const oldNonce = book.nonceOf(sam.self)
    expect(oldNonce).toBeDefined()
    await sam.close()
    await waitFor(() => !linksOf(host).has(sam.self) && !linksOf(m).has(sam.self), 20_000, 'old links gone')
    // Sam comes back with a new attempt; its host link is blocked, so its request has not reached the host
    const hostKey = Buffer.from(host.self, 'hex')
    const back = h.track(
      await Room.resume(
        record,
        h.options('Sam', { testing: { firewall: (pk) => pk.equals(hostKey), timing: { admitWaitMs: 60_000 } } }),
      ),
    )
    await waitFor(() => linksOf(m).get(back.self)?.ready === true, 20_000, 'M linked to Sam again')
    expect(book.nonceOf(back.self)).toBe(oldNonce)
    // the kick reaches Sam through M, carrying the old attempt's nonce
    host.kick(back.self)
    await waitFor(() => back.state().phase === 'kicked', 10_000, 'Sam told')
  })

  it('rotate moves everyone to the new topic and the old invite no longer joins', async () => {
    const { host, viewers, harness } = await roomWith(2)
    const oldInvite = host.invite().code
    const oldTopic = host.currentTopic
    const fresh = host.rotateInvite()
    expect(fresh.code).not.toBe(oldInvite)
    await waitFor(() => viewers.every((v) => v.currentTopic.equals(host.currentTopic)), 10_000, 'viewers moved')
    expect(host.currentTopic.equals(oldTopic)).toBe(false)
    expect(viewers.every((v) => v.peers().length === 2)).toBe(true) // links stayed up

    const late = await harness.viewer(oldInvite, 'Late')
    await new Promise((r) => setTimeout(r, 4000))
    expect(late.state().phase).not.toBe('in-room')
    expect(memberIds(host)).not.toContain(late.self)

    const welcome = await harness.viewer(fresh.code, 'New')
    await waitFor(() => welcome.state().phase === 'in-room', 15_000, 'new invite works')
  })

  it('viewers reconnect within 30 s after the host restarts with the same key', async () => {
    const { host, viewers, harness } = await roomWith(2)
    const record = host.roomRecord
    await host.close()
    await waitFor(() => viewers.every((v) => !v.peers().some((p) => p.isHost)), 10_000, 'host gone')
    await waitFor(() => viewers.every((v) => !v.state().hostPresent), 10_000, 'host away detected')

    const restarted = harness.track(await Room.resume(record, harness.options('Host')))
    expect(restarted.self).toBe(host.self)
    const ms = await waitFor(
      () => viewers.every((v) => v.state().hostPresent && v.peers().some((p) => p.isHost)),
      30_000,
      'viewers back with the host',
    )
    expect(ms).toBeLessThan(30_000)
    expect(viewers.every((v) => v.state().phase === 'in-room')).toBe(true)
  })

  it('a member that comes back under a new name gets in again, and everyone sees the new name', async () => {
    // one viewer: the host's own copy of the members list is the only one it can be handed
    const { host, viewers, harness } = await roomWith(1)
    const [sam] = viewers as [Room]
    const record = sam.roomRecord
    await sam.close()
    // same key, new display name (renamed in Settings, then rejoined or restarted)
    const back = harness.track(await Room.resume(record, harness.options('Samuel')))
    await waitFor(() => back.state().phase === 'in-room', 20_000, 'back in under the new name')
    const nameIn = (r: Room): string | undefined => r.members().find((m) => m.id === back.self)?.name
    await waitFor(() => [host, back].every((r) => nameIn(r) === 'Samuel'), 10_000, 'the new name everywhere')
  })

  it('a member that cannot reach the host comes back under a new name through a neighbour', async () => {
    const { host, harness } = await roomWith(1)
    const hostKey = Buffer.from(host.self, 'hex')
    const firewall = (pk: Buffer): boolean => pk.equals(hostKey)
    const record = viewerRecord(decodeInvite(host.invite().code), null)
    const sam = harness.track(await Room.resume(record, harness.options('Sam', { testing: { firewall } })))
    await waitFor(() => sam.state().phase === 'in-room', 20_000, 'in through V1')
    await sam.close()
    // its request, under the new name, reaches the host only inside V1's room.join-via
    const back = harness.track(await Room.resume(record, harness.options('Samuel', { testing: { firewall } })))
    await waitFor(() => back.state().phase === 'in-room', 20_000, 'back in under the new name')
    const nameIn = (r: Room): string | undefined => r.members().find((m) => m.id === back.self)?.name
    await waitFor(() => [host, back].every((r) => nameIn(r) === 'Samuel'), 10_000, 'the new name everywhere')
  })

  it('a joiner without a host link that comes back while still pending learns it is pending', async () => {
    const { host, harness } = await roomWith(1)
    host.setAdmission('approve')
    const hostKey = Buffer.from(host.self, 'hex')
    const far = harness.options('J', { testing: { firewall: (pk) => pk.equals(hostKey) } })
    const record = viewerRecord(decodeInvite(host.invite().code), null)
    const j1 = harness.track(await Room.resume(record, far))
    await waitFor(() => j1.state().phase === 'pending', 20_000, 'J told it waits')
    expect(host.state().pending).toEqual([{ id: j1.self, name: 'J', via: 'V1' }])
    // Cancel and join again (or an app restart) well within the request's expiry: the host has no link to J that
    // could tell it J went away, so J's request still waits there, unchanged
    await j1.close()
    const j2 = harness.track(await Room.resume(record, far))
    // before: the host answered a request it already had on its own link to J only, and it has none
    await waitFor(() => j2.state().phase === 'pending', 10_000, 'J told again')
    expect(host.state().pending).toEqual([{ id: j2.self, name: 'J', via: 'V1' }])
    host.admit(j2.self, true)
    await waitFor(() => j2.state().phase === 'in-room', 10_000, 'J in through V1')
  })

  it('a joiner whose only neighbour cannot reach the host either gets in, its request relayed two members on', async () => {
    const { host, viewers, harness } = await roomWith(1)
    const [v1] = viewers as [Room]
    const hostKey = Buffer.from(host.self, 'hex')
    const v1Key = Buffer.from(v1.self, 'hex')
    // host - V1 - Far - J: Far links to V1 only, J to Far only
    const far = await harness.viewer(host.invite().code, 'Far', { testing: { firewall: (pk) => pk.equals(hostKey) } })
    await waitFor(() => far.state().phase === 'in-room', 20_000, 'Far in through V1')
    host.setAdmission('approve')
    const j = await harness.viewer(host.invite().code, 'J', {
      testing: { firewall: (pk) => pk.equals(hostKey) || pk.equals(v1Key) },
    })
    // Far's room.join-via reaches the host through V1, which checks Far's relaying rate on the way
    await waitFor(() => host.state().pending.some((p) => p.id === j.self && p.via === 'Far'), 20_000, 'J via Far')
    await waitFor(() => j.state().phase === 'pending', 10_000, 'J told it waits')
    // its re-sends are answered too: the host has no link to Far to send the answer back on, so it goes to all
    let answers = 0
    j.onMessage('room.admission', () => answers++)
    await waitFor(() => answers > 0, 10_000, 'a re-send answered')
    host.admit(j.self, true)
    await waitFor(() => j.state().phase === 'in-room', 20_000, 'J in through Far')
    expect(j.peers().map((p) => p.name)).toEqual(['Far'])
  })

  it('a viewer that cannot reach the host is admitted through a neighbour and gets sticky state', async () => {
    const { host, harness } = await roomWith(2)
    host.defineMessage('session.announce', { hostOnly: true, sticky: true })
    host.publish('session.announce', { infoHash: 'abc', rev: 1 })
    const hostKey = Buffer.from(host.self, 'hex')
    const blocked = await harness.viewer(host.invite().code, 'Far', {
      testing: { firewall: (pk) => pk.equals(hostKey) },
    })
    await waitFor(() => blocked.state().phase === 'in-room', 20_000, 'admitted via neighbour')
    await waitFor(() => blocked.latest('session.announce') !== null, 10_000, 'sticky replayed')
    expect(blocked.latest('session.announce')?.body).toEqual({ infoHash: 'abc', rev: 1 })
    expect(blocked.peers().some((p) => p.isHost)).toBe(false)
    const hostView = blocked.members().find((m) => m.isHost)
    await waitFor(() => blocked.members().find((m) => m.isHost)?.path === 'via-peer', 10_000, 'host is via-peer')
    expect(hostView?.linked).toBe(false)
    expect(blocked.state().hostPresent).toBe(true)
    expect(memberIds(host)).toContain(blocked.self)

    // and the bus reaches it in both directions
    const got: unknown[] = []
    blocked.onMessage('chat', (m) => got.push(m.body))
    host.publish('chat.say', 'hello far one')
    await waitFor(() => got.length === 1, 5000, 'host → far viewer')
    const atHost: unknown[] = []
    host.onMessage('chat', (m) => {
      if (m.from === blocked.self) atHost.push(m.body)
    })
    blocked.publish('chat.say', 'hi host')
    await waitFor(() => atHost.length === 1, 5000, 'far viewer → host')
  })

  it('a host listener that throws while a direct joiner is admitted is logged, and the joiner still gets in', async () => {
    h = await Harness.start()
    const warnings: string[] = []
    const host = await h.host('Host', {
      log: { debug: () => undefined, info: () => undefined, warn: (m) => warnings.push(m) },
    })
    // The admission runs from the joiner's own request on the auth lane: a throw there must not become an
    // uncaught exception, nor reach Protomux.
    let thrown = false
    host.on('members', (list) => {
      if (thrown || !list.some((m) => !m.self)) return
      thrown = true
      throw new Error('a members listener failed')
    })
    const v = await h.viewer(host.invite().code, 'Ann')
    await waitFor(() => v.state().phase === 'in-room' && host.peer(v.self) !== null, 20_000, 'admitted')
    expect(thrown).toBe(true)
    expect(
      warnings.some((w) => w.includes('join request handler failed') && w.includes('a members listener failed')),
    ).toBe(true)
  })

  it('approve mode keeps joiners pending until the host admits them', async () => {
    h = await Harness.start()
    const host = await h.host('Host', { admission: 'approve' })
    const v = await h.viewer(host.invite().code, 'Ann')
    await waitFor(() => v.state().phase === 'pending', 10_000, 'pending')
    await waitFor(() => host.state().pending.length === 1, 5000, 'host sees request')
    expect(host.state().pending[0]?.name).toBe('Ann')
    host.admit(v.self, true)
    await waitFor(() => v.state().phase === 'in-room', 10_000, 'admitted')
    expect(host.state().pending).toEqual([])

    // a joiner that gives up while pending (Cancel) leaves the host's queue
    const quitter = await h.viewer(host.invite().code, 'Bob')
    await waitFor(() => host.state().pending.length === 1, 10_000, 'second request')
    await quitter.leave()
    await waitFor(() => host.state().pending.length === 0, 5000, 'request withdrawn')
  })

  it('a viewer leaving says goodbye and frees its seat; the host can end the room', async () => {
    const { host, viewers } = await roomWith(2)
    const [a, b] = viewers as [Room, Room]
    const byes: string[] = []
    host.on('bye', (x) => byes.push(x.peerId))
    await a.leave()
    await waitFor(() => byes.includes(a.self) && !memberIds(host).includes(a.self), 5000, 'seat freed')
    await host.leave({ end: true })
    await waitFor(() => b.state().phase === 'ended', 5000, 'room ended')
  })
})
