# Renderer (M7) and main-process UI helpers

The UI is React 19 + zustand, sandboxed. It talks to core over `window.wt.core` (MessagePort brokered by main) and to
main over `window.wt.app`. Its state comes only from the core snapshot and events (plan §4.6, §5.1).

## Layout

```
src/renderer/src/
  main.tsx            entry: uses window.wt, or the fake core in a plain browser (dev only)
  bridge.ts           setBridge()/wt(): the WtBridge in use (real or fake)
  store.ts            zustand store: core slices, settings, theme, info, toasts, recent rooms, UI flags,
                      PlayheadClock; connectStore(bridge) wires it all and returns a disconnect
  rpc.ts              call() (toasts failures), sendIntent()/denied()/askHost() for playback intents
  leave.ts            leaveRoom()/cancelPrepare()/saveFile()/openLeavePrompt(): one leave at a time, ui.leaving
  saves.ts            finishExport()/refreshRecent(): a cut-off save (RecentRoom.export), from Home or a notice, and
                      what came of it
  route.ts            selectScreen(core, leavingFrom): the screen for session.phase / player.status
  hooks.ts            useDeepLinks(), openInvite(), usePlaybackKeys()
  App.tsx             shell: TitleBar, current screen, Toasts, Settings / Leave / JoinDialog overlays
  lib/                pure helpers: format, playhead, coverage, relay-key, keyboard, settings-form, theme, mpv-check
  components/         TitleBar, Toasts, JoinDialog, LeavePrompt (+ StopHostingPrompt), KeepAwakeNote, Feasibility,
                      FullDownload, MediaNotes, LimitField, ui (Switch, Field, Segmented, Modal, ProgressBar),
                      Timeline/{Timeline.tsx, draw.ts}
  screens/            Home, HostPrepare, JoinConfirm, Room/*, Settings (overlay), MpvSetup, ErrorScreen
  mock/               FakeCore (scriptable window.wt), fixtures, scenarios, simulate (live mode)
  test/harness.tsx    tiny DOM harness for tests (no @testing-library dependency)
```

## Routing

`selectScreen(core, leavingFrom)`:

| condition                                         | screen                                                     |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `player.status` is `missing` or `tooOld`          | MpvSetup (replaces everything)                             |
| phase missing or `idle`                           | Home                                                       |
| `preparing`                                       | HostPrepare                                                |
| `connecting`, `pending-admission`, `confirm-join` | JoinConfirm (spinner / pending with Cancel / confirm card) |
| `in-room`, `ended`                                | Room (Ended card on sync `ended`; Closed card on `ended`)  |
| `leaving`                                         | the screen the leave started on (see Leaving); else Room   |
| `error`                                           | ErrorScreen (Back to Home = `session.leave {data:'keep'}`) |

