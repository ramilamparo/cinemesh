#!/usr/bin/env bash
# Runs a command as fake root in private user + mount + network + PID namespaces, so scripts/netns-nat.sh
# (and the S5 matrix, scripts/s5-matrix.mjs) work without sudo. Needs unprivileged user namespaces
# (kernel.unprivileged_userns_clone=1) plus ip, iptables-nft and node on PATH.
#
#   scripts/netns-rootless.sh                    an interactive shell inside the session
#   scripts/netns-rootless.sh CMD [ARGS...]      e.g. scripts/netns-rootless.sh node scripts/s5-matrix.mjs --out DIR
#
# Inside the session:
#   - /run is a private tmpfs, so `ip netns add` can create /run/netns without touching the real one;
#   - WT_NETNS_ROOTLESS=1 makes netns-nat.sh use its iptables backend and run `exec` without sudo;
#   - files you create are owned by your real user (uid 0 inside maps to you outside);
#   - every namespace and process lives only as long as the session: when CMD (or the shell) exits, the
#     PID namespace is torn down, which kills every member, testnet and relay it started.
# The session has no route to the outside world: everything talks over the namespaces' veths and bridge.
set -euo pipefail

if [[ ${WT_NETNS_ROOTLESS:-} != 1 ]]; then
  command -v unshare >/dev/null || {
    echo "netns-rootless: unshare (util-linux) is required" >&2
    exit 1
  }
  # --kill-child: if unshare itself is killed, its child (PID 1 of the session) is too, and with it the session.
  exec unshare --user --map-root-user --mount --net --pid --fork --mount-proc --kill-child \
    env WT_NETNS_ROOTLESS=1 bash "$0" "$@"
fi

# Now PID 1 of the session, as root of the new user namespace.
mount --make-rprivate /
mount -t tmpfs -o mode=0755 none /run
mkdir -p /run/netns
ip link set lo up

if [[ $# -eq 0 ]]; then
  echo "netns-rootless: session shell; scripts/netns-nat.sh works here without sudo. Exit to tear down." >&2
  exec bash -i
fi

# Run CMD as a child, not as PID 1, so it gets the normal signal defaults; forward INT/TERM to it.
"$@" &
child=$!
trap 'kill -TERM "$child" 2>/dev/null || true' INT TERM
status=0
wait "$child" || status=$?
# A trapped signal interrupts the first wait; wait again for the child to finish its own cleanup.
if kill -0 "$child" 2>/dev/null; then wait "$child" || status=$?; fi
exit "$status"
