import { useApp } from '../store'

// Mirrors core's power rule (hosting, preparing or downloading) so the user knows why the computer
// does not sleep; main holds the actual powerSaveBlocker.
export function KeepAwakeNote(): React.JSX.Element | null {
  const awake = useApp((s) => {
    const phase = s.core.session?.phase
    if (phase === 'preparing') return true
    if (phase !== 'in-room') return false
    return s.core.session?.role === 'host' || (s.core.transfer?.progress ?? 1) < 1
  })
  if (!awake) return null
  return (
    <span className="muted" style={{ fontSize: 12 }}>
      <span aria-hidden="true">☕</span> Keeping this computer awake
    </span>
  )
}
