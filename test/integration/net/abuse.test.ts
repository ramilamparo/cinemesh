import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Bus, type Envelope, parseEnvelope } from '../../../src/core/net/bus.js'
import { randomBytes, toHex } from '../../../src/core/net/crypto.js'
import { type RoomRecord, RoomStore, keyPairFromSeed, viewerRecord } from '../../../src/core/net/identity.js'
import { decodeInvite } from '../../../src/core/net/invite.js'
import { PeerLink } from '../../../src/core/net/peer.js'
import { Room, type RoomTiming } from '../../../src/core/net/room.js'
import { Harness, waitFor } from './helpers.js'

// What a holder of the invite, admitted or not, can make the room do. The auth lane takes frames from anyone
// who has the invite, and members forward what they accept to everyone. Nothing here may cost a member a link,
// slip a message past admission, or turn one frame into a room-wide flood (or a room.json write).

interface Inside {
  bus: Bus
  links: Map<string, PeerLink>
  keyPair: { publicKey: Buffer; secretKey: Buffer }
  /** the room's join attempt: what its requests carry besides the name */
  attempt: { nonce: string; at: number }
  /** gives the host's envelope for a joiner to it on the auth lane (the bus calls it through the instance) */
  handOver: (env: Envelope) => void
}
const inside = (room: Room): Inside => room as unknown as Inside

let h: Harness | null = null
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await h?.cleanup()
  h = null
})
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

async function room(names: string[], extra: Parameters<Harness['host']>[1] = {}): Promise<[Room, ...Room[]]> {
  const harness = (h = await Harness.start())
  const host = await harness.host('Host', extra)
  const viewers: Room[] = []
  for (const name of names) viewers.push(await harness.viewer(host.invite().code, name))
  await waitFor(() => viewers.every((v) => v.state().phase === 'in-room'), 20_000, 'admitted')
  await waitFor(() => [host, ...viewers].every((r) => r.peers().length === names.length), 20_000, 'mesh')
  return [host, ...viewers]
}

/** A joiner left waiting in approve mode, once every room in `linkedTo` holds a ready (not admitted) link to it. */
async function pendingJoiner(host: Room, linkedTo: Room[], opts: Parameters<Harness['viewer']>[2] = {}): Promise<Room> {
  if (!h) throw new Error('no harness')
  host.setAdmission('approve')
  const j = await h.viewer(host.invite().code, 'J', opts)
  await waitFor(() => host.state().pending.some((p) => p.id === j.self), 20_000, 'J pending')
  await waitFor(() => linkedTo.every((r) => inside(r).links.get(j.self)?.ready === true), 20_000, 'links to J')
  return j
}

/** Join requests signed by keys nobody holds a link for: what a forger would slip past the host. */
function ghostRequest(hostKey: string, to?: string): Envelope {
  const bus = new Bus({ keyPair: keyPairFromSeed(toHex(randomBytes(32))), hostKey })
  const body = { name: 'Ghost', nonce: toHex(randomBytes(16)), at: Date.now() }
  return bus.seal('room.join-req', body, to !== undefined ? { to } : {})
}

/** A join request of `room`'s own attempt, as it sends them (a later one each call). */
function joinRequest(room: Room, name = 'J'): Envelope {
  return inside(room).bus.seal('room.join-req', { name, ...inside(room).attempt })
}

