import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const trays: FakeTray[] = []
class FakeTray extends EventEmitter {
  tooltip = ''
  menu: { label?: string; enabled?: boolean; click?: () => void; type?: string }[] = []
  constructor() {
    super()
    trays.push(this)
  }
  setToolTip(t: string): void {
    this.tooltip = t
  }
  setContextMenu(m: typeof this.menu): void {
    this.menu = m
  }
  displayBalloon(): void {}
  destroy(): void {}
}
const appEvents = new EventEmitter()
const quit = vi.fn()
const showMessageBox = vi.fn((..._args: unknown[]) => Promise.resolve({ response: 0 }))

vi.mock('electron', () => ({
  Tray: FakeTray,
  Menu: { buildFromTemplate: (t: unknown) => t },
  app: { on: (e: string, cb: () => void) => appEvents.on(e, cb), quit },
  dialog: { showMessageBox },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBitmap: (buf: Buffer, o: { width: number }) => ({ buf, width: o.width }),
  },
}))

const { AppTray, parseSessionReport, trayIconBitmap, confirmQuitInRoom } = await import('./tray.js')

class FakeWindow extends EventEmitter {
  visible = true
  sent: unknown[][] = []
  webContents = { send: (...a: unknown[]) => this.sent.push(a) }
  isDestroyed = () => false
  isMinimized = () => false
  restore = vi.fn()
  hide = () => {
    this.visible = false
  }
  show = () => {
    this.visible = true
  }
  focus = vi.fn()
  /** emits 'close' like BrowserWindow; returns whether it was prevented */
  close(): boolean {
    let prevented = false
    this.emit('close', { preventDefault: () => (prevented = true) })
    return prevented
  }
}

describe('AppTray', () => {
  const platform = process.platform
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    trays.length = 0
    appEvents.removeAllListeners()
  })
  afterEach(() => Object.defineProperty(process, 'platform', { value: platform }))

  it('hides instead of closing while in a room, and closes otherwise', () => {
    const win = new FakeWindow()
    const tray = new AppTray(win as never)
    tray.install()
    expect(win.close()).toBe(false)
    tray.setSession({ inRoom: true, title: 'Movie night' })
    expect(win.close()).toBe(true)
    expect(win.visible).toBe(false)
    appEvents.emit('before-quit')
    expect(win.close()).toBe(false)
    tray.cancelQuit()
    expect(win.close()).toBe(true)
  })

  it('builds a tray menu that tracks the room', () => {
    const win = new FakeWindow()
    const tray = new AppTray(win as never)
    tray.install()
    const t = trays[0]
    expect(t?.menu.find((i) => i.label === 'Leave room…')?.enabled).toBe(false)
    tray.setSession({ inRoom: true, title: 'Movie night' })
    expect(t?.tooltip).toBe('Watch Together · Movie night')
    win.hide()
    t?.menu.find((i) => i.label === 'Leave room…')?.click?.()
    expect(win.visible).toBe(true)
    expect(win.sent).toEqual([['push:command', 'leave']])
    t?.menu.find((i) => i.label === 'Quit')?.click?.()
    expect(quit).toHaveBeenCalled()
    t?.emit('click')
    expect(win.visible).toBe(true)
  })

  it('validates session reports from the renderer', () => {
    expect(parseSessionReport({ inRoom: true, title: null })).toStrictEqual({ inRoom: true, title: null })
    expect(parseSessionReport({ inRoom: 'yes' })).toBeNull()
    // a save running (phase 'leaving' with leave 'save')
    expect(parseSessionReport({ inRoom: true, title: 'Movie', saving: true })).toStrictEqual({
      inRoom: true,
      title: 'Movie',
      saving: true,
    })
    expect(parseSessionReport({ inRoom: true, title: null, saving: 'yes' })).toBeNull()
  })

  it('confirms quitting', async () => {
    expect(await confirmQuitInRoom(null)).toBe(true)
  })

  it('words the quit question for a save that is running, and keeps saving unless told to quit', async () => {
    const ask = showMessageBox
    const win = new FakeWindow()
    const tray = new AppTray(win as never)
    tray.install()
    tray.setSession({ inRoom: true, title: 'Movie night' })
    expect(tray.saving).toBe(false)
    ask.mockClear()
    await tray.confirmQuit()
    expect(ask).toHaveBeenLastCalledWith(win, expect.objectContaining({ title: 'Leave room?' }))

    tray.setSession({ inRoom: true, title: 'Movie night', saving: true })
    expect(tray.saving).toBe(true)
    win.hide()
    ask.mockResolvedValueOnce({ response: 1 })
    expect(await tray.confirmQuit()).toBe(false) // 'Keep saving'
    expect(win.visible).toBe(true) // a sheet on the window, shown first
    expect(ask).toHaveBeenLastCalledWith(win, {
      type: 'question',
      buttons: ['Quit', 'Keep saving'],
      defaultId: 1,
      cancelId: 1,
      title: 'Saving the video',
      message: 'Quit while the video is being saved?',
      detail: 'Saving finishes the next time you open Watch Together.',
    })
    expect(await tray.confirmQuit()).toBe(true) // 'Quit'
  })

  it('generates an opaque icon with a white play mark', () => {
    const bmp = trayIconBitmap(32)
    expect(bmp.length).toBe(32 * 32 * 4)
    const px = (x: number, y: number) => [...bmp.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)]
    expect(px(0, 0)[3]).toBe(0) // rounded corner is transparent
    expect(px(16, 4)).toEqual([0xf6, 0x6c, 0x3b, 0xff])
    expect(px(14, 16)).toEqual([0xff, 0xff, 0xff, 0xff])
  })
})
