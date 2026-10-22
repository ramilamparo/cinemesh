import { z } from 'zod'
import type { CoreLog } from '../log.js'
import type { Room } from '../net/room.js'
import type { TransferEngine } from '../transfer/engine.js'
import { MAX_URGENT } from '../transfer/revealer.js'

// Host-assigned striping (plan §4.2, ADR 0003) needs two things only viewers know: the members each one has an
// open bt lane to (a piece given to one viewer alone must be able to spread from it), and the pieces its HTTP
// readers are blocked on (a striping host shows a viewer only what it revealed to it, so a read outside the
// group plan would wait for the walk). Viewers report both to the host on the bus; the host feeds its transfer.

/** A viewer's report to the host: `{v: 1, linked, urgent}`, addressed to the host. */
export const TRANSFER_LINKS = 'transfer.links'
/** a viewer reports at least this often (a host that missed one, or restarted, has it again within a second) */
export const REPORT_MS = 1000
/** ...and at most this often: the blocked pieces change in bursts while a seek reads */
export const REPORT_MIN_GAP_MS = 200
export const MAX_LINKED = 32
/** what the host's transfer takes from one report (a viewer has a few HTTP readers, each blocked on one piece) */
export const MAX_REPORTED_URGENT = MAX_URGENT
/** per sender, on the host: a burst of this many, refilled per second; an honest viewer stays well inside */
const RATE_BURST = 10
const RATE_PER_S = 10

const MEMBER_ID = /^[0-9a-f]{64}$/

export const TransferLinksSchema = z.object({
  v: z.literal(1),
  linked: z.array(z.string().regex(MEMBER_ID)).max(MAX_LINKED),
  urgent: z.array(z.number().int().nonnegative()).max(MAX_REPORTED_URGENT),
})
export type TransferLinks = z.infer<typeof TransferLinksSchema>

/**
 * Viewer: reports its bt lanes and blocked pieces to the host every second, and as soon as the blocked pieces
 * change (at most every REPORT_MIN_GAP_MS; the last change in a burst always goes out). Returns the stop function.
 */
export function reportTransferLinks(opts: {
  room: Room
  hostId: string
  transfer: TransferEngine
  log: CoreLog
}): () => void {
  const { room, hostId, transfer, log } = opts
  room.defineMessage(TRANSFER_LINKS, {})
  let lastAt = Number.NEGATIVE_INFINITY
  let trailing: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let failed = false
  const send = (): void => {
    if (trailing) clearTimeout(trailing)
    trailing = null
    if (stopped) return
    lastAt = performance.now()
    const body: TransferLinks = {
      v: 1,
      linked: transfer
        .linkedPeers()
        .filter((id) => id !== room.self)
        .slice(0, MAX_LINKED),
      urgent: transfer.blockedPieces().slice(0, MAX_REPORTED_URGENT),
    }
    try {
      room.publish(TRANSFER_LINKS, body, { to: hostId })
      failed = false
    } catch (e) {
      // no route to the host right now: the next report tries again; say so once per outage
      if (!failed) log.debug(`striping: reporting links failed: ${e instanceof Error ? e.message : String(e)}`)
      failed = true
    }
  }
  const soon = (): void => {
    if (stopped || trailing) return
    const wait = lastAt + REPORT_MIN_GAP_MS - performance.now()
    if (wait <= 0) send()
    else trailing = setTimeout(send, wait)
  }
  const onBlocked = (): void => soon()
  transfer.on('blocked-changed', onBlocked)
  const timer = setInterval(send, REPORT_MS)
  timer.unref()
  send()
  return () => {
    stopped = true
    clearInterval(timer)
    if (trailing) clearTimeout(trailing)
    transfer.off('blocked-changed', onBlocked)
  }
}

/**
 * Host: takes viewers' reports into its transfer (setViewerLinks, setViewerUrgent), and forgets a viewer whose
 * link closed (removeViewer). Reports are validated: only from admitted members, rate-limited per sender, linked
 * kept to admitted members, urgent to pieces of the torrent. Returns the stop function.
 */
export function collectTransferLinks(opts: { room: Room; transfer: TransferEngine; log: CoreLog }): () => void {
  const { room, transfer, log } = opts
  room.defineMessage(TRANSFER_LINKS, {})
  const buckets = new Map<string, { tokens: number; at: number }>()
  let pieceCount = 0
  const allow = (from: string): boolean => {
    const now = performance.now()
    const b = buckets.get(from) ?? { tokens: RATE_BURST, at: now }
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_S)
    b.at = now
    buckets.set(from, b)
    if (b.tokens < 1) return false
    b.tokens -= 1
    return true
  }
  const off = room.onMessage(TRANSFER_LINKS, (m) => {
    if (m.via === null) return // our own (the host never reports)
    const members = new Set(room.members().map((x) => x.id))
    if (!members.has(m.from) || m.from === room.self) return
    if (!allow(m.from)) return
    const parsed = TransferLinksSchema.safeParse(m.body)
    if (!parsed.success) {
      log.debug(`striping: dropped a malformed ${TRANSFER_LINKS} from ${m.from.slice(0, 8)}`)
      return
    }
    // the torrent's piece count, known once seeding started (the host has every piece)
    pieceCount ||= transfer.pieceStates().length
    const linked = parsed.data.linked.filter((id) => id !== m.from && members.has(id))
    const urgent = parsed.data.urgent.filter((i) => i < pieceCount)
    transfer.setViewerLinks(m.from, [...new Set(linked)])
    transfer.setViewerUrgent(m.from, [...new Set(urgent)])
  })
  // its lanes went with its link: what it was given alone and did not fetch is assigned again
  const onGone = (id: string): void => {
    buckets.delete(id)
    transfer.removeViewer(id)
  }
  room.on('peer-gone', onGone)
  return () => {
    off()
    room.off('peer-gone', onGone)
  }
}
