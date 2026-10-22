// Striping's take-back, through whole sessions in their own processes, as viewers join one after the other (the
// alpha found it failing): the first viewer is alone for a moment, so the host shows it everything (the Revealer's
// open mode); when the second viewer attaches, the host takes back what the first neither holds nor is fetching,
// with BEP 54 donthave messages (ADR 0003, round 2 (a) and round 3). Each retracted piece must reach the viewer as a
// donthave, and the cost must not grow with what was taken back: once the first donthave is in, the viewer asks the
// host only for the retracted pieces its pipeline was on (3 pieces, 3 pipelines of blocks at most).
// What happens instead (takeback-wire.test.ts has the mechanism, with engines in one process): each donthave fails
// the viewer's requests for that piece, WebTorrent refills the pipeline at once with the next piece the host still
// seems to have, the next retracted one, and the host answers all of it into the viewer's upload queue, where it
// waits in RAM and is discarded on arrival. The viewer's genuine requests wait behind it until WebTorrent's 30 s
// request timeout drops its host wire. docs/adr/0008-m8-alpha.md §4.1: failed on src as of 2026-10-20, fixed in
// round 6 (ADR 0003: donthaves from the plan's end, and the host rejects what it does not advertise). A piece the
// walk gives the viewer again after its donthave is its work from then on, not a refill.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HAVE_FFMPEG, fixture } from '../integration/media/fixtures.js'
import {
  ALPHA_SET,
  type AlphaMember,
  HOST_UPLOAD_KBPS,
  Results,
  dumpMembers,
  killAll,
  loadavg,
  sleep,
  spawnMember,
} from './harness.js'
import { round, unrevealedServed } from './analysis.js'
import { tag } from './protocol.js'

/** a viewer's pipeline to the host: torrent.js getBlockPipelineLength(wire, 1) at the host's upload limit */
const PIPELINE = 2 + Math.ceil((HOST_UPLOAD_KBPS * 1024) / 16384)
/** the pieces one pipeline spans (1 MiB pieces of 64 blocks), and the one after */
const PIPELINE_PIECES = Math.ceil(PIPELINE / 64) + 1

const say = (...a: unknown[]): void => console.log('[alpha-takeback]', ...a)

