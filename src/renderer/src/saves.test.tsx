import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoticeEvent } from '../../shared/ipc/core'
import { CodedError } from '../../shared/result'
import { createBrowserMock } from './mock'
import * as fx from './mock/fixtures'
import { finishExport, refreshRecent } from './saves'
import { type Toast, useApp } from './store'
import { type Mounted, allByRole, byRole, callsOf, click, flush, mountApp, queryByRole, text } from './test/harness'

// A 'save' that a quit, a crash or a missing drive cut off (RecentRoom.export): Home's Recent rooms offers Finish saving
// and Cancel saving instead of Resume, both transfer.finishExport, and shows what came of it. Core's
// transfer.export-waiting notice offers Finish saving with the same handling.

const NAME = fx.FILE.name
const ROOM = fx.SAVE_ROOM_ID

/** A request handler that stays open until `release()`, as finishing a long save does. */
function gate(): { wait: Promise<void>; release: () => void } {
  let release = (): void => undefined
  const wait = new Promise<void>((resolve) => (release = resolve))
  return { wait, release }
}

const recentRooms = (m: Mounted): HTMLElement => byRole(m.container, 'region', 'Recent rooms')
const notifications = (m: Mounted): HTMLElement => byRole(m.container, 'region', 'Notifications')
/** The cut-off save's Recent rooms entry, or null once it is gone. */
const entry = (m: Mounted): HTMLElement | null =>
  m.container.querySelector(`[data-testid="cut-off-${ROOM}"]`)?.closest('li') ?? null
const finishButton = (m: Mounted): HTMLElement => byRole(recentRooms(m), 'button', `Finish saving ${NAME}`)
const cancelButton = (m: Mounted): HTMLElement => byRole(recentRooms(m), 'button', `Cancel saving ${NAME}`)
const toastsOf = (code: string): Toast[] =>
  useApp.getState().toasts.filter((t) => t.code === code || t.code?.startsWith(`${code}:`))
const shownInFolder = (m: Mounted): unknown[] =>
  m.fake.appCalls.filter((c) => c.method === 'showItemInFolder').map((c) => c.params)

