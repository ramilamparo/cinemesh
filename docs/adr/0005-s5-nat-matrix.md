# ADR 0005: Spike S5: the NAT and relay matrix

- Date: 2026-10-19
- Status: **partial**. Of the plan's seven S5 criteria, four pass as designed: `randomized` in the RANDOM
  namespace, `relayed` once a relay is set, CONSISTENT↔RANDOM goes direct, and a via-peer member receives
  state. One passes only in part: `remote-changed` fires when a link starts relayed and is upgraded, but a
  **src defect** keeps a freshly started RANDOM viewer's first dial off the relay (fix in §6.1, verified).
  Two fail and change the plan:
  - RANDOM↔RANDOM never surfaces `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`. hyperdht decides it, then reports
    `HOLEPUNCH_ABORTED`.
  - A forwarded UDP port does **not** turn RANDOM into OPEN or CONSISTENT. It only turns CONSISTENT into OPEN.

  The plan's fallback therefore applies: the UI recommends a relay. Not run here: the phone-hotspot
  (CGNAT) row and real routers.
- Plan: §4.1 (Relay, Option without a VPS, Path, Diagnostics), §7 S5, §9 Network
- Harness: `scripts/netns-rootless.sh`, `scripts/netns-nat.sh` (now rootless-capable), `scripts/s5-matrix.mjs`,
  `scripts/s5-hyperdht-trace.mjs`, `src/core/net/headless.ts` (instrumented). Raw results (JSON lines per
  member, `row.json` per row, `summary.json` per run) stayed outside the repo, in the session scratchpad
  (`…/scratchpad/s5/{run1,run2,fix-firstdial,fix-trylater*}`). The commands in §2.6 regenerate them.
- Environment:
  - hyperswarm 4.17.2, hyperdht 6.34.1, dht-rpc 6.27.0, udx-native 1.21.3, secret-stream 6.9.2, blind-relay 1.6.1.
  - Node 26.6.0, Linux 6.18, iptables-nft 1.8.13, iproute2 7.2.
  - No sudo: unprivileged user namespaces only.
  - 14 cores shared with other agents' tests (load average 0.7–8.3 during the runs).
  - `src/core/net` was unchanged during both runs. `summary.json` records the hashes, e.g. `room.ts`
    `fc65da10e16cc905`.

## 1. Question
Does the NAT and relay matrix behave as plan §4.1 designs it? Pass criteria (plan §7 S5):
1. `randomized` in the RANDOM namespace.
2. RANDOM↔RANDOM gives `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`,
3. then `relayed` once a relay is set.
4. CONSISTENT↔RANDOM goes direct
5. and fires `remote-changed`.
6. A via-peer member receives state.
7. A forwarded port turns RANDOM into OPEN or CONSISTENT.

Also recorded:
- the NAT class as diagnostics report it (`natClass`: `!firewalled` → OPEN, `port 0` → RANDOM, else CONSISTENT);
- the `path` each member reports for each peer;
- time to connect and to `relayed`;
- the error codes and hints the app would show;
- the Network test's "UDP blocked?" path.

## 2. Method
### 2.1 Harness without root
- **`scripts/netns-rootless.sh CMD`** runs CMD as fake root in new user, mount, net and PID namespaces
  (`unshare --user --map-root-user --mount --net --pid --fork --mount-proc --kill-child`).
  - It mounts a private tmpfs on `/run`, so `ip netns add` works.
  - It sets `WT_NETNS_ROOTLESS=1`.
  - Everything dies with the session: when CMD exits, PID 1 of the namespace exits and the kernel kills
    every member, testnet and relay, so none can outlive the session.
- **`scripts/netns-nat.sh`** keeps its root mode (nft) and gains an **iptables backend**, chosen automatically
  when rootless.
  - The nft rules were only syntax-checked (`nft -c`); without sudo the kernel refuses their
    module-backed expressions. Every run here used the iptables backend.
  - Why: a user namespace cannot load `nft_masq`/`nft_nat`, but iptables-nft's `xt_MASQUERADE`, `xt_nat` and
    `xt_conntrack` (via `nft_compat`) are already loaded.
  - New commands: `forward a|b PORT [static]`, `block-udp`/`unblock-udp`, and `netem NS DEV ARGS…`. The matrix
    adds its link delay through `netem` rather than `exec … tc`: under sudo, `exec` drops back to `$SUDO_USER`,
    and tc then lacks CAP_NET_ADMIN (found by the verification; root mode is still untested without sudo).
  - Router state lives in `/run/wt-netns`. `exec` skips the `$SUDO_USER` dance when rootless.
  - The public prefix is configurable (`WT_NETNS_PUB`, §2.3).
- **`scripts/s5-matrix.mjs`** drives every row:
  - a fresh topology per row (no conntrack state carries over);
  - a 20-node HyperDHT testnet plus a blind relay in `wt-pub` (`scripts/testnet.mjs --relay`);
  - headless members in `wt-a`/`wt-b`/`wt-c`, run from the working tree with tsx;
  - pass/fail per criterion, from the members' JSON lines.
- **`scripts/s5-hyperdht-trace.mjs`** is preloaded into every member. It prints every error hyperdht
  *constructs*, which shows the cause hyperdht decided on even when another code reaches the socket
  (Finding 3).

### 2.2 Topology and NAT behaviour
```
wt-pub  br-wt P.1/24 ── testnet (20 nodes) + blind relay
  ├── wt-ra  wan P.11 ── NAT ── 10.10.1.1/24 ── wt-a 10.10.1.2
  ├── wt-rb  wan P.12 ── NAT ── 10.10.2.1/24 ── wt-b 10.10.2.2
  └── wt-c   P.20 (no NAT)                      P = 192.88.99 (§2.3)
```
- **plain** = `iptables -t nat -A POSTROUTING -o wan -j MASQUERADE`.
  - Port-preserving, endpoint-independent mapping.
  - A UDP probe to 3 destinations saw the same external port 3 times.
- **random** = `MASQUERADE --random --random-fully`, the same as nft's `random,fully-random`.
  - The probe saw 3 different external ports.
