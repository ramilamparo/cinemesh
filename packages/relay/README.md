# cinemesh-relay

A blind UDP relay for Cinemesh. Use it when two members cannot reach each other directly, for example when both are behind strict (RANDOM) NATs or carrier-grade NAT. The app shows this case as `HOLEPUNCH_DOUBLE_RANDOMIZED_NATS`, or as a member stuck on `via-peer`.

The relay is built on [hyperdht](https://github.com/holepunchto/hyperdht) and [blind-relay](https://github.com/holepunchto/blind-relay). Members connect to it by public key, and it pairs their UDX streams. It forwards only end-to-end encrypted packets: it never sees room secrets, chat or video, and it cannot join rooms.

## Run it

```sh
node packages/relay/bin.js                  # from a checkout
cinemesh-relay --port 49737 --seed-file ./seed    # once installed (see below)
```

At startup it prints one JSON line with its `key` (64 hex characters). Paste that key into **Settings → Relay** on the host. The host then puts it into new invites and into its `room.state` message, so every member uses the same relay.

| Option             | Default                                   | Meaning                                                                               |
| ------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `--port`           | `49737`                                   | UDP port. Members must be able to reach it.                                           |
| `--host`           | all interfaces                            | Bind address.                                                                         |
| `--seed-file`      | `$STATE_DIRECTORY/seed`, else `./seed`    | 32-byte hex seed, which is the relay's identity. Created with mode 0600 on first run. |
| `--bootstrap`      | public HyperDHT nodes (or `WT_BOOTSTRAP`) | `host:port,...`, for example a local testnet from `scripts/testnet.mjs`.              |
| `--stats-interval` | `60`                                      | Seconds between `stats` log lines.                                                    |

**Keep the seed file.** If you lose it, the relay gets a new key, and every host has to paste the new one.

**Logs:** every line is a JSON object `{t, level, msg, ...}`. The `stats` line holds the number of open DHT connections, plus blind-relay's session, pairing and stream counters (`pairings.active` is the number of relayed links right now).

## Deploy on a VPS (systemd)

Any small Linux VPS with a public IPv4 address works. The relay uses little CPU and memory, and is capped at 256 MB. What it costs is bandwidth: see below.

1. Install Node.js 20 or newer.
2. Install the relay so that `/usr/local/bin/cinemesh-relay` exists:

   ```sh
   git clone https://github.com/ramilamparo/cinemesh.git
   cd cinemesh/packages/relay
   sudo npm install -g .          # installs blind-relay + hyperdht and links /usr/local/bin/cinemesh-relay
   ```

3. Open the UDP port in the VPS firewall and in the provider's security group:

   ```sh
   sudo ufw allow 49737/udp       # or: sudo firewall-cmd --add-port=49737/udp --permanent && sudo firewall-cmd --reload
   ```

4. Install and start the unit:

   ```sh
   sudo cp cinemesh-relay.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cinemesh-relay
   journalctl -u cinemesh-relay -o cat | head -3    # the "relay listening" line has the key
   ```

   The unit runs as a `DynamicUser`. It keeps the seed in `/var/lib/cinemesh-relay/seed` (`StateDirectory`), restarts on failure (`Restart=always`), and is limited to `MemoryMax=256M`. It also has the usual sandboxing (`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, and only AF_INET and AF_INET6 sockets).

5. Check the result. The startup log should not warn "looks firewalled". In a room that uses the key, the relay status should read "ok". Rooms probe the relay every 5 minutes, and after a 10 s timeout show "relay unreachable".

To upgrade, pull, run `sudo npm install -g .` again, then `sudo systemctl restart cinemesh-relay`. The key stays the same.

## Bandwidth math

A relayed link carries everything that two members exchange, and the relay sees each byte twice: once in, once out.

- One relayed viewer of a stream at bitrate _B_ for _T_ seconds moves _B × T_ through the relay in each direction.
- A 4K stream at 60 Mbit/s for 2 h: 60 Mbit/s × 7200 s = 432,000 Mbit ≈ **54 GB in, plus 54 GB out, per relayed viewer**.
- 1080p at 10 Mbit/s for 2 h: ≈ **9 GB** each way, per relayed viewer.
- Control traffic (bus, sync pings, datagrams) is a few kbit/s per link and does not matter here.

Many providers bill or cap only egress, so count about _B × T_ per relayed viewer per session against the monthly allowance. Viewers that are not relayed (direct, lan) cost the relay nothing. Only links that cannot hole-punch go through it, and a member whose own NAT is RANDOM uses it for all its links. Forwarding a UDP port on that member's router (**Settings → UDP port**) often removes the need for the relay.

## Security notes

- The key is not a secret: it travels in invites. Anyone who has it can relay traffic through your server. Watch the `stats` lines, and rotate the seed (delete it and restart) if the relay is abused. After a rotation, hosts must paste the new key.
- The relay cannot decrypt anything. Room access is still controlled by the room secret and the host's admission.
