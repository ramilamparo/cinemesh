import { describe, expect, it } from 'vitest'
import { BUS_MAX_BYTES, Bus, type BusLink, type BusMessage, type Envelope } from './bus.js'
import { toHex } from './crypto.js'
import { keyPairFromSeed } from './identity.js'
import { CTRL_MAX_BYTES } from './wire.js'

// Buses wired by in-memory links. Delivery is synchronous, so assertions can follow publish() directly.

const host = keyPairFromSeed('01'.repeat(32))
const hostKey = toHex(host.publicKey)

function makeBus(seedByte: number, opts: { acceptOrigin?: (o: string) => boolean } = {}): Bus {
  const kp = seedByte === 1 ? host : keyPairFromSeed(seedByte.toString(16).padStart(2, '0').repeat(32))
  const bus = new Bus({ keyPair: kp, hostKey, ...(opts.acceptOrigin ? { acceptOrigin: opts.acceptOrigin } : {}) })
  bus.define('room.members', { hostOnly: true, sticky: true })
  bus.define('sync.state', { hostOnly: true, sticky: true })
  return bus
}

function connect(a: Bus, b: Bus): void {
  const toB: BusLink = { id: b.self, sendEnvelope: (env) => b.receive(JSON.parse(JSON.stringify(env)), a.self) }
  const toA: BusLink = { id: a.self, sendEnvelope: (env) => a.receive(JSON.parse(JSON.stringify(env)), b.self) }
  a.addLink(toB)
  b.addLink(toA)
}

function inbox(bus: Bus, name: string): BusMessage[] {
  const got: BusMessage[] = []
  bus.subscribe(name, (m) => got.push(m))
  return got
}

/** `n` envelopes `bus` published under `name`, caught on a tap link (the bus sends them nowhere else). */
function published(bus: Bus, name: string, n: number): Envelope[] {
  const sent: Envelope[] = []
  bus.addLink({ id: 'tap', sendEnvelope: (e) => sent.push(e) })
  for (let i = 0; i < n; i++) bus.publish(name, { i })
  return sent
}

