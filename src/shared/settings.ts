import { z } from 'zod'
import { THEME_MODES } from './theme-tokens.js'

// Persisted by main in <userData>/settings.json (atomic tmp + fsync + rename). Plan §4.6.

export const StartModeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('buffered'), seconds: z.number().int().min(0).max(3600) }),
  z.object({ kind: z.literal('play-through') }),
])
export type StartMode = z.infer<typeof StartModeSchema>

const HostDefaultsSchema = z.object({
  othersControl: z.boolean().default(false),
  waitForAll: z.boolean().default(true),
  startMode: StartModeSchema.default({ kind: 'buffered', seconds: 10 }),
  admission: z.enum(['open', 'approve']).default('open'),
  maxMembers: z.number().int().min(2).max(12).default(8),
})

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.enum(THEME_MODES).default('system'),
  displayName: z.string().trim().min(1).max(32).default('Friend'),
  // null means <Downloads>/Cinemesh
  downloadDir: z.string().min(1).nullable().default(null),
  cacheCapGB: z.number().int().min(1).max(100_000).default(100),
  mpvPath: z.string().min(1).nullable().default(null),
  hwdec: z.enum(['auto-safe', 'no']).default('auto-safe'),
  macHdrExperimental: z.boolean().default(false),
  alang: z.array(z.string().min(1).max(16)).max(8).default([]),
  slang: z.array(z.string().min(1).max(16)).max(8).default([]),
  relayKey: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable()
    .default(null),
  alwaysRelay: z.boolean().default(false),
  udpPort: z.number().int().min(1024).max(65535).nullable().default(null),
  bootstrapExtra: z
    .array(z.string().regex(/^[^\s:]+:\d{1,5}$/))
    .max(16)
    .default([]),
  // KiB/s, null = none. Upload: hosting and watching; download: watching only (a host downloads nothing)
  uploadLimitKBps: z.number().int().positive().nullable().default(null),
  downloadLimitKBps: z.number().int().positive().nullable().default(null),
  hashWorkers: z.number().int().min(1).max(4).default(2),
  speedNudge: z.boolean().default(true),
  oscPersistentStrip: z.boolean().default(false),
  // 0 = off; otherwise warn (with a Resync to live button) after this many ms behind the host for 2 s
  desyncWarnMs: z.union([z.literal(0), z.number().int().min(500).max(30_000)]).default(1000),
  hostDefaults: HostDefaultsSchema.prefault({}),
})

export type Settings = z.infer<typeof SettingsSchema>
export type HostDefaults = Settings['hostDefaults']

// What the renderer may send: any subset, nested host defaults merged field by field.
export type SettingsPatch = Partial<Omit<Settings, 'version' | 'hostDefaults'>> & {
  hostDefaults?: Partial<HostDefaults>
}

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}

export function parseSettings(raw: unknown): { settings: Settings; valid: boolean } {
  const parsed = SettingsSchema.safeParse(raw)
  return parsed.success ? { settings: parsed.data, valid: true } : { settings: defaultSettings(), valid: false }
}

export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  const { hostDefaults, ...rest } = patch
  return SettingsSchema.parse({
    ...current,
    ...rest,
    hostDefaults: { ...current.hostDefaults, ...hostDefaults },
  })
}
