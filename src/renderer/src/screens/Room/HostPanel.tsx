import { useState } from 'react'
import type { StartMode } from '../../../../shared/settings'
import { wt } from '../../bridge'
import { FeasibilityNote } from '../../components/Feasibility'
import { Segmented, Switch } from '../../components/ui'
import { call } from '../../rpc'
import { pushToast, useApp } from '../../store'
import styles from './Room.module.css'

const RELAY_TEXT = { none: 'No relay configured', ok: 'Relay reachable', unreachable: 'Relay unreachable' } as const
const RELAY_TONE = { none: undefined, ok: 'ok', unreachable: 'danger' } as const

export function HostPanel(): React.JSX.Element {
  return (
    <section className="card stack" aria-labelledby="host-panel-heading">
      <h2 id="host-panel-heading">Host controls</h2>
      <PlaybackSettings />
      <Membership />
      <Network />
    </section>
  )
}

function PlaybackSettings(): React.JSX.Element {
  const sync = useApp((s) => s.core.sync)
  const control = Boolean(sync?.perms.othersPlayPause && sync.perms.othersSeek)
  const startMode: StartMode = sync?.startMode ?? { kind: 'buffered', seconds: 10 }
  // null follows the room's value; a string is an edit in progress
  const [draft, setDraft] = useState<string | null>(null)
  const seconds = draft ?? (startMode.kind === 'buffered' ? String(startMode.seconds) : '10')

  const setMode = (mode: StartMode): void => void call('sync.setStartMode', mode)
  const commitSeconds = (): void => {
    const n = Number(seconds)
    setDraft(null)
    if (draft !== null && Number.isInteger(n) && n >= 0 && n <= 3600) setMode({ kind: 'buffered', seconds: n })
  }

  return (
    <fieldset className={styles.group}>
      <legend>Playback</legend>
      <Switch
        label="Let others play, pause and seek"
        description="When off, only you control playback; others can ask."
        checked={control}
        disabled={!sync}
        onChange={(on) => void call('sync.setPerms', { othersPlayPause: on, othersSeek: on })}
      />
      <Switch
        label="Wait for everyone"
        description="Pause the room while someone is buffering."
        checked={sync?.waitForAll ?? true}
        disabled={!sync}
        onChange={(on) => void call('sync.setWaitForAll', { on })}
      />
      <Segmented
        label="Start"
        value={startMode.kind}
        options={[
          { value: 'buffered', label: 'After buffering' },
          { value: 'play-through', label: 'Immediately' },
        ]}
        onChange={(kind) => setMode(kind === 'buffered' ? { kind, seconds: Number(seconds) || 10 } : { kind })}
      />
      {startMode.kind === 'buffered' && (
        <div className="row">
          <label htmlFor="start-seconds">Seconds buffered by everyone before starting</label>
          <input
            id="start-seconds"
            type="number"
            min={0}
            max={3600}
            style={{ width: 80 }}
            value={seconds}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitSeconds}
            onKeyDown={(e) => e.key === 'Enter' && commitSeconds()}
          />
        </div>
      )}
    </fieldset>
  )
}