/** A joiner's record for the host's room, to start it (again) under one key: `Room.join` makes a new key each time without a store. */
function joinerRecord(host: Room): ReturnType<typeof viewerRecord> {
  return viewerRecord(decodeInvite(host.invite().code), null)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Counts the bus envelopes sent over any ctrl lane in this process, by name (`ns.t`), from now on. */
function countSent(): (name: string) => number {
  const spy = vi.spyOn(PeerLink.prototype, 'sendCtrl')
  return (name) =>
    spy.mock.calls.filter(([frame]) => {
      const m = frame.m as Partial<Envelope> | undefined
      return frame.ns === 'bus' && `${String(m?.ns)}.${String(m?.t)}` === name
    }).length
}

describe('what an invite holder cannot make the room do', () => {
  it('a message too big for the auth lane, addressed to a joiner, costs nobody a link', async () => {
    const [host, x, m] = (await room(['X', 'M'])) as [Room, Room, Room]
    // J waits for approval: the host, X and M hold ready links to it without a ctrl lane
    const j = await pendingJoiner(host, [host, x, m])
    const who = new Map([
      [host.self, 'host'],
      [x.self, 'X'],
      [m.self, 'M'],
    ])
    const lost: string[] = []
    for (const r of [host, x, m])
      r.on('peer-gone', (id) => lost.push(`${String(who.get(r.self))} lost ${String(who.get(id))}`))

    // M's 20 KB message for J, sent to X only: X and then the host hold a link to J it could be handed on
    const big = inside(m).bus.seal('chat.big', 'x'.repeat(20_000), { to: j.self })
    expect(inside(m).links.get(x.self)?.sendCtrl({ ns: 'bus', t: 'msg', m: big })).toBe(true)
    // the host's own 20 KB message for J reaches X and M, which hold links to J
    host.publish('chat.big', 'y'.repeat(20_000), { to: j.self })
    await sleep(1500)
    // a throw from the auth lane's 16 KiB limit, inside the ctrl message callback, made Protomux destroy the
    // link the message came in on: the host lost X, X lost M and the host
    expect(lost).toEqual([])
    for (const r of [host, x, m]) expect(r.peers()).toHaveLength(2)
  })

  it("only the host's messages travel the auth lane, both ways", async () => {
    const [host, x, m] = (await room(['X', 'M'])) as [Room, Room, Room]
    const j = await pendingJoiner(host, [host, x, m])

    // M addresses J, who is not in yet: nobody may hand that to J on the auth lane
    const spy = vi.spyOn(PeerLink.prototype, 'sendAuth')
    m.publish('chat.dm', 'psst', { to: j.self })
    await sleep(1000)
    const handedOver = spy.mock.calls.flatMap(([frame]) => (frame.t === 'env' ? [(frame.env as Envelope).o] : []))
    spy.mockRestore()
    expect(handedOver.filter((o) => o !== host.self)).toEqual([])

    // J tries to slip in join requests for keys it made up, as hand-overs, unaddressed and addressed to the host
    const toHost = inside(j).links.get(host.self)
    const ghosts = [ghostRequest(host.self), ghostRequest(host.self), ghostRequest(host.self, host.self)]
    for (const env of ghosts) expect(toHost?.sendAuth({ t: 'env', env })).toBe(true)
    await sleep(1000)
    expect(host.state().pending.map((p) => p.id)).toEqual([j.self])
    expect(host.members()).toHaveLength(3)
  })

  it('an invite holder flooding join requests costs the room a few messages, not some per frame', async () => {
    const [host, x, y] = (await room(['X', 'Y'])) as [Room, Room, Room]
    // J cannot reach the host: its requests travel through X and Y, as a via-peer joiner's do
    const hostKey = Buffer.from(host.self, 'hex')
    const j = await pendingJoiner(host, [x, y], { testing: { firewall: (pk) => pk.equals(hostKey) } })
    let states = 0
    host.on('state', () => states++)
    const sent = countSent()

    let answers = 0
    j.onMessage('room.admission', () => answers++)

    const toX = inside(j).links.get(x.self)
    // padding a request costs J nothing
    const padder = new Bus({ keyPair: inside(j).keyPair, hostKey: host.self })
    for (let i = 0; i < 500; i++) {
      toX?.sendAuth({ t: 'join', env: joinRequest(j) })
      const padded = padder.seal('room.join-req', { name: 'J', ...inside(j).attempt, pad: 'p'.repeat(8000) })
      toX?.sendAuth({ t: 'join', env: padded })
    }
    await sleep(2000)
    console.log(
      `1000 join frames to X: ${String(sent('room.join-req'))} forwarded, ${String(sent('room.join-via'))} relayed, ` +
        `${String(sent('room.admission'))} answers sent, ${String(states)} host state events; J got ${String(answers)}`,
    )
    // measured on the code before round 4: 1516 copies forwarded, 1649 answer copies, 500 host state events.
    // Join requests no longer travel the ctrl lanes: X relays them, at J's rate (3, then one a second here).
    expect(sent('room.join-req')).toBe(0)
    expect(sent('room.join-via')).toBeLessThanOrEqual(10)
    // J was waiting already, under the same name: nothing changed, so no event, and the answer to each relayed
    // request goes back to the member that relayed it, not to everyone (and J hears it)
    expect(sent('room.admission')).toBeLessThanOrEqual(sent('room.join-via'))
    expect(answers).toBeGreaterThan(0)
    expect(states).toBe(0)

    // and the real request still stands, shown as relayed: admitted, J gets in through its neighbours
    expect(host.state().pending.map((p) => [p.id, p.name])).toEqual([[j.self, 'J']])
    expect(['X', 'Y']).toContain(host.state().pending[0]?.via)
    host.admit(j.self, true)
    await waitFor(() => j.state().phase === 'in-room', 20_000, 'J admitted through X and Y')
  })

  it('a member that keeps renaming itself costs a members broadcast and a room.json write or two', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-net-rename-'))
    dirs.push(dir)
    const store = new RoomStore(dir)
    let saves = 0
    const save = store.save.bind(store)
    store.save = async (record) => {
      saves++
      await save(record)
    }
    const [host, mal, x] = (await room(['Mal', 'X'], { store })) as [Room, Room, Room]
    await sleep(500)
    let broadcasts = 0
    x.onMessage('room.members', () => broadcasts++)
    const before = saves

    // a member's request travels its own link to the host, as its sendJoin sends it
    const toHost = inside(mal).links.get(host.self)
    for (let i = 0; i < 300; i++) toHost?.sendAuth({ t: 'join', env: joinRequest(mal, i % 2 ? 'Mallory' : 'Mal') })
    await sleep(1500)
    console.log(`300 renames: ${String(saves - before)} room.json writes, ${String(broadcasts)} members broadcasts`)
    // measured on the code before the limits: 299 of each
    expect(saves - before).toBeLessThanOrEqual(2)
    expect(broadcasts).toBeLessThanOrEqual(2)
    // once its rename window has passed, the newest name it asked for is the one everyone has
    const nameOf = (r: Room): string | undefined => r.members().find((v) => v.id === mal.self)?.name
    await waitFor(() => [x, mal].every((r) => nameOf(r) === nameOf(host)), 10_000, 'one name everywhere')
    expect(['Mal', 'Mallory']).toContain(nameOf(host))
  })

  it('room.json writes queue at most one behind the one running, and the last one has it all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-net-persist-'))
    dirs.push(dir)
    const store = new RoomStore(dir)
    const saved: RoomRecord[] = []
    const save = store.save.bind(store)
    store.save = async (record) => {
      saved.push(structuredClone(record))
      await sleep(100) // a slow disk
      await save(record)
    }
    const [host] = await room([], { store })
    await sleep(300)
    const before = saved.length
    const keys = Array.from({ length: 20 }, () => toHex(randomBytes(32)))
    for (const key of keys) host.kick(key) // each publishes the members list and its bans
    await host.close() // waits for the save queued last
    expect(saved.length - before).toBeLessThanOrEqual(2)
    expect(saved.at(-1)?.banned).toEqual(expect.arrayContaining(keys))
    expect((await store.load(host.id))?.banned).toEqual(expect.arrayContaining(keys))
  })

  it('the host says it is alive every hostHeartbeatMs, other members every heartbeatMs', async () => {
    const timing: Partial<RoomTiming> = { tickMs: 100, heartbeatMs: 2000, hostHeartbeatMs: 400 }
    const harness = (h = await Harness.start())
    const host = await harness.host('Host', { testing: { timing } })
    const a = await harness.viewer(host.invite().code, 'A', { testing: { timing } })
    const b = await harness.viewer(host.invite().code, 'B', { testing: { timing } })
    await waitFor(() => [host, a, b].every((r) => r.peers().length === 2), 20_000, 'mesh')
    const fromHost: number[] = []
    const fromB: number[] = []
    a.onMessage('room.hb', (msg) => {
      if (msg.from === host.self) fromHost.push(Date.now())
      else if (msg.from === b.self) fromB.push(Date.now())
    })
    await sleep(4000)
    const gaps = fromHost.slice(1).map((t, i) => t - (fromHost[i] ?? t))
    console.log(
      `in 4 s: ${String(fromHost.length)} host heartbeats (gaps ${gaps.join(', ')} ms), ${String(fromB.length)} from B`,
    )
    expect(fromHost.length).toBeGreaterThanOrEqual(8)
    expect(Math.max(...gaps)).toBeLessThan(700)
    expect(fromB.length).toBeGreaterThanOrEqual(1)
    expect(fromB.length).toBeLessThanOrEqual(3)
  })
})

