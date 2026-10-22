/// <reference lib="dom" />
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test'
import createTestnet from 'hyperdht/testnet.js'
import { HAVE_FFMPEG, fixture } from '../integration/media/fixtures'

// M7 UI smoke test against the built app with the fake player: boot, theme toggle, Settings save and
// validation (with a toast showing, which must not block the dialog's buttons), and the minimum window size.
// Then, on its own instance and a local DHT testnet: hosting a video and ending the room, where the Room
// must lock (a disabled fieldset, which happy-dom cannot check) while the leave runs.

let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'wt-e2e-ui-'))
  app = await electron.launch({
    args: ['out/main/index.js'],
    colorScheme: null,
    env: { ...process.env, WT_USER_DATA: userData, WT_FAKE_PLAYER: '1' },
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

const savedSettings = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')) as Record<string, unknown>

test('boots to Home with the core connected', async () => {
  await expect(page.getByRole('heading', { name: 'Watch together' })).toBeVisible()
  await expect(page.getByTestId('core-status')).toContainText('Background process connected')
  await expect(page.getByRole('region', { name: 'Join a room' })).toBeVisible()
})

test('theme toggles flip the tokens', async () => {
  const bg = (): Promise<string> =>
    page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())
  await page.getByRole('radio', { name: 'Dark' }).click()
  await expect.poll(bg).toBe('#121317')
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect.poll(bg).toBe('#ffffff')
  expect(savedSettings().theme).toBe('light')
})

test('Settings opens, rejects a bad value and saves a good one', async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()

  await dialog.getByLabel('UDP port').fill('80')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog.getByText('UDP port must be between 1024 and 65535')).toBeVisible()
  expect(savedSettings().udpPort).toBeNull()

  // a toast while the dialog is open must not cover its buttons (it used to block Save for ~6 s)
  await dialog.getByRole('button', { name: 'Copy diagnostics' }).click()
  const toasts = page.getByRole('region', { name: 'Notifications' })
  await expect(toasts.locator('[role="status"], [role="alert"]').first()).toBeVisible()

  await dialog.getByLabel('UDP port').fill('')
  await dialog.getByLabel('Display name').fill('E2E Tester')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click({ timeout: 2000 })
  await expect(dialog).toBeHidden()
  await expect.poll(() => savedSettings().displayName).toBe('E2E Tester')
  await expect(page.getByLabel('Display name (what friends see)')).toHaveValue('E2E Tester')
})

test('Escape closes Settings', async () => {
  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden()
})

test('Home fits the minimum window size without horizontal scrolling', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(720, 520))
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(720)
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main')
    return main ? main.scrollWidth - main.clientWidth : 0
  })
  expect(overflow).toBeLessThanOrEqual(0)
})

/** What the page showed the moment the leaving banner appeared (the leave itself may take only a moment). */
interface LeavingSeen {
  text: string
  controls: number
  enabled: string[]
  slider: string | null
}

test('hosting, then ending the room: the Room locks while leaving, then Home', async () => {
  test.skip(!HAVE_FFMPEG, 'needs ffmpeg for the fixture')
  test.setTimeout(120_000)
  const testnet = await createTestnet(3)
  const dir = mkdtempSync(join(tmpdir(), 'wt-e2e-ui-host-'))
  const bootstrap = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  const host = await electron.launch({
    args: ['out/main/index.js'],
    colorScheme: null,
    env: { ...process.env, WT_USER_DATA: dir, WT_FAKE_PLAYER: '1', WT_BOOTSTRAP: bootstrap },
  })
  const p = await host.firstWindow()
  try {
    await expect(p.getByTestId('core-status')).toContainText('Background process connected')
    const video = await fixture('mkv-cues.mkv')
    await host.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] })
    }, video)
    await p.getByRole('button', { name: 'Host a video…' }).click()
    await p.getByRole('button', { name: 'Start hosting' }).click()
    // the header's Leave exists only in the Room (HostPrepare has Cancel)
    const leave = p.getByRole('button', { name: 'Leave', exact: true })
    await expect(leave).toBeVisible({ timeout: 60_000 })

    await p.evaluate(() => {
      const w = window as unknown as { leavingSeen?: LeavingSeen }
      const observer = new MutationObserver(() => {
        const banner = document.querySelector('[data-testid="leaving"]')
        const body = document.querySelector('[data-testid="room-body"]')
        if (!banner || !body || w.leavingSeen) return
        const controls = [...body.querySelectorAll('button, input, select, textarea')]
        w.leavingSeen = {
          text: banner.textContent,
          controls: controls.length,
          enabled: controls.filter((c) => !c.matches(':disabled')).map((c) => c.outerHTML.slice(0, 120)),
          slider: body.querySelector('[role="slider"]')?.getAttribute('aria-disabled') ?? null,
        }
        observer.disconnect()
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })
    await leave.click()
    await p
      .getByRole('dialog', { name: 'Leave the room?' })
      .getByRole('button', { name: 'End room for everyone' })
      .click()
    await expect(p.getByRole('heading', { name: 'Watch together' })).toBeVisible({ timeout: 30_000 })

    const seen = await p.evaluate(() => (window as unknown as { leavingSeen?: LeavingSeen }).leavingSeen ?? null)
    // what runs: the window asked to end the room (core's 'leaving' event says 'end' as well)
    expect(seen?.text).toBe('Ending the room…')
    expect(seen?.controls).toBeGreaterThan(10)
    expect(seen?.enabled).toEqual([])
    expect(seen?.slider).toBe('true')
  } catch (e) {
    console.log(
      await p
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => '(no page text)'),
    )
    throw e
  } finally {
    // at Home nothing asks before quitting; answer anyway, so a failure above cannot hang the close
    await host
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false })
      })
      .catch(() => undefined)
    await host.close()
    await testnet.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
})
