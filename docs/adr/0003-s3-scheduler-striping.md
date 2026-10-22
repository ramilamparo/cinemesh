# ADR 0003: Spike S3 — R6 request order and host-assigned striping

- Date: 2026-10-19
- Status: **R6 order passes on the host wire, with one patch** (fresh-wire `validateWire()` order); **striping passes**
  (dupFactor 1.03–1.06 vs 3.63, no stalls; 7 viewers 1.05). The literal "nothing outside the window" check fails on viewer↔viewer wires,
  by design of per-wire greedy requesting (Finding 3). The plan's 8 s deadline rule (Finding 9) and R ≈ 4 s (Finding 11) were replaced.
- Plan: §4.2 "R6 scheduler", "Host-assigned striping (Revealer)", "Piece states (R8)"; §7 S3; §9 "R6 order"; M3 dupFactor
- Code: `spikes/s3-scheduler/` (README there); raw results in `spikes/s3-scheduler/data/results/` (gitignored)

## Question
1. Does the plan's `replan()` (every selection a priority-0 stream selection, in strict insertion order) make a viewer
   request pieces in R6 order after a seek: blocked reader → hot window → critical ranges → L1 → L2 → L3?
2. Does a listener on the host torrent's `'wire'` event run before the first piece advertisement, so that per-wire
   overrides of `haveAll` / `haveNone` / `bitfield` can drive host-assigned striping without a WebTorrent patch?
3. With 1 host and 4 viewers at a shared playhead, is dupFactor about N without striping and ≤ 1.3 with it, without new stalls?

## Method
All nodes are in-process WebTorrent 3.0.21 clients, as in `test/integration/webtorrent-over-protomux.test.ts`. Each
link is a `@hyperswarm/secret-stream` pair (`a.rawStream.pipe(b.rawStream).pipe(a.rawStream)`) with `Protomux.from` and
the production `MuxWireStream` on each side. There is no DHT. The client options are `WEBTORRENT_OPTIONS`. The host is
`skipVerify` from disk with `uploadLimit`. Viewers use a memory store with `deselect: true` and `strategy: 'sequential'`.
Fixtures are random files: 256 MiB with P = 256 KiB (N = 1024) for Part A, and 512 MiB with P = 1 MiB (N = 512) for Part B.

```sh
sh spikes/s3-scheduler/run-all.sh          # everything (about 65 min; every run < 2 min, timeout 160 s)
sh spikes/s3-scheduler/run-all.sh a        # or: patched | b | extra (7 viewers, tight uplink) | r2 (R = 2 runs)
npx tsx spikes/s3-scheduler/summarize.ts   # the tables below, from data/results/*.json
rm -rf spikes/s3-scheduler/data            # ~800 MB of fixtures and logs
```

- **Part A** (`part-a.ts`): host (10 MB/s), v1 (instrumented) and v2, in a full mesh. The time-line is:
  - plan p = 0;
  - +4 s: seek to 40 % (p = 409) with an 8 s hot window [409, 439];
  - +10 s: add a 16-piece critical range [960, 975] (4 MiB, like Cues);
  - 150 ms later, while that range is pending: a blocked reader on the first unrequested piece ≥ 150;
  - +16 s: seek to 90 % (p = 921), then run to `done`.
  - v2 follows the same plan, except in `--peer-plan independent`, where it stays on the p = 0 plan.
  - L1 is w = 96 pieces: 25 s at 1 MB/s, P = 256 KiB.
  - Every outgoing request is logged by wrapping `wire.request` from v1's `'wire'` listener (`lib/request-log.ts`).
    bittorrent-protocol 5.0.9 has no outgoing-request event, and `_request()` always calls `wire.request()`
    (torrent.js:1957).
  - Piece states are sampled at 20 Hz and checked against the bitfield.
  - Each scenario was run 3× (default, and `--churn` = replan at 10 Hz). Single runs: `--delay 25` (25 ms one-way
    on every link, using an in-process FIFO delay, not netem), `--sentinel`, `--batched --churn`, `--peer-plan independent`.
  - With `S3_PATCHED_WT=1` the run loads `spikes/s3-scheduler/patched/webtorrent`, which carries the proposed
    `validateWire` patch (×3, plus one churn run).
- **Coinciding bounds** (`part-a-bounds.ts`, live transfer, replan at 10 Hz): p = 2 with an urgent [0, 1], so L3 = [0, 1] too;
  then p = N−1, which has no L2; then L1 reaching N−1. `bench.ts` checks the selection list and `_critical` against the plan
  after 3000 replans (the 8 edge cases, then random plans, with pieces completing underneath). It also times the
  piece-state snapshot at 15,000 pieces with 32 wires × 64 requests, and times `replan()`.
- **B.1** (`wire-hook.ts`): logs every message the host pushes on a wire, with the fast extension on (the normal case) and forced off.
- **B.2/B.3** (`part-b.ts`): host at 5 MB/s with 4 viewers, in a full mesh (or with v3↔v4 dropped).
  - Open-critical = pieces 0–1 and N−1.
  - Every viewer runs the plan's `Scheduler` on one shared playhead. The playhead advances at 2 MB/s after a 3 s
    preroll; replan happens every w/4 pieces, with w = 48.
  - Each run lasts 60 s of playback.
  - dupFactor = host bytes served / distinct (piece, offset) bytes served, counted by wrapping the host's `wire.piece`.
  - A stall is a piece not verified on a viewer when the playhead reaches its first byte.
  - Each main configuration was run 3×; the medians are reported.
  - Also run: the plan's §9 load case (7 viewers at 1.25 MB/s on a 6.25 MB/s host, 3×) and a tight uplink
    (bitrate 4 MB/s on a 5 MB/s host).

**CPU contention.** Other spike agents shared the machine. The first Part B attempt (preserved in
`data/results-contended/`) ran at load 28–33 on 14 cores. Its runs hit the 108 s deadman, and one striping run served
only 0.86 MB/s, with 364 stalls. Those numbers measure starvation of the single-threaded test process, not striping,
and are discarded. Every number below comes from runs at load ≤ 6.3 on 14 cores, mostly 1.5–4 (each run's start load is in
`data/results/run-all*.log`). The load7 and tight runs overlapped the S2 agent's jobs (load 4.3–6.3), and every run
finished in its time budget.

## Results
Part A runs: 3× default, 3× `--churn` (10 Hz replan), and 1× each of delay25, sentinel, batched + churn and
independent, all at load 1–3.5. Patched runs: 3× default + 1× churn with `S3_PATCHED_WT=1` (load 2.4–4.5). "Host wire" means v1's requests to the host, which holds
every piece, so that wire shows the plan order directly. v2's wire can only offer what v2 holds (Finding 3).

