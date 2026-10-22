import { useState } from 'react'
import type { LeaveData } from '../../../../shared/ipc/core'
import { formatBehindS } from '../../../../shared/peer-warnings'
import { wt } from '../../bridge'
import { FullDownloadWait, FullDownloadWarning } from '../../components/FullDownload'
import { KeepAwakeNote } from '../../components/KeepAwakeNote'
import { HostMediaNotes, ViewerMediaNote } from '../../components/MediaNotes'
import { Timeline } from '../../components/Timeline/Timeline'
import { leaveRoom, openLeavePrompt, saveFile } from '../../leave'
import { formatEta, formatPercent, formatRate } from '../../lib/format'
import { call, resync, sendIntent } from '../../rpc'
import { isLeaving, leaveKind, useApp } from '../../store'
import { ConnectionPanel } from './ConnectionPanel'
import { CopyInviteButton } from './CopyInviteButton'
import { HostPanel } from './HostPanel'
import { LocalPanel } from './LocalPanel'
import { PeerList } from './PeerList'
import { Transport } from './Transport'
import styles from './Room.module.css'

export function Room(): React.JSX.Element {
  const session = useApp((s) => s.core.session)
  const roomName = useApp((s) => s.core.room?.name)
  const videoEnded = useApp((s) => s.core.sync?.mode === 'ended')
  const leaving = useApp(isLeaving)
  const isHost = session?.role === 'host'
  // phase 'ended': the host closed the room; sync mode 'ended': the video reached its end, the room goes on
  const closed = session?.phase === 'ended'

  return (
    <div className={styles.room}>
      {leaving && <LeavingBanner />}
      {/* a fieldset so that one `disabled` locks every control in the room while a leave or save runs */}
      <fieldset className={styles.body} disabled={leaving} data-testid="room-body">
        <header className={styles.header}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title} title={session?.fileName ?? undefined}>
              {session?.fileName ?? 'Room'}
            </h1>
            <p className={styles.subtitle}>
              <span className="badge">{isHost ? 'Host' : 'Viewer'}</span>
              {roomName && <span className="muted">{roomName}</span>}
              <KeepAwakeNote />
            </p>
          </div>
          <div className="row">
            <CopyInviteButton />
            <button type="button" onClick={openLeavePrompt}>
              Leave
            </button>
          </div>
        </header>

        {leaving ? null : closed ? <ClosedCard isHost={isHost} /> : videoEnded && <EndedCard isHost={isHost} />}
        <WaitBanner />
        {!isHost && !leaving && <DesyncBanner />}
        {/* hidden while leaving: core keeps media on its 'leaving' event */}
        {leaving ? null : isHost ? (
          <>
            <FullDownloadWarning />
            <HostMediaNotes />
          </>
        ) : (
          <FullDownloadWait />
        )}

        <section aria-label="Timeline" className={styles.timelineCard}>
          <Timeline />
          <Transport />
          {!isHost && <TransferLine />}
          {!isHost && !leaving && <ViewerMediaNote />}
        </section>

        <div className={styles.columns}>
          <PeerList />
          <div className={styles.side}>
            <LocalPanel />
            {isHost ? <HostPanel /> : <ConnectionPanel />}
          </div>
        </div>
      </fieldset>
    </div>
  )
}

/**
 * session.leave or transfer.saveFile is running (this window asked, or core reports phase 'leaving'): the Room
 * stays up, every control locked, until core is done. Not a dialog: toasts stay usable, nothing traps focus.
 * What it says follows store.leaveKind: core's SessionEvent.leave, so a window reloaded mid-save still says saving.
 */
function LeavingBanner(): React.JSX.Element {
  const kind = useApp(leaveKind)
  const saving = kind === 'save'
  return (
    <div className={styles.leaving} role="status" data-testid="leaving">
      <span className={styles.spinnerSmall} aria-hidden="true" />
      <span className={styles.leavingText}>
        <strong>
          {saving
            ? 'Saving the video… this can take a few minutes'
            : kind === 'end'
              ? 'Ending the room…'
              : 'Leaving the room…'}
        </strong>
        {saving && <span className="muted">Keep Cinemesh running until it is done.</span>}
      </span>
    </div>
  )
}

function TransferLine(): React.JSX.Element | null {
  const t = useApp((s) => s.core.transfer)
  // KiB/s against the rate's decimal KB/s: a 500 limit reads ~512 KB/s, so the line names no number
  const limited = useApp((s) => (s.settings?.downloadLimitKBps ?? null) !== null)
  if (!t) return null
  return (
    <p className={styles.transferLine}>
      <span>{formatPercent(t.progress)} downloaded</span>
      <span>
        <span aria-hidden="true">↓</span>
        <span className="visually-hidden">Download</span> {formatRate(t.downBps)}
        {limited && <span className="muted"> (limited)</span>}
      </span>
      <span>
        <span aria-hidden="true">↑</span>
        <span className="visually-hidden">Upload</span> {formatRate(t.upBps)}
      </span>
      {t.etaToEofS !== null && t.progress < 1 && <span>Rest of the file in about {formatEta(t.etaToEofS)}</span>}
      {t.diskLow && (
        <span className="error-text" role="alert">
          <span aria-hidden="true">⚠</span> The disk is almost full
        </span>
      )}
    </p>
  )
}

const WAIT_REASON = {
  seek: 'after the seek',
  buffering: 'buffering',
  start: 'to be ready to start',
  join: 'joining',
} as const

