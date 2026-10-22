import { powerSaveBlocker } from 'electron'
import { log } from './log.js'

type Blocker = Pick<typeof powerSaveBlocker, 'start' | 'stop' | 'isStarted'>

/** The part of CoreHost this needs: core's `power {keepAwake}` messages, and crashes (which drop the request). */
export interface PowerSource {
  on(event: 'power', cb: (keepAwake: boolean) => void): unknown
  on(event: 'crashed', cb: (code: number) => void): unknown
}

/**
 * Holds one 'prevent-app-suspension' blocker while core says the machine must stay awake (hosting, preparing
 * or downloading). The display may still sleep; only system suspend is prevented.
 */
export class PowerKeeper {
  private id: number | null = null

  constructor(private readonly blocker: Blocker = powerSaveBlocker) {}

  get active(): boolean {
    return this.id !== null && this.blocker.isStarted(this.id)
  }

  set(keepAwake: boolean): void {
    if (keepAwake && !this.active) {
      this.id = this.blocker.start('prevent-app-suspension')
      log.info('keeping the computer awake')
    } else if (!keepAwake && this.id !== null) {
      this.blocker.stop(this.id)
      this.id = null
      log.info('no longer keeping the computer awake')
    }
  }

  dispose(): void {
    this.set(false)
  }
}

/** Wire core's power messages to a keeper. A crashed core sends nothing more, so release on crash. */
export function bindPower(core: PowerSource, keeper: PowerKeeper = new PowerKeeper()): PowerKeeper {
  core.on('power', (keepAwake) => keeper.set(keepAwake))
  core.on('crashed', () => keeper.set(false))
  return keeper
}
