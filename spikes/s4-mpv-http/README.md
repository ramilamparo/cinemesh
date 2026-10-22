# Spike S4: mpv against a blocking loopback HTTP server

Throwaway prototypes for plan §4.3 (critical ranges, stream server, readiness, blocked-seek
watchdog, subtitles), §4.4 (argument list, IPC, version differences) and the §7 S4 row.
The report is `docs/adr/0004-s4-mpv-http.md`.

mpv 0.41.0 runs headless (`--vo=null --ao=null`) with the plan's stream options. It plays synthetic
fixtures from a `node:http` server that logs every request and can withhold byte ranges: a withheld
byte blocks the response body until it is released, which is what a missing piece does. A small
JSON-IPC client drives mpv.

## One command

```sh
cd spikes/s4-mpv-http
sh run-all.sh            # fixtures (if missing) + every measurement below; ~25 min, each step < 2 min
npx tsx summarize.ts     # the open/seek table from data/results/*.json
rm -rf data/*.mkv data/*.mp4 data/*.avi   # ~1.7 GB of fixtures (results and logs stay, ~15 MB)
```

`run-all.sh` runs these steps; each also works on its own:

| Step | Command | Output |
|---|---|---|
| fixtures (~1.7 GB, a few minutes of x264) | `bash make-fixtures.sh` | `data/*.mkv/mp4/avi`, `data/subs.{srt,ass}` |
| golden ranges | `npx tsx ranges.ts` | `data/<f>.ranges.json`, `golden/<f>.ranges.json` |
| open / seek / audio switch, 3 reps × 5 modes | `npx tsx run-open-seek.ts` | `data/results/open-seek-*.json` |
| the same at 16 KiB gating granularity | `npx tsx run-open-seek.ts --modes gated,gated-join,fixed,fixed-join --piece 16384 --tag -p16k` | `…-p16k-*.json`; `npx tsx summarize.ts fixed-p16k fixed-join-p16k` |
| where mpv starts reading for a target | `npx tsx probe-seek-target.ts` | stdout |
| audio switch, free and gated | `npx tsx probe-aid.ts <fixture> free\|fixed` | stdout |
| what works while the reader is blocked | `npx tsx probe-blocked-ops.ts` (env `SKIP_SET`, `RELOAD_OPT`) | `data/results/blocked-ops-*.json` |
| short stalls (10 s), 3 reps | `bash run-stall-short.sh` | `data/results/stall-*-h10-*.json` |
| 5-minute stalls, nt=0 and nt=60 (~5.5 min wall, runs in parallel) | `bash run-stall-5min.sh` | `data/results/stall-*-h300-*.json` |
| subtitles over HTTP + screenshots | `npx tsx run-subs.ts` | stdout, `data/results/shots/*.png` |
| argv parses on the installed mpv | `npx tsx argv-check.ts` | stdout, `data/run/argv-B.log` |
| `--input-ipc-client=fd://3` | `npx tsx ipc-fd3.ts` | stdout |
| options.rst at v0.39.0/v0.40.0/v0.41.0 | `npx tsx options-diff.ts` | stdout |

`options-diff.ts` reads `data/mpvdocs/options-<ver>.rst`, fetched with
`curl -fsSLo data/mpvdocs/options-0.39.0.rst https://raw.githubusercontent.com/mpv-player/mpv/v0.39.0/DOCS/man/options.rst`
(the same for v0.40.0 and v0.41.0; `run-all.sh` does this when the files are missing).

## Pieces

| File | What |
|---|---|
| `make-fixtures.sh`, `make-subs.ts` | 10 min 854×480 25 fps H.264 (2 Mbit/s, 2 s GOP) + two AAC tracks (eng/jpn), remuxed into 9 containers; external .srt/.ass |
| `mkv-move-to-tail.ts`, `ebml.ts` | tiny EBML walker/writer (mkvinfo is not installed): layout, Cues, and moving Tags/Attachments/Chapters behind the Clusters with a rebuilt SeekHead |
| `mp4.ts` | top-level box walker (largesize, size 0) and `sidx` reader |
| `ranges.ts` | golden data: plan §4.3 open-critical / seek-critical / readyRange, plus the S4-corrected rules (`openCriticalFixed`, `readyRange[t].fixed`) |
| `server.ts` | logging range server: single-range 206, HEAD, 416, per-file availability (`setAvailable`) and withholding (`withhold`/`release`), `destroyBlocked`, one-shot error statuses |
| `mpv.ts` | spawns mpv with the plan argv (headless subset) and a JSON-IPC client |
| `analyze.ts` | classifies each request/byte of a phase against the golden ranges |
| `run-open-seek.ts` | open → seek 50 % → aid switch per fixture; modes `free`, `gated`/`gated-join` (plan ranges only), `fixed`/`fixed-join` (S4 ranges only) |
| `run-stall.ts` | withholds [20 s, 40 s), plays into the hole, holds, then watchdog / release / release-while-seeking / destroy / cache-seek |
| `run-subs.ts` | `sub-add` .srt/.ass URLs, embedded ASS + attached font at the MKV tail, `sub-add` of a withheld file |
| `mpv-args.ts`, `argv-check.ts`, `stub-wt-osc.lua` | version-aware argv prototype and its check (a stub stands in for wt-osc.lua) |
| `ipc-fd3.ts` | Node `stdio[3] = 'pipe'` + `--input-ipc-client=fd://3` |
| `options-diff.ts` | per-option signature diff of options.rst across versions |
| `summarize.ts` | the Markdown table in the report |

`golden/` holds the expected ranges for M4 and `golden/fixtures.sha256`. x264 output is probably but
not provably deterministic: if a regenerated fixture's hash differs, rerun `ranges.ts` and use the
new JSON. Note the golden `pieceLength` (1 MiB) only matters for the generic (AVI) rule.

Code is throwaway; `npx tsc -p tsconfig.json` typechecks it.
