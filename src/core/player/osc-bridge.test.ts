import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Span } from '../../shared/ipc/core.js'
import { themePayload } from '../../shared/theme-tokens.js'
import { OscBridge, type OscSend, TOAST_KEEP_MS, assColor, capSpans, parseIntent, wireTheme } from './osc-bridge.js'

describe('assColor', () => {
  it('converts #RRGGBB to ASS blue-first literals', () => {
    expect(assColor('#3b6cf6')).toBe('&HF66C3B&')
    expect(assColor('ffffff')).toBe('&HFFFFFF&')
    expect(assColor('&H00FF00&')).toBe('&H00FF00&')
    expect(assColor('red')).toBe('&HFFFFFF&')
  })
})

describe('capSpans', () => {
  it('sorts and merges overlapping and touching spans', () => {
    expect(
      capSpans(
        [
          [5, 6],
          [0, 1],
          [1, 2],
          [1.5, 3],
          [7, 7],
        ],
        512,
      ),
    ).toEqual([
      [0, 3],
      [5, 6],
    ])
  })

  it('closes the smallest gaps first to respect the cap', () => {
    const spans: Span[] = [
      [0, 1],
      [1.1, 2],
      [5, 6],
      [6.5, 7],
      [20, 21],
    ]
    expect(capSpans(spans, 3)).toEqual([
      [0, 2],
      [5, 7],
      [20, 21],
    ])
  })

  it('caps a large input at 512', () => {
    const spans: Span[] = Array.from({ length: 2000 }, (_, i) => [i * 2, i * 2 + 1])
    const out = capSpans(spans, 512)
    expect(out).toHaveLength(512)
    expect(out[0]?.[0]).toBe(0)
    expect(out.at(-1)?.[1]).toBe(3999)
  })
})

describe('parseIntent', () => {
  it('accepts the OSC intent kinds', () => {
    expect(parseIntent('{"t":"toggle","seq":3}')).toEqual({ t: 'toggle', seq: 3 })
    expect(parseIntent('{"t":"seek","pos":12.5,"seq":4}')).toEqual({ t: 'seek', pos: 12.5, seq: 4 })
    expect(parseIntent('{"t":"seek-rel","delta":-5,"seq":5}')).toEqual({ t: 'seek-rel', delta: -5, seq: 5 })
    expect(parseIntent('{"t":"resync","seq":6}')).toEqual({ t: 'resync', seq: 6 })
  })
  it('rejects malformed intents', () => {
    expect(parseIntent('{"t":"seek","seq":1}')).toBeNull()
    expect(parseIntent('{"t":"quit","seq":1}')).toBeNull()
    expect(parseIntent('nope')).toBeNull()
    expect(parseIntent(undefined)).toBeNull()
  })
})