Overlays: Settings (title bar button, or the tray's `open-settings` command), the leave prompt (Leave button, or
the tray's `leave` command; see Leave prompt below), and JoinDialog when a deep link arrives while a room is active.

Keyboard (Room only, no dialog open): Space = `toggle`, ←/→ = `seekRel ∓5`. Keys are left alone when focus is in a
control that uses them (`lib/keyboard.ts`: text fields, selects, range inputs; Space/Enter on buttons, switches
and radios). The focused timeline slider handles ←/→ itself; Space still toggles there.

## Behaviour notes (where the plan left room)

- **Permission-gated controls** use `aria-disabled` + `title`, not `disabled`, so they stay focusable and the
  tooltip shows. Pressing one shows the denial toast with **Ask host** (`sync.request`). Core rejections
  (`perm-playpause`/`perm-seek`) give the same toast. While play/pause is not allowed, an "Ask host to play/pause"
  button is shown as well.
- **Playhead interpolation**: `playback.at` is core's monotonic clock, whose origin differs from the renderer's.
  `PlayheadClock` estimates the offset as the minimum of (receive time − at), extrapolates only while
  playing (not paused/seeking/stalled), at most 2 s past the last sample, and re-bases when the offset jumps
  by more than 5 s (core restart).
- **Timeline**: `drawTimeline(ctx, {width,height,dpr}, state, tokens)` is pure. Layers bottom to top: missing,
  downloaded (host: `groupDone`), downloading with 45° stripes, buffered strip under the bar, peer triangles
  (`--peer-N`, N = index in the `peers` list), playhead, hover line + label. The host's labels read "Everyone has
  it" / "Sending" / "Not everyone has it". The element is a `role="slider"` with a text value; a legend with
  patterned swatches sits below it so no state depends on colour alone. Seeks are sent on pointer release only
  when `canSeek`.
- **Theme**: the `ThemePayload` from main is mirrored onto `:root` as inline custom properties, plus
  `--peer-0..7`, which have no `tokens.css` counterpart (the tokens test compares `tokens.css` to the
  token set exactly, so the peer colours cannot be added there). `tokens.css` stays the first-paint fallback.
- **Space check (JoinConfirm)**: blocked when `freeBytes < size − haveBytes + 512 MiB`. Unknown free space
  (`session.checkDir` unavailable) does not block. An unwritable folder blocks.
- **Leave prompt**: viewers choose Save file (only when `transfer.progress` is 1) / Keep for later / Delete now.
  The host chooses Leave for now (`keep`) or End room for everyone (`keep`, `end: true`). Which prompt fits comes
  from `store.leavePromptFor`, by session phase: the Room's for `in-room` / `ended` (also over MpvSetup, where it is
  the only way out of a room), "Stop hosting?" while `preparing`, none elsewhere or while a leave runs. The tray's
  "Leave room…" (enabled while preparing too, since `inRoom` covers it) therefore asks "Stop hosting?" on HostPrepare:
  the room already exists and leaving now ends it, so Stop hosting runs HostPrepare's Cancel (`session.cancelPrepare`)
  and Keep preparing closes it. HostPrepare's own Cancel button stays immediate. Where no prompt is drawn the command
  does nothing, so it never leaves `leaveOpen` waiting to pop up later. An open prompt closes once the session moves to
  where a different prompt (or none) fits, e.g. preparing finishes or core restarts at idle, instead of changing
  meaning under the pointer.
- **Leaving** (`leave.ts`, phase `leaving`): every leave and save the UI starts goes through `leaveRoom()`,
  `cancelPrepare()` or `saveFile()`. From the click until core answers, `ui.leaving` holds what runs; a second
  leave or save is dropped there (core would refuse a different one as `busy`), and the tray's Leave and the
  Leave buttons open no prompt. The store keeps `leavingFrom` (the phase before `leaving`), so the screen the leave
  started on stays up: JoinConfirm shows "Cancelling…", HostPrepare and the error screen disable their button, and
  a cancelled join never flashes an empty Room. In the Room a sticky, modal-free banner says what runs
  (`store.leaveKind`: core's `SessionEvent.leave` on its `leaving` event, else what this window asked):
  "Saving the video… this can take a few minutes" for `save`, "Ending the room…" for `end`, else "Leaving the
  room…". Core's word wins, so a window reloaded mid-save still says saving, from the snapshot alone. The Ended/Closed
  cards and the media notes go, and everything else sits in a `<fieldset disabled>`, which disables every control at
  once. The Timeline (not a form control) and the playback keys check the same flag. A deep link that arrives
  meanwhile waits for the leave to finish, then joins without asking. `isActivePhase` includes `leaving`, so main
  hides the window on close and asks before quitting during an export; `SessionReport.saving` (phase `leaving` and a
  `save` leave, `store.isSaving`) lets its quit prompt say that quitting interrupts the export.
- **Saving** always uses `transfer.saveFile` (Leave prompt and Closed card: no `dest`, so the join folder; Ended
  card: a picked folder), never `session.leave {data:'save'}`: it takes a folder, and it refuses an incomplete
  download before leaving the room. Where the video went is core's `transfer.export-finished` notice ("Saved <name>",
  with `path`), which core sends for every finished save (`transfer.saveFile`, `session.leave {data:'save'}`, a save
  finished at startup or by `transfer.finishExport`); the result's path adds no toast of its own, so one save gives one
  "Saved" toast, with **Show in folder**, that stays until dismissed. An `incomplete` error shows core's message; when
  the session is idle by then (the export found missing parts, the room's download is kept), the toast offers
  **Rejoin** (`session.resume {roomId}`). Before the export (not fully downloaded) the room stays and there is no
  Rejoin.
- **Full download** (`session.media.fullDownload`, an fMP4 without sidx): HostPrepare and the host's Room show
  "Viewers can only start after downloading the whole file" with `FASTSTART_REMUX` (`src/shared/media/remux.ts`,
  re-exported from `media-map.ts`) and a Copy button, for container `fmp4` only (a file of a few pieces is whole-file
  too, and downloading all of it costs nothing). A viewer's Room shows "Plays once the whole video is downloaded
  (N %)" from `transfer.progress` until it reaches 1; JoinConfirm says so before joining. Sync keeps such a viewer
  `joining` (it has no source to load yet), so the viewer's own peer row says "Downloading N %" (the same
  `transfer.progress`) instead of "Joining". Other rows keep sync's word: a remote `joining` member may still be
  connecting.
