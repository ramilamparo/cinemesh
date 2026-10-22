import { LIMIT_MAX_KBPS } from '../../../shared/limits'
import { type Settings, type SettingsPatch, mergeSettings } from '../../../shared/settings'
import { normalizeRelayKey } from './relay-key'

// The Settings overlay edits text fields; this module turns them into a validated SettingsPatch with
// one message per bad field. The full schema runs last (mergeSettings) as the authority.

export interface SettingsForm {
  displayName: string
  downloadDir: string | null
  cacheCapGB: string
  mpvPath: string | null
  hwdec: Settings['hwdec']
  macHdrExperimental: boolean
  alang: string
  slang: string
  relayKey: string
  alwaysRelay: boolean
  udpPort: string
  bootstrapExtra: string
  uploadLimitKBps: string
  downloadLimitKBps: string
  hashWorkers: string
  speedNudge: boolean
  /** desyncWarnMs > 0, and that many seconds as typed */
  desyncWarn: boolean
  desyncWarnS: string
  oscPersistentStrip: boolean
  hostOthersControl: boolean
  hostWaitForAll: boolean
  hostStartMode: 'buffered' | 'play-through'
  hostStartSeconds: string
  hostAdmission: 'open' | 'approve'
  hostMaxMembers: string
}

export type FormErrors = { [K in keyof SettingsForm | 'form']?: string | undefined }

