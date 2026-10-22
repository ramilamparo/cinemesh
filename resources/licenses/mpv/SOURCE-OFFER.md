# mpv: licence and source code offer

The Windows and macOS packages of Cinemesh include **mpv 0.41.0**, which Cinemesh starts as a separate
program; mpv is not linked into Cinemesh. mpv and the libraries in these builds are free software. This file
says which builds we ship, which licence covers them, where their exact source code is, and how to get a copy from us.
Linux packages include no mpv: they use the mpv from your distribution or Flatpak.

## Licence

- mpv itself is licensed **GPL-2.0-or-later** in these builds (built with `-Dgpl=true`; see the `Copyright` file in
  the mpv source).
- **macOS builds** include Homebrew's FFmpeg 8.0.1, configured with `--enable-gpl --enable-version3` (it reports
  "GPL version 3 or later"), and x264, x265 and Rubber Band. Each macOS mpv build is therefore distributed under
  **GPL-3.0-or-later**.
- **The Windows build** includes FFmpeg configured as "GPL version 2 or later" and Apache-2.0 components (shaderc,
  SPIRV-Cross, Vulkan-Loader). Apache-2.0 code can be combined with GPL version 3 but not with version 2 alone, so
  the "or later" option applies: the build as a whole is distributed under **GPL-3.0-or-later**.
- The full licence texts are next to this file: [GPL-2.0.txt](GPL-2.0.txt) and [GPL-3.0.txt](GPL-3.0.txt), from
  <https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt> and <https://www.gnu.org/licenses/gpl-3.0.txt>.

## What we ship

All three are the mpv project's own builds (first-party GitHub CI builds), published with the release at
<https://github.com/mpv-player/mpv/releases/tag/v0.41.0>.

