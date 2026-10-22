/// <reference lib="dom" />
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test'
import { APP_PUSH, type SessionReport, type WtBridge } from '../../src/shared/ipc/app'

// M7 app shell wiring in main and preload: session reports drive hide-on-close and the "Leave room?" quit prompt,
// and app commands (the tray menu's) reach the renderer. The native message box is stubbed in main.

let app: ElectronApplication
let page: Page
let userData: string

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'wt-e2e-shell-'))
  app = await electron.launch({
    args: ['out/main/index.js'],
    colorScheme: null,
    env: { ...process.env, WT_USER_DATA: userData, WT_FAKE_PLAYER: '1' },
  })
  page = await app.firstWindow()
  await expect(page.getByTestId('core-status')).toContainText('Background process connected')
})

test.afterAll(async () => {
  await report({ inRoom: false, title: null }) // or the close below would ask "Leave room?"
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

// reportSession is fire-and-forget; IPC from one renderer arrives in order, so the invoke after it returns only once
// main has handled the report.
const report = (r: SessionReport): Promise<void> =>
  page.evaluate(async (x) => {
    const { app: api } = (window as unknown as { wt: WtBridge }).wt
    api.reportSession?.(x)
    await api.info()
  }, r)

const windowState = (): Promise<{ count: number; visible: boolean }> =>
  app.evaluate(({ BrowserWindow }) => {
    const wins = BrowserWindow.getAllWindows()
    return { count: wins.length, visible: wins[0]?.isVisible() ?? false }
  })

test('the preload exposes the M7 app methods', async () => {
  const methods = await page.evaluate(() => {
    const a = (window as unknown as { wt: WtBridge }).wt.app
    return [typeof a.recheckMpv, typeof a.reportSession, typeof a.onAppCommand]
  })
  expect(methods).toEqual(['function', 'function', 'function'])
})

test('an app command opens Settings', async () => {
  await app.evaluate(({ BrowserWindow }, channel) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(channel, 'open-settings')
  }, APP_PUSH.command)
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.keyboard.press('Escape')
})

test('in a room, closing the window hides it', async () => {
  await report({ inRoom: true, title: 'Movie.mkv' })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(windowState).toEqual({ count: 1, visible: false })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
  await expect.poll(windowState).toEqual({ count: 1, visible: true })
})

test('in a room, quitting asks first and No keeps the app running', async () => {
  await report({ inRoom: true, title: 'Movie.mkv' })
  await app.evaluate(({ app: electronApp, dialog }) => {
    const g = globalThis as { __asked?: number }
    g.__asked = 0
    dialog.showMessageBox = () => {
      g.__asked = (g.__asked ?? 0) + 1
      return Promise.resolve({ response: 1, checkboxChecked: false }) // Cancel
    }
    electronApp.quit()
  })
  await expect.poll(() => app.evaluate(() => (globalThis as { __asked?: number }).__asked)).toBe(1)
  // still alive and talking to core
  await expect(page.getByTestId('core-status')).toContainText('Background process connected')
  expect((await windowState()).count).toBe(1)
  // and closing hides again (the cancelled quit no longer counts as quitting)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(windowState).toEqual({ count: 1, visible: false })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show())
})
