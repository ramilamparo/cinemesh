/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test'
import type { WtBridge } from '../../src/shared/ipc/app'
import type { MpvInfo } from '../../src/shared/ipc/control'
import type { Result } from '../../src/shared/result'

// M7 main-process wiring against the built app: main finds the real mpv on this machine (0.41 or newer), Settings
// → mpv program → Save re-runs the lookup, recheckMpv returns it, and Copy diagnostics reports it. Native dialogs
// and the clipboard are stubbed in main so the test neither blocks nor touches the real clipboard.

const mpvOnPath = ((): string | null => {
  try {
    // the same PATH search main does, so the fallback below lands on this exact path
    return execFileSync('sh', ['-c', 'command -v mpv'], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
})()

let app: ElectronApplication
let page: Page
let userData: string

test.skip(mpvOnPath === null, 'needs mpv on PATH')

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'wt-e2e-mpv-'))
  app = await electron.launch({
    args: ['out/main/index.js'],
    colorScheme: null,
    env: { ...process.env, WT_USER_DATA: userData, WT_FAKE_PLAYER: '1' },
  })
  page = await app.firstWindow()
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
  rmSync(userData, { recursive: true, force: true })
})

/** The next "Locate mpv…" (or any open dialog) answers with this path. */
async function answerOpenDialog(path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] })
  }, path)
}

const recheck = (): Promise<Result<MpvInfo> | null> =>
  page.evaluate(async () => (await (window as unknown as { wt: WtBridge }).wt.app.recheckMpv?.()) ?? null)

const copied = (): Promise<string> => app.evaluate(() => (globalThis as { __copied?: string[] }).__copied?.at(-1) ?? '')

const savedMpvPath = (): unknown =>
  (JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as { mpvPath?: unknown }).mpvPath

test('boots to Home with the core connected and mpv found', async () => {
  await expect(page.getByRole('heading', { name: 'Cinemesh' })).toBeVisible()
  await expect(page.getByTestId('core-status')).toContainText('Background process connected')
  const r = await recheck()
  expect(r?.ok).toBe(true)
  if (r?.ok) {
    expect(r.value.status).toBe('ok')
    expect(r.value.path).not.toBeNull()
    expect(r.value.version).toMatch(/^0\.(39|[4-9]\d)\./)
  }
})

test('Settings → mpv program → Save rechecks with that path', async () => {
  const mpv = mpvOnPath ?? ''
  await answerOpenDialog(mpv)
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Locate mpv…' }).click()
  await expect(dialog.getByText(mpv, { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(savedMpvPath).toBe(mpv)

  const r = await recheck()
  expect(r).toMatchObject({ ok: true, value: { status: 'ok', path: mpv, kind: 'system' } })
  if (r?.ok) expect(r.value.tried?.[0]).toMatchObject({ source: 'settings', path: mpv, status: 'ok' })
})

test('an mpvPath that is not mpv is reported and the lookup falls back to PATH', async () => {
  const notMpv = join(userData, 'not-mpv')
  writeFileSync(notMpv, '#!/bin/sh\necho "hello, I am not mpv"\n', { mode: 0o755 })
  await answerOpenDialog(notMpv)
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Locate mpv…' }).click()
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(savedMpvPath).toBe(notMpv)

  const r = await recheck()
  expect(r).toMatchObject({ ok: true, value: { status: 'ok', path: mpvOnPath } })
  if (r?.ok) {
    expect(r.value.tried?.[0]).toMatchObject({ source: 'settings', path: notMpv, status: 'unusable' })
    expect(r.value.tried?.at(-1)).toMatchObject({ source: 'path', status: 'ok' })
  }
  // the app is still on Home: mpv is usable, so MpvSetup does not take over
  await expect(page.getByRole('heading', { name: 'Cinemesh' })).toBeVisible()
})

// Last: its toast sits over the Settings footer until it times out.
test("Copy diagnostics reports main's latest mpv lookup", async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Copy diagnostics' }).click()
  await expect(page.getByText('Diagnostics copied.')).toBeVisible()
  const report = await copied()
  expect(report).toContain('### mpv')
  expect(report).toContain(`- Found: system at ${mpvOnPath ?? ''}, version `)
  expect(report).toMatch(/version 0\.\d+\.\d+\S* \(ok\)/)
  expect(report).toMatch(
    / {2}- tried settings: \S*not-mpv → unusable \(unrecognised version output: hello, I am not mpv\)/,
  )
  expect(report).toMatch(/ {2}- tried path: \S*mpv → ok 0\.\d+/)
  await page.keyboard.press('Escape')
})
