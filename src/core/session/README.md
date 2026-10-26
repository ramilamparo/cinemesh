# src/core/session: the session orchestrator

This layer ties net, transfer, media, player and sync into one host or viewer session. It also implements
the renderer contract (`src/shared/ipc/core.ts`). `src/core/index.ts` creates one `SessionManager` on init and
forwards main's control messages (`settings`, `theme`, `mpv`, `shutdown`) to it. It loads `manager.ts` with a
dynamic import once init arrives, after `env-first.ts` (a bundle hoists static package imports above any code,
and WebTorrent's `ws` must see that environment), and attaches renderer ports only after every request handler
is registered, so a request sent at once (a cold start from an invite link) finds its handler.

| File                     | What                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `manager.ts`             | `SessionManager`: at most one session. Every renderer request is zod-validated here, then delegated              |
| `base-session.ts`        | Shared by both roles: room events, player (through `PlayerHolder`), sync engine, peer views, OSC state, teardown |
| `host-session.ts`        | Room + invite at once → index → hash → manifest/blobs → announce → seed → player/sync; the playlist (below)      |
| `host-slot.ts`           | One playlist item on the host: its prepare (index, hashes, manifest, blobs) and its seeding                      |
| `viewer-session.ts`      | Join → announce → blobs → JoinConfirm → download/stream server → player/sync. Resume reuses the journal          |
| `viewer-slot.ts`         | One playlist item on a viewer: torrent and manifest, its download, its stream server                             |
| `playlist-wire.ts`       | `session.playlist`'s schema and size guard (ADR 0011 §3)                                                         |
| `playlist-files.ts`      | Sibling subtitles of a video, and a subtitle file name's language and forced flag                                |
| `announce.ts`            | `session.announce`'s schema; `media-checks.ts`: `crossCheck`, `criticalSpans`, `cachedManifest`                  |
| `sync-ports.ts`          | Adapters to sync's ports: Clock (`performance.now`), Player, Bus (and host presence), Datagram, Media, Transfer  |
| `striping.ts`            | Bus message `transfer.links`: viewers report their bt lanes and blocked pieces, the host feeds its transfer      |
| `hash-fails.ts`          | Host: viewers' hash failures (reported with `transfer.links`) → one notice and peer-list warnings                |
| `timeline.ts`            | Piece states → seconds for the renderer `timeline` and the OSC `ranges`; 256-bucket coverage                     |
| `peer-view.ts`           | Merges net, sync and transfer rows into `PeerView`, the warnings as entries with their numbers                   |
| `peer-warning-toasts.ts` | Host: an OSC toast when a viewer's download turns too slow (120 s cooldown)                                      |
| `player-holder.ts`       | A swappable player: an mpv fixed mid-session replaces the controller without rewiring sync                       |
| `player-like.ts`         | The player surface sessions use; `PlayerController` and `FakePlayer` both implement it                           |
| `fake-player.ts`         | `WT_FAKE_PLAYER=1`: a clock-driven player for e2e tests and headless peers                                       |
| `session-file.ts`        | `<userData>/wt/rooms/<id>/session.json`, written atomically: at once when asked (see Resume), else 2 s debounced |
| `sweep.ts`               | Startup sweep of kept partial downloads: unused for 7 days, then least recently used over the cache cap          |
| `common.ts`              | Session bus names (`session.announce`, …), the net log adapter, subtitle languages, playhead reason names        |

### Startup

The manager's startup sweep runs before any session: `session.recent` and every session start (host, join,
resume) wait for it, at most `SWEEP_WAIT_MS` (10 s; `deps.sweepWaitMs` in tests), since a sweep stuck on a dead
mount must not block every room (a start then stops it deleting). `session.resume` claims its room from the
sweep (`SweepKeep`: the room open when core died, plus any the user resumes while it runs; `claim()` is refused
once that folder is being deleted), then reads its record once the sweep settled. The `session.resume-failed`
notice after a crash restart goes through `RpcServer.noticeUntilSeen`, and so do the notices of the cut-off saves
below.

