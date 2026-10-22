# Spike S3: R6 request order and host-assigned striping

Throwaway prototypes for plan §4.2 "R6 scheduler", "Host-assigned striping (Revealer)" and "Piece states (R8)". The
report is `docs/adr/0003-s3-scheduler-striping.md`.

All nodes are in-process WebTorrent 3.0.21 clients joined by `@hyperswarm/secret-stream` pairs, with `Protomux` and the
production `MuxWireStream` on each pair. There is no DHT and no sockets. On the first run, fixtures are generated into
`data/` (gitignored): 256 MiB and 512 MiB random files, plus their `.torrent` files.

## One command

From the repository root:

```sh
sh spikes/s3-scheduler/run-all.sh          # everything, about 60 min; each run < 2 min (timeout 160 s)
npx tsx spikes/s3-scheduler/summarize.ts   # the report's tables, from data/results/*.json
rm -rf spikes/s3-scheduler/data            # about 800 MB of fixtures and logs
```

Subsets: `run-all.sh a`, `run-all.sh patched` and `run-all.sh b`.

- `a`: Part A, with and without the validateWire patch.
- `patched`: only the runs that load `patched/webtorrent`.
- `b`: Part B. `run-all.sh extra` adds the 7-viewer load case, a tight-uplink case, and repeats of the no-deadline
  variant.

The start load of every run is logged in `data/results/run-all*.log`. Part B is sensitive to CPU starvation, because
host and viewers share one event loop. Runs at load ≈ 30 are kept apart in `data/results-contended/` and are not used.

Typecheck and format check:

```sh
npx tsc -p spikes/s3-scheduler/tsconfig.json
npx prettier --check 'spikes/s3-scheduler/*.ts' 'spikes/s3-scheduler/lib/*.ts'
```

## Pieces

| File                   | What                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/net.ts`           | Fixtures; the host (`skipVerify`, `uploadLimit`); viewers (memory store, `deselect: true`); `link()` = SecretStream pair + MuxWireStream, with an optional one-way delay. `S3_PATCHED_WT=1` loads `patched/webtorrent`                                                     |
| `lib/scheduler.ts`     | The plan's `replan()` verbatim, plus two experiment switches: `sentinel` and `batched`                                                                                                                                                                                     |
| `lib/request-log.ts`   | Wraps `wire.request` from the torrent's `'wire'` listener                                                                                                                                                                                                                  |
| `lib/piece-states.ts`  | The R8 `Uint8Array` snapshot                                                                                                                                                                                                                                               |
| `lib/revealer.ts`      | The host hook (`haveAll` / `haveNone` / `bitfield` overrides) and the Revealer tick                                                                                                                                                                                        |
| `lib/spike-types.d.ts` | Typings on top of `src/types/modules.d.ts`                                                                                                                                                                                                                                 |
| `patched/webtorrent/`  | A copy of webtorrent 3.0.21 where `validateWire()` walks the plan forwards (the only change, in `lib/torrent.js`)                                                                                                                                                          |
| `part-a.ts`            | Host + v1 (instrumented) + v2. Seek 0 % → 40 % (with a hot window) → Cues range + blocked reader → 90 %, then run to the end. Flags: `--churn` (replan at 10 Hz), `--delay 25`, `--sentinel`, `--batched`, `--peer-plan independent`                                       |
| `part-a-bounds.ts`     | Coinciding bounds on a live transfer: p = 2 with urgent [0, 1], p = N−1, L1 reaching N−1                                                                                                                                                                                   |
| `bench.ts`             | Piece-state cost at 15k pieces, replan cost, and selection / `_critical` invariants over 3000 random plans                                                                                                                                                                 |
| `wire-hook.ts`         | B.1: logs every message the host sends on a wire, with the fast extension on and off                                                                                                                                                                                       |
| `part-b.ts`            | 1 host + V viewers on a shared playhead. Flags: `--mode baseline\|stripe`, `--drop v3-v4`, `--deadline-mode rescue\|everyone\|none`, `--eligibility full\|connected`, `--R auto\|n`, `--viewer-up MB/s`, `--delay ms`, `--viewers n`, `--bitrate MB/s`, `--host-rate MB/s` |
| `summarize.ts`         | Prints the per-run (Part A) and median (Part B) tables                                                                                                                                                                                                                     |

Single runs:

```sh
npx tsx spikes/s3-scheduler/part-a.ts --churn
S3_PATCHED_WT=1 npx tsx spikes/s3-scheduler/part-a.ts --out a-patched-x
npx tsx spikes/s3-scheduler/part-b.ts --mode stripe --drop v3-v4
```
