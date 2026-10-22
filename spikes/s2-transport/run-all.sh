#!/bin/sh
# Runs the whole S2 matrix, 3 repetitions each, one run at a time (each run is 1-1.5 min), then prints the
# median table. Results go to results/<label>.json, raw member reports to data/raw/<label>.json.
#   spikes/s2-transport/run-all.sh            # everything (~45 min)
#   spikes/s2-transport/run-all.sh lo netem   # only some groups: lo soft one viewer1 reattach relay netem limits
#                                             #   reqq relaynetem limits2 netemreqq reattachrep fixed
# A run whose mesh does not form within 60 s (testnet flakiness, see the ADR) is retried up to 2 times.
set -u
here="$(cd "$(dirname "$0")" && pwd)"
groups="${*:-lo soft one viewer1 reattach relay netem limits reqq relaynetem limits2 netemreqq reattachrep fixed}"
run() { # <condition> <label> [flags...]
  cond="$1"; label="$2"; shift 2
  if [ -f "$here/results/$label.json" ] && [ -z "${FORCE:-}" ]; then echo "skip $label (exists; FORCE=1 to redo)"; return; fi
  echo "=== $label $(date +%T) load $(cut -d' ' -f1-3 /proc/loadavg)"
  for attempt in 1 2 3; do
    "$here/run.sh" "$cond" --label "$label" "$@" 2>&1 | grep -E 'FAILED|transfer phase|hard timeout' || true
    grep -q '"failure": "timeout waiting for full mesh' "$here/results/$label.json" 2>/dev/null || break
    mkdir -p "$here/results/mesh-failures"
    mv "$here/results/$label.json" "$here/results/mesh-failures/$label-attempt$attempt.json"
    echo "retry $label (mesh did not form)"
  done
}
for g in $groups; do
  for i in 1 2 3; do
    case "$g" in
      lo) run loopback "lo-strict-$i" --max-ms 60000 ;;
      soft) run loopback "lo-soft-$i" --max-ms 60000 --bp soft ;;
      one) run loopback "op-strict-$i" --max-ms 60000 --one-process ;;
      viewer1) run loopback "lo1v-strict-$i" --max-ms 40000 --viewers 1 ;;
      reattach) run loopback "re-strict-$i" --max-ms 60000 --reattach 8000 ;;
      relay) run loopback "rl-strict-$i" --max-ms 70000 --relay ;;
      netem) run netem "ne-strict-$i" --max-ms 30000
             run netem "ne-soft-$i" --max-ms 30000 --bp soft ;;
      limits) run loopback "lo-dl50-$i" --max-ms 60000 --down-limit 0,48828 # 50 MB/s per viewer
              run netem "ne-up-$i" --max-ms 30000 --up-limit 2500,600 ;; # ~53 % of the shared 6.25 MB/s
      limits2) run netem "ne-up78-$i" --max-ms 30000 --up-limit 4000,300 ;; # ~78 % of the shared link
      reqq) run loopback "lo-reqq-$i" --max-ms 60000 --reqq 256 ;; # <= 256 x 16 KiB outstanding per wire
      relaynetem) run netem "rlne-strict-$i" --max-ms 30000 --relay ;;
      netemreqq) run netem "ne-udx-$i" --max-ms 30000 # = ne-strict, run again with UDX sampling
                 run netem "ne-reqq256-$i" --max-ms 30000 --reqq 256
                 run netem "ne-reqq32-$i" --max-ms 30000 --reqq 32 ;;
      reattachrep) run loopback "re-rep-$i" --max-ms 40000 --reattach 5000 --reattach-every 5000 ;; # 6-7 re-attaches
      fixed) run loopback "re-repfix-$i" --max-ms 40000 --reattach 5000 --reattach-every 5000 --bp fixed
             run loopback "lo-fixreqq-$i" --max-ms 60000 --bp fixed --reqq 256 ;; # the recommended combination
      *) echo "unknown group $g" >&2 ;;
    esac
  done
done
npx tsx "$here/summarize.ts"
