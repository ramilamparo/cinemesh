# ADR 0004: Spike S4 — mpv against a blocking loopback HTTP server, and the mpv argument list

- Date: 2026-10-19
- Status: **partial pass**. mpv 0.41 behaves well against a server that blocks: it does not
  reconnect, does not hit EOF, and the reload watchdog recovers in about 0.2 s. The plan's
  critical-range table holds for MKV and AVI but **fails for MP4 and fMP4**; the corrected rules
  below pass on every fixture. The argument list was only executed on 0.41; for 0.39 and 0.40 it was
  checked against options.rst, not run.
- Plan: §4.3 (critical ranges, stream server, readiness, blocked-seek watchdog, subtitles),
  §4.4 (argv, IPC, version differences), §7 S4
- Spike: `spikes/s4-mpv-http/` (README has the one-command run). Golden data for M4:
  `spikes/s4-mpv-http/golden/*.ranges.json` and `golden/fixtures.sha256`.
- Environment: mpv v0.41.0 (Arch build, libplacebo 7.360), FFmpeg n9.0.2, Node 26.6, 14 cores.

## 1. Question
When mpv streams from our loopback HTTP server and the server blocks on missing pieces:
- Which bytes does mpv read before the first `playback-restart` on open, on seek and on an audio switch?
  Do they all lie in open-critical ∪ seek-critical ∪ readyRange?
- How many requests does it make, in parallel or not, and does it reconnect?
- What do mpv and FFmpeg do during a 5-minute stall, with `--network-timeout=0` and with the default 60?
- How fast does the blocked-seek watchdog bring playback back?
- Do external subtitles over HTTP load and render?
- Does the §4.4 argument list parse on 0.39, 0.40 and 0.41, and does `--input-ipc-client=fd://3` work
  with a Node `stdio[3]` pipe?

## 2. Method
Reproduce everything with `sh spikes/s4-mpv-http/run-all.sh` (about 25 min plus fixture generation;
each step under 2 min except the 5-minute stall). `README.md` lists every step's own command.

**Fixtures** (`make-fixtures.sh`). One master encode is remuxed into every container, so the packets
are identical: 10 min, 854×480, 25 fps H.264 at about 2 Mbit/s with a 2 s GOP and B-frames, plus two
AAC tracks (eng 440 Hz, jpn 660 Hz). Files are about 170 MB each.

| Fixture | How | Verified layout |
|---|---|---|
| `mkv-cues.mkv` | ffmpeg default | Cues after the last Cluster (169 854 800 +6 546), listed in the SeekHead |
| `mkv-nocues.mkv` | `-f matroska pipe:1`: a non-seekable output gets no Cues. `-live 1` has the same effect (checked: 0 occurrences of the Cues ID `1C53BB6B`, against 2 by default) | no Cues; 4 164 Clusters |
| `mkv-tail.mkv` | ASS track, attached font (`-attach`), chapters and tags, then `mkv-move-to-tail.ts` moves Tags, Attachments and Chapters behind the Clusters and rebuilds the SeekHead (ffmpeg always writes them in front) | Cues, Chapters, Attachments (709 KB) and Tags after the last Cluster |
| `mp4-faststart.mp4` / `mp4-tailmoov.mp4` | `-movflags +faststart` / default | moov 690 859 B at 32 / at 169 347 434 |
| `fmp4-sidx.mp4` | `+frag_keyframe+empty_moov+default_base_moof+global_sidx` | 3 sidx (one per track, 300 refs each), 300 moofs, mfra trailer |
| `fmp4-nosidx.mp4` | same with `+skip_trailer` and no `global_sidx` | no sidx, no mfra |
| `fmp4-mfra.mp4` | no `global_sidx`, trailer kept | no sidx, mfra trailer |
| `avi.avi` | H.264 Annex B + MP3, `-r 25` | `idx1` at the tail (1 040 128 B) |
| `subs.srt`, `subs.ass` | `make-subs.ts`: one cue every 10 s | |

**Golden ranges** (`ranges.ts`). Derived from `ffprobe -show_entries packet=…` plus our own EBML
walker (`ebml.ts`; mkvinfo is not installed) and MP4 box walker (`mp4.ts`). For each fixture they
contain:
- the plan §4.3 rules: `openCritical`, `seekCritical`, and `readyRange[t].plan` with aheadS = 6 s;
- the S4-corrected rules: `openCriticalFixed` and `readyRange[t].fixed`;
- the full keyframe list.

**Server** (`server.ts`). A logging `node:http` range server on `127.0.0.1:0`:
- single-range 206, HEAD and 416;
- `requestTimeout = 0`, `keepAliveTimeout = 5000`, `maxConnections = 32`;
- slices of at most 256 KiB, writes that wait for drain, and blocking on unavailable bytes until they
  are released;
- per-request logging: Range header, bytes written, open and close times, connection id and the
  request's index on that connection.

**mpv** (`mpv.ts`). The plan's common argv, minus what needs a window or our OSC script (`--script`,
`--force-window`, `--vo=gpu-next`, `--hwdec`, `--force-media-title`, `--autofit-larger`,
`--wayland-app-id`). Plus `--vo=null --ao=null --idle=yes --input-ipc-server=<sock> --log-file`.
Driven over JSON IPC with `loadfile <url> replace -1 start=…,pause=yes`, `seek T absolute+exact`
and `set_property aid 2`.

**Modes** of `run-open-seek.ts`, 3 reps each, `--par 3`:
- `free`: everything available;
- `gated`: only the plan ranges (open ∪ seek ∪ readyRange(0)) are available, rounded out to 1 MiB
  pieces (the piece length a 170 MB torrent gets). Before the seek, readyRange(300 s) is added.
  Anything else blocks forever, so a needed byte outside the rules shows up as "no playback-restart";
- `gated-join`: like `gated`, but loadfile starts directly at 300 s;
- `fixed` / `fixed-join`: the same with the S4 rules;
- `--piece 16384`: the same gating at 16 KiB granularity, which tests the exact ranges rather than the
  piece-rounded ones.

If a seek gets no `playback-restart` within 3 s, the runner issues the watchdog's
`loadfile … replace -1 start=300,pause=yes`.

**Other experiments:**
- **Stalls** (`run-stall.ts`): withhold the pieces of [20 s, 40 s) and play from 0 until mpv stalls at
  about 14 s. Hold for 10 s (×3, 4 containers) or 300 s (mkv-cues ×3 and mp4-faststart ×1, each with
  `--network-timeout=0` and `=60`). Then do one of: seek to 400 s and fall back to the watchdog;
  release the range during the seek; release with no seek; destroy the blocked response; or seek
  inside the demuxer cache.
- **Blocked reader** (`probe-blocked-ops.ts`): open at 300 s with only the fixed ranges available,
  wait until mpv's read-ahead blocks, then try `sub-add`, an aid switch, and the reload variants.
- **Subtitles** (`run-subs.ts`): `sub-add` both URLs at 32 s; check track-list and `sub-text`; take
  `screenshot-to-file … subtitles` (libass renders in software, so `--vo=null` works); also the
  embedded ASS of mkv-tail, and a `sub-add` of a withheld file.
