# src/core/net: connectivity and rooms

This module handles connectivity and rooms (plan §4.1, §5.2 and §5.3). It covers:

- one Hyperswarm per room;
- authenticated links with an auth lane, a ctrl lane and datagrams;
- the signed room bus;
- admission, kick and rotate;
- bans;
- small blob transfer;
- diagnostics.

It runs in the core utilityProcess. It has no Electron imports and no RPC: the lead wires it into the session and the RPC handlers.

| File             | What it does                                                             |
| ---------------- | ------------------------------------------------------------------------ |
| `room.ts`        | **`Room` facade**: swarm, links, bus, membership, presence, relay probe. |
| `peer.ts`        | `PeerLink`, one per Hyperswarm connection. It implements `RoomPeer`.     |
| `bus.ts`         | Signed envelopes, dedupe, forwarding, host-only and sticky policies.     |
| `membership.ts`  | Host-side admission book: open or approve mode, cap, pending queue.      |
| `bans.ts`        | Bans with expiry. Synchronous `has()` for the Hyperswarm firewall.       |
| `identity.ts`    | `room.json` records (mode 0600), `RoomStore`, `DHT.keyPair(seed)`.       |
| `invite.ts`      | Invite v1 binary codec, z32, the "Copy invite" text block.               |
| `crypto.ts`      | Topic, authKey, auth proofs, ed25519 bus signatures, z32 helpers.        |
| `wire.ts`        | Lane names, frame limits, frame codecs, Hello.                           |
| `swarm.ts`       | Hyperswarm options as in plan §4.1, bootstrap resolution, dial reports.  |
| `path.ts`        | Path classification: `lan`, `direct`, `relayed`.                         |
| `blobs.ts`       | `blob.get` / `blob.data` over ctrl, with BLAKE2b-256 verification.       |
| `diagnostics.ts` | NAT class, Network test, error → hint table, relay probe.                |
| `errors.ts`      | `WTP_*` error codes.                                                     |
| `headless.ts`    | CLI member for manual and S5 tests. Not imported by the app.             |

## Room API

```ts
import { Room, RoomStore, networkTest, hintFor, Blobs, FileBlobProvider } from './net/...'

const store = new RoomStore(app.getPath('userData')) // <userData>/wt/rooms/<id>/room.json
const opts: RoomOptions = {
  displayName,
  settings /* udpPort, bootstrapExtra, relayKey, alwaysRelay */,
  store,
  admission: 'open' | 'approve',
  maxMembers,
  appVersion,
}

const room = await Room.create({ ...opts, name }) // host: fresh secret and keySeed
const room = await Room.join(inviteTextOrLink, opts) // viewer: reuses this machine's keySeed for that room
const room = await Room.resume(record, opts) // either role, from store.list() / store.load(id)
await room.ready() // first announce on the topic flushed
```

### Calls

