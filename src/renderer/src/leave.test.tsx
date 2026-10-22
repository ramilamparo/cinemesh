import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../shared/ipc/core'
import { CodedError } from '../../shared/result'
import { leaveRoom, saveFile } from './leave'
import type { FakeCore } from './mock/fake-core'
import * as fx from './mock/fixtures'
import { SCENARIOS } from './mock/scenarios'
import { selectScreen } from './route'
import { type LeaveKind, type Toast, isSaving, leaveKind, setUi, useApp } from './store'
import {
  type Mounted,
  allByRole,
  byRole,
  callsOf,
  click,
  flush,
  key,
  mountApp,
  queryByRole,
  text,
} from './test/harness'

// session.leave / transfer.saveFile: phase 'leaving' keeps the screen the leave started on, locked, with a
// banner; one leave at a time; the saved path (or why saving failed) once core answers.

const SAVED = `/home/alex/Downloads/Cinemesh/${fx.FILE.name}`

/** A request handler that stays open until `release()`, as a long 'save' export does. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => (release = resolve))
  return { wait, release }
}

/**
 * Core's 'leaving' event: the session's role, room, file and media (no joinInfo or error), and what runs when
 * `leave` is given (SessionEvent.leave; without it, a core that does not say).
 */
function emitLeaving(fake: FakeCore, leave?: SessionEvent['leave']): void {
  const s = fake.state.session
  if (!s) throw new Error('no session')
  const leaving: SessionEvent = {
    phase: 'leaving',
    role: s.role,
    roomId: s.roomId,
    fileName: s.fileName,
    fileSize: s.fileSize,
    durationS: s.durationS,
    ...(s.media ? { media: s.media } : {}),
    ...(leave ? { leave } : {}),
  }
  fake.emit('session', leaving)
}

/** The toasts that say where a saved video went (core's transfer.export-finished notices). */
const savedToasts = (): Toast[] =>
  useApp
    .getState()
    .toasts.filter((t) => t.code?.startsWith('transfer.export-finished') || t.message.startsWith('Saved'))

const screenOf = (m: Mounted): string | null =>
  m.container.querySelector('[data-screen]')?.getAttribute('data-screen') ?? null

/** Disabled as a browser sees it: own attribute or a disabled fieldset around it (happy-dom checks only the first). */
const isDisabled = (el: Element): boolean => el.hasAttribute('disabled') || el.closest('fieldset[disabled]') !== null

function roomControls(m: Mounted): HTMLElement[] {
  const main = m.container.querySelector('main')
  if (!main) throw new Error('no main')
  return [...main.querySelectorAll<HTMLElement>('button, input, select, textarea')]
}

