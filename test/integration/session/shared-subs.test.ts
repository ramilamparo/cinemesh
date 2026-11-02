import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet, { type Testnet } from 'hyperdht/testnet.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HAVE_FFMPEG, HAVE_MPV, fixture } from '../media/fixtures.js'
import { type Member, member } from './harness.js'

// Shared subtitle files (ADR 0013) between real sessions over a test DHT: a viewer shares a file mid-session, the
// host fetches and lists it, every member gets it; the host can turn viewers' sharing off; with a real mpv the file
// is in the player's subtitle list and subtitles.use selects it.

const SRT = '1\n00:00:00,500 --> 00:00:04,000\nShared line\n'

describe.skipIf(!HAVE_FFMPEG)('session: shared subtitle files', () => {
  let testnet: Testnet
  let video = ''
  const root = mkdtempSync(join(tmpdir(), 'wt-shared-subs-'))
  beforeAll(async () => {
    testnet = await createTestnet(3)
    process.env.WT_BOOTSTRAP = testnet.bootstrap.map((n) => `${n.host}:${String(n.port)}`).join(',')
    video = await fixture('mkv-cues.mkv')
  }, 120_000)
  afterAll(async () => {
    await testnet.destroy()
    delete process.env.WT_BOOTSTRAP
    rmSync(root, { recursive: true, force: true })
  })

  async function join_(m: Member, invite: string): Promise<void> {
    await m.client.request('session.join', { invite })
    await m.client.until('session', (s) => s.phase === 'confirm-join', 60_000)
    await m.client.request('session.confirmJoin', { dir: join(m.dir, 'save') })
    await m.client.until('session', (s) => s.phase === 'in-room', 60_000)
  }

  function srt(m: Member, name: string, text = SRT): string {
    const p = join(m.dir, name)
    writeFileSync(p, text)
    return p
  }

  it('a viewer shares a file: the host lists it and the other viewer gets it; sharing off refuses the next', async () => {
    const host = member('Host', root)
    const sam = member('Sam', root)
    const kim = member('Kim', root)
    const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
    await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
    await join_(sam, invite)
    await join_(kim, invite)
    await sam.client.until('sharedSubs', (e) => e.available && e.viewersMayShare)

    const { hash } = await sam.client.request('subtitles.share', { path: srt(sam, 'Film.en.srt') })
    const listed = await host.client.until('sharedSubs', (e) =>
      e.items.some((i) => i.hash === hash && i.state === 'ready'),
    )
    expect(listed.items).toEqual([
      expect.objectContaining({ name: 'Film.en.srt', lang: 'en', byName: 'Sam', mine: false, canRemove: true }),
    ])
    const got = await kim.client.until('sharedSubs', (e) => e.items.some((i) => i.state === 'ready'))
    expect(got.items[0]).toMatchObject({ hash, byName: 'Sam', mine: false, canRemove: false })
    await kim.client.until('notice', (n) => n.code.startsWith('subtitles.shared:'))
    expect(sam.client.all('notice').some((n) => n.code.startsWith('subtitles.shared:'))).toBe(false)

    // another viewer cannot take it off; its sharer can
    expect(await kim.client.requestError('subtitles.remove', { hash })).toBe('not-yours')
    await sam.client.request('subtitles.remove', { hash })
    await kim.client.until('sharedSubs', (e) => e.items.length === 0)

    // the host turns viewers' sharing off: refused, while the host's own still goes out
    expect(await sam.client.requestError('subtitles.setViewersMayShare', { on: false })).toBe('not-host')
    await host.client.request('subtitles.setViewersMayShare', { on: false })
    await sam.client.until('sharedSubs', (e) => !e.viewersMayShare)
    expect(await sam.client.requestError('subtitles.share', { path: srt(sam, 'b.srt') })).toBe('sharing-off')
    await host.client.request('subtitles.share', { path: srt(host, 'host.srt', `${SRT}\n`) })
    await sam.client.until('sharedSubs', (e) => e.items.some((i) => i.name === 'host.srt' && i.state === 'ready'))

    await kim.client.request('session.leave', { data: 'delete' })
    await sam.client.request('session.leave', { data: 'delete' })
    await host.client.request('session.leave', { data: 'keep', end: true })
  }, 240_000)

  it.skipIf(!HAVE_MPV)(
    'with a real mpv: the file is in the subtitle list, and Use selects it',
    async () => {
      const host = member('Host', root, { realMpv: true })
      const sam = member('Sam', root, { realMpv: true })
      const { invite } = await host.client.request('session.host', { videoPath: video, subtitlePaths: [] })
      await host.client.until('session', (s) => s.phase === 'in-room', 60_000)
      await join_(sam, invite)
      await sam.client.until('sharedSubs', (e) => e.available)
      await host.client.until('tracks', (t) => t.audio.length > 0, 60_000)
      await sam.client.until('tracks', (t) => t.audio.length > 0, 60_000)

      const { hash } = await sam.client.request('subtitles.share', { path: srt(sam, 'Film.en.srt') })
      // the sharer's own copy is selected in its player
      const own = await sam.client.until('tracks', (t) =>
        t.sub.some((s) => s.external && s.title === 'Film.en.srt (Sam)'),
      )
      const ownId = own.sub.find((s) => s.title === 'Film.en.srt (Sam)')?.id
      await sam.client.until('tracks', (t) => t.sid === ownId)

      // the host's player lists it, unselected, until the host uses it
      const t = await host.client.until('tracks', (x) =>
        x.sub.some((s) => s.external && s.title === 'Film.en.srt (Sam)'),
      )
      const id = t.sub.find((s) => s.title === 'Film.en.srt (Sam)')?.id
      expect(host.client.last('tracks')?.sid).not.toBe(id)
      await host.client.request('subtitles.use', { hash })
      await host.client.until('tracks', (x) => x.sid === id)

      await sam.client.request('session.leave', { data: 'delete' })
      await host.client.request('session.leave', { data: 'keep', end: true })
    },
    240_000,
  )
})
