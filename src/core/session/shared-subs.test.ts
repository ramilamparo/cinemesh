import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoticeEvent, SharedSubsEvent } from '../../shared/ipc/core.js'
import { CodedError } from '../../shared/result.js'
import { blobHash } from '../net/blobs.js'
import type { BusMessage } from '../net/bus.js'
import { NET_POLICIES } from '../net/room.js'
import type { SubtitleSpec } from '../player/player-controller.js'
import { SharedSubs, type SharedSubsRoom } from './shared-subs.js'
import { SUBTITLES_NAME, SUBTITLE_OFFER_NAME } from './shared-subs-wire.js'

// Shared subtitle files (ADR 0013) between a host and two viewers over an in-memory bus: the host lists, viewers
// offer, everyone fetches the playing item's files from whoever holds them and hands them to its player.

const HOST = '1'.repeat(64)
const SAM = '2'.repeat(64)
const KIM = '3'.repeat(64)
const ITEM1 = 'a'.repeat(40)
const ITEM2 = 'b'.repeat(40)
const NAMES: Record<string, string> = { [HOST]: 'Host', [SAM]: 'Sam', [KIM]: 'Kim' }

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined }

interface Member {
  id: string
  shared: SharedSubs
  added: { spec: SubtitleSpec; select: boolean }[]
  notices: NoticeEvent[]
  last: () => SharedSubsEvent | undefined
}

class World {
  readonly handlers = new Map<string, Map<string, Set<(m: BusMessage) => void>>>()
  readonly stickies = new Map<string, BusMessage>()
  readonly members = new Map<string, Member>()
  /** the item each member plays */
  readonly playing = new Map<string, string | null>()
  items = new Set([ITEM1, ITEM2])
  /** members whose blobs nobody can reach (a via-peer member) */
  readonly unreachable = new Set<string>()

  room(id: string): SharedSubsRoom {
    return {
      role: id === HOST ? 'host' : 'viewer',
      self: id,
      hostKey: HOST,
      publish: (name, body, opts = {}) => {
        if (NET_POLICIES[name]?.hostOnly && id !== HOST) throw new CodedError('WTP_NOT_HOST', 'host only')
        const [ns = '', t = ''] = name.split(/\.(.*)/)
        const msg: BusMessage = {
          name,
          ns,
          t,
          from: id,
          to: opts.to ?? null,
          rev: NET_POLICIES[name]?.sticky ? Date.now() : null,
          body: structuredClone(body),
          via: null,
        }
        if (NET_POLICIES[name]?.sticky) this.stickies.set(name, msg)
        queueMicrotask(() => {
          for (const [member, byName] of this.handlers) {
            if (msg.to !== null && msg.to !== member) continue
            for (const h of byName.get(name) ?? []) h({ ...msg, via: member === id ? null : id })
          }
        })
      },
      onMessage: (name, handler) => {
        const byName = this.handlers.get(id) ?? new Map<string, Set<(m: BusMessage) => void>>()
        this.handlers.set(id, byName)
        const set = byName.get(name) ?? new Set()
        byName.set(name, set)
        set.add(handler)
        return () => set.delete(handler)
      },
      latest: (name) => this.stickies.get(name) ?? null,
      members: () => [...this.members.keys()].map((k) => ({ id: k, name: NAMES[k] ?? '' })),
    }
  }

  async join(id: string, dir: string): Promise<Member> {
    const added: Member['added'] = []
    const notices: NoticeEvent[] = []
    let last: SharedSubsEvent | undefined
    const shared = new SharedSubs({
      room: this.room(id),
      fetch: async (hash, size) => {
        for (const [other, m] of this.members) {
          if (other === id || this.unreachable.has(other)) continue
          const r = await m.shared.provider.read(hash, 0, size)
          if (r && r.total === size && blobHash(r.data) === hash) return Buffer.from(r.data)
        }
        throw new CodedError('WTP_BLOB_NOT_FOUND', 'no member has this file')
      },
      dir: join(dir, id.slice(0, 4)),
      currentItem: () => (this.playing.has(id) ? (this.playing.get(id) ?? null) : ITEM1),
      ...(id === HOST ? { knownItem: (h: string) => this.items.has(h), viewersMayShare: true } : {}),
      addToPlayer: (spec, select) => added.push({ spec, select }),
      onChange: (e) => (last = e),
      notice: (n) => notices.push(n),
      log: quiet,
    })
    const m: Member = { id, shared, added, notices, last: () => last }
    this.members.set(id, m)
    shared.start()
    shared.refresh()
    await settle()
    return m
  }