describe('bus', () => {
  it('delivers once and dedupes copies arriving on other links', () => {
    const [a, b, c] = [makeBus(1), makeBus(2), makeBus(3)]
    connect(a, b)
    connect(a, c)
    connect(b, c)
    const atC = inbox(c, 'chat.say')
    a.publish('chat.say', { text: 'hi' })
    expect(atC).toHaveLength(1)
    expect(atC[0]).toMatchObject({ name: 'chat.say', from: a.self, body: { text: 'hi' } })
  })

  it('keeps what it signed: a body the publisher changes afterwards still verifies everywhere', () => {
    const [a, b] = [makeBus(1), makeBus(2)]
    const member = { key: 'b'.repeat(64), name: 'Sam', role: 'viewer' }
    a.publish('room.members', { members: [member], banned: [] })
    member.name = 'Samuel' // the publisher's live record changes later
    connect(a, b) // b gets the sticky replay only now
    expect(b.latest('room.members')?.body).toEqual({ members: [{ ...member, name: 'Sam' }], banned: [] })
    expect(a.latest('room.members')?.body).toEqual(b.latest('room.members')?.body)
  })

  it('forwards while ttl > 0: three hops on a line, not four', () => {
    const buses = [1, 2, 3, 4, 5].map((n) => makeBus(n))
    for (let i = 0; i < 4; i++) connect(buses[i] as Bus, buses[i + 1] as Bus)
    const boxes = buses.map((b) => inbox(b, 'chat'))
    buses[0]?.publish('chat.say', 1)
    expect(boxes.map((b) => b.length)).toEqual([1, 1, 1, 1, 0])
  })

  it('delivers addressed messages only to the addressee, but still forwards them', () => {
    const [a, b, c] = [makeBus(1), makeBus(2), makeBus(3)]
    connect(a, b)
    connect(b, c)
    const atB = inbox(b, 'chat')
    const atC = inbox(c, 'chat')
    a.publish('chat.dm', 'psst', { to: c.self })
    expect(atB).toHaveLength(0)
    expect(atC).toHaveLength(1)
    expect(atC[0]?.to).toBe(c.self)
  })

  it('rejects bad signatures and does not forward them', () => {
    const [a, b, c] = [makeBus(1), makeBus(2), makeBus(3)]
    connect(b, c)
    const atC = inbox(c, 'chat')
    const drops: string[] = []
    b.on('drop', (reason) => drops.push(reason))
    const tapped: Envelope[] = []
    a.addLink({ id: 'tap', sendEnvelope: (e) => tapped.push(e) })
    a.publish('chat.say', { amount: 1 })
    const env = tapped[0]
    if (!env) throw new Error('nothing published')
    const forged = { ...env, body: { amount: 1000 } }
    expect(b.receive(forged, a.self)).toBe(false)
    expect(drops).toEqual(['signature'])
    expect(atC).toHaveLength(0)
    expect(b.receive(env, a.self)).toBe(true)
  })

  it('accepts host-only names only from the host, and refuses to publish them elsewhere', () => {
    const [a, b] = [makeBus(1), makeBus(2)]
    connect(a, b)
    const atA = inbox(a, 'sync.state')
    expect(() => b.publish('sync.state', {})).toThrow(/only be sent by the host/)
    // a forged host-only message from a viewer is dropped before its signature is even checked
    const viewer = makeBus(3)
    let env: Envelope | null = null
    viewer.addLink({ id: 'tap', sendEnvelope: (e) => (env = e) })
    viewer.publish('sync.tate', {})
    const relabelled = { ...(env as unknown as Envelope), ns: 'sync', t: 'state', rev: 1 }
    const drops: string[] = []
    a.on('drop', (r) => drops.push(r))
    expect(a.receive(relabelled, b.self)).toBe(false)
    expect(drops).toEqual(['host-only'])
    expect(atA).toHaveLength(0)
  })

  it('applies the origin check', () => {
    const a = makeBus(1)
    const b = makeBus(2, { acceptOrigin: (o) => o === hostKey })
    connect(a, b)
    const c = makeBus(3)
    connect(c, b)
    const atB = inbox(b, 'chat')
    a.publish('chat.say', 1)
    c.publish('chat.say', 2)
    expect(atB.map((m) => m.body)).toEqual([1])
  })

  it('keeps the newest sticky message and replays it to newly added links', () => {
    const a = makeBus(1)
    a.publish('room.members', { v: 1 })
    a.publish('room.members', { v: 2 })
    const late = makeBus(5)
    const atLate = inbox(late, 'room.members')
    connect(a, late)
    expect(atLate.map((m) => m.body)).toEqual([{ v: 2 }])
    expect(late.latest('room.members')?.body).toEqual({ v: 2 })
  })

  it('drops sticky messages older than the one it holds', () => {
    const a = makeBus(1)
    const sent: Envelope[] = []
    a.addLink({ id: 'tap', sendEnvelope: (e) => sent.push(e) })
    a.publish('sync.state', { v: 1 })
    a.publish('sync.state', { v: 2 })
    const b = makeBus(2)
    const atB = inbox(b, 'sync.state')
    const [first, second] = sent
    if (!first || !second) throw new Error('missing envelopes')
    expect(b.receive(second, 'x')).toBe(true)
    expect(b.receive(first, 'x')).toBe(false)
    expect(atB.map((m) => m.body)).toEqual([{ v: 2 }])
  })

  it('refuses messages that would not fit one ctrl frame', () => {
    const a = makeBus(1)
    expect(() => a.publish('chat.big', 'x'.repeat(BUS_MAX_BYTES))).toThrow(/larger than/)
    // every envelope it takes (or forwards) travels as {ns: 'bus', t: 'msg', m: envelope}
    const wrapper = Buffer.byteLength(JSON.stringify({ ns: 'bus', t: 'msg', m: 0 })) - 1
    expect(BUS_MAX_BYTES + wrapper).toBeLessThanOrEqual(CTRL_MAX_BYTES)
  })

  it('a failing hand-over hook or handler neither escapes receive nor stops the forwarding', () => {
    const b = new Bus({
      keyPair: keyPairFromSeed('02'.repeat(32)),
      hostKey,
      onForeign: () => {
        throw new Error('hand-over failed')
      },
    })
    const faults: string[] = []
    b.on('fault', (name) => faults.push(name))
    const [a, c] = [makeBus(1), makeBus(3)]
    connect(a, b)
    connect(b, c)
    const atC = inbox(c, 'chat')
    const atB: unknown[] = []
    b.subscribe('chat.say', () => {
      throw new TypeError('a body it did not expect')
    })
    b.subscribe('chat.say', (m) => atB.push(m.body))
    // receive runs inside the link's message callback: a throw from it would cost that link (Protomux)
    expect(() => a.publish('chat.dm', 'psst', { to: c.self })).not.toThrow()
    expect(() => a.publish('chat.say', 'hi')).not.toThrow()
    expect(atC.map((m) => m.body)).toEqual(['psst', 'hi'])
    expect(atB).toEqual(['hi'])
    expect(faults).toEqual(['chat.dm', 'chat.say'])
  })

  it('rate-limits a name per origin: a burst, then one per interval; the rest are dropped, not forwarded', () => {
    let now = 0
    const b = new Bus({ keyPair: keyPairFromSeed('02'.repeat(32)), hostKey, now: () => now })
    b.define('room.join-req', { rate: { burst: 2, everyMs: 1000 } })
    const c = makeBus(3)
    connect(b, c)
    const atC = inbox(c, 'room.join-req')
    const drops: string[] = []
    b.on('drop', (reason) => drops.push(reason))
    const sent = published(makeBus(4), 'room.join-req', 6)
    // forgeries under the same origin spend none of its allowance
    for (const env of sent.slice(0, 3)) expect(b.receive({ ...env, body: { name: 'Mallory' } }, 'x')).toBe(false)
    expect(sent.slice(0, 4).map((env) => b.receive(env, 'x'))).toEqual([true, true, false, false])
    now += 1000
    expect(sent.slice(4).map((env) => b.receive(env, 'x'))).toEqual([true, false])
    expect(drops).toEqual(['signature', 'signature', 'signature', 'rate', 'rate', 'rate'])
    expect(atC.map((m) => m.body)).toEqual([{ i: 0 }, { i: 1 }, { i: 4 }])
    // another origin has an allowance of its own
    const [other] = published(makeBus(5), 'room.join-req', 1)
    expect(b.receive(other, 'x')).toBe(true)
  })

  it('take checks an envelope as receive does, but not its origin, and neither delivers nor forwards it', () => {
    let now = 0
    const b = new Bus({ keyPair: keyPairFromSeed('02'.repeat(32)), hostKey, acceptOrigin: () => false, now: () => now })
    b.define('room.join-req', { rate: { burst: 2, everyMs: 1000 } })
    const c = makeBus(3)
    connect(b, c)
    const atB = inbox(b, 'room')
    const atC = inbox(c, 'room')
    const drops: string[] = []
    b.on('drop', (reason) => drops.push(reason))
    const [first, second, third, fourth] = published(makeBus(4), 'room.join-req', 4)
    if (!first || !second || !third || !fourth) throw new Error('missing envelopes')
    // a forgery spends none of the origin's allowance
    expect(b.take({ ...first, body: { i: 9 } })).toBeNull()
    expect(b.take(first)).toEqual(first)
    expect(b.take(first)).toBeNull()
    expect(b.take(second)).toEqual(second)
    expect(b.take(third)).toBeNull()
    now += 1000
    expect(b.take(third)).toEqual(third)
    expect([atB, atC]).toEqual([[], []])
    // receive still asks acceptOrigin
    expect(b.receive(fourth, 'x')).toBe(false)
    expect(drops).toEqual(['signature', 'duplicate', 'rate', 'origin'])
  })

  it('holds a name to its own size bound when it has one, on receive, take and publish', () => {
    const b = makeBus(2)
    b.define('chat.small', { maxBytes: 400 })
    const drops: string[] = []
    b.on('drop', (reason) => drops.push(reason))
    // about 250 bytes of envelope around the body
    const [small, big, bigger] = [50, 200, 300].map((n) => makeBus(3).seal('chat.small', 'x'.repeat(n)))
    if (!small || !big || !bigger) throw new Error('missing envelopes')
    expect(b.receive(small, 'x')).toBe(true)
    expect(b.receive(big, 'x')).toBe(false)
    expect(b.take(bigger)).toBeNull()
    expect(drops).toEqual(['too-large', 'too-large'])
    expect(() => b.publish('chat.small', 'x'.repeat(200))).toThrow(/larger than 400 bytes/)
  })

  it('seal signs without delivering or sending; what it signed verifies wherever it is handed', () => {
    const a = makeBus(1)
    const b = makeBus(2)
    a.define('room.admission', { hostOnly: true })
    b.define('room.admission', { hostOnly: true })
    const sent: Envelope[] = []
    a.addLink({ id: 'tap', sendEnvelope: (e) => sent.push(e) })
    const atA = inbox(a, 'room.admission')
    const atB = inbox(b, 'room.admission')
    const env = a.seal('room.admission', { state: 'pending' }, { to: b.self })
    expect(sent).toEqual([])
    expect(atA).toEqual([])
    expect(b.receive({ ...env, ttl: 0 }, a.self)).toBe(true)
    expect(atB.map((m) => m.body)).toEqual([{ state: 'pending' }])
  })

  it('evicts the oldest entry from the dedupe window', () => {
    const kp = keyPairFromSeed('02'.repeat(32))
    const b = new Bus({ keyPair: kp, hostKey, dedupeSize: 2 })
    const a = makeBus(1)
    const sent: Envelope[] = []
    a.addLink({ id: 'tap', sendEnvelope: (e) => sent.push(e) })
    for (let i = 0; i < 3; i++) a.publish('chat.say', i)
    for (const e of sent) b.receive(e, 'x')
    const first = sent[0]
    if (!first) throw new Error('missing')
    expect(b.receive(first, 'x')).toBe(true) // forgotten, so accepted again
    expect(b.receive(sent[2], 'x')).toBe(false)
  })
})
