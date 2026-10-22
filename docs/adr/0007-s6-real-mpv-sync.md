# ADR 0007: Spike S6-lite — sync precision on real mpv 0.41, measured without sound

- Date: 2026-10-20
- Status: **pass for everything this machine can measure, with three src defects (one medium, two low).**
  - **Update 2026-10-22: the three defects and Finding 6 are fixed in src** (§6 has how each was applied; the
    findings below are as measured before):
    - Finding 5: the member keeps the exact position it holds and reads audio-pts only after a pause from playback.
    - Finding 4: at a seek's or load's `playback-restart` it reads `time-pos` (`PlayerPort.readTimePos`) and starts
      from the frame mpv landed on.
    - Finding 9: `loopLagMs()` subtracts the histogram's 10 ms interval.
    - Finding 6: `seekLatMs` is timed by every exact seek whose data is local, the first replacing a 150 ms prior,
      with a 25 ms floor.
    - Finding 7 / §6.4: the first unpause probe replaces the 50 ms prior, and the first drift decision after each
      start corrects from `DRIFT.OFF` up (ADR 0008 §4.4).
    - The simulator's `FakeMpv` models Findings 4 and 5 (on by default), with a start-alignment test for both flows.
  - **Setup:** the real mpv 0.41 under the production `PlayerController`: the production argument list plus
    `--ao=null --vo=null`, JSON IPC over `fd://3`. It plays the host's path (a local file) and a viewer's path (the
    `StreamServer`), idle and next to 12 busy loops.
  - **All six measurements pass, five of them by a wide margin, idle and under load:**
    - IPC round trip p99 is 0.26–1.03 ms when quiet, and ≤ 4.9 ms in 9 of the 10 contended runs (criterion:
      5 ms). Only paused under overload (12 busy loops on top of another workflow, CPU PSI 34 %) did it reach
      5.8 ms.
    - The residual σ of the 4 Hz audio-pts fit is 0.04 ms when quiet and ≤ 0.44 ms under load (criterion:
      10 ms). time-pos alone would fail: σ ≈ 12 ms, because it is frame-quantised.
    - mpv's own unpause latency is 0.12–0.28 ms (p50); every trial lies within −2.2…+11.9 ms (criterion:
      ±20 ms). This is the null AO's latency, not a device's.
    - Speed nudges run at the set rate to within ±0.0003 % when quiet and −0.0033…+0.0056 % in all runs, measured
      against each run's own 1x rate (criterion: 0.1 %).
    - The drift loop's gate keeps 100 % of samples when quiet and ≥ 95.6 % under load.
  - **An assumption in `src/core/sync` is off:** an exact seek reaches `playback-restart` in 41–52 ms (p50), but
    the drift loop's `seekLatMs` starts at 400 ms and learns only from skips. The first catch-up skip of a session
    therefore lands ~360 ms ahead (Finding 6, §6.4).
  - **src defect (medium), Finding 5:**
    - After a pause from playback, a paused seek or load leaves audio-pts reading 111–199 ms early until the next
      unpause. That was measured on the null AO. Per mpv's code the same happens on the other push AOs, PulseAudio
      and ALSA; pull AOs (PipeWire, WASAPI, CoreAudio) are probably spared.
    - The member re-reads audio-pts when a state for the position it already holds arrives, and starts early by
      that much. End to end, starts land +165…+218 ms early in two room flows: a pause during a seek barrier, and
      a play while a member is not yet ready.
  - **src defect (low), Finding 4:**
    - An exact seek or load lands on the first frame at or after `target − 5 ms`, and playback starts there.
    - The member assumes it starts at the target. So starts after a seek are off by −5…+35 ms (25 fps), which is
      below DRIFT.ON and never corrected.
    - Its unpause-latency probe learns the same error, clamped at 0.
  - **src defect (low), Finding 9:** `createClock().loopLagMs()` counts the event-loop histogram's 10 ms timer
    interval as lag. So the gate drops samples at ~10 ms of real lag, not at the 20 ms of plan §4.5.
  - **Not measured, because nothing may make a sound:** real audio outputs (PipeWire, PulseAudio, ALSA,
    Bluetooth, WASAPI, CoreAudio), spdif, real video outputs, Windows named pipes and macOS. The plan's per-device
    criteria stay open for a real-device S6 (§7).
- Plan: §4.4 (IPC client, `sample()`, seek), §4.5 (clock, start scheduling, drift loop), §7 S6, §9 (sync simulator
  rows 2 and 9). ADR 0004 §7 (the reload-path follow-up, Finding 10).