describe('leaving the room', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it("core's 'leaving' phase keeps the Room up with a banner and every control locked", async () => {
    m = await mountApp('leaving')
    expect(screenOf(m)).toBe('room')
    expect(text(byRole(m.container, 'status', 'Leaving the room'))).toBe('Leaving the room…')
    // even with full control: nothing may reach core while leaving
    act(() => m?.fake.emit('sync', fx.sync('viewer', { canPlayPause: true, canSeek: true })))
    await flush()
    const controls = roomControls(m)
    for (const name of [/^Leave$/, 'Copy invite', /^Play$/, 'Forward 5 seconds', 'Mute', 'Show player']) {
      expect(controls).toContain(byRole(m.container, 'button', name))
    }
    expect(controls.filter((c) => !isDisabled(c)).map((c) => c.textContent)).toEqual([])
    expect(byRole(m.container, 'slider', 'Playback position').getAttribute('aria-disabled')).toBe('true')
    // no shortcut, no seek from the timeline, no second leave from the tray
    await key(document.body, ' ')
    await key(byRole(m.container, 'slider', 'Playback position'), 'ArrowRight')
    expect(callsOf(m.fake, 'playback.intent')).toEqual([])
    act(() => m?.fake.command('leave'))
    await flush()
    expect(queryByRole(m.container, 'dialog', 'Leave the room?')).toBeNull()
  })

  it('the controls come back when the leave is refused before it starts', async () => {
    m = await mountApp('room-viewer')
    m.fake.handle('session.leave', () => {
      throw new CodedError('busy', 'Already leaving the room')
    })
    await click(byRole(m.container, 'button', /^Leave$/))
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'Keep for later'))
    expect(queryByRole(m.container, 'status', 'Leaving the room')).toBeNull()
    expect(
      roomControls(m)
        .filter(isDisabled)
        .map((c) => c.textContent),
    ).not.toContain('Leave')
    expect(text(byRole(m.container, 'region', 'Notifications'))).toContain('Already leaving the room')
    // the click on Leave did not leave a prompt waiting to pop up
    expect(queryByRole(m.container, 'dialog', 'Leave the room?')).toBeNull()
  })

  it('locks at the click, before core reports the phase, and drops a second leave or save', async () => {
    m = await mountApp('room-closed-complete')
    const g = gate()
    m.fake.handle('session.leave', async () => {
      await g.wait
      // refused before it started (core's phase never moved): the room comes back
      throw new CodedError('busy', 'Already leaving the room')
    })
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Keep for later'))
    expect(m.fake.state.session?.phase).toBe('ended')
    expect(text(byRole(m.container, 'status', 'Leaving the room'))).toBe('Leaving the room…')
    expect(queryByRole(m.container, 'region', 'The host ended the room')).toBeNull()
    expect(roomControls(m).filter((c) => !isDisabled(c))).toEqual([])

    // no prompt is drawn while leaving, whoever opens it
    act(() => setUi({ leaveOpen: true }))
    await flush()
    expect(queryByRole(m.container, 'dialog', 'Leave the room?')).toBeNull()
    act(() => setUi({ leaveOpen: false }))
    // whatever still asks (a stale handler, the header's Leave, the tray): nothing more reaches core
    expect(await leaveRoom('delete')).toBeNull()
    await saveFile()
    await click(byRole(m.container, 'button', /^Leave$/))
    act(() => m?.fake.command('leave'))
    await flush()
    expect(queryByRole(m.container, 'dialog', 'Leave the room?')).toBeNull()
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep' }])
    expect(callsOf(m.fake, 'transfer.saveFile')).toEqual([])

    g.release()
    await flush()
    expect(queryByRole(m.container, 'status', 'Leaving the room')).toBeNull()
    expect(byRole(m.container, 'region', 'The host ended the room')).toBeTruthy()
    // the Leave and tray presses during the leave did not leave a prompt waiting to pop up now
    expect(queryByRole(m.container, 'dialog', 'Leave the room?')).toBeNull()
  })

  it("a viewer's save shows 'Saving the video…', then where it went with Show in folder", async () => {
    m = await mountApp('room-closed-complete')
    const fake = m.fake
    const g = gate()
    fake.handle('transfer.saveFile', async () => {
      emitLeaving(fake)
      await g.wait
      // core's transfer.export-finished notice says where it went
      await fake.leaveFlow(0, 'save')
      return { path: SAVED }
    })
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Save file'))
    expect(screenOf(m)).toBe('room')
    const banner = byRole(m.container, 'status', 'Saving the video')
    expect(text(banner)).toContain('Saving the video… this can take a few minutes')
    expect(roomControls(m).filter((c) => !isDisabled(c))).toEqual([])
    expect(callsOf(fake, 'transfer.saveFile')).toEqual([{}])

    g.release()
    await flush()
    expect(screenOf(m)).toBe('home')
    const toasts = byRole(m.container, 'region', 'Notifications')
    expect(text(toasts)).toContain(`Saved ${fx.FILE.name}`)
    // the export may finish while nobody watches: the toast stays until dismissed
    expect(savedToasts().map((t) => t.sticky)).toEqual([true])
    await click(byRole(toasts, 'button', 'Show in folder'))
    expect(fake.appCalls.filter((c) => c.method === 'showItemInFolder')).toEqual([
      { method: 'showItemInFolder', params: [SAVED] },
    ])
  })

  it("the leave prompt saves with transfer.saveFile; core's notice says where it went", async () => {
    m = await mountApp('room-viewer')
    act(() => {
      const t = m?.fake.state.transfer
      if (t) m?.fake.emit('transfer', { ...t, progress: 1 })
    })
    await flush()
    await click(byRole(m.container, 'button', /^Leave$/))
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'Save file'))
    expect(callsOf(m.fake, 'transfer.saveFile')).toEqual([{}])
    expect(callsOf(m.fake, 'session.leave')).toEqual([])
    expect(screenOf(m)).toBe('home')
    expect(text(byRole(m.container, 'region', 'Notifications'))).toContain(`Saved ${fx.FILE.name}`)
    await click(byRole(byRole(m.container, 'region', 'Notifications'), 'button', 'Show in folder'))
    expect(m.fake.appCalls.filter((c) => c.method === 'showItemInFolder').map((c) => c.params)).toEqual([[SAVED]])
  })

  it("'incomplete' after leaving shows core's message and offers to rejoin", async () => {
    m = await mountApp('room-closed-complete')
    const fake = m.fake
    const message = 'Some downloaded data was missing. Rejoin the room to download it again, then save.'
    fake.handle('transfer.saveFile', async () => {
      await fake.leaveFlow(0)
      throw new CodedError('incomplete', message)
    })
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Save file'))
    expect(screenOf(m)).toBe('home')
    const alert = byRole(byRole(m.container, 'region', 'Notifications'), 'alert')
    expect(text(alert)).toContain(message)
    expect(text(alert)).not.toContain('Saving the file failed')
    await click(byRole(alert, 'button', 'Rejoin'))
    expect(callsOf(fake, 'session.resume')).toEqual([{ roomId: fx.ROOM_ID }])
  })

  it("'incomplete' before leaving (not fully downloaded) keeps the room and offers no rejoin", async () => {
    m = await mountApp('ended-viewer')
    act(() => {
      const t = m?.fake.state.transfer
      if (t) m?.fake.emit('transfer', { ...t, progress: 1 })
    })
    await flush()
    m.fake.handle('transfer.saveFile', () => {
      throw new CodedError('incomplete', 'The video is not fully downloaded yet')
    })
    await click(byRole(byRole(m.container, 'region', 'The video has ended'), 'button', 'Save file…'))
    expect(callsOf(m.fake, 'transfer.saveFile')).toEqual([{ dest: '/media/alex/External' }])
    expect(screenOf(m)).toBe('room')
    expect(queryByRole(m.container, 'status', 'Saving the video')).toBeNull()
    const alert = byRole(byRole(m.container, 'region', 'Notifications'), 'alert')
    expect(text(alert)).toContain('The video is not fully downloaded yet')
    expect(queryByRole(alert, 'button', 'Rejoin')).toBeNull()
    expect(isDisabled(byRole(m.container, 'button', 'Save file…'))).toBe(false)
  })

  it('JoinConfirm Cancel stays on the join screen while leaving: no empty Room flashes', async () => {
    m = await mountApp('confirm-join')
    const fake = m.fake
    const g = gate()
    fake.handle('session.leave', async () => {
      emitLeaving(fake)
      await g.wait
      await fake.leaveFlow(0)
      return null
    })
    const screens: string[] = []
    const off = useApp.subscribe((s) => screens.push(selectScreen(s.core, s.leavingFrom)))
    try {
      await click(byRole(m.container, 'button', 'Cancel'))
      expect(fake.state.session?.phase).toBe('leaving')
      expect(screenOf(m)).toBe('join')
      expect(text(m.container)).toContain('Cancelling…')
      expect(queryByRole(m.container, 'button', 'Cancel')).toBeNull()
      g.release()
      await flush()
      expect(screenOf(m)).toBe('home')
      expect(screens).not.toContain('room')
    } finally {
      off()
    }
  })

  it('a new snapshot that is already leaving shows the Room, whatever screen the old one left from', async () => {
    m = await mountApp('confirm-join')
    const fake = m.fake
    const g = gate()
    fake.handle('session.leave', async () => {
      emitLeaving(fake)
      await g.wait
      return null
    })
    await click(byRole(m.container, 'button', 'Cancel'))
    expect(screenOf(m)).toBe('join')
    // core sends a whole new snapshot (e.g. after reconnecting): nothing says where that leave started
    act(() => fake.reset(SCENARIOS.leaving()))
    await flush()
    expect(screenOf(m)).toBe('room')
    g.release()
  })

  it('HostPrepare Cancel stays on HostPrepare, disabled, while core reports leaving', async () => {
    m = await mountApp('preparing')
    const fake = m.fake
    const g = gate()
    fake.handle('session.cancelPrepare', async () => {
      emitLeaving(fake)
      await g.wait
      await fake.leaveFlow(0)
      return null
    })
    await click(byRole(m.container, 'button', 'Cancel'))
    expect(screenOf(m)).toBe('host-prepare')
    const button = byRole(m.container, 'button', 'Cancelling…')
    expect(button.hasAttribute('disabled')).toBe(true)
    g.release()
    await flush()
    expect(screenOf(m)).toBe('home')
    expect(callsOf(fake, 'session.cancelPrepare')).toHaveLength(1)
  })

  it('the error screen stays up with Back to Home disabled while leaving', async () => {
    m = await mountApp('error')
    const fake = m.fake
    const g = gate()
    fake.handle('session.leave', async () => {
      emitLeaving(fake)
      await g.wait
      await fake.leaveFlow(0)
      return null
    })
    await click(byRole(m.container, 'button', 'Back to Home'))
    expect(screenOf(m)).toBe('error')
    expect(byRole(m.container, 'button', 'Back to Home').hasAttribute('disabled')).toBe(true)
    g.release()
    await flush()
    expect(screenOf(m)).toBe('home')
  })

  it('a deep link that arrives while leaving waits for the leave, then joins without asking', async () => {
    m = await mountApp('room-viewer')
    const fake = m.fake
    const g = gate()
    fake.handle('session.leave', async () => {
      emitLeaving(fake)
      await g.wait
      await fake.leaveFlow(0)
      return null
    })
    await click(byRole(m.container, 'button', /^Leave$/))
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'Keep for later'))
    act(() => fake.deepLink(fx.INVITE))
    await flush()
    expect(queryByRole(m.container, 'dialog', 'Join another room?')).toBeNull()
    expect(callsOf(fake, 'session.join')).toEqual([])
    g.release()
    await flush()
    expect(callsOf(fake, 'session.leave')).toEqual([{ data: 'keep' }])
    expect(callsOf(fake, 'session.join')).toEqual([{ invite: fx.INVITE }])
    expect(allByRole(m.container, 'dialog')).toEqual([])
  })

  it('a deep link on the error screen leaves quietly, then joins', async () => {
    m = await mountApp('error')
    m.fake.handle('session.leave', () => {
      throw new CodedError('no-session', 'You are not in a room')
    })
    act(() => m?.fake.deepLink(fx.INVITE))
    await flush()
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep' }])
    expect(callsOf(m.fake, 'session.join')).toEqual([{ invite: fx.INVITE }])
    expect(text(byRole(m.container, 'region', 'Notifications'))).not.toContain('You are not in a room')
  })

  it('main keeps treating the window as in a room while leaving (hide on close, ask before quitting)', async () => {
    m = await mountApp('room-viewer')
    const fake = m.fake
    act(() => emitLeaving(fake))
    await flush()
    expect(m.fake.reports.at(-1)).toEqual({ inRoom: true, title: "Maya's room" })
  })
})

