# src/core/transfer: WebTorrent over Hyperswarm

Plan §4.2. One WebTorrent 3.0.21 client per session. It runs only over `MuxWireStream`s (Protomux channel
`wtp/bt/1`, `id = infoHash`) on room connections. All its own discovery, and its TCP listener, are off
(`client-options.ts` together with `patches/webtorrent+3.0.21.patch`, which also makes a fresh wire's first request
the head of the plan: `validateWire()` walks the selections forwards, ADR 0003 Finding 1; it also holds the hooks of
the viewer's download limit, below).

**What a member can send.** Any room member can open the lane and send any bytes. Two patches harden the wire
parser; each item below was an uncaught exception in the core (its handler reports it to main as fatal) or a stalled
or exhausted core, sent at will:

- `patches/bittorrent-protocol+5.0.9.patch`:
  - It caps a message at 1 MiB, and assembles a message once instead of on every write (a huge length prefix, or a
    message trickled in tiny writes).
  - It keeps a BEP 10 extension id only when it is an integer 0-255. Upstream threw on a dict with its own `toString`
    key.
  - `wire.extended(name)` drops a message for an extension the peer did not announce. Upstream threw when ut_metadata
    answered a request from a peer whose handshake left ut_metadata out.
  - An extension handler that throws on a peer's handshake or message drops that wire. Upstream threw out of the
    parser: ut_metadata reads `msg_type` from the `null` that bencode returns for an empty message.
- `patches/bencode+4.0.1.patch` (the copy that decodes BEP 10 handshakes and ut_metadata messages; parse-torrent
  uses it for the host's torrent too). It throws on a string length that is negative, not a whole number, or past the
  end of the data, and on nesting deeper than 64 levels. A negative length moved the decoder backwards, so a dict or
  list never ended and the core's event loop stopped, which no try/catch can catch. Now every step moves forward,
  so a decode ends in time linear in its size. A handshake that does not decode is ignored, as upstream does, and
  ut_metadata drops a message that does not decode.
- The BitTorrent DHT's own bencode (2.0.3, under k-rpc-socket) has the same flaw and is not patched. Only a DHT
  decodes with it, and the client never creates one (`dht: false`; a test checks it).

Two more patches serve the host's upload scheduler (below), not hardening:

- `patches/bittorrent-protocol+5.0.9.patch` also adds a hold mode. With `wire.holdRequests` set, a request (past the
  choke check) waits in `wire.heldRequests`, announced by `'request-held'`, until `releaseRequest()` answers it as
  upstream would (`'request'` with a respond callback, plus an `onAnswered` callback) or `refuseRequest()` turns it
  down (BEP 6 reject; no answer without the fast extension). A cancel drops a held request, a choke rejects held
  ones (except allowed-fast), a close clears them; they leave the list in arrival order. `wire.pushedBytes` counts
  every byte pushed towards the connection.
- `patches/udx-native+1.21.3.patch` (JS only, `lib/stream.js`): `bytesWritten` (what `_writev` was handed) and
  `bytesAcked` (write requests acknowledged in full, counted in `_onack` before their buffers are dropped). UDX
  exposes `inflight` but not its send queue: unsent = `bytesWritten − bytesAcked − inflight`.

| File                                 | What                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `engine.ts`                          | **`TransferEngine` facade**: host seeding, viewer download, attach/detach, stats, journal, disk checks, leave           |
| `mux-wire-stream.ts`                 | WebTorrent peer over a Protomux channel. Strict backpressure, ≤ 64 KiB messages; destroy releases a held write          |
| `client-options.ts`                  | `WEBTORRENT_OPTIONS`; `torrentPort: 1` is a placeholder that torrent-discovery requires. No `downloadLimit` (S2)        |
| `download-gate.ts`                   | Viewer: the download limit, a token bucket over the block requests it sends (ADR 0010)                                  |
| `torrent-builder.ts`                 | `pieceLengthFor`, multi-file layout `[video, ...subs]`, private info dict, infoHash                                     |
| `host-prepare.ts` + `hash-worker.ts` | SHA-1 in worker threads. Whole-video hashes are cached per file, with a 3-piece spot check                              |
| `source-files.ts`                    | The host's files, opened read-only once. Shared by the store and the source watchdog                                    |
| `readonly-store.ts`                  | Host chunk store: reads the original files and refuses writes                                                           |
| `segment-store.ts`                   | Viewer chunk store: 64 MiB segment files. ENOSPC parks the write instead of failing it; > 64 MiB in flight is write lag |
| `journal.ts`                         | Bitfield (+ `recent` pieces) in `state.json`, saved only after the segments are fdatasync'd; saves serialized           |
| `resume.ts`                          | Resume check before WebTorrent sees the bitfield; `trustedBytes` (JoinConfirm, read-only)                               |
| `scheduler.ts`                       | R6 order (`orderRanges`): one batched rebuild of priority-0 stream selections; byte ranges merged into piece spans      |
| `revealer.ts`                        | Host-assigned striping: each viewer is advertised only what the host revealed to it (ADR 0003)                          |
| `upload-scheduler.ts`                | Host: requests held and released just in time, urgent first, at the limit or paced rate (ADR 0006)                      |
| `upload-pacer.ts`                    | Host: delay-based pacer on the viewers' UDX srtt, 20 ms of queue: the scheduler's rate (ADR 0006)                       |
| `piece-source.ts`                    | The stream server's `StreamSource`. A reader blocked on a missing piece puts that piece first                           |
| `piece-state.ts`                     | R8 states per piece: 0 missing, 1 partial or requested, 2 verified                                                      |
| `save-file.ts`                       | Exports segments to real files, all checked first; a consuming save journals itself in `export.json` to survive a cut   |
| `safe-name.ts`                       | Host-chosen file names: one safe component, no leading dot, and an allowlisted video/subtitle extension                 |
| `disk.ts`                            | `freeBytes`, `checkSpace`, and the 512 MiB reserve                                                                      |

## API

```ts
const t = new TransferEngine()
await t.startHost(prepared /* prepareHost() */, { uploadLimitKBps })
await t.joinAsViewer({ torrent, manifest, dir, uploadLimitKBps, downloadLimitKBps }) // → { resumedPieces }
// dir: '<save>/.wt-partial/<infoHash>'; downloadLimitKBps is optional (absent = none)
// writes meta.torrent and (when given) manifest.bin (MANIFEST_FILE) there: a resume reads the manifest back
t.attach(roomPeer)
t.detach(peerId) // on room 'peer' / 'peer-gone'
t.setPlayhead(plan) // media Playhead → scheduler (viewer)
t.setCriticalRanges(ranges) // open-/seek-critical + subtitle files, torrent bytes (viewer)
t.streamSource // PieceSource for StreamServer.listen (viewer)
t.pieceStates()
t.setUploadLimit(kbps) // also before the client exists: a start picks up the latest value. Host: the upload
// scheduler's limit (with the paced rate, whichever is lower); viewer: WebTorrent's upload throttle
t.setDownloadLimit(kbps) // viewer, also before the torrent exists: gates the requests it sends; no effect on a host
await t.leave({ data: 'keep' | 'save' | 'delete', saveDir }) // idempotent; 'delete' works before the torrent is ready

// host-assigned striping: the sessions wire these (session/striping.ts, bus message 'transfer.links')
host.setGroupCriticalRanges(ranges) // open-critical + subtitle files: revealed to every viewer at once
host.setGroupPlayhead(plan) // the room's playhead: the same PlayheadPlan viewers pass to setPlayhead
viewer.linkedPeers() // members it has an open, handshaken bt wire to: reported at 1 Hz, and with the reports below
viewer.blockedPieces() // pieces an HTTP reader is blocked on, ascending: reported with the links
viewer.hashFailures() // { total, worst: [piece, failures][] ≤ 8 }: downloaded pieces that failed their hash check
viewer.on('blocked-changed', (pieces) => report()) // report at once, not at the next 1 Hz
host.setViewerLinks(memberId, linked) // a lane counts once both ends report it
host.setViewerUrgent(memberId, urgent) // revealed to that viewer at once unless on its way, outside its R; [] clears
host.removeViewer(memberId) // a viewer left the room (with detach): forgets its links and urgent pieces

await trustedBytes(dir, { infoHash, pieceLength, pieceCount, length }) // JoinConfirm: bytes a resume can skip

// a 'save' (saveFile with consume) that a quit, a crash or a missing drive cut off: its journal is <dir>/export.json
await pendingExport(dir) // { name, dest } | null: the saved name, and the folder it saves into
await resumeExport(dir, { signal }) // 'finished' | 'rejoin' (lost pieces leave state.json) | null; 'dest-unavailable' throws
await dropExport(dir) // Cancel saving: 'rejoin' (what it consumed counts as missing again); 'finished' if saved in full
await exportPending(dir) // a journal there, or one that cannot be checked: no download may use that folder
```

`startHost` and `joinAsViewer` reject with code `'cancelled'` when `leave()`/`destroy()` ran during the start, and
with the error itself when the torrent fails before `ready` (such an error is not also emitted). `leave({ data: 'save' })`
rejects with code `'incomplete'` (`IncompleteDownloadError`) when a segment went missing after the join: nothing is
consumed, and the journal stops claiming those pieces, so a later session downloads them again.

**Events:**

- `pieces-changed` (≤ 4 Hz while changing, otherwise every 5 s)
- `blocked-changed` (viewer: `blockedPieces()` changed; one per burst, only on a real change)
- `verified`
- `stats` (1 Hz: speeds, progress, `missingAheadBytes`, `etaToEofS`, `dupFactor` and
  `uplink {rateBps, queueMs, state}` on the host (the upload scheduler's rate, the pacer's queueing-delay estimate
  and state), per-peer rows with `reattaches`: lanes to that member that opened after the first one, so a re-attach
  ratchet shows; on a viewer `hashFails {total, worst}`, as `hashFailures()` returns it)
- `disk-low`
- `done` (also after a complete resume: once, on the next macrotask after `joinAsViewer` resolves)
- `source-changed` (host; once per kind. `'changed'` stops seeding for good: the torrent is destroyed and `attach()`
  refuses peers. A moved file never hides a changed one)
- `error` (after `ready` only, and only when someone listens: an unhandled emit would throw inside WebTorrent). Once the
  torrent is gone (a store error), every lane is dropped and `attach()` refuses peers.

## Host-assigned striping (`revealer.ts`)

The host overrides `haveAll`/`haveNone`/`bitfield` on each viewer's wire in the torrent's `'wire'` event, which fires
before WebTorrent's advertisement. Every 250 ms it walks the group plan in the viewers' own order (`orderRanges`):

- **Nothing to stripe** (no `setGroupPlayhead` yet, or a single viewer): everyone is shown everything, as plain
  seeding. So call `setGroupPlayhead` before viewers attach. When striping starts, each viewer is told (lt_donthave,
  BEP 54) the host no longer has what it neither holds nor is fetching; otherwise the first viewer would be the only
  way to every later one, through its own uplink. Telling needs lt_donthave with a non-zero id in the viewer's latest
  BEP 10 handshake (`peerExtendedMapping`), which arrives up to an RTT after its wire: until then the viewer stays open
  and every tick asks again. A donthave that throws ends that viewer's take-back; the rest stays revealed to it. An
  open viewer is assigned nothing: what it was shown does not count against its budget, so the take-back leaves its R
  free (a piece counted there and then taken back would starve it of the walk until the next group seek).
  - **The donthaves go from the plan's end** (the walk's order, backwards). Each one fails the viewer's requests for
    that piece, and its WebTorrent refills the pipeline at once with the next piece the host still seems to have; the
    donthaves arrive in several reads. In plan order that refill was the next retracted piece, whose donthave was
    right behind, so each retracted piece drew a whole pipeline of requests (ADR 0008 §4.1: up to 4244 requests and
    65 MiB served for nothing, a 67 MiB queue, and the viewer's host wire dropped by its 30 s request timeout).
    Backwards, the pieces it is fetching go last and nothing retracted is left to refill with.
- **The host answers only what it advertises to that wire.** A request for any other piece is refused when it
  arrives, before it is held (the upload scheduler asks `revealer.onArrival`): a BEP 6 reject when both ends set
  the fast bit, which WebTorrent always does, so the viewer's request fails at once instead of after 30 s; without
  it, no answer (a seeder cannot refuse otherwise). It never reaches the upload queue, `'request'` listeners or
  `dupFactor`. Requests that cross a take-back's donthaves get these rejects (the donthave, read first, has already
  failed them), and whatever a viewer sends, the host queues no data it did not offer. An admitted request is
  activity on its piece (the rescue rule's clock) from its arrival: `'request'` fires only when it is released.
- **Urgent pieces** (`setViewerUrgent`, a viewer's `blockedPieces()`): revealed to that viewer at once, outside its
  budget, never taken back while reported, and in the first bitfield of a lane that re-attaches. Each report replaces
  the last (`[]` clears it, so does `removeViewer`); at most 16 are taken. A piece on its way is not revealed: held
  by a viewer it has a lane to, or shown to one that saw a reveal or request for it within 3 s (re-checked every
  tick). After a group seek every reader waits on the same pieces, and each would otherwise get them from the host
  (ADR 0003 Finding 9's "everyone" rule, through the back door). That wait lasts at most 3 s plus two pieces at one
  lane's share of the host upload (`2 × P × viewers / host upload`) from the viewer's first report of the piece: ~9 s
  for 1 MiB pieces at 1 MB/s and 3 viewers. The first viewer's own fetch of a group seek's first piece took 0.55-2.55
  such pieces (median 1.3), behind what it had already asked for; a flat 3 s sent that piece to the other readers too
  (ADR 0003, Round 5). After the wait the host sends it anyway: a holder with a slow or limited uplink, or one that
  does not serve it (or claims pieces it lacks), would keep the reader blocked.
- A piece somebody holds spreads through the viewers' `have`s. Only a lacking viewer with no lane to any holder gets it
  from the host.
- An unheld piece goes to one eligible viewer: lowest `(exclusive + 1) / rate`, below its budget
  `R = max(2, ⌈1.5 s × host upload × rate share / P⌉)`. Host upload: the limit or the upload pacer's rate, whichever
  is lower, else an EWMA of the measured peak; the paced rate and the peak count as at least 1 MB/s. The walk stops at the first piece where every eligible viewer is at R.
- Eligible (`full`): linked to every other viewer that has a lane at all. A lane counts once both ends report it.
  A viewer without reports (late, or truly isolated) does not block the others; it gets what it lacks from the host,
  within its own R, once the link wait below is over. With nobody eligible, every viewer is fed from the host at its
  own pace.
- **Link wait**: for 2 s after its wire attached, a viewer that has reported no lane is not taken for isolated: the
  walk gives it nothing (critical and urgent pieces still reach it). Viewers report their lanes at 1 Hz, so the host
  learns them up to a second after they open, and viewers that joined together were meanwhile each given the same R
  pieces from the host, whose requests it served whatever the next report said (0.7-4 MiB of a 15 MiB file in the
  session striping test, ADR 0003, Round 5). A reported lane ends the wait; a viewer still without one after 2 s is
  isolated, and fed from the host as above.
- Rescue: a revealed piece due within 8 s that saw no reveal or request for 3 s goes to the fastest other lacking viewer.
- A group seek (`plan.seek`) clears every exclusive set, and takes back (as above, from the plan's end) what each
  viewer was shown and neither holds nor is fetching, outside the new window `[p, p + w]` and the new plan's urgent
  audio ranges (a poorly interleaved file's, which the walk takes first and which may lie outside L1), and apart
  from critical and urgent pieces. Until the new window's `have`s reach it, a viewer's host wire offers only those old reveals, so it
  fetched them first and the window's data queued behind them (ADR 0008 §4.3: 1.1-1.9 MB per seek in the alpha).
  A departed viewer's unfetched pieces are assigned again.
- `dupFactor` in the stats is the engine's per-16 KiB-block count of what the host served.

Measured (`test/integration/transfer/striping.test.ts`, host 2.5 MB/s, 4 viewers at a 1 MB/s playhead): dupFactor
≈ 1.05 with no stalls (1.03 with the upload scheduler), against ≈ 3.2 and stalls within 8 s when seeding plainly.
Through whole sessions (`test/integration/session/striping.test.ts`: host 800 KB/s, three viewers that join at once, a
16-piece MKV):
1.05-1.24, idle or under CPU load, nearly all of it the critical pieces every viewer fetches at once; 1.09-1.55 before
the link wait (1.29-1.46 on an idle machine).

A blocked reader outside the group plan (`test/integration/transfer/revealer.test.ts`, host 1 MB/s): the host sends the
`have` ~1 ms after the report, rejects the viewer's held filler requests (preempt) and releases the piece's blocks
first. With 3 viewers busy downloading, a piece far past the frontier is verified 0.24-0.26 s after the reader blocked
(its 256 KiB at the full rate; median under 0.6 s asserted), where the walk would have reached it in over a minute.
Before the upload scheduler it took 1.0-2.6 s with 2 viewers (1.4-2.3 s in that test with the scheduler off): the `have`
waited 0.3-1 s behind the blocks already queued in the host's upload throttle (ADR 0003 Finding 8), the request for a
free pipeline slot (Finding 4), and the data behind the blocks queued meanwhile; without urgent-first it takes 0.72-0.77
s. Three viewers whose readers all wait on the 9 pieces after a group seek asked the host for each piece once (1.00) at
256 KiB pieces; without the on-its-way check the first one left the host 2.6-3 times. At the app's 1 MiB pieces the
first one left the host once in 23 of 24 runs at 500-700 KB/s (once 1.2), and all 9 took 1.00-1.38 (1.55 under CPU
load); with round 4's flat 3 s it left 2.0-2.6 times in 6 of 6 runs at 500 KB/s, and in 13 of 21 at 700 KB/s, where the
first viewer is quicker. What doubles the others is the 3 s idle of the rescue and of the on-its-way check: a viewer's
later pieces wait behind its first ones, 4-6 s each at those rates, so they look idle (see Limits).

Round 4 measured this again (ADR 0003, "Round 4"): host 1 MB/s, a reader blocked far past the frontier. The median
was 1.09 s with one viewer and 2.37 s with three. With three viewers, the `have` reached the viewer at 0.59 s, its
request reached the host at 0.98 s, and the first byte arrived at 1.47 s. Cancelling the viewer's other in-flight
requests on `blockedOn` (Follow-up 2) does not help: the host has already queued their data, so it sends that data
anyway and again when it is requested again. With one viewer that gave 2.0 s and a dupFactor of 1.24. The lever was
on the host: a shorter per-wire upload queue (Follow-up 7), now the upload scheduler (ADR 0006: 0.31 s with three
viewers on a 31 ms RTT).

**Limits:** a viewer can only fetch what the host revealed to it, so anything it needs outside the group plan has to be
reported as urgent. A viewer that cannot be told (no lt_donthave, or a donthave failed) keeps all it was shown; while
it does, every piece shown to it counts as assigned, so the others get those only from it or by rescue. Every
viewer in our app is WebTorrent with lt_donthave, so this takes a member that misbehaves. The rescue's 3 s, and the
on-its-way check's, are 3 s without a reveal or a request. A viewer asks for a piece's blocks only once every block of
the piece before it is asked for, and the host's answers wait in its upload queue, so at 1 MiB pieces a fetch that
progresses can go 3 s without a request: before it starts, or while its last blocks arrive. That sent up to 3.4
pieces more of a group seek's 9 in the 1 MiB test at 500 KB/s, 5 under CPU load (ADR 0003, Round 5). And the room's
start needs two pieces past its position at every viewer (readiness), which now leave the host once each, to one
viewer. A starved lane holds up the whole room: under CPU load, WebTorrent's upload throttle (speed-limiter's token
bucket, unfair between wires) left single lanes idle for 3-8 s (no request from that viewer), and the rescue does not
reach a piece more than 8 s of playback away (piece 2 at 1 MiB and 2 Mbit/s). The session striping test started at
8-16 s that way, 20 s at worst, against 6-16 s when every viewer fetched those pieces itself. The host no longer uses
that throttle: its upload scheduler releases round-robin between wires, and a wire that got nothing for 2 s while
holding requests goes first.

## Host upload scheduling (`upload-scheduler.ts`, `upload-pacer.ts`)

ADR 0006. As shipped, bittorrent-protocol answered every request at once, and the block waited in the wire's buffer,
WebTorrent's upload throttle (a second deep, unfair between wires) and UDX's send queue (~256 KiB per stream before it
pushes back), where a cancel cannot reach it and a `have`, a blocked reader's request and the room's ctrl frames
queue behind it. On the host now (viewers keep WebTorrent's throttle for their own limit):

- **Hold, then release just in time.** Every request is held (the patch's hold mode, set in the torrent's `'wire'`
  event) and released, exactly as upstream would answer it, while its wire's queue is under max(32 KiB, 100 ms of the
  wire's drain rate). The queue: released and still being read from the store, plus pushed into the wire and not yet
  past the peer's `'upload'` Transform, plus what the connection handed to UDX and UDX has not sent (the udx-native
  patch's counters, through `peer.mux.stream.rawStream`). The drain rate: an EWMA (50 ms ticks, α 0.3) of what UDX got
  acknowledged, or of what crossed the Transform on a lane that is not UDX (tests).
- **Rate.** A token bucket 20 ms deep at the effective rate: the upload limit or the pacer's rate, whichever is lower;
  none when neither applies. The Revealer's budget R and urgent wait follow the same rate (the paced part taken as at
  least 1 MB/s).
- **Order.** Class 0 (a piece some viewer's reader is blocked on: the urgent reports), then 1 (the hot window,
  critical ranges), then 2 (`revealer.classOf`), across wires; FIFO within a class on a wire; round-robin between
  wires. A wire that holds requests and got nothing for 2 s takes the next release whatever its class (a viewer's
  WebTorrent drops a wire after 30 s without an answer).
- **Preempt.** `setViewerUrgent` with a piece new in that viewer's report rejects its held class-2 requests, after
  the Revealer has shown the piece: never served, so nothing is sent twice, and its WebTorrent refills those slots at
  once with the blocked piece.
- A cancel drops a held request; a choke rejects held ones (BEP 6). A wire holding over 512 requests (twice our reqq)
  has the rest refused. A request over 128 KiB is released at once (WebTorrent drops that wire).
- **Pacer.** Every 50 ms, each viewer's UDX smoothed RTT while its stream sends; every 100 ms, a LEDBAT-like step:
  base = the lowest of the last 60 s, current = the lowest of the last 500 ms, queueing delay = the median over
  viewers (a viewer that re-attaches starts its history over). Start: from 1 MB/s, ×1.3 per tick while the rate binds,
  under a cap of 1.25 × the best upload of the last 2 s + 64 KB/s, which makes it ~×1.1 (1 to 4 MB/s in ~1.5 s), until
  the queue reaches 10 ms. Steady: cut 5 % per 20 ms of queue above the 20 ms target (at most 20 %, held 2 s), regrow
  below it (2 % / 0.4 % / 0.8 % per tick around the rate of the last cut). A steady rate is not capped, so it holds
  through a pause and the upload comes back at it at once (the spike's cap left it at the floor after 2 s of quiet,
  15 s from 4 MB/s); after 5 s with the upload under half the rate, back to start from that rate. Never under
  250 KB/s. No paced rate until a stream gives a sample (a lane that is not UDX: tests).

Measured in the spike (ADR 0006 §3, `pxjitd`): a blocked read at the app's 1 MB/s limit 1.9 s → 0.31 s with three
viewers; at a saturated 20 / 50 Mbit/s uplink the ctrl RTT p50 46 / 42 ms (shipped 427 / 220), group-seek reads
620 / 402 ms (shipped 1695 / 997), 98-99 % of the shipped throughput, dupFactor 1.00 / 1.01. Open: the pacer's cycle
sets its p95 (ctrl 127 / 157 ms, datagrams ~4× idle; ADR 0006 Follow-up 6), and a competing upload on the same uplink
pushes it down to its floor (Follow-up 2).

## Playlists: one uplink for every item (`uplink.ts`, ADR 0011 §6)

A host seeding several playlist items runs one engine per item, all on one `HostUplink`:

- **One pacer and one token bucket.** `startHost(prepared, {uplink, tier})` builds no pacer of its own. Its scheduler
  takes the uplink's `bucket` and `mayRelease`.
- **Tiers.** A tier-1 scheduler (an item viewers fetch ahead) releases nothing while a tier-0 scheduler (the item
  playing) holds a request it could release now (`UploadScheduler.waiting()`). It refuses (BEP 6) requests a wire
  held for 10 s (`BACKGROUND_MAX_HOLD_MS`).
- **The pacer** reads every engine's streams, each connection once, and the sum of their sent bytes.
- **The upload limit** is the uplink's (`setLimit`). `setTier()` moves an engine between tiers.

Without an uplink nothing changes. Engines of different infoHashes share a member's connection: each pairs its own
Protomux channel (`id: infoHash`).

## Viewer download limit (`download-gate.ts`)

ADR 0010. KiB/s like the upload limit; viewers only (a host downloads nothing: its torrent has no gate). WebTorrent's
own `downloadLimit` throttles what the viewer reads, so the host keeps sending and the data waits in the viewer's RAM
(S2), with `have`s and urgent blocks behind it. The gate holds back the requests instead, so nothing is sent that
was not asked for:

- **Bucket.** One per viewer torrent, shared by its wires: max(64 KiB, 0.25 s of the rate) deep. A request may go
  while the bucket is above empty and is charged its block in full.
- **Critical pieces borrow** up to max(64 KiB, 1 s of the rate) below empty: a blocked reader, the hot window,
  critical ranges (`t._critical`, the Scheduler's urgent groups). A read mpv waits on arrives at link speed; the
  average stays at the limit.
- **Refund.** A failed request (a reject, also the host's preempt; a choke; a closed wire) gives its bytes back, also
  for a piece replaced meanwhile, once per request.
- **Kick.** Nothing in WebTorrent asks again once every request is answered, so a refusal sets one timer (10-1000 ms,
  for when the refused request could go) that calls `torrent._update()`. Setting, raising or clearing the limit
  kicks at once. Lowering it keeps at most the new depth and the new debt: debt borrowed at the old rate is
  forgiven, or every request would wait while the new rate paid it back.
- **Hooks** (`patches/webtorrent+3.0.21.patch`, `torrent._requestGate`, set right after `client.add`): `_request`
  asks the gate before it reserves a block and charges it; `onChunk` refunds before its piece-identity check; the
  walks in `validateWire` and `trySelectWire` stop at the first piece refused. The R6 order puts every critical piece
  first, so nothing after a refusal could go. A critical piece a wire does not have is skipped before the check, so
  under striping the wire to the viewer that holds it still borrows for it.

The setting is `downloadLimitKBps`; the viewer session passes it in and applies changes live (session README
"Transfer limits"), and `limitBps()` (`src/shared/limits.ts`) converts it here.

Measured (256 KiB pieces, in-memory links): at 256 KiB/s, 2064 KiB in 8 s with nothing in transit between the
host's wire and the viewer's; a reader blocked far in L2 at 128 KiB/s waited 875 ms (2 s without borrowing), and from
another viewer under striping 740-874 ms (4.5 s without).

## Things that are easy to get wrong

- **Protomux rejects a remote's channel open** unless this side has already created that channel, or a
  `pair()` handler claims it. `attach()` therefore registers `mux.pair({protocol: 'wtp/bt/1', id: infoHash})`,
  so whichever member opens first, the other side creates its end on demand. A regression test for this is in
  `mux-wire-stream.test.ts`.
- **Per-wire hooks go in at `'ready'`**, synchronously, before any queued lane is added: BEP 10 `reqq = 256` on every
  wire (bounds what a peer keeps outstanding to us, so the uploader holds ~4 MiB per wire, not 1 s of its rate; S2),
  the host's served-block count, the Revealer's overrides and the upload scheduler's hold. The scheduler's `'wire'`
  listener goes after the Revealer's, whose `onArrival` it asks about every request.
- **`'request'` on a host wire fires when the request is released, not when it arrives.** What must see arrivals
  (the Revealer's activity clock, its refusal) goes through the scheduler's `onArrival`; what a viewer is fetching
  from the host is `wire.heldRequests` plus `wire.peerRequests`.
- **Startup verification.** Viewers must always be added with a `bitfield`, all zeros on a fresh download.
  Without one, WebTorrent reads every piece to look for existing data.
- **Chunk-store `get` arguments.** WebTorrent calls `store.get(index, cb)` without `opts`, so both stores accept
  2 or 3 arguments.
- **`torrent.files` is emptied on destroy**, and a store error destroys the torrent at any time. The engine keeps the
  file list it captured at `ready`.
- **File names in the torrent are the host's.** parse-torrent keeps the raw last path element as `name`, so
  `'../../x'` gets through. Anything that turns a name into a path goes through `safe-name.ts`. Saved files keep only
  an allowlisted extension (`mkv mp4 m4v webm avi mov ts m2ts mts`, plus `srt ass ssa vtt sub idx sup` for subtitles);
  anything else gets `.bin` appended, or the video's sniffed container extension for file 0.
- **Journal order.** A piece is claimed only after its segment synced (`SegmentStore.syncDirty` is serialized and
  reports failed segments through `syncFailed`). Each save also lists the last 2 pieces verified in every segment
  synced in the last 30 s; `resume.ts` re-hashes those, because WebTorrent itself probes only one piece per file.
- **Export order** (`saveFile` with `consume`, `resumeExport`). The export journal (`export.json`) is written whole:
  tmp, fsync, rename, then an fsync of the folder. Each file's `.part` is created with O_EXCL and journaled, and the
  destination folder is fsynced, before anything relies on it; a resume writes only into the part its journal names.
  For each whole segment of the video: copy it at its offset, fdatasync the part, journal `consumedThrough`, unlink
  it (a segment it shares with a subtitle goes with the folder). The final name is journaled before the rename, and
  the destination folder is fsynced right after the rename, before the journal can say done. Then the transfer folder
  goes, `export.json` last. A cut anywhere copies at most one segment again. A destination folder that is not there
  (a drive away, a share not mounted) keeps the export pending (`dest-unavailable`), and nothing is created in its
  place: the export is given up (the pieces of what is gone leave state.json) only while that folder is there and
  the part is missing or short, a segment it needs is gone, or the saved video is not where its journal says. The
  same holds when the folder goes while a resumed export runs (any failure then is `dest-unavailable`), and for a
  folder that was a mount point when the save began (`destMount` in the journal): unmounted it is an empty folder on
  the parent's disk, so it counts as not there while its device equals its parent's.
- **Hash failures have no event of their own.** A downloaded piece that fails its SHA-1 is reset and fetched again;
  WebTorrent 3.0.21 says so only with a torrent `'warning'` whose message is `Piece <i> failed verification`
  (torrent.js:2010), which the viewer engine parses into `hashFailures()`. The piece's sources are cleared before the
  hash, so a failure cannot be pinned on a wire. A host whose bytes for a piece no longer match (a file rewritten in
  place with its size and mtime kept, which the source watchdog cannot see, or a failing disk) gets the same request
  again and again; the session layer reports the counts to the host, which warns (session README, "Hash failures").
- **Back-pressure from the disk.** WebTorrent keeps requesting at network speed and holds every piece in memory until
  its `put` completes. Past 64 MiB of writes in flight the scheduler pauses (until < 16 MiB), combined with the
  disk-low pause: either reason keeps it paused.
- **No `select()` or `file.createReadStream()` on a viewer torrent.** Both add priority-1 selections, and
  `shufflePriority` rotates those, which breaks the scheduler's order. The scheduler rebuilds `_selections` itself
  (one `_updateSelections()` per plan), which is valid only because every selection is its own.

## Tests

```sh
scripts/isolated.sh npx vitest run --project unit src/core/transfer
scripts/isolated.sh npx vitest run --project integration test/integration/transfer test/integration/webtorrent-over-protomux.test.ts
```

`upload-scheduler.test.ts` runs the scheduler against real bittorrent-protocol wires (the patched hold mode): order,
queue caps (store reads, the wire, UDX's unsent bytes), the rate, cancel, choke, preempt, aging and the held cap.
`upload-pacer.test.ts` runs the pacer on a fluid bottleneck: it converges on its target, cuts on a capacity step
down, regrows on a step up, goes by the median viewer, holds its floor and starts over after a pause.

`striping.test.ts` takes about 50 s (30 s of striped playback, then a 10 s plain-seeding baseline). `takeback.test.ts`
(about 13 s) has a lone viewer taken back at the app's 1 MiB pieces: it may refill only the pipeline it had, the host
answers nothing it does not advertise, and a request for such a piece is rejected. `revealer.test.ts` (about 70 s)
covers a viewer whose BEP 10 handshake comes an RTT late, one that disables lt_donthave, a group seek's take-back (three
viewers, the walk past the new window: every piece shown outside it and neither held, fetched nor critical gets a
donthave and is no longer revealed), and the urgent channel (a reader outside the group plan; nine readers far past the
frontier with three busy viewers at 1 MB/s, median under 0.6 s; and readers that all wait on the same pieces after a
group seek, at 256 KiB and at the app's 1 MiB pieces; the latter, at 500 KB/s so that round 4's flat 3 s fails it, takes
~30 s). The session striping test (`test/integration/session/striping.test.ts`) has three viewers join at once, which
the link wait is for.

What a member can send is tested twice. `mux-wire-stream.test.ts` feeds malformed bencode and BEP 10 messages to
bencode and to a wire set up as WebTorrent sets it up, each in a worker with a deadline. `hostile-member.test.ts`
attacks a running host from a hand-written peer on the bt lane while a viewer downloads. The host runs in a child
process (`hostile-member.ts`), whose heartbeats the test watches. Either way, a parser that loops fails the test
instead of hanging the run. `engine.test.ts` holds each viewer's handshake in the host's lane until the torrent adds
the lane. That makes the window between 'ready' and the rest of `startHost` deterministic, so the wire hooks are
tested inside it.

`engine.test.ts` also rewrites a piece of the host's file in place and restores its mtime: the watchdog stays quiet,
and the viewer counts that piece's hash failures. The host there is upload-limited: over the in-memory link an
unlimited host answers each refetch without the loop ever leaving the microtask queue, so no timer (the test's
deadline included) runs again.

The download limit: `download-gate.test.ts` runs the bucket on a fake clock. The unit `engine.test.ts` drives the
patched `_request` and `_updateWire` of a real viewer torrent with a fake wire and a recording gate (the check comes
before the reservation, each failed block is refunded once, both walks stop at the first refusal), so a hook lost in
a WebTorrent upgrade fails there. The integration `engine.test.ts` holds a viewer to 256 KiB/s with nothing in
transit, lifts the limit, times a blocked read that borrows, checks the R6 order and a seek under a limit, and
refetches a piece failing its hash at the limit; `revealer.test.ts` has a limited viewer borrow for a piece only
another viewer holds.
