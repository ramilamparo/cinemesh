import type { SessionPhase } from '../../shared/ipc/core'
import type { CoreState } from './store'

export type Screen = 'mpv-setup' | 'home' | 'host-prepare' | 'join' | 'room' | 'error'

/**
 * The screen follows session.phase; a missing or too old mpv replaces everything. While 'leaving', the screen
 * the leave started on stays up (`leavingFrom`, kept by the store): the Room for a leave or a long 'save' export,
 * JoinConfirm for its Cancel, so a cancelled join never flashes an empty Room. Unknown (a reload mid-leave): the Room.
 */
export function selectScreen(core: CoreState, leavingFrom: SessionPhase | null = null): Screen {
  const player = core.player?.status
  if (player === 'missing' || player === 'tooOld') return 'mpv-setup'
  const phase = core.session?.phase
  return phaseScreen(phase === 'leaving' ? (leavingFrom ?? 'leaving') : phase)
}

function phaseScreen(phase: SessionPhase | undefined): Screen {
  switch (phase) {
    case undefined:
    case 'idle':
      return 'home'
    case 'preparing':
      return 'host-prepare'
    case 'connecting':
    case 'pending-admission':
    case 'confirm-join':
      return 'join'
    case 'in-room':
    case 'ended':
    case 'leaving':
      return 'room'
    case 'error':
      return 'error'
  }
}
