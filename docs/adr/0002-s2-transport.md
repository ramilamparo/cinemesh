# ADR 0002: Spike S2: transport (WebTorrent over Protomux over Hyperswarm)

- Date: 2026-10-19
- Status: **partial**. Loopback throughput, handshake, event-loop lag and the source-file check pass. The
  relay carries datagrams. Two criteria fail and need decisions below:
  - control-lane and datagram latency at a saturated 50 Mbit/s bottleneck;
  - host RSS once lanes re-attach, which also exposed a real bug in `MuxWireStream`, fixed by a 3-line diff.
- Plan: §4.1 (swarm, relay), §4.2 (MuxWireStream, host seeding, RAM), §4.5 (clock pings, StateFast
  datagrams), §7 S2
- Harness: `spikes/s2-transport/` (README there). Raw results: `spikes/s2-transport/results/*.json`;
  medians: `results/summary.json`.

## 1. Question
Can WebTorrent 3.0.21, running over one Protomux channel (`wtp/bt/1`) of each Hyperswarm connection:
- serve a ≥ 2 GB file from a read-only host store to 3 viewers at line rate;
- without delaying the control lane (`wtp/ctrl/1`) or the connection's datagrams too much;
- with bounded memory and event-loop lag;
- directly and through a blind relay;
- while leaving the host's file untouched?

Also: strict or soft backpressure, datagrams on relayed links, and whether a default `downloadLimit` is needed.

## 2. Method
**Topology:**
- One user+net namespace per run (`unshare -rn`, only `lo`), so runs are isolated from the other agents' traffic.
- A local HyperDHT testnet (3 nodes, `hyperdht/testnet.js`).
- Host + 3 viewers as **separate Node processes**. Each has its own Hyperswarm (`maxPeers: 12`, its own
  `keyPair`), and everyone joins one topic.
- Per connection: `Protomux.from(conn)` with
  - `wtp/ctrl/1` (c.json messages);
  - the `wtp/bt/1` MuxWireStream lane, attached with `torrent.addPeer` after `opened`.
- How the mesh is dialed (`--mesh ordered`, the default):
  - everyone runs `join(topic, {server: true, client: false})`;
  - each viewer runs `joinPeer()` to the host and to every member whose key sorts below its own, so each pair has exactly one dialer.
  - Finding 6 explains why plain topic discovery was not used.

**Data:**
- `make-data.ts` writes a **random, fully allocated (not sparse)** file of 2,147,495,993 B (2 GiB + 12,345 B: 2,049 × 1 MiB pieces, with an odd tail).
- It hashes the file **once** with create-torrent (private, no announce) into a cached `source.torrent`.

**Host:**
- `client.add(torrentBuf, {store: ReadOnlyFileStore, storeOpts: {sourcePaths}, skipVerify: true, uploads: 16, storeCacheSlots: 16, destroyStoreOnDestroy: false})`.
- `lib/read-only-store.ts` is the throwaway store. It holds O_RDONLY fds, `put` fails, and `destroy` only closes.

**Viewers:** `client.add(torrentBuf, {path: <tmp>, deselect: false, strategy: 'sequential'})`, with the plan's WebTorrent options.

**Each run:**
1. Mesh: wait until every member has 3 open ctrl lanes.
2. 6 s idle phase.
3. `go`: everyone opens the bt lanes; transfer until all viewers are `done` (loopback) or for 30 s (netem).
4. `finish`.

**What is measured:**
- **Pings:** the host pings every viewer every 100 ms, both on ctrl (`{t:'ping'}`/`pong`) and as a datagram via `conn.trySend()`/`'message'` (15 B, `[0x53][ver][type]` layout).
  - "Idle" means the idle phase.
  - "Saturated" means while that viewer downloads (its first 500 ms and last 500 ms are excluded).
  - "Extra" ctrl delay = RTT − that link's idle median.
- **Memory and loop:** RSS, arrayBuffers and heap every 250 ms; `monitorEventLoopDelay({resolution: 5})` per process.
- **Lanes:** conn open → bt channel `opened` → WebTorrent `'wire'`.
- **UDX:** in the runs added last (`ne-udx`, `ne-reqq*`, `re-rep*`, `lo-fixreqq`), the host also samples the UDX state of each link every 250 ms (srtt, inflight, retransmits).

