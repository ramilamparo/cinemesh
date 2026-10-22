import { useState } from 'react'
import type { MemberPhase, PeerPath, PeerView } from '../../../../shared/ipc/core'
import { peerWarningText, peerWarningTone } from '../../../../shared/peer-warnings'
import { Modal } from '../../components/ui'
import { coverageRuns, decodeCoverage } from '../../lib/coverage'
import { formatDrift, formatPercent, formatRate } from '../../lib/format'
import { call } from '../../rpc'
import { type AppState, useApp } from '../../store'
import styles from './Room.module.css'

const PHASE_TEXT: Record<MemberPhase, string> = {
  joining: 'Joining',
  loading: 'Loading',
  ready: 'Ready',
  playing: 'Playing',
  paused: 'Paused',
  seeking: 'Seeking',
  buffering: 'Buffering',
  ended: 'Finished',
  'no-player': 'Player closed',
  'disk-full': 'Disk full',
}
const PHASE_TONE: Partial<Record<MemberPhase, string>> = {
  buffering: 'warn',
  seeking: 'warn',
  'no-player': 'warn',
  'disk-full': 'danger',
  playing: 'ok',
}

const PATH_TEXT: Record<PeerPath, { icon: string; label: string; title: string }> = {
  lan: { icon: '⌂', label: 'LAN', title: 'Same local network' },
  direct: { icon: '↔', label: 'Direct', title: 'Direct connection over the internet' },
  relayed: { icon: '⇄', label: 'Relay', title: 'Through your relay server' },
  'via-peer': { icon: '⤳', label: 'Via peer', title: 'Reached through another member' },
  none: { icon: '–', label: '—', title: 'Not connected' },
}

// A stable empty list: a fresh [] from a zustand selector changes the snapshot on every render (React #185).
const NO_PEERS: PeerView[] = []

export function PeerList(): React.JSX.Element {
  const peers = useApp((s) => s.core.peers ?? NO_PEERS)
  const isHost = useApp((s) => s.core.session?.role === 'host')
  const ownWait = useApp(ownDownloadWait)
  const [kicking, setKicking] = useState<PeerView | null>(null)

  return (
    <section className="card stack" aria-labelledby="peers-heading">
      <h2 id="peers-heading">People ({peers.length})</h2>
      <ul className={styles.peers}>
        {peers.map((p, i) => (
          <PeerRow
            key={p.id}
            peer={p}
            index={i}
            isHost={isHost}
            downloading={p.self && p.phase === 'joining' ? ownWait : null}
            onKick={() => setKicking(p)}
          />
        ))}
      </ul>
      {kicking && <KickDialog peer={kicking} onClose={() => setKicking(null)} />}
    </section>
  )
}

/**
 * A viewer waiting for the whole file (session.media.fullDownload): sync keeps it 'joining' until all of it is on
 * disk, so its own row says how far the download is instead. The fraction (transfer.progress, as in the Room's
 * "Plays once the whole video is downloaded" line), or null when there is no such wait.
 */
function ownDownloadWait(s: AppState): number | null {
  const progress = s.core.transfer?.progress ?? 0
  const waiting = s.core.session?.role === 'viewer' && s.core.session.media?.fullDownload === true && progress < 1
  return waiting ? progress : null
}

