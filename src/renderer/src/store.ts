import { create } from 'zustand'
import type { AppInfo, WtBridge } from '../../shared/ipc/app'
import type {
  CoreEvents,
  CoreMethod,
  CoreSnapshot,
  LeaveData,
  NoticeEvent,
  RecentRoom,
  SessionPhase,
} from '../../shared/ipc/core'
import type { Settings } from '../../shared/settings'
import type { ThemePayload } from '../../shared/theme-tokens'
import { setBridge } from './bridge'
import { PlayheadClock } from './lib/playhead'

export type CoreState = Partial<Omit<CoreEvents, 'notice'>>

export interface Toast {
  id: number
  level: NoticeEvent['level']
  message: string
  code?: string
  action?: ToastAction
  /** stays until dismissed, whatever its level (e.g. where a saved video went: the save may finish unattended) */
  sticky?: boolean
}

/**
 * A toast's button: the UI's own `run`, or core's request from a notice (NoticeEvent.action), which the toast runs like
 * a click's request, so that its failure or outcome shows (components/Toasts.tsx).
 */
export type ToastAction = { label: string; run: () => void } | { label: string; request: CoreMethod; params: unknown }

/** A transfer.finishExport this window runs for a room: finishing its cut-off save, or giving it up (saves.ts). */
export type Finishing = 'finish' | 'give-up'

/** What a leave this window asked for does: session.leave's data, the host ending the room, or HostPrepare's Cancel. */
export type LeaveKind = LeaveData | 'end' | 'cancel'

export interface UiState {
  settingsOpen: boolean
  leaveOpen: boolean
  /** a deep link that arrived while a room is active, waiting for the JoinDialog */
  incomingLink: string | null
  /** a leave (or save) this window asked for, from the click until core answers (src/leave.ts) */
  leaving: LeaveKind | null
}

export interface AppState {
  connected: boolean
  versions: CoreSnapshot['versions'] | null
  core: CoreState
  toasts: Toast[]
  settings: Settings | null
  theme: ThemePayload | null
  info: AppInfo | null
  recent: RecentRoom[] | null
  /** by room id: the transfer.finishExport request running for it, from Home or a notice's Finish saving */
  finishing: Record<string, Finishing>
  ui: UiState
  /**
   * While session.phase is 'leaving': the phase it came from, so the screen the leave started on stays up (route.ts).
   * null otherwise, and after a snapshot that is already 'leaving' (a reload during a long save: the Room).
   */
  leavingFrom: SessionPhase | null
}

const initialState = (): AppState => ({
  connected: false,
  versions: null,
  core: {},
  toasts: [],
  settings: null,
  theme: null,
  info: null,
  recent: null,
  finishing: {},
  ui: { settingsOpen: false, leaveOpen: false, incomingLink: null, leaving: null },
  leavingFrom: null,
})

export const useApp = create<AppState>(initialState)

/** Local extrapolation of playback; read by the Timeline every animation frame. */
export const playhead = new PlayheadClock()

const STATE_EVENTS = [
  'session',
  'prepare',
  'room',
  'peers',
  'playback',
  'sync',
  'timeline',
  'transfer',
  'tracks',
  'player',
] as const satisfies readonly (keyof CoreState)[]

const MAX_TOASTS = 5
let nextToastId = 1

export function pushToast(toast: Omit<Toast, 'id'>): number {
  const id = nextToastId++
  useApp.setState((s) => {
    // the same code replaces its previous toast instead of stacking
    const rest = toast.code ? s.toasts.filter((t) => t.code !== toast.code) : s.toasts
    return { toasts: [...rest, { ...toast, id }].slice(-MAX_TOASTS) }
  })
  return id
}

/**
 * A toast code for one thing: `code` plus what it is about (a file, a room). The same code replaces its previous toast,
 * so notices about two saved videos, or two rooms' saves, would otherwise collapse into the last one.
 */
export function codeAbout(code: string, about: string | null): string {
  return about === null ? code : `${code}:${about}`
}

