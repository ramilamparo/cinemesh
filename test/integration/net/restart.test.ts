import { type ChildProcess, fork } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Bans } from '../../../src/core/net/bans.js'
import { randomBytes, toHex } from '../../../src/core/net/crypto.js'
import { RoomStore, keyPairFromSeed, viewerRecord } from '../../../src/core/net/identity.js'
import { decodeInvite } from '../../../src/core/net/invite.js'
import { Room } from '../../../src/core/net/room.js'
import { Harness, alive, orphanable, waitFor } from './helpers.js'
import type { ChildCommand, ChildMessage } from './room-child.js'

// Real crashes: a member's process is SIGKILLed (no bye; its sockets just stop answering) and started again
// from the same folder, as main's core restart or a user's Resume does. The survivor still holds a link to
// the dead process, which UDX notices only after ~15 s, and the restarted process's first dial can be left
// half-open by hyperdht. Without the stale-link check the restarted member stays unreachable that long;
// with an auth-timeout ban it stays locked out for 10 min.

interface Child {
  proc: ChildProcess
  msgs: ChildMessage[]
  up: Promise<Extract<ChildMessage, { t: 'up' }>>
}

const children: Child[] = []
let h: Harness
const root = mkdtempSync(join(tmpdir(), 'wt-net-restart-'))

beforeAll(async () => {
  h = await Harness.start()
})
afterEach(() => {
  for (const c of children.splice(0)) c.proc.kill('SIGKILL')
})
afterAll(async () => {
  await h.cleanup()
  rmSync(root, { recursive: true, force: true })
})

