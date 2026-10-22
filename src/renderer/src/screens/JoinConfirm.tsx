import { useState } from 'react'
import type { SessionEvent } from '../../../shared/ipc/core'
import { wt } from '../bridge'
import { leaveRoom } from '../leave'
import { formatBytes, formatPercent } from '../lib/format'
import { call } from '../rpc'
import { isLeaving, useApp } from '../store'
import styles from './Screens.module.css'

type JoinInfo = NonNullable<SessionEvent['joinInfo']>

/** Head-room kept free on the target drive beyond the file itself: metadata, journal, other apps. */
export const SPACE_RESERVE_BYTES = 512 * 1024 * 1024

export interface SpaceCheck {
  needBytes: number
  freeBytes: number | null
  ok: boolean
  message: string | null
}

export function spaceCheck(
  info: Pick<JoinInfo, 'size' | 'haveBytes'>,
  freeBytes: number | null,
  writable = true,
): SpaceCheck {
  const needBytes = Math.max(0, info.size - (info.haveBytes ?? 0))
  if (!writable) {
    return { needBytes, freeBytes, ok: false, message: 'This folder cannot be written to. Choose another folder.' }
  }
  if (freeBytes === null) return { needBytes, freeBytes, ok: true, message: null }
  if (freeBytes >= needBytes + SPACE_RESERVE_BYTES) return { needBytes, freeBytes, ok: true, message: null }
  return {
    needBytes,
    freeBytes,
    ok: false,
    message: `Not enough space: the video needs ${formatBytes(needBytes + SPACE_RESERVE_BYTES)} and this drive has ${formatBytes(freeBytes)} free. Choose another folder or free up space.`,
  }
}

export function JoinConfirm(): React.JSX.Element {
  const session = useApp((s) => s.core.session)
  // while the host is still preparing, core forwards its session.preparing progress as prepare events
  const prepare = useApp((s) => s.core.prepare)
  // Cancel runs session.leave: this screen stays up (route.ts) until core is back at idle
  const cancelling = useApp(isLeaving)
  const cancel = (): void => void leaveRoom('keep')

  if (cancelling) {
    return (
      <div className={styles.screen}>
        <section className={`card stack ${styles.centered}`} aria-live="polite" aria-busy="true">
          <div className={styles.spinner} aria-hidden="true" />
          <h1>Cancelling…</h1>
        </section>
      </div>
    )
  }
  if (session?.phase === 'confirm-join' && session.joinInfo) {
    return <Confirm info={session.joinInfo} fullDownload={session.media?.fullDownload === true} onCancel={cancel} />
  }
  const pending = session?.phase === 'pending-admission'
  return (
    <div className={styles.screen}>
      <section className={`card stack ${styles.centered}`} aria-live="polite" aria-busy="true">
        <div className={styles.spinner} aria-hidden="true" />
        <h1>{pending ? 'Waiting for the host to let you in' : 'Connecting to the room…'}</h1>
        <p className="muted">
          {pending
            ? 'The host approves new members. This page moves on as soon as they do.'
            : 'Finding the host on the network. This usually takes a few seconds.'}
        </p>
        {prepare && (
          <p data-testid="host-preparing" style={{ margin: 0 }}>
            The host is preparing the video:{' '}
            {formatPercent(prepare.bytesTotal > 0 ? prepare.bytesDone / prepare.bytesTotal : 0)}
          </p>
        )}
        <div className="row" style={{ justifyContent: 'center' }}>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  )
}

function Confirm({
  info,
  fullDownload,
  onCancel,
}: {
  info: JoinInfo
  fullDownload: boolean
  onCancel: () => void
}): React.JSX.Element {
  // Until the user picks another folder, follow core's joinInfo (it may refresh, e.g. after a resume).
  const [picked, setPicked] = useState<{ dir: string; free: number | null; writable: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const dir = picked?.dir ?? info.dir
  const free = picked ? picked.free : info.freeBytes
  const check = spaceCheck(info, free, picked?.writable ?? true)

  const change = async (): Promise<void> => {
    const chosen = await wt().app.pickFolder(dir)
    if (!chosen) return
    setPicked({ dir: chosen, free: null, writable: true })
    const r = await call('session.checkDir', { dir: chosen }, { quiet: true })
    setPicked({ dir: chosen, free: r.ok ? r.value.freeBytes : null, writable: r.ok ? r.value.writable : true })
  }
  const join = async (): Promise<void> => {
    setBusy(true)
    await call('session.confirmJoin', { dir })
    setBusy(false)
  }

  return (
    <div className={styles.screen}>
      <header className={styles.screenHeader}>
        <h1>Join this room?</h1>
      </header>
      <section className="card stack" aria-labelledby="confirm-file">
        <h2 id="confirm-file" className={styles.fileName} title={info.name}>
          {info.name}
        </h2>
        <dl className={styles.facts}>
          <dt>Size</dt>
          <dd>
            {formatBytes(info.size)}
            {info.haveBytes ? <span className="muted"> ({formatBytes(info.haveBytes)} already downloaded)</span> : null}
          </dd>
          <dt>Save to</dt>
          <dd className={styles.dirRow}>
            <code title={dir}>{dir}</code>
            <button type="button" className="small" onClick={() => void change()}>
              Change…
            </button>
          </dd>
          <dt>Free space</dt>
          <dd>{free === null ? 'Unknown' : formatBytes(free)}</dd>
        </dl>
        {check.message && (
          <p className={styles.blocked} role="alert" data-testid="space-blocked">
            <span aria-hidden="true">⚠ </span>
            {check.message}
          </p>
        )}
        {fullDownload ? (
          <p style={{ margin: 0 }} data-testid="full-download-note">
            <span aria-hidden="true">⏳ </span>
            This video plays only once all of it is downloaded: the host&apos;s file cannot be streamed.
          </p>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            The video downloads while you watch, starting from where the room is playing.
          </p>
        )}
        <div className="row">
          <button type="button" className="primary" disabled={!check.ok || busy} onClick={() => void join()}>
            Join
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </section>
    </div>
  )
}