| Criterion | Target from the plan | Measured | Pass? |
|---|---|---|---|
| A1. First request after a seek, host wire | `pieceOf(target)` (§7 S3, §9 R6 row) | **0 % (fresh wire): piece 1023 in 9/9 unpatched runs**; 0 with the sentinel and in 4/4 patched runs. 40 %: 409 in 10/10 (median +250 ms, range 51–487). 90 %: 921 in 10/10 (median +161 ms, range 66–872) | 0 %: **fail** without the patch, pass with it; 40/90 %: pass |
| A1b. First non-urgent request after the 40 % seek (hot window [409, 439] is urgent) | first L1 piece outside urgent = 440 | 440 in 10/10, +1.3–2.1 s, i.e. after the hot window was fully requested | pass |
| A2. Nothing outside urgent ∪ [p, p+w] until [p, p+w] is fully requested | §7 S3 | Host wire: 0 requests outside, at 40 % and at 90 %, in every run. The only exception is the one-block piece 1023 at 0 % (A1). v2 wire: 0 at 40 %, but 135–215 per run at 90 % (L3 pieces v2 held). Patched runs: 56–208 on v2's wire at 40 % as well, because v2's fresh wire now starts from the plan head and reaches the L3 pieces v2 holds. In none of these did v2 hold an unrequested window piece | host wire: pass; **literal: fail** (v2 wire, Finding 3) |
| A3. Blocked-reader piece requested next while a 16-piece critical range is pending | §7 S3 | Piece 150 was the first host-wire request in 9/9 runs. In `--peer-plan independent` the blocked piece was 197, and v1 requested it from v2 first, at +34 ms. Median +249 ms (24–452 ms). At that moment the Cues range had 16/16 pieces unverified and 5–16 not fully requested. On v2's wire the first request was another piece, because v2 did not have 150 | pass |
| A4. L2 before L3 | §7 S3 | Host wire: the first L3 request is issued in the same millisecond L2 becomes fully requested (+3.9–4.5 s after the 90 % seek, 10/10). v2 wire: L3 earlier, as in A2 | host wire: pass |
| A5. Replan at 10 Hz: no stall, no duplicate requests | task | 501–514 replans per run. Every run issued exactly 16,384 block requests (N × 16, i.e. none repeated) with 0 duplicate blocks. Time to `done`: 49.7 / 50.9 / 50.9 s, vs 49.6 / 51.3 / 50.5 s without churn | pass |
| A6. Coinciding bounds (p = 2 with urgent [0, 1]; p = N−1; L1 reaching N−1) | M3: "plans are correct, including coinciding bounds" | All 32 blocks of pieces 0–1 were requested before any piece ≥ 2. No errors in 62 live replans or 3000 benched replans; the selection list and `_critical` match the plan every time. The first request was piece 1 (fresh-wire order), or 0 with the patch | pass |
| A7. Piece-state snapshot consistent and cheap | §4.2 R8 | 0 mismatches against the bitfield, and 0 `2→x` or `1→0` transitions, over ~1000 samples per run. 15,000 pieces with 32 wires × 64 requests: **27.5 µs median, 36.8 µs p99** | pass |
| A8. `replan()` cost at 15k pieces | derived from §3 "loop p99 < 20 ms" | Plan's version: 0.02 / 2.65 / **11.5 ms** with 0 / 8 / 32 wires. Batched rebuild: 0.01 / 0.20 / 0.78 ms | pass with the batched rebuild (Finding 5) |
| B1. Host `'wire'` overrides run before the first advertisement | §7 S3 | Fast extension on: `'wire'` → `extended` → our `haveAll` override → `bitfield` (3 revealed pieces). Fast off: same, through the `bitfield` override. The viewer only ever saw the 3-piece bitfield | pass |
| B2. dupFactor without striping (4 viewers, host 5 MB/s, 2 MB/s playhead) | ≈ N (= 4) | **3.63** (3.49 / 3.69 / 3.63). The viewers re-shared only 0.1–4.4 MB each, because all 4 fetched every piece from the host at the same moment | pass (recorded) |
| B2b. Stalls without striping | (baseline) | **433 / 439 / 441** pieces missed. The first came 2.1 s into playback, as expected: 4 × 2 MB/s > 5 MB/s | — |
| B3. dupFactor with striping (full mesh) | ≤ 1.3 (M3) | **1.06** (1.081 / 1.035 / 1.057). After the first 10 s: **1.00**. The excess is the 3 open-critical pieces sent to all 4 viewers, plus startup rescues | pass |
| B3b. Stalls with striping | no new stalls | **0 / 0 / 0**. All viewers ran ~160 pieces (≈ 80 s) ahead of the playhead | pass |
| B3c. One viewer pair without a link (v3↔v4 dropped) | ≤ 1.3, no stalls | dupFactor **1.05** (1.047 / 1.051 / 1.048), 0 / 0 / 0 stalls. Only v1 and v2 (fully linked) are assignees; they uploaded 430–457 MB each, v3 and v4 0.3 MB | pass |
| B3d. Same, viewer upload capped at 4 MB/s | ≤ 1.3, no stalls | `full` eligibility: 1.08, 0 stalls, but only 48 pieces of headroom. `connected` eligibility (any viewer may be the assignee, pieces take 2 hops): 1.05, 0 stalls, 112 pieces ahead (1 run each) | pass |
| B3e. Plan rule "deadline < 8 s → reveal to everyone" | ≤ 1.3, no stalls | **3.48** (3.479 / 3.447 / 3.48), **438** stalls (440 / 437 / 438), no better than no striping | **fail** (Finding 9) |
| B3f. Variants (1 run each unless noted) | ≤ 1.3, no stalls | No deadline rule (3×): 1.03 / 1.03 / 1.03. 25 ms one-way delay on every link: 1.03 (`have` p95 2.0 s). Viewer upload ≤ 4 MB/s: 1.05. **R = 2 (3×): 1.029 / 1.022 / 1.027 with 0 rescues**. R = 8: 1.06. All had 0 stalls | pass |
| B3g. Viewers request unrevealed pieces | none | 0 unrevealed blocks served, in every run | pass |
| B4. Plan §9 load case: 7 viewers at 10 Mbit/s (1.25 MB/s), host uplink 50 Mbit/s (6.25 MB/s) | no stalls, dupFactor ≤ 1.3 | Without striping: 5.74, 476 stalls. With striping: **1.05** (1.049 / 1.055 / 1.042), stalls 0 / 0 / **7**. The 7 are one start-up miss: all 7 viewers missed piece 2, the first exclusively assigned piece, by ≤ 51 ms at 1.7 s into playback. The simulated playhead has no readiness gate; §4.3's gate ("≥ 2 pieces past pieceOf(pos) verified") would have held it. **With R = 2: 1.06, 0 stalls** (1 run) | dupFactor: pass; stalls: pass after the gate (2 of 3 runs clean as is) |
| B5. Tight uplink: bitrate 4 MB/s, host 5 MB/s (1.25× one stream) | (stress) | Without striping: 3.42, 900 stalls. With striping (R auto, rescue): **1.33**, 537 stalls. 121 rescues sent pieces twice, and the distinct rate (3.8 MB/s) fell under the bitrate. **With R = 2: 1.03, 0 stalls, 0 rescues, 60 pieces ahead**; R = 2 without the rescue rule: 1.02, 0 stalls (1 run each) | R auto: **fail**; R = 2: pass |
| B2c. 25 ms one-way delay, without striping | (baseline) | 3.14, 411 stalls | — |

## Findings
1. **A fresh wire's first request is the end of the last selection, not the head of the plan.**
   - `_updateWire` sends every wire that has not downloaded a byte yet to `validateWire()` (torrent.js:1631).
   - `validateWire()` walks `_selections` backwards, and each selection from `to` down to `from` (torrent.js:1660-1686).
   - It requests one block whenever `wire.requests` is empty.
   - So at p = 0 the plan's first request was piece **1023**, the top of L2 [97, 1023], in every unpatched run. In
     `part-a-bounds` it was piece 1 instead of 0.
   - Only that one block goes out of order; once the wire has downloaded, `trySelectWire` takes over in plan order. But the same backwards walk applies to every
     viewer↔viewer wire whose peer has not served anything yet. That is the §7 S3 fallback case: "add a strict-order change
     to the patch file".
   - The 3-line patch (diff 1) makes `validateWire` walk forwards. Measured with it: first request piece 0 at the 0 % seek in 4/4 runs (+18–23 ms) and in `bounds-patched`; host-wire
     results otherwise unchanged (0 outside the window, blocked piece 150 first, L3 only after L2 full, 0 duplicates).
   - A patch-free alternative is a sentinel: append `[head, head]` as the last selection. It works (first request piece 0
     in `a-sentinel` and `bounds-sentinel`), but it must be refreshed on every `'verified'` of the head, and it adds a
     selection. The patch is simpler.