- **Forward** = `PREROUTING -i wan -p udp --dport P -j DNAT --to-destination client:P`.
- **static** adds `POSTROUTING -s client -p udp --sport P -j SNAT --to-source wan:P`, a "static port"
  outbound rule.
- Like a home router, each router drops unsolicited WAN input (`INPUT -i wan -m conntrack --ctstate NEW -j DROP`).
  - Checked: unsolicited UDP from a third party to a client's mapped port is dropped, so filtering is
    address- and port-dependent.
  - The drop also keeps the routers from confirming conntrack entries for stray inbound punches. Those
    entries would collide with the router's own later mappings.

### 2.3 Calibration: three things the first harness got wrong
The original harness had no delay, a 3-node testnet and TEST-NET-2 addresses (198.51.100.0/24). Each of these
distorts hyperdht's behaviour, so every result below uses all three corrections. Finding 11 has the details.
1. **netem `delay 10ms` on every access link, both directions.** That is 20 ms RTT to the DHT and 40 ms between
   members behind different routers.
2. **A 20-node testnet.** With no delay and 5 nodes, the bootstrap query ends in about 5 ms, before
   dht-rpc's one quick firewall probe answers. Then even the un-NATed namespace is classified CONSISTENT, and a
   forwarded port never shows OPEN.
3. **A non-bogon public prefix (192.88.99.0/24).** hyperdht ignores bogon addresses when it dials an OPEN
   server (connect.js:212-219), and TEST-NET-2 is a bogon. A correctly forwarded host then got
   `WTP_AUTH_TIMEOUT` instead of a link.

### 2.4 Members and what they record
- Each member is one `Room` per process (`headless.ts host|join`). Keys are fresh in every row. Hosts run
  with `--sticky`: they publish a sticky host-only `session.announce {s5}`.
- `headless.ts` gained these JSON lines (test-only, not in the app bundle):
  - `member`: a peer's path, link or last error changed. It is checked on every `members` event and at
    1 Hz, like the session's 1 Hz `peers` event (base-session.ts:287), because via-peer depends on traffic
    timing and emits no event of its own.
  - `link` / `remote-changed`: the UDX remote of each link, and every `remote-changed`.
  - `connect-error`: with the hint `hintFor()` gives.
  - `bus`: messages from others, with the link they came through.
  - `relay-decision`: every `relayThrough` evaluation. Hyperswarm's prototype is patched before the swarm
    exists, because the first dial happens inside the `Room` constructor.
  - hyperdht's punch and relay counters.
- **Times** are ms from the member's process spawn. That includes Node + tsx start; a member printed `up`
  typically 0.35–0.43 s after spawn, up to 0.8 s under load (run2 m2).

### 2.5 Rows
| Row | Routers a / b | Members (host first) | Plan criterion |
|---|---|---|---|
| nat | plain / random, then swapped, then forwards | Network test (`headless.ts nat`) in each namespace: a fresh DHT per test, each forward variant on its own port | 1, 7, NAT classes, UDP blocked |
| a1 / a2 | plain / random | CONSISTENT host ↔ RANDOM viewer / RANDOM host ↔ CONSISTENT viewer, no relay | 4 |
| a3 / a4 | plain / random | as a1 / a2, relay key in the invite | 4, 5 |
| a5 | plain / random | as a1, relay key + `alwaysRelay` on both | 5 |
| b1 / b2 / b3 | random / random | RANDOM ↔ RANDOM: no relay / relay key / relay key + `alwaysRelay` | 2, 3 |
| c1 | random / random | OPEN host (c), RANDOM viewers a and b | 6 |
| c2 | random / random | RANDOM host (b), OPEN viewer (c) first, then RANDOM viewer (a) | 6 (admitted via a neighbour) |
| d1 / d2 / d3 | random / random, random, plain | b hosts with `--port 49800` behind a forward: DNAT / DNAT + static / DNAT; RANDOM viewer a | 7 |
| m1 / m2 | plain / random | RANDOM host (b), two CONSISTENT viewers in a 1.4 s apart; no relay / relay key | hyperdht's punch rate limit |
| p | plain / random | 8 × (CONSISTENT ↔ RANDOM, no relay), host side alternating | time to direct |

### 2.6 Commands
```sh
OUT=/some/dir/outside/the/repo
scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out "$OUT" --label run1    # ≈ 8 min, no sudo
scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out "$OUT" --label run2
# subsets and other settings (defaults: --size 20 --netem 'delay 10ms' --pub 192.88.99 --repeats 8)
scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out "$OUT" --label x --rows a3,m2 [--netem none] [--size 5]
# the fix checks of Findings 6 and 9 ran the same driver from scratch copies of the tree (node_modules
# symlinked): one with the §6.1 room.ts change, one with patched copies of hyperdht and hyperswarm (§7 (b))
# by hand: a shell in the session, then the netns-nat.sh header's steps
scripts/netns-rootless.sh
scripts/netns-nat.sh up plain random
scripts/netns-nat.sh exec pub node scripts/testnet.mjs --host 192.88.99.1 --relay --size 20 &
WT_BOOTSTRAP=192.88.99.1:49737 scripts/netns-nat.sh exec a node --import tsx src/core/net/headless.ts host --name A
```

