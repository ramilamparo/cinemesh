# Spike S2: transport

Headless harness for plan §7 S2. A host and 3 viewers run as separate Node processes. Each member has
its own Hyperswarm on a local HyperDHT testnet, and everyone joins one topic. Per connection, each
member runs `Protomux.from(conn)` with a `wtp/ctrl/1` lane (c.json) and a `wtp/bt/1` MuxWireStream
lane, and WebTorrent 3.0.21 on top. The report is `docs/adr/0002-s2-transport.md`.

## One command

```sh
npx tsx spikes/s2-transport/make-data.ts      # once: 2 GiB + 12345 B random file + cached .torrent (~1 min)
spikes/s2-transport/run-all.sh                # whole matrix, 3 runs each, then the median table (~80 min)
npx tsx spikes/s2-transport/verify-source.ts  # source sha256 + mtime unchanged, not sparse
```

`run-all.sh` takes group names to run only part of the matrix: `lo soft one viewer1 reattach relay netem limits reqq
relaynetem limits2 netemreqq reattachrep fixed` (the labels each group produces are in the script).
A run whose mesh does not form within 60 s is retried up to 2 times; the failed attempt goes to `results/mesh-failures/`.
It skips labels that already have a result; set `FORCE=1` to redo them. `npx tsx spikes/s2-transport/summarize.ts`
re-prints the table from `results/*.json`.

A single run:

```sh
spikes/s2-transport/run.sh loopback --label my-run [--bp strict|soft|fixed] [--relay] [--one-process] \
  [--reattach 8000 [--reattach-every 5000]] [--viewers 1] [--max-ms 60000] [--up-limit host,viewer KB/s] [--down-limit host,viewer KB/s] [--reqq 256]
spikes/s2-transport/run.sh netem --label my-netem-run --max-ms 30000
```

`run.sh` wraps everything in `unshare -rn`, i.e. a private user+net namespace with only `lo`. That
isolates the run from other processes' traffic and allows `tc`/`nft` without root. `netem` adds
`netem delay 25ms rate 50mbit` on `lo` once the mesh is up: 50 ms RTT, and 50 Mbit/s shared by all
loopback traffic in the namespace, in both directions.

## Files

| Path | What |
|---|---|
| `make-data.ts` | Writes `data/source.bin` (random, fully allocated) and hashes it once with create-torrent (1 MiB pieces) into `data/source.torrent`; records size, mtime and sha256 in `data/source.json` |
| `run.ts` | Orchestrator: testnet, optional relay, forks the members, waits for the full ctrl mesh, 6 s idle phase, `go`, transfer, `finish`, analysis |
| `lib/member.ts` | One member (host or viewer) as core would run it; pings every viewer every 100 ms on ctrl and with datagrams; samples RSS and event-loop delay |
| `lib/read-only-store.ts` | Throwaway ReadOnlyFileStore (O_RDONLY fds, `put` fails, `destroy` never deletes) |
| `lib/mux-wire-stream-soft.ts` | Local copy of `src/core/transfer/mux-wire-stream.ts` with a 256 KiB soft backpressure limit (`--bp soft`) |
| `lib/mux-wire-stream-fixed.ts` | Local copy of the src lane plus the `_predestroy` fix recommended in the ADR (`--bp fixed`) |
| `lib/relay.ts`, `lib/relay-main.ts` | Blind relay on the testnet (blind-relay + `dht.createRawStream({framed: true})`) in its own process |
| `lib/nft.ts` | Drops member-to-member UDP inside the namespace, so a forced relay is actually used |
| `lib/analyze.ts`, `summarize.ts` | Per-run numbers, then medians per configuration |
| `verify-source.ts` | Source file still identical (sha256, mtime) and not sparse |
| `experiments/mesh-probe.ts` | Does a 4-member mesh form, and with matching connections on both ends? (`topic` vs `ordered`) |
| `experiments/relay-probe.ts` | Does forced `relayThrough` stay relayed on loopback (`block` vs not), and do datagrams pass? |
| `experiments/reopen-probe.ts` | Re-opening a destroyed bt lane: livelock without `mux.pair()`, ~1.5 ms with it |
| `experiments/held-write-probe.ts` | The src lane never closes when the remote closes it while a write is held; the fixed one does |

Results: `results/<label>.json` (per run), `results/summary.json` (medians). Raw member reports go to
`data/raw/` (gitignored). Viewer downloads go to `data/run-<label>/`, which is deleted after each run.

Typecheck: `npx tsc -p spikes/s2-transport/tsconfig.json`.
`make-data.ts` must have been run first: `data/source.bin` (2 GB) is deleted after the spike to free disk. ESLint ignores `spikes/` by project config.