- **Argument list**: `argv-check.ts` builds the argv from `mpv-args.ts` for the installed mpv and runs
  it parse-only (`--idle=no`) and with full initialisation (`--idle=no --frames=0 <file>`, which
  initialises gpu-next/Vulkan, the script and the demuxer). `options-diff.ts` diffs each option's
  signature in options.rst at v0.39.0, v0.40.0 and v0.41.0. `ipc-fd3.ts` spawns mpv with
  `stdio[3] = 'pipe'`.

**CPU contention.** The final numbers come from 02:08–02:40 at load average 1.3–4.8. An earlier
pass (around 01:24) ran under heavy contention from other spikes: one mpv took 95 s to reach
`loadfile`, and a free fMP4 open timed out. Those runs were discarded and rerun; the raw text is kept
as `data/results/open-seek-3reps-rerun.txt`. The stall runs were made earlier, before the
interruption, at an unrecorded load. Their timings agree across reps (release 1–51 ms, reload
126–271 ms), so contention did not visibly skew them, but they were not repeated at a known low load.

## 3. Results

| Criterion | Target (plan §7 S4) | Measured | Pass? |
|---|---|---|---|
| Bytes read before the first `playback-restart` lie in open ∪ seek ∪ readyRange | all fixtures | **Plan rules:** MKV ×3 ✓ (exact, 16 KiB gating); AVI ✓ at 1 MiB pieces (the 8-byte chunk header in front of the keyframe is outside the exact range); **MP4 faststart ✗** (seek and join hang, 3/3); **MP4 tail-moov ✗** at 16 KiB (passes at 1 MiB pieces only by luck); **fMP4 with sidx ✗** (open hangs, 3/3); **fMP4 without sidx ✗** (the whole file is read at open, with or without mfra). **S4 rules (§5):** ✓ on all 9 fixtures, 3/3 reps, at 16 KiB and at 1 MiB gating | ✗ plan / ✓ amended |
| One open request per file | 1 | Never two requests transferring at once, and never two playback readers. At each seek FFmpeg opens the new connection before closing the old one, so 2 sockets coexist for ≤ 19 ms (typical overlap 1–10 ms). Every request uses a new TCP connection: 0 of 769 requests reused one, and all were open-ended `bytes=N-` with no HEAD | ✓ in substance (brief overlap) |
| No reconnect or EOF within 5 min of withholding | 0 | `--network-timeout=0`: 0 new requests, no EOF, `paused-for-cache=yes` throughout (4/4 runs). With the default 60: 3 reconnects in 5 min (at 60, 181 and 305 s, with FFmpeg's 0/1/3 s back-off) and no EOF within 5 min | ✓ with `=0` |
| Watchdog reaches `playback-restart` in < 1 s after release or reload | < 1 s | Reload → restart, medians per container: 10 s hold 176–238 ms; 5 min hold 164–201 ms; open/seek matrix 208–344 ms. Release → restart while a seek is pending, medians: 11–31 ms. **A plain `seek` while the reader is blocked never completes on its own** (0 of 102: 63 gated-matrix seeks + 39 stall seeks) | ✓ (and the watchdog is mandatory) |
| Subtitles render | .srt and .ass via `sub-add` URL | Both load (track-list: `subrip` and `ass`, `external`); `sub-text` = "SRT 4" / "ASS 4" at 32 s; screenshots show the text. The embedded ASS with its font in the tail Attachments renders too. Each `sub-add` took 3–4 ms and made one `bytes=0-` request | ✓ |
| Argument list exits 0 | 0.39 / 0.40 / 0.41 | 0.41: exit 0, no parse or log errors, both parse-only and full init (the Vulkan context and the script load). 0.39 and 0.40: **not executed** (no binaries); options.rst shows 8 of 55 options differ (finding 13) | ✓ 0.41 / unverified 0.39–0.40 |
| `--input-ipc-client=fd://3` with Node `stdio[3]` pipe | works | fd 3 in mpv is a `socket:` (a socketpair); `client_name` = **`ipc`** (with `--input-ipc-server` it is `ipc_0`); RTT p50 0.041 ms, p99 0.21 ms (median of 3 × 200); mpv exits 0 within 5.5 ms of our closing the fd | ✓ |

Open/seek medians, 3 reps, 1 MiB gating (`data/results/summary.md`; 16 KiB gating in `summary-p16k.md`):

| Fixture | free: open / seek → restart | plan-gated open | plan-gated join at 300 s | S4-gated open / join | S4-gated seek |
|---|---|---|---|---|---|
| mkv-cues | 52 / 19 ms | 34 ms | 34 ms | 31 / 33 ms | blocked → watchdog 232 ms |
| mkv-nocues | 30 / 104 ms | 49 ms | 117 ms | 29 / 151 ms | 84 ms (linear read, never blocks) |
| mkv-tail | 51 / 17 ms | 56 ms | 42 ms | 50 / 41 ms | blocked → watchdog 208 ms |
| mp4-faststart | 38 / 44 ms | 36 ms | **hang** | 60 / 100 ms | blocked → watchdog 279 ms |
| mp4-tailmoov | 57 / 67 ms | 51 ms | 64 ms (hang at 16 KiB) | 41 / 55 ms | blocked → watchdog 248 ms |
| fmp4-sidx | 37 / 44 ms | **hang** | **hang** | 56 / 59 ms | blocked → watchdog 344 ms |
| fmp4-nosidx | 235 / 9 ms | **hang** | **hang** | 305 / 332 ms (whole file) | 15 ms |
| fmp4-mfra | 363 / 30 ms | **hang** | **hang** | 406 / 384 ms (whole file) | 12 ms |
| avi | 55 / 17 ms | 63 ms | 50 ms | 45 / 44 ms | blocked → watchdog 227 ms |

## 4. Findings
1. **A seek cannot get past a blocked read; only `loadfile` can.**
   - mpv's demuxer thread sits inside FFmpeg's HTTP read, which never times out with
     `network-timeout=0`. A `seek` is queued behind that read and completes only when the byte arrives:
     11–31 ms after release (`stall-*-release-seek-*.json`).
   - `loadfile … replace` interrupts the stream ("Immediate exit requested" in the mpv log) and reaches
     `playback-restart` in about 0.2 s.
   - With cache-secs=60, read-ahead blocks on the first missing piece after readyRange **whenever** the
     file is incomplete. So every seek outside the demuxer cache during a download is a "blocked seek":
     in the gated matrix 63 of 63 seeks needed the watchdog. This excludes the linear-mode files,
     whose single request reads straight through.
   - A seek inside the cached range still works while blocked: 17–27 ms, ×4
     (`stall-*-cache-seek-*.json`).
2. **An audio switch while blocked freezes playback.** `set_property aid 2` needs a refresh seek, which
   waits behind the blocked read: 0 s of progress in 3 s and `paused-for-cache=yes`, 19/19
   (`probe-blocked-ops.ts:37`, `data/results/blocked-ops.txt`). Without the switch, the same setup plays 3 s in 3 s.
   - **Recovery:** `loadfile … start=<pos>,aid=2` recovers in 187–231 ms (8/8: 4 with `aid=2`
     when aid had not been set at runtime, 4 with `aid=2,alang=jpn`).
   - **mpv quirk:** if `aid` was already set at runtime, the per-file `aid=2` of the reload is
     **ignored** and the file comes back with aid 1 (9/9 on MKV, MP4 and AVI). Adding `alang=jpn` works (4/4).
   - Setting aid on `file-loaded`, as `player-controller.ts:726` does, races the read-ahead and stalled
     1 time in 6.
   - Unblocked, the switch works and reads from `timeToByte(p − 2 s)` for MKV (`probe-aid.ts`).
3. **Destroying a blocked response does not help, and an error status is fatal.**
   - FFmpeg reconnects at the same offset ("Will reconnect at 4194304"), and the new request blocks
     again; the seek still did not complete, 3/3.
   - If that reconnect gets 404, 416 or 503, mpv treats it as **EOF** and jumps to the end of the file
     (`run-stall.ts:81-82`, `stall-*-destroy-{404,416,503}`).
   - So the server must never answer a valid range with an error status.
4. **Headers are not sent until the first body byte.** Node's `writeHead` (`server.ts:143`, and
   `stream-server.ts:194/199` in src) buffers the headers until the first write. This causes two
   problems:
   - With `network-timeout=60`, FFmpeg's reconnect fails with "Error reading HTTP response: Connection
     timed out" rather than waiting on a body.
   - FFmpeg keeps the previous connection open until the new one answers. In the gated MP4 hang cases
     that overlap lasted 15–20 s.