### 2.7 Not run here
- **The phone-hotspot (CGNAT) row.** This machine has no hotspot.
- **Real routers.** That includes the developer's own RANDOM router.
- **Other NAT behaviours.** Real NATs vary more than the two modes above:
  - mapping-timeout tuning (conntrack's 30/120 s defaults were used);
  - hairpinning;
  - predictable (sequential) symmetric NATs;
  - double NAT;
  - IPv6;
  - networks that change mid-session;
  - UPnP/PCP.
- **Datagrams over relayed links.** S2 covered them.

## 3. Results
Two identical runs. Every criterion had the same verdict in both.

| # | Plan criterion | Rows | run1 / run2 | Evidence |
|---|---|---|---|---|
| 1 | `randomized` in the RANDOM namespace | nat, every random-router member | **pass / pass** | Network test RANDOM `P.12:0` (b) and `P.11:0` (a); room state RANDOM for every member behind a random router |
| 2 | RANDOM↔RANDOM gives `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` | b1, c1, c2, d1, d2 | **fail / fail** | hyperdht decides it on every attempt (trace: 3–5 per row), but the app receives `HOLEPUNCH_ABORTED`, every time (Finding 3) |
| 3 | …then `relayed` once a relay is set | b2, b3 | **pass / pass** | linked relayed after 546 / 515 ms (b3: 552 / 522); stays relayed; relay probe `ok` |
| 4 | CONSISTENT↔RANDOM goes direct | a1, a2, a3, p | **pass / pass** | 22 of 22 pairs linked direct; time to link below |
| 5 | …and fires `remote-changed` | a3, a4, a5, m2 | **partial / partial** | a4, a5, m2-V1: relayed → `remote-changed` on both sides → path `direct`. Never on links that were direct from the start. a3 never starts relayed (src defect, Finding 6); with the §6.1 fix it does (relayed 584 ms, `remote-changed` 13.0 s) |
| 6 | A via-peer member receives state | c1, c2 | **pass / pass** | c1: a↔b cannot link, are shown `via-peer`, and get the sticky plus each other's traffic through the host. c2: A cannot reach the RANDOM host, is admitted through C at 4.29 s, and gets the host's sticky via C at 4.33 s |
| 7 | A forwarded port turns RANDOM into OPEN or CONSISTENT | nat, d1, d2 | **fail / fail** | random + forward and random + forward + static both stay RANDOM, and a RANDOM viewer cannot link (Finding 8). plain + forward turns into OPEN, and a RANDOM viewer links directly in 493 / 486 ms (d3) |
| – | Phone hotspot (CGNAT) | – | **not run** | §2.7 |

**Network test** (`headless.ts nat`, a fresh DHT; time includes process start; run1 / run2):

| Namespace and router | Class | Address | Time | Hint shown |
|---|---|---|---|---|
| a, plain | CONSISTENT | P.11:45516 / :54850 | 0.43 / 0.39 s | none |
| b, random | RANDOM | P.12:0 | 0.43 / 0.39 s | "Your router gives each connection a new port, so some friends may not reach you. Add a relay, or set a fixed UDP port in Settings and forward it." |
| c, no NAT | OPEN | P.20:49737 | 0.45 / 0.40 s | none |
| a random, b plain (swapped) | RANDOM / CONSISTENT | P.11:0 / P.12:47900, :59111 | 0.34–0.39 s | as above / none |
| b random, `--port 49811`, no forward | RANDOM | P.12:0 | 0.35 / 0.34 s | "…Forward UDP 49811 on your router, or add a relay." |
| b random + forward 49812 | **RANDOM** | P.12:0 | 0.30 / 0.28 s | the same, with 49812 |
| b random + forward 49813 + static | **RANDOM** | P.12:0 | 0.33 / 0.27 s | the same, with 49813 |
| b plain, `--port 49814`, no forward | CONSISTENT | P.12:33285 / :43713 | 0.37 / 0.34 s | none |
| b plain + forward 49815 | **OPEN** | P.12:49815 | 0.40 / 0.36 s | none |
| b plain, UDP blocked | UNKNOWN | – | 6.21 / 6.19 s | "No answer from the network within 15 seconds. Is UDP blocked by a firewall?" |

**Links**: the viewer's view, in ms from the viewer's spawn (run1 / run2). The host's side links about 0.43 s
later in its own clock, because it started first.

| Row | Pair | Linked | Path (first → last) | `remote-changed` (viewer / host) | Errors seen by the viewer |
|---|---|---|---|---|---|
| a1 | C host ↔ R viewer | 4,247 / 7,790 | direct → direct | – | none |
| a2 | R host ↔ C viewer | 4,347 / 5,088 | direct → direct | – | none |
| a3 | C ↔ R, relay key | 4,015 / 3,725 | direct → direct | – | none |
| a3 with §6.1 fix | C ↔ R, relay key | 584 | relayed → direct | 13,023 / 13,550 | none |
| a4 | R ↔ C, relay key | 533 / 528 | relayed → direct | run1 1,564 / 1,989; run2 3,841 / 4,268 | none |
| a5 | C ↔ R, relay + alwaysRelay | 559 / 504 | relayed → direct | run1 2,155 / 2,581; run2 2,728 / 3,153 | none |
| b1 | R ↔ R | no link | – | – | `HOLEPUNCH_ABORTED` ×4 in 20 s (first at 488 / 451) |
| b2 | R ↔ R, relay key | 546 / 515 | relayed → relayed | – | none |
| b3 | R ↔ R, relay + alwaysRelay | 552 / 522 | relayed → relayed | – | none |
| c1 | O host ↔ R viewers a, b | a 446 / 496, b 438 / 499 | direct; a↔b `via-peer` | – | a↔b `HOLEPUNCH_ABORTED` ×3–4 |
| c2 | R host, O viewer C, R viewer A | A: no host link; A↔C 4,287 / 4,290 | host `via-peer` | – | A→host `HOLEPUNCH_ABORTED` ×5 |
| d1 / d2 | R+fwd host ↔ R viewer | no link | – | – | `HOLEPUNCH_ABORTED` ×4 (d1) / ×3 (d2), both runs |
| d3 | OPEN (C+fwd) host ↔ R viewer | 493 / 486 | direct, to `P.12:49800` | – | none |
| m1 | R host ↔ C viewers V1, V2 | V1 7,485 / 1,354; **V2 45,742 / 20,792** | direct | – | V2 `HOLEPUNCH_ABORTED` ×5 / ×8 (the host answered TRY_LATER 5 / 8 times) |
| m2 | the same, relay key | V1 527 / 822; V2 489 / 838 | V1 relayed → direct (842 / 7,476); **V2 stays relayed** | V2: none | V2 trace: `REMOTE_NOT_HOLEPUNCHABLE` at 25.3 / 31.1 s |
| m2 with patched hyperdht | the same | V1 515 / 527; V2 469 / 472 | both relayed → direct | V2: 37,914 / 45,017 | none |
| p | C ↔ R ×16 (8 per run) | median 5.1 s, mean 5.9 s, p90 11.8 s, max 12.9 s, min 0.5 s | direct | – | none |

With a1–a3 included, CONSISTENT↔RANDOM without a relay took 0.5–12.9 s over 22 links (median 4.5 s).

**Error codes and hints the app showed** (`connect-error`, `MemberView.lastError`, `RoomState.hostError`):
- **`HOLEPUNCH_ABORTED`** → "A direct connection could not be made. A relay or a forwarded UDP port helps."
  - Seen in b1, c1, c2, d1, d2 and m1.
  - It is the only connect error any row produced.
- **`NO_BOOTSTRAP`** → "No answer from the network within 15 seconds. Is UDP blocked by a firewall?"
  - Shown after 6.2 s.
- **Network-test hints**: the RANDOM ones, as in the table above.
- **Never shown, only traced:**
  - `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` (its hint is unreachable);
  - `REMOTE_ABORTED`;
  - `REMOTE_NOT_HOLEPUNCHABLE`.

**Paths reported:**
- `direct`, `relayed`, `via-peer`, `none`.
- `lan`: the two m-row viewers (two processes in namespace a) linked over `10.10.1.2`, through hyperdht's
  same-public-address shortcut (connect.js:251-275, server.js:449-462).

## 4. Findings
1. **NAT classes come out as designed.**
   - plain → CONSISTENT: the client socket's port is kept.
   - random → RANDOM: `port 0`, i.e. `dht.randomized` (dht-rpc index.js:134-136).
   - No NAT → OPEN, with the server socket's port, 49737.
   - UDP blocked → UNKNOWN with the "UDP blocked?" hint.
   - The test needs about 0.3–0.45 s including process start.
   - "UDP blocked" answers after 6.2 s, not 15: `fullyBootstrapped()` resolves once the bootstrap query gives
     up, and `networkTest` then sees an empty table (diagnostics.ts:87-92). The hint's "within 15 seconds" is
     therefore wrong (§6.2).

2. **CONSISTENT↔RANDOM goes direct, by hyperdht's birthday punch, in seconds rather than milliseconds.**
   - **How it works:**
     - The RANDOM side opens 256 sockets toward the CONSISTENT side's verified address (holepuncher.js:6,
       :206, :271-276). Each socket gets a new random port on its NAT.
     - The CONSISTENT side sends to random ports of the RANDOM side's host, every 20 ms, for up to 1750 tries
       (≈ 35 s; holepuncher.js:199, :234-244).
     - Each probe hits with p ≈ 256/64,512. That makes about 250 probes, about 5 s, plus the handshake rounds,
       and leaves e^-6.9 ≈ 0.1 % unconnected after 35 s.
   - **Measured:** median 4.5 s, up to 12.9 s, 22 of 22 linked.
   - A relay hides this wait: a4 and a5 link relayed in about 0.5 s and are upgraded after 1.6–3.8 s.
   - These times are samples of one distribution, the birthday punch: seconds, occasionally over 15 s, and
     ~0.1 % not within 35 s. The verification run drew from the same distribution and saw longer ones: a4
     upgraded at 8.4 s, a5 at 10.4 s, a3 direct at 9.9 s, a p-row link at 16.4 s. Relayed → direct upgrades
     follow it too.

