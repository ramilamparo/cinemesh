import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { FASTSTART_REMUX } from '../../../shared/media/media-map'
import * as fx from '../mock/fixtures'
import { type Mounted, byRole, click, flush, mountApp, text } from '../test/harness'

// session.media.fullDownload (an fMP4 without sidx): viewers can only play once the whole file is on disk.
// The host is warned, with the remux that fixes it; a viewer sees how far the download is.

const warning = (m: Mounted): Element | null => m.container.querySelector('[data-testid="full-download"]')
const waitLine = (m: Mounted): Element | null => m.container.querySelector('[data-testid="full-download-wait"]')

/** The phase badge of a peer row (after the role badge). */
function phaseOf(m: Mounted, row: string): string {
  const badge = m.container.querySelector(`li[aria-label="${row}"]`)?.querySelectorAll('.badge')[1]
  if (!badge) throw new Error(`no phase badge for ${row}`)
  return text(badge)
}

/** Sync's 'joining' for these rows: a member without a source to load (a whole-file download keeps it there). */
function joining(m: Mounted, names: string[]): void {
  const peers = m.fake.state.peers ?? []
  act(() =>
    m.fake.emit(
      'peers',
      peers.map((p) => (names.includes(p.name) ? { ...p, phase: 'joining' as const } : p)),
    ),
  )
}

describe('full-download files', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('HostPrepare warns the host and copies the remux command', async () => {
    m = await mountApp('preparing-full-download')
    const box = warning(m)
    expect(text(box as Element)).toContain('Viewers can only start after downloading the whole file')
    expect(text(box as Element)).toContain(FASTSTART_REMUX)
    await click(byRole(box as Element, 'button', 'Copy the remux command'))
    expect(m.fake.clipboard).toBe(FASTSTART_REMUX)
    expect(text(byRole(m.container, 'region', 'Notifications'))).toContain('Remux command copied')
  })

  it('HostPrepare shows the warning once indexing reports it, and not for other files', async () => {
    m = await mountApp('preparing')
    expect(warning(m)).toBeNull()
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    act(() => m?.fake.emit('session', { ...s, media: fx.media(false) }))
    await flush()
    expect(warning(m)).toBeNull()
    act(() => m?.fake.emit('session', { ...s, media: fx.media(true) }))
    await flush()
    expect(warning(m)).not.toBeNull()
  })

  it("the host's Room keeps the warning with the command; viewers' lines are not shown to the host", async () => {
    m = await mountApp('room-host-full-download')
    expect(text(warning(m) as Element)).toContain('Viewers can only start after downloading the whole file')
    expect(text(warning(m) as Element)).toContain(FASTSTART_REMUX)
    expect(waitLine(m)).toBeNull()
  })

  it('a normal file shows neither', async () => {
    m = await mountApp('room-host')
    expect(m.fake.state.session?.media?.fullDownload).toBe(false)
    expect(warning(m)).toBeNull()
    await m.cleanup()
    m = await mountApp('room-viewer')
    expect(waitLine(m)).toBeNull()
    expect(warning(m)).toBeNull()
  })

  it("a viewer's Room says it plays once the whole video is downloaded, with the progress", async () => {
    m = await mountApp('room-viewer-full-download')
    expect(text(waitLine(m) as Element)).toBe('⏳ Plays once the whole video is downloaded (34 %)')
    // the remux advice is for the host only
    expect(warning(m)).toBeNull()
    const t = m.fake.state.transfer
    if (!t) throw new Error('no transfer')
    act(() => m?.fake.emit('transfer', { ...t, progress: 0.5 }))
    await flush()
    expect(text(waitLine(m) as Element)).toContain('(50 %)')
    act(() => m?.fake.emit('transfer', { ...t, progress: 1 }))
    await flush()
    expect(waitLine(m)).toBeNull()
  })

  it('neither stays under the leaving banner (core keeps media on its leaving event)', async () => {
    m = await mountApp('room-viewer-full-download')
    expect(waitLine(m)).not.toBeNull()
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    const { role, roomId, fileName, fileSize, durationS, media } = s
    act(() =>
      m?.fake.emit('session', {
        phase: 'leaving',
        role,
        roomId,
        fileName,
        fileSize,
        durationS,
        ...(media ? { media } : {}),
      }),
    )
    await flush()
    expect(text(m.container)).toContain('Leaving the room…')
    expect(waitLine(m)).toBeNull()
    await m.cleanup()
    m = await mountApp('room-host-full-download')
    expect(warning(m)).not.toBeNull()
    act(() => m?.fake.emit('session', { ...s, role: 'host', phase: 'leaving' }))
    await flush()
    expect(warning(m)).toBeNull()
  })

  it("a viewer's own row says Downloading N % instead of Joining while it waits for the whole file", async () => {
    m = await mountApp('room-viewer-full-download')
    joining(m, ['Jun', 'Ola'])
    await flush()
    expect(phaseOf(m, 'Jun (you)')).toBe('Downloading 34 %')
    // only our own row knows what its wait is: another member keeps sync's word
    expect(phaseOf(m, 'Ola')).toBe('Joining')
    const t = m.fake.state.transfer
    if (!t) throw new Error('no transfer')
    act(() => m?.fake.emit('transfer', { ...t, progress: 0.5 }))
    await flush()
    expect(phaseOf(m, 'Jun (you)')).toBe('Downloading 50 %')
    // complete: the member loads now, and its row follows sync again
    act(() => m?.fake.emit('transfer', { ...t, progress: 1 }))
    await flush()
    expect(phaseOf(m, 'Jun (you)')).toBe('Joining')
  })

  it('other phases, and joining with a file that streams, keep what sync says', async () => {
    m = await mountApp('room-viewer-full-download')
    expect(phaseOf(m, 'Jun (you)')).toBe('Paused')
    await m.cleanup()
    m = await mountApp('room-viewer')
    joining(m, ['Jun'])
    await flush()
    expect(phaseOf(m, 'Jun (you)')).toBe('Joining')
  })

  it('JoinConfirm tells a viewer before joining', async () => {
    m = await mountApp('confirm-join')
    expect(m.container.querySelector('[data-testid="full-download-note"]')).toBeNull()
    expect(text(m.container)).toContain('The video downloads while you watch')
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    act(() => m?.fake.emit('session', { ...s, media: fx.media(true) }))
    await flush()
    const note = m.container.querySelector('[data-testid="full-download-note"]')
    expect(text(note as Element)).toContain('This video plays only once all of it is downloaded')
    expect(text(m.container)).not.toContain('The video downloads while you watch')
  })
})
