# Changelog

All notable changes to Cinemesh are listed here, newest first. Versions follow
[Semantic Versioning](https://semver.org); see [docs/RELEASING.md](docs/RELEASING.md#versioning) for what counts as
a major, minor or patch change and how a release is cut. Write new entries under **Unreleased**; `npm version`
turns that section into the release's own (scripts/changelog.mjs).

## Unreleased

### Added

- Host a local video and invite friends with a `cinemesh://` link or code. Rooms are peer-to-peer over Hyperswarm,
  with no server; an optional self-hosted relay (`cinemesh-relay`) connects networks that cannot reach each other.
- Streaming from the room's playhead: viewers download from wherever the group is watching, re-share pieces with
  each other, and keep the download on disk to resume or save later.
- Synced playback in mpv: shared clock, group play, pause and seek, wait-for-everyone while someone buffers, and
  drift correction. The host decides whether others may control playback.
- A timeline of downloaded, downloading and missing parts, in the app and in the player.
- A warning for viewers who fall behind the host, with **Resync to live**.
- Upload limit, and a download limit for viewers; the host's upload is paced to keep its queue short.
- Network test, connection hints, light and dark themes, and packages for Windows, macOS and Linux.