  async leave(m: Member): Promise<void> {
    this.members.delete(m.id)
    this.handlers.delete(m.id)
    await m.shared.destroy()
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello there\n'

describe('SharedSubs', () => {
  let dir = ''
  let world: World
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wt-shared-subs-'))
    world = new World()
  })
  afterEach(async () => {
    for (const m of [...world.members.values()]) await world.leave(m)
    await rm(dir, { recursive: true, force: true })
  })

  async function file(name: string, text: string | Buffer = SRT): Promise<string> {
    const p = join(dir, name)
    await writeFile(p, text)
    return p
  }

  it('the host shares: every viewer fetches it and adds it to its player; only the host selects it', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    const kim = await world.join(KIM, dir)
    const { hash } = await host.shared.share(await file('Film.en.srt'))

    await vi.waitFor(() => expect(sam.added).toHaveLength(1))
    await vi.waitFor(() => expect(kim.added).toHaveLength(1))
    expect(host.added).toEqual([{ spec: expect.objectContaining({ lang: 'en' }) as SubtitleSpec, select: true }])
    expect(sam.added[0]?.select).toBe(false)
    expect(sam.added[0]?.spec).toMatchObject({ title: 'Film.en.srt (Host)', lang: 'en' })
    expect(existsSync(sam.added[0]?.spec.url ?? '')).toBe(true)
    // others hear about it, with a Use action; the sharer does not
    expect(sam.notices).toEqual([
      expect.objectContaining({ action: { label: 'Use', request: 'subtitles.use', params: { hash } } }),
    ])
    expect(host.notices).toEqual([])
    expect(sam.last()?.items).toEqual([
      expect.objectContaining({
        hash,
        name: 'Film.en.srt',
        byName: 'Host',
        mine: false,
        canRemove: false,
        state: 'ready',
      }),
    ])
    expect(host.last()?.items[0]).toMatchObject({ mine: true, canRemove: true })
  })

