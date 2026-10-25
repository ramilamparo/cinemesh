import { useEffect, useState } from 'react'
import type { NatClass, NatReport, RecentRoom } from '../../../shared/ipc/core'
import { extractInvite } from '../../../shared/invite-link'
import { MAX_PLAYLIST_ITEMS, naturalSort } from '../../../shared/media-files'
import { THEME_MODES, type ThemeMode } from '../../../shared/theme-tokens'
import { wt } from '../bridge'
import { FileName, Modal, Segmented } from '../components/ui'
import { formatBytes, formatPercent } from '../lib/format'
import { moveItem, useDragReorder } from '../lib/reorder'
import { call } from '../rpc'
import { finishExport, refreshRecent } from '../saves'
import { useApp } from '../store'
import styles from './Home.module.css'

const THEME_OPTIONS = THEME_MODES.map((value) => ({
  value,
  label: ({ system: 'System', light: 'Light', dark: 'Dark' } as const)[value],
}))

export function Home(): React.JSX.Element {
  const connected = useApp((s) => s.connected)
  const versions = useApp((s) => s.versions)
  const theme = useApp((s) => s.settings?.theme ?? null)

  return (
    <div className={styles.home}>
      <section className={styles.hero}>
        <h1>Cinemesh</h1>
        <p className={styles.lead}>
          Share a video from your computer and watch it in sync with friends. The file goes straight from you to them.
        </p>
      </section>

      <div className={styles.grid}>
        <HostCard />
        <JoinCard />
      </div>

      <RecentRooms />

      <div className={styles.grid}>
        <NetworkTest />
        <section className="card stack" aria-labelledby="you-heading">
          <h2 id="you-heading">You</h2>
          <DisplayName />
          <Segmented
            label="Theme"
            value={theme}
            options={THEME_OPTIONS}
            onChange={(t: ThemeMode) => void wt().app.setSettings({ theme: t })}
          />
        </section>
      </div>

      <footer className={styles.footer} data-testid="core-status">
        {connected && versions
          ? `Background process connected · v${versions.app}${versions.electron ? ` · Electron ${versions.electron}` : ''}`
          : 'Starting background process…'}
      </footer>
    </div>
  )
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function HostCard(): React.JSX.Element {
  // in playlist order: the first one opens the room
  const [videos, setVideos] = useState<string[]>([])
  const [subs, setSubs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const first = videos[0] ?? null

  const chooseVideos = async (opts: { add: boolean }): Promise<void> => {
    const paths = await wt().app.pickVideos()
    if (paths.length === 0) return
    // picked videos go in episode order, after the ones already listed (in the order the host gave them)
    setVideos((cur) => {
      const kept = opts.add ? cur : []
      return [...kept, ...naturalSort(paths.filter((p) => !kept.includes(p)))].slice(0, MAX_PLAYLIST_ITEMS)
    })
    if (!opts.add) setSubs([])
  }
  const addSubs = async (): Promise<void> => {
    const paths = await wt().app.pickSubtitles()
    setSubs((cur) => [...cur, ...paths.filter((p) => !cur.includes(p))])
  }
  const remove = (path: string): void => {
    setVideos((cur) => cur.filter((x) => x !== path))
    // the subtitles chosen were the first video's
    if (path === first) setSubs([])
  }
  const move = (from: number, to: number): void => {
    const next = moveItem(videos, from, to)
    setVideos(next)
    if (next[0] !== first) setSubs([])
  }
  const drag = useDragReorder(move)
  const start = async (): Promise<void> => {
    if (!first) return
    setBusy(true)
    const more = videos.slice(1)
    await call('session.host', { videoPath: first, subtitlePaths: subs, ...(more.length > 0 ? { more } : {}) })
    setBusy(false)
  }

  return (
    <section className="card stack" aria-labelledby="host-heading">
      <h2 id="host-heading">Host a video</h2>
      {first === null ? (
        <>
          <p className="muted">
            Pick a video file on this computer, or several episodes for a playlist. Friends download them from you while
            you watch.
          </p>
          <div className="row">
            <button type="button" className="primary" onClick={() => void chooseVideos({ add: false })}>
              Host a video…
            </button>
          </div>
        </>
      ) : (
        <>
          {videos.length === 1 ? (
            <p className={styles.fileName} title={first}>
              <span aria-hidden="true">🎞</span> {baseName(first)}
            </p>
          ) : (
            <div className="stack">
              <span className="muted">Playlist, in this order (drag a video, or use ↑ and ↓, to change it)</span>
              <ol className={styles.videoList} aria-label="Playlist">
                {videos.map((v, i) => (
                  <li key={v} {...drag(i)}>
                    <span title={v}>
                      <FileName name={baseName(v)} />
                    </span>
                    <span className={styles.videoActions}>
                      <button
                        type="button"
                        className="small"
                        disabled={i === 0}
                        aria-label={`Move ${baseName(v)} up`}
                        onClick={() => move(i, i - 1)}
                      >
                        <span aria-hidden="true">↑</span>
                      </button>
                      <button
                        type="button"
                        className="small"
                        disabled={i === videos.length - 1}
                        aria-label={`Move ${baseName(v)} down`}
                        onClick={() => move(i, i + 1)}
                      >
                        <span aria-hidden="true">↓</span>
                      </button>
                      <button
                        type="button"
                        className="small"
                        aria-label={`Remove ${baseName(v)}`}
                        onClick={() => remove(v)}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
          <div className="stack">
            <span className="muted">
              {videos.length > 1
                ? `Subtitle files for ${baseName(first)} (optional). The other videos take the subtitle files next to them that share their name.`
                : `Subtitle files ${subs.length === 0 ? '(optional; they cannot be added after hosting starts)' : ''}`}
            </span>
            {subs.length > 0 && (
              <ul className={styles.subList} aria-label="Subtitle files">
                {subs.map((s) => (
                  <li key={s}>
                    <span title={s}>{baseName(s)}</span>
                    <button
                      type="button"
                      className="small"
                      aria-label={`Remove ${baseName(s)}`}
                      onClick={() => setSubs((cur) => cur.filter((x) => x !== s))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="row">
              <button type="button" className="small" onClick={() => void addSubs()}>
                Add subtitles…
              </button>
            </div>
          </div>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void start()}>
              Start hosting
            </button>
            <button type="button" onClick={() => void chooseVideos({ add: true })}>
              Add videos…
            </button>
            <button type="button" onClick={() => void chooseVideos({ add: false })}>
              Choose another…
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setVideos([])
                setSubs([])
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function JoinCard(): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [offer, setOffer] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const invite = extractInvite(text, { joinLines: true })
  const showError = text.trim() !== '' && invite === null

  const join = async (link: string): Promise<void> => {
    setBusy(true)
    const r = await call('session.join', { invite: link })
    setBusy(false)
    if (r.ok) {
      setText('')
      setOffer(null)
    }
  }

  // Offer an invite found on the clipboard when the window gains focus; main only returns invites.
  useEffect(() => {
    const check = (): void => {
      void wt().app.readClipboardInvite().then(setOffer)
    }
    check()
    window.addEventListener('focus', check)
    return () => window.removeEventListener('focus', check)
  }, [])

  const visibleOffer = offer !== null && offer !== dismissed && offer !== invite ? offer : null

  return (
    <section className="card stack" aria-labelledby="join-heading">
      <h2 id="join-heading">Join a room</h2>
      {visibleOffer && (
        <div className={styles.offer} role="status">
          <span>
            <span aria-hidden="true">📋</span> An invite is on your clipboard.
          </span>
          <div className="row">
            <button type="button" className="small primary" disabled={busy} onClick={() => void join(visibleOffer)}>
              Join it
            </button>
            <button type="button" className="small" onClick={() => setDismissed(visibleOffer)}>
              Not now
            </button>
          </div>
        </div>
      )}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (invite) void join(invite)
        }}
      >
        <label htmlFor="invite-input" className="muted">
          Paste the invite link or code a friend sent you
        </label>
        <textarea
          id="invite-input"
          rows={2}
          value={text}
          spellCheck={false}
          placeholder="cinemesh://join/…"
          aria-invalid={showError || undefined}
          aria-describedby={showError ? 'invite-error' : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (invite) void join(invite)
            }
          }}
        />
        {showError && (
          <p id="invite-error" className="error-text" style={{ margin: 0, fontSize: 12 }}>
            That does not look like an invite. It starts with cinemesh://join/
          </p>
        )}
        <div className="row">
          <button type="submit" className="primary" disabled={!invite || busy}>
            Join
          </button>
          {invite && (
            <span className="muted" style={{ fontSize: 12 }}>
              <span aria-hidden="true">✓</span> Invite recognised
            </span>
          )}
        </div>
      </form>
    </section>
  )
}

function RecentRooms(): React.JSX.Element | null {
  const recent = useApp((s) => s.recent)
  // the room whose Cancel saving asks first; found in the current list, so a refresh that drops its save closes it
  const [cancelling, setCancelling] = useState<string | null>(null)
  useEffect(() => {
    void refreshRecent()
    // core finishing or giving up a cut-off save by itself (at startup) changes the list: no stale entry stays
    return wt().core.on('notice', (n) => {
      if (n.code.startsWith('transfer.export-')) void refreshRecent()
    })
  }, [])
  if (!recent || recent.length === 0) return null
  const cancel = recent.find((r) => r.roomId === cancelling && r.export)
  return (
    <section className="card stack" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent rooms</h2>
      <ul className={styles.recent}>
        {recent.map((r) => (
          <RecentRoomItem key={r.roomId} room={r} onCancelSave={() => setCancelling(r.roomId)} />
        ))}
      </ul>
      {cancel?.export && (
        <CancelSavePrompt roomId={cancel.roomId} save={cancel.export} onClose={() => setCancelling(null)} />
      )}
    </section>
  )
}

function RecentRoomItem({ room: r, onCancelSave }: { room: RecentRoom; onCancelSave: () => void }): React.JSX.Element {
  const finishing = useApp((s) => s.finishing[r.roomId] ?? null)
  const save = r.export
  return (
    <li>
      <div className={styles.recentText}>
        <strong title={r.fileName}>{r.fileName}</strong>
        <span className="muted">
          {r.role === 'host' ? 'You hosted' : r.name} · {formatBytes(r.fileSize)}
          {r.role === 'viewer' && !save ? ` · ${formatPercent(r.progress)} downloaded` : ''} ·{' '}
          {new Date(r.lastActiveAt).toLocaleString()}
        </span>
        {save ? (
          // a 'save' that a quit, a crash or a missing drive cut off: finished or given up before the room resumes
          <span className={styles.cutOff} data-testid={`cut-off-${r.roomId}`}>
            {save.running ? (
              <>
                Finishing saving {save.name} into <span title={save.dest}>{save.dest}</span>…
              </>
            ) : (
              <>
                Saving {save.name} into <span title={save.dest}>{save.dest}</span> was cut off.
              </>
            )}
            {save.waiting && (
              <>
                {' '}
                <span className="badge" data-tone="warn">
                  Folder not connected
                </span>
              </>
            )}
          </span>
        ) : (
          !r.resumable && (
            <span className="muted">
              {r.role === 'host' ? 'The source file has moved or changed.' : 'The downloaded data is gone.'}
            </span>
          )
        )}
      </div>
      {save?.running ? null : save ? (
        // the name after the visible text, so the accessible name starts with what the button says
        <span className="row">
          <button type="button" disabled={finishing !== null} onClick={() => void finishExport(r.roomId)}>
            {finishing === 'finish' ? 'Saving…' : 'Finish saving'}
            <span className="visually-hidden"> {save.name}</span>
          </button>
          <button type="button" className="danger" disabled={finishing !== null} onClick={onCancelSave}>
            {finishing === 'give-up' ? 'Cancelling…' : 'Cancel saving'}
            <span className="visually-hidden"> {save.name}</span>
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={!r.resumable}
          aria-label={`Resume ${r.fileName}`}
          onClick={() => void call('session.resume', { roomId: r.roomId })}
        >
          Resume
        </button>
      )}
    </li>
  )
}

/** Cancel saving asks first: the save's progress is lost, and its partly saved file deleted. */
function CancelSavePrompt(props: {
  roomId: string
  save: NonNullable<RecentRoom['export']>
  onClose: () => void
}): React.JSX.Element {
  const { roomId, save, onClose } = props
  return (
    <Modal
      title="Cancel saving?"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose}>
            Go back
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              onClose()
              void finishExport(roomId, true)
            }}
          >
            Cancel saving
          </button>
        </>
      }
    >
      <p>
        <strong>{save.name}</strong> is not saved, and the room stays in Recent rooms.
      </p>
      <p className="muted">
        The parts already saved are downloaded again when you resume the room. The partly saved file in {save.dest} is
        deleted if that folder is there.
      </p>
    </Modal>
  )
}

const NAT_TEXT: Record<NatClass, string> = {
  OPEN: 'Open: friends can reach you directly.',
  CONSISTENT: 'Consistent: direct connections work with most friends. A forwarded UDP port (Settings) makes you Open.',
  RANDOM: 'Random: friends whose routers do the same cannot reach you directly. Add a relay in Settings.',
  UNKNOWN: 'Unknown: the test could not classify your network.',
}

function NetworkTest(): React.JSX.Element {
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<NatReport | null>(null)
  const run = async (): Promise<void> => {
    setRunning(true)
    const r = await call('net.test', {})
    setRunning(false)
    if (r.ok) setReport(r.value)
  }
  return (
    <section className="card stack" aria-labelledby="net-heading" aria-busy={running}>
      <h2 id="net-heading">Network test</h2>
      <p className="muted">Checks how easily friends can connect to you.</p>
      <div className="row">
        <button type="button" disabled={running} onClick={() => void run()}>
          {running ? 'Testing…' : report ? 'Test again' : 'Test network'}
        </button>
      </div>
      {report && (
        <div role="status" className="stack">
          <p style={{ margin: 0 }}>
            <span
              className="badge"
              data-tone={report.class === 'RANDOM' ? 'warn' : report.class === 'UNKNOWN' ? undefined : 'ok'}
            >
              {report.class}
            </span>{' '}
            {NAT_TEXT[report.class]}
          </p>
          {!report.bootstrapped && <p className="error-text">Could not reach the network's bootstrap nodes.</p>}
          {report.hint && <p className="muted">{report.hint}</p>}
        </div>
      )}
    </section>
  )
}

function DisplayName(): React.JSX.Element {
  const saved = useApp((s) => s.settings?.displayName ?? '')
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const value = draft ?? saved
  const save = async (): Promise<void> => {
    if (draft === null || draft.trim() === saved) {
      setDraft(null)
      return
    }
    const name = draft.trim()
    if (name.length < 1 || name.length > 32) {
      setError('Use 1 to 32 characters.')
      return
    }
    const r = await wt().app.setSettings({ displayName: name })
    if (r.ok) {
      setDraft(null)
      setError(null)
    } else setError(r.message)
  }
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <label htmlFor="display-name" className="muted">
        Display name (what friends see)
      </label>
      <div className="row">
        <input
          id="display-name"
          type="text"
          value={value}
          maxLength={32}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'display-name-error' : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
        />
        <button type="submit" disabled={draft === null}>
          Save
        </button>
      </div>
      {error && (
        <p id="display-name-error" className="error-text" role="alert" style={{ margin: 0, fontSize: 12 }}>
          {error}
        </p>
      )}
    </form>
  )
}