- **Peer warnings** (`PeerView.warnings`): entries with a code and their numbers, not text. `PeerList` shows each
  as a line from `peerWarningText` (`src/shared/peer-warnings.ts`, which core's OSC toasts use too), keyed by code,
  with `data-tone` from `peerWarningTone`: hash failures in the danger colour, the rest in the normal text colour.
  `formatMbit` lives there as well; `lib/format.ts` re-exports it.
- **Media notes** (`components/MediaNotes.tsx`, `session.media`; not for a full-download file, which plays from disk):
  `seekMode: 'linear'` (no seek index: to play from a point, a viewer needs everything from the start up to it) shows
  "Seeking is slower for viewers." in HostPrepare and the host's Room; `interleave: 'poor'` shows "Viewers need more
  data before playing or seeking." The stream-copy remux that fixes the file comes from `src/shared/media/remux.ts`
  (`remuxFor` → `remuxCommand(container, seekMode, interleave)`: MP4/fMP4 and MOV faststart, MKV and WebM with Cues and
  tighter interleaving, MPEG-TS into Matroska; none for AVI or an unknown container, and none is made up here). One
  command fixes both, so it shows once, under the first note, with Copy and the files it reads and writes from
  `remuxFiles` ("run this with your file as in.ts, then host out.mkv"). A viewer gets one short muted line under the
  download line, only while the download runs (starts and seeks are local afterwards).
- **Ended card** (the video ended, room still open: `sync.mode === 'ended'` while the phase is `in-room`): the host
  gets Play again (`seek 0`, then `play`) and End room. Viewers get Leave, plus Save file once `transfer.progress`
  is 1 (pick a folder, then `transfer.saveFile {dest: folder}`, then a toast with "Show in folder").
- **Closed card** (`session.phase === 'ended'`: the host closed the room): "The host ended the room". Viewers get
  Save file (only with the whole file), Keep for later and Delete (`session.leave {data}`); never Play again. A
  host who still sees this phase gets Back to Home.
- **Wait banner**: `sync.wait.waitingFor` holds display names, shown as they are ("Waiting for Sam, Alex…", more
  than three become "and N more"). Start anyway is host-only; viewers never get it, whatever their permissions.
  Shown only while the phase is `in-room`: once the room is closed (or being left) sync stops, and its last event
  would keep a stale wait on the Closed card.
- **Feasibility line**: core sends `prepare.feasibility` while preparing and about once a second on the host in
  the room, so it shows in HostPrepare and in the host panel's Network group (`components/Feasibility.tsx`). When
  the host's own upload limit is what the upload comes to (at most 5 % above the measured upload, or nothing
  measured yet), the line names it ("your upload limit ~0.8 Mbit/s") and the advice is to raise or clear it.
- **Transfer limits** (settings `uploadLimitKBps`, `downloadLimitKBps`; KiB/s, empty for none): Settings › Network
  has both. In the Room, `components/LimitField.tsx` edits one of them live through `app.setSettings` (blur or
  Enter; a bad value says why and saves nothing; it takes what Settings takes, `limitKBps` in
  `lib/settings-form.ts`, so a value saved there never fails a later Settings save): the host panel has the upload
  limit only, and a viewer's **Your connection** card (`Room/ConnectionPanel.tsx`) has both, with a line comparing
  the download limit to the video's average bitrate (`fileSize / durationS`; a warning below 1.1 × it,
  `SLOW_RATE_FACTOR` from `src/shared/limits.ts`, the factor core's slow-download warning uses: "Below" the bitrate
  itself, "Close to" it from there to 1.1 ×). The viewer's transfer line adds
  "(limited)" while a download limit is set: the limit is KiB-based and the rate decimal, so no number.