describe('OscBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function setup(): { bridge: OscBridge; sent: [string, unknown][]; send: OscSend } {
    const sent: [string, unknown][] = []
    const bridge = new OscBridge({
      theme: themePayload('dark', 'dark'),
      perms: { isHost: false, canPlayPause: false, canSeek: true },
      persistentStrip: true,
    })
    const send: OscSend = (kind, json) => {
      sent.push([kind, JSON.parse(json)])
      return Promise.resolve()
    }
    bridge.attach(send, 'ipc_3', 10)
    return { bridge, sent, send }
  }

  it('retries init every 100 ms until wt-ready, then sends heartbeats', () => {
    const { bridge, sent } = setup()
    vi.advanceTimersByTime(350)
    const inits = sent.filter(([k]) => k === 'init')
    expect(inits).toHaveLength(4)
    expect(inits[0]?.[1]).toMatchObject({
      v: 1,
      client: 'ipc_3',
      watchdogS: 10,
      persistentStrip: true,
      perms: { canPlayPause: false },
      theme: { mode: 'dark', colors: { accent: '&HFF8C6C&' } },
    })
    const ready = vi.fn()
    bridge.on('ready', ready)
    expect(bridge.handleClientMessage(['wt-ready', '{"v":1}'])).toBe(true)
    expect(ready).toHaveBeenCalledOnce()
    sent.length = 0
    vi.advanceTimersByTime(4100)
    expect(sent.map(([k]) => k)).toEqual(['hb', 'hb'])
    bridge.detach()
  })

  it('gives up after 5 s without wt-ready', () => {
    const { bridge } = setup()
    const timeout = vi.fn()
    bridge.on('timeout', timeout)
    vi.advanceTimersByTime(5000)
    expect(timeout).toHaveBeenCalledOnce()
    bridge.detach()
  })

  it('throttles ranges to 4 Hz and peers to 2 Hz, keeping the latest', () => {
    const { bridge, sent } = setup()
    bridge.handleClientMessage(['wt-ready', '{}'])
    sent.length = 0
    for (let i = 0; i < 10; i++) {
      bridge.sendMessage('ranges', { dur: 100, done: [[0, i]], loading: [] })
      bridge.sendMessage('peers', [{ id: 'a', name: 'A', color: '#ff0000', pos: i, state: 'playing' }])
      vi.advanceTimersByTime(50)
    }
    vi.advanceTimersByTime(1000)
    const ranges = sent.filter(([k]) => k === 'ranges')
    const peers = sent.filter(([k]) => k === 'peers')
    expect(ranges.length).toBeLessThanOrEqual(3)
    expect(peers.length).toBeLessThanOrEqual(2)
    expect(ranges.at(-1)?.[1]).toEqual({ dur: 100, done: [[0, 9]], loading: [] })
    expect(peers.at(-1)?.[1]).toEqual([{ id: 'a', name: 'A', color: '&H0000FF&', pos: 9, state: 'playing' }])
    bridge.detach()
  })

  it('leaves out groupDone when it shows the same spans as done (the host case)', () => {
    const { bridge, sent } = setup()
    bridge.handleClientMessage(['wt-ready', '{}'])
    const group: Span[] = [
      [0, 2],
      [4, 6],
    ]
    const ranges = (): unknown[] => sent.filter(([k]) => k === 'ranges').map(([, body]) => body)
    // the host's timeline sends done = groupDone; unmerged input that merges to the same spans counts too
    bridge.sendMessage('ranges', {
      dur: 10,
      done: group,
      loading: [[2, 4]],
      groupDone: [
        [4, 6],
        [0, 1],
        [1, 2],
      ],
    })
    expect(ranges().at(-1)).toEqual({ dur: 10, done: group, loading: [[2, 4]] })
    // a viewer's own copy differs from what everyone has: the strip is drawn
    vi.advanceTimersByTime(250)
    bridge.sendMessage('ranges', { dur: 10, done: [[0, 6]], loading: [], groupDone: [[0, 2]] })
    expect(ranges().at(-1)).toEqual({ dur: 10, done: [[0, 6]], loading: [], groupDone: [[0, 2]] })
    vi.advanceTimersByTime(250)
    bridge.sendMessage('ranges', { dur: 10, done: [], loading: [], groupDone: [] })
    expect(ranges().at(-1)).toEqual({ dur: 10, done: [], loading: [] })
    expect(ranges()).toHaveLength(3)
    bridge.detach()
  })

  it('replays sticky state to a restarted OSC', () => {
    const { bridge, sent } = setup()
    bridge.sendMessage('ranges', { dur: 10, done: [[0, 5]], loading: [[5, 6]] })
    bridge.sendMessage('status', { text: 'Waiting for Bob', level: 'info' })
    bridge.sendMessage('perms', { isHost: true, canPlayPause: true, canSeek: true })
    bridge.sendMessage('toast', { text: 'kept until ready' })
    bridge.sendMessage('ended', { ended: true })
    expect(sent.some(([k]) => k === 'ranges' || k === 'toast' || k === 'ended')).toBe(false)
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(sent.map(([k]) => k)).toContain('ranges')
    expect(sent.map(([k]) => k)).toContain('status')
    expect(sent.filter(([k]) => k === 'ended').map(([, body]) => body)).toEqual([{ ended: true }])
    // perms ride along in the next init
    bridge.attach(() => Promise.resolve(), 'ipc_4', 0)
    bridge.detach()
    expect(sent.find(([k]) => k === 'init')?.[1]).toMatchObject({ perms: { canPlayPause: false } })
  })

  it("keeps the Resync to live button's state for a restarted OSC, and names it in init", () => {
    const { bridge, sent } = setup()
    expect(sent.find(([k]) => k === 'init')?.[1]).toMatchObject({ strings: { resync: 'Resync to live' } })
    bridge.sendMessage('resync', { shown: true })
    expect(sent.some(([k]) => k === 'resync')).toBe(false)
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(sent.filter(([k]) => k === 'resync').map(([, body]) => body)).toEqual([{ shown: true }])
    bridge.sendMessage('resync', { shown: false })
    expect(sent.at(-1)).toEqual(['resync', { shown: false }])
    bridge.detach()
  })

  it('shows the latest toast sent before the OSC was up once it is, once, and only while it is fresh', () => {
    const { bridge, sent, send } = setup()
    const toasts = (): unknown[] => sent.filter(([k]) => k === 'toast').map(([, body]) => body)
    // a notice right after the player was created: mpv and its OSC are still starting
    bridge.sendMessage('toast', { text: 'Bob joined' })
    bridge.sendMessage('toast', { text: 'Only the host can pause', ms: 4000 })
    vi.advanceTimersByTime(800)
    expect(toasts()).toEqual([])
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(toasts()).toEqual([{ text: 'Only the host can pause', ms: 4000 }])
    bridge.sendMessage('toast', { text: 'now' })
    expect(toasts()).toHaveLength(2)
    // shown already: a restarted OSC does not get it again
    bridge.attach(send, 'ipc_4', 10)
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(toasts()).toHaveLength(2)
    // the player was closed meanwhile: a toast from that long before the OSC came back is dropped
    bridge.detach()
    bridge.sendMessage('toast', { text: 'stale' })
    vi.advanceTimersByTime(TOAST_KEEP_MS + 1)
    bridge.attach(send, 'ipc_5', 10)
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(toasts()).toHaveLength(2)
    bridge.detach()
  })

  it('sends a theme or perms change that came after the last init once the OSC is up', () => {
    const { bridge, sent, send } = setup()
    const of = (kind: string): unknown[] => sent.filter(([k]) => k === kind).map(([, body]) => body)
    // the OSC answers the init it got; the app switched to light mode after that init was sent
    bridge.sendMessage('theme', themePayload('light', 'light'))
    expect(of('theme')).toEqual([])
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(of('theme')).toEqual([wireTheme(themePayload('light', 'light'))])
    expect(of('perms')).toEqual([]) // unchanged since that init
    // an init retried after the change carries it: nothing more to send
    bridge.detach()
    bridge.attach(send, 'ipc_4', 10)
    const perms = { isHost: false, canPlayPause: true, canSeek: true }
    bridge.sendMessage('perms', perms)
    vi.advanceTimersByTime(100)
    bridge.handleClientMessage(['wt-ready', '{}'])
    expect(of('init').at(-1)).toMatchObject({ perms })
    expect(of('perms')).toEqual([])
    expect(of('theme')).toHaveLength(1)
    bridge.detach()
  })

  it('emits parsed intents', () => {
    const { bridge } = setup()
    const intents: unknown[] = []
    bridge.on('intent', (i) => intents.push(i))
    bridge.handleClientMessage(['wt-intent', '{"t":"seek-rel","delta":5,"seq":1}'])
    bridge.handleClientMessage(['wt-intent', 'garbage'])
    expect(bridge.handleClientMessage(['something-else'])).toBe(false)
    expect(intents).toEqual([{ t: 'seek-rel', delta: 5, seq: 1 }])
    bridge.detach()
  })
})
