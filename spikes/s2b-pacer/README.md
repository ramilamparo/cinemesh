# Spike S2b: host upload scheduling and pacing

Harness for ADR 0006 (`docs/adr/0006-s2b-upload-pacing.md`). It asks two things about the host's upload:

- **(A)** Would answering requests just in time, urgent pieces first, cut the blocked-read latency of ADR 0003
  round 4 (1.09 s median with 1 viewer, 2.37 s with 3, at a 1 MB/s host) without costing throughput or dupFactor?
- **(B)** When the host's real uplink is the bottleneck, would a delay-based pacer keep the room's ctrl lane and
  datagrams near their idle delay while using most of the uplink, compared with a fixed limit at 85 % of the peak?

Nothing here touches `src/`: the prototypes wrap the host's wires, its engine and udx-native from outside.

## How a run works

One run is one rootless session (`scripts/netns-rootless.sh`: user + mount + net + pid namespaces, no sudo; every
process dies with it). Inside:

```
session ns: br0 192.88.99.1/24 ── HyperDHT testnet (10 nodes, in the driver)
  ├── h   192.88.99.10  host    netem delay 20ms rate R limit (500 ms of R)   <- the uplink under test
  ├── v1  192.88.99.11  viewer  netem delay 10ms
  ├── v2  ...
```

- Each member (`lib/member.ts`) is its own Node process in its own namespace and runs what the app runs for a
  striped room: a `Room` (src/core/net) on the testnet, a `TransferEngine` attached to every admitted peer, and the
  sessions' striping glue (`collectTransferLinks` / `reportTransferLinks`, i.e. `transfer.links` on the bus).
- Simulated on top: the room's playhead (the host plays a `--bitrate` video and sends `play` / `seek` ctrl frames,
  like `sync.state`), and mpv after a seek (each viewer reads `--read-pieces` pieces from the target through its
  `PieceSource`, blocking like the stream server).
- Measured: ctrl-lane pings and datagram pings host -> viewer -> host every 100 ms, with one-way delays on the
  shared monotonic clock, and the viewer's UDX stream (BBR state, cwnd, inflight, srtt) as each ping leaves; the
  netem queue (`tc -s qdisc`, 4 Hz); per-wire app and UDX queues; per-piece traces (reveal, request, release, first
  block, verified); event-loop delay; `/proc/loadavg` every 5 s.
- Timeline: mesh -> 6 s idle (pings only) -> start -> warm-up -> measure (trials every `--trial-every` ms,
  jittered) -> finish.

## Prototypes (host)

- `lib/upload-sched.ts`
  - `monitor` counts the host wires' queues.
  - `jit` holds each request (own-property `wire._onRequest` / `_onCancel` / `choke`). It releases one when the
    wire's queue is under max(32 KiB, 100 ms of its drain rate) and, with a rate (`--limit-kbps` or the pacer), when
    the scheduler's own token bucket (20 ms deep) has tokens. WebTorrent's throttle is then off.
  - Release order (`--urgent global`): class 0 (a piece a viewer's reader is blocked on, from the Revealer's urgent
    reports) before 1 (the group's hot window, critical ranges) before 2, FIFO within a class, round-robin between
    wires. `--preempt` rejects (BEP 6) a viewer's held class-2 requests when its reader blocks on a new piece.
  - `--jit-udx`: a wire's queue reaches down into its connection's UDX send queue (bytes handed to UDX, minus acked,
    minus inflight; `member.ts` counts them by wrapping udx-native's `_writev` / `_onack` before any stream exists),
    and its drain rate is what UDX got acknowledged.
- `lib/pacer.ts`: the delay-based pacer. Per viewer, base = the 60 s minimum and current = the 500 ms minimum of the
  signal; queueing delay = the median over viewers. Cut 5 % per target of queue when above the target (not again
  for 2 s unless the queue grew by half), slow regrowth near the last cut, probing above it.
  - `--pacer-signal ctrl` (default): one-way delay of the ctrl pings (network queue + the stream's own queue);
    `dgram`: of the datagram pings (network only); `udx`: UDX's smoothed RTT of each viewer's stream, sampled every
    50 ms while it sends (network only, no probe traffic).
- `lib/member.ts` (one member: room, transfer, striping glue, playhead, reads, pings, traces, report),
  `lib/topo.ts` (bridge, one namespace per member, netem), `lib/proto.ts` (config, commands, events, clock,
  percentiles), `run.ts` / `run.sh` (one run; the header of `run.ts` lists every option), `run-all.sh` (the ADR's
  matrix), `summarize.ts` (its tables).

## Commands

From the repository root. `OUT` holds the results, the raw reports and the cached 1 GiB / 128 MiB source files
(keep it out of the repo, e.g. under /tmp).

```sh
S2B_LOCK=/path/to/lock spikes/s2b-pacer/run-all.sh OUT   # everything, 3 repeats (~100 min); a | b | b20 | b50
npx tsx spikes/s2b-pacer/summarize.ts OUT                # the ADR's tables, also OUT/summary.json
# single runs, e.g.:
spikes/s2b-pacer/run.sh --out OUT --label x --rate 20mbit                                    # baseline
spikes/s2b-pacer/run.sh --out OUT --label y --rate 20mbit --pacer 40 --sched jit --urgent global --preempt --jit-udx
spikes/s2b-pacer/run.sh --out OUT --label z --limit-kbps 1000 --size-mib 128 --piece-kib 256 --trials far \
  --trial-every 2500 --sched jit --urgent global --preempt
npx tsc -p spikes/s2b-pacer/tsconfig.json                # typecheck (ESLint ignores spikes/)
```

`S2B_LOCK` is optional: the matrix then holds `flock` on that file for each repeat (`S2B_LOCK_SCOPE=chunk` or `run`
for shorter holds), so other timing-sensitive jobs that take the same lock never overlap a run. Needs unprivileged user namespaces, `ip`, `tc` (netem) and Node 26. Timing is sensitive to
CPU contention: every result records the 1-minute load average at start, every 5 s and at the end, and whether
`src/` changed during the run.
