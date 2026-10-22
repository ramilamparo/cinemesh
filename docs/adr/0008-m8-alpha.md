# ADR 0008: M8 alpha — one host and three viewers with real mpv, end to end

- Date: 2026-10-20
- Status: **pass on one machine, with two src defects; the 3-machine LAN session is not covered.**
  - **What runs.** One host and three viewers, each a whole core in its own process with the installed mpv
    headless, share a 5-minute 720p MKV on a local HyperDHT testnet. The host uploads at 2.5x the bitrate.
  - **Checks 1–6 pass in R5** (load 0.4–1.3), and in R4 (load 1.5–2.9) apart from a harness flaw in a new
    assertion. The flaw is fixed, and the fixed check passes on R4's data.
    - R6 order after the host skips to 3:20 holds per wire, in the union of the viewers, and in the host's
      reveals (§2.5 defines it).
    - Every viewer's mpv pauses within 3.1–8.8 ms of the host's request.
    - Permissions: refused with control off, Ask host reaches the host, the grant works.
    - dupFactor 1.046–1.053 (1.007–1.013 without the critical pieces).
    - Keep, save (sha256 equal) and delete.
    - Drift p95 ≤ 17.8 ms, except one viewer at 51.6 ms after an mpv stall (§4.4).
  - **Check 7, the 10-minute run, passes:** every viewer's p95 drift stays ≤ 1.4 ms in every minute.
  - **src defect, high (§4.1).** When a viewer is alone for a moment and a second one joins, which is how rooms
    usually fill, the host's take-back makes the first viewer ask for, and the host send, a pipeline per
    retracted piece:
    - up to 4244 requests and 65 MiB served for nothing, with the host's queue to that viewer at 38–67 MiB in
      RAM;
    - about 37 s later WebTorrent's request timeout drops that viewer's host link. That leaves the other viewer
      alone, opened up and then taken back, so the storm moves to its wire.

    Rooms A and B avoided it only by joining their viewers together. It made one earlier run fail dupFactor (1.308).
    **Fixed 2026-10-22** (§4.1, ADR 0003 round 6): the donthaves go from the plan's end, and the host rejects a
    request for a piece it does not advertise. After the first donthave the viewer asks for no retracted piece, and
    the host serves none; rooms A and B now join their viewers one by one and pass (runs F1–F3).

  - **src defect, low (§4.2).** A paused member's exact position is dropped when mpv's `pause` change arrives in a
    later read than the sample reply: 12 of 44 settles in R4. It costs up to a frame of steady offset, which the
    drift loop leaves alone. **Fixed 2026-10-22** (§4.2): the member keeps the reply.
  - **Not covered:** the 3-machine LAN session, real networks, real audio outputs, and late join with mpv (§6).
