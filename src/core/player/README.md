# player: mpv process, JSON IPC, controller, Lua OSC, HDR status

Plan §4.4, §5.3 (player API, core ↔ OSC messages), S7/S8 (methods only), M5.

| File                               | What                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `core/player/mpv-version.ts`       | `parseMpvVersion` (releases, distro, git/dev builds), `atLeast`, `MIN_MPV` (0.39) |
| `core/player/mpv-args.ts`          | `buildMpvArgs`: common args + `VERSIONED_ARGS` table + per-OS video/IPC options   |
| `core/player/mpv-ipc.ts`           | `MpvIpc`: newline-delimited JSON IPC over fd://3, a Unix socket or a named pipe   |
| `core/player/player-controller.ts` | `PlayerController`: lifecycle, restarts, enforcement, intents, tracks, HDR, OSC   |
| `core/player/osc-bridge.ts`        | `OscBridge`: typed core ↔ OSC messages, init handshake, heartbeat, throttling     |
| `core/player/hdr-status.ts`        | `hdrStatus` → `PlayerEvent['hdr']`, `hdrLabel` ("HDR → SDR (tone-mapped)")        |
| `core/player/child-env.ts`         | `mpvChildEnv`: strips `LD_LIBRARY_PATH`/`LD_PRELOAD` under AppImage               |
| `main/mpv-locate.ts`               | `locateMpv`: settings → bundled → PATH → Flatpak, version check                   |
| `resources/mpv-scripts/wt-osc.lua` | The OSC (script name `wt_osc`); never changes pause or position                   |
| `test/integration/player/*`        | Real-mpv tests (argv, IPC, controller, OSC)                                       |

## API for the lead

### Locating mpv (main)

```ts
import { locateMpv, toMpvInfo } from './mpv-locate.js'

const found = await locateMpv({
  mpvPath: settings.mpvPath,
  resourcesPath: app.isPackaged ? process.resourcesPath : null,
})
// found.status: 'ok' | 'missing' | 'tooOld'   found.kind: 'bundled' | 'system' | 'flatpak' | 'none'
// found.path: executable to spawn (for Flatpak: the flatpak binary)   found.version: '0.41.0', '0.42.0-dev', ...
// found.tried: every candidate with status ok | tooOld | unusable (+ detail), for MpvSetup and diagnostics
const info = toMpvInfo(found) // the control-channel MpvInfo
```

- Order: `settings.mpvPath` → bundled (`<resources>/mpv/mpv.exe`, `mpv/mpv.app/Contents/MacOS/mpv`, `mpv/mpv`)
  → PATH (plus `/opt/homebrew/bin`, `/usr/local/bin` on macOS) → `flatpak info io.mpv.Mpv` (Linux).
  The first candidate ≥ 0.39 wins. If none qualifies, the result is `tooOld` when an old one was found,
  otherwise `missing`.
- The Flatpak version comes from `flatpak info`'s `Version:` line. Only when that line is missing does it run
  `flatpak run io.mpv.Mpv --version`.
- `mpvChildEnv(env)` is re-exported here: use it for any mpv/flatpak child spawned from main.

To pass the result to core, map it to `MpvBinary { path, kind, version: versionFromString(found.version) }`.

### PlayerController (core)