describe("one Saved toast per finished save, from core's notice", () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  const shownInFolder = (mounted: Mounted): unknown[] =>
    mounted.fake.appCalls.filter((c) => c.method === 'showItemInFolder').map((c) => c.params)

  /** Clicks the one Saved toast's Show in folder; the path it opens. */
  async function savedPath(mounted: Mounted): Promise<unknown> {
    expect(savedToasts().map((t) => t.message)).toEqual([`Saved ${fx.FILE.name}`])
    const toasts = byRole(mounted.container, 'region', 'Notifications')
    expect(allByRole(toasts, 'button', 'Show in folder')).toHaveLength(1)
    await click(byRole(toasts, 'button', 'Show in folder'))
    return shownInFolder(mounted)[0]
  }

  it("the Closed card's Save file (transfer.saveFile into the join folder)", async () => {
    m = await mountApp('room-closed-complete')
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Save file'))
    expect(screenOf(m)).toBe('home')
    expect(await savedPath(m)).toEqual([SAVED])
  })

  it("the Ended card's Save file… (transfer.saveFile into a picked folder)", async () => {
    m = await mountApp('ended-viewer')
    act(() => {
      const t = m?.fake.state.transfer
      if (t) m?.fake.emit('transfer', { ...t, progress: 1 })
    })
    await flush()
    await click(byRole(byRole(m.container, 'region', 'The video has ended'), 'button', 'Save file…'))
    expect(await savedPath(m)).toEqual([`/media/alex/External/${fx.FILE.name}`])
  })

  it("session.leave {data: 'save'} too", async () => {
    m = await mountApp('room-closed-complete')
    await act(async () => {
      await leaveRoom('save')
    })
    await flush()
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'save' }])
    expect(await savedPath(m)).toEqual([SAVED])
  })

  it("transfer.saveFile's path alone adds no toast: where the video went is core's notice", async () => {
    m = await mountApp('room-closed-complete')
    const fake = m.fake
    // a save that answers with its path, but whose notice has not come (yet)
    fake.handle('transfer.saveFile', async () => {
      await fake.leaveFlow(0)
      return { path: SAVED }
    })
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Save file'))
    expect(screenOf(m)).toBe('home')
    expect(savedToasts()).toEqual([])
    act(() => fake.emit('notice', fx.savedNotice(SAVED)))
    await flush()
    expect(await savedPath(m)).toEqual([SAVED])
  })
})

