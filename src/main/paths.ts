import { join, resolve } from 'node:path'
import { app } from 'electron'

// Must run before app 'ready': userData decides the single-instance lock and every file we write.
// WT_USER_DATA sets it outright (tests); WT_PROFILE runs a second copy side by side (manual testing).
export function configureUserData(): void {
  const explicit = process.env.WT_USER_DATA
  const profile = process.env.WT_PROFILE
  if (explicit) app.setPath('userData', resolve(explicit))
  else if (profile) app.setPath('userData', `${app.getPath('userData')}-${profile}`)
  if (explicit || profile) app.setAppLogsPath(join(app.getPath('userData'), 'logs'))
}

export function isSeparateProfile(): boolean {
  return Boolean(process.env.WT_USER_DATA || process.env.WT_PROFILE)
}

export const outDir = (): string => resolve(import.meta.dirname, '..') // out/
export const preloadPath = (): string => join(outDir(), 'preload', 'index.cjs')
export const rendererDir = (): string => join(outDir(), 'renderer')
export const coreEntry = (): string => join(import.meta.dirname, 'core.js')

export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

export function defaultDownloadDir(): string {
  return join(app.getPath('downloads'), 'Cinemesh')
}