3. **RANDOM↔RANDOM: hyperdht detects the double-randomized pair but reports `HOLEPUNCH_ABORTED`.**
   - The trace shows `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` being constructed (connect.js:668-671) about 0.45 s
     after start, then `REMOTE_ABORTED`, then `HOLEPUNCH_ABORTED`.
   - **Why the specific code is lost:**
     - `abort()` calls `destroyPuncher(c)` (connect.js:789, :845-848) before `maybeDestroyEncryptedSocket(c, err)`
       (:790).
     - The puncher's `destroy()` runs its `onabort` (holepuncher.js:306-309). `onabort` was set at
       connect.js:285 to the closure at :238-241, which destroys the socket with `HOLEPUNCH_ABORTED()`.
     - By the time `abort()` passes the real error, the socket is already destroying, so
       `maybeDestroyEncryptedSocket` returns at :764.
     - Other causes are lost the same way:
       - `HOLEPUNCH_PROBE_TIMEOUT`, which also goes through `abort()` (:664);
       - `REMOTE_ABORTED`, `REMOTE_NOT_HOLEPUNCHING` and `REMOTE_NOT_HOLEPUNCHABLE`, through the catch blocks
         at :294-298 and :335-339, which also destroy the puncher first.
   - **Consequences:**
     - The diagnostics entry for `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` is unreachable with hyperdht 6.34.1.
     - Users see the `HOLEPUNCH_ABORTED` hint, which recommends a forwarded port. That cannot help a RANDOM
       pair (Finding 8).
     - Relaying is unaffected: Hyperswarm forces it after `HOLEPUNCH_ABORTED` too (hyperswarm index.js:225-231,
       :674-680). b1's second relay decision is `force: true`, which returns null only because b1 has no key.
   - **The two sides see different things:**
     - The viewer stays `joining`, with `hostError` and the hint, and retries with backoff: 4 attempts in 20 s.
     - The host never learns that someone tried: no join request arrives, and Hyperswarm does not surface
       server-side failures.

4. **The relay works as designed.**
   - b2 and b3: RANDOM↔RANDOM is linked and `relayed` about 0.5 s after the viewer starts.
   - The relay probe is `ok` before the link exists, so the very first `peer` event already says `relayed`.
   - The link stays relayed: each upgrade attempt is again a double-randomized abort.
   - `alwaysRelay` changes nothing for this pair.
   - Bus traffic (the sticky) crosses the relay.