describe('what the leaving banner says (SessionEvent.leave)', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it.each([
    ['viewer', 'save', 'Saving the video… this can take a few minutes'],
    ['host', 'end', 'Ending the room…'],
    ['host', 'keep', 'Leaving the room…'],
    ['viewer', 'keep', 'Leaving the room…'],
    ['viewer', 'delete', 'Leaving the room…'],
  ] as const)("a %s's leave '%s' from core: %s", async (role, leave, banner) => {
    m = await mountApp(role === 'host' ? 'room-host' : 'room-viewer')
    const fake = m.fake
    act(() => emitLeaving(fake, leave))
    await flush()
    const status = byRole(m.container, 'status', banner)
    expect(text(status)).toContain(banner)
    expect(text(status).includes('Keep Cinemesh running')).toBe(leave === 'save')
  })

  it('a window reloaded mid-save still says Saving the video…, from the snapshot alone', async () => {
    m = await mountApp('leaving-save')
    expect(useApp.getState().ui.leaving).toBeNull()
    expect(screenOf(m)).toBe('room')
    expect(text(byRole(m.container, 'status', 'Saving the video'))).toContain(
      'Saving the video… this can take a few minutes',
    )
    expect(roomControls(m).filter((c) => !isDisabled(c))).toEqual([])
  })

  it("the host's End room says Ending the room… from the click, before core's event", async () => {
    m = await mountApp('room-host')
    const fake = m.fake
    const g = gate()
    fake.handle('session.leave', async () => {
      await g.wait
      await fake.leaveFlow(0, 'end')
      return null
    })
    await click(byRole(m.container, 'button', /^Leave$/))
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'End room for everyone'))
    expect(fake.state.session?.phase).toBe('in-room')
    expect(text(byRole(m.container, 'status', 'Ending the room'))).toBe('Ending the room…')
    g.release()
    await flush()
    expect(screenOf(m)).toBe('home')
  })

  it("core's word wins over what this window asked; without it, the window's own request", () => {
    const leavingSession = (leave?: SessionEvent['leave']): SessionEvent => ({
      phase: 'leaving',
      role: 'viewer',
      roomId: fx.ROOM_ID,
      fileName: fx.FILE.name,
      fileSize: fx.FILE.size,
      durationS: fx.FILE.durationS,
      ...(leave ? { leave } : {}),
    })
    const state = (session: SessionEvent | undefined, leaving: LeaveKind | null): Parameters<typeof leaveKind>[0] => ({
      core: session ? { session } : {},
      ui: { settingsOpen: false, leaveOpen: false, incomingLink: null, leaving },
    })
    expect(leaveKind(state(leavingSession('save'), 'keep'))).toBe('save')
    expect(leaveKind(state(leavingSession(), 'save'))).toBe('save')
    expect(leaveKind(state(leavingSession(), null))).toBeNull()
    // `leave` means something only with phase 'leaving'
    expect(leaveKind(state({ ...leavingSession('save'), phase: 'in-room' }, 'keep'))).toBe('keep')
    expect(leaveKind(state(undefined, null))).toBeNull()
    // saving: the export runs, which needs core's phase (a click alone has nothing to interrupt yet)
    expect(isSaving(state(leavingSession('save'), null))).toBe(true)
    expect(isSaving(state(leavingSession(), 'save'))).toBe(true)
    expect(isSaving(state(leavingSession('keep'), 'save'))).toBe(false)
    expect(isSaving(state({ ...leavingSession(), phase: 'ended' }, 'save'))).toBe(false)
  })
})

