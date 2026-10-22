import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { CORE_PROTOCOL, type CoreToRenderer } from '../shared/ipc/core.js'
import { type RpcPort, createHostTransport } from './host-transport.js'
import { RpcServer } from './rpc-server.js'

/** Electron's MessagePortMain: it holds messages until start(). */
class FakeMessagePort extends EventEmitter {
  readonly posted: CoreToRenderer[] = []
  private started = false
  private readonly queued: unknown[] = []
  postMessage(data: CoreToRenderer): void {
    this.posted.push(data)
  }
  start(): void {
    this.started = true
    for (const data of this.queued.splice(0)) this.emit('message', { data })
  }
  close(): void {
    this.emit('close')
  }
  /** a message from the renderer */
  receive(data: unknown): void {
    if (this.started) this.emit('message', { data })
    else this.queued.push(data)
  }
}

const versions = { app: '0.0.0-test', electron: null, node: process.versions.node, chrome: null, protocol: 1 }

/** The utilityProcess's parentPort, with main posting a renderer's port on it. */
function electronCore(): { ports: RpcPort[]; post: (port: FakeMessagePort) => void } {
  const parent = Object.assign(new EventEmitter(), { postMessage: () => undefined })
  Object.assign(process, { parentPort: parent })
  const transport = createHostTransport([])
  expect(transport.kind).toBe('electron')
  const ports: RpcPort[] = []
  transport.onControl((_msg, p) => ports.push(...p))
  return { ports, post: (port) => parent.emit('message', { data: { type: 'renderer-port' }, ports: [port] }) }
}

describe('electron transport', () => {
  afterEach(() => {
    delete (process as { parentPort?: unknown }).parentPort
  })

  it('a port core takes up once it is ready gets what the renderer sent meanwhile', () => {
    const core = electronCore()
    const port = new FakeMessagePort()
    core.post(port)
    port.receive({ t: 'hello', v: CORE_PROTOCOL })
    const rpc = new RpcServer(versions)
    for (const p of core.ports) rpc.attach(p)
    expect(port.posted.map((m) => m.t)).toEqual(['snapshot'])
  })

  it('a port whose window reloaded before core took it up is not kept', () => {
    const core = electronCore()
    const port = new FakeMessagePort()
    core.post(port)
    port.close()
    const rpc = new RpcServer(versions)
    for (const p of core.ports) rpc.attach(p)
    expect(rpc.connectedPorts).toBe(0)
  })
})
