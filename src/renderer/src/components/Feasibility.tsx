import type { PrepareEvent } from '../../../shared/ipc/core'
import { limitBps } from '../../../shared/limits'
import { formatMbit } from '../lib/format'
import { useApp } from '../store'
import styles from './Feasibility.module.css'

/**
 * "Group needs ~X Mbit/s from you; your upload ~Y Mbit/s", or null without data. Inputs are bytes/s. `byLimit`: the
 * host's own upload limit is what the upload comes to (the measured upload cannot be above it), so the line names
 * the limit instead.
 */
export function feasibilityLine(
  f: PrepareEvent['feasibility'],
  uploadLimitBps: number | null = null,
): { text: string; short: boolean; byLimit: boolean } | null {
  if (!f) return null
  const byLimit = uploadLimitBps !== null && (f.uploadBps === null || uploadLimitBps <= 1.05 * f.uploadBps)
  const uploadBps = byLimit ? uploadLimitBps : f.uploadBps
  const upload = byLimit
    ? `your upload limit ~${formatMbit(uploadLimitBps)} Mbit/s`
    : `your upload ${f.uploadBps === null ? 'unknown' : `~${formatMbit(f.uploadBps)} Mbit/s`}`
  return {
    text: `Group needs ~${formatMbit(f.needBps)} Mbit/s from you; ${upload}`,
    short: uploadBps !== null && uploadBps < f.needBps,
    byLimit,
  }
}

/**
 * The host's upload check, from `prepare.feasibility`: shown while preparing and, because core keeps sending it
 * once a second while hosting, in the Room's host panel. In the room it warns when even the paced rate (what the
 * host's uplink carries without queueing) stays below what the viewers need.
 */
export function FeasibilityNote({
  feasibility,
}: {
  feasibility: PrepareEvent['feasibility']
}): React.JSX.Element | null {
  const limit = useApp((s) => limitBps(s.settings?.uploadLimitKBps ?? null))
  const line = feasibilityLine(feasibility, limit)
  if (!line) return null
  return (
    <p className={styles.feasibility} data-short={line.short || undefined} data-testid="feasibility">
      {line.short && <span aria-hidden="true">⚠ </span>}
      {line.short && <span className="visually-hidden">Warning: </span>}
      {line.text}
      {line.short && (
        <span className="muted">
          {line.byLimit
            ? '. Raise or clear the upload limit, or friends may have to wait while it buffers.'
            : '. Friends may have to wait while it buffers; fewer viewers, a lower-bitrate file or a faster upload helps.'}
        </span>
      )}
    </p>
  )
}