2. **No code path reorders priority-0 stream selections.** Every place in torrent.js that could:
   - `shufflePriority` (torrent.js:1724-1730) runs only `if (next.priority)` (torrent.js:1764, 1779), and its loop stops at
     the first priority-0 selection.
   - `_select` sorts by priority (torrent.js:1255). V8's sort is stable, so equal priorities keep insertion order.
   - `_gcSelections` (torrent.js:1529-1548, a microtask after every `_updateSelections`) only advances `offset` and removes
     completed selections. `from`/`to` never change, so the exact-bounds `_deselect` (selections.js:28-40) still matches.
   - **Hotswap** (`_hotswap`, torrent.js:1877-1917) is reached only from `_request(..., hotswap)` when a block is already
     reserved (torrent.js:1943). It cancels a block on a *different* wire that is under 3 blocks/s and under half this
     wire's speed. It never reorders this wire's own queue, and it fired 0 times in all runs, since no wire was slow
     enough. The `critical` flags made no difference in these runs. They matter only against a stalled peer.
   - `speedRanker` (torrent.js:1694-1722) is the one deliberate reorder. On a wire slower than 48 KiB/s it skips up to
     10 pieces that a faster wire also has and would finish sooner. So a slow peer takes later pieces and leaves the plan
     head to fast peers. That is harmless for R6, and the head still goes first on the fast wire.
   - `FileIterator` adds a priority-1 selection (file-iterator.js:32). That is why `createReadStream()` stays forbidden.
   - The `rarest` strategy uses `getRarestPiece` within each selection (torrent.js:1749) and ignores order within a range.
     Viewers must stay on `'sequential'`.
3. **Requests are greedy per wire, so "nothing outside the window" holds per wire, not per torrent.**
   - `trySelectWire` walks the whole plan for *each* wire and requests the first piece **that peer has**
     (torrent.js:1768-1769).
   - When v2 holds no piece of urgent ∪ L1 ∪ L2, v1's v2 wire requests the L3 pieces v2 does hold: 135–215 requests
     after the 90 % seek, and up to 1360 in `--peer-plan independent`.
   - None of them displaced a window request. `outsideWhilePeerHadWindowPiece` and `L3whilePeerHadL2Piece` were 0 in every
     run: at each such request, v2 had no window piece that v1 still needed.
   - This is the useful behaviour: an idle link fetches the wrap. It costs at most ~1 s of that link's pipeline when v2
     later gets a window piece.
   - The §9 "R6 order" check should be stated per wire: on each wire, nothing outside urgent ∪ [p, p+w] is requested while
     that peer has an unrequested piece of it.
4. **A replan or seek takes effect at the next pipeline refill, 0.05–0.9 s later; in-flight requests are never cancelled.**
   - `_updateWire` returns while `wire.requests.length >= 2 + ceil(0.5 s × speed / 16 KiB)`, then refills up to 1 s worth
     (torrent.js:81-82, 1602-1621, 2207).
   - With the host's throttle releasing in bursts, host-wire requests came in batches 400–750 ms apart. In 3 of the 4 runs
     checked, no request at all was made in the 150 ms after the Cues range was added.
   - First request for the new head: seek 40 % +51–487 ms, seek 90 % +66–872 ms, blocked reader +24–452 ms.
   - Its data then queues behind up to ~1 s of old requests on that wire.
   - Budget ~1.5 s from `blockedOn` to the first byte on a busy wire. If S4/M5 readiness needs better, cancel non-urgent
     in-flight requests on `blockedOn` (`wire.cancel` + `piece.cancel` + `_reservations` cleanup); that was not
     prototyped here (Follow-up 2).
5. **The plan's `replan()` costs O(calls × wires × N) and is not atomic.**
   - Each `_deselect`, `_select` and `critical` call runs `_updateSelections()`. That runs `_updateInterest()`, which scans
     pieces for every wire (torrent.js:1553-1576), and then `_update()`.
   - `_update()` is **synchronous in Node**: `IDLE_CALLBACK` exists only with `window.requestIdleCallback`
     (torrent.js:107, 1580-1585).
   - So 10–12 calls per replan cost 11.5 ms at 15k pieces × 32 wires (2.65 ms at 8 wires).
   - Wires could also request from a half-built list, e.g. after the old urgent and L1 are removed but before the new ones
     are added. Measured: 0 of 16,384 requests per run were made inside `replan()`, because the pipelines were full. It is
     still a race.
   - Rebuilding `_selections` in place and calling `_updateSelections()` once (diff 2) gives the same end state. It passed
     the same 3000-plan invariant check and the `--batched --churn` run, and costs 0.78 ms.
6. **Piece states.**
   - The snapshot is a single pass over `pieces` and over `wire.requests` (`lib/piece-states.ts`, identical in logic to
     `src/core/transfer/piece-state.ts`).
   - It agreed with the bitfield in every sample. No piece ever went from verified back to anything, or from 1 to 0
     A 1 → 0 change would need a cancelled or timed-out request, and none occurred.
   - At 27.5 µs for 15k pieces it can run on every `'verified'`; the 4 Hz cap is for IPC, not CPU.
7. **The striping hook works without a patch.**
   - `_onWire` emits `'wire'` synchronously (torrent.js:1383). The advertisement comes later, in `_onWireWithMetadata`:
     queued as a microtask when the torrent is ready (torrent.js:1385-1390), or called from `_onStore` for wires that
     arrived before ready (torrent.js:936-944).
   - The advertisement is `if (wire.hasFast && this._hasAllPieces()) wire.haveAll() else if (wire.hasFast &&
     this._hasNoPieces()) wire.haveNone() else wire.bitfield(this.bitfield)` (torrent.js:1492-1494).
   - It is looked up on the wire object, so own-property overrides shadow the prototype.
   - `hasFast` is true only when both handshakes set reserved bit 0x04 (bittorrent-protocol index.js:324-328, 627-631).
     WebTorrent always offers `fast: true` (peer.js:199-205), so a seeding host normally calls **`haveAll()`**. Without
     fast it calls `bitfield()`.
   - Overriding all three with a call to the original `bitfield()` is valid in both modes. In fast mode a bitfield is an
     allowed first message. bittorrent-protocol's own `haveAll`/`haveNone` would throw without fast
     (index.js:515-530).
   - A seeder never re-broadcasts `have` (that happens only on `'verified'`, torrent.js:2003), so nothing else leaks
     unrevealed pieces.
   - The host serves any request whatever it advertised. Measured: **0 unrevealed blocks served** in every run, because
     viewers only request what they were told about.
8. **Reveal latency is mostly the host's throttle queue.**
   - A `have` is written into the same wire stream as piece data and passes the upload throttle (peer.js:135-150).
     So it waits behind ~1 s of queued blocks: reveal → viewer receives `have` p50 751 ms, p95 1340 ms (medians of 3 runs; 866 / 2017 ms with 25 ms of link delay).
   - Reveal → first request p50 2686 ms, p95 4773 ms with R = auto (5 per viewer); 4840 / 7155 ms with R = 8; but
     **686 / 1221 ms with R = 2**, i.e. the `have` latency itself. The gap is queueing behind the viewer's other ≤ R
     exclusive pieces, not interest or unchoke latency.
   - Open-critical pieces are in the initial bitfield, so every viewer is `interested` at once. WebTorrent unchokes on the
     first `interested` (torrent.js:1463-1465), and with `uploads: 16` `_rechoke` keeps up to 15 interested wires
     unchoked (torrent.js:1793-1870). The member cap is 12, so an interested viewer is never choked.
   - A viewer that runs out of revealed pieces sends `uninterested`. It becomes interested again on the next `have`
     (`_updateWireInterest`, torrent.js:1564-1576), with no unchoke round trip.
9. **The plan's "deadline < 8 s → reveal to everyone" rule is unstable.**
   - It fires exactly when the group is behind, which is when the host is short of upload.
   - Revealing to all 4 makes all 4 fetch the piece from the host, which divides the distinct rate by ~N. The group then
     falls further behind, and every later piece is inside 8 s too.
   - Measured (`--deadline-mode everyone`, 3×): dupFactor 3.48, 438 stalls, the same as no striping. It
     starts with the first ~10 pieces, which are already inside 8 s at t = 0 (deadline = 3 s preroll + 0.52 s per
     piece).
   - Replacement that worked (`rescue`): below 8 s, a piece is revealed to **one more** viewer (the fastest lacking one)
     only if nobody holds it yet and the host has served no block of it for 3 s since its last reveal.
   - Measured: 13 rescues per run (median), dupFactor 1.06, 0 stalls. With no deadline rule at all: 1.03 and 0 stalls
     (3×). The rescue is a safety net that this setup never needed. Its 3 s trigger fired at start-up, while
     assigned pieces were merely queued (reveal → request p95 4.8 s with R = 5). With R = 2 it never fired.