### Saves a quit cut off

A viewer's `save` journals its export (`export.json` in the transfer folder; transfer README, "Export order"), so a
quit, a crash, a power loss or a missing drive cannot lose it. At startup the manager finds every viewer room whose
`session.json` names a transfer folder holding one, registers all those folders as exporting before the first one
runs, and finishes them one after another without the network (`started` waits for them; sessions do not):
`transfer.export-resumed`, then `transfer.export-finished` (with `path`: the UI offers Show in folder) or
`transfer.export-failed` (given up: the room is resumable again, its `session.json` progress lowered). One whose
destination folder is not there (a drive unplugged, a share not mounted) is not started: `transfer.export-waiting`
(`Saving <name> is waiting for <dest>: connect it, then choose Finish saving.`) carries the action
`transfer.finishExport {roomId}`. A quit stops a running one at its next step, and the next start goes on with it.

Until the save is finished or cancelled, its room belongs to it:

- `session.recent` lists the room with `export: {name, dest, waiting}` (`waiting`: that folder is not there now), and
  Home offers Finish saving and Cancel saving instead of Resume.
- `transfer.finishExport {roomId}` runs it now: `finished` (with `path`), `waiting` (its folder is still not there;
  nothing changed) or `rejoin` (given up, with a `transfer.export-failed` notice saying why). `{giveUp: true}` drops
  it instead (`dropExport`: what it had consumed counts as missing again, its `.part` is deleted when reachable) and
  answers `rejoin`, or `finished` when the video turns out saved in full. `not-found` when the room has none; `busy`
  while that folder's export runs (the startup's, another call's, or the `save` leave that made it).
- `session.join` (checked on the invite's room id, before anything starts), `session.resume` and
  `transfer.deleteData` refuse the room with `busy`: a new download of it would point its `session.json`, the one
  way to that save, at another folder.
- No session downloads into a folder holding `export.json`, whatever its room (the same video saved into the same
  folder): `ViewerSession.confirmJoin` answers `busy` there, and `startDownload` refuses it for every way in, a
  resume included. The sweep never deletes nor counts such a folder.
- A finished save removes the room records, and a give-up lowers their progress, only for rooms whose `session.json`
  still names that folder, and never for the room in use.

There is no separate index of pending saves: the room's `session.json` points at each one, and the rules above keep
anything from moving or removing that pointer while a save is pending. An index would be a second record to keep in
step with `export.json` across crashes.

Tested in `export-resume.test.ts` and `export-finish.test.ts` (a real save cut by a quit, 1 MiB segments), and step by
step in `transfer/save-file.test.ts`.

## Flows

### Host

1. `HostSession.start`: `stat` of the video (`file-missing` if it is gone), `Room.create` (the invite exists at
   once), then `session.json` is written and flushed. Only then does `start` return, so the manager's active-room
   marker can never point at a room without a `session.json` (a crash in between could not resume it).
2. `buildMediaIndex` (stage `indexing`). The session event gains `media`: `container`, `seekMode`,
   `fullDownload` and `interleave`. `fullDownload` (open-critical is the whole file: an fMP4 without sidx, or
   with one per fragment) also sends the warning notice `media.full-download`: viewers can start only once they
   have the whole file, and `FASTSTART_REMUX` fixes that. `interleave` is the index's verdict (`poor`: audio
   stored far from its video, so streaming needs more data before it can start or seek).
3. `prepareHost` (stage `hashing`).
4. `buildManifest` + `encodeManifest`. A manifest over `MAX_MANIFEST_BYTES` (what viewers accept) fails hosting with
   `manifest-too-large`, instead of an announce nobody could join. The torrent and manifest are served by `Blobs`
   (MemoryBlobProvider).