5. **MKV: the plan rules hold exactly** (`ranges.ts:85-86`), with Cues, without Cues, and with
   Tags/Attachments/Chapters at the tail.
   - Open reads: `bytes=0-`, then a jump to the first tail element (Cues; with mkv-tail one open-ended
     request covers Cues, Chapters, Attachments and Tags), then back to the first Cluster.
   - A seek or loadfile starts at the Cluster of the keyframe ≤ T (`probe-seek-target.ts`). The plan's
     lo (keyframe ≤ p − 2 s) is a superset, and the preroll is what the aid switch reads.
   - Without Cues, mpv seeks by reading linearly from the current position (no new request, 84–137 ms
     for 300 s), so `seekMode = linear` with lo = 0 is right.
6. **MP4: readyRange lo is too late.** mpv/lavf starts reading before the keyframe ≤ T:
   - When T falls exactly on a keyframe, it uses the previous GOP: T = 300.000 reads from
     84 842 469, which is in GOP 296–298, while the plan's lo is the keyframe at 300 s
     (85 353 283). The keyframes have a B-frame CTS offset, and this matches a dts-based backward
     search.
   - It also reads the interleaved audio packets stored in front of that keyframe: up to 46 KB before
     it in these files (mean 35 KB).
   - The rule that held at 16 KiB granularity (`ranges.ts:143-146`) is: keyframe ≤ p − 250 ms, then
     the earliest byte of any audio packet with pts ≤ that keyframe − 250 ms. hi must cover every
     stream up to the next keyframe; the audio runs up to about 80 KB past the plan's hi.
   - Tail moov: the open-critical rule holds (requests `0-`, `169347434-`, then `48-` for the mdat).
7. **fMP4 with sidx:**
   - At open FFmpeg reads `ftyp` (0–28, not in the plan's "moov, sidx, first moof") and the **last 4
     bytes** (`bytes=169802953-`, the `mfro` size). The open hangs without them.
   - Seeks start at the `moof` that contains the keyframe or its audio, which can be the previous
     fragment.
   - Fix: `[0, moovEnd)`, the sidx boxes, the first moof+mdat and `[size − 16, size)`
     (`ranges.ts:100`).
8. **fMP4 without sidx needs the whole file at open, even with an mfra trailer.** FFmpeg 9's mov
   demuxer reads every top-level box to EOF before the first frame. The mpv log shows "stream level
   seek from 169246720 to 3863", and the first request sends all 169 774 841 bytes. Under gating it
   blocked at the first gap for 20 s, 3/3 for both `fmp4-nosidx` and `fmp4-mfra`.
   - After that scan seeks are instant (9–30 ms), but playback cannot start until the file is
     complete.
   - src `mp4.ts:482` sets `seekMode = 'index'` when an mfra exists, and `mp4.ts:497` adds only the
     mfra to open-critical. Both are wrong for this case.
9. **AVI:**
   - Open reads `0-`, `idx1-` (169 846 296), then `movi`. The demuxer reads `idx1` before the first
     frame, so its whole range is open-critical.
   - "The last 2 pieces" only covers it while idx1 ≤ 2 pieces. idx1 is about 1 MB per 10 min here
     (16 bytes per chunk), so about 12.5 MB for 2 h, which is more than 2 pieces of 4 MiB. src
     `fallback.ts` already parses idx1 exactly, which is the right rule.
   - Seeks start 8 bytes before the keyframe (the chunk header).
10. **The head margin.** In these fixtures (2 Mbit/s), mpv never needed more than the plan's 256 KiB
    after the first Cluster/moov, even at 16 KiB gating with a 300 s join. src `margins.ts` keeps
    max(1 MiB, 5 s), which is a superset: harmless, and it covers its own 600 kbit/s observation,
    which S4 did not reproduce.
11. **`sub-add` blocks mpv's core while the subtitle file is incomplete.** All IPC
    (`get_property time-pos`) timed out for 12.5 s until the file was released (`run-subs.ts:57`).
    - The plan already gates `sub-add` on verified pieces; this makes that gate mandatory.
    - `sub-add` of an available file while the *video* reader is blocked works (3–11 ms, 23/23).
    - `sub-add … auto` adds without selecting.
12. **5-minute stall with `--network-timeout=60`.** FFmpeg times out every 60 s, reconnects with
    back-off (0, 1, 3 s, …) and its error reading the response headers. It did not EOF within 5 min.
    After `reconnect_delay_max` (120 s by FFmpeg default) it would presumably give up; that was not
    measured. With `=0` nothing happens at all, which is what we want.
13. **Version differences (options.rst).**
    - **`--target-colorspace-hint=auto` exists from 0.40**, not only 0.41. 0.40's default is `no`;
      0.41 changes the default to `auto` (interface-changes 0.41). 0.39 has it only as a flag.
    - **`--media-controls` (yes|player|no) and `--input-builtin-dragging` already exist in 0.39.**
    - `--load-osd-console` was renamed to `--load-console` in 0.40, and `--load-commands` and
      `--load-positioning` were added in 0.40. `--load-context-menu` is new in 0.41.
    - `--hwdec=auto-safe` is still accepted in 0.40+ (documented as "exactly the same as auto").
    - The spike's `mpv-args.ts` and `argv-check.ts` print the 0.39/0.40 variants.

## 5. Decision / fallback chosen
- **Keep `--network-timeout=0`.** The plan's fallback (`=300` plus reload on an end-file error) is not
  needed.
- **Watchdog: reload instead of seek whenever a reader is blocked.**
  - If the stream server has a blocked response for the current file and the target is outside
    `demuxer-cache-state/seekable-ranges`, sync issues `loadfile <url> replace -1 start=<t>,pause=<p>`
    directly, about 0.2–0.35 s to `playback-restart`.
  - Otherwise it uses `seek`, and keeps the 3 s watchdog as a backstop.
  - The same applies to `aid` changes: reload with `aid=<n>,alang=<lang>` in the per-file options.
- **Critical ranges** (end exclusive; the engine still rounds to pieces). Rules that held are kept;
  MP4 and fMP4 are amended:

  | Container | open-critical | seek-critical | readyRange lo |
  |---|---|---|---|
  | MKV/WebM | plan rule (held) | Cues (held) | plan (keyframe ≤ p − 2 s, Cluster start) |
  | MP4 faststart / tail moov | plan rule (held) | — | **keyframe ≤ p − 250 ms, minus the interleaved audio in front of it** (exact from the per-track sample offsets, or a 64 KiB slack); hi likewise **+ 64 KiB** |
  | fMP4 with sidx (§8.2: an index in front of the first mdat) | **`[0, moovEnd)`**, sidx boxes, first moof+mdat, **`[size − 16, size)`** | — | **moof start** of that position |
  | fMP4 without sidx (with or without mfra); since §8.2 also with a sidx per fragment | **whole file** (`seekMode = linear`) | — | 0 |
  | AVI | `[0, movi + margin)` (src rule; S4 tested piece 0), **exact idx1** | — | keyframe − 8 B |
  | External subtitles | whole file (gate `sub-add` on it) | — | — |

- **fMP4 without sidx** (and, §8.2, with a sidx per fragment): the host's index marks the file "plays after
  full download". The UI should say so and suggest a remux (`ffmpeg -i in.mp4 -c copy -movflags +faststart
  out.mp4`).
- **Subtitles:** keep `sub-add <url>` after verification. The temp-file fallback is not needed.
- **Argument list:** the version table below (§6.1). CI must still run it against real 0.39 and 0.40
  binaries.

## 6. Changes recommended for src/
src/ already contains M-milestone code written in parallel with this spike, so these diffs are
against the files as they stand today. They were not applied.

### 6.1 `src/core/player/mpv-args.ts`: options confirmed in 0.39; `auto` hint from 0.40
```diff
@@ VERSIONED_ARGS
   { since: [0, 41], args: ['--load-context-menu=no'], note: 'context menu script added in 0.41' },
-  // Plan §4.4 lists these as present in 0.39. Not verified against a 0.39 binary yet, and a wrong guess
-  // here is fatal while leaving them out on 0.39 costs nothing (window dragging only; SMTC is Windows,
-  // which always runs the bundled 0.41). Move them to COMMON_ARGS once S4 confirms.
-  { since: [0, 40], args: ['--input-builtin-dragging=no', '--media-controls=no'], note: 'S4 to confirm on 0.39' },
 ]
