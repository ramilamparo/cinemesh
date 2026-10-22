import { contextBridge, ipcRenderer } from 'electron'
import { APP_CHANNELS, APP_PUSH, type AppApi, type CoreClient, type WtBridge } from '../shared/ipc/app.js'
import {
  CORE_ERRORS,
  CORE_PROTOCOL,
  type CoreSnapshot,
  type CoreToRenderer,
  type RendererToCore,
} from '../shared/ipc/core.js'
import { type Result, err, ok } from '../shared/result.js'

// The core MessagePort stays here; the page only sees request/on functions through contextBridge.
// Main sends a new port after every load and whenever core restarts.

let port: MessagePort | null = null
let nextId = 1
const queued: RendererToCore[] = []
const pending = new Map<number, (r: Result<unknown>) => void>()
const eventListeners = new Map<string, Set<(d: unknown) => void>>()
const snapshotListeners = new Set<(s: CoreSnapshot) => void>()
let lastSnapshot: CoreSnapshot | null = null

ipcRenderer.on(APP_PUSH.corePort, (event) => {
  const next = event.ports[0]
  if (!next) return
  if (port) {
    port.close()
    for (const resolve of pending.values()) resolve(err(CORE_ERRORS.coreRestarted, 'The background process restarted'))
    pending.clear()
  }
  port = next
  port.onmessage = (e: MessageEvent) => onCoreMessage(e.data as CoreToRenderer)
  send({ t: 'hello', v: CORE_PROTOCOL })
  for (const msg of queued.splice(0)) send(msg)
})

function send(msg: RendererToCore): void {
  if (port) port.postMessage(msg)
  else queued.push(msg)
}

function onCoreMessage(msg: CoreToRenderer): void {
  switch (msg.t) {
    case 'snapshot':
      lastSnapshot = msg.d
      for (const cb of snapshotListeners) cb(msg.d)
      break
    case 'res': {
      const resolve = pending.get(msg.id)
      pending.delete(msg.id)
      resolve?.(msg.ok ? ok(msg.v) : err(msg.code, msg.msg))
      break
    }
    case 'evt':
      for (const cb of eventListeners.get(msg.e) ?? []) cb(msg.d)
      break
  }
}

const core: CoreClient = {
  request(method, params) {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve as (r: Result<unknown>) => void)
      send({ t: 'req', id, m: method, p: params })
    })
  },
  on(event, cb) {
    const set = eventListeners.get(event) ?? new Set()
    eventListeners.set(event, set)
    const listener = cb as (d: unknown) => void
    set.add(listener)
    return () => set.delete(listener)
  },
  onSnapshot(cb) {
    snapshotListeners.add(cb)
    if (lastSnapshot) queueMicrotask(() => lastSnapshot && cb(lastSnapshot))
    return () => snapshotListeners.delete(cb)
  },
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the payload type AppApi declares
function push<T>(channel: string, cb: (data: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, data: T): void => cb(data)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Payload types come from AppApi; Promise<never> is assignable to each method's declared Promise<T>.
const invoke = (channel: string, ...args: unknown[]): Promise<never> =>
  ipcRenderer.invoke(channel, ...args) as Promise<never>

const app: AppApi = {
  info: () => invoke(APP_CHANNELS.info),
  getSettings: () => invoke(APP_CHANNELS.getSettings),
  setSettings: (patch) => invoke(APP_CHANNELS.setSettings, patch),
  onSettings: (cb) => push(APP_PUSH.settings, cb),
  getTheme: () => invoke(APP_CHANNELS.getTheme),
  onTheme: (cb) => push(APP_PUSH.theme, cb),
  pickVideo: () => invoke(APP_CHANNELS.pickVideo),
  pickSubtitles: () => invoke(APP_CHANNELS.pickSubtitles),
  pickFolder: (defaultPath) => invoke(APP_CHANNELS.pickFolder, defaultPath ?? null),
  pickMpv: () => invoke(APP_CHANNELS.pickMpv),
  openExternal: (url) => invoke(APP_CHANNELS.openExternal, url),
  showItemInFolder: (path) => invoke(APP_CHANNELS.showItemInFolder, path),
  writeClipboard: (text) => invoke(APP_CHANNELS.writeClipboard, text),
  readClipboardInvite: () => invoke(APP_CHANNELS.readClipboardInvite),
  // main validates core's diagnostics itself; null means "not available"
  copyDiagnostics: (coreDiagnostics) => invoke(APP_CHANNELS.copyDiagnostics, coreDiagnostics ?? null),
  openLogsFolder: () => invoke(APP_CHANNELS.openLogsFolder),
  onDeepLink: (cb) => push(APP_PUSH.deepLink, cb),
  takePendingDeepLink: () => invoke(APP_CHANNELS.takePendingDeepLink),
  registerLinuxDeepLinks: () => invoke(APP_CHANNELS.registerLinuxDeepLinks),
  recheckMpv: () => invoke(APP_CHANNELS.recheckMpv),
  reportSession: (report) => ipcRenderer.send(APP_CHANNELS.reportSession, report),
  onAppCommand: (cb) => push(APP_PUSH.command, cb),
}

const bridge: WtBridge = { app, core }
contextBridge.exposeInMainWorld('wt', bridge)
