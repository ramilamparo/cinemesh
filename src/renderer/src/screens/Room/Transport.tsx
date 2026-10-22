import type { IntentRejection, PlaybackIntent } from '../../../../shared/ipc/core'
import { formatTime } from '../../lib/format'
import { askHost, denied, sendIntent } from '../../rpc'
import { useApp } from '../../store'
import styles from './Room.module.css'

const SEEK_STEP_S = 5

export function Transport(): React.JSX.Element {
  const sync = useApp((s) => s.core.sync)
  const paused = useApp((s) => s.core.playback?.paused ?? true)
  const posS = useApp((s) => s.core.playback?.posS ?? 0)
  const durationS = useApp((s) => s.core.playback?.durationS ?? null)
  const canPlayPause = sync?.canPlayPause ?? false
  const canSeek = sync?.canSeek ?? false

  return (
    <div className={styles.transport} role="group" aria-label="Playback controls">
      <ControlButton
        label={`Back ${SEEK_STEP_S} seconds`}
        glyph={`⏪ ${SEEK_STEP_S} s`}
        allowed={canSeek}
        reason="perm-seek"
        intent={{ kind: 'seekRel', deltaS: -SEEK_STEP_S }}
      />
      <ControlButton
        label={paused ? 'Play' : 'Pause'}
        glyph={paused ? '▶ Play' : '⏸ Pause'}
        allowed={canPlayPause}
        reason="perm-playpause"
        intent={{ kind: paused ? 'play' : 'pause' }}
        primary
      />
      <ControlButton
        label={`Forward ${SEEK_STEP_S} seconds`}
        glyph={`${SEEK_STEP_S} s ⏩`}
        allowed={canSeek}
        reason="perm-seek"
        intent={{ kind: 'seekRel', deltaS: SEEK_STEP_S }}
      />
      <span className={styles.clock} aria-hidden="true">
        {formatTime(posS)} / {formatTime(durationS)}
      </span>
      {!canPlayPause && (
        <button type="button" onClick={() => void askHost({ kind: paused ? 'play' : 'pause' })}>
          Ask host to {paused ? 'play' : 'pause'}
        </button>
      )}
      {!(canPlayPause && canSeek) && (
        <span className="muted" style={{ fontSize: 12 }}>
          {canPlayPause
            ? 'Only the host can seek.'
            : canSeek
              ? 'Only the host can play or pause.'
              : 'The host controls playback.'}
        </span>
      )}
    </div>
  )
}

const REASON_TEXT: Record<'perm-seek' | 'perm-playpause', string> = {
  'perm-seek': 'Only the host can seek right now',
  'perm-playpause': 'Only the host can play or pause right now',
}

/**
 * aria-disabled rather than disabled: the button stays focusable and hoverable so its tooltip explains why,
 * and pressing it offers to ask the host instead of doing nothing.
 */
function ControlButton(props: {
  label: string
  glyph: string
  allowed: boolean
  reason: Extract<IntentRejection, 'perm-seek' | 'perm-playpause'>
  intent: PlaybackIntent
  primary?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={props.primary ? 'primary' : undefined}
      aria-label={props.label}
      aria-disabled={!props.allowed}
      title={props.allowed ? props.label : REASON_TEXT[props.reason]}
      onClick={() => {
        if (props.allowed) void sendIntent(props.intent)
        else denied(props.intent, props.reason)
      }}
    >
      {props.glyph}
    </button>
  )
}