function PeerRow(props: {
  peer: PeerView
  index: number
  isHost: boolean
  /** a whole-file download this row waits for (only our own row knows): shown instead of 'Joining' */
  downloading: number | null
  onKick: () => void
}): React.JSX.Element {
  const { peer: p, isHost } = props
  const path = PATH_TEXT[p.path]
  return (
    <li className={styles.peer} aria-label={`${p.name}${p.self ? ' (you)' : ''}`}>
      <div className={styles.peerHead}>
        <span
          className={styles.swatch}
          style={{ background: `var(--peer-${String(props.index % 8)})` }}
          aria-hidden="true"
        />
        <strong className={styles.peerName}>{p.name}</strong>
        {p.self && <span className="muted">(you)</span>}
        <span className="badge">{p.role === 'host' ? 'Host' : 'Viewer'}</span>
        <span className="badge" data-tone={PHASE_TONE[p.phase]}>
          {props.downloading === null ? PHASE_TEXT[p.phase] : `Downloading ${formatPercent(props.downloading)}`}
        </span>
        {p.exempt && (
          <span className="badge" title="Not waited for when someone buffers">
            Not waited for
          </span>
        )}
        {isHost && !p.self && (
          <button type="button" className="small" style={{ marginLeft: 'auto' }} onClick={props.onKick}>
            Remove…
          </button>
        )}
      </div>
      <dl className={styles.stats}>
        {!(p.self && p.role === 'host') && (
          <div>
            <dt>Drift</dt>
            <dd>{formatDrift(p.driftMs)}</dd>
          </div>
        )}
        <div>
          <dt>
            <span aria-hidden="true">↓/↑</span>
            <span className="visually-hidden">Download and upload</span>
          </dt>
          <dd>
            {formatRate(p.downBps)} / {formatRate(p.upBps)}
          </dd>
        </div>
        <div>
          <dt>Has</dt>
          <dd>{Math.round(p.havePct)} %</dd>
        </div>
        {!p.self && (
          <>
            <div>
              <dt>RTT</dt>
              <dd>{p.rttMs === null ? '–' : `${String(Math.round(p.rttMs))} ms`}</dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd title={path.title}>
                <span aria-hidden="true">{path.icon}</span> {path.label}
              </dd>
            </div>
          </>
        )}
      </dl>
      {isHost && !p.self && p.role === 'viewer' && <CoverageBar peer={p} />}
      {(p.warnings.length > 0 || p.lastError) && (
        <ul className={styles.warnings}>
          {p.warnings.map((w) => (
            <li key={w.code} data-tone={peerWarningTone(w)}>
              <span aria-hidden="true">⚠</span> {peerWarningText(w)}
            </li>
          ))}
          {p.lastError && (
            <li>
              <span aria-hidden="true">⚠</span> {p.lastError.hint} <code>{p.lastError.code}</code>
            </li>
          )}
        </ul>
      )}
    </li>
  )
}

/** Which parts of the video this viewer has, from its 256-bucket coverage bitmap. */
export function CoverageBar({ peer }: { peer: PeerView }): React.JSX.Element {
  const bits = decodeCoverage(peer.coverage)
  const runs = bits ? coverageRuns(bits) : []
  const pct = bits ? Math.round((bits.filter(Boolean).length / bits.length) * 100) : null
  return (
    <div
      className={styles.coverage}
      role="img"
      aria-label={pct === null ? `${peer.name}: coverage unknown` : `${peer.name} has ${String(pct)} % of the video`}
      data-testid={`coverage-${peer.id}`}
    >
      {runs.map(([s, e]) => (
        <span key={s} style={{ left: `${String(s * 100)}%`, width: `${String((e - s) * 100)}%` }} />
      ))}
    </div>
  )
}

function KickDialog({ peer, onClose }: { peer: PeerView; onClose: () => void }): React.JSX.Element {
  const kick = async (rotate: boolean): Promise<void> => {
    onClose()
    await call('room.kick', { peerId: peer.id, rotate })
  }
  return (
    <Modal
      title={`Remove ${peer.name}?`}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" onClick={() => void kick(false)}>
            Remove
          </button>
          <button type="button" className="danger" onClick={() => void kick(true)}>
            Remove and change invite
          </button>
        </>
      }
    >
      <p>{peer.name} is disconnected and cannot rejoin with the current invite while you are hosting.</p>
      <p className="muted">
        Changing the invite also stops anyone they shared it with. Everyone still in the room moves over automatically.
      </p>
    </Modal>
  )
}
