import { useEffect, useRef, useState } from 'react'
import type { PlayerEvent, SharedSubView, TrackInfo } from '../../../../shared/ipc/core'
import { fileNameOf } from '../../../../shared/media-files'
import { wt } from '../../bridge'
import { call } from '../../rpc'
import { pushToast, useApp } from '../../store'
import styles from './Room.module.css'

function trackLabel(t: TrackInfo): string {
  const parts = [t.title ?? (t.lang ? t.lang.toUpperCase() : `Track ${t.id}`)]
  const extra = [t.title && t.lang ? t.lang : null, t.codec, t.forced ? 'forced' : null, t.external ? 'external' : null]
  const tail = extra.filter(Boolean).join(', ')
  if (tail) parts.push(`(${tail})`)
  return parts.join(' ')
}

export function hdrLabel(hdr: PlayerEvent['hdr'] | undefined): string {
  if (!hdr || hdr.source === 'unknown') return 'Dynamic range unknown'
  if (hdr.source === 'sdr') return 'SDR'
  switch (hdr.output) {
    case 'passthrough':
      return 'HDR (passthrough)'
    case 'tonemapped':
      return 'HDR, tone-mapped to SDR'
    case 'sdr':
      return 'HDR shown as SDR'
    case 'unknown':
      return 'HDR'
  }
}

const PLAYER_TEXT: Record<PlayerEvent['status'], string> = {
  absent: 'Not started',
  spawning: 'Starting…',
  connecting: 'Starting…',
  idle: 'Ready',
  loading: 'Loading the video…',
  ready: 'Playing in the player window',
  closedByUser: 'Player window closed',
  crashed: 'Player crashed; restarting',
  missing: 'mpv not found',
  tooOld: 'mpv is too old',
}

const VOLUME_SEND_MS = 100

export function LocalPanel(): React.JSX.Element {
  const tracks = useApp((s) => s.core.tracks)
  const player = useApp((s) => s.core.player)
  const [volume, setVolume] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const shownVolume = volume ?? tracks?.volume ?? 100
  const muted = tracks?.muted ?? false

  const sendVolume = (v: number): void => {
    setVolume(v)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void call('player.setVolume', { volume: v, muted }).then(() => setVolume(null))
    }, VOLUME_SEND_MS)
  }

  return (
    <section className="card stack" aria-labelledby="local-heading">
      <h2 id="local-heading">Your player</h2>
      <p className={styles.playerStatus}>
        <span>{PLAYER_TEXT[player?.status ?? 'absent']}</span>
        <span className="badge" title={player?.hdr.gpuContext ?? undefined}>
          {hdrLabel(player?.hdr)}
        </span>
      </p>
      <div className={styles.formGrid}>
        <label htmlFor="audio-track">Audio</label>
        <select
          id="audio-track"
          value={String(tracks?.aid ?? 'no')}
          disabled={!tracks || tracks.audio.length === 0}
          onChange={(e) => {
            const v = e.target.value
            void call('player.setTrack', { kind: 'audio', id: v === 'no' ? 'no' : Number(v) })
          }}
        >
          <option value="no">None</option>
          {tracks?.audio.map((t) => (
            <option key={t.id} value={t.id}>
              {trackLabel(t)}
            </option>
          ))}
        </select>
        <label htmlFor="sub-track">Subtitles</label>
        <select
          id="sub-track"
          value={String(tracks?.sid ?? 'no')}
          disabled={!tracks}
          onChange={(e) => {
            const v = e.target.value
            void call('player.setTrack', { kind: 'sub', id: v === 'no' ? 'no' : Number(v) })
          }}
        >
          <option value="no">Off</option>
          {tracks?.sub.map((t) => (
            <option key={t.id} value={t.id}>
              {trackLabel(t)}
            </option>
          ))}
        </select>
        <label htmlFor="volume">Volume</label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input
            id="volume"
            type="range"
            min={0}
            max={130}
            value={shownVolume}
            aria-valuetext={`${String(shownVolume)} %${muted ? ', muted' : ''}`}
            disabled={!tracks}
            onChange={(e) => sendVolume(Number(e.target.value))}
          />
          <span className={styles.num}>{shownVolume}</span>
          <button
            type="button"
            className="small"
            aria-pressed={muted}
            disabled={!tracks}
            onClick={() => void call('player.setVolume', { volume: shownVolume, muted: !muted })}
          >
            {muted ? 'Unmute' : 'Mute'}
          </button>
        </div>
      </div>
      <SharedSubtitles />
      <div className="row">
        <button type="button" onClick={() => void call('player.reopen', {})}>
          Show player
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          Audio and subtitle choices only affect you.
        </span>
      </div>
    </section>
  )
}

const SHARED_STATE_TEXT: Record<SharedSubView['state'], string> = {
  fetching: 'downloading…',
  ready: '',
  error: 'could not download',
}

/** Subtitle files members share while the room plays (ADR 0013): everyone gets them in their subtitle list. */
function SharedSubtitles(): React.JSX.Element | null {
  const shared = useApp((s) => s.core.sharedSubs)
  const isHost = useApp((s) => s.core.session?.role === 'host')
  const [busy, setBusy] = useState(false)
  if (!shared) return null
  const canShare = shared.available && (isHost || shared.viewersMayShare)
  const why = !shared.available
    ? "The host's Cinemesh is too old to share subtitle files."
    : canShare
      ? null
      : 'The host turned off sharing subtitle files.'

  const share = async (): Promise<void> => {
    const paths = await wt().app.pickSubtitles()
    if (paths.length === 0) return
    setBusy(true)
    try {
      for (const path of paths) {
        const r = await call('subtitles.share', { path })
        if (r.ok) {
          pushToast({ level: 'info', message: `Shared ${fileNameOf(path)} with the room.`, code: 'subtitles.own' })
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <button type="button" className="small" disabled={!canShare || busy} onClick={() => void share()}>
          {busy ? 'Sharing…' : 'Share a subtitle file…'}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {why ?? 'Shared files show up in everyone’s subtitle list.'}
        </span>
      </div>
      {shared.items.length > 0 && (
        <ul className={styles.sharedSubs} aria-label="Shared subtitle files">
          {shared.items.map((item) => (
            <li key={item.hash}>
              <span className={styles.sharedSubName} title={item.name}>
                {item.name}
              </span>
              <span className="muted">
                {item.mine ? 'you' : item.byName || 'someone'}
                {SHARED_STATE_TEXT[item.state] ? ` · ${SHARED_STATE_TEXT[item.state]}` : ''}
              </span>
              {item.state === 'ready' && (
                <button
                  type="button"
                  className="small"
                  aria-label={`Use ${item.name}`}
                  onClick={() => void call('subtitles.use', { hash: item.hash })}
                >
                  Use
                </button>
              )}
              {item.canRemove && (
                <button
                  type="button"
                  className="small"
                  aria-label={`Stop sharing ${item.name}`}
                  onClick={() => void call('subtitles.remove', { hash: item.hash })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
