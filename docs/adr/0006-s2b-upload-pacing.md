# ADR 0006: Spike S2b — host upload scheduling and pacing

- Date: 2026-10-20
- Status: **(A) passes; (B) passes in part.** Just-in-time, urgent-first release with preempt cuts the blocked
  read 4-6× with no cost. The pacer on the scheduler (UDX srtt) meets ADR 0002's ctrl criterion at 98-99 % of the
  shipped throughput, but not its datagram one. The matrix (`run-all.sh`, 3 repeats) ran 66 of 66 runs on a quiet
  machine, 2026-10-22 04:11-05:38, 1-min load 0.1-1.7. `src/` as of round 6 (the Revealer with the take-back
  reverse order and the request reject); no run saw it change. Raw data was in the session scratchpad, which is
  tmpfs and lost on reboot: the tables in §3 are the record.
- Plan: §4.2 (host seeding, Revealer), §4.5 ("Host uplink saturated" warning), §7 (S2b, from ADR 0002 §7);
  ADR 0003 Follow-up 7.
- Spike: `spikes/s2b-pacer/` (its README has every command). Nothing in `src/` was changed.
- Environment: WebTorrent 3.0.21, bittorrent-protocol 5.0.9, udx-native 1.21.3, hyperdht 6.34.1, Node 26.6.0,
  Linux 6.18, 14 cores. The machine was quiet during the matrix; the 1-min load average at each run's start is in every
  table. Raw data (volatile): `…/scratchpad/s2b-final/`. The smoke and calibration runs that some of §4's mechanisms
  were first seen in ran on a shared machine; their data is gone, and §4 marks what only they showed.

## 1. Question

- **(A) Request scheduling.** ADR 0003 round 4 found that a reader blocked far past the frontier waits 1.09 s
  (median, 1 viewer) or 2.37 s (3 viewers) at a 1 MB/s host, and that the host's per-wire upload queue causes
  most of it: bittorrent-protocol answers every request into the upload throttle at once, so a `have` and an
  urgent piece's blocks wait behind ~1 s of older data, a cancel cannot recall queued data, and cache hits
  overtake disk reads (Follow-up 7). Would answering requests **just in time** (each wire's queue kept to ~100 ms of
  its rate) and **urgent pieces first** (the Revealer already knows them: blocked readers, the hot window, critical
  ranges) cut that latency without lowering throughput (≥ 90 % of the link) or raising dupFactor?
