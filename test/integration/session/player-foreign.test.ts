import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type MpvCommand, MpvIpc } from '../../../src/core/player/mpv-ipc.js'
import { PlayerController } from '../../../src/core/player/player-controller.js'
import type { PlayerHolder } from '../../../src/core/session/player-holder.js'
import type { SyncEngine } from '../../../src/core/sync/engine.js'
import { HAVE_FFMPEG, HAVE_MPV, LONG, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Sessions with the installed mpv (headless): another client on the viewer's mpv (a second IPC client, a console
// command, macOS File > Open) acts twice while the room plays. Its first command ends our file, and sync's member
// reloads the room's stream; its second lands while that load opens. The player gives the load up as superseded
// (a stop leaves no file whose playback-restart could stand in for it, and another file's restart must not), the
// member loads the stream again at once, and the viewer plays with the room within a few seconds.

interface Internals {
  current: { playerHolder(): PlayerHolder | null; syncEngine(): SyncEngine | null } | null
}
const internals = (m: Member): Internals => m.manager as unknown as Internals

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function eventually(check: () => boolean, ms: number, what: () => string): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`${what()}: not in ${String(ms)} ms`)
    await sleep(25)
  }
}

const outcome = (e: unknown): string => (e as { code?: string }).code ?? String(e)

type Command = (otherFile: string) => MpvCommand

const stop: Command = () => ['stop']
const loadOther: Command = (f) => ['loadfile', f, 'replace']

describe.skipIf(!HAVE_FFMPEG || !HAVE_MPV)("real mpv: another client's command while the member's load opens", () => {
  let testnet: Testnet
  let video: string
  let otherFile: string
  const root = mkdtempSync(join(tmpdir(), 'wt-player-foreign-'))
  const members: Member[] = []
  // a Unix socket path must stay short: not under a long TMPDIR
  let sockDir = ''

  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv', LONG) // 60 s: the room plays on well past both commands
    otherFile = await fixture('mp4-faststart.mp4') // a local file: it opens at once
    sockDir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? '/tmp', 'wt-'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const m of members.splice(0)) await m.manager.shutdown()
  })
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
    await rm(sockDir, { recursive: true, force: true })
  })

  // `lagMs`: each of the viewer's loadfiles reaches mpv that much later, unanswered meanwhile (mpv or core busy).
  // The other client's file then opens before mpv takes our next loadfile, and its playback-restart reaches the
  // player while our load waits: the player passes it on, and it must not pass for ours (a third load).
  const cases: [string, Command, Command, number][] = [
    ['stops mpv, then loads its own file', stop, loadOther, 0],
    ['loads its own file, then stops mpv', loadOther, stop, 0],
    ['stops mpv, then loads its own file, open before our next loadfile', stop, loadOther, 300],
    ['loads its own file, open before our reload, then stops mpv', loadOther, stop, 300],
  ]
  for (const [i, [what, first, second, lagMs]] of cases.entries()) {
    it(`another client ${what}: the load it hit is loaded again at once, and the viewer plays with the room`, async () => {
      const sock = join(sockDir, `mpv-${String(i)}.sock`)
      const host = member('Host', root)
      const viewer = member('Sam', root, { realMpv: true, mpvArgs: [`--input-ipc-server=${sock}`] })
      members.push(host, viewer)
      const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
      await viewer.client.request('session.join', { invite })
      await viewer.client.until('session', (s) => s.phase === 'confirm-join', 60_000)
      await viewer.client.request('session.confirmJoin', { dir: join(viewer.dir, 'save') })
      await viewer.client.until('session', (s) => s.phase === 'in-room', 60_000)
      // the whole file first: this is about the loads, not the download
      await viewer.client.until('transfer', (t) => t.progress >= 1, 60_000)
      await viewer.client.until('player', (p) => p.status === 'ready', 30_000)
      expect((await host.client.request('playback.intent', { kind: 'play' })).accepted).toBe(true)
      await viewer.client.until('playback', (p) => !p.paused && p.posS > 1, 30_000)
      await sleep(1000)

      const holder = internals(viewer).current?.playerHolder()
      const engine = internals(viewer).current?.syncEngine()
      if (!holder || !engine) throw new Error('no player')
      const controller = holder.player
      const stream = holder.prop('path')
      expect(stream).toMatch(/^http:\/\/127\.0\.0\.1:/)
      const client = await MpvIpc.connect(sock)

      // the viewer's loadfiles and load() outcomes from now on; once mpv answered the first loadfile (its entry is
      // in the playlist, opening or about to), the other client's second command goes out
      const loadfiles: string[] = []
      const outcomes: string[] = []
      let armed = true
      const proto = PlayerController.prototype as unknown as {
        sendLoadfile: (...a: unknown[]) => Promise<unknown>
        load: (...a: unknown[]) => Promise<void>
      }
      const send = proto.sendLoadfile
      const load = proto.load
      vi.spyOn(proto, 'sendLoadfile').mockImplementation(async function (this: unknown, ...a: unknown[]) {
        if (this !== controller) return send.apply(this, a)
        loadfiles.push(String(a[1]))
        const reply = await send.apply(this, a)
        if (armed) {
          armed = false
          await client.command(second(otherFile))
        }
        return reply
      })
      vi.spyOn(proto, 'load').mockImplementation(function (this: unknown, ...a: unknown[]) {
        const p = load.apply(this, a)
        const settled = (o: string): void => {
          if (this === controller) outcomes.push(o)
        }
        p.then(
          () => settled('loaded'),
          (e: unknown) => settled(outcome(e)),
        )
        return p
      })
      if (lagMs > 0) {
        const ipcProto = MpvIpc.prototype as unknown as { command: (...a: unknown[]) => Promise<unknown> }
        const command = ipcProto.command
        vi.spyOn(ipcProto, 'command').mockImplementation(async function (this: unknown, ...a: unknown[]) {
          const args = a[0]
          if (this !== client && Array.isArray(args) && args[0] === 'loadfile') await sleep(lagMs)
          return command.apply(this, a)
        })
      }

      try {
        const sentAt = Date.now()
        await client.command(first(otherFile))
        const inStep = (): boolean => {
          const pos = holder.prop('time-pos')
          const room = engine.roomPosition()
          return (
            holder.status === 'ready' &&
            holder.prop('path') === stream &&
            holder.prop('pause') === false &&
            typeof pos === 'number' &&
            room !== null &&
            Math.abs(pos - room) < 0.5
          )
        }
        // the first command ends our file: the member reloads (the second command hits that load)
        await eventually(
          () => loadfiles.length > 0,
          5000,
          () => 'the reload',
        )
        await eventually(
          () => outcomes.length === loadfiles.length && inStep(),
          10_000,
          () => `in step (loads ${JSON.stringify(outcomes)} of ${String(loadfiles.length)})`,
        )
        // the load the second command hit was given up, not left waiting; the next one is the room's stream
        expect(outcomes).toEqual(['player-superseded', 'loaded'])
        expect(loadfiles).toEqual([stream, stream])
        expect(Date.now() - sentAt).toBeLessThan(5000)
        // and it stays that way: no load behind the member's back, nothing left of the other client's file
        await sleep(2000)
        expect(inStep()).toBe(true)
        expect(loadfiles).toHaveLength(2)
      } finally {
        client.close()
      }
    }, 180_000)
  }
})
