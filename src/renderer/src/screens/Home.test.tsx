import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { INVITE } from '../mock/fixtures'
import {
  type Mounted,
  byLabel,
  byRole,
  callsOf,
  click,
  dragTo,
  flush,
  mountApp,
  queryByRole,
  text,
  typeInto,
} from '../test/harness'

const CODE = INVITE.slice('cinemesh://join/'.length)

describe('Home', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('joins with a pasted invite, even when a chat app wrapped it over lines', async () => {
    m = await mountApp('home')
    const box = byLabel(m.container, 'Paste the invite link')
    const join = byRole(m.container, 'button', /^Join$/)
    expect(join.hasAttribute('disabled')).toBe(true)

    await typeInto(box, `cinemesh://join/${CODE.slice(0, 50)}\n${CODE.slice(50)}`)
    expect(join.hasAttribute('disabled')).toBe(false)
    expect(text(m.container)).toContain('Invite recognised')

    await click(join)
    expect(callsOf(m.fake, 'session.join')).toEqual([{ invite: INVITE }])
    await flush(6)
    expect(m.container.querySelector('[data-screen]')?.getAttribute('data-screen')).toBe('join')
  })

  it('accepts a bare code and rejects other text', async () => {
    m = await mountApp('home')
    const box = byLabel(m.container, 'Paste the invite link')
    await typeInto(box, 'hello there')
    expect(box.getAttribute('aria-invalid')).toBe('true')
    expect(text(m.container)).toContain('does not look like an invite')
    expect(byRole(m.container, 'button', /^Join$/).hasAttribute('disabled')).toBe(true)

    await typeInto(box, `  ${CODE.toUpperCase()}  `)
    expect(box.getAttribute('aria-invalid')).toBeNull()
    await click(byRole(m.container, 'button', /^Join$/))
    expect(callsOf(m.fake, 'session.join')).toEqual([{ invite: INVITE }])
  })

  it('offers an invite found on the clipboard', async () => {
    m = await mountApp('home', { clipboard: `Come watch! ${INVITE} see you` })
    expect(text(m.container)).toContain('An invite is on your clipboard')
    await click(byRole(m.container, 'button', 'Join it'))
    expect(callsOf(m.fake, 'session.join')).toEqual([{ invite: INVITE }])
  })

  it('can dismiss the clipboard offer', async () => {
    m = await mountApp('home', { clipboard: INVITE })
    await click(byRole(m.container, 'button', 'Not now'))
    expect(text(m.container)).not.toContain('An invite is on your clipboard')
  })

  it('joins a pending deep link from a cold start exactly once', async () => {
    m = await mountApp('home', { pendingDeepLink: INVITE })
    await flush()
    act(() => m?.fake.deepLink(INVITE))
    await flush()
    expect(callsOf(m.fake, 'session.join')).toEqual([{ invite: INVITE }])
  })

  it('asks before leaving an active room for a deep link', async () => {
    m = await mountApp('room-viewer')
    act(() => m?.fake.deepLink(INVITE))
    await flush()
    const dialog = byRole(m.container, 'dialog', 'Join another room?')
    expect(callsOf(m.fake, 'session.join')).toEqual([])
    await click(byRole(dialog, 'button', 'Leave and join'))
    expect(callsOf(m.fake, 'session.leave')).toEqual([{ data: 'keep' }])
    expect(callsOf(m.fake, 'session.join')).toEqual([{ invite: INVITE }])
  })

  it('lists recent rooms and resumes one', async () => {
    m = await mountApp('home')
    expect(text(m.container)).toContain('Recent rooms')
    expect(byRole(m.container, 'button', 'Resume Holiday 2025.mp4').hasAttribute('disabled')).toBe(true)
    expect(text(m.container)).toContain('The source file has moved or changed')
    await click(byRole(m.container, 'button', 'Resume Nature.Documentary.S01E03.mkv'))
    expect(callsOf(m.fake, 'session.resume')).toEqual([{ roomId: 'r-old1' }])
  })

  it('hides recent rooms when core does not support them yet', async () => {
    m = await mountApp('home', { unsupported: ['session.recent'] })
    expect(callsOf(m.fake, 'session.recent')).toHaveLength(1)
    expect(queryByRole(m.container, 'region', 'Recent rooms')).toBeNull()
    expect(text(m.container)).not.toContain('Not available yet')
  })

  it('hosts a video with subtitles', async () => {
    m = await mountApp('home')
    await click(byRole(m.container, 'button', 'Host a video…'))
    await click(byRole(m.container, 'button', 'Add subtitles…'))
    expect(text(m.container)).toContain('friends.srt')
    await click(byRole(m.container, 'button', 'Start hosting'))
    expect(callsOf(m.fake, 'session.host')).toEqual([
      { videoPath: '/home/alex/Videos/Big.Buck.Bunny.2160p.HDR.mkv', subtitlePaths: ['/home/alex/Videos/friends.srt'] },
    ])
  })

  it('hosts several videos as a playlist, in episode order', async () => {
    m = await mountApp('home', {
      pickedVideos: ['/v/Show.S01E10.mkv', '/v/Show.S01E2.mkv', '/v/Show.S01E1.mkv'],
    })
    await click(byRole(m.container, 'button', 'Host a video…'))
    const list = byRole(m.container, 'list', 'Playlist')
    expect(text(list)).toMatch(/E1\.mkv.*E2\.mkv.*E10\.mkv/)
    expect(text(m.container)).toContain('Subtitle files for Show.S01E1.mkv')
    await click(byRole(m.container, 'button', 'Remove Show.S01E2.mkv'))
    await click(byRole(m.container, 'button', 'Start hosting'))
    expect(callsOf(m.fake, 'session.host')).toEqual([
      { videoPath: '/v/Show.S01E1.mkv', subtitlePaths: [], more: ['/v/Show.S01E10.mkv'] },
    ])
  })

  it('orders the playlist as the host likes; added videos go after it', async () => {
    m = await mountApp('home', { pickedVideos: ['/v/Show.S01E2.mkv', '/v/Show.S01E1.mkv'] })
    await click(byRole(m.container, 'button', 'Host a video…'))
    await click(byRole(m.container, 'button', 'Add subtitles…'))
    await click(byRole(m.container, 'button', 'Move Show.S01E2.mkv up'))
    const list = (): HTMLElement => byRole(m?.container ?? document.body, 'list', 'Playlist')
    expect(text(list())).toMatch(/E2\.mkv.*E1\.mkv/)
    // the subtitle files chosen were for the video that opened the playlist
    expect(text(m.container)).toContain('Subtitle files for Show.S01E2.mkv')
    expect(text(m.container)).not.toContain('friends.srt')

    m.fake.pickedVideos = ['/v/Show.S01E4.mkv', '/v/Show.S01E3.mkv', '/v/Show.S01E1.mkv']
    await click(byRole(m.container, 'button', 'Add videos…'))
    expect(text(list())).toMatch(/E2\.mkv.*E1\.mkv.*E3\.mkv.*E4\.mkv/)
    // drag the last one to the top
    const rows = (): HTMLElement[] => [...list().querySelectorAll('li')]
    await dragTo(rows()[3] as HTMLElement, rows()[0] as HTMLElement)
    expect(text(list())).toMatch(/E4\.mkv.*E2\.mkv.*E1\.mkv.*E3\.mkv/)
    expect(byRole(m.container, 'button', 'Move Show.S01E4.mkv up').hasAttribute('disabled')).toBe(true)
    await click(byRole(m.container, 'button', 'Start hosting'))
    expect(callsOf(m.fake, 'session.host')).toEqual([
      {
        videoPath: '/v/Show.S01E4.mkv',
        subtitlePaths: [],
        more: ['/v/Show.S01E2.mkv', '/v/Show.S01E1.mkv', '/v/Show.S01E3.mkv'],
      },
    ])
  })

  it('runs the network test and shows the hint', async () => {
    m = await mountApp('home')
    await click(byRole(m.container, 'button', 'Test network'))
    await flush(4)
    expect(text(m.container)).toContain('RANDOM')
    expect(text(m.container)).toContain('need a relay')
  })

  it('saves the display name and validates it', async () => {
    m = await mountApp('home')
    const input = byLabel(m.container, 'Display name')
    await typeInto(input, '   ')
    await click(byRole(m.container, 'button', /^Save$/))
    expect(text(m.container)).toContain('Use 1 to 32 characters')
    await typeInto(input, 'Robin')
    await click(byRole(m.container, 'button', /^Save$/))
    expect(m.fake.settings.displayName).toBe('Robin')
  })
})
