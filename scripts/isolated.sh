#!/usr/bin/env bash
# Runs a command with no network but its own loopback: private user, network, mount and PID namespaces (no sudo).
# Tests start HyperDHT testnets whose nodes listen on every interface and probe every address they learn; in here the
# only interface is lo, so none of that reaches the host's interfaces, VPN tunnels, firewall, conntrack or DNS. When
# the command ends the namespaces go, and every process left in them (testnet nodes, mpv, Electron) is killed.
#
#   scripts/isolated.sh npx vitest run --project integration
#   scripts/isolated.sh npx playwright test
#
# The command runs under your own uid (Electron refuses to run as root) with the same files, display (Wayland and
# D-Bus are path sockets) and environment. Anything that needs the real network (npm install, the public DHT) fails
# fast in here with ENETUNREACH, which is also how a test that leaks onto the network shows itself. (Name lookups may
# still answer, through systemd-resolved's socket on the host, but nothing can connect to the result.)
set -euo pipefail

if [[ ${WT_ISOLATED:-} == 1 ]]; then exec "$@"; fi
# CI runners are throwaway machines (and Ubuntu 24.04 forbids unprivileged user namespaces); macOS and Windows have
# no namespaces: run the command as it is there.
if [[ -n ${CI:-} || $(uname -s) != Linux ]]; then exec "$@"; fi
[[ $# -gt 0 ]] || {
  sed -n '2,13p' "$0"
  exit 1
}

uid=$(id -u)
gid=$(id -g)
# Outer namespace: fake root, only to bring lo up. Inner one: back to our own uid for the command. bash stays PID 1
# (no exec, and a command after the last one so bash does not exec that either): orphans are re-parented to PID 1,
# and bash reaps them, where node would leave zombies that still look alive to process.kill(pid, 0).
exec unshare --user --map-root-user --net --mount --pid --fork --kill-child --mount-proc -- bash -c '
  ip link set lo up
  export WT_ISOLATED=1
  unshare --map-user="$0" --map-group="$1" -- "${@:2}"
  rc=$?
  exit $rc
' "$uid" "$gid" "$@"
