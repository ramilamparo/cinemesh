# ADR 0011: Playlists

- Date: 2026-10-25
- Status: **accepted; in.** A host shares several videos as a playlist. The room plays one at a time and moves to the
  next one when the host asks, or by itself a few seconds after an item ends. Each member keeps its audio and
  subtitle choice across items when the next file has a matching track. Viewers download upcoming items in playlist
  order, and the host serves them only with upload the item playing leaves. Two settings turn background
  downloading and uploading off.
- Plan: §4.1 (bus names), §4.2 (one torrent per session, host upload), §4.4 (player loads, tracks), §4.5 (sync
  epoch), §4.6 (settings), §5.1 (RPC), §5.3 (OSC); ADR 0006 (upload pacing).
- Code:
  - `src/core/session/{host-session,host-slot,viewer-session,viewer-slot,playlist-wire,playlist-files,announce,media-checks}.ts`;
  - `src/core/player/track-carry.ts`;
  - `src/core/transfer/uplink.ts`, `upload-scheduler.ts`, `engine.ts`;
  - `src/core/sync/{engine,clock}.ts`;
  - `src/renderer/src/screens/Room/PlaylistPanel.tsx`.
- Tests:
  - `test/integration/session/playlist.test.ts`: host and viewers on a testnet with fake players;
  - `test/integration/player/track-carry.test.ts`: real mpv;
  - unit tests next to each module.

## 1. Context

Friends watching a series want one room for a whole season. Until now a room was bound to one video:

- the host prepared one torrent and published one sticky `session.announce`;
- a viewer took only the first announce, and told the user to leave and join again on any other;
- sync messages named no media, only a `syncEpoch`;
- `PlayerController.load()` of another file forgot the chosen audio and subtitle tracks.

Nothing about a room's identity (keys, invite, members) depends on its video, so the room can outlive one.

## 2. One torrent per item

**Decision.** Each item is prepared on its own, exactly as a single hosted video was:

- the media index and piece hashes are cached per file in `host-cache/`;
- each item has its own manifest and torrent, served as blobs.

**Consequences:**

- Adding an item never changes another item's infoHash.
- Two items made of the same files would have the same infoHash. Their bt lanes (one Protomux channel per infoHash)
  would collide, so they are refused:
  - by path at `playlist.add` ('duplicate');
  - by infoHash once prepared: the second item becomes an error.
- The first item, or the one a resume left off at, is prepared in front of HostPrepare and opens the room. The rest
  are prepared in the background, in playlist order, one at a time with one hash worker, because the same disk
  serves the item playing.
- An item can be played once it is prepared.

**Viewers.** A viewer keeps one `ViewerSlot` per item it downloads, each in `<saveDir>/.wt-partial/<infoHash>/`:

- JoinConfirm runs for the first item only.
- Later items download into the folder confirmed then, after a space check of their own.
- An item that does not fit is not started. Its member reports `disk-full`, which barriers already skip, and the
  user gets a notice.

## 3. Wire

### `session.playlist`

Host-only and sticky. It is in `NET_POLICIES`, so every member enforces it even when no module loads it.

```
{ v: 1, rev: u32,
  current: { id, syncEpoch } | null,
  autoAdvance: boolean,
  advance?: { nextId, inMs },
  items: [{ id: 12 hex, name ≤ 255, fileSize, durationMs | null, prepared,
            infoHash?, torrent?: {hash, size}, manifest?: {hash, size} }] ≤ 100 }
```

Rules the schema checks:

- A prepared item names its torrent, manifest and duration.
- `current` is a prepared item.
- Ids and infoHashes do not repeat.

Size:

- At most 100 items.
- The body stays under 48 KiB, inside one 64 KiB bus frame with its signature: 100 items with ordinary names take
  about 36 KB.
- `playlist.add` checks the size the list would have once every item is prepared, with the longest values, so a later
  publish cannot fail.

Publishing:

- `rev` is persisted, and a resumed host continues 1000 above it.
- The host publishes the playlist before the announce and before the new engine's first state.

### Changes to existing messages

