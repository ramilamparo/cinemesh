# Installing Watch Together

Watch Together runs on Windows, macOS and Linux. Download it from the project's GitHub **Releases** page; the
link is also in every invite ("No app yet? Download it from …").

The builds are **not code-signed** yet, so Windows and macOS warn the first time you open them. The steps below show
how to get past each warning. You only need to do it once per version.

## Which file to download

| Your computer                        | File                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Windows 10 or 11 (64-bit)            | `Watch-Together-Setup-<version>.exe` (installer) or `Watch-Together-<version>-win.zip` |
| Mac with Apple silicon (M1 or later) | `Watch-Together-<version>-mac-arm64.dmg` (or the `.zip`)                               |
| Mac with an Intel processor          | `Watch-Together-<version>-mac-x64.dmg` (or the `.zip`)                                 |
| Linux (64-bit), any distribution     | `Watch-Together-<version>.AppImage`                                                    |
| Ubuntu, Debian, Linux Mint           | `watch-together-p2p_<version>_amd64.deb`                                               |
| Fedora, openSUSE                     | `watch-together-p2p-<version>.x86_64.rpm`                                              |
| Arch, Manjaro                        | `watch-together-p2p-<version>.pacman`                                                  |

Videos play in [mpv](https://mpv.io), which opens in its own window. The Windows and macOS downloads include mpv
0.41.0. On Linux you install mpv yourself (see [Linux](#linux)). On a Mac, Watch Together needs macOS 13 or later,
and the mpv it includes needs macOS 14 (Apple silicon) or macOS 15 (Intel): see [Older macOS](#macos) otherwise.

### Check the download (optional)

Every release has a `SHA256SUMS` file. Put it next to your download and run:

```sh
sha256sum --check --ignore-missing SHA256SUMS           # Linux
shasum -a 256 --check --ignore-missing SHA256SUMS       # macOS
```

On Windows, run `Get-FileHash .\Watch-Together-Setup-<version>.exe` in PowerShell and compare the hash with the
matching line of `SHA256SUMS`. When the release also has `SHA256SUMS.minisig`, check the list itself first with
`minisign -Vm SHA256SUMS -P <public key>`, using the public key published with the release.

## Windows

1. Run `Watch-Together-Setup-<version>.exe`.
2. Windows shows **"Windows protected your PC"** (Microsoft Defender SmartScreen). Click **More info**, then
   **Run anyway**.
3. Choose **Only for me** (no administrator rights needed) or **Anyone who uses this computer**, and finish the
   installer.

The installer registers `watchtogether://` invite links, so clicking an invite opens the app. The `.zip` needs no
installer: extract it anywhere and run `Watch Together.exe`. It registers invite links for that copy when it starts.

- **Firewall:** the first time you host or join, Windows Defender Firewall may ask whether Watch Together may
  communicate on your networks. Click **Allow access**. If you cancelled it, friends may be unable to connect to you:
  allow it later under Windows Security > Firewall & network protection > Allow an app through firewall.
- **Smart App Control:** on Windows 11 with Smart App Control turned on, Windows blocks unsigned apps without a
  **Run anyway** button. Watch Together cannot run there until it is code-signed.
- **Uninstall:** Settings > Apps > Installed apps > Watch Together > Uninstall. This also removes the
  `watchtogether://` registration.

## macOS

1. Open the `.dmg` and drag **Watch Together** to **Applications**. (With the `.zip`, double-click it and move
   **Watch Together** to Applications.)
2. Open Watch Together from Applications. macOS says it **cannot verify** the app ("Apple could not verify ...").
   Click **Done** (not Move to Trash).
3. Open **System Settings > Privacy & Security**, scroll down to **Security**, and click **Open Anyway** next to
   "Watch Together was blocked". Confirm with **Open Anyway** and your password or Touch ID.
   On macOS 14 you can instead Control-click the app in Applications, choose **Open**, then **Open** again.

Or do all of that in one step in Terminal. This also covers the mpv player inside the app:

```sh
xattr -dr com.apple.quarantine "/Applications/Watch Together.app"
```

- If macOS blocks **mpv** the first time a video plays, approve it the same way, or run the `xattr` command above.
- The app is ad-hoc signed, so macOS never calls it "damaged". If it does, the download is incomplete or was
  changed: download it again and check it against `SHA256SUMS`.
- **Local network:** when macOS asks whether Watch Together may find devices on your local network, click **Allow**.
  Without it, friends on the same Wi-Fi cannot connect to you directly. You can change it later under
  System Settings > Privacy & Security > Local Network.
- **Firewall:** if the macOS firewall is on, allow Watch Together to accept incoming connections. Because the app is
  not signed with a developer certificate, macOS may ask again after an update.
- **Older macOS:** the included mpv needs macOS 14 (Apple silicon) or macOS 15 (Intel). On an older version, install
  mpv 0.39 or newer another way (for example `brew install mpv`), then choose it in Watch Together under
  **Settings > Player > mpv program > Locate mpv…** (Homebrew puts it in `/opt/homebrew/bin/mpv` on Apple silicon
  and `/usr/local/bin/mpv` on Intel).
- **Uninstall:** move Watch Together from Applications to the Bin.

## Linux

### mpv

Watch Together needs **mpv 0.39 or newer**. Check yours with `mpv --version`. The app looks for mpv in this order:
the program chosen under **Settings > Player > mpv program**, then `mpv` on your `PATH`, then the Flatpak
`io.mpv.Mpv`. If none is usable, it shows the setup screen.

| Distribution                                                                                                     | mpv                                      |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Arch, Manjaro, EndeavourOS, CachyOS, openSUSE Tumbleweed, Fedora 41 and later, Debian 13, Ubuntu 25.04 and later | Recent enough: install the `mpv` package |
| Ubuntu 24.04, Linux Mint 22, Debian 12 and older                                                                 | Too old: install the Flatpak below       |

```sh
flatpak install flathub io.mpv.Mpv
```

### AppImage

```sh
chmod +x Watch-Together-<version>.AppImage
./Watch-Together-<version>.AppImage
```

- AppImages need FUSE 2: `sudo apt install libfuse2t64` (Ubuntu 24.04), `libfuse2` (Ubuntu 22.04),
  `sudo dnf install fuse-libs` (Fedora), `sudo pacman -S fuse2` (Arch). Without it, start the AppImage with
  `--appimage-extract-and-run`.
- **Ubuntu 24.04 and later** restrict the user namespaces that the app's sandbox needs, so the AppImage may exit
  with "The SUID sandbox helper binary was found, but is not configured correctly". Use the `.deb` there (it
  installs an AppArmor profile for the app), or allow the AppImage with a profile of your own, saved as
  `/etc/apparmor.d/watch-together-appimage`:

  ```
  abi <abi/4.0>,
  include <tunables/global>

  profile watch-together-appimage /tmp/.mount_*/watch-together-p2p flags=(unconfined) {
    userns,
  }
  ```

  Then load it with `sudo apparmor_parser -r /etc/apparmor.d/watch-together-appimage`.

- An AppImage is not installed, so your desktop does not know it opens invite links. To fix that, click
  **Settings > Help and troubleshooting > Register invite links**. Do it again if you move the AppImage.

### deb, rpm and pacman packages

```sh
sudo apt install ./watch-together-p2p_<version>_amd64.deb      # Ubuntu, Debian, Linux Mint
sudo dnf install ./watch-together-p2p-<version>.x86_64.rpm     # Fedora (openSUSE: sudo zypper install ./...rpm)
sudo pacman -U watch-together-p2p-<version>.pacman             # Arch, Manjaro
```

The deb and rpm packages _recommend_ mpv, so your package manager installs it unless you turned that off; on Ubuntu
24.04 and Debian 12 that mpv is too old, so also install the Flatpak above. The pacman package depends on mpv.
These packages register invite links on their own. To uninstall, remove the `watch-together-p2p` package
(`sudo apt remove`, `sudo dnf remove` or `sudo pacman -R`).

## If friends cannot connect

Watch Together connects you and your friends directly, over UDP, without a server of ours. That works with most home
routers. **Home > Network test** tells you what kind of connection your network allows:

- **Open** or **Consistent**: friends can reach you directly. Two friends who both get "Consistent" may need a few
  seconds for the first connection.
- **Random** (common with mobile hotspots, some ISPs and carrier-grade NAT): you reach friends whose test says Open
  or Consistent, but never a friend whose test also says Random. Only a relay connects the two of you (below). A
  forwarded port does not change "Random".

Two things help:

- **Forward a UDP port**, if your test says Consistent and you control the router: it makes you Open, so friends with
  a Random network reach you at once. Pick a port between 1024 and 65535 (for example 49737) and enter it under
  **Settings > Network > UDP port**. Then, in your router's settings, forward that **UDP** port to this computer. Allow
  it in your firewall too, for example `sudo ufw allow 49737/udp` or
  `sudo firewall-cmd --add-port=49737/udp --permanent && sudo firewall-cmd --reload` on Linux. Run the Network test
  again: it should now say Open. Doing this on the host's computer helps the most.
- **Run a relay.** A relay is a small program you run on any server with a public IP address, such as a cheap VPS.
  It passes along encrypted traffic between members who cannot reach each other, and it cannot see the video or
  join rooms. To set one up, follow [packages/relay/README.md](../packages/relay/README.md), then paste the key it
  prints into **Settings > Network > Relay key** on the **host's** computer. New invites carry the key, so guests
  need no setup. **Always use the relay** keeps every new connection on the relay instead of switching to a direct
  path once one works (friends with an open address are still reached directly), which is useful for testing or to
  keep your address from friends. The relay pays for every relayed viewer's video in bandwidth, once in and once out:
  the README has the numbers.

Watch Together needs outgoing UDP. Networks that block UDP entirely (some offices and schools) do not work, with or
without a relay.

## Your data

- Settings: `%APPDATA%\Watch Together` (Windows), `~/Library/Application Support/Watch Together` (macOS),
  `~/.config/Watch Together` (Linux). Logs: **Settings > Help and troubleshooting > Open logs folder**.
- Videos you receive are saved under `Downloads/Watch Together` unless you choose another folder under
  **Settings > Storage**. When you leave a room, the app asks whether to save the file or delete it.
- Uninstalling leaves both in place. Delete them by hand if you no longer want them.

## Building from source

You need Node.js 24 or newer.

```sh
npm ci
npm run dist          # this OS's installers in release/<version>/; on Windows and macOS it first downloads mpv
npm run dist:linux    # AppImage, deb, rpm and pacman (needs rpmbuild for rpm and bsdtar for pacman)
npm run check:package -- --selftest   # checks the packages and starts the app once (needs a display on Linux)
```

- `npm run fetch-mpv -- --platform all` downloads the official mpv 0.41.0 builds for Windows and both Macs into
  `vendor/mpv/`, checking each against the SHA-256 pinned in `scripts/mpv-assets.json`. Build each package on its own
  operating system, as CI does: the packages only include that system's native modules.
- On Debian and Ubuntu, `sudo apt install rpm libarchive-tools` provides rpmbuild and bsdtar.
- `npm run icons` redraws the icons in `build/` (needs `rsvg-convert` and ImageMagick 7). `npm run licenses`
  refreshes `resources/licenses/THIRD-PARTY.md` after dependency changes; CI fails when it is out of date.
- The Windows and macOS packages include mpv, which is GPL software. Its licence, the exact builds and where their
  source code is are in `resources/licenses/mpv/SOURCE-OFFER.md`; every release attaches `mpv-0.41.0.tar.gz`.
