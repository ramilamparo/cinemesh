import type { WtBridge } from '../../shared/ipc/app'

declare global {
  interface Window {
    wt: WtBridge
  }
}

export {}
