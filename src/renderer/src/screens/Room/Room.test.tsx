import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import * as fx from '../../mock/fixtures'
import {
  type Mounted,
  byLabel,
  byRole,
  callsOf,
  click,
  flush,
  key,
  mountApp,
  queryByRole,
  text,
  typeInto,
} from '../../test/harness'

describe('Room', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('disables transport controls without permission and explains why', async () => {
    m = await mountApp('room-viewer')
    const play = byRole(m.container, 'button', /^Play$/)
    const back = byRole(m.container, 'button', 'Back 5 seconds')
    expect(play.getAttribute('aria-disabled')).toBe('true')
    expect(play.getAttribute('title')).toContain('Only the host can play or pause')
    expect(back.getAttribute('aria-disabled')).toBe('true')
    expect(back.getAttribute('title')).toContain('Only the host can seek')
    expect(byRole(m.container, 'slider', 'Playback position').getAttribute('aria-disabled')).toBe('true')

    await click(play)
    expect(callsOf(m.fake, 'playback.intent')).toEqual([])
    const toast = byRole(m.container, 'region', 'Notifications')
    expect(text(toast)).toContain('Only the host can play or pause')
    await click(byRole(toast, 'button', 'Ask host'))
    expect(callsOf(m.fake, 'sync.request')).toEqual([{ kind: 'play' }])
  })

  it('has a direct Ask host button while play/pause is not allowed', async () => {
    m = await mountApp('room-viewer')
    await click(byRole(m.container, 'button', 'Ask host to play'))
    expect(callsOf(m.fake, 'sync.request')).toEqual([{ kind: 'play' }])
  })

  it('offers Ask host when core rejects an intent', async () => {
    m = await mountApp('room-viewer')
    // the UI thinks it may seek, core disagrees
    act(() => m?.fake.emit('sync', fx.sync('viewer', { canSeek: true })))
    m.fake.handle('playback.intent', () => ({ accepted: false, reason: 'perm-seek' }))
    await click(byRole(m.container, 'button', 'Forward 5 seconds'))
    expect(callsOf(m.fake, 'playback.intent')).toEqual([{ kind: 'seekRel', deltaS: 5 }])
    await click(byRole(byRole(m.container, 'region', 'Notifications'), 'button', 'Ask host'))
    const [ask] = callsOf(m.fake, 'sync.request') as { kind: string; posS: number }[]
    expect(ask?.kind).toBe('seek')
    expect(ask?.posS).toBeCloseTo(605, 0)
  })

  it('enables everything once the host shares control', async () => {
    m = await mountApp('room-viewer')
    act(() => m?.fake.emit('sync', fx.sync('viewer', { canPlayPause: true, canSeek: true })))
    await flush()
    const play = byRole(m.container, 'button', /^Play$/)
    expect(play.getAttribute('aria-disabled')).toBe('false')
    expect(queryByRole(m.container, 'button', 'Ask host to play')).toBeNull()
    await click(play)
    expect(callsOf(m.fake, 'playback.intent')).toEqual([{ kind: 'play' }])
    expect(byRole(m.container, 'button', /^Pause$/)).toBeTruthy()
  })

  it('handles Space and arrows, but not while typing', async () => {
    m = await mountApp('room-host')
    await key(document.body, ' ')
    await key(document.body, 'ArrowLeft')
    expect(callsOf(m.fake, 'playback.intent')).toEqual([{ kind: 'toggle' }, { kind: 'seekRel', deltaS: -5 }])
    const input = byLabel(m.container, 'Upload limit')
    input.focus()
    await key(input, ' ')
    await key(input, 'ArrowRight')
    expect(callsOf(m.fake, 'playback.intent')).toHaveLength(2)
  })

  it('host control switch sets both permission flags', async () => {
    m = await mountApp('room-host')
    const sw = byRole(m.container, 'switch', 'Let others play, pause and seek')
    expect(sw.getAttribute('aria-checked')).toBe('false')
    await click(sw)
    expect(callsOf(m.fake, 'sync.setPerms')).toEqual([{ othersPlayPause: true, othersSeek: true }])
    expect(sw.getAttribute('aria-checked')).toBe('true')
  })

  it('host manages admission, cap and start mode', async () => {
    m = await mountApp('room-host')
    await click(byRole(m.container, 'button', 'Let Priya in'))
    expect(callsOf(m.fake, 'room.admit')).toEqual([{ peerId: 'p-new', allow: true }])
    expect(text(m.container)).toContain('Priya')
    await click(byRole(m.container, 'radio', 'Immediately'))
    expect(callsOf(m.fake, 'sync.setStartMode')).toEqual([{ kind: 'play-through' }])
    await click(byRole(m.container, 'radio', 'Join freely'))
    expect(callsOf(m.fake, 'room.setAdmission')).toEqual([{ mode: 'open' }])
  })

  it("host's queue says which member passed on a request from someone who cannot reach the host", async () => {
    m = await mountApp('room-host-pending-via')
    const queue = byRole(m.container, 'region', 'Waiting to join')
    // each entry's name, as its first element shows it
    const names = [...queue.querySelectorAll('li')].map((li) => text(li.firstElementChild ?? li))
    expect(names).toEqual(['Priya', 'Kai via Sam'])
    expect(queue.querySelector('[title]')?.getAttribute('title')).toBe(
      'Sam passed this request on: Kai cannot reach you directly',
    )
    await click(byRole(queue, 'button', 'Let Kai in'))
    expect(callsOf(m.fake, 'room.admit')).toEqual([{ peerId: 'p-kai', allow: true }])
  })

  it('host sees a coverage bar per viewer and can remove one', async () => {
    m = await mountApp('room-host')
    expect(byRole(m.container, 'img', 'Ola has').getAttribute('aria-label')).toMatch(/Ola has 2\d % of the video/)
    expect(m.container.querySelector('[data-testid="coverage-p-host"]')).toBeNull()
    await click(byRole(m.container, 'button', 'Remove…'))
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'Remove and change invite'))
    expect(callsOf(m.fake, 'room.kick')).toEqual([{ peerId: 'p-jun', rotate: true }])
  })

  it('viewers see no coverage bars or host panel', async () => {
    m = await mountApp('room-viewer')
    expect(queryByRole(m.container, 'img', 'of the video')).toBeNull()
    expect(queryByRole(m.container, 'region', 'Host controls')).toBeNull()
  })

  it('shows the wait banner with Start anyway for the host', async () => {
    m = await mountApp('room-host')
    act(() =>
      m?.fake.emit(
        'sync',
        fx.sync('host', { mode: 'waiting', wait: { reason: 'buffering', waitingFor: ['Ola'], softDeadline: null } }),
      ),
    )
    await flush()
    expect(text(m.container)).toContain('Waiting for Ola (buffering)')
    await click(byRole(m.container, 'button', 'Start anyway'))
    expect(callsOf(m.fake, 'sync.startAnyway')).toHaveLength(1)
  })

  it('wait banner shows the display names core sends, even for people not in the peer list', async () => {
    m = await mountApp('room-host')
    const wait = { reason: 'start' as const, waitingFor: ['Sam', 'Alex'], softDeadline: null }
    act(() => m?.fake.set({ peers: [], sync: fx.sync('host', { mode: 'waiting', wait }) }))
    await flush()
    expect(text(m.container)).toContain('Waiting for Sam, Alex (to be ready to start)…')
    expect(text(m.container)).not.toContain('Waiting for someone')
    const many = { ...wait, waitingFor: ['Sam', 'Alex', 'Ola', 'Jun', 'Priya'] }
    act(() => m?.fake.emit('sync', fx.sync('host', { mode: 'waiting', wait: many })))
    await flush()
    expect(text(m.container)).toContain('Waiting for Sam, Alex, Ola and 2 more')
  })

  it('viewer without control sees the banner but cannot start', async () => {
    m = await mountApp('room-viewer-waiting')
    expect(text(m.container)).toContain('Waiting for Ola')
    expect(queryByRole(m.container, 'button', 'Start anyway')).toBeNull()
  })

  it('viewers never get Start anyway, even with play/pause permission', async () => {
    m = await mountApp('room-viewer-waiting')
    const wait = { reason: 'buffering' as const, waitingFor: ['Ola'], softDeadline: null }
    act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'waiting', canPlayPause: true, canSeek: true, wait })))
    await flush()
    expect(text(m.container)).toContain('Waiting for Ola')
    expect(queryByRole(m.container, 'button', 'Start anyway')).toBeNull()
  })

  it('a viewer behind the host sees how far, and Resync to live asks core once, disabled until it answers', async () => {
    m = await mountApp('room-viewer-behind')
    const banner = (): string => text(m?.container)
    expect(banner()).toContain("You're 3.5 s behind the host")
    expect(banner()).not.toContain('(buffering)')
    let answer: (v: { outcome: 'skip' }) => void = () => undefined
    m.fake.handle('playback.resync', () => new Promise((resolve) => (answer = resolve)))
    const button = byRole(m.container, 'button', 'Resync to live')
    expect(button.getAttribute('title')).toBe('Jump to where the host is now')
    await click(button)
    expect(callsOf(m.fake, 'playback.resync')).toEqual([{}])
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await click(button)
    expect(callsOf(m.fake, 'playback.resync')).toHaveLength(1)
    await act(async () => {
      answer({ outcome: 'skip' })
      await Promise.resolve()
    })
    await flush()
    expect((byRole(m.container, 'button', 'Resync to live') as HTMLButtonElement).disabled).toBe(false)
    // a catch-up shows itself: no toast
    expect(text(byRole(m.container, 'region', 'Notifications'))).toBe('')
  })

  it('the desync banner says when the viewer is buffering, and shows the catch-up without a button', async () => {
    m = await mountApp('room-viewer-behind')
    const pb = m.fake.state.playback
    if (pb) act(() => m?.fake.emit('playback', { ...pb, stalled: true }))
    await flush()
    expect(text(m.container)).toContain("You're 3.5 s behind the host (buffering)")
    act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'playing', desync: { state: 'catching-up' } })))
    await flush()
    expect(text(m.container)).toContain('Resyncing with the host…')
    expect(queryByRole(m.container, 'button', 'Resync to live')).toBeNull()
  })

  it('the desync banner announces its state, not every new number while a stall grows', async () => {
    m = await mountApp('room-viewer-behind')
    const banner = (): Element => {
      const el = m?.container.querySelector('[data-testid="desync-banner"]')
      if (!el) throw new Error('no desync banner')
      return el
    }
    // what a screen reader is pushed: every live region in the banner, the banner itself included
    const announced = (): string[] =>
      [banner(), ...banner().querySelectorAll('*')]
        .filter((el) => el.matches('[role="status"], [role="alert"], [aria-live]'))
        .map((el) => text(el))
    expect(announced()).toEqual(["You're behind the host"])
    for (const behindS of [4, 4.5, 5]) {
      act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'playing', desync: { state: 'behind', behindS } })))
      await flush()
      expect(text(banner())).toContain(`You're ${String(behindS)} s behind the host`)
      expect(announced()).toEqual(["You're behind the host"])
    }
    act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'playing', desync: { state: 'catching-up' } })))
    await flush()
    expect(announced()).toEqual(['Resyncing with the host…'])
  })

  it('Resync to live when there is nothing to do says so', async () => {
    m = await mountApp('room-viewer-behind')
    m.fake.handle('playback.resync', () => ({ outcome: 'in-sync' }))
    await click(byRole(m.container, 'button', 'Resync to live'))
    expect(text(byRole(m.container, 'region', 'Notifications'))).toContain("You're already in sync.")
  })

  it('no desync banner for the host, a room that does not play, or a room that closed', async () => {
    const behind = { state: 'behind' as const, behindS: 4 }
    m = await mountApp('room-host')
    act(() => m?.fake.emit('sync', fx.sync('host', { mode: 'playing', desync: behind })))
    await flush()
    expect(text(m.container)).not.toContain('behind the host')
    await m.cleanup()

    m = await mountApp('room-viewer-behind')
    expect(text(m.container)).toContain('behind the host')
    act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'paused', desync: behind })))
    await flush()
    expect(text(m.container)).not.toContain('behind the host')
    act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'playing', desync: behind })))
    await flush()
    expect(text(m.container)).toContain("You're 4 s behind the host")
    act(() => {
      const s = m?.fake.state.session
      if (s) m?.fake.emit('session', { ...s, phase: 'ended' })
    })
    await flush()
    expect(text(m.container)).not.toContain('behind the host')
  })

  it('host panel shows the feasibility line from prepare events, with a warning when upload is short', async () => {
    m = await mountApp('room-host')
    const panel = byRole(m.container, 'region', 'Host controls')
    expect(panel.querySelector('[data-testid="feasibility"]')).toBeNull()
    const prepare = { stage: 'ready' as const, bytesDone: 1, bytesTotal: 1, bytesPerSec: 0, cached: false }
    act(() => m?.fake.emit('prepare', { ...prepare, feasibility: { needBps: 2_900_000, uploadBps: 2_100_000 } }))
    await flush()
    const line = panel.querySelector('[data-testid="feasibility"]')
    expect(text(line as Element)).toContain('Group needs ~23 Mbit/s from you; your upload ~17 Mbit/s')
    expect(line?.getAttribute('data-short')).toBe('true')
    act(() => m?.fake.emit('prepare', { ...prepare, feasibility: { needBps: 500_000, uploadBps: 4_400_000 } }))
    await flush()
    expect(panel.querySelector('[data-testid="feasibility"]')?.getAttribute('data-short')).toBeNull()
  })

  it("names the host's upload limit in the feasibility line when the limit is what holds the upload back", async () => {
    m = await mountApp('room-host', { settings: { uploadLimitKBps: 100 } })
    const panel = byRole(m.container, 'region', 'Host controls')
    const prepare = { stage: 'ready' as const, bytesDone: 1, bytesTotal: 1, bytesPerSec: 0, cached: false }
    act(() => m?.fake.emit('prepare', { ...prepare, feasibility: { needBps: 2_900_000, uploadBps: 102_400 } }))
    await flush()
    const line = panel.querySelector('[data-testid="feasibility"]')
    expect(text(line as Element)).toContain('Group needs ~23 Mbit/s from you; your upload limit ~0.8 Mbit/s')
    expect(text(line as Element)).toContain('Raise or clear the upload limit')
    expect(line?.getAttribute('data-short')).toBe('true')
  })

  it('the host edits its upload limit live, and has no download limit', async () => {
    m = await mountApp('room-host')
    const panel = byRole(m.container, 'region', 'Host controls')
    expect(text(panel)).toContain('Usually not needed: sending already slows down when your connection is full.')
    expect(() => byLabel(m?.container ?? document.body, 'Download limit')).toThrow()
    expect(queryByRole(m.container, 'region', 'Your connection')).toBeNull()
    const input = byLabel(panel, 'Upload limit')
    await typeInto(input, '300')
    await key(input, 'Enter')
    expect(m.fake.appCalls.filter((c) => c.method === 'setSettings').map((c) => c.params)).toEqual([
      [{ uploadLimitKBps: 300 }],
    ])
  })

  it('a viewer sets its download and upload limits live from Your connection', async () => {
    m = await mountApp('room-viewer')
    const card = byRole(m.container, 'region', 'Your connection')
    const saved = (): unknown[] => m?.fake.appCalls.filter((c) => c.method === 'setSettings').map((c) => c.params) ?? []
    const download = byLabel(card, 'Download limit (KB/s)') as HTMLInputElement
    expect(download.value).toBe('')
    expect(download.placeholder).toBe('No limit')
    await typeInto(download, '300')
    await key(download, 'Enter')
    expect(saved()).toEqual([[{ downloadLimitKBps: 300 }]])
    expect(m.fake.settings.downloadLimitKBps).toBe(300)
    expect(download.value).toBe('300')
    // the same value again, or leaving the field untouched: nothing to save
    await typeInto(download, ' 300 ')
    await key(download, 'Enter')
    download.focus()
    act(() => download.blur())
    await flush()
    expect(saved()).toHaveLength(1)
    // a bad value says why and saves nothing; so does one Settings would reject later (its bound is the same)
    for (const bad of ['1.5', '0', '20000000', '99999999999999999999']) {
      await typeInto(download, bad)
      await key(download, 'Enter')
      expect(text(card)).toContain('Use a whole number of KB/s up to 10000000, or leave empty for no limit.')
      expect(download.getAttribute('aria-invalid')).toBe('true')
    }
    expect(saved()).toHaveLength(1)
    // empty clears it, on leaving the field
    await typeInto(download, '')
    download.focus()
    act(() => download.blur())
    await flush()
    expect(saved().at(-1)).toEqual([{ downloadLimitKBps: null }])
    expect(text(card)).not.toContain('Use a whole number')
    const upload = byLabel(card, 'Upload limit (KB/s)')
    await typeInto(upload, '200')
    await key(upload, 'Enter')
    expect(saved().at(-1)).toEqual([{ uploadLimitKBps: 200 }])
    expect(text(card)).toContain('Changes apply now and are kept for next time.')
  })

  it("a viewer's download limit is held against the video's bitrate", async () => {
    // the fixture's file: 58.2 GB over 90 min, ~86 Mbit/s
    m = await mountApp('room-viewer', { settings: { downloadLimitKBps: 100 } })
    const note = (): string | null => {
      const el = m?.container.querySelector('[data-testid="bitrate-note"]')
      return el ? text(el) : null
    }
    expect(note()).toBe("⚠ Warning: Below this video's bitrate (~86 Mbit/s): playback will pause to buffer.")
    const download = byLabel(m.container, 'Download limit (KB/s)')
    // 11.3 MB/s: above the average but below 1.1 × it, where core's slow-download warning would never clear
    await typeInto(download, '11000')
    await key(download, 'Enter')
    expect(note()).toBe("⚠ Warning: Close to this video's bitrate (~86 Mbit/s): playback may pause to buffer.")
    await typeInto(download, '20000') // 20.5 MB/s, above 1.1 × 10.8 MB/s
    await key(download, 'Enter')
    expect(note()).toBe('This video needs about 86 Mbit/s.')
    await typeInto(download, '')
    await key(download, 'Enter')
    expect(note()).toBeNull()
  })

  it("the viewer's transfer line says (limited) only while a download limit is set", async () => {
    m = await mountApp('room-viewer', { settings: { downloadLimitKBps: 500 } })
    const line = (): string => text(byRole(m?.container ?? document.body, 'region', 'Timeline'))
    expect(line()).toContain('(limited)')
    const download = byLabel(m.container, 'Download limit (KB/s)')
    await typeInto(download, '')
    await key(download, 'Enter')
    expect(line()).not.toContain('(limited)')
  })

  it('a viewer typing a limit does not play, pause or seek', async () => {
    m = await mountApp('room-viewer')
    act(() => m?.fake.emit('sync', fx.sync('viewer', { canPlayPause: true, canSeek: true })))
    await flush()
    await key(document.body, ' ')
    expect(callsOf(m.fake, 'playback.intent')).toEqual([{ kind: 'toggle' }])
    const input = byLabel(m.container, 'Download limit')
    input.focus()
    await key(input, ' ')
    await key(input, 'ArrowRight')
    expect(callsOf(m.fake, 'playback.intent')).toHaveLength(1)
  })

  it('copies the invite text block', async () => {
    m = await mountApp('room-host')
    await click(byRole(m.container, 'button', 'Copy invite'))
    expect(m.fake.clipboard).toContain(fx.INVITE)
    expect(m.fake.clipboard).toContain('Join me on Cinemesh')
  })

  it('leave prompt offers save, keep and delete to viewers', async () => {
    m = await mountApp('room-viewer')
    await click(byRole(m.container, 'button', /^Leave$/))
    const dialog = byRole(m.container, 'dialog', 'Leave the room?')
    expect(byRole(dialog, 'button', 'Save file').hasAttribute('disabled')).toBe(true)
    await click(byRole(dialog, 'button', 'Delete now'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'delete' }])
  })

  it('leave prompt lets the host end the room', async () => {
    m = await mountApp('room-host')
    await click(byRole(m.container, 'button', /^Leave$/))
    await click(byRole(byRole(m.container, 'dialog'), 'button', 'End room for everyone'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep', end: true }])
  })

  it('ended card shows when the video ends while the room stays open', async () => {
    m = await mountApp('room-host')
    expect(queryByRole(m.container, 'region', 'The video has ended')).toBeNull()
    act(() => m?.fake.emit('sync', fx.sync('host', { mode: 'ended' })))
    await flush()
    expect(byRole(m.container, 'region', 'The video has ended')).toBeTruthy()
    expect(text(m.container)).not.toContain('The host ended the room')
  })

  it('ended card: host plays again, and the card goes away once the room plays', async () => {
    m = await mountApp('ended-host')
    await click(byRole(m.container, 'button', 'Play again'))
    expect(callsOf(m.fake, 'playback.intent')).toEqual([{ kind: 'seek', posS: 0 }, { kind: 'play' }])
    expect(queryByRole(m.container, 'region', 'The video has ended')).toBeNull()
  })

  it('ended card: host ends the room', async () => {
    m = await mountApp('ended-host')
    await click(byRole(m.container, 'button', 'End room'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep', end: true }])
  })

  it('ended card: viewer saves the finished file', async () => {
    m = await mountApp('ended-viewer')
    const card = byRole(m.container, 'region', 'The video has ended')
    expect(queryByRole(card, 'button', 'Play again')).toBeNull()
    expect(queryByRole(card, 'button', 'Save file…')).toBeNull()
    expect(text(card)).toContain('34 % downloaded')
    expect(byRole(card, 'button', /^Leave$/)).toBeTruthy()
    act(() => {
      const t = m?.fake.state.transfer
      if (t) m?.fake.emit('transfer', { ...t, progress: 1 })
    })
    await flush()
    await click(byRole(card, 'button', 'Save file…'))
    expect(callsOf(m.fake, 'transfer.saveFile')).toEqual([{ dest: '/media/alex/External' }])
    // where it went: core's transfer.export-finished notice, with Show in folder
    const toasts = byRole(m.container, 'region', 'Notifications')
    expect(text(toasts)).toContain(`Saved ${fx.FILE.name}`)
    await click(byRole(toasts, 'button', 'Show in folder'))
    expect(m.fake.appCalls.filter((c) => c.method === 'showItemInFolder').map((c) => c.params)).toEqual([
      [`/media/alex/External/${fx.FILE.name}`],
    ])
  })

  it('room closed by the host: viewer keeps or deletes a partial download, no Play again', async () => {
    m = await mountApp('room-closed')
    const card = byRole(m.container, 'region', 'The host ended the room')
    expect(queryByRole(m.container, 'region', 'The video has ended')).toBeNull()
    expect(queryByRole(card, 'button', 'Play again')).toBeNull()
    expect(queryByRole(card, 'button', 'Save file')).toBeNull()
    await click(byRole(card, 'button', 'Keep for later'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep' }])
  })

  it('room closed by the host: viewer with the whole file can save it or delete it', async () => {
    m = await mountApp('room-closed')
    act(() => {
      const t = m?.fake.state.transfer
      if (t) m?.fake.emit('transfer', { ...t, progress: 1 })
    })
    await flush()
    const card = byRole(m.container, 'region', 'The host ended the room')
    expect(byRole(card, 'button', 'Delete')).toBeTruthy()
    await click(byRole(card, 'button', 'Save file'))
    // transfer.saveFile rather than session.leave {data: 'save'}: it refuses an incomplete download before leaving
    expect(callsOf(m.fake, 'transfer.saveFile')).toEqual([{}])
    expect(callsOf(m.fake, 'session.leave')).toEqual([])
    // where it went: core's transfer.export-finished notice, with Show in folder
    const toasts = byRole(m.container, 'region', 'Notifications')
    expect(text(toasts)).toContain(`Saved ${fx.FILE.name}`)
    await click(byRole(toasts, 'button', 'Show in folder'))
    expect(m.fake.appCalls.filter((c) => c.method === 'showItemInFolder').map((c) => c.params)).toEqual([
      [`/home/alex/Downloads/Cinemesh/${fx.FILE.name}`],
    ])
  })

  it('room closed by the host: no wait banner, even when the last sync event still had a wait', async () => {
    m = await mountApp('room-viewer-waiting')
    expect(text(m.container)).toContain('Waiting for Ola')
    // sync stops once the host ends the room, so its last event (with the wait) stays in the store
    act(() => {
      const s = m?.fake.state.session
      if (s) m?.fake.emit('session', { ...s, phase: 'ended' })
    })
    await flush()
    expect(byRole(m.container, 'region', 'The host ended the room')).toBeTruthy()
    expect(m.fake.state.sync?.wait).toBeDefined()
    expect(text(m.container)).not.toContain('Waiting for')
    expect(queryByRole(m.container, 'button', 'Start anyway')).toBeNull()
  })

  it('leaving: no wait banner either, even when the last sync event still had a wait', async () => {
    m = await mountApp('room-host')
    const wait = { reason: 'buffering' as const, waitingFor: ['Ola'], softDeadline: null }
    act(() => m?.fake.emit('sync', fx.sync('host', { mode: 'waiting', wait })))
    await flush()
    expect(text(m.container)).toContain('Waiting for Ola')
    // sync stops once the leave runs, so its last event (with the wait) stays in the store
    act(() => {
      const s = m?.fake.state.session
      if (s) m?.fake.emit('session', { ...s, phase: 'leaving', leave: 'keep' })
    })
    await flush()
    expect(byRole(m.container, 'status', 'Leaving the room')).toBeTruthy()
    expect(m.fake.state.sync?.wait).toBeDefined()
    expect(text(m.container)).not.toContain('Waiting for')
    expect(queryByRole(m.container, 'button', 'Start anyway')).toBeNull()
  })

  it('room closed while the video had ended shows only the closed card', async () => {
    m = await mountApp('room-closed')
    act(() => m?.fake.emit('sync', fx.sync('viewer', { mode: 'ended' })))
    await flush()
    expect(byRole(m.container, 'region', 'The host ended the room')).toBeTruthy()
    expect(queryByRole(m.container, 'region', 'The video has ended')).toBeNull()
  })

  it('local panel switches tracks and shows the HDR label', async () => {
    m = await mountApp('room-viewer')
    expect(text(m.container)).toContain('HDR, tone-mapped to SDR')
    const audio = byLabel(m.container, 'Audio') as HTMLSelectElement
    await act(async () => {
      audio.value = '2'
      audio.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    await flush()
    expect(callsOf(m.fake, 'player.setTrack')).toEqual([{ kind: 'audio', id: 2 }])
    await click(byRole(m.container, 'button', 'Show player'))
    expect(callsOf(m.fake, 'player.reopen')).toHaveLength(1)
  })
})