@@ COMMON_ARGS
   '--drag-and-drop=no',
+  // Both documented in options.rst v0.39.0 (media-controls=<yes|player|no>) — S4 options-diff.ts
+  '--input-builtin-dragging=no',
+  '--media-controls=no',
   '--terminal=no',
@@ function videoArgs
-  const modernHint = atLeast(version, 0, 41)
+  // auto|yes|no since 0.40 (default no; 0.41 made auto the default); 0.39 has a plain flag.
+  const modernHint = atLeast(version, 0, 40)
```
Version table for `mpv-args.ts` (options.rst at each tag; only 0.41 executed):

| Option | 0.39 | 0.40 | 0.41 |
|---|---|---|---|
| console script | `--load-osd-console=yes` | `--load-console=yes` | `--load-console=yes` |
| `--load-commands=no`, `--load-positioning=no` | absent (omit) | yes | yes |
| `--load-context-menu=no` | absent (omit) | absent (omit) | yes |
| `--target-colorspace-hint` | flag: `=yes` on Wayland/Windows, `=no` on X11/macOS | `=auto` | `=auto` |
| `--media-controls=no`, `--input-builtin-dragging=no` | yes | yes | yes |
| every other option in §4.4 | identical signature in all three | | |

### 6.2 `src/core/media/stream-server.ts`: send headers at once; expose blocked readers
```diff
@@ private async handle
     } else res.writeHead(200, { ...common, 'Content-Length': length })
