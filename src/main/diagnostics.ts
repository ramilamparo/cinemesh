import { open } from 'node:fs/promises'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { app, clipboard } from 'electron'
import { z } from 'zod'
import type { MpvInfo } from '../shared/ipc/control.js'
import type { CoreDiagnostics } from '../shared/ipc/core.js'
import { INVITE_SCHEME } from '../shared/invite-link.js'
import { type Result, err, ok } from '../shared/result.js'
import type { Settings } from '../shared/settings.js'

// "Copy diagnostics" (plan §4.6): a Markdown report for bug reports. Core's part arrives from the renderer, which
// fetched it with diagnostics.get (main has no request channel to core), so it is validated like any input.

export const LOG_LINES = 200

const PeerPathSchema = z.enum(['lan', 'direct', 'relayed', 'via-peer', 'none'])
export const CoreDiagnosticsSchema = z.object({
  versions: z.object({
    app: z.string(),
    electron: z.string().nullable(),
    node: z.string(),
    chrome: z.string().nullable(),
    protocol: z.number(),
  }),
  uptimeS: z.number(),
  eventLoopDelayP99Ms: z.number().nullable(),
  rssBytes: z.number(),
  nat: z
    .object({
      class: z.enum(['OPEN', 'CONSISTENT', 'RANDOM', 'UNKNOWN']),
      host: z.string().nullable(),
      port: z.number().nullable(),
      bootstrapped: z.boolean(),
      hint: z.string().nullable(),
    })
    .nullable(),
  peers: z.array(z.object({ id: z.string(), path: PeerPathSchema, rttMs: z.number().nullable() })).max(64),
  mpv: z.object({
    path: z.string().nullable(),
    version: z.string().nullable(),
    vo: z.string().nullable(),
    hwdec: z.string().nullable(),
  }),
  logTail: z.array(z.string().max(4000)).max(1000),
}) satisfies z.ZodType<CoreDiagnostics>

export interface DiagnosticsInput {
  generatedAt: Date
  app: { version: string; electron: string; chrome: string; node: string; packaged: boolean; appImage: boolean }
  os: { platform: string; release: string; arch: string; sessionType: string | null; desktop: string | null }
  mpv: MpvInfo
  core: CoreDiagnostics | null
  settings: Settings
  home: string
  logs: { name: string; lines: string[] }[]
}

const Z32 = '[ybndrfg8ejkmcpqxot1uwisza345h769]'
const INVITE_LINK = new RegExp(`${INVITE_SCHEME}://join/${Z32}+`, 'gi')
const BARE_CODE = new RegExp(`${Z32}{100,}`, 'gi')

/** Invites grant access to a room, so none may leave the machine in a report. */
export function redactInvites(line: string): string {
  return line.replace(INVITE_LINK, `${INVITE_SCHEME}://join/[invite redacted]`).replace(BARE_CODE, '[invite redacted]')
}

/** Replaces the home directory with ~ (both slash styles, so Windows paths in JSON are caught too). */
export function tildify(text: string, home: string): string {
  if (!home || home === '/' || home === '\\') return text
  const variants = new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])
  let out = text
  for (const v of variants) out = out.split(v).join('~')
  return out
}