| Message               | Change                                                                                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.announce`    | Still published, for the current item. It is all an older viewer reads. A new viewer follows the playlist once it has seen one, and ignores the announce from then on. |
| `transfer.links`      | Optional `infoHash` (stripped by older hosts). The host routes each report to that item's transfer. A report without it is about the current item.                     |
| `session.unavailable` | Optional `infoHash`. A viewer ignores it when it names another item.                                                                                                   |

Older peers:

- An older viewer plays the current item. On a switch it shows the existing "leave and join again" notice and applies
  the new epoch's states to its old file.
- An older host never sends a playlist, so a new viewer behaves as before.

## 4. Sync: one engine and one epoch per item

**Decision.** Switching items stops the sync engine and starts a new one with a new random `syncEpoch`:

- The engine's ports are fixed when it is built (`MediaPortAdapter` holds one map).
- A new group gives each episode its own start gate, so the first play waits for everyone under the start mode, and
  its own duration.
- The epoch is the only media id that already travels in both bus states and StateFast datagrams.

The host carries over permissions, Wait for everyone and the start mode from the old engine's snapshot. A switch the
host asks for (Next, Play) or an auto-advance plays the new item once the host's own member holds its first state;
an intent sent before that is refused as not-ready.

**`SyncEngineOptions.acceptEpoch`** (viewers). The engine applies only states, bus or datagram, whose epoch is the
current playlist item's:

- An engine whose item is no longer current applies none. Without this, the next item's first StateFast can arrive
  before `session.playlist` does and seek the previous file.
- States dropped this way are not lost: the next engine's hello gets the sticky state again.
- With no playlist, it applies everything.

**`SyncEngineOptions.clockEstimator`.** The viewer hands its `OffsetEstimator` to the next engine. The host process
is the same, so its clock estimate still holds and playback does not wait for a fresh one: `ClockClient` takes an
estimator and restarts without resetting it.

**Fixes this needed:**

- `PlayerPortAdapter.dispose()`: the old adapter's listeners on the player holder would otherwise keep firing into a
  stopped engine.
- `BaseSession` starts its 1 Hz peers timer once, not once per engine.
- `FakePlayer` takes its duration per load, so fake-player rooms can reach an item's end.

## 5. Auto-advance

When the room reaches an item's end (`sync.mode` 'ended'), the host counts down `ADVANCE_MS` (5 s) to the next
playable item:

- the countdown is published in `advance`, shown on the room's ended card and toasted in the player;
- Play now or Next starts it at once;
- Cancel stops it until the room next reaches an end;
- a seek or play that moves the room off the end also cancels it.

If the next item is still being prepared, the countdown starts once it is ready. Auto-advance is on by default:
`hostDefaults.autoAdvance`, persisted per room and changed with `playlist.setAutoAdvance`.

Only the host edits the playlist (add, remove, move, play, next, prev), through the RPC methods or with `>` and `<` in
the player. The item playing cannot be removed.

## 6. Background transfer

### Host: one uplink, two tiers (`HostUplink`)

Each item's torrent keeps its own `UploadScheduler`, but all of them release from one token bucket at one paced rate
(`uplink.ts`):

- **Why one pacer.** Two pacers would read the same queueing delay (the same UDX streams to the same viewers) and each
  grant its own rate. That is twice what the uplink carries without queueing, and ADR 0006's 20 ms target would be
  gone.
- **What it adds up.**
  - `sentBytes` is the sum over every member scheduler, and keeps the share of members that left.
  - `streams()` lists each viewer's connection once.
  - The upload limit applies to the sum.
- **Tiers.** Tier 0 is the item playing; tier 1 is any item viewers fetch ahead. A tier-1 scheduler releases nothing
  while a tier-0 scheduler holds a request it could release now (a wire under its queue cap).
- **Why the ADR 0006 guarantees hold.**
  - The total stays under the paced rate.
  - The item playing always goes first.
  - A tier-1 lane to a viewer reads the same connection-level UDX `unsent` as the tier-0 lane to that viewer. So what
    tier 1 commits ahead of a later tier-0 request is at most max(32 KiB, 100 ms of that connection's drain), the
    same bound class 2 already has against class 0.
- **No starved wires.** A tier-1 wire whose held requests got nothing for 10 s (`BACKGROUND_MAX_HOLD_MS`) has them
  refused (BEP 6, fast wires only), well before the viewer's 30 s request timeout would drop the wire.
- **When items seed.**
  - The item that was playing stays on tier 1 when **Share other playlist videos** is on.
  - Any other item starts seeding on tier 1 when a viewer's `transfer.links` report names it.
  - Either stops after 60 s without a report, or at once when the setting goes off.

### Viewers: strict playlist order

With **Download upcoming playlist videos** on, a viewer downloads ahead only once the item playing is complete. It
takes the next item after it that is not complete, one at a time, from position 0. An item not prepared yet, or one
that does not fit in the save folder, stops the walk there.

**Switching to a prefetched item.** The item downloaded ahead becomes the item playing with what it has (no second
download). The test checks the next item's first transfer event shows it complete.

**Sharing.**

- With **Share other playlist videos** off, an item fetched ahead links only to the host. No other member is linked,
  so none asks this viewer for it. Items played earlier then close.
- With it on, the last two items played stay open for others still fetching them.
- Each WebTorrent client throttles only itself, so once a second the item playing gets the whole upload limit and the
  other open items share what it leaves (at least 16 KiB/s each).

A viewer downloads one item at a time, so each engine keeps its own `DownloadGate` (ADR 0010).

## 7. Track carry-over (`track-carry.ts`)

**Capture.** At a switch each member captures what mpv plays (`captureChoice`): the title, language, codec, forced
and external flags of the audio and subtitle tracks, or "subtitles off".

**Matching** (`planCarry`), per type, against the next item's manifest:

1. The same title, trimmed and case-insensitive. Ties go to the same language, then the same position.
2. Else the same language and forced flag. 2- and 3-letter ISO 639 codes are equal; a region must match when both
   have one.
3. Else nothing, and mpv's `--alang`/`--slang` defaults pick. The carried language still rides as `alang`.

Subtitles off stays off. External subtitles are titled by file name, which changes per episode, so they match by
language and forced flag (`subtitleFlags` reads both from `Ep01.en.forced.srt`).

**Applying** (`LoadOptions.carry`). For a file other than the loaded one, the plan rides in the loadfile's per-file
options (`aid=`, `alang=`, `sid=`), like a same-file reload's, so nothing switches tracks after the file opened. A
switch then could stall a viewer behind a blocked read (ADR 0004). mpv numbers each type's tracks from 1 in container
order, which is the manifest's order, so the id is the match's position + 1. A matched external subtitle is added
with `sub-add … select`.

**Check.** At file-loaded the controller compares the selected tracks' titles and languages with the match. If they
differ, it picks the matched track by title and language in mpv's own list. The real-mpv test shows the mapping held
on MKV files whose track orders differ between episodes. The check covers containers it was not tried on.

Track choice stays local, as before: each member carries its own.

## 8. Persistence

`session.json` keeps its `v: 1` and gains optional fields:

- `playlist`: entries `{id, name, fileSize, videoPath?, subtitlePaths?, infoHash?, transferDir?, progress?}`;
- `currentItemId`, `playlistRev` and `autoAdvance`.

The single fields (`videoPath`, `infoHash`, `transferDir`, `group`…) mirror the current item, so Recent rooms and
export finishing work as before.

**Host resume.** It rebuilds the playlist from the file, prepares the current item first (from the cache) and
restores its group snapshot. The test checks the same items, the same current item and a higher `rev`.

**Viewer resume** follows the host's current item.

**Sweep.** It treats every item folder a room lists as the room's:

- they live as long as the room is used;
- a kept room protects them all;
- for the cap, a room's earlier items go before the one it plays. That one takes the room record with it, as before.

**`transfer.deleteData`** removes every item folder of the room.

**Leaving.** The item playing gets the leave asked for. Other open items are exported when complete and kept
otherwise ('save'), or treated alike ('keep', 'delete'). 'delete' also removes the folders of items closed earlier.

## 9. Compatibility

| Host \ viewer           | older viewer                                                                    | this viewer                                 |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------- |
| **older host**          | unchanged                                                                       | no playlist: follows the announce as before |
| **this host, one item** | unchanged                                                                       | follows the playlist (one item)             |
| **this host, a switch** | "leave and join again" notice; its member follows the new epoch on the old file | follows the switch                          |

## 10. Follow-ups

- Older viewers are not yet left out of a new item's barriers. A `sync.status` capability flag would let the group
  skip them.
- The host keeps every prepared item's manifest and torrent in a `MemoryBlobProvider` (typically 0.1-0.5 MB per item,
  up to 68 MiB for one). A provider that rebuilds them from `host-cache/` would bound that.
- An alpha-harness run over real links measuring switch time and ctrl latency under background load. The integration
  tests run on loopback.
- Viewers cannot edit the playlist, even with **Let others play, pause and seek** on.
