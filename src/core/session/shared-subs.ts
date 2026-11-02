import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoticeEvent, SharedSubsEvent } from '../../shared/ipc/core.js'
import { CodedError } from '../../shared/result.js'
import { FileBlobProvider, blobHash } from '../net/blobs.js'
import type { BusMessage } from '../net/bus.js'
import type { CarrySub } from '../player/track-carry.js'
import type { SubtitleSpec } from '../player/player-controller.js'
import { subtitleFlags } from './playlist-files.js'
import {
  MAX_SHARED_PER_ITEM,
  MAX_SHARED_IN_ROOM,
  MAX_SHARED_SUB_BYTES,
  SUBTITLES_NAME,
  SUBTITLE_OFFER_NAME,
  SUBTITLE_REMOVE_NAME,
  SUBTITLE_RESULT_NAME,
  type SharedSub,
  type SharedSubsBody,
  SharedSubsSchema,
  type SubtitleOffer,
  SubtitleOfferSchema,
  SubtitleRemoveSchema,
  type SubtitleResult,
  SubtitleResultSchema,
  checkSharedSubsSize,
  looksLikeText,
  sharedSubName,
  subtitleExt,
} from './shared-subs-wire.js'

/** How long a viewer waits for the host to take (or refuse) its file: the host fetches it first. */
export const OFFER_TIMEOUT_MS = 30_000

/** The part of Room shared subtitles need. */
export interface SharedSubsRoom {
  readonly role: 'host' | 'viewer'
  readonly self: string
  readonly hostKey: string
  publish(name: string, body: unknown, opts?: { to?: string }): void
  onMessage(name: string, handler: (msg: BusMessage) => void): () => void
  latest(name: string): BusMessage | null
  members(): readonly { id: string; name: string }[]
}

export interface SharedSubsOptions {
  room: SharedSubsRoom
  /** fetches a blob from whichever member holds it, checked against its hash (Blobs.fetch) */
  fetch: (hash: string, size: number) => Promise<Uint8Array>
  /** where this session keeps the files (emptied at start and on leave) */
  dir: string
  /** the playing item's infoHash, or null before one plays */
  currentItem: () => string | null
  /** host: whether an item with this infoHash is in the playlist */
  knownItem?: (infoHash: string) => boolean
  /** host: what session.subtitles starts with */
  viewersMayShare?: boolean
  /** a shared file of the playing item is on disk: the player takes it now (`select`: the one this member shared) */
  addToPlayer: (spec: SubtitleSpec, select: boolean) => void
  /** the list or a file's state changed */
  onChange: (e: SharedSubsEvent) => void
  notice: (n: NoticeEvent) => void
  log: { info(m: string): void; warn(m: string): void; debug(m: string): void }
}

type FileState = 'fetching' | 'ready' | 'error'

interface Pending {
  resolve: () => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Subtitle files members share while the room plays (ADR 0013), on host and viewers alike. The host owns the list
 * (session.subtitles); a viewer offers a file, the host fetches and checks it, then lists it, so the file stays
 * available after its sharer leaves. Every member fetches the playing item's files, keeps them on disk (mpv reads a
 * path; the stream server only knows the torrent's files) and serves them to the others as blobs.
 */
export class SharedSubs {
  /** serves the files on disk to other members (Blobs' provider, next to the session's metadata) */
  readonly provider = new FileBlobProvider()
  private readonly room: SharedSubsRoom
  private readonly isHost: boolean
  private list: SharedSubsBody | null = null
  private rev = 0
  /** files on disk, by hash */
  private readonly paths = new Map<string, string>()
  private readonly states = new Map<string, FileState>()
  /** files this member shared and has yet to see listed: selected in its player once they are */
  private readonly selectOnReady = new Set<string>()
  /** viewer: offers and removals waiting for the host's answer, by hash */
  private readonly pending = new Map<string, Pending>()
  /** host: offers being fetched, by `${infoHash}|${hash}` */
  private readonly accepting = new Map<string, Promise<void>>()
  /** files of the playing item the player has (from its load, or added since), by `${infoHash}|${hash}` */
  private readonly given = new Set<string>()
  /** entries already announced to this member (no toast for what was there when it joined) */
  private readonly seen = new Set<string>()
  private firstList = true
  private lastItem: string | null = null
  private readonly unsubs: (() => void)[] = []
  private ready: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly o: SharedSubsOptions) {
    this.room = o.room
    this.isHost = o.room.role === 'host'
    if (this.isHost) this.list = { v: 1, rev: 0, viewersMayShare: o.viewersMayShare ?? true, items: [] }
  }