describe('SessionReport.saving', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it("tells main while core's save export runs, so its quit prompt can say quitting interrupts it", async () => {
    m = await mountApp('room-closed-complete')
    const fake = m.fake
    const g = gate()
    fake.handle('transfer.saveFile', async () => {
      emitLeaving(fake, 'save')
      await g.wait
      await fake.leaveFlow(0, 'save')
      return { path: SAVED }
    })
    expect(fake.reports.at(-1)).toEqual({ inRoom: true, title: "Maya's room" })
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Save file'))
    expect(fake.reports.at(-1)).toEqual({ inRoom: true, title: "Maya's room", saving: true })
    g.release()
    await flush()
    expect(fake.reports.at(-1)).toEqual({ inRoom: false, title: null })
  })

  it('after a reload mid-save too, from the snapshot', async () => {
    m = await mountApp('leaving-save')
    expect(m.fake.reports.at(-1)).toEqual({ inRoom: true, title: "Maya's room", saving: true })
  })

  it("not for other leaves; from this window's own save when core does not say what runs", async () => {
    m = await mountApp('room-viewer')
    const fake = m.fake
    act(() => emitLeaving(fake, 'keep'))
    await flush()
    expect(fake.reports.map((r) => r.saving)).not.toContain(true)
    await m.cleanup()

    m = await mountApp('room-closed-complete')
    const older = m.fake
    const g = gate()
    older.handle('transfer.saveFile', async () => {
      emitLeaving(older)
      await g.wait
      await older.leaveFlow(0)
      return { path: SAVED }
    })
    await click(byRole(byRole(m.container, 'region', 'The host ended the room'), 'button', 'Save file'))
    expect(older.reports.at(-1)).toEqual({ inRoom: true, title: "Maya's room", saving: true })
    g.release()
    await flush()
    expect(older.reports.at(-1)?.saving).toBeUndefined()
  })
})