```ts
const player = new PlayerController({
  mpv,                       // MpvBinary | null; null → state 'missing' or opts.unavailable ('tooOld')
  role,                      // 'host' | 'viewer' (viewer adds the stream/cache options)
  resourcesDir,              // contains mpv-scripts/wt-osc.lua
  logFile,                   // <logs>/mpv.log; the previous run's log is kept as mpv.prev.log
  settings,                  // hwdec, alang, slang, macHdrExperimental, oscPersistentStrip
  theme, perms,              // ThemePayload (#RRGGBB) and {isHost, canPlayPause, canSeek}
  strings?, mediaTitle?,     // OSC strings (i18n), --force-media-title
  hooks: {
    resolveToggle: () => room.paused ? 'play' : 'pause',   // OSC toggle → play | pause
    resolveSeekRel: (d) => clamp(sync.seekBase() + d),     // OSC ±5 / ±60 s → absolute seconds (from the newest
                                                           // seek not yet answered, so a held key adds up)
    restartPosition: () => room.pos(),                     // where selfReload reloads: crash, path change, reopen
    onPid: (pid) => control.send('mpv-pid', pid),          // main kills this pid if core dies
    readerBlocked: () => streamServer.isBlocked(0),        // viewers only; default () => false (see below)
  },
  selfReload: false,         // default true; false: the caller reloads (see "Who reloads")
  // tests and special cases: os, sessionType, ipcMode: 'socket', runtimeDir, extraArgs, env, timing, log
})
player.start()                                   // spawn idle mpv
await player.load(url, { start, paused, title?, subtitles? })  // resolves at its file's first playback-restart
await player.seek(pos)                           // 'absolute+exact'; resolves at its playback-restart
await player.setPaused(b); await player.setSpeed(x)
await player.getProperty('audio-pts')            // {value, tSend, tRecv} (performance.now())
await player.sample()                            // audio-pts, else time-pos; plus {prop}
await player.setTrack('audio' | 'sub', id | 'no'); await player.setVolume(vol, muted)
await player.addSubtitle({ url, title, lang }, select?)  // host: local path, viewer: stream URL
player.osc('ranges' | 'peers' | 'theme' | 'perms' | 'status' | 'toast' | 'ended', payload)
player.reopen()                                  // "Reopen player": fresh crash budget, then as after a crash
await player.close()  /* → closedByUser */       await player.quit()  /* → absent */   await player.dispose()
player.tracks(); player.buffered(); player.frameDrops(); player.prop(name); player.playerEvent(); player.pid
```

Events:

| Event             | Payload                                  | When                                                            |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------- |
| `state`           | `(next, prev)` `PlayerStatus`            | every lifecycle change                                          |
| `status`          | `PlayerEvent` `{status, version, hdr}`   | state or HDR change; forward as the renderer's `player` event   |
| `intent`          | `{kind, pos?, src: 'osc', seq}`          | OSC intents (resolved): `play pause seek close show-app resync` |
| `fileLoaded`      | `{path}`                                 | mpv `file-loaded` of a file our `loadfile` opened               |
| `playbackRestart` | `{pos}`                                  | every mpv `playback-restart`                                    |
| `audioReconfig`   | —                                        | mpv `audio-reconfig` (sync re-fits its clock)                   |
| `external-change` | `{kind: pause\|speed\|seek\|path, …}`    | something other than us changed playback; see Enforcement       |
| `exit`            | `{code, signal, requested, restartInMs}` | mpv exited; `restartInMs` null when no restart follows          |
| `tracks`          | `TracksEvent`                            | track-list / aid / sid / volume / mute changed (deduplicated)   |
| `property`        | `(name, value)`                          | every observed property, after enforcement                      |
| `eof`             | `boolean`                                | `eof-reached` flipped                                           |
| `oscReady`        | —                                        | the OSC answered `init` (also after every restart)              |

Calls that need mpv throw `CodedError('player-not-running')` when there is no IPC. A load that a newer load,
another client's file or `stop` (`selfReload: false`) or a restart replaces rejects with `player-superseded` /
`player-exited`. A file mpv cannot open rejects with `player-load-failed`.

### Lifecycle

`absent → spawning → connecting → idle → loading → ready`, plus `closedByUser`, `crashed`, `missing`, `tooOld`.

- **IPC:** fd://3 (socketpair on stdio[3]) on Linux/macOS. Flatpak or `ipcMode: 'socket'` uses
  `--input-ipc-server=<runtimeDir>/wt-mpv-<rand>.sock`. Windows uses `\\.\pipe\wt-mpv-<pid>-<16hex>`, with
  connect retried every 50 ms for up to 10 s.
- **Quit:** `quit`, then SIGKILL after 2 s (`taskkill /T /F /PID` on Windows). `quit()` → `absent`;
  `close()`, the OSC `close` intent, or an unrequested exit with code 0 → `closedByUser`.
- **Crash:** any other exit → `crashed`, then a restart after 1, 2 and 4 s (at most 3 per 60 s). The 4th crash
  in the window stays `crashed`. A restart and `reopen()` reload the last file paused at `hooks.restartPosition()`
  and re-apply aid, sid, volume, mute and external subtitles; with `selfReload: false` they stop at `idle` and
  the caller reloads (below).
