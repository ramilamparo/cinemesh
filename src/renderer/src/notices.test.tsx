import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NoticeEvent } from '../../shared/ipc/core'
import * as fx from './mock/fixtures'
import { SCENARIO_NOTICES } from './mock/scenarios'
import { type Toast, useApp } from './store'
import { type Mounted, allByRole, byRole, callsOf, click, flush, mountApp, queryByRole, text } from './test/harness'

// Core's notices become toasts. One about a file (NoticeEvent.path: a video that an export a quit interrupted
// finished saving at startup) offers Show in folder; the others render as they are.

const toasts = (m: Mounted): HTMLElement => byRole(m.container, 'region', 'Notifications')
/** The toasts of a notice code; one about a file or a room has that in its toast code too (store.codeAbout). */
const toastsOf = (code: string): Toast[] =>
  useApp.getState().toasts.filter((t) => t.code === code || t.code?.startsWith(`${code}:`))
const toastOf = (code: string): Toast | undefined => toastsOf(code)[0]

describe('notices', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('a notice about a file offers Show in folder and stays until dismissed', async () => {
    m = await mountApp('home')
    const { finished } = fx.exportNotices('/media/alex/External/Film.mkv')
    act(() => m?.fake.emit('notice', finished))
    await flush()
    expect(text(toasts(m))).toContain(finished.message)
    // it may arrive at startup, with nobody watching
    expect(toastOf('transfer.export-finished')?.sticky).toBe(true)
    await click(byRole(toasts(m), 'button', 'Show in folder'))
    expect(m.fake.appCalls.filter((c) => c.method === 'showItemInFolder')).toEqual([
      { method: 'showItemInFolder', params: ['/media/alex/External/Film.mkv'] },
    ])
    // the action dismisses it, like the saved-path toast
    expect(toastOf('transfer.export-finished')).toBeUndefined()
  })

  it('export-resumed and export-failed render as normal notices', async () => {
    m = await mountApp('home')
    const { resumed, failed } = fx.exportNotices()
    act(() => m?.fake.emit('notice', resumed))
    act(() => m?.fake.emit('notice', failed))
    await flush()
    expect(text(toasts(m))).toContain(resumed.message)
    expect(text(toasts(m))).toContain(failed.message)
    expect(queryByRole(toasts(m), 'button', 'Show in folder')).toBeNull()
    for (const n of [resumed, failed]) {
      // core's level and code, keyed by what it is about (here its message: no path, no room) so two saves keep two
      expect(toastOf(n.code)).toMatchObject({ level: n.level, code: `${n.code}:${n.message}` })
      expect(toastOf(n.code)?.sticky).toBeUndefined()
      expect(toastOf(n.code)?.action).toBeUndefined()
    }
  })

  it('two failed saves at one startup keep two toasts, with or without a room to resume', async () => {
    m = await mountApp('home')
    const failedA: NoticeEvent = {
      level: 'warn',
      code: 'transfer.export-failed',
      message: 'Could not finish saving A.mkv: the partly saved video is gone.',
      action: { label: 'Resume', request: 'session.resume', params: { roomId: 'room-a' } },
    }
    const failedB: NoticeEvent = {
      ...failedA,
      message: 'Could not finish saving B.mkv: parts of the download are gone.',
    }
    const { action: _a, ...noRoomC } = { ...failedA, message: 'Saving C.mkv stopped: EIO.' }
    const { action: _b, ...noRoomD } = { ...failedA, message: 'Saving D.mkv stopped: EIO.' }
    const roomB = { ...failedB, action: { ...failedA.action, params: { roomId: 'room-b' } } } as NoticeEvent
    for (const n of [failedA, roomB, noRoomC, noRoomD]) act(() => m?.fake.emit('notice', n))
    await flush()
    expect(toastsOf('transfer.export-failed')).toHaveLength(4)
  })

  it("core's own action wins over the path (one action per toast)", async () => {
    m = await mountApp('home')
    act(() =>
      m?.fake.emit('notice', {
        level: 'warn',
        code: 'transfer.export-failed',
        message: 'Saving the video failed.',
        path: '/home/alex/Downloads/Cinemesh/part.mkv',
        action: { label: 'Rejoin', request: 'session.resume', params: { roomId: fx.ROOM_ID } },
      }),
    )
    await flush()
    expect(queryByRole(toasts(m), 'button', 'Show in folder')).toBeNull()
    await click(byRole(toasts(m), 'button', 'Rejoin'))
    expect(callsOf(m.fake, 'session.resume')).toEqual([{ roomId: fx.ROOM_ID }])
  })

  // round-4 review repro: core finishes two cut-off saves at one startup, one after the other; the second notice used
  // to replace the first one's toast, and with it where the first video went
  it('two saved videos keep a Show in folder toast each', async () => {
    m = await mountApp('home')
    const a = fx.exportNotices('/home/alex/Downloads/A.mkv')
    const b = fx.exportNotices('/media/alex/External/B.mkv')
    for (const n of [a.resumed, a.finished, b.resumed, b.finished]) act(() => m?.fake.emit('notice', n))
    await flush()
    expect(toastsOf('transfer.export-finished').map((t) => [t.message, t.sticky])).toEqual([
      [a.finished.message, true],
      [b.finished.message, true],
    ])
    const buttons = allByRole(toasts(m), 'button', 'Show in folder')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) await click(button)
    expect(m.fake.appCalls.filter((c) => c.method === 'showItemInFolder').map((c) => c.params)).toEqual([
      ['/home/alex/Downloads/A.mkv'],
      ['/media/alex/External/B.mkv'],
    ])
  })

  it('the same notice about the same thing still replaces its toast, also without a file or a room', async () => {
    m = await mountApp('home')
    const { resumed, finished } = fx.exportNotices('/media/alex/External/Film.mkv')
    for (const n of [finished, resumed, finished, resumed]) act(() => m?.fake.emit('notice', n))
    await flush()
    expect(toastsOf('transfer.export-finished')).toHaveLength(1)
    expect(toastsOf('transfer.export-resumed')).toHaveLength(1)
    expect(useApp.getState().toasts).toHaveLength(2)
  })

  it("two rooms' saves waiting for their folders keep a toast each, each Finish saving for its room", async () => {
    m = await mountApp('home')
    const a = fx.waitingNotice({ ...fx.cutOffSave(true), roomId: 'r-a' })
    const b = fx.waitingNotice({ ...fx.cutOffSave(true), roomId: 'r-b' })
    for (const n of [a, b, a]) act(() => m?.fake.emit('notice', n))
    await flush()
    expect(toastsOf('transfer.export-waiting')).toHaveLength(2)
    for (const button of allByRole(toasts(m), 'button', 'Finish saving')) await click(button)
    expect(callsOf(m.fake, 'transfer.finishExport')).toEqual([{ roomId: 'r-b' }, { roomId: 'r-a' }])
  })

  it("a notice's action that fails shows the usual error toast (its result is not dropped)", async () => {
    m = await mountApp('home')
    act(() =>
      m?.fake.emit('notice', {
        level: 'warn',
        code: 'session.resume-failed',
        message: 'The background process restarted and could not rejoin the room.',
        action: { label: 'Rejoin', request: 'session.resume', params: { roomId: 'r-gone' } },
      }),
    )
    await flush()
    await click(byRole(toasts(m), 'button', 'Rejoin'))
    expect(callsOf(m.fake, 'session.resume')).toEqual([{ roomId: 'r-gone' }])
    const alert = byRole(toasts(m), 'alert')
    expect(text(alert)).toContain('That room is no longer saved.')
    expect(toastOf('rpc:session.resume')?.level).toBe('error')
  })

  it("the browser mock's export-finished scenario sends both startup notices", () => {
    const sent = SCENARIO_NOTICES['export-finished']?.() ?? []
    expect(sent.map((n) => n.code)).toEqual(['transfer.export-resumed', 'transfer.export-finished'])
    expect(sent[1]?.path).toBe(`/home/alex/Downloads/Cinemesh/${fx.FILE.name}`)
  })

  it("the browser mock's recent-export-waiting scenario sends core's startup notice with Finish saving", () => {
    const sent = SCENARIO_NOTICES['recent-export-waiting']?.() ?? []
    expect(sent.map((n) => [n.code, n.action?.request, n.action?.params])).toEqual([
      ['transfer.export-waiting', 'transfer.finishExport', { roomId: fx.SAVE_ROOM_ID }],
    ])
  })
})
