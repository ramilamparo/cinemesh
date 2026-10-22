# Releasing

`release.yml` builds draft releases from `v*` tags. Before the first public release, these must be done. They are
not code bugs; they are decisions, accounts or legal work that the build cannot do for itself.

## Blockers

1. **A real repository URL.** The project has no published repository yet. A placeholder,
   `https://github.com/watch-together-p2p/watch-together-p2p`, appears in:
   - `src/core/net/invite.ts` (`DOWNLOAD_URL`, which goes into every copied invite);
   - `electron-builder.yml` (`extraMetadata.homepage`, which deb, rpm and pacman require);
   - `resources/licenses/mpv/SOURCE-OFFER.md` (the issue link of the written offer);
   - `packages/relay/README.md` and `packages/relay/cinemesh-relay.service`.

   Replace them together. `linux.maintainer` in `electron-builder.yml` also has no contact address yet.

2. **GPLv3 corresponding source for the bundled mpv** (Windows and macOS packages).
   - The macOS builds link Homebrew's FFmpeg 8.0.1, built with `--enable-version3`, plus x264, x265 and Rubber
     Band. The Windows build combines GPL-2.0+ FFmpeg with Apache-2.0 parts. Both are therefore distributed under
     GPL-3.0-or-later.
   - Release downloads fall under GPLv3 §6(d). The Corresponding Source of the whole work must be available from
     the same place: FFmpeg, x264, x265, libplacebo and the other libraries, not only mpv's own tarball, which is
     all `release.yml` attaches today. A §6(b) written offer covers only physical media.
   - For macOS: the source tarball plus Homebrew's patches of every formula inside `mpv.app`, at the bottled
     versions.
   - For Windows: the meson subprojects at the exact revisions upstream CI used. `SOURCE-OFFER.md` says that
     several came from "default branches" on 2025-12-21, so the revisions must be recovered from the upstream CI
     log. The alternative is to build mpv for Windows (and macOS) in our own CI with pinned wraps and attach that
     source.
   - Then have `release.yml` fetch and attach these archives with pinned SHA-256s, as it does for the mpv
     tarball, and name the exact revisions in `SOURCE-OFFER.md`.

3. **Licence notices of the libraries inside the bundled mpv.**
   - `mpv.app` ships about 100 dylibs under BSD, MIT, ISC, Apache-2.0, MPL-2.0 and LGPL licences, and `mpv.exe`
     links many of them statically.
   - Generate `resources/licenses/mpv/NOTICES.md` from their licence files, and add the LGPL-2.1, LGPL-3.0,
     MPL-2.0 and Apache-2.0 texts next to the GPL ones.
   - Add `NOTICES.md` to `checkResources` in `scripts/check-package.mjs`.

4. **A minisign key.**
   - Generate one with `minisign -G -W` and store the secret key as the `MINISIGN_SECRET_KEY` secret.
   - Publish the public key where `docs/install.md` points.

5. **Run CI once on GitHub.**
   - `ci.yml` and `release.yml` pass actionlint and shellcheck, but have never run on real runners.
   - Not yet exercised: the Windows NSIS install and uninstall (HKCU `cinemesh` registration), macOS ad-hoc
     signing with `codesign --verify --deep --strict` on the app, zip and DMG, the Nix mpv 0.39/0.40 jobs, and the
     Arch integration container.

## Worth deciding

- **macOS minimum versions.** Electron 44 allows macOS 13, but the bundled mpv needs macOS 14 (arm64) or macOS 15
  (Intel; mpv-player publishes no older Intel build). Below that, the lookup falls through to a Homebrew mpv or
  MpvSetup. Set `mac.minimumSystemVersion` per architecture in CI if that fallback is not good enough.
- **Gatekeeper and the nested `mpv.app`** (spike S9). If quarantined downloads refuse the nested app, move it to
  `Contents/MacOS` via `mac.extraFiles`.
