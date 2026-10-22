// The app's single before-quit policy (plan §4.6): while in a room, quitting asks "Leave room?" first; once quitting
// is decided, main shuts down (power blocker, tray, core) before letting the quit through.

export interface QuitGuardDeps {
  /** tray.inRoom */
  inRoom: () => boolean
  /** confirmQuitInRoom(win); true = leave and quit */
  confirm: () => Promise<boolean>
  /** the user kept the room: tray.cancelQuit(), so closing the window hides it again */
  cancelled: () => void
  /** stop everything main owns; called once */
  shutdown: () => Promise<void>
  /** app.quit() */
  quit: () => void
}

export class QuitGuard {
  private confirmed = false
  private asking = false
  private shuttingDown = false
  private done = false

  constructor(private readonly deps: QuitGuardDeps) {}

  /** The app 'before-quit' listener. */
  onBeforeQuit(e: { preventDefault(): void }): void {
    if (this.done) return
    e.preventDefault()
    if (this.shuttingDown || this.asking) return
    if (this.deps.inRoom() && !this.confirmed) {
      this.asking = true
      void this.deps.confirm().then(
        (yes) => this.answered(yes),
        () => this.answered(false),
      )
      return
    }
    this.shuttingDown = true
    void this.deps
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        this.done = true
        this.deps.quit()
      })
  }

  private answered(yes: boolean): void {
    this.asking = false
    if (yes) {
      this.confirmed = true
      this.deps.quit()
    } else this.deps.cancelled()
  }
}
