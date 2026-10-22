/// <reference lib="dom" />
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from '@playwright/test'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import type { WtBridge } from '../../src/shared/ipc/app'
import { HAVE_FFMPEG, fixture } from '../integration/media/fixtures'

// M8 alpha through the real UI: two app instances on a local DHT testnet (fake players). A hosts a video,
// B pastes the invite, confirms the folder and lands in the room; A's Play reaches B.

test.skip(!HAVE_FFMPEG, 'needs ffmpeg for the fixture')
test.setTimeout(120_000)

let testnet: Testnet
const dirs: string[] = []
const apps: ElectronApplication[] = []

interface Instance {
  name: string
  app: ElectronApplication
  page: Page
  userData: string
}

async function launch(name: string, bootstrap: string): Promise<Instance> {
  const userData = mkdtempSync(join(tmpdir(), `wt-e2e-${name}-`))
  dirs.push(userData)
  const app = await electron.launch({
    args: ['out/main/index.js'],
    colorScheme: null,
    env: { ...process.env, WT_USER_DATA: userData, WT_FAKE_PLAYER: '1', WT_BOOTSTRAP: bootstrap },
  })
  apps.push(app)
  const page = await app.firstWindow()
  await expect(page.getByTestId('core-status')).toContainText('Background process connected')
  // a private download folder: the default is the real ~/Downloads/Watch Together
  await page.evaluate(
    ([n, dir]) => (window as unknown as { wt: WtBridge }).wt.app.setSettings({ displayName: n, downloadDir: dir }),
    [name, join(userData, 'downloads')] as const,
  )
  return { name, app, page, userData }
}

/** On failure: what each app shows and the end of its core log, so a CI failure explains itself. */
async function report(instances: Instance[]): Promise<string> {
  const parts: string[] = []
  for (const i of instances) {
    const text = await i.page
      .locator('body')
      .innerText({ timeout: 2000 })
      .catch((e: unknown) => `(no page text: ${String(e)})`)
    let log: string
    try {
      log = readFileSync(join(i.userData, 'logs', 'core.log'), 'utf8')
        .split('\n')
        .slice(-60)
        .join('\n')
    } catch (e) {
      log = `(no core.log: ${String(e)})`
    }
    parts.push(`==== ${i.name}: screen ====\n${text}\n==== ${i.name}: core.log (tail) ====\n${log}`)
  }
  return parts.join('\n')
}

test.beforeAll(async () => {
  testnet = await createTestnet(3)
})

test.afterAll(async () => {
  for (const app of apps) {
    // in a room, quitting asks "Leave room?": answer Leave (with no window the dialog would block the quit)
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = () => Promise.resolve({ response: 0, checkboxChecked: false })
      })
      .catch(() => undefined)
    const closed = app.close().then(
      () => true,
      () => false,
    )
    const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000))
    if (!(await Promise.race([closed, timedOut]))) app.process().kill('SIGKILL')
  }
  await testnet.destroy()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test('host and viewer meet through the UI and play in sync', async () => {
  const bootstrap = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
  const video = await fixture('mkv-cues.mkv')
  const a = await launch('Ana', bootstrap)
  const b = await launch('Ben', bootstrap)
  try {
    // A: host the fixture (the native file dialog is stubbed in main)
    await a.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [path] })
    }, video)
    await a.page.getByRole('button', { name: 'Host a video…' }).click()
    await a.page.getByRole('button', { name: 'Start hosting' }).click()
    await expect(a.page.getByRole('button', { name: 'Copy invite' })).toBeVisible({ timeout: 60_000 })
    await expect(
      a.page.getByRole('group', { name: 'Playback controls' }).getByRole('button', { name: 'Play', exact: true }),
    ).toBeVisible({ timeout: 60_000 })
    const invite = await a.page.evaluate(async () => {
      const r = await (window as unknown as { wt: WtBridge }).wt.core.request('room.invite', {})
      if (!r.ok) throw new Error(r.message)
      return r.value.link
    })

    // B: paste the invite, confirm the folder, land in the room
    await b.page.locator('#invite-input').fill(invite)
    await b.page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(b.page.getByText('mkv-cues.mkv').first()).toBeVisible({ timeout: 60_000 })
    await b.page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(b.page.getByRole('button', { name: 'Copy invite' })).toBeVisible({ timeout: 60_000 })

    // A presses Play; B's transport flips to Pause
    await a.page
      .getByRole('group', { name: 'Playback controls' })
      .getByRole('button', { name: 'Play', exact: true })
      .click()
    // exact: the viewer also has "Ask host to pause" while only the host controls playback
    await expect(
      b.page.getByRole('group', { name: 'Playback controls' }).getByRole('button', { name: 'Pause', exact: true }),
    ).toBeVisible({ timeout: 30_000 })

    // each sees the other in the peer list
    await expect(a.page.getByRole('listitem', { name: 'Ben' })).toBeVisible({ timeout: 15_000 })
    await expect(b.page.getByRole('listitem', { name: 'Ana' })).toBeVisible({ timeout: 15_000 })
  } catch (e) {
    console.log(await report([a, b]))
    throw e
  }
})
