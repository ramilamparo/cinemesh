import SecretStream from '@hyperswarm/secret-stream'
import c from 'compact-encoding'
import Protomux from 'protomux'
import { afterEach, describe, expect, it } from 'vitest'
import { authProof, randomBytes, roomAuthKey, toHex } from './crypto.js'
import { NET_ERRORS } from './errors.js'
import { type LinkContext, type NetConnection, PeerLink } from './peer.js'
import { AUTH_MAX_BYTES, AUTH_PROTOCOL, CTRL_MAX_BYTES, encodeAuthHandshake } from './wire.js'

const timing = { authTimeoutMs: 2000, authOpenTimeoutMs: 400, ctrlPairWaitMs: 500, pingMs: 60_000, ctrlRetryMs: 100 }
const streams: SecretStream[] = []

afterEach(() => {
  for (const s of streams.splice(0)) s.destroy()
})

async function pair(): Promise<[NetConnection, NetConnection]> {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  streams.push(a, b)
  a.on('error', () => undefined)
  b.on('error', () => undefined)
  a.rawStream.pipe(b.rawStream).pipe(a.rawStream)
  await Promise.all([a.opened, b.opened])
  return [a as unknown as NetConnection, b as unknown as NetConnection]
}

/** Like pair(), with a switch per direction: off drops everything that side sends, as a dead peer does. */
async function gatedPair(): Promise<[NetConnection, NetConnection, { aToB: boolean; bToA: boolean }]> {
  const a = new SecretStream(true)
  const b = new SecretStream(false)
  streams.push(a, b)
  a.on('error', () => undefined)
  b.on('error', () => undefined)
  const gate = { aToB: true, bToA: true }
  a.rawStream.on('data', (d) => {
    if (gate.aToB) b.rawStream.write(d)
  })
  b.rawStream.on('data', (d) => {
    if (gate.bToA) a.rawStream.write(d)
  })
  await Promise.all([a.opened, b.opened])
  return [a as unknown as NetConnection, b as unknown as NetConnection, gate]
}

interface Side {
  link: PeerLink
  ctx: LinkContext
  allow: { value: boolean }
}

function side(conn: NetConnection, name: string, keys: { current: Buffer; previous?: Buffer }, member = true): Side {
  const allow = { value: false }
  const ctx: LinkContext = {
    hostKey: 'f'.repeat(64),
    authKeys: () => ({ current: keys.current, previous: keys.previous ?? null }),
    isKnownMember: () => member,
    localHello: () => ({ proto: 1, app: 'test', name, caps: [] }),
    allowCtrl: () => allow.value,
    relayAddress: () => null,
    timing,
  }
  return { link: new PeerLink(conn, ctx), ctx, allow }
}

function once<T>(emitter: PeerLink, event: 'ready' | 'auth-failed' | 'ctrl-open' | 'close'): Promise<T> {
  return new Promise((resolve) => emitter.once(event, (...args: unknown[]) => resolve(args[0] as T)))
}

describe('PeerLink auth', () => {
  it('exchanges Hello once both proofs check out', async () => {
    const key = roomAuthKey(randomBytes(32))
    const [ca, cb] = await pair()
    const a = side(ca, 'Ann', { current: key })
    const b = side(cb, 'Bob', { current: key })
    await Promise.all([once(a.link, 'ready'), once(b.link, 'ready')])
    expect(a.link.name).toBe('Bob')
    expect(b.link.name).toBe('Ann')
    expect(a.link.id).toBe(toHex(ca.remotePublicKey))
  })

  it('fails both ends when the room secrets differ', async () => {
    const [ca, cb] = await pair()
    const a = side(ca, 'Ann', { current: roomAuthKey(randomBytes(32)) })
    const b = side(cb, 'Bob', { current: roomAuthKey(randomBytes(32)) })
    const [fa, fb] = await Promise.all([once<string>(a.link, 'auth-failed'), once<string>(b.link, 'auth-failed')])
    expect(fa).toBe(NET_ERRORS.authFailed)
    expect(fb).toBe(NET_ERRORS.authFailed)
    await once(a.link, 'close')
  })

  it('accepts the previous epoch only from known members', async () => {
    const old = roomAuthKey(randomBytes(32))
    const current = roomAuthKey(randomBytes(32))
    const [ca, cb] = await pair()
    const rotated = side(ca, 'Ann', { current, previous: old }, true)
    const stale = side(cb, 'Bob', { current: old })
    await Promise.all([once(rotated.link, 'ready'), once(stale.link, 'ready')])

    const [cc, cd] = await pair()
    const strict = side(cc, 'Ann', { current, previous: old }, false)
    side(cd, 'Eve', { current: old })
    expect(await once<string>(strict.link, 'auth-failed')).toBe(NET_ERRORS.authFailed)
  })

  it('times out when the other side never authenticates', async () => {
    const [ca] = await pair()
    const a = side(ca, 'Ann', { current: roomAuthKey(randomBytes(32)) })
    expect(await once<string>(a.link, 'auth-failed')).toBe(NET_ERRORS.authTimeout)
  })

  it('gives up early on a connection the other side never took up', async () => {
    // hyperdht can leave a dial half-open: our end is open, nothing ever arrives from the other one
    const [ca] = await pair()
    const t0 = performance.now()
    const a = side(ca, 'Ann', { current: roomAuthKey(randomBytes(32)) })
    expect(await once<string>(a.link, 'auth-failed')).toBe(NET_ERRORS.authTimeout)
    expect(performance.now() - t0).toBeLessThan(timing.authTimeoutMs / 2)
    expect(a.link.heard).toBe(false)
  })

  it('keeps the full auth timeout once the other side has opened its auth lane', async () => {
    const key = roomAuthKey(randomBytes(32))
    const [ca, cb] = await pair()
    const t0 = performance.now()
    const a = side(ca, 'Ann', { current: key })
    // the other side proves the secret but never sends its Hello (a slow peer, not a missing one)
    const hh = cb.handshakeHash
    if (!hh) throw new Error('no handshake hash')
    const channel = Protomux.from(cb).createChannel({ protocol: AUTH_PROTOCOL, unique: true, handshake: c.raw })
    channel?.open(encodeAuthHandshake(authProof(key, hh, cb.isInitiator), null))
    expect(await once<string>(a.link, 'auth-failed')).toBe(NET_ERRORS.authTimeout)
    expect(performance.now() - t0).toBeGreaterThan(timing.authTimeoutMs - 200)
    expect(a.link.heard).toBe(true)
  })
})