  start(): void {
    // whatever an earlier session of this room left behind (a crash skips the cleanup)
    this.ready = rm(this.o.dir, { recursive: true, force: true })
      .then(() => mkdir(this.o.dir, { recursive: true }))
      .then(() => undefined)
      .catch((e: unknown) => this.o.log.warn(`shared subtitles: cannot prepare ${this.o.dir}: ${String(e)}`))
    if (this.isHost) {
      this.unsubs.push(
        this.room.onMessage(SUBTITLE_OFFER_NAME, (m) => this.onOffer(m)),
        this.room.onMessage(SUBTITLE_REMOVE_NAME, (m) => this.onRemoveRequest(m)),
      )
      this.publish()
    } else {
      this.unsubs.push(
        this.room.onMessage(SUBTITLES_NAME, (m) => this.onList(m.body)),
        this.room.onMessage(SUBTITLE_RESULT_NAME, (m) => this.onResult(m)),
      )
      const latest = this.room.latest(SUBTITLES_NAME)
      if (latest) this.onList(latest.body)
    }
    this.emit()
  }

  async destroy(): Promise<void> {
    this.stopped = true
    for (const u of this.unsubs) u()
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new CodedError('cancelled', 'Left the room'))
    }
    this.pending.clear()
    await this.ready
    await rm(this.o.dir, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---- what the player gets -------------------------------------------------------------------

  /** The item's shared files on disk, in list order: added after the torrent's own subtitles at every load. */
  specsFor(infoHash: string | null): SubtitleSpec[] {
    return this.readyEntries(infoHash).map((e) => this.spec(e))
  }

  /** The same files as the track carry-over sees them. */
  carrySubs(infoHash: string | null): CarrySub[] {
    return this.readyEntries(infoHash).map((e) => {
      const f = subtitleFlags(e.name)
      return { lang: e.lang || f.lang, forced: f.forced }
    })
  }

  /** The player's title for a shared file. */
  titleOf(hash: string): string | null {
    const e = this.entries(this.o.currentItem()).find((x) => x.hash === hash)
    return e ? this.spec(e).title : null
  }

  /**
   * The playing item changed (or may have): fetch its files. Call it before the player loads the new item: what is on
   * disk by then comes with the load (specsFor), and only what arrives later is added to the player.
   */
  refresh(): void {
    const item = this.o.currentItem()
    if (item === this.lastItem) return
    this.lastItem = item
    this.given.clear()
    for (const e of this.readyEntries(item)) this.given.add(`${e.infoHash}|${e.hash}`)
    this.fetchMissing()
    this.emit()
  }

  // ---- requests -------------------------------------------------------------------------------

  /** subtitles.share: reads the file, keeps it, and lists it (host) or offers it to the host (viewer). */
  async share(path: string): Promise<{ hash: string }> {
    const infoHash = this.o.currentItem()
    if (!infoHash) throw new CodedError('not-ready', 'Nothing is playing yet')
    const name = sharedSubName(path)
    if (name === null) throw new CodedError('bad-type', 'Only .srt, .ass, .ssa and .vtt files can be shared')
    if (!this.isHost) {
      if (!this.list) throw new CodedError('not-supported', "The host's Cinemesh is too old to share subtitles")
      if (!this.list.viewersMayShare) throw new CodedError('sharing-off', 'The host turned off sharing subtitles')
    }
    const st = await stat(path).catch(() => null)
    if (!st?.isFile()) throw new CodedError('file-missing', `${name} cannot be read`)
    if (st.size > MAX_SHARED_SUB_BYTES) throw new CodedError('too-large', `${name} is larger than 4 MB`)
    const data = await readFile(path)
    if (!looksLikeText(data)) throw new CodedError('bad-type', `${name} is not a text subtitle file`)
    const hash = blobHash(data)
    if (this.entries(infoHash).some((e) => e.hash === hash))
      throw new CodedError('duplicate', `${name} is already shared`)
    await this.store(hash, name, data)
    this.selectOnReady.add(hash)
    const offer: SubtitleOffer = { hash, size: data.byteLength, name, infoHash }
    try {
      if (this.isHost) await this.accept(offer, this.room.self)
      else await this.ask(hash, () => this.room.publish(SUBTITLE_OFFER_NAME, offer, { to: this.room.hostKey }))
    } catch (e) {
      this.selectOnReady.delete(hash)
      throw e
    }
    return { hash }
  }

  /** subtitles.remove: its sharer or the host takes a file of the playing item off the list. */
  async remove(hash: string): Promise<void> {
    const infoHash = this.o.currentItem()
    const entry = this.entries(infoHash).find((e) => e.hash === hash)
    if (!infoHash || !entry) throw new CodedError('not-found', 'That subtitle is no longer shared')
    if (this.isHost) {
      this.drop(infoHash, hash)
      return
    }
    if (entry.by !== this.room.self) throw new CodedError('not-yours', 'Only its sharer or the host can remove it')
    await this.ask(hash, () => this.room.publish(SUBTITLE_REMOVE_NAME, { hash, infoHash }, { to: this.room.hostKey }))
  }

  /** subtitles.setViewersMayShare (host). Files already shared stay. */
  setViewersMayShare(on: boolean): void {
    if (!this.isHost || !this.list) throw new CodedError('not-host', 'Only the host can do this')
    this.list = { ...this.list, viewersMayShare: on }
    this.publish()
  }

  /** Host: items the playlist no longer has take their shared files with them. */
  pruneItems(known: (infoHash: string) => boolean): void {
    if (!this.isHost || !this.list) return
    const items = this.list.items.filter((e) => known(e.infoHash))
    if (items.length === this.list.items.length) return
    this.list = { ...this.list, items }
    this.publish()
  }

  // ---- host -----------------------------------------------------------------------------------

  private onOffer(m: BusMessage): void {
    if (m.from === this.room.self || m.to !== this.room.self) return
    const parsed = SubtitleOfferSchema.safeParse(m.body)
    if (!parsed.success) return
    const offer = parsed.data
    this.accept(offer, m.from).then(
      () => this.answer(m.from, { hash: offer.hash, ok: true }),
      (e: unknown) => {
        const code = e instanceof CodedError ? e.code : 'failed'
        const message = e instanceof Error ? e.message : String(e)
        this.o.log.info(`shared subtitles: refused ${offer.name} from ${m.from.slice(0, 8)}: ${message}`)
        this.answer(m.from, { hash: offer.hash, ok: false, code: code.slice(0, 32), message: message.slice(0, 300) })
      },
    )
  }

  private onRemoveRequest(m: BusMessage): void {
    if (m.from === this.room.self || m.to !== this.room.self) return
    const parsed = SubtitleRemoveSchema.safeParse(m.body)
    if (!parsed.success) return
    const { hash, infoHash } = parsed.data
    const entry = this.list?.items.find((e) => e.infoHash === infoHash && e.hash === hash)
    if (entry && entry.by !== m.from) {
      this.answer(m.from, { hash, ok: false, code: 'not-yours', message: 'Only its sharer or the host can remove it' })
      return
    }
    if (entry) this.drop(infoHash, hash)
    this.answer(m.from, { hash, ok: true })
  }

  private answer(to: string, r: SubtitleResult): void {
    try {
      this.room.publish(SUBTITLE_RESULT_NAME, r, { to })
    } catch (e) {
      this.o.log.warn(`shared subtitles: cannot answer ${to.slice(0, 8)}: ${String(e)}`)
    }
  }

  /** Lists a file (the host's own, or a viewer's offer once fetched and checked). Throws CodedError. */
  private accept(offer: SubtitleOffer, from: string): Promise<void> {
    const key = `${offer.infoHash}|${offer.hash}`
    const running = this.accepting.get(key)
    if (running) return running
    const run = this.doAccept(offer, from).finally(() => this.accepting.delete(key))
    this.accepting.set(key, run)
    return run
  }

  private async doAccept(offer: SubtitleOffer, from: string): Promise<void> {
    const check = (): boolean => {
      const list = this.list
      if (!list || this.stopped) throw new CodedError('cancelled', 'The room closed')
      if (from !== this.room.self && !list.viewersMayShare) {
        throw new CodedError('sharing-off', 'The host turned off sharing subtitles')
      }
      if (!(this.o.knownItem?.(offer.infoHash) ?? false)) {
        throw new CodedError('not-found', 'That video is no longer in the playlist')
      }
      const forItem = list.items.filter((e) => e.infoHash === offer.infoHash)
      if (forItem.some((e) => e.hash === offer.hash)) return true // already listed: nothing to do
      if (forItem.length >= MAX_SHARED_PER_ITEM) {
        throw new CodedError('item-full', `This video already has ${String(MAX_SHARED_PER_ITEM)} shared subtitles`)
      }
      if (list.items.length >= MAX_SHARED_IN_ROOM) {
        throw new CodedError('subtitles-full', 'The room has too many shared subtitle files. Remove one first.')
      }
      return false
    }
    if (check()) return
    if (!this.paths.has(offer.hash)) {
      const data = await this.o.fetch(offer.hash, offer.size).catch((e: unknown) => {
        throw new CodedError('unreachable', `The host could not fetch ${offer.name}: ${String(e)}`)
      })
      if (!looksLikeText(data)) throw new CodedError('bad-type', `${offer.name} is not a text subtitle file`)
      await this.store(offer.hash, offer.name, data)
    }
    if (check()) return
    const list = this.list
    if (!list) return
    const entry: SharedSub = {
      hash: offer.hash,
      size: offer.size,
      name: offer.name,
      lang: subtitleFlags(offer.name).lang.slice(0, 16),
      infoHash: offer.infoHash,
      by: from,
      byName: (this.room.members().find((m) => m.id === from)?.name ?? '').slice(0, 32),
    }
    const next = { ...list, items: [...list.items, entry] }
    checkSharedSubsSize(next)
    this.list = next
    this.publish()
  }

  private drop(infoHash: string, hash: string): void {
    const list = this.list
    if (!list) return
    this.list = { ...list, items: list.items.filter((e) => !(e.infoHash === infoHash && e.hash === hash)) }
    this.publish()
  }

  private publish(): void {
    const list = this.list
    if (!list || this.stopped) return
    this.rev = (this.rev + 1) % 0xffff_ffff
    this.list = { ...list, rev: this.rev }
    try {
      this.room.publish(SUBTITLES_NAME, this.list)
    } catch (e) {
      this.o.log.warn(`shared subtitles: cannot publish the list: ${String(e)}`)
    }
    this.onListed()
  }

  // ---- viewer ---------------------------------------------------------------------------------

  private onList(raw: unknown): void {
    if (this.stopped) return
    const parsed = SharedSubsSchema.safeParse(raw)
    if (!parsed.success) {
      this.o.log.debug(`shared subtitles: unreadable list: ${parsed.error.issues[0]?.message ?? '?'}`)
      return
    }
    this.list = parsed.data
    // an offer whose answer got lost is answered by the list itself
    for (const [hash, p] of this.pending) {
      if (this.list.items.some((e) => e.hash === hash && e.by === this.room.self)) {
        clearTimeout(p.timer)
        this.pending.delete(hash)
        p.resolve()
      }
    }
    this.onListed()
  }

  private onResult(m: BusMessage): void {
    if (m.to !== this.room.self) return
    const parsed = SubtitleResultSchema.safeParse(m.body)
    if (!parsed.success) return
    const r = parsed.data
    const p = this.pending.get(r.hash)
    if (!p) return
    clearTimeout(p.timer)
    this.pending.delete(r.hash)
    if (r.ok) p.resolve()
    else p.reject(new CodedError(r.code ?? 'refused', r.message ?? 'The host refused the file'))
  }

  /** Sends a request to the host and waits for its answer (or the list that shows it). */
  private ask(hash: string, send: () => void): Promise<void> {
    if (this.pending.has(hash)) throw new CodedError('busy', 'That file is already on its way to the host')
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(hash)
        reject(new CodedError('timeout', 'The host did not answer. Try again.'))
      }, OFFER_TIMEOUT_MS)
      timer.unref()
      this.pending.set(hash, { resolve, reject, timer })
      try {
        send()
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(hash)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  // ---- both -----------------------------------------------------------------------------------

  /** A new list: toasts for files others just shared, then fetch what the playing item lacks. */
  private onListed(): void {
    const item = this.o.currentItem()
    for (const e of this.list?.items ?? []) {
      const key = `${e.infoHash}|${e.hash}`
      if (this.seen.has(key)) continue
      this.seen.add(key)
      if (this.firstList || e.by === this.room.self || e.infoHash !== item) continue
      const who = e.byName || 'Someone'
      this.o.notice({
        level: 'info',
        code: `subtitles.shared:${e.hash.slice(0, 12)}`,
        message: `${who} shared the subtitle ${e.name}.`,
        action: { label: 'Use', request: 'subtitles.use', params: { hash: e.hash } },
      })
    }
    this.firstList = false
    this.fetchMissing()
    this.deliver()
    this.emit()
  }

  private fetchMissing(): void {
    const item = this.o.currentItem()
    for (const e of this.entries(item)) {
      // a failed fetch is tried again at the next list or item change
      const state = this.states.get(e.hash)
      if (state === 'fetching' || state === 'ready') continue
      this.states.set(e.hash, 'fetching')
      void this.o
        .fetch(e.hash, e.size)
        .then((data) => {
          if (!looksLikeText(data)) throw new Error('not a text subtitle file')
          return this.store(e.hash, e.name, data)
        })
        .then(() => {
          this.deliver()
          this.emit()
        })
        .catch((err: unknown) => {
          if (this.stopped) return
          this.states.set(e.hash, 'error')
          this.o.log.warn(`shared subtitles: cannot fetch ${e.name}: ${String(err)}`)
          this.emit()
        })
    }
  }

  /** Writes a file under its hash, and serves it from then on. */
  private async store(hash: string, name: string, data: Uint8Array): Promise<void> {
    if (this.paths.has(hash)) return
    await this.ready
    const path = join(this.o.dir, `${hash}.${subtitleExt(name) ?? 'srt'}`)
    await writeFile(path, data)
    if (this.stopped) return
    this.paths.set(hash, path)
    this.provider.add(hash, path)
    this.states.set(hash, 'ready')
  }

  /** The playing item's files on disk that the player does not have yet: added now (selected when this member shared it). */
  private deliver(): void {
    if (this.stopped) return
    for (const e of this.readyEntries(this.o.currentItem())) {
      const key = `${e.infoHash}|${e.hash}`
      if (this.given.has(key)) continue
      this.given.add(key)
      this.o.addToPlayer(this.spec(e), this.selectOnReady.delete(e.hash))
    }
  }

  private entries(infoHash: string | null): SharedSub[] {
    if (!infoHash) return []
    return (this.list?.items ?? []).filter((e) => e.infoHash === infoHash)
  }

  private readyEntries(infoHash: string | null): SharedSub[] {
    return this.entries(infoHash).filter((e) => this.paths.has(e.hash))
  }

  private spec(e: SharedSub): SubtitleSpec {
    return {
      url: this.paths.get(e.hash) ?? '',
      title: e.byName ? `${e.name} (${e.byName})` : e.name,
      lang: e.lang || null,
    }
  }

  private emit(): void {
    if (this.stopped) return
    const list = this.list
    const self = this.room.self
    this.o.onChange({
      available: list !== null,
      viewersMayShare: list?.viewersMayShare ?? false,
      items: this.entries(this.o.currentItem()).map((e) => ({
        hash: e.hash,
        name: e.name,
        lang: e.lang || null,
        byName: e.byName,
        mine: e.by === self,
        canRemove: this.isHost || e.by === self,
        state: this.states.get(e.hash) ?? 'fetching',
      })),
    })
  }
}