5. `TransferEngine.startHost`, then striping (below) before any peer is attached, then every admitted peer.
6. `session.announce` is published (sticky).
7. Player and `SyncEngine(host)`: `mediaReady(duration, {fullDownload})` (then the room's first play does not
   wait for viewers still downloading such a file, except in the play-through start mode, which waits for their
   whole download unless the host starts anyway; sync README), then `setSource(videoPath)`.

While preparing, `session.preparing {stage, pct}` goes out at most once a second.

### Viewer

1. `Room.join`; phases `connecting` / `pending-admission`.
2. Sticky `session.announce`. One that fails `AnnounceSchema` fails the join instead of leaving it on
   Connecting…: `update-required` when it comes from a newer host (`v > 1`), else `bad-session` naming the
   field. A later readable announce then only posts `session.changed`.
3. `Blobs.fetch` of the torrent and manifest. Both are verified (`crossCheck`) and then re-served. The session
   event gains `media: {container, seekMode, fullDownload, interleave}` from the manifest. A resume knows its
   folder, so it first looks for the manifest kept there (`cachedManifest`, below) and fetches it only when that
   copy is missing or no longer the announced one.
4. `confirm-join` with `joinInfo {name, size, dir, freeBytes, haveBytes}`.
5. `session.confirmJoin(dir)` checks space, and refuses (`busy`) a folder where a cut-off save of this video is
   still pending (Saves a quit cut off, above).
6. `joinAsViewer` into `<dir>/.wt-partial/<infoHash>`, with critical ranges set (open-critical, seek-critical
   and the subtitle files). The engine writes `meta.torrent` and the manifest (`manifest.bin`, plan §4.2 "Viewer
   storage") there at every join, inside the start, so a `delete` leave (which waits for the start) never races
   them. `save`, `delete` and the sweep handle the folder as a whole, so the manifest goes with it.
7. `StreamServer.listen` and the `Playhead`; `reportTransferLinks` starts (striping, below) and runs until a
   leave or the room closing.
8. Player and `SyncEngine(viewer)`: `setSource(streamUrl)`. A 1 Hz playhead `tick` runs while playing. When
   `needsFullDownload(manifest)`, FFmpeg would read the file to its end at open, so mpv would sit in that read
   for the whole download (and each reload for a blocked reader would start it over): the stream goes to sync
   only after transfer `done`. Until then mpv is empty, the member has no source and reports `joining` (the
   room's plays do not wait for it, the first one included, except in the play-through start mode, which waits
   for the whole download; sync README), the `session.full-download` notice says why, and
   the OSC shows the same text as a toast on `oscReady` (it drops toasts until it is up), also after an mpv
   restart or a Reopen. `done` releases the stream (`transfer.done`: "…it plays now") and the member meets the
   room as a late joiner does; once the room is over nothing is released.

### Playlists (ADR 0011)

The room plays a playlist, one item at a time; a single hosted video is a playlist of one.

- **Host** (`HostSession` + `HostSlot`). `session.host {more}` and `playlist.add` append items, each with the
  subtitle files next to it that share its name (`siblingSubtitles`). The item opening the room is prepared as
  above. The rest are prepared in the background, in order, one hash worker, and the same files twice are refused.
- **A switch** (`activate`):
  1. the new item seeds first (tier 0 of the shared `HostUplink`);
  2. the old item's engine stops;
  3. `session.playlist` goes out naming the new epoch, then `session.announce`;
  4. a new `SyncEngine` loads the item with the carried tracks (`planCarry`) and, for Next / Play / auto-advance,
     plays it once the host's own member holds its first state.

  The old item stays seeding on tier 1 while viewers fetch it (Settings: Share other playlist videos), and any other
  item starts there when a viewer's `transfer.links` names it. Both stop after 60 s without a report.

- **Auto-advance.** `sync.mode` 'ended' starts a 5 s countdown (`advance` in the playlist, the ended card, an OSC
  toast) to the next playable item. Cancel holds it until the room next ends; a seek or play off the end drops it.
- **Viewer** (`ViewerSession` + `ViewerSlot`). It follows `session.playlist`'s current item (or, from an older host,
  the announce).
  - The first item goes through JoinConfirm; later ones download into the confirmed folder after a space check (no
    space: the member reports disk-full).
  - Each item gets a new engine that applies only its epoch (`acceptEpoch`) and takes over the clock estimate.
  - With Download upcoming playlist videos on, once the item playing is complete the next incomplete items download
    ahead, strictly in order. An item downloaded ahead plays without downloading again.
  - Items played earlier stay open to share (the last two) or close; the upload limit is shared across them once a
    second.