function spawnRoom(args: string[]): Child {
  const proc = fork(new URL('./room-child.ts', import.meta.url).pathname, args, {
    execArgv: ['--import', 'tsx'],
    env: { ...process.env, WT_BOOTSTRAP: h.bootstrap },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  const msgs: ChildMessage[] = []
  const up = new Promise<Extract<ChildMessage, { t: 'up' }>>((resolve, reject) => {
    proc.on('message', (m: ChildMessage) => {
      msgs.push(m)
      if (m.t === 'up') resolve(m)
    })
    proc.on('exit', (code, signal) => reject(new Error(`room child exited (${String(code ?? signal)})`)))
  })
  const child = { proc, msgs, up }
  children.push(child)
  return child
}

async function crash(child: Child): Promise<void> {
  const gone = new Promise((resolve) => child.proc.once('exit', resolve))
  child.proc.kill('SIGKILL')
  await gone
}

/** The keys among `keys` that the child's room has banned. */
async function bannedIn(child: Child, keys: string[]): Promise<string[]> {
  const id = Math.random()
  child.proc.send({ t: 'banned', id, keys } satisfies ChildCommand)
  let reply: ChildMessage | undefined
  await waitFor(() => (reply = child.msgs.find((m) => m.t === 'banned' && m.id === id)) !== undefined, 5000, 'diag')
  return reply?.t === 'banned' ? reply.keys : []
}

const bansOf = (room: Room): Bans => (room as unknown as { bans: Bans }).bans

/**
 * A viewer record for `invite` whose key sorts below (or above) `than`. Hyperswarm settles two connections
 * between the same pair by key order when neither has carried data: with the order fixed, a half-open dial
 * left in place always wins over the other side's new one, so the test sees what dropping it is worth.
 */
function viewerKeyed(invite: string, than: string, below: boolean): ReturnType<typeof viewerRecord> {
  for (;;) {
    const keySeed = toHex(randomBytes(32))
    const key = toHex(keyPairFromSeed(keySeed).publicKey)
    if (key < than === below) return { ...viewerRecord(decodeInvite(invite), null), keySeed }
  }
}

describe('a member whose process is killed and started again', () => {
  it('a restarted host is linked to its viewer within seconds, and bans nobody', async () => {
    const dir = mkdtempSync(join(root, 'host-'))
    let child = spawnRoom(['host', dir])
    const { invite, roomId, hostKey } = await child.up
    // below the host: the restarted host's half-open dial beats the viewer's dial back unless it is dropped.
    // A slow tick: no mesh repair dials the host for us, so the dial back has to come at once by itself.
    const record = viewerKeyed(invite, hostKey, true)
    const viewer = h.track(await Room.resume(record, h.options('Sam', { testing: { timing: { tickMs: 10_000 } } })))
    await waitFor(() => viewer.state().phase === 'in-room' && viewer.peer(hostKey) !== null, 20_000, 'viewer in')
    const links: { at: number; up: boolean }[] = []
    viewer.on('peer', (p) => p.id === hostKey && links.push({ at: Date.now(), up: true }))
    viewer.on('peer-gone', (id) => id === hostKey && links.push({ at: Date.now(), up: false }))

    // Twice: whether hyperdht completes the restarted host's first dial (Hyperswarm then swaps it in at
    // once) or leaves it half-open (only the stale-link check helps) is a race; each round is likely the latter.
    for (let round = 1; round <= 2; round++) {
      await new Promise((r) => setTimeout(r, 1000)) // pings and heartbeats both ways, as in a real room
      links.length = 0
      await crash(child)
      child = spawnRoom(['resume', dir, roomId])
      await child.up
      const upAt = Date.now()
      // a new link to the restarted process; the old one, to the dead process, is retired first
      await waitFor(() => links.some((l) => l.up), 15_000, 'viewer linked to the restarted host')
      const seen = links.map((l) => `${l.up ? 'up' : 'gone'} +${String(l.at - upAt)} ms`).join(', ')
      console.log(`round ${String(round)}: viewer's host link ${seen}`)
      const [gone, up] = links
      expect(gone?.up).toBe(false)
      expect(up?.up).toBe(true)
      // UDX alone keeps the dead link ~13 s past the restart; measured ~3 ms (swapped in) or ~2.0 s (stale check)
      expect((up?.at ?? Infinity) - upAt).toBeLessThan(4000)
      // the viewer dials the host back as soon as it drops the stale link (Hyperswarm's retry: 0.66 s at best)
      expect((up?.at ?? Infinity) - (gone?.at ?? 0)).toBeLessThan(400)
      expect(viewer.state().phase).toBe('in-room')
      expect(await bannedIn(child, [viewer.self])).toEqual([])
      expect(bansOf(viewer).has(hostKey)).toBe(false)
    }
  })

  it('a restarted viewer is linked to its host within seconds, and bans nobody', async () => {
    const host = await h.host('Host')
    const dir = mkdtempSync(join(root, 'viewer-'))
    // above the host: the restarted viewer's half-open dial beats the host's dial unless it is dropped
    const record = viewerKeyed(host.invite().code, host.self, false)
    await new RoomStore(dir).save(record)
    let child = spawnRoom(['resume', dir, record.id])
    const { roomId, self } = await child.up
    // On this one-machine testnet a fresh child's dials to a host in the test's process (where the DHT nodes
    // run too) tend to be left half-open, so the first join can take several rounds of authOpenTimeoutMs.
    // Have the host look the joiner up and dial it instead: the restart below is what this test is about.
    void (host as unknown as { discovery: { refresh(): Promise<void> } }).discovery.refresh()
    await waitFor(() => child.msgs.some((m) => m.t === 'peer' && m.id === host.self), 30_000, 'viewer in')
    await waitFor(() => host.peer(self) !== null, 10_000, 'host links the viewer')
    await new Promise((r) => setTimeout(r, 1000))

    await crash(child)
    child = spawnRoom(['resume', dir, roomId])
    await child.up
    const upAt = Date.now()
    const fresh = child
    await waitFor(() => fresh.msgs.some((m) => m.t === 'peer' && m.id === host.self), 20_000, 'linked again')
    const backMs = Date.now() - upAt
    console.log(`restarted viewer linked to its host ${String(backMs)} ms after it came up`)
    // measured ~2.1 s: the host drops its stale link (staleLinkMs), its mesh repair dials the viewer
    expect(backMs).toBeLessThan(4000)
    await waitFor(() => host.peer(self) !== null, 5000, 'host links the restarted viewer')
    expect(await bannedIn(child, [host.self])).toEqual([])
    expect(bansOf(host).has(self)).toBe(false)
  })
})

describe('a room child', () => {
  it('closes its room and exits once the process that started it is gone', async () => {
    const dir = mkdtempSync(join(root, 'orphan-'))
    const script = new URL('./room-child.ts', import.meta.url).pathname
    const { parent, childPid } = await orphanable(
      script,
      ['host', dir],
      { ...process.env, WT_BOOTSTRAP: h.bootstrap },
      'up',
    )
    try {
      parent.kill('SIGKILL')
      // measured: gone ~0.2 s after its parent; before, it lived on (re-parented) with its swarm
      await waitFor(() => !alive(childPid), 10_000, 'the orphaned room child exits')
    } finally {
      if (alive(childPid)) process.kill(childPid, 'SIGKILL')
    }
  })
})