describe('what a member cannot make the host do with join requests', () => {
  it('a member making up join requests gets its relaying rate through, each shown as relayed by it', async () => {
    const [host, m] = (await room(['M'])) as [Room, Room]
    host.setAdmission('approve')
    const toHost = inside(m).links.get(host.self)
    // round 4's way: requests signed by keys it made up, on its own ctrl lane, as if forwarding them
    for (let i = 0; i < 20; i++) toHost?.sendCtrl({ ns: 'bus', t: 'msg', m: ghostRequest(host.self) })
    await sleep(500)
    expect(host.state().pending).toEqual([])
    // the way a member relays a joiner's request, as fast as it can
    for (let i = 0; i < 40; i++)
      inside(m).bus.publish('room.join-via', { req: ghostRequest(host.self) }, { to: host.self })
    await sleep(1000)
    const pending = host.state().pending
    console.log(`40 made-up requests relayed: ${String(pending.length)} pending, via ${String(pending[0]?.via)}`)
    // before: every one of them was a pending entry; now its burst (6), and a refill (one per 500 ms here) at most
    expect(pending.length).toBeGreaterThan(0)
    expect(pending.length).toBeLessThanOrEqual(8)
    expect(pending.every((p) => p.via === 'M')).toBe(true)
    // the host kicks the member that vouched for them, and they go with it
    host.kick(m.self)
    expect(host.state().pending).toEqual([])
  })

  it('in open mode its made-up requests take seats at its relaying rate at most, and the host log names it', async () => {
    const lines: string[] = []
    const log = { debug: () => undefined, info: (line: string) => lines.push(line), warn: () => undefined }
    const [host, m] = (await room(['M'], { log })) as [Room, Room]
    // room for 10 more: the rate, not the cap, is what stops them
    host.setMaxMembers(12)
    for (let i = 0; i < 40; i++)
      inside(m).bus.publish('room.join-via', { req: ghostRequest(host.self) }, { to: host.self })
    await sleep(1000)
    const ghosts = host.members().filter((v) => v.name === 'Ghost')
    console.log(`40 made-up requests relayed in open mode: ${String(ghosts.length)} admitted`)
    expect(ghosts.length).toBeGreaterThan(0)
    expect(ghosts.length).toBeLessThanOrEqual(8)
    // nothing else shows who vouched for them: no pending list in open mode
    const relayed = `(relayed by ${m.self.slice(0, 8)})`
    for (const g of ghosts) expect(lines.some((l) => l.includes(`admitted ${g.id.slice(0, 8)} ${relayed}`))).toBe(true)
  })
})