- **Host still preparing**: a viewer in `connecting` / `pending-admission` gets prepare events forwarded from the
  host and sees "The host is preparing the video: N %". The store drops `prepare` when the session goes back to
  `idle` or `error`, so a later join never shows a stale line.
- **Settings → Save** with a changed mpv path runs `recheckMpv()`: on success the toast reads "Settings saved.
  mpv 0.41.0 found."; otherwise the dialog stays open with "mpv not usable: …" (from `status` and `tried[0]`,
  `lib/mpv-check.ts`) under the mpv row.
- **Notices** become toasts with core's level and message. The toast's code is core's code plus what the notice is
  about (`store.codeAbout`: its `path`, else the `roomId` in its action's params): the same notice about the same thing
  replaces its previous toast, while notices about two saved videos, or two rooms' saves, each keep their own (two
  saves finished at one startup used to leave only the last "Saved" toast). Core's `action` becomes the toast's button
  and runs like a click's request (`components/Toasts.tsx`): a failure shows the usual error toast, and
  `transfer.finishExport` (the Finish saving of `transfer.export-waiting`) goes through `saves.ts`, like Home's button.
  A notice with a `path` (`transfer.export-finished`) gets **Show in folder** instead (`showItemInFolder`) when it has
  no action of its own, and stays until dismissed. `transfer.export-resumed` and `transfer.export-failed` show as they
  come.
- **Toasts vs dialogs**: while any `aria-modal` dialog is open, the toast area moves to the top edge and passes
  every click through (`body:has(...)` in `Toasts.module.css`), so it never covers a dialog's buttons.
- **zustand selectors** must return stored values or primitives. A selector that builds a new array, object or
  function (`?? []`, `.map`/`.filter` inside it, an object literal) changes the snapshot on every render and ends
  in React error #185. Use a module-level empty constant (`NO_PEERS`), `useShallow`, or select primitives and
  derive with `useMemo`. `render-loop.test.tsx` renders every screen from bare snapshots and fails on #185.
- **"Keeping this computer awake"** is inferred in the UI from the same rule core uses (preparing, hosting, or a
  viewer with progress < 1). Main holds the actual blocker (`src/main/power.ts`).
- **Deep links**: a pushed link is handled, then `takePendingDeepLink()` clears main's copy. The same link is
  ignored for 10 s. JoinConfirm therefore appears once, including under StrictMode and after reloads. When idle
  (or after an error) the link calls `session.join` directly; otherwise JoinDialog asks first.
- **Recent rooms** load with `session.recent` when Home mounts (`saves.refreshRecent`; a later refresh that fails
  keeps the list shown). If core does not implement it yet, the section is hidden.
- **A cut-off save** (`RecentRoom.export`: a 'save' that a quit, a crash or a missing drive cut off) is listed as
  "Saving <name> into <folder> was cut off." (plus a **Folder not connected** badge while `waiting`), with **Finish
  saving** and **Cancel saving** instead of Resume, which core refuses meanwhile. Finish saving is
  `transfer.finishExport {roomId}`, also while `waiting` (the drive may be back by now). Cancel saving asks first
  ("Cancel saving?": the parts already saved are downloaded again when the room is resumed; the partly saved file is
  deleted if its folder is there), then sends `{roomId, giveUp: true}`. One request per room at a time
  (`AppState.finishing`, which also shows "Saving…" / "Cancelling…" and disables both buttons); a second one, e.g. from
  the notice, is dropped. After every outcome the list is refreshed: `finished` (the room is gone; core's
  `transfer.export-finished` notice is the one "Saved" toast), `rejoin` (the room offers Resume; when it was asked to
  finish, core's `transfer.export-failed` notice says why, so the UI adds nothing), `waiting` (a warning asks to
  connect the folder's drive and try again, with **Try again**; its toast code is the one core's
  `transfer.export-waiting` notice for that room gets, so the two never stack). Errors (`busy`, …) are the usual error
  toast.
- **Admission queue** (host): a request a member passed on for a joiner that cannot reach the host
  (`RoomEvent.pending[].via`) reads "<name> via <member>".
