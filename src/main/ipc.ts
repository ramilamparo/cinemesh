import { app, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, shell } from 'electron'
import { z } from 'zod'
import { APP_CHANNELS, type AppInfo, type SessionReport } from '../shared/ipc/app.js'
import type { MpvInfo } from '../shared/ipc/control.js'
import { extractInvite } from '../shared/invite-link.js'
import { type Result, err, ok } from '../shared/result.js'
import { SettingsSchema, type SettingsPatch } from '../shared/settings.js'
import type { DeepLinks } from './deep-links.js'
import { copyDiagnostics } from './diagnostics.js'
import { registerLinuxDeepLinks } from './linux-desktop.js'
import type { MpvService } from './mpv-service.js'
import { readDistro } from './os-release.js'
import type { SettingsStore } from './settings-store.js'
import type { ThemeController } from './theme.js'
import { parseSessionReport } from './tray.js'
import { isTrustedUrl } from './window.js'

interface Deps {
  settings: SettingsStore
  theme: ThemeController
  deepLinks: DeepLinks
  mpv: MpvService
  /** a validated session report from our renderer (the tray, hide-on-close and the quit prompt follow it) */
  onSessionReport: (report: SessionReport) => void
}

const VIDEO_EXTENSIONS = ['mkv', 'mp4', 'm4v', 'webm', 'mov', 'avi', 'ts', 'm2ts']
const SUBTITLE_EXTENSIONS = ['srt', 'ass', 'ssa', 'vtt']

// Only the shape is checked here; values are validated by mergeSettings against the full schema.
// (A .partial() schema would not do: zod 4 fills defaults into omitted keys and reset other settings.)
const PATCHABLE_KEYS = new Set(Object.keys(SettingsSchema.shape).filter((k) => k !== 'version'))
const SettingsPatchSchema = z
  .record(z.string(), z.unknown())
  .refine((o) => Object.keys(o).every((k) => PATCHABLE_KEYS.has(k)), 'unknown setting')
  .refine((o) => o.hostDefaults === undefined || (typeof o.hostDefaults === 'object' && o.hostDefaults !== null), {
    message: 'hostDefaults must be an object',
  })

function handle<A extends unknown[], R>(channel: string, args: z.ZodType<A>, fn: (...a: A) => Promise<R> | R): void {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...raw: unknown[]) => {
    if (!isTrustedUrl(event.senderFrame?.url)) throw new Error(`untrusted sender for ${channel}`)
    return fn(...args.parse(raw))
  })
}

const none = z.tuple([])

export function registerIpc({ settings, theme, deepLinks, mpv, onSessionReport }: Deps): void {
  const distro = readDistro()
  handle(APP_CHANNELS.info, none, async (): Promise<AppInfo> => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    sessionType: process.env.XDG_SESSION_TYPE ?? null,
    isPackaged: app.isPackaged,
    isAppImage: Boolean(process.env.APPIMAGE),
    distro: await distro,
  }))

  handle(APP_CHANNELS.getSettings, none, () => settings.get())
  handle(APP_CHANNELS.setSettings, z.tuple([z.unknown()]), async (raw) => {
    const parsed = SettingsPatchSchema.safeParse(raw)
    if (!parsed.success) return err('bad-request', parsed.error.message)
    try {
      return ok(await settings.update(parsed.data as SettingsPatch))
    } catch (e) {
      return err('bad-request', e instanceof Error ? e.message : String(e))
    }
  })
  handle(APP_CHANNELS.getTheme, none, () => theme.payload())

  handle(APP_CHANNELS.pickVideo, none, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Choose a video to share',
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: VIDEO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle(APP_CHANNELS.pickSubtitles, none, async () => {
    const r = await dialog.showOpenDialog({
      title: 'Add subtitle files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Subtitles', extensions: SUBTITLE_EXTENSIONS }],
    })
    return r.canceled ? [] : r.filePaths
  })
  handle(APP_CHANNELS.pickFolder, z.tuple([z.string().nullable()]), async (defaultPath) => {
    const r = await dialog.showOpenDialog({
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(defaultPath ? { defaultPath } : {}),
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  handle(APP_CHANNELS.pickMpv, none, async () => {
    const r = await dialog.showOpenDialog({ title: 'Locate the mpv program', properties: ['openFile'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  handle(APP_CHANNELS.openExternal, z.tuple([z.string()]), async (url): Promise<Result<null>> => {
    if (!/^https:\/\//i.test(url)) return err('bad-request', 'only https links can be opened')
    await shell.openExternal(url)
    return ok(null)
  })
  handle(APP_CHANNELS.showItemInFolder, z.tuple([z.string()]), (path) => shell.showItemInFolder(path))
  handle(APP_CHANNELS.writeClipboard, z.tuple([z.string().max(10_000)]), (text) => clipboard.writeText(text))
  handle(APP_CHANNELS.readClipboardInvite, none, async () =>
    extractInvite((await clipboard.readText()).slice(0, 10_000)),
  )
  // The renderer passes core's diagnostics.get result (or nothing); copyDiagnostics validates it.
  handle(APP_CHANNELS.copyDiagnostics, z.tuple([z.unknown().optional()]), (rawCore?: unknown) =>
    copyDiagnostics({ settings: () => settings.get(), mpv: () => mpv.info }, rawCore),
  )
  handle(APP_CHANNELS.openLogsFolder, none, async () => {
    await shell.openPath(app.getPath('logs'))
  })
  handle(APP_CHANNELS.takePendingDeepLink, none, () => deepLinks.take())
  handle(APP_CHANNELS.registerLinuxDeepLinks, none, () => registerLinuxDeepLinks())

  // Re-runs the lookup with the saved mpvPath; MpvService's 'change' passes the result on to core.
  handle(APP_CHANNELS.recheckMpv, none, async (): Promise<Result<MpvInfo>> => {
    try {
      return ok(await mpv.lookup(settings.get().mpvPath))
    } catch (e) {
      return err('internal', e instanceof Error ? e.message : String(e))
    }
  })

  // Fire and forget (ipcRenderer.send), so an untrusted or malformed report is dropped silently.
  ipcMain.on(APP_CHANNELS.reportSession, (event, raw: unknown) => {
    if (!isTrustedUrl(event.senderFrame?.url)) return
    const report = parseSessionReport(raw)
    if (report) onSessionReport(report)
  })
}
