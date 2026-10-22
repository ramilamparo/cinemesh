# Cinemesh

Watch a video from your own computer together with friends, in sync, with no server in between.

The host picks a video file and sends an invite link. Friends open the link, and the file streams to them
peer-to-peer: the host and every viewer share the pieces with each other, starting from wherever the group is
watching. Playback stays in sync across everyone (within about 100 ms), and each person still picks their own audio
track, subtitles and volume. Video plays in [mpv](https://mpv.io), so any codec, HDR and styled subtitles work.

> **Status: pre-release.** Nothing has been published yet. The builds are not code-signed, and some release work is
> still open (see [docs/RELEASING.md](docs/RELEASING.md)).

## Features

- **No upload, no server.** Peers find each other over [Hyperswarm](https://github.com/holepunchto/hyperswarm) and
  connect directly (UDP hole punching). An optional relay you host yourself covers networks that cannot connect
  directly.
- **Starts fast, seeks anywhere.** Downloading follows the room's playhead to the end of the file, then wraps around.
  Seeking to a part nobody has yet fetches that part first.
- **Shares the host's upload fairly.** The host hands different pieces to different viewers so they re-share among
  themselves. Its upload is paced to keep its queue short, so control messages do not wait long behind video data.
- **Saved to disk, not RAM.** Viewers keep what they downloaded, can resume later, and can save the finished file.
- **Group playback.** By default only the host plays, pauses and seeks (one switch lets everyone do it), and
  everyone waits when someone is buffering (another switch turns that off). Viewers who fall behind get a warning and
  a **Resync to live** button.
- **Timeline of what's downloaded**, in the app and in the player: done, downloading and missing parts.
- **Limits** for your upload and (as a viewer) your download speed.
- Light and dark themes; Windows, macOS and Linux (X11 and Wayland).

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Install

Download a build for your system and follow [docs/install.md](docs/install.md). It covers getting past the
unsigned-app warnings, installing mpv on Linux, and what to do when friends cannot connect.

## Using it

1. **Host:** on Home, choose **Host a video**, pick a file (and subtitle files, if any) and choose **Start hosting**.
   Cinemesh prepares the file, then gives you an invite. Use **Copy invite** to share the link, which includes
   download instructions for friends who do not have the app yet.
2. **Join:** open the `cinemesh://` link, or paste the link or code on Home. Check where the video will be saved
   (**Change…** picks another folder) and choose **Join**.
3. **Watch:** the video opens in its own mpv window. The host's play, pause and seek apply to everyone.
4. **Leave:** a viewer keeps the download to resume later (for 7 days), saves the finished file, or deletes it. The
   host leaves for now or ends the room for everyone.

If friends cannot reach you, run **Home > Network test** and see
[If friends cannot connect](docs/install.md#if-friends-cannot-connect).

## How it works

```
┌─ Electron main ─┐   ┌─ renderer (React) ─┐
│ windows, tray,  │   │ screens, timeline  │
│ settings, links │   └─────────┬──────────┘
└───────┬─────────┘             │ MessagePort
┌───────▼───────────────────────▼─────────────────────────────────┐        ┌─ mpv ────────────────┐
│ core (utility process)                                          │  IPC   │ video window and our │
│ net: Hyperswarm rooms, auth, signed message bus                 ├───────►│ on-screen controls   │
│ transfer: WebTorrent over the room's connections, playhead-first│        └──────────▲───────────┘
│ media: index, local HTTP stream for viewers ────────────────────┼───────────────────┘
│ sync: shared clock, group playback, drift correction            │
└─────────────────────────────────────────────────────────────────┘
```

- A room is a Hyperswarm topic derived from a secret that only the invite carries. Members authenticate with it,
  and all traffic is end-to-end encrypted.
- The video travels as a private BitTorrent swarm (WebTorrent) inside the room's encrypted connections. It never
  touches the public BitTorrent network: no trackers, DHT, peer exchange or local discovery.
- Viewers' mpv reads the video from a local HTTP server that waits for missing pieces. The host's mpv opens the
  file directly.
- The host publishes the playback state against a shared clock. Every member corrects its drift by nudging speed
  slightly or skipping.

The full design is in the architecture decision records in [docs/adr](docs/adr). Each module in `src/core` has its
own README, for example [src/core/sync](src/core/sync/README.md) and [src/core/transfer](src/core/transfer/README.md).

## Development

You need Node.js 24 or newer. On Linux you also need mpv 0.39 or newer, and the tests need unprivileged user
namespaces (most distributions allow them; Ubuntu 24.04 and later restrict them by default).

```sh
npm ci                     # also applies the patches in patches/
npm run dev                # the app with hot reload
npm run typecheck
npm run lint
npm test                   # unit and renderer tests
npm run test:integration   # several peers on a local test network, real mpv (no audio)
npm run test:e2e           # Playwright against the built app (Linux needs a display, e.g. DISPLAY=:0)
npm run dist               # installers for this OS in release/<version>/
```

- **Tests run without network access.** On Linux, `scripts/isolated.sh` puts each test run in its own network
  namespace with only a loopback interface, so a test can never touch your real network or VPN. In CI it runs the
  tests directly.
- **Builds:** the **Build** workflow (Actions tab, Run workflow) produces the Windows installer and zip and the
  Linux AppImage. **CI** typechecks, lints and runs the unit, renderer and integration tests on Linux and the
  end-to-end tests on Windows, macOS and Linux, then builds and checks every package on all three. **Release**
  (Actions tab, Run workflow) bumps the version, tags it, runs CI and publishes the GitHub release with every
  package; see [Cutting a release](docs/RELEASING.md#cutting-a-release).
- `npm run fetch-mpv` downloads the official mpv builds that the Windows and macOS packages bundle. See
  [Building from source](docs/install.md#building-from-source).

### Repository layout

| Path                    | What                                                                            |
| ----------------------- | ------------------------------------------------------------------------------- |
| `src/main`              | Electron main process: windows, tray, settings, deep links, packaging glue      |
| `src/core`              | The background process: `net`, `transfer`, `media`, `player`, `sync`, `session` |
| `src/renderer`          | The React UI                                                                    |
| `src/shared`            | Types and code shared by the processes (IPC contracts, settings, media map)     |
| `resources/mpv-scripts` | The on-screen controls inside mpv (Lua)                                         |
| `packages/relay`        | `cinemesh-relay`, the optional relay server                                     |
| `patches`               | Small patches to WebTorrent and networking libraries (patch-package)            |
| `test`                  | Integration, sync simulator, alpha and end-to-end tests                         |
| `spikes`                | Measurement prototypes behind the ADRs                                          |
| `docs`                  | Install guide, release checklist, ADRs                                          |

## License

MIT (the `license` field in package.json; there is no LICENSE file yet). Windows and macOS packages bundle mpv,
which is GPL-licensed and runs as a separate program; see [resources/licenses](resources/licenses) for its licence,
the source offer and the notices of the npm dependencies. Notices for the libraries inside the bundled mpv are still
to do (see [docs/RELEASING.md](docs/RELEASING.md)).
