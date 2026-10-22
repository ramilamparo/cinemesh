#!/bin/sh
# Runs one measurement in its own user+net namespace (only `lo`, isolated from other processes' traffic).
#   spikes/s2-transport/run.sh loopback --label lo-strict-1
#   spikes/s2-transport/run.sh netem    --label netem-strict-1 --max-ms 40000
# "netem" adds `netem delay 25ms rate 50mbit` on lo (50 ms RTT, 50 Mbit/s shared by all loopback traffic)
# once the mesh is up. Extra flags go to run.ts (see its header).
set -eu
cond="$1"
shift
cd "$(dirname "$0")/../.."
case "$cond" in
  loopback) netem='' ;;
  netem) netem='--netem "delay 25ms rate 50mbit"' ;;
  *) echo "condition must be loopback or netem" >&2; exit 1 ;;
esac
exec timeout 300 unshare -rn sh -c "ip link set lo up && node --import tsx spikes/s2-transport/run.ts $netem $*"