export function formatDiagnostics(d: DiagnosticsInput): string {
  const core = d.core
  const settings: Record<string, unknown> = { ...d.settings }
  if (d.settings.relayKey) settings.relayKey = `${d.settings.relayKey.slice(0, 8)}…`
  const lines: string[] = [
    '## Watch Together diagnostics',
    '',
    `Generated ${d.generatedAt.toISOString()}`,
    '',
    '### Versions',
    `- App ${d.app.version}${d.app.packaged ? '' : ' (development)'}${d.app.appImage ? ' (AppImage)' : ''}`,
    `- Electron ${d.app.electron}, Chrome ${d.app.chrome}, Node ${d.app.node}`,
    `- Core protocol ${core ? String(core.versions.protocol) : 'unknown'}`,
    '',
    '### System',
    `- OS: ${d.os.platform} ${d.os.release} (${d.os.arch})`,
    `- Session: ${d.os.sessionType ?? 'n/a'}${d.os.desktop ? `, desktop ${d.os.desktop}` : ''}`,
    '',
    '### mpv',
    `- Found: ${d.mpv.kind}${d.mpv.path ? ` at ${d.mpv.path}` : ''}, version ${d.mpv.version ?? 'unknown'}${
      d.mpv.status ? ` (${d.mpv.status})` : ''
    }`,
    ...mpvCandidateLines(d.mpv),
    `- vo ${core?.mpv.vo ?? 'n/a'}, hwdec ${core?.mpv.hwdec ?? 'n/a'}`,
    '',
    '### Network',
  ]
  if (core?.nat) {
    lines.push(
      `- NAT ${core.nat.class}, bootstrapped ${core.nat.bootstrapped ? 'yes' : 'no'}${core.nat.port !== null ? ', fixed port' : ''}`,
    )
    if (core.nat.hint) lines.push(`- Hint: ${core.nat.hint}`)
  } else lines.push('- NAT not tested')
  lines.push(`- Relay ${d.settings.relayKey ? 'configured' : 'none'}${d.settings.alwaysRelay ? ' (always)' : ''}`)
  if (core && core.peers.length > 0) {
    lines.push('', '| Peer | Path | RTT |', '|---|---|---|')
    for (const p of core.peers) {
      lines.push(
        `| ${p.id.slice(0, 8)} | ${p.path} | ${p.rttMs === null ? '–' : `${String(Math.round(p.rttMs))} ms`} |`,
      )
    }
  } else lines.push('- No peers')
  lines.push(
    '',
    '### Core',
    core
      ? `- Uptime ${String(core.uptimeS)} s, RSS ${String(Math.round(core.rssBytes / 1e6))} MB, event-loop delay p99 ${
          core.eventLoopDelayP99Ms === null ? 'n/a' : `${core.eventLoopDelayP99Ms.toFixed(1)} ms`
        }`
      : '- Not reachable',
    '',
    '### Settings',
    '```json',
    JSON.stringify(settings, null, 2),
    '```',
  )
  for (const log of d.logs) {
    lines.push(
      '',
      `### ${log.name} (last ${String(log.lines.length)} lines)`,
      '```',
      ...log.lines.slice(-LOG_LINES),
      '```',
    )
  }
  return tildify(lines.map(redactInvites).join('\n'), d.home)
}

function mpvCandidateLines(mpv: MpvInfo): string[] {
  return (mpv.tried ?? []).map(
    (c) =>
      `  - tried ${c.source}: ${c.path} → ${c.status}${c.version ? ` ${c.version}` : ''}${
        c.detail ? ` (${c.detail.split('\n', 1)[0] ?? ''})` : ''
      }`,
  )
}

/** Last `n` lines of a text file, reading at most the final 512 KiB. Missing files give []. */
export async function readTail(file: string, n = LOG_LINES): Promise<string[]> {
  const MAX = 512 * 1024
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    return []
  }
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - MAX)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    const lines = buf.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift() // probably cut mid-line
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-n)
  } finally {
    await fh.close()
  }
}

export interface DiagnosticsDeps {
  settings: () => Settings
  mpv: () => MpvInfo
  logsDir?: string
}

/** Handler for APP_CHANNELS.copyDiagnostics; `rawCore` is what the renderer passed (may be absent or bogus). */
export async function copyDiagnostics(deps: DiagnosticsDeps, rawCore: unknown): Promise<Result<null>> {
  try {
    const parsed = CoreDiagnosticsSchema.safeParse(rawCore)
    const core = parsed.success ? parsed.data : null
    const logsDir = deps.logsDir ?? app.getPath('logs')
    const coreLines = core && core.logTail.length > 0 ? core.logTail : await readTail(join(logsDir, 'core.log'))
    const text = formatDiagnostics({
      generatedAt: new Date(),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        packaged: app.isPackaged,
        appImage: Boolean(process.env.APPIMAGE),
      },
      os: {
        platform: process.platform,
        release: release(),
        arch: process.arch,
        sessionType: process.env.XDG_SESSION_TYPE ?? null,
        desktop: process.env.XDG_CURRENT_DESKTOP ?? null,
      },
      mpv: deps.mpv(),
      core,
      settings: deps.settings(),
      home: homedir(),
      logs: [
        { name: 'core.log', lines: coreLines.slice(-LOG_LINES) },
        { name: 'main.log', lines: await readTail(join(logsDir, 'main.log')) },
        { name: 'mpv.log', lines: await readTail(join(logsDir, 'mpv.log')) },
      ],
    })
    await clipboard.writeText(text)
    return ok(null)
  } catch (e) {
    return err('internal', e instanceof Error ? e.message : String(e))
  }
}