10. **Who may be the exclusive assignee.**
    - The plan says to reveal to everyone when "the assigned viewer has no bt link to the others". The prototype
      (`--eligibility full`) instead assigns exclusive pieces only to viewers with a lane to every other viewer, and
      sends a piece to a viewer directly only if it has no lane to any holder.
    - With v3↔v4 dropped this made v1 and v2 the only assignees. It held (1.05, 0 stalls), but it put all re-sharing
      on two viewers.
    - With viewer upload capped at 4 MB/s the headroom fell from ~165 to 48 pieces. `--eligibility connected` (any
      viewer, relying on 2-hop spread) kept 112 pieces of headroom at 1.05–1.08.
    - `connected` is only safe while the viewer graph is connected. In a split graph a piece assigned in one component
      never reaches the other, and neither the holder rule nor the rescue rule would catch it. So `connected` needs a
      component check, and the simpler `full` rule is the default (Decision).
11. **R should cover the reveal → request latency, not 4 s of upload.**
    - The host stays saturated as long as the pieces revealed but not yet requested cover the `have` latency plus
      one RTT.
    - R = 2 per viewer (8 MiB ≈ 1.7 s of host upload) kept the host at 5.0 MB/s with no queueing and 0 rescues.
    - The auto R (5 per viewer ≈ 4 s) and R = 8 only lengthened each viewer's queue: reveal → request p50 2.7 s and
      4.8 s.
    - That queue is what made the 3 s rescue fire needlessly at start-up. It also makes reveals commit pieces to a
      viewer earlier than needed, which reacts worse to seeks and departures.
    - R = 2 confirmed it: 1.029 / 1.022 / 1.027 with 0 stalls and 0 rescues (3×), and 1.06 / 0 stalls on the
      7-viewer load case.
    - Above all, R = 2 rescued the tight uplink case (4 MB/s on a 5 MB/s host). With the auto R, the queueing
      triggered 121 rescues, dupFactor 1.33 and 537 stalls; with R = 2 it ran 1.03 with 0 stalls.
12. **What these numbers do not cover.**
    - Every node shares one event loop, and the links are loopback SecretStreams with no loss. Only the
      `--delay 25` runs add latency.
    - Viewer uplinks are unlimited, except in the `vup4` runs.
    - A "stall" here is a piece missing when the simulated playhead reaches it. The playhead never pauses, so the
      baseline's 439 stalls count every piece after the first miss. It is a pass/fail signal, not a rebuffer count.
    - The host rate is set by WebTorrent's `uploadLimit` throttle, not by a real uplink. The throttle is also why
      `have` messages queue (Finding 8).

## Decision / fallback chosen
- **R6 scheduler:** keep the plan's design: every selection is our own priority-0 stream selection, rebuilt in strict
  order, with `deselect: true`, and no `select()` or `createReadStream()`. Three changes:
  1. Take the §7 S3 fallback: add a 3-line `validateWire` hunk to `patches/webtorrent+3.0.21.patch` (diff 1), so a fresh
     wire's first request is the plan head. The append-a-sentinel trick is the patch-free fallback.
  2. Rebuild `_selections` in one batch with a single `_updateSelections()` (diff 2): it is atomic and 15× cheaper.
  3. State the §9 "R6 order" check per wire (Finding 3). On the host wire every criterion passed in every run.
- **Piece states:** keep `src/core/transfer/piece-state.ts` as written. It is the same algorithm that was validated here.
- **Striping:** ship the Revealer as §4.2 describes, with the hook exactly as prototyped and no WebTorrent patch.
  Parameters that worked:
  - **tick 250 ms**, walking the group plan in viewer order;
  - **R = max(2, ⌈1.5 s × hostUpload × share / P⌉)**, where share = the viewer's EWMA host→viewer rate (α = 0.3 per
    tick) / Σ rates. That gives **R = 2** in every measured case. The plan's ≈ 4 s (R = 5 here) queued reveals and
    failed the tight case (Finding 11);
  - assign each piece to the eligible viewer with the lowest (outstanding exclusive + 1) / rate, and **stop the walk at
    the first piece where every eligible viewer is at R**, so reveals never skip ahead of the plan;
  - a piece that a viewer already holds is never re-sent by the host, unless a lacking viewer has no lane to any holder;
  - **eligibility `full`**: only viewers with a lane to every other viewer are assignees; a lacking viewer with no
    lane to any holder gets the piece revealed directly; if no viewer is eligible, reveal to all lacking viewers.
    `connected` (Finding 10) is the upgrade once the host tracks viewer-graph components;
  - a single viewer gets every piece revealed;
  - **replace "deadline < 8 s → everyone" with the rescue rule** (Finding 9): below 8 s, if nobody holds the piece
    and no block of it was served for 3 s, reveal it to the fastest other lacking viewer. With R = 2 it never fired,
    so it stays a safety net for a stuck or departed assignee.
- No fallback is needed for striping. A WebTorrent "advertise" hook patch is unnecessary.

## Changes recommended for src/
**Diff 1: `patches/webtorrent+3.0.21.patch`, append this hunk** (regenerate with `npx patch-package webtorrent`; the
patched copy used for the measurements is `spikes/s3-scheduler/patched/webtorrent/lib/torrent.js`):
```diff
diff --git a/node_modules/webtorrent/lib/torrent.js b/node_modules/webtorrent/lib/torrent.js
--- a/node_modules/webtorrent/lib/torrent.js
+++ b/node_modules/webtorrent/lib/torrent.js
@@ -1660,8 +1660,7 @@
     function validateWire () {
       if (wire.requests.length) return
 
-      let i = self._selections.length
-      while (i--) {
+      for (let i = 0; i < self._selections.length; i++) {
         const next = self._selections.get(i)
         let piece
         if (self.strategy === 'rarest') {
@@ -1680,7 +1679,7 @@
             tries += 1
           }
         } else {
-          for (piece = next.to; piece >= next.from + next.offset; --piece) {
+          for (piece = next.from + next.offset; piece <= next.to; ++piece) {
             if (!wire.peerPieces.get(piece)) continue
             if (self._request(wire, piece, false)) return
           }
```

**Diff 2: `src/core/transfer/scheduler.ts`, a batched rebuild** (the same end state as the plan's version; the bench
checked it against the plan after 3000 replans):
```diff
--- a/src/core/transfer/scheduler.ts
+++ b/src/core/transfer/scheduler.ts
@@ -117,10 +117,17 @@
     }
     const t = this.t
     const n = this.pieceCount
-    for (const s of this.live) t._deselect(s.from, s.to, true) // all stream selections are ours
+    // One rebuild and one _updateSelections() instead of one per _deselect/_select/critical call. Each of those
+    // runs _updateInterest (wires x pieces) and _update over every wire synchronously (torrent.js:1516-1524), so a
+    // wire with a free pipeline can request from a half-built list. S3: 11.5 ms -> 0.8 ms at 15k pieces x 32 wires.
+    // Valid only because every selection is ours (deselect: true, never select() or createReadStream()).
+    t._selections.clear()
     t._critical = [] // upstream never clears critical flags
     this.live = []
-    if (this.paused) return
+    if (this.paused) {
+      t._updateSelections()
+      return
+    }
 
     const urgent: PieceRange[] = [...[...this.blocked.values()].map((i) => [i, i] as const)]
     if (this.playhead?.hot) urgent.push(this.playhead.hot)
@@ -137,8 +144,12 @@
       .map(clamp)
       .filter(([a, b]) => a <= b)
       .map(([from, to]) => ({ from, to }))
-    for (const s of this.live) t._select(s.from, s.to, 0, null, true) // insertion order = request order
-    for (const [a, b] of urgent.map(clamp)) if (a <= b) t.critical(a, b)
+    for (const { from, to } of this.live) {
+      // insertion order = request order (priority 0 is never shuffled, torrent.js:1764/1779)
+      t._selections.insert({ from, to, offset: 0, priority: 0, notify: null, isStreamSelection: true })
+    }
+    for (const [a, b] of urgent.map(clamp)) for (let i = a; i <= b; i++) t._critical[i] = true
+    t._updateSelections()
   }
 
   private pieceOf(byte: number): number {
```

