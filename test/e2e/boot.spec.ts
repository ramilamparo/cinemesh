/// <reference lib="dom" />
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'

// M0: the built app boots to Home, the renderer reaches core through the brokered port,
// and the theme switch flips the CSS tokens.

let app: ElectronApplication
let userData: string

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'wt-e2e-'))
  app = await electron.launch({
    args: ['out/main/index.js'],
    // Playwright emulates prefers-color-scheme: light by default; let nativeTheme drive it instead.
    colorScheme: null,
    env: { ...process.env, WT_USER_DATA: userData, WT_FAKE_PLAYER: '1' },
  })
})

test.afterAll(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

test('boots to Home and connects to core', async () => {
  const page = await app.firstWindow()
  await expect(page.getByRole('heading', { name: 'Watch together' })).toBeVisible()
  await expect(page.getByTestId('core-status')).toContainText('Background process connected')
})

test('theme switch flips the colour tokens', async () => {
  const page = await app.firstWindow()
  const bg = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect.poll(bg).toBe('#121317')
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect.poll(bg).toBe('#ffffff')
})
