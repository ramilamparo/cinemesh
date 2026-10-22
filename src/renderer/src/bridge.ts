import type { WtBridge } from '../../shared/ipc/app'

// The bridge is window.wt in Electron, or the scriptable fake core (src/mock) in a plain browser and in tests.
let current: WtBridge | null = null

export function setBridge(bridge: WtBridge): void {
  current = bridge
}

export function wt(): WtBridge {
  if (!current) throw new Error('bridge not connected; call connectStore() first')
  return current
}
