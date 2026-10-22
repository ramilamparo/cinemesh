# ADR 0010: Viewer download limit by request gating

- Date: 2026-10-22
- Status: **accepted; in.** `TransferEngine.joinAsViewer({downloadLimitKBps})` and `setDownloadLimit()` limit what
  a viewer downloads. The setting `downloadLimitKBps` reaches them at the join and live (Settings › Network, the
  viewer's **Your connection** card in the Room), and `sync.status.downLimitBps` lets the host name it in a
  slow-download warning (§5, ADR 0009 rows).
- Plan: §4.2 (viewer download, RAM, S2 fallback `downloadLimit`), §4.6 (settings); ADR 0002 Finding 3, ADR 0006
  Finding 1.
- Code: `src/core/transfer/download-gate.ts`, `patches/webtorrent+3.0.21.patch`, `src/core/transfer/engine.ts`;
  wiring in `src/shared/limits.ts`, `src/core/session/viewer-session.ts`, `src/core/sync/member.ts` (status) and
  `src/renderer/src/screens/Room/ConnectionPanel.tsx`.
- Environment: WebTorrent 3.0.21 (line numbers below are upstream's), Node 26, Linux 6.18; tests over in-memory
  Protomux links in the isolated namespace.

## 1. Context

A viewer may need to cap what it downloads, on a shared or metered connection. The plan's only download limit was
S2's fallback, WebTorrent's `downloadLimit`, which ADR 0002 rejected. One `uploadLimitKBps` already covers both roles
(the host's upload scheduler, viewers' `throttleUpload`); a host downloads nothing, so the new limit is for viewers
only.

## 2. Decision

**Limit the block requests a viewer sends, not the bytes it reads.** A sender that gets no request sends nothing,
so the limit holds without anything queueing on the way.

- **`DownloadGate`** (`download-gate.ts`): a token bucket over requested bytes, one per viewer torrent, shared by all
  its wires. Rate = KiB/s × 1024 (the upload limit's unit). Depth max(64 KiB, 0.25 s of the rate). Refill is lazy;
  a request may go while the bucket is above empty, and its block is charged in full (so a block can take the bucket
  below empty, and the next waits for it).
- **Critical pieces borrow.** A piece the Scheduler flags critical (a blocked reader, the hot window after a seek,
  open-/seek-critical ranges, subtitles, urgent audio: `t._critical`) may go until the bucket is max(64 KiB, 1 s of
  the rate) below empty. A read mpv waits on arrives at link speed while the average stays at the limit; once the
  debt is used up, critical pieces wait for the rate too.
- **Refunds.** A request that fails (BEP 6 reject, choke, closed wire, timeout) gives its bytes back: those bytes
  never came. The host's preempt rejects a viewer's held filler requests when it reports a blocked piece (ADR 0006),
  and the refund lets the blocked piece's requests go at once.
- **Kick.** Once every request is answered nothing in WebTorrent runs `_updateWire` again, so a refusal sets one
  timer (10-1000 ms) for when the refused request could go, which calls `torrent._update()`. A limit set, raised or
  cleared kicks at once; a new limit starts full. A lowered limit keeps at most its own depth and owes at most its
  own debt: debt borrowed at the old rate would otherwise be paid back at the new one, and every request, a read mpv
  waits on included, would wait for it (5 MiB borrowed at 5000 KiB/s, then 500 KiB/s: about 9 s).
- **Hooks** in `patches/webtorrent+3.0.21.patch` (`torrent._requestGate`, null by default, set by the engine right
  after `client.add`, before any wire):
  - `_request` (torrent.js:1923) asks `allows(critical)` after the pipeline check and before it reserves a block,
    and `take`s the block's length when the request goes out.
  - Its `onChunk` refunds a failed block right after the reservation is released and **before** the
    `piece !== self.pieces[index]` check (torrent.js:1965). A block of a piece replaced meanwhile (verified through
    another wire after a hotswap, or reset by a failed hash check) is refunded too, and each request is refunded at
    most once: `onChunk` runs once per request.
  - The request walks in `_updateWire` stop at the first piece the gate refuses: `validateWire` (1660) returns,
    `trySelectWire`'s sequential loop (1732) returns true, so `trySelectWire(true)` does not walk again. The
    Scheduler puts every critical range first (`orderRanges`), so a critical piece later in the walk was already
    visited; without the exit a closed gate would walk every piece for every wire on every update (S3: 15k pieces ×
    32 wires).
  - The check comes after `!wire.peerPieces.get(piece)`. A critical piece a wire lacks (striping: the host shows a
    viewer only what it revealed) is skipped there, and that wire stops at the next piece; a wire that has the piece
    still borrows for it.
- **Engine.** `joinAsViewer` takes an optional `downloadLimitKBps`, and `setDownloadLimit(kbps)` keeps the latest
  value for a torrent that does not exist yet, as `setUploadLimit` does. On a host it has no effect: the host torrent
  has no gate. The gate is destroyed with the engine and when the torrent closes on its own.

## 3. Rejected: WebTorrent's `throttleDownload` / `downloadLimit`

- It throttles the read side (peer.js:135-155), in front of the wire parser. MuxWireStream pushes every Protomux
  message whatever `push()` returns, and Protomux has no per-channel flow control, so the backlog lands in viewer RAM
  (ADR 0002 Finding 3: viewer RSS growth 218 MB vs 154 at 50 MB/s).
- The host's UDX acks come at once, so its upload scheduler and pacer (ADR 0006) keep sending into that backlog.
- A `have`, a reveal, a BEP 6 reject and an urgent block wait behind up to a second of throttled bulk data: the read
  side's version of ADR 0006 Finding 1. Striping's 3 s activity windows and the blocked-read path both suffer.
- Its token bucket is unfair between wires (ADR 0006 Finding 1: the busiest of 3 wires took 0.52 of the rate).

## 4. Evidence

Unit (`download-gate.test.ts`, fake clock): depth, borrowing to exactly 1 s of the rate, refunds, one capped kick
timer (a refused critical piece is kicked when it may borrow again), `setRate` transitions, 60 s of greedy requests
within rate × 60 + depth + debt and above 0.97 of it, `destroy()`. `engine.test.ts` drives the patched `_request` and
`_updateWire` of a real viewer torrent with a fake wire and a recording gate: the check precedes the reservation and
carries the critical flag, a reject and a failure on a replaced piece are each refunded once, an answered block
never, and both walks stop at the first refusal.

Integration (`test/integration/transfer/engine.test.ts`, `revealer.test.ts`; unlimited host over an in-memory link,
256 KiB pieces):

| Case                                               | Measured                                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 256 KiB/s for 8 s                                  | 2064 KiB received (bound: rate × s + depth + debt), 8 pieces; host sent − viewer read: 0 KiB  |
| Limit cleared                                      | the other 17 pieces within 3 s, on the same wire (no request timed out)                       |
| 128 KiB/s, reader blocked on a piece far in L2     | verified in 875 ms (2001 ms with borrowing off); 1280 KiB in the 10 s from the block          |
| 512 KiB/s, playhead at piece 12, then a seek to 3  | 12-17 first, in order; then 3, with no piece between                                          |
| 256 KiB/s, the host's piece 5 rewritten            | 3 failed hash checks in 3.9 s, 1 MiB received: each refetch charged; idle 1 s, the gate opens |
| Striping, a at 128 KiB/s blocks on a piece b holds | from b in 740-874 ms, never revealed to a by the host; 4506 ms with borrowing off             |

Wiring: `test/integration/session/download-limit.test.ts` (three viewers of an 800 KB/s host, one at 128 KiB/s)
checks the gate's rate from Settings, the received bytes over 8 s within the bound above, the limit in that viewer's
status at the host and gone once lifted live, and every viewer complete with the host's dupFactor ≤ 1.5.
`viewer-join.test.ts` sets the limit while the start is held and again in the room; the sync simulation
(`test/sync/control.test.ts`) checks the host's warning text with and without a limit.

Mutation checks: each hook removed, the refund moved behind the piece check (the design's first draft) or made
twice, borrowing or the kick timer turned off, and `take` dropped, each failed at least one of these tests.

## 5. Consequences

- The limit is an average. Bursts above it happen only while playback waits on a piece, at most 1 s of the rate,
  plus the 0.25 s depth after a quiet spell.
- Readiness, the start modes and the play-through ETA need no change: they use the viewer's measured rate, which
  the limit lowers. A limit below the bitrate makes that viewer buffer; with wait-for-all the room waits for it.
- The host sees a viewer that asks for less. The Revealer's budget follows the lower measured rate, and its rescue
  reassigns pieces the limited viewer is slow to fetch.
- Hash-failed pieces are charged again: those bytes did cross the link.
- The webtorrent patch grows by four hooks, to carry forward on any upgrade. The unit hook tests fail if one goes
  missing.
- **Wiring.** `downloadLimitKBps` is a setting next to `uploadLimitKBps` (KiB/s, null = none; no settings version
  change: an older file lacks it and gets the default, an older app drops it). One setting means Settings and the
  Room show one value: the Room's field writes it like Settings does, and core applies it through
  `updateSettings`. The session passes it to `joinAsViewer` and applies it again after the start; a host ignores
  it. The viewer's member puts it in `sync.status.downLimitBps` (optional, sent only when set), and the host's
  slow-download line names it while it is below 1.1 × the need: "Download too slow (3.9 of 9.5 Mbit/s, limit 4.0
  Mbit/s); may buffer in ~35 s". The limit does not change when the member warns: such a room really will buffer.
- The unit is KiB/s, as for the upload limit, while the transfer line shows decimal KB/s: a 500 limit reads about
  512 KB/s. The line says "(limited)" rather than the number.
- Viewers keep `throttleUpload` for their upload limit (one second deep, unfair between wires). Moving them onto the
  upload scheduler is a follow-up.