**Conditions:**
- `loopback`: no shaping.
- `netem`: `tc qdisc add dev lo root netem delay 25ms rate 50mbit`, applied once the mesh is up.
  - That is 50 ms RTT, and **one 50 Mbit/s queue (default limit 1,000 packets) shared by all traffic of all members in both directions**.
  - This is harsher than reality, where each member has its own uplink.
- `relay`:
  - a blind-relay 1.6.1 server on the testnet in its own process (`RelayServer({createStream: o => dht.createRawStream({...o, framed: true})})`, `lib/relay.ts`);
  - viewers set `relayThrough: (force, swarm) => relayKey`;
  - nft drops member-to-member UDP inside the namespace, so the relay is actually used (Finding 7).

**Commands:**
```sh
npx tsx spikes/s2-transport/make-data.ts       # once: source.bin + cached source.torrent
spikes/s2-transport/run-all.sh                 # the whole matrix, 3 runs per configuration (~80 min)
npx tsx spikes/s2-transport/summarize.ts       # medians table (results/summary.json)
npx tsx spikes/s2-transport/verify-source.ts   # sha256 + mtime of the source vs make-data's record
# single runs, e.g.:
spikes/s2-transport/run.sh loopback --label x --bp strict|soft|fixed [--relay] [--one-process] [--reqq 256] \
  [--reattach 8000 [--reattach-every 5000]] [--viewers 1] [--down-limit 0,48828] [--max-ms 60000]
spikes/s2-transport/run.sh netem --label y --max-ms 30000 [--up-limit 2500,600]
# experiments (each prints its finding)
unshare -rn sh -c 'ip link set lo up && npx tsx spikes/s2-transport/experiments/mesh-probe.ts topic|ordered send'
unshare -rn sh -c 'ip link set lo up && npx tsx spikes/s2-transport/experiments/relay-probe.ts [block]'
npx tsx spikes/s2-transport/experiments/reopen-probe.ts immediate|pair
npx tsx spikes/s2-transport/experiments/held-write-probe.ts
```

**Configurations** (3 runs each, medians reported):

| label | what |
|---|---|
| `lo-strict` | loopback, src MuxWireStream (strict backpressure) |
| `lo-soft` | loopback, local variant with a 256 KiB soft limit (`lib/mux-wire-stream-soft.ts`) |
| `lo1v-strict` | loopback, 1 viewer (single-wire line rate) |
| `op-strict` | loopback, host + 3 viewers in **one** process |
| `re-strict` / `re-rep` | loopback; v1 destroys its bt lane to the host at +8 s / every 5 s from +5 s, and re-opens it |
| `rl-strict` | loopback, every link relayed |
| `lo-dl50` | loopback, viewers `downloadLimit` 50 MB/s (48,828 KiB/s) |
| `lo-reqq` | loopback, every wire advertises BEP 10 `reqq = 256` |
| `ne-strict` / `ne-soft` | netem, strict / soft |
| `ne-up` / `ne-up78` | netem with `uploadLimit` host 2,500 + viewers 600 KB/s (≈ 53 % of the shared link) / 4,000 + 300 (≈ 78 %) |
| `ne-udx`, `ne-reqq256`, `ne-reqq32` | netem strict with UDX sampling; with `reqq` 256 / 32 |
| `rlne-strict` | netem, every link relayed |
| `re-repfix`, `lo-fixreqq` | as `re-rep` / `lo-strict`, with the `_predestroy` fix (`--bp fixed`); the latter also with `reqq = 256` |

**CPU contention:**
- Other agents ran tests on this 14-core machine throughout. The 1-minute load before runs was 0.4-7.3 (median 2-3).
- Each member process runs at about 94 % event-loop utilisation (ELU) at loopback line rate, so loopback **throughput is CPU-bound and sensitive to contention**. The spread between the 3 runs is ±8 %.
- Latency medians under netem are not CPU-sensitive: each process sits at about 5 % ELU there.

## 3. Results
Medians of 3 runs. Times are in ms, rates in MB/s (10⁶ B/s).