**Diff 3: `src/types/modules.d.ts`**, the typings that diffs 2 and 4 need:
```diff
--- a/src/types/modules.d.ts
+++ b/src/types/modules.d.ts
@@ -50,6 +50,8 @@
     peerChoking: boolean
     peerInterested: boolean
     hasFast: boolean
+    peerId: string
+    piece(index: number, offset: number, buffer: Uint8Array): void
     have(index: number): void
     haveAll(): void
     haveNone(): void
@@ -102,7 +104,20 @@
     _select(start: number, end: number, priority: number, notify: (() => void) | null, isStreamSelection: boolean): void
     _deselect(from: number, to: number, isStreamSelection: boolean): void
     _critical: boolean[]
-    _selections: { length: number; get(i: number): { from: number; to: number; offset: number; priority: number } }
+    _selections: {
+      length: number
+      get(i: number): { from: number; to: number; offset: number; priority: number; isStreamSelection?: boolean }
+      clear(): void
+      insert(item: {
+        from: number
+        to: number
+        offset: number
+        priority: number
+        notify: (() => void) | null
+        isStreamSelection: boolean
+      }): void
+    }
+    _updateSelections(): void
   }
 
   export interface AddOptions {
```

**Diff 4: new `src/core/transfer/revealer.ts`** (M3). It is condensed from `spikes/s3-scheduler/lib/revealer.ts`
with the parameters above, and it typechecks against diff 3. The hook is the `onWire` override block. Wire it to
MuxWireStream's remote key (`memberOf`), the membership lanes (`linked`) and the host's group playhead (`plan`,
`deadlineS`):
```diff
--- /dev/null
+++ b/src/core/transfer/revealer.ts
@@ -0,0 +1,154 @@
+import type { Torrent, Wire } from 'webtorrent'
+
+export interface RevealerDeps {
+  /** group plan in request order (urgent -> L1 -> L2 -> L3), built like the viewers' Scheduler */
+  plan(): readonly number[]
+  /** seconds until the group playhead reaches piece i (Infinity behind it) */
+  deadlineS(i: number): number
+  openCritical: readonly (readonly [number, number])[]
+  /** member id behind a host wire (from MuxWireStream's remote key), null for non-members */
+  memberOf(wire: Wire): string | null
+  /** true when members a and b have an open bt lane */
+  linked(a: string, b: string): boolean
+  hostUploadBps(): number
+}
+
+const TICK_MS = 250
+// R: exclusive reveals a viewer may hold unfetched, in seconds of host upload. It only has to cover the reveal -> request
+// latency (have queued behind ~1 s of throttled blocks + RTT); max(2, ...) gives R = 2 in every S3 case.
+const AHEAD_S = 1.5
+const DEADLINE_S = 8
+const RESCUE_AFTER_MS = 3000
+
+interface View {
+  id: string
+  wire: Wire
+  revealed: Uint8Array
+  exclusive: Set<number>
+  rate: number
+}
+
+/** Host-assigned striping (plan §4.2, validated in S3 / ADR 0003). Host only. */
+export class Revealer {
+  private readonly views = new Map<Wire, View>()
+  private readonly lastActivity = new Map<number, number>() // piece -> last reveal or served block (ms)
+  private timer: ReturnType<typeof setInterval> | null = null
+  private served = 0 // bytes
+  private distinct = 0 // bytes of pieces served at least once (pieces leave the host whole)
+  private readonly everServed: Uint8Array
+
+  constructor(
+    private readonly t: Torrent,
+    private readonly d: RevealerDeps,
+  ) {
+    // THE HOOK: 'wire' is emitted synchronously in _onWire (torrent.js:1383); the advertisement
+    // (haveAll / haveNone / bitfield, torrent.js:1492-1494) runs later in _onWireWithMetadata.
+    this.everServed = new Uint8Array(t.pieces.length)
+    t.on('wire', (wire: Wire) => this.onWire(wire))
+  }
+
+  start(): void {
+    this.timer = setInterval(() => this.tick(), TICK_MS)
+  }
+
+  destroy(): void {
+    if (this.timer) clearInterval(this.timer)
+  }
+
+  /** host bytes served / distinct bytes served */
+  dupFactor(): number {
+    return this.distinct ? this.served / this.distinct : 1
+  }
+
+  private onWire(wire: Wire): void {
+    const id = this.d.memberOf(wire)
+    if (!id) return
+    const view: View = { id, wire, revealed: new Uint8Array(this.t.pieces.length), exclusive: new Set(), rate: 0 }
+    for (const [a, b] of this.d.openCritical) view.revealed.fill(1, a, b + 1)
+    this.views.set(wire, view)
+    wire.once('close', () => this.views.delete(wire))
+
+    const sendBitfield = wire.bitfield.bind(wire) // bittorrent-protocol's own method
+    const advertise = (): void => sendBitfield(packBits(view.revealed))
+    wire.haveAll = advertise // fast extension + seeder: the normal path
+    wire.haveNone = advertise
+    wire.bitfield = advertise
+
+    const piece = wire.piece.bind(wire)
+    wire.piece = (index: number, offset: number, buf: Uint8Array) => {
+      this.served += buf.length
+      if (!this.everServed[index]) {
+        this.everServed[index] = 1
+        this.distinct += index === this.t.pieces.length - 1 ? this.t.lastPieceLength : this.t.pieceLength
+      }
+      this.lastActivity.set(index, performance.now())
+      piece(index, offset, buf)
+    }
+  }
+
+  private reveal(v: View, i: number): void {
+    if (v.revealed[i]) return
+    v.revealed[i] = 1
+    this.lastActivity.set(i, performance.now())
+    v.wire.have(i)
+  }
+
+  private tick(): void {
+    const views = [...this.views.values()]
+    if (views.length === 0) return
+    const has = (v: View, i: number): boolean => v.wire.peerPieces.get(i)
+    for (const v of views) {
+      for (const i of v.exclusive) if (has(v, i)) v.exclusive.delete(i)
+      v.rate = 0.7 * v.rate + 0.3 * v.wire.uploadSpeed()
+    }
+    const total = views.reduce((s, v) => s + Math.max(v.rate, 1), 0)
+    const budget = (v: View): number =>
+      Math.max(2, Math.ceil((AHEAD_S * this.d.hostUploadBps() * Math.max(v.rate, 1)) / total / this.t.pieceLength))
+    const fullyLinked = (v: View): boolean => views.every((u) => u === v || this.d.linked(v.id, u.id))
+
+    for (const i of this.d.plan()) {
+      const lacking = views.filter((v) => !has(v, i))
+      if (lacking.length === 0) continue
+      if (views.length === 1) {
+        this.reveal(lacking[0]!, i)
+        continue
+      }
+      const holders = views.filter((v) => has(v, i))
+      if (holders.length) {
+        // spreads through normal 'have's; only a viewer with no lane to any holder needs the host
+        for (const v of lacking) if (!holders.some((h) => this.d.linked(h.id, v.id))) this.reveal(v, i)
+        continue
+      }
+      if (views.some((v) => v.revealed[i])) {
+        // assigned, nobody holds it yet: near its deadline and idle for 3 s, add the fastest other viewer
+        const idle = performance.now() - (this.lastActivity.get(i) ?? 0) > RESCUE_AFTER_MS
+        if (this.d.deadlineS(i) < DEADLINE_S && idle) {
+          const next = lacking.filter((v) => !v.revealed[i]).sort((a, b) => b.rate - a.rate)[0]
+          if (next) this.reveal(next, i)
+        }
+        continue
+      }
+      const eligible = lacking.filter(fullyLinked)
+      if (eligible.length === 0) {
+        for (const v of lacking) this.reveal(v, i)
+        continue
+      }
+      let best: View | null = null
+      for (const v of eligible) {
+        if (v.exclusive.size >= budget(v)) continue
+        if (!best || (v.exclusive.size + 1) / Math.max(v.rate, 1) < (best.exclusive.size + 1) / Math.max(best.rate, 1))
+          best = v
+      }
+      if (!best) break // every eligible viewer is at R: stop, so reveals stay in plan order
+      best.exclusive.add(i)
+      this.reveal(best, i)
+    }
+  }
+}
+
+/** BitTorrent bitfield: piece 0 is the high bit of byte 0. */
+function packBits(flags: Uint8Array): Uint8Array {
+  const out = new Uint8Array(Math.ceil(flags.length / 8))
+  for (let i = 0; i < flags.length; i++) if (flags[i]) out[i >> 3]! |= 128 >> (i & 7)
+  return out
+}
```