export function dismissToast(id: number): void {
  useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function setUi(patch: Partial<UiState>): void {
  useApp.setState((s) => ({ ui: { ...s.ui, ...patch } }))
}

/**
 * Phases in which the window should hide instead of closing, and quitting should ask first. 'leaving' too: a
 * 'save' export takes minutes, and closing the window must not look like it stopped.
 */
export function isActivePhase(phase: SessionPhase | undefined): boolean {
  return phase === 'preparing' || phase === 'in-room' || phase === 'ended' || phase === 'leaving'
}

/** A leave or save is running: this window asked for one, or core reports the phase (e.g. after a reload). */
export function isLeaving(s: Pick<AppState, 'ui' | 'core'>): boolean {
  return s.ui.leaving !== null || s.core.session?.phase === 'leaving'
}

/**
 * What the running leave does: core's word on its 'leaving' event (`SessionEvent.leave`, so a reload mid-save still
 * knows), else what this window asked for (from the click until core's event, or from a core that does not say).
 */
export function leaveKind(s: Pick<AppState, 'ui' | 'core'>): LeaveKind | null {
  const session = s.core.session
  if (session?.phase === 'leaving' && session.leave !== undefined) return session.leave
  return s.ui.leaving
}

/** A 'save' export runs (core reports it), so quitting would interrupt it: SessionReport.saving. */
export function isSaving(s: Pick<AppState, 'ui' | 'core'>): boolean {
  return s.core.session?.phase === 'leaving' && leaveKind(s) === 'save'
}

/**
 * Which leave prompt fits now: the Room's ('Leave the room?') in-room or ended, HostPrepare's ('Stop hosting?')
 * while preparing, else none (no prompt is drawn there, so the tray's "Leave room…" must not leave one waiting).
 */
export function leavePromptFor(s: Pick<AppState, 'ui' | 'core'>): 'room' | 'prepare' | null {
  if (isLeaving(s)) return null
  const phase = s.core.session?.phase
  return phase === 'in-room' || phase === 'ended' ? 'room' : phase === 'preparing' ? 'prepare' : null
}

/** Wire the bridge into the store once, before the first render. Returns a disconnect for tests. */
export function connectStore(wt: WtBridge): () => void {
  setBridge(wt)
  const offs: (() => void)[] = []
  offs.push(
    wt.core.onSnapshot((snap) => {
      const { versions, ...core } = snap
      playhead.reset()
      if (core.playback) playhead.update(core.playback, performance.now())
      useApp.setState({ connected: true, versions, core, leavingFrom: null })
    }),
  )
  for (const name of STATE_EVENTS) {
    offs.push(
      wt.core.on(name, (data) => {
        if (name === 'playback') playhead.update(data as CoreEvents['playback'], performance.now())
        useApp.setState((s) => {
          const core: CoreState = { ...s.core, [name]: data }
          if (name !== 'session') return { core }
          // a prepare slice outlives its session; back at idle (or error) drop it, so a later join does not show
          // a stale "The host is preparing the video"
          const phase = (data as CoreEvents['session']).phase
          if (phase === 'idle' || phase === 'error') delete core.prepare
          const prev = s.core.session?.phase
          const leavingFrom = phase !== 'leaving' ? null : prev === 'leaving' ? s.leavingFrom : (prev ?? null)
          return { core, leavingFrom }
        })
      }),
    )
  }
  offs.push(wt.core.on('notice', (n) => pushToast(noticeToast(wt, n))))
  offs.push(wt.app.onSettings((settings) => useApp.setState({ settings })))
  offs.push(wt.app.onTheme((theme) => useApp.setState({ theme })))
  if (wt.app.onAppCommand) {
    offs.push(
      wt.app.onAppCommand((cmd) => {
        if (cmd === 'open-settings') setUi({ settingsOpen: true })
        // the tray's "Leave room…": only where a prompt is drawn (not while a leave already runs, which would only
        // offer a second, refused one); while preparing, that is HostPrepare's "Stop hosting?"
        else if (leavePromptFor(useApp.getState())) setUi({ leaveOpen: true })
      }),
    )
  }
  // An open prompt belongs to the session state it was opened in: once that moves on (preparing becomes the Room,
  // a core restart goes back Home), it closes, instead of changing meaning under the pointer or popping up later.
  let prompt = leavePromptFor(useApp.getState())
  offs.push(
    useApp.subscribe((s) => {
      const next = leavePromptFor(s)
      if (next === prompt) return
      prompt = next
      if (s.ui.leaveOpen) setUi({ leaveOpen: false })
    }),
  )
  if (wt.app.reportSession) {
    const report = wt.app.reportSession.bind(wt.app)
    let last = ''
    offs.push(
      useApp.subscribe((s) => {
        const inRoom = isActivePhase(s.core.session?.phase)
        const title = inRoom ? (s.core.room?.name ?? s.core.session?.fileName ?? null) : null
        // only while true: main's quit prompt then says that quitting interrupts the export
        const saving = isSaving(s)
        const key = JSON.stringify([inRoom, title, saving])
        if (key === last) return
        last = key
        report(saving ? { inRoom, title, saving } : { inRoom, title })
      }),
    )
  }
  void wt.app.getSettings().then((settings) => useApp.setState({ settings }))
  void wt.app.getTheme().then((theme) => useApp.setState({ theme }))
  void wt.app.info().then((info) => useApp.setState({ info }))
  return () => {
    for (const off of offs) off()
  }
}

function noticeToast(wt: WtBridge, n: NoticeEvent): Omit<Toast, 'id'> {
  const { action, path } = n
  return {
    level: n.level,
    message: n.message,
    code: codeAbout(n.code, noticeAbout(n)),
    // a file the notice is about (a saved video: core says so for every finished save, also one it finished at
    // startup): it stays until dismissed, since the save may finish while nobody watches
    ...(path ? { sticky: true } : {}),
    ...(action
      ? { action: { label: action.label, request: action.request, params: action.params } }
      : path
        ? { action: { label: 'Show in folder', run: () => void wt.app.showItemInFolder(path) } }
        : {}),
  }
}

/** What a notice is about: its file, else the room its action is for (a cut-off save's Finish saving). */
function noticeAbout(n: NoticeEvent): string | null {
  if (n.path) return n.path
  const params = n.action?.params
  if (typeof params === 'object' && params !== null && 'roomId' in params && typeof params.roomId === 'string') {
    return params.roomId
  }
  // a save's notice with no subject (an older core): its message names the video, so two saves keep two toasts
  return n.code.startsWith('transfer.export-') ? n.message : null
}

/** Tests only. */
export function resetStore(): void {
  playhead.reset()
  useApp.setState(initialState(), true)
}