| Package     | Where it is in the installed app                        | Upstream file                            | SHA-256 of the upstream file                                       |
| ----------- | ------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| Windows x64 | `resources\mpv\` (`mpv.exe`, `mpv.com`, `vulkan-1.dll`) | `mpv-v0.41.0-x86_64-pc-windows-msvc.zip` | `4e197f729f5071c6772f35fffd96e0f36e3e8a044bd9479b136bb09b7c6a80ff` |
| macOS arm64 | `Cinemesh.app/Contents/Resources/mpv/mpv.app`           | `mpv-v0.41.0-macos-14-arm.zip`           | `5c96f9b21355fc0a11d2e2161ad65f33031070e9fb3f6bd9865fb459b94587e6` |
| macOS x64   | `Cinemesh.app/Contents/Resources/mpv/mpv.app`           | `mpv-v0.41.0-macos-15-intel.zip`         | `41003617ab4f7784394b5ddea7ce51b3e0838e8cfc8166ad1a378b2eda3b583c` |

We do not modify the programs. We leave out the Windows debug symbols (`mpv.pdb`) and the `mpv-register.bat` /
`mpv-unregister.bat` scripts, drop two empty `.gitkeep` placeholder files (and their AppleDouble `._.gitkeep`
metadata files) from the macOS bundle, and the macOS bundle is re-signed with an ad-hoc signature when the app is
packaged. `scripts/fetch-mpv.mjs` and `scripts/mpv-assets.json`
in the Cinemesh source do exactly this.

## Corresponding source

**mpv**: tag `v0.41.0`, commit `41f6a645068483470267271e1d09966ca3b9f413`.

- Source tarball: <https://github.com/mpv-player/mpv/archive/refs/tags/v0.41.0.tar.gz>
  (SHA-256 `ee21092a5ee427353392360929dc64645c54479aefdb5babc5cfbb5fad626209`).
- Every Cinemesh release attaches a copy of this tarball as `mpv-0.41.0.tar.gz`.

**Build scripts**: these are first-party builds, so the scripts are part of the same tag; there is no separate
build-script repository.

- `.github/workflows/build.yml`: job `win32` (target `x86_64-pc-windows-msvc`) built the Windows file; job `macos` on
  the `macos-14` (arm) and `macos-15-intel` runners built the macOS files, on 2025-12-21.
- `ci/build-win32.ps1`: Meson with `--wrap-mode=forcefallback` and `-Ddefault_library=static`, so every library is
  compiled from source into `mpv.exe`.
- `ci/build-macos.sh` and `meson compile -C build macos-bundle`: libraries come from Homebrew, and
  `TOOLS/dylib_unhell.py` copies them into the app bundle.

**Libraries in the Windows build.** `ci/build-win32.ps1` takes several libraries from their default branches at build
time, so the revisions are those of 2025-12-21. Versions recorded in `mpv.exe`:

- FFmpeg: GStreamer's Meson port of FFmpeg, branch `meson-8.0`
  (<https://gitlab.freedesktop.org/gstreamer/meson-ports/ffmpeg>), revision `f853d12` (libavcodec 62.11.100, FFmpeg
  8.0).
- libplacebo v7.358.0, LuaJIT 2.1.1720049189, HarfBuzz 12.2.0, libpng 1.6.53, libaom 3.13.1.
- Also compiled in: libass, dav1d, libjxl, shaderc, SPIRV-Cross and Vulkan-Loader (`vulkan-1.dll`) from their
  default branches, and Meson WrapDB packages such as zlib, Expat, FreeType, FriBidi, Little-CMS, libjpeg-turbo,
  xxHash and MuJS.

**Libraries in the macOS builds.** Homebrew bottles current on 2025-12-21; the homebrew-core formula for each version
names its source URL and SHA-256. Versions recorded in the binaries: ffmpeg 8.0.1, libplacebo 7.351.0, libass 0.17.4,
luajit 2.1.1765228720, mujs 1.3.8, rubberband 4.0.0, uchardet 0.0.8, vulkan-loader 1.4.335.0, zimg 3.0.6, libbluray
1.4.0, libvpx 1.15.2, gnutls 3.8.11, openssl 3.6.0, glib 2.86.3, fontconfig 2.17.1, gettext 0.26, jpeg-turbo 3.1.3,
libsamplerate 0.2.2, libx11 1.8.12, p11-kit 0.25.10. Both macOS bundles contain the same libraries:
`Contents/Frameworks/libMoltenVK.dylib` and, in `Contents/MacOS/lib/`, libaom, libarchive, libaribb24, libass,
libavcodec, libavdevice, libavfilter, libavformat, libavutil, libb2, libbluray, libbrotli (common, dec, enc),
libcjson, libcrypto, libdav1d, libfontconfig, libfreetype, libfribidi, libgif, libglib-2.0, libgmp, libgnutls,
libgraphite2, libharfbuzz, libhogweed, libhwy, libidn2, libintl, libjpeg, libjxl (+ cms, threads), liblcms2,
libleptonica, libluajit-5.1, liblz4, liblzma, libmbedcrypto, libmp3lame, libmujs, libnettle, libogg,
libopencore-amrnb, libopencore-amrwb, libopenjp2, libopus, libp11-kit, libpcre2-8, libplacebo, libpng16, librav1e,
librist, librubberband, libsamplerate, libshaderc_shared, libsharpyuv, libsnappy, libsodium, libsoxr, libspeex,
libsrt, libssh, libssl, libSvtAv1Enc, libswresample, libswscale, libtasn1, libtesseract, libtheoradec, libtheoraenc,
libtiff, libuchardet, libudfread, libunibreak, libunistring, libvidstab, libvmaf, libvorbis, libvorbisenc, libvpx,
libvulkan, libwebp, libwebpmux, libX11, libx264, libx265, libXau, libxcb (+ shape, shm, xfixes), libXdmcp, libzimg,
libzmq and libzstd.

## Written offer

For at least three years after we last distribute a Cinemesh release that contains mpv, we will give anyone
who asks a complete, machine-readable copy of the corresponding source code of that release's mpv build (mpv, every
library in it, and the scripts used to build it), by download or on a medium customarily used for software
interchange, for no more than our cost of physically performing the distribution. To ask, open an issue in the
project's tracker: <https://github.com/watch-together-p2p/watch-together-p2p/issues>.