Plan text: in §4.2 "Host-assigned striping", replace "R ≈ 4 s of host upload" with "R = max(2, 1.5 s of host
upload by rate share)", replace "its deadline is under 8 s" with the rescue rule, and replace "the
assigned viewer has no bt link to the others" with "only viewers linked to every other viewer are assignees; a viewer with no
lane to any holder gets the piece from the host". In §9 "R6 order", add "on each wire".

## Follow-ups
1. **M3**: turn `part-b.ts` into the integration test for "dupFactor ≤ 1.3 with 4 viewers at a shared playhead". It
   runs in about 65 s. Use 30 s of playback and assert `dupFactor ≤ 1.3` and 0 stalls. Add the `bench.ts` invariant
   check to the scheduler unit tests, including the coinciding-bounds cases.
2. **Seek latency** (Finding 4): a replan reaches the wire only at the next pipeline refill, behind ≤ 1 s of in-flight
   blocks. Measure blocked-seek time to first byte in S4/M5. If the readiness gate needs it, cancel non-urgent in-flight
   requests on `blockedOn`. (Measured in round 4 and not applied: it re-sends what the host had already queued. See
   "Applied in src", Round 4, and Follow-up 7 there.)
3. **Revealer after a group seek** (not tested): exclusive pieces that were revealed before the seek and not yet
   fetched still count against R, and the viewers now rank them in L2/L3. On a group seek, clear every `exclusive`
   set. Test that pieces revealed to a viewer that leaves are reassigned (its view is dropped on `close`).
4. Re-run `part-b.ts` over real Hyperswarm/netem connections once S2's transport numbers are in. Here the reveal → have
   latency (p50 ≈ 0.7 s) came only from the throttle queue. Link RTT adds to it. Check that
   R = 2 still keeps the host saturated (served rate = uploadLimit); if not, raise the 1.5 s term of R.
5. The 7-viewer start-up miss (B4): add the readiness gate to `part-b.ts`, or let the playhead start once 2 pieces
   past it are verified everywhere. Then re-check that the first exclusively assigned piece spreads within the preroll.
6. Revisit `connected` eligibility (Finding 10) once the host knows the viewer-graph components, e.g. from per-peer
   stats. It gave more headroom when viewer uplinks are tight.

## Applied in src
Code in `src/core/transfer/`. The tests named here are in `src/core/transfer/*.test.ts` and
`test/integration/transfer/`.

**As decided.**
- Diff 1 is in `patches/webtorrent+3.0.21.patch`. In `request-order.test.ts`, a fresh wire's first request is piece 0 at
  p = 0.
- Diff 2 is `Scheduler.replan()`. The R6 order is the pure functions `applyPlayhead()` and `orderRanges()`, which the
  Revealer walks too. The invariants from `bench.ts` are now unit tests in `scheduler.test.ts`: the coinciding bounds,
  and 3000 random re-plans.
- Diff 3 is in `src/types/modules.d.ts`.
- Diff 4 is `revealer.ts`, with the Decision's parameters:
  - tick 250 ms;
  - R = max(2, ⌈1.5 s × host upload × rate share / P⌉);
  - the assignee is the viewer with the lowest (exclusive + 1) / rate;
  - the walk stops once every eligible viewer is at R;
  - the holders rule, eligibility `full`, and the rescue rule.
- Follow-up 1 is `striping.test.ts`: host 2.5 MB/s, 4 viewers at a 1 MB/s playhead, 30 s. dupFactor was 1.015–1.05
  with 0 stalls. Plain seeding gave 3.15, with stalls from 8 s.
- Follow-up 3: a group seek clears every exclusive set, and a departed viewer's unfetched pieces are assigned again.
  Both have unit tests.

**Deviations (round 2).** Two things force them: viewers join one by one, and they report their lanes asynchronously.
The spike's topology was static.
- (a) "A single viewer gets every piece revealed" became an _open mode_. With no room playhead yet, or exactly one
  viewer, everyone is shown everything. In the spike that reveal cannot be undone, so the first viewer would be the
  only way to every later one, through its own uplink. When striping starts, each viewer is now told (lt_donthave,
  BEP 54, which WebTorrent supports at both ends) that the host no longer has what the viewer neither holds nor is
  fetching.
- (b) Everything the host reveals beyond the critical pieces counts against R. That covers direct reveals under the
  holders rule, the no-eligible fallback (in the spike it revealed to every lacking viewer, unbudgeted) and rescues (R
  never blocks a rescue). A late link report therefore costs at most R pieces per viewer, not the whole file.
- (c) Eligibility `full` ignores viewers that are linked to no other viewer, because their report is late or they
  really are isolated. Such a viewer gets what it lacks from the host, within its own R, and does not leave the
  others ineligible.
- (d) A lane counts only once both ends report it (`setViewerLinks`).

**Round 3.**
- **Take-back waits for the viewer's BEP 10 handshake.**
  - A viewer sends its extended handshake only once our BT handshake reaches it. On the host it therefore arrives up
    to an RTT after the `'wire'` event, and a lone viewer is opened up before then.
  - Round 2 read a missing handshake as "no lt_donthave" and never retried. On a slow link the first viewer kept every
    piece, and the room got only rescues. This reproduced at 250–400 ms one way.
  - Now a view stays open until lt_donthave has a non-zero id in its latest handshake (`wire.peerExtendedMapping`,
    which is what `wire.extended()` needs; a later handshake may disable it with id 0). Every tick asks again.
  - Each donthave is guarded: a throw ends that viewer's take-back, and the rest stays revealed to it. Nothing
    peer-controlled can throw out of the Revealer's timer.
  - Tests: unit tests, plus `revealer.test.ts` (a 400 ms one-way link, and a viewer that disables lt_donthave).
- **Urgent pieces (the viewer-need channel).**
  - With striping, a viewer can fetch only what the host revealed to it. A reader blocked outside the group plan used
    to wait for the walk (~35 s in `revealer.test.ts`) or for a rescue, and a rescue covers only revealed pieces.
  - Viewers now report `blockedPieces()` with their links (bus message `transfer.links`, at 1 Hz and on the engine's
    `'blocked-changed'`).
  - On the host, `setViewerUrgent(memberId, pieces)` reveals them to that viewer at once, outside R. It keeps them
    through a take-back and in the first bitfield of a lane that re-attaches. An empty report or `removeViewer` clears
    them. At most 16 are taken per report.
  - A piece already on its way is not revealed again. That means a viewer the reporter has a lane to holds it, or was
    shown it and the piece saw a reveal or request within 3 s; this is re-checked every tick. After a group seek every
    reader waits on the same pieces. Without this check each reader's viewer would get them from the host, which is
    Finding 9's "everyone" rule again: the first piece left the host 2.6–3 times with 3 viewers. With it, each of the 9
    pieces was requested once.
  - Measured (host 1 MB/s, 2 viewers): the `have` leaves the host ~1 ms after the report, and the piece is verified
    1.0–2.6 s after the reader blocked.
  - Most of that delay is Findings 8 and 4 again. The `have` waits 0.3–1 s behind blocks already in the throttle
    queue, the request waits for a free pipeline slot, and the data waits behind what was queued meanwhile.
    Follow-up 2 was expected to cut the last two; measured in round 4, it does not (below).
- **bittorrent-protocol patch.** Any member can send these messages. A BEP 10 id is now kept only when it is an
  integer from 0 to 255, and `wire.extended(name)` drops a message for an extension the peer did not announce.
  Upstream threw out of the parser in both cases, which was an uncaught exception in the core:
  - a dict carrying its own `toString` key;
  - ut_metadata answering a request from a peer whose handshake announced no ut_metadata.
- **Known limit.** A viewer that cannot be told keeps everything it was shown: it lacks lt_donthave, or a donthave
  failed. While it does, the others get those pieces only through it or by rescue. Every viewer in the app is
  WebTorrent with lt_donthave.

