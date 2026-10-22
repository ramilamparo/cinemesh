import { type Duplex, duplexPair } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { MPV_ERRORS, MpvIpc, MpvIpcError } from './mpv-ipc.js'

// A scripted stand-in for mpv on the other end of a duplex pair.
function fakeMpv(): { ipc: MpvIpc; mpv: Duplex; requests: Record<string, unknown>[] } {
  const [ours, theirs] = duplexPair()
  const requests: Record<string, unknown>[] = []
  let buf = ''
  theirs.setEncoding('utf8')
  theirs.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) requests.push(JSON.parse(l) as Record<string, unknown>)
  })
  return { ipc: new MpvIpc(ours, 100), mpv: theirs, requests }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('MpvIpc', () => {
  let cleanup: (() => void) | null = null
  afterEach(() => {
    cleanup?.()
    cleanup = null
  })

  it('matches replies by request_id, also when split across chunks', async () => {
    const { ipc, mpv, requests } = fakeMpv()
    cleanup = () => ipc.close()
    const a = ipc.command(['get_property', 'volume'])
    const b = ipc.getProperty<number>('speed')
    await tick()
    expect(requests).toEqual([
      { command: ['get_property', 'volume'], request_id: 1 },
      { command: ['get_property', 'speed'], request_id: 2 },
    ])
    mpv.write('{"data":1.5,"request_id":2,"error":"success"}\n{"data":100,"req')
    mpv.write('uest_id":1,"error":"success"}\n')
    await expect(a).resolves.toBe(100)
    const timed = await b
    expect(timed.value).toBe(1.5)
    expect(timed.tRecv).toBeGreaterThanOrEqual(timed.tSend)
  })

  it('maps mpv errors to MpvIpcError', async () => {
    const { ipc, mpv } = fakeMpv()
    cleanup = () => ipc.close()
    const p = ipc.getProperty('nope')
    await tick()
    mpv.write('{"request_id":1,"error":"property not found"}\n')
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MpvIpcError)
    expect(err).toMatchObject({ code: MPV_ERRORS.command, mpvError: 'property not found' })
  })

  it('times out requests mpv never answers', async () => {
    const { ipc } = fakeMpv()
    cleanup = () => ipc.close()
    await expect(ipc.command(['get_property', 'pause'], { timeoutMs: 20 })).rejects.toMatchObject({
      code: MPV_ERRORS.timeout,
    })
  })

  it('flags async commands and routes events', async () => {
    const { ipc, mpv, requests } = fakeMpv()
    cleanup = () => ipc.close()
    const events: string[] = []
    const changes: unknown[] = []
    const messages: string[][] = []
    ipc.on('event', (e) => events.push(e.event))
    ipc.on('property-change', (p) => changes.push(p))
    ipc.on('client-message', (args) => messages.push(args))
    const obs = ipc.observe('pause')
    void ipc.command(['loadfile', 'x', 'replace', -1, 'pause=yes'], { async: true }).catch(() => undefined)
    await tick()
    expect(requests[0]).toEqual({ command: ['observe_property', 1, 'pause'], request_id: 1 })
    expect(requests[1]).toMatchObject({ async: true, request_id: 2 })
    mpv.write('{"request_id":1,"error":"success"}\n')
    await expect(obs).resolves.toBe(1)
    mpv.write('{"event":"property-change","id":1,"name":"pause","data":true}\n')
    mpv.write('{"event":"property-change","id":1,"name":"pause"}\n')
    mpv.write('{"event":"client-message","args":["wt-ready","{}"]}\nnot json\n{"event":"playback-restart"}\n')
    await tick()
    expect(events).toEqual(['property-change', 'property-change', 'client-message', 'playback-restart'])
    expect(changes).toEqual([
      { id: 1, name: 'pause', value: true },
      { id: 1, name: 'pause', value: undefined },
    ])
    expect(messages).toEqual([['wt-ready', '{}']])
  })

  it('hands a reply to onReply in line order, before the events after it in the same chunk', async () => {
    const { ipc, mpv } = fakeMpv()
    cleanup = () => ipc.close()
    const seen: string[] = []
    ipc.on('event', (e) => seen.push(e.event))
    const reply = ipc
      .command(['loadfile', 'x', 'replace'], {
        async: true,
        onReply: (data) => seen.push(`reply ${JSON.stringify(data)}`),
      })
      .then(() => seen.push('settled'))
    const failed = ipc.command(['seek', 1], { onReply: () => seen.push('never') }).catch(() => seen.push('failed'))
    await tick()
    // mpv sends a loadfile's reply before its entry's start-file; node may read both and more in one chunk
    mpv.write(
      '{"request_id":1,"error":"success","data":{"playlist_entry_id":7}}\n' +
        '{"event":"start-file","playlist_entry_id":7}\n{"event":"playback-restart"}\n' +
        '{"request_id":2,"error":"invalid parameter"}\n',
    )
    await Promise.all([reply, failed])
    expect(seen).toEqual(['reply {"playlist_entry_id":7}', 'start-file', 'playback-restart', 'settled', 'failed'])
  })

  it('rejects pending and later requests once closed', async () => {
    const { ipc, mpv } = fakeMpv()
    const closed: unknown[] = []
    ipc.on('close', (e) => closed.push(e))
    const p = ipc.command(['get_property', 'pause'])
    await tick()
    mpv.end()
    await expect(p).rejects.toMatchObject({ code: MPV_ERRORS.closed })
    await expect(ipc.command(['get_property', 'pause'])).rejects.toMatchObject({ code: MPV_ERRORS.closed })
    expect(ipc.isClosed).toBe(true)
    expect(closed).toEqual([null])
  })

  it('gives up connecting to a missing server after the timeout', async () => {
    const path = process.platform === 'win32' ? '\\\\.\\pipe\\wt-test-missing' : '/nonexistent/wt-test.sock'
    await expect(MpvIpc.connect(path, { retryMs: 10, timeoutMs: 60 })).rejects.toMatchObject({
      code: MPV_ERRORS.connect,
    })
  })
})
