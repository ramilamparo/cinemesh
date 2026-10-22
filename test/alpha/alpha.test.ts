// M8 alpha (plan §8 M8; §9 "R6 order", "Scenarios", "Load"): one host and three viewers, each a SessionManager in
// its own process (member-child.ts) with the installed mpv headless, on a local HyperDHT testnet, sharing a 5 min
// 720p MKV with Cues from an upload-limited host. Opt-in: WT_ALPHA=1 npx vitest run --project alpha
// (docs/adr/0008-m8-alpha.md). Every number goes to a JSON file under WT_ALPHA_OUT (default <tmpdir>/wt-alpha-results)
// with the 1-minute load average next to it, and to the console as `[alpha] ...` lines.
//
// Room A: the viewers play from 0:00. (3) permissions with control off, Ask host, the grant; (2) pause latency and
// unpause alignment over host pause/play cycles; (4) striping until every viewer has the whole file; (6) drift over
// the whole run; a viewer's seek once allowed; (5) the three leave kinds.
// Room B: the host skips to 3:20 while the room plays; (1) the R6 order of every request after it, per wire and in
// the union, and of the host's reveals; (6) drift after the seek.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HAVE_FFMPEG, HAVE_MPV, fixture, goldenKeyframes } from '../integration/media/fixtures.js'
import {
  blocksOf,
  classOf,
  driftVsHost,
  driftVsRoom,
  dupFactor,
  expectedPlayhead,
  firstProp,
  fullyRequestedAt,
  percentile,
  piecesOf,
  playbackStart,
  propBefore,
  revealOrder,
  round,
  rssMiB,
  shownAt,
  summary,
  unrevealedServed,
  urgentKind,
  wireOrder,
} from './analysis.js'
import {
  ALPHA_SET,
  type AlphaMember,
  type AlphaRoom,
  HOST_UPLOAD_KBPS,
  Results,
  closeRoom,
  hr,
  killAll,
  loadavg,
  openRoom,
  sha256File,
  sleep,
  srcFingerprint,
} from './harness.js'
import { CLS, type PlanRec, type ReqRec } from './protocol.js'

const VIEWERS = ['Ann', 'Bob', 'Cid']
const CYCLES = Number(process.env.WT_ALPHA_CYCLES ?? 8)
/** samples this soon after a seek, an unpause or a playback-restart do not count for drift (the task: 2 s) */
const SETTLE_MS = 2000
/** a sample's stamp is its IPC request's midpoint, good to rtt / 2: drop slow ones */
const MAX_RTT_MS = 20
const SEEK_TARGET_S = 200
const KEEP = process.env.WT_ALPHA_KEEP === '1'

const say = (...a: unknown[]): void => console.log('[alpha]', ...a)

function need<T>(x: T | null | undefined, what: string): T {
  if (x === null || x === undefined) throw new Error(`no ${what}`)
  return x
}

async function waitFor(check: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`${what}: not within ${String(ms)} ms`)
    await sleep(250)
  }
}

const complete = (v: AlphaMember): boolean => (v.last('transfer')?.progress ?? 0) >= 1

function mpvVersion(): string {
  try {
    return execFileSync('mpv', ['--version'], { encoding: 'utf8' }).split('\n')[0] ?? ''
  } catch {
    return 'none'
  }
}