- Spike: `spikes/s6-lite/`. Its README has every command; §8 has the re-run for a quiet period.
- Raw data: kept outside the repo, in the session scratchpad
  (`/tmp/claude-1000/-home-ram-Documents-projects-watch-together-p2p/2544c560-b9a2-48b1-83d4-60348e2ead8d/scratchpad/s6/`):
  - `main/` holds 5 contended runs (2026-10-19), and `quiet/` 1 quiet run (the night of 2026-10-19).
  - `final/` holds the 2026-10-20 matrix (one repetition), the socket run, the e2e starts (`e2e.md`, `e2e6.md`) and
    the probes (`probe-*.md`).
  - Each run has `run.json` (every sample and event, and the machine's load every second), `mpv.log` and
    `log.txt`.
  - `final/summary-all.md` pools every run; `final/summary.md` covers the 2026-10-20 runs alone.
- Environment:
  - mpv v0.41.0 (Arch build; libplacebo v7.360.1, FFmpeg n9.0.2), Node 26.6.0, Linux 6.18.55 (CachyOS LTS).
  - AMD Ryzen 7 7735HS with 14 of its 16 threads online; `powersave` governor.
  - systemd-timesyncd slews `CLOCK_MONOTONIC` (Finding 2).
  - **The machine was shared.** Another workflow ran vitest suites and eslint during most runs, outside the
    measurement lock. The 1-minute load average was 0.0–32.5 and CPU pressure (PSI some avg10) up to 57 %. Both
    were recorded every second (§3, Runs).
  - The other items' measurements took the same lock, so they never overlapped these.
  - Every run used the same hashes of the sources the numbers depend on (`player-controller.ts`, `mpv-ipc.ts`,
    `mpv-args.ts`, `mpv-stream-opts.ts`, `stream-server.ts`, `sync-ports.ts`, `drift.ts`, `member.ts`,
    `wt-osc.lua`), as they stand after round 5. None changed during a run.

## 1. Question

Is sync precise on real mpv 0.41, and do the sync engine's assumptions about mpv hold? Measured silently, on one
Linux machine, through the production player path:

1. **IPC round trip** of `get_property audio-pts` and `time-pos`: paused, playing, and under CPU load (plan: p99
   < 5 ms).
2. **Position fit:** 4 Hz samples stamped `tSend`/`tRecv`, a line fitted over 60 s of playing (plan: residual σ
   < 10 ms). Compare audio-pts with time-pos.
3. **Unpause latency:** `pause=no` → the position starts advancing (the fitted line, extrapolated back).
   Distribution and stability (plan: ±20 ms).
4. **Seek latency:** `seek absolute+exact` → the next `playback-restart`. The drift loop's `seekLatMs` EWMA
   starts at 400 ms.
5. **Speed nudges:** speed 1.02 / 0.98 (and ±5 %, the drift loop's MAXD). Does the measured rate match within
   0.1 %?
6. **The drift loop's sample gate:** IPC RTT < 15 ms and event-loop lag < 20 ms. How many samples pass under load?

Two more, because the numbers depend on them:

- **Starts end to end:** does a member's start land where the anchor says? Plan §9's simulator row 2 asks for start
  alignment p95 < 50 ms.
- **ADR 0004 §7's follow-up:** time the reload path (`loadfile` at a position) against the sync tolerance.

## 2. Method

### 2.1 Setup

- **mpv:** `PlayerController` builds and spawns the production argument list (`mpv-args.ts`). The viewer role adds
  `STREAM_ARGS` (the demuxer cache options).
  - `extraArgs` then appends `--vo=null`, `--ao=null` and `--script-opts=wt_osc-test-dims=1280x720`. These win over
    the earlier `--vo=gpu-next`.
  - JSON IPC runs over `--input-ipc-client=fd://3` (`mpv-ipc.ts`). The controller's 22 observed properties flow on
    the same socket.
  - `selfReload: false`, as the sessions run it. One run used `--input-ipc-server` instead (the Flatpak path,
    Finding 3).
- **Sources:**
  - `local` is the file path, the host's case.
  - `stream` is `StreamServer` plus a `FakeSource` with every piece verified. That is a viewer whose download is
    complete or far ahead: it measures sync, not buffering.
- **Fixture:** `fixtures.ts`'s generator with LONG's encode parameters (640×360, 25 fps, x264 at 2 Mbit/s, 1 s GOP
  with B-frames, AAC 440 Hz), made 300 s long. The `mkv-cues.mkv` remux is used.
- **Clock:**
  - Every sample is stamped by `MpvIpc` with `tSend` (just before the write) and `tRecv` (when the reply's bytes
    arrived), both on `performance.now()`. That is the clock of the session's `createClock()`. A sample's time is
    the midpoint.
  - Event-loop lag is that clock's `loopLagMs()`, read as each reply is handled, as `member.ts` reads it.
- **Commands:** pause, seek and speed go through `PlayerPortAdapter`, as the member sends them.
- **CPU load:** 12 self-ending `bash` busy loops on the 14 online CPUs, started 3 s before the protocols.
- **Machine record:** the 1-minute load average, runnable tasks and CPU PSI, every second of every run.

### 2.2 Protocols (`s6.ts`, one mpv per run, ~7.5 min)

| Protocol    | What it does                                                                                                                                                                                                                                                                                        | Feeds              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `fit`       | 30 s paused at 4 Hz. Then 62 s at 1x and 4 Hz; the line is fitted over the 60 s from 1 s after the unpause. Then speeds 1.02, 1, 0.98, 1, 1.05, 1, 0.95, 1 (25/10/25/10/15/8/15/8 s), each fitted from 1 s after its change                                                                         | (1), (2), (5), (6) |
| `pause` (A) | 20 trials. Each plays, pauses, and reads the paused position 50 and 300 ms later. It unpauses at a scheduled T with `member.ts`'s timing (`setTimeout` to T − 15 ms, then a `setImmediate` spin), then samples at 20 Hz for 3 s. The line from 0.5 s on is extrapolated back to the paused position | (3)                |
| `seek` (B)  | 20 exact seeks while paused, to random ms-precise targets. Each records the time to `playback-restart` and reads the paused audio-pts and time-pos. It then unpauses at T as in A                                                                                                                   | (3), (4)           |
| `seek` (C)  | 20 exact seeks while playing. Even trials are drift-loop skips (+1.5 s from the current position); odd ones go anywhere. Each records the time to `playback-restart` and fits the line after it                                                                                                     | (4)                |

Every sample is a pair: `PlayerController.sample()` (audio-pts, what `PlayerPortAdapter.sample` and so the drift
loop call), then `get_property time-pos`, in alternating order. Sampling runs on a `setTimeout` chain, like sync's
`every()`.

### 2.3 Starts end to end (`member-e2e.ts`)

- **Setup:** the production `SyncEngine` drives the real mpv through `PlayerPortAdapter`, as the host with no
  viewers. θ̂ is 0, the lead is the 250 ms minimum, and the bus, media and transfer ports are stubs.
- **What it measures:** after each start, it samples audio-pts every 50 ms in [+0.3 s, +1 s] after the anchor's host
  time, before the drift loop may act. It records D = audio-pts − expected.
- **Scenarios:** each of 8 reps runs six starts, with seek targets random to the ms:
  - `resume`: playing → pause → play.
  - `paused-seek`: paused → seek X → play.
  - `barrier-paused`: playing → seek X and pause in the same turn, so the seek barrier completes `paused` → play.
  - `playing-seek`: playing → seek X, and the barrier completes `playing`.
  - `wait-after-seek`: paused → seek X → play while this member is not ready (its media port says so for 1 s), as
    when a viewer is still fetching X. The room waits at X, then plays.
  - `reload-paused`: playing → pause → the same source loaded again while paused → play.

### 2.4 Probes (`probes.ts`, each under a minute)

- `landing`: 44 paused exact seeks to targets 0…39 ms past a frame. Where does time-pos land?
- `paused`: audio-pts and time-pos while paused after a fresh load, after a pause from playback, and after paused
  seeks. It was repeated with `--ao-null-buffer=0.05` and `0.5` (default 0.2).
- `speed-step`: audio-pts at ~100 Hz around each speed change.
- `reload`: 20 × (play 1 s, pause, `loadfile` at a random position, paused), local and stream. Each records the time
  to `playback-restart`, where the load lands, the paused audio-pts, and then a paused exact seek for comparison.

### 2.5 Runs

- `main/`: the matrix {local, stream} × {no load, 12 busy loops}, 5 runs on 2026-10-19 under heavy contention.
- `quiet/`: one local run at load average 0.0–0.4.
- `final/`: the matrix once on 2026-10-20, plus the e2e starts, the probes and one socket-IPC run. A second
  repetition was dropped to free the shared lock for the e2e run; every condition has ≥ 2 runs across `main/` and
  `final/`.

Every number below names its runs or conditions. `summarize.ts` pools runs by condition (source × load).

## 3. Results

11 runs (91,832 samples): 5 in `main/`, 1 in `quiet/`, and 5 in `final/` (one of them over a Unix socket), plus the
e2e starts and the probes. "Quiet run" always means the one run at load average 0.0–0.4. Rows labelled with a
condition pool every run of that condition. The tables are `summarize.ts` output, condensed.

| #   | Criterion                                                           | Target                                         | Measured                                                                                                                                                                                                                                                                                                                                                                | Pass?                                       |
| --- | ------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | IPC RTT p99, `get_property` audio-pts / time-pos over `fd://3`      | < 5 ms                                         | **Quiet run:** p50 0.08–0.16 ms, p99 0.26–1.03 ms (paused, playing, 20 Hz trials). **9 of the 10 other runs:** p99 ≤ 4.9 ms in every state; 12 busy loops alone give 1.2–2.0 ms. **Overload** (12 busy loops on top of another workflow, CPU PSI 34 %): 5.81 ms paused (n = 120), 2.05 ms playing. 7 of 91,832 samples took ≥ 15 ms (max 167 ms), all in contended runs | ✓ (✗ by 0.8 ms while paused under overload) |
| 2   | Residual σ of the 4 Hz fit over 60 s                                | < 10 ms                                        | **audio-pts:** 0.038–0.041 ms in the two quietest runs, 0.07–0.44 ms in the others; max \|residual\| 0.35–6.06 ms. **time-pos:** 11.7–12.0 ms, frame quantisation (40 ms / √12 = 11.5)                                                                                                                                                                                  | ✓ audio-pts; ✗ time-pos alone               |
| 3   | Unpause latency, stable to                                          | ±20 ms                                         | **mpv with the null AO:** p50 0.12 ms quiet (σ 0.13, range 0.10–0.70 ms), 0.15–0.28 ms per condition. All 200 A and 200 B trials lie within −2.2…+11.9 ms. **Scheduling:** the command goes out 0.01 ms (p50) after T when quiet, ≤ 9.3 ms after it under load                                                                                                          | ✓ mpv side; devices open (§7)               |
| 4   | Exact seek → `playback-restart`, where `seekLatMs` starts at 400 ms | —                                              | p50 40.8–52.4 ms playing, 40.9–46.4 ms paused; p95 ≤ 120 ms, max 208 ms. Local and stream alike, and the busy loops did not slow it                                                                                                                                                                                                                                     | the prior is ~8× too high (Finding 6)       |
| 5   | Speed nudge rate                                                    | within 0.1 %                                   | **Against the run's own 1x rate:** within ±0.0003 % quiet, −0.0033…+0.0056 % in all runs (the +0.0056 % segment contains an NTP rate step). **Against nominal:** −0.0144…+0.0013 %, NTP slew included (Finding 2). No `audio-reconfig`                                                                                                                                  | ✓                                           |
| 6   | Gate (RTT < 15 ms and loop lag < 20 ms) keeps                       | —                                              | 100 % in the four least contended runs and 95.6–99.4 % in the others. Every rejection was for loop lag, none for RTT. 99.0–100 % if `loopLagMs()` excluded its 10 ms timer interval (Finding 9)                                                                                                                                                                         | ✓ (and a defect)                            |
| e2e | Start alignment: D 0.3–1 s after a start                            | p95 < 50 ms (plan §9 row 2, for the simulator) | **`resume`, `paused-seek`, `playing-seek`:** −4.4…+36.8 ms; once the 50 ms unpause prior has converged, D = where the seek landed, ±1 ms. **`barrier-paused`:** +175…+218 ms in 6 of 8. **`wait-after-seek`:** ⟨e2e6⟩                                                                                                                                                   | ✗ in two flows (Finding 5)                  |

### Runs, and IPC round trip per run

p99 in ms, audio-pts / time-pos; 4 Hz samples paused and playing, and 20 Hz samples in the trials.

| dir       | condition                       | started (UTC)    | load avg 1 min | CPU PSI avg10, % mean / max | p99 paused      | p99 playing     | p99 20 Hz       |
| --------- | ------------------------------- | ---------------- | -------------- | --------------------------- | --------------- | --------------- | --------------- |
| main      | local                           | 2026-10-19 19:03 | 1.2–13.0       | 3.9 / 18.1                  | 2.52 / 2.54     | 0.70 / 0.73     | 1.77 / 1.45     |
| main      | stream                          | 2026-10-19 19:11 | 2.3–9.4        | 5.2 / 36.0                  | 0.88 / 1.89     | 0.88 / 0.81     | 1.85 / 1.85     |
| main      | local, 12 loops                 | 2026-10-19 19:18 | 4.0–32.5       | 22.2 / 57.0                 | 2.58 / 2.11     | 2.04 / 2.23     | 2.32 / 2.34     |
| main      | stream, 12 loops                | 2026-10-19 19:25 | 17.2–30.2      | 31.0 / 51.9                 | 4.89 / 2.04     | 2.38 / 2.19     | 2.98 / 2.99     |
| main      | local (r2)                      | 2026-10-19 19:33 | 12.5–29.4      | 23.6 / 45.2                 | 3.04 / 3.26     | 2.15 / 3.05     | 2.42 / 2.50     |
| **quiet** | local                           | 2026-10-19 23:04 | **0.0–0.4**    | **0.1 / 2.2**               | **0.26 / 0.32** | **0.59 / 0.51** | **0.43 / 1.03** |
| final     | local                           | 2026-10-20 18:01 | 1.6–4.7        | 1.8 / 23.5                  | 1.24 / 0.94     | 0.79 / 1.19     | 1.30 / 1.82     |
| final     | stream                          | 2026-10-20 18:08 | 1.7–14.2       | 5.7 / 24.1                  | 0.48 / 0.41     | 2.01 / 1.59     | 2.21 / 2.19     |
| final     | local, 12 loops                 | 2026-10-20 18:18 | 14.7–26.5      | 33.9 / 37.8                 | **5.81** / 3.65 | 2.05 / 2.98     | 2.49 / 2.44     |
| final     | local, Unix socket (`fit` only) | 2026-10-20 18:25 | 2.9–25.2       | 1.8 / 23.1                  | 1.66 / 1.95     | 1.09 / 0.74     | –               |
| final     | stream, 12 loops                | 2026-10-20 18:45 | 1.7–15.3       | 4.0 / 15.3                  | 1.65 / 1.16     | 1.99 / 1.99     | 1.99 / 2.04     |

- **p50:** 0.08–0.20 ms in every run and state.
- **Load:** the 1-minute load average includes our own 12 busy loops, so PSI is the better measure of contention.

### (2) The 60 s fit at 1x, per run

| run                               | audio-pts σ, ms | max \|res\|, ms | rate − 1, ppm (Finding 2) | median-of-5 p99 \|D\|, ms | time-pos σ, ms | time-pos − audio-pts, ms: mean (min…max) | time-pos median-of-5 p99 \|D\|, ms |
| --------------------------------- | --------------- | --------------- | ------------------------- | ------------------------- | -------------- | ---------------------------------------- | ---------------------------------- |
| quiet, local                      | 0.041           | 0.37            | −26.7                     | 0.021                     | 12.02          | 22.3 (0.1…49.2)                          | 36.6                               |
| final, local                      | 0.038           | 0.35            | +3.9                      | 0.036                     | 11.81          | 20.8 (−0.1…46.6)                         | 32.5                               |
| final, stream                     | 0.070           | 0.71            | −81.7                     | 0.034                     | 11.89          | 21.2 (0.2…46.2)                          | 34.1                               |
| final, socket                     | 0.145           | 1.77            | −29.7                     | 0.059                     | 11.68          | 20.0 (−0.9…46.3)                         | 30.1                               |
| final, stream, 12 loops           | 0.165           | 0.96            | +10.3                     | 0.040                     | 11.91          | 21.4 (−0.3…47.9)                         | 36.1                               |
| final, local, 12 loops (PSI 34 %) | 0.444           | 6.06            | −39.4                     | 0.139                     | 11.99          | 20.2 (−3.0…45.7)                         | 31.5                               |
| main, local / local r2            | 0.115 / 0.183   | 1.40 / 1.75     | −19.5 / −11.4             | 0.032 / 0.040             | 11.85 / 11.95  | 22.5 / 21.2                              | 36.3 / 33.3                        |
| main, stream / stream, 12 loops   | 0.175 / 0.210   | 1.09 / 1.42     | −6.2 / −8.1               | 0.250 / 0.047             | 11.99 / 11.96  | 21.1 / 19.7                              | 34.0 / 31.2                        |
| main, local, 12 loops             | 0.166           | 1.42            | −2.2                      | 0.058                     | 12.01          | 21.4 (−1.2…49.6)                         | 35.9                               |

### (3) Unpause at a scheduled T, after a pause while playing (A trials)

p50 / p95 / min…max, in ms. The latency is the time from the command until the new line reaches the paused
audio-pts.

| condition        | n   | command after T         | unpause latency (σ)             | start after T             | member's estimate − latency | paused audio-pts − line at the pause |
| ---------------- | --- | ----------------------- | ------------------------------- | ------------------------- | --------------------------- | ------------------------------------ |
| quiet run        | 20  | 0.01 / 0.04 / 0.01…0.09 | 0.12 / 0.19 / 0.10…0.70 (0.13)  | 0.14 / 0.27 / 0.11…0.71   | 0.00 / 0.02 / −0.04…0.02    | 0.11 / 0.15 / 0.06…0.71              |
| local (4 runs)   | 80  | 0.02 / 1.00 / 0.01…6.67 | 0.15 / 0.57 / −0.05…2.41 (0.35) | 0.20 / 2.26 / 0.06…8.54   | 0.00 / 0.08 / −0.82…0.18    | 0.12 / 0.41 / −0.23…6.24             |
| local, 12 loops  | 40  | 0.74 / 5.92 / 0.01…9.27 | 0.17 / 1.54 / 0.01…6.04 (1.00)  | 0.87 / 9.73 / 0.03…11.71  | 0.03 / 0.13 / −0.37…0.17    | 0.10 / 0.45 / −0.16…0.91             |
| stream           | 40  | 0.01 / 1.88 / 0.00…4.79 | 0.16 / 1.25 / 0.06…11.88 (1.96) | 0.17 / 4.60 / 0.07…11.89  | 0.00 / 0.12 / −0.28…0.40    | 0.11 / 0.31 / −0.02…1.04             |
| stream, 12 loops | 40  | 0.02 / 4.24 / 0.01…8.56 | 0.18 / 0.96 / −0.03…3.30 (0.55) | 0.28 / 4.50 / −0.02…11.86 | 0.00 / 0.17 / −0.86…0.44    | 0.11 / 1.06 / −0.10…2.04             |

- **Member's estimate:** `member.ts`'s own probe, which takes the first gated sample ≥ 300 ms after the command, with
  the paused audio-pts as `fromPos`. It matches the fitted latency to within 0.9 ms.
- **While paused:** audio-pts did not move at all between 50 and 300 ms after the pause (0.000 ms in all 200
  trials).

### (4) Exact seeks: p50 / p95 / min…max, in ms

| condition        | kind (n)            | seek → `playback-restart` | where it lands: time-pos − target | D after a skip, `seekLatMs` = 400 (prior) | … = 100 (floor)          | … = this seek's latency |
| ---------------- | ------------------- | ------------------------- | --------------------------------- | ----------------------------------------- | ------------------------ | ----------------------- |
| local            | paused, B (80)      | 45.0 / 82.6 / 18.1…123.1  | 13.5 / 33.0 / −5.0…34.0           |                                           |                          |                         |
| local, 12 loops  | paused, B (40)      | 41.3 / 57.5 / 20.3…68.1   | 12.0 / 33.0 / −4.0…34.0           |                                           |                          |                         |
| stream           | paused, B (40)      | 46.4 / 83.9 / 22.7…94.6   | 21.0 / 33.1 / −5.0…35.0           |                                           |                          |                         |
| stream, 12 loops | paused, B (40)      | 40.9 / 66.2 / 20.6…81.5   | 21.0 / 33.1 / −5.0…35.0           |                                           |                          |                         |
| local            | skip +1.5 s, C (40) | 48.8 / 119.8 / 26.0…208.3 |                                   | 363.5 / 388.1 / 215.1…391.1               | 63.5 / 88.1 / −84.9…91.1 | 16.1 / 30.2 / −4.6…33.1 |
| local, 12 loops  | skip +1.5 s, C (20) | 40.8 / 63.5 / 20.8…68.0   |                                   | 370.3 / 389.1 / 343.7…392.6               | 70.3 / 89.1 / 43.7…92.6  | 11.2 / 31.3 / −3.2…31.8 |
| stream           | skip +1.5 s, C (20) | 52.4 / 76.6 / 20.2…88.8   |                                   | 363.0 / 391.4 / 313.3…412.3               | 63.0 / 91.4 / 13.3…112.3 | 11.4 / 34.1 / −5.3…34.8 |
| stream, 12 loops | skip +1.5 s, C (20) | 50.7 / 65.8 / 23.7…66.3   |                                   | 376.2 / 390.4 / 335.7…400.3               | 76.2 / 90.4 / 35.7…100.3 | 15.4 / 32.3 / −3.9…35.6 |

- **How D is computed:** a skip seeks to `expected(now + seekLatMs)`, so right after it D = `seekLatMs` − (the time
  until the line after the seek passes the target). The last three columns evaluate that for the prior, for the
  floor, and for a perfectly learned value.
- **Seeks to anywhere** (C, odd trials) take the same time: p50 41.6–51.6 ms.

### (5) Speed nudges

The rate is measured from 1 s after each change, against the set speed. "vs 1x" divides by the same run's 1x rate,
which removes the NTP slew of Finding 2.

|                                    | 0.95              | 0.98              | 1.02              | 1.05              |
| ---------------------------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| quiet run, vs 1x                   | −0.0003 %         | −0.0003 %         | −0.0001 %         | −0.0002 %         |
| all runs (11 segments each), vs 1x | −0.0023…+0.0030 % | −0.0006…+0.0008 % | −0.0013…+0.0056 % | −0.0033…+0.0015 % |
| all runs, vs nominal               | −0.0128…+0.0009 % | −0.0144…+0.0010 % | −0.0086…+0.0013 % | −0.0137…+0.0010 % |
| the change takes effect after      | 358–419 ms        | 366–400 ms        | 366–414 ms        | 371–426 ms        |

time-pos rates are frame-quantised and lie within 0.18 %.

### (6) The gate on `sample()` while playing (4 Hz)

| condition          | samples | kept    | dropped for lag | dropped for RTT | `loopLagMs()`, ms: p50 / p99 / max | kept if the lag excluded the 10 ms interval |
| ------------------ | ------- | ------- | --------------- | --------------- | ---------------------------------- | ------------------------------------------- |
| quiet run          | 712     | 100.0 % | 0               | 0               | 11.4 / 12.4 / 12.5                 | 100.0 %                                     |
| local (4 runs)     | 2,848   | 99.2 %  | 0.8 %           | 0               | 11.6 / 18.4 / 28.3                 | 100.0 %                                     |
| local, 12 loops    | 1,424   | 98.4 %  | 1.6 %           | 0               | 13.0 / 20.3 / 24.6                 | 100.0 %                                     |
| stream             | 1,424   | 99.4 %  | 0.6 %           | 0               | 11.5 / 17.0 / 59.6                 | 99.7 %                                      |
| stream, 12 loops   | 1,424   | 96.7 %  | 3.3 %           | 0               | 12.7 / 28.2 / 30.2                 | 99.5 %                                      |
| local, Unix socket | 712     | 100.0 % | 0               | 0               | 11.5 / 13.0 / 13.9                 | 100.0 %                                     |

- **Per run:** 95.6–100 % kept, and 99.0–100 % without the interval.
- **No fallback:** `sample()` never fell back to time-pos.

### Starts end to end (`member-e2e.ts`)

| scenario          | quiet run (load avg 0.4–0.8): D, ms, median (min…max) of 8 | D − where the seek landed, ms                         | extended run (⟨load⟩): D, ms, median (min…max) of 8 |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------- |
| `resume`          | +1.7 (+0.5…+35.8)                                          | —                                                     | ⟨⟩                                                  |
| `paused-seek`     | +6.4 (−1.8…+36.8)                                          | +0.1…+34.8: the unpause prior converging              | ⟨⟩                                                  |
| `playing-seek`    | +20.3 (−4.4…+36.2)                                         | −0.4…+16.8: the same                                  | ⟨⟩                                                  |
| `barrier-paused`  | **+178.3** (+17.7…+218.1)                                  | **+148…+204 in 6 of 8**; +9.7 and +1.2 in the other 2 | ⟨⟩                                                  |
| `wait-after-seek` | —                                                          | —                                                     | ⟨⟩                                                  |
| `reload-paused`   | —                                                          | —                                                     | ⟨⟩                                                  |

## 4. Findings

1. **audio-pts is a near-perfect clock for sync; time-pos is frame-quantised.**
   - Over 60 s at 4 Hz the audio-pts residual σ is 0.04 ms quiet, 0.07–0.21 ms in contended runs and 0.44 ms under
     overload, where the largest single residual is 6.1 ms. The drift loop's median-of-5 D then has p99 |D|
     ≤ 0.25 ms, far below DRIFT.OFF (15 ms).
   - time-pos is the shown frame's pts. Its σ is 11.7–12.0 ms (40 ms / √12 = 11.5 ms), and it leads audio-pts by
     a mean of 20–23 ms (−3…+50 ms).
   - `sample()` uses time-pos only when audio-pts fails (no audio). Such a member sees a median-of-5 p99 |D| of
     31–37 ms: under DRIFT.ON (60 ms), so no false corrections, but a ~21 ms bias.
   - Plan §7's criterion holds for audio-pts by a factor of 20 (overload) to 250 (quiet). It would fail on time-pos.
2. **mpv's clock and ours are different kernel clocks.**
   - mpv 0.41 times everything on `CLOCK_MONOTONIC_RAW` (`osdep/timer-linux.c`, `mp_raw_time_init`), and so does
     the null AO's simulated device. `performance.now()` is `CLOCK_MONOTONIC`, which NTP slews.
   - The fitted rate − 1 is therefore systemd-timesyncd's correction of the moment, −82…+10 ppm across the runs.
     - In one run it stepped from +4 to −145 ppm within one 5 s window (2026-10-20 18:03 UTC), at constant load.
     - A check right after measured `CLOCK_MONOTONIC_RAW` running −59.6 ppm against `CLOCK_MONOTONIC`.
   - With a real device the audio clock is the device's crystal, so the drift loop sees the crystal's ppm plus the
     NTP slew. Both are what the loop and plan §9's row 9 (100 ppm skew) are for. It matters here only for how to
     read rates: speed errors are given against the run's own 1x rate.
3. **IPC is fast enough even when the machine is not.**
   - The p50 is 0.08–0.20 ms in every run and state, and the p99 is 0.26–1.03 ms in the quiet run.
   - 12 busy loops alone (PSI 4 %) leave the p99 at 1.2–2.0 ms. Both runs above 4 ms had another workflow's load on
     top (PSI 31–34 %), and both were paused: 4.89 and 5.81 ms. That last one exceeds plan §7's 5 ms, by 0.8 ms.
   - Under contention, paused round trips have the longer tails. That fits a request having to wake mpv's waiting
     core thread first.
   - Only 7 of 91,832 samples took ≥ 15 ms (21, 21, 23, 28, 51, 54 and 167 ms), all in contended runs.
     - These data cannot tell whether mpv or our event loop was descheduled. `tRecv` is stamped when Node handles
       the reply, which can come before the lag histogram's timer notices a stall.
     - DRIFT.MAX_IPC_RTT_MS (15) dropped none of the drift loop's 4 Hz samples.
   - **Unix socket:** one `fit` run used `--input-ipc-server` (the Flatpak path) at load average 2.9–25.2 (PSI mean
     1.8 %). It matches `fd://3`:
     - p50 0.15–0.20 ms, p99 1.66 / 1.95 ms paused and 1.09 / 0.74 ms playing (audio-pts / time-pos);
     - audio-pts fit σ 0.145 ms.
4. **src defect (low): an exact seek lands on the first frame at or after `target − 5 ms`, and playback, audio
   included, starts there. The member assumes the target.**
   - **The rule:** the `landing` probe matched it in 44 of 44 targets: 4.9 ms past a frame lands on that frame,
     5.1 ms past it on the next. The B trials matched in 196 of 200 and the `reload` loads in 40 of 40. All 4
     misses were the same target, 173.805 s, exactly 5.000 ms past a frame: a rounding tie (the stream runs with
     seed 1).
   - **Audio starts at the frame:** after an unpause, the audio-pts line passes the paused time-pos 0.17–0.42 ms
     after the command (B trials), which is the same latency as from a pause (A trials).
   - **The member assumes the target:** `onPlaybackRestart` keeps `actual: loadedAt` (its comment says "mpv is
     paused exactly at the load position"), and `settle` keeps `actual: pos` after a seek. So every start after a
     seek or load is off by where the frame landed: −5…+35 ms at 25 fps (−5…+36.7 ms at 24 fps). The e2e shows it:
     `paused-seek` and `playing-seek` D track that offset to ±1 ms once the unpause prior has converged.
   - **Effects:** this stays below DRIFT.ON (60 ms), so the drift loop never removes it. It is harmless while every
     member seeks to the same target in the same file: all land on the same frame. It separates members that start
     from different seeks (a rendezvous, a late joiner, a skip) by up to a frame + 5 ms.
   - **It also biases the unpause-latency probe.** `fromPos = target` makes the probe measure latency − (frame −
     target), clamped at 0. In the B trials that was −11.7…−20.9 ms (p50) before the clamp.
     - So after seeks the EWMA learns too low a latency.
     - On a device with a real start latency L, it learns about L − 15 ms on average after a seek. Later `resume`
       starts, which use the exact paused audio-pts, would then start up to 35 ms late.
5. **src defect (medium): after a pause from playback, a paused seek or load makes audio-pts read 0.11–0.20 s early,
   and the member starts from that value.**
   - **mpv's behaviour (null AO):**
     - After playing and pausing, an exact seek while paused leaves audio-pts below the target. B trials: −111…−199 ms,
       p50 −153…−171 ms. time-pos sits on the landing frame.
     - The `reload` probe shows the same for a `loadfile` after playing and pausing: −155…−191 ms (40 loads, local
       and stream), already at the load's `playback-restart`.
     - The value stays until the next unpause. The `paused` probe got −175.8 ms after three successive paused
       seeks, and −146.8 ms after a further 30 ms of playing and a pause.
     - It is the AO's buffered delay at the moment of the pause, and follows the buffer's size. After a paused
       seek it measured −16…−19 ms with `--ao-null-buffer=0.05`, −147…−176 ms with the default 0.2 and −443…−473
       ms with 0.5 (`paused` probe).
     - It is absent on a fresh AO: before the first play, a paused seek reads the landing frame.
   - **Why:** mpv's `audio/out/buffer.c` (0.41) keeps the device state from the moment of pausing
     (`get_dev_state(ao, &p->prepause_state)` in `ao_set_paused`). While the AO is paused and playing,
     `get_dev_state` returns that state, for push AOs (those with a `write` callback). `ao_get_delay` uses it, and
     audio-pts = written pts − speed × delay.
     - So after a seek the old buffer's delay is subtracted from the new position.
     - **Push AOs** (the driver sets `.write`): null (buffer 0.2 s), ALSA and **PulseAudio** (`ao_pulse.c`). The null
       AO measured it; ALSA and PulseAudio take the same path. Users whose mpv opens PulseAudio or ALSA get it, and
       so does every test that runs mpv with `--ao=null`.
     - **Pull AOs** (the device's callback calls `ao_read_data`): PipeWire, WASAPI and CoreAudio. `ao_get_delay`
       takes their delay from the last callback's end time, not from `prepause_state`, so they probably do not show
       it. That is unverified (§7).
   - **Where the member reads it:**
     - `settle()` (`member.ts:385–411`) handles every paused, waiting or ended state. When mpv already sits within a
       frame of the state's position, it takes the "close enough not to seek" branch. That branch replaces the
       position with `player.sample()`, even when that position is the member's own completed seek or load (`act`
       is `settle`, `actual === pos`).
     - `beginPlay()` (`member.ts:446–448`) then starts from `a.actual` with `exact = true`.
     - Its re-seek check (`member.ts:465`, `anchorLocal − now > seekLatMs + 100`) cannot pass at the 250 ms
       minimum lead, because `seekLatMs` is 400.
     - So the unpause is scheduled from a position ~170 ms behind mpv's: the member starts that much early. The
       unpause-latency probe is fed the same error, clamped at 0.
   - **Which room flows reach it:** a new state for the same position after a member's own seek.
     - **A pause during a seek barrier** (waiting → paused at X): `barrier-paused`, D +175…+218 ms in 6 of 8 starts.
       For the other 2, see the next bullet but one.
     - **A play while any member is not ready after a paused seek.** `play()` opens a barrier at the same position
       (paused → waiting), and every ready member re-settles. This is `wait-after-seek`: D ⟨e2e6⟩ ms. With real
       viewers it is common: the host seeks while paused and presses play before a viewer has fetched the new
       position.
     - **Loads escape by an accident of event order** (`reload-paused`, D ⟨e2e6⟩).
       - At a load's `playback-restart` audio-pts is already stale (`reload` probe: −155…−191 ms at the restart).
       - But mpv sends the `seeking` = false property change after the `playback-restart` event. So
         `settle()`, which `onPlaybackRestart` reaches through `reconcile()`, still sees `snapshot().seeking`.
       - It issues a redundant exact seek to the same position, and `actual` becomes the target. mpv's log shows
         that seek within 1 ms of every load's restart (`member-e2e` `mpv.log`).
       - A state for the same position that arrives later reads the stale value. A barrier that completes within
         those few ms escapes the same way, which explains `barrier-paused`'s 2 low starts if their re-settle came
         that soon after the seek's restart (⟨e2e6 resettle⟩).
   - **Effect:** each member starts early by its own stale delay: 111–199 ms here, depending on how full the buffer
     was when it paused. So the members also end up as much as ~85 ms apart.
     - The drift loop acts only after its 1 s hold and 5 samples (~2.3 s).
     - It then needs ~7 s of nudging to get under DRIFT.OFF: 0.95 at first, then proportional with a 3 s time
       constant (GAIN 1/3000).
     - That is ~9 s of a start that is off, then a tempo change of up to 5 %.
   - It breaks plan §9's start-alignment target in these flows. The fix is in §6.1.
6. **Exact seeks take ~50 ms; `seekLatMs` assumes 400 ms.**
   - **Measured:** seek → `playback-restart` has p50 41–52 ms and p95 ≤ 120 ms (max 208 ms), playing or paused,
     local or stream, quiet or with 12 busy loops. This is a 1 s GOP at 360p: heavier content (long GOPs, 4K,
     software decoding) takes longer, which is why the value is learned.
   - **Effects:**
     - The first catch-up skip of every session uses the 400 ms prior, so it lands **+361…+376 ms ahead** (p50;
       +215…+412 ms over all trials). The loop then needs ~11 s to bring it under DRIFT.OFF: ~4 s at 0.95, then
       ~7 s of proportional nudging.
     - The EWMA learns only from skips (`noteSeekDone` is called in the `skip` branch alone), so most sessions never
       learn it.
     - Its 100 ms floor still leaves every skip ~60–75 ms ahead (p50 +62…+76 ms), just above DRIFT.ON.
     - `beginPlay`'s corrective re-seek never fits in a 250 ms lead.
   - **With a learned value**, a skip lands +8…+18 ms ahead (p50): the frame landing of Finding 4.
7. **mpv's own unpause latency is a fraction of a millisecond; the member's 50 ms prior costs the first starts.**
   - **Measured:** with the null AO, the line after `pause=no` reaches the paused position 0.12–0.28 ms (p50) after
     the command: 0.12 ms with σ 0.13 ms quiet, and every trial between −2.2 and +11.9 ms.
   - **Scheduling:** with `member.ts`'s method (a `setTimeout` to 15 ms early, then a `setImmediate` spin), the
     command goes out 0.01 ms (p50) after T when quiet, and ≤ 9.3 ms after it under load.
   - **The prior:** `UNPAUSE_LAT_INIT_MS` (50) is learned with α = 0.3. The first start after a fresh member is ~50
     ms early, and the next ones +36, +25, +17, +12… ms (e2e: `resume` rep 0 +35.8 ms, rep 3 +1.8 ms).
   - Real devices add their own start latency, which this cannot measure (§7).
8. **Speed changes are exact and take effect after the AO's buffer drains.**
   - The rate matches the set speed to within −0.0033…+0.0056 % of the run's 1x rate (§3 (5)).
   - A change shows up 358–426 ms after the command: the null AO's 0.2 s buffer plus mpv's own queue.
   - At the command audio-pts steps by about −Δspeed × that delay: −7.7 ms for 1 → 1.02, −20.5 ms for 1 → 1.05
     (`speed-step` probe). mpv applies the new speed to the audio still buffered (audio-pts = written − speed ×
     delay); the step corrects itself within that delay.
   - **For the drift loop:** the step is ≤ 20 ms at MAXD and in the direction of the correction, and the delay is
     well inside the loop's ~3 s time constant (GAIN 1/3000). No change is needed.
9. **src defect (low): `loopLagMs()` reports 10 ms of lag on an idle loop.**
   - **Why:** `createClock()` (`sync-ports.ts:34, 52`) uses `monitorEventLoopDelay({ resolution: 10 })`. Node's
     histogram records the whole interval between its timer's runs, not the delay beyond it.
     - An idle loop reads a median of 10.1 ms (9.1–12.2 ms over four 2 s checks), and 20.2 ms at resolution 20.
     - A 5 ms block every 100 ms reads a max of 15.3 ms.
   - **In the data:** `loopLagMs()` never read below 10.41 ms in 91,832 samples (quiet: 10.61–12.53 ms).
   - **Effect:** `DriftController.offer` drops samples at `loopLagMs() ≥ 20`, so it drops them at ~10 ms of real lag,
     where the `Clock` port and plan §4.5 say 20 ms.
   - Under contention that dropped up to 4.4 % of a run's 4 Hz samples; with the interval removed, at most 1.0 %.
     Harmless at these levels, but the gate is twice as strict as designed. The fix is in §6.3.
10. **The reload path (ADR 0004 §7): a `loadfile` at a position takes ~80 ms, 20–40 ms more than an exact seek,
    and lands like one.**
    - **Timing** (`reload` probe, 20 loads each, every piece present):
      - Load → `playback-restart`: p50 79.9 ms, p95 131.4 ms, max 137.5 ms (local); p50 87.4 ms, p95 125.4 ms, max
        129.6 ms (stream).
      - The paused exact seek right after each load: p50 60.9 ms (local) and 58.6 ms (stream).
      - The B trials' seeks: 41–46 ms (p50).
      - ADR 0004 measured 164–344 ms (medians) for a reload through a _blocked_ stream, the watchdog's case.
    - **Landing:** by Finding 4's rule in 40 of 40 loads (time-pos − target: −2…+29 ms). After playing and pausing,
      the paused audio-pts is stale as in Finding 5, already at the restart: −155…−191 ms.
    - **Against the sync tolerance:** the member loads paused and schedules its start from the load's restart. The
      load time is spent before the start, not in it, so it costs readiness time, not alignment.

## 5. Decision

- **Plan §7 S6 criteria:** S6-lite passes every criterion this machine can measure, for mpv's side of sync.
  - IPC RTT p99 has a margin of 5–20× when quiet, and stays under 5 ms in 10 of the 11 runs. The exception is
    paused under overload, which missed by 0.8 ms.
  - The audio-pts fit has a margin of 20–250×.
  - So the plan's fallback (widen the ON/OFF band) is not needed for that reason.
- **Fix in src:** the member's start positions need two corrections, the medium defect (§6.1) and the landing frame
  (§6.2). The gate's lag measure needs one (§6.3). `seekLatMs` needs to learn from every seek (§6.4).
- **Still open for a real-device S6 (§7):** the plan's per-device criteria (unpause → sound on PipeWire, WASAPI,
  CoreAudio and Bluetooth; spdif) and the pull-AO question of Finding 5.

## 6. Changes recommended for src/

Not applied: this item may not edit `src/`. Each is small.

**Applied 2026-10-22** (the original recommendations stay below as written):

- **6.1** as proposed (`exactPausedAt` in `settle()`), with the seek's position now the landed frame (6.2).
- **6.2** through a new port call, `PlayerPort.readTimePos()` (a `get_property time-pos`; the session's adapter
  adds `getProperty` to `PlayerLike`). The read is sent at the `playback-restart` and the act completes when it
  answers; mpv's observed `time-pos` still shows the target then and changes ~50 ms later. A read more than a frame
  from the target keeps the target. Loads take the same path, and their "replaced by another loadfile" check now
  uses the read too. Skips are not aimed at frame boundaries (the optional part).
- **6.3** as proposed, with the histogram injectable for the unit test.
- **6.4** `SEEK_LAT_INIT_MS` 150, `SEEK_LAT_MIN_MS` 25, the first timed seek replacing the prior; seeks are timed
  only when their data is local (`bufferedAheadS ≥ 2 s`, as for a skip), so a seek waiting for a download does not
  inflate it. The first unpause probe replaces its prior. `UNPAUSE_LAT_INIT_MS` stays 50.
- **6.5** `landing: 'frame'` and `stalePausedMs: 170`, both on by default; `test/sync/drift.test.ts` has the start
  alignment of both Finding 5 flows (and `test/sync/member.test.ts` the deterministic cases).

**6.1 `src/core/sync/member.ts` `settle()`: keep the exact position the member already has** (Finding 5, the
medium defect). Re-read audio-pts only where the member does not know the position exactly: when it paused mpv
from playback (`act` was `playing`, `idle`, `hold` or `skip`, where `pausedAt` falls back to time-pos), or when an
earlier read has not answered yet.

```diff
     const at = inFlightTo === null && !snap.seeking ? this.pausedAt(snap) : null
-    if (at !== null && Math.abs(at - pos) < snap.frameS) {
+    // Where our own completed seek or load (or an earlier read) put mpv is exact: keep it. After a pause from
+    // playback, a paused seek or load leaves audio-pts early by the old AO delay until the next unpause (push AOs;
+    // ADR 0007 Finding 5), so it must not be re-read here.
+    const known = at === null ? null : exactPausedAt(a)
+    if (known !== null && Math.abs(known - pos) < snap.frameS) {
+      this.act = { k: 'settle', pos, seeking: false, actual: known }
+    } else if (at !== null && Math.abs(at - pos) < snap.frameS) {
       // Close enough not to seek, but time-pos is frame-quantised: learn the exact audio position so the next
       // unpause can be scheduled from where we really are.
 …
+/** The exact paused position an activity holds (a completed seek or load, or an audio read), if any. */
+function exactPausedAt(a: Activity): number | null {
+  if (a.k === 'settle') return a.seeking ? null : a.actual
+  if (a.k === 'prep') return !a.seeking && a.exact ? a.target : null
+  if (a.k === 'scheduled') return a.exact ? a.pos : null
+  return null
+}
```

- **Unit test:** use a fake `PlayerPort` whose `sample()` returns posS = X − 0.17 while paused after a seek. Go
  paused(X) → seek done → waiting(X) → playing(X, hostTime = now + 250). Assert that `setPaused(false)` fires at
  `hostTime − unpauseLatMs`, not 170 ms earlier. Repeat with waiting(X) → paused(X) → playing(X).
- **Real mpv:** `member-e2e.ts`. `barrier-paused` and `wait-after-seek` should fall to the same D as `paused-seek`.

**6.2 `src/core/sync/member.ts`: start from the frame mpv landed on** (Finding 4, a low defect). This removes a
start error of up to a frame + 5 ms, and the bias it feeds into the unpause-latency probe.

- **Settle and prep seeks:** when a seek completes (`onPlaybackRestart`, the `settle`/`prep` branches), read
  time-pos (`get_property`, ~0.1 ms). If it lies within a frame of the target, use it as `actual` (or `target`).
  - Paused time-pos after an exact seek is the landing frame exactly (196 of 200; the 4 others were a rounding tie).
    Audio starts there to within 0.5 ms.
  - The observed property may still be in flight when the event arrives, so read it rather than trusting
    `snapshot()`.
- **Loads:** the same for a load's restart, in place of `actual: loadedAt`.
- **Skips (optional):** a playing skip cannot be scheduled. Aiming it at the frame boundary nearest the wanted
  position, where it then lands exactly, would turn its landing error from −5…+35 ms (mean +15) into ±20 ms (mean 0).
  The frame grid is known from any time-pos read after a seek.

**6.3 `src/core/session/sync-ports.ts` `createClock()`: lag beyond the timer interval** (Finding 9, the low defect).

```diff
 export function createClock(): Clock & { dispose(): void } {
-  const hist = monitorEventLoopDelay({ resolution: 10 })
+  const RESOLUTION_MS = 10
+  // The histogram records whole intervals of its RESOLUTION_MS timer: an idle loop reads RESOLUTION_MS (ADR 0007).
+  const hist = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
 …
-    loopLagMs: () => Math.max(recentMaxMs, hist.max / 1e6),
+    loopLagMs: () => Math.max(0, Math.max(recentMaxMs, hist.max / 1e6) - RESOLUTION_MS),
```

A unit test can stub `monitorEventLoopDelay` (or check the real one): an idle loop gives `loopLagMs()` < 5.

**6.4 Constants in `src/core/sync`** (recommendations from the numbers; none of them alone is a defect).

| Constant                                      | Now                  | Measured here                                                 | Recommendation                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRIFT.SEEK_LAT_INIT_MS`                      | 400                  | exact seek → restart p50 41–52 ms, p95 ≤ 120 ms               | Keep a prior, but **learn from every exact seek the member makes**: settle, prep and rendezvous seeks complete with a `playback-restart` too, and paused seeks take the same time (B ≈ C). Let the first measurement replace the prior (α = 1 once). Without that, lower the prior to ~150 ms |
| `DRIFT.SEEK_LAT_MIN_MS`                       | 100                  | p50 41–52 ms                                                  | **25 ms.** At 100, every learned skip lands ~60–75 ms ahead                                                                                                                                                                                                                                   |
| `MEMBER.UNPAUSE_LAT_INIT_MS`, `UNPAUSE_ALPHA` | 50, 0.3              | mpv side 0.1–0.3 ms; the member's probe is accurate to < 1 ms | Keep 50 until the real-device S6. **Let the first probe replace the prior**: the first five starts are 50 → 12 ms early now                                                                                                                                                                   |
| `MEMBER.UNPAUSE_LAT_MAX_MS`                   | 200                  | —                                                             | Real-device S6: Bluetooth start latencies may exceed it                                                                                                                                                                                                                                       |
| `DRIFT.MAX_LOOP_LAG_MS`                       | 20                   | —                                                             | Keep, with §6.3. Without §6.3 it means 10 ms                                                                                                                                                                                                                                                  |
| `DRIFT.MAX_IPC_RTT_MS`                        | 15                   | p99 ≤ 5.8 ms; it dropped 0 samples                            | Keep                                                                                                                                                                                                                                                                                          |
| `DRIFT.ON` / `OFF`                            | 60 / 15              | audio-pts noise ≤ 0.25 ms (median-of-5 p99)                   | Keep for now. After §6.1/§6.2 the start error is ~1 ms on the null AO, and ON could drop to ~30 ms; the real-device jitter decides                                                                                                                                                            |
| `DRIFT.GAIN`, `MAXD`, `MEDIAN_N`, `TICK_MS`   | 1/3000, 0.05, 5, 250 | a speed change takes effect after ~0.4 s, with a step ≤ 20 ms | Keep                                                                                                                                                                                                                                                                                          |
| `MEMBER.SPIN_LEAD_MS`                         | 15                   | command 0.01 ms (p50) after T quiet, ≤ 9.3 ms under load      | Keep                                                                                                                                                                                                                                                                                          |
| `DRIFT.RESTART_HOLD_MS`                       | 1000                 | the null AO is linear from ~0.5 ms after an unpause           | Keep until real devices are measured                                                                                                                                                                                                                                                          |

**6.5 `test/sync/sim/fake-mpv.ts`: let the simulator see Findings 4 and 5.** As it stands, its seeks and loads
land exactly on the target, and `sample()` returns the true position while paused. So plan §9's start-alignment
test (row 2) cannot catch either finding. Add two options, on by default, and a test per flow of Finding 5:

- **`landing: 'frame'`:** a seek or load lands on the first frame at or after `target − 5 ms`.
- **`stalePausedMs`** (e.g. 170): after a pause from playback, a paused seek or load makes `sample()` read that much
  early until the next unpause.

Its timing defaults are pessimistic next to what mpv 0.41 did on this content. They can stay, as long as the tests
are known to cover the slow case:

| Option                          | Default    | Here                                                      |
| ------------------------------- | ---------- | --------------------------------------------------------- |
| seek                            | 150–450 ms | p50 41–52 ms, max 208 ms                                  |
| load                            | 400 ms     | p50 80 ms local, 87 ms stream                             |
| unpause                         | 60 ms      | the null AO: 0.2 ms; devices unknown                      |
| restart → moving, while playing | 20 ms      | ≈ 0 ms (the line passes the landing frame at the restart) |

## 7. What remains for a real-device S6

All of it needs a machine where sound may play, and an acoustic or electrical loopback (a microphone or a line-in
cable) to time what is heard against the IPC command:

- **Per device:**
  - Unpause → audible latency, and its stability (plan: ±20 ms): PipeWire (and PulseAudio, ALSA direct) on Linux,
    WASAPI shared and exclusive on Windows, CoreAudio on macOS, and Bluetooth A2DP/LE Audio on each.
  - Whether the device's start latency shows up in audio-pts (as a later start of the line) or is hidden in its
    reported delay.
  - Whether `UNPAUSE_LAT_MAX_MS` (200) covers Bluetooth.
- **Paused audio-pts on real AOs:** Finding 5 on pull AOs (PipeWire, WASAPI, CoreAudio) and on PulseAudio, after a
  paused seek and after a load. A §6.1 fix makes the member immune either way.
  - Also check whether a pull AO's paused audio-pts creeps forward as the pause ages. `ao_get_delay` takes its
    delay as `max(0, end − now)`, which drains while paused.
  - The `resume` path reads the paused audio-pts right after the pause, so a creep would move a resumed start by up
    to the device buffer. Compare the reading 50 ms, 300 ms and several seconds after a pause (the A protocol's
    `pausedDriftMs`, which is 0 on the null AO).
- **The device crystal:** the rate of audio-pts against an NTP-disciplined clock over 10 min. This is the real input
  of plan §9's 100 ppm row.
- **Speed nudges on real outputs:** scaletempo2 with 1.02 / 0.98 / 0.95 / 1.05, the step and delay of Finding 8 with
  real buffers, and whether nudges are audible. spdif passthrough into an AVR with speed 1.02: mpv cannot change the
  speed of a bitstream, so this documents the plan's skip-only mode.
- **IPC:** Windows named pipes (`--input-ipc-server=\\.\pipe\…`) and macOS `fd://3`.
- **Real video outputs:** `--vo=gpu-next` with display sync off, as the app runs it. Does frame presentation change
  time-pos, or the timing of `playback-restart`?
- **Heavier content:** exact-seek latency with long GOPs and 4K (hardware and software decoding), to see the range
  `seekLatMs` must learn.

## 8. Re-running

Everything above, in a quiet period (~75 min). Each run takes the shared measurement lock, so it never overlaps the
other items' measurements:

```sh
cd /home/ram/Documents/projects/watch-together-p2p
S6_LOCK=/tmp/claude-1000/-home-ram-Documents-projects-watch-together-p2p/2544c560-b9a2-48b1-83d4-60348e2ead8d/scratchpad/measure.lock \
  spikes/s6-lite/run-all.sh /tmp/s6-quiet 2
cat /tmp/s6-quiet/summary.md /tmp/s6-quiet/e2e.md /tmp/s6-quiet/probe-*.md
```

- **Contents:** `run-all.sh` runs the e2e starts and the probes first, then the matrix, then the socket run. It
  records the 1-minute load average and CPU PSI with every run and every second.
- **Quiet:** for numbers comparable with the quiet run here, `cat /proc/loadavg` should show < 1 before starting.
- **Only the tables again, from existing data:**
  `npx tsx spikes/s6-lite/summarize.ts /tmp/s6-quiet [<more dirs>] --json /tmp/s6-quiet/summary.json`.
- **Only the defects** (no lock needed for a check; ~7 min and ~10 s):
  - `npx tsx spikes/s6-lite/member-e2e.ts --out /tmp/s6-e2e --reps 8`: `barrier-paused` and `wait-after-seek`
    start ~170 ms early (Finding 5), and `paused-seek` and `playing-seek` start where the seek landed (Finding 4).
  - `npx tsx spikes/s6-lite/probes.ts paused`: mpv's stale paused audio-pts.
  - For Finding 9, `node -e "const {monitorEventLoopDelay: m} = require('node:perf_hooks'); const h = m({ resolution:
10 }); h.enable(); setTimeout(() => console.log(h.percentile(50) / 1e6, h.max / 1e6), 2000)"` prints a median of
    ~10.1 ms (and a max of 10.5–12) on an idle loop.
