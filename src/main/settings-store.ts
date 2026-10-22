import { EventEmitter } from 'node:events'
import { open, readFile, rename } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { type Settings, type SettingsPatch, defaultSettings, mergeSettings, parseSettings } from '../shared/settings.js'
import { log } from './log.js'

export class SettingsStore extends EventEmitter<{ change: [Settings] }> {
  private writing: Promise<void> = Promise.resolve()

  private constructor(
    private readonly file: string,
    private current: Settings,
  ) {
    super()
  }

  static async open(userData: string): Promise<SettingsStore> {
    const file = join(userData, 'settings.json')
    let raw: string | null = null
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      // first run
    }
    if (raw === null) {
      const store = new SettingsStore(file, { ...defaultSettings(), displayName: guessDisplayName() })
      await store.persist()
      return store
    }
    let json: unknown = null
    try {
      json = JSON.parse(raw)
    } catch {
      // treated as invalid below
    }
    const { settings, valid } = parseSettings(json)
    if (!valid) {
      const backup = `${file}.bad-${String(Date.now())}`
      log.warn(`settings.json is invalid; moved to ${backup} and using defaults`)
      await rename(file, backup).catch(() => undefined)
    }
    const store = new SettingsStore(file, settings)
    if (!valid) await store.persist()
    return store
  }

  get(): Settings {
    return this.current
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    this.current = mergeSettings(this.current, patch)
    await this.persist()
    this.emit('change', this.current)
    return this.current
  }

  private persist(): Promise<void> {
    const snapshot = this.current
    this.writing = this.writing.then(() => writeAtomic(this.file, `${JSON.stringify(snapshot, null, 2)}\n`))
    return this.writing
  }
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`
  const fh = await open(tmp, 'w', 0o600)
  try {
    await fh.writeFile(data, 'utf8')
    await fh.sync()
  } finally {
    await fh.close()
  }
  await rename(tmp, file)
}

function guessDisplayName(): string {
  try {
    const name = userInfo().username.trim()
    if (name.length >= 1 && name.length <= 32) return name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    // no passwd entry, e.g. some containers
  }
  return defaultSettings().displayName
}