- **Persistence.** `session.json`'s `playlist` lists every item, with its `transferDir` on viewers, and
  `currentItemId`, `playlistRev` and `autoAdvance`. The single fields mirror the current item. The sweep, Delete
  and a leave go through every item's folder.

### Resume

`session.resume(roomId)` takes the `RoomStore` record plus `session.json`.

- **Host:** the hash cache makes re-preparing take seconds. Sync resumes with the same epoch, at the saved seq
  plus `RESUME_SEQ_GAP` (1000), so its restore state outranks anything viewers kept: the file can miss the last
  publishes (a crash between a publish and its write). The room comes back paused at the saved position.
  `session.json` is written before `HostSession.start` returns (a crash while hashing a big file stays resumable)
  and at every publish (every new seq); only the 5 s position updates while playing keep the 2 s debounce. Until
  preparing finishes it holds `infoHash: null` and `durationS: null` (nothing that reads host records uses them).
- **Viewer:** joins the saved folder without asking, and the journal resumes the download. The manifest comes from
  `<saveDir>/.wt-partial/<announced infoHash>/manifest.bin` when it is a regular file of the announced size and
  BLAKE2b hash (what `Blobs.fetch` would check), else by `blob.get` as on a join. The torrent is still fetched.

### Crash restart

`<userData>/wt/active.json` (`{roomId}`) marks the room in use: written when a session starts (for a host, after
its `session.json` is on disk), cleared by a leave (at its start, so a crash during the leave does not bring the
room back), by the host ending the room and by a clean quit. If core dies, main restarts it once with `init.resumeActive`; the new `SessionManager`
finds the marker and resumes that room as `session.resume` would (a failure is a `session.resume-failed`
notice). Without `resumeActive` (a whole-app crash or kill) the marker is only cleared: Recent rooms offers the
resume. The startup sweep never touches the marked room's download.

### Leaving