- **Relay key** accepts 64 hex or 52 z-base-32 characters (case-insensitive) and is stored as lowercase hex.

## Contract additions (`src/shared/ipc/core.ts`, `src/shared/ipc/app.ts`)

All additions are optional or new, so existing code keeps compiling.

core.ts

- `RecentRoom {roomId, name, role, fileName, fileSize, lastActiveAt, progress, resumable}`.
- Request `session.recent: {} → RecentRoom[]` (newest first).
- Request `session.checkDir: {dir} → {freeBytes, writable}`: JoinConfirm calls it after "Change…".
- `SessionEvent.joinInfo.haveBytes?`: bytes already on disk from an earlier session.
- `PrepareEvent.feasibility?: {needBps, uploadBps | null}` in **bytes/s**: the upload the group needs from the
  host and the host's upload: its measured peak, or once the upload pacer found the uplink to be the bottleneck,
  the best paced rate of the last 10 s (ADR 0006). HostPrepare and the Room's host panel show "Group needs ~X
  Mbit/s from you; your upload ~Y Mbit/s" and warn when the upload is lower.
- `TransferEvent.uplink?: {rateBps | null, queueMs | null, state}` (host): the upload scheduler's rate (the upload
  limit or the paced rate, whichever is lower), the pacer's queueing-delay estimate and its state ('start' |
  'steady'). Nothing shows it yet.