5. **`remote-changed` fires exactly when hyperdht upgrades a relayed link, and the path follows it.**
   - Upgrades (a4, a5, m2-V1, and a3 with §6.1) call `rawStream.changeRemote` on both sides:
     - client: connect.js:498-504;
     - server: server.js:351-354.
   - udx then emits `remote-changed`. `PeerLink` turns it into `path-changed`, and `members()` reports
     `relayed` → `direct`.
   - Links that were direct from the start never fire it: a1, a2, c1, d3, p.
   - So the plan's "CONSISTENT↔RANDOM goes direct and fires `remote-changed`" holds only for links that start
     relayed: a relay key whose decision saw the NAT (Finding 6), or `alwaysRelay`.
   - **`alwaysRelay` does not keep a link relayed.** a5 is upgraded to direct (after 2.2–2.7 s in the two runs,
     10.4 s in the verification run) like any other link, because hyperdht holepunches in parallel and upgrades whenever it can.
     - If the setting is ever meant for privacy (hiding addresses), it needs hyperdht's `holepunch` callback:
       connect.js:320-330 for dials, the server's `holepunch` option at server.js:33 and :591.
     - Hyperswarm 4.17.2 passes neither through (index.js:47-52, :211-216). Today the setting only guarantees
       a relayed start.

6. **src defect: a RANDOM viewer's first dial never uses the relay** (a3, both runs).
   - **The chain:**
     - The `Room` constructor calls `this.swarm.joinPeer(hostKey)` (room.ts:352).
     - Hyperswarm dials synchronously: `joinPeer` → `_attemptClientConnections` → `_connect`
       (hyperswarm index.js:547, :285, :199).
     - `_connect` evaluates `relayThrough` at once (:211). swarm.ts:48-51 reads `sw.dht.randomized`.
     - `randomized` is false: the DHT has not bound its sockets, let alone sampled its NAT
       (dht-rpc index.js:134-136).
   - **Evidence:**
     - Every viewer's first `relay-decision` came 0.19–0.25 s after spawn, inside the constructor, with
       `natKnown: false`. Hosts decide later, on the server side, after bootstrap (`natKnown: true`).
     - In a3 it was `relay: false`. Neither side relays: the CONSISTENT host's server-side decision is null
       too, and hyperdht relays only if one side asks (connect.js:534-536, server.js:427-429).
     - The pair therefore waits for the birthday punch: 4.0 / 3.7 s, up to 13 s (Finding 2), with no relayed
       phase and no `remote-changed`.
   - **Where it does not matter:**
     - b2: the RANDOM host's server-side decision, made after its own bootstrap, supplies the relay.
     - a4: the same.
     - a5: `alwaysRelay` does not depend on the NAT.
   - **Fix (§6.1), verified in a scratch copy of the tree:**
     - The change: dial the host only after `fullyBootstrapped()`.
     - a3: the first decision came at 334 ms with `randomized: true, relay: true`. The link was relayed at
       584 ms, and `remote-changed` → `direct` followed at 13.0 s.
     - a4, b1, b2 and c2 behaved as before.
     - The cost is the bootstrap time on the first dial: about 130 ms here (first decision at 325–339 ms with
       the fix, ~190–200 ms without). On the public DHT it is not measured: a fresh node's `fullyBootstrapped()`
       is an iterative self-lookup there. Measure it in the real-network rows (§7) before relying on it. A dial made before bootstrap does not wait for it: dht-rpc seeds the query with the
       bootstrap nodes (query.js:122-126).
   - The existing integration test cannot catch this. `relay-scenario.ts` runs with `alwaysRelay: true`.

7. **Via-peer works: the bus and neighbour admission deliver room state to members without a direct link.**
   - c1: a↔b fail (`HOLEPUNCH_ABORTED`, with double-randomized decided). Both show each other as `via-peer`,
     with `lastError` and its hint. Each receives the host's sticky directly, and the other's `room.join-req`
     or `room.hb` with `via` = the host.
   - c2: A cannot reach the RANDOM host (`HOLEPUNCH_ABORTED` ×5).
     - After `admitWaitMs` (3 s), A asks its OPEN neighbour C.
     - The host's `room.admission` reaches A via C at 4.29 s.
     - The sticky `session.announce` arrives via C about 45 ms later.
     - The host is shown `via-peer`.
   - `via-peer` is computed lazily in `members()`, and no `members` event marks the first forwarded traffic.
     The UI still shows it because the session polls at 1 Hz. Anything that only listens to `members` events
     will not.

8. **A forwarded port turns CONSISTENT into OPEN, but leaves RANDOM as RANDOM.**
   - **plain + forward:**
     - The Network test and the room report OPEN, with the forwarded port as the address.
     - A RANDOM viewer links straight to `P.12:49800` in 0.49 s, with no punch at all (d3). That is how the
       un-NATed host in c1 behaves too.
   - **random + forward** (with or without the static outbound rule) stays RANDOM, and d1/d2 never link.
   - **Root cause in dht-rpc:**
     - While firewalled, every request leaves from the client socket (io.js:321). Its port is random
       (io.js:265), so the user cannot forward it.
     - Behind a randomizing router those requests get a new external port per destination, so the NAT sampler
       reports port 0.
     - `_updateNetworkState()` then returns before it ever probes the server port (index.js:814). The quick
       probe (:389-430) is sent, and answered through the forward, but its result is never used.
     - The probe itself (:916-958) additionally requires the forwarded port to keep its number outside: the
       `PING_NAT` reply goes to `<public IP>:<the claimed local server port>` (index.js:417/929 with :649-655).
   - **Probe with bare HyperDHT nodes, plus an echo** (not part of the matrix):
     - Only DNAT + static outbound mapping + `new HyperDHT({port, firewalled: false})` gave an OPEN, reachable
       server (echo after 176 ms).
     - DNAT alone stayed randomized even with `firewalled: false`.
     - `firewalled: false` with no forward (a false claim) produced an `open` with no path behind it, then
       `ETIMEDOUT` after 13 s.
   - **So the "Option without a VPS" does nothing for its target user**, the RANDOM developer. It helps
     CONSISTENT users become OPEN. That does help their RANDOM friends: no punch and no rate limit
     (Finding 9).