describe('the leave prompt goes only where it is drawn', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  const command = async (mounted: Mounted): Promise<void> => {
    act(() => mounted.fake.command('leave'))
    await flush()
  }

  it("the tray's Leave room… while preparing asks to stop hosting; confirming cancels it", async () => {
    m = await mountApp('preparing')
    await command(m)
    const dialog = byRole(m.container, 'dialog', 'Stop hosting?')
    expect(text(dialog)).toContain('the room ends')
    expect(queryByRole(m.container, 'dialog', 'Leave the room?')).toBeNull()
    await click(byRole(dialog, 'button', 'Stop hosting'))
    expect(callsOf(m.fake, 'session.cancelPrepare')).toHaveLength(1)
    expect(callsOf(m.fake, 'session.leave')).toEqual([])
    expect(screenOf(m)).toBe('home')
    expect(allByRole(m.container, 'dialog')).toEqual([])
  })

  it('Keep preparing closes it, and no prompt pops up once the room opens', async () => {
    m = await mountApp('preparing')
    await command(m)
    await click(byRole(byRole(m.container, 'dialog', 'Stop hosting?'), 'button', 'Keep preparing'))
    expect(allByRole(m.container, 'dialog')).toEqual([])
    expect(callsOf(m.fake, 'session.cancelPrepare')).toEqual([])
    act(() => m?.fake.set(fx.inRoom('host', performance.now())))
    await flush()
    expect(screenOf(m)).toBe('room')
    expect(allByRole(m.container, 'dialog')).toEqual([])
  })

  // round-3 review repro: the prompt used to wait unseen on HostPrepare, then pop up in the Room unprompted
  it("a prompt still open when preparing finishes closes instead of turning into the Room's", async () => {
    m = await mountApp('preparing')
    await command(m)
    expect(byRole(m.container, 'dialog', 'Stop hosting?')).toBeTruthy()
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    act(() => m?.fake.emit('session', { ...s, phase: 'in-room' }))
    act(() => m?.fake.emit('sync', fx.sync('host')))
    await flush()
    expect(screenOf(m)).toBe('room')
    expect(allByRole(m.container, 'dialog')).toEqual([])
    expect(useApp.getState().ui.leaveOpen).toBe(false)
  })

  it('a prompt open when core restarts at idle does not come back with the next room', async () => {
    m = await mountApp('room-viewer')
    await click(byRole(m.container, 'button', /^Leave$/))
    expect(byRole(m.container, 'dialog', 'Leave the room?')).toBeTruthy()
    act(() => m?.fake.reset(SCENARIOS.home()))
    await flush()
    expect(screenOf(m)).toBe('home')
    expect(allByRole(m.container, 'dialog')).toEqual([])
    act(() => m?.fake.set(fx.inRoom('viewer', performance.now())))
    await flush()
    expect(screenOf(m)).toBe('room')
    expect(allByRole(m.container, 'dialog')).toEqual([])
  })

  it("the Room's prompt stays when the host closes the room under it (same choices)", async () => {
    m = await mountApp('room-viewer')
    await click(byRole(m.container, 'button', /^Leave$/))
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    act(() => m?.fake.emit('session', { ...s, phase: 'ended' }))
    await flush()
    expect(byRole(m.container, 'dialog', 'Leave the room?')).toBeTruthy()
  })

  it.each(['home', 'connecting', 'confirm-join', 'error'] as const)(
    "the tray's Leave room… on %s opens nothing and leaves nothing waiting",
    async (scenario) => {
      m = await mountApp(scenario)
      await command(m)
      expect(allByRole(m.container, 'dialog')).toEqual([])
      expect(useApp.getState().ui.leaveOpen).toBe(false)
    },
  )

  it("in a room whose player went missing, the tray's Leave room… still asks (over MpvSetup)", async () => {
    m = await mountApp('room-viewer')
    act(() => m?.fake.emit('player', fx.player('missing')))
    await flush()
    expect(screenOf(m)).toBe('mpv-setup')
    await command(m)
    await click(byRole(byRole(m.container, 'dialog', 'Leave the room?'), 'button', 'Keep for later'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep' }])
  })
})
