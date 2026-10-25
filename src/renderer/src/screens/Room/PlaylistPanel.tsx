import type { PlaylistItemView } from '../../../../shared/ipc/core'
import { MAX_PLAYLIST_ITEMS, naturalSort } from '../../../../shared/media-files'
import { wt } from '../../bridge'
import { Switch } from '../../components/ui'
import { formatPercent, formatTime } from '../../lib/format'
import { call } from '../../rpc'
import { useApp } from '../../store'
import styles from './Room.module.css'

/**
 * The room's playlist (ADR 0011): every item in order with the one playing marked. The host adds, orders, plays and
 * removes items and sets whether the room moves on by itself; viewers see the list with their own copy of each item.
 * A room without a playlist (an older host) shows none.
 */
export function PlaylistPanel(): React.JSX.Element | null {
  const playlist = useApp((s) => s.core.playlist)
  const isHost = useApp((s) => s.core.session?.role === 'host')
  if (!playlist) return null
  const { items } = playlist
  const at = items.findIndex((i) => i.current)
  const playable = (i: PlaylistItemView): boolean => (isHost ? i.host?.state === 'ready' : true)
  const prev = at > 0 ? items.slice(0, at).findLast(playable) : undefined
  const next = items.slice(at + 1).find(playable)

  const add = async (): Promise<void> => {
    const paths = await wt().app.pickVideos()
    if (paths.length > 0) await call('playlist.add', { videoPaths: naturalSort(paths) })
  }

  return (
    <section className="card stack" aria-labelledby="playlist-heading">
      <h2 id="playlist-heading">
        Playlist <span className="badge">{items.length}</span>
      </h2>
      <ol className={styles.playlist} aria-label="Playlist items">
        {items.map((item, index) => (
          <PlaylistRow key={item.id} item={item} index={index} count={items.length} isHost={isHost} />
        ))}
      </ol>
      {isHost && (
        <>
          <div className="row">
            <button type="button" className="small" disabled={!prev} onClick={() => void call('playlist.prev', {})}>
              Previous
            </button>
            <button type="button" className="small" disabled={!next} onClick={() => void call('playlist.next', {})}>
              Next
            </button>
            <button
              type="button"
              className="small"
              disabled={items.length >= MAX_PLAYLIST_ITEMS}
              onClick={() => void add()}
            >
              Add videos…
            </button>
          </div>
          <Switch
            label="Play the next video by itself"
            description="A few seconds after a video ends; you can cancel it each time."
            checked={playlist.autoAdvance}
            onChange={(on) => void call('playlist.setAutoAdvance', { on })}
          />
        </>
      )}
    </section>
  )
}

function PlaylistRow(props: {
  item: PlaylistItemView
  index: number
  count: number
  isHost: boolean
}): React.JSX.Element {
  const { item, index, count, isHost } = props
  const ready = item.host?.state === 'ready'
  return (
    <li className={styles.playlistItem} aria-current={item.current ? 'true' : undefined}>
      <span className={styles.playlistName} title={item.name}>
        {item.name}
      </span>
      <span className={styles.playlistMeta}>
        {item.current && (
          <span className="badge" data-tone="ok">
            Playing
          </span>
        )}
        {item.durationS !== null && <span className="muted">{formatTime(item.durationS)}</span>}
        <ItemStatus item={item} />
      </span>
      {isHost && (
        <span className={styles.playlistActions}>
          {!item.current && (
            <button
              type="button"
              className="small"
              disabled={!ready}
              aria-label={`Play ${item.name}`}
              onClick={() => void call('playlist.play', { id: item.id })}
            >
              Play
            </button>
          )}
          <button
            type="button"
            className="small"
            disabled={index === 0}
            aria-label={`Move ${item.name} up`}
            onClick={() => void call('playlist.move', { id: item.id, toIndex: index - 1 })}
          >
            <span aria-hidden="true">↑</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={index === count - 1}
            aria-label={`Move ${item.name} down`}
            onClick={() => void call('playlist.move', { id: item.id, toIndex: index + 1 })}
          >
            <span aria-hidden="true">↓</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={item.current}
            aria-label={`Remove ${item.name}`}
            onClick={() => void call('playlist.remove', { id: item.id })}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </span>
      )}
    </li>
  )
}

/** Host: how far preparing it is. Viewer: this machine's copy. */
function ItemStatus({ item }: { item: PlaylistItemView }): React.JSX.Element | null {
  const h = item.host
  if (h) {
    if (h.state === 'ready') return null
    if (h.state === 'error') {
      return (
        <span className="error-text" title={h.error}>
          Cannot be shared
        </span>
      )
    }
    if (h.state === 'queued') return <span className="muted">Waiting to be prepared</span>
    return (
      <span className="muted">
        {h.state === 'indexing' ? 'Reading' : 'Preparing'} {formatPercent(h.pct)}
      </span>
    )
  }
  const l = item.local
  if (!l) return null
  switch (l.state) {
    case 'complete':
      return <span className="muted">Downloaded</span>
    case 'downloading':
      return <span className="muted">{formatPercent(l.progress)} downloaded</span>
    case 'waiting':
      return <span className="muted">{formatPercent(l.progress)} downloaded, paused</span>
    case 'no-space':
      return <span className="error-text">Not enough disk space</span>
    case 'error':
      return <span className="error-text">Download failed</span>
    default:
      return null
  }
}