  it('a viewer offers: the host fetches and lists it, the other viewer gets it, and the sharer selects its own', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    const kim = await world.join(KIM, dir)
    const { hash } = await sam.shared.share(await file('Film.pt-BR.forced.ass'))

    const listed = world.stickies.get(SUBTITLES_NAME)?.body as { items: { by: string; byName: string }[] }
    expect(listed.items).toEqual([expect.objectContaining({ by: SAM, byName: 'Sam' })])
    await vi.waitFor(() => expect(kim.added).toHaveLength(1))
    await vi.waitFor(() => expect(sam.added).toHaveLength(1))
    expect(sam.added[0]?.select).toBe(true)
    expect(host.added[0]?.select).toBe(false)
    expect(host.notices[0]?.message).toBe('Sam shared the subtitle Film.pt-BR.forced.ass.')
    expect(sam.shared.carrySubs(ITEM1)).toEqual([{ lang: 'pt-BR', forced: true }])

    // the host keeps serving it once its sharer left
    await world.leave(sam)
    const late = await world.join('4'.repeat(64), dir)
    await vi.waitFor(() => expect(late.added).toHaveLength(1))
    expect(late.last()?.items[0]?.hash).toBe(hash)
    // a joiner hears nothing about what was shared before it came
    expect(late.notices).toEqual([])
  })

  it('refuses what is not a text subtitle, too large, or already shared, before sending anything', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    const offers: BusMessage[] = []
    world.room(HOST).onMessage(SUBTITLE_OFFER_NAME, (m) => offers.push(m))
    await expect(sam.shared.share(await file('movie.mkv'))).rejects.toMatchObject({ code: 'bad-type' })
    await expect(sam.shared.share(await file('fake.srt', Buffer.from([0x1a, 0x45, 0, 1])))).rejects.toMatchObject({
      code: 'bad-type',
    })
    await expect(
      sam.shared.share(await file('huge.srt', Buffer.alloc(4 * 1024 * 1024 + 1, 0x41))),
    ).rejects.toMatchObject({ code: 'too-large' })
    await expect(sam.shared.share(join(dir, 'missing.srt'))).rejects.toMatchObject({ code: 'file-missing' })
    await settle()
    expect(offers).toEqual([])
    await host.shared.share(await file('a.srt'))
    await vi.waitFor(() => expect(sam.added).toHaveLength(1))
    await expect(sam.shared.share(await file('a-copy.srt'))).rejects.toMatchObject({ code: 'duplicate' })
  })

  it('with sharing off for viewers, a viewer cannot share and the host refuses an offer anyway', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    host.shared.setViewersMayShare(false)
    await vi.waitFor(() => expect(sam.last()?.viewersMayShare).toBe(false))
    await expect(sam.shared.share(await file('a.srt'))).rejects.toMatchObject({ code: 'sharing-off' })

    // an offer sent all the same (an older list) is answered with a refusal
    const results: BusMessage[] = []
    world.room(SAM).onMessage('session.subtitle-result', (m) => results.push(m))
    const data = Buffer.from(SRT)
    world
      .room(SAM)
      .publish(
        SUBTITLE_OFFER_NAME,
        { hash: blobHash(data), size: data.byteLength, name: 'a.srt', infoHash: ITEM1 },
        { to: HOST },
      )
    await vi.waitFor(() => expect(results).toHaveLength(1))
    expect(results[0]?.body).toMatchObject({ ok: false, code: 'sharing-off' })
    // the host itself still can
    await expect(host.shared.share(await file('b.srt'))).resolves.toMatchObject({})
  })

  it('a viewer whose file the host cannot reach is told so', async () => {
    await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    world.unreachable.add(SAM)
    await expect(sam.shared.share(await file('a.srt'))).rejects.toMatchObject({ code: 'unreachable' })
  })

  it('removes a file by its sharer or the host, not by another viewer', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    const kim = await world.join(KIM, dir)
    const { hash } = await sam.shared.share(await file('a.srt'))
    await vi.waitFor(() => expect(kim.last()?.items).toHaveLength(1))
    await expect(kim.shared.remove(hash)).rejects.toMatchObject({ code: 'not-yours' })
    await sam.shared.remove(hash)
    await vi.waitFor(() => expect(kim.last()?.items).toEqual([]))

    const other = await kim.shared.share(await file('b.srt'))
    await vi.waitFor(() => expect(host.last()?.items).toHaveLength(1))
    await host.shared.remove(other.hash)
    await vi.waitFor(() => expect(kim.last()?.items).toEqual([]))
    // a removed file is not added again at the next load
    expect(kim.shared.specsFor(ITEM1)).toEqual([])
  })

  it('files belong to their item: a switch fetches the next item’s, and what is on disk comes with the load', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    await host.shared.share(await file('ep1.srt'))
    await vi.waitFor(() => expect(sam.added).toHaveLength(1))

    // the host plays item 2 and shares a file for it; Sam still plays item 1 meanwhile
    world.playing.set(HOST, ITEM2)
    host.shared.refresh()
    await host.shared.share(await file('ep2.srt', `${SRT}2\n`))
    await settle()
    expect(sam.added).toHaveLength(1)
    expect(sam.last()?.items.map((i) => i.name)).toEqual(['ep1.srt'])

    // Sam switches: the file is fetched and added to the player then
    world.playing.set(SAM, ITEM2)
    sam.shared.refresh()
    await vi.waitFor(() => expect(sam.added).toHaveLength(2))
    expect(sam.added[1]?.spec.title).toBe('ep2.srt (Host)')

    // back to item 1: its file is on disk already, so it rides with the load (specsFor), not a second add
    world.playing.set(SAM, ITEM1)
    sam.shared.refresh()
    // (a later list must not add it either)
    host.shared.setViewersMayShare(true)
    await settle()
    expect(sam.added).toHaveLength(2)
    expect(sam.shared.specsFor(ITEM1).map((s) => s.title)).toEqual(['ep1.srt (Host)'])
  })

  it('the host drops the files of an item taken off the playlist', async () => {
    const host = await world.join(HOST, dir)
    const sam = await world.join(SAM, dir)
    await host.shared.share(await file('ep1.srt'))
    await vi.waitFor(() => expect(sam.last()?.items).toHaveLength(1))
    world.items.delete(ITEM1)
    host.shared.pruneItems((h) => world.items.has(h))
    await vi.waitFor(() => expect(sam.last()?.items).toEqual([]))
    // and an offer for it is refused
    await expect(host.shared.share(await file('ep1b.srt', `${SRT}x\n`))).rejects.toMatchObject({ code: 'not-found' })
  })

  it('a viewer of an older host (no list) is told sharing is not supported', async () => {
    const sam = await world.join(SAM, dir)
    expect(sam.last()).toMatchObject({ available: false })
    await expect(sam.shared.share(await file('a.srt'))).rejects.toMatchObject({ code: 'not-supported' })
  })

  it('leaving removes the files from disk', async () => {
    const host = await world.join(HOST, dir)
    await host.shared.share(await file('a.srt'))
    const path = host.shared.specsFor(ITEM1)[0]?.url ?? ''
    expect(existsSync(path)).toBe(true)
    await world.leave(host)
    expect(existsSync(path)).toBe(false)
  })
})