describe.skipIf(!HAVE_FFMPEG || !HAVE_MPV)(
  'M8 alpha: a host and three viewers in their own processes, real mpv',
  () => {
    let testnet: Testnet
    let video = ''
    const results = new Results('alpha')
    beforeAll(async () => {
      testnet = await createTestnet(3)
      process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
      video = await fixture('mkv-cues.mkv', ALPHA_SET)
      results.set('env', {
        start: new Date().toISOString(),
        loadavg: loadavg(),
        src: srcFingerprint(),
        video,
        fixture: ALPHA_SET,
        hostUploadKBps: HOST_UPLOAD_KBPS,
        cycles: CYCLES,
        mpv: mpvVersion(),
        node: process.version,
      })
      say('results ->', results.file)
    })
    afterAll(async () => {
      await killAll()
      await testnet.destroy()
      delete process.env.WT_BOOTSTRAP
      results.set('end', { at: new Date().toISOString(), loadavg: loadavg(), src: srcFingerprint() })
    })

    describe('room A: the viewers play from 0:00', () => {
      let root = ''
      let room: AlphaRoom | null = null
      let tPlay = 0
      beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'wt-alpha-a-'))
        const t0 = hr()
        room = await openRoom({ root, video, viewers: VIEWERS, hostSettings: { uploadLimitKBps: HOST_UPLOAD_KBPS } })
        const opened = hr()
        const play = await room.host.request('playback.intent', { kind: 'play' })
        expect(play.v.accepted).toBe(true)
        tPlay = play.tReq
        // the first play waits for the host's start mode: everyone 10 s buffered
        await Promise.all(room.all.map((m) => m.until('playback', (p) => !p.paused && p.posS > 0.5, 180_000, tPlay)))
        const setup = { openMs: round(opened - t0), firstPlayMs: round(hr() - tPlay), loadavg: loadavg() }
        results.set('roomA.setup', setup)
        say('room A open', setup)
      })
      afterAll(async () => {
        await closeRoom(room, { results, room: 'A' })
        results.set('roomA.fatals', room?.all.map((m) => ({ name: m.name, fatals: m.fatals })) ?? [])
        if (!KEEP && root) rmSync(root, { recursive: true, force: true })
      })

      it('(3) control off: a viewer is refused, Ask host reaches the host, the grant lets its next intent through', async () => {
        const r = need(room, 'room')
        const { host } = r
        const ann = need(r.viewers[0], 'Ann')
        expect(host.last('sync')?.perms).toEqual({ othersPlayPause: false, othersSeek: false })
        const since = hr()
        const pause = await ann.request('playback.intent', { kind: 'pause' })
        expect(pause.v).toEqual({ accepted: false, reason: 'perm-playpause' })
        const refused = await ann.until('notice', (n) => n.code === 'sync.perm-playpause', 5000, since)
        expect(refused.d.action).toEqual({ label: 'Ask host', request: 'sync.request', params: { kind: 'pause' } })
        const seek = await ann.request('playback.intent', { kind: 'seek', posS: 30 })
        expect(seek.v).toEqual({ accepted: false, reason: 'perm-seek' })
        await ann.until(
          'notice',
          (n) => n.code === 'sync.perm-seek' && n.action?.request === 'sync.request',
          5000,
          since,
        )
        // refused locally: nobody's mpv paused or seeked
        await sleep(500)
        for (const m of r.all) {
          await m.flush()
          expect(firstProp(m.logs, 'pause', true, since), `${m.name} paused`).toBeNull()
          expect(firstProp(m.logs, 'seeking', true, since), `${m.name} seeked`).toBeNull()
        }

        // Ask host: what the refusal notice's action sends; the host sees the one-click toast its UI shows
        const ask = await ann.request('sync.request', { kind: 'pause' })
        const asked = await host.until('notice', (n) => n.code === 'sync.request', 10_000, ask.tReq)
        expect(asked.d.message).toBe('Ann asks to pause')
        expect(asked.d.action).toEqual({ label: 'Pause', request: 'playback.intent', params: { kind: 'pause' } })
        // the grant (the host panel's one switch sets both)
        const grant = await host.request('sync.setPerms', { othersPlayPause: true, othersSeek: true })
        const granted = await ann.until('sync', (s) => s.canPlayPause && s.canSeek, 10_000, grant.tReq)

        // Ann's next intent is accepted and applied everywhere
        const p2 = await ann.request('playback.intent', { kind: 'pause' })
        expect(p2.v).toEqual({ accepted: true })
        const pausedAt = await Promise.all(r.all.map((m) => m.waitProp('pause', true, p2.tReq, 10_000)))
        await sleep(1500)
        const play = await ann.request('playback.intent', { kind: 'play' })
        expect(play.v).toEqual({ accepted: true })
        const playedAt = await Promise.all(r.all.map((m) => m.waitProp('pause', false, play.tReq, 20_000)))
        const out = {
          askToHostNoticeMs: round(asked.at - ask.tReq),
          grantToViewerMs: round(granted.at - grant.tReq),
          viewerPauseToMpvMs: Object.fromEntries(r.all.map((m, i) => [m.name, round((pausedAt[i] ?? NaN) - p2.tReq)])),
          viewerPlayToMpvMs: Object.fromEntries(r.all.map((m, i) => [m.name, round((playedAt[i] ?? NaN) - play.tReq)])),
          loadavg: loadavg(),
        }
        results.set('roomA.permissions', out)
        say('(3) permissions', out)
        for (const ms of Object.values(out.viewerPauseToMpvMs)) expect(ms).toBeLessThan(500)
        await sleep(4000) // steady again before the pause cycles
      })

      it('(2) the host pauses: every mpv reports pause within 500 ms; unpause alignment', async () => {
        const r = need(room, 'room')
        const { host } = r
        const cycles: {
          pauseMs: Record<string, number>
          unpauseCmdVsHostMs: Record<string, number>
          startVsHostMs: Record<string, number | null>
          startVsAnchorMs: Record<string, number | null>
          leadMs: number | null
          loadavg: number[]
        }[] = []
        for (let c = 0; c < CYCLES; c++) {
          for (const m of r.all) await m.flush()
          for (const m of r.all)
            expect(propBefore(m.logs, 'pause', hr()), `${m.name} playing before cycle ${String(c)}`).toBe(false)
          const pr = await host.request('playback.intent', { kind: 'pause' })
          expect(pr.v.accepted).toBe(true)
          const paused = await Promise.all(r.all.map((m) => m.waitProp('pause', true, pr.tReq, 10_000)))
          await sleep(1500)
          const pl = await host.request('playback.intent', { kind: 'play' })
          expect(pl.v.accepted).toBe(true)
          const unpaused = await Promise.all(r.all.map((m) => m.waitProp('pause', false, pl.tReq, 20_000)))
          await sleep(4000)
          for (const m of r.all) await m.flush()
          const anchor = host.logs.anchor.find((a) => a.t >= pl.tReq && a.mode === 'playing')
          const startOf = (m: AlphaMember, i: number): number | null =>
            anchor
              ? playbackStart(m.logs, unpaused[i] ?? NaN, anchor.pos, {
                  fromMs: 300,
                  toMs: 1500,
                  maxRttMs: MAX_RTT_MS,
                  prop: 'audio-pts',
                })
              : null
          const starts = r.all.map(startOf)
          const hostStart = starts[0] ?? null
          const hostUnpause = unpaused[0] ?? NaN
          cycles.push({
            pauseMs: Object.fromEntries(r.all.map((m, i) => [m.name, round((paused[i] ?? NaN) - pr.tReq)])),
            unpauseCmdVsHostMs: Object.fromEntries(
              r.viewers.map((v, i) => [v.name, round((unpaused[i + 1] ?? NaN) - hostUnpause)]),
            ),
            startVsHostMs: Object.fromEntries(
              r.viewers.map((v, i) => {
                const s = starts[i + 1]
                return [v.name, s !== null && s !== undefined && hostStart !== null ? round(s - hostStart) : null]
              }),
            ),
            startVsAnchorMs: Object.fromEntries(
              r.all.map((m, i) => {
                const s = starts[i]
                return [m.name, s !== null && s !== undefined && anchor ? round(s - anchor.hostTimeHr) : null]
              }),
            ),
            leadMs: anchor ? round(anchor.hostTimeHr - anchor.t) : null,
            loadavg: loadavg(),
          })
        }
        const viewerPause = cycles.flatMap((c) => r.viewers.map((v) => c.pauseMs[v.name] ?? NaN))
        const cmd = cycles.flatMap((c) => Object.values(c.unpauseCmdVsHostMs).map(Math.abs))
        const start = cycles.flatMap((c) =>
          Object.values(c.startVsHostMs)
            .filter((x): x is number => x !== null)
            .map(Math.abs),
        )
        const out = {
          cycles,
          viewerPauseMs: summary(viewerPause),
          perViewerPauseMs: Object.fromEntries(
            r.viewers.map((v) => [v.name, summary(cycles.map((c) => c.pauseMs[v.name] ?? NaN))]),
          ),
          hostOwnPauseMs: summary(cycles.map((c) => c.pauseMs.Host ?? NaN)),
          unpauseCmdAbsVsHostMs: summary(cmd),
          playbackStartAbsVsHostMs: summary(start),
        }
        results.set('roomA.pause', out)
        say('(2) pause', { viewerPauseMs: out.viewerPauseMs, perViewer: out.perViewerPauseMs })
        say('(2) unpause', { cmd: out.unpauseCmdAbsVsHostMs, playbackStart: out.playbackStartAbsVsHostMs })
        expect(Math.max(...viewerPause)).toBeLessThan(500)
      })

      it('(4) striping: dupFactor <= 1.3 with three viewers playing from 0:00, and every viewer completes', async () => {
        const r = need(room, 'room')
        const { host } = r
        await waitFor(() => r.viewers.every(complete), 12 * 60_000, 'every viewer complete')
        await sleep(2500) // the host's next 1 Hz transfer event
        await host.flush()
        for (const v of r.viewers) await v.flush()
        const P = r.manifest.pieceLength
        const critical = piecesOf([...r.manifest.openCritical, ...r.manifest.seekCritical], P)
        const d = dupFactor(host.logs.served, critical, r.pieceCount)
        const engine = host.last('transfer')?.dupFactor
        const completedS = Object.fromEntries(
          r.viewers.map((v) => {
            const done = v.all('transfer').find((x) => x.d.progress >= 1)
            return [v.name, done ? round((done.at - tPlay) / 1000) : null]
          }),
        )
        // where each viewer's blocks came from: the host or the other viewers
        const fromHost = Object.fromEntries(
          r.viewers.map((v) => {
            const n = v.logs.req.length
            return [v.name, round(v.logs.req.filter((q) => q[3] === host.tag).length / Math.max(1, n), 3)]
          }),
        )
        const out = {
          engineDupFactor: engine === undefined ? null : round(engine, 3),
          ...d,
          criticalBytesPerViewer: d.criticalDistinct,
          // the take-backs of the one-by-one join, and what the host served for pieces it did not show that viewer (none
          // since round 6: it rejects those requests; takeback.test.ts)
          striping: stripingBookkeeping(r, critical),
          completedAfterPlayS: completedS,
          blockShareFromHost: fromHost,
          // the per-wire R6 rule (room B's check) over every request of this room, which never seeks
          perWireOrder: Object.fromEntries(
            r.viewers.map((v) => {
              const o = wireOrder(v.logs.req, new Map(v.logs.plan.map((x) => [x.gen, x])), r.pieceCount)
              return [v.name, { requests: o.requests, violations: o.violations, rankerSkips: o.rankerSkips }]
            }),
          ),
          pieces: r.pieceCount,
          // each member process (the core; mpv is its own process) from the first play to every viewer complete
          rssMiB: Object.fromEntries(r.all.map((m) => [m.name, rssMiB(m.logs.mem, tPlay)])),
          // mpv waiting for data while the room plays (paused-for-cache going true)
          stalls: Object.fromEntries(
            r.all.map((m) => [
              m.name,
              m.logs.prop.filter(([t, n, v]) => t >= tPlay && n === 'paused-for-cache' && v === true).length,
            ]),
          ),
          loadavg: loadavg(),
        }
        results.set('roomA.striping', out)
        say('(4) striping', out)
        expect(r.viewers.every(complete)).toBe(true)
        expect(engine).toBeDefined()
        // a take-back (a viewer alone at a Revealer tick) costs dupFactor: takeback.test.ts
        expect(engine, JSON.stringify(out.striping)).toBeLessThanOrEqual(1.3)
        expect(Math.abs(d.dupAll - (engine ?? 0))).toBeLessThan(0.02) // our count is the engine's
      })

      it('(6) drift: p95 |viewer - host| < 100 ms while playing (2 s after any seek or unpause excluded)', async () => {
        const r = need(room, 'room')
        const { host } = r
        for (const m of r.all) await m.flush()
        const opts = {
          settleMs: SETTLE_MS,
          maxRttMs: MAX_RTT_MS,
          maxGapMs: 600,
          prop: 'audio-pts' as const,
          from: tPlay,
        }
        const perViewer = r.viewers.map((v) => ({ name: v.name, ...driftVsHost(host.logs, v.logs, opts) }))
        const vsRoom = r.all.map((m) => {
          const d = driftVsRoom(m.logs, host.logs.anchor, opts)
          return { name: m.name, abs: d.abs, signed: d.signed }
        })
        // what the app itself reports (sync.status driftMs, the host's peer list)
        const reported = Object.fromEntries(
          r.viewers.map((v) => {
            const xs = host
              .all('peers', tPlay)
              .flatMap((e) => e.d.filter((p) => p.id === v.info?.self && p.driftMs !== null).map((p) => p.driftMs ?? 0))
            return [v.name, summary(xs.map(Math.abs))]
          }),
        )
        const out = {
          perViewer: perViewer.map((x) => ({
            name: x.name,
            abs: x.abs,
            signed: x.signed,
            dropped: x.dropped,
            minutes: round((x.series.at(-1)?.t ?? 0) / 60_000 - (x.series[0]?.t ?? 0) / 60_000, 2),
          })),
          vsRoom,
          appReportedAbsMs: reported,
          loadavg: loadavg(),
        }
        results.set('roomA.drift', out)
        say(
          '(6) drift room A',
          out.perViewer.map((x) => ({ name: x.name, abs: x.abs })),
        )
        for (const x of perViewer) {
          expect(x.abs.n, `${x.name}: samples`).toBeGreaterThan(100)
          expect(x.abs.p95, `${x.name}: p95 |drift|`).toBeLessThan(100)
        }
      })

      it('(3) once allowed, a viewer seek is applied everywhere', async () => {
        const r = need(room, 'room')
        const ann = need(r.viewers[0], 'Ann')
        const target = 100
        const seek = await ann.request('playback.intent', { kind: 'seek', posS: target })
        expect(seek.v).toEqual({ accepted: true })
        const back = await Promise.all(
          r.all.map((m) =>
            m.until(
              'playback',
              (p) => !p.paused && !p.seeking && p.posS > target && p.posS < target + 5,
              60_000,
              seek.tReq,
            ),
          ),
        )
        const out = Object.fromEntries(r.all.map((m, i) => [m.name, round((back[i]?.at ?? NaN) - seek.tReq)]))
        results.set('roomA.viewerSeek', { target, playingAgainMs: out, loadavg: loadavg() })
        say('(3) viewer seek to 1:40, playing again after (ms)', out)
      })

      it('(5) leaving: keep stays resumable, save exports the exact file, delete removes the download', async () => {
        const r = need(room, 'room')
        const [ann, bob, cid] = r.viewers
        if (!ann || !bob || !cid) throw new Error('three viewers')
        for (const v of r.viewers) await v.refreshInfo()
        const roomId = need(ann.info?.roomId, 'room id')
        const record = (v: AlphaMember): string => join(v.dir, 'userData', 'wt', 'rooms', roomId, 'room.json')
        const out: Record<string, unknown> = {}

        // keep: the record stays, Recent rooms offers Resume, the data stays on disk
        const tA = hr()
        await ann.v('session.leave', { data: 'keep' })
        await ann.until('session', (s) => s.phase === 'idle', 30_000, tA)
        const aDir = need(ann.info?.transferDir, 'Ann transferDir')
        const recentA = await ann.v('session.recent', {})
        const mineA = recentA.find((x) => x.roomId === roomId)
        expect(mineA).toMatchObject({ role: 'viewer', resumable: true })
        expect(existsSync(record(ann))).toBe(true)
        expect(existsSync(join(aDir, 'state.json'))).toBe(true)
        const segs = readdirSync(join(aDir, 'seg'))
        expect(segs.length).toBeGreaterThan(0)
        out.keep = { leaveMs: round(hr() - tA), recent: mineA, segments: segs.length }

        // save: the exported file is the source, byte for byte; the download folder and the record are gone
        const tB = hr()
        await bob.v('session.leave', { data: 'save' }, 600_000)
        await bob.until('session', (s) => s.phase === 'idle', 60_000, tB)
        const saveDir = need(bob.info?.saveDir, 'Bob saveDir')
        const saved = readdirSync(saveDir).filter((f) => f !== '.wt-partial')
        expect(saved).toEqual([basename(video)])
        const [src, copy] = await Promise.all([sha256File(video), sha256File(join(saveDir, basename(video)))])
        expect(copy).toBe(src)
        expect(existsSync(need(bob.info?.transferDir, 'Bob transferDir'))).toBe(false)
        expect(existsSync(record(bob))).toBe(false)
        expect((await bob.v('session.recent', {})).some((x) => x.roomId === roomId)).toBe(false)
        out.save = { leaveMs: round(hr() - tB), file: saved[0], sha256: copy }

        // delete: the download folder (and the record) are gone
        const tC = hr()
        await cid.v('session.leave', { data: 'delete' })
        await cid.until('session', (s) => s.phase === 'idle', 30_000, tC)
        expect(existsSync(need(cid.info?.transferDir, 'Cid transferDir'))).toBe(false)
        expect(existsSync(record(cid))).toBe(false)
        expect((await cid.v('session.recent', {})).some((x) => x.roomId === roomId)).toBe(false)
        out.delete = { leaveMs: round(hr() - tC) }
        results.set('roomA.leave', out)
        say('(5) leave', out)
      })
    })

    describe('room B: the host skips to 3:20 while the room plays', () => {
      let root = ''
      let room: AlphaRoom | null = null
      let tSeek = 0
      let tResumed = 0
      let tPlay = 0
      beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), 'wt-alpha-b-'))
        room = await openRoom({ root, video, viewers: VIEWERS, hostSettings: { uploadLimitKBps: HOST_UPLOAD_KBPS } })
        const r = room
        const play = await r.host.request('playback.intent', { kind: 'play' })
        expect(play.v.accepted).toBe(true)
        tPlay = play.tReq
        await Promise.all(r.all.map((m) => m.until('playback', (p) => !p.paused && p.posS > 0.5, 180_000, tPlay)))
        await r.host.until('playback', (p) => p.posS >= 20, 120_000, tPlay)
        const seek = await r.host.request('playback.intent', { kind: 'seek', posS: SEEK_TARGET_S })
        expect(seek.v.accepted).toBe(true)
        tSeek = seek.tReq
        await Promise.all(
          r.all.map((m) =>
            m.until(
              'playback',
              (p) => !p.paused && !p.seeking && p.posS > SEEK_TARGET_S + 0.5 && p.posS < 280,
              180_000,
              tSeek,
            ),
          ),
        )
        tResumed = hr()
        // L1, then L2 to the end, then L3 from 0:00: all of it
        await waitFor(() => r.viewers.every(complete), 12 * 60_000, 'every viewer complete')
        for (const m of r.all) await m.flush()
        const out = {
          seekAtPosS: SEEK_TARGET_S,
          seekAfterPlayS: round((tSeek - tPlay) / 1000),
          playingAgainAfterMs: round(tResumed - tSeek),
          completeAfterSeekS: round((hr() - tSeek) / 1000),
          striping: stripingBookkeeping(
            r,
            piecesOf([...r.manifest.openCritical, ...r.manifest.seekCritical], r.manifest.pieceLength),
          ),
          loadavg: loadavg(),
        }
        results.set('roomB.setup', out)
        say('room B', out)
      })
      afterAll(async () => {
        await closeRoom(room, { results, room: 'B' })
        results.set('roomB.fatals', room?.all.map((m) => ({ name: m.name, fatals: m.fatals })) ?? [])
        if (!KEEP && root) rmSync(root, { recursive: true, force: true })
      })

      /** p, the hot window and L1 the plan says for 3:20, from the manifest (not MediaMap) and ffprobe */
      const expected = (r: AlphaRoom): { p: number; keyMs: number; byte: number } =>
        expectedPlayhead(r.manifest, SEEK_TARGET_S)

      /** each viewer's seek plan: its first scheduler plan after its playhead moved to 3:20 */
      const seekPlans = (r: AlphaRoom): { v: AlphaMember; t: number; plan: PlanRec; playheadT: number }[] =>
        r.viewers.map((v) => {
          const ph = need(
            v.logs.playhead.find(
              (x) => x.t >= tSeek && x.seek && x.posS !== null && Math.abs(x.posS - SEEK_TARGET_S) < 0.5,
            ),
            `${v.name}: a seek playhead at 3:20`,
          )
          const plan = need(
            v.logs.plan.find((x) => x.t >= ph.t),
            `${v.name}: a plan after the seek`,
          )
          return { v, t: plan.t, plan, playheadT: ph.t }
        })

      it('(1) the plan after the seek: p = pieceOf(keyframe <= 3:20 - 2 s) on every viewer and in the host group plan', () => {
        const r = need(room, 'room')
        const exp = expected(r)
        const P = r.manifest.pieceLength
        // the manifest's keyframe (Cues) against ffprobe's packets: same keyframe, same piece
        const golden = goldenKeyframes(video)
          .filter((k) => k.ms <= SEEK_TARGET_S * 1000 - 2000)
          .at(-1)
        expect(golden?.ms).toBe(exp.keyMs)
        expect(Math.floor((golden?.pos ?? 0) / P)).toBe(exp.p)
        const gplan = need(
          r.host.logs.gplan.find(
            (g) => g.t >= tSeek && g.seek && g.posS !== null && Math.abs(g.posS - SEEK_TARGET_S) < 0.5,
          ),
          'host: a seek group plan',
        )
        const viewers = seekPlans(r).map(({ v, plan, playheadT }) => ({
          name: v.name,
          p: plan.p,
          hot: plan.hot,
          w: plan.w,
          afterHostSeekMs: round(playheadT - tSeek),
          live: plan.live,
        }))
        const out = {
          expected: { ...exp, keyS: exp.keyMs / 1000 },
          golden,
          host: { p: gplan.p, hot: gplan.hot, w: gplan.w, afterSeekMs: round(gplan.t - tSeek) },
          viewers,
        }
        results.set('roomB.r6.plan', out)
        say('(1) R6 plan', out)
        expect(gplan.p).toBe(exp.p)
        expect(gplan.hot?.[0]).toBe(exp.p)
        for (const v of viewers) {
          expect(v.p, v.name).toBe(exp.p)
          expect(v.hot?.[0], v.name).toBe(exp.p)
          expect(v.w, v.name).toBe(gplan.w)
        }
      })

      it('(1) per wire (ADR 0003 F3): every request after the seek was the plan head among what that peer offered', () => {
        const r = need(room, 'room')
        const out = seekPlans(r).map(({ v, t }) => {
          const plans = new Map(v.logs.plan.map((p) => [p.gen, p]))
          const after = wireOrder(
            v.logs.req.filter((q) => q[0] >= t),
            plans,
            r.pieceCount,
          )
          const before = wireOrder(
            v.logs.req.filter((q) => q[0] < t),
            plans,
            r.pieceCount,
          )
          const byPeer = Object.fromEntries(
            [...new Set(v.logs.req.filter((q) => q[0] >= t).map((q) => q[3]))].map((peer) => [
              r.names.get(peer) ?? peer,
              v.logs.req.filter((q) => q[0] >= t && q[3] === peer).length,
            ]),
          )
          return { name: v.name, afterSeek: after, beforeSeek: before, requestsByPeer: byPeer }
        })
        results.set('roomB.r6.perWire', out)
        say(
          '(1) R6 per wire',
          out.map((x) => ({
            name: x.name,
            after: { n: x.afterSeek.requests, viol: x.afterSeek.violations, ranker: x.afterSeek.rankerSkips },
            before: { n: x.beforeSeek.requests, viol: x.beforeSeek.violations },
          })),
        )
        for (const x of out) {
          expect(x.afterSeek.requests, x.name).toBeGreaterThan(1000)
          expect(x.afterSeek.violations, `${x.name}: ${JSON.stringify(x.afterSeek.examples)}`).toBe(0)
        }
      })

      it("(1) the host's reveals after the seek follow the group plan: L1 from p, L2 to the end, then L3 from 0", () => {
        const r = need(room, 'room')
        const exp = expected(r)
        const { host } = r
        const tG = need(
          host.logs.gplan.find(
            (g) => g.t >= tSeek && g.seek && g.posS !== null && Math.abs(g.posS - SEEK_TARGET_S) < 0.5,
          ),
          'host: a seek group plan',
        ).t
        // plan epochs: a new p (the 1 Hz ticks keep p until L1 moved a quarter)
        const epochs = host.logs.gplan
          .filter((g) => g.t >= tG)
          .filter((g, i, a) => i === 0 || g.p !== a[i - 1]?.p)
          .map((g) => ({ t: g.t, p: g.p }))
        const order = revealOrder(host.logs.reveal, epochs, r.pieceCount, tG)
        const after = host.logs.reveal.filter((x) => x[0] >= tG)
        const kinds: Record<string, number> = {}
        for (const x of after)
          kinds[`${x[3]}${x[4] ? `:${x[4]}` : ''}`] = (kinds[`${x[3]}${x[4] ? `:${x[4]}` : ''}`] ?? 0) + 1
        const firstReveals = after.slice(0, 12).map(([t, viewer, piece, ctx, path]) => ({
          ms: round(t - tG),
          viewer: r.names.get(viewer) ?? viewer,
          piece,
          how: path ? `${ctx}:${path}` : ctx,
        }))
        // where the walk's last first-assignment of L2 and the first of L3 fall (L3 = pieces before p)
        const firstWalk = new Map<number, number>()
        for (const [t, , piece, ctx, path] of after)
          if (ctx === 'give' && path === 'walk' && !firstWalk.has(piece)) firstWalk.set(piece, t)
        const l2 = [...firstWalk].filter(([i]) => i > exp.p)
        const l3 = [...firstWalk].filter(([i]) => i < exp.p)
        const lastL2 = l2.length ? Math.max(...l2.map(([, t]) => t)) : null
        const firstL3 = l3.length ? Math.min(...l3.map(([, t]) => t)) : null
        const out = {
          epochs: epochs.length,
          walkGives: order.gives,
          backSteps: order.backSteps,
          backExamples: order.examples,
          firstWalkPieces: order.first,
          firstReveals,
          revealKinds: kinds,
          lastL2GiveMs: lastL2 === null ? null : round(lastL2 - tG),
          firstL3GiveMs: firstL3 === null ? null : round(firstL3 - tG),
        }
        results.set('roomB.r6.host', out)
        say('(1) R6 host reveals', out)
        expect(order.gives).toBeGreaterThan(10)
        expect(order.backSteps).toBe(0)
        expect(order.first[0]).toBe(exp.p)
        if (lastL2 !== null && firstL3 !== null) expect(firstL3).toBeGreaterThanOrEqual(lastL2)
      })

      it('(1) per viewer and in the union: first requests, the window fully requested, then L2, then L3', () => {
        const r = need(room, 'room')
        const exp = expected(r)
        const plans = seekPlans(r)
        const N = r.pieceCount
        const first = plans[0]
        if (!first) throw new Error('no plans')
        const { plan } = first
        const p = need(plan.p, 'p')
        const w = need(plan.w, 'w')
        const L1 = range(p, Math.min(N - 1, p + w))
        const L2 = range(p + w + 1, N - 1)
        const L3 = range(0, p - 1)
        const describeReq = (q: ReqRec | undefined, pl: PlanRec, t0: number): object | null =>
          q
            ? {
                ms: round(q[0] - t0),
                piece: q[1],
                peer: r.names.get(q[3]) ?? q[3],
                cls: clsName(classOf(pl, q[1], N)),
                urgent: urgentKind(pl, q[1]),
              }
            : null
        const perViewer = plans.map(({ v, t, plan: pl }) => {
          const reqs = v.logs.req.filter((q) => q[0] >= t)
          const own = [{ reqs: v.logs.req, verified: v.logs.verified }]
          const l1At = fullyRequestedAt(L1, own, r.manifest, N, t)
          const outside = l1At === null ? [] : reqs.filter((q) => q[0] < l1At && q[4] !== CLS.urgent && q[4] !== CLS.l1)
          const firstOf = (cls: number): number | null => reqs.find((q) => q[4] === cls)?.[0] ?? null
          const hotVerified = pl.hot ? verifiedAll(v, range(pl.hot[0], pl.hot[1]), t) : null
          const l1Verified = verifiedAll(v, L1, t)
          return {
            name: v.name,
            first: describeReq(reqs[0], pl, t),
            firstNotBlockedOrCritical: describeReq(
              reqs.find((q) => {
                const k = urgentKind(pl, q[1])
                return k !== 'blocked' && k !== 'critical'
              }),
              pl,
              t,
            ),
            firstOutsideUrgent: describeReq(
              reqs.find((q) => classOf(pl, q[1], N) !== CLS.urgent),
              pl,
              t,
            ),
            l1FullyRequestedMs: l1At === null ? null : round(l1At - t),
            outsideWindowBeforeThat: outside.length,
            outsideWindowPieces: [...new Set(outside.map((q) => q[1]))].slice(0, 20),
            firstL2Ms: ms(firstOf(CLS.l2), t),
            firstL3Ms: ms(firstOf(CLS.l3), t),
            hotVerifiedMs: hotVerified === null ? null : round(hotVerified - t),
            l1VerifiedMs: l1Verified === null ? null : round(l1Verified - t),
          }
        })
        const t0 = Math.min(...plans.map((x) => x.t))
        const all = r.viewers.map((v) => ({ reqs: v.logs.req, verified: v.logs.verified }))
        const union = {
          l1FullyRequestedMs: ms(fullyRequestedAt(L1, all, r.manifest, N, t0), t0),
          l2FullyRequestedMs: ms(fullyRequestedAt(L2, all, r.manifest, N, t0), t0),
          l3FullyRequestedMs: ms(fullyRequestedAt(L3, all, r.manifest, N, t0), t0),
          // the order pieces were first asked for after the seek (any viewer), against the cyclic rank from p
          firstAskOrder: firstAskOrder(r.viewers, t0, p, N),
        }
        // what the host sent after the seek before it had sent the whole window once: the cost of reveals made for
        // the old position, which viewers still fetch when their host wire offers nothing better (ADR 0003 F3)
        const served = r.host.logs.served.filter((s) => s[0] >= t0)
        const sentOnce = new Map<number, Set<number>>()
        let l1SentAt: number | null = null
        const before: Record<string, number> = { urgentOrL1: 0, l2: 0, l3: 0 }
        for (const [t, piece, offset, length] of served) {
          const k = classOf(plan, piece, N)
          if (l1SentAt === null) {
            const key = k === CLS.urgent || k === CLS.l1 ? 'urgentOrL1' : k === CLS.l2 ? 'l2' : 'l3'
            before[key] = (before[key] ?? 0) + length
          }
          let s = sentOnce.get(piece)
          if (!s) {
            s = new Set()
            sentOnce.set(piece, s)
          }
          s.add(offset)
          if (l1SentAt === null && L1.every((i) => (sentOnce.get(i)?.size ?? 0) >= blocksOf(i, r.manifest, N)))
            l1SentAt = t
        }
        // Until the viewers together had requested the whole window, what each asked the host for outside urgent ∪ L1
        // (in the plan the request was made under) must be (a) a piece the host showed it before the seek: the old
        // position's reveals, which a seek does not take back (ADR 0003 Follow-up 3 clears only the budgets), and
        // which a wire fetches when its peer offers nothing better (F3); or (b) a piece the host revealed to it only
        // once every window piece had been given out (held, shown or assigned). Anything else would be the host
        // revealing past the window early. Requests on viewer wires are F3's idle links fetching the wrap.
        const { host } = r
        const tG = need(
          host.logs.gplan.find(
            (g) => g.t >= tSeek && g.seek && g.posS !== null && Math.abs(g.posS - SEEK_TARGET_S) < 0.5,
          ),
          'host: a seek group plan',
        ).t
        const l1Union = fullyRequestedAt(L1, all, r.manifest, N, t0) ?? Number.POSITIVE_INFINITY
        const shownBefore = new Map(r.viewers.map((v) => [v.tag, shownAt(host.logs, v.tag, tG)]))
        const heldBefore = (i: number): boolean =>
          r.viewers.some((v) => v.logs.verified.some(([t, x]) => x === i && t < tG))
        let windowGivenAt = tG
        for (const i of L1) {
          if (heldBefore(i) || [...shownBefore.values()].some((s) => s.has(i))) continue
          const at = host.logs.reveal.find((x) => x[0] >= tG && x[2] === i)?.[0]
          windowGivenAt = Math.max(windowGivenAt, at ?? Number.POSITIVE_INFINITY)
        }
        const hot = need(plan.hot, 'hot window')
        const outside = { toHostOldReveals: 0, toHostAfterWindowGiven: 0, onViewerWires: 0 }
        const early: object[] = []
        // the first request of any kind (a reader blocked at the old position comes first: group 1), the first for a
        // piece of the new window [p, p+w], and the first for one of its pieces past the hot window
        let firstReq: ReqRec | null = null
        let firstWindowReq: ReqRec | null = null
        let firstL1Req: ReqRec | null = null
        for (const { v, t } of plans) {
          for (const q of v.logs.req) {
            if (q[0] < t) continue
            if (!firstReq || q[0] < firstReq[0]) firstReq = q
            if (q[1] >= p && q[1] <= p + w) {
              if (!firstWindowReq || q[0] < firstWindowReq[0]) firstWindowReq = q
              if (q[1] > hot[1] && (!firstL1Req || q[0] < firstL1Req[0])) firstL1Req = q
            }
            if (q[4] === CLS.urgent || q[4] === CLS.l1 || q[0] >= l1Union) continue
            if (q[3] !== host.tag) outside.onViewerWires++
            else if (shownBefore.get(v.tag)?.has(q[1])) outside.toHostOldReveals++
            else {
              const shownAfter = host.logs.reveal.find((x) => x[1] === v.tag && x[2] === q[1] && x[0] >= tG)?.[0]
              if (shownAfter !== undefined && shownAfter >= windowGivenAt) outside.toHostAfterWindowGiven++
              else if (early.length < 20) early.push({ viewer: v.name, ms: round(q[0] - t0), piece: q[1], cls: q[4] })
            }
          }
        }
        const reqOut = (q: ReqRec | null): object | null =>
          q ? { ms: round(q[0] - t0), piece: q[1], viewer: r.names.get(q[3]) ?? q[3], cls: clsName(q[4]) } : null
        const out = {
          expectedP: exp.p,
          plan: { p, w, hot: plan.hot, L1: [p, p + w], L2: [p + w + 1, N - 1], L3: [0, p - 1] },
          perViewer,
          union,
          unionRule: {
            firstRequest: reqOut(firstReq),
            firstWindowRequest: reqOut(firstWindowReq),
            firstL1RequestPastHot: reqOut(firstL1Req),
            windowGivenOutMs: ms(Number.isFinite(windowGivenAt) ? windowGivenAt : null, t0),
            outsideBeforeWindowRequested: outside,
            early,
          },
          host: { l1SentOnceMs: ms(l1SentAt, t0), bytesBeforeThat: before },
        }
        results.set('roomB.r6.union', out)
        say('(1) R6 per viewer', perViewer)
        say('(1) R6 union', union, out.unionRule, out.host)
        const { l1FullyRequestedMs: a, l2FullyRequestedMs: b, l3FullyRequestedMs: c } = union
        expect(a).not.toBeNull()
        expect(b).not.toBeNull()
        expect(c).not.toBeNull()
        expect(a ?? Infinity).toBeLessThanOrEqual(b ?? -Infinity)
        expect(b ?? Infinity).toBeLessThanOrEqual(c ?? -Infinity)
        // the first request for the new window is in the hot window that starts at p
        expect(firstWindowReq?.[1]).toBeGreaterThanOrEqual(hot[0])
        expect(firstWindowReq?.[1]).toBeLessThanOrEqual(hot[1])
        expect(early, JSON.stringify(out.unionRule)).toEqual([])
      })

      it('(6) drift after the seek: p95 |viewer - host| < 100 ms', () => {
        const r = need(room, 'room')
        const opts = {
          settleMs: SETTLE_MS,
          maxRttMs: MAX_RTT_MS,
          maxGapMs: 600,
          prop: 'audio-pts' as const,
          from: tResumed,
        }
        const perViewer = r.viewers.map((v) => ({ name: v.name, ...driftVsHost(r.host.logs, v.logs, opts) }))
        const out = {
          perViewer: perViewer.map((x) => ({ name: x.name, abs: x.abs, signed: x.signed, dropped: x.dropped })),
          loadavg: loadavg(),
        }
        results.set('roomB.drift', out)
        say(
          '(6) drift room B',
          out.perViewer.map((x) => ({ name: x.name, abs: x.abs })),
        )
        for (const x of perViewer) {
          expect(x.abs.n, `${x.name}: samples`).toBeGreaterThan(40)
          expect(x.abs.p95, `${x.name}: p95 |drift|`).toBeLessThan(100)
        }
      })
    })
  },
)

