import { remuxCommand, remuxFiles } from '../../../shared/media/remux'
import { useApp } from '../store'
import { RemuxCommand } from './FullDownload'
import styles from './MediaNotes.module.css'

// session.media beyond the full download (plan §4.3): a file without a seek index ('linear': to play from a point, a
// viewer needs everything from the start up to it) and a poorly interleaved one (audio stored far from its video:
// a start or a seek needs both stretches). Info, not warnings: the room works, viewers just wait longer.

/**
 * The stream-copy remux src/shared/media gives for such a file (one command fixes both), or null: none is made up
 * here, and none is known for AVI or an unknown container.
 */
export function remuxFor(container: string | null, slow: { linear: boolean; poor: boolean }): string | null {
  return remuxCommand(container, slow.linear ? 'linear' : 'index', slow.poor ? 'poor' : null)
}

interface Flags {
  linear: boolean
  poor: boolean
  container: string | null
}

/** Selects primitives only (a fresh object from a zustand selector would loop). */
function useMediaFlags(): Flags {
  // a full-download file plays only once all of it is on disk (FullDownload.tsx): seeking is local by then
  const full = useApp((s) => s.core.session?.media?.fullDownload === true)
  const linear = useApp((s) => s.core.session?.media?.seekMode === 'linear')
  const poor = useApp((s) => s.core.session?.media?.interleave === 'poor')
  const container = useApp((s) => s.core.session?.media?.container ?? null)
  return { linear: linear && !full, poor: poor && !full, container }
}

/** HostPrepare and the host's Room: what this file means for viewers, and the remux when there is one. */
export function HostMediaNotes(): React.JSX.Element | null {
  const { linear, poor, container } = useMediaFlags()
  if (!linear && !poor) return null
  // one remux fixes both, so it is shown once: under the first note
  const remux = remuxFor(container, { linear, poor })
  return (
    <div className={styles.notes}>
      {linear && (
        <div className={styles.note} data-testid="media-note-linear">
          <p>
            <Info />
            <strong>Seeking is slower for viewers.</strong>{' '}
            <span className="muted">
              This file has no seek index, so viewers need all of it from the start up to wherever they play.
            </span>
          </p>
          {remux && (
            <RemuxHint command={remux} fixes={poor ? 'adds one and stores the audio with its video' : 'adds one'} />
          )}
        </div>
      )}
      {poor && (
        <div className={styles.note} data-testid="media-note-interleave">
          <p>
            <Info />
            <strong>Viewers need more data before playing or seeking.</strong>{' '}
            <span className="muted">
              This file stores its audio far from its video, so each start or seek fetches both.
            </span>
          </p>
          {remux && !linear && <RemuxHint command={remux} fixes="stores the audio with its video" />}
        </div>
      )}
    </div>
  )
}

/** The remux, with the files it reads and writes named (in.ts → out.mkv), and Copy. */
function RemuxHint({ command, fixes }: { command: string; fixes: string }): React.JSX.Element {
  const files = remuxFiles(command)
  return (
    <>
      <p className="muted">
        A remux {fixes} without re-encoding:{' '}
        {files
          ? `run this with your file as ${files.input}, then host ${files.output}.`
          : 'run this on your file, then host the file it writes.'}
      </p>
      <RemuxCommand command={command} />
    </>
  )
}

/** A viewer's Room, under the download line: why starts and seeks take longer, only while the download runs. */
export function ViewerMediaNote(): React.JSX.Element | null {
  const { linear, poor } = useMediaFlags()
  const downloading = useApp((s) => (s.core.transfer?.progress ?? 0) < 1)
  if (!downloading || (!linear && !poor)) return null
  return (
    <p className={styles.viewerNote} data-testid="media-note-viewer">
      <Info />
      {linear && 'Seeking ahead takes longer with this file: it has no seek index.'}
      {linear && poor && ' '}
      {poor && 'Starting and seeking take longer with this file: its audio is stored far from its video.'}
    </p>
  )
}

function Info(): React.JSX.Element {
  return (
    <>
      <span aria-hidden="true">ℹ </span>
      <span className="visually-hidden">Note: </span>
    </>
  )
}