**Round 4.**
- **The wire parser, completed.** The round-3 patch closed two throws, and the text above read as if that made the
  parser safe. Two more paths from a member's bytes were still open:
  - bencode 4.0.1 decodes BEP 10 handshakes and ut_metadata messages. It accepted a negative string length, so the
    decoder moved backwards and a dict or list never ended (`d1:a-3:e`). The host's event loop stopped, and no
    try/catch can stop that. `patches/bencode+4.0.1.patch` now throws on a length that is negative, not a whole
    number, or past the end of the data. Before, a length past the end returned a short string. It also throws on
    nesting deeper than 64 levels, which used to run out of stack. Every decode step now moves forward, so a decode
    ends in time linear in its size.
  - k-rpc-socket's bencode 2.0.3 has the same flaw. It is not patched: only a BitTorrent DHT uses it, and the client
    never creates one (a test checks `client.dht === false`).
  - ut_metadata read `msg_type` from the `null` that bencode returns for an empty message. That is a TypeError out
    of the parser, which the core's handler reports to main as fatal. The bittorrent-protocol patch now runs every
    extension handler (`onExtendedHandshake`, `onMessage`) inside a try/catch, and drops the wire when one throws.
  - A handshake that does not decode is still ignored, as upstream does. ut_metadata drops a message that does not
    decode.
  - Tests: the bencode and wire cases run in workers with a deadline, so a loop fails the test instead of hanging
    the run. `hostile-member.test.ts` has a hand-written peer attack a running host in a child process while a
    viewer downloads. The host's heartbeats never stopped (the largest gap was ~55 ms). It answered 'interested'
    after the malformed messages, dropped the lane on the empty one, and the viewer went on at ~4 pieces/s. With
    either patch reverted, the test fails: the child stops ticking and is killed, or reports the TypeError.
- **An open view is assigned nothing.** Since round 3, a view can stay open during the walk while its handshake is
  pending. The holders rule then gave it pieces it was already shown. The take-back retracted them but left them in
  its exclusive set, so its R stayed full, and the walk gave it nothing more until the next group seek.
  - `give()` now skips an open view, and the take-back also drops each piece it retracts from the set.
  - The second is defence in depth: with the first in place, an open view's set is always empty.