- Plan: §8 M8; §9 rows "R6 order", "Scenarios" (control switch, leave prompt, saved file's sha256, EOF) and
  "Load / R7" (dupFactor, core RSS); §8 M6 "real mpv holds p95 drift < 100 ms over 10 min"
- Harness: `test/alpha/` (§2), the opt-in vitest project `alpha` in `vitest.config.ts`
- Raw data: kept outside the repo, in the session scratchpad (`…/scratchpad/alpha/runs/`). It holds every run's
  results JSON, with each member's records next to it when `WT_ALPHA_DUMP=1` (§8).
- Environment:
  - mpv v0.41.0 with `--vo=null --ao=null`; Node 26.6.0; Linux 6.18 (CachyOS); 14 cores.
  - **The machine was shared.** Another workflow's agents ran vitest suites, and two other spikes ran their
    measurement matrices.
    - Measurement runs took turns on a lock, so no two items' measurements overlapped. The other agents' vitest
      suites were not on the lock.
    - Every number below carries the 1-minute load average of its run.
    - The main runs (R4, R5 and the long run) had the machine nearly to themselves: load 1.5–3.
  - §8 has the commands to rerun.

## 1. Question

Does the app work end to end with one host and three viewers, each a whole core in its own process, playing a
real file in a real mpv? The plan's M8 criteria are:

- the host skips to 3:20 and the R6 order holds as §9 states it;
- a pause reaches everyone in under 500 ms;
- with control off a viewer's intent is rejected, and Ask host works;
- dupFactor ≤ 1.3;
- the leave prompt keeps, saves or deletes as chosen;
- a 3-machine LAN session works.

M6's "real mpv holds p95 drift < 100 ms over 10 min" is checked here too.

## 2. Method

### 2.1 Members, room, fixture

- **Members.** Each member is a `SessionManager` in its own Node process: `test/alpha/member-child.ts`, forked
  with tsx by `harness.ts`. It wraps `test/integration/session/harness.ts`'s `member()` and drives it over the fork
  IPC channel through its RPC surface (`session.host`, `session.join`, `playback.intent`, `sync.request`,
  `sync.setPerms`, `session.leave`, `session.recent`), the way `host-child.ts` drives a host. Every member runs the
  installed mpv headless: `member(name, root, { realMpv: true })`, with `--vo=null --ao=null`.
- **Network.** A local HyperDHT testnet (`hyperdht/testnet.js`, 3 bootstrap nodes) passed to every child through
  `WT_BOOTSTRAP`, as the session integration tests do. All members run on one machine and talk over loopback UDX.
- **Room.** The host hosts the fixture. The three viewers (Ann, Bob, Cid) join from the invite together, each
  confirms its own save folder, and the test waits until every mpv has the file loaded and the room is paused at
  0:00. They join together on purpose: a viewer alone for a moment is shown everything (the Revealer's open
  mode), and what goes wrong when that is taken back is the subject of its own tests (§4.1).
- **Fixture.** `test/integration/media/fixtures.ts` with the FixtureSet `ALPHA_SET`:
  - `alpha-300s-4M`: testsrc2 1280x720 at 25 fps, H.264 with a 1 s GOP, AAC 48 kHz at 128 kbit/s;
  - an MKV with Cues: 300.02 s, 155,333,677 bytes (4.14 Mbit/s), 149 pieces of 1 MiB;
  - the long run (§2.5 item 7) uses the same at 600 s (`alpha-600s-4M`, 310 MB, 297 pieces).
- **Host upload limit.** `settings.uploadLimitKBps = 1250` (1.28 MB/s, 2.5x the file's 0.52 MB/s). Three viewers
  each taking their own copy from the host would need 1.55 MB/s, more than the host has. Striping is what lets
  the room play at all; one striped copy plus the critical pieces fits with room to spare.

### 2.2 Instrumentation, without changing src/

`member-child.ts` wraps methods on the prototypes of the classes the session creates, before the member exists:

- **Viewer.**
  - Every block request WebTorrent sends (`wire.request`), with the piece's class in the scheduler's latest plan.
  - At the moment of each request, WebTorrent's own walk of `torrent._selections` for that wire: the first piece
    ahead of the requested one that the wire's peer advertises, the viewer lacks and that still has a block to
    reserve. A piece that speedRanker may skip on a slow wire is counted apart.
  - The scheduler's plans, playheads and blocked readers; verified pieces; BEP 54 donthaves as each wire
    processes them.
- **Host.**
  - Every request a viewer sends (what the engine counts as served).
  - Every reveal of the Revealer, with what made it: the walk (`give`, path walk / rescue / holders), a viewer's
    urgent report, the critical ranges, or open mode.
  - Its group plans, urgent reports and take-backs, and the first bitfield each viewer wire is shown.
  - The room's anchor at every `sync.state` it publishes.
  - At 4 Hz, how many bytes each viewer wire has queued for upload (streamx's readable buffer).
- **Every member.**
  - mpv's pause / seeking / paused-for-cache / speed / eof changes and playback-restarts, as the session's
    `PlayerHolder` sees them.
  - A 4 Hz sample of `audio-pts` and `time-pos` over the player's own IPC connection.
  - The sync member's unpause decisions: what each one is planned from, when it is scheduled and sent, and the
    unpause-latency estimate.
  - The process's RSS at 1 Hz. This is the core's process; mpv is its own process.

### 2.3 Time

Every record is stamped in the child with `process.hrtime.bigint()`: CLOCK_MONOTONIC on Linux, so stamps from
different processes on one machine compare directly. The 4 Hz samples are stamped at their IPC request's midpoint
(good to rtt/2), and samples with an rtt over 20 ms are dropped. The host's anchors (`hostTime`, `performance.now()`)
are converted with each child's `performance.now()` → hrtime offset, measured at start (median of 15).

### 2.4 Rooms

- **Room A: the viewers play from 0:00.** The host plays; the first start waits for the host's start mode (every
  member 10 s buffered). Then, in order:
  - check 3 (control off, Ask host, the grant);
  - check 2: 8 cycles of a host pause, 1.5 s paused, a host play, 4 s playing;
  - check 4: the room plays on until every viewer has the whole file;
  - check 6 over the whole room;
  - a viewer's seek to 1:40, now allowed;
  - check 5 (the three leave kinds).
- **Room B: the host skips to 3:20 while the room plays.** A fresh room plays from 0:00. At 0:20 or later the host
  seeks to 200 s. The room then plays on until every viewer has the whole file. Check 1 runs over room B's records,
  and check 6 over the playing after the seek.

### 2.5 The checks, defined

1. **R6 order after the host's seek to 3:20.**
   - **Terms** (ADR 0003, `scheduler.ts` `orderRanges`). After the seek the plan has:
     - p = pieceOf(the keyframe at or before 200 s − 2 s): the MKV subtitle preroll;
     - the hot window [p, p+5]: 8 s of bytes from the keyframe;
     - L1 = [p, p+w], with w = 14: 25 s of bytes;
     - L2 = [p+w+1, N−1] and L3 = [0, p−1].

     _Urgent_ is group 1 (pieces the viewer's HTTP readers are blocked on), group 2 (the hot window) and group 3
     (the open- and seek-critical ranges: pieces 0–2 and 148 here; this file is well interleaved, so there are no
     audio intervals).

   - **(1a) The plan.** Every viewer's first scheduler plan after the seek, and the host's group plan, have p =
     pieceOf(the Cues keyframe ≤ 198 s), hot[0] = p and the same w. ffprobe's packet list gives the same keyframe
     and piece independently.
   - **(1b) Per wire.** This is the form ADR 0003 Finding 3 gives the §9 row.
     - Rule: every block request a viewer makes after its seek plan, on every wire, is the plan head among what
       that wire's peer offers. The head is the first piece in WebTorrent's walk of the selections that the peer
       advertises, the viewer lacks and that still has a block to reserve.
     - It is checked synchronously at each request. speedRanker's permitted skips on a slow wire are counted
       apart.
     - This is "nothing outside urgent ∪ [p, p+w] while that peer offers a needed window piece; L2 before L3"
       for each link.
   - **(1c) In the union of the viewers.** This is the room as the host's upload sees it.
     - Order: the viewers together request all of L1 before all of L2, and all of L2 before all of L3. "All" means
       every block of every piece is requested by some viewer, or the piece was already held.
     - The first request for a piece of the new window [p, p+w] is in the hot window that starts at p. A reader
       still blocked at the old position may come first: that is group 1, and rightly first.
     - Until the window is fully requested, every request _to the host_ outside urgent ∪ L1 (in the plan it was
       made under) must be one of two things:
       - (i) a piece the host showed that viewer before the seek (old reveals, which a seek does not take back);
       - (ii) a piece the host showed it only after every window piece had been given out (held, shown or
         assigned).
     - Anything else counts as an early reveal, and the test asserts there are none. Requests outside the window
       on viewer↔viewer wires are F3's idle links fetching the wrap; they are reported.
   - **(1d) The host's reveals.** The Revealer's walk assignments after the seek (`give`, path walk) start at p.
     Within a plan epoch they never step back in the cyclic order from p (L1, L2 to the end, L3 from 0). The first
     L3 assignment comes after the last L2 one.
   - **Why per wire and union, not per viewer.** Under striping a viewer can request only what it is shown, and
     the host shows each window piece to one viewer (R = 2 unfetched pieces at a time).
     - So no single viewer requests the whole window before anything else. Each gets about a third from the host
       and the rest from the others, and meanwhile its links fetch what they can.
     - ADR 0003 measured the same: A2, "literal: fail", by design.
     - What R6 gives the player:
       - on each link, the plan order, given what the peer offers (1b);
       - in the room, the window completes first, and the host spends its upload on it before anything later,
         except what it showed before the seek (1c);
       - the host's reveals, which decide what each link can offer, follow the plan (1d).
     - The literal per-viewer numbers are reported as well (§4.4).
2. **Pause latency.**
   - Measured from the host's `playback.intent` pause (stamped in the host's child just before the request enters
     its RPC server) to each viewer's mpv reporting `pause=true` (stamped in the viewer's child as its
     `PlayerHolder` sees the change). Pass: under 500 ms in every cycle, for every viewer.
   - Unpause alignment, as p95 of |viewer − host| over 8 cycles × 3 viewers:
     - (a) when each mpv reported `pause=false`;
     - (b) when each member's playback actually passed the anchor's position. This is the median, over the
       audio-pts samples 0.3–1.5 s after its unpause, of t − (pos − anchor.pos).
3. **Permissions.** Control is off by default (`othersPlayPause` and `othersSeek` false).
   - Ann's `playback.intent` pause and seek return `perm-playpause` and `perm-seek`. She gets the refusal notice,
     whose action is Ask host (`sync.request`). Nobody's mpv pauses or seeks.
   - Ask host reaches the host as the one-click notice its UI shows (`sync.request`, "Ann asks to pause", with a
     Pause action).
   - The host grants control with `sync.setPerms`, and Ann's next intents are accepted and applied in every mpv:
     a pause, a play, and later a seek to 1:40.
4. **Striping.** dupFactor is the engine's own, from the host's `transfer` event: bytes served / distinct 16 KiB
   blocks served.
   - It is checked against the same count over the host's served records.
   - Pass: dupFactor ≤ 1.3, with the 3 viewers playing from 0:00 until each has the whole file.
   - Also reported:
     - the critical pieces' share, from the manifest's open- and seek-critical ranges;
     - dupFactor without them;
     - what each viewer took from the host and from the others;
     - when each completed.
5. **Leave kinds.**
   - Ann leaves with `keep`: her room record stays, `session.recent` offers the room with `resumable: true`, and
     `state.json` and the segments stay on disk.
   - Bob leaves with `save`: the one file in his save folder hashes (sha256) to the source's hash, and his partial
     folder, his record and the Recent entry are gone.
   - Cid leaves with `delete`: the partial folder, the record and the Recent entry are gone.
6. **Drift.** Each viewer sample is compared with the host's position at the same instant: linear between the two
   adjacent host samples, at most 600 ms apart. A viewer sample counts when it is steady:
   - it has audio-pts (present with `--ao=null`) and an IPC rtt of at most 20 ms;
   - the player is not paused, seeking or paused-for-cache;
   - it is at least 2 s after any seek, unpause or playback-restart on that member.

   Reported per viewer: p50, p95 and max of |drift|, the signed values, and each member against the room's anchor.
   Pass: p95 |drift| < 100 ms per viewer.

7. **Long run** (`WT_ALPHA_LONG=1`). A fresh room plays the 10-minute fixture from 0:00 to its end. Pass: every
   viewer's p95 |drift| < 100 ms in each of the 10 minutes, with at least 120 steady samples in each minute.

## 3. Results

Runs on current src are R4 and R5 (rooms A and B) and L1 (the long run), all on 2026-10-20 at load 0.4–2.9; §7
lists them. The earlier runs R1–R3 are from 2026-10-19, on src before round 5 had fully landed, and are given for
comparison.

| #   | Check                                        | Pass when                                                                                                      | Measured (R4; R5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Earlier (R1–R3)                                                          | Pass |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---- |
| 1a  | Plan after the seek                          | p = pieceOf(Cues keyframe ≤ 198 s) everywhere                                                                  | Keyframe 198.000 s at byte 102,517,686 (ffprobe: the same keyframe), so p = 97. Every viewer's plan and the host's group plan have p = 97, hot = [97, 102] and w = 14, 8–9 ms after the host's seek. R5: the same, 2–4 ms after the seek.                                                                                                                                                                                                                                                                                                                 | Same in R1–R3                                                            | pass |
| 1b  | Per wire                                     | Every request after the seek is the plan head of what its peer offers                                          | 0 violations in 7476–7511 requests per viewer after the seek, and 0 in the ~2000 before it. 0 speedRanker skips. R5: 0 in 7428–7442 after the seek, 0 in ~2050 before.                                                                                                                                                                                                                                                                                                                                                                                    | 0 in every run                                                           | pass |
| 1c  | Union                                        | L1 fully requested before L2 before L3; the first request for the window is in the hot window; no early reveal | Fully requested: L1 at 16.9 s, L2 at 45.5 s, L3 at 96.5 s. The first request for the window was piece 99, at 0.68 s. The first past the hot window was 103 (= p+6), at 4.2 s. Before the window was fully requested, the requests to the host outside urgent ∪ L1 were 68 old reveals, 0 given after the window and 0 early; 256 more went over viewer wires. R5: L1 at 18.0 s, L2 at 53.5 s, L3 at 98.7 s. The first window request was piece 100 at 0.51 s, and 103 at 2.3 s. 96 old reveals, 118 given after the window, 0 early; 384 on viewer wires. | L1 18.1 s / 25.1 s, L2 47.9 s, L3 98.1 s; early 0 (R2, R3)               | pass |
| 1d  | Host reveals                                 | The walk starts at p, never steps back within an epoch, and L3 comes after L2                                  | 112 walk gives (plus 2 rescues and 1 urgent reveal), the first ones 97, 98, …, 108 from 205 ms after the seek. 0 back steps; the last L2 give and the first L3 give came at the same tick (42.0 s). R5: 111 walk gives, 0 back steps, the first ones 97, …, 108 from 227 ms.                                                                                                                                                                                                                                                                              | R1, R3: 0 back steps. R2: 1, caused by §4.1 (a wire re-attached)         | pass |
| 2   | Pause latency                                | Every viewer's mpv pauses within 500 ms of the host's request                                                  | 24 viewer pauses (8 cycles × 3): p50 3.8, p95 8.1, max **8.8 ms**. The host's own mpv: max 8.4 ms. R5, load 0.9–1.2: p50 2.2, p95 3.1, max **3.1 ms**; the host 2.7 ms.                                                                                                                                                                                                                                                                                                                                                                                   | max 13.5 ms (R1, load 3–9), 26.9 ms (R3, load 13–17)                     | pass |
| 2   | Unpause alignment                            | Reported                                                                                                       | \|viewer − host\| p95: mpv `pause=false` 13.8 ms; playback past the anchor's position 17.8 ms (p50 4.7, max 19.5). R5: 9.8 / 17.4 ms.                                                                                                                                                                                                                                                                                                                                                                                                                     | R1 p95 16.2 / 28.6 ms; R3 19.0 / 15.1 ms                                 | —    |
| 3   | Permissions                                  | Refused while control is off; Ask host reaches the host; after the grant, intents apply everywhere             | `perm-playpause` and `perm-seek`, each with its notice and an Ask host action; nobody's mpv moved. Ask host became the host's notice ("Ann asks to pause", Pause action) in 3.2 ms. The grant reached Ann in 3.4 ms. Her pause reached every mpv in 5–11 ms, her play in 219–227 ms (the scheduled start), and her seek to 1:40 had everyone playing again in 456–507 ms. R5: Ask host 1.4 ms, grant 1.5 ms, pause 3.0–4.2 ms, play 217 ms, seek 323–474 ms.                                                                                              | Same in R1–R3                                                            | pass |
| 4   | Striping                                     | dupFactor ≤ 1.3, every viewer completes                                                                        | Engine dupFactor **1.046**, the same as ours from the served requests. Critical pieces 0–2 and 148 are 4 of 149, a 2.7 % share; without them dupFactor is **1.007**. Every viewer completed 122.8 s after the first play, taking 34–37 % of its blocks from the host. 0 stalls, 0 take-backs. R5: **1.053**, 1.013 without the critical pieces; complete at 123.8 s; 0 stalls, 0 take-backs. Room B (the seek): 1.062 (R4), 1.093 (R5).                                                                                                                   | 1.059 (R1), **1.308 (R2, with a 145-piece take-back, §4.1)**, 1.048 (R3) | pass |
| 5   | Leave kinds                                  | keep / save / delete as chosen                                                                                 | keep: the record stays and Recent offers Resume (`resumable: true`, progress 1), with `state.json` and 3 segments on disk. save: the one file's sha256 equals the source's (`ad9b629b…`); the partial folder, the record and the Recent entry are gone (1.22 s). delete: all gone. R5: the same (save 0.56 s).                                                                                                                                                                                                                                            | Same in R1–R3                                                            | pass |
| 6   | Drift, room A (play from 0:00, pause cycles) | p95 \|viewer − host\| < 100 ms                                                                                 | Ann p50 4.8 / p95 17.8 / max 109.6 ms; Bob 4.4 / 10.8 / 19.7; Cid 0.0 / 4.7 / 12.2. About 316 steady samples each, over 1.9 min. Ann's max is one mpv stall (§4.4). R5: p95 11.2 / 9.0 / 12.0 ms, max 19.4. The viewers were 8–11 ms behind the host, which ran 11 ms ahead of its anchor (§4.4).                                                                                                                                                                                                                                                         | p95 ≤ 18.0 (R1), 11.6 (R3)                                               | pass |
| 6   | Drift, room B (after the seek)               | p95 < 100 ms                                                                                                   | p95 0.7–0.9 ms, max 5.9 ms, 348 samples each. R5: Ann 0.8, Cid 0.4, and **Bob p50 40.9 / p95 51.6 / max 144.7 ms**: one mpv stall, after which the drift loop pulled him back to the anchor while everyone else ran 33 ms ahead of it (§4.4).                                                                                                                                                                                                                                                                                                             | p95 ≤ 0.6 (R1), 10.4 (R3)                                                | pass |
| 7   | Long run, 10 min                             | p95 < 100 ms in every minute, for every viewer                                                                 | L1, load 1.1–2.8: in each minute, each viewer had 235–240 steady samples, p95 0.7–1.4 ms, max ≤ 4.1 ms. Over the 10 minutes: Ann p95 1.1 ms, Bob 1.3, Cid 0.8, from about 2389 samples each. 0 stalls. The room played the file to its end.                                                                                                                                                                                                                                                                                                               | —                                                                        | pass |

Also measured:

- **Room A set-up.**
  - Opening the room took 12.9 s: four processes started, the host prepared and announced, and three viewers
    joined and confirmed.
  - The first play started 8.6 s after the host's request: the start mode is 10 s buffered for everyone.
- **A far seek with striping (room B).** The room played again 9.0 s after the host's seek to 3:20. It was 12.5 s in
  R5, and 13.4 s in R3 at load 19. Each viewer had the hot window verified after 7.2–7.9 s and L1 after 17.8 s.
  The whole file was everywhere 97.7 s after the seek. The room's dupFactor was 1.062.
- **Drift as the app reports it** (the host's peer list). p95 26–37 ms in R4, against 4.7–17.8 ms measured
  between members. The app measures each member against the room's anchor, which every member runs ahead of while
  its unpause-latency estimate settles (§4.4).
- **The host's upload queue to each viewer** (sampled at 4 Hz in rooms A and B):
  - p50 300–350 KiB, p95 460–530 KiB, max 0.96 MiB. At a wire's third of the limit that is about 0.7–1.3 s, which
    is how long a `have` or an urgent block waits behind it (ADR 0003 Finding 8, Follow-up 7).
  - §4.1's take-back took one to 66.9 MiB.
- **Core RSS** in room A, from the first play to the end of the download:
  - host 228.6 → 229.2 MiB (max 235.6);
  - viewers 182–183 → 185–211 MiB (max 213).
  - over the long run's 10 minutes: host 230.8 → 215.5 MiB (max 237.3); viewers 203–205 → 200–205 MiB (max
    221–228).

## 4. Findings

### 4.1 src defect (high): a take-back makes the first viewer ask for, and the host send, a pipeline per retracted piece

- **Status: fixed 2026-10-22** (ADR 0003 round 6; the text below is the finding as it was made).
  - **The fix.** Both parts of the fix direction below. `Revealer.retract()` sends the donthaves backwards through
    the plan's order. The Revealer also overrides each viewer wire's `_onRequest`: a request for a piece the host
    does not advertise to that wire gets a BEP 6 reject (no answer without the fast extension; WebTorrent always
    sets it) before the store is read, so it never reaches the upload queue. bittorrent-protocol 5.0.9 has
    `reject()` and fails the request at once on a reject, so no patch was needed. A request that crosses a donthave
    was already failed by it: the viewer reads the donthave first.
  - **Each part alone, and both** (`test/integration/transfer/takeback.test.ts`, the regression test; engines in
    one process, 60–61 pieces retracted). Before: 1892 requests over 43 retracted pieces after the first donthave,
    1917 blocks answered while not advertised, a 30.7 MiB queue, a request waiting 10.6 s. Reject only: 1856
    requests, all rejected, 0 answered, 1.5 MiB. Reverse order only: 0 requests, but 25 blocks answered (requests
    that crossed the donthaves), 1.2 MiB. Both: 0 requests and 0 answered, 24–25 rejects, 1.2 MiB, longest request
    wait 2.0 s. Reverting either part fails the test.
  - **The repros, unskipped and passing** (3 runs each, load 1.6–3.6):
    - `takeback-wire.test.ts`: 60–61 retracted, 0 requests for them after the first donthave apart from the 4–6
      pieces the walk gave back to the viewer, 0 blocks answered unadvertised, queue ≤ 1.2 MiB.
    - `takeback.test.ts`: Ann alone, then Bob; 136–138 pieces taken back, all told. After the first donthave she
      asked for none of them (29–30 given back by the walk), the host served nothing unrevealed, its queue to her
      stayed at 1.3–1.8 MiB and its RSS rose 3–12 MiB, and her host wire lasted the 45 s.
  - **In the alpha** (`openRoom()` now joins the viewers one by one): Ann was taken back in every room (140–145
    pieces), nothing was served unrevealed, and room A's dupFactor was 1.005–1.021 (runs F1–F3, §7).
  - The take-back's cost is now a donthave per piece plus a reject per request that crosses one: it no longer
    grows with the file beyond 4 bytes per piece.

- **When it happens.** Viewers join one after the other, the usual way (§9 "late join"). The first viewer is alone
  for a moment, so the host shows it everything (the Revealer's open mode, ADR 0003 round 2 (a)). When the second
  viewer's wire attaches, `Revealer.takeBack()` retracts what the first viewer neither holds nor is fetching: one
  BEP 54 donthave per piece, in piece order. At p = 0 that is the viewer's own plan order.
- **What the viewer does.** lt_donthave 2.0.7 clears the piece in the wire's `peerPieces` and fails the viewer's
  outstanding requests for it. torrent.js's request callback then cancels the reservations and queues `_update()`
  as a microtask.
  - The donthaves leave the host through its upload throttle, so they arrive in several reads, spread over
    24–116 ms.
  - Between two reads, `_update()` refills the pipeline with the next piece the host still seems to advertise.
    That is the next retracted piece, whose donthave is right behind.
  - So each retracted piece draws about one pipeline of requests (2 + ⌈1 s × rate / 16 KiB⌉ blocks).
- **What the host does.** It answers all of them (it serves any request, ADR 0003 Finding 7) into that viewer's
  upload queue. The viewer then discards the data, because its requests were failed.
  - That data is host upload spent for nothing and host RAM held until it drains.
  - The viewer's genuine requests wait behind it. Discarded data never resets WebTorrent's 30 s request timeout
    (bittorrent-protocol `_resetTimeout` runs only for a matched request), so the timeout fires, drops the
    viewer's host wire, and the lane is opened again. The assignments it held are then given out again.
- **Measured.**
  - **Whole sessions** (`takeback.test.ts`, T1; child processes with the session's fake player, host at
    1250 KiB/s; 2026-10-20 22:16, load 14).
    - Ann was alone for 24 s (the test waits 3 s; Bob's join took the rest). Then Bob joined, and 118 pieces were
      taken back. All 118 donthaves reached Ann, the first 674 ms after the take-back, spread over 116 ms, in
      piece order.
    - Ann's requests to the host for the retracted pieces: 78 before the first donthave (her usual fetching), then
      **4244 after it, over 90 pieces**. For 58 of the pieces she asked for all 64 blocks between the previous
      piece's donthave and its own.
    - The host served **4157 blocks (65 MiB)** for pieces it no longer showed her.
    - Its upload queue to her went from at most 2 MiB to **66.9 MiB**, and its RSS from 252 to 339 MiB.
  - **The same, held for 45 s** (T2; 23:25, load 0.2–0.4, the src of 23:03).
    - Ann was alone for 11 s, and 134 pieces were taken back. After the first donthave she sent 2667 requests
      over 71 pieces.
    - The host served 37.2 MiB she was no longer shown. Its queue to her went from 1.5 to 38.4 MiB, and its RSS
      from 224 to 290 MiB.
    - **Her host wire was dropped 36.8 s after the take-back**, by WebTorrent's request timeout. That left Bob
      alone, so he was opened up (119 pieces). 0.8 s later Ann's wire attached again, and Bob's take-back
      (107 pieces) set off the same storm on his wire: 2808 blocks (43.9 MiB) served, his queue at 45 MiB.
    - So the storm feeds itself: each one drops a wire about 37 s later, which opens the other viewer up for the
      next one.
  - **Engines in one process** (`takeback-wire.test.ts`; same limit, 1 MiB pieces, 64 MiB file).
    - 60–61 pieces were retracted. After the first donthave, a sent **1755–1969 requests over 31–45 of them**
      (W2, W3 and P1; load 1.7–14.3). P1 ran on src after round 5b's `revealer.ts` change.
    - The host answered 28–31 MiB of them, and its queue to a reached 27–31 MiB.
  - **In the alpha itself.** R2, run before the harness joined the viewers together, had a 145-piece take-back in
    room A, and room A's dupFactor was **1.308**: the check failed. In room B, Bob was alone for 11 s and 133
    pieces were taken back. He then sent 4078 requests for retracted pieces (1774 of them in one second).
    The host got almost nothing else from him for 30 s. His host wire was dropped and re-attached 36.9 s after the
    take-back, and the walk gave a piece it had given him to Ann: the one back step in that run's reveal order.
- **Scale.** The cost grows with the number of pieces taken back. A first viewer alone in a room for a 4 GiB file
  (about 4000 pieces of 1 MiB) could make the host queue gigabytes. That is extrapolated; the most measured here
  is 66.9 MiB for 118 pieces.
- **Repro** (skipped by default; `WT_ALPHA=1 WT_ALPHA_REPRO=1`):
  - `test/alpha/takeback-wire.test.ts`: engines in one process, about 10 s.
  - `test/alpha/takeback.test.ts`: whole sessions in their own processes, about 80 s.

  Both assert that the cost does not grow with what was taken back. Once the first donthave is in, the viewer may
  ask the host only for the retracted pieces its pipeline was on: at most 3 pieces and 3 pipelines of blocks.

- **Fix direction.** Tried in a scratch experiment only; src is unchanged.
  - Send the donthaves in reverse plan order, last piece first. The pieces the viewer is fetching are then
    retracted last, and when their donthaves fail its requests, the refill finds nothing retracted left to ask
    for. With engines in one process this gave 3 pieces and 146 blocks after the first donthave, 215 blocks
    (3 MiB) answered and a queue of at most 1.8 MiB. The same setting with src's order gave 31 pieces, 1755
    blocks, 28 MiB and a 27.4 MiB queue.
  - Defence in depth: the host should not answer a request for a piece it does not advertise to that wire (with
    the fast extension, a BEP 6 reject). That bounds the host's RAM whatever a viewer sends.

### 4.2 src defect (low): a settle drops its exact paused position when mpv's `pause` change comes in a later read

- **The rule.** `MemberController.settle()`, for a member paused within a frame of the room's position, does not
  seek. It pauses mpv and asks for audio-pts at once (`pausePlayer`, then `sample`, with no await between). It
  keeps the position only if `snapshot().paused` (mpv's observed `pause`) is already true when the reply's
  continuation runs.
- **What mpv does.** mpv 0.41 sends the `pause` change after that reply: 29 of 30 times in a raw probe on a Unix
  socket. `MpvIpc` handles a read's lines in order and settles replies as promises.
  - When both arrive in one read (26 of 30 on that socket, idle), the flag is set in time.
  - When the change comes in a later read, the position is dropped. The member then unpauses from the room's
    position while mpv is paused up to a frame (40 ms at 25 fps) away. The drift loop leaves that alone: it acts
    above 60 ms (`DRIFT.ON`).
- **Measured.**
  - Through src's `MpvIpc`, over the fd://3 socketpair the app uses on Linux (`settle-mpv.test.ts`, 60 trials):
    **46 of 60 dropped at load 1.5**, and 41 of 60 at load 13.8. Over this transport the change usually comes in a
    later read.
  - The deterministic model (`settle-exact.test.ts`): 33.8 ms ahead of the room after a re-pause, against
    13.85 ms when the sample is kept. The 20 ms it was paused ahead stay.
  - In the alpha's room A, settles before an unpause with no exact position:

    | Run | Load  | Settles without it | Median \|start offset\| vs host 1.5–3.5 s after: without | with            |
    | --- | ----- | ------------------ | -------------------------------------------------------- | --------------- |
    | R4  | 2–3   | 12 of 44           | 5.3 ms (n = 8)                                           | 4.7 ms (n = 19) |
    | R3  | 13–22 | 7 of 44            | 11.0 ms (n = 5)                                          | 4.0 ms (n = 22) |
    | R2  | 10–24 | 12 of 44           | 7.6 ms (n = 8)                                           | 2.8 ms (n = 20) |
    - The host's own settles are among the dropped ones, which blurs a comparison against the host.
- **Effect.** Small: everything stays far inside p95 < 100 ms. But it is a systematic offset of up to a frame
  that nothing corrects until the next seek.
- **Repro** (skipped by default; `WT_ALPHA=1 WT_ALPHA_REPRO=1`):
  - `test/alpha/settle-exact.test.ts`: deterministic; a virtual clock and a scripted player.
  - `test/alpha/settle-mpv.test.ts`: the installed mpv through src's `MpvIpc`, 60 trials, about 25 s.
- **Fix direction.** Either:
  - take the sample once the pause is observed (sample again on the `pause` change while `actual` is null); or
  - accept the reply as it is, since mpv answers commands in order and the get_property went out after the
    set_property.

  ADR 0007 has a related mpv behaviour after a paused seek.

- **Fixed 2026-10-22, the second way.** `settle()` keeps the reply whatever the observed `pause` says by then; the
  session's `PlayerPortAdapter` sends every command at once, in the member's order, so the read always follows the
  pause. Fixed with it: ADR 0007's Findings 4 and 5 (the member no longer re-reads a position it holds exactly, and
  starts from the frame a seek landed on). The repros moved into the regular suites and pass:
  - `settle-exact.test.ts` → `test/sync/member.test.ts` (unit), both cases, now within 0.5 ms of the room;
  - `settle-mpv.test.ts` → `test/integration/player/sync-reads.test.ts` (skipped without mpv and ffmpeg). It now
    checks the fix's premise on the production path (`PlayerController` and `PlayerPortAdapter`): the sample sent
    right after the pause equals the paused audio-pts read 150 ms later, in 20 of 20 trials, while the `pause`
    change came after the reply in 14 of 20 (2026-10-22).

### 4.3 After a far seek, viewers first fetch what the host showed them for the old position

- **What happens.** A group seek clears every viewer's exclusive set (ADR 0003 Follow-up 3), but what was
  revealed stays revealed. The new hot window's reveals come with the next tick (≤ 250 ms) and then wait in each
  viewer's upload queue (the `have` latency, Finding 8).
- **The cost.** Meanwhile each viewer's host wire offers nothing better than its unfetched old reveals (L3 now),
  so it fetches them (F3: correct per wire). Then the window's data waits behind them in the same queue.
  - R4: in the 16.9 s before the window had left the host once, the host sent:
    - 17.9 MB of urgent and L1 pieces;
    - 2.7 MB of L2, given out only after every window piece had been;
    - 1.1 MB of L3: the old reveals, 68 requests, about 0.9 s of its upload.
  - R5: 1.5 MB of L3 (96 requests); R3: 1.9 MB (1.5 s).
  - The room played again 9.0 s (R4), 12.5 s (R5) and 13.4 s (R3) after the seek. The hot window (6 MiB) needs at
    least 4.9 s of host upload.
- **Why it is not a defect yet.** Taking those pieces back on a seek would end the waste, but today a take-back
  sets off §4.1.
- **Addressed 2026-10-22** (ADR 0003 round 6), once §4.1's fix made a take-back cheap. A group seek takes back from
  each viewer what it was shown outside the new window `[p, p + w]` and neither holds nor is fetching (critical and
  urgent pieces stay). Room B, before the window had left the host once: F1 (without it) 1.06 MB of L3 and 1.72 MB
  of L2, the window out once at 16.9 s; F2 and F3 (with it) 0 L3 and 0.59–1.25 MB of L2, at 14.2 and 13.4 s. The
  room played again at 11.2 s (F1), 11.8 and 8.6 s (F2, F3): too few runs to call that part.

### 4.4 Observations

- **R6 per viewer, read literally, does not hold** (§2.5 explains why it is not the check).
  - Each viewer's first request after the seek was a piece of the old position:
    - piece 30 for Ann and Bob, 85 ms after the seek. That was a reader of the old position, mpv's readahead, still
      blocked on it: group 1, rightly first. It let go when the piece arrived, 83–165 ms after the seek.
    - piece 33 for Cid, at 41 ms: an old reveal.
  - Before each viewer had requested the whole window, it made 77–170 requests outside urgent ∪ L1 (R4); 312–338 in
    R3.
- **Every member starts before the room's anchor, and a member brought back to it splits from the rest.**
  - Each member, the host included, starts its unpause early by its unpause-latency estimate. The estimate starts
    at 50 ms and moves only after an exact unpause (its probe), while mpv with `--ao=null` takes a few ms
    (ADR 0007). So a room plays up to about 50 ms ahead of its own anchor, every member alike:
    - 24–39 ms in R4's first pause cycle, and 3–8 ms by the eighth;
    - 33–49 ms in R5's room B;
    - 50–52 ms through the whole long run, which had one start and no later unpause to learn from (max 61 ms).
  - Inside the drift loop's 60 ms dead band this cannot be seen between members. It shows when one member is
    corrected.
    - In R5's room B, after Bob's mpv stalled (below), the drift loop brought him back to about 8 ms from the
      anchor. Everyone else stayed 33 ms ahead of it, so he ran 41 ms behind the others for the rest of the room
      (p95 51.6 ms).
    - With real audio outputs the estimate starts nearer the truth, but devices differ, and a member corrected
      toward the anchor can split from the rest by up to the dead band. That belongs to S6 with real devices
      (ADR 0007).
  - **Addressed 2026-10-22 (follow-up 6), without waiting for real devices.** The anchor is the only position all
    members share, so the sound fix is to put every member there rather than to guess one common bias:
    - after every start, the drift loop's first decision corrects from `DRIFT.OFF` (15 ms) up instead of `DRIFT.ON`
      (60 ms): a start's error, whatever its cause (the latency estimate, a missed frame landing), is nudged out
      once by every member that can nudge, so a later correction of one member no longer splits it from the rest;
    - the first unpause probe replaces the 50 ms prior (α 1, then 0.3), so later starts begin on time.
    - Left for S6 on real devices: a member that cannot nudge (spdif) keeps its first start's error until its next
      start, and whether a device's start latency shows in audio-pts at all (ADR 0007 §7).
- **Two mpv stalls.** A viewer's mpv stalled once in R4 (Ann, room A) and once in R5 (Bob, room B).
  - One 4 Hz IPC sample took 416 and 421 ms, while the member's own core timers ran on time. The viewer fell
    100–145 ms behind, and the drift loop caught up with speed 1.031–1.034 → 1.0 in about 3 s.
  - Bob's stall came while one of mpv's reads waited for a piece 10 pieces ahead of the playhead. Ann's came 0.3 s
    before her download's last piece arrived, with no read waiting.
  - mpv.log was not kept, so the cause is open. These are the two largest drift samples of the rooms (109.6 and
    144.7 ms).

## 5. Decision

- **M8's automated criteria pass on one machine** for a room whose viewers join together: R6 order (in the form
  §2.5 defines), pause latency, permissions and Ask host, dupFactor, the three leave choices. M6's 10-minute drift
  criterion is checked by the long run (§3, row 7).
- **M8 is not done:**
  - **§4.1 must be fixed before beta.** It hits the usual case, viewers joining one after another; it grows with
    the file; and it costs the host upload and RAM, and the first viewer its host link. Once it is fixed:
    - `openRoom()` should join the viewers one by one, so rooms A and B cover late join;
    - `takeback.test.ts` and `takeback-wire.test.ts` should run unskipped.
  - **The 3-machine LAN session** is the remaining M8 criterion. It needs real machines, and real audio outputs
    with them (the open per-device part of S6, ADR 0007).
- **§4.2 is low priority**, and best fixed together with ADR 0007's paused-seek finding: both are about where a
  paused member really is.
- **The alpha stays opt-in** (`WT_ALPHA=1`), outside `npm test` and the `integration` project. It needs mpv and
  ffmpeg, takes about 5 minutes (the long run 11), and keeps several cores busy: four cores and four mpv.
- **Follow-ups:**
  1. Fix §4.1. Order the take-back's donthaves from the plan's end; answer only advertised pieces (BEP 6 reject).
     Then turn the joins sequential and unskip the repros. Done 2026-10-22 (§4.1).
  2. Fix §4.2, and unskip `settle-exact.test.ts` and `settle-mpv.test.ts`. Done 2026-10-22 (§4.2): both moved
     into the regular suites.
  3. After §4.1: consider taking back, on a group seek, what was revealed for the old position and not fetched
     (§4.3). Done 2026-10-22 (§4.3).
  4. Rerun in a quiet period (§8) before quoting these numbers as final. Rerun the repros once round 5b's
     transfer changes are in: `revealer.ts` and `engine.ts` changed during these runs (§7).
  5. A 3-machine LAN alpha, with 5 viewers and the §9 load case, at M10.
  6. Sync, with S6 on real devices (ADR 0007): the unpause-latency estimate learns only from unpauses, so a room
     runs up to 50 ms ahead of its anchor. A member corrected toward the anchor then splits from the rest (§4.4).
     Learn the estimate from steady play too, or start it from the device's measured latency. Addressed
     2026-10-22 by a start trim and a first probe that replaces the prior (§4.4).
  7. When a run shows an mpv stall again, keep its folders (`WT_ALPHA_KEEP=1`) for mpv.log (§4.4).

## 6. What this does not cover

- **One machine.** Every member and the testnet run on one machine and talk over loopback UDX. There is no real
  network, no NAT, no relay, no packet loss and no real RTT; ADR 0005 covers those, and the plan's netem rows stay
  open.
  - The host's upload limit is WebTorrent's throttle, not a real uplink.
  - All four cores and their mpv share 14 cores with each other and with the other work on the machine.
  - Cross-process timing uses CLOCK_MONOTONIC, so no clock offset needs estimating here. On real machines the
    sync engine's own clock estimate adds its error.
- **No sound.** `--ao=null` and `--vo=null`: drift is mpv's own `audio-pts`. There is no audio device latency or
  jitter (PipeWire, Bluetooth, WASAPI, CoreAudio) and no spdif; ADR 0007 has the same limit.
- **The plan's "3-machine LAN session works" is not covered.** It needs three machines.
- **Three viewers**, the low end of M8's 3–5.
- **The viewers joined together** up to R5: in rooms A and B no viewer was alone at a Revealer tick, so no take-back
  happened (each run's `striping.takebacks` records whether one did). Since F1 they join one by one, so the first
  is taken back in each room. Late join while the room plays is still not covered.
- **Scenarios** (§9) covered: the control switch and Ask host, a viewer's seek once allowed, the leave prompt's three
  choices with the saved file's sha256, and EOF (the long run plays to the end). Not covered here: late join
  while playing, 10 seeks/min, host leave/return/restart, kick and rotate, disk below 512 MiB, ENOSPC, crashes,
  closing mpv, a modified source.
- **Load.** It is one striped room at 2.5x the bitrate, not the §9 load case (7 viewers at 10 Mbit/s on 50 Mbit/s).
  Core RSS is reported, not judged against a 2 h run.

## 7. Runs

The fingerprint is a hash of the size and mtime of every file under `src/`, taken at a run's start and end.
`src/` was changing under these runs: round 5 landed on 2026-10-19 between 22:45 and 23:42, and round 5b edited
`net/room.ts` (22:08), `transfer/engine.ts` (22:33) and `transfer/revealer.ts` (22:38, 22:43) on 2026-10-20. Each
member process loads `src/` when it starts, so a room runs on the src of its own start. W1–W3, S1 and M1 were short
repro runs made while writing those tests, outside the measurement lock; P1 repeats them under it.

| Run    | When               | Load (1 min) | src                       | What                                                        | Outcome                                                                                                                                                                                                             |
| ------ | ------------------ | ------------ | ------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1     | 10-19 23:10        | 2.5–8.8      | `cfb1ae81`                | rooms A and B                                               | 11 of 11 pass                                                                                                                                                                                                       |
| R2     | 10-19 23:19        | 10.5–23.6    | `92de243f`                | the same, viewers joining one by one                        | 9 of 11. Check 4 (1.308) and check 1d (one back step) fail, both from §4.1. The harness has joined the viewers together since.                                                                                      |
| R3     | 10-19 23:34        | 12.6–21.6    | `482519a8` → `b8942ac8`   | rooms A and B                                               | 11 of 11                                                                                                                                                                                                            |
| T1     | 10-20 22:16        | 13.6–14.0    | after `room.ts` 22:08     | `takeback.test.ts`                                          | fails (§4.1)                                                                                                                                                                                                        |
| W1–W3  | 10-20 22:06–22:21  | 1.7–14.3     | before `engine.ts` 22:33  | `takeback-wire.test.ts`, plus the scratch reverse-order run | fails (§4.1)                                                                                                                                                                                                        |
| S1, M1 | 10-20 22:01, 22:13 | 0.8, 13.8    | —                         | `settle-exact.test.ts`, `settle-mpv.test.ts`                | fail (§4.2)                                                                                                                                                                                                         |
| R4     | 10-20 22:29        | 1.5–2.9      | `f3f4c8f3` → `0c050ea2`   | the alpha suite, rooms A and B                              | 10 of 11 pass. Check 1c failed on an assertion new in R4: a harness flaw, now fixed. A reader still blocked at the old position counts as urgent. On R4's data the fixed check passes, as it does on R2's and R3's. |
| L1     | 10-20 22:33        | 1.1–2.8      | `0c050ea2` → `b32bde30`   | `long.test.ts`                                              | pass: every minute p95 ≤ 1.4 ms                                                                                                                                                                                     |
| P1     | 10-20 22:44        | 1.5–1.7      | after `revealer.ts` 22:43 | `settle-exact`, `settle-mpv` and `takeback-wire` tests      | All three fail, as §4 expects: 33.8 against 13.85 ms; 46 of 60 dropped; 1826 requests over 31 pieces                                                                                                                |
| R5     | 10-20 23:20        | 0.4–1.3      | `f6c2913e`                | the alpha suite, rooms A and B                              | 11 of 11 pass                                                                                                                                                                                                       |
| T2     | 10-20 23:25        | 0.2–0.4      | `f6c2913e`                | `takeback.test.ts`, held for 45 s                           | fails (§4.1). The storm passed to the second viewer.                                                                                                                                                                |
| F1     | 10-22 02:46        | 0.9–2.0      | `c21497be` → `15a11727`   | the alpha suite, viewers one by one; §4.1 fixed             | rooms A and B 11 of 11; both take-back repros pass. `settle-exact.test.ts` failed (another change in progress, §4.2)                                                                                                |
| F2     | 10-22 02:55        | 2.1–2.7      | `289a1fc2` → `271867f7`   | `alpha.test.ts`, with §4.3's seek take-back                 | 11 of 11                                                                                                                                                                                                            |
| F3     | 10-22 02:59        | 2.4–4.6      | `271867f7` → `55ca0882`   | the alpha suite, final round-6 src                          | 13 of 13 (rooms A and B, both take-back repros)                                                                                                                                                                     |

## 8. How to run

Needs ffmpeg and mpv on PATH. The fixture is generated once into `/tmp/wt-media-fixtures-v1/alpha-300s-4M`
(about 1 min) and reused. Run it inside `scripts/isolated.sh` (a loopback-only network namespace; `npm run test:alpha`
does): its four cores' testnet traffic on the host's network disturbed a VPN tunnel and DNS on the dev machine.

```sh
# the alpha: rooms A and B, checks 1-6 (about 5 min)
WT_ALPHA=1 scripts/isolated.sh npx vitest run --project alpha

# the long run, check 7 (about 11 min; the 10-minute fixture is generated on first use)
WT_ALPHA=1 WT_ALPHA_LONG=1 scripts/isolated.sh npx vitest run --project alpha test/alpha/long.test.ts

# the take-back repros of §4.1 (they failed on src as of 2026-10-20; part of the suite above since the fix;
# §4.2's repros moved to the regular suites)
WT_ALPHA=1 scripts/isolated.sh npx vitest run --project alpha test/alpha/takeback-wire.test.ts test/alpha/takeback.test.ts
```

| Variable           | Effect                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `WT_ALPHA=1`       | Adds the `alpha` project; without it the project does not exist and nothing here runs          |
| `WT_ALPHA_LONG=1`  | Runs the long run                                                                              |
| `WT_ALPHA_REPRO=1` | Ran the defect repros; nothing uses it since §4.1 and §4.2 were fixed                          |
| `WT_ALPHA_OUT`     | Where each run's results JSON goes (default `<tmpdir>/wt-alpha-results`, never the repository) |
| `WT_ALPHA_DUMP=1`  | Also writes every member's records and events next to it, `<results>-<room>-<member>.json`     |
| `WT_ALPHA_KEEP=1`  | Keeps the rooms' folders: each member's data, its core and mpv logs, and its `*.child.log`     |
| `WT_ALPHA_CYCLES`  | Pause/play cycles in check 2 (default 8)                                                       |

Each run prints `[alpha] …` lines with the numbers and the path of its results file. Every record in it carries
the 1-minute load average, and the src fingerprint (sizes and mtimes) at the start and end of the run.
