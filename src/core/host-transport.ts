import { createInterface } from 'node:readline'
import type { CoreToMain, MainToCore } from '../shared/ipc/control.js'

/** A renderer connection as core sees it: Electron MessagePortMain, or a channel over stdio in tests. */
export interface RpcPort {
  post(msg: unknown): void
  onMessage(cb: (msg: unknown) => void): void
  onClose(cb: () => void): void
  close(): void
}

export interface HostTransport {
  kind: 'electron' | 'stdio'
  sendControl(msg: CoreToMain): void
  onControl(cb: (msg: MainToCore, ports: RpcPort[]) => void): void
}

// Minimal structural types for Electron's utility-process objects, so core does not import 'electron'.
interface MessagePortMainLike {
  on(event: 'message', cb: (e: { data: unknown }) => void): void
  on(event: 'close', cb: () => void): void
  postMessage(data: unknown): void
  start(): void
  close(): void
}
interface ParentPortLike {
  on(event: 'message', cb: (e: { data: unknown; ports: MessagePortMainLike[] }) => void): void
  postMessage(data: unknown): void
}

export function createHostTransport(argv: readonly string[] = process.argv): HostTransport {
  const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort
  if (parentPort && !argv.includes('--stdio-transport')) return electronTransport(parentPort)
  return stdioTransport()
}

function electronTransport(parentPort: ParentPortLike): HostTransport {
  return {
    kind: 'electron',
    sendControl: (msg) => parentPort.postMessage(msg),
    onControl(cb) {
      parentPort.on('message', (e) => cb(e.data as MainToCore, e.ports.map(wrapMessagePortMain)))
    },
  }
}

function wrapMessagePortMain(port: MessagePortMainLike): RpcPort {
  const closeHandlers: (() => void)[] = []
  let closed = false
  const fireClose = (): void => {
    if (closed) return
    closed = true
    for (const cb of closeHandlers) cb()
  }
  port.on('close', fireClose)
  return {
    post: (msg) => {
      if (!closed) port.postMessage(msg)
    },
    // the port queues messages until start(): core starts it once its handlers are registered
    onMessage(cb) {
      port.on('message', (e) => cb(e.data))
      port.start()
    },
    // a window may reload while core still starts, before anyone listens here
    onClose: (cb) => {
      if (closed) cb()
      else closeHandlers.push(cb)
    },
    close() {
      port.close()
      fireClose()
    },
  }
}

/**
 * Headless mode (`--stdio-transport`, or no Electron parent port; `src/core/index.test.ts` runs core's entry so): JSON
 * lines on stdin/stdout.
 * {"ch":"control","m":...} carries MainToCore/CoreToMain; {"ch":"rpc","m":...} is one renderer port,
 * opened by sending {"ch":"control","m":{"type":"renderer-port"}}.
 */
function stdioTransport(): HostTransport {
  const write = (line: unknown): void => {
    process.stdout.write(`${JSON.stringify(line)}\n`)
  }
  let controlCb: ((msg: MainToCore, ports: RpcPort[]) => void) | null = null
  let rpcCb: ((msg: unknown) => void) | null = null
  /** rpc frames from before core listens on the port: held, as a MessagePortMain holds them until start() */
  const rpcEarly: unknown[] = []
  const rpcClose: (() => void)[] = []
  const rl = createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    if (!line.trim()) return
    const frame = JSON.parse(line) as { ch: 'control' | 'rpc'; m: unknown }
    if (frame.ch === 'rpc') {
      if (rpcCb) rpcCb(frame.m)
      else rpcEarly.push(frame.m)
    } else controlCb?.(frame.m as MainToCore, (frame.m as MainToCore).type === 'renderer-port' ? [rpcPort] : [])
  })
  rl.on('close', () => {
    for (const cb of rpcClose) cb()
  })
  const rpcPort: RpcPort = {
    post: (m) => write({ ch: 'rpc', m }),
    onMessage(cb) {
      rpcCb = cb
      for (const m of rpcEarly.splice(0)) cb(m)
    },
    onClose: (cb) => rpcClose.push(cb),
    close: () => rl.close(),
  }
  return {
    kind: 'stdio',
    sendControl: (m) => write({ ch: 'control', m }),
    onControl: (cb) => (controlCb = cb),
  }
}