9. **hyperdht allows one random punch per node per 20 s. With a relay, the later CONSISTENT viewers of a
   RANDOM host can stay relayed for the whole session.**
   - **The limit:**
     - `randomPunchInterval` is 20 s and `_randomPunchLimit` is 1 (index.js:22, :54-56).
     - It is checked by the client (connect.js:681-710) and by the server (server.js:600-622).
     - `_lastRandomPunch` is set when a punch succeeds and also when it fails (holepuncher.js:289-295).
   - **Without a relay (m1):**
     - V2 linked after 45.7 / 20.8 s; V1 took 7.5 / 1.4 s.
     - The host answered TRY_LATER 5 / 8 times (server.js:606).
     - Without a relay token, the client treats that as an error payload and throws `REMOTE_ABORTED`
       (connect.js:580-582). The masking of Finding 3 turns it into `HOLEPUNCH_ABORTED`, and Hyperswarm
       retries later.
     - With N viewers, viewer k waits roughly 20·(k−1) s or more.
   - **With a relay (m2):**
     - Both viewers link relayed in about 0.5–0.8 s, and V1 is upgraded.
     - V2's delayed punch ends in `REMOTE_NOT_HOLEPUNCHABLE` at 25–31 s (traced). hyperdht never tries again
       on a live relayed connection (connect.js:766), so **V2 stays relayed**.
   - **Root cause:**
     - On a server-side TRY_LATER, `updateHolepunch` returns at connect.js:572-578, before `updateRemote`
       (:586-591). The token echo of that round therefore never marks the server's address verified.
     - The delayed round sends `token: null` (:731).
     - `_punch()` refuses a RANDOM remote without a verified address (holepuncher.js:194), which throws at
       connect.js:753-755.
   - **Candidate upstream fix**, verified in a scratch copy with a patched hyperdht: keep the verification on
     TRY_LATER (§7).
     - Result: V2 was upgraded to direct at 37.9 s and 45.0 s, in two runs, with no
       `REMOTE_NOT_HOLEPUNCHABLE`.
     - m1 (no relay, so no delayed round) and a4 were unchanged.
   - **Cost:** the server refuses a random punch only while one is in flight or within 20 s of the last one
     (server.js:600-604, holepuncher.js:289-295). Every viewer whose join falls within ~20 s of another viewer's
     punch therefore stays relayed: worst case "all viewers but one" of a RANDOM host (plan §4.1: ~54 GB per
     relayed 4K viewer over 2 h), not "only the RANDOM↔RANDOM pairs". m2 measured two viewers 1.4 s apart.

10. **No auth failure, ban or dropped link in any row of either run.**
    - No `auth-failed` events.
    - No `peer-gone` before the driver stopped the members.
    - The auth and ctrl lanes survived every relayed → direct upgrade (a4, a5, m2-V1). `changeRemote` keeps
      the secret stream.
    - Neighbour admission (c2) produced no false bans either.

11. **Emulation pitfalls**, which matter for anyone repeating S5 or writing integration tests:
    - **No latency + a small testnet means no OPEN at all.**
      - dht-rpc sends a single quick firewall probe (`PING_NAT`) on the first query response, and counts its
        result only if it arrives before the bootstrap query ends (index.js:389-430).
      - The next check is the adaptive one after `STABLE_TICKS`, i.e. 240 × 5 s ≈ 20 min (:777-783).
      - Calibration trials:
        - 5 nodes, with or without 10 ms per link: lost 8 of 8.
        - 20 nodes and no delay: race-dependent. The un-NATed namespace won 3 of 3 under load (load average
          0.7–8.3) and lost 3 of 3 in the verification run at low load (0.2–0.8); a forwarded port lost 2 of 2.
        - 20 nodes and 10 ms per link: won in every test of both runs and of the verification run.
      - On the public DHT the race is normally won. A loopback or LAN testnet without link delay classifies
        OPEN unreliably at best: use 20 nodes and 10 ms per link.
    - **Bogon public addresses mislead connect.**
      - For an OPEN server, connect.js:212-219 skips bogon `addresses4` and dials the address the DHT relay
        node saw instead.
      - Hyperswarm announces at construction, before the firewall check completes, so that address is the
        host's client-socket mapping, not the forwarded port.
      - The original TEST-NET-2 harness reported "a forwarded host is unreachable" (`WTP_AUTH_TIMEOUT`).
        Public addresses do not have this problem.
    - **A hyperdht socket's `open` proves nothing about the path.**
      - The Noise handshake runs through the DHT, so secret-stream resolves `opened` immediately
        (secret-stream index.js:440-443).
      - Our `Room` only reports a link once the auth lane opens; its 4 s guard
        (`authOpenTimeoutMs`) catches hollow dials. Every link time above is therefore a real round trip.
    - **conntrack entries outlive `unforward`** (30–120 s). The nat row therefore gives every forward variant
      its own port.

## 5. Decision
The plan's S5 fallback applies: **real-network matrix only; the UI recommends a relay.**
- **Keep the relay design:**
  - `relayThrough` uses force, randomized or alwaysRelay;
  - one key, taken from the invite, then `room.state`, then the member's own setting;
  - the path comes from the relay's probed address.
  - It links RANDOM↔RANDOM in about 0.5 s and upgrades every link that can go direct (except Finding 9).
- **Fix the first-dial defect** (§6.1). Without it, a RANDOM viewer joining a CONSISTENT or OPEN host with a
  relay set (for example the developer joining a friend's room) waits for the birthday punch (median ~4.5 s,
  up to 13–16 s) instead of starting relayed. RANDOM hosts are unaffected (a4, b2): their server-side decision,
  made after bootstrap, supplies the relay.
- **Withdraw "forward a UDP port" as advice for RANDOM NATs.**
  - It does not change the class (Finding 8).
  - Keep `udpPort` as an option for CONSISTENT users. The Network test shows OPEN once the forward works, and
    an OPEN host is reachable by RANDOM friends without a punch or the 20 s spacing.
  - Hints change accordingly (§6.2).
  - The plan's line "S5 checks that forwarding turns RANDOM into OPEN or CONSISTENT" becomes: "turns
    CONSISTENT into OPEN; RANDOM needs a relay".
- **Do not build hints on `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`.** With hyperdht 6.34.1 the app sees
  `HOLEPUNCH_ABORTED`. Its hint must be right for both causes: relay, or retry.
