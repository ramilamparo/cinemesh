import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../../shared/ipc/core'
import { FASTSTART_REMUX } from '../../../shared/media/media-map'
import { MKV_REMUX, TS_REMUX } from '../../../shared/media/remux'
import * as fx from '../mock/fixtures'
import { type Mounted, byRole, click, flush, mountApp, queryByRole, text } from '../test/harness'
import { remuxFor } from './MediaNotes'

// session.media beyond the full download: no seek index ('linear') and poor interleave. The host learns what that
// means for viewers (with the remux when src/shared/media has one); a downloading viewer gets one short line.

type Media = NonNullable<SessionEvent['media']>

const LINEAR_FMP4: Media = { container: 'fmp4', seekMode: 'linear', fullDownload: false, interleave: 'unknown' }

const note = (m: Mounted, id: string): Element | null => m.container.querySelector(`[data-testid="media-note-${id}"]`)

/** The session as it is, with this media (what core sends once indexing or the manifest knows it). */
function setMedia(m: Mounted, media: Media | undefined): void {
  const s = m.fake.state.session
  if (!s) throw new Error('no session')
  const { media: _old, ...rest } = s
  act(() => m.fake.emit('session', media ? { ...rest, media } : rest))
}

describe('media notes', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('HostPrepare: no seek index means seeking is slower for viewers; a cue-less MKV gets the Matroska remux', async () => {
    m = await mountApp('preparing-linear')
    const linear = note(m, 'linear')
    expect(text(linear as Element)).toContain('Seeking is slower for viewers.')
    expect(text(linear as Element)).toContain('no seek index')
    // the remux src/shared/media gives for it, with the files it reads and writes
    expect(text(linear as Element)).toContain(
      'A remux adds one without re-encoding: run this with your file as in.mkv, then host out.mkv.',
    )
    expect(text(linear as Element)).toContain(MKV_REMUX)
    await click(byRole(linear as Element, 'button', 'Copy the remux command'))
    expect(m.fake.clipboard).toBe(MKV_REMUX)
    expect(note(m, 'interleave')).toBeNull()
  })

  it('HostPrepare: an MPEG-TS goes into Matroska; an AVI gets the note but no made-up remux', async () => {
    m = await mountApp('preparing')
    setMedia(m, { container: 'mpegts', seekMode: 'linear', fullDownload: false, interleave: 'unknown' })
    await flush()
    expect(text(note(m, 'linear') as Element)).toContain('run this with your file as in.ts, then host out.mkv.')
    expect(text(note(m, 'linear') as Element)).toContain(TS_REMUX)
    setMedia(m, { container: 'avi', seekMode: 'linear', fullDownload: false, interleave: 'poor' })
    await flush()
    expect(text(note(m, 'linear') as Element)).toContain('Seeking is slower for viewers.')
    expect(note(m, 'interleave')).not.toBeNull()
    expect(text(m.container)).not.toContain('ffmpeg')
    expect(queryByRole(m.container, 'button', 'Copy the remux command')).toBeNull()
  })

  it('HostPrepare: a linear fMP4 gets the remux from src/shared/media, with Copy', async () => {
    m = await mountApp('preparing')
    expect(note(m, 'linear')).toBeNull()
    setMedia(m, LINEAR_FMP4)
    await flush()
    const linear = note(m, 'linear')
    expect(text(linear as Element)).toContain(FASTSTART_REMUX)
    await click(byRole(linear as Element, 'button', 'Copy the remux command'))
    expect(m.fake.clipboard).toBe(FASTSTART_REMUX)
    expect(text(byRole(m.container, 'region', 'Notifications'))).toContain('Remux command copied')
  })

  it('HostPrepare: poor interleave means viewers need more data before playing or seeking', async () => {
    m = await mountApp('preparing')
    setMedia(m, fx.POOR_MP4)
    await flush()
    const interleave = note(m, 'interleave')
    expect(text(interleave as Element)).toContain('Viewers need more data before playing or seeking.')
    // a poorly interleaved MP4 with an index: the faststart remux stores its samples in time order
    expect(text(interleave as Element)).toContain(
      'A remux stores the audio with its video without re-encoding: run this with your file as in.mp4, then host out.mp4.',
    )
    expect(text(interleave as Element)).toContain(FASTSTART_REMUX)
    expect(note(m, 'linear')).toBeNull()
    // both at once: both lines, and the one remux that fixes both, once
    setMedia(m, { ...fx.LINEAR_MKV, interleave: 'poor' })
    await flush()
    expect(note(m, 'interleave')).not.toBeNull()
    expect(text(note(m, 'linear') as Element)).toContain('A remux adds one and stores the audio with its video')
    expect(text(note(m, 'linear') as Element)).toContain(MKV_REMUX)
    expect(m.container.querySelectorAll('code')).toHaveLength(1)
  })

  it('nothing for a well-indexed file, an unknown interleave, or before indexing says', async () => {
    m = await mountApp('preparing')
    expect(note(m, 'linear')).toBeNull()
    for (const media of [fx.media(false), { ...fx.media(false), interleave: 'unknown' as const }, undefined]) {
      setMedia(m, media)
      await flush()
      expect(note(m, 'linear')).toBeNull()
      expect(note(m, 'interleave')).toBeNull()
    }
    // an older core without interleave
    const { interleave: _i, ...older } = fx.media(false)
    setMedia(m, older)
    await flush()
    expect(note(m, 'interleave')).toBeNull()
  })

  it('a full-download file shows only its own warning (it plays from disk, so seeking is not slower)', async () => {
    m = await mountApp('preparing-full-download')
    expect(fx.media(true).seekMode).toBe('linear')
    expect(m.container.querySelector('[data-testid="full-download"]')).not.toBeNull()
    expect(note(m, 'linear')).toBeNull()
    expect(note(m, 'interleave')).toBeNull()
    expect(m.container.querySelectorAll('code')).toHaveLength(1)
  })

  it("the host's Room shows them too, and not under the leaving banner", async () => {
    m = await mountApp('room-host-linear')
    expect(text(note(m, 'linear') as Element)).toContain('Seeking is slower for viewers.')
    expect(note(m, 'viewer')).toBeNull()
    setMedia(m, { ...fx.LINEAR_MKV, interleave: 'poor' })
    await flush()
    expect(note(m, 'interleave')).not.toBeNull()
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    act(() => m?.fake.emit('session', { ...s, phase: 'leaving', leave: 'end' }))
    await flush()
    expect(text(m.container)).toContain('Ending the room…')
    expect(note(m, 'linear')).toBeNull()
    expect(note(m, 'interleave')).toBeNull()
  })

  it("a viewer's Room: one short line under the download line while it downloads, never the host's notes", async () => {
    m = await mountApp('room-viewer-linear')
    const line = note(m, 'viewer')
    expect(text(line as Element)).toBe('ℹ Note: Seeking ahead takes longer with this file: it has no seek index.')
    expect(line?.closest('section')?.getAttribute('aria-label')).toBe('Timeline')
    expect(note(m, 'linear')).toBeNull()
    expect(queryByRole(m.container, 'button', 'Copy the remux command')).toBeNull()

    setMedia(m, fx.POOR_MP4)
    await flush()
    expect(text(note(m, 'viewer') as Element)).toContain('Starting and seeking take longer with this file')
    expect(text(note(m, 'viewer') as Element)).not.toContain('seek index')

    // with the whole file on disk, starts and seeks are local: nothing to explain any more
    const t = m.fake.state.transfer
    if (!t) throw new Error('no transfer')
    act(() => m?.fake.emit('transfer', { ...t, progress: 1 }))
    await flush()
    expect(note(m, 'viewer')).toBeNull()
  })

  it("a viewer's line is not shown for a normal file, nor while leaving", async () => {
    m = await mountApp('room-viewer')
    expect(note(m, 'viewer')).toBeNull()
    setMedia(m, fx.LINEAR_MKV)
    await flush()
    expect(note(m, 'viewer')).not.toBeNull()
    const s = m.fake.state.session
    if (!s) throw new Error('no session')
    act(() => m?.fake.emit('session', { ...s, phase: 'leaving', leave: 'keep' }))
    await flush()
    expect(note(m, 'viewer')).toBeNull()
  })

  it('remuxFor gives what src/shared/media gives, for what the notes show (no seek index, poor interleave)', () => {
    expect(remuxFor('fmp4', { linear: true, poor: false })).toBe(FASTSTART_REMUX)
    expect(remuxFor('mp4', { linear: false, poor: true })).toBe(FASTSTART_REMUX)
    expect(remuxFor('mkv', { linear: true, poor: false })).toBe(MKV_REMUX)
    expect(remuxFor('mpegts', { linear: true, poor: true })).toBe(TS_REMUX)
    // none for a file that needs none, nor where no stream copy is known to fix it
    expect(remuxFor('mkv', { linear: false, poor: false })).toBeNull()
    for (const container of ['avi', 'generic', null]) {
      expect(remuxFor(container, { linear: true, poor: true })).toBeNull()
    }
  })
})