function range(a: number, b: number): number[] {
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

function ms(t: number | null, t0: number): number | null {
  return t === null ? null : round(t - t0)
}

function clsName(c: number): string {
  return c === CLS.urgent ? 'urgent' : c === CLS.l1 ? 'L1' : c === CLS.l2 ? 'L2' : c === CLS.l3 ? 'L3' : 'none'
}

/** When every piece of `pieces` was verified at v (or before t0: t0); null if not all were. */
function verifiedAll(v: AlphaMember, pieces: readonly number[], t0: number): number | null {
  let latest = t0
  for (const i of pieces) {
    const at = v.logs.verified.find(([, x]) => x === i)?.[0]
    if (at === undefined) return null
    latest = Math.max(latest, at)
  }
  return latest
}

/**
 * The pieces in the order any viewer first asked for them after t0, against their cyclic rank from p (L1, L2 to the
 * end, then L3 from 0): the share of consecutive pairs in rank order, and the longest run back.
 */
function firstAskOrder(viewers: readonly AlphaMember[], t0: number, p: number, N: number): object {
  const firstAsk = new Map<number, number>()
  for (const v of viewers) {
    for (const [t, piece] of v.logs.req) {
      if (t < t0) continue
      const prev = firstAsk.get(piece)
      if (prev === undefined || t < prev) firstAsk.set(piece, t)
    }
  }
  const seq = [...firstAsk].sort((a, b) => a[1] - b[1]).map(([i]) => i)
  const rank = (i: number): number => (i - p + N) % N
  let inOrder = 0
  for (let k = 1; k < seq.length; k++) if (rank(seq[k] ?? 0) >= rank(seq[k - 1] ?? 0)) inOrder++
  const firstL3 = seq.findIndex((i) => i < p)
  const l2AfterFirstL3 = firstL3 < 0 ? 0 : seq.slice(firstL3).filter((i) => i > p).length
  return {
    pieces: seq.length,
    pairsInRankOrder: round(inOrder / Math.max(1, seq.length - 1), 3),
    first12: seq.slice(0, 12),
    firstL3Index: firstL3,
    l2PiecesAskedAfterFirstL3: l2AfterFirstL3,
    medianRankJump: percentile(
      seq.slice(1).map((x, k) => rank(x) - rank(seq[k] ?? 0)),
      0.5,
    ),
  }
}

/**
 * When each viewer's wire first reached the host's Revealer (its first bitfield), any take-back (a viewer alone for a
 * moment was shown everything), and what the host served for pieces it did not show the requester at that moment,
 * with the dupFactor that is left without those blocks.
 */
function stripingBookkeeping(r: AlphaRoom, critical: readonly number[]): object {
  const { host } = r
  const name = (t: string): string => r.names.get(t) ?? t
  const t0 = Math.min(...host.logs.bitfield.map((b) => b.t))
  const u = unrevealedServed(host.logs)
  const kept = new Set(u.served)
  const rest = host.logs.served.filter((x) => !kept.has(x))
  return {
    wires: host.logs.bitfield.map((b) => ({ viewer: name(b.viewer), atS: round((b.t - t0) / 1000, 2) })),
    takebacks: host.logs.takeback.map((b) => ({
      viewer: name(b.viewer),
      atS: round((b.t - t0) / 1000, 2),
      pieces: b.pieces.length,
    })),
    unrevealedServed: Object.fromEntries(
      [...u.perViewer].map(([v, o]) => [name(v), { blocks: o.blocks, mib: round(o.bytes / 1048576, 1) }]),
    ),
    dupWithoutUnrevealed: dupFactor(rest, critical, r.pieceCount).dupAll,
  }
}