- `PeerView.posS?: number | null`: each member's last reported position, for the timeline peer markers.
- `PeerView.warnings: PeerWarning[]` (was `string[]`): `{code, …numbers}` from `src/shared/peer-warnings.ts`.
- `SyncEvent.desync?: {state: 'behind', behindS} | {state: 'catching-up'}` (viewer): this viewer is behind the host
  (Settings `desyncWarnMs`). The Room shows `DesyncBanner` while the room plays: "You're 3 s behind the host" with
  **Resync to live**, or "Resyncing with the host…". Its live region holds only the state ("You're behind the
  host"), not the number, which changes up to twice a second while a stall grows. Request `playback.resync: {} → {outcome: ResyncOutcome}`,
  viewer only and local (no permission); `rpc.resync()` toasts the outcomes that changed nothing.
- (Lead, round 3) `SessionPhase` `'leaving'` and `SessionEvent.media?: {container, seekMode, fullDownload}`.
- (Lead, round 4) `SessionEvent.leave?: 'keep' | 'save' | 'delete' | 'end'` (only with phase `leaving`),
  `SessionEvent.media.interleave?: 'good' | 'poor' | 'unknown'`, `NoticeEvent.path?: string`.
- (Lead, round 5) `RecentRoom.export?: {name, dest, waiting}`, `RoomEvent.pending[].via?: string`, and the request
  `transfer.finishExport: {roomId, giveUp?} → {outcome: 'finished' | 'waiting' | 'rejoin', path?}`. Core posts
  `transfer.export-finished` (with `path`) for every finished save, and `transfer.export-waiting` (action Finish saving
  → `transfer.finishExport {roomId}`) when a save's folder is not there.

app.ts

- `AppInfo.distro?: string | null`: the Linux os-release `ID`. MpvSetup highlights the matching command.
- `copyDiagnostics(core?: CoreDiagnostics | null)`: the renderer fetches `diagnostics.get` and passes it along,
  because main has no request channel to core. The preload must forward the argument.
- Optional methods (the renderer feature-detects them until main and preload provide them):
  - `recheckMpv?(): Promise<Result<MpvInfo>>`, channel `APP_CHANNELS.recheckMpv = 'mpv:recheck'`. It re-runs
    the mpv lookup after `settings.mpvPath` changes and passes the result to core, which should then emit a
    `player` event.
  - `reportSession?(report: SessionReport)`, channel `APP_CHANNELS.reportSession = 'session:report'`, sent with
    `ipcRenderer.send` (fire and forget). `SessionReport {inRoom, title, saving?}`; `inRoom` is true for
    `preparing`, `in-room`, `ended` and `leaving`; `saving: true` (lead, round 4) only while a `save` export runs,
    otherwise left out. Sent on every change.
  - `onAppCommand?(cb)`, push channel `APP_PUSH.command = 'push:command'`, `AppCommand = 'leave' | 'open-settings'`.

## Main-process helpers (wired by the lead in `src/main/index.ts` / `ipc.ts` / preload)

`src/main/tray.ts`

- `new AppTray(win, {iconPath?})`, then `.install()`. Hides the window on close while `inRoom`. Creates a tray on
  Windows/Linux with Show, Leave room… (enabled in a room), Settings…, Quit. On macOS it re-shows the window on
  `activate`. Without an icon asset it draws its own.
- `.setSession(report)` from `ipcMain.on(APP_CHANNELS.reportSession, (e, raw) => { if trusted sender: const r =
parseSessionReport(raw); if (r) tray.setSession(r) })`.
- `.inRoom`, `.show()` (use it for second-instance and `show-app`), `.cancelQuit()`, `.destroy()`.
- `confirmQuitInRoom(win)` returns true when the user accepts "Leave room?". Suggested `before-quit`: if
  `tray.inRoom` and not yet confirmed, `preventDefault()`; ask; on yes, set confirmed and `app.quit()`; on no,
  call `tray.cancelQuit()`.
- Preload: `reportSession: (r) => ipcRenderer.send(APP_CHANNELS.reportSession, r)`,
  `onAppCommand: (cb) => push(APP_PUSH.command, cb)`.

`src/main/power.ts`

- `bindPower(coreHost)` returns a `PowerKeeper`. It follows core's `power {keepAwake}` with one
  `powerSaveBlocker.start('prevent-app-suspension')` and releases it on `crashed` and on `dispose()`.

`src/main/diagnostics.ts`

- `copyDiagnostics({settings: () => store.get(), mpv: () => mpvInfo, logsDir?}, rawCore)` is the
  `APP_CHANNELS.copyDiagnostics` handler (`z.tuple([z.unknown().optional()])`). `rawCore` is validated with
  `CoreDiagnosticsSchema`; when it is missing or invalid, core.log is read from disk instead.
- The Markdown report has versions, OS/session type/desktop, mpv (kind, path, version, vo, hwdec), NAT class
  (the public IP is left out on purpose), relay, a peer path/RTT table, core uptime/RSS/loop-delay p99, settings
  JSON, and the last 200 lines of core.log, main.log and mpv.log. Invite links and bare codes are redacted, home
  paths are shown as `~`, and the relay key is shortened.
- Pure parts: `formatDiagnostics`, `redactInvites`, `tildify`, `readTail`.

`src/main/linux-desktop.ts`

- `registerLinuxDeepLinks(deps?, platform?)` is the `APP_CHANNELS.registerLinuxDeepLinks` handler. On Linux with
  `$APPIMAGE` set, it writes `$XDG_DATA_HOME/applications/app.cinemesh.desktop` (Exec quoted per the
  spec, `%U`, `MimeType=x-scheme-handler/cinemesh;`). It then runs `update-desktop-database` (best effort)
  and `xdg-mime default`. Without xdg-utils it edits `$XDG_CONFIG_HOME/mimeapps.list` itself.
- `linuxDeepLinkStatus()` returns `unsupported | unregistered | registered | stale`. `stale` means the AppImage
  moved. Settings shows the button whenever `info.isAppImage`.

## Developing against the mock

`main.tsx` falls back to `createBrowserMock(location.search)` when `window.wt` is missing. That happens only in a
dev build, in a plain browser on the Vite dev server (`npm run dev`, then open the renderer URL in a browser).
Query parameters:

- `?mock=<scenario>`, one of: `home`, `preparing`, `connecting`, `pending`, `connecting-host-preparing`,
  `confirm-join`, `confirm-join-low-space`, `room-host`, `room-viewer`, `room-viewer-waiting`, `room-viewer-behind` (the desync banner), `ended-host`,
  `ended-viewer` (video ended, room open), `room-closed` (the host ended the room), `room-closed-complete` (… and
  the viewer has the whole video: Save file shows the saving banner for 3 s, then Home with the saved path),
  `leaving` (core reports phase `leaving`, without saying what runs), `leaving-save` (… a `save`, as after a reload
  mid-save), `preparing-full-download`, `room-host-full-download`, `room-viewer-full-download` (an fMP4 without
  sidx), `preparing-linear`, `room-host-linear`, `room-viewer-linear` (an MKV without Cues),
  `room-host-poor-interleave`, `room-host-pending-via` (a join request a member passed on), `export-finished` (Home,
  then core's startup notices about an interrupted export, `SCENARIO_NOTICES`), `recent-export` (Home with a cut-off
  save in Recent rooms: Finish saving gives `finished`, Cancel saving `rejoin`), `recent-export-waiting` (… whose
  folder is not connected: Finish saving gives `waiting`; core's `transfer.export-waiting` notice at startup too),
  `recent-export-lost` (… whose data is gone: Finish saving gives `rejoin`), `mpv-missing`, `mpv-too-old`, `error`.
  What a scenario's core holds besides its state (its Recent rooms, `FakeOptions.recent` / `exportLost`) is in
  `SCENARIO_CORE`, which the browser mock and the test harness's `mountApp` both use; `wtMock.recent` is the list
  `session.recent` answers (set an entry's `export.waiting` to false to "connect the drive"). In the fake, an mpv path
  containing `broken` fails `recheckMpv()`; `session.leave` and `transfer.saveFile` go through phase `leaving` with
  `leave` set like the manager does (`fake.leaveFlow(ms, leave?, dest?)`, reusable in a test's own handler; without
  `leave` it is a core that does not say), and a `save` then posts `transfer.export-finished` with the path, as core
  does for every finished save. `transfer.saveFile` refuses an incomplete download with `incomplete`, like core;
  `transfer.finishExport` finishes, waits or gives up the way the contract says, and `session.resume` refuses a room
  with a cut-off save (`busy`).
- `&dark=1` (the OS colour preference), `&clipboard=<text>`.

The fake walks through the flows with realistic timing: host → prepare → room; join → connecting → pending →
confirm → room; resume; leave. `simulate()` advances playback and jitters peer stats. In the devtools console,
`window.wtMock` is the `FakeCore`: `wtMock.emit('sync', …)`, `wtMock.set(slices)`, `wtMock.deepLink(link)`,
`wtMock.command('leave')`, `wtMock.handle(method, fn)`. Production builds never include the mock (it sits
behind `import.meta.env.DEV` and a dynamic import).

## Tests

- `npx vitest run --project renderer` (happy-dom) covers: routing by phase (pure function and the mounted App);
  the Home join flow (paste box with wrapped lines, bare code, clipboard offer, deep links cold and in-room,
  recent rooms, hosting with subtitles, network test, display name); HostPrepare (stages, feasibility line, cached
  badge, Cancel); JoinConfirm space blocking, Change folder and the host-preparing line; Room controls' disabled
  states, Ask host, keyboard, host panel (with feasibility, and the admission queue's "via"), coverage bars, wait
  banner (names, host-only Start anyway), leave prompt, ended and closed cards, local panel; leaving
  (`leave.test.tsx`: banner and lock, what the banner says per `SessionEvent.leave` (also from a snapshot),
  `SessionReport.saving`, one leave at a time, `incomplete` with and without Rejoin, no Room flash from
  JoinConfirm/HostPrepare/the error screen, deep links during a leave, where the tray's Leave opens which prompt and
  that none is left waiting, one "Saved" toast per finished save, from core's notice); full-download warnings and the
  own row's "Downloading N %"
  (`FullDownload.test.tsx`); media notes (`MediaNotes.test.tsx`); notices (`notices.test.tsx`: Show in folder, two
  saved videos or two rooms' saves keeping a toast each, an action's failure); cut-off saves (`saves.test.tsx`: the
  Recent rooms entry, Finish/Cancel saving and each outcome, one request at a time, the notice's Finish saving);
  `drawTimeline` with a recording 2D context; lib helpers;
  Settings validation, save, mpv locate/recheck result and diagnostics; MpvSetup; and `render-loop.test.tsx`
  (every screen and overlay from empty core slices, failing on React #185 / "Maximum update depth exceeded").
- `npx vitest run --project unit src/main/{tray,power,diagnostics,linux-desktop}.test.ts` runs the main helpers
  with `electron` mocked. linux-desktop uses a temporary XDG directory and removes it afterwards.
- `npm run build && npx playwright test` runs `test/e2e/ui.spec.ts` (boot, theme toggle, Settings validation and
  save with a toast showing, Escape, Home at 720×520 without horizontal scroll) and the existing `boot.spec.ts`.
