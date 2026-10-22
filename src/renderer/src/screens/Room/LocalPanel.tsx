import { useEffect, useRef, useState } from 'react'
import type { PlayerEvent, TrackInfo } from '../../../../shared/ipc/core'
import { call } from '../../rpc'
import { useApp } from '../../store'
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