describe('a cut-off save in Recent rooms', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('says its save was cut off and into which folder, with Finish and Cancel saving instead of Resume', async () => {
    m = await mountApp('recent-export')
    const li = entry(m)
    if (!li) throw new Error('no cut-off save listed')
    expect(text(li)).toContain(`Saving ${NAME} into ${fx.JOIN_DIR} was cut off.`)
    expect(text(li)).not.toContain('Folder not connected')
    expect(queryByRole(li, 'button', 'Resume')).toBeNull()
    expect(finishButton(m).hasAttribute('disabled')).toBe(false)
    expect(cancelButton(m).hasAttribute('disabled')).toBe(false)
    // the other rooms are listed as before
    expect(byRole(recentRooms(m), 'button', 'Resume Nature.Documentary.S01E03.mkv')).toBeTruthy()
  })

  it('one core is finishing right now says so, with no buttons that would only be refused', async () => {
    m = await mountApp('recent-export')
    m.fake.recent = [fx.cutOffSave(false, true), ...fx.recentRooms()]
    await act(async () => {
      await refreshRecent()
    })
    const li = entry(m)
    if (!li) throw new Error('no cut-off save listed')
    expect(text(li)).toContain(`Finishing saving ${NAME} into ${fx.JOIN_DIR}…`)
    expect(queryByRole(recentRooms(m), 'button', `Finish saving ${NAME}`)).toBeNull()
    expect(queryByRole(recentRooms(m), 'button', `Cancel saving ${NAME}`)).toBeNull()
    expect(queryByRole(li, 'button', 'Resume')).toBeNull()
  })

  it('core finishing it by itself (at startup) refreshes the list: no stale entry stays', async () => {
    m = await mountApp('recent-export')
    expect(entry(m)).not.toBeNull()
    m.fake.recent = m.fake.recent.filter((r) => r.roomId !== ROOM)
    act(() => m?.fake.emit('notice', fx.savedNotice()))
    await flush()
    expect(entry(m)).toBeNull()
  })

  it('a refused Finish saving refreshes the list too: the entry was stale', async () => {
    m = await mountApp('recent-export')
    // core ended that save meanwhile, without a notice this window saw
    m.fake.recent = m.fake.recent.filter((r) => r.roomId !== ROOM)
    m.fake.handle('transfer.finishExport', () => {
      throw new CodedError('not-found', 'This room has no unfinished save')
    })
    await click(finishButton(m))
    expect(entry(m)).toBeNull()
  })

  it('one whose folder is not there says so, and still offers Finish saving (the drive may be back)', async () => {
    m = await mountApp('recent-export-waiting')
    const li = entry(m)
    if (!li) throw new Error('no cut-off save listed')
    expect(text(li)).toContain(`Saving ${NAME} into /media/alex/External was cut off. Folder not connected`)
    expect(finishButton(m).hasAttribute('disabled')).toBe(false)
  })

  it("Finish saving 'finished': the list is refreshed, and the one Saved toast is core's notice", async () => {
    m = await mountApp('recent-export')
    await click(finishButton(m))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }])
    // the room's download became the saved file, so core lists it no more
    expect(entry(m)).toBeNull()
    expect(callsOf(m.fake, 'session.recent').length).toBeGreaterThanOrEqual(2)
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual([`Saved ${NAME}`])
    await click(byRole(notifications(m), 'button', 'Show in folder'))
    expect(shownInFolder(m)).toEqual([[`${fx.JOIN_DIR}/${NAME}`]])
  })

  it('while it runs, its buttons are disabled, and a second Finish saving is dropped here', async () => {
    m = await mountApp('recent-export')
    const g = gate()
    m.fake.handle('transfer.finishExport', async () => {
      await g.wait
      return { outcome: 'waiting' }
    })
    const finish = finishButton(m)
    await click(finish)
    expect(text(finish)).toBe(`Saving… ${NAME}`)
    expect(finish.hasAttribute('disabled')).toBe(true)
    expect(cancelButton(m).hasAttribute('disabled')).toBe(true)
    // e.g. the Finish saving of core's notice meanwhile
    await act(async () => {
      await finishExport(ROOM)
    })
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }])
    g.release()
    await flush()
    expect(useApp.getState().finishing).toEqual({})
    expect(text(finishButton(m))).toBe(`Finish saving ${NAME}`)
    expect(finishButton(m).hasAttribute('disabled')).toBe(false)
  })

  it("Finish saving 'waiting': a toast asks to connect the folder's drive and try again", async () => {
    m = await mountApp('recent-export-waiting')
    await click(finishButton(m))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }])
    const toast = byRole(notifications(m), 'status', 'Cannot finish saving')
    expect(text(toast)).toContain(
      `Cannot finish saving ${NAME}: its folder /media/alex/External is not connected. Connect its drive, then try again.`,
    )
    expect(toastsOf('transfer.export-waiting').map((t) => t.level)).toEqual(['warn'])
    // nothing changed
    expect(entry(m)).not.toBeNull()

    // the drive is back
    m.fake.recent = m.fake.recent.map((r) => (r.export ? { ...r, export: { ...r.export, waiting: false } } : r))
    await click(byRole(toast, 'button', 'Try again'))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }, { roomId: ROOM }])
    expect(entry(m)).toBeNull()
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual([`Saved ${NAME}`])
    await click(byRole(notifications(m), 'button', 'Show in folder'))
    expect(shownInFolder(m)).toEqual([[`/media/alex/External/${NAME}`]])
  })

  it("Finish saving 'rejoin' (data it needed is gone): the room offers Resume; core's notice is the one word", async () => {
    m = await mountApp('recent-export-lost')
    await click(finishButton(m))
    expect(entry(m)).toBeNull()
    const resume = byRole(recentRooms(m), 'button', `Resume ${NAME}`)
    expect(resume.hasAttribute('disabled')).toBe(false)
    // what it had moved into the saved file counts as missing again
    const li = resume.closest('li')
    if (!li) throw new Error('no entry')
    expect(text(li)).toContain('62 % downloaded')
    // core says why (transfer.export-failed); nothing here says it again
    expect(useApp.getState().toasts.map((t) => [t.code, t.message])).toEqual([
      [
        `transfer.export-failed:${fx.exportNotices(`${fx.JOIN_DIR}/${NAME}`).failed.message}`,
        fx.exportNotices(`${fx.JOIN_DIR}/${NAME}`).failed.message,
      ],
    ])
    await click(resume)
    expect(callsOf(m.fake, 'session.resume')).toEqual([{ roomId: ROOM }])
  })

  it('Cancel saving asks first and says what it does; Go back changes nothing', async () => {
    m = await mountApp('recent-export')
    await click(cancelButton(m))
    const dialog = byRole(m.container, 'dialog', 'Cancel saving?')
    expect(text(dialog)).toContain(`${NAME} is not saved, and the room stays in Recent rooms.`)
    expect(text(dialog)).toContain('The parts already saved are downloaded again when you resume the room.')
    expect(text(dialog)).toContain(`The partly saved file in ${fx.JOIN_DIR} is deleted if that folder is there.`)
    await click(byRole(dialog, 'button', 'Go back'))
    expect(allByRole(m.container, 'dialog')).toEqual([])
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([])
    expect(entry(m)).not.toBeNull()
  })

  it('confirming Cancel saving gives the save up (giveUp), and the room offers Resume; nothing more to say', async () => {
    m = await mountApp('recent-export-waiting')
    await click(cancelButton(m))
    await click(byRole(byRole(m.container, 'dialog', 'Cancel saving?'), 'button', /^Cancel saving$/))
    expect(allByRole(m.container, 'dialog')).toEqual([])
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM, giveUp: true }])
    expect(entry(m)).toBeNull()
    expect(byRole(recentRooms(m), 'button', `Resume ${NAME}`).hasAttribute('disabled')).toBe(false)
    expect(useApp.getState().toasts).toEqual([])
  })

  it('a refresh that fails keeps the list shown', async () => {
    m = await mountApp('recent-export')
    m.fake.handle('session.recent', () => {
      throw new CodedError('core-restarted', 'The background process restarted')
    })
    await click(finishButton(m))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }])
    expect(byRole(recentRooms(m), 'button', 'Resume Nature.Documentary.S01E03.mkv')).toBeTruthy()
  })

  it("a refused request ('busy') is the usual error toast, and the entry stays", async () => {
    m = await mountApp('recent-export')
    m.fake.handle('transfer.finishExport', () => {
      throw new CodedError('busy', 'This video is being saved right now. Try again once it is saved.')
    })
    await click(finishButton(m))
    const alert = byRole(notifications(m), 'alert')
    expect(text(alert)).toContain('This video is being saved right now. Try again once it is saved.')
    expect(useApp.getState().toasts.map((t) => t.code)).toEqual(['rpc:transfer.finishExport'])
    expect(entry(m)).not.toBeNull()
    expect(finishButton(m).hasAttribute('disabled')).toBe(false)
  })
})

