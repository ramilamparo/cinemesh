# Changelog

All notable changes to Cinemesh are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org); see [docs/RELEASING.md](docs/RELEASING.md#versioning) for what counts as
a major, minor or patch change and how a release is cut. Write new entries under **Unreleased**; the Release
workflow (or `npm version`) turns that section into the release's own (scripts/changelog.mjs).

## Unreleased

### Added

- Playlists for watching a series: **Host a video…** takes several videos and puts them in episode order, and the
  room's **Playlist** adds, orders, plays and removes videos. Each video takes the subtitle files next to it that
  share its name.
- The next video starts by itself a few seconds after one ends (**Play the next video by itself**), with **Play
  now** and **Cancel**. The host's **>** and **<** in the player go to the next and previous video.
- Each person keeps their audio track and subtitles on the next video when it has ones with the same name (or else
  the same language), and subtitles stay off if they were off
- Viewers download the next videos ahead, in playlist order, once the one playing is complete, and share them with
  each other. The host shares them only with upload the video playing leaves. **Download upcoming playlist videos**
  and **Share other playlist videos** in **Settings** turn this off.

## 0.1.1 - 2026-10-22

The first release of Cinemesh: watch a video from your own computer with friends, in sync, peer-to-peer.

### Added

- Host a video file and invite friends with a `cinemesh://` link or code. **Copy invite** also says how to install
  Cinemesh for friends who do not have it yet, and you can share it while the video is still being prepared
- Rooms connect peer-to-peer over Hyperswarm, with no server of ours. An optional relay you run yourself
  (`cinemesh-relay`) connects networks that cannot reach each other: the host pastes its key once, and invites carry
  it to guests.
- The host decides who gets in (**Join freely** or **Ask me first**), can **Remove…** someone, make a **New invite…**
  that stops the old one, and limit the room to up to 12 people
- Playback in mpv stays in sync for everyone. By default only the host plays, pauses and seeks; others can **Ask
  host**, or the host turns on **Let others play, pause and seek**.
- The room waits while someone buffers (**Wait for everyone**, on by default) and starts **After buffering** or
  **Immediately**, once everyone's download can keep up
- Each person picks their own audio track, subtitles, subtitle delay and volume. The host can add subtitle files,
  which everyone gets.
- The player window has its own controls and a timeline of what is downloaded, downloading and missing, with
  everyone's position; the app shows the same timeline
- A warning for viewers who fall behind the host, with **Resync to live** (**Shift+R** in the player)
- Closing the player keeps you in the room: **Show player** opens it again, in sync, and a crashed player restarts
  by itself. If the host drops out, viewers pause after 10 seconds and carry on when the host is back.
- Viewers download from wherever the room is watching, share pieces with each other, and keep the video on disk
- When leaving, viewers choose **Save file** (once the whole video is downloaded), **Keep for later** or **Delete
  now**. Kept downloads are removed after 7 days unused, or when they pass the **Cache limit**.
- **Recent rooms** on Home: the host can **Leave for now** and **Resume** the room later with the same invite, and
  **End room for everyone** closes it
- Plays MKV, WebM, MP4, MOV, AVI and MPEG-TS files. For a file that streams poorly, the host is told why and gets a
  command that fixes it without re-encoding.
- An upload limit, and a download limit for viewers, in **Settings** or right in the room. The host's upload is
  paced so playback controls stay responsive while it is busy.
- Every piece is checked as it arrives, and the host is warned when its video file changes on disk
- The **People** list shows how each person is connected, how much they have downloaded and whether they are in
  sync, with a hint when a connection fails
- **Network test** on Home, and **Settings > Network** for a **Relay key**, **Always use the relay** and a **UDP
  port** to forward on your router
- Light, dark and system themes, in the app and in the player's controls
- Closing the window in a room keeps you in it (in the tray, or the dock on macOS), and the computer stays awake
  while you host or download
- A setup screen helps install mpv when it is missing or too old, and **Copy diagnostics** in **Settings** puts a
  bug report on the clipboard
- Packages for Windows (installer or zip), macOS (Apple silicon and Intel) and Linux (AppImage, deb, rpm and pacman)

### Known limitations

- The builds are not code-signed, so Windows and macOS warn the first time you open Cinemesh (the install guide
  shows what to click). Windows 11 with Smart App Control turned on blocks it.
- Linux needs mpv 0.39 or newer, installed separately: on Ubuntu 24.04, Linux Mint 22 and Debian 12, use the
  Flatpak. The mpv included for macOS needs macOS 14 (Apple silicon) or 15 (Intel).
- Some fragmented MP4 files play for viewers only once fully downloaded
- Networks that block UDP cannot connect. Two people whose **Network test** both say Random connect only through a
  relay.
- Everyone in a room should use the same version of Cinemesh
- No automatic updates yet: download new versions from the Releases page
- 64-bit only, with no ARM builds for Windows or Linux
