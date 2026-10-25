# cinemesh-relay

A blind UDP relay for Cinemesh. Use it when two members cannot reach each other directly, for example when both are behind strict (RANDOM) NATs or carrier-grade NAT. The app shows this case as `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, or as a member stuck on `via-peer`.

The relay is built on [hyperdht](https://github.com/holepunchto/hyperdht) and [blind-relay](https://github.com/holepunchto/blind-relay). Members connect to it by public key, and it pairs their UDX streams. It forwards only end-to-end encrypted packets: it never sees room secrets, chat or video, and it cannot join rooms.

## Run it

```sh
node packages/relay/bin.js                  # from a checkout
cinemesh-relay --port 49737 --seed-file ./seed    # once installed (see below)
```

At startup it prints one JSON line with its `key` (64 hex characters). Paste that key into **Settings > Network > Relay key** on the host. The host then puts it into new invites and into its `room.state` message, so every member uses the same relay.

| Option             | Default                                   | Meaning                                                                               |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `--port`           | `49737`                                   | UDP port. Members must be able to reach it.                                           |
| `--host`           | all interfaces                            | Bind address.                                                                         |
| `--seed-file`      | `$STATE_DIRECTORY/seed`, else `./seed`    | 32-byte hex seed, which is the relay's identity. Created with mode 0600 on first run. |
| `--bootstrap`      | public HyperDHT nodes (or `WT_BOOTSTRAP`) | `host:port,...`, for example a local testnet from `scripts/testnet.mjs`.              |
| `--stats-interval` | `60`                                      | Seconds between `stats` log lines.                                                    |

**Keep the seed file.** If you lose it, the relay gets a new key, and every host has to paste the new one.

**Logs:** every line is a JSON object `{t, level, msg, ...}`. The `stats` line holds the number of open DHT connections, plus blind-relay's session, pairing and stream counters (`pairings.active` is the number of relayed links right now).

## Deploy on a VPS

Any small Linux VPS with a public IPv4 address works. The relay uses little CPU and memory, and is capped at 256 MB. What it costs is bandwidth: see below.

Whichever way you run it, open its UDP port in the VPS firewall and in the provider's security group:

```sh
sudo ufw allow 49737/udp       # or: sudo firewall-cmd --add-port=49737/udp --permanent && sudo firewall-cmd --reload
```

Then check the result. The "relay listening" line should show `"firewalled":false`; with `true` it is followed by a "looks firewalled" warning, and members cannot reach it. In a room that uses the key, the relay status should read "ok". Rooms probe the relay every 5 minutes, and after a 10 s timeout show "relay unreachable".

### Docker

```sh
git clone https://github.com/ramilamparo/cinemesh.git
cd cinemesh/packages/relay
docker compose up -d --build
until docker compose logs relay | grep "relay listening"; do sleep 1; done    # waits for startup (~5 s), then shows the key
```

The container uses the host's network, so the relay is reached on the VPS's own port 49737 and sees its real address. The seed lives in the `relay-data` volume. It restarts unless you stop it, and is limited to 256 MB. To upgrade: `git pull`, then `docker compose up -d --build`. The key stays the same.

### systemd user service

1. Install Node.js 20 or newer (nvm works).
2. Install the relay into your home:

   ```sh
   git clone https://github.com/ramilamparo/cinemesh.git
   cd cinemesh/packages/relay
   npm pack --pack-destination /tmp                                               # /tmp/cinemesh-relay-<version>.tgz
   npm install -g --prefix ~/.local/opt/cinemesh-relay /tmp/cinemesh-relay-*.tgz  # a copy, with blind-relay + hyperdht
   rm /tmp/cinemesh-relay-*.tgz
   ```

   Install the packed tarball, not the folder. `npm install -g .` only links the global package to the checkout and installs none of its dependencies, so the relay fails with `ERR_MODULE_NOT_FOUND`.

3. Install and start the unit:

   ```sh
   mkdir -p ~/.config/systemd/user
   sed "s|/usr/bin/node|$(command -v node)|" cinemesh-relay.service > ~/.config/systemd/user/cinemesh-relay.service
   systemctl --user daemon-reload
   systemctl --user enable --now cinemesh-relay
   loginctl enable-linger "$USER"                           # start at boot, keep running after you log out
   until journalctl --user -u cinemesh-relay -o cat | grep "relay listening"; do sleep 1; done    # waits for startup (~5 s), then shows the key
   ```

   The unit runs as you. It keeps the seed in `~/.local/state/cinemesh-relay/seed` (`StateDirectory`; the "created a new seed" line shows the file), restarts on failure (`Restart=always`), and is limited to `MemoryMax=256M`. Without lingering, it stops when you log out. On some servers `loginctl enable-linger` asks for sudo once.

To upgrade, pull, run the three install commands of step 2 again, then `systemctl --user restart cinemesh-relay`. The key stays the same. After upgrading Node with nvm, its path changes: run the `sed` line of step 3 again, then `systemctl --user daemon-reload`.

## Bandwidth math

A relayed link carries everything that two members exchange, and the relay sees each byte twice: once in, once out.

- One relayed viewer of a stream at bitrate _B_ for _T_ seconds moves _B × T_ through the relay in each direction.
- A 4K stream at 60 Mbit/s for 2 h: 60 Mbit/s × 7200 s = 432,000 Mbit ≈ **54 GB in, plus 54 GB out, per relayed viewer**.
- 1080p at 10 Mbit/s for 2 h: ≈ **9 GB** each way, per relayed viewer.
- Control traffic (bus, sync pings, datagrams) is a few kbit/s per link and does not matter here.

Many providers bill or cap only egress, so count about _B × T_ per relayed viewer per session against the monthly allowance. Viewers that are not relayed (direct, lan) cost the relay nothing. Only links that cannot hole-punch go through it, and a member whose own NAT is RANDOM uses it for all its links. Forwarding a UDP port on that member's router (**Settings > Network > UDP port**) often removes the need for the relay.

## Security notes

- The key is not a secret: it travels in invites. Anyone who has it can relay traffic through your server, from Cinemesh or any other HyperDHT app, and the relay has no login or limits. Watch the `stats` lines (`pairings.active` while nobody you know is watching means someone else is using it), and rotate the seed (delete it and restart) if the relay is abused. After a rotation, hosts must paste the new key.
- Set a billing alert or a data cap with the provider. Bandwidth is what abuse costs you.
- The relay cannot decrypt anything. Room access is still controlled by the room secret and the host's admission.
- The seed is the relay's only secret. Someone who has it can run a relay under your key, which can drop traffic but still decrypts nothing.
- The relay needs no TLS, domain or reverse proxy: members reach it by key, and the link to it is encrypted.