+    // Send the headers now: FFmpeg closes its previous connection only when the new one answers,
+    // and a header read that never completes is what network-timeout would kill (ADR 0004, finding 4).
+    res.flushHeaders()
     if (req.method === 'HEAD' || length === 0) {
@@ export class StreamServer
+  /** Files whose response is waiting on a piece; the player reloads instead of seeking (ADR 0004, finding 1). */
+  private readonly blocked = new Map<number, number>()
+  isBlocked(fileIndex: number): boolean {
+    return (this.blocked.get(fileIndex) ?? 0) > 0
+  }
@@ private async body
         if (!this.source.has(piece)) {
           reader.blockedOn(piece)
-          await this.source.waitVerified(piece, signal)
+          this.blocked.set(file.index, (this.blocked.get(file.index) ?? 0) + 1)
+          try {
+            await this.source.waitVerified(piece, signal)
+          } finally {
+            this.blocked.set(file.index, (this.blocked.get(file.index) ?? 1) - 1)
+          }
         }
```
Also add a comment at `res.destroy()` (line 239): FFmpeg reconnects at the same offset. Never
answer an in-range request for an existing file with 4xx/5xx: mpv treats that as EOF (S4 finding 3).

### 6.3 `src/core/media/mp4.ts`: fMP4 open-critical
```diff
@@ indexFragmented
-  if (mfra) seekMode = 'index'
+  // FFmpeg 9 reads every top-level box to EOF at open when there is no sidx, even with an mfra
+  // trailer (S4: fmp4-nosidx, fmp4-mfra). Without sidx the file only plays once complete.
+  const scansAll = sidxBoxes.length === 0
@@
   const openCritical: ByteRange[] = [[0, moovBox.end]]
@@
-  // ffmpeg reads the mfro trailer (and then mfra) at open when the file has one
-  if (mfra) openCritical.push([mfra.pos, src.size])
+  // ffmpeg reads the last 4 bytes (mfro) at open (S4: bytes=size-4 on fmp4-sidx)
+  openCritical.push([Math.max(0, src.size - 16), src.size])
+  if (mfra) openCritical.push([mfra.pos, src.size])
+  if (scansAll) {
+    seekMode = 'linear'
+    openCritical.splice(0, openCritical.length, [0, src.size])
+  }
```
(`mfra` is then only informative.) The faststart and tail-moov rules at `mp4.ts:395-402` held.

### 6.4 `src/shared/media/media-map.ts`: readyRange for interleaved non-MKV containers
```diff
@@ constructor
-    this.prerollMs = input.container === 'mkv' || input.container === 'webm' ? MKV_SUBTITLE_PREROLL_MS : 0
+    // MKV: subtitle preroll. MP4/MOV/fMP4/AVI: lavf's backward seek lands on the previous GOP when p
+    // is on a keyframe (B-frame CTS offset), so look 250 ms further back (S4 finding 6).
+    this.prerollMs = input.container === 'mkv' || input.container === 'webm' ? MKV_SUBTITLE_PREROLL_MS : 250
@@ readyRange(pMs: number, aheadMs: number): ByteRange[] {
-    const lo = this.linear ? 0 : this.timeToByte(pMs - this.prerollMs, 'keyframe')
+    const mkv = this.input.container === 'mkv' || this.input.container === 'webm'
+    // Interleaved audio for the keyframe sits up to ~46 KB before it (S4); the index stores video
+    // offsets only. Better: store min(offset over tracks) per keyframe at index time (mp4.ts has
+    // the per-track samples already).
+    const slack = mkv ? 0 : INTERLEAVE_SLACK_BYTES // 64 KiB
+    const lo = this.linear ? 0 : Math.max(0, this.timeToByte(pMs - this.prerollMs, 'keyframe') - slack)
     const hi =
       this.kt.length > 0
-        ? this.timeToByte(end, 'nextKeyframe')
+        ? Math.min(this.fileSize, this.timeToByte(end, 'nextKeyframe') + slack)
```
For fMP4, `keyframes` already point at the moof start (sidx refs), which S4 confirmed is where reads
begin. The 8-byte AVI chunk header is covered by the slack.

### 6.5 `src/core/player/player-controller.ts`: reload instead of seek/aid when blocked
```diff
@@ seek(pos: number): Promise<void> {
+    // A seek waits behind a blocked HTTP read until the piece arrives; loadfile interrupts it and
+    // reaches playback-restart in ~0.2 s (S4). Seeks inside the demuxer cache still work.
+    if (this.deps.readerBlocked(this.expected.path) && !this.inDemuxerCache(pos)) {
+      return this.load(this.expected.path!, { start: pos, paused: this.expected.paused })
+    }
     const ipc = this.requireIpc()
@@ async setTrack(kind: 'audio' | 'sub', id: number | 'no'): Promise<void> {
     if (kind === 'audio') this.desired.aid = id
     else this.desired.sid = id
+    if (kind === 'audio' && this.deps.readerBlocked(this.expected.path)) {
+      // set_property aid needs a refresh seek, which also waits behind the blocked read (S4)
+      return this.load(this.expected.path!, { start: this.lastPos ?? 0, paused: this.expected.paused })
+    }
     await this.requireIpc().setProperty(kind === 'audio' ? 'aid' : 'sid', id)
@@ private async loadInternal
-    const fileOpts = `start=${String(Math.max(0, start))},pause=${paused ? 'yes' : 'no'}`
+    // Carry the audio choice in the loadfile itself: setting aid on file-loaded races the read-ahead
+    // (1/6 stalls in S4). mpv ignores a per-file aid= equal to an aid set at runtime earlier, so also
+    // pass alang (the track's language) when known.
+    const a = this.restoreTracks ? this.desired.aid : null
+    const fileOpts = `start=${String(Math.max(0, start))},pause=${paused ? 'yes' : 'no'}` +
+      (typeof a === 'number' ? `,aid=${String(a)}${this.aidLang(a)}` : '')
```
(and drop the `aid` line from `onFileLoaded`, `player-controller.ts:726`.) `deps.readerBlocked` is
`StreamServer.isBlocked` for viewers and `() => false` for the host, which reads a local file.

### 6.6 `src/core/media/mpv-stream-opts.ts`
No change. All options parse on 0.41 and are documented with the same signature in 0.39 and 0.40.
`--network-timeout=0` means "FFmpeg default" (no timeout for HTTP), and the measurements confirm it.

## 7. Follow-ups
- **CI (M9):** run `argv-check.ts`'s two invocations against real 0.39.x and 0.40.x binaries. S4 checked
  those versions only against the docs.
- **Fixtures S4 did not cover:**
  - fMP4 with sidx but **no** mfra: does FFmpeg still read the last bytes? (Inferred yes; untested.)
  - MOV with edit lists, WebM, HEVC 10-bit, a high-bitrate multichannel audio track (the 64 KiB slack
    scales with audio bitrate), and a poorly interleaved MP4 (audioIndexes path).
  - A 2-hour AVI (an idx1 bigger than 2 pieces).
- **M4:** feed `golden/*.ranges.json` (`openCriticalFixed`, `readyRange[t].fixed`) to the index-builder
  tests. If x264 output differs on regeneration (`golden/fixtures.sha256`), rerun `ranges.ts`.
- **mpv aid quirk** (finding 2): reduce it to a minimal reproduction and, if it is a bug, report it
  upstream. Meanwhile pass `alang` with `aid`.
- **Not tested:**
  - Windows named-pipe IPC and the Flatpak `--input-ipc-server` path.
  - Whether FFmpeg eventually EOFs with `network-timeout=60` (not needed with `=0`).
- **S6** should time the reload path (`loadfile` at a position) against the sync tolerance: it costs
  about 0.2 s more than a seek.

## 8. Applied (2026-10-19)
§6 landed in `src/`, adapted to the code as it stood. Tests: `npx vitest run --project unit src/core/player
src/core/media src/shared/media` and `npx vitest run --project integration test/integration/media
test/integration/player`.

- **§6.1 `mpv-args.ts`:** `--input-builtin-dragging=no` and `--media-controls=no` are common args, and the hint is
  `auto` from 0.40. `VERSIONED_ARGS` names the §6.1 table as its source of truth. `mpv-args.test.ts` checks every
  row for 0.39.0, 0.40.0 and 0.41.0 on four platforms, and pins the full Linux argument list of each version.
  0.39 and 0.40 are still not executed (the CI follow-up stands).
- **§6.2 `stream-server.ts`:** `flushHeaders()` after `writeHead`; `isBlocked(fileIndex)` counts the responses
  waiting on a piece and decrements in `finally`, also on abort; the 4xx/5xx comment sits at `res.destroy()`.
- **§6.3 `mp4.ts`:** as written. With a sidx, the `mfra` stays open-critical as a small superset.
- **§6.4 `media-map.ts`:** a 250 ms preroll and a 64 KiB slack on lo and hi for non-MKV containers; fMP4 starts one
  fragment earlier. **The slack was kept, not the "better" variant.** Storing min(offset over tracks) as the
  keyframe byte would also lower hi, which reuses the next keyframe's byte, and hi is already short of the golden
  `fixed` hi (below). It must also stay off for poorly interleaved files and for AVI, whose index is video-only.
  An exact rule needs per-file lead and trail bytes in the manifest behind a flag bit (follow-up).
- **New: the read-on rule** (`STREAM_SKIP_BYTES`, `MediaMap.seekByte`).
  - mpv serves a forward seek of up to `--stream-buffer-size` (1 MiB) by reading on. FFmpeg's avio does the same
    up to its TCP receive window, which autotunes to about 1 MiB on loopback.
  - A start that lies at most 2 MiB past the open-critical head is therefore reached through every byte in
    between, so lo becomes the head's end. `MediaMap` takes the manifest's `openCritical` for this.
  - Found by our gated test (`test/integration/media/gated-mpv.test.ts`). On the 30 s AVI at 13.5 s, mpv waited
    on a byte between the head and lo, every run. With every byte available, mpv sends no ranged request for
    targets up to 13.75 s and reads on from `movi`; MP4 faststart reads on from 0 through 13.5 s.
  - MKV and tail-moov MP4 seek backwards from the tail, so they never read on. S4 used 2 Mbit/s and targets of
    20 s and 300 s, and never hit it.
- **§6.5 `player-controller.ts`:** `hooks.readerBlocked` (optional, default `() => false`).
  - A seek outside the demuxer cache reloads while a read is blocked, and so does an audio switch (`setTrack` or
    the OSC's select-aid).
  - `loadfile` carries `aid` and `alang`. aid is set at `file-loaded` only when mpv did not take it, with a warning.
  - **Fixed:** after a reload with no audio choice, mpv's late `aid` notification counted as an OSC switch and
    sent a second `loadfile`.
  - **Extended to embedded subtitles:** selecting an embedded `sid` while blocked froze playback the same way
    (0 s played in 2 s, MKV with ASS). An external `sid` did not (2 s in 2 s; it has its own demuxer). An embedded
    `sid` now rides in the `loadfile`, and switching to one while blocked reloads.
  - Real-mpv tests: `test/integration/player/blocked-reader.test.ts`.
- **M4: the golden fixtures cannot be regenerated.** Two runs of `make-fixtures.sh`'s master encode on the S4
  machine (FFmpeg n9.0.2, x264 0.165.3222) gave different video bitstreams: packet MD5 `e2dfd1d1…` against
  `4e2e8482…`, while the source frames and the AAC packets matched. Neither matches `fixtures.sha256`: the second
  keyframe of `mp4-faststart` lands at 1 115 951 against the golden 1 138 826. S4's encode and two reruns
  give three sizes for `mp4-faststart.mp4`: 170 038 293 B (golden), 170 034 263 B and 170 043 892 B. So:
  - the rules are tested on our own fixtures. `index.test.ts` derives open-critical and readyRange from ffprobe
    packets and plain box walks (`s4-rules.ts`). `gated-mpv.test.ts` requires mpv to start from open ∪ seek ∪
    readyRange alone, at 16 KiB granularity, on 9 fixtures at 3 positions;
  - the golden numbers are tested where they are comparable. `s4-golden.test.ts` feeds S4's keyframes for MP4
    and AVI, which are the seek points our index stores, to `MediaMap`. lo ≤ `fixed` lo, and lies within 64 KiB of
    it, at 0, 20 and 300 s. fMP4 without sidx needs the whole file;
  - **hi against the golden data:** `fixed` hi lies 15–17 KB past our hi (next keyframe + 64 KiB) on every MP4 and
    AVI row. That is the audio stored behind the next keyframe's I-frame (up to 85 KB here), which is presented
    within 80 ms before that keyframe. It is needed only when the keyframe falls within about 80 ms after
    p + 6 s, and piece rounding usually covers it. A fixed slack cannot track I-frame size, so it was not raised.
- **Finding 2's quirk did not reproduce on mpv 0.41.0.** After a runtime switch to aid 2, a reload with `aid=2`
  alone came back as aid 2 in 6 of 6 runs: on a local file, with a blocked reader while paused, and with S4's
  exact sequence (unpause, 3 s, `pause=no`). S4's nine rows showing the quirk lack the script's `opt` field, so an
  earlier version of the script may not have passed `aid` at all. `alang` stays (harmless), and the upstream
  report is probably moot.
- **Open for the session and UI:** `needsFullDownload(manifest)` and `FASTSTART_REMUX` exist in
  `shared/media/media-map.ts`, but no event carries them (or `seekMode`) to the renderer yet.

### 8.1 Review follow-ups (2026-10-19)

- **A reload during a reload kept the track choice only partly.** `fileOptions()` looked up whether `sid` is
  embedded, and the `alang` of `aid`, in the live `track-list`. mpv empties it from a `loadfile` until the new
  demuxer opens (about 180 ms of a 220 ms reload over `StreamServer`), and sync sends a new seek while one is in
  flight, so the second `loadfile` lost `sid` and `alang`. The `set_property sid` after `file-loaded` then
  refresh-seeked behind the blocked read, and the seek never completed (time-pos 22, reader blocked, 6 s). A crash
  restart lost them the same way, because a crash clears every property. The controller now keeps the loaded
  file's last non-empty `track-list` (`fileTracks`) for these lookups. It survives a restart of the same file, a
  `load()` of another file resets it, and it ignores lists reported while mpv shows a file another client
  loaded. Tests in `blocked-reader.test.ts`: `seek(20)` then `seek(22)` from the first empty `track-list` event
  (both `loadfile`s carry `aid=2,alang=jpn,sid=1`, no `set_property`), and kill -9 with an embedded `sid` chosen.
  `mustSet()` is unchanged: setting the track mpv already has is a no-op in mpv (`mp_switch_track_n` returns
  when the track is the current one, `player/loadfile.c` in v0.41.0), so reading the value first would only
  trade one command for another.
- **`selfReload` (PlayerController option, default true).** After a crash, a reopen or another client's
  `loadfile`, both the controller and sync's member reloaded; the later `loadfile` won and the member waited
  about 6 s ahead of mpv (round-1 review). With `selfReload: false` the controller stops at `idle` after a
  restart and only emits `external-change` `'path'`; the caller's `load()` of the same URL restores the tracks.
  While mpv shows another file or is between files, its `aid`/`sid` (`"auto"` at `end-file`, then the other
  file's defaults) are no longer recorded as the user's choice: with `selfReload: false` that file stays until
  the caller reloads. The session does not pass the option yet.
- **`gated-mpv.test.ts` did not test readyRange's lo.** At 0, 10 and 13.5 s into the 30 s, 600 kbit/s fixtures,
  lo lies within the open-critical head plus `STREAM_SKIP_BYTES` in 26 of 27 cases, so the released bytes were
  one range from 0, and the test passed with the plan's lo (keyframe at or before p, no preroll, no slack, no
  earlier fragment) as well. It now also starts at 40 s and 45.5 s into 60 s at 2 Mbit/s for the six layouts
  with a seek index, after asserting lo > head end + `STREAM_SKIP_BYTES`. With the plan's lo, mp4-faststart and
  mp4-tailmoov fail at 40 s and fmp4-sidx at 40 and 45.5 s; a control case shows mp4-faststart at 40 s waiting on
  a byte between S4's lo and the plan's.
- **OSC:** the host's `done` is groupDone, so `wt-osc.lua` no longer draws the groupDone strip under the bar when
  it equals `done`.

### 8.2 Round-3 follow-ups (2026-10-19)

- **Which `sidx` boxes FFmpeg reads.** The question was whether only the first `sidx` (or those in front of the
  first moof) is read at open, so that one `sidx` per fragment need not all be open-critical. Measured with mpv
  0.41 / FFmpeg n9.0.2 through `StreamServer` (16 KiB gating, request starts logged), on the `LONG` master
  remuxed with `-movflags +dash` (a `sidx` per track in front of each 1 s fragment), the same from a 10 s GOP
  master (4 MB fragments), and that file behind a spliced `sidx` index per track (`fmp4-dash-global`):
  - FFmpeg's header read takes top-level boxes until it has seen moov and an mdat and its fragment index is
    complete. `mov_read_sidx` completes it only at a `sidx` whose first_offset is 0 and whose references end at
    EOF or where the `mfra` starts (its size: the last 4 bytes, read at the first `sidx` that does not end at
    EOF). With global_sidx that is the audio `sidx` in front (the video one has first_offset 760), so the open
    stops after the first mdat, as S4 saw. With a `sidx` per fragment it is the last fragment's audio `sidx`:
    the scan went on past the video one (first_offset 52) and stopped after it.
  - So with a `sidx` per fragment the open walks every fragment: every `sidx` and every moof. With 1 s fragments
    it read on through every mdat as well: one request from byte 1288 through the end, and with every `sidx`
    and moof released (all but the mdat bodies) it waited inside the second fragment's mdat. With 4 MB fragments
    it skipped each mdat with a new request at the next `sidx`, and opened from the `sidx` and moof boxes alone.
    The old rule (every `sidx`, the first fragment, the tail) therefore never let such a file open early: mpv
    waited on the next moof or mdat byte, and with one keyframe from the first `sidx`, `readyRange` ran to EOF.
  - After that walk a seek reads only sample data (all `trun` boxes are indexed). With an index in front, a seek
    jumps to the reference's start: with global_sidx the target moof (and the previous fragment's for audio),
    with `fmp4-dash-global` the target fragment's own `sidx` boxes (request at their offset). Both lie in
    `readyRange`, which starts at the reference one fragment earlier. No `sidx` is seek-critical.
  - A quirk not to build on: with an index for the video track only, in front of per-track `sidx` boxes per
    fragment, the audio `sidx` of the first fragment is read at open, `get_frag_time` then finds audio times
    only for that fragment, and a start at 40 s read on from the first fragment's mdat (it waited past the head).
    The fixture therefore has an index per track, as global_sidx writes it.
- **Decision (`mp4.ts`):** model the scan (`openScanEnd`, `completesFragmentIndex`). If it ends within the first
  fragment, open-critical is every box in front of the first mdat, the first moof + mdat with the margin,
  `[size − 16, size)` and the `mfra`, and `sidx` boxes further on are in neither list. If it walks past the
  first fragment (no `sidx`, or a `sidx` per fragment), the whole file is open-critical and `seekMode` is
  `linear` (`needsFullDownload`): with fragments under the read-on distance FFmpeg reads every byte, and the
  exact set for larger ones (every `sidx` and moof piece) is a large share of the pieces anyway, so the UI's
  "plays after the full download" and the remux hint are the honest answer. Tests: `mp4.test.ts` (the two
  helpers), `index.test.ts` (`fmp4-dash`: whole file, linear, keyframes from the moofs; `fmp4-dash-global`:
  head and tail only, keyframes at each fragment's first `sidx`), `gated-mpv.test.ts` (both at 0, 10 and
  13.5 s; `fmp4-dash-global` at 40 and 45.5 s of `LONG`; the `fmp4-dash` control above).
- **`selfReload: false` on another file:** the controller stayed `ready` on a file another client loaded (console
  `loadfile`/`stop`, a second IPC client), so a member holding for an absent host never reloaded ours, and a
  pending seek resolved on that file's `playback-restart`. It now rejects the pending seek as superseded, goes
  to `idle` and emits `'path'` once. In `idle` with no load of ours in flight, the other file's `file-loaded` is
  ignored: it was reported as `fileLoaded` with our path (a viewer's "file opened") and given our external
  subtitles. Tests: `player-controller.test.ts` (`loadfile` and `stop`) and `blocked-reader.test.ts` (a seek
  waiting behind a blocked read).
- **OSC:** the bridge leaves `groupDone` out of `ranges` when it equals `done` (the host case); the Lua check stays.
- **Whole-file files (`needsFullDownload`):** an fMP4 without `sidx` and one with a `sidx` per fragment. Both
  get open-critical `[0, size)` and `seekMode = linear`, so `needsFullDownload(manifest)`,
  `SessionEvent.media.fullDownload` and the `FASTSTART_REMUX` hint cover both (round-3 review: the JSDoc and §5
  still named the first only).

### 8.3 Round-4 follow-ups (2026-10-19)

- **Another client's file while our load or reload is in flight.** §8.2's fix covered `ready` with nothing in
  flight only: while our `load()` or a reload standing in for a seek waited on missing data, another client's
  `loadfile` was ignored, and that file's `playback-restart` then completed our load or seek. The controller
  ended `ready` on the other file (round-3 review, 3/3 through `StreamServer`), and sync would have settled and
  played it. The controller now tells files apart by playlist entry id instead of the `path` property:
  - mpv documents property changes as coalesced and sent only once a client's event queue is empty
    (`mpv_observe_property` in client.h, `mpv_wait_event` in client.c, both v0.41.0): `path` has no order
    against `file-loaded` or `playback-restart`. Measured anyway, with mpv 0.41 through a gated HTTP server and
    with the controller's own arguments and OSC, 220 of the runs under 20–28 busy processes plus `gated-mpv`:
    a changed `path` came before `file-loaded` in 400 of 400 loads, and a load of the same URL sent no `path`
    change at all (between two files mpv sometimes sends `null`). So `path` cannot tell another client's
    load of our own URL, and a check of it at `playback-restart` would rely on an order nothing promises.
  - A `loadfile` reply carries the new entry's `playlist_entry_id` (0.39 and 0.41: `cmd_loadfile`), and so do
    `start-file` and `end-file`. The reply is queued when the command finishes on the core thread, before the
    play loop starts that entry; measured: before its `start-file` in 480 of 480 loads. The controller takes
    it in line order (`MpvIpc` `onReply`; a promise settles after the rest of the chunk). Then: an entry that
    is not our newest loadfile's, while none of ours is unanswered, is another client's; the end of our newest
    entry (not `quit`, not a load error) with none unanswered is a `stop` or another client's `loadfile`. Both
    give our file up at once, also with a load or reload in flight: with `selfReload: false` that load, reload
    or seek rejects as `player-superseded`, the state goes to `idle` and `'path'` (now always `null`) fires
    once. (Not yet a `stop` that drops our entry before it starts, which brings neither event: round-4
    review, fixed in §8.4.) A `playback-restart` completes our requests only on our newest entry with nothing
    unanswered, and `fileLoaded`, our subtitles and track bookkeeping only count on our entries.
  - The same ordering fixed a latent race: a seek's `sent` and a reload's acknowledgement were set in a promise
    callback, so a reply and the `playback-restart` it led to, read in one chunk, left the request waiting for
    a restart that never came. Both are now set in `onReply`.
  - Tests (`blocked-reader.test.ts`, real mpv through `StreamServer`): our `load()` at a target whose pieces
    are missing, then another client loads another file, loads our own URL, or stops; a reload waiting the
    same way, then another file. Each ends `player-superseded`, `idle`, one `'path'`, and a seek of the other
    file is not reported as ours. With injected events (`player-controller.test.ts`): a restart and another
    client's `start-file`/`file-loaded`/`playback-restart` before our reply complete nothing and give nothing
    up; another client's `start-file` alone gives our file up; a seek and a reload whose reply and events come
    in one chunk complete there. All fail on the round-3 controller.
- **A late default track became the user's choice.** `blocked-reader.test.ts` "selects an embedded subtitle by
  reload while blocked" failed once in a full parallel run: its seek reload carried `aid=1,alang=eng`.
  Reproduced with logging under `gated-mpv` load (2 of 20 runs): after a reload mpv reports `aid` `"auto"`
  between the files and then the track it picked, and that report came in after `onFileLoaded` had finished,
  so the controller took aid 1 as chosen, and every later reload carried it. The test's timing assumption was
  that the pick arrives before the restore ends; nothing orders the two. Now a track counts as the user's
  only when it switches from one track (or none, `false`) to another: not from `"auto"` or nothing (after a
  restart), and not a value reported again unchanged. The test is unchanged; the new one injects the late
  pick and also checks that turning subtitles off still rides in the next reload. 20 runs of the old test
  while `gated-mpv` runs in parallel: see the round-4 report.
- **OSC:** a toast sent before the OSC is up (right after the player was created, or while it restarts) was
  dropped; the bridge now keeps the latest one and shows it at `wt-ready` if it is at most 10 s old
  (`TOAST_KEEP_MS`). A theme or perms change made after the last `init` was posted, before `wt-ready`, was
  dropped too; it is sent at `wt-ready`.
- **Docs:** the player README said `base-session.ts` did not pass `selfReload: false`; it does (§8.1's note
  predates that).

### 8.4 Round-5 follow-ups (2026-10-19)

- **A `stop` before our entry started.** §8.3 missed one case (round-4 review, 6 of 6 with mpv 0.41 through
  `StreamServer`): another client's `stop` that mpv runs after it answered our `loadfile`, while the entry before
  ours still closes. mpv runs commands while it waits for that entry's demuxer to terminate
  (`kill_demuxers_reentrant` calls `mp_idle`; about 0.2 s when the read waits on a missing piece). The `stop`
  clears the playlist, our new entry with it, so that entry gets no `start-file` and no `end-file`
  (`play_current_file` also returns before `start-file` when a stop lands during its `on_before_start_file`
  hooks). The old entry's `end-file` is not ours, and mpv's next event, `idle`, was ignored. A `load()` then stayed
  `loading` for good: sync's member keeps `loadPending` and never reloads. A seek's reload stayed `ready` on an
  empty mpv. Now `idle` with our newest `loadfile` answered, none of ours unanswered and no entry shown gives our
  file up (`onFileGone`): `player-superseded`, `idle` and one `'path'`, as for another client's file.
  - mpv sends `idle` from `idle_loop`, after the last `end-file`, once nothing is left to play (`player/playloop.c`
    in v0.39.0 and v0.41.0, and still in master). In every other case `idle` is a no-op:
    - after our entry's `end-file`, `onFileGone` already ran;
    - after a load error, the load was already rejected;
    - after a `stop` that mpv ran before our `loadfile`, our `loadfile` is still unanswered;
    - at startup and after a restart, no `loadfile` of ours was answered yet.
  - `playlist-remove current` drops our entry the same way: `current` moves to the next entry, which does not
    exist. `playlist-clear` keeps the current entry, which is ours.
  - client.h calls the event deprecated ("equivalent to observing `idle-active`"), but that property cannot
    stand in. Property changes are coalesced and read only once the event queue is empty, so `idle-active` has no
    order against our `loadfile`'s reply.
  - Tests:
    - `blocked-reader.test.ts`: a `stop` and a `playlist-remove current`, for a `load()` and for a seek's reload,
      sent the moment we handle our `loadfile`'s reply. Each ends `player-superseded`, `idle` and one `'path'`,
      with no `start-file` of our entry. A `playlist-clear` there lets our entry load.
    - `player-controller.test.ts`: 20 rounds of a `load()` and another client's `stop` sent together on a local
      file. Each round ends `ready` on our file, or `idle` on an empty mpv with one `'path'`. The reviewer's
      probe hung in 6 of 20 rounds before the fix.
    - Injected events: an `idle` before our reply, or while our entry is shown, gives nothing up.
  - Without the fix the four drop cases and the rounds hang. Without the "none unanswered" or "no entry shown"
    guard, the injected test fails.
- **Remux commands for the media notes** (`shared/media/remux.ts`: `remuxCommand(container, seekMode,
  interleave)` and `remuxFiles`). They were run with FFmpeg n9.0.2 on generated files and checked with our
  indexer; the decoded video and audio were compared with `framemd5`, and mpv played each copy:

  | Input                                                   | Command                                     | Result                                                       |
  | ------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------ |
  | MKV without Cues (through a pipe), with ASS and a font  | `MKV_REMUX`                                 | `index`, `good`; every track and the attachment kept         |
  | WebM without Cues (VP9, Opus)                           | `WEBM_REMUX`                                | `index`, `good`                                              |
  | MPEG-TS (H.264, AAC)                                    | `TS_REMUX` (into MKV)                       | `index`, `good`; same decoded video and audio                |
  | fMP4: no `sidx`, `mfra`, `dash`                         | `FASTSTART_REMUX`                           | MP4 `index`, `good`, not a full download                     |
  | fMP4 with two audio tracks, mov_text and a timecode     | the old `-c copy` only                      | second audio and subtitle **dropped**                        |
  |                                                         | `-map 0`                                    | **fails** ("Could not find tag for codec none": the timecode) |
  |                                                         | `-map 0 -map -0:d` (`FASTSTART_REMUX` now)  | all kept                                                     |
  | MP4 with the audio 9, 12, 20 or 61 s after its video    | `FASTSTART_REMUX`                           | `good` each                                                  |
  | MOV with the audio 20 s after its video                 | `MOV_REMUX`                                 | `good`                                                       |
  | MKV with the audio 8 s after its video                  | plain `-map 0 -c copy`                      | `good`                                                       |
  | MKV with the audio 20 s after its video                 | plain `-map 0 -c copy`                      | **`poor`**: the audio still 10 s late                        |
  |                                                         | `MKV_REMUX` (`-max_interleave_delta 60000000`) | `good`                                                    |
  | AVI, H.264 with B-frames (`avi.avi`)                    | plain                                       | **fails** ("Can't write packet with unknown timestamp")      |
  |                                                         | `-fflags +genpts`                           | **wrong**: 749 of 750 frames, out of order                   |
  | AVI, MPEG-4 ASP with B-frames (XviD style)              | plain / `+genpts`                           | fails / correct                                              |
  | AVI, H.264 without B-frames                             | plain                                       | correct                                                      |

  - **Does `FASTSTART_REMUX` fix a poorly interleaved MP4? Yes**, at any distance. The mov demuxer reads samples
    in time order (`interleaved_read`, seeking within the file), so the muxer receives them interleaved. The
    matroska demuxer reads in file order, and FFmpeg's interleaving queue waits at most `max_interleave_delta`
    (10 s by default) before writing video ahead. 0 would wait for a packet of every stream, a sparse or empty
    subtitle track's too, which can hold up to the whole file in memory. 60 s fixes lags up to 60 s and holds at
    most 60 s of media.
  - Every command keeps every track (`-map 0`; without it FFmpeg keeps one audio and one subtitle track) and drops
    data tracks (`-map -0:d`), which MP4 and Matroska cannot hold. The negative map is a no-op when there are
    none. `-dn` did the same with FFmpeg 9; the negative map removes mapped streams by definition, whatever the
    release. `FASTSTART_REMUX` keeps its name and gained both.
  - None for AVI. The index cannot tell MPEG-4 ASP from H.264 with B-frames (with no ffprobe it has no codecs
    at all), and `+genpts` silently breaks the latter. None for `generic` either. `TS_REMUX` fails on DVB
    teletext, which Matroska cannot hold: an error, not a silent loss.
  - Tests: `test/integration/media/remux.test.ts` runs each command as the UI shows it on generated inputs
    (`fixtures.ts`: `webm-nocues`, `mpegts`, `fmp4-tracks`, and on `LONG` `mp4-poor`, `mov-poor`, `mkv-poor`),
    plus `mkv-nocues` and `fmp4-nosidx`. A control shows the plain Matroska copy leaving the 20 s lag `poor`.
    `src/shared/media/remux.test.ts` covers `remuxCommand` and `remuxFiles`. These mutations are caught: the old
    `FASTSTART_REMUX`, no `-map -0:d`, no `-max_interleave_delta`, and no remux for MPEG-TS.
