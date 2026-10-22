/// <reference lib="dom" />
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test'
import type { WtBridge } from '../../src/shared/ipc/app'
import type { MpvInfo } from '../../src/shared/ipc/control'
import type { Result } from '../../src/shared/result'

// The built app on a computer without mpv, as CI's e2e runners are: main's lookup finds none, and core still comes
// up. A user gets MpvSetup, a connected one (Check again and Copy diagnostics reach main and core); the fake player
// (WT_FAKE_PLAYER) needs no mpv, so with it the app boots to Home as usual. Runs whether this machine has mpv or not:
// it takes mpv off PATH.

/** What main's lookup runs on PATH: mpv, and flatpak for io.mpv.Mpv. */
const LOOKED_UP = new Set(['mpv', 'mpv.exe', 'mpv.com', 'flatpak'])

/** On macOS the lookup also tries Homebrew's directories, whatever PATH says: an mpv there cannot be hidden. */
const brewMpv =
  process.platform === 'darwin' && ['/opt/homebrew/bin/mpv', '/usr/local/bin/mpv'].some((p) => existsSync(p))

/**
 * process.env with mpv off PATH. A directory on it holding mpv (or flatpak) is replaced by a directory of symlinks to
 * everything else in it, so the rest of PATH still works; on Windows such a directory is left out.
 */
function envWithoutMpv(scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Windows spells it Path; one key, or the child could see either
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const dirs = (env[key] ?? '').split(delimiter).filter(Boolean)
  const kept = dirs.flatMap((dir, i) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return [dir]
    }
    if (!names.some((n) => LOOKED_UP.has(n.toLowerCase()))) return [dir]
    if (process.platform === 'win32') return []
    const copy = join(scratch, `path-${String(i)}`)
    mkdirSync(copy)
    for (const n of names) if (!LOOKED_UP.has(n.toLowerCase())) symlinkSync(join(dir, n), join(copy, n))
    return [copy]
  })
  env[key] = kept.join(delimiter)
  delete env.WT_FAKE_PLAYER // CI sets it for every test; each describe below says what it runs with
  return env
}

let scratch: string
let noMpvEnv: NodeJS.ProcessEnv

test.skip(brewMpv, 'cannot hide a Homebrew mpv from the lookup')

test.beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'wt-e2e-nompv-'))
  noMpvEnv = envWithoutMpv(scratch)
})

test.afterAll(() => rmSync(scratch, { recursive: true, force: true }))

async function launch(name: string, extra: NodeJS.ProcessEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['out/main/index.js'],
    colorScheme: null,
    env: { ...noMpvEnv, ...extra, WT_USER_DATA: join(scratch, name) },
  })
  return { app, page: await app.firstWindow() }
}

const recheck = (page: Page): Promise<Result<MpvInfo> | null> =>
  page.evaluate(async () => (await (window as unknown as { wt: WtBridge }).wt.app.recheckMpv?.()) ?? null)

test.describe('a user without mpv', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    ;({ app, page } = await launch('user', {}))
    await app.evaluate(({ clipboard }) => {
      const g = globalThis as { __copied?: string[] }
      g.__copied = []
      clipboard.writeText = (text: string) => {
        g.__copied?.push(text)
        return Promise.resolve()
      }
    })
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('gets MpvSetup, with the core connected', async () => {
    // core's snapshot is what sends the window there: no core, no MpvSetup (Home's "Starting background process…")
    await expect(page.getByRole('heading', { name: 'Cinemesh needs mpv' })).toBeVisible()
    await expect(page.locator('[data-screen="mpv-setup"]')).toBeVisible()
    await page.getByRole('button', { name: 'Copy diagnostics' }).click()
    const copied = (): Promise<string> =>
      app.evaluate(() => (globalThis as { __copied?: string[] }).__copied?.at(-1) ?? '')
    await expect.poll(copied).toContain('## Cinemesh diagnostics')
    const report = await copied()
    // core answered diagnostics.get: its protocol and uptime are in the report
    expect(report).toMatch(/^- Core protocol \d+$/m)
    expect(report).toMatch(/^- Uptime \d+ s/m)
    expect(report).toContain('- Found: none, version unknown (missing)')
  })

  test('Check again looks again, and still finds none', async () => {
    await page.getByRole('button', { name: 'Check again' }).click()
    await expect(page.getByText('mpv was still not found.')).toBeVisible()
    expect(await recheck(page)).toMatchObject({ ok: true, value: { status: 'missing', path: null } })
    await expect(page.getByRole('heading', { name: 'Cinemesh needs mpv' })).toBeVisible()
  })
})

test.describe('the fake player (WT_FAKE_PLAYER=1), without mpv', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    ;({ app, page } = await launch('fake', { WT_FAKE_PLAYER: '1' }))
  })

  test.afterAll(async () => {
    await app.close()
  })

  test('boots to Home with the core connected, and stays there', async () => {
    await expect(page.getByTestId('core-status')).toContainText('Background process connected')
    await expect(page.locator('[data-screen="home"]')).toBeVisible()
    // main still reports what it found; the fake player does not need it
    expect(await recheck(page)).toMatchObject({ ok: true, value: { status: 'missing', path: null } })
    await expect(page.getByRole('region', { name: 'Join a room' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Cinemesh needs mpv' })).toBeHidden()
  })
})
