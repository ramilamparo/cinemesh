import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import type { CoreToMain, MainToCore, MpvInfo, SelftestReport } from '../shared/ipc/control.js'
import type { CoreToRenderer, RendererToCore } from '../shared/ipc/core.js'
import { defaultSettings } from '../shared/settings.js'
import { themePayload } from '../shared/theme-tokens.js'

// Core's entry (index.ts) as main runs it, from source over the headless stdio transport: one JSON frame per line.

const ROOT = resolve(import.meta.dirname, '../..')
const root = mkdtempSync(join(tmpdir(), 'wt-core-entry-'))

type Frame = { ch: 'control'; m: MainToCore | CoreToMain } | { ch: 'rpc'; m: RendererToCore | CoreToRenderer }

class HeadlessCore {
  readonly control: CoreToMain[] = []
  readonly rpc: CoreToRenderer[] = []
  private readonly child: ChildProcessWithoutNullStreams
  private readonly exited: Promise<number | null>
  private stderr = ''

  /** `nodeArgs`: options for node itself, before the entry; `fakePlayer: false` runs it as the app does, with mpv */
  constructor(nodeArgs: string[] = [], opts: { fakePlayer?: boolean } = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, WT_FAKE_PLAYER: '1' }
    if (opts.fakePlayer === false) delete env.WT_FAKE_PLAYER
    // what env-first.ts must provide by itself here (main's fork env is not involved)
    delete env.WS_NO_BUFFER_UTIL
    delete env.WS_NO_UTF_8_VALIDATE
    const entry = join(ROOT, 'src/core/index.ts')
    this.child = spawn(process.execPath, [...nodeArgs, '--import', 'tsx', entry, '--stdio-transport'], {
      cwd: ROOT,
      env,
    })
    this.exited = new Promise((r) => this.child.once('exit', (code) => r(code)))
    this.child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()))
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let frame: Frame
      try {
        frame = JSON.parse(line) as Frame
      } catch {
        return
      }
      if (frame.ch === 'control') this.control.push(frame.m as CoreToMain)
      else this.rpc.push(frame.m as CoreToRenderer)
    })
  }

  /** Every frame in one write: they reach core together, as queued messages do when it starts. */
  send(...frames: Frame[]): void {
    this.child.stdin.write(frames.map((f) => `${JSON.stringify(f)}\n`).join(''))
  }

  async until<T>(find: () => T | undefined, what: string, ms = 30_000): Promise<T> {
    const t0 = Date.now()
    for (;;) {
      const hit = find()
      if (hit !== undefined) return hit
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; stderr: ${this.stderr.slice(-2000)}`)
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  async stop(): Promise<number | null> {
    this.send({ ch: 'control', m: { type: 'shutdown' } })
    const timer = setTimeout(() => this.child.kill(), 10_000)
    const code = await this.exited
    clearTimeout(timer)
    return code
  }
}

function initFrame(name: string, opts: { selftest?: boolean; mpv?: MpvInfo } = {}): Frame {
  const dir = mkdtempSync(join(root, `${name}-`))
  return {
    ch: 'control',
    m: {
      type: 'init',
      protocol: 1,
      appVersion: '0.0.0-test',
      paths: {
        userData: join(dir, 'userData'),
        logsDir: join(dir, 'logs'),
        downloadDir: join(dir, 'downloads'),
        resources: join(ROOT, 'resources'),
      },
      mpv: opts.mpv ?? { path: null, kind: 'none', version: null, status: 'missing' },
      settings: { ...defaultSettings(), downloadDir: join(dir, 'downloads') },
      theme: themePayload('system', 'light'),
      selftest: opts.selftest ?? false,
    },
  }
}

const req = (id: number, m: string, p: unknown = {}): Frame => ({
  ch: 'rpc',
  m: { t: 'req', id, m, p } as RendererToCore,
})

/** What a module's import and export-from declarations load, in order (`import type` loads nothing). */
function loads(file: string): string[] {
  const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  return src.statements.flatMap((st) => {
    if (!(ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) || !st.moduleSpecifier) return []
    const typeOnly = ts.isImportDeclaration(st)
      ? st.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
      : st.isTypeOnly
    if (typeOnly) return []
    return ts.isStringLiteral(st.moduleSpecifier) ? [st.moduleSpecifier.text] : []
  })
}

/** Every package core's own modules reach through static imports from `entry`: a bundle hoists them all above its code. */
function staticPackages(entry: string): Set<string> {
  const packages = new Set<string>()
  const seen = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const spec of loads(file)) {
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec.replace(/\.js$/, '.ts')))
      else packages.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : (spec.split('/')[0] ?? spec))
    }
  }
  visit(entry)
  return packages
}

describe('core entry (index.ts)', () => {
  it('sets its environment before any package that reads it at load can load, in a bundle too', () => {
    const entry = join(ROOT, 'src/core/index.ts')
    expect(loads(entry)[0]).toBe('./env-first.js')
    // WebTorrent's tracker client loads ws, which reads WS_NO_BUFFER_UTIL as it loads: in out/main/core.js a static
    // import of it would run before env-first.ts. The session side of core comes in with a dynamic import.
    const reached = staticPackages(entry)
    expect(reached).toContain('hyperdht') // the walk does reach packages
    expect(reached).not.toContain('webtorrent')
    expect(reached).not.toContain('ws')
  })
})

describe('core entry (index.ts) over the stdio transport', () => {
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('a window that connects while core starts gets a full snapshot, and every request it queued an answer', async () => {
    const core = new HeadlessCore()
    try {
      // a cold start from an invite link: main posts init and the window's port back to back, and the preload
      // sends hello and the requests it queued (Home's Recent rooms, the invite's join) the moment it has a port
      core.send(
        initFrame('early'),
        { ch: 'control', m: { type: 'renderer-port' } },
        { ch: 'rpc', m: { t: 'hello', v: 1 } },
        req(1, 'session.recent'),
        req(2, 'session.join', { invite: 'cinemesh://join/not-an-invite' }),
        req(3, 'app.ping'),
      )
      const answers = await core.until(() => {
        const res = core.rpc.filter((m) => m.t === 'res')
        return res.length === 3 ? res : undefined
      }, 'three answers')
      const snapshot = core.rpc.find((m) => m.t === 'snapshot')?.d
      expect(snapshot?.session?.phase).toBe('idle')
      // no mpv in init, but the fake player needs none: Home, not MpvSetup
      expect(snapshot?.player?.status).toBe('absent')
      const byId = new Map(answers.map((a) => [a.id, a]))
      expect(byId.get(1)).toMatchObject({ ok: true, v: [] })
      // the join reached its handler: it fails on the invite, not for want of a handler
      expect(byId.get(2)).toMatchObject({ ok: false })
      expect(byId.get(2)).not.toMatchObject({ code: 'not-implemented' })
      expect(byId.get(3)).toMatchObject({ ok: true, v: { pong: true } })
      expect(core.control.map((m) => m.type)).toContain('ready')
    } finally {
      expect(await core.stop()).toBe(0)
    }
  }, 60_000)

  it('sends the window to MpvSetup when main found no mpv, but not with a fake player (WT_FAKE_PLAYER)', async () => {
    const idlePlayer = async (fakePlayer: boolean): Promise<string | undefined> => {
      const core = new HeadlessCore([], { fakePlayer })
      try {
        // main found no mpv (initFrame's default): how a user without it, and CI's e2e runners, start
        const hello: Frame = { ch: 'rpc', m: { t: 'hello', v: 1 } }
        core.send(initFrame(`mpv-${String(fakePlayer)}`), { ch: 'control', m: { type: 'renderer-port' } }, hello)
        // core does come up either way: MpvSetup is a screen of a connected window
        await core.until(() => core.control.find((m) => m.type === 'ready'), 'ready')
        const snapshot = await core.until(() => core.rpc.find((m) => m.t === 'snapshot')?.d, 'the snapshot')
        return snapshot.player?.status
      } finally {
        expect(await core.stop()).toBe(0)
      }
    }
    const [real, fake] = await Promise.all([idlePlayer(false), idlePlayer(true)])
    expect(real).toBe('missing')
    expect(fake).toBe('absent')
  }, 60_000)

  it('starts once when init comes twice', async () => {
    const core = new HeadlessCore()
    try {
      core.send(
        initFrame('twice'),
        initFrame('twice'),
        { ch: 'control', m: { type: 'renderer-port' } },
        req(1, 'app.ping'),
      )
      await core.until(() => core.rpc.find((m) => m.t === 'res'), 'the ping')
      // a second start would emit idle again and send a second ready
      await new Promise((r) => setTimeout(r, 300))
      expect(core.control.filter((m) => m.type === 'ready')).toHaveLength(1)
    } finally {
      expect(await core.stop()).toBe(0)
    }
  }, 60_000)

  it("loads WebTorrent with ws's native addons off, and reports main's mpv lookup in the selftest", async () => {
    const core = new HeadlessCore()
    try {
      const mpv: MpvInfo = { path: '/usr/bin/mpv', kind: 'system', version: '0.41.0' }
      core.send(initFrame('selftest', { selftest: true, mpv }))
      const report = await core.until(
        () =>
          core.control.find((m): m is { type: 'selftest'; report: SelftestReport } => m.type === 'selftest')?.report,
        'the selftest report',
        60_000,
      )
      const addons = report.checks.find((c) => c.name === 'loaded native addons')
      expect(addons, JSON.stringify(report.checks, null, 2)).toMatchObject({ ok: true })
      expect(addons?.detail).not.toMatch(/bufferutil|utf-8-validate/)
      // WebTorrent did load: the selftest seeded with it
      expect(report.checks.find((c) => c.name === 'webtorrent: no TCP listener')).toMatchObject({ ok: true })
      expect(report.mpv).toEqual({ ...mpv, status: 'ok' })
    } finally {
      expect(await core.stop()).toBe(0)
    }
  }, 90_000)

  it("fails the selftest when ws's native addon is loaded after all", async () => {
    // loaded before core starts, as it would be if the environment came too late
    const core = new HeadlessCore(['--require', join(ROOT, 'node_modules/bufferutil/index.js')])
    try {
      core.send(initFrame('loaded', { selftest: true }))
      const report = await core.until(
        () =>
          core.control.find((m): m is { type: 'selftest'; report: SelftestReport } => m.type === 'selftest')?.report,
        'the selftest report',
        60_000,
      )
      expect(report.ok).toBe(false)
      const addons = report.checks.find((c) => c.name === 'loaded native addons')
      expect(addons?.ok).toBe(false)
      expect(addons?.detail).toMatch(/unexpected addons loaded: \S*bufferutil/)
    } finally {
      expect(await core.stop()).toBe(0)
    }
  }, 90_000)
})
