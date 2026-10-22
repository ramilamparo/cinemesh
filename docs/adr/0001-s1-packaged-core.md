# ADR 0001: Spike S1 — the packaged core loads without WebTorrent's side effects

- Date: 2026-10-19
- Status: **passed on Linux**; Windows (NSIS) and macOS (DMG) run in CI (M9)
- Plan: §7 S1, §4.2 "Removing side effects", §4.6 Packaging

## Question
Does the core run as an ESM `utilityProcess` inside a packaged, fused, asar-packed build, loading the
patched WebTorrent, Hyperswarm and the N-API addons, without WebTorrent opening a TCP listener or
loading `node-datachannel` / `utp-native`?

## Method
- `npm run build && npx electron-builder --linux AppImage`, then
  `WT_USER_DATA=$(mktemp -d) "./release/0.1.0/Watch Together-0.1.0.AppImage" --selftest`
  (also against `release/0.1.0/linux-unpacked/watch-together-p2p`).
- `--selftest` makes main start core with `init.selftest = true`; core runs `src/core/selftest.ts`
  and main prints the JSON report and exits 0/1. CI will run the same command on every packaged target.
- Fuses read back with `npx @electron/fuses read --app release/0.1.0/linux-unpacked/watch-together-p2p`.

## Results
| Check | Result |
|---|---|
| ESM core as utilityProcess from `app.asar` | ok |
| `sodium-native` (BLAKE2b) | ok |
| WebTorrent with `connPool: false`: `listening`, no ConnPool, seeds a buffer | ok |
| Hyperswarm DHT socket (udx-native) opens and closes | ok |
| `fs.statfs` | ok |
| Loaded addons | sodium-native, udx-native, fs-native-extensions only (no node-datachannel, no utp) |
| Fuses | RunAsNode off, NodeOptions off, CliInspect off, asar integrity on, OnlyLoadAppFromAsar on |

## Findings
1. `npm overrides` with `file:` stubs work: `webrtc-polyfill` and `utp-native` resolve to `stubs/`, and
   `node-datachannel` is not installed at all.
2. **New:** with the ConnPool disabled, `client.torrentPort` stays 0 and torrent-discovery throws
   "Option `port` is required" when a torrent is added, even with DHT, trackers and LSD off. Fixed by
   `torrentPort: 1` in `src/core/transfer/client-options.ts`: nothing listens on it and, with every
   discovery source off, it is never announced. The selftest now seeds a buffer to catch this class of issue.
3. `ws` (pulled in by bittorrent-tracker) loaded the `bufferutil` addon at import time. `WS_NO_BUFFER_UTIL=1` and
   `WS_NO_UTF_8_VALIDATE=1` turn both of its optional addons off, and they are set in two places:
   - main's `utilityProcess.fork` env (`src/main/core-host.ts`), so they hold before core's first line however core
     is bundled;
   - `src/core/env-first.ts`, the first import of `src/core/index.ts`, for core started any other way (headless
     `--stdio-transport` runs, tests).

   **Update:** setting them in a side-effect module imported first is not enough on its own. The bundler
   (rolldown, through electron-vite) hoists every package import of the entry's static graph above all of the
   module's own code, env-first's included: a build with a static `SessionManager` import put `import WebTorrent`
   ahead of the env lines, and `bufferutil.node` loaded. So `src/core/index.ts` only `import type`s the session
   layer and loads `./session/manager.js` (the WebTorrent side of core) with a dynamic import inside `init`; the
   build emits it as its own chunk next to `core.js`. `src/core/index.test.ts` walks the entry's static import graph
   (env-first first, no `webtorrent` or `ws` reachable) and spawns core without the env vars to check that no ws
   addon loads. The packaged selftest's "loaded native addons" check now fails if `bufferutil` or `utf-8-validate`
   loads, so CI's `--selftest` on every package catches a regression.
4. `fs-native-extensions` (N-API, from random-access-file) loads at import time; it works from
   `app.asar.unpacked` and stays.
5. electron-builder warns that `desktopName` is unset (Linux window association) and that no icon is set.

## Decision
Keep the plan's approach: one-line patch-package change + `npm overrides` stubs + `asarUnpack` of
`**/*.node`, `udx-native`, `sodium-native`. No fallback needed on Linux.

## Follow-ups
- M9: run `--selftest` on the NSIS and DMG builds in CI; set `desktopName` + `linux.syncDesktopName`;
  add icons; copy electron-builder's default rpm/pacman depends and add `mpv`.