function Membership(): React.JSX.Element {
  const room = useApp((s) => s.core.room)
  const members = useApp((s) => s.core.peers?.length ?? 0)

  const rotate = async (): Promise<void> => {
    const r = await call('room.rotateInvite', {})
    if (!r.ok) return
    await wt().app.writeClipboard(r.value.text)
    pushToast({ level: 'info', message: 'New invite copied. The old one no longer works.', code: 'invite' })
  }

  return (
    <fieldset className={styles.group}>
      <legend>Membership</legend>
      <Segmented
        label="New people"
        value={room?.admission ?? null}
        options={[
          { value: 'open', label: 'Join freely' },
          { value: 'approve', label: 'Ask me first' },
        ]}
        disabled={!room}
        onChange={(mode) => void call('room.setAdmission', { mode })}
      />
      {room && room.pending.length > 0 && (
        <div className="stack" role="region" aria-label="Waiting to join">
          <strong>
            Waiting to join <span className="badge">{room.pending.length}</span>
          </strong>
          <ul className={styles.queue}>
            {room.pending.map((p) => (
              <li key={p.id}>
                <span>
                  {p.name}
                  {/* a joiner that cannot reach the host directly: a member passed the request on */}
                  {p.via !== undefined && (
                    <span
                      className="muted"
                      title={`${p.via} passed this request on: ${p.name} cannot reach you directly`}
                    >
                      {' '}
                      via {p.via}
                    </span>
                  )}
                </span>
                <span className="row">
                  <button
                    type="button"
                    className="small primary"
                    aria-label={`Let ${p.name} in`}
                    onClick={() => void call('room.admit', { peerId: p.id, allow: true })}
                  >
                    Let in
                  </button>
                  <button
                    type="button"
                    className="small"
                    aria-label={`Turn ${p.name} away`}
                    onClick={() => void call('room.admit', { peerId: p.id, allow: false })}
                  >
                    Turn away
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <label htmlFor="member-cap">Room size</label>
        <select
          id="member-cap"
          value={room?.maxMembers ?? 8}
          disabled={!room}
          onChange={(e) => void call('room.setMaxMembers', { n: Number(e.target.value) })}
        >
          {Array.from({ length: 11 }, (_, i) => i + 2).map((n) => (
            <option key={n} value={n} disabled={n < members}>
              {n} people
            </option>
          ))}
        </select>
        <span className="muted" style={{ fontSize: 12 }}>
          including you · {members} now
        </span>
      </div>
      <div className="row">
        <button type="button" onClick={() => void rotate()}>
          New invite…
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Members stay; the old invite stops working.
        </span>
      </div>
    </fieldset>
  )
}

function Network(): React.JSX.Element {
  const room = useApp((s) => s.core.room)
  const dupFactor = useApp((s) => s.core.transfer?.dupFactor)
  const savedLimit = useApp((s) => s.settings?.uploadLimitKBps ?? null)
  // core keeps sending prepare.feasibility once a second while hosting
  const feasibility = useApp((s) => s.core.prepare?.feasibility)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const limit = draft ?? (savedLimit === null ? '' : String(savedLimit))

  const commit = async (): Promise<void> => {
    if (draft === null) return
    const t = draft.trim()
    const n = t === '' ? null : Number(t)
    if (n !== null && (!Number.isInteger(n) || n <= 0)) {
      setError('Use a whole number of KB/s, or leave empty for no limit.')
      return
    }
    setError(null)
    setDraft(null)
    if (n === savedLimit) return
    const r = await wt().app.setSettings({ uploadLimitKBps: n })
    if (!r.ok) setError(r.message)
  }

  const relay = room?.relay.status ?? 'none'
  return (
    <fieldset className={styles.group}>
      <legend>Network</legend>
      <p className="row" style={{ margin: 0 }}>
        <span className="badge" data-tone={RELAY_TONE[relay]}>
          {RELAY_TEXT[relay]}
        </span>
        {room && <span className="badge">NAT {room.nat.class}</span>}
        {dupFactor !== undefined && (
          <span className="badge" title="How many times each piece leaves your computer on average; about 1 is ideal">
            Sent {dupFactor.toFixed(2)}× per piece
          </span>
        )}
      </p>
      <FeasibilityNote feasibility={feasibility} />
      <div className="row">
        <label htmlFor="upload-limit">Upload limit (KB/s)</label>
        <input
          id="upload-limit"
          type="number"
          min={1}
          style={{ width: 110 }}
          placeholder="No limit"
          value={limit}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'upload-limit-error' : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(e) => e.key === 'Enter' && void commit()}
        />
      </div>
      {error && (
        <p id="upload-limit-error" className="error-text" role="alert" style={{ margin: 0, fontSize: 12 }}>
          {error}
        </p>
      )}
    </fieldset>
  )
}
