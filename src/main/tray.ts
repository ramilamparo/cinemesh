import { Menu, Tray, app, dialog, nativeImage, type BrowserWindow, type NativeImage } from 'electron'
import { z } from 'zod'
import { APP_PUSH, type AppCommand, type SessionReport } from '../shared/ipc/app.js'

// Tray (Windows/Linux) and hide-on-close (all platforms) while the user is in a room (plan §4.6). The room keeps
// running in core; the window comes back from the tray, the dock (macOS), a second launch, or the OSC.

export const SessionReportSchema = z.object({
  inRoom: z.boolean(),
  title: z.string().max(300).nullable(),
  saving: z.boolean().optional(),
})

export function parseSessionReport(raw: unknown): SessionReport | null {
  const r = SessionReportSchema.safeParse(raw)
  if (!r.success) return null
  const { inRoom, title, saving } = r.data
  return saving === undefined ? { inRoom, title } : { inRoom, title, saving }
}

export interface AppTrayOptions {
  /** PNG for the tray; a generated icon is used when absent (no build/icons yet) */
  iconPath?: string
}

export class AppTray {
  private tray: Tray | null = null
  private session: SessionReport = { inRoom: false, title: null }
  private quitting = false
  private hiddenHintShown = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly opts: AppTrayOptions = {},
  ) {}

  get inRoom(): boolean {
    return this.session.inRoom
  }

  /** A 'save' leave (the video's export) is running: quitting interrupts it until the next start. */
  get saving(): boolean {
    return this.session.saving === true
  }

  /** The quit question for the current report, as a sheet on the window (shown first: it may be hidden). */
  confirmQuit(): Promise<boolean> {
    this.show()
    return confirmQuitInRoom(this.win.isDestroyed() ? null : this.win, { saving: this.saving })
  }

  install(): void {
    this.win.on('close', (e) => {
      if (!this.session.inRoom || this.quitting) return
      e.preventDefault()
      this.win.hide()
      this.notifyHidden()
    })
    app.on('before-quit', () => {
      this.quitting = true
    })
    if (process.platform === 'darwin') {
      app.on('activate', () => this.show())
      return
    }
    this.tray = new Tray(this.icon())
    this.tray.on('click', () => this.show())
    this.render()
  }

  /** From the renderer's session report (APP_CHANNELS.reportSession). */
  setSession(report: SessionReport): void {
    this.session = report
    this.render()
  }

  /** Call when a quit was cancelled (e.g. the user said no to "Leave room?"), so closing hides again. */
  cancelQuit(): void {
    this.quitting = false
  }

  show(): void {
    if (this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    this.win.focus()
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private command(cmd: AppCommand): void {
    this.show()
    if (!this.win.isDestroyed()) this.win.webContents.send(APP_PUSH.command, cmd)
  }

  private render(): void {
    const tray = this.tray
    if (!tray) return
    const { inRoom, title } = this.session
    tray.setToolTip(inRoom && title ? `Watch Together · ${title}` : 'Watch Together')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Watch Together', click: () => this.show() },
        { label: 'Leave room…', enabled: inRoom, click: () => this.command('leave') },
        { label: 'Settings…', click: () => this.command('open-settings') },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    )
  }

  private notifyHidden(): void {
    // Windows shows a balloon once so people learn where the window went; other trays have no such API.
    if (this.hiddenHintShown || process.platform !== 'win32' || !this.tray) return
    this.hiddenHintShown = true
    this.tray.displayBalloon({
      title: 'Still in the room',
      content: 'Watch Together keeps running here. Use Quit to leave.',
      iconType: 'info',
    })
  }

  private icon(): NativeImage {
    if (this.opts.iconPath) {
      const img = nativeImage.createFromPath(this.opts.iconPath)
      if (!img.isEmpty()) return img
    }
    const size = 32
    return nativeImage.createFromBitmap(trayIconBitmap(size), { width: size, height: size, scaleFactor: 2 })
  }
}

/**
 * Asks before quitting while in a room, or while the video is being saved (`saving`: the export stops, and core
 * finishes it at the next start). Resolves true when the user agrees to quit.
 */
export async function confirmQuitInRoom(win: BrowserWindow | null, opts: { saving?: boolean } = {}): Promise<boolean> {
  const options = opts.saving
    ? {
        type: 'question' as const,
        buttons: ['Quit', 'Keep saving'],
        defaultId: 1,
        cancelId: 1,
        title: 'Saving the video',
        message: 'Quit while the video is being saved?',
        detail: 'Saving finishes the next time you open Watch Together.',
      }
    : {
        type: 'question' as const,
        buttons: ['Leave and quit', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        title: 'Leave room?',
        message: 'Leave the room and quit?',
        detail: 'You can resume the room later from Recent rooms.',
      }
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  return r.response === 0
}

/**
 * A 32-bit BGRA bitmap of the app mark (play triangle on a rounded square in the accent colour), so the tray works
 * before real icon assets exist.
 */
export function trayIconBitmap(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4)
  const accent = [0xf6, 0x6c, 0x3b] // #3b6cf6 as B, G, R
  const r = size * 0.22
  const inset = (x: number, y: number): boolean => {
    const cx = Math.min(Math.max(x, r), size - 1 - r)
    const cy = Math.min(Math.max(y, r), size - 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  // triangle pointing right, centred
  const tx0 = size * 0.36
  const tx1 = size * 0.72
  const tyMid = size / 2
  const half = size * 0.22
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (!inset(x + 0.5, y + 0.5)) continue
      const inTri = x >= tx0 && x <= tx1 && Math.abs(y + 0.5 - tyMid) <= half * (1 - (x - tx0) / (tx1 - tx0))
      const [b, g, rr] = inTri ? [0xff, 0xff, 0xff] : accent
      buf[i] = b ?? 0
      buf[i + 1] = g ?? 0
      buf[i + 2] = rr ?? 0
      buf[i + 3] = 0xff
    }
  }
  return buf
}
