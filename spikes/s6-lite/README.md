# Spike S6-lite: sync precision on real mpv 0.41, measured silently

Throwaway driver for plan §7 S6, limited to what one Linux machine can measure without producing sound or touching
the audio setup. The report is `docs/adr/0007-s6-real-mpv-sync.md`.

mpv runs under the production `PlayerController` (`src/core/player`):

- the production argument list from `mpv-args.ts` (the viewer's stream options too, for the stream source), plus
  `--vo=null --ao=null --script-opts=wt_osc-test-dims=1280x720`, so the OSC draws as into a 1280x720 window;
- JSON IPC over `fd://3` (`mpv-ipc.ts`), with the controller's 22 observed properties flowing on the same socket
  (`--ipc socket`: `--input-ipc-server`, the Flatpak path);
- `selfReload: false`, as the sessions run it.

Nothing here makes a sound or opens a window: every mpv gets `--ao=null --vo=null`, and `probes.ts --mpv-arg` refuses
any output selection (it is for the null AO's own options, such as `--ao-null-buffer`).

**What a sample is.** Each sample is `PlayerController.sample()`, which returns audio-pts, else time-pos. That is
what `PlayerPortAdapter.sample`, and so sync's drift loop, calls. Each is paired with a `get_property time-pos`.

- **Timestamps:** `MpvIpc` stamps every request with `tSend` and `tRecv`, from `performance.now()`. That is the
  clock of the session's sync `Clock` (`createClock()` in `src/core/session/sync-ports.ts`).
- **Event-loop lag:** that same clock's `loopLagMs()`, read when each reply arrives, as `member.ts` reads it.
- **Commands:** pause, seek and speed are sent through `PlayerPortAdapter`, as the member sends them.
- **Two clocks.** `performance.now()` is `CLOCK_MONOTONIC`, which NTP slews; mpv's own timer, which paces the null
  AO, is `CLOCK_MONOTONIC_RAW`. Rates measured against our clock carry the slew of the moment (−27 to −166 ppm on
  this machine, stepping when systemd-timesyncd adjusts). `summarize.ts` therefore also gives speed errors against
  the same run's 1x rate.

## Commands

```sh
# everything in ADR 0007: the e2e starts and the probes, then {local, stream} × {no load, 12 busy loops} × 2 reps,
# then one run over a Unix socket (~75 min). With S6_LOCK each run holds that flock(1) lock, so it never overlaps
# other measurements that take it.
S6_LOCK=/path/to/measure.lock spikes/s6-lite/run-all.sh /tmp/s6 2   # → /tmp/s6/summary.md (+ e2e.md, probe-*.md)

# one run, or a quick smoke test (~75 s)
npx tsx spikes/s6-lite/s6.ts --out /tmp/s6 --source local --load 0 --tag x
npx tsx spikes/s6-lite/s6.ts --out /tmp/s6 --quick --tag smoke
npx tsx spikes/s6-lite/s6.ts --out /tmp/s6 --ipc socket --protocols fit --tag sock   # IPC over a Unix socket

# the production SyncEngine (host, no viewers) driving the real mpv: D right after each start
npx tsx spikes/s6-lite/member-e2e.ts --out /tmp/s6/e2e --reps 8

# probes (each well under a minute)
npx tsx spikes/s6-lite/probes.ts landing|paused|speed-step [--fixtures /tmp/s6/fixtures]
npx tsx spikes/s6-lite/probes.ts paused --mpv-arg=--ao-null-buffer=0.05     # the stale delay follows the AO buffer
npx tsx spikes/s6-lite/probes.ts reload --source local|stream               # loadfile at a position vs a seek

# tables from any set of runs
npx tsx spikes/s6-lite/summarize.ts /tmp/s6 [more dirs…] [--json summary.json]
npx tsc -p spikes/s6-lite/tsconfig.json        # typecheck
```

The fixture is built on first use into `<out>/fixtures` (or `--fixtures <dir>`). It comes from `fixtures.ts`'s
generator with LONG's encode parameters, but 300 s long. LONG is 640x360 at 25 fps, x264 at 2 Mbit/s with a 1 s
GOP and B-frames, and AAC 440 Hz audio. The `mkv-cues.mkv` remux is used.

**Busy loops.** `--load N` starts N `bash` busy loops (`while (( SECONDS < 900 )); do :; done`). They end on their
own after 900 s, even if the driver is killed.

**Checks recorded with each run.**

- The 1-minute load average, the runnable-task count and CPU PSI (`/proc/pressure/cpu`), every second.
- The content hashes of the sources the numbers depend on.
- Whether any of those sources changed while the run was going.

## Protocols (`s6.ts`)

| Protocol    | What it does                                                                                                                                                                                                                                                                                         | Feeds              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `fit`       | 30 s paused at 4 Hz (idle RTT). Then 1x for 62 s at 4 Hz: the line is fitted over the 60 s from 1 s after the unpause. Then speeds 1.02, 1, 0.98, 1, 1.05, 1, 0.95, 1 (25/10/25/10/15/8/15/8 s), fitted from 1 s after each change                                                                   | (1), (2), (5), (6) |
| `pause` (A) | 20 trials. Each plays, pauses and reads the paused position 50 and 300 ms later. It then unpauses at a scheduled T, with `member.ts`'s timing: `setTimeout` 15 ms early, then a `setImmediate` spin. It samples at 20 Hz for 3 s. The line from 0.5 s on is extrapolated back to the paused position | (3)                |
| `seek` (B)  | 20 exact seeks while paused, to random targets. Each records the time to `playback-restart` and reads the paused audio-pts and time-pos. It then unpauses at T and extrapolates as in A                                                                                                              | (3), (4)           |
| `seek` (C)  | 20 exact seeks while playing. Even trials are drift-loop skips (+1.5 s from the current position); odd ones go anywhere. Each records the time to `playback-restart`, then fits the line after it                                                                                                    | (4)                |

## Starts end to end (`member-e2e.ts`)

A host-only `SyncEngine` (θ̂ = 0, lead 250 ms) with stub bus, media and transfer ports drives the real mpv. After
each start it samples audio-pts every 50 ms in [+0.3 s, +1 s] after the anchor's host time, before the drift loop
may act, and records D = audio-pts − expected, next to where the seek or load landed (the first frame ≥ target − 5
ms). For `barrier-paused` and `wait-after-seek` it also records how long after the seek's `playback-restart` the state
came that made the member settle again (ADR 0007, Finding 5). Each rep runs six starts:

| Scenario          | How the room gets there                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `resume`          | playing → pause → play                                                                                   |
| `paused-seek`     | paused → seek X → play                                                                                   |
| `barrier-paused`  | playing → seek X and pause in one turn: the seek barrier completes `paused` → play                       |
| `playing-seek`    | playing → seek X: the barrier completes `playing`                                                        |
| `wait-after-seek` | paused → seek X → play while the member is not ready (its media port says so for 1 s): waits at X, plays |
| `reload-paused`   | playing → pause → the same source loaded again while paused → play                                       |

## Pieces

| File            | What                                                                                                                                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s6.ts`         | The driver: one mpv, one source (`local` path or `stream` = `StreamServer` + `FakeSource` with every piece verified), one load level. Writes `<out>/<tag>-<source>-load<n>-<time>/run.json`, `mpv.log` and `log.txt` |
| `lib.ts`        | Types, statistics (quantiles, least-squares lines, median-of-5) and the per-run analysis                                                                                                                             |
| `summarize.ts`  | Pools runs by condition and prints the ADR's tables                                                                                                                                                                  |
| `member-e2e.ts` | The end-to-end starts above                                                                                                                                                                                          |
| `probes.ts`     | `landing` (where exact seeks land), `paused` (audio-pts while paused), `speed-step` (audio-pts around a speed change), `reload` (loadfile at a position)                                                             |
| `run-all.sh`    | Everything, in order                                                                                                                                                                                                 |

Code is throwaway. It does not run under eslint (`spikes/` is ignored) but is prettier-formatted.