/** "Waiting for Sam, Alex…": core puts display names (not peer ids) in sync.wait.waitingFor. */
export function WaitBanner(): React.JSX.Element | null {
  const wait = useApp((s) => s.core.sync?.wait)
  // a wait only means something while the room runs: once the host closed it (or we are leaving), sync stops and
  // its last event would keep the banner up for good
  const inRoom = useApp((s) => s.core.session?.phase === 'in-room')
  // only the host may override the wait; viewers never get Start anyway, even with play/pause permission
  const isHost = useApp((s) => s.core.session?.role === 'host')
  if (!wait || !inRoom) return null
  const names = wait.waitingFor
  const who =
    names.length === 0
      ? 'everyone'
      : names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 3).join(', ')} and ${String(names.length - 3)} more`
  return (
    <div className={styles.banner} role="status">
      <span className={styles.spinnerSmall} aria-hidden="true" />
      <span>
        Waiting for {who} ({WAIT_REASON[wait.reason]})…
      </span>
      {isHost && (
        <button type="button" className="small" onClick={() => void call('sync.startAnyway', {})}>
          Start anyway
        </button>
      )}
    </div>
  )
}

/**
 * This viewer is behind the host (Settings: Warn when I fall behind). Core decides when (sync.desync); the banner
 * shows it while the room plays, with Resync to live, and the catch-up that follows. Only the state is announced:
 * the number changes up to twice a second while a stall grows, so it stays out of the live region.
 */
export function DesyncBanner(): React.JSX.Element | null {
  const desync = useApp((s) => s.core.sync?.desync)
  const playing = useApp((s) => s.core.sync?.mode === 'playing')
  // as for the wait banner: the last sync event of a room that closed must not keep it up
  const inRoom = useApp((s) => s.core.session?.phase === 'in-room')
  const viewer = useApp((s) => s.core.session?.role === 'viewer')
  const stalled = useApp((s) => s.core.playback?.stalled ?? false)
  const [pending, setPending] = useState(false)
  if (!desync || !playing || !inRoom || !viewer) return null
  const run = async (): Promise<void> => {
    setPending(true)
    try {
      await resync()
    } finally {
      setPending(false)
    }
  }
  const behind = desync.state === 'behind'
  return (
    <div className={styles.banner} data-testid="desync-banner">
      <span role="status" className="visually-hidden" data-testid="desync-status">
        {behind ? "You're behind the host" : 'Resyncing with the host…'}
      </span>
      {behind ? (
        <>
          <span aria-hidden="true">⚠</span>
          <span>{`You're ${formatBehindS(desync.behindS)} behind the host${stalled ? ' (buffering)' : ''}`}</span>
          <button
            type="button"
            className="small"
            title="Jump to where the host is now"
            disabled={pending}
            onClick={() => void run()}
          >
            Resync to live
          </button>
        </>
      ) : (
        <>
          <span className={styles.spinnerSmall} aria-hidden="true" />
          <span aria-hidden="true">Resyncing with the host…</span>
        </>
      )}
    </div>
  )
}

/** The video reached its end (sync mode 'ended') while the room is still open. */
function EndedCard({ isHost }: { isHost: boolean }): React.JSX.Element {
  const progress = useApp((s) => s.core.transfer?.progress ?? 0)

  const playAgain = async (): Promise<void> => {
    if (await sendIntent({ kind: 'seek', posS: 0 })) await sendIntent({ kind: 'play' })
  }
  const saveTo = async (): Promise<void> => {
    const dest = await wt().app.pickFolder()
    if (dest) await saveFile(dest)
  }

  return (
    <section className={`card ${styles.ended}`} aria-labelledby="ended-heading">
      <h2 id="ended-heading">The video has ended</h2>
      {isHost ? (
        <div className="row">
          <button type="button" className="primary" onClick={() => void playAgain()}>
            Play again
          </button>
          <button type="button" className="danger" onClick={() => void leaveRoom('keep', { end: true })}>
            End room
          </button>
        </div>
      ) : (
        <div className="row">
          {progress >= 1 && (
            <button type="button" className="primary" onClick={() => void saveTo()}>
              Save file…
            </button>
          )}
          <button type="button" onClick={openLeavePrompt}>
            Leave
          </button>
          {progress < 1 && (
            <span className="muted">{formatPercent(progress)} downloaded; finish it to save the file.</span>
          )}
        </div>
      )}
    </section>
  )
}

/** session.phase 'ended': the host closed the room. Viewers decide what happens to the downloaded data. */
function ClosedCard({ isHost }: { isHost: boolean }): React.JSX.Element {
  const progress = useApp((s) => s.core.transfer?.progress ?? 0)
  const complete = progress >= 1
  const leave = (data: LeaveData): void => void leaveRoom(data)

  return (
    <section className={`card ${styles.ended}`} aria-labelledby="closed-heading">
      <h2 id="closed-heading">{isHost ? 'The room has ended' : 'The host ended the room'}</h2>
      {isHost ? (
        <div className="row">
          <button type="button" className="primary" onClick={() => leave('keep')}>
            Back to Home
          </button>
        </div>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>
            {complete
              ? 'You have the whole video. Save it, keep it for later, or delete it.'
              : `${formatPercent(progress)} was downloaded. Keep it to resume if the host reopens the room, or delete it.`}
          </p>
          <div className="row">
            {complete && (
              <button type="button" className="primary" onClick={() => void saveFile()}>
                Save file
              </button>
            )}
            <button type="button" className={complete ? undefined : 'primary'} onClick={() => leave('keep')}>
              Keep for later
            </button>
            <button type="button" className="danger" onClick={() => leave('delete')}>
              Delete
            </button>
          </div>
        </>
      )}
    </section>
  )
}
