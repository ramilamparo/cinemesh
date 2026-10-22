import { describe, expect, it } from 'vitest'
import { CORE_PROTOCOL, type CoreToRenderer, type NoticeEvent } from '../shared/ipc/core.js'
import type { RpcPort } from './host-transport.js'
import { RpcServer } from './rpc-server.js'

/** A renderer's end of a port: what it received, in order; hello() is its preload connecting. */
class Window {
  readonly got: CoreToRenderer[] = []
  private deliver: (m: unknown) => void = () => undefined
  private closed: () => void = () => undefined
  readonly port: RpcPort = {
    post: (m) => this.got.push(m as CoreToRenderer),
    onMessage: (cb) => (this.deliver = cb),
    onClose: (cb) => (this.closed = cb),
    close: () => this.closed(),
  }

  hello(): void {
    this.deliver({ t: 'hello', v: CORE_PROTOCOL })
  }

  /** What arrived, as `snapshot` or the notice's code. */
  seen(): string[] {
    return this.got.map((m) => (m.t === 'evt' && m.e === 'notice' ? (m.d as NoticeEvent).code : m.t))
  }
}

const versions = { app: '0.0.0-test', electron: null, node: process.versions.node, chrome: null, protocol: 1 }
const failed: NoticeEvent = { level: 'error', code: 'session.resume-failed', message: 'could not rejoin the room' }

function connect(rpc: RpcServer, opts: { hello?: boolean } = {}): Window {
  const w = new Window()
  rpc.attach(w.port)
  if (opts.hello !== false) w.hello()
  return w
}

describe('RpcServer.noticeUntilSeen', () => {
  it('keeps a notice nobody is listening for, and gives it to the next window after its snapshot, once', () => {
    const rpc = new RpcServer(versions)
    rpc.noticeUntilSeen(failed)
    expect(connect(rpc).seen()).toEqual(['snapshot', 'session.resume-failed'])
    expect(connect(rpc).seen()).toEqual(['snapshot'])
  })

  it('a window that is listening gets it like any notice; one connecting later does not', () => {
    const rpc = new RpcServer(versions)
    const open = connect(rpc)
    rpc.noticeUntilSeen(failed)
    expect(open.seen()).toEqual(['snapshot', 'session.resume-failed'])
    expect(connect(rpc).seen()).toEqual(['snapshot'])
  })

  it('a port attached but not yet listening gets it once, ahead of its snapshot', () => {
    const rpc = new RpcServer(versions)
    const loading = connect(rpc, { hello: false })
    rpc.noticeUntilSeen(failed)
    loading.hello()
    expect(loading.seen()).toEqual(['session.resume-failed', 'snapshot'])
    expect(connect(rpc).seen()).toEqual(['snapshot'])
  })

  it('a port that closed before listening does not use it up', () => {
    const rpc = new RpcServer(versions)
    const reloaded = connect(rpc, { hello: false })
    rpc.noticeUntilSeen(failed)
    reloaded.port.close()
    expect(connect(rpc).seen()).toEqual(['snapshot', 'session.resume-failed'])
  })

  it('a window that went away does not count as listening', () => {
    const rpc = new RpcServer(versions)
    connect(rpc).port.close()
    rpc.noticeUntilSeen(failed)
    expect(connect(rpc).seen()).toEqual(['snapshot', 'session.resume-failed'])
  })

  it('keeps only the latest few while nobody connects', () => {
    const rpc = new RpcServer(versions)
    for (let i = 0; i < 12; i++) rpc.noticeUntilSeen({ ...failed, code: `n${String(i)}` })
    expect(connect(rpc).seen()).toEqual(['snapshot', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10', 'n11'])
  })

  it('plain notices stay transient', () => {
    const rpc = new RpcServer(versions)
    rpc.emit('notice', failed)
    expect(connect(rpc).seen()).toEqual(['snapshot'])
  })
})