- **(B) Uplink saturation.** When the host's real uplink, not the app's limit, is the bottleneck, queues build in
  the host's network stack and router, and the room's ctrl messages and sync datagrams wait in them (ADR 0002: ctrl
  p95 extra 3.8 s, datagrams 4.7× idle at a saturated 50 Mbit/s). Would a **delay-based pacer** (LEDBAT-like:
  keep the queueing delay to the viewers under a target of 25–50 ms by adjusting the upload rate) keep the ctrl RTT
  and the datagram delay near idle while using most of the uplink? Compare with a **fixed limit at 85 %** of the
  measured peak (what plan §4.5's warning would suggest).

## 2. Method

### 2.1 Network and members

One run is one rootless session (`scripts/netns-rootless.sh`: user + mount + net + pid namespaces, no sudo). A
bridge carries a 10-node HyperDHT testnet; each member is its own Node process in its own namespace behind a veth:

```
session ns: br0 192.88.99.1/24 ── HyperDHT testnet
  ├── h   192.88.99.10  host    netem delay 20ms [rate R limit (500 ms of R + the delay line)]
  ├── v1  192.88.99.11  viewer  netem delay 10ms
  ├── v2, v3 ...
```

- Each member's uplink is the netem qdisc on its side of the veth; downlinks are unshaped. Idle RTT host↔viewer is
  31 ms. The host's netem queue holds 500 ms of its rate, a bufferbloated home router.
- Each member runs what the app runs for a striped room: a `Room` (src/core/net) on the testnet, a
  `TransferEngine` attached to every admitted peer, and the sessions' striping glue (`collectTransferLinks` /
  `reportTransferLinks`, i.e. `transfer.links` on the bus, with the viewers' blocked pieces). The host is the
  production `startHost` with the Revealer; viewers are `joinAsViewer` with the R6 scheduler.
- Simulated on top: the room's playhead (the host plays a 1 MB/s video, sends its position at 1 Hz on the ctrl lane
  and calls `setGroupPlayhead` with the app's 25 s window and 8 s hot window), and mpv after a seek: each viewer
  reads pieces from the target through its `PieceSource`, blocking like the stream server (`reader.blockedOn` →
  scheduler → `blocked-changed` → the host's `setViewerUrgent`).
- Measured, every run:
  - pings from the host to each viewer every 100 ms, one on the ctrl lane (`sendCtrl`) and one datagram
    (`sendDatagram`), each answered at once; one-way delays use CLOCK_MONOTONIC, which every process on the
    machine shares, so they are exact;
  - the viewer's UDX stream as each ping leaves (BBR state, cwnd, inflight, srtt);
  - the netem backlog (`tc -s qdisc`, 4 Hz), what crossed the host's upload pipeline per wire, per-wire queues;
  - per-piece traces of the trials' pieces: reveal (`have` pushed), request in/out, release, first and last block
    past the host's throttle, first block in, verified;
  - event-loop delay (`monitorEventLoopDelay`, 10 ms resolution) in every member, `/proc/loadavg` every 5 s, and a
    hash of every `src/` file the run uses, before and after (no run saw a change).
- Timeline: full mesh → 6 s idle (pings only: the idle baselines) → start → warm-up → 60 s measure window → finish.

### 2.2 The two parts

- **Part A** (ADR 0003 round 4's bench): no netem rate; the app's upload limit (1000 KiB/s) is the bottleneck.
  128 MiB, 256 KiB pieces, 3 viewers (or 1). Every ~2.5 s (jittered) one viewer, in turn, reads one piece far past
  everyone's frontier; 10 s warm-up. Metric: blocked → verified.
- **Part B**: the host's uplink is netem `rate 20mbit` or `50mbit` (2.5 / 6.25 MB/s), no app limit unless the
  variant sets one. 1 GiB, 1 MiB pieces (the app's smallest), 3 viewers downloading from the start. Every ~8 s
  (jittered) a group seek to an untouched spot: `setGroupPlayhead(seek)` plus a ctrl `seek` frame; each viewer then
  reads 4 pieces from the target. 12 s warm-up. Metrics: blocked → verified (first piece), seek → 4 pieces, the
  ctrl RTT and the datagram one-way delay during the measure window (the uplink is saturated throughout: viewers
  download the whole file), wire use and payload throughput, dupFactor.

### 2.3 Prototypes (all from outside `src/`)

- **`jit`** (`lib/upload-sched.ts`). On the host, each wire's `_onRequest` is replaced by an own property (the
  parser calls `this._onRequest`, bittorrent-protocol index.js:1025), so requests are held. A held request is
  released, exactly as upstream would answer it (index.js:696-718: `peerRequests`, `'request'` with a respond
  callback, so WebTorrent's store read, the engine's served-block count and the Revealer's hooks are unchanged), when
  - the wire's queue is under max(32 KiB, 100 ms of the wire's drain rate). The queue is what was released and is
    still being read from the store, plus what was pushed into the wire and has not crossed WebTorrent's `'upload'`
    Transform (peer.js:135-155); and
  - with a rate (the app's limit, or the pacer's), the scheduler's own token bucket (20 ms deep) has tokens.
    WebTorrent's throttle is then off, and the engine's limit field is set directly so the Revealer's budget sees
    the same rate.
  - `_onCancel` drops a held request; `choke` rejects held ones (BEP 6) as upstream rejects queued ones.
- **Release order** (`--urgent`): `off` = FIFO; `global` = class 0 (a piece some viewer's reader is blocked on, from
  the Revealer's urgent reports) before class 1 (the group's hot window and critical ranges) before class 2,
  across wires; FIFO within a class on a wire; round-robin between wires.
- **`preempt`**: when a viewer reports a new blocked piece, its held class-2 requests are rejected (BEP 6). They were
  never served, so nothing is sent twice; WebTorrent cancels each reservation and refills the freed pipeline slots at
  once in its R6 order, whose head is the blocked piece. (ADR 0003 Follow-up 2 cancelled requests the host had
  already answered; that data was sent anyway, then again.)
- **`jit-udx`** ("d" in the labels): the wire's queue also counts what its connection handed to UDX and UDX has not
  sent: written − acked − inflight, from two counters added to udx-native's `_writev` / `_onack` (prototype patched
  before any stream exists; udx-native exposes `inflight` but not its send queue). The drain rate is then what UDX
  got acknowledged.
- **Pacer** (`lib/pacer.ts`), every 100 ms: per viewer, base = the minimum of the signal over 60 s (2 s buckets,
  seeded in the idle phase), current = the minimum over the last 500 ms; queueing delay = the median over viewers
  (the uplink delays every lane alike; one stream's trouble only its own). Start: ×1.3 per tick while the queue is
  under target/2 and the rate is what limits the upload. Then: above the target, cut 5 % per target's worth of queue
  (at most 20 %), not again for 2 s unless the queue grew by half; below it, regrow by 2 % × (target − queue)/target
  per tick under 0.9 × the rate of the last cut, 0.4 % up to it, and probe above it at 0.8 %; never above 1.25 × the
  best upload of the last 2 s + 64 KB/s, never under 250 KB/s. Signals:
  - `ctrl`: the one-way delay of the ctrl pings (the router queue plus the stream's own send queue);
  - `udx`: UDX's smoothed RTT of each viewer's stream, read every 50 ms while it sends (the router queue only; no
    probe traffic, so the app could use it as is).
  - Without `jit` the pacer drives WebTorrent's throttle (`setUploadLimit`), with its bucket cut from 1 s of rate to
    50 ms; with `jit` it sets the scheduler's rate.
- **Fixed limit**: `--limit-kbps` = 85 % of the 5 s peak the baseline reached in calibration runs (2.40 MB/s at
  20 Mbit/s → 1995 KiB/s; 6.20 MB/s at 50 Mbit/s → 5147 KiB/s), through WebTorrent's throttle (`f85`) or the jit
  scheduler (`f85jd`).

### 2.4 Variants

| Label                  | Part | What                                                                           |
| ---------------------- | ---- | ------------------------------------------------------------------------------ |
| `a3-base`, `a1-base`   | A    | as shipped (3 viewers / 1 viewer)                                              |
| `a3-jit`               | A    | jit, FIFO                                                                      |
| `a3-jitu`              | A    | jit, urgent first                                                              |
| `a3-jitup`, `a1-jitup` | A    | jit, urgent first, preempt                                                     |
| `bR-base`              | B    | as shipped, R = 20 or 50 Mbit/s                                                |
| `bR-f85` / `bR-f85jd`  | B    | fixed 85 % limit, WebTorrent's throttle / jit-udx + urgent + preempt           |
| `bR-pacer`             | B    | pacer (ctrl, 40 ms) on WebTorrent's throttle                                   |
| `bR-pjit` / `bR-pjitd` | B    | pacer (ctrl, 40 ms) + jit + urgent + preempt, queue to the throttle / into UDX |
| `bR-pxjitd`            | B    | pacer (UDX srtt, 20 ms) + jit-udx + urgent + preempt                           |
| `bR-jitd`              | B    | jit-udx + urgent + preempt without any rate                                    |

Each variant ran 3 times (§8 has the command); delays and read times are pooled over the runs, throughput and
dupFactor are medians with the range.

## 3. Results

Tables from `summarize.ts` over the matrix (66 runs). Load is the 1-min load average when the run started ("max":
the highest sample during the group's runs). Delays and read times are pooled over the group's runs; wire use,
throughput and dupFactor are medians over runs (range in brackets). "Wire / link" is what left netem over its rate
(headers included); "payload / link" is the piece data that crossed the host's upload pipeline. The raw data and
`summary.json` were in the session scratchpad (tmpfs, lost on reboot): these tables are the record. Trimmed from
the script's output: the per-run table's load max and `src changed` columns (`src/` changed in no run) and the link
table's netem drops (0 in every run).

### 3.1 Part A: app limit 1000 KiB/s, a reader blocked far past the frontier (ms)

"Starved wire-s": wire-seconds with work waiting (≥ 16 KiB queued or a held request) that got < 10 % of the host's
upload in that second. "Busiest wire share": per second, the busiest wire's share of the host's upload (1/3 is fair
with 3 viewers). Loop p99: event-loop delay p99, the highest over the group's runs (host; viewers).

| variant  | runs | load1 start   | max | trials | blocked p50 | p95  | up / limit | dupFactor | starved wire-s % | busiest wire share p50 | p90  | ctrl RTT p50 | p95 | loop p99 host | viewers |
| -------- | ---- | ------------- | --- | ------ | ----------- | ---- | ---------- | --------- | ---------------- | ---------------------- | ---- | ------------ | --- | ------------- | ------- |
| a3-base  | 3    | 0.5 (0.3-1.3) | 1.3 | 69     | 1907        | 3786 | 1 (1-1)    | 1 (1-1)   | 12.9             | 0.52                   | 0.76 | 31           | 32  | 11.7          | 11.6    |
| a3-jit   | 3    | 0.3 (0.2-0.6) | 0.6 | 70     | 1584        | 1873 | 1 (1-1)    | 1 (1-1)   | 0                | 0.33                   | 0.34 | 30           | 31  | 11.8          | 11.6    |
| a3-jitu  | 3    | 0.4 (0.4-0.9) | 1.7 | 71     | 524         | 837  | 1 (1-1)    | 1 (1-1)   | 0                | 0.35                   | 0.49 | 30           | 32  | 11.7          | 11.6    |
| a3-jitup | 3    | 0.5 (0.4-0.8) | 1   | 72     | 314         | 471  | 1 (1-1)    | 1 (1-1)   | 0                | 0.35                   | 0.49 | 30           | 32  | 11.6          | 11.6    |
| a1-base  | 3    | 0.4 (0.1-0.5) | 0.5 | 71     | 1111        | 1476 | 1 (1-1)    | 1 (1-1)   | 0                | -                      | -    | 31           | 32  | 12            | 11.8    |
| a1-jitup | 3    | 0.3 (0.1-0.3) | 0.3 | 71     | 289         | 431  | 1 (1-1)    | 1 (1-1)   | 0                | -                      | -    | 31           | 32  | 11.9          | 11.8    |

### 3.2 Part B: uplink is the bottleneck, group seeks (ms)

"Seeks x viewers": reads measured. Seek → 1st piece and → 4 pieces count from the host's `seek` frame; blocked counts
from the reader blocking to the piece verified.

| variant    | runs | load1 start   | max | seeks x viewers | seek -> 1st piece p50 | p95  | blocked p50 | p95  | 4 pieces p50 | p95  | aborted | dupFactor           |
| ---------- | ---- | ------------- | --- | --------------- | --------------------- | ---- | ----------- | ---- | ------------ | ---- | ------- | ------------------- |
| b20-base   | 3    | 0.1 (0.1-0.3) | 0.8 | 63              | 2116                  | 2836 | 1695        | 2320 | 3499         | 4146 | 0       | 1 (1-1)             |
| b20-f85    | 3    | 0.3 (0.1-0.5) | 1.2 | 60              | 2737                  | 3932 | 2710        | 3905 | 4265         | 5314 | 0       | 1.028 (1.012-1.036) |
| b20-f85jd  | 3    | 0.3 (0.3-0.4) | 0.9 | 63              | 683                   | 871  | 658         | 842  | 2295         | 2513 | 0       | 1 (1-1)             |
| b20-pacer  | 3    | 0.4 (0.1-0.6) | 0.8 | 62              | 2311                  | 3593 | 2282        | 3507 | 3913         | 4841 | 0       | 1.008 (1.007-1.012) |
| b20-pjit   | 3    | 0.5 (0.5-0.7) | 0.7 | 61              | 711                   | 988  | 656         | 916  | 2446         | 2985 | 0       | 1 (1-1.005)         |
| b20-pjitd  | 3    | 0.3 (0.2-0.8) | 1.6 | 63              | 692                   | 1214 | 640         | 1149 | 2354         | 2991 | 0       | 1 (1-1.003)         |
| b20-pxjitd | 3    | 0.7 (0.3-1.1) | 1.2 | 66              | 659                   | 897  | 620         | 824  | 2256         | 2710 | 0       | 1 (1-1)             |
| b20-jitd   | 3    | 0.8 (0.3-0.9) | 0.9 | 66              | 1715                  | 2076 | 1528        | 1890 | 2962         | 3434 | 0       | 1 (1-1)             |
| b50-base   | 3    | 0.5 (0.3-0.6) | 1.4 | 63              | 1203                  | 1515 | 997         | 1308 | 1783         | 2013 | 0       | 1.003 (1.003-1.008) |
| b50-f85    | 3    | 0.7 (0.6-0.9) | 1   | 60              | 1042                  | 2679 | 1017        | 2655 | 2562         | 3730 | 0       | 1.005 (1.003-1.006) |
| b50-f85jd  | 3    | 0.9 (0.6-1)   | 1.5 | 63              | 409                   | 580  | 384         | 558  | 1104         | 1250 | 0       | 1.009 (1.009-1.01)  |
| b50-pacer  | 3    | 0.6 (0.5-0.9) | 1.2 | 63              | 1272                  | 2748 | 1186        | 2712 | 2415         | 3283 | 0       | 1.003 (1-1.009)     |
| b50-pjit   | 3    | 0.7 (0.6-1.1) | 1.3 | 63              | 456                   | 647  | 412         | 544  | 1124         | 1407 | 0       | 1.008 (1.006-1.014) |
| b50-pjitd  | 3    | 0.5 (0.5-0.7) | 0.8 | 60              | 448                   | 708  | 405         | 598  | 1088         | 1286 | 0       | 1.012 (1.005-1.013) |
| b50-pxjitd | 3    | 0.5 (0.3-0.6) | 1.5 | 60              | 451                   | 845  | 402         | 674  | 1125         | 1648 | 0       | 1.01 (1.006-1.017)  |
| b50-jitd   | 3    | 0.7 (0.3-1.1) | 1.1 | 63              | 851                   | 1280 | 690         | 1113 | 1333         | 2129 | 0       | 1.016 (1.013-1.019) |

### 3.3 Part B: delays and link use during saturation

Delays (ms). Idle: the 6 s idle phase. "Net queue": datagram one-way minus its idle median (the router queue).
"Stream": ctrl one-way minus the datagram sent with it (UDX's send queue and the stream's own stalls). "Stream > 50":
% of pings whose stream wait exceeded 50 ms; "of which PROBE_RTT": % of those that saw their stream in PROBE_RTT from
200 ms before to 600 ms after they left.

| variant    | ctrl RTT idle | ctrl RTT p50 | p95 | p99 | dgram 1-way idle | dgram p50 | p95 | net queue p50 | p95 | stream p50 | p95 | p99 | stream > 50 % | of which PROBE_RTT % | dgram loss % |
| ---------- | ------------- | ------------ | --- | --- | ---------------- | --------- | --- | ------------- | --- | ---------- | --- | --- | ------------- | -------------------- | ------------ |
| b20-base   | 31            | 427          | 580 | 666 | 21               | 75        | 109 | 54            | 88  | 338        | 493 | 576 | 98            | 11                   | 0.17         |
| b20-f85    | 31            | 34           | 84  | 206 | 21               | 23        | 55  | 3             | 34  | 0          | 8   | 148 | 2.2           | 56                   | 0.06         |
| b20-f85jd  | 31            | 35           | 45  | 113 | 21               | 23        | 29  | 3             | 8   | 0          | 7   | 80  | 1.3           | 96                   | 0            |
| b20-pacer  | 31            | 71           | 272 | 390 | 21               | 54        | 118 | 33            | 97  | 0          | 185 | 314 | 18.4          | 24                   | 0.11         |
| b20-pjit   | 31            | 50           | 244 | 395 | 21               | 34        | 106 | 13            | 85  | 0          | 173 | 304 | 15.4          | 25                   | 0.17         |
| b20-pjitd  | 31            | 55           | 168 | 234 | 21               | 42        | 95  | 21            | 74  | 0          | 76  | 177 | 8.1           | 31                   | 0.17         |
| b20-pxjitd | 31            | 46           | 127 | 199 | 21               | 33        | 85  | 12            | 64  | 0          | 47  | 151 | 4.5           | 53                   | 0.06         |
| b20-jitd   | 31            | 189          | 232 | 338 | 21               | 68        | 82  | 47            | 61  | 110        | 150 | 285 | 98.9          | 10                   | 0.11         |
| b50-base   | 31            | 220          | 284 | 420 | 21               | 73        | 100 | 53            | 79  | 134        | 193 | 347 | 94.4          | 11                   | 0.17         |
| b50-f85    | 31            | 32           | 83  | 176 | 21               | 21        | 50  | 1             | 29  | 0          | 35  | 137 | 3.5           | 27                   | 0.06         |
| b50-f85jd  | 31            | 34           | 64  | 203 | 21               | 23        | 38  | 2             | 17  | 0          | 20  | 170 | 2.6           | 85                   | 0.06         |
| b50-pacer  | 31            | 77           | 181 | 287 | 21               | 57        | 106 | 36            | 85  | 0          | 96  | 211 | 12.5          | 20                   | 0.17         |
| b50-pjit   | 31            | 56           | 219 | 261 | 21               | 39        | 80  | 19            | 59  | 0          | 137 | 211 | 14.8          | 27                   | 0.11         |
| b50-pjitd  | 31            | 59           | 153 | 253 | 21               | 43        | 83  | 23            | 63  | 0          | 73  | 212 | 7.9           | 40                   | 0.17         |
| b50-pxjitd | 31            | 42           | 157 | 234 | 21               | 29        | 79  | 8             | 58  | 0          | 76  | 192 | 7             | 35                   | 0.13         |
| b50-jitd   | 31            | 174          | 209 | 364 | 21               | 60        | 78  | 39            | 58  | 103        | 121 | 310 | 98.5          | 10                   | 0.17         |

Link use. Netem backlog includes the 20 ms delay line. App queue: per wire, above the connection; UDX unsent: per
wire, handed to UDX and not yet sent (jit-udx variants only). Pacer queue est: the pacer's own queueing-delay
estimate.

| variant    | wire / link      | payload / link   | vs base | payload kB/s     | netem backlog p50 (incl. 20 ms line) | p95           | UDX rtx    | app queue / wire p50 KiB | p95  | UDX unsent / wire p50 KiB | p95 | pacer kB/s p50   | pacer queue est p50 | pings in PROBE_RTT % | loop p99 host | viewers |
| ---------- | ---------------- | ---------------- | ------- | ---------------- | ------------------------------------ | ------------- | ---------- | ------------------------ | ---- | ------------------------- | --- | ---------------- | ------------------- | -------------------- | ------------- | ------- |
| b20-base   | 0.98 (0.98-0.99) | 0.94 (0.94-0.94) | 1       | 2346 (2338-2355) | 74 (71-78)                           | 104 (104-115) | 0 (0-0)    | 208                      | 448  | -                         | -   | -                | -                   | 2.7                  | 10.9          | 11      |
| b20-f85    | 0.86 (0.86-0.86) | 0.82 (0.82-0.82) | 0.871   | 2043 (2043-2043) | 21 (21-21)                           | 54 (53-56)    | 1 (1-3)    | 448                      | 769  | -                         | -   | -                | -                   | 1.2                  | 11            | 11      |
| b20-f85jd  | 0.86 (0.86-0.86) | 0.82 (0.82-0.82) | 0.871   | 2042 (2041-2042) | 21 (21-21)                           | 28 (27-30)    | 0 (0-0)    | 0                        | 0    | 0                         | 15  | -                | -                   | 1.5                  | 10.9          | 11      |
| b20-pacer  | 0.96 (0.94-0.98) | 0.91 (0.89-0.93) | 0.969   | 2271 (2234-2320) | 48 (36-59)                           | 116 (112-117) | 2 (0-3)    | 448                      | 769  | -                         | -   | 2284 (2270-2302) | 11 (5-22)           | 2.3                  | 10.9          | 11      |
| b20-pjit   | 0.95 (0.93-0.96) | 0.9 (0.88-0.91)  | 0.962   | 2255 (2205-2278) | 32 (26-41)                           | 104 (95-116)  | 0 (0-0)    | 0                        | 0    | -                         | -   | 2256 (2213-2285) | 5 (3-6)             | 2.3                  | 10.9          | 11.1    |
| b20-pjitd  | 0.98 (0.96-0.98) | 0.93 (0.92-0.93) | 0.989   | 2320 (2290-2327) | 39 (31-48)                           | 94 (92-96)    | 0 (0-0)    | 0                        | 0    | 0                         | 60  | 2346 (2310-2346) | 10 (5-20)           | 2.4                  | 10.9          | 11      |
| b20-pxjitd | 0.97 (0.96-0.97) | 0.92 (0.91-0.92) | 0.978   | 2292 (2267-2298) | 31 (26-39)                           | 82 (78-88)    | 0 (0-0)    | 0                        | 0    | 0                         | 51  | 2298 (2263-2319) | 2 (1-4)             | 2.1                  | 10.9          | 11.1    |
| b20-jitd   | 0.98 (0.98-0.98) | 0.93 (0.93-0.94) | 0.996   | 2335 (2334-2337) | 69 (65-73)                           | 80 (74-84)    | 0 (0-0)    | 0                        | 0    | 91                        | 118 | -                | -                   | 2.8                  | 10.9          | 11      |
| b50-base   | 0.98 (0.98-0.98) | 0.93 (0.93-0.94) | 1       | 5832 (5830-5852) | 73 (71-75)                           | 99 (95-104)   | 0 (0-0)    | 673                      | 1441 | -                         | -   | -                | -                   | 3                    | 11.1          | 11.6    |
| b50-f85    | 0.89 (0.89-0.89) | 0.84 (0.84-0.84) | 0.904   | 5271 (5270-5271) | 19 (19-20)                           | 48 (48-53)    | 3 (1-5)    | 1025                     | 2050 | -                         | -   | -                | -                   | 1.1                  | 11.1          | 11.5    |
| b50-f85jd  | 0.89 (0.89-0.89) | 0.84 (0.84-0.84) | 0.904   | 5269 (5264-5272) | 20 (20-20)                           | 36 (31-40)    | 12 (2-15)  | 0                        | 0    | 0                         | 60  | -                | -                   | 2.2                  | 11.1          | 11.8    |
| b50-pacer  | 0.98 (0.97-0.99) | 0.94 (0.93-0.94) | 1.006   | 5870 (5809-5896) | 55 (55-57)                           | 108 (99-108)  | 2 (0-3)    | 977                      | 2178 | -                         | -   | 5869 (5859-5884) | 26 (25-28)          | 2                    | 11.2          | 11.7    |
| b50-pjit   | 0.94 (0.94-0.96) | 0.9 (0.9-0.92)   | 0.965   | 5623 (5608-5726) | 39 (37-39)                           | 81 (80-82)    | 31 (12-38) | 0                        | 48   | -                         | -   | 5708 (5694-5760) | 7 (5-11)            | 2.2                  | 11.2          | 11.8    |
| b50-pjitd  | 0.97 (0.97-0.98) | 0.93 (0.92-0.93) | 0.994   | 5797 (5759-5838) | 41 (35-48)                           | 83 (72-85)    | 0 (0-3)    | 0                        | 0    | 6                         | 154 | 5874 (5797-5883) | 11 (10-21)          | 2.4                  | 11.1          | 11.8    |
| b50-pxjitd | 0.97 (0.96-0.97) | 0.92 (0.91-0.92) | 0.986   | 5751 (5687-5758) | 29 (26-30)                           | 81 (70-84)    | 11 (0-39)  | 0                        | 0    | 4                         | 139 | 5729 (5727-5752) | 1 (1-1)             | 2.3                  | 11.3          | 11.7    |
| b50-jitd   | 0.98 (0.98-0.98) | 0.93 (0.93-0.94) | 1       | 5831 (5828-5851) | 60 (59-61)                           | 76 (72-88)    | 0 (0-0)    | 0                        | 0    | 209                       | 255 | -                | -                   | 2.8                  | 11.1          | 11.6    |

### 3.4 Where a read's time goes

Medians, ms after the trial started (the host's `far` or `seek` frame), for the first piece of each read that came
from the host (number of reads in brackets). Part A, 3 viewers and 1 (with 1 viewer the reveal steps are not
traced):

| step                         | a3-base (69) | a3-jit (70) | a3-jitu (71) | a3-jitup (72) | a1-base (71) | a1-jitup (71) |
| ---------------------------- | ------------ | ----------- | ------------ | ------------- | ------------ | ------------- |
| reveal (have pushed)         | 32           | 31          | 31           | 31            | -            | -             |
| have past the throttle       | 648          | 31          | 31           | 31            | -            | -             |
| viewer: have in              | 668          | 52          | 52           | 52            | -            | -             |
| viewer: request out          | 995          | 259         | 248          | 52            | 246          | 53            |
| request in                   | 1005         | 269         | 258          | 64            | 256          | 64            |
| released                     | -            | 865         | 265          | 73            | -            | 64            |
| 1st block past the throttle  | 1379         | 865         | 265          | 74            | 869          | 64            |
| viewer: 1st block in         | 1403         | 886         | 288          | 95            | 898          | 85            |
| last block past the throttle | 1882         | 1583        | 523          | 313           | 1108         | 287           |
| viewer: verified             | 1927         | 1604        | 545          | 335           | 1133         | 310           |

Part B, 20 Mbit/s:

| step                         | b20-base (21) | b20-f85 (20) | b20-f85jd (21) | b20-pacer (21) | b20-pjit (20) | b20-pjitd (21) | b20-pxjitd (22) | b20-jitd (22) |
| ---------------------------- | ------------- | ------------ | -------------- | -------------- | ------------- | -------------- | --------------- | ------------- |
| reveal (have pushed)         | 170           | 33           | 37             | 54             | 50            | 49             | 42              | 92            |
| have past the throttle       | 312           | 590          | 37             | 546            | 50            | 49             | 42              | 92            |
| viewer: have in              | 777           | 618          | 65             | 637            | 119           | 98             | 72              | 273           |
| viewer: request out          | 777           | 618          | 65             | 637            | 119           | 98             | 72              | 273           |
| request in                   | 793           | 629          | 76             | 649            | 130           | 110            | 83              | 283           |
| released                     | -             | -            | 76             | -              | 130           | 114            | 83              | 283           |
| 1st block past the throttle  | 794           | 647          | 77             | 780            | 130           | 114            | 83              | 284           |
| viewer: 1st block in         | 852           | 674          | 105            | 807            | 157           | 156            | 112             | 380           |
| last block past the throttle | 1640          | 2610         | 565            | 2178           | 589           | 564            | 553             | 1467          |
| viewer: verified             | 2092          | 2638         | 594            | 2207           | 639           | 647            | 600             | 1663          |

Part B, 50 Mbit/s:

| step                         | b50-base (21) | b50-f85 (20) | b50-f85jd (21) | b50-pacer (21) | b50-pjit (21) | b50-pjitd (20) | b50-pxjitd (20) | b50-jitd (21) |
| ---------------------------- | ------------- | ------------ | -------------- | -------------- | ------------- | -------------- | --------------- | ------------- |
| reveal (have pushed)         | 98            | 34           | 40             | 70             | 44            | 49             | 60              | 73            |
| have past the throttle       | 386           | 299          | 40             | 558            | 44            | 49             | 60              | 73            |
| viewer: have in              | 562           | 337          | 63             | 639            | 83            | 84             | 127             | 240           |
| viewer: request out          | 563           | 337          | 63             | 639            | 83            | 84             | 127             | 240           |
| request in                   | 577           | 352          | 73             | 652            | 94            | 95             | 137             | 251           |
| released                     | -             | -            | 74             | -              | 94            | 95             | 138             | 251           |
| 1st block past the throttle  | 579           | 573          | 74             | 755            | 95            | 96             | 138             | 252           |
| viewer: 1st block in         | 604           | 613          | 99             | 829            | 152           | 128            | 162             | 353           |
| last block past the throttle | 894           | 894          | 270            | 1090           | 279           | 289            | 311             | 637           |
| viewer: verified             | 1146          | 956          | 355            | 1244           | 410           | 395            | 401             | 804           |

### 3.5 Per run

| run          | load1 start | blocked p50 | p95    | ctrl RTT p50 | p95   | dgram 1-way p50 | p95   | up / link or limit | dupFactor |
| ------------ | ----------- | ----------- | ------ | ------------ | ----- | --------------- | ----- | ------------------ | --------- |
| a3-base-1    | 0.31        | 1829.8      | 3785.9 | 30.5         | 31.6  | 20.2            | 20.9  | 1                  | 1         |
| a3-base-2    | 0.51        | 2245.8      | 4714.9 | 30.5         | 31.8  | 20.2            | 21.1  | 1                  | 1         |
| a3-base-3    | 1.27        | 1906.8      | 3503.7 | 30.5         | 31.7  | 20.2            | 21.1  | 1                  | 1         |
| a3-jit-1     | 0.24        | 1636.4      | 1873   | 30.5         | 31.5  | 20.2            | 20.9  | 1.001              | 1         |
| a3-jit-2     | 0.6         | 1536.2      | 1798.9 | 30.5         | 31.3  | 20.2            | 20.8  | 1.001              | 1         |
| a3-jit-3     | 0.28        | 1549.1      | 1858.1 | 30.5         | 31.5  | 20.2            | 20.9  | 1.001              | 1         |
| a3-jitu-1    | 0.39        | 498.4       | 804.9  | 30.5         | 31.7  | 20.2            | 20.9  | 1.001              | 1         |
| a3-jitu-2    | 0.94        | 488.2       | 737.4  | 30.5         | 31.6  | 20.2            | 20.8  | 1.001              | 1         |
| a3-jitu-3    | 0.43        | 589.6       | 836.5  | 30.5         | 31.7  | 20.2            | 20.9  | 1.001              | 1         |
| a3-jitup-1   | 0.37        | 318.3       | 467.7  | 30.4         | 31.8  | 20.2            | 20.9  | 1.001              | 1         |
| a3-jitup-2   | 0.51        | 313.2       | 406.8  | 30.5         | 31.5  | 20.2            | 20.8  | 1.001              | 1         |
| a3-jitup-3   | 0.81        | 313.6       | 483.7  | 30.5         | 31.6  | 20.2            | 20.9  | 1.001              | 1         |
| a1-base-1    | 0.42        | 1116.9      | 1476.3 | 30.8         | 32    | 20.3            | 21.1  | 1                  | 1         |
| a1-base-2    | 0.45        | 1065.9      | 1421.2 | 30.9         | 34.3  | 20.3            | 21    | 1                  | 1         |
| a1-base-3    | 0.14        | 1177.8      | 1436.2 | 30.9         | 32.8  | 20.3            | 21.1  | 1                  | 1         |
| a1-jitup-1   | 0.33        | 288.6       | 424.3  | 30.7         | 32.2  | 20.3            | 21.1  | 0.996              | 1         |
| a1-jitup-2   | 0.32        | 288.6       | 458.9  | 30.8         | 32.2  | 20.3            | 21.1  | 0.999              | 1         |
| a1-jitup-3   | 0.1         | 289         | 412.9  | 30.8         | 32.2  | 20.3            | 21.1  | 0.999              | 1         |
| b20-base-1   | 0.33        | 1617.9      | 2126.2 | 421.3        | 582.1 | 71.4            | 105.8 | 0.938              | 1         |
| b20-base-2   | 0.09        | 1883.7      | 2462.7 | 434.4        | 591   | 78.6            | 115.7 | 0.942              | 1         |
| b20-base-3   | 0.13        | 1620.9      | 1891.3 | 426.8        | 564.1 | 73.3            | 102.9 | 0.935              | 1         |
| b20-f85-1    | 0.54        | 2503.6      | 3059   | 34.3         | 86.3  | 23.1            | 61.5  | 0.817              | 1.012     |
| b20-f85-2    | 0.25        | 3101.4      | 4272.2 | 34.4         | 80.5  | 23.4            | 49.7  | 0.817              | 1.028     |
| b20-f85-3    | 0.15        | 2443.2      | 3350.7 | 34.3         | 85    | 23.4            | 52.6  | 0.817              | 1.036     |
| b20-f85jd-1  | 0.35        | 663.9       | 775.3  | 34.9         | 42.6  | 23.4            | 28.2  | 0.817              | 1         |
| b20-f85jd-2  | 0.31        | 699         | 998.8  | 34.5         | 50.7  | 23.7            | 30.7  | 0.816              | 1         |
| b20-f85jd-3  | 0.36        | 635.2       | 667.6  | 34.4         | 42.8  | 23.3            | 28.3  | 0.817              | 1         |
| b20-pacer-1  | 0.4         | 2160.4      | 2812.1 | 80.2         | 244.4 | 60              | 118   | 0.928              | 1.007     |
| b20-pacer-2  | 0.12        | 2249.6      | 3506.6 | 67.5         | 266   | 50.6            | 115.6 | 0.909              | 1.012     |
| b20-pacer-3  | 0.58        | 2345        | 3519.9 | 64.6         | 304   | 44              | 118.4 | 0.894              | 1.008     |
| b20-pjit-1   | 0.52        | 663.4       | 751.5  | 44.8         | 257   | 29.6            | 90.7  | 0.882              | 1         |
| b20-pjit-2   | 0.72        | 681.5       | 921.7  | 47.8         | 225.7 | 32.5            | 103.8 | 0.902              | 1.005     |
| b20-pjit-3   | 0.5         | 626.2       | 959.3  | 58.1         | 256.2 | 41.2            | 118.1 | 0.911              | 1         |
| b20-pjitd-1  | 0.78        | 644.2       | 1055.3 | 46.2         | 174.2 | 33.4            | 97.1  | 0.916              | 1         |
| b20-pjitd-2  | 0.18        | 638         | 1299.8 | 54.3         | 168.2 | 41.8            | 95.6  | 0.931              | 1.003     |
| b20-pjitd-3  | 0.35        | 640.3       | 1148.6 | 64.3         | 156.8 | 49.5            | 91    | 0.928              | 1         |
| b20-pxjitd-1 | 1.09        | 630.1       | 974.6  | 39.8         | 119.2 | 28              | 92.4  | 0.907              | 1         |
| b20-pxjitd-2 | 0.26        | 604.1       | 693.8  | 46.3         | 129.3 | 32.7            | 84.4  | 0.917              | 1         |
| b20-pxjitd-3 | 0.73        | 613.1       | 804.9  | 53.2         | 131.1 | 38.7            | 78.6  | 0.919              | 1         |
| b20-jitd-1   | 0.89        | 1440.9      | 1650.4 | 191.5        | 233.1 | 73              | 84.8  | 0.935              | 1         |
| b20-jitd-2   | 0.33        | 1555        | 1928   | 189.9        | 236.3 | 68.8            | 80.4  | 0.934              | 1         |
| b20-jitd-3   | 0.83        | 1570.4      | 1965.2 | 185.8        | 224.3 | 65.7            | 72.7  | 0.934              | 1         |
| b50-base-1   | 0.29        | 896.2       | 1170.5 | 220.2        | 288   | 73.9            | 98.8  | 0.933              | 1.003     |
| b50-base-2   | 0.6         | 1213.9      | 1382.9 | 217.7        | 284.3 | 70.5            | 97.1  | 0.933              | 1.003     |
| b50-base-3   | 0.52        | 982.1       | 1178   | 222.2        | 277.9 | 75.7            | 103.2 | 0.936              | 1.008     |
| b50-f85-1    | 0.67        | 1168.4      | 2924.7 | 32.4         | 78.9  | 21.3            | 46.6  | 0.843              | 1.006     |
| b50-f85-2    | 0.93        | 1019.2      | 1795.5 | 32.3         | 72.9  | 21.3            | 45.8  | 0.843              | 1.003     |
| b50-f85-3    | 0.58        | 946.7       | 2654.5 | 32.7         | 94.1  | 21.5            | 52.9  | 0.843              | 1.005     |
| b50-f85jd-1  | 1           | 389         | 443.5  | 33.7         | 71.8  | 22.6            | 40.6  | 0.842              | 1.01      |
| b50-f85jd-2  | 0.86        | 381.5       | 551.5  | 33.4         | 64.2  | 22.5            | 36.5  | 0.843              | 1.009     |
| b50-f85jd-3  | 0.59        | 379.3       | 768.3  | 33.4         | 59.5  | 22.7            | 36.3  | 0.843              | 1.009     |
| b50-pacer-1  | 0.95        | 1080.6      | 2723.9 | 76.5         | 167.5 | 57              | 105.6 | 0.943              | 1.003     |
| b50-pacer-2  | 0.62        | 1589.4      | 2712   | 83.1         | 199.9 | 58              | 105.8 | 0.929              | 1.009     |
| b50-pacer-3  | 0.49        | 1091.4      | 1347.6 | 72.2         | 167.1 | 56.9            | 105.9 | 0.939              | 1         |
| b50-pjit-1   | 0.62        | 416.7       | 486.9  | 53.2         | 210.1 | 36.5            | 78.7  | 0.897              | 1.014     |
| b50-pjit-2   | 0.74        | 408.4       | 765.4  | 57.7         | 219.7 | 41.2            | 80.2  | 0.916              | 1.008     |
| b50-pjit-3   | 1.09        | 397.8       | 531.1  | 57.8         | 223.8 | 41              | 80.8  | 0.9                | 1.006     |
| b50-pjitd-1  | 0.46        | 408.7       | 597.6  | 63.4         | 153.2 | 50.2            | 89.8  | 0.934              | 1.005     |
| b50-pjitd-2  | 0.48        | 404.6       | 682.9  | 56.5         | 144.2 | 41.4            | 74    | 0.927              | 1.013     |
| b50-pjitd-3  | 0.74        | 376.3       | 443.6  | 54.3         | 160   | 39.1            | 82.4  | 0.921              | 1.012     |
| b50-pxjitd-1 | 0.61        | 442.7       | 1543.8 | 41.4         | 161.6 | 27.6            | 81.4  | 0.92               | 1.01      |
| b50-pxjitd-2 | 0.26        | 390.8       | 665.6  | 42.1         | 186.1 | 29.1            | 87    | 0.91               | 1.017     |
| b50-pxjitd-3 | 0.48        | 390.2       | 602    | 43           | 112.3 | 30.2            | 70.8  | 0.921              | 1.006     |
| b50-jitd-1   | 1.12        | 702.7       | 1381.1 | 173.2        | 201   | 59              | 76.1  | 0.933              | 1.019     |
| b50-jitd-2   | 0.72        | 679.2       | 1043.9 | 175.6        | 219.4 | 61.1            | 90.4  | 0.936              | 1.013     |
| b50-jitd-3   | 0.26        | 691.2       | 781.2  | 174          | 195   | 60.1            | 73.5  | 0.933              | 1.016     |

## 4. Findings

Pairs of numbers are 20 / 50 Mbit/s; delays and read times are medians unless a percentile is named.

1. **Where the host's upload waits, as shipped.**
   - The path: a request arrives → bittorrent-protocol answers it at once (index.js:696-718) → WebTorrent reads
     the store and calls `wire.piece` → `_push` ignores backpressure (index.js:608) → the wire's readable buffer →
     WebTorrent's upload throttle, a token bucket one second deep shared by every wire (peer.js:135-155,
     speed-limiter throttle-group.js:47-48) → MuxWireStream → Protomux → secret-stream → UDX's send queue → the
     network.
   - With the app's limit as the bottleneck (Part A) the queue is in the throttle: each wire holds what its viewer
     has asked for, and a `have` or an urgent block joins its tail. In `a3-base` the `have` for a blocked reader's
     piece waited 616 ms there (pushed at 32 ms, past the throttle at 648; §3.4), then the viewer's request waited
     0.33 s for a free pipeline slot (have in at 668 → request out at 995; ADR 0003 Finding 4 had ~0.6 s), then the
     piece's blocks queued again (request in at 1005 → first block past the throttle at 1379).
   - With the uplink as the bottleneck (Part B) it is in three places: the wire's buffer (208 / 673 KiB per wire),
     UDX's send queue and the router. A ctrl frame waited 338 / 134 ms longer than the datagram sent with it (UDX's
     queue, the "stream" column), and the datagram waited 54 / 53 ms over idle (the router, "net queue"; p95
     88 / 79). UDX's BBR keeps the router queue there by itself, a tenth of netem's 500 ms buffer.
   - MuxWireStream's strict backpressure does not keep video bytes out of the ctrl lane's way. UDX reports its
     stream drained until its own send queue holds a few hundred KB, whatever its congestion window allows, so the
     backpressure only starts behind that queue (338 ms at a ~0.78 MB/s share and 134 ms at ~1.94 MB/s are both
     ~0.26 MB).
   - WebTorrent's throttle is also unfair between wires. Nothing queues its waiters: a `Throttle` that just got
     tokens asks again at once for its next slice (rate/10 bytes, speed-limiter throttle.js:89-125), while each
     waiting one sleeps for its own deficit (limiter tokenBucket.js:106-111) and often wakes to an empty bucket. In
     `a3-base` the busiest of 3 wires took 0.52 of a second's upload (p90 0.76), against 0.33-0.35 with the
     scheduler's round-robin, and 12.9 % of the wire-seconds with data waiting got under a tenth of it (0 % with the
     scheduler).
2. **UDX's send queue fills when UDX's congestion window is the limit.** udx-native's BBR keeps its window near
   2 × its bandwidth estimate × the minimum RTT (a stream at a ~0.8 MB/s share and a 31 ms base RTT ran a 33-packet
   window). Once the router queue grows past about one base RTT, a stream cannot carry its share inside that
   window, and what the app writes beyond it waits in UDX's send queue, with the ctrl frames behind it. Per Part B
   ping (UDX's state as the ping left; not a `summarize.ts` column): when the viewer's stream was window-limited
   (inflight ≥ 90 % of cwnd × 1472 B), the ctrl frame waited 20-339 ms in the stream (median, by variant); when it
   was not, 0.1-0.2 ms in every variant with a rate. As shipped and in `jitd` the stream was window-limited for
   92-99 % of pings. Two consequences:
   - a pacer has to keep the router queue below about one base RTT, or bound UDX's send queue itself (a smoke run,
     not in the matrix, held 40 ms of router queue on UDX's srtt with the wire queue counted only down to
     WebTorrent's throttle: ctrl RTT p50 106 / p95 513 ms);
   - just-in-time release must count UDX's unsent bytes as part of a wire's queue (`jit-udx`). Without that
     (`pjit`) a stream that stalls keeps being fed: stream p95 173 / 137 ms against 76 / 73 with `pjitd`, ctrl p95
     244 / 219 against 168 / 153, and 0.962 / 0.965 of the shipped throughput against 0.989 / 0.994.
3. **(A) Just in time, urgent first and preempt cut the blocked read 6× with 3 viewers and 4× with 1, with no
   cost.** With 3 viewers at the 1000 KiB/s limit, blocked → verified went from 1907 ms (p95 3786; ADR 0003
   round 4 had 2.37 s) to 314 ms (p95 471) in `a3-jitup`; with one viewer from 1111 ms (p95 1476; round 4: 1.09 s)
   to 289 ms (p95 431). Upload stayed at the limit (1.00) and dupFactor at 1.00. Each part's share (§3.4):
   - just in time alone (`a3-jit`, FIFO): the `have` is in the viewer's hands at 52 ms instead of 668, but the
     request, once it arrives (269), waits in the host's hold queue behind the viewer's older requests until 865:
     1584 ms (p95 1873);
   - urgent first (`a3-jitu`): the blocked piece's requests are released as they arrive (258 → 265), and get the
     whole rate (class 0 goes first across wires): 524 ms (p95 837);
   - preempt (`a3-jitup`): the viewer's request goes out with the `have` (52 ms) instead of ~0.2 s later (248),
     because the host just rejected its held filler requests: 314 ms;
   - then the piece itself takes ~0.24 s (first to last block past the throttle, 74 → 313), its 256 KiB at about
     the full rate.
4. **(B) The fixed 85 % limit on WebTorrent's throttle fixes the delays by moving the queue into the throttle.**
   With `f85` the ctrl RTT is p50 34 / 32 ms, p95 84 / 83, and the datagrams p50 23 / 21, p95 55 / 50, but the
   per-wire queues are back in the throttle (448 / 1025 KiB per wire, against 208 / 673 as shipped):
   - at 20 Mbit/s group-seek reads are slower than shipped at p50 and p95: blocked 2710 ms (p95 3905) against 1695
     (2320), 4 pieces 4265 against 3499;
   - at 50 Mbit/s the first piece's median is the same (1017 against 997), but its p95 doubles (2655 against 1308)
     and 4 pieces take 2562 against 1783;
   - a few pieces leave the host twice (dupFactor 1.028 against 1.00 at 20 Mbit/s; 1.005 against 1.003 at 50): the
     Revealer's 3 s activity windows expire while assigned pieces sit in the throttle;
   - 14 / 11 % of the link is left unused (wire / link 0.86 / 0.89; payload 0.87 / 0.90 of the shipped path's).
   - Enforced by the scheduler instead (`f85jd`), the same limit gives the lowest p95 delays of every variant (ctrl
     45 / 64, datagrams 29 / 38) and reads as fast as the paced variants' (blocked 658 / 384, p95 842 / 558),
     dupFactor 1.00 / 1.01, at the same 0.82 / 0.84 payload share.
   - A fixed limit needs the uplink's capacity, which the app does not know, and it must be re-measured when that
     changes; set above it, the router queue comes back.
5. **(B) The pacer on the scheduler keeps the median delays near idle and 98-99 % of the throughput; its p95 is set
   by its cycle.** `pxjitd` (UDX srtt, 20 ms target) against `pjitd` (ctrl one-way delay, 40 ms):
   - throughput 0.978 / 0.986 of the shipped path's (`pjitd` 0.989 / 0.994). For comparison: `pacer` 0.969 /
     1.006, `pjit` 0.962 / 0.965, `jitd` 0.996 / 1.00, `f85` and `f85jd` 0.871 / 0.904;
   - ctrl RTT p50 46 / 42 ms (idle 31; shipped 427 / 220; `pjitd` 55 / 59), p95 127 / 157 (shipped 580 / 284;
     `pjitd` 168 / 153). Both meet ADR 0002's "ctrl p95 extra < 150 ms" pooled (extra 96 / 126 and 137 / 122); per
     run, every `pjitd` run does (≤ 143), one of six `pxjitd` runs does not (`b50-pxjitd-2`, 186: extra 155);
   - datagram one-way p50 33 / 29 ms (idle 21; shipped 75 / 73; `pjitd` 42 / 43), p95 85 / 79 (shipped 109 / 100;
     `pjitd` 95 / 83). The median router queue is mostly gone (net queue p50 12 / 8 against 54 / 53). The p95 is
     ~20 ms under the shipped path's but no lower than `jitd`'s (82 / 78), where BBR alone sets the queue, and ~4×
     the idle one-way: ADR 0002's "datagram p95 < 2× idle" is missed. Only `f85jd` meets it (1.4× / 1.8×). Loss
     ≤ 0.17 % in every variant;
   - group-seek reads: blocked 620 / 402 ms, p95 824 / 674 (shipped 1695 / 997, p95 2320 / 1308; `pjitd` 640 / 405,
     p95 1149 / 598), dupFactor 1.00 / 1.01.
   - The UDX-srtt signal at its lower target did as well as the ctrl pings or better on every delay but the ctrl
     p95 at 50 Mbit/s (157 against 153, a tie), with equal read medians, for ~1 % less throughput. It needs no probe
     traffic and no protocol change.
   - The p95 comes from the controller's cycle: it cuts (median 8 %) every 2.4-2.9 s (`pxjitd`; 2.5-3.5 s
     `pjitd`), probes 0.4-0.8 % per tick above the rate of its last cut, detects the queue 0.5-1 s late (a 500 ms
     minimum filter on a smoothed RTT) and holds its rate 2 s after a cut. The router queue is over 40 ms for
     19-22 % of the time (`pxjitd`; p95 64 / 58 ms, p99 82 / 84), about 0.5 s per cycle. A faster-reacting tuning
     (200 ms filter, 500 ms hold, half the probe) ran only in smoke runs and is not in the matrix (Follow-up 6).
   - On WebTorrent's throttle (`pacer`, ctrl, 40 ms) the same controller keeps the queues of finding 4 (448 / 977
     KiB per wire) and is worse than `pjitd` on delays and reads: ctrl p95 272 / 181 (extra 241 / 150: misses),
     blocked 2282 / 1186 ms, p95 3507 / 2712, slower than shipped; dupFactor 1.008 / 1.003.
6. **Just in time without any rate (`jitd`) caps the stream queue near 100 ms but leaves BBR's router queue.** The
   ctrl frame's wait in the stream is capped near the scheduler's 100 ms (110 / 103 ms, p95 150 / 121, against
   338 / 134 shipped), and reads get somewhat faster (blocked 1528 / 690 against 1695 / 997; 4 pieces 2962 / 1333
   against 3499 / 1783), but the datagrams see most of the shipped router queue (net queue 47 / 39 against 54 / 53;
   datagram p50 68 / 60, p95 82 / 78) and the ctrl RTT stays at 189 / 174 ms (p95 232 / 209). Throughput 0.996 /
   1.00. The pacer is what removes the router queue.
7. **With a fixed limit the rest of the tail is BBR's PROBE_RTT; with the pacer, mostly the pacer's cycle.** Every
   ~10 s, unless its minimum RTT was refreshed, each UDX stream spends ≥ 200 ms at a 4-packet window; a ctrl frame
   queued behind even 32 KiB on that stream then waits for it. 1.1-3.0 % of pings found their stream in PROBE_RTT
   (2.0-2.4 % in the paced variants). Of the ctrl frames that waited > 50 ms in the stream, 96 / 85 % with the
   scheduler-enforced fixed limit coincided with one (they were only 1.3 / 2.6 % of pings), but 20-53 % in the
   paced variants (`pxjitd` 53 / 35 %, of 4.5 / 7.0 % of pings): the rest waited behind a window-limited stream
   at the top of the pacer's cycle (finding 2). The app cannot prevent PROBE_RTT; it can keep less in UDX's queue
   (Follow-up 4).
8. **No measurable cost.** Event-loop delay p99 stayed at 10.9-12.0 ms in the host and 11.0-11.8 ms in the viewers
   (the highest run of each variant; the monitor's resolution is 10 ms), including the scheduler's 5 ms pump at
   6 MB/s.
9. **What these numbers do not cover.**
   - One kind of uplink: netem's rate with a 500 ms FIFO, a bufferbloated router without AQM, and no other traffic
     on it. A competing upload (Follow-up 2) and AQM routers (fq_codel, CAKE) were not run.
   - Viewer uplinks are unshaped, so viewer-to-viewer re-sharing is free here.
   - Three viewers, one machine, one clock. One-way delays are exact here; in the app the pacer's minimum filters
     cancel a constant clock offset, as LEDBAT's do.
   - UDX's congestion control is udx-native 1.21.3's BBR; another version changes the stream-queue numbers.
   - Every member and the testnet share one 14-core machine (quiet: load 0.1-1.7, in every table).

## 5. Decision

**Implement both, as one host upload scheduler in `src/core/transfer`, in this order:**

1. **Just-in-time release with urgent-first order and preempt** (Follow-up 7). Where the app's own rate is the
   bottleneck (its limit, or the pacer's rate) it cuts the blocked read 4-6× (Part A) and makes group seeks 2.5-4×
   faster than a limit on WebTorrent's throttle (`f85jd` against `f85`, `pjitd` against `pacer`). It enforces the
   rate itself, replacing WebTorrent's throttle, which is unfair between wires and holds a second of data. With the
   real uplink as the bottleneck and no rate (`jitd`) it only caps UDX's queue: reads 10-30 % faster, the router
   queue stays.
2. **A delay-based pacer driving the scheduler's rate, on UDX's srtt with a 20 ms target first** (`pxjitd`). It
   removes most of the router queue that ctrl and sync datagrams wait in (net queue p50 12 / 8 ms against 54 / 53),
   meets ADR 0002's ctrl criterion (p95 extra 96 / 126 ms pooled) and keeps 98-99 % of the shipped throughput. Over
   the ctrl-ping signal (`pjitd`) it has lower median delays, an equal or lower ctrl p95, no probe traffic and no
   protocol change, for ~1 % less throughput. Keep the ctrl-ping signal as the fallback if srtt proves noisy on
   real links. It does not meet ADR 0002's "datagram p95 < 2× idle" (85 / 79 ms against 21 idle); that stays open
   (Follow-up 6).
3. The wire's queue must be measured **down into UDX's send queue**, not only to WebTorrent's throttle: below the
   throttle, UDX takes ~0.26 MB per stream before it pushes back (finding 1), and a ctrl frame waits behind all of
   it (`pjit` against `pjitd`: ctrl p95 244 / 219 against 168 / 153 ms).

Do **not** ship the fixed-85 % suggestion of plan §4.5 as the remedy. On WebTorrent's throttle it moves the queue
into the throttle: group seeks get slower than shipped (at 20 Mbit/s blocked p50 2710 against 1695 ms; at 50 the
p95 2655 against 1308), dupFactor rises to 1.028 at 20 Mbit/s, and 11-14 % of the link goes unused. Through the
scheduler it has the best delays of all, but it needs the uplink's capacity and still leaves 10-13 % of the
throughput.

## 6. Design

### 6.1 `src/core/transfer/upload-scheduler.ts` (new)

```ts
export interface UploadSchedulerDeps {
  memberOf(wire: Wire): string | null
  /** 0 = a piece some viewer's reader is blocked on, 1 = the group's hot window or a critical range, 2 = the rest */
  classOf(piece: number): 0 | 1 | 2
  /** the UDX stream under the wire's connection; null until known */
  transport(wire: Wire): { unsentBytes: number; ackedBytes: number } | null
  /** a request arrived (held): the Revealer's activity clock */
  onArrival(wire: Wire, piece: number): void
  now?: () => number
}
export class UploadScheduler {
  constructor(torrent: Torrent, deps: UploadSchedulerDeps)
  setRate(bps: number | null): void // min(manual limit, paced rate); null = per-wire caps only
  preempt(memberId: string): number // reject that viewer's held class-2 requests (BEP 6)
  stats(): UploadSchedulerStats
  destroy(): void
}
```

- **Hooks**, installed by `TransferEngine.installWireHooks()` on the host torrent's `'wire'` (synchronously at
  `'ready'`, like the Revealer's): hold requests instead of answering them; release them as upstream answers them,
  so WebTorrent's store read, `countServed` and the Revealer's `'request'` listener keep working; drop a held request
  on cancel; reject held requests on choke (BEP 6). The spike replaced `wire._onRequest`, `_onCancel` and `choke` with
  own properties. In src, prefer adding the hold to `patches/bittorrent-protocol+5.0.9.patch` (a `holdRequests` mode
  with `'request-held'` and `wire.releaseRequest()`): the own-property override depends on the parser calling
  `this._onRequest` (index.js:1025), an implementation detail.
- **Queue per wire** = released and still being read from the store + pushed into the wire and not yet handed to
  the connection (the peer's `'upload'` event) + the connection's unsent UDX bytes. Release while it is under
  max(32 KiB, 100 ms × the wire's drain rate), the drain rate being an EWMA (50 ms ticks, α 0.3) of the bytes UDX
  got acknowledged.
- **UDX's send queue**: udx-native 1.21.3 exposes `inflight` but not its send queue. Add a JS-only
  `patches/udx-native+1.21.3.patch` to `lib/stream.js`: `bytesWritten += size` in `_writev`, `bytesAcked += size` in
  `_onack` (before it clears the request's buffers); unsent = written − acked − inflight. The engine reaches the
  stream through the attachment, `peer.mux.stream.rawStream`, as `src/core/net/headless.ts` does.
- **Order**: class 0, then 1, then 2 across wires; FIFO within a class on a wire; round-robin between wires.
  **Aging** (not measured; a safety rule): a wire with held requests that got nothing for 2 s takes the next
  release whatever its class. A viewer's wire destroys itself when no request is answered for 30 s
  (`PIECE_TIMEOUT`, torrent.js:77 and 1320-1328), and a stream of class-0/1 requests elsewhere must not starve it.
- **Rate**: a token bucket 20 ms deep at the effective rate; none when neither a limit nor the pacer applies.
  `setUploadLimit(kbps)` sets the manual part; `client.throttleUpload` is no longer called on the host.
- **Preempt**: `setViewerUrgent(id, pieces)` with a piece not in that viewer's previous report calls
  `scheduler.preempt(id)` after the Revealer has shown the piece.

### 6.2 `src/core/transfer/upload-pacer.ts` (new)

The spike's `DelayPacer` (`spikes/s2b-pacer/lib/pacer.ts`) with its constants (§2.3), fed per viewer with its UDX
stream's srtt (20 ms target, as `pxjitd`; §5) and driving `scheduler.setRate(min(manual, paced))`. Additions not
measured here: after the upload stayed under half the paced rate for 5 s (nothing to send), go back to the start
state from the current rate, so a burst after a pause ramps at ×1.3 per tick instead of 2 % per tick.

### 6.3 Changes to existing files

- `engine.ts`: build the scheduler (and pacer) in `installWireHooks()`'s host branch; `setUploadLimit()` goes to the
  scheduler; `setViewerUrgent()` preempts; the Revealer's `uploadLimitBps` dep returns the effective rate (paced or
  manual), so its budget R and its urgent wait follow the pacer; `stats()` gains `uplink { rateBps, queueMs, state }`.
- `revealer.ts`: `classOf(piece)` from what it already holds (`urgent`, `playhead.hot`, `critical`); its
  `lastActivity` for a request is set on arrival (`onArrival`), because `'request'` now fires on release.
- Plan §4.5 "Host uplink saturated": the pacer replaces "suggest an upload limit at 85 % of the measured peak". Keep
  a warning for when the paced rate stays below what the room needs (Σ viewers' need), which is the real problem
  the user can act on (fewer viewers, a lower bitrate, a better uplink).

## 7. Follow-ups

1. **Implement §6** before M6 (ADR 0002 §5 already scheduled the pacer there). Applied: §9. Tests:
   - unit: the scheduler's order, caps, rate, cancel, choke and preempt against a fake wire; the pacer on a fluid
     bottleneck model (converges to its target, cuts on a capacity step down, regrows on a step up, holds its floor);
   - integration: `revealer.test.ts`'s blocked reader with 3 viewers at 1 MB/s asserts the median under 0.6 s
     (1.91 s in Part A today); `striping.test.ts` keeps dupFactor ≤ 1.3 with the scheduler on;
   - this spike's `run-all.sh b20` as the netem regression bench (manual, like S5's matrix).
2. **Competing traffic.** A LEDBAT-like pacer yields to anything else that fills the router queue, e.g. a cloud
   backup on the same uplink, down to its 250 KB/s floor; nothing here measured that. Decide the floor against the
   room's need (Σ viewers' need, with the plan's "download too slow" warning as the outcome), and run the harness
   with a competing bulk upload from the host namespace.
3. **Viewers.** Viewers upload to each other (striping depends on it), and a viewer on a slow uplink has the same
   queues. The scheduler has no urgent classes there, but just-in-time release and the pacer apply as they are.
   Measure with a shaped viewer uplink.
4. **The PROBE_RTT tail** (§4). Options: stop releasing to a stream while UDX reports PROBE_RTT (`bbrState`), or
   carry ctrl on its own UDX stream (ADR 0002's fallback, which the pacer now makes worthwhile: it removes the
   router queue that made the fallback insufficient on its own).
5. ADR 0003 Follow-up 4 (striping over real links) is covered in part: every run here was striped over real
   Hyperswarm connections behind netem, and the jit variants kept dupFactor at 1.00 at 20 Mbit/s and ≤ 1.016 at 50
   (shipped: 1.003; §3).
6. **The pacer's cycle.** Its ctrl p95 (127 / 157 ms) and datagram p95 (85 / 79 ms, ~4× idle) come from the
   router queue it builds before each cut (finding 5). A faster-reacting tuning (200 ms filter, 500 ms hold, half
   the probe) ran only in smoke runs: add it to `run-all.sh` and run it before tuning the constants in src; ADR
   0002's "datagram p95 < 2× idle" is the target it has not met.

## 8. Commands

```sh
# the matrix (3 repeats, ~90 min of runs; the lock is optional) and its tables
S2B_LOCK=/path/to/measure.lock spikes/s2b-pacer/run-all.sh /tmp/s2b-final all 3
npx tsx spikes/s2b-pacer/summarize.ts /tmp/s2b-final
```

## 9. Applied (follow-up 1)

Date: 2026-10-22. `src/core/transfer` (its README, "Host upload scheduling", has the details):

- **§6.1** `upload-scheduler.ts`: hold, release just in time (queue = being read + in the wire + UDX unsent, cap
  max(32 KiB, 100 ms of the UDX-acked drain rate)), 20 ms token bucket, urgent-first order with round-robin, 2 s
  aging, cancel, choke, `preempt`. The hold is a mode of `patches/bittorrent-protocol+5.0.9.patch` (`holdRequests`,
  `heldRequests`, `'request-held'`, `releaseRequest(…, onAnswered)`, `refuseRequest`, `pushedBytes`; held requests
  keep their arrival order, which upstream's unordered `_pull` would not). UDX's counters are
  `patches/udx-native+1.21.3.patch` (`bytesWritten`, `bytesAcked`).
- **§6.2** `upload-pacer.ts`: the spike's `DelayPacer` with the `pxjitd` constants, fed with each viewer's UDX srtt,
  plus the 5 s idle reset.
- **§6.3** `engine.ts`, `revealer.ts`, and the feasibility line (`session/host-session.ts` `uploadCapacityBps`).

Where it differs from §6:

- `onArrival` returns a boolean: the Revealer's refusal of a piece it does not advertise to that wire moved from
  its own-property `_onRequest` override into the scheduler's arrival path (refused before it is held). The take-back
  counts held requests as "fetching", like answered ones.
- The pacer has no rate until a stream gives a delay sample; a lane that is not UDX (the integration tests' piped
  SecretStreams) is paced by the limit alone. A wire holding over 512 requests (twice our reqq) has the rest refused;
  a request over 128 KiB is released at once (WebTorrent drops that wire); `destroy()` refuses what is held.
- §6.3's warning is the existing feasibility line: its "your upload" is the best paced rate of the last 10 s once the
  pacer has been steady that long (else the measured peak), so it warns when the paced rate stays below Σ viewers'
  need. `stats().uplink.queueMs` is the pacer's queueing-delay estimate.
- Found in review, changed from the spike's pacer: its cap (1.25 × the best upload of the last 2 s + 64 KB/s) applies
  in start only. Applied to a steady rate it pulled it to the 250 KB/s floor within 2 s of quiet, before §6.2's 5 s
  reset, and a burst 2-5 s after that took 7.4 s to get 1 MB/s back and 14.4 s for 4 MB/s on a 5 MB/s link. Now the
  steady rate holds through a pause (the scheduler's 20 ms bucket keeps an unused rate from leaving as a burst), and
  the 5 s reset starts over from it. In start the cap never goes below the rate start began from (1 MB/s in a new
  session: ctrl traffic gives samples before any data moves, so every session began at the floor). The ×1.3 per
  tick of start is bounded by the cap (and by "the rate binds": 0.8 is 1 / 1.25), so start grows ~×1.1 per tick,
  as in the spike. A viewer whose UDX stream changes (re-attached) starts its delay history over.
- The Revealer takes the paced rate as at least 1 MB/s (its floor for a measured upload); a manual limit as it is.

Measured (tests in `scripts/isolated.sh`, loopback, no RTT): the 3-viewer blocked reader at 1000 KiB/s
(`test/integration/transfer/revealer.test.ts`) 0.24-0.26 s per read, median under 0.6 s asserted; 0.72-0.77 s with
the class order disabled, 1.4-2.3 s with the hold off and WebTorrent's throttle on (the shipped path).
`striping.test.ts` dupFactor 1.03, no stalls (was ≈ 1.05).

The spike's harness drives `src/` itself in its `base` variant (`--sched` and `--pacer` off; its `monitor` only
counts), so `run.sh` with run-all's `b20-base` options now measures this implementation: 3 runs, 2026-10-22, load
0-1.0. Ctrl RTT p50 45-49 ms, p95 134-142 (`pxjitd` 46 / 127; shipped 427 / 580); datagram one-way p50 31-36 ms, p95
78-89 (33 / 85); upload 2269-2296 kB/s (2292; shipped 2346); dupFactor 1.00; blocked p50 644-691 ms, p95 773-917
(620 / 824); seek → first piece p50 691-716 ms (659). The other `b20` variants layer the spike's prototypes on top of
`src/`'s scheduler and no longer mean what §2.4 says. After the review fixes (cap in start only, above), 2 more runs:
ctrl RTT p50 49-50 ms, p95 108-118; datagram p50 36, p95 77-78; upload 2308-2317 kB/s; dupFactor 1.00; blocked p50
603-670 ms, p95 677-801.