describe('PeerLink ctrl lane', () => {
  async function ready(): Promise<[Side, Side]> {
    const key = roomAuthKey(randomBytes(32))
    const [ca, cb] = await pair()
    const a = side(ca, 'Ann', { current: key })
    const b = side(cb, 'Bob', { current: key })
    await Promise.all([once(a.link, 'ready'), once(b.link, 'ready')])
    return [a, b]
  }

  async function admitted(): Promise<[Side, Side, { aToB: boolean; bToA: boolean }]> {
    const key = roomAuthKey(randomBytes(32))
    const [ca, cb, gate] = await gatedPair()
    const a = side(ca, 'Ann', { current: key })
    const b = side(cb, 'Bob', { current: key })
    await Promise.all([once(a.link, 'ready'), once(b.link, 'ready')])
    a.allow.value = b.allow.value = true
    const opened = Promise.all([once(a.link, 'ctrl-open'), once(b.link, 'ctrl-open')])
    a.link.refreshCtrl()
    b.link.refreshCtrl()
    await opened
    return [a, b, gate]
  }

  it('checkAlive: a live link answers, one whose peer went silent is reported stale', async () => {
    const [a, , gate] = await admitted()
    let stale = 0
    a.link.on('stale', () => stale++)
    a.link.checkAlive(300)
    await new Promise((r) => setTimeout(r, 450))
    expect(stale).toBe(0)

    gate.bToA = false // the other end is gone: our pings leave, nothing comes back
    a.link.checkAlive(300)
    await new Promise((r) => setTimeout(r, 450))
    expect(stale).toBe(1)
    expect(a.link.closed).toBe(false) // the room decides what to do with it
  })

  it('checkAlive needs the ctrl lane', async () => {
    const [a] = await ready()
    let stale = 0
    a.link.on('stale', () => stale++)
    a.link.checkAlive(100)
    await new Promise((r) => setTimeout(r, 250))
    expect(stale).toBe(0)
  })

  it('opens only when both ends allow it, even if one side is late', async () => {
    const [a, b] = await ready()
    a.allow.value = true
    a.link.refreshCtrl()
    await new Promise((r) => setTimeout(r, 50))
    expect(a.link.ctrlOpen).toBe(false)
    b.allow.value = true
    const opened = Promise.all([once(a.link, 'ctrl-open'), once(b.link, 'ctrl-open')])
    b.link.refreshCtrl()
    await opened
    const got = new Promise((resolve) => b.link.once('ctrl', resolve))
    a.link.sendCtrl({ ns: 'test', t: 'x', n: 1 })
    expect(await got).toEqual({ ns: 'test', t: 'x', n: 1 })
  })

  it('retries after the other side rejected the first open', async () => {
    const [a, b] = await ready()
    a.allow.value = true
    a.link.refreshCtrl()
    await new Promise((r) => setTimeout(r, timing.ctrlPairWaitMs + 50)) // b's pair wait runs out
    b.allow.value = true
    await Promise.all([once(a.link, 'ctrl-open'), once(b.link, 'ctrl-open')])
  })

  it('refuses to send a frame over its lane limit, without throwing, and the link stays up', async () => {
    const [a, b] = await ready()
    // The room sends from inside other links' message callbacks (forwarding, hand-overs to joiners): a throw
    // there makes Protomux destroy the connection the message came in on.
    expect(a.link.sendAuth({ t: 'env', env: { pad: 'x'.repeat(AUTH_MAX_BYTES) } })).toBe(false)
    a.allow.value = b.allow.value = true
    a.link.refreshCtrl()
    b.link.refreshCtrl()
    await Promise.all([once(a.link, 'ctrl-open'), once(b.link, 'ctrl-open')])
    expect(a.link.sendCtrl({ ns: 'test', t: 'big', pad: 'x'.repeat(CTRL_MAX_BYTES) })).toBe(false)
    const got = new Promise((resolve) => b.link.once('ctrl', resolve))
    expect(a.link.sendCtrl({ ns: 'test', t: 'small' })).toBe(true)
    expect(await got).toEqual({ ns: 'test', t: 'small' })
    expect(a.link.sendAuth({ t: 'env', env: { small: true } })).toBe(true)
    expect([a.link.closed, b.link.closed]).toEqual([false, false])
  })

  it('destroys the connection on an oversized ctrl frame', async () => {
    const [a, b] = await ready()
    a.allow.value = b.allow.value = true
    a.link.refreshCtrl()
    b.link.refreshCtrl()
    await Promise.all([once(a.link, 'ctrl-open'), once(b.link, 'ctrl-open')])
    const closed = once(b.link, 'close')
    // bypass our own send-side check to emulate a misbehaving peer
    const raw = (a.link as unknown as { ctrlMessage: { send(b: Uint8Array): void } }).ctrlMessage
    raw.send(Buffer.alloc(CTRL_MAX_BYTES + 1, 0x20))
    await closed
    expect(b.link.closed).toBe(true)
  })
})
