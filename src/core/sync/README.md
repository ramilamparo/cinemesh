# src/core/sync: sync engine (M6)

Pure TypeScript, plan §4.5. The module does no I/O, never calls `Date.now`, and starts no real timers. Every
side effect goes through the ports in `ports.ts`, so the same code runs against mpv, the room bus and the
transfer engine in production, and against the discrete-event simulator in `test/sync/sim`.

| File            | Role                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `ports.ts`      | `Clock`, `PlayerPort`, `BusPort`, `DatagramPort`, `MediaPort`, `TransferPort`, plus the `every()` helper |
| `protocol.ts`   | zod schemas for the `sync.*` bus messages, `parseBusMessage`, `isNewer`, and the datagram codecs         |
| `clock.ts`      | `OffsetEstimator` (NTP-style θ̂ and ε) and `ClockClient` (ping cadence, fallback to bus pings), `pong()`  |
| `drift.ts`      | `DriftController`: the plan's `step()`, sample gating, the median of 5, skip windows, `seekLat`          |
| `desync.ts`     | `DesyncMonitor`: when a viewer's "behind the host" warning shows and hides                               |
| `start-gate.ts` | Start modes: N s buffered, or play-through (the ETA rule)                                                |
| `group.ts`      | `GroupController`: the host's authoritative state machine                                                |
| `member.ts`     | `MemberController`: everyone's player follower, including the host's own (over loopback)                 |
| `engine.ts`     | `SyncEngine`: composes the above for a role and emits UI-facing events                                   |

## Facade for the lead: `SyncEngine`

```ts
const engine = new SyncEngine({
  role: 'host' | 'viewer',
  selfId, selfName, hostId,
  nudge: settings.speedNudge,          // the user's speed-nudge switch
  desyncWarnMs: settings.desyncWarnMs, // viewer: warn this many ms behind (0 = off); the host never warns itself
  ports: { clock, player, bus, datagram, media, transfer },
  host: { syncEpoch: randomU32(), perms, waitForAll, startMode, resume?: GroupSnapshot },  // host only
})
engine.start()
engine.mediaReady(durationS, { fullDownload })  // host: index ready → room leaves idle, paused at 0 or the restored anchor
engine.setSource(urlOrPath)            // host: local path; viewer: stream URL once it is ready
await engine.intent(playbackIntent)    // playback.intent and OSC input; toggle/seekRel become play/pause/seek here
engine.request(kind, posS?)            // viewer "Ask host"
engine.setPerms(perms) / setWaitForAll(on) / setStartMode(mode) / startAnyway()   // host only, no-ops on viewers
engine.setNudge(on)
engine.setDesyncWarn(ms)               // viewer: the warning's setting changed (no-op on the host)
engine.resync()                        // viewer: playback.resync, local only (no intent); 'not-ready' on the host
engine.roomPosition()                  // seconds; for the UI and the playhead (the anchor until θ̂ is known)
engine.seekBase()                      // where seekRel and the OSC's seek-rel count from: our newest unanswered seek, else roomPosition()
engine.syncEvent()                     // latest SyncEvent or null
engine.snapshot()                      // host: GroupSnapshot for session.json
engine.stop()                          // cancels every timer and subscription; unanswered intents resolve 'timeout'
```

`engine.group` (host only) and `engine.member` are public for diagnostics and tests.

### Playlists (ADR 0011 §4)

A playlist runs one engine per item, each with its own `syncEpoch`. Two options exist for that:

- **`acceptEpoch: () => number | null`** (viewer). The engine applies only states, bus and StateFast, of that epoch;
  null applies any. The session returns the current playlist item's epoch, or -1 once the host moved on. Without it,
  the next item's first datagram could seek the previous file before `session.playlist` arrives.
- **`clockEstimator`** (viewer). It hands `engine.clockEstimator()` to the next engine, whose `ClockClient` keeps that
  estimate instead of starting over (the host process is the same).

### Events (`SyncEngineEvents`)

