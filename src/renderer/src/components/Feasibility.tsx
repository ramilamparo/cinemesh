import type { PrepareEvent } from '../../../shared/ipc/core'
import { formatMbit } from '../lib/format'
import styles from './Feasibility.module.css'

/** "Group needs ~X Mbit/s from you; your upload ~Y Mbit/s", or null without data. Inputs are bytes/s. */
export function feasibilityLine(f: PrepareEvent['feasibility']): { text: string; short: boolean } | null {
  if (!f) return null
  const upload = f.uploadBps === null ? 'unknown' : `~${formatMbit(f.uploadBps)} Mbit/s`
  return {
    text: `Group needs ~${formatMbit(f.needBps)} Mbit/s from you; your upload ${upload}`,
    short: f.uploadBps !== null && f.uploadBps < f.needBps,
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
  const line = feasibilityLine(feasibility)
  if (!line) return null
  return (
    <p className={styles.feasibility} data-short={line.short || undefined} data-testid="feasibility">
      {line.short && <span aria-hidden="true">⚠ </span>}
      {line.short && <span className="visually-hidden">Warning: </span>}
      {line.text}
      {line.short && (
        <span className="muted">
          . Friends may have to wait while it buffers; fewer viewers, a lower-bitrate file or a faster upload helps.
        </span>
      )}
    </p>
  )
}