| Call                          | Notes                                                                                                                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish(name, body, {to?})`  | Bus message, e.g. `'sync.status'`. Host-only names throw `WTP_NOT_HOST` on viewers. An envelope over 64 KiB − 64 B (it must fit one ctrl frame), or over its name's `maxBytes`, throws `WTP_FRAME_TOO_LARGE`. Sticky messages cannot take `to`. |
| `onMessage(nameOrNs, h)`      | Takes `'sync.state'` or a whole namespace `'sync'`. `h(msg: BusMessage)` gets `{name, ns, t, from, to, rev, body, via}`. Our own messages are delivered too (`via: null`). Returns an unsubscribe function.                                     |
| `defineMessage(name, policy)` | `{hostOnly?, sticky?, rate?: {burst, everyMs}, maxBytes?}` (`rate`: per origin; `maxBytes`: below 64 KiB; see Bus). `NET_POLICIES` already covers the plan's names, so call this only for new ones.                                             |
| `latest(name)`                | Newest sticky message, e.g. `'session.announce'`.                                                                                                                                                                                               |
| `onDatagram(prefix, h)`       | `h(peer, buf)` for datagrams whose first byte is `prefix`. Sync uses `DATAGRAM_SYNC` (0x53).                                                                                                                                                    |
| `onCtrl(ns, h)`               | Direct (not forwarded) ctrl frames `{ns, t, ...}`. `bus`, `ctrl` and `room` are reserved.                                                                                                                                                       |
| `peers()` / `peer(id)`        | `RoomPeer`s with an admitted link (ctrl lane open).                                                                                                                                                                                             |
| `members()`                   | `MemberView[]`: `{id, name, role, self, isHost, path, rttMs, linked, lastError?}`.                                                                                                                                                              |
| `state()`                     | `RoomState`: phase, hostPresent, admission, cap, pending `{id, name, via?}` (`via`: the member that relayed the request), inviteEpoch, relay `{status, key}`, nat, denyReason, error, hostError.                                                |
| `invite()`                    | `{code, link, text}`. `text` is the clipboard block.                                                                                                                                                                                            |
| `updateSettings(s)`           | Relay key and alwaysRelay apply to the next connection. On the host, a relay key change is re-published in `room.state`. `udpPort` and bootstrap changes need a new Room.                                                                       |
| `admit(id, allow)`            | Host only, approve mode.                                                                                                                                                                                                                        |
| `kick(id, {rotate?})`         | Host only. Returns the new invite when `rotate` is set.                                                                                                                                                                                         |
| `setAdmission(mode)`          | Host only. Switching to `open` admits everyone pending while there is room.                                                                                                                                                                     |
| `setMaxMembers(n)`            | Host only. Clamped to 2..12. Lowering it never removes anyone.                                                                                                                                                                                  |
| `rotateInvite()`              | Host only. Returns the new invite.                                                                                                                                                                                                              |
| `leave({end?})`               | Sends `room.bye {end}` on every link, then destroys the swarm. `end` only has an effect on the host.                                                                                                                                            |
| `close()`                     | Shuts down without a goodbye.                                                                                                                                                                                                                   |
| `roomRecord`                  | Copy of what is persisted.                                                                                                                                                                                                                      |
| `currentTopic`                | The current DHT topic.                                                                                                                                                                                                                          |

### `RoomPeer` (plan §5.3)

`{id, publicKey, name, isHost, path, rttMs, mux, sendDatagram(buf), sendCtrl(frame)}`

- `mux` is the connection's Protomux. Transfer opens its own `'wtp/bt/1'` channel on it, with `id = infoHash`, after the `peer` event. The bt lane should only be used while the peer is in `peers()`.
- `sendDatagram` returns `false` when the ctrl lane is not open, which means the peer is not admitted.

### Events

| Event           | Payload          | When                                                                                                |
| --------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| `peer`          | `RoomPeer`       | An admitted link is up (ctrl open on our side).                                                     |
| `peer-gone`     | `id`             | That link closed, was replaced, kicked or banned.                                                   |
| `members`       | `MemberView[]`   | Membership, link, path or connect-error changes.                                                    |
| `state`         | `RoomState`      | Phase, presence, admission, relay or rekey changes.                                                 |
| `rekey`         | `{inviteEpoch}`  | A viewer moved to a new secret.                                                                     |
| `bye`           | `{peerId, end}`  | A peer said goodbye.                                                                                |
| `auth-failed`   | `{peerId, code}` | `WTP_AUTH_FAILED`, `WTP_PROTOCOL` (both ban the key for 10 min) or `WTP_AUTH_TIMEOUT` (no ban).     |
| `connect-error` | `{peerId, code}` | An outgoing attempt failed: `HOLEPUNCH_*`, `PEER_NOT_FOUND` and so on. Map it with `hintFor(code)`. |

**Viewer phases:**

- `joining` → `pending` (approve mode) → `in-room`;
- `denied` (`denyReason`: `full`, `banned` or `rejected`), `kicked`, `ended` (the host ended the room);
- `error` (`WTP_AUTH_FAILED`: wrong or outdated invite);
- `closed`.

The host starts `in-room`. A viewer goes back to `joining` if a restarted host's member list no longer contains it, and asks again at once.

### Other facades

- **`RoomStore`**: `save(record)` (atomic write, mode 0600 in a 0700 directory), `load(id)`, `list()` (recent rooms, newest first), `remove(id)`.
  - Room id = hex of the first 8 bytes of BLAKE2b-128(hostKey). It is the same on every machine and stays stable across rotations.
- **`Blobs`**: `new Blobs(room, provider?)`; `fetch(hash, {size?, signal?})` returns a `Buffer`; `setProvider(p)`; `destroy()`.
  - Providers: `MemoryBlobProvider.add(data)` returns the hash; `FileBlobProvider.add(hash, path)`.
  - `fetch` tries the host first, then the other peers, in 45 KiB chunks, 4 in parallel. It verifies BLAKE2b-256 (hex) and throws `WTP_BLOB_NOT_FOUND` or `WTP_BLOB_HASH`.
  - The session supplies the provider: the host serves the `.torrent` and the manifest, and viewers re-serve what they fetched.
- **Diagnostics:**
  - `networkTest({bootstrap?, port?, timeoutMs?})` returns a `NatReport`. It starts a temporary DHT, and after 15 s without bootstrap it reports UNKNOWN with "UDP blocked?". The session's `net.test` returns the open room's `state().nat` instead once that room has bootstrapped: its DHT holds `udpPort`, so a second node would bind another port and test that one.
  - `natClass`, `natReport(dht, bootstrapped, udpPort?, bound?)`, `boundPort(dht)`, `hintFor(code)`.
  - `probeRelay(dht, key, timeoutMs)` returns `{ok, address, rttMs}` or `{ok: false, code}`.
  - For `net.test` with the relay set, the lead can call `probeRelay` on the test DHT as well.
- **Invites:** `encodeInvite`, `decodeInvite` (throws `CodedError` with `WTP_INVITE_ENCODING`, `_LENGTH`, `_VERSION` or `_CHECKSUM`), `inviteText`, `DOWNLOAD_URL`.

## Wire (plan §5.2)

One `Protomux.from(conn)` per Hyperswarm connection.

- **auth `wtp/auth/1`:**
  - Channel handshake (`c.raw`): `[ver 1][proof 32][previousEpochProof 32]?`, where `proof = BLAKE2b(handshakeHash ‖ "wtp/auth/" + i|r, key = authKey)`. It is checked with `sodium_memcmp`.
  - Then JSON frames over `c.raw`:
    - `hello {proto: 1, app, name ≤ 32 B, caps}`, at most 4 KiB;
    - `join {env}`: the sender's own `room.join-req` (origin = the link's key, no `to`); anything else is dropped. The host takes it as the joiner's request; a member relays it to the host inside its own `room.join-via` (deviation 16);
    - `env {env}`: the host's `room.admission` answer, plus the sticky `room.state` and `room.members`, handed to a joiner that has no ctrl lane yet (by the host, or by a member the joiner is linked to). Auth frames are at most 16 KiB.
  - Any holder of the invite can write on this lane, admitted or not. So only **host-signed** envelopes are handed over, and a joiner takes from it only the host's messages addressed to it and, once the host has answered `admitted` to its current attempt, `room.state` and `room.members`. They are taken with `ttl: 0`, so nothing from this lane is forwarded. A member's message to a joiner, a join request signed by a key that holds no link, or an old members list replayed to a joiner, never gets past it. An envelope over 16 KiB is not handed over (`sendAuth` returns false).
  - Timeout is 10 s, and 4 s for the remote's auth lane to open at all (a dial it never took up, see deviation 11). On failure the link lingers 250 ms so the other side reaches the same verdict, then it is destroyed. A failed proof or a protocol error also bans the key for 10 min; a timeout does not.
- **ctrl `wtp/ctrl/1`:**
  - Opens only while **both** ends see both keys in the members list. A side that gets the remote's open first waits up to `ctrlPairWaitMs` for its own view to catch up, then retries.
  - Carries JSON frames of at most 64 KiB; larger ones destroy the connection. Frame types:
    - `{ns:'bus', t:'msg', m: envelope}`;
    - `{ns:'ctrl', t:'ping'|'pong', id}`: RTT as an EWMA, every 5 s;
    - `{ns:'room', t:'bye', end}`;
    - module frames such as `blob.get` / `blob.data`.
- **datagrams:** `conn.send` / `'message'`, demultiplexed by the first byte. They are dropped unless the ctrl lane is open.

### Bus

- **Envelope:** `{o, s: "<bootNonce>.<counter>", ttl: 2, ns, t, to?, rev?, body, sig}`.
  - `sig` is ed25519 over `"wtp/bus/1\n" + JSON([o, s, ns, t, to, rev, body])`. `ttl` is excluded because it changes hop by hop.
  - `publish` signs and keeps a JSON copy of `body`, so a caller that changes its object later (the host's member records) cannot change a sticky envelope that is handed out afterwards.
- **Rate limits and sizes.** A name may have a per-origin token bucket (`rate: {burst, everyMs}`) and a size bound below 64 KiB (`maxBytes`). The rate is checked before the signature (cheap) and spent after it (a forgery cannot use up someone's allowance). A message over the limit is dropped (`'rate'`) and not forwarded, so a flood stops at the first hop. Buckets are kept for the 1024 most recent origins.
  - `room.join-req` (at most 1 KiB): 3, then 1 per `rejoinMs / 3`, per joiner key, wherever a request is taken (by the host, and by each member that relays one). Joiners send one per `rejoinMs`, plus one whenever a host link comes up.
  - `room.join-via` (at most 2 KiB): 6, then 1 per `rejoinMs / 6`, per relaying member, on every member it passes and on the host. That is twice a joiner's rate, so that one joiner asking as fast as it may through a member leaves room for others' requests.
- **`take(env)`** checks an envelope as a receiver does (below), except for the origin, and neither delivers nor forwards it: the room acts on join requests itself.
- **Receivers:**
  - parse;
  - dedupe on `(o, s)` with an LRU of 2048;
  - check size (64 KiB − 64 B, or the name's own bound), the host-only policy, the origin (the host or a member; `room.join-req` never travels the bus) and the rate;
  - verify the signature.
  - Then they deliver it if `to` is absent or is themselves (otherwise the room may hand it over, see the auth lane), and forward it to every admitted link except the sender and the origin while `ttl > 0`.
  - `receive` never throws for what a remote sent: a handler, the hand-over hook or a link that fails on it is reported as a `fault` event (the room logs it) and the rest still run. It runs inside the link's message callback, where a throw makes Protomux destroy that connection, and a `TypeError` crashes the process (safety-catch). Our own `publish` still throws what its local handlers throw. `PeerLink.sendAuth`/`sendCtrl` never throw either (false over the lane's limit), and the room runs `onCtrl`/`onDatagram` handlers the same guarded way.
- **Sticky messages** keep the newest `rev` per name, and are replayed with `ttl: 0` to every newly admitted link. `rev` is wall-clock milliseconds, monotonic per publisher, so a restarted host's state supersedes what members kept.

| Name                             | Policy                | Body                                                                                                                        |
| -------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `room.members`                   | host-only, sticky     | `{members: [{key, name, role}], banned: [hex] (last 32)}`                                                                   |
| `room.state`                     | host-only, sticky     | `{name, relayKey, admission, maxMembers, inviteEpoch}` (the plan's `room`★)                                                 |
| `room.rekey`                     | host-only, sticky     | `{secret, inviteEpoch}`                                                                                                     |
| `room.admission`                 | host-only, addressed  | `{state: 'admitted'\|'pending'\|'denied'\|'kicked', reason?, nonce?}`: `nonce` is the attempt it answers (deviation 16)     |
| `room.join-req`                  | never on the bus      | `{name, nonce, at}`, signed by the joiner. On the auth lane only: to the host, or to a member that relays it.               |
| `room.join-via`                  | members, rate-limited | `{req}`: a joiner's `room.join-req`, relayed to the host (`to`) by the member it was sent to. 6, then 1 per `rejoinMs / 6`. |
| `room.hb`                        | members               | `{at}`: the host every 1 s, other members every 5 s (see deviation 14).                                                     |
| `session.announce`, `sync.state` | host-only, sticky     | owned by the session and sync modules                                                                                       |
| `sync.intentResult`              | host-only             | owned by sync                                                                                                               |

## Invariants

- One `Room` means one Hyperswarm, one keyPair (from `keySeed`), and one topic at a time. Everyone joins `{server: true, client: true}`, and viewers also call `joinPeer(hostKey)` once the DHT has bootstrapped (17).
- The host is whoever's `remotePublicKey` equals `hostKey`. The host key never changes for a room, and it is inside every invite.
- Bus links equal admitted links equal `peers()`. Nothing reaches a non-admitted peer except on the auth lane: Hello, host-signed messages addressed to it (the admission answer), and the room state and members needed to finish joining. `room.rekey` is never handed over, so old invites cannot learn the new secret.
- A kicked key is banned for the rest of the session on the host and on every viewer (from `members.banned`). It is also persisted in the host's `room.json`, so a restarted host keeps refusing it.
- `room.json` writes are coalesced: one runs, at most one waits behind it and writes the record as it is when it starts. `close()` waits for it.
- Auth bans (10 min) are lifted through `Bans.onExpire`, which calls `peerInfo.ban(false)`: Hyperswarm's own ban is permanent per PeerInfo.
- The relay key is chosen in this order: invite → host's `room.state` → own setting. It is read on every connection attempt. `relayThrough(force, sw)` returns that key only when `force` is set, the local NAT is randomized, or alwaysRelay is on. With alwaysRelay on and a key set, hyperdht's holepunch is refused, so relayed links stay relayed (17).
- `bootstrap` stays `undefined` unless `WT_BOOTSTRAP` is non-empty or `bootstrapExtra` is set: an empty array would disable bootstrapping.
- `path` comes from `rawStream.remoteHost/remotePort` (re-read on `remote-changed`):
  - the relay's probed address → `relayed`;
  - a private or loopback address → `lan`;
  - anything else → `direct`.
  - In `members()`, a member with no link whose traffic arrived within 60 s is `via-peer`.

### Timing (`DEFAULT_TIMING`, overridable through `testing.timing`)

| Setting                                         | Value                                 |
| ----------------------------------------------- | ------------------------------------- |
| auth timeout                                    | 10 s                                  |
| remote's auth lane open (else a half-open dial) | 4 s                                   |
| auth ban (failed proof or protocol error only)  | 10 min                                |
| stale-link check when a linked member redials   | 2 s                                   |
| ADMIT_WAIT (no host link, then ask neighbours)  | 3 s                                   |
| join re-send                                    | 30 s                                  |
| host away after                                 | 10 s                                  |
| discovery refresh while the host is away        | 60 s                                  |
| heartbeat (`room.hb`): host / other members     | 1 s / 5 s                             |
| ctrl ping                                       | 5 s                                   |
| join requests taken per joiner key              | 3, then 1 per `rejoinMs / 3` (10 s)   |
| relayed join requests per relaying member       | 6, then 1 per `rejoinMs / 6` (5 s)    |
| a key's join attempts kept in order             | 2.5 × re-send after its last request  |
| renames per member (a newer name waits)         | 1 per `rejoinMs` (30 s)               |
| relay probe                                     | every 5 min, 10 s timeout             |
| kick grace                                      | 1 s                                   |
| pending request expiry                          | 2.5 × re-send                         |
| mesh repair                                     | refresh with backoff from 5 s to 60 s |

## Deviations from the plan, and why

1. **Message names are `ns.t`.** The plan's `members`★ and `room`★ are `room.members` and `room.state`, because the bus routes by namespace.
   - Two names were added: `room.admission` (the host's answer to one joiner) and `room.hb` (liveness for `via-peer` members and for host-away detection).
   - `room.bye` is a direct ctrl frame, not a bus message, because it describes the link it is sent on.
2. **The auth handshake is `c.raw` `[ver][proof][prevProof?]`, and the frames after it are JSON over `c.raw`** (not `c.json`), so the byte limits are enforced before parsing.
   - The optional second proof is made with the **previous** epoch's key. It is accepted only from known members, so a member that was offline during a rekey can still reconnect and receive the sticky `room.rekey`.
   - The previous secret is kept in `room.json` as `previousSecret`.
3. **The auth lane also carries `join` and `env` frames.** A joiner has no ctrl lane until it is admitted (the plan's rule), so the admission answer and the host-signed members list it needs travel the auth lane for the last hop. That is also how a neighbour finishes a `via-peer` admission (and the neighbour relays the joiner's request in its own `room.join-via`, deviation 16). The auth-frame limit is 16 KiB instead of 4 KiB, because of the members list; Hello itself stays at most 4 KiB.
4. **`room.rekey` is sticky**, so members that were briefly disconnected still move to the new topic.
5. **Kick bans are persisted with the host's record** (the plan says "for the rest of the session"). Otherwise a host restart would let a kicked member back in. There is no unban API yet: rotating the invite is the way to start over.
6. **Extra `room.json` fields:** `previousSecret`, and on the host `members` and `banned`, so a restarted host keeps its room.
7. **Viewers use `maxPeers = 2 × (12 + 4)`**, because a `joinPeer()` target makes Hyperswarm count each connection twice. The host keeps `cap + 4`.
8. **Additions:**
   - Seats held by a member that has been silent for 60 s are freed when the cap blocks a newcomer.
   - Mesh repair calls `discovery.refresh()` with backoff while an admitted member has no link.
   - Pending requests are withdrawn when the joiner's link closes (Cancel), and expire when they are not re-sent.
9. **Connect errors.** Hyperswarm does not surface client connection errors, so `Room` wraps `swarm.dht.connect` to record them. They appear as `MemberView.lastError`, `RoomState.hostError` and the `connect-error` event, which is what makes the error → hint table reachable from the UI.
10. **The relay library lives in `packages/relay/src/`**, which `tsconfig.node.json` already includes, so its `.d.ts` is type-checked and linted.
11. **Auth timeouts are not banned** (the plan bans every auth failure for 10 min). A timeout proves nothing about the key: hyperdht can leave a dial half-open. The dialer's connection opens, but the other side aborted it while its LAN shortcut raced the holepunch round, so nothing ever arrives. A process that has just started hits this when it dials a peer on the same LAN, e.g. a restarted host dialing its viewers. Banning that locked the viewer out for 10 min, and a joiner whose own dial was half-open banned the host and failed the join with "The invite is out of date or wrong". A timeout therefore neither bans nor sets the joiner's `error` phase, and a link whose remote has not even opened its auth lane after 4 s (`authOpenTimeoutMs`) gives up early, so the next dial comes sooner.
12. **A linked member dialing us again replaces its stale link.** A dial from a key we hold a link to means the remote lost that link: it restarted or its address changed. Hyperswarm swaps a completed new connection in by itself, but it does nothing about a half-open one. Our own dial back waits until the old link closes, which UDX notices only after ~15 s. So, when the swarm firewall sees such a dial (`onDial`):
    - An admitted link must answer a ping within 2 s (`staleLinkMs`), or it is dropped. A viewer that drops its host link this way dials the host back at once.
    - A link that has heard nothing from its remote for 1 s is our own half-open dial, and it is dropped. Kept, it would win Hyperswarm's tie-break against the remote's new connection.
    - A live link survives the check. That covers simultaneous dials, and an old handshake replayed at us.
    - A crashed and restarted host or viewer is linked again ~2 s after it comes up (`restart.test.ts`), instead of after ~13 s, or never with the auth ban.
13. **A member that rejoins under a new name** (renamed in Settings) gets a new record in the host's book, never an in-place edit, and the members list is published again before the host answers. A member is renamed at most once per `rejoinMs`: each rename is a members broadcast and a `room.json` write, so a member alternating names could otherwise make the host rewrite both for every request. A newer name waits, and the tick applies the latest one once its time has come.
14. **The host's heartbeat is every 1 s** (`hostHeartbeatMs`; other members keep 5 s). Viewers take any host message (`room`, `sync`, `session`, or a sync datagram) as its last word, and sync pauses 10 s after that word. Past the viewer clock's first 20 s of 1 s pings, `room.hb` every 5 s left the last word up to ~5 s old, so a crashed host paused its viewers 5.8-9.8 s after the crash. With 1 s it is at most ~1 s old, and the pause lands 9-10 s after the crash wherever it happens (`host-crash.test.ts`). The cost is measured in a 1 + 5 room at default timings: bus frames per link go from 2.0/s to 3.3/s (540 → 900 B/s per link), because a publish costs (n − 1)² frames in a full mesh with ttl 2.
15. **Floods and the auth lane** (none of this is in the plan). Anyone with the invite can open a link and write on its auth lane, and every member forwards what it accepts. So:
    - only host-signed envelopes are handed over to joiners or taken from the auth lane, and those taken are never forwarded (see Wire);
    - `join` frames must be the sender's own, join requests never travel the bus (16), and they are rate-limited per joiner key wherever they are taken, and per relaying member (see Bus);
    - a pending joiner that asks again under the same name, through the same member, changes nothing the host shows: no `state` event. Its answer goes back the way the request came, on the host's own link to the joiner or to the member that relayed it (which hands it over), not as a broadcast every member forwards (to every member only when the host holds no link to that member, as when the request came two members on). A joiner that comes back while its request still waits (Cancel and join again, or a restart, within 2.5 × `rejoinMs`) learns it is pending either way, through a neighbour too;
    - renames are rate-limited (13) and `room.json` writes coalesced (Invariants).
    - Measured in a 3-member room (`abuse.test.ts`): 500 join frames from a non-member to one member gave 1516 join-request copies sent over ctrl lanes, 1649 answer copies and 500 host `state` events before round 4. Now 1000 such frames (half of them padded to 8 KB) give 0 join-request copies, 2 relayed requests, 2 answers (one per relayed request, to the member that relayed it) and 0 `state` events. A member alternating its name in 300 requests: 299 `room.json` writes and 299 members broadcasts before, 1 and 1 after.
16. **Join attempts, and relayed requests** (round 5; in the plan a neighbour puts the joiner's `room.join-req` on the bus as it is).
    - **Answers belong to an attempt.** A join attempt (one `Room`, from join until it closes) has a random `nonce` and a start time `at` (the joiner's clock), and its requests carry both. The host keeps the latest attempt's nonce with the pending entry and echoes it in every `room.admission` answer, and a joiner acts on an answer only when it carries its current nonce. So a `denied` a member saw once, replayed to the joiner after a restart (its dedupe is empty then), is ignored. Within an attempt, answers only move the join forward: once it is denied, an earlier `pending` (one its relayer held back and hands over late, or one that came the slower way) is ignored too, so the joiner does not ask again. `kicked` is the exception: it is taken whatever its nonce. The host names the attempt it last heard of, which is none 2.5 × `rejoinMs` after the key's last request (a member asks only when its host link comes up), and within that time, for a member that restarted and whose new request has not reached the host yet, its previous attempt: ignored, that kick left the member joining with no link for good, since every member bans the key. A kick bans the key for good, so a replay can only tell a banned key that it is banned.
    - **The room's state, too.** A joiner takes `room.state` and `room.members` from the auth lane only once the host has answered `admitted` to its current attempt. Otherwise a member could hand a joiner that was once in an old list that still names it: it would think it is in, with nobody to talk to, and ignore the host's answers as members do.
    - **Requests are taken in order.** The host takes a request only when it is newer than the last one it took from that key: a later attempt (by `at`), or a later re-send of the same attempt (by its envelope counter). An old request that someone replays neither moves the host back to an attempt the joiner has left (its answers would go unheard) nor spends the joiner's allowance. The order is kept for 2.5 × `rejoinMs` after the key's last request, so a joiner whose clock went back between two attempts is held up no longer than that.
    - **A relayed request names its relayer.** A member that gets a joiner's `join` frame relays the request inside its own signed `room.join-via`. The host takes a joiner's request from the bus only in that form, and an unwrapped one only on the joiner's own link (a member's too: it asks only when its host link comes up). `room.join-via` is limited per relaying member (6, then 1 per `rejoinMs / 6`). Each pending entry shows the member that relayed it (`RoomState.pending[].via`, its name), and kicking that member drops the requests it relayed. A relayer that leaves does not drop them: its joiners ask again through others, or their requests expire.
    - **Open mode needs nothing more.** It trusts every invite holder, and anyone with the invite can already join under as many keys as it likes (one link each), up to the cap. Keys a member makes up never link and are never heard from, so the cap frees their seats for the next newcomer at once (as it frees the seat of a member silent for 60 s), and they come no faster than its relaying rate. The host logs the member that relayed each admission (`admitted <key> (relayed by <member>)`): without a pending list, that is where it sees who vouched for a key.
    - Measured (`abuse.test.ts`): 40 made-up requests that a member relays as fast as it can give 6 pending entries, all shown as relayed by it, and none once it is kicked; in open mode, 6 admissions, each logged as relayed by it. Before, each request with a made-up key that a member sent over its ctrl lane was a pending entry (or an admission, up to the cap).
    - **Not covered:** a member can still vouch for keys it makes up, at its relaying rate; the host sees who did (in the pending list, or its log in open mode), and can kick it. A request replayed after the host has forgotten its key's order (2.5 × `rejoinMs` without a request from that key) or after a host restart is taken again: in approve mode it shows up as pending, relayed by whoever replayed it, and in open mode it admits that key until its seat is needed.

17. **S5 findings applied** (round 6; [ADR 0005](../../../docs/adr/0005-s5-nat-matrix.md), the NAT and relay matrix).
    - **A viewer dials the host once the DHT has bootstrapped** (Finding 6). `relayThrough` reads `dht.randomized`, which is false until bootstrap has sampled the NAT, so the dial the constructor used to make sent a RANDOM viewer's first attempt without the relay: joining a CONSISTENT or OPEN host it waited for a birthday punch (median ~4.5 s, up to 13-16 s) instead of linking relayed in ~0.5 s. The cost is the bootstrap time before the first dial (~130 ms on the S5 testnet). A room closing before then never dials.
    - **Hints follow what S5 measured** (Findings 1, 3, 8). A forwarded port does not change RANDOM, so a RANDOM NAT's hint recommends a relay only. A CONSISTENT NAT with `udpPort` set says the port does not answer from the internet yet (once the forward works it shows OPEN, with no hint), but only when the DHT bound that port: dht-rpc quietly binds another when it is busy (another program, or a room holding it while the Network test runs), and then the hint says the port was in use. A room's report uses the port its DHT was made with; a `udpPort` changed in Settings applies to the next room. `HOLEPUNCH_ABORTED`, which hyperdht 6.34.1 reports for every failed punch including two RANDOM NATs, says the attempt is retried and that only a relay helps two strict NATs; `NO_BOOTSTRAP` no longer promises 15 s (bootstrap gives up after ~6 s).
    - **`patches/hyperdht+6.34.1.patch`** (Finding 9, §7 (b)): on a server-side TRY_LATER (one random punch per node per 20 s), hyperdht dropped the round's address verification, so the delayed punch failed with `REMOTE_NOT_HOLEPUNCHABLE` and later viewers of a RANDOM host stayed relayed for the whole session. The patch keeps the verification; they are upgraded to direct ~35-45 s after joining instead (S5 m2). One copy of hyperdht is loaded (`npm ls hyperdht`: hyperswarm's is deduped).
    - **alwaysRelay holds** (Finding 5). hyperdht holepunches beside every relayed link and upgrades it whenever a punch succeeds, so the setting only guaranteed a relayed start. `createSwarm` now makes the DHT node itself, and `holdRelayed` wraps its `connect` and `createServer` while alwaysRelay is on and a relay key is set: hyperdht's `holepunch` callback refuses the punch on both sides; our dials skip the fast-open probe and the same-public-address LAN shortcut (`fastOpen: false`, `localConnection: false`), which connect without asking; and the server takes no part in punching (hyperdht's `_neverPunch`, read per handshake), so it sends no "fast mode" ping. That ping used to break alwaysRelay between two CONSISTENT NATs altogether: it linked the dialer directly while the server was already on the relay, and every attempt ended in `WTP_AUTH_TIMEOUT` (S5 row a6). The setting is read per connection and per punch, so switching it applies to new links and to links still being set up; a link already direct stays direct. Dials to the relay itself are left alone. Not held: a peer with an OPEN address (no NAT, or a working port forward), which hyperdht dials directly before it asks, and a peer on our LAN that has alwaysRelay off and dials us.
    - **The host's handling of a joiner's own request is guarded** like every other handler of remote input: a throwing `members` or `state` listener is logged as a fault instead of becoming an uncaught exception or being thrown into Protomux.

## Testing

```sh
scripts/isolated.sh npx vitest run --project unit src/core/net                  # codecs, bus, bans, membership, links, swarm options, diagnostics, room (stub DHT)
scripts/isolated.sh npx vitest run --project integration test/integration/net   # local hyperdht testnet, about 25 s in total
```

Integration tests use `test/integration/net/helpers.ts` (`Harness`: a testnet plus rooms with fast timings, all torn down). They cover:

- a 1 + 5 full mesh with the same members list everywhere;
- cap 4 → `full`;
- a wrong secret → `WTP_AUTH_FAILED` in < 10 s, plus a ban;
- a peer that never authenticates → `WTP_AUTH_TIMEOUT` and no ban, and its key joins later; a joiner whose host never answers keeps joining (no `error`, no ban) and gets in once the host is up;
- a member that comes back under a new name gets in, and everyone sees the new name, also through a neighbour;
- a joiner without a host link that comes back while its request still waits learns it is pending;
- a member is told it was kicked even when the host no longer knows its attempt, and when it restarted and is kicked, through a neighbour, before its new request reached the host;
- kick reaches everyone, and the kicked peer cannot reconnect;
- rotate moves everyone, and the old invite no longer joins;
- host restart → viewers back in < 30 s;
- a blocked host link → admitted via a neighbour, with sticky state; and two members on, when that neighbour has no host link either;
- approve mode and Cancel;
- a host `members` listener that throws while a direct joiner is admitted: logged as a fault, and the joiner gets in;
- bye and end;
- datagram demux, ctrl frames and RTT;
- blobs from any holder;
- the connect-error hint;
- the port-forward hint only for a `udpPort` the DHT bound (`diagnostics.test.ts`: a port held by another socket, and a Network test beside a room holding it, say it was in use).

`restart.test.ts` SIGKILLs a member running in its own process (`room-child.ts`, a bare `Room`) and starts it again from the same folder: a restarted host, and a restarted viewer, are linked again within 4 s and nobody is banned. These are real crashes (no bye; the dead process's link lingers), which `room.close()` in the test's own process cannot fake. `test/integration/session/host-crash.test.ts` does the same with a whole host session (`host-child.ts`): a host restarted from its folder (the viewer follows the restore), and hosts killed after 25 s of play just after and just before a heartbeat (the viewer pauses 8.5-16 s after the kill; measured 10.0 s and 9.2 s). Both child scripts close and exit when their parent dies without killing them (the IPC channel closes), and both test files check that with a stand-in parent (`orphanable()` in `helpers.ts`).

`abuse.test.ts` covers what an invite holder cannot make the room do: an oversized message for a joiner costs no member a link; only the host's messages travel the auth lane; a join-request flood costs a few relayed requests and answers and no host `state` event; a renaming member costs a write or two; `room.json` writes are coalesced; the host's heartbeat cadence. It also covers what a member cannot make the host do with join requests (made-up requests get through at its relaying rate, are shown as relayed by it, and go when it is kicked; in open mode the host log names it), and that answers belong to the attempt they answer: a replayed denial, an old members list replayed to a joiner, an earlier request of a joiner relayed again, and a `pending` its relayer held back until after the denial change nothing; answers still reach joiners straight or through a neighbour (pending, rejected, full).

`src/core/net/room.test.ts` runs a viewer `Room` on a stub DHT: it dials the host only after bootstrap, through the relay once its NAT shows RANDOM, and never once it is leaving. `swarm.test.ts` checks what hyperdht is given while alwaysRelay holds (the `holepunch` callback on dials and on the server, no fast open or LAN shortcut, a server that never punches), and that the hyperdht every module loads carries `patches/hyperdht+6.34.1.patch`.

`relay.test.ts` runs `relay-scenario.ts` inside `unshare -rn`: a private network namespace in which nft drops member-to-member UDP, so the local blind relay is the only path. It asserts path `relayed`, bus delivery and datagrams. It is skipped where unprivileged user namespaces or nft are unavailable.

Set `WT_TEST_LOG=1` to see room logs.

### Manual and S5 (not run by the suite)

```sh
# the S5 NAT and relay matrix (ADR 0005), no sudo: rootless namespaces, NAT routers, a 20-node testnet and a relay
scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out DIR [--label run1] [--rows a3,a5,m2]
# a member by hand, on a local testnet
node scripts/testnet.mjs --relay                 # prints "export WT_BOOTSTRAP=..." and a relay key
WT_BOOTSTRAP=... node --import tsx src/core/net/headless.ts host --name A
WT_BOOTSTRAP=... node --import tsx src/core/net/headless.ts join <invite> --name B [--relay KEY] [--port 49800]
WT_BOOTSTRAP=... node --import tsx src/core/net/headless.ts nat
```

The matrix's method, rows and results, and why a NAT testnet needs 20 nodes and link delay, are in [ADR 0005](../../../docs/adr/0005-s5-nat-matrix.md). `scripts/netns-nat.sh`'s header describes driving the namespaces by hand inside `scripts/netns-rootless.sh`.