describe('answers belong to the attempt they answer', () => {
  it('a denial a member replays to a joiner that came back is ignored, and its join still completes', async () => {
    const [host, m] = (await room(['M'])) as [Room, Room]
    if (!h) throw new Error('no harness')
    host.setAdmission('approve')
    const record = joinerRecord(host)
    const j1 = h.track(await Room.resume(record, h.options('J')))
    await waitFor(() => j1.state().phase === 'pending', 20_000, 'J waits')
    // M sees the host's answers to J go by
    const seen = vi.spyOn(inside(m).bus, 'receive')
    host.admit(j1.self, false)
    await waitFor(() => j1.state().phase === 'denied', 10_000, 'J told no')
    const denied = seen.mock.calls
      .map(([raw]) => parseEnvelope(raw))
      .find((e) => e?.t === 'admission' && e.to === j1.self && (e.body as { state?: unknown }).state === 'denied')
    if (!denied) throw new Error('M saw no denial')
    await j1.close()

    // J asks again (or its app restarted): a new attempt, whose bus has seen nothing yet
    const j2 = h.track(await Room.resume(record, h.options('J')))
    await waitFor(() => j2.state().phase === 'pending', 20_000, 'J waits again')
    await waitFor(() => inside(m).links.get(j2.self)?.ready === true, 20_000, 'M linked to J')
    expect(
      inside(m)
        .links.get(j2.self)
        ?.sendAuth({ t: 'env', env: { ...denied, ttl: 0 } }),
    ).toBe(true)
    await sleep(1000)
    // before: host-signed, addressed to J and new to its bus, so J took it and ended as denied
    expect(j2.state().phase).toBe('pending')
    host.admit(j2.self, true)
    await waitFor(() => j2.state().phase === 'in-room', 10_000, 'J in')
  })

  it('a pending answer its relayer held back and hands over after the denial does not have the joiner ask again', async () => {
    const [host, m] = (await room(['M'])) as [Room, Room]
    if (!h) throw new Error('no harness')
    host.setAdmission('approve')
    const hostKey = Buffer.from(host.self, 'hex')
    const j = await h.viewer(host.invite().code, 'J', { testing: { firewall: (pk) => pk.equals(hostKey) } })
    await waitFor(() => j.state().phase === 'pending', 20_000, 'J told it waits, through M')
    // From now on M keeps the host's answers to J's re-sends (they come back to M only) instead of handing them on
    const held: Envelope[] = []
    const handOver = inside(m).handOver.bind(m)
    inside(m).handOver = (env) => {
      if (env.to === j.self && (env.body as { state?: unknown }).state === 'pending') held.push(env)
      else handOver(env)
    }
    await waitFor(() => held.length > 0, 10_000, 'M holds an answer to a re-send')
    host.admit(j.self, false)
    await waitFor(() => j.state().phase === 'denied', 10_000, 'J told no')
    // it carries J's nonce and J's bus has never seen it: only coming after the denial gives it away
    const late = held[0]
    if (!late) throw new Error('nothing held')
    expect(
      inside(m)
        .links.get(j.self)
        ?.sendAuth({ t: 'env', env: { ...late, ttl: 0 } }),
    ).toBe(true)
    // longer than J's re-send interval (rejoinMs 3 s)
    await sleep(4500)
    // before: J went back to pending and asked again, and the host listed the joiner it had turned away
    expect(j.state().phase).toBe('denied')
    expect(host.state().pending).toEqual([])
  })

  it('an old members list that still names a joiner who came back does not make it think it is in', async () => {
    const [host, m] = (await room(['M'])) as [Room, Room]
    if (!h) throw new Error('no harness')
    const record = joinerRecord(host)
    const j1 = h.track(await Room.resume(record, h.options('J')))
    await waitFor(() => m.members().some((v) => v.id === j1.self), 20_000, 'J in, as M sees it')
    const list = inside(m).bus.stickyEnvelope('room.members')
    if (!list) throw new Error('M has no members list')
    await j1.leave()
    await waitFor(() => !host.members().some((v) => v.id === j1.self), 10_000, 'J gone from the list')

    host.setAdmission('approve')
    const j2 = h.track(await Room.resume(record, h.options('J')))
    await waitFor(() => j2.state().phase === 'pending', 20_000, 'J waits')
    await waitFor(() => inside(m).links.get(j2.self)?.ready === true, 20_000, 'M linked to J')
    expect(
      inside(m)
        .links.get(j2.self)
        ?.sendAuth({ t: 'env', env: { ...list, ttl: 0 } }),
    ).toBe(true)
    await sleep(1000)
    // before: J took it (host-signed, newer than no list at all) and went in-room with nobody to talk to, and
    // as a member it then ignored the host's answers
    expect(j2.state().phase).toBe('pending')
    host.admit(j2.self, false)
    await waitFor(() => j2.state().phase === 'denied', 10_000, 'J told no')
  })

  it("a joiner's earlier request, relayed again by a member, changes nothing at the host", async () => {
    const [host, m] = (await room(['M'])) as [Room, Room]
    if (!h) throw new Error('no harness')
    host.setAdmission('approve')
    const record = joinerRecord(host)
    const hostKey = Buffer.from(host.self, 'hex')
    // J's first attempt cannot reach the host: it asks through M
    const far = h.options('J', { testing: { firewall: (pk) => pk.equals(hostKey) } })
    const j1 = h.track(await Room.resume(record, far))
    await waitFor(() => host.state().pending.some((p) => p.id === j1.self && p.via === 'M'), 20_000, 'J waits, via M')
    // one more request of that attempt, which M kept back instead of relaying (or one past the host's dedupe)
    const kept = new Bus({ keyPair: keyPairFromSeed(record.keySeed), hostKey: host.self }).seal('room.join-req', {
      name: 'J',
      ...inside(j1).attempt,
    })
    await j1.close()

    // J asks again, and reaches the host itself this time
    const j2 = h.track(await Room.resume(record, h.options('J')))
    await waitFor(() => host.state().pending.some((p) => p.id === j2.self && p.via === undefined), 20_000, 'J, direct')
    await waitFor(() => j2.state().phase === 'pending', 10_000, 'J waits')
    const before = host.state().pending
    inside(m).bus.publish('room.join-via', { req: kept }, { to: host.self })
    await sleep(500)
    // before: the host took it as J's latest, so its answers went to an attempt J has left, through M
    expect(host.state().pending).toEqual(before)
    host.admit(j2.self, true)
    await waitFor(() => j2.state().phase === 'in-room', 2_000, 'J in at once, not at its next request')
  })

  it('answers reach joiners in either mode, straight or through a neighbour: pending, rejected and full', async () => {
    const [host] = (await room(['X'])) as [Room, Room]
    if (!h) throw new Error('no harness')
    const hostKey = Buffer.from(host.self, 'hex')
    const far = { testing: { firewall: (pk: Buffer) => pk.equals(hostKey) } }
    host.setAdmission('approve')
    const near = await h.viewer(host.invite().code, 'Near')
    const farJ = await h.viewer(host.invite().code, 'Far', far)
    await waitFor(() => [near, farJ].every((j) => j.state().phase === 'pending'), 20_000, 'both told they wait')
    expect(host.state().pending.map((p) => [p.name, p.via])).toEqual(
      expect.arrayContaining([
        ['Near', undefined],
        ['Far', 'X'],
      ]),
    )
    host.admit(near.self, false)
    host.admit(farJ.self, false)
    await waitFor(() => [near, farJ].every((j) => j.state().phase === 'denied'), 10_000, 'both told no')
    expect([near, farJ].map((j) => j.state().denyReason)).toEqual(['rejected', 'rejected'])

    // open, and full: the host and X fill a cap of 2
    host.setAdmission('open')
    host.setMaxMembers(2)
    const late = [await h.viewer(host.invite().code, 'Late'), await h.viewer(host.invite().code, 'Later', far)]
    await waitFor(() => late.every((j) => j.state().phase === 'denied'), 20_000, 'both told the room is full')
    expect(late.map((j) => j.state().denyReason)).toEqual(['full', 'full'])
  })
})
