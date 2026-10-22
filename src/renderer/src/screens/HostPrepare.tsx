import type { PrepareEvent } from '../../../shared/ipc/core'
import { FeasibilityNote } from '../components/Feasibility'
import { FullDownloadWarning } from '../components/FullDownload'
import { KeepAwakeNote } from '../components/KeepAwakeNote'
import { HostMediaNotes } from '../components/MediaNotes'
import { ProgressBar } from '../components/ui'
import { cancelPrepare } from '../leave'
import { formatBytes, formatEta, formatPercent, formatRate } from '../lib/format'
import { CopyInviteButton } from './Room/CopyInviteButton'
import { isLeaving, useApp } from '../store'
import styles from './Screens.module.css'

const STAGES: { id: PrepareEvent['stage']; label: string; detail: string }[] = [
  { id: 'indexing', label: 'Indexing', detail: 'Reading the keyframe index so playback can start anywhere' },
  { id: 'hashing', label: 'Hashing', detail: 'Fingerprinting every piece so friends can verify what they receive' },
  { id: 'ready', label: 'Ready', detail: 'Friends can start downloading' },
]

export function HostPrepare(): React.JSX.Element {
  const session = useApp((s) => s.core.session)
  const prepare = useApp((s) => s.core.prepare)
  const cancelling = useApp(isLeaving)
  const stage = prepare?.stage ?? 'indexing'
  const stageIndex = STAGES.findIndex((s) => s.id === stage)
  const fraction = prepare && prepare.bytesTotal > 0 ? prepare.bytesDone / prepare.bytesTotal : 0
  const eta = prepare && prepare.bytesPerSec > 0 ? (prepare.bytesTotal - prepare.bytesDone) / prepare.bytesPerSec : null

  return (
    <div className={styles.screen}>
      <header className={styles.screenHeader}>
        <h1>Preparing to host</h1>
        <p className={styles.fileName} title={session?.fileName ?? undefined}>
          {session?.fileName ?? 'Your video'}
          {session?.fileSize ? <span className="muted"> · {formatBytes(session.fileSize)}</span> : null}
        </p>
      </header>

      <section className="card stack" aria-labelledby="prep-heading">
        <h2 id="prep-heading" className="visually-hidden">
          Progress
        </h2>
        <ol className={styles.stages}>
          {STAGES.map((s, i) => {
            const state = i < stageIndex || stage === 'ready' ? 'done' : i === stageIndex ? 'current' : 'todo'
            return (
              <li key={s.id} data-state={state} aria-current={state === 'current' ? 'step' : undefined}>
                <span className={styles.stageMark} aria-hidden="true">
                  {state === 'done' ? '✓' : state === 'current' ? '●' : '○'}
                </span>
                <span>
                  <strong>{s.label}</strong>
                  <span className="visually-hidden">
                    {state === 'done' ? ' (done)' : state === 'current' ? ' (in progress)' : ' (waiting)'}
                  </span>
                  <span className="muted"> · {s.detail}</span>
                </span>
              </li>
            )
          })}
        </ol>

        {prepare?.cached && (
          <p style={{ margin: 0 }}>
            <span className="badge" data-tone="ok">
              ✓ Cached
            </span>{' '}
            <span className="muted">This file was hashed before; only a quick spot check is needed.</span>
          </p>
        )}

        {stage !== 'ready' && (
          <>
            <ProgressBar value={fraction} label={`${STAGES[stageIndex]?.label ?? 'Preparing'} progress`} />
            <p className={styles.stats}>
              <span>
                {formatBytes(prepare?.bytesDone ?? 0)} of {formatBytes(prepare?.bytesTotal ?? session?.fileSize ?? 0)} (
                {formatPercent(fraction)})
              </span>
              <span>{formatRate(prepare?.bytesPerSec ?? 0)}</span>
              <span>About {formatEta(eta)} left</span>
            </p>
          </>
        )}

        <FeasibilityNote feasibility={prepare?.feasibility} />
        <FullDownloadWarning />
        <HostMediaNotes />
      </section>

      <section className="card stack" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite friends now</h2>
        <p className="muted">
          The room already exists. Friends who join now see the preparation progress and start downloading once it is
          ready.
        </p>
        <div className="row">
          <CopyInviteButton />
        </div>
      </section>

      <footer className={styles.footerRow}>
        <KeepAwakeNote />
        <button type="button" disabled={cancelling} onClick={() => void cancelPrepare()}>
          {cancelling ? 'Cancelling…' : 'Cancel'}
        </button>
      </footer>
    </div>
  )
}