describe("core's transfer.export-waiting notice", () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it("its Finish saving runs transfer.finishExport with Home's outcome handling ('waiting')", async () => {
    m = await mountApp('recent-export-waiting')
    act(() => m?.fake.emit('notice', fx.waitingNotice()))
    await flush()
    await click(byRole(notifications(m), 'button', 'Finish saving'))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }])
    // the notice's toast went with the click; the outcome's asks to connect the drive
    expect(toastsOf('transfer.export-waiting').map((t) => t.message)).toEqual([
      `Cannot finish saving ${NAME}: its folder /media/alex/External is not connected. Connect its drive, then try again.`,
    ])
  })

  it("…and 'finished': Recent rooms is refreshed, and the only toast left is core's Saved", async () => {
    m = await mountApp('recent-export')
    act(() => m?.fake.emit('notice', fx.waitingNotice(fx.cutOffSave())))
    await flush()
    await click(byRole(notifications(m), 'button', 'Finish saving'))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM }])
    expect(entry(m)).toBeNull()
    expect(useApp.getState().toasts.map((t) => t.message)).toEqual([`Saved ${NAME}`])
  })

  it('an action that gives the save up is sent as one (giveUp), and says nothing more', async () => {
    m = await mountApp('recent-export-waiting')
    act(() =>
      m?.fake.emit('notice', {
        ...fx.waitingNotice(),
        action: { label: 'Cancel saving', request: 'transfer.finishExport', params: { roomId: ROOM, giveUp: true } },
      }),
    )
    await flush()
    await click(byRole(notifications(m), 'button', 'Cancel saving'))
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: ROOM, giveUp: true }])
    expect(byRole(recentRooms(m), 'button', `Resume ${NAME}`).hasAttribute('disabled')).toBe(false)
    expect(useApp.getState().toasts).toEqual([])
  })

  it("core's notice and a request's 'waiting' for the same room leave one toast, not two", async () => {
    m = await mountApp('recent-export-waiting')
    await click(finishButton(m))
    act(() => m?.fake.emit('notice', fx.waitingNotice()))
    await flush()
    expect(useApp.getState().toasts.map((t) => t.code)).toEqual([`transfer.export-waiting:${ROOM}`])
  })
})

describe("the browser mock's cut-off save scenarios", () => {
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    delete window.wtMock
  })

  it("recent-export-waiting lists the save as waiting and sends core's startup notice; Finish saving waits", async () => {
    vi.useFakeTimers()
    const fake = createBrowserMock('?mock=recent-export-waiting')
    const notices: NoticeEvent[] = []
    fake.bridge.core.on('notice', (n) => notices.push(n))
    const recent = await fake.bridge.core.request('session.recent', {})
    expect(recent.ok && recent.value.map((r) => [r.roomId, r.export?.waiting])).toEqual([
      [ROOM, true],
      ['r-old1', undefined],
      ['r-old2', undefined],
    ])
    vi.advanceTimersByTime(600)
    expect(notices.map((n) => [n.code, n.action?.params])).toEqual([['transfer.export-waiting', { roomId: ROOM }]])
    expect(await fake.bridge.core.request('transfer.finishExport', { roomId: ROOM })).toEqual({
      ok: true,
      value: { outcome: 'waiting' },
    })
    fake.dispose()
  })

  it("recent-export finishes ('finished', with core's Saved notice); recent-export-lost gives 'rejoin'", async () => {
    vi.useFakeTimers()
    for (const [scenario, outcome] of [
      ['recent-export', 'finished'],
      ['recent-export-lost', 'rejoin'],
    ] as const) {
      const fake = createBrowserMock(`?mock=${scenario}`)
      const notices: NoticeEvent[] = []
      fake.bridge.core.on('notice', (n) => notices.push(n))
      const done = fake.bridge.core.request('transfer.finishExport', { roomId: ROOM })
      await vi.advanceTimersByTimeAsync(3000)
      const r = await done
      expect(r.ok && r.value.outcome).toBe(outcome)
      expect(notices.map((n) => n.code)).toEqual([
        outcome === 'finished' ? 'transfer.export-finished' : 'transfer.export-failed',
      ])
      fake.dispose()
    }
  })
})