`leave()` is memoized per session: the first call's options win and every caller gets the same promise. The
manager keeps what each session's leave was asked for (`keep`/`end` on the host, `keep`/`save`/`delete` on a
viewer): a second request asking for the same thing waits for the first, a different one is refused with
`busy` (it would silently get the first one's outcome); `transfer.saveFile` is refused while any leave runs. A
leave resolves even when a teardown step fails, so the manager never keeps a dead session as the current one.
The one exception is a viewer `save` leave that finds segments missing (transfer's `IncompleteDownloadError`):
it rejects with `incomplete` after the full teardown, and keeps the room record and `session.json`, so a rejoin
downloads what is missing.

`session.leave` and `transfer.saveFile` go out once as phase `leaving` (the manager's) when the first of them
starts; an identical second request shares it, and `session.cancelPrepare` stays quiet (HostPrepare stays up).
That event carries `leave`: what the running leave does (`keep`, `save` for a `save` leave or
`transfer.saveFile`, `delete`, or `end` for a host ending the room), so a renderer reloaded mid-leave can still
say "Saving the video…" and main's quit prompt can word a running save. `idle` always follows, whether the
leave worked or not, posted before a failed response.

Every finished save, however it ran (`session.leave {data: 'save'}`, `transfer.saveFile`, the startup run or
`transfer.finishExport`), posts `transfer.export-finished` with its `path` through `noticeUntilSeen`, once per save
(a `transfer.saveFile` and a `session.leave` sharing one are one): a window reloaded meanwhile never gets the
request's answer, so the UI shows where the video went from this notice. A `save` whose export stopped part-way
answers `save-failed`, pointing at Finish saving in Recent rooms (or at the folder to connect); the save stays
pending.

A quit (`shutdown`) leaves without ending the room, and waits for the running leave at most 3 s
(`deps.shutdownWaitMs`; main kills core 5 s after asking): a save goes on at the next start from its export journal,
a failing leave is logged, and the active-room marker is cleared either way.

## Wiring rules

- The bus adapter drops our own messages (`via === null`): the sync group loops back to the host's member itself.
- Presence (`BusPortAdapter.onPresence`):
  - **Viewers track only the host.** It is present while `RoomState.hostPresent` holds (a host link, or host
    traffic within net's 10 s, so a via-peer host stays present) and it was heard from within `HOST_SILENT_MS`
    (7 s): any bus message from it (`room`, `sync`, `session`; the host's `room.hb` comes every second), direct
    or forwarded, or a sync datagram. Silence is how a crash, a sleeping laptop or a lost network shows: nothing
    closes the link, and UDX gives up on it only ~15 s later. It is checked every 2 s, so it is noticed 7–9 s
    after the last word.
  - Every `leave` carries `sinceMs`, how long ago the host was last heard from. Sync's 10 s grace counts from that
    word (`MemberController.hostLeft(sinceMs)` holds after `10 s − sinceMs`), so the pause lands 10 s after the
    host's last traffic: 9–10 s after a crash, as its heartbeats are a second apart.
  - Sharper signals: a host link opening is a `join` even while the host still counted as present (a quick
    restart: sync says hello again and restarts its clock pings). The host's `bye` with `end: false` (its last
    word, `sinceMs` 0) and the host link's `peer-gone` while the room is `in-room` are a `leave` at once. Both last
    until a new host link or host traffic forwarded by a neighbour; frames still arriving over the old link do not
    count. A `peer-gone` during our own leave, a kick or an ended room is ignored (net sets the phase first), and
    so is `bye` with `end: true` (the session closes the room). After silence alone, any word brings it back.
  - **The host tracks everyone else** from the members list: linked or `via-peer` members are present. It is
    re-read every 2 s, because a via-peer entry going stale emits no event.
- Datagrams are used on every linked peer, relayed links included (net's relay test checks that they pass).
- `PlayerPortAdapter` forwards OSC intents to sync. The session never calls `engine.intent()` for them;
  `playback.intent` (renderer) does.
- Power is kept awake while hosting, preparing or downloading. Core sends `power` only on change.
- `mpvChanged()` (the mpv path was fixed mid-session) replaces a `missing`/`tooOld` player through the holder,
  never once a leave has started: nothing would quit an mpv started then.
- The player never reloads by itself (`selfReload: false`). After an mpv crash or a Reopen it comes back `idle`;
  another client's file or `stop` makes it give ours up and go `idle` (a load in flight rejects as superseded).
  Then sync's member, the one owner of `loadfile`, loads at its own rendezvous, at once: two owners raced, and
  mpv ended up where the later loadfile put it. Another file's playback-restart, which the player passes on,
  never completes the member's load (sync README). `hooks.readerBlocked` asks the session
  (`readerBlocked()`, overridden by the viewer: its stream server waits on a piece of the video), so the player
  reloads instead of seeking into a blocked read. `hooks.restartPosition` returns null once sync stopped (the
  controller then keeps its own last position). `SessionDeps.mpvExtraArgs` reaches mpv's arguments (session tests
  run a real mpv with `--vo=null --ao=null`, plus `--input-ipc-server` where another client acts on it).

## Striping (`striping.ts`, plan §4.2, ADR 0003)

- **Host:** right after `startHost`, before any peer is attached (with no group playhead the first viewer would be
  shown everything): `setGroupCriticalRanges` and `setGroupPlayhead` for the room's position (0, or the restored
  anchor). From then on the group plan is a media `Playhead` whose sink is `setGroupPlayhead`. It moves with the
  host member's own playhead calls (its seeks, loads and catch-ups) and a 1 Hz tick: `tick` while the room plays
  (L1 slides), and `seek` whenever the room is more than 2 s from the plan, playing or not. That is a room that
  moved without the host member: its mpv closed, missing or restarting does not seek, and a `tick` to a far
  position would keep the hot window where it was. `collectTransferLinks` takes the viewers' reports, and calls
  `removeViewer` on `peer-gone` (the session detaches the lane as before).
- **Critical ranges** (`groupCriticalRanges`, as `criticalSpans`): shown to every viewer at once, outside the
  plan's order. The open-critical ranges, the seek-critical ones and the subtitle files:
  - **Seek-critical** is the MKV Cues (empty for every other container). mpv reads them at its first seek, and a
    session's every load is one: it loads at `start=<room position>`, 0:00 included (measured with mpv 0.41:
    `start=0` reads the Cues piece right after the head, a plain open does not). Left to the plan's walk, the
    Cues piece (usually the last one) came only through the viewer's urgent report once its open blocked on
    it: a round trip, then a queue behind the throttle (~10 s at 200 KB/s). The cost: Cues are about 21 bytes
    per keyframe, ~50 KB for a 2 h film with a keyframe every 3 s (measured: 49.5 KB for 2400), ~150 KB with
    one every second. That is one piece (two when it straddles a boundary; pieces are 1 MiB up to 16 GiB), so
    every viewer fetches 1–2 MiB more at once instead of a striped share: (viewers − 1) × 1–2 MiB more host
    upload, once, against a first load or seek that waits for no report.
  - **A file that plays only once complete** (`needsFullDownload`) is open-critical from end to end. Shown to
    everyone it would leave the host once per viewer (dupFactor 2.9 with three viewers), so only its subtitle
    files are critical and the plan's walk (L1, L2, L3: the whole file) stripes it like any other.
- **Viewers** (`reportTransferLinks`, started by the viewer session): every second, and on the transfer's
  `blocked-changed` (at most every 200 ms, the last change of a burst always sent), the bus message
  `transfer.links` `{v: 1, linked, urgent}` addressed to the host: `linkedPeers()` and `blockedPieces()`, at most
  `MAX_REPORTED_URGENT` of them: the transfer's `MAX_URGENT` (16), all the host takes from one report.
- **Validation on the host:** zod (`linked` ≤ 32 member keys, `urgent` ≤ 16 non-negative integers), only from
  admitted members, `linked` kept to admitted members other than the sender, `urgent` to pieces of the torrent,
  duplicates dropped, and each sender rate-limited (a burst of 10, 10 a second). Each report replaces the last.

### Catch-up priority (`catch-up.ts`, ADR 0012)

The host's peers tick (1 Hz) runs `pickCatchUp` over its sync peers (itself left out), for the playing item only. A
viewer starts catching up under 15 s of buffer, or while buffering, when another has at least 10 s more. It stops at
30 s, or once nobody is more than 5 s ahead. At most a third of the viewers are picked at once (at least one), the
least buffered first, and those already picked keep their place. Left out:

- `joining` members, whose position is 0 until the room's state reaches them;
- `no-player`, `disk-full` and `ended` members;
- members with their own download limit under 1.5 × their bitrate;
- members whose buffer already reaches the end.

Each picked viewer's range, its position to 30 s on (`catchUpRange`: from the first byte its player reads there),
goes to `TransferEngine.setViewerCatchUp` every tick, and `null` when it stops. Another item playing ends it on the
old item's transfer. The transfer marks its peer row `catchUp`, which the peer list shows as "Catching up".
`catchUpEnabled = false` turns it off (the integration test's baseline).

### Hash failures

Plan §4.2 "Source-change watchdog". The watchdog compares size and mtime, so a file rewritten in place with both kept,
or a disk returning other bytes, gets past it, and the host goes on serving pieces that fail their hash at every
viewer (WebTorrent refetches such a piece at once, from the same host).

- **Viewers** count them per piece and in total (`TransferEngine.hashFailures()`, transfer README) and, once they
  have any, add `hashFails: {total, worst}` to their `transfer.links` report (`worst`: at most 8 `[piece, failures]`,
  most first). It is optional within `v: 1`: an older host's schema strips it.
- **The host** (`HashFailWatch`, fed by `collectTransferLinks`; `worst` kept to pieces of the torrent, a report that
  fails the schema dropped whole) warns once one viewer reports the same piece failing `SAME_PIECE_FAILS` (3) times,
  or `VIEWERS_WITH_FAILS` (2) viewers report failures at all. One failure at one viewer can be a fluke and says
  nothing. The warning is the notice `transfer.hash-fails` (once per session; it names a changed file or a failing
  disk and asks to host the video again), and from then on a peer-list entry `{code: 'hash-fails', total}` (first
  on the row; text in `shared/peer-warnings.ts`) for every viewer still reporting failures. A viewer that leaves
  stops counting.
- A member can claim failures it never had. That costs nothing but a false warning on the host's screen; the counts
  never change what is served.

### Peer-list warnings

`PeerView.warnings` is a list of `PeerWarning` entries (`src/shared/peer-warnings.ts`), not text. `mergePeerViews`
builds them: a member's sync codes with their numbers (`slow-download` gets the rates and, while the member plays,
when its buffer runs out: buffered / (1 − rate/need), under an hour), then the session's own entries (hash
failures). A member's own desync warning (`PeerSync.behindS`, from its `sync.status.behindS`) becomes `behind`.
`slow-download` also gets the member's own download limit (`PeerSync.downLimitBps`, from `sync.status.downLimitBps`),
which the text names while it is below 1.1 × need.
One entry per code, in the order hash-fails, behind, slow-download, frame-drops. The renderer and the OSC take the
words from `peerWarningText`.

- A viewer's own row shows its own codes and rates, from its member's last `sync.status`. Other rows on a viewer
  have none: it hears no one else's status.
- **The host's OSC** (`PeerWarningToasts`, run in `emitPeers`): a toast "Sam: download too slow (…)" when
  `slow-download` appears on another member's row. At most one a tick (the rest are dropped, not queued), and a
  warning that comes back within 120 s of its toast stays quiet. Hash failures toast through their notice; the
  host can do nothing about the others.

### Behind the host (viewer)

`desyncWarnMs` (Settings, live through `updateSettings`) goes to the viewer's sync engine; the host never warns
itself. `syncOscState` shows the warning in mpv's status line ("3 s behind the host · Shift+R to resync", warn
level, or "Resyncing with the host…") after any wait text, and sends `resync {shown}` for the bar's button. The
OSC's `resync` intent (Shift+R, the button) and the request `playback.resync` (the manager refuses it for the host
with `not-viewer`) both call `resync()`, local only; from the OSC, `in-sync`, `not-playing` and `not-ready` become
toasts. `FakePlayer.stall(on)` is a test hook: paused-for-cache where it is until `stall(false)` or a seek.

