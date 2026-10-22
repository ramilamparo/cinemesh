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

## Versioning

Cinemesh follows [Semantic Versioning](https://semver.org). Until 1.0.0, the minor number marks breaking changes and
the patch number everything else. From 1.0.0:

- **Major:** members on different major versions cannot share a room. Examples are changes to the peer wire
  (`proto` in the Hello, lane and message formats), to invites, or to the room and auth key derivation. Also any
  change that drops saved data or settings without migrating them.
- **Minor:** new features that still talk to the previous minor versions. New optional message fields and new
  settings with defaults count here.
- **Patch:** fixes only.

`packages/relay` keeps its own version and changes it only when the relay changes.

Every build is named with its version, both in its file names and in the app (`app.getVersion()`, Copy diagnostics):

- A release builds from its `v<version>` tag, with package.json's version, for example `Cinemesh-Setup-0.2.0.exe` and
  `cinemesh_0.2.0_amd64.deb`. `release.yml` refuses a tag that does not match package.json, a version that
  CHANGELOG.md has no section for, and an asset whose name lacks the version.
- CI and Build runs on any other ref build `<version>-dev.<run number>`, for example `Cinemesh-0.2.0-dev.41.AppImage`.
  The deb and pacman packages turn that into `0.2.0~dev.41` and `0.2.0_dev.41`, which sort before the release.

### Cutting a release

1. Under **Unreleased** in CHANGELOG.md, list what the release changes (Added, Changed, Fixed, Removed). Commit it.
2. Bump the version:

   ```sh
   npm version 0.2.0 -m "Release %s"   # or: npm version patch | minor | major
   ```

   This updates package.json and package-lock.json, then runs `scripts/changelog.mjs release`, which renames the
   Unreleased section to `0.2.0 - <date>` and opens a new empty one. It then commits everything as "Release 0.2.0"
   and tags `v0.2.0`. It stops before committing if Unreleased is empty. In that case, undo the bump with
   `git checkout package.json package-lock.json`.

3. Push the commit and the tag: `git push --follow-tags`.
4. `release.yml` runs CI on the tag and drafts the GitHub release "Cinemesh 0.2.0". The draft's notes are the
   changelog section followed by the download table. Check the draft, then publish it.
