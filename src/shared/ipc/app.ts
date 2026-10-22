// renderer <-> main API exposed as window.wt.app (ipcRenderer.invoke under the hood, plan §5.1).

import type { Result } from '../result.js'
import type { Settings, SettingsPatch } from '../settings.js'
import type { ThemePayload } from '../theme-tokens.js'
import type { MpvInfo } from './control.js'
import type {
  CoreDiagnostics,
  CoreEventName,
  CoreEvents,
  CoreMethod,
  CoreSnapshot,
  ParamsOf,
  ResultOf,
} from './core.js'

export interface AppInfo {
  version: string
  platform: string
  arch: string
  electron: string
  sessionType: string | null
  isPackaged: boolean
  isAppImage: boolean
  /** Added: Linux os-release ID (e.g. 'arch', 'ubuntu'), so MpvSetup can highlight the matching command. */
  distro?: string | null
}

/** Added: what the renderer reports to main so the tray, hide-on-close and quit prompt know about the room. */
export interface SessionReport {
  inRoom: boolean
  /** shown in the tray tooltip */
  title: string | null
  /**
   * Added: a 'save' leave (the video export) is running, so the quit prompt warns that quitting interrupts it
   * (the export finishes the next time the app starts).
   */
  saving?: boolean
}

/** Added: main -> renderer commands, e.g. from the tray menu. */
export type AppCommand = 'leave' | 'open-settings'

// Invoke channels; main validates the sender frame and the payload of each.
export const APP_CHANNELS = {
  info: 'app:info',
  getSettings: 'settings:get',
  setSettings: 'settings:set',
  getTheme: 'theme:get',
  pickVideo: 'pick:video',
  pickSubtitles: 'pick:subtitles',
  pickFolder: 'pick:folder',
  pickMpv: 'pick:mpv',
  openExternal: 'shell:open-external',
  showItemInFolder: 'shell:show-item',
  writeClipboard: 'clipboard:write',
  readClipboardInvite: 'clipboard:read-invite',
  copyDiagnostics: 'diagnostics:copy',
  openLogsFolder: 'logs:open',
  takePendingDeepLink: 'deeplink:take',
  registerLinuxDeepLinks: 'deeplink:register-linux',
  recheckMpv: 'mpv:recheck',
  /** ipcRenderer.send (fire and forget), not invoke */
  reportSession: 'session:report',
} as const

// main -> renderer pushes (webContents.send)
export const APP_PUSH = {
  settings: 'push:settings',
  theme: 'push:theme',
  deepLink: 'push:deep-link',
  command: 'push:command',
  corePort: 'core-port',
} as const

export interface AppApi {
  info(): Promise<AppInfo>
  getSettings(): Promise<Settings>
  setSettings(patch: SettingsPatch): Promise<Result<Settings>>
  onSettings(cb: (s: Settings) => void): () => void
  getTheme(): Promise<ThemePayload>
  onTheme(cb: (t: ThemePayload) => void): () => void
  pickVideo(): Promise<string | null>
  pickSubtitles(): Promise<string[]>
  pickFolder(defaultPath?: string): Promise<string | null>
  pickMpv(): Promise<string | null>
  openExternal(url: string): Promise<Result<null>>
  showItemInFolder(path: string): Promise<void>
  writeClipboard(text: string): Promise<void>
  readClipboardInvite(): Promise<string | null>
  /** core diagnostics are fetched by the renderer (diagnostics.get) and passed along; main has no RPC to core */
  copyDiagnostics(core?: CoreDiagnostics | null): Promise<Result<null>>
  openLogsFolder(): Promise<void>
  onDeepLink(cb: (link: string) => void): () => void
  takePendingDeepLink(): Promise<string | null>
  registerLinuxDeepLinks(): Promise<Result<null>>
  // Optional additions (M7): the renderer feature-detects them until main and preload wire them up.
  /** Re-run the mpv lookup (after settings.mpvPath changed) and pass the result on to core. */
  recheckMpv?(): Promise<Result<MpvInfo>>
  reportSession?(report: SessionReport): void
  onAppCommand?(cb: (cmd: AppCommand) => void): () => void
}

export interface CoreClient {
  request<M extends CoreMethod>(method: M, params: ParamsOf<M>): Promise<Result<ResultOf<M>>>
  on<E extends CoreEventName>(event: E, cb: (data: CoreEvents[E]) => void): () => void
  /** fires on first connect and again whenever core restarts */
  onSnapshot(cb: (snapshot: CoreSnapshot) => void): () => void
}

export interface WtBridge {
  app: AppApi
  core: CoreClient
}
