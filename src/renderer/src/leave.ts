import type { LeaveData } from '../../shared/ipc/core'
import type { Result } from '../../shared/result'
import { call, describeError } from './rpc'
import { type LeaveKind, isLeaving, leavePromptFor, pushToast, setUi, useApp } from './store'

// Every leave and save the UI starts goes through here. From the click until core answers, `ui.leaving` says
// what is running: the screen shows it (the Room's leaving banner) and locks its controls, and a second leave or
// save is dropped here instead of reaching core, which would refuse a different one as `busy`.

/** Runs `run` unless a leave is already running; null when it was dropped. */
async function once<T>(kind: LeaveKind, run: () => Promise<Result<T>>): Promise<Result<T> | null> {
  if (isLeaving(useApp.getState())) return null
  setUi({ leaving: kind, leaveOpen: false })
  try {
    return await run()
  } finally {
    setUi({ leaving: null })
  }
}

/**
 * Opens the leave prompt where one is drawn (store.leavePromptFor), and not while a leave runs: it would pop up
 * when a failed leave gives the Room back.
 */
export function openLeavePrompt(): void {
  if (leavePromptFor(useApp.getState())) setUi({ leaveOpen: true })
}

/** session.leave: viewers choose what happens to the download; the host may end the room for everyone. */
export function leaveRoom(
  data: LeaveData,
  opts: { end?: boolean; quiet?: boolean } = {},
): Promise<Result<null> | null> {
  const params = opts.end ? { data, end: true } : { data }
  return once(opts.end ? 'end' : data, () => call('session.leave', params, { quiet: opts.quiet ?? false }))
}

/** session.cancelPrepare (HostPrepare's Cancel, or switching rooms while preparing). */
export function cancelPrepare(): Promise<Result<null> | null> {
  return once('cancel', () => call('session.cancelPrepare', {}))
}

/**
 * transfer.saveFile: exports the finished video, which leaves the room and can take minutes. `dest` is a folder the
 * user picked; without it, the video goes to the folder chosen when joining. Where it went is core's
 * transfer.export-finished notice (with Show in folder), which core sends for every finished save, so the result's
 * path adds no toast of its own: one save, one "Saved" toast.
 */
export async function saveFile(dest?: string): Promise<void> {
  const roomId = useApp.getState().core.session?.roomId ?? null
  const r = await once('save', () => call('transfer.saveFile', dest ? { dest } : {}, { quiet: true }))
  if (!r || r.ok) return
  // 'incomplete' after the export started: the room was left, but its download is kept, so rejoining fetches
  // the missing parts. Before that (the session is still on) it only means "not fully downloaded yet".
  const left = (useApp.getState().core.session?.phase ?? 'idle') === 'idle'
  const rejoin = r.code === 'incomplete' && left && roomId !== null
  pushToast({
    level: 'error',
    message: describeError(r),
    code: 'rpc:transfer.saveFile',
    ...(rejoin ? { action: { label: 'Rejoin', run: () => void call('session.resume', { roomId }) } } : {}),
  })
}