describe.skipIf(!HAVE_FFMPEG)('striping take-back through sessions (alpha)', () => {
  let testnet: Testnet
  let root = ''
  const results = new Results('alpha-takeback')
  const members: AlphaMember[] = []
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wt-alpha-takeback-'))
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  })
  afterAll(async () => {
    await Promise.all(members.map((m) => m.shutdown()))
    dumpMembers(results, 'takeback', members)
    await killAll()
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    if (process.env.WT_ALPHA_KEEP !== '1' && root) rmSync(root, { recursive: true, force: true })
  })

  it('the first viewer is told about every piece taken back, and then asks the host only for what it was fetching', async () => {
    const video = await fixture('mkv-cues.mkv', ALPHA_SET)
    const spawn = (name: string, hostLimit?: boolean): Promise<AlphaMember> =>
      spawnMember({
        name,
        root,
        logFile: join(root, `${name}.child.log`),
        realMpv: false,
        ...(hostLimit ? { settings: { uploadLimitKBps: HOST_UPLOAD_KBPS } } : {}),
      })
    const [host, ann, bob] = await Promise.all([spawn('Host', true), spawn('Ann'), spawn('Bob')])
    members.push(host, ann, bob)
    const { invite } = await host.v('session.host', { videoPath: video, subtitlePaths: [] })
    await host.until('session', (s) => s.phase === 'in-room', 120_000)
    const join1 = async (v: AlphaMember): Promise<void> => {
      await v.v('session.join', { invite })
      await v.until('session', (s) => s.phase === 'confirm-join', 120_000)
      await v.v('session.confirmJoin', { dir: join(v.dir, 'save') })
      await v.until('session', (s) => s.phase === 'in-room', 120_000)
    }
    await join1(ann)
    await sleep(3000) // alone: shown everything
    await join1(bob)
    // long enough for WebTorrent's 30 s request timeout: Ann's genuine requests to the host wait behind the
    // answers she discards, which never reset it, so it drops her host wire and the lane is opened again
    await sleep(45_000)
    for (const m of [host, ann, bob]) {
      await m.flush()
      await m.refreshInfo()
    }
    const takebacks = host.logs.takeback.map((b) => ({
      viewer: b.viewer === ann.tag ? 'Ann' : b.viewer === bob.tag ? 'Bob' : b.viewer,
      pieces: b.pieces.length,
      peerSupports: b.peerSupports,
      mappingId: b.mappingId,
    }))
    const annTakeback = host.logs.takeback.find((b) => b.viewer === ann.tag)
    if (!annTakeback) throw new Error('the host took nothing back from the first viewer')
    const T = annTakeback.t
    const retracted = new Set(annTakeback.pieces)
    const toldAt = new Map<number, number>()
    for (const [t, peer, i] of ann.logs.donthave) if (peer === host.tag && !toldAt.has(i)) toldAt.set(i, t)
    const firstTold = toldAt.size ? Math.min(...toldAt.values()) : Number.POSITIVE_INFINITY
    // Ann's block requests to the host for what it took back: before the first donthave reached her (the
    // take-back on its way: she fetches in plan order as usual), and after it (the refills)
    // given back to Ann by the walk after its donthave: hers to fetch from then on
    const reshownAt = new Map<number, number>()
    for (const [t, viewer, i] of host.logs.reveal) {
      const at = toldAt.get(i)
      if (viewer === ann.tag && at !== undefined && t > T && !reshownAt.has(i)) reshownAt.set(i, t)
    }
    const toHost = ann.logs.req.filter((q) => q[3] === host.tag && q[0] >= T && retracted.has(q[1]))
    const beforeTold = toHost.filter((q) => q[0] < firstTold)
    const afterTold = toHost.filter((q) => q[0] >= firstTold && q[0] < (reshownAt.get(q[1]) ?? Infinity))
    const unrevealed = unrevealedServed(host.logs).perViewer
    const queueToAnn = host.logs.queue.filter((q) => q[1] === ann.tag)
    const maxQueued = (from: number, to: number): number =>
      Math.max(0, ...queueToAnn.filter((q) => q[0] >= from && q[0] < to).map((q) => q[2]))
    const rssBefore = host.logs.mem.filter((x) => x[0] < T).at(-1)?.[1] ?? Number.NaN
    const rssAfter = Math.max(0, ...host.logs.mem.filter((x) => x[0] >= T).map((x) => x[1]))
    const MiB = 1048576
    const out = {
      takebacks,
      annDonthavesFromHost: toldAt.size,
      firstDonthaveAfterMs: Number.isFinite(firstTold) ? round(firstTold - T) : null,
      donthaveSpreadMs: toldAt.size ? round(Math.max(...toldAt.values()) - firstTold) : null,
      bounds: { pieces: PIPELINE_PIECES, blocks: 3 * PIPELINE },
      annRequestsToHostForRetracted: {
        beforeFirstDonthave: beforeTold.length,
        afterFirstDonthave: afterTold.length,
        piecesAfterFirstDonthave: new Set(afterTold.map((q) => q[1])).size,
        givenBackByTheWalk: reshownAt.size,
      },
      hostServedUnrevealed: Object.fromEntries(
        [...unrevealed].map(([v, o]) => [
          v === ann.tag ? 'Ann' : v === bob.tag ? 'Bob' : v,
          { blocks: o.blocks, mib: round(o.bytes / MiB, 1) },
        ]),
      ),
      hostQueueToAnnMiB: {
        before: round(maxQueued(-Infinity, T) / MiB, 1),
        after: round(maxQueued(T, Infinity) / MiB, 1),
      },
      hostRssMiB: { before: round(rssBefore / MiB), maxAfter: round(rssAfter / MiB) },
      // a later first bitfield for Ann: her host wire was dropped and attached again
      annHostWireReattachedAfterS:
        host.logs.bitfield
          .filter((b) => b.viewer === ann.tag && b.t > T)
          .map((b) => round((b.t - T) / 1000, 1))
          .at(0) ?? null,
      annVerifiedIn40s: ann.logs.verified.filter(([t]) => t >= T && t < T + 40_000).length,
      hostTag: tag(host.info?.self),
      loadavg: loadavg(),
    }
    results.set('takeback', out)
    say(out)
    // each retracted piece reached Ann as a donthave
    expect(toldAt.size).toBe(retracted.size)
    // and once told, Ann asked the host only for the retracted pieces her pipeline was on
    expect(new Set(afterTold.map((q) => q[1])).size, JSON.stringify(out)).toBeLessThanOrEqual(PIPELINE_PIECES)
    expect(afterTold.length, JSON.stringify(out)).toBeLessThanOrEqual(3 * PIPELINE)
    // the host served nobody a piece it did not show them, and Ann kept her host wire (no 30 s request timeout)
    expect(out.hostServedUnrevealed, JSON.stringify(out)).toEqual({})
    expect(out.annHostWireReattachedAfterS, JSON.stringify(out)).toBeNull()
  }, 300_000)
})