- **The urgent deferral is bounded.** A blocked reader's piece that is on its way through a linked viewer is held
  back only for 3 s after that viewer first reported it. After that the host sends it anyway. (Round 5 sizes the
  bound to the piece: a flat 3 s fell short at the app's 1 MiB pieces.)
  - Round 3 deferred to a linked holder without any bound. A holder with a slow or limited uplink kept the reader
    blocked, and so did one that never serves the piece or claims pieces it lacks.
  - A piece that leaves the report and comes back starts a new wait.
  - The group-seek test still asked the host for each piece once, but only because it uses 256 KiB pieces, which
    reach the first viewer within 3 s. That did not show a healthy viewer passes a piece on within 3 s. At 1 MiB, the
    smallest piece the app uses, the first viewer's own fetch takes longer, and the 3 s also sent the piece to the
    other readers, in most runs (Round 5).
- **Hook ordering, tested.** `engine.test.ts` holds each viewer's handshake in the host's lane. The wire gets it
  as the torrent adds the lane, so the wire's `'wire'` event falls between `'ready'` and the rest of `startHost`.
  With the round-1 order (hooks installed after `await whenReady()`), both viewers get have-all.
- **Follow-up 2, measured and not applied.**
  - Setup: host at 1 MB/s, 256 KiB pieces, the viewers' pipelines full of the plan. A reader blocks on a piece far
    past the frontier, 10 trials per run, three runs.
  - Variant: cancel each wire's in-flight requests outside groups 1–3 on `blockedOn`. `wire.cancel` runs
    WebTorrent's own error path (`piece.cancel` and the reservation slot).

  | | blocked → verified, median / p90 | dupFactor | requests cancelled / sent twice |
  |---|---|---|---|
  | 1 viewer, as is | 1.09 / 1.30–1.36 s | 1.00 | 0 / 0 |
  | 1 viewer, cancelling | 2.00 / 2.00 s | 1.24 | 597 / 597 |
  | 3 viewers, as is | 2.37–2.38 / 2.91–3.71 s | 1.00–1.01 | 0 / 6–16 |
  | 3 viewers, cancelling | 2.00–2.35 / 2.64–3.55 s | 1.03–1.05 | 107–132 / 83–148 |

  - Cancelling gets the blocked piece's request to the host at once: 1–4 ms instead of 13–494 ms with one viewer.
  - But the host had already answered most of what was cancelled. That data sits in its upload throttle, is sent
    anyway, and is discarded. Then it is requested and sent again. The viewer asks for the blocked piece first, but
    the host answered 752 KiB of the re-requests before the piece's first block. That block needs the whole piece
    read from disk, while the re-requested ones sit in WebTorrent's piece cache (`cache-chunk-store`). Without
    cancelling, 64–240 KiB went ahead of it. The piece's first byte came 1.76 s after the block instead of 0.85 s.
    With three viewers, the median was 0.02–0.37 s lower, the p90 was no better, and dupFactor rose.
- **Where the blocked-read time goes** (medians, 3 viewers, as is). The host sends the `have` ~0 ms after the
  report. It reaches the viewer at 0.59 s: it waited in the host's upload queue (Finding 8). The viewer's request
  reaches the host at 0.98 s, after waiting for a pipeline slot (Finding 4). The host answers at once, and the
  first byte arrives at 1.47 s, after waiting in the same queue. The piece is verified at 2.36 s, at the lane's
  share of the host's upload. With one viewer there is no `have`, since the view is open: request 0.14 s, first
  byte 0.85 s, verified 1.09 s.
  - Every part except the pipeline slot is the host's per-wire upload queue: bittorrent-protocol answers each
    request into it at once, and the throttle drains it at the limit.
  - What would cut it is on the host. Answer requests just in time, keeping each wire's queue at ~100 ms, so that a
    `have` and an urgent piece's blocks do not wait behind a second of older data. Or serve requests for a viewer's
    urgent pieces first. That is Follow-up 7. A viewer-side cancel cannot shorten a queue that is already filled.

**Round 5.**
- **The urgent deferral, sized to the piece.** Round 4's flat 3 s (from the reader's first report) was shorter than
  the first viewer's own fetch of a group seek's first piece at the app's piece size: 1 MiB, `pieceLengthFor`'s
  smallest, so every file up to 16 GiB. That viewer gets it at one lane's share of the host, behind what it had
  already asked for, and at 3 s the piece went to the other readers too, each asking the host for it.
  - The wait now lasts 3 s plus two pieces at one lane's share of the host upload, `2 × P × viewers / host upload`
    (the host upload as R uses it), from the first report: 15.3 s at 500 KB/s with 3 viewers, 11.8 s at 700 KB/s,
    9.1 s at 1000 KiB/s, 3.4 s for an unlimited host that measured 10 MB/s with 2 viewers.
  - Measured with `revealer.test.ts`'s group seek at 1 MiB (3 viewers, 40 pieces, a seek to 24), the first viewer
    verified S 2.4–13.1 s after the seek: 0.55–2.55 pieces at its lane's share, median 1.3, in 24 runs at
    500–700 KB/s (some on a loaded machine). With the new wait S left the host once in 23 of 24 runs (once 1.2
    times). With one piece instead of two (the re-review's prototype: 7.4 s at 700 KB/s, 9.1 s at 500 KB/s), 4 of
    those 24 fetches outlast the wait; in its own 9 runs S left once every time, but all 9 pieces took 1.00–1.60
    against 1.00–1.38 at 500 KB/s, likely as the later pieces' urgent waits ran out sooner.
  - All 9 together took 1.00–1.38 at 500 KB/s, and 1.55 once under CPU load, so that test allows 1.75 (round 4:
    1.59–2.02). At a third of 500 KB/s a viewer's later pieces wait ~6 s each behind its first ones, and the 3 s
    idle of the rescue (S+1 and S+2 are due within its 8 s) and of the on-its-way check takes some of them for stuck.
    In traced runs the rescue gave S+1 or S+2 to a second viewer at 3.2 s, and a third at 6.2 s; that is latency
    bought with upload, as the readers waited on them, and Follow-up 7 is the better lever.
  - Round 4 asked the host for S 2.0–2.6 times in 6 of 6 runs at 500 KB/s, and 3 of 4 at 600 KB/s; at 700 KB/s,
    where the first viewer is quicker, 1.7–3 times in 13 of 21 (12 of 17 on the loaded machine of the round's first
    attempt, 1 of 4 on an idle one). So the test runs at 500 KB/s.
  - Not chosen: timing a holder from when the host first saw it hold the piece, and leaving a fetch to the idle
    rule while it progresses. A fetch still needs a cap (one that progresses slowly is the case at hand), and at
    1 MiB a progressing fetch goes 3 s without a request before it starts and while its last blocks wait in the
    host's queue. Counting the bytes asked for (a viewer that asked for all of a piece has it on its way) gave S
    once in 5 of 5 and 1.00–1.26 for all 9 under CPU load: no better than the cap alone, for more state.
  - The cost: a linked holder that never serves the piece, or claims one it lacks, keeps a reader waiting that
    long instead of 3 s, and longer with more viewers or a slower host (8 viewers at 500 KB/s: 36 s). Still bounded.
- **Viewers that join together get each piece once.** The session striping test
  (`test/integration/session/striping.test.ts`: host 800 KB/s, three viewers joining at once, a 60 s 2 Mbit/s MKV
  of 16 pieces, 15.2 MiB) failed once at dupFactor 1.5056 in a full integration run while other heavy processes ran.
  Its duplicates had two sources (MiB sent more than once, per run):
  - the critical pieces, by design: the 1.3 MB head (pieces 0–1) and the Cues piece, shown to every viewer at once,
    which all three fetch from the host at the start: 1.1–3.3 here, at most 4.4;
  - the no-eligible fallback before the links were known: viewers report their lanes at 1 Hz, so for about a second
    after the wires attached the host took all three for isolated and gave each the same R = 2 pieces. Their
    requests were queued at once, and served whatever the next report said: 0.7–4.0.
  - The urgent deferral plays no part: the test's viewers have no HTTP readers, so nothing is urgent.
- So for its first 2 s (from its wire's attach) a viewer that has reported no lane is not taken for isolated: the
  walk gives it nothing, while critical and urgent pieces still reach it. A reported lane ends the wait; a viewer
  still without one after 2 s is fed from the host as before.
  - Under CPU load (12 busy-loop processes on 14 cores, load average 8–26), the two Revealers alternating, 10 runs
    each: dupFactor 1.22–1.41 (median 1.29) before, 1.12–1.22 (median 1.17) after, the fallback's share gone. The
    round's first, cut-off attempt measured 1.09–1.55 (1 of 10 over 1.5) and 1.05–1.24 (9 runs). On an idle
    machine (4 runs each) the old code sat even closer to the bound, 1.29–1.46 (median 1.41): with fair lanes all
    three fetch the same pieces in parallel, where a starved one would get them from the others. After: 1.09–1.20.
    What is left is the critical pieces, about 1.3 at worst, so the test's bound (1.5) stays.
- **The start then waits on one lane.** Readiness needs two pieces past the position, so the room's start needs
  piece 2 at every viewer, and that piece now leaves the host once, to one viewer, where all three used to fetch it.
  Under the load the host's throttle starved single lanes (most likely speed-limiter's token bucket: a lane in the
  middle of a chunk takes what drips in as it goes, while the others wait on timers that fire late): the viewer
  fetching piece 2 went 3–8 s without a request in 9 of 10 runs. The room started at 10.0–16.0 s (median 12.9),
  against 8.4–16.1 s (median 12.0) before; the first attempt saw 20.3 s in 2 of 10. The rescue rule does not reach
  piece 2: it is 8.4 s of playback away at this bitrate (readiness counts pieces, the rescue seconds).
  - Tried and not applied: rescue a piece up to 3 past the plan's (readiness's two, plus MKV's subtitle preroll)
    however far away, once nobody it was shown to had asked the host for anything for 3 s. Under the same load it
    fired in 7 of 10 runs (1–2 pieces each), mostly just before the starved lane resumed, and the rescuer's lane
    starved as often: start 8.0–14.4 s (median 11.5), dupFactor 1.01–1.32 (median 1.21). The lever is the
    throttle (Follow-up 7).
  - The test counted the plan's 1 Hz ticks when the download ended, ~20 s in, so a start that late left too few (2
    and 5 in the first attempt's runs). The room plays on, so the test now waits up to 20 s for its six ticks.

**Round 6 (2026-10-22): the take-back, made cheap; and a group seek takes back.** ADR 0008 §4.1 found round 2's
take-back costing a pipeline of requests per retracted piece when a lone viewer is taken back: its WebTorrent refills
the pipeline between donthave reads, with the next retracted piece. The host answered all of it (Finding 7) into the
viewer's queue, up to 65 MiB served for nothing, and the viewer's 30 s request timeout dropped its host wire.

- **Donthaves from the plan's end** (`retract()` walks `planOrder()` backwards). The pieces the viewer is fetching are
  retracted last, so a refill finds nothing retracted to ask for.
- **The host answers only what it advertises to that wire.** The Revealer overrides the wire's `_onRequest` (what
  bittorrent-protocol's parser calls) as it does the advertisement: a request for any other piece gets a BEP 6
  reject (WebTorrent sets the fast bit on both ends; without it, no answer), before the store is read, the
  `'request'` listeners run or `dupFactor` counts it. Requests that cross the donthaves were failed by them already.
  No patch was needed: bittorrent-protocol 5.0.9 has `reject()`, and a reject fails the request at once.
- Measured with engines in one process (`test/integration/transfer/takeback.test.ts`, 1 MiB pieces, host
  1250 KiB/s, 60-61 pieces retracted):

  |                    | requests for retracted pieces after the first donthave | answered unadvertised | host queue to the viewer | rejects |
  | ------------------ | ------------------------------------------------------ | --------------------- | ------------------------ | ------- |
  | before             | 1892 over 43 pieces                                    | 1917 blocks (~30 MiB) | 30.7 MiB                 | 0       |
  | reject only        | 1856 over 29                                           | 0                     | 1.5 MiB                  | 1857    |
  | reverse order only | 0                                                      | 25                    | 1.2 MiB                  | 0       |
  | both               | 0                                                      | 0                     | 1.2 MiB                  | 24-25   |

  Through sessions (`test/alpha/takeback.test.ts`, 136-138 pieces, 3 runs): 0 refills, nothing served unrevealed, queue
  1.3-1.8 MiB, host RSS +3-12 MiB, the viewer's host wire kept for 45 s; before: 2667-4244 requests, 37-65 MiB,
  queue 38-67 MiB, RSS +66-87 MiB, wire dropped at 36.8 s.

- **A group seek takes back** (ADR 0008 §4.3, possible now that a take-back is cheap): what each viewer was shown
  outside the new window `[p, p + w]`, not held, fetched, critical or urgent. Until the new window's `have`s reach a
  viewer, its host wire offered only those, so it fetched them first. In the alpha's room B (seek to 3:20; one
  run without, two with): before the window had left the host once, it sent 1.06 MB of L3 and 1.72 MB of L2
  without this, 0 L3 and 0.59-1.25 MB of L2 with it; the window had left once 13.4-14.2 s after the seek, against
  16.9 s.

**Still open.**
- Follow-up 7 (new): pace the host's answers so its per-wire upload queue stays short (~100 ms), serving urgent
  pieces first. It is the lever for the blocked-read time above; Follow-up 2 is dropped. Round 5 adds two reasons:
  a scheduler that serves the wires in turn would not starve one lane for seconds (and with it the room's start),
  and with short queues the 3 s idle of the rescue and of the on-its-way check would see a 1 MiB fetch progress.
  ADR 0006 (S2b) prototypes it.
- Follow-up 4: real Hyperswarm/netem links.
- Follow-up 5: the start-up gate in the striping test.
- Follow-up 6: `connected` eligibility.
- The plan text changes listed under "Changes recommended for src/", and deviations (a)–(d), are not in plan §4.2 yet.
