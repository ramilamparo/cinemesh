import { FASTSTART_REMUX } from '../../../shared/media/media-map'
import { wt } from '../bridge'
import { formatPercent } from '../lib/format'
import { pushToast, useApp } from '../store'
import styles from './FullDownload.module.css'

// session.media.fullDownload: an fMP4 without sidx, which the player reads to the end before it can start
// (ADR 0004), so viewers can only play it once they have all of it. The host is told how to remux it.

/**
 * The host's warning (HostPrepare and the Room), with the remux command and a Copy button. Only for an fMP4: a file of
 * a few pieces is whole-file too (the manifest's head and tail cover it), but downloading all of it costs nothing.
 */
export function FullDownloadWarning(): React.JSX.Element | null {
  const full = useApp((s) => s.core.session?.media?.fullDownload === true && s.core.session.media.container === 'fmp4')
  if (!full) return null
  return (
    <div className={styles.warning} data-testid="full-download">
      <p className={styles.title}>
        <span aria-hidden="true">⚠ </span>
        <span className="visually-hidden">Warning: </span>
        Viewers can only start after downloading the whole file
      </p>
      <p className="muted">
        This MP4 is fragmented without an index, so the player reads all of it before it can start. A remux fixes that
        without re-encoding: run this with your file as in.mp4, then host out.mp4.
      </p>
      <RemuxCommand command={FASTSTART_REMUX} />
    </div>
  )
}

/** A remux command (from src/shared/media, never made up here) with a Copy button. */
export function RemuxCommand({ command }: { command: string }): React.JSX.Element {
  const copy = async (): Promise<void> => {
    await wt().app.writeClipboard(command)
    pushToast({ level: 'info', message: 'Remux command copied.', code: 'remux' })
  }
  return (
    <div className={styles.command}>
      <code>{command}</code>
      <button type="button" className="small" aria-label="Copy the remux command" onClick={() => void copy()}>
        Copy
      </button>
    </div>
  )
}

/** A viewer's Room: why nothing plays yet, until the whole video is on disk. */
export function FullDownloadWait(): React.JSX.Element | null {
  const full = useApp((s) => s.core.session?.media?.fullDownload === true)
  const progress = useApp((s) => s.core.transfer?.progress ?? 0)
  if (!full || progress >= 1) return null
  return (
    <p className={styles.wait} data-testid="full-download-wait">
      <span aria-hidden="true">⏳ </span>
      Plays once the whole video is downloaded ({formatPercent(progress)})
    </p>
  )
}