| Event      | Payload                   | Notes                                                                                                                                                                                                                                                                                                                         |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sync`     | `SyncEvent` (core.ts)     | On every newly applied state, and (viewer) when `desync` changes: then only `sync`, no `state` or cause notice. `wait.softDeadline` is converted to _local_ monotonic ms. `cause.by` is a display name.                                                                                                                       |
| `playback` | `PlaybackEvent` (core.ts) | 4 Hz. `at` is local monotonic ms. With no file loaded (no source yet, a download that must complete first, mpv starting or loading) it shows the room: `roomPosition()`, paused unless the room plays, never seeking or stalled. An idle mpv's own pause flag is off, and the anchor would freeze.                            |
| `peers`    | `PeerSync[]`              | 1 Hz. The sync-owned fields of `PeerView`. The lead merges them with net (`path`, `rttMs`) and transfer (`downBps`, `havePct`, …) fields by `id`. On the host every field comes from `sync.status`; viewers know phases and exemptions, plus their own drift, warnings, rates and `behindS`.                                  |
| `notice`   | `NoticeEvent`             | Codes `sync.cause` (one code for all cause toasts, so the UI replaces the previous one; this is the "merged within 1 s"), `sync.exempt`, `sync.request` (host; action `playback.intent`), `sync.<rejection>` (with an **Ask host** action `sync.request` for permission rejections), `sync.host-gone`, `sync.host-back`.      |
| `persist`  | `GroupSnapshot`           | Host only. Write `syncEpoch`, `seq` and `lastAnchor` into session.json. It fires on every publish (a new `seq`: write it **at once**, or a resume can start below a seq viewers hold) and every 5 s while playing (same `seq`, a newer position: this one may be debounced 2 s). The session adds `RESUME_SEQ_GAP` on resume. |
| `state`    | `SyncState`               | Every newly applied state (for the OSC's `perms` and `ended` messages).                                                                                                                                                                                                                                                       |
| `clock`    | `ClockInfo`               | `{offsetMs, errorMs, poor (ε > 150 ms), via}` when θ̂ changes.                                                                                                                                                                                                                                                                 |

### Port adapters the lead writes

- **Clock:**
  - `now` = `performance.now()`, the clock the player stamps its IPC samples with;
  - `setTimer` = `setTimeout`;
  - `immediate` = `setImmediate`;
  - `loopLagMs` from a `perf_hooks.monitorEventLoopDelay` histogram (a recent max), minus the histogram's own
    10 ms timer interval, which it records as delay (ADR 0007 Finding 9): the gate's 20 ms means 20 ms of lag.
- **PlayerPort:**
  - `sample()` = one `get_property audio-pts` (falling back to `time-pos`), with `tSend` and `tRecv` from `Clock.now`;
  - `readTimePos()` = one `get_property time-pos`. Not the observed value: after a paused seek mpv notifies the
    landed frame only ~50 ms after the `playback-restart`;
  - commands go out at once and in the member's order (a seek after its `setPaused`), and never throw: a
    synchronous throw (`PlayerController.seek` without IPC) is caught like a rejection and logged;
  - `snapshot()` mirrors observed properties. `available` = mpv up with its IPC connected (`idle`, `loading`
    or `ready`); `loaded` = the player is `ready` (our load reached its restart). `spdif` =
    `audio-out-params/format` starts with `spdif`. `frameDrops` = `frame-drop-count + decoder-frame-drop-count`.
    `frameS` = 1 / `container-fps` (observed), at most 1 s, and 1/24 when the file has none or reports over 240:
    a seek or load lands up to a frame past its target, so a fixed 1/24 took a 12 fps file's landing for another
    client's load (an extra seek) and discarded a seek's landing read (a start up to a frame early);
  - `state` fires on any snapshot change;
  - `externalChange` comes from player enforcement.

  Sync calls `load`, `seek`, `setPaused` and `setSpeed` and expects nothing back except `playbackRestart`, or
  `loadFailed {superseded}` for a load that will never get one: another client's file or `stop` replaced it
  while it opened (`superseded`), mpv could not open it, or mpv went away. Only for the latest `load`: one that
  the member's own later load replaced is no news (reported, it would end that later load's wait). The player
  passes every mpv `playback-restart` on, another file's too, and reports `loaded` before the one that
  completes our load: a load is complete at the first restart that finds `snapshot().loaded`.

- **BusPort:**
  - `publish(msg, {to?})` maps to `room.publish(msg.t, msg, {to})`: each message goes under its own name. Stickiness
    comes from the name's policy (net's `NET_POLICIES` makes `sync.state` sticky and host-only), not from `sticky`.
    Net cannot address a sticky name, so an addressed `sync.state` (the answer to a `sync.hello`) goes to everyone;
  - per-origin rates for the names members send (`SYNC_BUS_POLICIES` in `sync-ports.ts`: `sync.hello`,
    `sync.request`, `sync.intent`, `sync.status`, `sync.ping`; `sync.pong` host-only) are defined on every member
    before sync starts, so a flood stops at the first bus that receives it;
  - `onMessage` delivers raw bodies from admitted peers (sync validates them);
  - `onPresence`: on the host, every other member that is linked or `via-peer` (the members list, re-read
    every 2 s); on a viewer, only the host: present while net's `hostPresent` holds and it was heard from within
    7 s (any of its bus messages, the host's `room.hb` every second, or a sync datagram), so a crash shows as
    silence. A host link opening is a `join` even while present (a quick restart); its `bye` or its link closing
    while in the room is a `leave` at once. A `leave` carries `sinceMs`, how long ago the host was last heard
    from: the 10 s grace below counts from that word, not from when the silence was noticed. See the session
    README.

  **Sticky replay must deliver the stored body unchanged** (sync measures how old it is from `sentAt`).

- **DatagramPort:**
  - `send` = `RoomPeer.sendDatagram`;
  - `onMessage` = `room.onDatagram(0x53, …)`;
  - `usable(peer)` is false for `via-peer` members; relayed links carry datagrams (net's relay test checks it).
- **MediaPort / TransferPort:**
  - `readiness`, `bufferedAheadS`, `playhead.set` and `needBps` come straight from media;
  - `onChange` fires on the transfer's `pieces-changed` (never on the host, whose pieces are all local);
  - `rateBps` is the 10 s EWMA;
  - `etaToEofS` is the time until everything from the playhead to EOF is local;
  - `coverage` is the 256-bit bitmap in base64;
  - `diskFull` comes from `diskLow`/ENOSPC parking;
  - `downLimitBps` (optional): a viewer's download limit setting in bytes/s, read at every status; the host's port
    has none.

### Wiring invariants

- The host's own player is a normal member. The group's `publish` loops back to it (deferred one `immediate`),
  and its own `sync.status` goes to the group the same way. Never call `MemberController` directly from the
  group.
- A member applies a state only if `(syncEpoch, seq)` is newer. A different epoch always wins (a new session or
  a full rejoin). The reliable copy of a state first seen as StateFast is applied again at the same seq, to fill
  in `wait`, `members` and `cause`.
- After a host restart: construct the host engine with `host.resume = <saved GroupSnapshot>` and call
  `mediaReady` once the media is re-indexed. The first publish carries the same `syncEpoch` and `seq + 1`, and the
  room comes back `paused` at `lastAnchor.posS`, with cause `restore` (no toast). The session passes the saved
  seq plus 1000, because session.json can lag the last publishes viewers already applied.
- A restarted host process has a new clock (`performance.now` starts over). A viewer that applies a state with
  a new `restore` cause, another epoch, or a `sentAt` below the previous state's restarts its clock client with
  the estimate reset; until the first new pong θ̂ is null, so a playing room is joined as a late joiner would.
  Without the reset the old estimate would stay in the 12-sample window, off by the old process's uptime.
- Viewers send `sync.hello {resume}` on start and whenever the host's presence returns. The host answers with the
  current state, at most once a second per member (one held back goes out at the end of that second, with the state
  of then): the answer is the sticky `sync.state`, which goes to everyone. Ask host (`sync.request`) toasts are
  coalesced the same way, one per member per 2 s, the latest shown. Viewers keep exchanging pieces with each other while the host is gone (that is net's and
  transfer's concern). Sync only pauses 10 s after the host's last word (`MemberController.hostLeft(sinceMs)`)
  with "Host disconnected — waiting", and never ends the room.
- The member is the only one to `loadfile`: the session's player does not reload by itself (`selfReload: false`).
  After an mpv crash, a Reopen, or another client's file or `stop`, the player goes `idle`, and the member's rule
  "available and not loaded" loads at its rendezvous. A `path` change reloads even while holding for an absent
  host.
- A load in flight blocks every other load (`loadPending`) until its `playbackRestart`: the first one that finds
  the player loaded. A restart with nothing loaded belongs to another file (another client's, or one our load
  replaces), and it can arrive after our next load went out: taken for ours, it would send a third load that
  replaces the second. `loadFailed` ends the wait too, so the rule above loads again instead of waiting for a
  restart that belongs to someone else's file (or never comes): at once after a replacement, or once mpv is back
  after it went away; after 1 s, 2 s, 4 s … (at most 30 s) while mpv keeps failing to open the file, so that is
  no loop. A load that reaches its restart, or a new source (`setSource`, also the same one for a new player),
  starts the pause over.
- Permission checks run twice: on the viewer for the instant toast, and on the host, which is authoritative.
- **A viewer's intents go out one at a time**, in order: the next when the last one's `sync.intentResult` (or its
  timeout) is back, and paced to at most 4 in a row and then one per 300 ms, inside the bus's per-origin rate for
  `sync.intent` (5, then one per 250 ms) with a token to spare for jitter. A seek waiting to go out is replaced by a
  newer one (a held arrow key repeats 40 times a second): the replaced one resolves `accepted` with no notice, as
  the newer seek carries it and reports any failure itself. Play and pause are never merged nor moved past a seek.
  Relative seeks (`seekRel`, and the OSC's `seek-rel` through the session's `resolveSeekRel`) count from
  `seekBase()`, the newest unanswered seek's target, so presses during a round trip add up. The 5 s timeout runs
  from the press. The host's own intents go straight to its group.

## Behaviour notes

- **Unpause scheduling:** target = `hostTime − θ̂ − unpauseLatency`. `setTimer(target − 15 ms)` wakes the member
  early, and it then spins on `Clock.immediate` until the deadline.

  `unpauseLatency` is learned (0–200 ms) from the first gated audio sample ≥ 300 ms after an exact start: the
  first probe replaces the 50 ms prior, later ones are an EWMA (α 0.3).

  **Start trim:** after every start, the drift loop's first decision corrects anything beyond `DRIFT.OFF` (15 ms),
  not only beyond `DRIFT.ON`. A start is off by the estimate's error (50 ms early on mpv's null AO until the first
  probe), which the dead band would keep for good, and a member the loop corrects later (after a stall) would then
  sit at the anchor apart from the rest (ADR 0008 §4.4). Trimmed, every member that can nudge plays at the anchor.

- **Where a paused member is:** members pause, and exact-seek only if they are a frame or more off.
  - After its own exact seek or load the member reads `time-pos` at the `playback-restart`: mpv lands on the first
    frame at or after target − 5 ms and playback starts there (ADR 0007 Finding 4), so that frame, not the target,
    is where the next start begins. A read within a frame plus those 5 ms of the target is that landing (the frame
    is the file's, `frameS`); from an exact position that close, a seek would land no closer, so none is sent.
  - After a pause from playback, when it does not seek, it reads the exact audio position (time-pos is
    frame-quantised). It keeps the reply even if mpv's `pause` change comes later: mpv answers in order, and the
    read went out after the pause (ADR 0008 §4.2).
  - A state for the position it already holds exactly is not read again: after a pause from playback, a paused
    seek or load leaves audio-pts early by the AO's old delay until the next unpause (push AOs: null, ALSA,
    PulseAudio; ADR 0007 Finding 5).
- **seekLat** (the skip target's lead): every exact seek whose data was local times it at its `playback-restart`
  (settle, rendezvous and corrective seeks as well as skips). The first replaces the 150 ms prior, later ones are an
  EWMA (α 0.3), 25–3000 ms. Seeks that wait for data are not timed.
- **Seek barrier:** `playhead.set(target, 'seek')` is called before `seek`. A member reports `ready` with
  `barrierId = seq` only after `playback-restart` and once `readiness(target, 'seek')` passes. The group ignores
  readiness that is older than the last anchor move (`posSeq`).
- **Catch-up:**
  - **Skip:** used if the target `expected(now + seekLat)` has ≥ 2 s buffered and the player is running.
  - **Rendezvous** otherwise: target `T = expected(now + est)`, prefetch from T, seek there paused, then a
    scheduled unpause. `est` is a seek plus 300 ms when 2 s are buffered there, else `estReady`, which starts at
    6 s and is learned as 1.5 × the observed time to readiness.
  - Late joiners load straight at their rendezvous target, with the same estimate (so on the host, whose data is
    all local, an mpv that restarted is back in step about a second after it is up).
  - **A load another load replaced:** a player that reloads the last file itself (`selfReload`, not the
    sessions' setting) does so after an mpv restart, a Reopen or an external path change, right after the
    member's own load, and the later loadfile wins. When the load's `playback-restart` finds `time-pos` more than
    a frame from the load target, the member settles where mpv really is and meets a playing room by catching up
    (a rendezvous, since mpv is paused) even when only a little behind: unpausing from a frame-quantised position
    would leave the start to the drift loop.
- **A late start without nudging:** a state that arrives late is normally unpaused into, and the drift loop
  absorbs the lateness (up to 1 s). A member that cannot nudge (spdif, or nudging off) would keep it: its drift
  loop only skips once 300 ms behind. Such a member meets the room by catching up when a start is over 100 ms
  late, once per state (seeks slower than it expects could otherwise keep it from ever starting).
- **Buffering:** `paused-for-cache`, or `time-pos` stalled for 750 ms with `core-idle`. The host opens a
  `waiting {reason: buffering}` barrier after a 1 s grace period, when `waitForAll` is on and the member is not
  exempt.
- **Who a barrier waits for:** present, recently heard from (10 s), not exempt, and not `no-player` or
  `disk-full`. Members still `joining` or `loading` are waited for only at the room's first play (`start`); later
  barriers leave them to rendezvous. A file that plays only once completely downloaded is the exception (the
  host passes its `needsFullDownload` to `mediaReady`): there `joining` can mean a whole download, as a viewer
  holds its stream back until then, so the first play does not wait for them either, and they meet the room as
  late joiners. The play-through start mode still waits, as everyone watching from the start is what it asks
  for, and its ETA rule then wants an ETA of 0 (not 0.9 × what is left), so `wait.etaS` is the member's ETA to
  the end of the file. The first play's barrier has no deadline (the host's Start anyway ends it); seek and
  buffering barriers have a soft one at 8 s and a hard one at 30 s.
- **Behind the host** (viewer, `desyncWarnMs`, default 1 s; `desync.ts`): the member measures its lag behind the
  room at every tick (its own position: the extrapolated sample while playing, mpv's time-pos while buffering).
  The warning shows once the lag less ε has stayed at the threshold for 2 s, and hides after 1 s under half of it
  (keeping the number it showed meanwhile, never "0 s behind"). A changed setting starts it afresh; the same value
  again (every settings change sends them all) changes nothing.
  It applies only while the room plays and the member plays in it or catches up: never while paused, waiting,
  loading, settled, out of disk, before θ̂, or while the host is gone (grace and hold); a newly applied state or a
  move behind our back clears it at once, a θ̂ jump restarts its timers. A catch-up (start, late join, the drift
  loop's skip) shows nothing of its own: 2 s is longer than every automatic fix, so the default never fires in
  normal play. After a warning, or after Resync, a catch-up shows `catching-up` (no number), which ends at once
  when the member lands in sync, and turns into `behind` only after another 2 s behind. A viewer ahead is not
  warned: its pause-wait has no cooldown and fixes it within about 1.5 s. While `behind`, `sync.status.behindS`
  carries the number to the host's row.
- **Resync to live** (`MemberController.resync`, viewer only): meets the room on this machine, never as an intent,
  so it needs no permission and the room, its state and the other members do not move. Behind: skip when the data
  at the room's position is here and the player runs, else rendezvous (which also moves the download there).
  Ahead: wait paused. `in-sync` within 300 ms (a stall's first moments included), `busy` during a catch-up or 2 s
  after the last Resync, `not-playing` (room not playing, host gone), `not-ready` (no file, loading, landing, no
  θ̂). A Resync during the host's 1 s buffering grace leaves the position the member waits at, so the room stops
  waiting for it; it never opens a barrier (only `buffering` does).
- **The room's position before the clock:** a viewer places a playing room on the host clock, so before its first
  θ̂ (joining, or a restarted host) `roomPosition()` is the anchor; its own clock alone would put it anywhere.

## Deviations from the plan

1. **StateFast carries `sentAt`** (8 more bytes), so a member can measure state lag from whichever copy arrives
   first.
2. **The first ping burst:** 5 pings at 100 ms, then every 1 s for 20 s (counted from the end of the burst), then
   every 5 s. A ping counts as lost after 2 s with no answer.
3. **θ̂ agreement:** "3 samples agree" means that the last 3 θ values lie within max(10 ms, Δδ/2 + 5 ms) of the
   lowest-δ sample's θ. Jumps of ≥ 15 ms (and the first estimate) open the 3 s drift skip window.
4. **Long pause-waits:** a member far _ahead_ of the room (for example, held at an old position while the host
   seeked back, or the drift loop's `pause-wait` for a large D) waits paused only while that is quicker than a
   rendezvous: max(5 s, estReady + 300 ms). Beyond that it rendezvouses. Otherwise a member held at minute 24
   while the room restarted at minute 13 would sit paused for 11 minutes. Fuzzing found this case.
5. **Stale state:**
   - Cause toasts older than 3 s are applied silently, so sticky replays after a reconnect or a late join do not
     toast something that happened earlier.
   - State-lag samples above 5 s are treated as replays and kept out of `lagP95`, so they do not inflate the lead
     time L.
6. **Metadata republishes** (member phases, `waitingFor`, exemptions) are coalesced to at most 1 per second.
   They bump `seq` like any publish, but members do not re-actuate when the anchor and mode are unchanged.
7. **The third flap-guard wait** exempts the member instead of opening another wait. When it happens at a soft
   timeout, the barrier completes with its original cause, not `timeout`.
8. **Extra message fields:** `sync.status.etaS`, `wait.resumeAs`, `wait.etaS` and `cause.at` were added.
   - `etaS` feeds the play-through gate and the "everyone ready in ~12 min" line.
   - `resumeAs` makes "a pause during a barrier" visible to everyone.
   - `cause.at` keeps two identical causes (Sam buffers twice) distinct.
9. **Late starts without nudging** (see Catch-up): over 100 ms late, a member that cannot nudge catches up
   instead of unpausing, once per state. The plan's "the drift loop absorbs it" assumes nudging.
10. **Full-download files** (see Who a barrier waits for): the plan's first play waits for everyone who is
    loading; for a file that plays only once complete, that would be whole downloads, so only play-through
    still waits for them.
11. **The start trim** (see Unpause scheduling): the plan's dead band (ON 60 ms) holds except for the first decision
    after a start, which corrects from OFF (15 ms) up.
12. **Warnings** (`sync.status.warnings`):
    - The codes are a closed v1 set, `slow-download` and `frame-drops`. An older host fails a whole status with a
      code it does not know, and that member then goes silent to it, so members never send another: a new
      condition is worked out on the host. Receivers drop codes they do not know and keep the status.
    - `slow-download` clears only after the rate has stayed at 1.1 × need for 10 s (`SLOW_CLEAR_MS`); the plan
      clears it at once, which made a rate near the threshold flicker on and off.
    - Frame drops are counted only while playing outside the drift loop's holds, and the count starts afresh after
      a seek, a start or a catch-up: those drop frames on their own.
13. **Behind the host** (see Behaviour notes): `sync.status.behindS` is an optional field, not a warning code
    (item 12), so an older host strips it and an older viewer omits it; no new message and no version change.
    Resync never reaches the bus.
14. **The member's download limit:** `sync.status.downLimitBps` (optional, sent only while a limit is set) tells the
    host the viewer's own limit, which its slow-download line names (session README "Peer-list warnings"). The
    warning itself does not change: a limited member below 1.1 × need still warns, because the room will buffer.

## Tests

```sh
npx vitest run --project unit src/core/sync test/sync     # ~2 s, all in virtual time
WT_FUZZ_SEEDS=500 npx vitest run --project unit test/sync/fuzz.test.ts   # longer fuzz hunt (~30 s)
```

**Unit tests** sit next to the sources: protocol codecs and validation, the clock estimator and cadence, drift
`step()`, the start gate, `GroupController`, and the `SyncEngine` facade.

**Simulator** (`test/sync/sim`):

- **Event loop:** seeded (mulberry32). Each node's clock has an offset (±1 h) and a skew (±100 ppm), and timers
  fire up to 1.5 ms late.
- **`FakeMpv`:**
  - latencies for seek, unpause, restart and load;
  - time-pos quantisation to the file's frames (24 fps by default), IPC RTT, and audio-clock skew;
  - seeks and loads that land on the first frame at or after target − 5 ms (`landing`), and, after a pause from
    playback, audio-pts 170 ms early while paused after a seek or load (`stalePausedMs`), as mpv 0.41 does
    (ADR 0007 Findings 4 and 5); both on by default;
  - spdif;
  - `paused-for-cache` at the end of the downloaded data (with `cache-pause-wait` = 1 s);
  - external pause;
  - load failures: another client's file or `stop` while a load opens (the load fails as superseded;
    `foreignFile`, `foreignStop`), with that file's own playback-restart some ms later if asked
    (`restartAfterMs`: it can reach the member after its next load went out), and a file mpv cannot open
    (`unopenable`); the player's own reload after a restart or a path change (`respawn(at)`,
    `externalPathChange`) replaces the member's load silently, a player that does not say so.
- **`FakeMedia`:** downloaded spans that grow from the last `playhead.set` at `rateX`, and a reported download
  limit (`downLimitBps`).
- **`Network`:**
  - per-direction latency, jitter and loss (lost reliable messages pay a retransmission delay);
  - in-order reliable delivery, with a head-of-line backlog and partitions;
  - optional per-origin rates by message name (`rates`, a token bucket like the bus's; drops in `rateDropped`);
  - datagram loss;
  - sticky replay on connect, and presence: a link opening is a join; viewers watch the host by silence, as the
    session's adapter does (a 5 s heartbeat on the reliable stream, a leave after 7 s without any delivery,
    checked every 2 s, with `sinceMs`), so a killed host, a partition or a blocked link all show as silence;
    other pairs report a leave 1 s after a disconnect. Every node beats every 5 s, net's rate for members; the
    real host beats every second, which only makes its last word fresher (scenario 7 is measured from it).

**The §9 scenarios:**

| #   | Scenario                                                                              | Test                 |
| --- | ------------------------------------------------------------------------------------- | -------------------- |
| 1   | p95 and p99 drift with 4 viewers, WAN links and 1 % loss                              | `drift.test.ts`      |
| 2   | Start alignment (also after a paused seek, in the flows that re-send its position)    | `drift.test.ts`      |
| 3   | 4 MB HOL backlog, ≥ 99 % on time over 200 seeds                                       | `start.test.ts`      |
| 4   | Slow viewer: soft timeout, then exemption, both with and without waitForAll           | `start.test.ts`      |
| 5   | Concurrent seeks → `superseded`                                                       | `control.test.ts`    |
| 6   | 20 s partition (disconnected, and blocked) reconverges in ≤ 3 s                       | `resilience.test.ts` |
| 7   | Host gone → paused 10 s after its last word, room kept                                | `resilience.test.ts` |
| 8   | spdif: no `setSpeed`                                                                  | `drift.test.ts`      |
| 9   | 2 h with 100 ppm skew                                                                 | `drift.test.ts`      |
| 10  | Fuzzing: (epoch, seq) is monotonic, speed changes sign < 6×/min, everyone reconverges | `fuzz.test.ts`       |

`resilience.test.ts` also covers a host process that restarts under kept viewers (a new clock, the resumed
room followed); a viewer's mpv that restarts or loads another file while the room plays, both with a player that
reloads itself (its reload wins the race; the member meets the room within 3 s) and with the sessions' player
(one load, just ahead of the room, met within 3 s; also the host's own mpv); another client's file while
holding for an absent host (reloaded at once); another client's file while our load opens (that load fails as
superseded, ours is loaded again at once, met within 1 s, with no help from the other file, and still loaded
only once more when that file's playback-restart comes 30 or 150 ms later, after our next load went out);
another client's `stop`, while our load opens (the same) and while the room plays (one load, met within 3 s);
and a file mpv cannot open (tried again after 1, 2, 4, 8 s, then met once it opens; a load that worked starts
the pause over).
Scenario 7 checks the pause lands 10 s after each viewer last heard from the host. `drift.test.ts` covers a
spdif member whose play arrives late (met, not kept) and seeks slower than expected (it still starts).
`start.test.ts` covers a full-download room: the first play starts without a viewer that has no stream yet, which
meets the room once it gets one (a streamable file still waits). `src/core/sync/engine.test.ts` checks each
host-restart signal that resets the clock estimate, that the host-gone pause counts from the host's last word,
and the playback event with nothing loaded (a playing and a paused room, and before θ̂).
`src/core/sync/group.test.ts` and `start-gate.test.ts` check who the first play waits for in a full-download
room, in both start modes. `src/core/session/sync-ports.test.ts` checks the adapter's `loadFailed` with the
member: a superseded load is loaded again at once, a failed one after a pause that a stop cancels, and another
file's restart while that next load opens does not complete it. With the installed mpv, the session's
`player-foreign.test.ts` has another IPC client stop mpv or load its own file while the member's load opens.

`test/sync/member.test.ts` drives one member against a scripted mpv: where a paused member is (the landed frame
after a seek or load, also for a 12 fps file whose landing is up to 78 ms past the target: no extra seek, the start
on that frame; and with a container-fps a little above the real rate; the audio read after a pause kept when mpv
reports the pause late, no re-read of a stale audio-pts), `seekLat` from every exact seek, and the start trim and
first probe; the desync warning (shown 3 s into a stall, cleared by a new state, a new setting or a landed
catch-up, restarted by a θ̂ jump, off at 0) and every Resync outcome. `src/core/sync/desync.test.ts` checks the
monitor's timing rules, and `test/sync/desync.test.ts` the room: no warning in 10 min of WAN play with downloads,
seeks and pauses, nor for spdif, the host or while the host is gone; a stalled viewer the room plays on without
(or is exempt) is warned and the host sees it; Resync moves nobody else and never makes the room wait.
`sync-ports.test.ts` checks `frameS` from `container-fps` and a 12 fps load through the adapter. `engine.test.ts` checks that a
member flooding hellos and Ask host gets one answer per second and one toast per 2 s, and that a desync change is
one `sync` event and nothing else, with `behindS` on the viewer's own row only (the host's from `sync.status`);
`sync-ports.test.ts` checks
the bus rates (a burst through, then nothing, also past a member that forwards). With the installed mpv,
`test/integration/player/sync-reads.test.ts` checks the two reads on the production path: the sample right after a
pause is the paused position, and the time-pos read at a paused seek's restart is the landed frame.

`control.test.ts` and `start.test.ts` also cover:

- a slow viewer in the host's rows, and its download limit named in the host's warning (none without one);

- permissions and Ask host;
- dedupe;
- toggle/seekRel;
- a held arrow key (33 presses in a second, as `seekRel` and as the OSC's absolute seeks, at 1, 40 and 150 ms one
  way, with the bus's `sync.intent` rate applied by the simulated network): at most 8 intents reach the host, none
  dropped or timed out, and the room lands at 33 × 5 s from where it was; queued seeks and a pause keep their order;
  unanswered intents (queued ones too) time out 5 s after the press;
- resumeAs paused;
- enforcement;
- a late-joiner rendezvous;
- no-player exclusion;
- the hard timeout and Start anyway;
- the start gate.

## Not covered here

- **Host-uplink-saturated warning:** ADR 0006 replaced the plan's "suggest an upload limit at 85 % of the peak":
  the host's upload pacer (`src/core/transfer/upload-pacer.ts`) keeps the uplink's queue near 20 ms by itself, and
  the feasibility line (below) warns when even the paced rate stays below what the viewers need
  (`uploadCapacityBps` in `host-session.ts`).
- **Feasibility line** ("Group needs ~X from you"): the host session computes it from the media index's average
  bitrate and the viewers present (`host-session.ts`), not from sync.
- **Real-mpv acceptance:** "p95 drift < 100 ms over 10 min with real mpv" is for M8 with real adapters.
