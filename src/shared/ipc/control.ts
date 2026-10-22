// main <-> core control messages over utilityProcess parentPort (plan §5.1).

import type { Settings } from '../settings.js'
import type { ThemePayload } from '../theme-tokens.js'
import type { Versions } from './core.js'

export interface CorePaths {
  userData: string
  logsDir: string
  /** default parent for partial downloads when no save folder is chosen */
  downloadDir: string
  /** packaged resources (mpv-scripts, bundled mpv); repo /resources in dev */
  resources: string
}

/** Added (M7): one candidate the mpv lookup looked at, in lookup order. */
export interface MpvCandidateInfo {
  source: 'settings' | 'bundled' | 'path' | 'flatpak'
  path: string
  status: 'ok' | 'tooOld' | 'unusable'
  version: string | null
  detail?: string
}

export interface MpvInfo {
  /** null unless status is 'ok' */
  path: string | null
  kind: 'bundled' | 'system' | 'flatpak' | 'none'
  /** the usable version; for 'tooOld', the old version that was found */
  version: string | null
  /** Added (M7): lookup outcome. Absent means: 'ok' when path is set, else 'missing'. */
  status?: 'ok' | 'missing' | 'tooOld'
  /** Added (M7): every candidate looked at, for MpvSetup and diagnostics */
  tried?: MpvCandidateInfo[]
}

export type MainToCore =
  | {
      type: 'init'
      protocol: number
      appVersion: string
      paths: CorePaths
      mpv: MpvInfo
      settings: Settings
      theme: ThemePayload
      selftest: boolean
      /** Added (review): main restarted core after a crash; core resumes the room that was active */
      resumeActive?: boolean
    }
  /** ports[0] is the renderer's MessagePort */
  | { type: 'renderer-port' }
  | { type: 'settings'; settings: Settings }
  | { type: 'theme'; theme: ThemePayload }
  /** Added (M7): the mpv lookup ran again (settings.mpvPath changed, or the renderer asked for a recheck) */
  | { type: 'mpv'; mpv: MpvInfo }
  | { type: 'shutdown' }

export interface SelftestReport {
  ok: boolean
  checks: { name: string; ok: boolean; detail: string }[]
  /**
   * Added (M9): main's mpv lookup, as core got it in init.mpv (status filled in when absent). Not part of `ok`:
   * scripts/check-package.mjs judges it per platform (a packaged Windows or macOS app must find its bundled mpv).
   */
  mpv?: {
    kind: MpvInfo['kind']
    path: string | null
    version: string | null
    status: 'ok' | 'missing' | 'tooOld'
    /** every candidate the lookup looked at, so a failed check can say why the bundled one was passed over */
    tried?: MpvCandidateInfo[]
  }
}

export type CoreToMain =
  | { type: 'ready'; versions: Versions }
  | { type: 'mpv-pid'; pid: number | null }
  | { type: 'power'; keepAwake: boolean }
  | { type: 'show-app' }
  | { type: 'selftest'; report: SelftestReport }
  | { type: 'fatal'; message: string }