- **OSC handshake:** `init` every 100 ms until `wt-ready` (5 s cap, then the bridge emits `timeout` and the
  player still works), then `hb` every 2 s. A restarted OSC is replayed the latest ranges, peers, status and ended.
  A theme or perms change after the last `init` was posted is sent at `wt-ready`, and the latest toast sent
  while the OSC was not up (mpv starting or restarting) is shown then, once, if it is at most
  `TOAST_KEEP_MS` (10 s) old.

### Enforcement

`expected = {paused, speed, path, pendingSeek}` changes only through `load/seek/setPaused/setSpeed`.

- `pause` ≠ expected, checked after a 30 ms settle, not at EOF or within 0.25 s of the end: re-apply and emit
  `external-change {kind: 'pause'}`.
- `speed` ≠ expected: reset and emit `{kind: 'speed'}`.
- An mpv `seek` event with no pending app seek, which lands > 0.5 s from where it started, emits `{kind: 'seek', pos}`
  at its `playback-restart`. So does a `time-pos` jump > 1.5 s beyond elapsed × speed (or backwards) while
  not seeking. Sync re-seeks; the controller does not.
- Another client's file replaces ours (a console `loadfile`, macOS File > Open, a second IPC client), or a
  `stop` (or `playlist-remove`) ends it, also while our load or reload is in flight, including before mpv started
  the entry our `loadfile` got: emit `{kind: 'path', path: null}` and reload expected.path paused at
  `restartPosition()`. With `selfReload: false` the controller goes to `idle` instead (a load, reload or seek in
  flight rejects with `player-superseded`) and emits `'path'` once: the other file's `start-file`, or mpv's `idle`,
  then finds it idle, and the other file's `file-loaded` and `playback-restart` complete nothing, emit no
  `fileLoaded` and get none of our subtitles. See "Whose file mpv shows".
- While mpv shows another file, or is between two files, its `aid` and `sid` are not taken as the user's
  choice; nor is the track mpv picks at a (re)load (it replaces `"auto"`), nor a value reported again unchanged.
  Only a switch from one track (or none) to another is.
- `paused-for-cache` never counts.

### Whose file mpv shows: playlist entry ids

Every `loadfile` reply carries the new entry's `playlist_entry_id`; `start-file` and `end-file` carry it too.
The controller takes the reply in line order (`MpvIpc` `onReply`: a promise would settle only after the
rest of the chunk), and mpv sends it before that entry's `start-file` and runs commands in order. So an entry
that is not our newest loadfile's, while none of ours is unanswered, is another client's file; one that is,
is ours even when its path did not change (another client loading our own URL). The end of our newest entry
(not `quit`, not a load error) with none of ours unanswered means a stop or another client's loadfile. mpv's
`idle` event with our newest `loadfile` answered, none unanswered and no entry shown means a `stop` or a
`playlist-remove` dropped our entry before it started. mpv runs commands while it waits for the previous entry's
demuxer to close (`kill_demuxers_reentrant`; ~0.2 s when a read waits on a missing piece), and then sends no
`start-file` or `end-file` for our entry, only `idle` (sent from `idle_loop`, after the last `end-file`). A
`playlist-clear` keeps the current entry, ours. mpv's client.h calls the `idle` event deprecated, but 0.39 to
master still send it; the `idle-active` property cannot stand in, since property changes have no order against
our `loadfile` reply.

- A `playback-restart` completes our load, reload or seek only while mpv shows our newest entry and none of
  our loadfiles is unanswered: not another client's file, nor what mpv showed before it took our loadfile.
- `fileLoaded`, the subtitles and track restore at `file-loaded`, `fileTracks` and the user's track choices
  only count on our entries.
- Not the `path` property: mpv coalesces property changes and sends them once its event queue is empty, so
  they have no order against events (measured in round 4: a changed `path` came before `file-loaded` in all
  400 loads, half of them under CPU load, but nothing promises it), and a load of the same URL changes nothing.
- An mpv without entry ids (none we support: 0.39 has them) counts every file as ours.

### Tracks across files: `LoadOptions.carry` (ADR 0011 §7)

`load(url, {carry})` for a file other than the loaded one starts it on the tracks `track-carry.ts` matched in the
next file's manifest:

- **Matching:** the same title, else the same language and forced flag; subtitles off stays off.
- **How they ride:** `aid=`/`alang=`/`sid=` go in the loadfile's per-file options, as a same-file reload's do, so
  nothing switches tracks after the file opened.
- **External subtitle:** a matched one is added with `sub-add … select`.
- **Check:** at file-loaded the selected tracks are compared with the match (title, language). A mismatch picks the
  matched track by title and language in mpv's list.

The manifest's order stands in for mpv's per-type ids: each type counts from 1 in container order. For the same file
`carry` is ignored.

### Who reloads: `selfReload`

After a restart (crash, `reopen()`) and on an external path change, the file has to be loaded again. By
default the controller does it. Sync's member reloads in the same two cases (when the player is available
again, and on `external-change` `'path'`), and two owners race: the later `loadfile` wins and the member then
waits at a position mpv is not at (round-1 review, "two reloads race"). So the session passes
`selfReload: false` (`base-session.ts` does, so sync's member owns every `loadfile`). Then the controller stops
at `idle` after a restart, and goes to `idle` when another file replaces ours or a `stop` ends it (emitting
`'path'` once), also while our load or reload is in flight, and leaves `hooks.restartPosition` unused. `idle` is
"available, not
loaded", which sync's member reloads by its generic rule, also while it holds for an absent host and ignores
`'path'`; staying `ready` on the other file would have let it settle and play that file. The caller's `load()`
of the same URL is a same-file load: it re-applies aid, sid, volume, mute and the external subtitles like the
controller's own reload.

### Blocked reader: reload instead of seek (viewers, ADR 0004 §5)

While `hooks.readerBlocked()` is true, mpv's demuxer sits in an HTTP read that waits on a piece, and
anything that needs a demuxer seek queues behind it until the piece arrives. `loadfile` interrupts it and
reaches `playback-restart` in about 0.2 s, so the controller reloads the same URL in place of:

- a `seek(pos)` whose target is outside `demuxer-cache-state/seekable-ranges` (or within 0.5 s of a range's
  end); a target inside the cache is still a plain seek;
- an audio switch (`setTrack('audio', n)`, or the OSC's select-aid seen as an `aid` change);
- an embedded subtitle switch (`setTrack('sub', n)` or select-sid). External subtitles have their own
  demuxer and are set with `set_property`.

A reload keeps the state `ready`: `seek()` resolves at its `playback-restart`, and its track, path, pause
and seek churn is neither enforced nor reported. Every same-file `loadfile` carries the track choice in its
per-file options (`aid=<n>,alang=<lang>`, an embedded `sid=<n>`, or `=no`): setting them at `file-loaded`
races the read-ahead. They are set there only when mpv did not take them, which logs a warning. A seek sent
while nothing looked blocked is reloaded by the 3 s watchdog if it still waits behind a blocked read.

Whether a `sid` is embedded and which language an `aid` has come from the loaded file's track-list as last
reported non-empty (`fileTracks`), not from the live one. mpv empties `track-list` from a `loadfile` until the
new demuxer opens (~180 ms of a ~220 ms reload), and a crash clears every property. A reload sent while
another is in flight (sync re-seeks during a seek) or after a restart would otherwise drop `sid` and
`alang`, and the `set_property sid` that follows waits behind the blocked read. The list is kept across a
restart of the same file, reset by a `load()` of another file, and ignores lists reported while mpv shows a
file another client loaded.

### OSC messages (`osc-bridge.ts`, `wt-osc.lua`)

Intents `next` and `prev` (added): the host's `>` and `<`, a playlist's next and previous item. The session decides,
and toasts when there is none.

- core → OSC: `script-message-to wt_osc <kind> <json>`.
  - `init {v, client, theme, perms, strings, watchdogS, persistentStrip}`;
  - `theme {mode, colors, peers}`, `perms {isHost, canPlayPause, canSeek}`;
  - `ranges {dur, done, loading, groupDone?}`: sorted and merged, at most 512 spans per layer (smallest gaps
    closed first), at most 4 Hz, latest wins. The bridge leaves `groupDone` out when it shows the same spans
    as `done`: the host's `done` is groupDone already (`core/session/timeline.ts`). `wt-osc.lua` still draws
    the strip under the bar only when it differs from `done` (`same_spans`);
  - `peers [{id, name, color, pos, state}]`: at most 2 Hz, at most 12 peers, names cut to 32 chars;
  - `status {text, level?}`, `toast {text, ms?}`, `ended {ended}`, `hb {}`;
  - `resync {shown}`: a viewer behind the host; the bar shows a **Resync to live** button (`strings.resync`) while
    shown, never for the host, and only from 600 px wide (Shift+R works at any width). Sticky, like `status`.
- OSC → core: `script-message-to <client_name> wt-ready {v}` / `wt-intent {t, pos?, delta?, seq}`.
  `t` is one of `play pause toggle seek seek-rel close show-app resync`. `resync` comes from Shift+R (`R`; plain `r`
  is show-app) or the bar button, never on the host; core decides what it does (`BaseSession`, local only).
- **Colours are converted in TS** (`assColor`: `#RRGGBB` → `&HBBGGRR&`), so the Lua side drops them into
  `\c` tags unchanged and has no hex parsing to get wrong. Already-ASS values pass through.
- Timeline mapping (piece states → seconds) is not here. `core/timeline.ts` (lead) produces `{done, loading}`
  and calls `player.osc('ranges', …)`. `buffered` is drawn by the OSC from mpv's own `demuxer-cache-state`.
- `wt-osc.lua` invariant: only `wt-intent` for play/pause/seek. Tracks (`script-binding select/select-aid|sid`,
  falling back to `cycle`), volume, mute, fullscreen, subtitle visibility and delay, and stats are local.
  `--script-opts=wt_osc-test-dims=WxH` gives it a size under `--vo=null` and publishes what it drew as
  `user-data/wt_osc/overlay` (tests only).

### HDR status

`hdrStatus({video-params, video-target-params, current-gpu-context, hwdec-current})`:

- source `hdr` when `video-params/gamma` is pq or hlg;
- output `passthrough` when `video-target-params/gamma` is pq or hlg, otherwise `tonemapped`; SDR sources give
  `sdr`, unknown inputs give `unknown`;
- `maxCll` from `video-params/max-cll`, `targetPeak` from `video-target-params/max-luma` (or `sig-peak` × 203);
- `gpuContext`, `hwdec`.

The controller observes these and emits `status` when the result changes. S7 verifies the values per platform.

## Argument table (`mpv-args.ts`)

`VERSIONED_ARGS` holds every option whose existence depends on the version; rows apply when
`since ≤ version < before`. The source of truth is the version table in ADR 0004 §6.1 (options.rst at
v0.39.0, v0.40.0 and v0.41.0; only 0.41 was executed), and `mpv-args.test.ts` checks every row of it.

| Rows                                                                | Versions |
| ------------------------------------------------------------------- | -------- |
| `--load-osd-console=yes`                                            | < 0.40   |
| `--load-console=yes`, `--load-commands=no`, `--load-positioning=no` | ≥ 0.40   |
| `--load-context-menu=no`                                            | ≥ 0.41   |

`--input-builtin-dragging=no` and `--media-controls=no` are common args: both exist in 0.39.
`--target-colorspace-hint` is `auto` from 0.40. On 0.39 it is a flag: `yes` on Wayland and Windows and `no`
on X11 and macOS (`yes` with the macOS HDR setting, which also selects `--vo=libmpv`, i.e. cocoa-cb). The
stream/cache options come from `core/media/mpv-stream-opts.ts` (`MPV_STREAM_OPTS`), deduplicated against the
common args.

## Deviations from the plan

- **`--target-colorspace-hint=auto` from 0.40**, not 0.41 as the plan says: 0.40 already takes `auto`
  (its default there is `no`; 0.41 made `auto` the default). ADR 0004, finding 13.
- **Stream options are viewer-only:** the cache/stream options are passed to viewers only. The host opens a
  local file, where mpv's defaults are right and `cache-pause` is meaningless.
- **Heartbeat watchdog:** the watchdog is armed for every server-socket IPC (Windows pipe, Flatpak socket),
  not only Windows. A socket outlives core just like a pipe; fd://3 does not, so there it is 0 (off).
- **Unrequested exit 0:** an exit with code 0 that we did not request (e.g. the WM killed the window without
  CLOSE_WIN) is treated as `closedByUser`, not a crash.
- **`close` intent:** the controller emits `intent {kind: 'close'}` and closes the player itself (state
  `closedByUser`). The session moves to phase `no-player` on that state.
- **Locate order on Linux:** the order is settings → bundled → PATH → Flatpak on every OS. That is the task's
  order; there is no bundled build on Linux, so the plan's Linux order is unchanged in practice.
- **Flatpak specifics:** for Flatpak, wt-osc.lua is copied into `$XDG_RUNTIME_DIR/app/io.mpv.Mpv/` with the
  socket, because the sandbox cannot see an AppImage mount. The sandbox runs with `--filesystem=host:ro`
  plus the log directory.
- **Extra events:** `tracks`, `property`, `eof` and `oscReady` are added beyond §5.3. They are what the lead
  needs for the renderer's tracks event, sync's buffering and EOF, and diagnostics.

## How to test

```sh
npx vitest run --project unit src/core/player src/main/mpv-locate.test.ts
npx vitest run --project integration test/integration/player   # needs mpv ≥ 0.39 and ffmpeg on PATH
```

- Unit: argv snapshots per version and OS (`__snapshots__/mpv-args.test.ts.snap`), version parsing, IPC framing,
  timeouts and errors against a fake stream, the OSC bridge timers (fake timers), span capping, HDR, and
  mpv-locate with fake executables in a temp dir.
- Integration (real mpv, `--vo=null --ao=null`, a generated 10 s testsrc2 clip):
  - argv accepted with `--idle=no` for host and viewer;
  - IPC over fd://3 and a Unix socket;
  - load paused at 3 s, seek, enforcement of external pause/seek through a second IPC connection;
  - kill -9 → restart at the room position with aid (and alang) re-applied, one `loadfile`;
  - `selfReload: false`: after kill -9 during playback, after Reopen and after another client's `loadfile`,
    the caller's `load()` is the only `loadfile` and brings the tracks back (alang from our file, not the
    other one); another client's `loadfile` or `stop` leaves the controller `idle` with one `'path'` event,
    and a seek waiting behind a blocked read rejects as superseded instead of resolving on the other file;
    the same while our `load()` or a reload standing in for a seek waits on missing data, for another file,
    our own URL and a `stop` (`blocked-reader.test.ts`), and at another client's `start-file` alone;
    `selfReload: true` reloads that other client's change itself;
  - a `stop` or a `playlist-remove current` that another client sends the moment mpv answered our `load()`'s
    or a seek reload's `loadfile`, while the blocked entry before it still closes: our entry never starts, and
    the request rejects as superseded, `idle`, one `'path'`; a `playlist-clear` there keeps our entry, which
    loads (`blocked-reader.test.ts`). 20 rounds of a `load()` and another client's `stop` sent together on a
    local file each end `ready` on our file or `idle` on an empty mpv with one `'path'`, never hanging;
  - entry ownership with injected events: a `playback-restart`, or another client's `start-file`,
    `file-loaded` and `playback-restart`, before mpv answered our `loadfile` complete and give up nothing;
    neither does an `idle` before that reply, or one while our entry is shown;
    a seek or reload whose reply and events come in one chunk completes there (`MpvIpc.onReply`);
  - a late or repeated report of the track mpv picked at a reload is not the user's choice (it rode in every
    later reload); turning subtitles off is;
  - a toast sent right after `start()`, before the OSC is up, is drawn once it is;
  - a viewer streaming from `StreamServer` with pieces withheld (`blocked-reader.test.ts`): seek by reload
    outside the cache and by seek inside it, audio and embedded-subtitle switches by reload (MKV and MP4),
    `alang` and `sid` carried in the `loadfile`, also in a reload sent while another is in flight and across
    a crash restart (both `selfReload` values), the OSC's switch, and the watchdog;
  - 4th crash in 60 s → `crashed`;
  - `close()` and CLOSE_WIN → `closedByUser`;
  - the OSC: init → wt-ready, SPACE without permission → toggle intent with pause unchanged, arrows, drag
    release, local keys, every message without `wt_osc` errors in the mpv log, and no groupDone strip that
    repeats `done`.

  The suites skip when mpv/ffmpeg are missing. They leave no processes, sockets or temp dirs behind.