| Criterion (plan §7 S2) | Target | Measured | Pass? |
|---|---|---|---|
| Throughput, loopback | ≥ 80 MB/s | **1 viewer: 128.5.** 3 viewers: 60.9 each (slowest 60.2), 179.9 aggregate, host upload 132.1. CPU-bound: every process at ~94 % ELU | **yes** per wire and aggregate; **no** for each of 3 concurrent viewers (60.9) |
| Throughput, netem 50 ms / 50 Mbit/s | (none) | 5.5 aggregate (88 % of the 6.25 MB/s shared link), 1.7 per viewer, host 4.4 | (n/a) |
| Throughput, relayed (loopback) | (none) | 135.0 aggregate, 45.3 per viewer; relay process 66 % CPU, 114 MB RSS | (n/a) |
| Handshake after conn open | < 1 s | bt channel opened: p50 2.9, max 7.4; `'wire'`: p50 8.8, max 13.6. netem: bt opened 28, `'wire'` 58 (max 61); relayed netem: 54 / 108 (max 112) | **yes** |
| ctrl extra delay p95, saturated | < 150 ms | loopback: strict **49.6**, soft 56.3, `reqq` 256: 20.1. netem: strict **3,767** (runs 703 / 3,767 / 5,256), soft 3,502, `reqq` 32: 520, `reqq` 256: 5,387. netem with a 53 % host upload cap: **27.3** (one run 566); 78 % cap: 260 | **loopback yes; netem no** (yes only with a ~50 % upload cap) |
| Datagram p95 vs idle RTT, direct | < 2× idle, loss < 5 % | loopback: 15.0 vs 0.5 idle (31×; +14.5 ms is event-loop queueing at 94 % ELU), 0 % loss. netem: **236 vs 50.8 (4.7×)**, loss 2.9 % (up to 4.6 %). netem with a 53 % cap: **56 vs 50.5 (1.1×)**, 0 % | **no** at saturation (ratio); loss yes; yes with a cap |
| Datagram p95 vs idle RTT, relayed | < 2× idle, loss < 5 % | loopback: 11.2 vs 0.6, **0 % loss**. netem: 420 vs 101 (4.2×), **0 % loss**. All 12 links relayed in every run (`remotePort` = relay's UDP port) | datagrams **pass through the relay**; ratio **no** at saturation, as on direct links |
| RSS growth at line rate | < 250 MB | host **207** (strict), 206 (soft), 95 (`reqq` 256); viewers ≤ 154. One re-attach: host **273**; 6 re-attaches: host **383** (bug, Finding 1). With the fix and 6 re-attaches: host **222** (runs 207 / 222 / 225; 3 live wires); fix + `reqq` 256: host **99** | **yes** without re-attach; **no** with re-attaches as src stands; **yes** with the §6.1 fix |
| Event-loop delay p99 | < 20 ms | separate processes: host 7.6, viewers ≤ 8.9 (≤ 10.7 across all configs). **Host + 3 viewers in one process: 7.2** at 100 % ELU (aggregate 61.6 MB/s). Includes the 5 ms sampling interval (idle p50 ≈ 5.05). Worst single stall: 88 ms (in the repeated re-attach runs) | **yes** |
| Source file unchanged | mtime unchanged | size + mtime unchanged after every one of the runs; sha256 identical afterwards (`verify-source.ts`: `4daad891…292d6e`, mtime 1792356631195.685, 2,147,500,032 B allocated, so not sparse) | **yes** |
| Re-attach: destroy → data flowing | (none; task g) | destroyed by v1 mid-transfer, both sides re-open: bt opened 70, `'wire'` 74, **first data 84** (runs 46 / 84 / 184). Fixed variant, 6 re-attaches × 3 runs: first data median 62 (36-141) after each destroy. Needs `mux.pair()` (Finding 2) | (n/a) |
| dupFactor without striping | ≈ N | 2.2 for 3 viewers (viewers re-share ~27 %). Striping was not part of this task (S3/M3) | (n/a) |

**Other numbers:**
- **Mesh formation** (topic + `joinPeer`, `ordered`): the per-configuration medians range from 7.6 to 48.8 s (15 s for `lo-strict`).
  - **7 of 63 attempts** did not form a full mesh within 60 s and were retried. The failed attempts are kept in `results/mesh-failures/`.
- **One process:** host + 3 viewers in one process reach 61.6 MB/s aggregate at 100 % ELU, with loop p99 still 7.2 ms (WebTorrent's work comes in small tasks).

## 4. Findings
1. **Bug in `src/core/transfer/mux-wire-stream.ts`: a lane whose remote closes while one of our writes is held never closes.** The chain:
   - `_write` holds its callback until `ondrain` (mux-wire-stream.ts:63-71).
   - Protomux calls `ondrain` only for channels still open (protomux index.js:601-607).
   - streamx calls `_destroy` only when no write is active (streamx index.js:220-224).
   - So `destroy()` from `onclose` (mux-wire-stream.ts:41) stops at "destroying". `_destroy`, which would release the write (mux-wire-stream.ts:77-81), never runs, and `'close'` never fires.
   - WebTorrent destroys a peer only on its conn's `close`/`end`/`finish`/`error` (peer.js:73-84). So the host keeps the dead peer, its wire, its throttles and all its queued piece data.

   **Evidence:**
   - `experiments/held-write-probe.ts`: src lane `destroying=true destroyed=false close=false`; with the fix, `destroyed=true close=true`.
   - Harness, 6 re-attaches: the host ends with **9 wires, 9 peers, 9 up-throttles instead of 3**.
   - Host RSS climbs 309 → 529 MB (arrayBuffers 118 → 300 MB), about +35 MB per re-attach. With the fix: 3 wires, 194 MB growth.

   **Consequence in `engine.ts`:**
   - `open()` and the `pair()` handler refuse to open while `a.stream` is set (engine.ts:304, 306-308).
   - `a.stream` is cleared only on that stream's `close` (engine.ts:317-320).
   - So a host whose viewer drops the lane while a host write is held (always the case at line rate) also **rejects every later re-open from that viewer** until detach. This is inferred from the code, not run: the harness has its own attach logic.

   **Fix:** override `_predestroy()`, which streamx calls synchronously in `destroy()` (streamx index.js:763-765), to release the held write. Diff in §6.
2. **Both sides re-opening on close livelocks without `mux.pair()`.**
   - Each re-open reaches a peer that has no bt channel at that instant. Protomux rejects it, the reject closes the new lane, and that triggers the next re-open.
   - `experiments/reopen-probe.ts immediate`: 12 attempts in 6 ms, none opened. `pair`: re-opened in about 1.5 ms. In the harness, before `pair()` was added: v1 used up 10 attempts and never re-attached.
   - `engine.ts:306-308` already registers `pair()`, which matches. With `pair()`, data flowed again 84 ms (median) after a mid-transfer destroy.
   - `engine.ts` adds its own 1 s backoff before the first re-open (`REATTACH_BACKOFF_MS`, engine.ts:71), so in the app expect about 1.1 s.
3. **The host's memory is about 1 s of its upload rate, and `downloadLimit` does not bound it.**
   - WebTorrent pipelines `2 + ceil(1 s × downloadSpeed / 16 KiB)` requests per wire (torrent.js:81-82, 2207-2219), capped only by the peer's BEP 10 `reqq`.
   - bittorrent-protocol advertises no `reqq`, answers every request at once, and `_push` ignores `push()`'s return value (bittorrent-protocol index.js:602-606, 690-711).
   - So piece data piles up in the host's wires regardless of MuxWireStream backpressure: arrayBuffers peak 193 MB at 132 MB/s.
   - **Advertising `reqq = 256`** (≤ 4 MiB outstanding per wire), by setting `wire.extendedHandshake.reqq` in the torrent's `'wire'` event:
     - host RSS growth 207 → 95 MB; host upload unchanged (134.9 vs 132.1 MB/s); loopback ctrl p95 49.6 → 20.1 ms.
     - It works because the event fires inside the wire's handshake handler, before the extended handshake is sent (bittorrent-protocol index.js:633-642).
     - Cost: viewers trade less among themselves (aggregate 147 vs 180 MB/s).
     - At 100 ms RTT, 256 still allows about 40 MB/s per wire.
   - **`downloadLimit` 50 MB/s is harmful:**
     - WebTorrent throttles the *read* side (peer.js:135-155). MuxWireStream pushes every Protomux message regardless of `push()`'s return value (mux-wire-stream.ts:56-58), and Protomux has no per-channel flow control.
     - So the limit only moves the backlog into the viewer: viewer RSS growth up to 218 MB vs 154, and host 185 MB (unchanged).
4. **At a saturated bottleneck the problem is the queue and loss, not the JS buffer, so backpressure mode doesn't matter there.**
   - Under netem, the host's UDX streams show srtt 167 ms p50 / 239 ms p95 against a 51 ms idle RTT, inflight up to 870 KB, and **about 2,250 retransmits in 30 s** (`ne-udx`).
   - Datagrams, which avoid head-of-line blocking, still see p50 160 ms and p95 236 ms: that is the bottleneck queue (1,000 packets ≈ 240 ms at 50 Mbit/s).
   - ctrl messages additionally wait for in-order delivery behind lost bt packets, hence seconds-long p95s.
   - Strict vs soft barely matters there (3.8 s vs 3.5 s).
   - Smaller `reqq` reduces bursts: `reqq` 32 gives 242 retransmits and p95 520 ms, but would also cap high-RTT links. It is not enough.
   - **What works is keeping the sender below the bottleneck:** a 53 % upload cap gave ctrl extra p95 27 ms (one run 566) and datagrams 1.1× idle with 0 % loss; a 78 % cap still gave 260 ms.
   - WebTorrent's throttle (speed-limiter) is a token bucket whose size equals one second of rate (speed-limiter lib/throttle-group.js:18-20), so a full second can leave at line rate. A cap therefore needs a wide margin.
   - The plan's fallback "bt on a second SecretStream" would remove the head-of-line stalls but not the 120-190 ms queue the datagrams measured, so on its own it would not meet 150 ms either.
5. **Soft backpressure (256 KiB) buys nothing.** Throughput is equal (179.3 vs 179.9 aggregate, 134.7 vs 132.1 host), ctrl is slightly worse on loopback (p95 56.3 vs 49.6, max 225 vs 138) and also fails under netem.
6. **Topic discovery alone does not form the mesh when members join together.**
   - `experiments/mesh-probe.ts topic`: after 30 s only the 3 `joinPeer(host)` links exist and no viewer-to-viewer link forms. The first lookup runs before the others' announces, and the next refresh is 10 min later (hyperswarm lib/peer-discovery.js:4).
   - `members` (everyone `joinPeer`s everyone) **flaps**: v3's link to the host closed and re-opened about every 5-20 s for 60 s. The cause: when both sides dial and bytes have already flowed, each side keeps the newer connection (hyperswarm index.js:357-362), so they can cross-swap.
   - `ordered` (exactly one dialer per pair) formed 6/6 pairs in 8 s in the probe. In the harness it still failed 7 of 63 times: a viewer's dial to the host opened on the viewer's side, then closed within seconds while the host never emitted it, repeatedly.
   - This belongs to M2/S5, but the plan's "everyone joins the topic, viewers also `joinPeer(host)`" is not enough for viewer-to-viewer links on its own.
7. **Forced `relayThrough` is not used on loopback while the direct path works.** `relay-probe.ts` without `block`: `relayed? false` (127.0.0.1:49741). The harness therefore drops member-to-member UDP with nft (`lib/nft.ts`, about 10 packets dropped per run), after which all 12 links report `remoteHost:remotePort` = the relay's socket.
   - Datagrams cross a blind relay intact: 0 % loss idle and saturated, 49/50 in the probe.
   - A relayed pair costs about 2× the bytes on the relay host (relay process at 66 % CPU for 135 MB/s).
8. **Store contract (webtorrent 3.0.21):**
   - The store is constructed as `new opts.store(pieceLength, {...storeOpts, torrent, path, files, length, name, addUID, rootDir, max: storeCacheSlots})` (torrent.js:588-600), where `files` are WebTorrent `File` objects with `offset`/`length` (file.js:18-21).
   - It is wrapped in CacheChunkStore when `storeCacheSlots > 0` (torrent.js:604-608) and always in ImmediateChunkStore (torrent.js:610-612). Both require `get` and `put` and copy `chunkLength` (cache-chunk-store 3.2.2 index.js:6-12, immediate-chunk-store 2.2.0 index.js:6-11).
   - The cache calls the raw store's `get(index, cb)` for **whole pieces** only (cache-chunk-store index.js:60).
   - Peer requests arrive as `store.get(index, {offset, length}, cb)` (torrent.js:1488). Torrent destroy calls `store.close` or `store.destroy` (torrent.js:992-1001).
   - `skipVerify` marks every piece verified without reading (torrent.js:656-659).
   - `put` was never called on the host (0 calls in every run).
9. **Event loop:** one process carrying the host and all 3 viewers kept p99 at 7.2 ms at 100 % ELU, so no second utilityProcess is needed for loop lag. CPU caps the aggregate at about 60 MB/s in that case, still about 480 Mbit/s.

## 5. Decision
- **Backpressure: keep strict** (plus the `_predestroy` fix). Soft adds nothing (Finding 5).
- **Relayed links can use datagrams.** They pass through the blind relay with 0 % loss. Clock pings and StateFast keep using datagrams there; no bus-ping fallback is needed for "relayed". The "after 6 lost pings" fallback stays.
- **No default `downloadLimit`** (Finding 3: it increases viewer memory). Instead, **advertise `reqq = 256`** on every wire. That bounds the host to about `wires × 4 MiB` of in-flight data: 95 MB growth measured at 135 MB/s.
- **ctrl latency under a saturated uplink: criterion not met.**
  - The fallback in the plan (bt on a second SecretStream) would not meet it either (Finding 4).
  - Chosen mitigation, in order:
    - (a) Sync must not depend on ctrl latency. This is already the design: StateFast datagrams ×3 and lead time from measured lag. **Sizing note:** at saturation the datagram p95 rises to about 240 ms (4.7× idle), and the lead time `L = clamp(lagP95 + 2ε + 50, 250, 2000)` absorbs that.
    - (b) Pace the host's upload below the bottleneck.
  - (b) needs a delay-based controller: reduce `uploadLimit` while the datagram ping RTT rises more than ~50 ms over its idle minimum, and raise it slowly otherwise. A fixed 53 % cap fixed it in this topology, but the uplink is unknown in the app.
  - This is a follow-up spike (S2b) before M6. Until then, Settings' upload limit is the manual lever.
- **Fix the MuxWireStream close bug before M3 ships** (§6). Without it the RAM criterion fails as soon as any lane re-attaches, and the host may refuse re-attaches.

## 6. Changes recommended for src/
**6.1 `src/core/transfer/mux-wire-stream.ts`:** release a held write when destroy starts. Proven by `spikes/s2-transport/lib/mux-wire-stream-fixed.ts` and `experiments/held-write-probe.ts`.
```diff
   override _read(cb: (err: Error | null) => void): void {
     cb(null) // data is pushed as channel messages arrive
   }
 
+  /**
+   * streamx runs _destroy only once no write is active (streamx index.js:220-224). A write held for
+   * 'drain' on a channel the remote closed is never released (Protomux drains open channels only), so
+   * release it here, synchronously in destroy(); otherwise the lane never emits 'close' and WebTorrent
+   * keeps the peer and its buffered piece data (S2).
+   */
+  override _predestroy(): void {
+    this.release(new Error('bt channel destroyed'))
+  }
+
   override _destroy(cb: (err: Error | null) => void): void {
```
**6.2 `src/core/transfer/mux-wire-stream.test.ts`:** regression test.
```diff
+  it('closes when the remote closes the channel while a write is held for drain', async () => {
+    const pair = connectedPair()
+    const a = MuxWireStream.open(pair.a, INFO_HASH, Buffer.alloc(32, 1))
+    const b = MuxWireStream.open(pair.b, INFO_HASH, Buffer.alloc(32, 2))
+    if (!a || !b) throw new Error('channel not created')
+    a.on('error', () => {})
+    b.on('error', () => {})
+    await Promise.all([a.opened, b.opened])
+    const closed = new Promise<void>((resolve) => a.once('close', () => resolve()))
+    for (let i = 0; i < 64; i++) a.write(Buffer.alloc(64 * 1024)) // the mux is not drained: a write is held
+    b.destroy()
+    await closed // times out without _predestroy
+    expect(a.destroyed).toBe(true)
+    pair.destroy()
+  })
```
**6.3 `src/core/transfer/engine.ts`:** advertise `reqq` on every wire, for host and viewer alike (viewers upload to each other).
```diff
+// BEP 10 reqq: the most block requests a peer may keep outstanding to us. WebTorrent otherwise pipelines
+// ~1 s of the wire's rate (torrent.js:2207-2219) and bittorrent-protocol answers all of it at once, so the
+// uploader holds ~1 s of upload in RAM (S2: host RSS +207 MB at 132 MB/s; with 256: +95 MB, same rate).
+const REQQ = 256
@@ private whenReady(t: Torrent): Promise<void> {
     this.torrent = t
     t.on('error', (e: Error) => this.emit('error', e))
+    // 'wire' fires inside the wire's handshake handler, before its extended handshake is sent
+    // (bittorrent-protocol index.js:633-642), so this value is what the peer sees
+    t.on('wire', (wire: Wire) => (wire.extendedHandshake.reqq = REQQ))
```
**6.4 `src/types/modules.d.ts`:**
```diff
   export interface Wire extends EventEmitter {
     requests: { piece: number; offset: number; length: number }[]
+    /** sent in our BEP 10 extended handshake; set before it goes out (in the torrent's 'wire' event) */
+    extendedHandshake: Record<string, unknown> & { reqq?: number }
```
**6.5 `src/core/transfer/client-options.ts`:** a comment only, so nobody adds the limit back.
```diff
+// No default downloadLimit: WebTorrent throttles the read side (peer.js:135-155) and MuxWireStream cannot
+// push back on Protomux, so a download limit only moves the backlog into the viewer's RAM (S2). Host memory
+// is bounded by reqq (engine.ts) instead.
 export const WEBTORRENT_OPTIONS = {
```

## 7. Follow-ups
- **S2b (before M6):** a delay-based upload pacer driven by the datagram ping RTT. Test it in the netem setup plus a per-member-uplink topology: one namespace per member, connected by veth, each with its own `tbf`/`netem` uplink, which is more realistic than one shared `lo` queue. Target: ctrl p95 extra < 150 ms and datagrams < 2× idle at ≥ 80 % of the uplink.
- **M2/S5:** mesh formation. Use the `members` list with exactly one dialer per pair (lower key dials), and re-dial on close. Then investigate the remaining "dial opens on one side only" failures (7 of 63 here) and topic refresh after a simultaneous join.
- **M3:** apply §6.1-6.4 and keep engine's re-attach backoff. Consider 0 ms for the first re-open when *we* closed the lane, since `pair()` makes it safe.
- **M3:** stats should show re-attach counts per peer, so a ratchet like Finding 1 is visible in diagnostics.
- **Revisit the 80 MB/s criterion for 3+ viewers.** Each process is CPU-bound at about 60 MB/s per viewer when it serves 3. That is far above any video bitrate, but the CPU cost (≈ 1.2 cores per member at line rate) matters on laptops. A future `uploadLimit` default could cap it.

## 8. Later: what a member can send (round 4)
This transport carries any member's bytes into WebTorrent's wire parser: whoever is in the room can open the
`wtp/bt/1` channel and write to it. Round 4 found two ways to stop or crash the core from there and patched both.
Details and measurements: ADR 0003, "Applied in src", Round 4; `src/core/transfer/README.md`, "What a member can send".
- **bencode 4.0.1** decodes BEP 10 handshakes and ut_metadata messages. It accepted a negative string length and moved
  backwards, so a dict or list never ended (`d1:a-3:e`) and the core's event loop stopped for good.
  `patches/bencode+4.0.1.patch` throws on a string length that is negative, not a whole number or past the end of the
  data, and on nesting deeper than 64 levels. Every decode step moves forward, so a decode ends in time linear in its
  size.
- **bittorrent-protocol** ran BEP 10 extension handlers unguarded. ut_metadata reads `msg_type` from the `null` that an
  empty message decodes to: a TypeError out of the parser, which the core reports to main as fatal.
  `patches/bittorrent-protocol+5.0.9.patch` makes `_onExtended` run each handler through `_runExtension`, which drops
  the wire (`_drop`: stop parsing, clear the buffer, destroy) when one throws. The 1 MiB message cap uses `_drop` too.
- **Tests.** `test/integration/transfer/hostile-member.test.ts` attacks a running host from a hand-written peer on the
  bt lane while a viewer downloads. The host runs in a child process whose heartbeats the test watches, so a parser
  that loops fails the test instead of hanging the run. `mux-wire-stream.test.ts` runs the wire-level cases in workers
  with a deadline.
- **Not patched:** the BitTorrent DHT's own bencode (2.0.3, under k-rpc-socket) has the same flaw. Only a DHT decodes
  with it, and the client never creates one (`dht: false`; a test checks it).