export function formFromSettings(s: Settings): SettingsForm {
  const hd = s.hostDefaults
  return {
    displayName: s.displayName,
    downloadDir: s.downloadDir,
    cacheCapGB: String(s.cacheCapGB),
    mpvPath: s.mpvPath,
    hwdec: s.hwdec,
    macHdrExperimental: s.macHdrExperimental,
    alang: s.alang.join(', '),
    slang: s.slang.join(', '),
    relayKey: s.relayKey ?? '',
    alwaysRelay: s.alwaysRelay,
    udpPort: s.udpPort === null ? '' : String(s.udpPort),
    bootstrapExtra: s.bootstrapExtra.join('\n'),
    uploadLimitKBps: s.uploadLimitKBps === null ? '' : String(s.uploadLimitKBps),
    downloadLimitKBps: s.downloadLimitKBps === null ? '' : String(s.downloadLimitKBps),
    hashWorkers: String(s.hashWorkers),
    speedNudge: s.speedNudge,
    desyncWarn: s.desyncWarnMs > 0,
    desyncWarnS: s.desyncWarnMs > 0 ? String(s.desyncWarnMs / 1000) : '1',
    oscPersistentStrip: s.oscPersistentStrip,
    hostOthersControl: hd.othersControl,
    hostWaitForAll: hd.waitForAll,
    hostStartMode: hd.startMode.kind,
    hostStartSeconds: hd.startMode.kind === 'buffered' ? String(hd.startMode.seconds) : '10',
    hostAdmission: hd.admission,
    hostMaxMembers: String(hd.maxMembers),
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

function int(text: string, min: number, max: number, label: string): Parsed<number> {
  const t = text.trim()
  if (!/^\d+$/.test(t)) return { ok: false, message: `${label} must be a whole number.` }
  const n = Number(t)
  if (n < min || n > max) return { ok: false, message: `${label} must be between ${min} and ${max}.` }
  return { ok: true, value: n }
}

/** Seconds with an optional fraction ("1.5", also ".5" as a number field may hold it), as whole milliseconds. */
function seconds(text: string, min: number, max: number, label: string): Parsed<number> {
  const t = text.trim()
  const n = Number(t)
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(t) || n < min || n > max) {
    return { ok: false, message: `${label} must be between ${min} and ${max}.` }
  }
  return { ok: true, value: Math.round(n * 1000) }
}

function optionalInt(text: string, min: number, max: number, label: string): Parsed<number | null> {
  return text.trim() === '' ? { ok: true, value: null } : int(text, min, max, label)
}

/** A transfer limit in KB/s, empty for none: the one check for Settings and the Room's LimitField. */
export function limitKBps(text: string, label: string): Parsed<number | null> {
  return optionalInt(text, 1, LIMIT_MAX_KBPS, label)
}

function langList(text: string): Parsed<string[]> {
  const items = text
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (items.length > 8) return { ok: false, message: 'At most 8 languages.' }
  if (items.some((x) => x.length > 16 || !/^[\w-]+$/.test(x))) {
    return { ok: false, message: 'Use language codes such as en, ja, por.' }
  }
  return { ok: true, value: items }
}

function bootstrapList(text: string): Parsed<string[]> {
  const items = text
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  if (items.length > 16) return { ok: false, message: 'At most 16 bootstrap nodes.' }
  const bad = items.find((x) => {
    const m = /^([^\s:]+):(\d{1,5})$/.exec(x)
    return !m || Number(m[2]) < 1 || Number(m[2]) > 65535
  })
  if (bad !== undefined) return { ok: false, message: `"${bad}" is not host:port.` }
  return { ok: true, value: items }
}

export function validateSettingsForm(
  form: SettingsForm,
  current: Settings,
): { ok: true; patch: SettingsPatch; settings: Settings } | { ok: false; errors: FormErrors } {
  const errors: FormErrors = {}
  const take = <T>(key: keyof SettingsForm, r: Parsed<T>, fallback: T): T => {
    if (r.ok) return r.value
    errors[key] = r.message
    return fallback
  }

  const name = form.displayName.trim()
  if (name.length < 1 || name.length > 32) errors.displayName = 'Use 1 to 32 characters.'
  const relay = normalizeRelayKey(form.relayKey)
  if (!relay.ok) errors.relayKey = relay.message

  const startSeconds = take('hostStartSeconds', int(form.hostStartSeconds, 0, 3600, 'Seconds'), 10)
  const candidate: Settings = {
    ...current,
    displayName: name,
    downloadDir: form.downloadDir,
    cacheCapGB: take('cacheCapGB', int(form.cacheCapGB, 1, 100_000, 'Cache size'), current.cacheCapGB),
    mpvPath: form.mpvPath,
    hwdec: form.hwdec,
    macHdrExperimental: form.macHdrExperimental,
    alang: take('alang', langList(form.alang), current.alang),
    slang: take('slang', langList(form.slang), current.slang),
    relayKey: relay.ok ? relay.hex : current.relayKey,
    alwaysRelay: form.alwaysRelay,
    udpPort: take('udpPort', optionalInt(form.udpPort, 1024, 65535, 'UDP port'), current.udpPort),
    bootstrapExtra: take('bootstrapExtra', bootstrapList(form.bootstrapExtra), current.bootstrapExtra),
    uploadLimitKBps: take('uploadLimitKBps', limitKBps(form.uploadLimitKBps, 'Upload limit'), current.uploadLimitKBps),
    downloadLimitKBps: take(
      'downloadLimitKBps',
      limitKBps(form.downloadLimitKBps, 'Download limit'),
      current.downloadLimitKBps,
    ),
    hashWorkers: take('hashWorkers', int(form.hashWorkers, 1, 4, 'Hash workers'), current.hashWorkers),
    speedNudge: form.speedNudge,
    // off saves 0 whatever the seconds field holds
    desyncWarnMs: form.desyncWarn
      ? take('desyncWarnS', seconds(form.desyncWarnS, 0.5, 30, 'Seconds'), current.desyncWarnMs || 1000)
      : 0,
    oscPersistentStrip: form.oscPersistentStrip,
    hostDefaults: {
      othersControl: form.hostOthersControl,
      waitForAll: form.hostWaitForAll,
      startMode:
        form.hostStartMode === 'buffered' ? { kind: 'buffered', seconds: startSeconds } : { kind: 'play-through' },
      admission: form.hostAdmission,
      maxMembers: take(
        'hostMaxMembers',
        int(form.hostMaxMembers, 2, 12, 'Member cap'),
        current.hostDefaults.maxMembers,
      ),
    },
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const patch = diff(current, candidate)
  try {
    return { ok: true, patch, settings: mergeSettings(current, patch) }
  } catch (e) {
    return { ok: false, errors: { form: e instanceof Error ? e.message : String(e) } }
  }
}

function diff(current: Settings, next: Settings): SettingsPatch {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(next) as (keyof Settings)[]) {
    if (key === 'version' || key === 'hostDefaults') continue
    if (JSON.stringify(next[key]) !== JSON.stringify(current[key])) patch[key] = next[key]
  }
  const hd: Record<string, unknown> = {}
  for (const key of Object.keys(next.hostDefaults) as (keyof Settings['hostDefaults'])[]) {
    if (JSON.stringify(next.hostDefaults[key]) !== JSON.stringify(current.hostDefaults[key])) {
      hd[key] = next.hostDefaults[key]
    }
  }
  if (Object.keys(hd).length > 0) patch.hostDefaults = hd
  return patch
}