- **Budget relay bandwidth as "every viewer of a RANDOM host whose join falls within ~20 s of another's punch"**
  (worst case all but one) until Finding 9 is fixed upstream or patched. This also argues for the relay being the default recommendation for RANDOM hosts, not a last resort.
- **Run the real-network matrix before beta (M10):**
  - phone hotspot (CGNAT);
  - the developer's RANDOM router;
  - at least two consumer routers;
  - a VPS relay.

  The harness is the same headless member with `WT_BOOTSTRAP` unset.

## 6. Changes recommended for src/
Not applied here: room.ts was being edited by another agent. Only headless.ts changed, test-only. Applied in
round 6, with §7 (b) and an `alwaysRelay` that holds: §8.

**6.1 `src/core/net/room.ts`** (constructor). This is the fix verified in the scratch copy (Finding 6).
```diff
     this.discovery = this.swarm.join(this.topic, { server: true, client: true })
-    if (this.role === 'viewer') this.swarm.joinPeer(Buffer.from(this.hostKey, 'hex'))
+    // Dial the host once the DHT has bootstrapped. relayThrough reads dht.randomized, which stays false until
+    // bootstrap has sampled our NAT, so a dial from here would send a RANDOM viewer's first attempt without
+    // the relay and leave it to a birthday punch (S5, ADR 0005 Finding 6).
+    if (this.role === 'viewer') {
+      void (this.swarm.dht as unknown as HyperDHT)
+        .fullyBootstrapped()
+        .then(() => {
+          if (!this.closing) this.swarm.joinPeer(Buffer.from(this.hostKey, 'hex'))
+        })
+        .catch(() => undefined)
+    }
```
An alternative with no delay: in swarm.ts, treat an unknown NAT like a randomized one
(`force || sw.dht.randomized || sw.dht.host === null || alwaysRelay`). It relays every member's first dial
while a relay key is set, and those dials then upgrade. The deferral is simpler and wastes no relay traffic.

Regression check:
- `scripts/s5-matrix.mjs --rows a3`: the viewer's first `relay-decision` after bootstrap says
  `randomized: true, relay: true`. Do not require a relayed phase: when the birthday punch completes before
  the auth lane opens, the first path is already `direct` (1 of 6 a4 runs from the fixed tree in the
  verification), which is not a regression.
- A unit test with a stub DHT whose `fullyBootstrapped()` is pending should assert that `joinPeer` has not
  been called.

**6.2 `src/core/net/diagnostics.ts`**: hints that match what S5 measured (Findings 1, 3, 8).
```diff
 function natHint(cls: NatClass, udpPort: number | null): string | null {
+  // S5: a forwarded port does not change RANDOM (hyperdht never tests it while its other traffic leaves from
+  // random ports), so only a relay helps there; with CONSISTENT the forward shows up as OPEN once it works.
   if (cls === 'RANDOM') {
-    return udpPort
-      ? `Your router gives each connection a new port, so some friends may not reach you. Forward UDP ${String(udpPort)} on your router, or add a relay.`
-      : 'Your router gives each connection a new port, so some friends may not reach you. Add a relay, or set a fixed UDP port in Settings and forward it.'
+    return 'Your router gives each connection a new port, so friends whose routers do the same cannot reach you directly. Add a relay.'
   }
+  if (cls === 'CONSISTENT' && udpPort) {
+    return `UDP ${String(udpPort)} does not answer from the internet yet. Check the port forward on your router.`
+  }
   if (cls === 'UNKNOWN') return 'Your network type is not known yet.'
   return null
 }
@@ const HINTS: Record<string, string> = {
-  HOLEPUNCH_DOUBLE_RANDOMIZED_NATS: 'Both of you have strict NATs: add a relay or forward a UDP port.',
-  HOLEPUNCH_ABORTED: 'A direct connection could not be made. A relay or a forwarded UDP port helps.',
+  // hyperdht 6.34.1 reports a double-randomized pair as HOLEPUNCH_ABORTED (S5); kept for later versions
+  HOLEPUNCH_DOUBLE_RANDOMIZED_NATS: 'Both of you have strict NATs, so you cannot connect directly: add a relay.',
+  HOLEPUNCH_ABORTED: 'A direct connection could not be made yet; it is retried. If both of you have strict NATs, only a relay helps.',
@@
-  NO_BOOTSTRAP: 'No answer from the network within 15 seconds. Is UDP blocked by a firewall?',
+  NO_BOOTSTRAP: 'No answer from the network. Is UDP blocked by a firewall?',
```
`diagnostics.test.ts` changes with it:
- "suggests forwarding the configured UDP port behind a RANDOM NAT" becomes "recommends a relay behind a RANDOM
  NAT, with or without udpPort" plus "flags an unforwarded udpPort behind a CONSISTENT NAT";
- the expected `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS` text changes to the new one.

**6.3 `src/core/net/README.md`, "Manual and S5"**: replace `sudo scripts/netns-nat.sh up plain random` with
`scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out DIR` (no sudo), and link this ADR.

## 7. Follow-ups
- **Real-network S5 rows (before beta):**
  - phone hotspot (CGNAT);
  - the developer's RANDOM router, with and without a forward and with "full cone"/EIM if the router offers it;
  - two consumer routers;
  - a VPS relay.

  Record class, path, time to link and hints with `headless.ts`.
- **Upstream (hyperdht), with the line references above:**
  - (a) `abort()` and the punch catch blocks report `HOLEPUNCH_ABORTED` instead of the cause (Finding 3).
    - Hyperswarm forces the relay only for the codes in `shouldForceRelaying` (index.js:674-680), and today
      every punch failure arrives as one of them, `HOLEPUNCH_ABORTED`.
    - A fix that delivered `HOLEPUNCH_PROBE_TIMEOUT` or `REMOTE_ABORTED` instead would stop relay forcing for
      those cases.
    - So either attach the cause to `HOLEPUNCH_ABORTED` (e.g. `err.cause`), or extend that list together with
      the fix.
  - (b) A server-side TRY_LATER loses the address verification (Finding 9). Candidate patch, verified here
    (Finding 9), a 4-line change in `updateHolepunch` (connect.js:572):
    ```diff
       if (error === ERROR.TRY_LATER && c.relayToken && payload.punching) {
    +    if (remoteToken && payload.token && b4a.equals(remoteToken, payload.token)) {
    +      c.puncher.updateRemote({ punching, firewall, addresses, verified: peerAddress.host })
    +    }
         return {
    ```
  - (c) A forwarded port is never tested while the client socket's mapping is random (Finding 8).
