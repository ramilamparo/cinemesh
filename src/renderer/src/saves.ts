import type { RecentRoom } from '../../shared/ipc/core'
import { call } from './rpc'
import { type Finishing, codeAbout, pushToast, useApp } from './store'

// A 'save' that a quit, a crash or a missing drive cut off stays with its room (RecentRoom.export) until it is finished
// or given up, both with transfer.finishExport: from Home's Recent rooms, or from the Finish saving of core's
// transfer.export-waiting notice. Where a finished one went comes from core's transfer.export-finished notice, as for
// every finished save, so nothing here says it again.

/** Loads session.recent into the store (Home's Recent rooms). A failed refresh keeps the list it has. */
export async function refreshRecent(): Promise<void> {
  const r = await call('session.recent', {}, { quiet: true })
  // a core without session.recent: an empty list, so Home hides the section
  useApp.setState((s) => ({ recent: r.ok ? r.value : (s.recent ?? []) }))
}

/**
 * transfer.finishExport for a room's cut-off save, then what came of it. `giveUp` drops the save instead: what it had
 * saved is downloaded again when the room is resumed. One request per room at a time; a second is dropped here, as
 * core would refuse it as 'busy'.
 */
export async function finishExport(roomId: string, giveUp = false): Promise<void> {
  if (useApp.getState().finishing[roomId]) return
  const before = exportOf(roomId)
  setFinishing(roomId, giveUp ? 'give-up' : 'finish')
  try {
    // a failure ('busy', a room that is gone, …) is the usual error toast
    const r = await call('transfer.finishExport', giveUp ? { roomId, giveUp: true } : { roomId })
    // 'busy' or 'not-found' can mean the list is stale (core ran or ended that save by itself)
    if (!r.ok) {
      await refreshRecent()
      return
    }
    // 'finished': the room is gone (its download became the saved file); 'rejoin': it offers Resume again (when it
    // was asked to finish, core's transfer.export-failed notice says why); 'waiting': nothing changed, but the folder
    // may have gone since the list was loaded
    await refreshRecent()
    if (r.value.outcome !== 'waiting') return
    const save = exportOf(roomId) ?? before
    pushToast({
      level: 'warn',
      message: save
        ? `Cannot finish saving ${save.name}: its folder ${save.dest} is not connected. Connect its drive, then try again.`
        : 'Cannot finish saving the video: its folder is not connected. Connect its drive, then try again.',
      // the same toast as core's transfer.export-waiting notice for this room, so the two never stack
      code: codeAbout('transfer.export-waiting', roomId),
      action: { label: 'Try again', run: () => void finishExport(roomId) },
    })
  } finally {
    setFinishing(roomId, null)
  }
}

function exportOf(roomId: string): NonNullable<RecentRoom['export']> | null {
  return useApp.getState().recent?.find((r) => r.roomId === roomId)?.export ?? null
}

function setFinishing(roomId: string, kind: Finishing | null): void {
  useApp.setState((s) => {
    const { [roomId]: _done, ...rest } = s.finishing
    return { finishing: kind ? { ...rest, [roomId]: kind } : rest }
  })
}
