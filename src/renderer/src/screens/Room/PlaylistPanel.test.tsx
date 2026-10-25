import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { type Mounted, byRole, callsOf, click, mountApp, queryByRole, text } from '../../test/harness'
import * as fx from '../../mock/fixtures'

describe('PlaylistPanel', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('shows no playlist for a room without one (an older host)', async () => {
    m = await mountApp('room-viewer')
    expect(queryByRole(m.container, 'region', 'Playlist')).toBeNull()
  })

  it("lists the host's items with what preparing each one has reached", async () => {
    m = await mountApp('room-host-playlist')
    const panel = byRole(m.container, 'region', 'Playlist')
    const rows = [...panel.querySelectorAll('li')]
    expect(rows).toHaveLength(4)
    expect(rows[1]?.getAttribute('aria-current')).toBe('true')
    expect(text(rows[1] as HTMLElement)).toContain('Playing')
    expect(text(rows[2] as HTMLElement)).toContain('Preparing 41 %')
    expect(text(rows[3] as HTMLElement)).toContain('Waiting to be prepared')
    // an item still preparing cannot be played yet, and the one playing cannot be removed
    expect(byRole(panel, 'button', 'Play Nature.Documentary.S01E03').hasAttribute('disabled')).toBe(true)
    expect(byRole(panel, 'button', 'Remove Nature.Documentary.S01E02').hasAttribute('disabled')).toBe(true)
  })

  it('plays, orders, removes and adds items, and moves on with Next and Previous', async () => {
    m = await mountApp('room-host-playlist', {
      pickedVideos: ['/v/Nature.Documentary.S01E06.mkv', '/v/Nature.Documentary.S01E05.mkv'],
    })
    const panel = (): HTMLElement => byRole(m?.container ?? document.body, 'region', 'Playlist')
    await click(byRole(panel(), 'button', 'Play Nature.Documentary.S01E01'))
    expect(callsOf(m.fake, 'playlist.play')).toEqual([{ id: 'aaaaaaaaaaa1' }])
    // the room's title follows the item playing
    expect(m.container.querySelector('h1')?.textContent).toContain('S01E01')
    // the first item has nothing before it
    expect(byRole(panel(), 'button', 'Previous').hasAttribute('disabled')).toBe(true)
    await click(byRole(panel(), 'button', 'Next'))
    expect(callsOf(m.fake, 'playlist.next')).toHaveLength(1)

    await click(byRole(panel(), 'button', 'Move Nature.Documentary.S01E04.1080p.mkv up'))
    expect(callsOf(m.fake, 'playlist.move')).toEqual([{ id: 'aaaaaaaaaaa4', toIndex: 2 }])
    await click(byRole(panel(), 'button', 'Remove Nature.Documentary.S01E04'))
    expect(callsOf(m.fake, 'playlist.remove')).toEqual([{ id: 'aaaaaaaaaaa4' }])
    // added in episode order, whatever order the dialog gave
    await click(byRole(panel(), 'button', 'Add videos…'))
    expect(callsOf(m.fake, 'playlist.add')).toEqual([
      { videoPaths: ['/v/Nature.Documentary.S01E05.mkv', '/v/Nature.Documentary.S01E06.mkv'] },
    ])
    await click(byRole(panel(), 'switch', 'Play the next video by itself'))
    expect(callsOf(m.fake, 'playlist.setAutoAdvance')).toEqual([{ on: false }])
  })

  it('shows a viewer its own copy of each item, and no host controls', async () => {
    m = await mountApp('room-viewer-playlist')
    const panel = byRole(m.container, 'region', 'Playlist')
    const rows = [...panel.querySelectorAll('li')]
    expect(text(rows[0] as HTMLElement)).toContain('Downloaded')
    expect(text(rows[1] as HTMLElement)).toContain('34 % downloaded')
    expect(queryByRole(panel, 'button', 'Next')).toBeNull()
    expect(queryByRole(panel, 'button', 'Add videos…')).toBeNull()
  })
})

describe('the end of a playlist item', () => {
  let m: Mounted | null = null
  afterEach(async () => {
    await m?.cleanup()
    m = null
  })

  it('counts down to the next video; the host can play it now or cancel', async () => {
    m = await mountApp('ended-host-playlist')
    const next = byRole(m.container, 'status', 'Next: Nature.Documentary.S01E03')
    expect(text(next)).toMatch(/in [45] s/)
    await click(byRole(m.container, 'button', 'Play now'))
    expect(callsOf(m.fake, 'playlist.play')).toEqual([{ id: 'aaaaaaaaaaa3' }])
  })

  it('Cancel stops the countdown, and the host keeps a way to go on', async () => {
    m = await mountApp('ended-host-playlist')
    await click(byRole(m.container, 'button', 'Cancel'))
    expect(callsOf(m.fake, 'playlist.cancelAdvance')).toHaveLength(1)
    expect(queryByRole(m.container, 'status', 'Next:')).toBeNull()
    expect(byRole(m.container, 'button', 'Play next: Nature.Documentary.S01E03')).toBeTruthy()
  })

  it('a viewer sees the countdown only', async () => {
    m = await mountApp('ended-viewer-playlist')
    expect(byRole(m.container, 'status', 'Next: Nature.Documentary.S01E03')).toBeTruthy()
    expect(queryByRole(m.container, 'button', 'Play now')).toBeNull()
    act(() => m?.fake.emit('playlist', { ...fx.playlist('viewer'), advance: null }))
    expect(queryByRole(m.container, 'status', 'Next:')).toBeNull()
  })
})
