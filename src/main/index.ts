import { join } from 'node:path'
import { BrowserWindow, app } from 'electron'
import { CORE_PROTOCOL } from '../shared/ipc/core.js'
import { APP_PUSH } from '../shared/ipc/app.js'
import { registerAppScheme, serveRendererBundle } from './app-protocol.js'
import { CoreHost } from './core-host.js'
import { DeepLinks } from './deep-links.js'
import { registerIpc } from './ipc.js'
import { LINUX_APP_ID } from './linux-desktop.js'
import { log, setupMainLog } from './log.js'
import { MpvService } from './mpv-service.js'
import { configureUserData, defaultDownloadDir, isSeparateProfile, resourcesDir } from './paths.js'
import { bindPower } from './power.js'
import { QuitGuard } from './quit-guard.js'
import { SettingsStore } from './settings-store.js'
import { ThemeController } from './theme.js'
import { AppTray } from './tray.js'
import { createMainWindow, hardenSession } from './window.js'

// --selftest (or WT_SELFTEST=1): start core headless, run its packaged-build checks (spike S1), print
// the JSON report on stdout and exit 0/1. Used by CI against packaged apps.
const selftest = process.argv.includes('--selftest') || process.env.WT_SELFTEST === '1'

configureUserData()
// Packaged builds get the same name from package.json (electron-builder extraMetadata); this covers the rest.
if (process.platform === 'linux') app.setDesktopName(`${LINUX_APP_ID}.desktop`)
registerAppScheme()
const deepLinks = new DeepLinks()

const primary = selftest || isSeparateProfile() || app.requestSingleInstanceLock(deepLinks.lockData())
if (!primary) app.quit()
else void app.whenReady().then(main)

async function main(): Promise<void> {
  setupMainLog()
  log.info(`Watch Together ${app.getVersion()} (Electron ${process.versions.electron}) starting`)
  const settings = await SettingsStore.open(app.getPath('userData'))
  const theme = new ThemeController(settings.get().theme)
  const core = new CoreHost()
  // The first lookup runs while the window loads; core is forked once it is done, with the result in init.mpv.
  const mpv = new MpvService(app.isPackaged ? process.resourcesPath : null, log)
  const firstLookup = mpv.lookup(settings.get().mpvPath)
  const init = async () => ({
    type: 'init' as const,
    protocol: CORE_PROTOCOL,
    appVersion: app.getVersion(),
    paths: {
      userData: app.getPath('userData'),
      logsDir: app.getPath('logs'),
      downloadDir: settings.get().downloadDir ?? defaultDownloadDir(),
      resources: resourcesDir(),
    },
    mpv: await firstLookup,
    settings: settings.get(),
    theme: theme.payload(),
    selftest,
  })

  if (selftest) {
    core.once('selftest', (report) => {
      process.stdout.write(`${JSON.stringify(report)}\n`)
      void core.stop().finally(() => app.exit(report.ok ? 0 : 1))
    })
    core.start(await init())
    return
  }

  hardenSession()
  if (!process.env.ELECTRON_RENDERER_URL) serveRendererBundle()
  let tray: AppTray | null = null
  registerIpc({ settings, theme, deepLinks, mpv, onSessionReport: (r) => tray?.setSession(r) })
  deepLinks.registerAsDefault()

  settings.on('change', (s) => {
    theme.setSource(s.theme)
    core.post({ type: 'settings', settings: s })
    void mpv.settingsChanged(s.mpvPath)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(APP_PUSH.settings, s)
  })
  theme.on('change', (t) => {
    core.post({ type: 'theme', theme: t })
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(APP_PUSH.theme, t)
  })
  // Later lookups (mpvPath changed, recheck): core updates its player and emits a `player` event.
  mpv.on('change', (info) => core.post({ type: 'mpv', mpv: info }))
  core.on('crashed', (code) => log.error(`core crashed (${String(code)})`))
  const power = bindPower(core)

  const win = createMainWindow(theme.payload())
  win.webContents.on('did-finish-load', () => core.connectRenderer(win.webContents))
  const appTray = new AppTray(win)
  tray = appTray
  appTray.install()

  deepLinks.on('link', (link) => {
    if (!win.isDestroyed()) win.webContents.send(APP_PUSH.deepLink, link)
  })
  core.on('show-app', () => appTray.show())

  app.on('second-instance', (_e, argv, _cwd, additionalData) => {
    deepLinks.handleSecondInstance(argv, additionalData)
    appTray.show()
  })
  app.on('window-all-closed', () => app.quit())
  const quitGuard = new QuitGuard({
    // a running save asks too (worded for it): quitting stops the export until the next start
    inRoom: () => appTray.inRoom || appTray.saving,
    confirm: () => appTray.confirmQuit(),
    cancelled: () => appTray.cancelQuit(),
    shutdown: async () => {
      power.dispose()
      appTray.destroy()
      await core.stop()
    },
    quit: () => app.quit(),
  })
  app.on('before-quit', (e) => quitGuard.onBeforeQuit(e))

  core.start(await init()) // ignored when a quit already stopped the host during the lookup
  log.info(`userData ${app.getPath('userData')}; logs ${join(app.getPath('logs'))}`)
}
