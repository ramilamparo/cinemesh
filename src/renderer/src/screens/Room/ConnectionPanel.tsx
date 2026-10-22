import { SLOW_RATE_FACTOR, limitBps } from '../../../../shared/limits'
import { LimitField } from '../../components/LimitField'
import { formatMbit } from '../../lib/format'
import { useApp } from '../../store'

/**
 * A viewer's limits, live: the same settings as Settings › Network. The host's upload limit is in its own panel,
 * and a host has no download limit.
 */
export function ConnectionPanel(): React.JSX.Element {
  const downloadLimit = useApp((s) => s.settings?.downloadLimitKBps ?? null)
  const fileSize = useApp((s) => s.core.session?.fileSize ?? null)
  const durationS = useApp((s) => s.core.session?.durationS ?? null)
  const note = bitrateNote(limitBps(downloadLimit), fileSize, durationS)
  return (
    <section className="card stack" aria-labelledby="connection-heading">
      <h2 id="connection-heading">Your connection</h2>
      <LimitField id="download-limit" label="Download limit (KB/s)" setting="downloadLimitKBps" />
      {note && (
        <p className={note.short ? undefined : 'muted'} style={{ fontSize: 12 }} data-testid="bitrate-note">
          {note.short && <span aria-hidden="true">⚠ </span>}
          {note.short && <span className="visually-hidden">Warning: </span>}
          {note.text}
        </p>
      )}
      <LimitField id="viewer-upload-limit" label="Upload limit (KB/s)" setting="uploadLimitKBps" />
      <p className="muted" style={{ fontSize: 12 }}>
        Changes apply now and are kept for next time.
      </p>
    </section>
  )
}

/**
 * The download limit against the video's average bitrate: short below SLOW_RATE_FACTOR × it, where core's
 * slow-download warning would never clear (below the bitrate itself it will pause; just above it, it may). null
 * without a limit or a known bitrate.
 */
export function bitrateNote(
  limit: number | null,
  fileSize: number | null,
  durationS: number | null,
): { text: string; short: boolean } | null {
  if (limit === null || fileSize === null || durationS === null || !(fileSize > 0 && durationS > 0)) return null
  const avgBps = fileSize / durationS
  const mbit = formatMbit(avgBps)
  if (limit < avgBps) {
    return { text: `Below this video's bitrate (~${mbit} Mbit/s): playback will pause to buffer.`, short: true }
  }
  return limit < SLOW_RATE_FACTOR * avgBps
    ? { text: `Close to this video's bitrate (~${mbit} Mbit/s): playback may pause to buffer.`, short: true }
    : { text: `This video needs about ${mbit} Mbit/s.`, short: false }
}
