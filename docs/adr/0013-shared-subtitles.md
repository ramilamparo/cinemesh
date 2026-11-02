# ADR 0013: Subtitle files shared while the room plays

- Date: 2026-11-02
- Status: **accepted; in.** Any member can share a subtitle file mid-session; every member gets it in their player's
  subtitle list. Viewers of an older app see nothing new; a viewer of an older host is told the host cannot do it.
- Plan: §4.2 (blobs), §5.2 (bus messages); ADR 0011 (playlist items, track carry-over).
- Code:
  - `src/core/session/shared-subs.ts` (`SharedSubs`, both roles), `shared-subs-wire.ts` (schemas, limits);
  - `src/core/net/blobs.ts` (`CompositeBlobProvider`), `room.ts` (`NET_POLICIES`);
  - `base-session.ts` (`createSharedSubs`, `shareSubtitle`, `useSharedSubtitle`), `host-session.ts`,
    `viewer-session.ts` (the subtitle and carry lists at each load), `manager.ts` (`subtitles.*`);
  - `src/renderer/src/screens/Room/LocalPanel.tsx` (Share a subtitle file…, the list), `HostPanel.tsx` (the switch).
- Tests: `shared-subs.test.ts`, `shared-subs-wire.test.ts`; `test/integration/session/shared-subs.test.ts` (three
  sessions over a test DHT, and a real mpv); `Room.test.tsx`.

## 1. Context

Subtitles reached viewers one way: the host picked them before hosting (or they sat next to the video), and they
became files of the item's torrent. Once the room ran, nobody could add one: a viewer with a better `.srt` could not
share it, and the host could only re-host.

The torrent cannot take a file later: its infoHash covers every file, so a new file means a new torrent, a new bt lane
and a new sync epoch. Blobs (`blob.get` / `blob.data` over ctrl, BLAKE2b-checked, from any member that holds them)
already carry the torrent and manifest, and both roles run one.

## 2. Decision

- **The host owns the list.** Host-only sticky `session.subtitles {v, rev, viewersMayShare, items}` names every shared
  file with the item it is for (`infoHash`), its sharer's key and name. A late joiner or a reconnect gets it like
  `session.playlist`.
- **Viewers offer, the host fetches.** `session.subtitle-offer {hash, size, name, infoHash}` goes to the host, which
  checks it (sharing on, the item still listed, room under the caps), fetches the blob from whoever holds it, checks
  it is text, and lists it. The host then holds every listed file, so a file outlives its sharer's stay. The answer is
  `session.subtitle-result {hash, ok, code?, message?}` (host-only, addressed); a list naming the file answers too.
- **Per item.** A file shared during episode 1 is offered only while episode 1 plays. Removing an item from the
  playlist drops its files.
- **Every member fetches the playing item's files**, writes them to `<userData>/wt/shared-subs/<roomId>/<hash>.<ext>`
  (mpv reads a path; the stream server only serves torrent files) and serves them to others from there
  (`CompositeBlobProvider`: the session's metadata in memory, then these files). The folder is emptied at the start
  and on leave.
- **Into the player, not forced.** A file arriving while its item plays is `sub-add … auto`: in the dropdown and mpv's
  list, unselected. Only the sharer's own copy is selected. At every later load (a reload, a restart, a switch back)
  the item's files on disk come after the torrent's own subtitles in the load's list, so the track carry-over indices
  of the torrent's subtitles do not move, and a shared file's language can carry over to the next item.
  `SharedSubs.refresh()` runs before each load, so a file on disk then comes with the load and is not added twice.
- **Others are told.** A toast "Sam shared the subtitle X" with **Use** (`subtitles.use`: selects the track whose
  title is the shared one's, `name (sharer)`), also in the OSC. Nothing for files listed before this member joined.
- **The host can stop viewers sharing** (Host controls → Let others share subtitle files, on by default; in the list
  body, not sync's perms, so the sync wire stays as it is). The host may always share, and may remove any file; a
  viewer only its own.

Limits: `.srt/.ass/.ssa/.vtt`, at most 4 MiB, no NUL in the first 4 KiB unless UTF-16 with a BOM (a renamed video or
archive is refused; mpv parses the rest), 16 per item, 64 in the room, a body of at most 48 KiB (64 entries with
100-character names and 32-character sharer names fit). Names lose control and bidi characters and are cut to 100
UTF-16 units, extension kept. Offers and removals are rate-limited per origin (4, then 1 per 15 s) and small
(`maxBytes`), as every member forwards them.

## 3. Compatibility

The four names are in `NET_POLICIES`, so members of this version enforce host-only on the list even before a session
loads. An older viewer never reads them. A viewer of an older host gets no list: `sharedSubs.available` is false and
`subtitles.share` answers 'not-supported'.

## 4. Not done

- A host's resumed room starts with an empty list: shared files are not kept across a resume.
- A removed file stays in players that already loaded it, until that video loads again (mpv's `sub-remove` is not
  wired in).
- No per-file timing offset: each member's mpv subtitle delay (OSC) applies as for any track.
- A viewer whose only path to the host is via another member can share only if the host can fetch the blob from it
  through a direct link; otherwise the offer fails with 'unreachable'.