### Transfer limits

`uploadLimitKBps` (both roles) and `downloadLimitKBps` (viewers; ADR 0010) are KiB/s, null = none
(`src/shared/limits.ts` `limitBps`). `updateSettings` applies both live: `applyUploadLimit` is the role's own,
and `applyDownloadLimit` is a no-op but on the viewer, which calls `TransferEngine.setDownloadLimit`. The viewer
also passes the limit to `joinAsViewer` and sets it again after the start, as for the upload limit, so a change
while the start runs is not lost. Its `TransferPortAdapter` reads the setting for every `sync.status`
(`downLimitBps`), so the host's warning follows a change within a second.

## Tests

```sh
npx vitest run --project unit src/core/session                  # adapters, presence, striping, player options
npx vitest run --project integration test/integration/session   # host + viewers on a local testnet
```

- `session.test.ts`: the whole pipeline with fake players: room → prepare (index + hash) → announce → blobs →
  JoinConfirm → download → stream server → sync.
- `host-lifecycle.test.ts`: leaving and cancelling (also while seeding starts), power, the feasibility line,
  live upload limits, `session.json` before the active-room marker, from the start and at every publish (a
  crash while preparing resumes), the media info (with `interleave`) and the full-download notice.
- `host-manifest.test.ts`: a manifest over `MAX_MANIFEST_BYTES` fails hosting (the encoder is padded).
- `host-sync.test.ts`: host gone with a bye (paused ~10 s after it) and without (10 s after its last word, also
  when a frozen host's link closes seconds later), and a resume from a session.json that missed its last
  publishes. A real SIGKILLed host is net's `host-crash.test.ts`.
- `striping.test.ts`: three viewers share an upload-limited host (dupFactor ≤ 1.5, every viewer completes, the
  host learns every lane), also for an fMP4 without sidx (full download: about 1.2 against 2.9 when shown to
  everyone); the plan is set before the first attach and follows seeks and the 1 Hz tick, also with the host's
  own player closed (a paused seek, and jumps while playing, are `seek`s); a read far outside the plan is served
  at once through its urgent report (~10 s against ~70 s); and with the installed mpv, the Cues reach every
  viewer before the walk's middle pieces even when the host drops every urgent report for them, so mpv's first
  seek (its load at `start=0`) does not wait for one.
- `viewer-full-download.test.ts`: an fMP4 without sidx. The viewer is told at JoinConfirm, mpv gets no stream
  until the download is complete, the room's plays (the first one too) do not wait for it, its transport shows
  the room meanwhile, and it then meets the playing room; a room ended mid-download stops it where the room was.
- `viewer-join.test.ts`: the join path against a bare host: leaving or the room closing at each step,
  admission while the host prepares, JoinConfirm's `haveBytes`, a second Join click, an unreadable announce,
  the host's file-gone notice, the blocked-reader hook, the striping reports, and the upload and download limits
  changed while the download starts (and the download limit again in the room).
- `download-limit.test.ts`: three viewers of an upload-limited host, one with a download limit: its request gate
  takes the setting, it receives no more than the gate allows over 8 s, the host sees the limit in its status,
  lifting it live opens the gate and drops it from the status, and every viewer completes with dupFactor ≤ 1.5.
- `viewer-data.test.ts`: a viewer's data on disk against a real host: `haveBytes` with an external subtitle,
  segment writes that fail, a second leave while a `save` runs, a save that finds a segment gone, and the kept
  manifest (resumes read it instead of fetching it, a copy that no longer matches is fetched and replaced, a save
  takes it with the folder).
- `hash-fails.test.ts`: the host's file rewritten in place with its mtime restored, after preparing: the viewer
  counts the failures of that piece, and the host warns once, in a notice and on that viewer's peer row.
- `viewer-room.test.ts`: the room goes away while the video plays (ended, or the viewer removed): sync stops
  and the player pauses where it is.
- `manager.test.ts`, `export-resume.test.ts`, `export-finish.test.ts`: the manager's (Startup, Saves a quit cut
  off, Crash restart, Leaving).
- `player-real.test.ts`: the installed mpv, headless (`member(…, { realMpv: true })`): `kill -9` of the
  viewer's and of the host's mpv in a playing room gives exactly one loadfile, and mpv is within 0.5 s of the
  room 3 s after that load's playback-restart.
- `player-foreign.test.ts`: the installed mpv with a second IPC endpoint (`mpvArgs`): another client stops the
  viewer's mpv or loads its own file while the room plays, and its next command (the other one) lands while the
  member's reload opens. The player rejects that load as superseded (also when the stop drops our entry before
  it started), the member loads the stream again at once (two loadfiles in all), and the viewer plays within
  0.5 s of the room in under 5 s (about 0.7 s). With our loadfiles reaching mpv 300 ms late, the other file's
  playback-restart arrives while our next load waits, and is not taken for it.