- **If relay bandwidth matters before (b) is fixed upstream:** carry (b) with patch-package. The project already
  patches webtorrent that way. The alternative is an app-level re-dial of a relayed link to a non-RANDOM peer
  after more than 20 s, which makes hyperdht punch again.
- **Optional:** add each member's NAT class to `room.hb`. The UI could then say "both of you have strict NATs"
  precisely, even when hyperdht reports `HOLEPUNCH_ABORTED`.
- **Integration test for §6.1:** a RANDOM-like member. `alwaysRelay: false`, a relay key, and a stub that
  reports `randomized` only after bootstrap is enough.
- **`scripts/testnet.mjs` defaults to `--size 3`.** For NAT work, document `--size 20` with link delay
  (Finding 11). Otherwise OPEN is never detected.
- **Optional:** `headless.ts` could print hyperdht's own `stats.punches` per peer instead of per node, to
  attribute punches when several peers connect at once.

## 8. Applied (round 6)
Date: 2026-10-22. Changes in `src/core/net` (its README, deviation 17, has the details):
- **§6.1:** a viewer dials the host after `fullyBootstrapped()`, and not at all once it is closing.
  Unit test: `room.test.ts`, a stub DHT.
- **§6.2:** the hints as proposed there. Unit tests: `diagnostics.test.ts`.
- **§7 (b):** `patches/hyperdht+6.34.1.patch` (patch-package). hyperdht has one copy (hyperswarm's is deduped).
  `swarm.test.ts` checks that the loaded copy carries the patch.
- **Finding 5, `alwaysRelay` holds.** `createSwarm` makes the DHT node itself, and `holdRelayed` wraps
  `connect` and `createServer`. While `alwaysRelay` is on and a relay key is set:
  - hyperdht's `holepunch` callback refuses the punch, for dials and for the server;
  - dials go without fast open and without the LAN shortcut;
  - the server never punches (`_neverPunch`), so it sends no fast-mode ping (server.js:470, :577-584).
  Unit tests: `swarm.test.ts`.
- **Unguarded join request** (round-5 review): `onAuthFrame` now runs the host's `onJoinRequest` through
  `guarded`. Integration test: `membership.test.ts`.

Matrix rows re-run with `scripts/netns-rootless.sh node scripts/s5-matrix.mjs` (defaults: 20 nodes, 10 ms per
link). Times are ms from the viewer's spawn. In these runs a member took 0.3–0.6 s from spawn to its room's
first log line, because of load; that is why links show at ~1.0 s where §3 shows ~0.5 s. The first relay
decision came 130–150 ms after the room started, and the link ~430 ms after.

| Row | Result (round 6) | Before |
|---|---|---|
| a3 | **pass**: the viewer's first decision is `randomized: true, relay: true` (720 / 794 ms). Linked relayed at 1,023 / 1,081 ms, then `remote-changed` → direct at 12.3 / 9.9 s | direct only, after 4.0 / 3.7 s; first decision `natKnown: false, relay: false` |
| a4 | **pass**: relayed at 1,039 / 1,031 ms → direct at 7.0 / 2.0 s | the same |
| a5 | **pass**: relayed at 1,018 / 1,033 ms, still relayed 30 s later, no `remote-changed` | relayed → direct after 2.2–10.4 s |
| a6 (new: CONSISTENT ↔ CONSISTENT, relay + `alwaysRelay`) | **pass**: relayed at 665 ms and stays relayed | **never linked**, without the hold too: `RELAY_ABORTED`, then `WTP_AUTH_TIMEOUT` on every attempt (below) |
| b2, b3 | **pass**: relayed at ~1,020 ms, stay relayed, sticky received | the same |
| c2 | **pass**: admitted through the OPEN neighbour at 4.7 s, sticky via it 50 ms later; hint is the new `HOLEPUNCH_ABORTED` text | the same, old text |
| m1 | **pass**: V2 linked direct after 24.9 / 27.9 s (TRY_LATER ×8) | the same (Finding 9) |
| m2 | **pass**: V2 relayed → direct at 41.1 / 34.0 s | V2 stays relayed |
| m2, hyperdht without the patch (mutation check) | V2 stays relayed (`remote-changed` none) | — |

Where two numbers are given, they come from two runs: `r6a` and `r6c` for a3, a4, m1 and m2, and `r6a` and
`r6b` for a5. a3, a4, b2, c2, m1 and m2 in `r6c` and a5, a6 and b3 in `r6b` ran on the final tree.

**New finding (a6): `alwaysRelay` broke links between two CONSISTENT NATs.** The control runs used a copy of the
tree without `holdRelayed`: a6 failed there too, while the same pair without a relay (a7), or with a relay key but
`alwaysRelay` off (a8), linked direct in about 0.6–1.0 s. The trace (hyperdht's counters and constructed errors), and what fixed
it, point to this chain:
- The server relays and pairs (`relaying.successes` went up 7 times).
- The dialer's relay aborts as it pairs (`RELAY_ABORTED`), because its stream was already connected directly.
  The server's fast-mode ping (server.js:577-584) had reached the dialer's puncher, whose session toward the
  server had opened that NAT mapping.
- Each side therefore uses a different path, and the auth lane never opens.
- Refusing the punch alone does not help: the ping comes before hyperdht asks the callback.
- The same race can still happen when both sides relay without `alwaysRelay` (forced after a `HOLEPUNCH_*`
  error) and both NATs are CONSISTENT. It was not reproduced, because CONSISTENT pairs do not normally fail a
  punch. Upstream follow-up: on a direct upgrade that races relay pairing, the side that paired should change
  its remote rather than keep the relay.
